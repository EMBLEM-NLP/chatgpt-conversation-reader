/**
 * SPEC-06 at the CLI: messages in a cycle with no root are findable by `gcr search` but not readable by `get` / `thread`, and the
 * NO_BRANCHES warning must say "N message(s) are stored but none is reachable from a root", not "the tree is empty".
 * Reproduction (before the fix): `gcr import fixtures/chatgpt/broken-trees.json`, `gcr get 00000000-0000-4000-8000-000000000030`
 * -> "NO_BRANCHES: The stored message tree of this snapshot is empty: there is no thread to show." SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { FIXTURES, FORMATS, arr, assertOk, assertTextError, envelope, gcr, tempDir } from './cli.helpers.test.js';

const CYCLE_ID = '00000000-0000-4000-8000-000000000030';
let dbPath = '';

before(async () => {
  dbPath = join(tempDir('gcr-spec06-'), 'bt.sqlite');
  assertOk(await gcr(['import', join(FIXTURES, 'chatgpt', 'broken-trees.json'), '--db', dbPath, '--format', 'json']), 'import');
});

describe('SPEC-06: unreachable-cycle messages', () => {
  it('get: exit 0, thread null, NO_BRANCHES says 2 messages are stored but unreachable (not "empty")', async () => {
    const r = await gcr(['get', CYCLE_ID, '--db', dbPath, '--format', 'json']);
    assertOk(r);
    const env = envelope(r.stdout);
    assert.equal(env.data['thread'], null);
    const w = env.warnings.find((x) => x.code === 'NO_BRANCHES');
    assert.ok(w !== undefined);
    assert.match(w.message, /2 message\(s\) are stored/);
    assert.match(w.message, /none of them is reachable from a root/);
    assert.doesNotMatch(w.message, /\bempty\b/i);
  });

  for (const format of FORMATS) {
    it(`get --format ${format} prints the same honest message`, async () => {
      const r = await gcr(['get', CYCLE_ID, '--db', dbPath, '--format', format]);
      assertOk(r);
      assert.ok(r.stdout.includes('none of them is reachable from a root'), r.stdout.slice(0, 200));
      assert.ok(!r.stdout.includes('tree of this snapshot is empty'));
    });
  }

  it('search finds the text (the documented claim), thread refuses with BRANCH_NOT_FOUND and the same distinction', async () => {
    const s = await gcr(['search', 'cycle', '--db', dbPath, '--format', 'json']);
    assertOk(s);
    const hits = arr(envelope(s.stdout).data['items']).filter((i) => i['conversationId'] === CYCLE_ID);
    assert.deepEqual(hits.map((h) => h['messageId']).sort(), ['cyc-a', 'cyc-b']);
    const t = await gcr(['thread', CYCLE_ID, '--db', dbPath]);
    assertTextError(t, 'BRANCH_NOT_FOUND');
    assert.match(t.stderr, /2 message\(s\) are stored but none is reachable from a root/);
  });
});
