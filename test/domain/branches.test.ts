/**
 * FR-04 scenario tests for src/domain/branches.ts: forks, roots, anomalies (missing parent / cycle / self-parent /
 * declared-child mismatch), active-branch marking, limits, threadForBranch and the opt-in heuristics.
 * Property tests live in branches.props.test.ts and the large-scale tests in branches.scale.test.ts.
 * Synthetic data only. Every scenario is also run on reversed and interleaved copies of the input array.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import type { Warning } from '../../src/errors.js';
import type { MessageRecord, TreeAnalysis } from '../../src/domain/types.js';
import { DEFAULT_MAX_BRANCHES, DEFAULT_MAX_TOTAL_PATH_NODES, analyzeTree, selectBranchByPolicy, threadForBranch } from '../../src/domain/branches.js';
import type { AnalyzeOptions } from '../../src/domain/branches.js';
import { branchedConversation, iso, link, linearConversation, msg } from '../helpers/records.js';

const C = 'c';

/** Node builder. `t` = minutes after BASE_TIME for createdAt (undefined => null). */
function m(id: string, parentId: string | null, extra: Partial<MessageRecord> & { t?: number } = {}): MessageRecord {
  const { t, ...rest } = extra;
  return msg({ id, conversationId: C, parentId, createdAt: t === undefined ? null : iso(t), text: `SECRET-TEXT-${id}`, authorRole: 'user', ...rest });
}
function structural(id: string, parentId: string | null = null): MessageRecord {
  return msg({ id, conversationId: C, parentId, nodeKind: 'structural_empty', authorRole: '', contentType: null });
}
function ids(a: TreeAnalysis): string[] {
  return a.branches.map((b) => b.branchId);
}
function warnings(a: TreeAnalysis, code: string): Warning[] {
  return a.warnings.filter((w) => w.code === code);
}
function codes(a: TreeAnalysis): string[] {
  return a.warnings.map((w) => w.code);
}
function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GcrError, String(e));
    assert.equal(e.code, code);
    return true;
  });
}

/** Deterministic permutations of the input array (reverse, and an interleave of both halves). */
function permutations<T>(xs: readonly T[]): T[][] {
  const reversed = xs.slice().reverse();
  const half = Math.ceil(xs.length / 2);
  const interleaved: T[] = [];
  for (let i = 0; i < half; i++) {
    const a = xs[i];
    const b = xs[xs.length - 1 - i];
    if (a !== undefined) interleaved.push(a);
    if (b !== undefined && i !== xs.length - 1 - i) interleaved.push(b);
  }
  return [reversed, interleaved];
}

/** analyzeTree on the input and on permuted copies; asserts identical output; returns the result. */
function analyze(messages: MessageRecord[], current: string | null = null, opts?: AnalyzeOptions): TreeAnalysis {
  const base = analyzeTree(C, messages, current, opts);
  for (const p of permutations(messages)) assert.deepEqual(analyzeTree(C, p, current, opts), base, 'output must not depend on input order');
  return base;
}

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

/**
 *  r(structural)
 *   u0 t1
 *    a0 t2
 *     u1 t3
 *      a1x t10  (leaf)
 *      a1y t11  (leaf)
 *     u1b t12
 *      a1b t13  (leaf)
 *    a0b t14    (leaf, second child of u0)
 */
function forkTree(): MessageRecord[] {
  return link([
    structural('r'),
    m('u0', 'r', { t: 1, ordinal: 1 }),
    m('a0', 'u0', { t: 2, ordinal: 2 }),
    m('u1', 'a0', { t: 3, ordinal: 3 }),
    m('a1x', 'u1', { t: 10, ordinal: 4 }),
    m('a1y', 'u1', { t: 11, ordinal: 5 }),
    m('u1b', 'a0', { t: 12, ordinal: 6 }),
    m('a1b', 'u1b', { t: 13, ordinal: 7 }),
    m('a0b', 'u0', { t: 14, ordinal: 8 }),
  ]);
}

