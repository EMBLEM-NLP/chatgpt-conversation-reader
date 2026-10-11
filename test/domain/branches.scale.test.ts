/**
 * Scale and resource-exhaustion tests for src/domain/branches.ts (FR-04, NFR-05): deep chains must not overflow the
 * stack, wide stars must stay fast, and a deep tree with many leaves must not allocate quadratic memory.
 * Synthetic data only. Wall-clock bounds are generous (CI machines vary) but would still catch quadratic behaviour.
 * Each bound is multiplied by how much slower a fixed CPU probe runs right before/after the timed section (`slack`, 1 on an
 * idle machine): test files run in parallel and CI runners are shared, and a fixed 3-4 s bound was observed to fail under
 * load (a 200k-node analysis that takes ~0.7 s idle took 23 s with the CPUs oversubscribed). Quadratic behaviour at these
 * sizes is hundreds of times over budget, so the scaled bound still catches it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MessageRecord } from '../../src/domain/types.js';
import { DEFAULT_MAX_BRANCHES, DEFAULT_MAX_TOTAL_PATH_NODES, analyzeTree, threadForBranch } from '../../src/domain/branches.js';
import { iso, msg } from '../helpers/records.js';

const C = 'big';

function node(id: string, parentId: string | null, ordinal: number, extra: Partial<MessageRecord> = {}): MessageRecord {
  return msg({ id, conversationId: C, parentId, ordinal, ...extra });
}

/** Duration of the CPU probe on an idle development machine (fill + sort 200k floats), in ms. */
const PROBE_IDLE_MS = 15;

/** >= 1; how many times slower than idle this machine currently runs a fixed CPU-bound probe. */
function machineSlowness(): number {
  const t0 = performance.now();
  const a = new Float64Array(200_000);
  let s = 12345;
  for (let i = 0; i < a.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = s;
  }
  a.sort();
  return Math.max(1, (performance.now() - t0) / PROBE_IDLE_MS);
}

function timed<T>(fn: () => T): { value: T; ms: number; slack: number } {
  const before = machineSlowness();
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  return { value, ms, slack: Math.max(before, machineSlowness()) };
}

describe('deep chains', () => {
  it('a 200,000-deep chain is analyzed iteratively (no stack overflow), including input in reverse order', () => {
    const n = 200_000;
    const msgs: MessageRecord[] = [];
    for (let i = 0; i < n; i++) msgs.push(node(`c${i}`, i === 0 ? null : `c${i - 1}`, i, { childIds: i + 1 < n ? [`c${i + 1}`] : [], hidden: i % 1000 === 7 }));
    const { value: a, ms, slack } = timed(() => analyzeTree(C, msgs, `c${n - 1}`));
    assert.ok(ms < 4000 * slack, `analysis took ${ms.toFixed(0)} ms (slack x${slack.toFixed(1)})`);
    assert.equal(a.branches.length, 1);
    const [b] = a.branches;
    assert.ok(b);
    assert.equal(b.path.length, n);
    assert.equal(b.path[0], 'c0');
    assert.equal(b.path[n - 1], `c${n - 1}`);
    assert.equal(b.messageCount, n);
    assert.equal(b.visibleMessageCount, n - Math.ceil((n - 7) / 1000));
    assert.equal(b.activeness, 'active');
    assert.equal(a.activeBranchId, `c${n - 1}`);
    assert.deepEqual(a.warnings, []);
    assert.deepEqual(a.rootIds, ['c0']);
    assert.deepEqual(a.leafIds, [`c${n - 1}`]);

    const reversed = msgs.slice().reverse();
    const r = analyzeTree(C, reversed, `c${n - 1}`);
    assert.equal(r.branches[0]?.path.length, n);
    for (let i = 0; i < n; i += 997) assert.equal(r.branches[0]?.path[i], b.path[i]);

    const thread = threadForBranch(a, reversed, b.branchId);
    assert.equal(thread.length, n - Math.ceil((n - 7) / 1000)); // hidden ones omitted
    assert.equal(thread[0]?.id, 'c0');
  });

  it('a 100,000-node cycle (and a tail below it) terminates, is reported once with a capped id list', () => {
    const n = 100_000;
    const msgs: MessageRecord[] = [];
    for (let i = 0; i < n; i++) msgs.push(node(`z${String(i).padStart(6, '0')}`, `z${String((i + n - 1) % n).padStart(6, '0')}`, i));
    msgs.push(node('tail', 'z000000', n));
    msgs.push(node('root', null, n + 1));
    const { value: a, ms, slack } = timed(() => analyzeTree(C, msgs, null));
    assert.ok(ms < 4000 * slack, `analysis took ${ms.toFixed(0)} ms (slack x${slack.toFixed(1)})`);
    const w = a.warnings.filter((x) => x.code === 'CYCLE_DETECTED');
    assert.equal(w.length, 1);
    assert.equal(w[0]?.ids?.length, 1000);
    assert.equal(w[0]?.ids?.[0], 'z000000');
    assert.equal(a.unreachableIds.length, n + 1);
    assert.deepEqual(a.branches.map((b) => b.branchId), ['root']);
  });
});

