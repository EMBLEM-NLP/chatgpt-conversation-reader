/**
 * `npm run licenses` launcher (scripts/licenses.mjs): argument handling and exit codes.
 *
 * The launcher imports ../dist/devtools/licenses.js, which only exists after `npm run build`. To test it
 * hermetically the compiled output of THIS test run (src/ -> licenses.js and its imports) is copied into a
 * throwaway layout `<tmp>/launcher/{scripts,dist}`, so the real launcher file runs unmodified against the
 * code under test. Projects are fabricated; no network, no real dependency tree.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { withTempDir } from '../helpers/tmp.js';

const execFileAsync = promisify(execFile);

function findLauncher(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, 'scripts', 'licenses.mjs');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('scripts/licenses.mjs not found above the test file');
}

const LAUNCHER_SOURCE = findLauncher();
/** Compiled sibling of this test: <out>/test/devtools/ -> <out>/src. */
const COMPILED_SRC = fileURLToPath(new URL('../../src', import.meta.url));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(script: string, args: readonly string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'number' && 'stdout' in e && 'stderr' in e) {
      return { code: e.code, stdout: String(e.stdout), stderr: String(e.stderr) };
    }
    throw e;
  }
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

interface Dep {
  name: string;
  license?: string;
  dev?: boolean;
}