describe('linear conversations', () => {
  it('one branch, one root, one leaf, no warnings, active from currentNodeId', () => {
    const rec = linearConversation('lin', 3);
    const a = analyzeTree(rec.id, rec.messages, rec.currentNodeId);
    assert.equal(a.conversationId, 'lin');
    assert.deepEqual(a.rootIds, ['lin-root']);
    assert.deepEqual(a.leafIds, ['lin-a2']);
    assert.deepEqual(a.unreachableIds, []);
    assert.deepEqual(a.warnings, []);
    assert.equal(a.branches.length, 1);
    const [b] = a.branches;
    assert.ok(b);
    assert.deepEqual(b.path, ['lin-root', 'lin-u0', 'lin-a0', 'lin-u1', 'lin-a1', 'lin-u2', 'lin-a2']);
    assert.equal(b.branchId, 'lin-a2');
    assert.equal(b.leafId, 'lin-a2');
    assert.equal(b.rootId, 'lin-root');
    assert.equal(b.index, 0);
    assert.equal(b.forkNodeId, null);
    assert.equal(b.messageCount, 6); // structural root not counted
    assert.equal(b.visibleMessageCount, 6);
    assert.equal(b.activeness, 'active');
    assert.equal(a.activeBranchId, 'lin-a2');
  });

  it('hidden messages lower visibleMessageCount only; structural nodes lower neither', () => {
    const msgs = link([structural('r'), m('u', 'r', { t: 1 }), m('sys', 'u', { t: 2, hidden: true }), m('a', 'sys', { t: 3 })]);
    const a = analyze(msgs, 'a');
    const [b] = a.branches;
    assert.equal(b?.messageCount, 3);
    assert.equal(b?.visibleMessageCount, 2);
  });

  it('works without a structural root and with a single node', () => {
    const a = analyze([m('only', null)], 'only');
    assert.deepEqual(ids(a), ['only']);
    assert.equal(a.branches[0]?.messageCount, 1);
    assert.equal(a.branches[0]?.activeness, 'active');
  });

  it('empty conversation: no roots/leaves/branches; warns about the current node pointer', () => {
    const none = analyze([], null);
    assert.deepEqual([none.rootIds, none.leafIds, none.branches, none.unreachableIds], [[], [], [], []]);
    assert.deepEqual(codes(none), ['NO_CURRENT_NODE']);
    assert.equal(none.activeBranchId, null);
    assert.deepEqual(codes(analyze([], 'x')), ['INVALID_CURRENT_NODE']);
  });

  it('a structural-only root is still a (message-less) branch', () => {
    const a = analyze([structural('r')], null);
    assert.deepEqual(ids(a), ['r']);
    assert.equal(a.branches[0]?.messageCount, 0);
  });
});

describe('forks', () => {
  it('forks at several depths: branch order, forkNodeId, counts', () => {
    const a = analyze(forkTree(), 'a1y');
    assert.deepEqual(a.rootIds, ['r']);
    assert.deepEqual(a.leafIds, ['a1x', 'a1y', 'a1b', 'a0b']);
    assert.deepEqual(ids(a), ['a1x', 'a1y', 'a1b', 'a0b']);
    assert.deepEqual(a.branches.map((b) => b.index), [0, 1, 2, 3]);
    assert.deepEqual(a.branches.map((b) => b.forkNodeId), [null, 'u1', 'a0', 'u0']);
    assert.deepEqual(a.branches.map((b) => b.messageCount), [4, 4, 4, 2]);
    assert.deepEqual(a.branches[2]?.path, ['r', 'u0', 'a0', 'u1b', 'a1b']);
    assert.deepEqual(a.warnings, []);
  });

  it('edited prompt at the root (shared helper fixture): the edit forks directly under the structural root', () => {
    const rec = branchedConversation('ed');
    const a = analyze(rec.messages, rec.currentNodeId);
    assert.deepEqual(ids(a), ['ed-a1_old', 'ed-a1_new', 'ed-a0_edit']);
    assert.deepEqual(a.branches.map((b) => b.forkNodeId), [null, 'ed-u1', 'ed-root']);
    assert.deepEqual(a.branches.map((b) => b.activeness), ['inactive', 'active', 'inactive']);
    assert.equal(a.activeBranchId, 'ed-a1_new');
    assert.deepEqual(a.warnings, []);
  });

  it('the first branch (by time) need not be the first in declared child order', () => {
    // r -> p -> {late (declared first, created last), early}
    const msgs = link([structural('r'), m('p', 'r', { t: 1 }), m('late', 'p', { t: 9 }), m('early', 'p', { t: 5 })]);
    const a = analyze(msgs, null);
    assert.deepEqual(ids(a), ['early', 'late']);
    assert.deepEqual(a.branches.map((b) => b.forkNodeId), [null, 'p']);
  });

  it('multiple roots: each root has its own first branch (fork null); branches interleave by leaf time', () => {
    const msgs = link([m('r1', null, { t: 1 }), m('x1', 'r1', { t: 20 }), m('x2', 'r1', { t: 22 }), m('r2', null, { t: 2 }), m('y1', 'r2', { t: 21 })]);
    const a = analyze(msgs, 'y1');
    assert.deepEqual(a.rootIds, ['r1', 'r2']);
    assert.deepEqual(ids(a), ['x1', 'y1', 'x2']);
    assert.deepEqual(a.branches.map((b) => b.rootId), ['r1', 'r2', 'r1']);
    assert.deepEqual(a.branches.map((b) => b.forkNodeId), [null, null, 'r1']);
    assert.deepEqual(a.branches.map((b) => b.activeness), ['inactive', 'active', 'inactive']);
    assert.equal(a.activeBranchId, 'y1');
  });

  it('duplicate fan-out: equal/missing timestamps order by ordinal, then id, whatever the input order', () => {
    const kids = [
      m('k-b', 'p', { ordinal: 3 }),
      m('k-a', 'p', { ordinal: 3 }),
      m('k-z', 'p', { ordinal: 1 }),
      m('k-m', 'p', { ordinal: 2 }),
      m('k-t', 'p', { ordinal: 0, t: 7 }), // has a timestamp -> sorts before every null-time sibling
    ];
    const a = analyze(link([m('p', null, { t: 0 }), ...kids]), null);
    assert.deepEqual(ids(a), ['k-t', 'k-z', 'k-m', 'k-a', 'k-b']);
    const equalTimes = link([m('p', null, { t: 0 }), ...['d', 'a', 'c', 'b'].map((x) => m(`s-${x}`, 'p', { t: 5, ordinal: 4 }))]);
    assert.deepEqual(ids(analyze(equalTimes, null)), ['s-a', 's-b', 's-c', 's-d']);
  });

  it('the id tie-break is plain code-unit order, never locale-dependent', () => {
    // Locale-aware comparison would give "_x, a, B, é, Z" (or similar); code-unit order is "B, Z, _x, a, é".
    const msgs = link([m('p', null, { t: 0 }), ...['a', 'B', '_x', 'Z', 'é'].map((id) => m(id, 'p', { t: 5, ordinal: 1 }))]);
    assert.deepEqual(ids(analyze(msgs, null)), ['B', 'Z', '_x', 'a', 'é']);
  });

  it('timestamps compare as instants, not strings (".500Z" vs no fraction, equal-ms spellings)', () => {
    const msgs = link([
      m('p', null),
      m('later', 'p', { createdAt: '2025-01-01T00:00:00.500Z' }),
      m('earlier', 'p', { createdAt: '2025-01-01T00:00:00Z' }), // "…:00Z" > "…:00.500Z" as a string, but it is earlier
    ]);
    assert.deepEqual(ids(analyze(msgs, null)), ['earlier', 'later']);
  });

  it('non-strict timestamps are treated as unknown (null last), never parsed locale/zone-dependently', () => {
    const msgs = link([m('p', null), m('zoneless', 'p', { createdAt: '2025-01-01T00:00:00' }), m('good', 'p', { t: 5 })]);
    assert.deepEqual(ids(analyze(msgs, null)), ['good', 'zoneless']);
  });
});