describe('wide trees', () => {
  /** root with `leaves` leaf children; createdAt cycles through 1000 minutes so there are many ties. */
  function star(leaves: number): MessageRecord[] {
    const msgs: MessageRecord[] = [node('root', null, 0, { nodeKind: 'structural_empty', authorRole: '', contentType: null, createdAt: iso(0) })];
    const kids: string[] = [];
    for (let i = 0; i < leaves; i++) {
      const id = `l${i}`;
      kids.push(id);
      msgs.push(node(id, 'root', i + 1, { createdAt: iso(1 + (i % 1000)) }));
    }
    (msgs[0] as MessageRecord).childIds = kids;
    return msgs;
  }

  it('a 50,000-leaf star with the DEFAULT limits is truncated to 10,000 branches, fast, with a warning and a complete leafIds', () => {
    const msgs = star(50_000);
    const { value: a, ms, slack } = timed(() => analyzeTree(C, msgs, null));
    assert.ok(ms < 3000 * slack, `analysis took ${ms.toFixed(0)} ms (slack x${slack.toFixed(1)})`);
    assert.equal(a.branches.length, DEFAULT_MAX_BRANCHES);
    assert.equal(a.leafIds.length, 50_000);
    const w = a.warnings.filter((x) => x.code === 'BRANCH_LIMIT_EXCEEDED');
    assert.equal(w.length, 1);
    assert.equal(w[0]?.ids?.length, 1000, 'skipped-leaf list is capped');
    assert.match(w[0]?.message ?? '', /40000 ids/);
    // the 10,000 kept leaves are the first 10,000 in declared order
    const kept = new Set(a.branches.map((b) => b.leafId));
    for (let i = 0; i < DEFAULT_MAX_BRANCHES; i++) assert.ok(kept.has(`l${i}`));
    assert.ok(!kept.has(`l${DEFAULT_MAX_BRANCHES}`));
  });

  it('the same star with maxBranches raised returns all 50,000 branches, totally ordered, fork = root', () => {
    const msgs = star(50_000);
    const { value: a, ms, slack } = timed(() => analyzeTree(C, msgs, 'l49999', { maxBranches: 100_000 }));
    assert.ok(ms < 3000 * slack, `analysis took ${ms.toFixed(0)} ms (slack x${slack.toFixed(1)})`);
    assert.equal(a.branches.length, 50_000);
    assert.deepEqual(a.warnings, []);
    const ord = (id: string): number => Number(id.slice(1)) + 1;
    for (let i = 1; i < a.branches.length; i++) {
      const p = a.branches[i - 1] as { leafId: string };
      const q = a.branches[i] as { leafId: string; index: number; forkNodeId: string | null };
      const tp = ord(p.leafId) - 1;
      const tq = ord(q.leafId) - 1;
      const kp = tp % 1000;
      const kq = tq % 1000;
      assert.ok(kp < kq || (kp === kq && ord(p.leafId) < ord(q.leafId)), `order broken at ${i}`);
      assert.equal(q.index, i);
      assert.equal(q.forkNodeId, 'root');
    }
    assert.equal(a.branches[0]?.forkNodeId, null);
    assert.equal(a.activeBranchId, 'l49999');
    assert.equal(a.branches.filter((b) => b.activeness === 'active').length, 1);
    const rev = analyzeTree(C, msgs.slice().reverse(), 'l49999', { maxBranches: 100_000 });
    assert.deepEqual(rev.branches.map((b) => b.branchId), a.branches.map((b) => b.branchId));
  });

  it('100,000 orphans (missing parents) become 100,000 roots; the warning id list stays capped', () => {
    const msgs: MessageRecord[] = [];
    for (let i = 0; i < 100_000; i++) msgs.push(node(`o${i}`, `gone${i}`, i));
    const { value: a, ms, slack } = timed(() => analyzeTree(C, msgs, null));
    assert.ok(ms < 4000 * slack, `analysis took ${ms.toFixed(0)} ms (slack x${slack.toFixed(1)})`);
    assert.equal(a.rootIds.length, 100_000);
    assert.equal(a.branches.length, DEFAULT_MAX_BRANCHES);
    assert.equal(a.warnings.find((w) => w.code === 'MISSING_PARENT')?.ids?.length, 1000);
  });
});

