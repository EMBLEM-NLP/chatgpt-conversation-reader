/**
 * SPEC-06 adversarial review: the literal reproduction of the finding is `gcr thread <id> --branch cyc-a`, which answered
 * "No such branch in this conversation." (branchCount 0) although cyc-a is a STORED message that no root reaches. The first fix
 * reworded the NO_BRANCHES warning and the branch-less `thread()` error but not this path: a user who copies a message id from
 * `gcr search` into `--branch` was told the branch does not exist, with no hint that the text is stored but unreachable.
 *
 * Pinned here: naming an unreachable (cycle) message as the branch gives a BRANCH_NOT_FOUND that says so (reason "unreachable"),
 * in a conversation with no branch at all (F07 "cycle with no root") and in one that has branches next to the cycle (F07 "cycle
 * declared from a root"); a really unknown id keeps the generic answer. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { expectGcr, fixedClock, makeTempDir, removeDir, thrown } from './sdk.helpers.test.js';

const NO_ROOT = '00000000-0000-4000-8000-000000000030';
const CYCLE_BESIDE_TREE = '00000000-0000-4000-8000-000000000031';
const FIXTURE = new URL('../../../fixtures/chatgpt/broken-trees.json', import.meta.url).pathname;

let dir = '';
let gcr: Gcr;

before(async () => {
  dir = await makeTempDir();
  gcr = Gcr.open({ dbPath: join(dir, 'bt.sqlite'), clock: fixedClock });
  await gcr.importExport({ source: { kind: 'path', path: FIXTURE } });
});

after(async () => {
  gcr.close();
  await removeDir(dir);
});

describe('SPEC-06 review: naming a stored but unreachable message as the branch', () => {
  it('no root at all: thread(branch "cyc-a") says the message is stored but unreachable, not that the branch does not exist', () => {
    const e = expectGcr(thrown(() => gcr.thread(NO_ROOT, { branch: 'cyc-a' })), 'BRANCH_NOT_FOUND');
    assert.equal(e.details?.['reason'], 'unreachable');
    assert.equal(e.details?.['branchCount'], 0);
    assert.match(e.message, /stored/);
    assert.match(e.message, /no root reaches it|not reachable from a root/);
    assert.match(e.remedy ?? '', /search/);
    assert.doesNotMatch(e.message, /^No such branch/);
  });

  it('a cycle next to a reachable tree: the cycle node is "unreachable", a reachable leaf still works', () => {
    const e = expectGcr(thrown(() => gcr.thread(CYCLE_BESIDE_TREE, { branch: 'cyc-y' })), 'BRANCH_NOT_FOUND');
    assert.equal(e.details?.['reason'], 'unreachable');
    assert.match(e.message, /stored/);
    const branches = gcr.branches(CYCLE_BESIDE_TREE).data.branches;
    assert.ok(branches.length >= 1);
    const ok = gcr.thread(CYCLE_BESIDE_TREE, { branch: branches[0]?.branchId ?? '' });
    assert.equal(ok.ok, true);
  });

  it('an id that is not in the conversation keeps the generic answer (the claim is only made for stored messages)', () => {
    for (const id of [NO_ROOT, CYCLE_BESIDE_TREE]) {
      const e = expectGcr(thrown(() => gcr.thread(id, { branch: 'definitely-not-a-message' })), 'BRANCH_NOT_FOUND');
      assert.equal(e.details?.['reason'], 'unknown_branch');
      assert.match(e.message, /^No such branch/);
    }
  });

  it('get({branch}) behaves the same as thread({branch})', () => {
    const e = expectGcr(thrown(() => gcr.get(NO_ROOT, { branch: 'cyc-b' })), 'BRANCH_NOT_FOUND');
    assert.equal(e.details?.['reason'], 'unreachable');
  });
});
