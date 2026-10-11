/**
 * Adversarial review tests for src/analysis/stats.ts (aggregation correctness, handle validation, labels, determinism).
 *
 * Every test here was written to FAIL against the reviewed implementation first (or to pin a behaviour the builder's own
 * tests did not exercise): see the "finding" notes. Synthetic data only; databases are built through the real
 * Repository.importBatch.
 *
 * The big property test re-derives every number from the generated data with an independent brute-force oracle that
 * knows nothing about SQL: multi-snapshot conversations (head = newest updated_at, ties -> newest import), several
 * providers/accounts reusing the same conversation ids, every filter, includeHidden, allBatches and fixed-offset time
 * zones for the day buckets (an independent "instant + offset" computation, no Intl).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { runAudit } from '../../src/analysis/audit.js';
import { computeStats, STATS_GROUP_BY, UNKNOWN_MODEL_LABEL } from '../../src/analysis/stats.js';
import type { StatsGroupBy, StatsOptions, StatsResult } from '../../src/analysis/stats.js';
import { GcrError } from '../../src/errors.js';
import { BASE_TIME } from '../helpers/records.js';
import { chat, claudeChat, fresh, importAll, iso } from './support.test.js';
import type { MsgSpec } from './support.test.js';

function expectGcr(fn: () => unknown, code: string, ctx: string): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `${ctx}: expected a GcrError, got ${Object.prototype.toString.call(e)} (${e instanceof Error ? e.message : String(e)})`);
    assert.equal(e.code, code, ctx);
    return e;
  }
  assert.fail(`${ctx}: expected ${code}, nothing was thrown`);
}

describe('finding 1: the database handle is validated (INVALID_ARGUMENT, never a raw TypeError)', () => {
  const garbage: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['a string', 'database.sqlite'],
    ['an empty object', {}],
    ['an array', []],
    ['an object whose db is not a connection', { db: 5 }],
    ['an object whose db is null', { db: null }],
    ['an object with exec/prepare that are not functions', { exec: 1, prepare: 2 }],
  ];
  for (const [name, handle] of garbage) {
    it(`${name} -> GcrError INVALID_ARGUMENT that does not echo the value`, () => {
      const e = expectGcr(() => computeStats(handle as never, { groupBy: 'role' }), 'INVALID_ARGUMENT', name);
      assert.ok(!e.message.includes('database.sqlite'));
    });
  }

  it('a handle error wins over nothing else: bad options on a good handle are still reported as the options', () => {
    const { db } = fresh();
    expectGcr(() => computeStats(db, { groupBy: 'nope' as StatsGroupBy }), 'INVALID_ARGUMENT', 'groupBy');
  });

  it('a Repository and a bare DatabaseSync both work and agree', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('h', [{ role: 'user', text: 'abc' }])]);
    const a = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(computeStats(repo, { groupBy: 'role' }), a);
  });
});

describe('finding 2: the "conversation" label is the title of the HEAD snapshot, also with allBatches', () => {
  it('a superseded snapshot with a lexicographically larger title must not rename the conversation', async () => {
    const { db, repo } = fresh();
    // Snapshot 1 (older updated_at) is titled "Zeta draft", the head (newer) is "Alpha final".
    await importAll(repo, [chat('c1', [{ role: 'user', text: 'a' }], { title: 'Zeta draft', updatedAt: iso(10) })], 'one');
    await importAll(repo, [chat('c1', [{ role: 'user', text: 'a' }], { title: 'Alpha final', updatedAt: iso(20) })], 'two');
    for (const allBatches of [false, true]) {
      const r = computeStats(db, { groupBy: 'conversation', allBatches });
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0]?.label, 'Alpha final', `allBatches=${allBatches}`);
      assert.equal(r.rows[0]?.messages, allBatches ? 2 : 1);
    }
  });

  it('a head without a title falls back to the id even if a superseded snapshot had one', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('c9', [{ role: 'user', text: 'a' }], { title: 'Old title', updatedAt: iso(10) })], 'one');
    await importAll(repo, [chat('c9', [{ role: 'user', text: 'a' }], { title: null, updatedAt: iso(20) })], 'two');
    for (const allBatches of [false, true]) {
      const r = computeStats(db, { groupBy: 'conversation', allBatches });
      assert.equal(r.rows[0]?.label, 'c9', `allBatches=${allBatches}`);
    }
  });

  it('the head is chosen by updated_at, not by import order, for the label as well', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('c2', [{ role: 'user', text: 'a' }], { title: 'Newest content', updatedAt: iso(50) })], 'one');
    await importAll(repo, [chat('c2', [{ role: 'user', text: 'a' }], { title: 'Zzz imported later but older', updatedAt: iso(5) })], 'two');
    const r = computeStats(db, { groupBy: 'conversation', allBatches: true });
    assert.equal(r.rows[0]?.label, 'Newest content');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Brute-force oracle
// ---------------------------------------------------------------------------------------------------------------

interface GenMsg {
  role: string;
  model: string | null;
  channel: string | null;
  contentType: string | null;
  hidden: boolean;
  /** quarter-hour index from the base instant, or null = no timestamp */
  q: number | null;
  sec: number;
  short: boolean;
  len: number;
}
interface GenSnap {
  round: number;
  /** quarter-hour index of the conversation updated_at, or null */
  updatedQ: number | null;
  title: string | null;
  msgs: GenMsg[];
}
interface GenConv {
  id: string;
  account: string;
  provider: 'chatgpt' | 'claude';
  snaps: GenSnap[];
}

