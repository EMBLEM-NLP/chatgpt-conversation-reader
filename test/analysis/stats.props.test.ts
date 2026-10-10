/**
 * Property tests for src/analysis/stats.ts (fixed seeds): the SQL aggregates agree with an independent brute-force oracle
 * computed from the generated data, pages never repeat or skip a row, and rows are in the documented total order.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { computeStats, STATS_GROUP_BY } from '../../src/analysis/stats.js';
import type { StatsGroupBy, StatsResult, StatsRow } from '../../src/analysis/stats.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { chat, claudeChat, fresh, importAll, iso } from './support.test.js';
import type { MsgSpec } from './support.test.js';

interface GenMsg {
  role: string;
  model: string | null;
  channel: string | null;
  contentType: string | null;
  hidden: boolean;
  minute: number | null;
  len: number;
}
interface GenConv {
  id: string;
  account: string;
  provider: 'chatgpt' | 'claude';
  title: string | null;
  msgs: GenMsg[];
}

const msgArb: fc.Arbitrary<GenMsg> = fc.record({
  role: fc.constantFrom('user', 'assistant', 'system', 'tool', 'weird'),
  model: fc.constantFrom<string | null>(null, 'm1', 'm2', '  '),
  channel: fc.constantFrom<string | null>(null, 'final', 'analysis'),
  contentType: fc.constantFrom<string | null>(null, 'text', 'code'),
  hidden: fc.boolean(),
  minute: fc.option(fc.integer({ min: 0, max: 60 * 24 * 4 }), { nil: null }),
  len: fc.integer({ min: 0, max: 12 }),
});

const convArb: fc.Arbitrary<GenConv> = fc.record({
  // Few ids / accounts / providers on purpose: the same conversation id must be able to exist in several scopes.
  id: fc.constantFrom('c0', 'c1', 'c2'),
  account: fc.constantFrom('default', 'alt'),
  provider: fc.constantFrom<'chatgpt' | 'claude'>('chatgpt', 'claude'),
  title: fc.constantFrom<string | null>(null, 'T0', 'T1'),
  msgs: fc.array(msgArb, { maxLength: 8 }),
});

const dataArb = fc.array(convArb, { minLength: 1, maxLength: 7 });

/** First occurrence of each (provider, account, id) wins - the same rule the importer applies within a batch. */
function dedupe(data: GenConv[]): GenConv[] {
  const seen = new Set<string>();
  return data.filter((c) => {
    const k = `${c.provider}|${c.account}|${c.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function toRecord(c: GenConv): ConversationRecord {
  const specs: MsgSpec[] = c.msgs.map((m) => ({
    role: m.role,
    model: m.model,
    channel: m.channel,
    contentType: c.provider === 'claude' ? null : m.contentType,
    hidden: m.hidden,
    at: m.minute === null ? null : iso(m.minute),
    text: 'x'.repeat(m.len),
  }));
  const over = { accountLabel: c.account, title: c.title };
  return c.provider === 'claude' ? claudeChat(c.id, specs, over) : chat(c.id, specs, over);
}

interface Expected {
  messages: number;
  conversations: Set<string>;
  characters: number;
}

/** Brute-force oracle: re-derives every group straight from the generated data. */
function oracle(data: GenConv[], groupBy: StatsGroupBy, includeHidden: boolean): Map<string, Expected> {
  const out = new Map<string, Expected>();
  for (const c of data) {
    for (const m of c.msgs) {
      if (m.hidden && !includeHidden) continue;
      const convKey = `${c.provider}|${c.account}|${c.id}`;
      let key: string | null;
      switch (groupBy) {
        case 'role':
          key = m.role;
          break;
        case 'model':
          key = m.model !== null && m.model.trim() !== '' ? m.model : null;
          break;
        case 'channel':
          key = m.channel;
          break;
        case 'provider':
          key = c.provider;
          break;
        case 'content_type':
          key = c.provider === 'claude' ? null : m.contentType;
          break;
        case 'conversation':
          key = convKey;
          break;
        case 'day':
          key = m.minute === null ? null : iso(m.minute).slice(0, 10);
          break;
      }
      const k = key === null ? '\u0000null' : `k:${key}`;
      const e = out.get(k) ?? { messages: 0, conversations: new Set<string>(), characters: 0 };
      e.messages++;
      e.conversations.add(convKey);
      e.characters += m.len;
      out.set(k, e);
    }
  }
  return out;
}

function rowKey(groupBy: StatsGroupBy, row: StatsRow): string {
  if (groupBy === 'conversation') return `k:${row.provider}|${row.accountLabel}|${row.key}`;
  return row.key === null ? '\u0000null' : `k:${row.key}`;
}

/** The documented total order: messages DESC, key ASC (NULL last); conversation ties by provider then account. */
function inOrder(groupBy: StatsGroupBy, rows: StatsRow[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1] as StatsRow;
    const b = rows[i] as StatsRow;
    if (a.messages !== b.messages) {
      if (a.messages < b.messages) return false;
      continue;
    }
    if (a.key === b.key) {
      if (groupBy !== 'conversation') return false; // equal keys can only coexist for conversation (different scope)
      const sa = `${a.provider}\u0000${a.accountLabel}`;
      const sb = `${b.provider}\u0000${b.accountLabel}`;
      if (!(sa < sb)) return false;
      continue;
    }
    if (a.key === null) return false;
    if (b.key !== null && !(a.key < b.key)) return false;
  }
  return true;
}

function collectPages(db: Parameters<typeof computeStats>[0], base: { groupBy: StatsGroupBy; includeHidden: boolean }, limit: number): StatsResult[] {
  const pages: StatsResult[] = [];
  let offset = 0;
  for (;;) {
    const page = computeStats(db, { ...base, limit, offset });
    pages.push(page);
    if (page.nextOffset === null) return pages;
    assert.equal(page.nextOffset, offset + limit, 'nextOffset advances by exactly one page');
    assert.ok(pages.length < 200, 'pagination must terminate');
    offset = page.nextOffset;
  }
}

describe('computeStats properties', () => {
  it('rows equal the brute-force oracle for every groupBy, with and without hidden messages', async () => {
    await fc.assert(
      fc.asyncProperty(dataArb, fc.boolean(), async (raw, includeHidden) => {
        const data = dedupe(raw);
        const { db, repo } = fresh();
        try {
          await importAll(repo, data.map(toRecord));
          for (const groupBy of STATS_GROUP_BY) {
            const r = computeStats(db, { groupBy, includeHidden, limit: 1000 });
            const want = oracle(data, groupBy, includeHidden);
            assert.equal(r.rows.length, want.size, `${groupBy}: number of groups`);
            for (const row of r.rows) {
              const e = want.get(rowKey(groupBy, row));
              assert.ok(e, `${groupBy}: unexpected group ${JSON.stringify(row.key)}`);
              assert.equal(row.messages, e.messages, `${groupBy}/${row.key}: messages`);
              assert.equal(row.conversations, e.conversations.size, `${groupBy}/${row.key}: conversations`);
              assert.equal(row.characters, e.characters, `${groupBy}/${row.key}: characters`);
            }
            assert.ok(inOrder(groupBy, r.rows), `${groupBy}: rows are in the documented total order`);
            const total = [...want.values()].reduce((n, e) => n + e.messages, 0);
            assert.equal(r.totals.messages, total, `${groupBy}: totals.messages`);
            assert.equal(r.nextOffset, null);
          }
        } finally {
          db.close();
        }
      }),
      { seed: 20251010, numRuns: 40 },
    );
  });

  it('pagination is stable: pages concatenate to the full list with no repeat and no skip, for any page size', async () => {
    await fc.assert(
      fc.asyncProperty(dataArb, fc.integer({ min: 1, max: 4 }), fc.boolean(), async (raw, limit, includeHidden) => {
        const data = dedupe(raw);
        const { db, repo } = fresh();
        try {
          await importAll(repo, data.map(toRecord));
          for (const groupBy of STATS_GROUP_BY) {
            const full = computeStats(db, { groupBy, includeHidden, limit: 1000 });
            const pages = collectPages(db, { groupBy, includeHidden }, limit);
            const joined = pages.flatMap((p) => p.rows);
            assert.deepEqual(joined, full.rows, `${groupBy}: concatenated pages equal the full result`);
            const ids = joined.map((row) => rowKey(groupBy, row));
            assert.equal(new Set(ids).size, ids.length, `${groupBy}: no row appears twice`);
            for (const p of pages) {
              assert.deepEqual(p.totals, full.totals, `${groupBy}: totals are page-independent`);
              assert.ok(p.rows.length <= limit);
            }
            // Only the last page may be short, and only it has no nextOffset.
            pages.slice(0, -1).forEach((p) => assert.equal(p.rows.length, limit));
          }
        } finally {
          db.close();
        }
      }),
      { seed: 424242, numRuns: 40 },
    );
  });

  it('a filter and the matching group agree: totals under role=R equal the "role" row for R', async () => {
    await fc.assert(
      fc.asyncProperty(dataArb, async (raw) => {
        const data = dedupe(raw);
        const { db, repo } = fresh();
        try {
          await importAll(repo, data.map(toRecord));
          const byRole = computeStats(db, { groupBy: 'role', limit: 1000 });
          for (const row of byRole.rows) {
            const filtered = computeStats(db, { groupBy: 'provider', role: row.key as string, limit: 1000 });
            assert.equal(filtered.totals.messages, row.messages);
            assert.equal(filtered.totals.characters, row.characters);
            assert.equal(filtered.totals.conversations, row.conversations);
          }
        } finally {
          db.close();
        }
      }),
      { seed: 99, numRuns: 30 },
    );
  });

  it('model honesty property: the null group holds exactly the messages whose source gave no (non-blank) model', async () => {
    await fc.assert(
      fc.asyncProperty(dataArb, async (raw) => {
        const data = dedupe(raw);
        const { db, repo } = fresh();
        try {
          // default_model_slug is set everywhere: it must never turn an unknown into a known model.
          await importAll(repo, data.map((c) => ({ ...toRecord(c), defaultModelSlug: 'conversation-default' })));
          const r = computeStats(db, { groupBy: 'model', limit: 1000 });
          assert.ok(!r.rows.some((x) => x.key === 'conversation-default'));
          const visible = data.flatMap((c) => c.msgs).filter((m) => !m.hidden);
          const known = visible.filter((m) => m.model !== null && m.model.trim() !== '').length;
          assert.equal(r.modelProvenance.messagesWithModel, known);
          assert.equal(r.modelProvenance.messagesWithoutModel, visible.length - known);
          const unknownRow = r.rows.find((x) => x.key === null);
          assert.equal(unknownRow?.messages ?? 0, visible.length - known);
        } finally {
          db.close();
        }
      }),
      { seed: 5, numRuns: 30 },
    );
  });
});
