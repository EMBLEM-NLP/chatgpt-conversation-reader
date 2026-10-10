/**
 * Adversarial-review tests for src/domain/branches.ts (hostile inputs: duplicate ids, garbage arguments, prototype-ish
 * ids, truncated analyses). Each test here was written to FAIL against the first implementation and pass after the
 * fix, or (where noted "regression") to pin behaviour that the review confirmed as correct.
 * Synthetic data only; fast-check runs use a fixed seed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';
import type { MessageRecord, TreeAnalysis } from '../../src/domain/types.js';
import { analyzeTree, selectBranchByPolicy, threadForBranch } from '../../src/domain/branches.js';
import { iso, link, msg } from '../helpers/records.js';

const C = 'adv';
const SEED = 20261013;
const MARK = 'ZZSECRETMARKERZZ';

function m(id: string, parentId: string | null, extra: Partial<MessageRecord> = {}): MessageRecord {
  return msg({ id, conversationId: C, parentId, ...extra });
}

function expectCode(fn: () => unknown, code: ErrorCode, check?: (e: GcrError) => void): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    assert.equal(e.code, code);
    assert.equal(JSON.stringify(e.toEnvelope()).includes(MARK), false, 'error envelope leaked an input value');
    check?.(e);
    return true;
  });
}

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns: number): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** The observable content of a thread: enough fields to tell two "duplicate" message objects apart. */
function fingerprint(x: MessageRecord): string {
  return JSON.stringify([x.id, x.parentId, x.nodeKind, x.hidden, x.text, x.authorRole, x.modelSlug, x.createdAt, x.updatedAt, x.ordinal]);
}

// ------------------------------------------------------------------------------------------
// 1. Duplicate ids must not make the output depend on the order of the input array
// ------------------------------------------------------------------------------------------

describe('duplicate message ids are resolved independently of input order', () => {
  /** Two records with the same id that agree on every field the first implementation compared (ordinal, createdAt, parentId, childIds). */
  function pairDiffering(over: Partial<MessageRecord>): MessageRecord[] {
    const root = m('r', null, { createdAt: iso(0), ordinal: 0, childIds: ['d'] });
    const one = m('d', 'r', { createdAt: iso(1), ordinal: 3, text: 'one' });
    const two = m('d', 'r', { createdAt: iso(1), ordinal: 3, text: 'one', ...over });
    return [root, one, two];
  }

  const variants: Array<[string, Partial<MessageRecord>]> = [
    ['hidden flag', { hidden: true }],
    ['nodeKind and its content', { nodeKind: 'structural_empty', authorRole: '', text: '' }],
    ['nodeKind alone', { nodeKind: 'structural_empty' }],
    ['text', { text: 'two' }],
    ['author role', { authorRole: 'assistant' }],
    ['model slug', { modelSlug: 'model-x' }],
    ['updatedAt', { updatedAt: iso(9) }],
  ];

  for (const [label, over] of variants) {
    it(`analyzeTree counts and thread content do not depend on array order (duplicates differ only in: ${label})`, () => {
      const [root, one, two] = pairDiffering(over) as [MessageRecord, MessageRecord, MessageRecord];
      const forward = [root, one, two];
      const backward = [root, two, one];
      const a1 = analyzeTree(C, forward, 'd');
      const a2 = analyzeTree(C, backward, 'd');
      assert.deepEqual(a2, a1, 'analysis must not depend on which duplicate came first');
      const opts = { includeHidden: true, includeStructural: true };
      assert.deepEqual(threadForBranch(a1, forward, 'd', opts).map(fingerprint), threadForBranch(a1, backward, 'd', opts).map(fingerprint));
    });
  }

  it('a null parent and an empty-string parent are different parents (no accidental tie): the chosen duplicate is order-independent', () => {
    const x = m('d', null, { ordinal: 1 });
    const y = m('d', '', { ordinal: 1 });
    const a1 = analyzeTree(C, [x, y], null);
    const a2 = analyzeTree(C, [y, x], null);
    assert.deepEqual(a2, a1);
  });

  it('property: arbitrary dup-heavy graphs give identical analyses and threads for any permutation of the input', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const nodeArb = fc.record({
      id: fc.constantFrom(...ids),
      parent: fc.constantFrom<string | null>(null, '', 'a', 'b', 'c', 'd', 'ghost'),
      kids: fc.subarray(ids.concat('ghost')),
      ordinal: fc.constantFrom(0, 1),
      time: fc.constantFrom<number | null>(null, 0, 1),
      hidden: fc.boolean(),
      structural: fc.boolean(),
      text: fc.constantFrom('x', 'y'),
      model: fc.constantFrom<string | null>(null, 'm1', 'm2'),
    });
    runProperty(
      fc.property(fc.array(nodeArb, { minLength: 1, maxLength: 12 }), fc.array(fc.nat(1000), { minLength: 12, maxLength: 12 }), fc.constantFrom<string | null>(null, 'a', 'b', 'c', 'd', 'nope'), (specs, keys, current) => {
        const messages = specs.map((s) =>
          m(s.id, s.parent, {
            childIds: s.kids,
            ordinal: s.ordinal,
            createdAt: s.time === null ? null : iso(s.time),
            hidden: s.hidden,
            nodeKind: s.structural ? 'structural_empty' : 'message',
            authorRole: s.structural ? '' : 'user',
            text: s.structural ? '' : s.text,
            modelSlug: s.model,
          }),
        );
        const shuffled = messages
          .map((x, i) => ({ x, k: keys[i] as number, i }))
          .sort((p, q) => p.k - q.k || p.i - q.i)
          .map((e) => e.x);
        for (const opts of [undefined, { maxBranches: 1 }, { maxBranches: Infinity, maxTotalPathNodes: Infinity }]) {
          const a1 = analyzeTree(C, messages, current, opts);
          const a2 = analyzeTree(C, shuffled, current, opts);
          assert.deepEqual(a2, a1);
          for (const b of a1.branches) {
            const t = { includeHidden: true, includeStructural: true };
            assert.deepEqual(threadForBranch(a1, shuffled, b.branchId, t).map(fingerprint), threadForBranch(a1, messages, b.branchId, t).map(fingerprint));
          }
        }
      }),
      1500,
    );
  });
});