const Q_MAX = 4 * 24 * 3; // 3 days of quarter hours

const msgArb: fc.Arbitrary<GenMsg> = fc.record({
  role: fc.constantFrom('user', 'assistant', 'assistant', 'system', 'tool', 'weird'),
  model: fc.constantFrom<string | null>(null, 'm1', 'm2', '  ', ''),
  channel: fc.constantFrom<string | null>(null, 'final', 'analysis'),
  contentType: fc.constantFrom<string | null>(null, 'text', 'code'),
  hidden: fc.boolean(),
  q: fc.option(fc.integer({ min: 0, max: Q_MAX }), { nil: null }),
  sec: fc.constantFrom(0, 0, 59),
  short: fc.boolean(),
  len: fc.integer({ min: 0, max: 9 }),
});

const snapArb = (round: number): fc.Arbitrary<GenSnap> =>
  fc.record({
    round: fc.constant(round),
    updatedQ: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }),
    title: fc.constantFrom<string | null>(null, 'T0', 'T1', 'T2'),
    msgs: fc.array(msgArb, { maxLength: 6 }),
  });

const convArb: fc.Arbitrary<GenConv> = fc.record({
  id: fc.constantFrom('c0', 'c1'),
  account: fc.constantFrom('default', 'alt'),
  provider: fc.constantFrom<'chatgpt' | 'claude'>('chatgpt', 'claude'),
  // 1..3 snapshots, each in a distinct import round (a batch holds one snapshot of a conversation).
  snaps: fc
    .subarray([0, 1, 2], { minLength: 1 })
    .chain((rounds) => fc.tuple(...rounds.map((r) => snapArb(r)))),
});