/** Fabricates package-lock.json + node_modules for the given packages (a package without `license` has no license info). */
async function makeProject(dir: string, deps: readonly Dep[]): Promise<void> {
  const packages: Record<string, unknown> = { '': { name: 'fixture-app', version: '1.0.0' } };
  for (const d of deps) {
    packages[`node_modules/${d.name}`] = { version: '1.0.0', ...(d.dev === true ? { dev: true } : {}) };
    await put(join(dir, 'node_modules', d.name, 'package.json'), JSON.stringify({ name: d.name, version: '1.0.0', ...(d.license === undefined ? {} : { license: d.license }) }));
  }
  await put(join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture-app', lockfileVersion: 3, requires: true, packages }));
  await mkdir(join(dir, 'node_modules'), { recursive: true });
}

describe('scripts/licenses.mjs', () => {
  let base: string;
  let withDist: string;
  let bare: string;

  async function layout(name: string, includeDist: boolean): Promise<string> {
    const root = join(base, name);
    await mkdir(join(root, 'scripts'), { recursive: true });
    await copyFile(LAUNCHER_SOURCE, join(root, 'scripts', 'licenses.mjs'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    if (includeDist) await cp(COMPILED_SRC, join(root, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });
    return join(root, 'scripts', 'licenses.mjs');
  }

  before(async () => {
    base = await mkdtemp(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-test-licenses-cli-'));
    withDist = await layout('built', true);
    bare = await layout('unbuilt', false);
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('exits 0 and prints the markdown report when every runtime dependency has a permissive license', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ name: 'a', license: 'MIT' }, { name: 'b', license: '(MIT OR Apache-2.0)' }, { name: 'c', license: 'ISC', dev: true }]);
      const r = await run(withDist, ['--root', dir], dir);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^# Dependency license report\n/);
      assert.match(r.stdout, /- Packages: 3 \(runtime 2, dev 1\)/);
      assert.match(r.stdout, /- Release gate: PASS/);
      assert.equal(r.stderr, '');
      assert.equal(r.stdout.includes(dir), false, 'the report must not contain absolute paths');
    });
  });

  it('exits 1 when a runtime package has an unknown license, naming it on stderr', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ name: 'fine', license: 'MIT' }, { name: 'mystery' }]);
      const r = await run(withDist, ['--root', dir], dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /1 runtime package\(s\) with an unknown or non-permissive license: mystery@1\.0\.0/);
      assert.match(r.stdout, /### Unknown license \(1\)[\s\S]*\*\*mystery@1\.0\.0\*\* \(runtime\)/);
      assert.match(r.stdout, /- Release gate: FAIL/);
    });
  });

  for (const license of ['GPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1', 'SSPL-1.0', 'BUSL-1.1', 'CC-BY-NC-4.0', 'UNLICENSED']) {
    it(`exits 1 for a runtime dependency licensed ${license}`, async () => {
      await withTempDir(async (dir) => {
        await makeProject(dir, [{ name: 'restricted', license }]);
        const r = await run(withDist, ['--root', dir], dir);
        assert.equal(r.code, 1);
        assert.match(r.stdout, /### Non-permissive license/);
        assert.ok(r.stdout.includes(`\`${license}\``));
      });
    });
  }

  it('lists but tolerates unknown and non-permissive DEV dependencies (exit 0)', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [
        { name: 'runtime-ok', license: 'MIT' },
        { name: 'dev-mystery', dev: true },
        { name: 'dev-gpl', license: 'GPL-3.0-only', dev: true },
      ]);
      const r = await run(withDist, ['--root', dir], dir);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /\*\*dev-mystery@1\.0\.0\*\* \(dev\)/);
      assert.match(r.stdout, /\*\*dev-gpl@1\.0\.0\*\*: `GPL-3\.0-only` \[GPL\] \(dev\)/);
      assert.match(r.stdout, /- Release gate: PASS/);
    });
  });

  it('accepts a dual license where a permissive alternative exists', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ name: 'dual', license: '(MIT OR GPL-3.0-only)' }]);
      assert.equal((await run(withDist, ['--root', dir], dir)).code, 0);
    });
  });

  it('--json prints parseable JSON with the blocking list and keeps the exit code', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ name: 'ok', license: 'MIT' }, { name: 'bad', license: 'GPL-2.0-only' }]);
      const r = await run(withDist, ['--json', '--root', dir], dir);
      assert.equal(r.code, 1);
      const data = JSON.parse(r.stdout) as { packages: Array<{ name: string }>; summary: Record<string, number>; unknown: string[]; blocking: string[] };
      assert.deepEqual(data.packages.map((p) => p.name), ['bad', 'ok']);
      assert.deepEqual(data.summary, { 'GPL-2.0-only': 1, MIT: 1 });
      assert.deepEqual(data.unknown, []);
      assert.deepEqual(data.blocking, ['bad@1.0.0']);
    });
  });

  it('without --root it inspects the directory above scripts/, not the current directory', async () => {
    await withTempDir(async (elsewhere) => {
      const script = await layout('default-root', true);
      const projectRoot = dirname(dirname(script));
      await makeProject(projectRoot, [{ name: 'home-pkg', license: 'MIT' }]);
      await makeProject(elsewhere, [{ name: 'cwd-pkg', license: 'GPL-3.0-only' }]);
      const r = await run(script, [], elsewhere);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /home-pkg/);
      assert.equal(r.stdout.includes('cwd-pkg'), false);
    });
  });

  it('--root is resolved against the current directory', async () => {
    await withTempDir(async (dir) => {
      await makeProject(join(dir, 'nested', 'proj'), [{ name: 'p', license: 'MIT' }]);
      const r = await run(withDist, ['--root', join('nested', 'proj')], dir);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /- Packages: 1 /);
    });
  });

  it('exits 2 with a clear message when there is no lockfile', async () => {
    await withTempDir(async (dir) => {
      const r = await run(withDist, ['--root', dir], dir);
      assert.equal(r.code, 2);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /^licenses: package-lock\.json was not found/);
      assert.match(r.stderr, /npm install/);
      assert.equal(r.stderr.includes(dir), false, 'error output must not echo absolute paths');
    });
  });

  it('exits 2 and says to run `npm run build` when the project is not built', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ name: 'a', license: 'MIT' }]);
      const r = await run(bare, ['--root', dir], dir);
      assert.equal(r.code, 2);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /dist\/devtools\/licenses\.js is missing\. Run `npm run build` first\./);
    });
  });

  it('exits 2 and prints usage for unknown or incomplete arguments', async () => {
    await withTempDir(async (dir) => {
      const unknownArg = await run(withDist, ['--bogus'], dir);
      assert.equal(unknownArg.code, 2);
      assert.match(unknownArg.stderr, /unknown argument "--bogus"/);
      assert.match(unknownArg.stderr, /usage: node scripts\/licenses\.mjs/);
      const noValue = await run(withDist, ['--root'], dir);
      assert.equal(noValue.code, 2);
      assert.match(noValue.stderr, /--root needs a directory/);
    });
  });

  it('--help prints usage and exits 0 without touching the project', async () => {
    await withTempDir(async (dir) => {
      const r = await run(withDist, ['--help'], dir);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /usage: node scripts\/licenses\.mjs/);
    });
  });

  it('is a thin launcher: imports only node:path and node:url and its own compiled module (no network, no child processes)', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(LAUNCHER_SOURCE, 'utf8');
    const imports = [...text.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['node:path', 'node:url']);
    assert.match(text, /import\(new URL\('\.\.\/dist\/devtools\/licenses\.js', import\.meta\.url\)\.href\)/);
    assert.equal(/\b(fetch|XMLHttpRequest|WebSocket|child_process|require)\b\s*\(/.test(text), false);
  });
});