// ------------------------------------------------------------------------------------------
// 2. Garbage arguments are INVALID_ARGUMENT, never a raw TypeError, never silently accepted
// ------------------------------------------------------------------------------------------

describe('garbage arguments: GcrError INVALID_ARGUMENT, never a raw exception', () => {
  const ok = (): MessageRecord[] => [m('a', null), m('b', 'a')];
  const bad = (x: unknown): MessageRecord[] => x as MessageRecord[];

  const badMessageLists: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'abc'],
    ['an array-like object', { length: 1, 0: m('a', null) }],
    ['a Set', new Set([m('a', null)])],
    ['a null element', [m('a', null), null]],
    ['an undefined element', [undefined]],
    ['a sparse array', new Array(2)],
    ['a number element', [1]],
    ['a string element', ['a']],
    ['an element without an id', [{ parentId: null, childIds: [] }]],
    ['a numeric id', [{ ...m('a', null), id: 5 }]],
    ['an object id', [{ ...m('a', null), id: {} }]],
    ['a numeric parentId', [{ ...m('a', null), parentId: 7 }]],
    ['an object parentId', [{ ...m('a', null), parentId: {} }]],
    ['a null entry in childIds', [{ ...m('a', null), childIds: ['b', null] }]],
    ['a numeric entry in childIds', [{ ...m('a', null), childIds: [1] }]],
    ['a secret-bearing numeric parentId (value must not be echoed)', [{ ...m(MARK, null), parentId: 7 }]],
  ];

  for (const [label, value] of badMessageLists) {
    it(`analyzeTree rejects messages = ${label}`, () => {
      expectCode(() => analyzeTree(C, bad(value), null), 'INVALID_ARGUMENT');
    });
  }

  it('analyzeTree rejects a non-string conversationId and non-object options', () => {
    for (const cid of [undefined, null, 5, {}]) expectCode(() => analyzeTree(cid as unknown as string, ok(), null), 'INVALID_ARGUMENT');
    for (const opts of [null, 5, 'x', true]) expectCode(() => analyzeTree(C, ok(), null, opts as never), 'INVALID_ARGUMENT');
  });

  it('regression: the documented tolerances survive (missing/undefined parentId, missing or non-array childIds, odd currentNodeId)', () => {
    const lenient = [{ ...m('a', null), parentId: undefined, childIds: undefined }, { ...m('b', 'a'), childIds: 'zz' }] as unknown as MessageRecord[];
    const a = analyzeTree(C, lenient, undefined as unknown as null);
    assert.deepEqual(a.rootIds, ['a']);
    assert.deepEqual(a.branches.map((b) => b.path), [['a', 'b']]);
    assert.equal(a.warnings.some((w) => w.code === 'NO_CURRENT_NODE'), true);
    const n = analyzeTree(C, ok(), 5 as unknown as string);
    assert.equal(n.warnings.some((w) => w.code === 'INVALID_CURRENT_NODE'), true);
    assert.equal(n.activeBranchId, null);
  });

  it('threadForBranch rejects a bad analysis, bad messages, bad options and a malformed branch', () => {
    const msgs = ok();
    const a = analyzeTree(C, msgs, null);
    for (const an of [undefined, null, 5, {}, { branches: 'x' }]) expectCode(() => threadForBranch(an as unknown as TreeAnalysis, msgs, 'b'), 'INVALID_ARGUMENT');
    for (const [, value] of badMessageLists) expectCode(() => threadForBranch(a, bad(value), 'b'), 'INVALID_ARGUMENT');
    for (const opts of [null, 5, 'x']) expectCode(() => threadForBranch(a, msgs, 'b', opts as never), 'INVALID_ARGUMENT');
    const broken = { ...a, branches: [{ ...(a.branches[0] as object), path: undefined }] } as unknown as TreeAnalysis;
    expectCode(() => threadForBranch(broken, msgs, 'b'), 'INVALID_ARGUMENT');
  });

  it('selectBranchByPolicy rejects a bad analysis and bad messages for both policies', () => {
    const msgs = ok();
    const a = analyzeTree(C, msgs, null);
    for (const policy of ['last_child', 'latest_leaf'] as const) {
      for (const an of [undefined, null, 5, {}, { rootIds: [], branches: 'x' }, { rootIds: 'x', branches: [] }]) {
        expectCode(() => selectBranchByPolicy(an as unknown as TreeAnalysis, msgs, policy), 'INVALID_ARGUMENT');
      }
      for (const [, value] of badMessageLists) expectCode(() => selectBranchByPolicy(a, bad(value), policy), 'INVALID_ARGUMENT');
    }
  });

  it('property: arbitrary JSON-ish junk in message slots only ever yields a result or a GcrError', () => {
    runProperty(
      fc.property(fc.array(fc.anything(), { maxLength: 6 }), fc.anything(), (junk, current) => {
        try {
          const a = analyzeTree(C, junk as MessageRecord[], current as string);
          threadForBranch(a, junk as MessageRecord[], 'x');
        } catch (e) {
          assert.ok(e instanceof GcrError, `non-GcrError escaped: ${String(e)}`);
        }
      }),
      800,
    );
  });
});

