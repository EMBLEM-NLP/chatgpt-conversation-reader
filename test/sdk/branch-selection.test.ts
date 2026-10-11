/**
 * The active-branch rules of get() and thread() (ADR-0009: the active branch is never guessed). The precedence table:
 *
 *   1. explicit `branch` id                         -> explicit_branch       (BRANCH_NOT_FOUND if unknown)
 *   2. the source's current_node                    -> source_current_node   (non-leaf: root -> that node + CURRENT_NODE_NOT_LEAF)
 *   3. exactly one branch in the tree               -> only_branch
 *   4. opts.branchPolicy last_child | latest_leaf   -> that policy, always with ACTIVE_BRANCH_HEURISTIC
 *   5. otherwise                                    -> ACTIVE_BRANCH_UNKNOWN (details.branchCount, remedy)
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, OMIT, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { BranchedIds } from './sdk.helpers.test.js';
import { ID, assertCode, assertEnvelopeShape, branched, chat, expectGcr, fixedClock, importBuilders, makeTempDir, removeDir, thrown, title, warningCodes } from './sdk.helpers.test.js';

interface World {
  dir: string;
  gcr: Gcr;
  /** current = a2b (a leaf) */
  leaf: BranchedIds;
  /** no current_node at all */
  none: BranchedIds;
  /** current_node = a1, an inner node with three branches through it */
  inner: BranchedIds;
  /** current_node names a node that does not exist */
  ghost: BranchedIds;
  /** current_node = null (explicit) */
  explicitNull: BranchedIds;
}

const IDS = { leaf: syntheticUuid(0x21), none: syntheticUuid(0x22), inner: syntheticUuid(0x23), ghost: syntheticUuid(0x24), explicitNull: syntheticUuid(0x25), single: syntheticUuid(0x26), singleCur: syntheticUuid(0x27), noStamps: syntheticUuid(0x28), empty: syntheticUuid(0x29) };

