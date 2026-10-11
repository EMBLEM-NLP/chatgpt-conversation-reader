/**
 * Second adversarial pass over src/domain/branches.ts. Lens: a truncated analysis (BRANCH_LIMIT_EXCEEDED) must never make
 * a heuristic answer a DIFFERENT question than the full analysis would, warnings must not misdescribe truncated id
 * lists, duplicate ids must resolve identically for every input order (a census over EVERY scalar MessageRecord field),
 * and the thread/branch counters must agree on arbitrary hostile graphs (duplicates, hidden/structural nodes).
 * Tests marked "DEFECT" failed against the implementation that was handed over for this pass.
 * Synthetic data only; property runs use a fixed seed that is printed on failure.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import type { MessageRecord } from '../../src/domain/types.js';
import { analyzeTree, selectBranchByPolicy, threadForBranch } from '../../src/domain/branches.js';
import type { BranchPolicy } from '../../src/domain/branches.js';
import { iso, link, msg } from '../helpers/records.js';

const C = 'trunc';
const SEED = 20261016;
const UNLIMITED = { maxBranches: Infinity, maxTotalPathNodes: Infinity } as const;
const POLICIES: readonly BranchPolicy[] = ['last_child', 'latest_leaf'];

function m(id: string, parentId: string | null, extra: Partial<MessageRecord> & { t?: number } = {}): MessageRecord {
  const { t, ...rest } = extra;
  return msg({ id, conversationId: C, parentId, createdAt: t === undefined ? null : iso(t), authorRole: 'user', ...rest });
}

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns: number): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

// ------------------------------------------------------------------------------------------
// DEFECT 1: latest_leaf only looked at the ENUMERATED branches of a truncated analysis
// ------------------------------------------------------------------------------------------

describe('DEFECT: selectBranchByPolicy on a truncated analysis answers the same question as on the full analysis', () => {
  /** p(t0) with leaves a(t1) b(t2) c(t3); `declared` is the declared child order (= visit order = what survives truncation). */
  function star(declared: string[]): MessageRecord[] {
    const msgs = [m('p', null, { t: 0 }), m('a', 'p', { t: 1, ordinal: 1 }), m('b', 'p', { t: 2, ordinal: 2 }), m('c', 'p', { t: 3, ordinal: 3 })];
    msgs[0]!.childIds = declared;
    return msgs;
  }

  it('latest_leaf: the newest leaf was not enumerated -> null, never an older leaf presented as "the latest"', () => {
    const msgs = star(['a', 'b', 'c']);
    const full = analyzeTree(C, msgs, null);
    assert.equal(selectBranchByPolicy(full, msgs, 'latest_leaf')?.branch.branchId, 'c');
    const cut = analyzeTree(C, msgs, null, { maxBranches: 2 });
    assert.deepEqual(cut.branches.map((b) => b.branchId), ['a', 'b']);
    assert.deepEqual(cut.leafIds, ['a', 'b', 'c']); // the analysis itself knows c exists
    assert.equal(selectBranchByPolicy(cut, msgs, 'latest_leaf'), null);
  });

  it('latest_leaf: the same holds when the cut is made by maxTotalPathNodes', () => {
    const msgs = star(['a', 'b', 'c']); // three paths of length 2
    const cut = analyzeTree(C, msgs, null, { maxTotalPathNodes: 4 });
    assert.equal(cut.branches.length, 2);
    assert.equal(selectBranchByPolicy(cut, msgs, 'latest_leaf'), null);
  });

  it('latest_leaf: the newest leaf IS enumerated (it was visited first) -> that branch, with the heuristic warning', () => {
    const msgs = star(['c', 'a', 'b']);
    const cut = analyzeTree(C, msgs, null, { maxBranches: 2 });
    assert.deepEqual(cut.branches.map((b) => b.branchId), ['a', 'c']);
    const sel = selectBranchByPolicy(cut, msgs, 'latest_leaf');
    assert.equal(sel?.branch.branchId, 'c');
    assert.equal(sel?.warning.code, 'ACTIVE_BRANCH_HEURISTIC');
    assert.deepEqual(sel?.warning.ids, ['c']);
  });

  it('latest_leaf: dropped leaves without a timestamp cannot win, so the best enumerated timed leaf is still returned', () => {
    const msgs = link([m('p', null, { t: 0 }), m('a', 'p', { t: 1, ordinal: 1 }), m('u1', 'p', { ordinal: 2 }), m('u2', 'p', { ordinal: 3 })]);
    const cut = analyzeTree(C, msgs, null, { maxBranches: 1 });
    assert.deepEqual(cut.branches.map((b) => b.branchId), ['a']);
    assert.equal(selectBranchByPolicy(cut, msgs, 'latest_leaf')?.branch.branchId, 'a');
  });

  it('latest_leaf: a truncated analysis whose enumerated leaves all lack timestamps but a dropped leaf has one -> null', () => {
    const msgs = link([m('p', null, { t: 0 }), m('u1', 'p', { ordinal: 1 }), m('timed', 'p', { t: 5, ordinal: 2 })]);
    msgs[0]!.childIds = ['u1', 'timed'];
    const cut = analyzeTree(C, msgs, null, { maxBranches: 1 });
    assert.deepEqual(cut.branches.map((b) => b.branchId), ['u1']);
    assert.equal(selectBranchByPolicy(cut, msgs, 'latest_leaf'), null);
  });

  it('a hand-built analysis without leafIds still works (falls back to the enumerated branches)', () => {
    const msgs = star(['a', 'b', 'c']);
    const a = analyzeTree(C, msgs, null);
    const { leafIds: _omit, ...rest } = a;
    void _omit;
    assert.equal(selectBranchByPolicy(rest as never, msgs, 'latest_leaf')?.branch.branchId, 'c');
  });

  it('property: for BOTH policies a truncated analysis yields exactly the full analysis\' branch when it was enumerated, else null (never another branch)', () => {
    const stats = { kept: 0, dropped: 0 };
    const specArb = fc.integer({ min: 1, max: 14 }).chain((n) => {
      const arr = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T[]> => fc.array(a, { minLength: n, maxLength: n });
      return fc.record({
        n: fc.constant(n),
        parent: arr(fc.nat(1000)),
        extraRoot: arr(fc.integer({ min: 0, max: 5 })), // 0 => an additional root
        time: arr(fc.integer({ min: -1, max: 4 })), //  -1 => no timestamp; small range => many ties
        ord: arr(fc.integer({ min: 0, max: 2 })),
        rev: arr(fc.boolean()), //                      reverse the declared child order of this node
        k: fc.integer({ min: 1, max: 4 }),
        budget: fc.integer({ min: 1, max: 30 }),
      });
    });
    runProperty(
      fc.property(specArb, (spec) => {
        const msgs = link(
          Array.from({ length: spec.n }, (_, i) =>
            m(`n${i}`, i === 0 || spec.extraRoot[i] === 0 ? null : `n${(spec.parent[i] as number) % i}`, {
              ordinal: spec.ord[i] as number,
              ...((spec.time[i] as number) >= 0 ? { t: spec.time[i] as number } : {}),
            }),
          ),
        );
        msgs.forEach((x, i) => {
          if (spec.rev[i] === true) x.childIds.reverse();
        });
        const full = analyzeTree(C, msgs, null, UNLIMITED);
        for (const cut of [analyzeTree(C, msgs, null, { maxBranches: spec.k }), analyzeTree(C, msgs, null, { maxTotalPathNodes: spec.budget })]) {
          const enumerated = new Set(cut.branches.map((b) => b.branchId));
          for (const policy of POLICIES) {
            const want = selectBranchByPolicy(full, msgs, policy);
            const got = selectBranchByPolicy(cut, msgs, policy);
            const expected = want !== null && enumerated.has(want.branch.branchId) ? want.branch.branchId : null;
            assert.equal(got?.branch.branchId ?? null, expected, `${policy}: full picks ${want?.branch.branchId ?? 'null'}`);
            if (got !== null) assert.deepEqual(got.warning.ids, [got.branch.branchId]);
            if (cut.branches.length < full.branches.length && want !== null) stats[expected === null ? 'dropped' : 'kept']++;
          }
        }
      }),
      1500,
    );
    assert.ok(stats.kept >= 25 && stats.dropped >= 25, `generator reached kept=${stats.kept} dropped=${stats.dropped}`);
  });
});