// ------------------------------------------------------------------------------------------
// 3. A valid leaf that a truncated analysis did not enumerate is not "no such branch"
// ------------------------------------------------------------------------------------------

describe('threadForBranch on a truncated analysis', () => {
  const star = (n: number): MessageRecord[] => link([m('root', null, { createdAt: iso(0) }), ...Array.from({ length: n }, (_, i) => m(`l${i}`, 'root', { createdAt: iso(i + 1), ordinal: i + 1 }))]);

  it('names the real cause (leaf exists but was not enumerated) and the remedy', () => {
    const msgs = star(5);
    const a = analyzeTree(C, msgs, null, { maxBranches: 2 });
    const skipped = a.leafIds.find((id) => !a.branches.some((b) => b.branchId === id));
    assert.ok(skipped !== undefined);
    expectCode(() => threadForBranch(a, msgs, skipped), 'BRANCH_NOT_FOUND', (e) => {
      assert.equal(e.details?.['reason'], 'not_enumerated');
      assert.match(String(e.remedy), /maxBranches|maxTotalPathNodes|limit/i);
    });
  });

  it('a genuinely unknown id is reported as such', () => {
    const msgs = star(3);
    const a = analyzeTree(C, msgs, null, { maxBranches: 2 });
    for (const id of ['nope', 'root', '']) expectCode(() => threadForBranch(a, msgs, id), 'BRANCH_NOT_FOUND', (e) => assert.equal(e.details?.['reason'], 'unknown_branch'));
  });
});

// ------------------------------------------------------------------------------------------
// 4. Regression: prototype-ish ids, weird ids everywhere, NaN/negative ordinals
// ------------------------------------------------------------------------------------------

