/**
 * FR-09 for EVERY method: source, completeness, warnings, ids and untrustedContent are present on every envelope, a source
 * that is not a complete exported tree is never presented as full history, and nothing identifies the operator's directories.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ResultEnvelope } from '../../src/domain/types.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { TestDb } from './sdk.helpers.test.js';
import {
  ID,
  assertEnvelopeShape,
  chat,
  conversationsJson,
  emptyDb,
  fixedClock,
  importBuilders,
  importClaude,
  makeTempDir,
  removeDir,
  standardDb,
  warningCodes,
  writeText,
} from './sdk.helpers.test.js';

const COMPLETENESS = ['exported_tree', 'api_owned_conversation', 'rendered_active_view_only', 'partial_user_supplied', 'unknown', 'mixed'];

interface Row {
  name: string;
  run: () => ResultEnvelope<unknown> | Promise<ResultEnvelope<unknown>>;
  /** Data holds imported strings (titles, message text, ids, labels). */
  untrusted: boolean;
}

describe('every method returns the full envelope (table-driven)', () => {
  let t: TestDb;
  let rows: Row[];
  let draftId: string;
  let annotationId: string;
  let edgeId: number;
  let nodeA: string;
  let nodeB: string;
  let extraDir: string;

  before(async () => {
    t = await standardDb();
    await t.gcr.buildGraph({ minEntityConversations: 1 });
    draftId = (await t.gcr.createDraft({ conversationRef: ID.linear, body: 'table draft' })).data.draft.draftId;
    annotationId = (await t.gcr.createAnnotation({ conversationRef: ID.linear, body: 'table note' })).data.annotation.annotationId;
    const q = t.gcr.graphQuery({ term: 'quokka' });
    const e = q.data.edges[0];
    assert.ok(e, 'the standard export yields at least one graph edge for "quokka"');
    edgeId = e.id;
    nodeA = e.src;
    nodeB = e.dst;
    const g = t.gcr;
    extraDir = await makeTempDir();
    const exportPath = await writeText(extraDir, 'e/conversations.json', conversationsJson([chat(syntheticUuid(0xa1), 'extra', [['q', 'a']])]));
    rows = [
      { name: 'list', run: () => g.list(), untrusted: true },
      { name: 'get', run: () => g.get(ID.linear), untrusted: true },
      { name: 'get(allBranches)', run: () => g.get(ID.noCurrent, { allBranches: true }), untrusted: true },
      { name: 'branches', run: () => g.branches(ID.branched), untrusted: true },
      { name: 'thread', run: () => g.thread(ID.linear), untrusted: true },
      { name: 'search', run: () => g.search({ query: 'quokka' }), untrusted: true },
      { name: 'search(titles)', run: () => g.search({ query: 'alpha', scope: 'titles' }), untrusted: true },
      { name: 'search(all)', run: () => g.search({ query: 'quokka', scope: 'all' }), untrusted: true },
      { name: 'stats', run: () => g.stats({ groupBy: 'role' }), untrusted: true },
      { name: 'audit', run: () => g.audit(), untrusted: true },
      { name: 'graphQuery', run: () => g.graphQuery({ term: 'quokka' }), untrusted: true },
      { name: 'graphPath', run: () => g.graphPath(nodeA, nodeB), untrusted: true },
      { name: 'graphNeighbors', run: () => g.graphNeighbors(nodeA), untrusted: true },
      { name: 'graphGodNodes', run: () => g.graphGodNodes(), untrusted: true },
      { name: 'graphExplain', run: () => g.graphExplain({ edgeId }), untrusted: true },
      { name: 'buildGraph', run: () => g.buildGraph({ minEntityConversations: 1 }), untrusted: false },
      { name: 'createDraft', run: () => g.createDraft({ conversationRef: ID.linear, body: 'x' }), untrusted: true },
      { name: 'getDraft', run: () => g.getDraft(draftId), untrusted: true },
      { name: 'listDrafts', run: () => g.listDrafts(), untrusted: true },
      { name: 'archiveDraft', run: () => g.archiveDraft(draftId), untrusted: true },
      { name: 'renderDraftMarkdown', run: () => g.renderDraftMarkdown(draftId), untrusted: true },
      { name: 'createAnnotation', run: () => g.createAnnotation({ conversationRef: ID.linear, body: 'y' }), untrusted: true },
      { name: 'updateAnnotation', run: () => g.updateAnnotation(annotationId, { body: 'z', expectedVersion: 1 }), untrusted: true },
      { name: 'getAnnotation', run: () => g.getAnnotation(annotationId), untrusted: true },
      { name: 'listAnnotations', run: () => g.listAnnotations(), untrusted: true },
      { name: 'importExport', run: () => g.importExport({ source: { kind: 'path', path: exportPath } }), untrusted: true },
      { name: 'importManualCopy', run: () => g.importManualCopy('{"messages":[{"role":"user","text":"table copy"}]}'), untrusted: true },
    ];
  });
  after(async () => {
    await t.cleanup();
    await removeDir(extraDir);
  });

  it('source, completeness, warnings, ids and untrustedContent are present on EVERY envelope; non-full sources are flagged first', async () => {
    assert.ok(rows.length >= 27);
    for (const row of rows) {
      const env = await row.run();
      assertEnvelopeShape(env);
      assert.ok(COMPLETENESS.includes(env.completeness), `${row.name}: completeness ${env.completeness}`);
      if (env.completeness === 'exported_tree') {
        assert.ok(!warningCodes(env).includes('SOURCE_NOT_FULL_HISTORY'), `${row.name}: a complete tree is not flagged`);
        assert.ok(env.source.length > 0 && env.source.every((s) => s.completeness === 'exported_tree'), row.name);
      } else {
        assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY', `${row.name}: completeness ${env.completeness} must come with SOURCE_NOT_FULL_HISTORY first`);
        assert.match(env.warnings[0]?.message ?? '', /NOT the full conversation history/, row.name);
      }
      assert.equal(env.untrustedContent, row.untrusted, `${row.name}: untrustedContent`);
      assert.equal(JSON.stringify(env).includes(t.dir), false, `${row.name}: no directory of the operator in the envelope`);
      assert.ok(env.source.every((s) => /^b_[0-9a-f]{32}$/.test(s.batchId) && typeof s.importedAt === 'string' && s.toolVersion.length > 0), row.name);
    }
  });

  it('reads are deterministic: the same call gives a deep-equal envelope', () => {
    for (const row of rows.slice(0, 15)) {
      const a = row.run();
      const b = row.run();
      assert.ok(!(a instanceof Promise), row.name);
      assert.deepEqual(a, b, row.name);
    }
  });

  it('graphExportHtml carries the same provenance fields', () => {
    const out = t.gcr.graphExportHtml({ term: 'quokka' });
    assert.ok(Array.isArray(out.source) && Array.isArray(out.warnings));
    assert.equal(typeof out.completeness, 'string');
    assert.equal(out.untrustedContent, true);
    assert.ok(out.source.length > 0);
  });
});