const dataArb = fc.array(convArb, { minLength: 1, maxLength: 5 }).map((all) => {
  const seen = new Set<string>();
  return all.filter((c) => {
    const k = `${c.provider}|${c.account}|${c.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
});

const TZ_OFFSETS: ReadonlyArray<[string | undefined, number]> = [
  [undefined, 0],
  ['UTC', 0],
  ['Asia/Kolkata', 330],
  ['Asia/Kathmandu', 345],
  ['Etc/GMT+5', -300],
  ['Pacific/Kiritimati', 840],
];

interface Opts {
  provider: string | undefined;
  accountLabel: string | undefined;
  role: string | undefined;
  afterQ: { q: number; sec: number; short: boolean } | undefined;
  beforeQ: { q: number; sec: number; short: boolean } | undefined;
  includeHidden: boolean;
  allBatches: boolean;
  tzIndex: number;
}

const boundArb = fc.option(fc.record({ q: fc.integer({ min: 0, max: Q_MAX }), sec: fc.constantFrom(0, 59), short: fc.boolean() }), { nil: undefined });

const optsArb: fc.Arbitrary<Opts> = fc.record({
  provider: fc.constantFrom<string | undefined>(undefined, undefined, 'chatgpt', 'claude', 'openai_api'),
  accountLabel: fc.constantFrom<string | undefined>(undefined, undefined, 'default', 'alt'),
  role: fc.constantFrom<string | undefined>(undefined, undefined, 'user', 'assistant', 'weird'),
  afterQ: boundArb,
  beforeQ: boundArb,
  includeHidden: fc.boolean(),
  allBatches: fc.boolean(),
  tzIndex: fc.integer({ min: 0, max: TZ_OFFSETS.length - 1 }),
});

function msOf(q: number, sec: number): number {
  return BASE_TIME + q * 15 * 60_000 + sec * 1000;
}
function spell(q: number, sec: number, short: boolean): string {
  const s = new Date(msOf(q, sec)).toISOString();
  return short ? s.replace('.000Z', 'Z') : s;
}

function toRecord(c: GenConv, s: GenSnap) {
  const specs: MsgSpec[] = s.msgs.map((m) => ({
    role: m.role,
    model: m.model,
    channel: m.channel,
    contentType: c.provider === 'claude' ? null : m.contentType,
    hidden: m.hidden,
    at: m.q === null ? null : spell(m.q, m.sec, m.short),
    text: 'x'.repeat(m.len),
  }));
  const over = { accountLabel: c.account, title: s.title, updatedAt: s.updatedQ === null ? null : iso(s.updatedQ) };
  return c.provider === 'claude' ? claudeChat(c.id, specs, over) : chat(c.id, specs, over);
}

async function build(data: GenConv[]) {
  const f = fresh();
  for (const round of [0, 1, 2]) {
    const records = data.flatMap((c) => c.snaps.filter((s) => s.round === round).map((s) => toRecord(c, s)));
    if (records.length > 0) await importAll(f.repo, records, `round${round}`);
  }
  return f;
}

interface Flat {
  provider: string;
  account: string;
  convId: string;
  headTitle: string | null;
  isHead: boolean;
  m: GenMsg;
}

/** head = greatest updated_at (NULL lowest), ties -> the later import round. */
function flatten(data: GenConv[]): Flat[] {
  const out: Flat[] = [];
  for (const c of data) {
    const rank = (s: GenSnap): number => (s.updatedQ === null ? -1 : s.updatedQ) * 10 + s.round;
    const head = c.snaps.reduce((best, s) => (rank(s) > rank(best) ? s : best));
    for (const s of c.snaps) {
      for (const m of s.msgs) out.push({ provider: c.provider, account: c.account, convId: c.id, headTitle: head.title, isHead: s === head, m });
    }
  }
  return out;
}

interface ExpRow {
  key: string | null;
  label: string;
  messages: number;
  conversations: number;
  characters: number;
  firstAt: string | null;
  lastAt: string | null;
  provider?: string;
  accountLabel?: string;
}

function inScope(f: Flat, o: Opts): boolean {
  if (!o.allBatches && !f.isHead) return false;
  if (o.provider !== undefined && f.provider !== o.provider) return false;
  if (o.accountLabel !== undefined && f.account !== o.accountLabel) return false;
  if (o.role !== undefined && f.m.role !== o.role) return false;
  if (f.m.hidden && !o.includeHidden) return false;
  if (o.afterQ !== undefined || o.beforeQ !== undefined) {
    if (f.m.q === null) return false;
    const ms = msOf(f.m.q, f.m.sec);
    if (o.afterQ !== undefined && ms < msOf(o.afterQ.q, o.afterQ.sec)) return false;
    if (o.beforeQ !== undefined && ms >= msOf(o.beforeQ.q, o.beforeQ.sec)) return false;
  }
  return true;
}

function keyOf(f: Flat, groupBy: StatsGroupBy, offsetMin: number): { key: string | null; label: string } {
  const m = f.m;
  switch (groupBy) {
    case 'role':
      return { key: m.role, label: m.role };
    case 'model': {
      const known = m.model !== null && m.model.trim() !== '';
      return known ? { key: m.model, label: m.model as string } : { key: null, label: UNKNOWN_MODEL_LABEL };
    }
    case 'channel':
      return m.channel === null ? { key: null, label: '(no channel)' } : { key: m.channel, label: m.channel };
    case 'provider':
      return { key: f.provider, label: f.provider };
    case 'content_type': {
      const ct = f.provider === 'claude' ? null : m.contentType;
      return ct === null ? { key: null, label: '(no content type)' } : { key: ct, label: ct };
    }
    case 'conversation':
      return { key: f.convId, label: f.headTitle ?? f.convId };
    case 'day': {
      if (m.q === null) return { key: null, label: 'unknown' };
      const day = new Date(msOf(m.q, m.sec) + offsetMin * 60_000).toISOString().slice(0, 10);
      return { key: day, label: day };
    }
  }
}

function expectedRows(flats: Flat[], o: Opts, groupBy: StatsGroupBy): ExpRow[] {
  const offsetMin = (TZ_OFFSETS[o.tzIndex] as [string | undefined, number])[1];
  const groups = new Map<string, { row: ExpRow; convs: Set<string> }>();
  for (const f of flats) {
    if (!inScope(f, o)) continue;
    const { key, label } = keyOf(f, groupBy, offsetMin);
    const gk = groupBy === 'conversation' ? `${f.provider}|${f.account}|${key}` : String(key === null ? '\u0000null' : `k:${key}`);
    let g = groups.get(gk);
    if (g === undefined) {
      const row: ExpRow = { key, label, messages: 0, conversations: 0, characters: 0, firstAt: null, lastAt: null };
      if (groupBy === 'conversation') {
        row.provider = f.provider;
        row.accountLabel = f.account;
      }
      g = { row, convs: new Set() };
      groups.set(gk, g);
    }
    g.row.messages++;
    g.row.characters += f.m.len;
    g.convs.add(`${f.provider}|${f.account}|${f.convId}`);
    if (f.m.q !== null) {
      const t = new Date(msOf(f.m.q, f.m.sec)).toISOString();
      if (g.row.firstAt === null || t < g.row.firstAt) g.row.firstAt = t;
      if (g.row.lastAt === null || t > g.row.lastAt) g.row.lastAt = t;
    }
  }
  const rows = [...groups.values()].map((g) => ({ ...g.row, conversations: g.convs.size }));
  rows.sort((a, b) => {
    if (a.messages !== b.messages) return b.messages - a.messages;
    if (a.key !== b.key) {
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return (a.key as string) < (b.key as string) ? -1 : 1;
    }
    const sa = `${a.provider}\u0000${a.accountLabel}`;
    const sb = `${b.provider}\u0000${b.accountLabel}`;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  return rows;
}

function toOptions(o: Opts, groupBy: StatsGroupBy, extra: Partial<StatsOptions> = {}): StatsOptions {
  const tz = (TZ_OFFSETS[o.tzIndex] as [string | undefined, number])[0];
  const opts: StatsOptions = { groupBy, includeHidden: o.includeHidden, allBatches: o.allBatches, limit: 1000, ...extra };
  if (o.provider !== undefined) opts.provider = o.provider;
  if (o.accountLabel !== undefined) opts.accountLabel = o.accountLabel;
  if (o.role !== undefined) opts.role = o.role;
  if (o.afterQ !== undefined) opts.createdAfter = spell(o.afterQ.q, o.afterQ.sec, o.afterQ.short);
  if (o.beforeQ !== undefined) opts.createdBefore = spell(o.beforeQ.q, o.beforeQ.sec, o.beforeQ.short);
  if (tz !== undefined) opts.tz = tz;
  return opts;
}

function codes(r: StatsResult): string[] {
  return r.warnings.map((w) => w.code).sort();
}

describe('computeStats vs an independent oracle (multi-snapshot, multi-scope, filters, allBatches, time zones)', () => {
  it('every groupBy: rows, order, totals, model provenance and warning codes equal the brute-force result', async () => {
    await fc.assert(
      fc.asyncProperty(dataArb, optsArb, async (data, o) => {
        const { db } = await build(data);
        try {
          const flats = flatten(data);
          const inS = flats.filter((f) => inScope(f, o));
          for (const groupBy of STATS_GROUP_BY) {
            const r = computeStats(db, toOptions(o, groupBy));
            const want = expectedRows(flats, o, groupBy);
            assert.deepStrictEqual(r.rows, want, `${groupBy}: rows`);
            assert.equal(r.totals.messages, inS.length, `${groupBy}: totals.messages`);
            assert.equal(r.totals.characters, inS.reduce((n, f) => n + f.m.len, 0), `${groupBy}: totals.characters`);
            assert.equal(r.totals.conversations, new Set(inS.map((f) => `${f.provider}|${f.account}|${f.convId}`)).size, `${groupBy}: totals.conversations`);

            const known = inS.filter((f) => f.m.model !== null && f.m.model.trim() !== '');
            const asst = inS.filter((f) => f.m.role === 'assistant');
            const mp = r.modelProvenance;
            assert.equal(mp.messagesWithModel, known.length);
            assert.equal(mp.messagesWithoutModel, inS.length - known.length);
            assert.equal(mp.assistantMessagesWithModel, asst.filter((f) => f.m.model !== null && f.m.model.trim() !== '').length);
            assert.equal(mp.assistantMessagesWithoutModel, asst.filter((f) => f.m.model === null || f.m.model.trim() === '').length);
            assert.equal(mp.distinctModels, new Set(known.map((f) => f.m.model)).size);

            // Warning codes: derive each from the data.
            const expectCodes: string[] = [];
            const snapsInScope = data.filter((c) => (o.provider === undefined || c.provider === o.provider) && (o.accountLabel === undefined || c.account === o.accountLabel));
            if (o.allBatches && snapsInScope.some((c) => c.snaps.length > 1)) expectCodes.push('SUPERSEDED_SNAPSHOTS_INCLUDED');
            if (!o.includeHidden) {
              const hiddenCount = flats.filter((f) => f.m.hidden && inScope({ ...f, m: { ...f.m, hidden: false } }, o)).length;
              if (hiddenCount > 0) expectCodes.push('HIDDEN_MESSAGES_EXCLUDED');
            }
            if (o.afterQ !== undefined || o.beforeQ !== undefined) {
              const undated = flats.filter((f) => f.m.q === null && (o.allBatches || f.isHead) && (o.provider === undefined || f.provider === o.provider) && (o.accountLabel === undefined || f.account === o.accountLabel) && (o.role === undefined || f.m.role === o.role) && (o.includeHidden || !f.m.hidden)).length;
              if (undated > 0) expectCodes.push('UNDATED_MESSAGES_EXCLUDED');
            }
            if (inS.length === 0) expectCodes.push('NO_MATCHING_MESSAGES');
            assert.deepEqual(codes(r), expectCodes.sort(), `${groupBy}: warning codes`);
          }
        } finally {
          db.close();
        }
      }),
      { seed: 20261011, numRuns: 120 },
    );
  });

  it('pagination over the same random data never repeats or skips a row, for every groupBy and page size', async () => {
    await fc.assert(
      fc.asyncProperty(dataArb, optsArb, fc.integer({ min: 1, max: 4 }), async (data, o, limit) => {
        const { db } = await build(data);
        try {
          for (const groupBy of STATS_GROUP_BY) {
            const full = computeStats(db, toOptions(o, groupBy));
            const joined = [];
            let offset = 0;
            for (let guard = 0; guard < 500; guard++) {
              const page = computeStats(db, toOptions(o, groupBy, { limit, offset }));
              assert.ok(page.rows.length <= limit);
              joined.push(...page.rows);
              assert.deepEqual(page.totals, full.totals, `${groupBy}: totals are page independent`);
              if (page.nextOffset === null) {
                assert.ok(page.rows.length <= limit);
                break;
              }
              assert.equal(page.rows.length, limit, `${groupBy}: only the last page may be short`);
              assert.equal(page.nextOffset, offset + limit);
              offset = page.nextOffset;
            }
            assert.deepStrictEqual(joined, full.rows, `${groupBy}: concatenated pages`);
          }
        } finally {
          db.close();
        }
      }),
      { seed: 777, numRuns: 60 },
    );
  });
});

describe('aggregation corner cases the builder did not pin', () => {
  it('the same message in two snapshots is counted once by default and once per snapshot with allBatches (never merged)', async () => {
    const { db, repo } = fresh();
    const rec = (u: number) => chat('dup', [{ role: 'user', text: 'abcd', at: '2025-01-01T00:00:00Z' }, { role: 'assistant', text: 'ef', model: 'm', at: '2025-01-01T00:00:01Z' }], { updatedAt: iso(u) });
    await importAll(repo, [rec(1)], 'a');
    await importAll(repo, [rec(2)], 'b');
    await importAll(repo, [rec(3)], 'c');
    const head = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(head.totals, { messages: 2, conversations: 1, characters: 6 });
    const all = computeStats(db, { groupBy: 'role', allBatches: true });
    assert.deepEqual(all.totals, { messages: 6, conversations: 1, characters: 18 });
    assert.deepEqual(all.rows.map((r) => [r.key, r.messages, r.conversations]), [['assistant', 3, 1], ['user', 3, 1]]);
    const w = all.warnings.find((x) => x.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED');
    assert.ok(w, 'two superseded snapshots are announced');
    assert.match(w.message, /^2 superseded/);
  });

  it('re-importing identical input as a new salt-less batch does not create a snapshot (idempotent): counts do not double', async () => {
    const { db, repo } = fresh();
    const rec = chat('idem', [{ role: 'user', text: 'abc' }]);
    await importAll(repo, [rec], 'same');
    await importAll(repo, [rec], 'same');
    assert.equal(computeStats(db, { groupBy: 'role', allBatches: true }).totals.messages, 1);
  });

  it('hidden and structural nodes never leak into any count, even through a role filter on the empty role', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('h1', [{ role: 'user', text: 'hide', hidden: true }, { role: 'user', text: 'show' }])]);
    // The structural root has author_role '' and must not be counted when asking for role ''.
    const r = computeStats(db, { groupBy: 'role', role: '' });
    assert.equal(r.totals.messages, 0);
    assert.ok(r.warnings.some((w) => w.code === 'NO_MATCHING_MESSAGES'));
    assert.equal(computeStats(db, { groupBy: 'role', includeHidden: true }).totals.messages, 2);
    assert.equal(computeStats(db, { groupBy: 'role' }).totals.messages, 1);
  });

  it('model honesty: a conversation default and sibling models never leak; a "model" row exists only for slugs on the message itself', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('mh', [{ role: 'user' }, { role: 'assistant', model: 'real-model' }, { role: 'assistant', model: null }, { role: 'assistant', model: ' \t ' }], { defaultModelSlug: 'conv-default' }),
    ]);
    const r = computeStats(db, { groupBy: 'model' });
    assert.deepEqual(r.rows.map((x) => [x.key, x.label, x.messages]), [
      [null, UNKNOWN_MODEL_LABEL, 3],
      ['real-model', 'real-model', 1],
    ]);
    assert.ok(!JSON.stringify(r).includes('conv-default'));
    assert.equal(r.modelProvenance.assistantMessagesWithModel, 1);
    assert.equal(r.modelProvenance.assistantMessagesWithoutModel, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DST zones against an independent rule-based oracle (no Intl): the offset depends on the instant.
// ---------------------------------------------------------------------------------------------------------------

/** Day of month of the n-th (1-based) Sunday of `month0` in `year`; n = -1 means the last Sunday. */
function sunday(year: number, month0: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const wd = new Date(Date.UTC(year, month0, lastDay)).getUTCDay();
  return lastDay - wd;
}

interface Rule {
  tz: string;
  /** UTC offset in minutes at the instant, per the zone's published rules for the years under test (2008..2035). */
  offset: (ms: number) => number;
  /** UTC instants where the offset changes in a given year. */
  transitions: (year: number) => number[];
}

const RULES: Rule[] = [
  {
    // US: DST from the 2nd Sunday of March 02:00 EST (07:00Z) to the 1st Sunday of November 02:00 EDT (06:00Z).
    tz: 'America/New_York',
    transitions: (y) => [Date.UTC(y, 2, sunday(y, 2, 2), 7), Date.UTC(y, 10, sunday(y, 10, 1), 6)],
    offset(ms) {
      const y = new Date(ms).getUTCFullYear();
      const [start, end] = this.transitions(y) as [number, number];
      return ms >= start && ms < end ? -240 : -300;
    },
  },
  {
    // EU: DST from the last Sunday of March 01:00Z to the last Sunday of October 01:00Z.
    tz: 'Europe/Berlin',
    transitions: (y) => [Date.UTC(y, 2, sunday(y, 2, -1), 1), Date.UTC(y, 9, sunday(y, 9, -1), 1)],
    offset(ms) {
      const y = new Date(ms).getUTCFullYear();
      const [start, end] = this.transitions(y) as [number, number];
      return ms >= start && ms < end ? 120 : 60;
    },
  },
  {
    // Australia (south-east): DST ends the 1st Sunday of April 03:00 AEDT (Sat 16:00Z) and starts the 1st Sunday of October 02:00 AEST (Sat 16:00Z).
    tz: 'Australia/Sydney',
    transitions: (y) => [Date.UTC(y, 3, sunday(y, 3, 1) - 1, 16), Date.UTC(y, 9, sunday(y, 9, 1) - 1, 16)],
    offset(ms) {
      const y = new Date(ms).getUTCFullYear();
      const [end, start] = this.transitions(y) as [number, number];
      return ms >= end && ms < start ? 600 : 660;
    },
  },
];

describe('day grouping: DST zones agree with an independent rule-based oracle', () => {
  it('random instants and every transition instant (+-1 ms) land on the day the zone rules dictate', async () => {
    const { db, repo } = fresh();
    const instants: number[] = [];
    let seed = 20261013;
    const rnd = (): number => {
      // mulberry32: exact 32-bit integer arithmetic
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const lo = Date.UTC(2008, 0, 1);
    const hi = Date.UTC(2036, 0, 1);
    for (let i = 0; i < 600; i++) instants.push(Math.floor(lo + rnd() * (hi - lo)));
    for (const rule of RULES) {
      for (let y = 2008; y <= 2035; y++) for (const t of rule.transitions(y)) instants.push(t - 1, t, t + 1);
    }
    const stamp = (ms: number): string => new Date(ms).toISOString();
    await importAll(repo, [chat('dst', instants.map((ms) => ({ role: 'user', text: 'x', at: stamp(ms) })))]);
    for (const rule of RULES) {
      const r = computeStats(db, { groupBy: 'day', tz: rule.tz, limit: 1000 });
      const want = new Map<string, number>();
      for (const ms of instants) {
        const key = new Date(ms + rule.offset(ms) * 60_000).toISOString().slice(0, 10);
        want.set(key, (want.get(key) ?? 0) + 1);
      }
      // The result may be paged (limit 1000): walk every page.
      const got = new Map<string | null, number>();
      let offset = 0;
      for (;;) {
        const page = computeStats(db, { groupBy: 'day', tz: rule.tz, limit: 1000, offset });
        for (const row of page.rows) got.set(row.key, row.messages);
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      assert.equal(r.tz, rule.tz);
      assert.deepEqual([...got].sort(), [...want].sort(), rule.tz);
    }
  });
});

describe('read-only guarantee', () => {
  it('neither function writes anything: total_changes, the schema and every table are untouched; no temp objects remain', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('ro', [{ role: 'user', text: 'a', model: null }, { role: 'assistant', text: 'b', model: 'm' }]), chat('ro2', [], { title: null })]);
    const snap = (): string => {
      const master = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
      const temp = db.prepare('SELECT type, name FROM sqlite_temp_master ORDER BY type, name').all();
      const changes = db.prepare('SELECT total_changes() AS n').get();
      const tables = ['messages', 'conversations', 'conversation_heads', 'source_batches'].map((t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get());
      return JSON.stringify({ master, temp, changes, tables, tx: db.isTransaction });
    };
    const before = snap();
    for (const groupBy of STATS_GROUP_BY) computeStats(db, { groupBy, allBatches: true, includeHidden: true });
    runAudit(db, { allBatches: true });
    assert.equal(snap(), before);
  });
});

describe('filters match hostile STORED values exactly (bound equality, no LIKE, no concatenation)', () => {
  it('an account label / role that looks like SQL selects exactly its own rows and nothing else', async () => {
    const { db, repo } = fresh();
    const evil = "x' OR '1'='1";
    const wild = '%';
    await importAll(repo, [
      chat('e1', [{ role: evil, text: 'aa' }, { role: 'user', text: 'b' }], { accountLabel: evil }),
      chat('e2', [{ role: wild, text: 'c' }], { accountLabel: wild }),
      chat('plain', [{ role: 'user', text: 'dddd' }], { accountLabel: 'default' }),
    ]);
    const byAccount = (accountLabel: string) => computeStats(db, { groupBy: 'conversation', accountLabel });
    assert.deepEqual(byAccount(evil).rows.map((r) => r.key), ['e1']);
    assert.deepEqual(byAccount(wild).rows.map((r) => r.key), ['e2']);
    assert.deepEqual(byAccount('x').rows, []);
    assert.deepEqual(byAccount("x' OR '1'='1' --").rows, []);
    const byRole = (role: string) => computeStats(db, { groupBy: 'role', role });
    assert.equal(byRole(evil).totals.messages, 1);
    assert.equal(byRole(wild).totals.messages, 1);
    assert.equal(byRole('%').totals.characters, 1);
    assert.equal(byRole('us%').totals.messages, 0);
    assert.equal(byRole('u_er').totals.messages, 0);
    // The data is intact afterwards.
    assert.equal(computeStats(db, { groupBy: 'role' }).totals.messages, 4);
  });
});

describe('exported vocabularies cannot be mutated at run time (they drive allow-lists)', () => {
  it('STATS_GROUP_BY is frozen: pushing a name would otherwise extend the groupBy allow-list for the whole process', () => {
    assert.ok(Object.isFrozen(STATS_GROUP_BY));
    assert.throws(() => (STATS_GROUP_BY as unknown as string[]).push('toString'), TypeError);
    const { db } = fresh();
    expectGcr(() => computeStats(db, { groupBy: 'toString' as StatsGroupBy }), 'INVALID_ARGUMENT', 'toString');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Finding 4: a stored created_at that is not a strict ISO-8601 UTC instant is "no usable timestamp" EVERYWHERE.
// ---------------------------------------------------------------------------------------------------------------

describe('finding 4: invalid stored timestamps never reach firstAt/lastAt or a date bound (all groupBy behave like "day")', () => {
  async function tamperedDb(stored: Array<string | null>) {
    const f = fresh();
    // Imported valid (the Repository validates), then damaged outside GCR: the immutability trigger is dropped ON PURPOSE.
    await importAll(f.repo, [chat('t', stored.map((_, i) => ({ role: 'user', text: 'x', at: iso(i + 1) })))]);
    f.db.exec('DROP TRIGGER messages_no_update');
    stored.forEach((v, i) => f.db.prepare('UPDATE messages SET created_at = ? WHERE message_id = ?').run(v, `t-m${i}`));
    return f;
  }
  const stored = [
    '2025-01-01T00:00:00Z', //          valid
    'last tuesday', //                  not a timestamp (sorts AFTER every digit string)
    '2025-13-45T99:99:99Z', //          right shape, impossible instant
    '2025-02-30T00:00:00Z', //          impossible day
    '2025-01-01T00:00:00+00:00', //     offset spelling (not the strict form)
    '2025-01-01T24:00:00Z', //          hour 24
    '2025-03-01T00:00:00.000Z', //      valid
    null, //                            no timestamp
  ];

  it('firstAt/lastAt of every grouping are taken from the valid timestamps only', async () => {
    const { db } = await tamperedDb(stored);
    for (const groupBy of STATS_GROUP_BY) {
      const r = computeStats(db, { groupBy });
      const times = r.rows.flatMap((x) => [x.firstAt, x.lastAt]).filter((x): x is string => x !== null);
      for (const t of times) assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${groupBy}: ${t}`);
      assert.ok(!times.includes('last tuesday'), groupBy);
      const all = r.rows.reduce<string[]>((acc, x) => acc.concat([x.firstAt, x.lastAt].filter((y): y is string => y !== null)), []).sort();
      assert.equal(all[0], '2025-01-01T00:00:00.000Z', `${groupBy}: earliest`);
      assert.equal(all.at(-1), '2025-03-01T00:00:00.000Z', `${groupBy}: latest`);
    }
  });

  it('a date bound counts only valid timestamps, and the others are reported as excluded, for every groupBy', async () => {
    const { db } = await tamperedDb(stored);
    for (const groupBy of STATS_GROUP_BY) {
      const r = computeStats(db, { groupBy, createdAfter: '2000-01-01T00:00:00Z' });
      assert.equal(r.totals.messages, 2, `${groupBy}: only the two valid timestamps match`);
      const w = r.warnings.find((x) => x.code === 'UNDATED_MESSAGES_EXCLUDED');
      assert.ok(w, `${groupBy}: exclusion is reported`);
      assert.match(w.message, /^6 message\(s\)/, `${groupBy}: 5 invalid + 1 null`);
      const before = computeStats(db, { groupBy, createdBefore: '9999-12-31T23:59:59Z' });
      assert.equal(before.totals.messages, 2, `${groupBy}: createdBefore as well`);
    }
  });

  it('the "day" grouping and the bounded totals agree about which messages have a day', async () => {
    const { db } = await tamperedDb(stored);
    const days = computeStats(db, { groupBy: 'day' });
    const dated = days.rows.filter((x) => x.key !== null).reduce((n, x) => n + x.messages, 0);
    const bounded = computeStats(db, { groupBy: 'role', createdAfter: '0000-01-01T00:00:00Z' }).totals.messages;
    assert.equal(dated, 2);
    assert.equal(bounded, dated);
  });

  it('differential: the SQL notion of a usable timestamp equals validate.ts\' strict parser on 600 mutated candidates', async () => {
    const { parseIsoUtcToEpochMs } = await import('../../src/domain/validate.js');
    const seeds = ['2025-01-01T00:00:00Z', '2025-01-01T00:00:00.123Z', '2024-02-29T23:59:59.999Z', '0000-02-29T00:00:00Z', '9999-12-31T23:59:59Z'];
    const alphabet = '0123456789-:TZ.+ x';
    let seed = 99;
    const rnd = (n: number): number => {
      // mulberry32: exact 32-bit integer arithmetic (a float LCG loses its low bits and cycles quickly)
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const candidates = new Set<string>([
      ...seeds,
      '2025-02-29T00:00:00Z', '0100-02-29T00:00:00Z', '2025-04-31T00:00:00Z', '2025-01-01T24:00:00Z', '2025-01-01T23:60:00Z', '2025-01-01T23:59:60Z',
      '2025-00-10T00:00:00Z', '2025-01-00T00:00:00Z', '2025-1-1T0:0:0Z', '2025-01-01t00:00:00z', '2025-01-01 00:00:00Z', '2025-01-01T00:00:00.1Z',
      '2025-01-01T00:00:00.12345Z', '２０２５-01-01T00:00:00Z', '', ' ', '2025-01-01T00:00:00Z ',
    ]);
    while (candidates.size < 600) {
      let s = seeds[rnd(seeds.length)] as string;
      for (let k = 1 + rnd(2); k > 0; k--) {
        const at = rnd(s.length);
        s = rnd(4) === 0 ? s.slice(0, at) + s.slice(at + 1) : s.slice(0, at) + (alphabet[rnd(alphabet.length)] as string) + s.slice(at + 1);
      }
      candidates.add(s);
    }
    const list = [...candidates];
    const f = fresh();
    await importAll(f.repo, list.map((_, i) => chat(`d${i}`, [{ role: `r${String(i).padStart(4, '0')}`, text: 'x', at: iso(1) }])));
    f.db.exec('DROP TRIGGER messages_no_update');
    list.forEach((v, i) => f.db.prepare('UPDATE messages SET created_at = ? WHERE conversation_id = ?').run(v, `d${i}`));
    const rows = new Map<string, string | null>();
    for (let offset = 0; ; ) {
      const page = computeStats(f.db, { groupBy: 'role', limit: 1000, offset });
      for (const r of page.rows) rows.set(r.key as string, r.firstAt);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    list.forEach((v, i) => {
      const ms = parseIsoUtcToEpochMs(v);
      const got = rows.get(`r${String(i).padStart(4, '0')}`);
      if (ms === null) assert.equal(got, null, `"${v}" must not be usable`);
      else assert.equal(got, new Date(ms).toISOString().replace(/^(\d{4})/, '$1'), `"${v}" must be usable`);
    });
  });
});
