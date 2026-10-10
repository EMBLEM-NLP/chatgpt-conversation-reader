/**
 * Pagination tests: offset pages, keyset (cursor) pages and a single big page must return the identical sequence in
 * the documented total order, with no repeated and no skipped rows (FR-05 "stable sort", "pagination"). All data is
 * synthetic; the property tests use a fixed seed that is printed on failure.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import type { DatabaseSync } from 'node:sqlite';
import type { SearchHit } from '../../src/domain/results.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { searchMessages } from '../../src/db/search.js';
import type { SearchQuery } from '../../src/db/search.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const SEED = 20261015;

async function runProperty<Ts extends unknown[]>(prop: fc.IAsyncPropertyWithHooks<Ts>, numRuns: number): Promise<void> {
  try {
    await fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'export.zip',
  contentDigest: 'digest-1',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

interface MsgSpec {
  text: string;
  createdAt: string | null;
  hidden: boolean;
}

function conv(id: string, specs: MsgSpec[], idPrefix: string, over: Partial<ConversationRecord> = {}): ConversationRecord {
  let prev: string | null = null;
  const msgs = specs.map((s, i) => {
    const m = msg({ id: `${idPrefix}${i}`, conversationId: id, parentId: prev, authorRole: 'user', createdAt: s.createdAt, hidden: s.hidden, text: s.text, ordinal: i });
    prev = m.id;
    return m;
  });
  return convo(id, link(msgs), over);
}

const keyOf = (h: SearchHit): string => `${h.provider}|${h.accountLabel}|${h.batchId}|${h.conversationId}|${h.messageId}`;

/** The documented total order, evaluated in JS (ids in these tests are ASCII, so JS and SQLite BINARY order agree). */
function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  const an = a.createdAt === null ? 1 : 0;
  const bn = b.createdAt === null ? 1 : 0;
  if (an !== bn) return an - bn;
  const parts: Array<[string, string]> = [
    [a.createdAt ?? '', b.createdAt ?? ''],
    [a.conversationId, b.conversationId],
    [a.messageId, b.messageId],
    [a.provider, b.provider],
    [a.accountLabel, b.accountLabel],
    [a.batchId, b.batchId],
  ];
  for (const [x, y] of parts) if (x !== y) return x < y ? -1 : 1;
  return 0;
}

function fetchAll(db: DatabaseSync, q: SearchQuery): SearchHit[] {
  const page = searchMessages(db, { ...q, limit: 200 });
  assert.equal(page.nextOffset, null, 'corpus must fit in one page');
  assert.equal(page.nextCursor, null);
  return page.items;
}

function walkByOffset(db: DatabaseSync, q: SearchQuery, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  let offset = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const page = searchMessages(db, { ...q, limit, offset });
    assert.equal(page.offset, offset);
    assert.ok(page.items.length <= limit);
    out.push(...page.items);
    if (page.nextOffset === null) {
      assert.equal(page.nextCursor, null, 'offset and cursor exhaust together');
      return out;
    }
    assert.equal(page.nextOffset, offset + page.items.length);
    assert.equal(page.items.length, limit, 'a non-final page is full');
    offset = page.nextOffset;
  }
  throw new Error('pagination did not terminate');
}