describe('completeness across sources', () => {
  it('an official ChatGPT export alone is a complete exported tree', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      await importBuilders(gcr, dir, [chat(ID.linear, 'complete', [['q', 'a']])]);
      const env = gcr.list();
      assert.equal(env.completeness, 'exported_tree');
      assert.deepEqual(env.warnings, []);
      assert.equal(env.source[0]?.provenance, 'official_chatgpt_export');
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });

  it('ChatGPT export + Claude export + manual copy: "mixed", three sources in import order, the warning names the weakest and the batches at fault', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      const a = await importBuilders(gcr, dir, [chat(ID.linear, 'official', [['official question', 'official answer']])]);
      const b = await importClaude(gcr, dir, [syntheticUuid(0xb1)]);
      const c = await gcr.importManualCopy(JSON.stringify({ conversationId: syntheticUuid(0xb2), messages: [{ role: 'user', text: 'copied' }] }));
      const env = gcr.list();
      assert.equal(env.completeness, 'mixed');
      assert.deepEqual(env.source.map((s) => s.batchId), [a.data.batchId, b.data.batchId, c.data.batchId]);
      assert.deepEqual(env.source.map((s) => s.provenance), ['official_chatgpt_export', 'official_claude_export', 'user_supplied_copy']);
      assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
      assert.match(env.warnings[0]?.message ?? '', /weakest: partial_user_supplied/);
      assert.deepEqual(env.warnings[0]?.ids, [b.data.batchId, c.data.batchId], 'only the batches that are not complete trees');

      // narrowing the result narrows the claim
      assert.equal(gcr.list({ provider: 'claude' }).completeness, 'rendered_active_view_only');
      assert.equal(gcr.get(syntheticUuid(0xb2)).completeness, 'partial_user_supplied');
      assert.equal(gcr.get(ID.linear).completeness, 'exported_tree');
      assert.equal(gcr.search({ query: 'official' }).completeness, 'exported_tree');
      assert.equal(gcr.search({ query: 'copied' }).completeness, 'partial_user_supplied');
      assert.equal(gcr.stats({ groupBy: 'provider' }).completeness, 'mixed');
      assert.equal(gcr.stats({ groupBy: 'provider', provider: 'claude' }).completeness, 'rendered_active_view_only');
      assert.equal(gcr.audit({ provider: 'claude' }).completeness, 'rendered_active_view_only');
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });

  it('a Claude conversation read says "rendered_active_view_only" and what is missing', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      await importClaude(gcr, dir, [syntheticUuid(0xb3)]);
      for (const env of [gcr.get(syntheticUuid(0xb3)), gcr.thread(syntheticUuid(0xb3)), gcr.branches(syntheticUuid(0xb3))] as Array<ResultEnvelope<unknown>>) {
        assert.equal(env.completeness, 'rendered_active_view_only');
        assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
        assert.match(env.warnings[0]?.message ?? '', /active view/);
        assert.match(env.warnings[0]?.message ?? '', /not rendered are missing/);
      }
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });

  it('a conversation the importer could not prove complete (no current_node) is "unknown" and flagged, even from an official export', async () => {
    const t = await standardDb();
    try {
      const env = t.gcr.get(ID.noCurrent, { branchPolicy: 'latest_leaf' });
      assert.equal(env.completeness, 'unknown');
      assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
      assert.ok(warningCodes(env).includes('COMPLETENESS_LOWERED'), 'the importer\'s own reason is kept');
      assert.equal(t.gcr.listBatches()[0]?.completeness, 'exported_tree', 'the batch row alone would have said "complete"');
    } finally {
      await t.cleanup();
    }
  });

  it('an empty database: nothing contributed, completeness "unknown", and an empty answer is not proof of absence', async () => {
    const e = await emptyDb();
    try {
      for (const env of [e.gcr.list(), e.gcr.search({ query: 'anything' }), e.gcr.stats({ groupBy: 'role' }), e.gcr.audit(), e.gcr.listDrafts(), e.gcr.listAnnotations()] as Array<ResultEnvelope<unknown>>) {
        assert.equal(env.completeness, 'unknown');
        assert.deepEqual(env.source, []);
        assert.match(env.warnings[0]?.message ?? '', /not proof/);
      }
    } finally {
      await e.cleanup();
    }
  });

  it('importing an export with no conversations still names its batch as the source; the importer marks such a batch "unknown" and the envelope says so', async () => {
    const e = await emptyDb();
    try {
      const path = await writeText(e.dir, 'none/conversations.json', '[]');
      const env = await e.gcr.importExport({ source: { kind: 'path', path } });
      assert.equal(env.data.conversations.stored, 0);
      assert.equal(env.source.length, 1);
      assert.equal(env.source[0]?.batchId, env.data.batchId);
      assert.equal(env.completeness, 'unknown', 'nothing was read, so nothing is claimed');
      assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
      assert.deepEqual(env.warnings[0]?.ids, [env.data.batchId]);
    } finally {
      await e.cleanup();
    }
  });

  it('source labels are basenames even when the export was read from a deep private directory', async () => {
    const e = await emptyDb();
    try {
      const path = await writeText(e.dir, 'home/someone/very-private/Downloads/chatgpt-export-2026/conversations.json', conversationsJson([chat(ID.linear, 'deep', [['q', 'a']])]));
      const env = await e.gcr.importExport({ source: { kind: 'path', path } });
      assert.equal(env.source[0]?.sourceLabel, 'conversations.json');
      for (const out of [env, e.gcr.list(), e.gcr.get(ID.linear), ...e.gcr.listBatches().map((b) => b)]) {
        const wire = JSON.stringify(out);
        assert.ok(!wire.includes('very-private') && !wire.includes('Downloads') && !wire.includes(e.dir));
      }
    } finally {
      await e.cleanup();
    }
  });

  it('a newer second export: reads cite the newer batch only; allBatches cites both', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      const first = await importBuilders(gcr, dir, [chat(ID.linear, 'v1', [['q', 'old']])]);
      const second = await importBuilders(gcr, dir, [chat(ID.linear, 'v2', [['q', 'new']], { updateTime: 1_760_900_000 })]);
      assert.deepEqual(gcr.get(ID.linear).source.map((s) => s.batchId), [second.data.batchId]);
      assert.deepEqual(gcr.list().source.map((s) => s.batchId), [second.data.batchId]);
      assert.deepEqual(gcr.search({ query: 'new' }).source.map((s) => s.batchId), [second.data.batchId]);
      assert.deepEqual(gcr.search({ query: 'old' }).data.items, [], 'the superseded snapshot is not searched by default');
      const all = gcr.search({ query: 'old', allBatches: true });
      assert.deepEqual(all.source.map((s) => s.batchId), [first.data.batchId]);
      assert.ok(warningCodes(all).includes('SUPERSEDED_SNAPSHOTS_INCLUDED'));
      assert.deepEqual(gcr.list({ allBatches: true }).source.map((s) => s.batchId), [first.data.batchId, second.data.batchId]);
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });
});
