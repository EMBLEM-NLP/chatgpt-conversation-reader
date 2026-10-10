/**
 * Property tests for src/domain/branches.ts (fast-check, FIXED seed, printed on failure).
 *
 * Arbitrary parent-pointer graphs (forests, forks, missing parents, self-parents, cycles, inconsistent declared child
 * lists, tied timestamps/ordinals, hidden/structural nodes) are compared against an INDEPENDENT brute-force oracle
 * written differently from the implementation (recursive DFS on <= 22 nodes, quadratic fork search, per-node parent
 * chain walks instead of a linear functional-graph scan).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import type { MessageRecord, TreeAnalysis } from '../../src/domain/types.js';
import { analyzeTree } from '../../src/domain/branches.js';
import { iso, msg } from '../helpers/records.js';

const SEED = 20261012;
const CONV = 'g';
const UNLIMITED = { maxBranches: Infinity, maxTotalPathNodes: Infinity } as const;

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns: number): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

// ---- generator ---------------------------------------------------------------------------------------------------

interface GraphSpec {
  n: number;
  mode: number[];
  pick: number[];
  time: number[];
  ord: number[];
  structural: boolean[];
  hidden: boolean[];
  childMode: number[];
  mask: number[];
  current: number;
  shuffle: number[];
  k: number;
}

const specArb: fc.Arbitrary<GraphSpec> = fc.integer({ min: 1, max: 22 }).chain((n) => {
  const arr = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T[]> => fc.array(a, { minLength: n, maxLength: n });
  return fc.record({
    n: fc.constant(n),
    mode: arr(fc.integer({ min: 0, max: 9 })), // 0 root, 1 missing parent, 2 self, 3 arbitrary node (cycles), 4..9 earlier node (forest)
    pick: arr(fc.nat(10_000)),
    time: arr(fc.integer({ min: -1, max: 3 })), // -1 => null; small range => many ties
    ord: arr(fc.integer({ min: 0, max: 3 })),
    structural: arr(fc.boolean()),
    hidden: arr(fc.boolean()),
    childMode: arr(fc.integer({ min: 0, max: 5 })),
    mask: arr(fc.nat(2 ** 22)),
    current: fc.integer({ min: -2, max: n - 1 }), // -2 => null, -1 => not a node
    shuffle: arr(fc.nat(1000)),
    k: fc.integer({ min: 1, max: 4 }),
  });
});

function buildMessages(spec: GraphSpec): { messages: MessageRecord[]; current: string | null } {
  const ids = Array.from({ length: spec.n }, (_, i) => `n${i}`);
  const parentOf: Array<string | null> = ids.map((id, i) => {
    const mode = spec.mode[i] as number;
    const pick = spec.pick[i] as number;
    if (mode === 0) return null;
    if (mode === 1) return 'ghost';
    if (mode === 2) return id;
    if (mode === 3) return ids[pick % spec.n] as string;
    return i === 0 ? null : (ids[pick % i] as string);
  });
  const messages = ids.map((id, i): MessageRecord => {
    const actual = ids.filter((_, j) => parentOf[j] === id);
    let childIds: string[];
    switch (spec.childMode[i] as number) {
      case 0: childIds = actual; break; //                      consistent
      case 1: childIds = actual.slice().reverse(); break; //     consistent, other order
      case 2: childIds = ids.filter((_, j) => (((spec.mask[i] as number) >> j) & 1) === 1); break; // arbitrary subset
      case 3: childIds = []; break; //                           declares nothing
      case 4: childIds = [...actual, 'ghost-child']; break; //   dangling declared child
      default: childIds = actual.length > 0 ? [...actual, actual[0] as string] : []; break; // repeated declaration
    }
    const t = spec.time[i] as number;
    const structural = spec.structural[i] as boolean;
    return msg({
      id,
      conversationId: CONV,
      parentId: parentOf[i] as string | null,
      childIds,
      nodeKind: structural ? 'structural_empty' : 'message',
      authorRole: structural ? '' : 'user',
      hidden: spec.hidden[i] as boolean,
      createdAt: t < 0 ? null : iso(t),
      ordinal: spec.ord[i] as number,
      text: `SECRET-TEXT-${id}`,
    });
  });
  const current = spec.current === -2 ? null : spec.current === -1 ? 'not-a-node' : (ids[spec.current] as string);
  return { messages, current };
}

function shuffled(spec: GraphSpec, messages: readonly MessageRecord[]): MessageRecord[] {
  return messages
    .map((x, i) => ({ x, key: spec.shuffle[i] as number, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((e) => e.x);
}

// ---- independent oracle ------------------------------------------------------------------------------------------

interface Oracle {
  roots: string[];
  leaves: string[]; //                 reachable leaves, sorted by the total order
  unreachable: string[];
  visitPaths: string[][]; //           root->leaf paths in DFS visit order
  branchPaths: string[][]; //          the same paths sorted by leaf order
  cycles: string[][]; //               sorted id arrays
  selfParents: string[];
  missingParents: string[];
  mismatch: boolean;
  reachable: Set<string>;
  byId: Map<string, MessageRecord>;
}

function buildOracle(messages: readonly MessageRecord[]): Oracle {
  const byId = new Map(messages.map((x) => [x.id, x] as const));
  const ms = (x: MessageRecord): number => (x.createdAt === null ? Infinity : Date.parse(x.createdAt));
  const cmp = (a: MessageRecord, b: MessageRecord): number => {
    const d = ms(a) === ms(b) ? 0 : ms(a) < ms(b) ? -1 : 1;
    if (d !== 0) return d;
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  const isRoot = (x: MessageRecord): boolean => x.parentId === null || !byId.has(x.parentId);
  // Walk up the parent chain; reaching a root means reachable, revisiting a node means a cycle.
  const chainEndsAtRoot = (start: MessageRecord): boolean => {
    const seen = new Set<string>();
    let cur: MessageRecord | undefined = start;
    while (cur !== undefined) {
      if (seen.has(cur.id)) return false;
      seen.add(cur.id);
      if (isRoot(cur)) return true;
      cur = byId.get(cur.parentId as string);
    }
    return false;
  };
  const reachable = new Set(messages.filter(chainEndsAtRoot).map((x) => x.id));
  const sortedAll = messages.slice().sort(cmp);
  const roots = sortedAll.filter(isRoot).map((x) => x.id);
  const actualKids = (p: MessageRecord): MessageRecord[] => sortedAll.filter((x) => x.parentId === p.id && x.id !== p.id);
  const isSelf = (x: MessageRecord): boolean => x.parentId === x.id;
  const declaredOf = (p: MessageRecord): string[] => (isSelf(p) ? p.childIds.filter((d) => d !== p.id) : p.childIds);
  const sameMultiset = (a: string[], b: string[]): boolean => a.slice().sort().join('\u0000') === b.slice().sort().join('\u0000');
  const consistent = (p: MessageRecord): boolean => {
    const declared = declaredOf(p);
    const actual = actualKids(p).map((x) => x.id);
    return declared.length === 0 && actual.length === 0 ? true : sameMultiset(declared, actual);
  };
  const orderedKids = (p: MessageRecord): string[] => (consistent(p) ? declaredOf(p) : actualKids(p).map((x) => x.id));

  const visitPaths: string[][] = [];
  const dfs = (id: string, path: string[]): void => {
    const node = byId.get(id) as MessageRecord;
    const kids = orderedKids(node);
    const here = [...path, id];
    if (kids.length === 0) visitPaths.push(here);
    else for (const k of kids) dfs(k, here);
  };
  for (const r of roots) dfs(r, []);

  const leafOrder = (p: string[]): MessageRecord => byId.get(p[p.length - 1] as string) as MessageRecord;
  const branchPaths = visitPaths.slice().sort((a, b) => cmp(leafOrder(a), leafOrder(b)));
  const leaves = branchPaths.map((p) => p[p.length - 1] as string);
  const unreachable = sortedAll.filter((x) => !reachable.has(x.id)).map((x) => x.id);

  // Cycles by brute force: from every unreachable non-self node, walk until a node repeats.
  const cycleKeys = new Map<string, string[]>();
  for (const u of messages.filter((x) => !reachable.has(x.id) && !isSelf(x))) {
    const walk: string[] = [];
    let cur = u.id;
    while (!walk.includes(cur)) {
      walk.push(cur);
      cur = (byId.get(cur) as MessageRecord).parentId as string;
    }
    const cycle = walk.slice(walk.indexOf(cur));
    if (cycle.length > 1) cycleKeys.set(cycle.slice().sort().join('\u0000'), cycle.slice().sort());
  }

  return {
    roots,
    leaves,
    unreachable,
    visitPaths,
    branchPaths,
    cycles: Array.from(cycleKeys.values()).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    selfParents: messages.filter(isSelf).map((x) => x.id).sort(),
    missingParents: messages.filter((x) => x.parentId !== null && x.parentId !== x.id && !byId.has(x.parentId)).map((x) => x.id).sort(),
    mismatch: messages.some((p) => !consistent(p)),
    reachable,
    byId,
  };
}

// ---- properties --------------------------------------------------------------------------------------------------

describe('analyzeTree properties (arbitrary parent-pointer graphs)', () => {
  const stats = { runs: 0, cycles: 0, selfParent: 0, missing: 0, mismatch: 0, multiBranch: 0, multiRoot: 0, unreachable: 0, truncated: 0, notLeafCurrent: 0, validCurrent: 0 };

  it('always terminates and returns only genuine root->leaf paths; every leaf is in exactly one branch', () => {
    runProperty(
      fc.property(specArb, (spec) => {
        const { messages, current } = buildMessages(spec);
        const a = analyzeTree(CONV, messages, current, UNLIMITED);
        const byId = new Map(messages.map((x) => [x.id, x] as const));
        const seenLeaves = new Set<string>();
        const seenBranchIds = new Set<string>();
        for (const b of a.branches) {
          const first = byId.get(b.path[0] as string) as MessageRecord;
          assert.ok(first.parentId === null || !byId.has(first.parentId), 'a path starts at a root');
          for (let i = 1; i < b.path.length; i++) {
            const child = byId.get(b.path[i] as string) as MessageRecord;
            assert.equal(child.parentId, b.path[i - 1], 'consecutive path nodes are real parent/child pairs');
            assert.notEqual(child.id, child.parentId, 'no self edges in a path');
          }
          assert.equal(new Set(b.path).size, b.path.length, 'a path never revisits a node');
          const leaf = b.path[b.path.length - 1] as string;
          assert.equal(b.branchId, leaf);
          assert.equal(b.leafId, leaf);
          assert.equal(b.rootId, b.path[0]);
          assert.ok(!messages.some((x) => x.parentId === leaf && x.id !== leaf), 'the last node of a branch is a leaf');
          assert.ok(!seenLeaves.has(leaf), 'a leaf appears in exactly one branch');
          seenLeaves.add(leaf);
          seenBranchIds.add(b.branchId);
        }
        assert.equal(seenBranchIds.size, a.branches.length);
        assert.deepEqual(new Set(a.leafIds), seenLeaves, 'every leaf has a branch');
        assert.equal(a.leafIds.length, a.branches.length);
        // Coverage: every reachable node lies on some branch path, every other node is reported unreachable.
        const covered = new Set(a.branches.flatMap((b) => b.path));
        const unreachable = new Set(a.unreachableIds);
        for (const x of messages) assert.equal(covered.has(x.id) !== unreachable.has(x.id), true, `node ${x.id} is either on a branch or unreachable`);
      }),
      1500,
    );
  });

  it('matches an independent brute-force oracle on structure, order, forks, counts, activeness and warnings', () => {
    runProperty(
      fc.property(specArb, (spec) => {
        const { messages, current } = buildMessages(spec);
        const o = buildOracle(messages);
        const a = analyzeTree(CONV, messages, current, UNLIMITED);

        assert.deepEqual(a.rootIds, o.roots);
        assert.deepEqual(a.leafIds, o.leaves);
        assert.deepEqual(a.unreachableIds, o.unreachable);
        assert.deepEqual(a.branches.map((b) => b.path), o.branchPaths);
        assert.deepEqual(a.branches.map((b) => b.index), a.branches.map((_, i) => i));

        // forkNodeId by brute force: deepest node shared with ANY earlier branch (null if none shares a node).
        a.branches.forEach((b, i) => {
          let deepest = 0;
          for (let j = 0; j < i; j++) {
            const other = (a.branches[j] as { path: string[] }).path;
            let k = 0;
            while (k < b.path.length && k < other.length && b.path[k] === other[k]) k++;
            deepest = Math.max(deepest, k);
          }
          assert.equal(b.forkNodeId, deepest === 0 ? null : (b.path[deepest - 1] as string), `fork of ${b.branchId}`);
          const nodes = b.path.map((id) => o.byId.get(id) as MessageRecord);
          assert.equal(b.messageCount, nodes.filter((x) => x.nodeKind !== 'structural_empty').length);
          assert.equal(b.visibleMessageCount, nodes.filter((x) => x.nodeKind !== 'structural_empty' && !x.hidden).length);
        });

        // Active branch.
        const curValid = current !== null && o.byId.has(current) && o.reachable.has(current);
        const containing = a.branches.filter((b) => b.path.includes(current as string));
        a.branches.forEach((b) => {
          const expected = !curValid ? 'unknown' : b.leafId === current ? 'active' : b.path.includes(current as string) ? 'contains_current_node' : 'inactive';
          assert.equal(b.activeness, expected, `activeness of ${b.branchId}`);
        });
        const exact = a.branches.find((b) => b.leafId === current);
        assert.equal(a.activeBranchId, !curValid ? null : (exact ?? containing[0])?.branchId ?? null);

        // Warnings: exact code sequence plus payloads.
        const expectedCodes: string[] = [];
        // Expected order: SELF_PARENT, MISSING_PARENT, CHILD_PARENT_MISMATCH, CYCLE_DETECTED*, current-node warning.
        // (No DUPLICATE_NODE_ID: ids are unique in this generator.)
        if (o.selfParents.length > 0) expectedCodes.push('SELF_PARENT');
        if (o.missingParents.length > 0) expectedCodes.push('MISSING_PARENT');
        if (o.mismatch) expectedCodes.push('CHILD_PARENT_MISMATCH');
        for (let i = 0; i < o.cycles.length; i++) expectedCodes.push('CYCLE_DETECTED');
        if (current === null) expectedCodes.push('NO_CURRENT_NODE');
        else if (!curValid) expectedCodes.push('INVALID_CURRENT_NODE');
        else if (!o.leaves.includes(current) && containing.length > 1) expectedCodes.push('CURRENT_NODE_NOT_LEAF');
        assert.deepEqual(a.warnings.map((w) => w.code), expectedCodes);

        const byCode = (code: string) => a.warnings.filter((w) => w.code === code);
        assert.deepEqual(byCode('SELF_PARENT')[0]?.ids ?? [], o.selfParents);
        assert.deepEqual(byCode('MISSING_PARENT')[0]?.ids ?? [], o.missingParents);
        const cycleWarnings = byCode('CYCLE_DETECTED');
        assert.deepEqual(cycleWarnings.map((w) => (w.ids ?? []).slice().sort()), o.cycles);
        for (const w of cycleWarnings) {
          const c = w.ids as string[];
          assert.equal(c[0], c.slice().sort()[0], 'cycle starts at its smallest id');
          c.forEach((id, i) => assert.equal((o.byId.get(id) as MessageRecord).parentId, c[(i + 1) % c.length], 'each id\'s parent is the next id'));
        }

        // statistics: prove the generator reaches the interesting regions
        stats.runs++;
        stats.cycles += o.cycles.length > 0 ? 1 : 0;
        stats.selfParent += o.selfParents.length > 0 ? 1 : 0;
        stats.missing += o.missingParents.length > 0 ? 1 : 0;
        stats.mismatch += o.mismatch ? 1 : 0;
        stats.multiBranch += a.branches.length > 1 ? 1 : 0;
        stats.multiRoot += a.rootIds.length > 1 ? 1 : 0;
        stats.unreachable += a.unreachableIds.length > 0 ? 1 : 0;
        stats.validCurrent += curValid ? 1 : 0;
        stats.notLeafCurrent += curValid && !o.leaves.includes(current as string) ? 1 : 0;
      }),
      1500,
    );
  });

  it('the generator exercises every anomaly class (guards against a vacuous property)', () => {
    assert.ok(stats.runs >= 1500, `ran ${stats.runs}`);
    for (const [k, v] of Object.entries(stats)) {
      if (k !== 'runs' && k !== 'truncated') assert.ok(v >= 25, `generator reached "${k}" only ${v} times in ${stats.runs} runs`);
    }
  });

  it('shuffling the input array never changes the output (default and truncated options, any current node)', () => {
    runProperty(
      fc.property(specArb, (spec) => {
        const { messages, current } = buildMessages(spec);
        const other = shuffled(spec, messages);
        for (const opts of [undefined, UNLIMITED, { maxBranches: spec.k }, { maxTotalPathNodes: 2 * spec.k }]) {
          assert.deepEqual(analyzeTree(CONV, other, current, opts), analyzeTree(CONV, messages, current, opts));
        }
      }),
      1500,
    );
  });

  it('truncation keeps exactly the first k leaves in visit order and reports the rest', () => {
    runProperty(
      fc.property(specArb, (spec) => {
        const { messages, current } = buildMessages(spec);
        const o = buildOracle(messages);
        const a = analyzeTree(CONV, messages, current, { maxBranches: spec.k });
        const keptLeaves = o.visitPaths.slice(0, spec.k).map((p) => p[p.length - 1] as string);
        assert.deepEqual(a.branches.map((b) => b.leafId).sort(), keptLeaves.slice().sort());
        assert.deepEqual(a.leafIds, o.leaves, 'leafIds stays complete');
        const limit = a.warnings.filter((w) => w.code === 'BRANCH_LIMIT_EXCEEDED');
        if (o.visitPaths.length > spec.k) {
          stats.truncated++;
          assert.equal(limit.length, 1);
          const skipped = o.visitPaths.slice(spec.k).map((p) => p[p.length - 1] as string).sort();
          assert.deepEqual(limit[0]?.ids, skipped);
        } else {
          assert.equal(limit.length, 0);
        }
        // Whatever was kept is sorted by the same total order as the full result.
        const full = analyzeTree(CONV, messages, current, UNLIMITED);
        const order = new Map(full.branches.map((b, i) => [b.branchId, i] as const));
        const kept = a.branches.map((b) => order.get(b.branchId) as number);
        assert.deepEqual(kept, kept.slice().sort((x, y) => x - y));
      }),
      1000,
    );
    assert.ok(stats.truncated >= 25, `truncation reached ${stats.truncated} times`);
  });

  it('warnings never contain message text, only codes, fixed messages and ids', () => {
    runProperty(
      fc.property(specArb, (spec) => {
        const { messages, current } = buildMessages(spec);
        const a: TreeAnalysis = analyzeTree(CONV, messages, current);
        assert.equal(JSON.stringify(a).includes('SECRET'), false);
      }),
      500,
    );
  });
});