function walkByCursor(db: DatabaseSync, q: SearchQuery, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = searchMessages(db, cursor === undefined ? { ...q, limit } : { ...q, limit, cursor });
    assert.ok(page.items.length <= limit);
    out.push(...page.items);
    if (page.nextCursor === null || page.nextCursor === undefined) {
      assert.equal(page.nextOffset, null);
      return out;
    }
    assert.equal(page.items.length, limit, 'a non-final page is full');
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

const textArb = fc.array(fc.constantFrom('alpha', 'beta', 'gamma', 'delta'), { minLength: 1, maxLength: 10 }).map((a) => a.join(' '));
const specArb: fc.Arbitrary<MsgSpec> = fc.record({
  text: textArb,
  createdAt: fc.constantFrom<string | null>(null, iso(1), iso(2), iso(2), iso(3)),
  hidden: fc.boolean(),
});
const caseArb = fc.record({
  convs: fc.array(fc.array(specArb, { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 5 }),
  secondSnapshot: fc.boolean(),
  otherAccount: fc.boolean(),
  limit: fc.integer({ min: 1, max: 7 }),
  query: fc.constantFrom('alpha', 'beta gamma', 'delta*', '"alpha beta"', 'gamma'),
  includeHidden: fc.boolean(),
  allBatches: fc.boolean(),
});

describe('searchMessages pagination', () => {
  it('offset pages, cursor pages and one big page agree exactly, in the documented total order, without duplicates (property)', async () => {
    await runProperty(
      fc.asyncProperty(caseArb, async (c) => {
        const h = openDatabase(':memory:');
        try {
          const repo = new Repository(h.db);
          const records = c.convs.map((specs, i) => conv(`c${i}`, specs, `c${i}-m`, { updatedAt: iso(10) }));
          await repo.importBatch({ batch: META, conversations: records });
          if (c.secondSnapshot) {
            // same conversation id AND same message ids in a later snapshot: only the batch tells them apart
            const again = conv('c0', c.convs[0] ?? [], 'c0-m', { updatedAt: iso(20) });
            await repo.importBatch({ batch: { ...META, contentDigest: 'v2' }, conversations: [again] });
          }
          if (c.otherAccount) {
            const other = { ...conv('c0', c.convs[0] ?? [], 'c0-m', { updatedAt: iso(10) }), accountLabel: 'other' };
            await repo.importBatch({ batch: { ...META, accountLabel: 'other', contentDigest: 'o' }, conversations: [other] });
          }
          const q: SearchQuery = { query: c.query, includeHidden: c.includeHidden, allBatches: c.allBatches };
          const big = fetchAll(h.db, q);
          const keys = big.map(keyOf);
          assert.equal(new Set(keys).size, keys.length, 'no duplicate rows');
          for (let i = 1; i < big.length; i++) {
            const prev = big[i - 1];
            const cur = big[i];
            assert.ok(prev !== undefined && cur !== undefined && compareHits(prev, cur) < 0, `rows ${i - 1},${i} must be in strictly increasing total order`);
          }
          assert.deepEqual(walkByOffset(h.db, q, c.limit).map(keyOf), keys);
          assert.deepEqual(walkByCursor(h.db, q, c.limit).map(keyOf), keys);
          // visibility rules hold on every page
          if (!c.includeHidden) assert.ok(big.every((x) => !x.hidden));
        } finally {
          h.db.close();
        }
      }),
      60,
    );
  });

  it('single-row pages walk a mixed corpus (nulls, ties, hidden) identically by offset and by cursor', async () => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const specs: MsgSpec[] = Array.from({ length: 30 }, (_, i) => ({ text: i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'alpha beta' : 'beta alpha gamma delta', createdAt: i % 4 === 0 ? null : iso(i % 5), hidden: i % 7 === 0 }));
    await repo.importBatch({ batch: META, conversations: [conv('c0', specs, 'm'), conv('c1', specs, 'm')] });
    const q: SearchQuery = { query: 'alpha', includeHidden: true };
    const big = fetchAll(h.db, q);
    assert.equal(big.length, 60);
    assert.deepEqual(walkByOffset(h.db, q, 1).map(keyOf), big.map(keyOf));
    assert.deepEqual(walkByCursor(h.db, q, 1).map(keyOf), big.map(keyOf));
    assert.deepEqual(walkByCursor(h.db, q, 13).map(keyOf), big.map(keyOf));
    // ties: rows with identical text/rank are ordered by created_at (NULL last), then ids
    const sameRank = big.filter((x) => x.rank === big[0]?.rank);
    assert.ok(sameRank.length > 2);
    for (let i = 1; i < sameRank.length; i++) {
      const a = sameRank[i - 1];
      const b = sameRank[i];
      assert.ok(a !== undefined && b !== undefined && compareHits(a, b) < 0);
    }
  });

  it('pages past the end are empty with no continuation, and exact multiples of the page size end cleanly', async () => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const specs: MsgSpec[] = Array.from({ length: 6 }, () => ({ text: 'alpha', createdAt: iso(1), hidden: false }));
    await repo.importBatch({ batch: META, conversations: [conv('c0', specs, 'm')] });
    const beyond = searchMessages(h.db, { query: 'alpha', offset: 100 });
    assert.deepEqual([beyond.items, beyond.nextOffset, beyond.nextCursor], [[], null, null]);
    const exact = searchMessages(h.db, { query: 'alpha', limit: 6 });
    assert.equal(exact.items.length, 6);
    assert.equal(exact.nextOffset, null, 'exactly one full page: nothing follows');
    assert.equal(exact.nextCursor, null);
    const first = searchMessages(h.db, { query: 'alpha', limit: 3 });
    assert.equal(first.nextOffset, 3);
    assert.ok(first.nextCursor);
    const last = searchMessages(h.db, { query: 'alpha', limit: 3, cursor: first.nextCursor ?? '' });
    assert.equal(last.items.length, 3);
    assert.equal(last.nextCursor, null);
    assert.equal(last.offset, 0, 'cursor pages report offset 0');
    assert.deepEqual([...first.items, ...last.items].map(keyOf), fetchAll(h.db, { query: 'alpha' }).map(keyOf));
  });

  it('a cursor stays usable (no error) after unrelated data is imported between pages', async () => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const specs: MsgSpec[] = Array.from({ length: 8 }, (_, i) => ({ text: `alpha ${'x '.repeat(i)}`, createdAt: iso(i), hidden: false }));
    await repo.importBatch({ batch: META, conversations: [conv('c0', specs, 'm')] });
    const first = searchMessages(h.db, { query: 'alpha', limit: 3 });
    await repo.importBatch({ batch: { ...META, contentDigest: 'later' }, conversations: [conv('c1', specs, 'n')] });
    const next = searchMessages(h.db, { query: 'alpha', limit: 3, cursor: first.nextCursor ?? '' });
    assert.ok(Array.isArray(next.items));
  });

  it('rejects page parameters outside their bounds', async () => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    await repo.importBatch({ batch: META, conversations: [conv('c0', [{ text: 'alpha', createdAt: null, hidden: false }], 'm')] });
    for (const extra of [{ limit: 0 }, { limit: 201 }, { limit: -1 }, { offset: -1 }, { offset: 10_000_001 }, { limit: 2.5 }]) {
      assert.throws(() => searchMessages(h.db, { query: 'alpha', ...extra }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', JSON.stringify(extra));
    }
    assert.equal(searchMessages(h.db, { query: 'alpha', limit: 200 }).limit, 200);
    assert.equal(searchMessages(h.db, { query: 'alpha' }).limit, 20, 'default page size is 20');
  });
});