describe('active branch marking', () => {
  it('leaf === currentNodeId is active, others inactive', () => {
    const a = analyze(forkTree(), 'a1b');
    assert.deepEqual(a.branches.map((b) => [b.branchId, b.activeness]), [['a1x', 'inactive'], ['a1y', 'inactive'], ['a1b', 'active'], ['a0b', 'inactive']]);
    assert.equal(a.activeBranchId, 'a1b');
    assert.deepEqual(a.warnings, []);
  });

  it('a non-leaf currentNodeId with ONE branch through it: contains_current_node, that branch is activeBranchId, no warning', () => {
    const a = analyze(forkTree(), 'u1b');
    assert.deepEqual(a.branches.map((b) => b.activeness), ['inactive', 'inactive', 'contains_current_node', 'inactive']);
    assert.equal(a.activeBranchId, 'a1b');
    assert.deepEqual(a.warnings, []);
  });

  it('a non-leaf currentNodeId with SEVERAL branches through it: all contains_current_node, first in branch order, with a warning', () => {
    const a = analyze(forkTree(), 'u1');
    assert.deepEqual(a.branches.map((b) => b.activeness), ['contains_current_node', 'contains_current_node', 'inactive', 'inactive']);
    assert.equal(a.activeBranchId, 'a1x');
    const w = warnings(a, 'CURRENT_NODE_NOT_LEAF');
    assert.equal(w.length, 1);
    assert.deepEqual(w[0]?.ids, ['u1']);
  });

  it('the root as currentNodeId: every branch contains it', () => {
    const a = analyze(forkTree(), 'r');
    assert.ok(a.branches.every((b) => b.activeness === 'contains_current_node'));
    assert.equal(a.activeBranchId, 'a1x');
  });

  it('null currentNodeId: NO_CURRENT_NODE, every branch unknown, activeBranchId null (no guessing)', () => {
    const a = analyze(forkTree(), null);
    assert.deepEqual(codes(a), ['NO_CURRENT_NODE']);
    assert.ok(a.branches.every((b) => b.activeness === 'unknown'));
    assert.equal(a.activeBranchId, null);
    assert.deepEqual(warnings(a, 'NO_CURRENT_NODE')[0]?.ids, [C]);
  });

  it('currentNodeId that is not a node: INVALID_CURRENT_NODE, all unknown', () => {
    const a = analyze(forkTree(), 'ghost');
    assert.deepEqual(codes(a), ['INVALID_CURRENT_NODE']);
    assert.ok(a.branches.every((b) => b.activeness === 'unknown'));
    assert.equal(a.activeBranchId, null);
    assert.deepEqual(a.warnings[0]?.ids, ['ghost']);
  });

  it('empty string and wrong-typed currentNodeId are invalid, never matched', () => {
    for (const bad of ['', 5 as unknown as string, {} as unknown as string]) {
      const a = analyzeTree(C, forkTree(), bad);
      assert.deepEqual(codes(a), ['INVALID_CURRENT_NODE']);
      assert.equal(a.activeBranchId, null);
    }
  });

  it('currentNodeId that exists but sits in a cycle (unreachable): INVALID_CURRENT_NODE, all unknown', () => {
    const msgs = link([m('r', null, { t: 1 }), m('x', 'r', { t: 2 }), m('c1', 'c2'), m('c2', 'c1')]);
    const a = analyze(msgs, 'c1');
    assert.deepEqual(codes(a).sort(), ['CYCLE_DETECTED', 'INVALID_CURRENT_NODE']);
    assert.ok(a.branches.every((b) => b.activeness === 'unknown'));
    assert.equal(a.activeBranchId, null);
  });
});

