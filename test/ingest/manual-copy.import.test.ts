/**
 * Mode B (manual copy), part 2: runManualCopyImport against a real Repository. Everything stored and reported is
 * flagged partial; invalid documents change nothing; the import is idempotent; searching works; a partial copy
 * never silently replaces a complete official export as the head.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchMessages } from '../../src/db/search.js';
import { GcrError } from '../../src/errors.js';
import { runImport } from '../../src/ingest/import-runner.js';
import { runManualCopyImport } from '../../src/ingest/manual-copy.js';
import { TOOL_VERSION } from '../../src/version.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { arrayOf, chatConv, count, dbDump, errorSurface, expectCode, fixedClock, freshRepo, writeFileIn } from './import-runner.helpers.test.js';

const ID = syntheticUuid(0xaa);
const DOC = JSON.stringify({
  conversationId: ID,
  title: 'Pasted from the web page',
  sourceUri: `https://chatgpt.com/c/${ID}`,
  messages: [
    { role: 'user', text: 'What is a quokka?', createdAt: '2025-03-04T05:06:07Z' },
    { role: 'assistant', text: 'A quokka is a small marsupial.', modelSlug: 'synthetic-model-1' },
  ],
});

describe('runManualCopyImport', () => {
  it('stores a partial, user-supplied conversation and says so in the batch, the record and the report', async () => {
    const t = freshRepo();
    try {
      const r = await runManualCopyImport(t.repo, { text: DOC, clock: fixedClock, sourceLabel: '/tmp/private/pasted.json' });
      assert.equal(r.provider, 'chatgpt');
      assert.equal(r.sourceKind, 'manual_copy');
      assert.equal(r.sourceLabel, 'pasted.json');
      assert.equal(r.alreadyImported, false);
      assert.deepEqual(r.conversations, { read: 1, stored: 1, failed: 0, newlyInserted: 1 });
      assert.deepEqual(r.messages, { stored: 2, newlyInserted: 2, structural: 0 });
      assert.equal(r.formatProfile, undefined, 'there is no export to profile');
      assert.equal(r.warnings.find((w) => w.code === 'PARTIAL_USER_SUPPLIED')?.count, 1);
      assert.deepEqual(r.warnings.find((w) => w.code === 'PARTIAL_USER_SUPPLIED')?.sampleIds, [ID]);

      const b = t.repo.getBatch(r.batchId);
      assert.ok(b);
      assert.equal(b.provenance, 'user_supplied_copy');
      assert.equal(b.completeness, 'partial_user_supplied');
      assert.equal(b.sourceKind, 'manual_copy');
      assert.equal(b.toolVersion, TOOL_VERSION);
      assert.equal(b.importedAt, '2026-02-03T04:05:06.007Z');
      assert.ok(b.warnings.some((w) => w.code === 'PARTIAL_USER_SUPPLIED'));

      const rec = t.repo.getConversation({ conversationId: ID });
      assert.ok(rec);
      assert.equal(rec.provenance, 'user_supplied_copy');
      assert.equal(rec.completeness, 'partial_user_supplied');
      assert.equal(rec.currentNodeId, null);
      assert.equal(rec.sourceUri, `https://chatgpt.com/c/${ID}`);
      assert.ok(rec.warnings.some((w) => w.code === 'PARTIAL_USER_SUPPLIED'));
      assert.deepEqual(rec.messages.map((m) => m.modelSlug), [null, 'synthetic-model-1']);
      const listed = t.repo.listConversations({ provider: 'chatgpt' }).items[0];
      assert.equal(listed?.completeness, 'partial_user_supplied');
      assert.equal(listed?.provenance, 'user_supplied_copy');
    } finally {
      t.close();
    }
  });

  it('the copy is searchable like any other imported text', async () => {
    const t = freshRepo();
    try {
      await runManualCopyImport(t.repo, { text: DOC, clock: fixedClock });
      const hits = searchMessages(t.db, { query: 'quokka marsupial' });
      assert.equal(hits.items.length, 1);
      assert.equal(hits.items[0]?.conversationId, ID);
      assert.equal(hits.items[0]?.authorRole, 'assistant');
    } finally {
      t.close();
    }
  });

  it('importing the same content again is an idempotent no-op (also when the JSON is spelled differently)', async () => {
    const t = freshRepo();
    try {
      const first = await runManualCopyImport(t.repo, { text: DOC, clock: fixedClock });
      const dump = dbDump(t.db);
      const respelled = JSON.stringify(JSON.parse(DOC), null, 4).replace('2025-03-04T05:06:07Z', '2025-03-04T06:06:07+01:00');
      const second = await runManualCopyImport(t.repo, { text: respelled, clock: () => '2031-01-01T00:00:00.000Z' });
      assert.equal(second.alreadyImported, true);
      assert.equal(second.batchId, first.batchId);
      assert.deepEqual(second.conversations, { read: 1, stored: 1, failed: 0, newlyInserted: 0 });
      assert.deepEqual(second.messages, { stored: 2, newlyInserted: 0, structural: 0 });
      assert.deepEqual(second.warnings, first.warnings, 'the stored warnings reproduce the first report');
      assert.equal(dbDump(t.db), dump);
    } finally {
      t.close();
    }
  });

  it('without a conversationId the synthesized id is stable across imports', async () => {
    const t = freshRepo();
    try {
      const text = JSON.stringify({ messages: [{ role: 'user', text: 'hello there' }] });
      const a = await runManualCopyImport(t.repo, { text, clock: fixedClock });
      const b = await runManualCopyImport(t.repo, { text, clock: fixedClock });
      assert.equal(b.alreadyImported, true);
      assert.equal(a.warnings.find((w) => w.code === 'CONVERSATION_ID_SYNTHESIZED')?.count, 1);
      assert.equal(count(t.db, 'conversations'), 1);
    } finally {
      t.close();
    }
  });

  it('invalid documents fail with the right code and change nothing', async () => {
    const t = freshRepo();
    try {
      const before = dbDump(t.db);
      const cases: Array<[string, string, string]> = [
        ['not json', 'PLANTED {', 'IMPORT_PARSE_ERROR'],
        ['wrong shape', '{"messages": "x"}', 'IMPORT_PARSE_ERROR'],
        ['bad uri', JSON.stringify({ sourceUri: 'https://chatgpt.com/share/x', messages: [{ role: 'user', text: 'x' }] }), 'INVALID_URL'],
        ['bad uuid', JSON.stringify({ conversationId: 'PLANTED', messages: [{ role: 'user', text: 'x' }] }), 'INVALID_UUID'],
        ['no messages', '{"messages": []}', 'IMPORT_PARSE_ERROR'],
        ['bad timestamp', JSON.stringify({ messages: [{ role: 'user', text: 'x', createdAt: 'later' }] }), 'IMPORT_PARSE_ERROR'],
      ];
      for (const [label, text, code] of cases) {
        await assert.rejects(runManualCopyImport(t.repo, { text, clock: fixedClock }), (e: unknown) => {
          assert.ok(e instanceof GcrError, label);
          assert.equal(e.code, code, label);
          assert.ok(!errorSurface(e).includes('PLANTED'), label);
          return true;
        });
      }
      assert.equal(dbDump(t.db), before);
      await assert.rejects(runManualCopyImport(t.repo, { text: DOC, accountLabel: '' }), expectCode('INVALID_ARGUMENT'));
      await assert.rejects(runManualCopyImport(t.repo, { text: DOC, clock: () => 'nope' }), expectCode('INVALID_ARGUMENT'));
    } finally {
      t.close();
    }
  });

  it('account labels isolate manual copies like any other import', async () => {
    const t = freshRepo();
    try {
      await runManualCopyImport(t.repo, { text: DOC, accountLabel: 'alice', clock: fixedClock });
      const b = await runManualCopyImport(t.repo, { text: DOC, accountLabel: 'bob', clock: fixedClock });
      assert.equal(b.alreadyImported, false);
      assert.equal(count(t.db, 'conversations'), 2);
    } finally {
      t.close();
    }
  });

  it('a partial copy of a conversation never replaces a dated official export as the head', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(0xaa, { title: 'OFFICIAL', updateTime: 1_760_000_000 })]));
        const official = await runImport(t.repo, { source: { kind: 'path', path: file }, clock: fixedClock });
        await runManualCopyImport(t.repo, { text: DOC, clock: fixedClock });
        const head = t.repo.getConversation({ conversationId: ID });
        assert.equal(head?.title, 'OFFICIAL');
        assert.equal(head?.completeness, 'exported_tree');
        assert.equal(t.repo.resolveConversation({ conversationId: ID }).matches[0]?.batchId, official.batchId);
        // The partial snapshot is still there, pinnable, and clearly marked.
        const snapshots = t.repo.listBatches().filter((b) => b.sourceKind === 'manual_copy');
        assert.equal(snapshots.length, 1);
        assert.equal(t.repo.getConversation({ conversationId: ID, batchId: snapshots[0]?.batchId })?.completeness, 'partial_user_supplied');
      });
    } finally {
      t.close();
    }
  });

  it('sourceUri is a label only: nothing is fetched (the module imports no network or process API)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const src = await readFile(fileURLToPath(new URL('../../../src/ingest/manual-copy.ts', import.meta.url)), 'utf8').catch(() => null);
    // The compiled test may run where src/ is absent; when present, check the import list.
    if (src !== null) {
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const spec of imports) assert.ok(!/^(node:)?(http|https|net|tls|dns|dgram|child_process|worker_threads|vm)$/.test(spec), spec);
      assert.ok(!/\bfetch\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
    }
    assert.ok(true);
  });
});