describe('branch selection precedence', () => {
  let w: World;
  before(async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    const leaf = branched(IDS.leaf, 'leaf pointer', { current: 'a2b' });
    const none = branched(IDS.none, 'no pointer', { current: OMIT });
    const inner = branched(IDS.inner, 'inner pointer', { current: 'a1' });
    const ghost = branched(IDS.ghost, 'ghost pointer', { current: 'a2b' });
    ghost.builder.setCurrent('no-such-node-anywhere');
    const explicitNull = branched(IDS.explicitNull, 'null pointer', { current: null });
    const single = chat(IDS.single, 'single no pointer', [['alone', 'single answer']], { current: OMIT });
    const singleCur = chat(IDS.singleCur, 'single with pointer', [['alone', 'single answer']]);
    await importBuilders(gcr, dir, [leaf.builder, none.builder, inner.builder, ghost.builder, explicitNull.builder, single, singleCur, noTimestamps()]);
    w = { dir, gcr, leaf, none, inner, ghost, explicitNull };
  });
  after(async () => {
    w.gcr.close();
    await removeDir(w.dir);
  });

  const id = (name: keyof typeof IDS): string => IDS[name];
  const texts = (ref: string, opts: Record<string, unknown> = {}): string[] => w.gcr.thread(ref, opts).data.messages.map((m) => m.text);

  describe('1. explicit branch id wins over everything', () => {
    it('names any branch, whatever the source says about the active one', () => {
      for (const world of ['leaf', 'none', 'inner', 'ghost'] as const) {
        const ids = w[world];
        const env = w.gcr.thread(id(world), { branch: ids.a2 });
        assert.equal(env.data.branchId, ids.a2, world);
        assert.equal(env.data.selectionPolicy, 'explicit_branch', world);
        assert.equal(env.data.messages.at(-1)?.text, 'answer two original');
        assert.deepEqual(env.warnings.filter((x) => x.code === 'ACTIVE_BRANCH_HEURISTIC'), []);
      }
    });

    it('beats a branchPolicy given at the same time (no heuristic is run, no heuristic warning)', () => {
      const env = w.gcr.thread(id('none'), { branch: w.none.a1e, branchPolicy: 'latest_leaf' });
      assert.equal(env.data.branchId, w.none.a1e);
      assert.equal(env.data.selectionPolicy, 'explicit_branch');
      assert.ok(!warningCodes(env).includes('ACTIVE_BRANCH_HEURISTIC'));
    });

    it('an inactive branch reports its activeness truthfully', () => {
      assert.equal(w.gcr.thread(id('leaf'), { branch: w.leaf.a2 }).data.activeness, 'inactive');
      assert.equal(w.gcr.thread(id('leaf'), { branch: w.leaf.a2b }).data.activeness, 'active');
      assert.equal(w.gcr.thread(id('none'), { branch: w.none.a2 }).data.activeness, 'unknown');
    });

    it('an unknown branch id is BRANCH_NOT_FOUND with the branch count and a remedy; an inner message id is not a branch either', () => {
      const e = expectGcr(thrown(() => w.gcr.thread(id('leaf'), { branch: 'no-such-branch' })), 'BRANCH_NOT_FOUND');
      assert.equal(e.details?.['branchCount'], 3);
      assert.equal(e.details?.['reason'], 'unknown_branch');
      assert.match(e.remedy ?? '', /gcr branches/);
      // a1 is a message but not a leaf: branch ids are leaf ids
      assertCode(() => w.gcr.thread(id('leaf'), { branch: w.leaf.a1 }), 'BRANCH_NOT_FOUND');
      assertCode(() => w.gcr.get(id('leaf'), { branch: 'no-such-branch' }), 'BRANCH_NOT_FOUND');
      assertCode(() => w.gcr.get(id('leaf'), { branch: 'no-such-branch', allBranches: true }), 'BRANCH_NOT_FOUND');
    });
  });

  describe('2. the source current_node', () => {
    it('a leaf current_node selects its branch (activeness "active", no warning)', () => {
      const env = w.gcr.thread(id('leaf'));
      assert.equal(env.data.branchId, w.leaf.a2b);
      assert.equal(env.data.selectionPolicy, 'source_current_node');
      assert.equal(env.data.activeness, 'active');
      assert.deepEqual(texts(id('leaf')), ['first prompt about quokka', 'first answer about quokka', 'follow up question', 'answer two regenerated']);
      assert.deepEqual(env.warnings, []);
      assert.equal(env.completeness, 'exported_tree');
    });

    it('wins over branchPolicy: the heuristic is not consulted and not reported', () => {
      for (const policy of ['last_child', 'latest_leaf'] as const) {
        const env = w.gcr.thread(id('leaf'), { branchPolicy: policy });
        assert.equal(env.data.branchId, w.leaf.a2b);
        assert.equal(env.data.selectionPolicy, 'source_current_node');
        assert.ok(!warningCodes(env).includes('ACTIVE_BRANCH_HEURISTIC'));
      }
    });

    it('a NON-LEAF current_node ends the thread AT that node and warns CURRENT_NODE_NOT_LEAF', () => {
      const env = w.gcr.thread(id('inner'));
      assert.equal(env.data.selectionPolicy, 'source_current_node');
      assert.equal(env.data.activeness, 'contains_current_node');
      assert.deepEqual(texts(id('inner')), ['first prompt about quokka', 'first answer about quokka'], 'root -> current node, nothing after it');
      assert.equal(env.data.messages.at(-1)?.id, w.inner.a1);
      const warn = env.warnings.find((x) => x.code === 'CURRENT_NODE_NOT_LEAF');
      assert.ok(warn);
      assert.deepEqual(warn.ids?.[0], w.inner.a1, 'the warning cites the current node');
      assert.equal(warn.ids?.[1], env.data.branchId, 'and the branch id reported');
      assert.equal(env.warnings.filter((x) => x.code === 'CURRENT_NODE_NOT_LEAF').length, 1, 'one warning, not one per layer');
      // branchId is a REAL branch (the first one through the node, in branch order), so it can be passed back as --branch
      const first = w.gcr.branches(id('inner')).data.branches.find((b) => b.activeness === 'contains_current_node');
      assert.equal(env.data.branchId, first?.branchId);
      const through = w.gcr.branches(id('inner')).data.branches.filter((b) => b.activeness === 'contains_current_node');
      assert.equal(through.length, 2, 'a2 and a2b pass through a1; the edited-prompt branch does not');
      assert.match(warn.message, /2 branch\(es\)/);
    });

    it('a non-leaf current_node also wins over a branchPolicy', () => {
      const env = w.gcr.thread(id('inner'), { branchPolicy: 'latest_leaf' });
      assert.equal(env.data.selectionPolicy, 'source_current_node');
      assert.ok(!warningCodes(env).includes('ACTIVE_BRANCH_HEURISTIC'));
    });

    it('get() applies the same rule', () => {
      const env = w.gcr.get(id('inner'));
      assert.equal(env.data.thread?.messages.length, 2);
      assert.equal(env.data.thread?.selectionPolicy, 'source_current_node');
      assert.ok(warningCodes(env).includes('CURRENT_NODE_NOT_LEAF'));
    });
  });

  describe('3. exactly one branch', () => {
    it('is selected as "only_branch" without a heuristic warning, even with no current_node', () => {
      const env = w.gcr.thread(id('single'));
      assert.equal(env.data.selectionPolicy, 'only_branch');
      assert.equal(env.data.messages.length, 2);
      assert.ok(!warningCodes(env).includes('ACTIVE_BRANCH_HEURISTIC'));
      assert.ok(warningCodes(env).includes('NO_CURRENT_NODE'), 'the missing pointer is still reported');
      assert.equal(env.data.activeness, 'unknown', 'only_branch does not claim the branch is the active one');
    });

    it('a source current_node still takes precedence over only_branch', () => {
      assert.equal(w.gcr.thread(id('singleCur')).data.selectionPolicy, 'source_current_node');
    });

    it('does not apply when there are several branches', () => {
      assertCode(() => w.gcr.thread(id('none')), 'ACTIVE_BRANCH_UNKNOWN');
    });
  });

  describe('4. opt-in heuristics (always labelled)', () => {
    it('last_child follows the last child from the first root; latest_leaf takes the newest leaf: they differ here on purpose', () => {
      const lc = w.gcr.thread(id('none'), { branchPolicy: 'last_child' });
      const ll = w.gcr.thread(id('none'), { branchPolicy: 'latest_leaf' });
      assert.equal(lc.data.branchId, w.none.a1e, 'the root\'s last child is the edited prompt');
      assert.equal(ll.data.branchId, w.none.a2b, 'the regenerated answer has the newest timestamp');
      assert.equal(lc.data.selectionPolicy, 'last_child');
      assert.equal(ll.data.selectionPolicy, 'latest_leaf');
    });

    for (const policy of ['last_child', 'latest_leaf'] as const) {
      it(`${policy}: ACTIVE_BRANCH_HEURISTIC is on the thread AND on the envelope, names the branch and the policy`, () => {
        const env = w.gcr.thread(id('none'), { branchPolicy: policy });
        const onThread = env.data.warnings.find((x) => x.code === 'ACTIVE_BRANCH_HEURISTIC');
        const onEnvelope = env.warnings.find((x) => x.code === 'ACTIVE_BRANCH_HEURISTIC');
        assert.ok(onThread && onEnvelope);
        assert.match(onThread.message, new RegExp(policy));
        assert.deepEqual(onThread.ids, [env.data.branchId]);
        assert.equal(env.data.activeness, 'unknown', 'the heuristic does not make the branch "active"');
        // get() reports it identically
        const viaGet = w.gcr.get(id('none'), { branchPolicy: policy });
        assert.equal(viaGet.data.thread?.selectionPolicy, policy);
        assert.ok(warningCodes(viaGet).includes('ACTIVE_BRANCH_HEURISTIC'));
      });
    }

    it('is also used when the source pointer is INVALID (names a node that does not exist) or explicitly null', () => {
      for (const world of ['ghost', 'explicitNull'] as const) {
        const env = w.gcr.thread(id(world), { branchPolicy: 'latest_leaf' });
        assert.equal(env.data.selectionPolicy, 'latest_leaf', world);
        assert.ok(warningCodes(env).includes('ACTIVE_BRANCH_HEURISTIC'), world);
      }
      const bad = w.gcr.thread(id('ghost'), { branchPolicy: 'latest_leaf' });
      assert.ok(warningCodes(bad).includes('INVALID_CURRENT_NODE'));
    });

    it('latest_leaf cannot choose when no leaf has a timestamp: ACTIVE_BRANCH_UNKNOWN (reason heuristic_unavailable), nothing is guessed', () => {
      const e = expectGcr(thrown(() => w.gcr.thread(syntheticUuid(0x28), { branchPolicy: 'latest_leaf' })), 'ACTIVE_BRANCH_UNKNOWN');
      assert.equal(e.details?.['reason'], 'heuristic_unavailable');
      assert.equal(e.details?.['branchPolicy'], 'latest_leaf');
      assert.equal(e.details?.['branchCount'], 2);
      // last_child needs no timestamps
      assert.equal(w.gcr.thread(syntheticUuid(0x28), { branchPolicy: 'last_child' }).data.selectionPolicy, 'last_child');
    });

    it('an unknown policy name is INVALID_ARGUMENT', () => {
      assertCode(() => w.gcr.thread(id('none'), { branchPolicy: 'newest' as never }), 'INVALID_ARGUMENT');
    });
  });

  describe('5. otherwise ACTIVE_BRANCH_UNKNOWN', () => {
    for (const world of ['none', 'ghost', 'explicitNull'] as const) {
      it(`${world}: thread() and get() throw with the branch count, the branch ids and an actionable remedy`, () => {
        for (const call of [() => w.gcr.thread(id(world)), () => w.gcr.get(id(world))]) {
          const e = expectGcr(thrown(call), 'ACTIVE_BRANCH_UNKNOWN');
          assert.equal(e.details?.['branchCount'], 3);
          assert.equal((e.details?.['branchIds'] as string[]).length, 3);
          assert.equal(e.details?.['conversationId'], id(world));
          const remedy = e.remedy ?? '';
          assert.match(remedy, /--branch <id>/);
          assert.match(remedy, /gcr branches/);
          assert.match(remedy, /--branch-policy last_child\|latest_leaf/);
          assert.match(remedy, /heuristic/);
          assert.equal(e.exitCode, 3);
        }
      });
    }

    it('the listed branch ids are exactly the ones branches() lists, so the remedy is actionable', () => {
      const e = expectGcr(thrown(() => w.gcr.thread(id('none'))), 'ACTIVE_BRANCH_UNKNOWN');
      const listed = w.gcr.branches(id('none')).data.branches.map((b) => b.branchId);
      assert.deepEqual(e.details?.['branchIds'], listed);
      // and each of them can be passed back
      for (const b of listed) assert.equal(w.gcr.thread(id('none'), { branch: b }).data.branchId, b);
    });

    it('an invalid pointer is reported as such by branches() (INVALID_CURRENT_NODE) and no branch is marked active', () => {
      const env = w.gcr.branches(id('ghost'));
      assert.equal(env.data.activeBranchId, null);
      assert.ok(warningCodes(env).includes('INVALID_CURRENT_NODE'));
      assert.ok(env.data.branches.every((b) => b.activeness === 'unknown'));
    });
  });

  describe('allBranches', () => {
    it('returns one ThreadResult per branch in branch order; the primary thread follows the precedence rules', () => {
      const env = w.gcr.get(id('leaf'), { allBranches: true });
      assertEnvelopeShape(env);
      const branches = w.gcr.branches(id('leaf')).data.branches;
      assert.deepEqual(env.data.threads?.map((t) => t.branchId), branches.map((b) => b.branchId));
      assert.equal(env.data.thread?.branchId, w.leaf.a2b);
      assert.equal(env.data.thread?.selectionPolicy, 'source_current_node');
      assert.ok(env.data.threads?.every((t) => t.selectionPolicy === 'explicit_branch'));
      for (const [i, t] of (env.data.threads ?? []).entries()) {
        assert.equal(t.activeness, branches[i]?.activeness);
        assert.equal(t.messages.at(-1)?.id, branches[i]?.leafId);
      }
      // each entry equals the thread() answer for that branch
      for (const t of env.data.threads ?? []) assert.deepEqual(t.messages, w.gcr.thread(id('leaf'), { branch: t.branchId }).data.messages);
    });

    it('without a source pointer the primary thread is null (nothing guessed) and a warning says why; no throw', () => {
      const env = w.gcr.get(id('none'), { allBranches: true });
      assert.equal(env.data.thread, null);
      assert.equal(env.data.threads?.length, 3);
      assert.ok(warningCodes(env).includes('ACTIVE_BRANCH_UNKNOWN'));
      assert.ok(env.data.threads?.every((t) => t.activeness === 'unknown'));
    });

    it('with a policy the primary thread is the labelled heuristic one and all branches are still listed', () => {
      const env = w.gcr.get(id('none'), { allBranches: true, branchPolicy: 'latest_leaf' });
      assert.equal(env.data.thread?.selectionPolicy, 'latest_leaf');
      assert.equal(env.data.thread?.branchId, w.none.a2b);
      assert.equal(env.data.threads?.length, 3);
      assert.ok(warningCodes(env).includes('ACTIVE_BRANCH_HEURISTIC'));
    });

    it('with an explicit branch it is the primary thread', () => {
      const env = w.gcr.get(id('none'), { allBranches: true, branch: w.none.a2 });
      assert.equal(env.data.thread?.branchId, w.none.a2);
      assert.equal(env.data.threads?.length, 3);
    });

    it('a single-branch conversation lists one thread, equal to the primary', () => {
      const env = w.gcr.get(id('single'), { allBranches: true });
      assert.equal(env.data.threads?.length, 1);
      assert.deepEqual(env.data.threads?.[0]?.messages, env.data.thread?.messages);
    });

    it('envelope ids cover every branch and message shown', () => {
      const env = w.gcr.get(id('leaf'), { allBranches: true });
      assert.deepEqual(new Set(env.ids.branchIds), new Set(env.data.threads?.map((t) => t.branchId)));
      assert.ok((env.ids.messageIds?.length ?? 0) >= 7);
    });
  });

  describe('a snapshot with no messages', () => {
    it('get() returns the conversation with thread null and NO_BRANCHES; thread() and an explicit branch say BRANCH_NOT_FOUND', async () => {
      const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
      const dir = await makeTempDir();
      try {
        const empty = new ConversationBuilder({ id: IDS.empty, title: title('nothing here') });
        empty.setCurrent(OMIT);
        await importBuilders(gcr, dir, [empty]);
        const env = gcr.get(IDS.empty);
        assert.equal(env.data.thread, null);
        assert.equal(env.data.conversation.messageCount, 0);
        assert.ok(warningCodes(env).includes('NO_BRANCHES'));
        assert.deepEqual(gcr.branches(IDS.empty).data.branches, []);
        const e = expectGcr(thrown(() => gcr.thread(IDS.empty)), 'BRANCH_NOT_FOUND');
        assert.equal(e.details?.['reason'], 'no_branches');
        assertCode(() => gcr.get(IDS.empty, { branch: 'x' }), 'BRANCH_NOT_FOUND');
        assert.equal(gcr.get(IDS.empty, { allBranches: true }).data.threads?.length, 0);
      } finally {
        gcr.close();
        await removeDir(dir);
      }
    });
  });

  describe('children-absent exports', () => {
    it('select exactly like exports that declare children', async () => {
      const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
      const dir = await makeTempDir();
      try {
        const declared = branched(syntheticUuid(0x31), 'declared children', { current: 'a2b' });
        const derived = branched(syntheticUuid(0x32), 'derived children', { current: 'a2b', omitChildren: true });
        const derivedNone = branched(syntheticUuid(0x33), 'derived no pointer', { current: OMIT, omitChildren: true });
        await importBuilders(gcr, dir, [declared.builder, derived.builder, derivedNone.builder]);
        const a = gcr.thread(syntheticUuid(0x31));
        const b = gcr.thread(syntheticUuid(0x32));
        assert.deepEqual(b.data.messages.map((m) => m.id), a.data.messages.map((m) => m.id));
        assert.equal(b.data.selectionPolicy, 'source_current_node');
        assert.ok(warningCodes(b).includes('CHILDREN_ABSENT'));
        assert.ok(!warningCodes(a).includes('CHILDREN_ABSENT'));
        // the heuristics work on the derived children too, and agree with the declared-children answers
        assert.equal(gcr.thread(syntheticUuid(0x33), { branchPolicy: 'last_child' }).data.branchId, derivedNone.a1e);
        assert.equal(gcr.thread(syntheticUuid(0x33), { branchPolicy: 'latest_leaf' }).data.branchId, derivedNone.a2b);
        assertCode(() => gcr.thread(syntheticUuid(0x33)), 'ACTIVE_BRANCH_UNKNOWN');
      } finally {
        gcr.close();
        await removeDir(dir);
      }
    });
  });

  it('the standard fixture ids are not reused by this world (guards the test data)', () => {
    for (const v of Object.values(IDS)) assert.ok(!Object.values(ID).includes(v as never));
  });
});

/** Two branches whose messages carry NO timestamps: latest_leaf has nothing to compare. */
function noTimestamps(): ConversationBuilder {
  const b = new ConversationBuilder({ id: IDS.noStamps, title: title('no timestamps') });
  const root = b.root();
  const u = b.user(root, 'question without a time', { createTime: null });
  b.assistant(u, 'first answer', { createTime: null });
  b.assistant(u, 'second answer', { createTime: null });
  b.setCurrent(OMIT);
  return b;
}
