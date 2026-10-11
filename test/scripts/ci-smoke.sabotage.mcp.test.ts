/**
 * Sabotaging the MCP server side: the smoke has to turn red with a precise FAIL line (see ci-smoke.sabotage.cli.test.ts for
 * the method and for what "precise" means).
 *
 * LONG: each case is a complete smoke run (about 15 s idle, much more on a loaded machine); the cases run one after the other.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appendToFile, assertRed, cleanupBuilds, failureOf, hasPassed, smokeOnSabotaged } from './scripts.helpers.test.js';

after(cleanupBuilds);

describe('scripts/ci-smoke.mjs turns red when the MCP server is sabotaged (LONG)', { timeout: 600_000 }, () => {
  it('the server writes a stray line to stdout, bypassing the stdout guard', async () => {
    const o = await smokeOnSabotaged((dist) =>
      appendToFile(join(dist, 'mcp', 'entry.js'), `import { writeSync as sabotageWrite } from 'node:fs';\nsabotageWrite(1, 'this stray line is not JSON-RPC\\n');`),
    );
    assertRed(o);
    assert.match(failureOf(o, 'mcp: raw stdio, every stdout line is a JSON-RPC message').reason, /^stdout line 1 is not JSON \(\d+ chars\)$/);
    // The SDK client tolerates the stray line (it reports it through onerror and carries on), which is exactly why the raw
    // byte check exists; the smoke also fails on what the client reported.
    assert.match(failureOf(o, 'mcp: the read-only session ends cleanly').reason, /^transport errors seen by the SDK client \(\w+\): got [1-9]\d*, expected 0$/);
    assert.ok(hasPassed(o, 'cli read: audit'), 'the CLI checks are unaffected');
  });

  it('a read-only tool writes to the database when writes are enabled', async () => {
    const o = await smokeOnSabotaged((dist) =>
      appendToFile(
        join(dist, 'mcp', 'entry.js'),
        `import('../sdk/gcr.js').then(({ Gcr }) => {
  const original = Gcr.prototype.list;
  Gcr.prototype.list = function sabotagedList(...args) {
    this.db.exec('CREATE TABLE IF NOT EXISTS sabotage_marker (x)');
    return original.apply(this, args);
  };
});`,
      ),
    );
    assertRed(o);
    assert.equal(
      failureOf(o, 'mcp: with writes enabled the nine read tools still do not change the database').reason,
      'gcr_list changed the database although it is annotated read-only',
    );
    assert.ok(hasPassed(o, 'mcp: tools/list is exactly the 12 documented tools'), 'the annotations themselves are still fine');
    assert.ok(hasPassed(o, 'cli read: list'));
  });

  it('the server calls http.get and swallows the error (only the guard log can tell)', async () => {
    const o = await smokeOnSabotaged((dist) =>
      appendToFile(join(dist, 'mcp', 'entry.js'), `import('node:http').then((http) => { try { http.get('http://192.0.2.1:9/'); } catch { /* swallowed on purpose */ } });`),
    );
    assertRed(o);
    assert.match(failureOf(o, 'guard: no product process attempted to use the network').reason, /^the guard recorded \d+ network attempt\(s\): http\.get x\d+$/);
    assert.ok(hasPassed(o, 'mcp: tools/list is exactly the 12 documented tools'));
  });
});
