/**
 * Adversarial review tests for src/analysis/audit.ts (handle validation, branch provenance, counting correctness).
 *
 * The property test re-derives every SQL-based finding from the generated data with a brute-force oracle that knows
 * nothing about SQL: multi-snapshot conversations (head = newest updated_at, ties -> newest import), several
 * providers/accounts reusing conversation ids, hostile roles/content types/models, blank titles and texts, every
 * current-node state, and allBatches / provider / accountLabel scoping. Synthetic data only; databases are built
 * through the real Repository.importBatch.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { AUDIT_CHECKS, KNOWN_CHATGPT_CONTENT_TYPES, KNOWN_ROLES, runAudit } from '../../src/analysis/audit.js';
import type { AuditCheck, AuditFinding, AuditOptions, AuditResult } from '../../src/analysis/audit.js';
import { GcrError } from '../../src/errors.js';
import { NAMED_CONTENT_TYPES } from '../../src/ingest/chatgpt-export.js';
import { chat, claudeChat, fresh, importAll, iso, star } from './support.test.js';
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

function finding(r: AuditResult, check: AuditCheck): AuditFinding {
  const f = r.findings.find((x) => x.check === check);
  assert.ok(f, `finding for ${check}`);
  return f;
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
      const e = expectGcr(() => runAudit(handle as never, {}), 'INVALID_ARGUMENT', name);
      assert.ok(!e.message.includes('database.sqlite'));
    });
  }

  it('a Repository and a bare DatabaseSync both work and agree', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('h', [{ role: 'user', text: 'abc' }])]);
    const a = runAudit(db, {});
    assert.deepEqual(runAudit(repo, {}), a);
  });
});

describe('finding 2: branchProvenance agrees with no_current_node when branch enumeration is truncated', () => {
  it('a VALID current node whose branch was skipped by the analyzer limits still counts as a known active branch', async () => {
    const { db, repo } = fresh();
    const n = 10_005; // more leaves than the analyzer's default maxBranches (10,000)
    const last = `big-l${String(n - 1).padStart(5, '0')}`;
    await importAll(repo, [star('big', n, { currentNodeId: last })]);
    const r = runAudit(db, {});
    assert.equal(finding(r, 'no_current_node').count, 0, 'the pointer is valid: no_current_node must not flag it');
    assert.equal(finding(r, 'tree_integrity').byCode?.['BRANCH_LIMIT_EXCEEDED'], 1, 'truncation is still reported where it belongs');
    assert.deepEqual(r.branchProvenance, {
      conversationsWithMultipleBranches: 1,
      maxBranchesInOneConversation: n,
      conversationsWithKnownActiveBranch: 1,
      conversationsWithUnknownActiveBranch: 0,
    });
  });

  it('known + unknown always equals scanned conversations, and unknown equals the no_current_node count (mixed bag)', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('ok', [{ role: 'user' }, { role: 'assistant' }]),
      chat('nul', [{ role: 'user' }], { currentNodeId: null }),
      chat('ghost', [{ role: 'user' }], { currentNodeId: 'no-such-node' }),
      star('trunc', 10_003, { currentNodeId: 'trunc-l10002' }),
    ]);
    const r = runAudit(db, {});
    const bp = r.branchProvenance;
    assert.equal(bp.conversationsWithKnownActiveBranch + bp.conversationsWithUnknownActiveBranch, r.scanned.conversations);
    assert.equal(bp.conversationsWithUnknownActiveBranch, finding(r, 'no_current_node').count);
    assert.equal(bp.conversationsWithKnownActiveBranch, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Brute-force oracle
// ---------------------------------------------------------------------------------------------------------------

type TextKind = 'empty' | 'blank' | 'zero_width' | 'real';
const TEXTS: Record<TextKind, string> = { empty: '', blank: ' \t\n', zero_width: '​﻿', real: 'x' };

interface GenMsg {
  role: string;
  model: string | null;
  contentType: string | null;
  hidden: boolean;
  q: number | null;
  text: TextKind;
}
type CurrentKind = 'last' | 'null' | 'dangling';
interface GenSnap {
  round: number;
  updatedQ: number | null;
  createdQ: number | null;
  title: string | null;
  current: CurrentKind;
  msgs: GenMsg[];
}
interface GenConv {
  id: string;
  account: string;
  provider: 'chatgpt' | 'claude';
  snaps: GenSnap[];
}

const msgArb: fc.Arbitrary<GenMsg> = fc.record({
  role: fc.constantFrom('user', 'assistant', 'assistant', 'system', 'tool', 'weird', 'USER', ''),
  model: fc.constantFrom<string | null>(null, 'm1', '  ', ''),
  contentType: fc.constantFrom<string | null>(null, 'text', 'code', 'weird_type', 'thoughts', 'audio_transcription'),
  hidden: fc.boolean(),
  q: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
  text: fc.constantFrom<TextKind>('empty', 'blank', 'zero_width', 'real', 'real'),
});

const snapArb = (round: number): fc.Arbitrary<GenSnap> =>
  fc.record({
    round: fc.constant(round),
    updatedQ: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
    createdQ: fc.option(fc.constant(3), { nil: null }),
    title: fc.constantFrom<string | null>(null, '', '  ', 'T'),
    current: fc.constantFrom<CurrentKind>('last', 'last', 'null', 'dangling'),
    msgs: fc.array(msgArb, { maxLength: 5 }),
  });

const convArb: fc.Arbitrary<GenConv> = fc.record({
  id: fc.constantFrom('c0', 'c1', 'c2'),
  account: fc.constantFrom('default', 'alt'),
  provider: fc.constantFrom<'chatgpt' | 'claude'>('chatgpt', 'claude'),
  snaps: fc.subarray([0, 1, 2], { minLength: 1 }).chain((rounds) => fc.tuple(...rounds.map((r) => snapArb(r)))),
});

const dataArb = fc.array(convArb, { minLength: 1, maxLength: 6 }).map((all) => {
  const seen = new Set<string>();
  return all.filter((c) => {
    const k = `${c.provider}|${c.account}|${c.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
});

interface Scope {
  provider: string | undefined;
  accountLabel: string | undefined;
  allBatches: boolean;
  sampleSize: number;
}
const scopeArb: fc.Arbitrary<Scope> = fc.record({
  provider: fc.constantFrom<string | undefined>(undefined, undefined, 'chatgpt', 'claude'),
  accountLabel: fc.constantFrom<string | undefined>(undefined, undefined, 'default', 'alt'),
  allBatches: fc.boolean(),
  sampleSize: fc.constantFrom(1, 2, 5),
});

function toRecord(c: GenConv, s: GenSnap) {
  const specs: MsgSpec[] = s.msgs.map((m) => ({
    role: m.role,
    model: m.model,
    contentType: c.provider === 'claude' ? null : m.contentType,
    hidden: m.hidden,
    at: m.q === null ? null : iso(m.q),
    text: TEXTS[m.text],
  }));
  const last = s.msgs.length === 0 ? null : `${c.id}-m${s.msgs.length - 1}`;
  const currentNodeId = s.current === 'last' ? last : s.current === 'null' ? null : 'ghost-node';
  const over = {
    accountLabel: c.account,
    title: s.title,
    createdAt: s.createdQ === null ? null : iso(s.createdQ),
    updatedAt: s.updatedQ === null ? null : iso(s.updatedQ),
    currentNodeId,
  };
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

interface Snap {
  conv: GenConv;
  snap: GenSnap;
  isHead: boolean;
}

function snapshots(data: GenConv[], sc: Scope): Snap[] {
  const out: Snap[] = [];
  for (const c of data) {
    const rank = (s: GenSnap): number => (s.updatedQ === null ? -1 : s.updatedQ) * 10 + s.round;
    const head = c.snaps.reduce((best, s) => (rank(s) > rank(best) ? s : best));
    if (sc.provider !== undefined && c.provider !== sc.provider) continue;
    if (sc.accountLabel !== undefined && c.account !== sc.accountLabel) continue;
    for (const s of c.snaps) {
      if (sc.allBatches || s === head) out.push({ conv: c, snap: s, isHead: s === head });
    }
  }
  return out;
}

const isBlank = (k: TextKind): boolean => k !== 'real';
const hasModel = (m: GenMsg): boolean => m.model !== null && m.model.trim() !== '';
const contentTypeOf = (c: GenConv, m: GenMsg): string | null => (c.provider === 'claude' ? null : m.contentType);

function lowest(ids: string[], k: number): string[] {
  return [...new Set(ids)].sort().slice(0, k);
}
function tally(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

describe('runAudit vs an independent oracle (multi-snapshot, multi-scope, hostile vocabularies)', () => {
  it('scanned counts, every SQL-based finding, timestamps, branch and model provenance equal the brute-force result', async () => {
    await fc.assert(
      fc.asyncProperty(dataArb, scopeArb, async (data, sc) => {
        const { db } = await build(data);
        try {
          const opts: AuditOptions = { allBatches: sc.allBatches, sampleSize: sc.sampleSize };
          if (sc.provider !== undefined) opts.provider = sc.provider;
          if (sc.accountLabel !== undefined) opts.accountLabel = sc.accountLabel;
          const r = runAudit(db, opts);
          const k = sc.sampleSize;
          const snaps = snapshots(data, sc);
          const msgsOf = (s: Snap): Array<{ id: string; m: GenMsg; i: number }> => s.snap.msgs.map((m, i) => ({ id: `${s.conv.id}-m${i}`, m, i }));
          const all = snaps.flatMap((s) => msgsOf(s).map((x) => ({ ...x, s })));

          assert.deepEqual(r.scanned, { conversations: snaps.length, messages: all.length });
          assert.deepEqual(r.findings.map((f) => f.check), [...AUDIT_CHECKS]);

          // missing_model
          const visAsst = all.filter((x) => x.m.role === 'assistant' && !x.m.hidden);
          const miss = visAsst.filter((x) => !hasModel(x.m));
          const fm = finding(r, 'missing_model');
          assert.equal(fm.count, miss.length, 'missing_model.count');
          assert.equal(fm.total, visAsst.length, 'missing_model.total');
          assert.deepEqual(fm.sampleMessageIds, lowest(miss.map((x) => x.id), k), 'missing_model message samples');
          assert.deepEqual(fm.sampleConversationIds, lowest(miss.map((x) => x.s.conv.id), k), 'missing_model conversation samples');
          assert.equal(fm.severity, 'info');

          // empty
          const emptySnaps = snaps.filter((s) => s.snap.msgs.every((m) => isBlank(m.text)));
          const fe = finding(r, 'empty');
          assert.equal(fe.count, emptySnaps.length, 'empty.count');
          assert.equal(fe.total, snaps.length);
          assert.deepEqual(fe.sampleConversationIds, lowest(emptySnaps.map((s) => s.conv.id), k), 'empty samples');
          assert.deepEqual(fe.sampleMessageIds, []);

          // untitled
          const untitled = snaps.filter((s) => s.snap.title === null || s.snap.title.trim() === '');
          const fu = finding(r, 'untitled');
          assert.equal(fu.count, untitled.length, 'untitled.count');
          assert.deepEqual(fu.sampleConversationIds, lowest(untitled.map((s) => s.conv.id), k), 'untitled samples');

          // tree integrity: every generated tree is a healthy chain
          assert.equal(finding(r, 'tree_integrity').count, 0, 'healthy chains have no integrity findings');
          assert.deepEqual(finding(r, 'tree_integrity').byCode, {});

          // no_current_node
          const noCur = snaps.filter((s) => s.snap.current !== 'last' || s.snap.msgs.length === 0);
          const fc2 = finding(r, 'no_current_node');
          assert.equal(fc2.count, noCur.length, 'no_current_node.count');
          assert.deepEqual(fc2.sampleConversationIds, lowest(noCur.map((s) => s.conv.id), k), 'no_current_node samples');
          const wantCur: Record<string, number> = {};
          for (const s of noCur) {
            const code = s.snap.current === 'dangling' ? 'INVALID_CURRENT_NODE' : 'NO_CURRENT_NODE';
            wantCur[code] = (wantCur[code] ?? 0) + 1;
          }
          assert.deepEqual(fc2.byCode, wantCur, 'no_current_node.byCode');

          // unknown_roles
          const unk = all.filter((x) => !['user', 'assistant', 'system', 'tool'].includes(x.m.role));
          const fr = finding(r, 'unknown_roles');
          assert.equal(fr.count, unk.length, 'unknown_roles.count');
          assert.equal(fr.total, all.length);
          assert.deepEqual(fr.byCode, tally(unk.map((x) => x.m.role)), 'unknown_roles.byCode');
          assert.deepEqual(fr.sampleMessageIds, lowest(unk.map((x) => x.id), k));

          // unknown_content_types (chatgpt only, NULL ignored)
          const gpt = all.filter((x) => x.s.conv.provider === 'chatgpt' && contentTypeOf(x.s.conv, x.m) !== null);
          const unkCt = gpt.filter((x) => !(NAMED_CONTENT_TYPES as readonly string[]).includes(contentTypeOf(x.s.conv, x.m) as string));
          const fct = finding(r, 'unknown_content_types');
          assert.equal(fct.count, unkCt.length, 'unknown_content_types.count');
          assert.equal(fct.total, gpt.length, 'unknown_content_types.total');
          assert.deepEqual(fct.byCode, tally(unkCt.map((x) => contentTypeOf(x.s.conv, x.m) as string)));
          assert.deepEqual(fct.sampleMessageIds, lowest(unkCt.map((x) => x.id), k));

          // hidden
          const hid = all.filter((x) => x.m.hidden);
          const fh = finding(r, 'hidden');
          assert.equal(fh.count, hid.length, 'hidden.count');
          assert.deepEqual(fh.byCode, tally(hid.map((x) => x.m.role)), 'hidden.byCode');
          assert.deepEqual(fh.sampleMessageIds, lowest(hid.map((x) => x.id), k));

          // timestamps: a message is flagged when it has no time, or is earlier than its (previous) parent message.
          const flaggedMsgs: Array<{ id: string; code: string; convId: string }> = [];
          for (const s of snaps) {
            const msgs = s.snap.msgs;
            msgs.forEach((m, i) => {
              const id = `${s.conv.id}-m${i}`;
              if (m.q === null) flaggedMsgs.push({ id, code: 'MESSAGE_CREATED_AT_NULL', convId: s.conv.id });
              else if (i > 0) {
                const prev = msgs[i - 1] as GenMsg;
                if (prev.q !== null && m.q < prev.q) flaggedMsgs.push({ id, code: 'MESSAGE_BEFORE_PARENT', convId: s.conv.id });
              }
            });
          }
          const flaggedConvs: Array<{ code: string; convId: string }> = [];
          for (const s of snaps) {
            if (s.snap.createdQ === null) flaggedConvs.push({ code: 'CONVERSATION_CREATED_AT_NULL', convId: s.conv.id });
            else if (s.snap.updatedQ !== null && s.snap.updatedQ < s.snap.createdQ) flaggedConvs.push({ code: 'CONVERSATION_UPDATED_BEFORE_CREATED', convId: s.conv.id });
          }
          const ft = finding(r, 'timestamps');
          assert.equal(ft.count, flaggedMsgs.length + flaggedConvs.length, 'timestamps.count');
          assert.equal(ft.total, all.length + snaps.length, 'timestamps.total');
          assert.deepEqual(ft.byCode, tally([...flaggedMsgs.map((x) => x.code), ...flaggedConvs.map((x) => x.code)]), 'timestamps.byCode');
          assert.deepEqual(ft.sampleMessageIds, lowest(flaggedMsgs.map((x) => x.id), k), 'timestamps message samples');
          assert.deepEqual(ft.sampleConversationIds, lowest([...flaggedMsgs.map((x) => x.convId), ...flaggedConvs.map((x) => x.convId)], k), 'timestamps conversation samples');

          // branch provenance (healthy chains: one leaf each, root-only snapshots have one leaf too)
          const known = snaps.filter((s) => s.snap.current === 'last' && s.snap.msgs.length > 0).length;
          assert.deepEqual(r.branchProvenance, {
            conversationsWithMultipleBranches: 0,
            maxBranchesInOneConversation: snaps.length > 0 ? 1 : 0,
            conversationsWithKnownActiveBranch: known,
            conversationsWithUnknownActiveBranch: snaps.length - known,
          });

          // model provenance
          assert.deepEqual(r.modelProvenance, {
            assistantMessagesWithModel: visAsst.length - miss.length,
            assistantMessagesWithoutModel: miss.length,
            conversationsWithAnyModel: snaps.filter((s) => s.snap.msgs.some(hasModel)).length,
          });
        } finally {
          db.close();
        }
      }),
      { seed: 20261012, numRuns: 150 },
    );
  });
});

describe('audit corner cases the builder did not pin', () => {
  it('with allBatches the SAME broken message in two snapshots is counted in each (units are snapshots) and announced', async () => {
    const { db, repo } = fresh();
    const rec = (u: number) => chat('x', [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b', model: null }], { updatedAt: iso(u) });
    await importAll(repo, [rec(1)], 's1');
    await importAll(repo, [rec(2)], 's2');
    const head = runAudit(db, {});
    const all = runAudit(db, { allBatches: true });
    assert.equal(finding(head, 'missing_model').count, 1);
    assert.equal(finding(all, 'missing_model').count, 2);
    assert.equal(all.scanned.conversations, 2);
    assert.ok(all.warnings.some((w) => w.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED'));
    assert.deepEqual(finding(all, 'missing_model').sampleConversationIds, ['x'], 'sample ids are distinct ids');
  });

  it('hidden and structural messages never count toward missing_model, and a hidden assistant without model is not "missing"', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('hm', [{ role: 'assistant', model: null, hidden: true, text: 'h' }, { role: 'assistant', model: 'm', text: 'v' }])]);
    const r = runAudit(db, {});
    const f = finding(r, 'missing_model');
    assert.equal(f.count, 0);
    assert.equal(f.total, 1);
    assert.deepEqual(r.modelProvenance, { assistantMessagesWithModel: 1, assistantMessagesWithoutModel: 0, conversationsWithAnyModel: 1 });
  });

  it('a conversation default model never counts as "has a model" for conversationsWithAnyModel', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('dm', [{ role: 'user' }, { role: 'assistant', model: null }], { defaultModelSlug: 'conv-default' })]);
    const r = runAudit(db, {});
    assert.equal(r.modelProvenance.conversationsWithAnyModel, 0);
    assert.equal(finding(r, 'missing_model').count, 1);
    assert.ok(!JSON.stringify(r).includes('conv-default'));
  });
});

describe('finding 3: "lowest ids first" has ONE definition (code point = SQLite BINARY order) for SQL-derived and tree-derived samples', () => {
  // U+FF5E is 3 UTF-8 bytes (EF BD 9E), U+1F600 is 4 (F0 9F 98 80): byte / code point order puts U+FF5E first, while
  // JavaScript's `<` compares UTF-16 code units (D83D < FF5E) and would put the astral id first.
  const low = '\uFF5Ea';
  const high = '\u{1F600}b';

  it('untitled (SQL) and timestamps (tree pass) pick the same sample for the same offenders', async () => {
    const { db, repo } = fresh();
    const mk = (id: string) => chat(id, [{ role: 'user', text: 'x', at: null }], { title: null });
    await importAll(repo, [mk(high), mk(low)]);
    const r = runAudit(db, { sampleSize: 1 });
    const fromSql = finding(r, 'untitled').sampleConversationIds;
    const fromTree = finding(r, 'timestamps').sampleConversationIds;
    assert.deepEqual(fromSql, [low], 'SQL BINARY order: U+FF5E (EF..) sorts before U+1F600 (F0..)');
    assert.deepEqual(fromTree, fromSql, 'the tree pass must use the same order');
  });

  it('with sampleSize 2 both sample lists are the same sorted list, whatever the import order', async () => {
    for (const order of [[low, high], [high, low]]) {
      const { db, repo } = fresh();
      await importAll(repo, order.map((id) => chat(id, [{ role: 'user', text: 'x', at: null }], { title: null })));
      const r = runAudit(db, { sampleSize: 2 });
      assert.deepEqual(finding(r, 'timestamps').sampleConversationIds, finding(r, 'untitled').sampleConversationIds);
      assert.deepEqual(finding(r, 'timestamps').sampleConversationIds, [low, high]);
    }
  });
});

describe('audit option validation: more hostile shapes', () => {
  it('opts that are not a plain object are INVALID_ARGUMENT', () => {
    const { db } = fresh();
    for (const bad of [null, [], 'checks', 7, true]) expectGcr(() => runAudit(db, bad as never), 'INVALID_ARGUMENT', String(bad));
  });

  it('check names are matched exactly: prototype names, case variants, padded names and sparse arrays are refused', () => {
    const { db } = fresh();
    const sparse = ['empty'];
    sparse[2] = 'hidden';
    for (const checks of [['constructor'], ['__proto__'], ['toString'], ['Empty'], [' empty'], ['empty '], sparse, [['empty']], [null], [{ toString: () => 'empty' }]]) {
      expectGcr(() => runAudit(db, { checks: checks as never }), 'INVALID_ARGUMENT', JSON.stringify(checks));
    }
  });

  it('a frozen opts object and a frozen checks array are fine and are not modified', () => {
    const { db } = fresh();
    const opts = Object.freeze({ checks: Object.freeze(['hidden', 'empty']) as unknown as AuditCheck[], sampleSize: 3 });
    const r = runAudit(db, opts);
    assert.deepEqual(r.findings.map((f) => f.check), ['empty', 'hidden']);
    assert.deepEqual(opts.checks, ['hidden', 'empty']);
  });
});

describe('finding 3 (property): samples are the lowest ids in UTF-8 byte order for ids mixing ASCII, BMP, high BMP and astral characters', () => {
  const alphabet = ['a', 'Z', 'é', 'ࠀ', '퟿', '', '～', '�', '\u{10000}', '\u{1f600}', '\u{e0001}', '\u{10fffd}'];
  const idArb = fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 3 }).map((cs) => cs.join(''));

  it('SQL-derived (untitled) and tree-derived (timestamps) sample lists both equal the byte-sorted offenders', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(idArb, { minLength: 1, maxLength: 12 }), fc.constantFrom(1, 3, 50), async (ids, k) => {
        const { db, repo } = fresh();
        try {
          await importAll(repo, ids.map((id) => chat(id, [{ role: 'user', text: 'x', at: null }], { title: null })));
          const r = runAudit(db, { sampleSize: k });
          const want = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))).slice(0, k);
          assert.deepEqual(finding(r, 'untitled').sampleConversationIds, want, 'SQL-derived');
          assert.deepEqual(finding(r, 'timestamps').sampleConversationIds, want, 'tree-derived');
          assert.deepEqual(finding(r, 'no_current_node').count, 0);
        } finally {
          db.close();
        }
      }),
      { seed: 4242, numRuns: 80 },
    );
  });
});

describe('exported vocabularies cannot be mutated at run time (they drive allow-lists and SQL placeholders)', () => {
  it('AUDIT_CHECKS, KNOWN_ROLES and KNOWN_CHATGPT_CONTENT_TYPES are frozen, and the latter still equals the adapter\'s own list', () => {
    for (const [name, list] of [['AUDIT_CHECKS', AUDIT_CHECKS], ['KNOWN_ROLES', KNOWN_ROLES], ['KNOWN_CHATGPT_CONTENT_TYPES', KNOWN_CHATGPT_CONTENT_TYPES]] as const) {
      assert.ok(Object.isFrozen(list), `${name} is frozen`);
      assert.throws(() => (list as unknown as string[]).push('x'), TypeError, name);
    }
    assert.deepEqual([...KNOWN_CHATGPT_CONTENT_TYPES], [...NAMED_CONTENT_TYPES]);
  });

  it('a role name pushed into KNOWN_ROLES by another module cannot silently change what the audit calls unknown', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('r', [{ role: 'oracle', text: 'x' }])]);
    try {
      (KNOWN_ROLES as unknown as string[]).push('oracle');
    } catch {
      // frozen: the mutation is refused, which is the point
    }
    assert.equal(finding(runAudit(db, {}), 'unknown_roles').count, 1);
  });
});