describe('regression: ids that collide with Object.prototype members', () => {
  const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'prototype', 'length'];

  it('as chain nodes, forks, current node, cycles and dangling parents/children', () => {
    const chain = NAMES.map((id, i) => m(id, i === 0 ? null : (NAMES[i - 1] as string), { ordinal: i, childIds: i + 1 < NAMES.length ? [NAMES[i + 1] as string] : [] }));
    const a = analyzeTree(C, chain, 'length');
    assert.deepEqual(a.branches[0]?.path, NAMES);
    assert.equal(a.activeBranchId, 'length');
    assert.deepEqual(a.warnings, []);

    const cyc = analyzeTree(C, [m('__proto__', 'constructor'), m('constructor', '__proto__'), m('toString', 'valueOf', { childIds: ['hasOwnProperty'] })], '__proto__');
    assert.deepEqual(cyc.warnings.map((w) => w.code).sort(), ['CHILD_PARENT_MISMATCH', 'CYCLE_DETECTED', 'INVALID_CURRENT_NODE', 'MISSING_PARENT']);
    assert.deepEqual(cyc.unreachableIds, ['__proto__', 'constructor']);
    assert.deepEqual(cyc.rootIds, ['toString']);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'Object.prototype must stay untouched');
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  it('threadForBranch and selectBranchByPolicy work with such ids', () => {
    const msgs = link([m('__proto__', null, { createdAt: iso(1) }), m('constructor', '__proto__', { createdAt: iso(2) }), m('toString', '__proto__', { createdAt: iso(3) })]);
    const a = analyzeTree(C, msgs, null);
    assert.deepEqual(threadForBranch(a, msgs, 'toString').map((x) => x.id), ['__proto__', 'toString']);
    assert.equal(selectBranchByPolicy(a, msgs, 'last_child')?.branch.branchId, 'toString');
    assert.equal(selectBranchByPolicy(a, msgs, 'latest_leaf')?.branch.branchId, 'toString');
  });
});

describe('regression: odd ordinals never break the total order', () => {
  it('NaN, Infinity, -0 and negative ordinals sort identically for every input permutation', () => {
    const odd = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, -5, 2 ** 60, 1.5];
    const msgs = [m('r', null), ...odd.map((o, i) => m(`k${i}`, 'r', { ordinal: o }))];
    const a1 = analyzeTree(C, msgs, null);
    const a2 = analyzeTree(C, msgs.slice().reverse(), null);
    assert.deepEqual(a2, a1);
    assert.equal(a1.branches.length, odd.length);
    // finite ordinals first in numeric order; non-finite ones (NaN/Infinity) are sanitized to the same maximum and then ordered by id
    const order = a1.branches.map((b) => b.branchId);
    assert.ok(order.indexOf('k5') < order.indexOf('k3'), '-5 before -0');
  });
});

// ------------------------------------------------------------------------------------------
// 5. Fuzz: hostile graphs with duplicate ids, weird id strings, cycles and self-parents terminate and stay consistent
// ------------------------------------------------------------------------------------------

describe('fuzz: hostile graphs', () => {
  const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', '__proto__', 'constructor', '', ' ', 'é', '\u0000x', '😀', 'a'.repeat(600));

  it('terminates; branches are genuine root->leaf paths of the CHOSEN nodes; every reachable node is on a branch; unreachable + covered = all ids', () => {
    const nodeArb = fc.record({
      id: idArb,
      parent: fc.option(idArb, { nil: null }),
      kids: fc.array(idArb, { maxLength: 4 }),
      ordinal: fc.integer({ min: 0, max: 2 }),
      time: fc.constantFrom<number | null>(null, 0, 1),
    });
    runProperty(
      fc.property(fc.array(nodeArb, { minLength: 0, maxLength: 14 }), fc.option(idArb, { nil: null }), (specs, current) => {
        const messages = specs.map((s) => m(s.id, s.parent, { childIds: s.kids, ordinal: s.ordinal, createdAt: s.time === null ? null : iso(s.time) }));
        const a = analyzeTree(C, messages, current, { maxBranches: Infinity, maxTotalPathNodes: Infinity });
        JSON.stringify(a);
        const allIds = new Set(messages.map((x) => x.id));
        const covered = new Set(a.branches.flatMap((b) => b.path));
        const unreachable = new Set(a.unreachableIds);
        for (const id of allIds) assert.equal(covered.has(id) !== unreachable.has(id), true, 'a node is either on a branch or unreachable');
        assert.equal(a.branches.length, a.leafIds.length);
        assert.equal(new Set(a.leafIds).size, a.leafIds.length);
        for (const b of a.branches) {
          assert.equal(new Set(b.path).size, b.path.length, 'a path never revisits a node');
          assert.equal(b.path[b.path.length - 1], b.branchId);
        }
        for (const w of a.warnings) {
          assert.ok((w.ids ?? []).length <= 1000);
          for (const id of w.ids ?? []) assert.ok(id.length <= 512);
        }
      }),
      1500,
    );
  });
});
