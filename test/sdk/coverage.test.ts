/**
 * Gaps the focused suites leave: the type surface of src/index.ts against the contract files, thread() options, raw FTS mode,
 * statistics paging and time zones, snapshot ordering and a scale smoke test (hundreds of conversations through the whole facade).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { ID, assertCode, assertEnvelopeShape, chat, fixedClock, importBuilders, makeTempDir, removeDir, standardDb } from './sdk.helpers.test.js';

const root = new URL('../../../', import.meta.url);

/** Names of `export interface|type|class|const|function X` declarations of a source file. */
function declaredExports(text: string): string[] {
  return [...text.matchAll(/^export\s+(?:declare\s+)?(?:interface|type|class|const|function|enum)\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1] as string);
}

describe('src/index.ts re-exports the whole contract', () => {
  it('every type of src/domain/types.ts and src/domain/results.ts is exported', async () => {
    const index = await readFile(new URL('src/index.ts', root), 'utf8');
    for (const file of ['src/domain/types.ts', 'src/domain/results.ts']) {
      const names = declaredExports(await readFile(new URL(file, root), 'utf8'));
      assert.ok(names.length >= 9, file);
      for (const n of names) assert.match(index, new RegExp(`\\b${n}\\b`), `${n} (from ${file}) must be exported from src/index.ts`);
    }
  });

  it('the documented error/version/reference/renderer/import/analysis/graph/drafts names are exported', async () => {
    const index = await readFile(new URL('src/index.ts', root), 'utf8');
    for (const n of [
      'GcrError', 'ErrorCode', 'ERROR_CODES', 'EXIT_CODES', 'ErrorEnvelope', 'Warning', 'TOOL_VERSION', 'TOOL_NAME', 'SCHEMA_VERSION',
      'parseChatGptUrl', 'parseConversationRef', 'renderThread', 'renderConversationList', 'renderSearchHits', 'renderBranchList', 'renderImportReport',
      'renderEnvelope', 'RenderOptions', 'ImportOptions', 'ImportReport', 'AdapterId', 'StatsOptions', 'StatsResult', 'AuditOptions', 'AuditResult',
      'BuildGraphOptions', 'GraphQueryInput', 'GraphQueryResult', 'PathResult', 'ExplainEdgeResult', 'DraftDto', 'AnnotationDto', 'DoctorReport', 'Gcr',
    ]) {
      assert.match(index, new RegExp(`\\b${n}\\b`), `${n} must be exported from src/index.ts`);
    }
  });

  it('internals are deliberately not re-exported: toGcrError, the local store, the repository', async () => {
    const index = await readFile(new URL('src/index.ts', root), 'utf8');
    for (const n of ['toGcrError', 'LocalStore', 'Repository', 'openDatabase', 'normalizeError', 'buildEnvelope']) assert.doesNotMatch(index, new RegExp(`\\b${n}\\b`), n);
  });
});

describe('thread() options', () => {
  it('includeHidden, includeRaw and batchId shape the answer like get()', async () => {
    const t = await standardDb();
    try {
      const plain = t.gcr.thread(ID.hidden);
      assert.equal(plain.data.messages.length, 2);
      assert.equal(plain.data.omittedHidden, 1);
      assert.ok(plain.data.messages.every((m) => m.rawSource === undefined));
      const full = t.gcr.thread(ID.hidden, { includeHidden: true, includeRaw: true });
      assert.equal(full.data.messages.length, 3);
      assert.equal(full.data.omittedHidden, 0);
      assert.ok(full.data.messages.every((m) => m.rawSource !== undefined));
      const batchId = t.gcr.listBatches()[0]?.batchId ?? '';
      assert.deepEqual(t.gcr.thread(ID.hidden, { batchId }).data, plain.data);
      assertCode(() => t.gcr.thread(ID.hidden, { batchId: 'b_nope' }), 'NOT_IN_LOCAL_EXPORT');
    } finally {
      await t.cleanup();
    }
  });
});

describe('search: raw FTS5 mode and Unicode', () => {
  it('raw mode passes FTS5 operators through; plain mode treats them as words', async () => {
    const t = await standardDb();
    try {
      const plain = t.gcr.search({ query: 'quokka OR sharks' });
      const raw = t.gcr.search({ query: 'quokka OR sharks', mode: 'raw' });
      assert.equal(plain.data.items.length, 0, 'plain: "OR" is just another required word');
      assert.equal(raw.data.items.length, 8, 'raw: a real OR');
      assert.equal(t.gcr.search({ query: 'quokka NOT habitat', mode: 'raw' }).data.items.length >= 6, true);
      assert.equal(t.gcr.search({ query: '"quokka lives"', mode: 'raw' }).data.items.length, 1, 'phrase query');
    } finally {
      await t.cleanup();
    }
  });

  it('queries are NFKC-normalized (full-width and compatibility forms match their plain equivalents)', async () => {
    const t = await standardDb();
    try {
      assert.equal(t.gcr.search({ query: 'ｑｕｏｋｋａ' }).data.items.length, 8);
    } finally {
      await t.cleanup();
    }
  });
});