// ------------------------------------------------------------------------------------------
// DEFECT 2: a CYCLE_DETECTED id list capped at 1000 ids still claimed to be the whole cycle
// ------------------------------------------------------------------------------------------

describe('DEFECT: a truncated CYCLE_DETECTED id list says so', () => {
  function cycle(n: number): MessageRecord[] {
    return Array.from({ length: n }, (_, i) => m(`z${String(i).padStart(5, '0')}`, `z${String((i + n - 1) % n).padStart(5, '0')}`));
  }

  it('a cycle longer than the cap lists the cap, states the true size and the truncation, and no longer claims the list closes on itself', () => {
    const a = analyzeTree(C, cycle(1500), null);
    const w = a.warnings.filter((x) => x.code === 'CYCLE_DETECTED');
    assert.equal(w.length, 1);
    assert.equal(w[0]?.ids?.length, 1000);
    assert.match(w[0]?.message ?? '', /1500 nodes/);
    assert.match(w[0]?.message ?? '', /first 1000/);
    assert.doesNotMatch(w[0]?.message ?? '', /last one's parent is the first/);
  });

  it('regression: a cycle within the cap keeps the full, self-closing description and no truncation note', () => {
    for (const n of [2, 3, 1000]) {
      const w = analyzeTree(C, cycle(n), null).warnings.filter((x) => x.code === 'CYCLE_DETECTED');
      assert.equal(w.length, 1);
      assert.equal(w[0]?.ids?.length, n);
      assert.match(w[0]?.message ?? '', new RegExp(`cycle of ${n} nodes`));
      assert.match(w[0]?.message ?? '', /last one's parent is the first/);
      assert.doesNotMatch(w[0]?.message ?? '', /first 1000/);
    }
  });

  it('the exact cap boundary: 1001 nodes is truncated, 1000 is not', () => {
    assert.match(analyzeTree(C, cycle(1001), null).warnings.find((x) => x.code === 'CYCLE_DETECTED')?.message ?? '', /first 1000/);
    assert.doesNotMatch(analyzeTree(C, cycle(1000), null).warnings.find((x) => x.code === 'CYCLE_DETECTED')?.message ?? '', /first 1000/);
  });
});

// ------------------------------------------------------------------------------------------
// DEFECT 3: duplicate ids that differ only in `conversationId` made the thread depend on the input order
// ------------------------------------------------------------------------------------------

describe('DEFECT: duplicate message ids resolve identically for every input order, whichever scalar field differs', () => {
  /** Alternative values for every scalar field of MessageRecord. A field of the default record without an entry here fails the census. */
  const VARIANTS: Record<string, unknown> = {
    conversationId: 'another-conversation',
    parentId: null,
    childIds: ['phantom'],
    nodeKind: 'structural_empty',
    authorRole: 'assistant',
    authorName: 'someone',
    modelSlug: 'model-x',
    channel: 'final',
    recipient: 'all',
    contentType: 'code',
    status: 'finished_successfully',
    hidden: true,
    createdAt: iso(7),
    updatedAt: iso(8),
    text: 'a different text',
    ordinal: 9,
  };
  /** Opaque payload fields: compared by nobody, cannot change any id-level result, documented limitation of the tie-break. */
  const OPAQUE = new Set(['blocks', 'attachments', 'rawSource']);
  const defaults = msg({ id: 'x', conversationId: C });

  it('the census covers every field of the default MessageRecord (a new field must be added to VARIANTS or OPAQUE)', () => {
    for (const key of Object.keys(defaults)) {
      if (key === 'id' || OPAQUE.has(key)) continue;
      assert.ok(key in VARIANTS, `MessageRecord field "${key}" has no duplicate-id census entry`);
    }
    for (const key of Object.keys(VARIANTS)) assert.ok(key in defaults, `stale census entry "${key}"`);
  });

  for (const [key, value] of Object.entries(VARIANTS)) {
    it(`two records with one id that differ only in ${key}: analysis and complete thread are identical for both array orders`, () => {
      const root = m('r', null, { t: 0, childIds: ['d'] });
      const base = m('d', 'r', { t: 1, ordinal: 3, text: 'same' });
      const other = { ...base, [key]: value } as MessageRecord;
      const fingerprint = (x: MessageRecord): string => JSON.stringify(x);
      const results = [[root, base, other], [root, other, base], [other, base, root], [base, other, root]].map((order) => {
        const a = analyzeTree(C, order, 'd');
        const threads = a.branches.map((b) => threadForBranch(a, order, b.branchId, { includeHidden: true, includeStructural: true }).map(fingerprint));
        return JSON.stringify({ a, threads });
      });
      for (const r of results) assert.equal(r, results[0]);
    });
  }
});

// ------------------------------------------------------------------------------------------
// Regression pins: thread vs counters, and a mid-size hostile-graph invariant fuzz
// ------------------------------------------------------------------------------------------

describe('regression: threadForBranch agrees with the branch counters on hostile graphs', () => {
  it('property: default thread length = visibleMessageCount, includeHidden = messageCount, both switches = path length; duplicates included', () => {
    const nodeArb = fc.record({
      id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      parent: fc.constantFrom<string | null>(null, null, 'a', 'b', 'c', 'd', 'e', 'f', 'ghost'),
      hidden: fc.boolean(),
      structural: fc.boolean(),
      ordinal: fc.integer({ min: 0, max: 2 }),
      time: fc.integer({ min: -1, max: 2 }),
    });
    let branchesChecked = 0;
    runProperty(
      fc.property(fc.array(nodeArb, { minLength: 1, maxLength: 12 }), fc.constantFrom<string | null>(null, 'a', 'c', 'zz'), (specs, current) => {
        const messages = specs.map((s) =>
          m(s.id, s.parent, {
            hidden: s.hidden,
            nodeKind: s.structural ? 'structural_empty' : 'message',
            authorRole: s.structural ? '' : 'user',
            ordinal: s.ordinal,
            ...(s.time >= 0 ? { t: s.time } : {}),
          }),
        );
        const a = analyzeTree(C, messages, current, UNLIMITED);
        for (const b of a.branches) {
          branchesChecked++;
          assert.equal(threadForBranch(a, messages, b.branchId).length, b.visibleMessageCount);
          assert.equal(threadForBranch(a, messages, b.branchId, { includeHidden: true }).length, b.messageCount);
          assert.equal(threadForBranch(a, messages, b.branchId, { includeHidden: true, includeStructural: true }).length, b.path.length);
          assert.deepEqual(threadForBranch(a, messages.slice().reverse(), b.branchId, { includeHidden: true, includeStructural: true }).map((x) => x.id), b.path);
        }
      }),
      1500,
    );
    assert.ok(branchesChecked > 500, `only ${branchesChecked} branches were checked`);
  });
});

describe('regression: mid-size hostile graphs (<= 60 nodes) keep every structural invariant', () => {
  /** Tiny LCG: reproducible without fast-check shrinking, and the failing iteration number is in the message. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  }

  it('3000 random graphs with dangling/self/cyclic parents, wrong or missing child lists, duplicate ids, odd ids and random limits', () => {
    const next = rng(SEED);
    const ri = (n: number): number => Math.floor(next() * n);
    const oddIds = ['__proto__', 'constructor', 'é', '😀', 'x'.repeat(40), ' '];
    let truncated = 0;
    let withCycle = 0;
    for (let iter = 0; iter < 3000; iter++) {
      const n = 1 + ri(60);
      const ids = Array.from({ length: n }, (_, i) => (next() < 0.1 ? `${oddIds[ri(oddIds.length)]}${i}` : `n${i}`));
      const parent = ids.map((id, i) => {
        const r = next();
        if (r < 0.15) return null;
        if (r < 0.2) return `ghost${ri(3)}`;
        if (r < 0.23) return id;
        if (r < 0.3) return ids[ri(n)] as string;
        return i === 0 ? null : (ids[ri(i)] as string);
      });
      const messages = ids.map((id, i) => {
        const actual = ids.filter((other, j) => parent[j] === id && other !== id);
        const r = next();
        const childIds = r < 0.5 ? actual : r < 0.6 ? actual.slice().reverse() : r < 0.7 ? [] : r < 0.8 ? [...actual, ids[ri(n)] as string] : r < 0.9 ? actual.slice(0, -1) : [...actual, 'ghost-kid'];
        return m(id, parent[i] as string | null, {
          childIds,
          ordinal: ri(4),
          hidden: next() < 0.2,
          nodeKind: next() < 0.2 ? 'structural_empty' : 'message',
          ...(next() < 0.8 ? { t: ri(5) } : {}),
        });
      });
      if (next() < 0.3) {
        for (let k = 0; k < 1 + ri(3); k++) {
          const src = messages[ri(messages.length)] as MessageRecord;
          messages.push({ ...src, ordinal: ri(4), hidden: next() < 0.5, text: String(ri(3)), parentId: next() < 0.5 ? src.parentId : next() < 0.5 ? null : (ids[ri(n)] as string) });
        }
      }
      const current = next() < 0.2 ? null : next() < 0.1 ? 'not-a-node' : (ids[ri(n)] as string);
      const opts = [undefined, { maxBranches: 1 + ri(4) }, { maxTotalPathNodes: 1 + ri(12) }, UNLIMITED][ri(4)];
      const where = `iteration ${iter} (seed ${SEED})`;

      const a = analyzeTree(C, messages, current, opts);
      const shuffled = messages.map((x) => ({ x, k: next() })).sort((p, q) => p.k - q.k).map((e) => e.x);
      assert.deepEqual(analyzeTree(C, shuffled, current, opts), a, `shuffle invariance, ${where}`);

      const allIds = new Set(messages.map((x) => x.id));
      const covered = new Set(a.branches.flatMap((b) => b.path));
      const unreachable = new Set(a.unreachableIds);
      const isTruncated = a.warnings.some((w) => w.code === 'BRANCH_LIMIT_EXCEEDED');
      if (isTruncated) truncated++;
      if (a.warnings.some((w) => w.code === 'CYCLE_DETECTED')) withCycle++;
      for (const id of unreachable) assert.ok(allIds.has(id) && !covered.has(id), `unreachable node on a branch or unknown, ${where}`);
      if (!isTruncated) for (const id of allIds) assert.equal(covered.has(id) !== unreachable.has(id), true, `partition of ${id}, ${where}`);
      assert.equal(new Set(a.leafIds).size, a.leafIds.length, where);
      assert.ok(a.branches.length <= a.leafIds.length, where);
      a.branches.forEach((b, i) => {
        assert.equal(b.index, i, where);
        assert.equal(new Set(b.path).size, b.path.length, `path revisits a node, ${where}`);
        assert.equal(b.path[b.path.length - 1], b.leafId, where);
        assert.equal(b.rootId, b.path[0], where);
        let deepest = 0;
        for (let j = 0; j < i; j++) {
          const other = (a.branches[j] as { path: string[] }).path;
          let k = 0;
          while (k < b.path.length && k < other.length && b.path[k] === other[k]) k++;
          deepest = Math.max(deepest, k);
        }
        assert.equal(b.forkNodeId, deepest === 0 ? null : b.path[deepest - 1], `fork of ${b.branchId}, ${where}`);
      });
      for (const b of a.branches.slice(0, 3)) {
        assert.deepEqual(threadForBranch(a, messages, b.branchId, { includeHidden: true, includeStructural: true }).map((x) => x.id), b.path, where);
      }
      assert.ok(a.branches.filter((b) => b.activeness === 'active').length <= 1, where);
      if (a.activeBranchId !== null) {
        assert.ok(a.branches.some((b) => b.branchId === a.activeBranchId && (b.activeness === 'active' || b.activeness === 'contains_current_node')), where);
      }
      for (const policy of POLICIES) selectBranchByPolicy(a, messages, policy);
    }
    assert.ok(truncated >= 100 && withCycle >= 100, `generator reached truncated=${truncated} cycles=${withCycle}`);
  });
});