describe('anomalies', () => {
  it('missing parent: warning, node becomes a root, its subtree is kept', () => {
    const msgs = link([m('r', null, { t: 1 }), m('a', 'r', { t: 2 }), m('orphan', 'ghost', { t: 3 }), m('child', 'orphan', { t: 4 })]);
    const a = analyze(msgs, 'child');
    assert.deepEqual(a.rootIds, ['r', 'orphan']);
    assert.deepEqual(ids(a), ['a', 'child']);
    assert.deepEqual(a.branches[1]?.path, ['orphan', 'child']);
    assert.equal(a.branches[1]?.forkNodeId, null);
    const w = warnings(a, 'MISSING_PARENT');
    assert.equal(w.length, 1);
    assert.deepEqual(w[0]?.ids, ['orphan']);
    assert.deepEqual(codes(a), ['MISSING_PARENT']); // and nothing else: ghost declares nothing
  });

  it('self-parent: SELF_PARENT, node (and its descendants) unreachable, no branch, no CYCLE_DETECTED', () => {
    const msgs = link([m('r', null, { t: 1 }), m('s', 's', { t: 2 }), m('under', 's', { t: 3 })]);
    const a = analyze(msgs, null);
    assert.deepEqual(codes(a), ['SELF_PARENT', 'NO_CURRENT_NODE']);
    assert.deepEqual(warnings(a, 'SELF_PARENT')[0]?.ids, ['s']);
    assert.deepEqual(a.unreachableIds, ['s', 'under']);
    assert.deepEqual(ids(a), ['r']);
  });

  it('cycle: CYCLE_DETECTED lists the cycle ids (smallest first, each id\'s parent is the next); cycle + tail are unreachable', () => {
    // parent pointers: a -> b -> c -> a ; tail d hangs under a ; normal tree r -> x
    const msgs = link([m('r', null, { t: 1 }), m('x', 'r', { t: 2 }), m('a', 'b'), m('b', 'c'), m('c', 'a'), m('d', 'a', { t: 5 })]);
    const a = analyze(msgs, 'x');
    const w = warnings(a, 'CYCLE_DETECTED');
    assert.equal(w.length, 1);
    assert.deepEqual(w[0]?.ids, ['a', 'b', 'c']);
    assert.deepEqual(new Set(a.unreachableIds), new Set(['a', 'b', 'c', 'd']));
    assert.deepEqual(ids(a), ['x']);
    assert.equal(a.activeBranchId, 'x');
    assert.equal(a.branches[0]?.activeness, 'active');
  });

  it('two independent cycles give two warnings in id order; a cycle of 2 reports both ids', () => {
    const msgs = link([m('z1', 'z2'), m('z2', 'z1'), m('b1', 'b2'), m('b2', 'b3'), m('b3', 'b1')]);
    const a = analyze(msgs, null);
    assert.deepEqual(warnings(a, 'CYCLE_DETECTED').map((w) => w.ids), [['b1', 'b2', 'b3'], ['z1', 'z2']]);
    assert.deepEqual(a.branches, []);
    assert.equal(a.unreachableIds.length, 5);
    assert.deepEqual(a.rootIds, []);
  });

  it('a graph made only of a cycle terminates and reports everything unreachable', () => {
    const a = analyze(link([m('p', 'q'), m('q', 'p')]), 'p');
    assert.deepEqual(a.branches, []);
    assert.deepEqual(a.leafIds, []);
    assert.deepEqual(a.unreachableIds, ['p', 'q']);
  });

  it('more than 100 cycles: first 100 individually, the rest summarized (bounded output)', () => {
    const msgs: MessageRecord[] = [];
    for (let i = 0; i < 150; i++) {
      const id = String(i).padStart(3, '0');
      msgs.push(m(`a${id}`, `b${id}`), m(`b${id}`, `a${id}`));
    }
    const a = analyze(msgs, null);
    const w = warnings(a, 'CYCLE_DETECTED');
    assert.equal(w.length, 101);
    assert.deepEqual(w[0]?.ids, ['a000', 'b000']);
    assert.equal(w[100]?.ids, undefined);
    assert.match(w[100]?.message ?? '', /50 further cycles/);
    assert.equal(a.unreachableIds.length, 300);
  });

  it('declared child whose parentId differs: CHILD_PARENT_MISMATCH, parent pointers win', () => {
    const msgs = link([m('r', null, { t: 1 }), m('p', 'r', { t: 2 }), m('q', 'r', { t: 3 }), m('x', 'q', { t: 4 })]);
    const p = msgs.find((n) => n.id === 'p');
    assert.ok(p);
    p.childIds = ['x']; // p claims x, but x's parent pointer says q
    const a = analyze(msgs, null);
    const w = warnings(a, 'CHILD_PARENT_MISMATCH');
    assert.equal(w.length, 1);
    assert.deepEqual(new Set(w[0]?.ids), new Set(['p', 'x'])); // q lists x consistently with x's pointer: not involved
    assert.deepEqual(a.branches.find((b) => b.leafId === 'x')?.path, ['r', 'q', 'x']);
    assert.deepEqual(ids(a).sort(), ['p', 'x']);
  });

  it('child whose parent does not list it: CHILD_PARENT_MISMATCH', () => {
    const msgs = link([m('r', null, { t: 1 }), m('a', 'r', { t: 2 }), m('b', 'r', { t: 3 })]);
    const root = msgs.find((n) => n.id === 'r');
    assert.ok(root);
    root.childIds = ['a'];
    const a = analyze(msgs, null);
    assert.deepEqual(new Set(warnings(a, 'CHILD_PARENT_MISMATCH')[0]?.ids), new Set(['r', 'b']));
    assert.deepEqual(ids(a), ['a', 'b']); // the unlisted child is still a branch
  });

  it('declared child that does not exist (dangling) and repeated declarations are mismatches', () => {
    const dangling = link([m('r', null, { t: 1 }), m('a', 'r', { t: 2 })]);
    dangling[0]!.childIds = ['a', 'ghost'];
    const a1 = analyze(dangling, null);
    assert.deepEqual(new Set(warnings(a1, 'CHILD_PARENT_MISMATCH')[0]?.ids), new Set(['r', 'ghost']));
    assert.deepEqual(ids(a1), ['a']);
    const dup = link([m('r', null, { t: 1 }), m('a', 'r', { t: 2 }), m('b', 'r', { t: 3 })]);
    dup[0]!.childIds = ['a', 'b', 'a'];
    const a2 = analyze(dup, null);
    assert.equal(warnings(a2, 'CHILD_PARENT_MISMATCH').length, 1);
    assert.deepEqual(ids(a2), ['a', 'b']);
  });

  it('a consistent tree (any declared order) produces no mismatch warning', () => {
    const msgs = forkTree();
    msgs.find((n) => n.id === 'u0')!.childIds.reverse();
    assert.deepEqual(warnings(analyze(msgs, 'a1x'), 'CHILD_PARENT_MISMATCH'), []);
  });

  it('duplicate message ids: DUPLICATE_NODE_ID and a deterministic choice (lowest ordinal) independent of input order', () => {
    const msgs = [m('r', null, { t: 1 }), m('dup', 'r', { t: 2, ordinal: 5, text: 'first' }), m('dup', 'r', { t: 2, ordinal: 4, text: 'second' })];
    const a = analyze(msgs, null);
    assert.deepEqual(warnings(a, 'DUPLICATE_NODE_ID')[0]?.ids, ['dup']);
    assert.equal(a.branches.length, 1);
  });

  it('warnings carry ids and counts only, never message text', () => {
    const msgs = link([m('r', null, { t: 1 }), m('o', 'ghost', { t: 2 }), m('s', 's'), m('c1', 'c2'), m('c2', 'c1'), m('x', 'r', { t: 3 })]);
    msgs[0]!.childIds = ['x', 'nope'];
    const a = analyze(msgs, 'ghost');
    assert.ok(a.warnings.length >= 4);
    assert.equal(JSON.stringify(a.warnings).includes('SECRET'), false);
  });

  it('long id lists are capped at 1000 with the true total in the message', () => {
    const msgs: MessageRecord[] = [];
    for (let i = 0; i < 2500; i++) msgs.push(m(`o${String(i).padStart(4, '0')}`, 'ghost'));
    const a = analyze(msgs, null);
    const w = warnings(a, 'MISSING_PARENT')[0];
    assert.equal(w?.ids?.length, 1000);
    assert.match(w?.message ?? '', /2500 ids/);
    assert.equal(a.rootIds.length, 2500);
  });

  it('does not mutate its input (deep-frozen records are fine)', () => {
    analyze(deepFreeze(forkTree()), 'a1x');
    analyzeTree(C, deepFreeze(link([m('a', 'b'), m('b', 'a')])), null);
  });
});

