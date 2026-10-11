/**
 * scripts/ci-smoke.mjs against the REAL product. LONG: the smoke spawns about 60 child processes (about 15 s on an idle
 * machine, several times that on a loaded one), so this file has generous timeouts.
 *
 * The product is compiled from src/ into a temp directory (see scripts.helpers.test.ts); the smoke is told where with
 * --dist. The smoke itself is run exactly as `npm run smoke` runs it, with an empty environment except PATH and a private
 * TMPDIR, so the test can also check that the smoke removes everything it created.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REPO_ROOT, SMOKE, baseEnv, buildProduct, cleanupBuilds, makeTempDir, parseSmoke, removeDir, runNode } from './scripts.helpers.test.js';
import type { RunResult, SmokeReport } from './scripts.helpers.test.js';

describe('scripts/ci-smoke.mjs passes on the real product (LONG)', { timeout: 300_000 }, () => {
  let tmpRoot = '';
  let run: RunResult;
  let report: SmokeReport;

  before(async () => {
    const build = await buildProduct();
    tmpRoot = makeTempDir('gcr-smoke-pass-');
    const smokeTmp = join(tmpRoot, 'tmp');
    mkdirSync(smokeTmp);
    run = await runNode([SMOKE, '--dist', build.dist], { cwd: REPO_ROOT, env: baseEnv({ TMPDIR: smokeTmp }), timeoutMs: 280_000 });
    report = parseSmoke(run.stdout);
  });
  after(() => {
    removeDir(tmpRoot);
    cleanupBuilds();
  });

  it('exits 0 and ends with "SMOKE OK (<n> checks)"', () => {
    assert.equal(run.timedOut, false);
    assert.deepEqual(report.failures, []);
    assert.equal(run.code, 0);
    assert.match(report.lastLine, /^SMOKE OK \(\d+ checks\)$/);
  });

  it('is not vacuous: n is the number of PASS lines and covers every area of the spec', () => {
    const n = Number(/\((\d+) checks\)/.exec(report.lastLine)?.[1]);
    assert.equal(n, report.passes.length);
    assert.ok(n >= 38, `only ${n} checks`);
    const areas: Array<[string, RegExp]> = [
      ['network guard', /^guard: blocks network/],
      ['fixtures', /^fixtures: /],
      ['doctor', /^cli: doctor/],
      ['import', /^cli: import stores/],
      ['idempotent import', /^cli: importing the same archive again/],
      ['list/get/search/branches/thread/stats/audit', /^cli read: audit/],
      ['read-only reads', /^cli read: read commands leave the database content unchanged/],
      ['NOT_IN_LOCAL_EXPORT', /NOT_IN_LOCAL_EXPORT exits 3/],
      ['UNSUPPORTED_URL', /UNSUPPORTED_URL exits 2/],
      ['drafts', /^cli: draft create and draft list/],
      ['graph export', /^cli: graph export writes an offline HTML file/],
      ['graph overwrite refusal', /refuses to overwrite/],
      ['mcp initialize', /^mcp: initialize over stdio/],
      ['mcp tool list', /^mcp: tools\/list is exactly the 12 documented tools/],
      ['mcp write refusal', /every write tool is refused/],
      ['mcp truthful hints', /readOnlyHint is truthful/],
      ['mcp import roots', /outside GCR_APPROVED_IMPORT_ROOTS/],
      ['mcp raw stdout', /^mcp: raw stdio, every stdout line is a JSON-RPC message/],
      ['canary outputs', /^canary: absent from every captured stdout/],
      ['canary database', /^canary: absent from every database table/],
      ['canary html', /^canary: absent from the exported HTML/],
      ['guard log empty', /^guard: no product process attempted/],
      ['guard loaded everywhere', /^guard: the guard was loaded in every product process/],
    ];
    for (const [area, pattern] of areas) assert.ok(report.passes.some((p) => pattern.test(p)), `no PASS line for: ${area}`);
  });

  it('prints nothing but PASS lines and the final line on stdout, and only the timing line on stderr', () => {
    assert.deepEqual(report.otherLines, [report.lastLine]);
    assert.match(run.stderr, /^ci-smoke: \d+(\.\d+)? s\n$/);
  });

  it('never prints an absolute path, a temp directory name or the canary', () => {
    assert.ok(!/\/tmp\b|\/home\/|\/Users\/|gcr-smoke-|\.sqlite|\.zip/.test(run.stdout + run.stderr), 'a path or a file name leaked');
    assert.ok(!run.stdout.includes(REPO_ROOT));
    assert.ok(!/GCR-CANARY/.test(run.stdout + run.stderr));
  });

  it('removes its temp directory', () => {
    assert.deepEqual(readdirSync(join(tmpRoot, 'tmp')), []);
  });

  it('finishes well inside the budget of about a minute on an idle machine (reported, not asserted tightly)', () => {
    const seconds = Number(/ci-smoke: ([\d.]+) s/.exec(run.stderr)?.[1]);
    assert.ok(seconds < 240, `took ${seconds} s`);
  });
});

describe('scripts/ci-smoke.mjs refuses to start without a product or with a bad argument', { timeout: 60_000 }, () => {
  it('exit 2 and a hint when --dist has no CLI', async () => {
    const empty = makeTempDir('gcr-smoke-empty-');
    try {
      const r = await runNode([SMOKE, '--dist', empty], { cwd: REPO_ROOT, env: baseEnv() });
      assert.equal(r.code, 2);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /not found \(run "npm run build" first/);
      assert.ok(!r.stderr.includes(empty), 'the directory is not echoed');
    } finally {
      removeDir(empty);
    }
  });

  it('exit 2 for an unknown argument', async () => {
    const r = await runNode([SMOKE, '--bogus'], { cwd: REPO_ROOT, env: baseEnv() });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown argument/);
  });
});