describe('quadratic-memory attack: deep tree with many leaves', () => {
  /** chain k0 -> k1 -> ... ; every chain node also has a leaf child. Sum of all root->leaf path lengths ~ D^2/2. */
  function comb(depth: number, leafFirst: boolean): MessageRecord[] {
    const msgs: MessageRecord[] = [];
    let ord = 0;
    for (let i = 0; i < depth; i++) {
      const kids = leafFirst ? [`leaf${i}`, `k${i + 1}`] : [`k${i + 1}`, `leaf${i}`];
      msgs.push(node(`k${i}`, i === 0 ? null : `k${i - 1}`, ord++, { childIds: i + 1 < depth ? kids : [`leaf${i}`] }));
      msgs.push(node(`leaf${i}`, `k${i}`, ord++));
    }
    return msgs;
  }

  for (const leafFirst of [true, false]) {
    it(`20,000-deep comb (${leafFirst ? 'leaf' : 'chain'} child declared first) is cut by maxTotalPathNodes, fast, with bounded memory`, () => {
      const depth = 20_000; // untruncated: ~2*10^8 path entries (~1.6 GB of references)
      const msgs = comb(depth, leafFirst);
      const { value: a, ms, slack } = timed(() => analyzeTree(C, msgs, null));
      assert.ok(ms < 4000 * slack, `analysis took ${ms.toFixed(0)} ms (slack x${slack.toFixed(1)})`);
      const total = a.branches.reduce((sum, b) => sum + b.path.length, 0);
      assert.ok(total <= DEFAULT_MAX_TOTAL_PATH_NODES, `stored ${total} path entries`);
      assert.ok(a.branches.length < depth);
      assert.equal(a.leafIds.length, depth);
      const w = a.warnings.find((x) => x.code === 'BRANCH_LIMIT_EXCEEDED');
      assert.ok(w);
      assert.match(w.message, /maxTotalPathNodes/);
    });
  }

  it('the same comb is returned in full when the caller explicitly lifts the limit (small depth)', () => {
    const a = analyzeTree(C, comb(300, true), null, { maxTotalPathNodes: Infinity, maxBranches: Infinity });
    assert.equal(a.branches.length, 300);
    assert.deepEqual(a.warnings.map((w) => w.code), ['NO_CURRENT_NODE']);
  });
});
