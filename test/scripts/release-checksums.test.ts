/**
 * scripts/release-checksums.mjs (SPEC NFR-02, independently verifiable SHA-256 release artifacts) against a tiny fake
 * package directory, so the test needs neither a built product nor the real tarball: the manifest format is the one
 * `sha256sum -c` reads, two packs of the same tree agree, a changed byte or a missing file turns --verify red, and
 * hostile manifests are refused.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SCRIPTS_DIR, baseEnv, makeTempDir, removeDir, runNode } from './scripts.helpers.test.js';

const SCRIPT = join(SCRIPTS_DIR, 'release-checksums.mjs');

let work = '';
let pkg = '';

before(() => {
  work = makeTempDir('gcr-release-test-');
  pkg = join(work, 'pkg');
  mkdirSync(join(pkg, 'dist', 'cli'), { recursive: true });
  mkdirSync(join(pkg, 'docs'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gcr-release-fixture', version: '1.2.3', files: ['dist', 'docs', 'README.md'] }));
  writeFileSync(join(pkg, 'dist', 'cli', 'main.js'), '#!/usr/bin/env node\nconsole.log("synthetic");\n');
  writeFileSync(join(pkg, 'docs', 'a.md'), '# synthetic\n');
  writeFileSync(join(pkg, 'README.md'), '# synthetic package\n');
});
after(() => removeDir(work));

const run = (args: string[]) => runNode([SCRIPT, '--root', pkg, ...args], { env: baseEnv({ HOME: work }), timeoutMs: 120_000 });

describe('scripts/release-checksums.mjs', () => {
  it('writes a sha256sum-format manifest whose hash is the hash of the tarball', async () => {
    const out = join(work, 'out1');
    const r = await run(['--out', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readdirSync(out).sort(), ['SHA256SUMS', 'gcr-release-fixture-1.2.3.tgz']);
    const manifest = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
    const want = createHash('sha256').update(readFileSync(join(out, 'gcr-release-fixture-1.2.3.tgz'))).digest('hex');
    assert.equal(manifest, `${want}  gcr-release-fixture-1.2.3.tgz\n`);
    assert.ok(!manifest.includes('/'), 'the manifest names the artifact by base name only');
    const v = await run(['--verify', out]);
    assert.equal(v.code, 0, v.stderr);
    assert.match(v.stdout, /gcr-release-fixture-1\.2\.3\.tgz: OK/);
  });

  it('two packs of the same tree have the same hash', async () => {
    const r = await run(['--twice']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /two packs agree \([0-9a-f]{64}\)/);
  });

  it('--verify fails when the tarball changed or is missing', async () => {
    const out = join(work, 'out2');
    assert.equal((await run(['--out', out])).code, 0);
    appendFileSync(join(out, 'gcr-release-fixture-1.2.3.tgz'), 'x');
    const changed = await run(['--verify', out]);
    assert.equal(changed.code, 1);
    assert.match(changed.stdout, /FAILED/);
    rmSync(join(out, 'gcr-release-fixture-1.2.3.tgz'));
    const missing = await run(['--verify', out]);
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /MISSING/);
  });

  it('--verify refuses a manifest with paths, odd lines, no manifest or no entries', async () => {
    const out = join(work, 'out3');
    mkdirSync(out);
    assert.equal((await run(['--verify', out])).code, 1, 'no manifest');
    const hash = 'a'.repeat(64);
    for (const body of [`${hash}  ../etc/passwd\n`, `${hash}  sub/file.tgz\n`, `${hash} file.tgz\n`, `${'g'.repeat(64)}  file.tgz\n`, '', '\n']) {
      writeFileSync(join(out, 'SHA256SUMS'), body);
      const r = await run(['--verify', out]);
      assert.equal(r.code, 1, `manifest ${JSON.stringify(body)} must be refused`);
    }
  });

  it('refuses to pack a tree that has no build, and rejects bad arguments', async () => {
    const empty = join(work, 'empty');
    mkdirSync(empty);
    writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    const r = await runNode([SCRIPT, '--root', empty, '--out', join(work, 'out4')], { env: baseEnv({ HOME: work }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /npm run build/);
    assert.equal((await runNode([SCRIPT, '--nope'], { env: baseEnv() })).code, 2);
    assert.equal((await runNode([SCRIPT, '--out'], { env: baseEnv() })).code, 2);
  });
});
