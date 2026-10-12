/**
 * SPEC-06 adversarial review at the CLI: the literal reproduction of the finding is `gcr thread <id> --branch cyc-a`, an id the
 * user copied from `gcr search`. It must not answer "No such branch": the message is stored, only no root reaches it.
 * SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { FIXTURES, assertJsonError, assertOk, assertTextError, gcr, tempDir } from './cli.helpers.test.js';

const NO_ROOT = '00000000-0000-4000-8000-000000000030';
const CYCLE_BESIDE_TREE = '00000000-0000-4000-8000-000000000031';
let dbPath = '';

before(async () => {
  dbPath = join(tempDir('gcr-spec06-adv-'), 'bt.sqlite');
  assertOk(await gcr(['import', join(FIXTURES, 'chatgpt', 'broken-trees.json'), '--db', dbPath, '--format', 'json']), 'import');
});

describe('SPEC-06 review: thread --branch <stored but unreachable message>', () => {
  it('text mode: BRANCH_NOT_FOUND that says the message is stored and unreachable, with a search remedy', async () => {
    const r = await gcr(['thread', NO_ROOT, '--branch', 'cyc-a', '--db', dbPath]);
    assertTextError(r, 'BRANCH_NOT_FOUND', { remedy: /search/ });
    assert.match(r.stderr, /stored, but no root reaches it/);
    assert.doesNotMatch(r.stderr, /No such branch/);
  });

  it('json mode: details.reason is "unreachable"', async () => {
    const r = await gcr(['thread', NO_ROOT, '--branch', 'cyc-b', '--db', dbPath, '--format', 'json']);
    const env = assertJsonError(r, 'BRANCH_NOT_FOUND');
    assert.equal(env.error.details?.['reason'], 'unreachable');
    assert.equal(env.error.details?.['branchCount'], 0);
  });

  it('a cycle beside a reachable tree gives the same answer for the cycle node and still reads the tree', async () => {
    const r = await gcr(['thread', CYCLE_BESIDE_TREE, '--branch', 'cyc-y', '--db', dbPath, '--format', 'json']);
    assert.equal(assertJsonError(r, 'BRANCH_NOT_FOUND').error.details?.['reason'], 'unreachable');
    const ok = await gcr(['get', CYCLE_BESIDE_TREE, '--db', dbPath, '--format', 'json']);
    assertOk(ok);
  });

  it('an id that is not in the conversation keeps the generic answer', async () => {
    const r = await gcr(['thread', NO_ROOT, '--branch', 'no-such-message', '--db', dbPath, '--format', 'json']);
    assert.equal(assertJsonError(r, 'BRANCH_NOT_FOUND').error.details?.['reason'], 'unknown_branch');
  });
});
