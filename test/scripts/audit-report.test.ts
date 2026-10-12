/**
 * scripts/audit-report.mjs: the branch / model provenance audit of the committed synthetic fixtures
 * (CODEX_TASK Phase 3). The published page docs/AUDIT_REPORT.md must be exactly what the product produces now, the
 * generator must be deterministic and must not leak the machine (paths, host name, user name), and `--check` must go red
 * on a stale page. The product under test is compiled into a temp directory, so no pre-existing dist/ is needed.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REPO_ROOT, SCRIPTS_DIR, baseEnv, buildProduct, cleanupBuilds, makeTempDir, removeDir, runNode } from './scripts.helpers.test.js';
import type { ProductBuild } from './scripts.helpers.test.js';

const SCRIPT = join(SCRIPTS_DIR, 'audit-report.mjs');
const PAGE = join(REPO_ROOT, 'docs', 'AUDIT_REPORT.md');

let build: ProductBuild;
let work = '';

before(async () => {
  build = await buildProduct();
  work = makeTempDir('gcr-audit-report-test-');
});
after(() => {
  removeDir(work);
  cleanupBuilds();
});

const cli = (): string => join(build.dist, 'cli', 'main.js');

describe('scripts/audit-report.mjs', () => {
  it('writes the same bytes twice (deterministic) and the page carries no machine details', async () => {
    const a = join(work, 'a.md');
    const b = join(work, 'b.md');
    const ra = await runNode([SCRIPT, '--cli', cli(), '--out', a], { env: baseEnv() });
    const rb = await runNode([SCRIPT, '--cli', cli(), '--out', b], { env: baseEnv() });
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(rb.code, 0, rb.stderr);
    const text = readFileSync(a, 'utf8');
    assert.equal(text, readFileSync(b, 'utf8'));
    for (const secret of [homedir(), hostname(), userInfo().username, REPO_ROOT, build.root]) {
      if (secret.length >= 4 && secret !== '/') assert.ok(!text.includes(secret), `the page must not contain ${secret.length > 12 ? 'a local path' : 'a machine detail'}`);
    }
    assert.match(text, /SYNTHETIC fixtures/);
    assert.match(text, /## Branch provenance/);
    assert.match(text, /## Model provenance/);
    assert.match(text, /unknown \(not supplied by source\)/);
  });

  it('docs/AUDIT_REPORT.md is exactly what this build produces from the fixtures', async () => {
    const r = await runNode([SCRIPT, '--check', '--cli', cli(), '--out', PAGE], { env: baseEnv() });
    assert.equal(r.code, 0, `docs/AUDIT_REPORT.md is stale; run: npm run build && npm run audit:report\n${r.stderr}`);
  });

  it('--check fails on a stale or a missing page', async () => {
    const stale = join(work, 'stale.md');
    writeFileSync(stale, `${readFileSync(PAGE, 'utf8')}\nan edit by hand\n`);
    const r1 = await runNode([SCRIPT, '--check', '--cli', cli(), '--out', stale], { env: baseEnv() });
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /stale/);
    const r2 = await runNode([SCRIPT, '--check', '--cli', cli(), '--out', join(work, 'missing.md')], { env: baseEnv() });
    assert.equal(r2.code, 1);
  });

  it('rejects an unknown argument', async () => {
    const r = await runNode([SCRIPT, '--nope'], { env: baseEnv() });
    assert.notEqual(r.code, 0);
  });
});
