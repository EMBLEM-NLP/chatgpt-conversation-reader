/**
 * The smoke must be impossible to pass vacuously: when the product is SABOTAGED in a way the smoke claims to detect, it
 * has to turn red with a precise FAIL line. Every test copies the freshly compiled product into its own temp directory,
 * changes one thing in the copy, runs `scripts/ci-smoke.mjs --dist <copy>` and looks at the output. This file sabotages
 * the CLI side; ci-smoke.sabotage.mcp.test.ts the MCP server.
 *
 * LONG: each case is a complete smoke run (about 15 s idle, much more on a loaded machine); the cases run one after the other.
 *
 * "Precise" means: the FAIL line names the right check, its reason states the observed fact in numbers, codes or API names
 * (never content: the canary itself must not appear), and checks unrelated to the sabotage still PASS, so the red line is
 * not just "everything broke".
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appendToFile, assertRed, cleanupBuilds, failureOf, hasPassed, replaceInFile, smokeOnSabotaged } from './scripts.helpers.test.js';

after(cleanupBuilds);

describe('scripts/ci-smoke.mjs turns red when the CLI is sabotaged (LONG)', { timeout: 600_000 }, () => {
  it('the import command prints the canary of the decoy file in the archive', async () => {
    const o = await smokeOnSabotaged((dist) =>
      appendToFile(
        join(dist, 'cli', 'main.js'),
        `import { readFileSync as sabotageRead } from 'node:fs';
{
  const zip = process.argv.find((a) => a.endsWith('.zip'));
  if (process.argv[2] === 'import' && zip !== undefined) {
    const found = /GCR-CANARY-[0-9a-f]{16}/.exec(sabotageRead(zip).toString('latin1'));
    if (found !== null) process.stdout.write(found[0] + '\\n');
  }
}`,
      ),
    );
    assertRed(o);
    assert.equal(failureOf(o, 'canary: absent from every captured stdout and stderr').reason, 'the canary reached an output stream');
    failureOf(o, 'cli: import stores the export'); // the extra line also breaks the JSON of the import report
    assert.ok(hasPassed(o, 'canary: absent from the exported HTML'), 'unrelated canary checks still pass');
    assert.ok(hasPassed(o, 'guard: no product process attempted'), 'the guard check is unaffected');
  });

  it('NOT_IN_LOCAL_EXPORT exits 0 instead of 3', async () => {
    const o = await smokeOnSabotaged((dist) => replaceInFile(join(dist, 'errors.js'), 'NOT_IN_LOCAL_EXPORT: 3,', 'NOT_IN_LOCAL_EXPORT: 0,'));
    assertRed(o);
    assert.equal(failureOf(o, 'cli errors: NOT_IN_LOCAL_EXPORT exits 3').reason, 'absent uuid exit code: got 0, expected 3');
    assert.ok(hasPassed(o, 'cli: import stores the export'));
    assert.ok(hasPassed(o, 'cli errors: UNSUPPORTED_URL exits 2'));
  });

  it('the CLI calls fetch and swallows the error (only the guard log can tell)', async () => {
    const o = await smokeOnSabotaged((dist) => appendToFile(join(dist, 'cli', 'main.js'), `try { await fetch('http://192.0.2.1:9/'); } catch { /* swallowed on purpose */ }`));
    assertRed(o);
    assert.match(failureOf(o, 'guard: no product process attempted to use the network').reason, /^the guard recorded \d+ network attempt\(s\): fetch x\d+$/);
    assert.ok(hasPassed(o, 'cli: import stores the export'), 'every functional check still passes: the swallowed call is invisible without the guard');
    assert.ok(hasPassed(o, 'guard: the guard was loaded in every product process'));
  });
});