describe('visit order and limits', () => {
  /** p with children a(t1) b(t2) c(t3); declared order given by `declared`. */
  function star(declared: string[]): MessageRecord[] {
    const msgs = [m('p', null, { t: 0 }), m('a', 'p', { t: 1 }), m('b', 'p', { t: 2 }), m('c', 'p', { t: 3 })];
    msgs[0]!.childIds = declared;
    return msgs;
  }

  it('without truncation the declared order does not affect branch order (time order wins)', () => {
    assert.deepEqual(ids(analyze(star(['c', 'a', 'b']))), ['a', 'b', 'c']);
  });

  it('truncated enumeration keeps the first leaves in DECLARED order when it agrees with the parent pointers', () => {
    const a = analyze(star(['c', 'a', 'b']), null, { maxBranches: 2 });
    assert.deepEqual(ids(a), ['a', 'c']); // visited c, a; listed by time
    assert.deepEqual(a.leafIds, ['a', 'b', 'c']); // leafIds is complete even when truncated
    const w = warnings(a, 'BRANCH_LIMIT_EXCEEDED');
    assert.equal(w.length, 1);
    assert.deepEqual(w[0]?.ids, ['b']);
    assert.match(w[0]?.message ?? '', /maxBranches/);
    assert.match(w[0]?.message ?? '', /2 of 3/);
  });

  it('falls back to (createdAt, ordinal, id) order when the declared list is inconsistent', () => {
    const a = analyze(star(['c']), null, { maxBranches: 2 });
    assert.deepEqual(ids(a), ['a', 'b']);
    assert.equal(warnings(a, 'CHILD_PARENT_MISMATCH').length, 1);
    const ghost = analyze(star(['c', 'ghost', 'a', 'b']), null, { maxBranches: 2 });
    assert.deepEqual(ids(ghost), ['a', 'b']);
  });

  it('exactly maxBranches leaves is not truncation', () => {
    const a = analyze(star(['a', 'b', 'c']), null, { maxBranches: 3 });
    assert.equal(a.branches.length, 3);
    assert.deepEqual(warnings(a, 'BRANCH_LIMIT_EXCEEDED'), []);
  });

  it('maxTotalPathNodes bounds the sum of path lengths', () => {
    const msgs = link([m('r', null, { t: 0 }), m('x', 'r', { t: 1 }), m('l1', 'x', { t: 2 }), m('l2', 'x', { t: 3 }), m('l3', 'x', { t: 4 })]); // 3 paths of length 3
    const all = analyze(msgs, null, { maxTotalPathNodes: 9 });
    assert.equal(all.branches.length, 3);
    assert.deepEqual(warnings(all, 'BRANCH_LIMIT_EXCEEDED'), []);
    const cut = analyze(msgs, null, { maxTotalPathNodes: 8 });
    assert.equal(cut.branches.length, 2);
    const w = warnings(cut, 'BRANCH_LIMIT_EXCEEDED')[0];
    assert.match(w?.message ?? '', /maxTotalPathNodes/);
    assert.deepEqual(w?.ids, ['l3']);
    const none = analyze(msgs, null, { maxTotalPathNodes: 2 });
    assert.deepEqual(none.branches, []);
    assert.equal(none.leafIds.length, 3);
    assert.equal(warnings(none, 'BRANCH_LIMIT_EXCEEDED').length, 1);
  });

  it('defaults are 10,000 branches and 5,000,000 path nodes', () => {
    assert.equal(DEFAULT_MAX_BRANCHES, 10_000);
    assert.equal(DEFAULT_MAX_TOTAL_PATH_NODES, 5_000_000);
  });

  it('when truncation drops the active branch, activeBranchId is null, enumerated branches are inactive, and the warning says so', () => {
    const a = analyze(star(['a', 'b', 'c']), 'c', { maxBranches: 1 });
    assert.equal(a.activeBranchId, null);
    assert.deepEqual(a.branches.map((b) => b.activeness), ['inactive']);
    assert.match(warnings(a, 'BRANCH_LIMIT_EXCEEDED')[0]?.message ?? '', /NOT enumerated/);
  });

  it('invalid limits are INVALID_ARGUMENT; Infinity means unlimited', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '5' as unknown as number]) {
      expectCode(() => analyzeTree(C, [], null, { maxBranches: bad }), 'INVALID_ARGUMENT');
      expectCode(() => analyzeTree(C, [], null, { maxTotalPathNodes: bad }), 'INVALID_ARGUMENT');
    }
    assert.equal(analyze(star(['a', 'b', 'c']), null, { maxBranches: Infinity, maxTotalPathNodes: Infinity }).branches.length, 3);
  });
});

