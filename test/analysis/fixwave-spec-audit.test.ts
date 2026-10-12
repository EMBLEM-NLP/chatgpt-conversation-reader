/**
 * SPEC-07 regression tests (low): `gcr audit --missing-model --empty --untitled` (the literal SPEC form) returned
 * branchProvenance as {0, 0, 0, 0}: real-looking zeros ("no conversation has a known active branch") with only a warning to say
 * they were never measured. A script that reads the field and ignores warnings would draw the wrong conclusion.
 *
 * Fixed: branchProvenance is `null` when no tree-based check (tree_integrity, no_current_node, timestamps) was selected; the
 * BRANCH_PROVENANCE_NOT_COMPUTED warning stays. modelProvenance does NOT have the problem (it is always measured, in a pass of
 * its own over the assistant messages) and is asserted to stay an object. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIT_CHECKS, runAudit } from '../../src/analysis/audit.js';
import type { AuditCheck } from '../../src/analysis/audit.js';
import { branchedConversation } from '../helpers/records.js';
import { chat, fresh, importAll, star } from './support.test.js';

const TREE_CHECKS: readonly AuditCheck[] = ['tree_integrity', 'no_current_node', 'timestamps'];
const NON_TREE_CHECKS: readonly AuditCheck[] = AUDIT_CHECKS.filter((c) => !TREE_CHECKS.includes(c));

describe('SPEC-07: branchProvenance is null when no tree-based check was selected', () => {
  it('the SPEC form (--missing-model --empty --untitled): null plus BRANCH_PROVENANCE_NOT_COMPUTED, never zeros', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [branchedConversation('br'), chat('nocur', [{}, {}], { currentNodeId: null }), star('star', 5)]);
    const r = runAudit(db, { checks: ['missing_model', 'empty', 'untitled'] });
    assert.equal(r.branchProvenance, null);
    const w = r.warnings.find((x) => x.code === 'BRANCH_PROVENANCE_NOT_COMPUTED');
    assert.ok(w !== undefined, 'the warning stays');
    assert.match(w.message, /branchProvenance is null/);
    assert.doesNotMatch(w.message, /all zeros/);
  });

  it('every subset of the non-tree checks gives null; every subset that contains a tree check gives a measured object', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [branchedConversation('br'), star('star', 3)]);
    for (const check of NON_TREE_CHECKS) {
      const r = runAudit(db, { checks: [check] });
      assert.equal(r.branchProvenance, null, `only ${check}`);
      assert.ok(r.warnings.some((w) => w.code === 'BRANCH_PROVENANCE_NOT_COMPUTED'), `only ${check}: warning`);
    }
    for (const tree of TREE_CHECKS) {
      const r = runAudit(db, { checks: [tree] });
      assert.ok(r.branchProvenance !== null, `only ${tree}`);
      assert.equal(r.branchProvenance.maxBranchesInOneConversation, 3, `only ${tree}: measured, not zero`);
      assert.ok(!r.warnings.some((w) => w.code === 'BRANCH_PROVENANCE_NOT_COMPUTED'), `only ${tree}: no warning`);
    }
    const all = runAudit(db);
    assert.ok(all.branchProvenance !== null);
    assert.equal(all.branchProvenance.conversationsWithKnownActiveBranch + all.branchProvenance.conversationsWithUnknownActiveBranch, all.scanned.conversations);
  });

  it('an empty database with a tree check selected is a MEASURED zero, not a null', () => {
    const { db } = fresh();
    const r = runAudit(db, { checks: ['no_current_node'] });
    assert.deepEqual(r.branchProvenance, { conversationsWithMultipleBranches: 0, maxBranchesInOneConversation: 0, conversationsWithKnownActiveBranch: 0, conversationsWithUnknownActiveBranch: 0 });
  });

  it('modelProvenance has no such problem: it is always an object with real counts, whatever is selected', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('m', [{ role: 'user' }, { role: 'assistant', model: 'm1' }, { role: 'user' }, { role: 'assistant' }])]);
    const r = runAudit(db, { checks: ['untitled'] });
    assert.equal(r.branchProvenance, null);
    assert.deepEqual(r.modelProvenance, { assistantMessagesWithModel: 1, assistantMessagesWithoutModel: 1, conversationsWithAnyModel: 1 });
  });
});