describe('stats: paging, days and time zones', () => {
  it('pages through rows with limit/offset without repeats; day grouping honours tz and rejects unknown zones', async () => {
    const t = await standardDb();
    try {
      const all = t.gcr.stats({ groupBy: 'conversation', limit: 1000 }).data.rows.map((r) => `${r.provider}/${r.accountLabel}/${r.key}`);
      const seen: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: ReturnType<typeof t.gcr.stats>['data'] = t.gcr.stats({ groupBy: 'conversation', limit: 4, offset }).data;
        seen.push(...page.rows.map((r) => `${r.provider}/${r.accountLabel}/${r.key}`));
        offset = page.nextOffset;
      }
      assert.deepEqual(seen, all);
      assert.equal(new Set(seen).size, seen.length);
      const utc = t.gcr.stats({ groupBy: 'day' });
      const tokyo = t.gcr.stats({ groupBy: 'day', tz: 'Asia/Tokyo' });
      assert.equal(utc.data.tz, 'UTC');
      assert.equal(tokyo.data.tz, 'Asia/Tokyo');
      assertCode(() => t.gcr.stats({ groupBy: 'day', tz: 'Mars/Olympus' }), 'INVALID_ARGUMENT');
    } finally {
      await t.cleanup();
    }
  });

  it('audit and stats honour allBatches (superseded snapshots) and say so', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      await importBuilders(gcr, dir, [chat(ID.linear, 'v1', [['q', 'old']])]);
      await importBuilders(gcr, dir, [chat(ID.linear, 'v2', [['q', 'new']], { updateTime: 1_760_900_000 })]);
      assert.equal(gcr.audit().data.scanned.conversations, 1);
      assert.equal(gcr.audit({ allBatches: true }).data.scanned.conversations, 2);
      assert.equal(gcr.audit({ allBatches: true }).source.length, 2);
      assert.equal(gcr.stats({ groupBy: 'role' }).data.totals.conversations, 1);
      assert.equal(gcr.stats({ groupBy: 'role', allBatches: true }).source.length, 2);
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });
});

describe('scale smoke: hundreds of conversations through the whole facade', () => {
  it('imports 400 conversations and answers list, get, search, stats, audit and the graph without pathological slowness', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: `${dir}/scale.sqlite`, clock: fixedClock });
    try {
      const builders = Array.from({ length: 400 }, (_, i) =>
        chat(syntheticUuid(0x1000 + i), `topic ${i % 20} conversation ${i}`, [
          [`question about topic${i % 20} and zebra${i % 7}`, `answer about topic${i % 20}`],
          [`follow up ${i}`, `closing reply ${i}`],
        ]),
      );
      const started = Date.now();
      const imp = await importBuilders(gcr, dir, builders);
      assert.equal(imp.data.conversations.stored, 400);

      const list = gcr.list({ limit: 200 });
      assert.equal(list.data.total, 400);
      assert.equal(list.data.items.length, 200);
      assert.equal(list.source.length, 1);
      assertEnvelopeShape(list);

      assert.equal(gcr.get(syntheticUuid(0x1000 + 123)).data.thread?.messages.length, 4);
      assert.equal(gcr.search({ query: 'zebra3', limit: 200 }).data.items.length, Math.ceil((400 - 3) / 7));
      assert.equal(gcr.search({ query: 'topic5', scope: 'all', limit: 100 }).data.items.length, 40, '20 conversations x 2 messages mention topic5; no title contains that single token');
      assert.equal(gcr.stats({ groupBy: 'role' }).data.totals.messages, 1600);
      assert.equal(gcr.audit().data.scanned.conversations, 400);

      const built = await gcr.buildGraph({ minEntityConversations: 2 });
      assert.ok(built.data.nodes > 400);
      assert.equal(built.completeness, 'exported_tree');
      assert.ok(gcr.graphQuery({ term: 'topic5' }).data.nodes.length > 1);
      assert.ok(gcr.graphExportHtml({ maxNodes: 200 }).html.length > 1000);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 60_000, `the whole scenario took ${elapsed} ms`);
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });
});