describe('threadForBranch', () => {
  const msgs = (): MessageRecord[] =>
    link([structural('r'), m('u', 'r', { t: 1 }), m('hid', 'u', { t: 2, hidden: true }), m('a', 'hid', { t: 3 }), m('alt', 'u', { t: 4 })]);

  it('returns the branch messages root->leaf, omitting hidden and structural nodes by default (same object references)', () => {
    const all = msgs();
    const a = analyzeTree(C, all, null);
    const t = threadForBranch(a, all, 'a');
    assert.deepEqual(t.map((x) => x.id), ['u', 'a']);
    assert.equal(t[0], all.find((x) => x.id === 'u'));
  });

  it('includeHidden / includeStructural are independent switches', () => {
    const all = msgs();
    const a = analyzeTree(C, all, null);
    assert.deepEqual(threadForBranch(a, all, 'a', { includeHidden: true }).map((x) => x.id), ['u', 'hid', 'a']);
    assert.deepEqual(threadForBranch(a, all, 'a', { includeStructural: true }).map((x) => x.id), ['r', 'u', 'a']);
    assert.deepEqual(threadForBranch(a, all, 'a', { includeHidden: true, includeStructural: true }).map((x) => x.id), ['r', 'u', 'hid', 'a']);
    assert.deepEqual(threadForBranch(a, all, 'alt').map((x) => x.id), ['u', 'alt']);
  });

  it('is independent of the order of the messages array', () => {
    const all = msgs();
    const a = analyzeTree(C, all, null);
    for (const p of permutations(all)) assert.deepEqual(threadForBranch(a, p, 'a', { includeHidden: true }).map((x) => x.id), ['u', 'hid', 'a']);
  });

  it('works for every branch of the shared branched fixture', () => {
    const rec = branchedConversation('t');
    const a = analyzeTree(rec.id, rec.messages, rec.currentNodeId);
    assert.deepEqual(threadForBranch(a, rec.messages, 't-a1_new').map((x) => x.id), ['t-u0', 't-a0', 't-u1', 't-a1_new']);
    assert.deepEqual(threadForBranch(a, rec.messages, 't-a0_edit').map((x) => x.id), ['t-u0_edit', 't-a0_edit']);
  });

  it('unknown branch id, a non-leaf node id and the empty string are BRANCH_NOT_FOUND', () => {
    const all = msgs();
    const a = analyzeTree(C, all, null);
    for (const bad of ['nope', 'u', 'r', '']) expectCode(() => threadForBranch(a, all, bad), 'BRANCH_NOT_FOUND');
    expectCode(() => threadForBranch(a, all, 7 as unknown as string), 'INVALID_ARGUMENT');
  });

  it('BRANCH_NOT_FOUND does not echo more than a bounded id', () => {
    const a = analyzeTree(C, msgs(), null);
    try {
      threadForBranch(a, [], 'x'.repeat(5000));
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof GcrError);
      assert.ok(JSON.stringify(e.toEnvelope()).length < 1500);
    }
  });

  it('messages that do not contain the branch path are MESSAGE_NOT_FOUND', () => {
    const all = msgs();
    const a = analyzeTree(C, all, null);
    expectCode(() => threadForBranch(a, all.filter((x) => x.id !== 'u'), 'a'), 'MESSAGE_NOT_FOUND');
  });
});

