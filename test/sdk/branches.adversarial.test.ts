/**
 * Adversarial review of "no guessed active branch": when the source DOES name the current node but the tree has more
 * branches than the enumeration limit, the active branch is known yet cannot be listed. The facade must say exactly that,
 * and must not let an opt-in heuristic overrule the source's own pointer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConversationBuilder, OMIT } from '../helpers/chatgpt-export-builder.js';
import { ID, assertCode, emptyDb, expectGcr, importBuilders, thrown, title, warningCodes } from './sdk.helpers.test.js';

/** root -> prompt -> N sibling answers. More leaves than the analysis enumerates (10 000); the LAST answer is the current node. */
function manyLeaves(current: 'last' | typeof OMIT): { builder: ConversationBuilder; lastLeaf: string } {
  const b = new ConversationBuilder({ id: ID.branched, title: title('more leaves than branches can be enumerated') });
  const root = b.root();
  const prompt = b.user(root, 'one prompt, very many regenerated answers');
  const first = b.assistant(prompt, 'answer 0', { model: 'synthetic-model-1' });
  let last = first;
  for (let i = 1; i < 10_005; i++) last = b.regenerate(first, `answer ${i}`, { model: 'synthetic-model-1' });
  if (current === OMIT) b.setCurrent(OMIT);
  else b.setCurrent(last);
  return { builder: b, lastLeaf: last };
}

describe('current_node known, branch not enumerated (BRANCH_LIMIT_EXCEEDED)', () => {
  it('get/thread refuse with an accurate ACTIVE_BRANCH_UNKNOWN: the pointer exists, the branch is beyond the limit; no heuristic may overrule it', async () => {
    const t = await emptyDb();
    try {
      const { builder } = manyLeaves('last');
      await importBuilders(t.gcr, t.dir, [builder]);
      const listing = t.gcr.branches(ID.branched);
      assert.ok(warningCodes(listing).includes('BRANCH_LIMIT_EXCEEDED'), 'the fixture really exceeds the enumeration limit');
      assert.equal(listing.data.activeBranchId, null);

      for (const opts of [{}, { branchPolicy: 'last_child' as const }, { branchPolicy: 'latest_leaf' as const }]) {
        const e = expectGcr(thrown(() => t.gcr.get(ID.branched, opts)), 'ACTIVE_BRANCH_UNKNOWN');
        assert.equal(e.details?.['reason'], 'active_branch_not_enumerated', JSON.stringify(opts));
        assert.ok(!/no valid current_node/i.test(e.message), 'the source DID give a valid current_node; the message must not claim otherwise');
        assert.match(e.message, /current_node/);
        assert.match(e.message, /limit|enumerat/i);
        assert.equal(typeof e.details?.['branchCount'], 'number');
        const again = expectGcr(thrown(() => t.gcr.thread(ID.branched, opts)), 'ACTIVE_BRANCH_UNKNOWN');
        assert.equal(again.details?.['reason'], 'active_branch_not_enumerated');
      }
    } finally {
      await t.cleanup();
    }
  });

  it('allBranches: thread stays null, with a warning that tells the same truth; an enumerated branch can still be chosen explicitly', async () => {
    const t = await emptyDb();
    try {
      const { builder } = manyLeaves('last');
      await importBuilders(t.gcr, t.dir, [builder]);
      const env = t.gcr.get(ID.branched, { allBranches: true, branchPolicy: 'latest_leaf' });
      assert.equal(env.data.thread, null, 'a heuristic must not produce a thread when the source named the active node');
      assert.equal(env.data.threads?.length, 10_000);
      const w = env.warnings.find((x) => x.code === 'ACTIVE_BRANCH_UNKNOWN');
      assert.ok(w);
      assert.ok(!/did not identify the active branch/i.test(w.message), 'the source did identify it');
      assert.match(w.message, /current_node/);
      assert.ok(!warningCodes(env).includes('ACTIVE_BRANCH_HEURISTIC'));

      const someBranch = env.data.threads?.[0]?.branchId;
      assert.ok(someBranch);
      const explicit = t.gcr.thread(ID.branched, { branch: someBranch });
      assert.equal(explicit.data.selectionPolicy, 'explicit_branch');
    } finally {
      await t.cleanup();
    }
  });

  it('control: without any current_node the same tree is the ordinary "source did not identify it" case, and says so', async () => {
    const t = await emptyDb();
    try {
      const { builder } = manyLeaves(OMIT);
      await importBuilders(t.gcr, t.dir, [builder]);
      const e = assertCode(() => t.gcr.get(ID.branched), 'ACTIVE_BRANCH_UNKNOWN');
      assert.match(e.message, /did not identify the active branch/i);
      assert.notEqual(e.details?.['reason'], 'active_branch_not_enumerated');
    } finally {
      await t.cleanup();
    }
  });
});