describe('selectBranchByPolicy (explicit heuristics)', () => {
  it('last_child follows the LAST declared child from the first root and differs from the source current node here', () => {
    const rec = branchedConversation('h');
    const a = analyzeTree(rec.id, rec.messages, rec.currentNodeId);
    assert.equal(a.activeBranchId, 'h-a1_new');
    const sel = selectBranchByPolicy(a, rec.messages, 'last_child');
    assert.ok(sel);
    assert.equal(sel.branch.branchId, 'h-a0_edit'); // root.childIds = [u0, u0_edit] -> last = u0_edit
    assert.equal(sel.warning.code, 'ACTIVE_BRANCH_HEURISTIC');
    assert.deepEqual(sel.warning.ids, ['h-a0_edit']);
    assert.match(sel.warning.message, /last_child/);
    assert.equal(sel.branch, a.branches.find((b) => b.branchId === 'h-a0_edit'));
  });

  it('last_child uses the declared order, not time, when the declared list is consistent', () => {
    // children declared [early, late]; "late" is declared last although created first
    const msgs = link([m('p', null, { t: 0 }), m('early', 'p', { t: 9 }), m('late', 'p', { t: 1 })]);
    msgs[0]!.childIds = ['early', 'late'];
    const a = analyzeTree(C, msgs, null);
    assert.equal(selectBranchByPolicy(a, msgs, 'last_child')?.branch.branchId, 'late');
    assert.equal(selectBranchByPolicy(a, msgs, 'latest_leaf')?.branch.branchId, 'early');
  });

  it('last_child falls back to sorted order when the declared list is unusable', () => {
    const msgs = link([m('p', null, { t: 0 }), m('a', 'p', { t: 1 }), m('b', 'p', { t: 2 })]);
    msgs[0]!.childIds = ['a', 'ghost'];
    const a = analyzeTree(C, msgs, null);
    assert.equal(selectBranchByPolicy(a, msgs, 'last_child')?.branch.branchId, 'b');
  });

  it('last_child starts from the FIRST root (by the total order), not the last', () => {
    // two roots: r1 (older) with children x1,x2 ; r2 (newer) with child y1
    const msgs = link([m('r1', null, { t: 1 }), m('x1', 'r1', { t: 3 }), m('x2', 'r1', { t: 4 }), m('r2', null, { t: 2 }), m('y1', 'r2', { t: 9 })]);
    const a = analyzeTree(C, msgs, null);
    assert.deepEqual(a.rootIds, ['r1', 'r2']);
    assert.equal(selectBranchByPolicy(a, msgs, 'last_child')?.branch.branchId, 'x2');
    assert.equal(selectBranchByPolicy(a, msgs, 'latest_leaf')?.branch.branchId, 'y1'); // by contrast, the newest leaf overall
  });

  it('last_child descends several levels', () => {
    const a = analyzeTree(C, forkTree(), null);
    // r -> u0 -> (a0, a0b): last declared child of u0 is a0b
    assert.equal(selectBranchByPolicy(a, forkTree(), 'last_child')?.branch.branchId, 'a0b');
  });

  it('latest_leaf: greatest leaf createdAt; ties by greater ordinal, then greater id; leaves without a timestamp never win', () => {
    const msgs = link([
      m('p', null, { t: 0 }),
      m('x', 'p', { t: 5, ordinal: 5 }),
      m('a', 'p', { t: 9, ordinal: 7 }),
      m('b', 'p', { t: 9, ordinal: 7 }),
      m('o', 'p', { t: 9, ordinal: 6 }),
      m('untimed', 'p', { ordinal: 99 }),
    ]);
    const a = analyzeTree(C, msgs, null);
    const sel = selectBranchByPolicy(a, msgs, 'latest_leaf');
    assert.equal(sel?.branch.branchId, 'b');
    assert.equal(sel?.warning.code, 'ACTIVE_BRANCH_HEURISTIC');
    for (const p of permutations(msgs)) assert.equal(selectBranchByPolicy(analyzeTree(C, p, null), p, 'latest_leaf')?.branch.branchId, 'b');
  });

  it('latest_leaf returns null when no leaf has a timestamp (no guessing)', () => {
    const msgs = link([m('p', null), m('a', 'p'), m('b', 'p')]);
    assert.equal(selectBranchByPolicy(analyzeTree(C, msgs, null), msgs, 'latest_leaf'), null);
  });

  it('both policies return null for an analysis without branches or roots', () => {
    const empty = analyzeTree(C, [], null);
    assert.equal(selectBranchByPolicy(empty, [], 'last_child'), null);
    assert.equal(selectBranchByPolicy(empty, [], 'latest_leaf'), null);
    const cyc = link([m('a', 'b'), m('b', 'a')]);
    assert.equal(selectBranchByPolicy(analyzeTree(C, cyc, null), cyc, 'last_child'), null);
  });

  it('returns null when a truncated analysis does not contain the chosen leaf', () => {
    const msgs = link([m('p', null, { t: 0 }), m('a', 'p', { t: 1 }), m('b', 'p', { t: 2 })]);
    const a = analyzeTree(C, msgs, null, { maxBranches: 1 }); // enumerated: a (first declared)
    assert.deepEqual(ids(a), ['a']);
    assert.equal(selectBranchByPolicy(a, msgs, 'last_child'), null); // wants b
    // Also wants b: the newest leaf of the WHOLE tree (leafIds is complete even when truncated). The previous expectation
    // ('a', "only enumerated branches are candidates") presented the newest ENUMERATED leaf as the latest one, which is a
    // wrong answer to the question the heuristic claims to answer; see branches.truncation.adversarial.test.ts.
    assert.deepEqual(a.leafIds, ['a', 'b']);
    assert.equal(selectBranchByPolicy(a, msgs, 'latest_leaf'), null);
  });

  it('never attaches a heuristic result implicitly: analyzeTree alone never picks one', () => {
    const a = analyzeTree(C, forkTree(), null);
    assert.equal(a.activeBranchId, null);
    assert.equal(warnings(a, 'ACTIVE_BRANCH_HEURISTIC').length, 0);
  });

  it('an unknown policy is INVALID_ARGUMENT', () => {
    const a = analyzeTree(C, forkTree(), null);
    expectCode(() => selectBranchByPolicy(a, forkTree(), 'first' as unknown as 'last_child'), 'INVALID_ARGUMENT');
  });
});
