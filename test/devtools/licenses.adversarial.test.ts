/**
 * Independent adversarial review of src/devtools/licenses.ts and scripts/licenses.mjs.
 *
 * Each block pins a defect found by attacking the first version: a license string that slipped past the
 * non-permissive check, a license text classified as MIT although a restriction was written next to the copyright
 * line, a hostile package that could write terminal escape sequences to the log, ... Every project is fabricated in a
 * temp directory; nothing is read from the real repository and nothing touches the network.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  blockingPackages,
  classifyLicenseText,
  collectLicenses,
  formatLicenseReport,
  licenseFromPackageJson,
  nonPermissiveFamily,
  sanitizeForTerminal,
} from '../../src/devtools/licenses.js';
import type { LicenseCollection } from '../../src/devtools/licenses.js';
import { withTempDir } from '../helpers/tmp.js';

const execFileAsync = promisify(execFile);

const MIT_BODY = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
  '',
].join('\n');

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

interface Fake {
  /** Lockfile key; the install directory is the same path below the project root. */
  key: string;
  lock?: Record<string, unknown>;
  /** package.json text (written verbatim); undefined = package not installed. */
  manifest?: string;
  files?: Record<string, string>;
}

async function makeProject(dir: string, fakes: readonly Fake[]): Promise<void> {
  const packages: Record<string, unknown> = { '': { name: 'fixture-app', version: '1.0.0' } };
  for (const f of fakes) {
    packages[f.key] = { version: '1.0.0', ...(f.lock ?? {}) };
    if (f.manifest !== undefined) await put(join(dir, f.key, 'package.json'), f.manifest);
    for (const [rel, text] of Object.entries(f.files ?? {})) await put(join(dir, f.key, rel), text);
  }
  await put(join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture-app', lockfileVersion: 3, packages }));
  await mkdir(join(dir, 'node_modules'), { recursive: true });
}

const manifestOf = (name: string, extra: Record<string, unknown>): string => JSON.stringify({ name, version: '1.0.0', ...extra });
const only = (result: LicenseCollection, name: string) => {
  const found = result.packages.find((p) => p.name === name);
  assert.ok(found !== undefined, `${name} missing from ${JSON.stringify(result.packages)}`);
  return found;
};

describe('adversarial: SPDX-looking strings that are not SPDX expressions are checked word by word', () => {
  const restricted: ReadonlyArray<readonly [string, string]> = [
    ['MIT/GPL-3.0', 'GPL'],
    ['MIT,GPL-3.0', 'GPL'],
    ['(MIT/GPL-3.0)', 'GPL'],
    ['BSD-3-Clause/AGPL-3.0-only', 'AGPL'],
    ['Apache-2.0;LGPL-2.1', 'LGPL'],
    ['MIT,SSPL-1.0', 'SSPL'],
    ['ISC/BUSL-1.1', 'BUSL'],
  ];
  for (const [license, family] of restricted) {
    it(`${license} is ${family}`, () => {
      assert.equal(nonPermissiveFamily(license), family);
    });
  }
  for (const license of ['MIT/X11', 'MIT*', 'Apache-2.0', 'MIT OR Apache-2.0', '(BSD-2-Clause OR MIT)', 'GPL-2.0-only OR MIT']) {
    it(`${license} is not flagged`, () => {
      assert.equal(nonPermissiveFamily(license), null);
    });
  }
});

describe('adversarial: declared strings that deny rights are non-permissive', () => {
  for (const license of [
    'All Rights Reserved',
    'all rights reserved',
    'Copyright 2020 Foo. All rights reserved.',
    'Private',
    'Closed source',
    'closed-source',
    'personal use only',
    'Educational use only',
    'CC BY-NC 4.0',
    'CC BY-NC-SA 4.0',
    'cc-by-nc',
  ]) {
    it(`${JSON.stringify(license)} is flagged`, () => {
      assert.notEqual(nonPermissiveFamily(license), null);
    });
  }
  for (const license of ['CC-BY-4.0', 'CC0-1.0', 'Unlicense', 'Public Domain', 'BSD']) {
    it(`${JSON.stringify(license)} is not flagged`, () => {
      assert.equal(nonPermissiveFamily(license), null);
    });
  }
});

describe('adversarial: "no license" placeholders are an absent declaration, not a license', () => {
  for (const license of ['NONE', 'none', 'NOASSERTION', 'No license', 'no licence', 'N/A']) {
    it(`${JSON.stringify(license)} declares nothing`, () => {
      assert.equal(licenseFromPackageJson({ license }), null);
    });
  }
  it('a package declaring NONE with no license file is unknown, hence blocks the release gate when it is a runtime package', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', { license: 'NONE' }) }]);
      const result = await collectLicenses(dir);
      assert.equal(only(result, 'a').source, 'unknown');
      assert.deepEqual(blockingPackages(result).map((p) => p.name), ['a']);
    });
  });
  it('a package declaring NONE falls back to an unmodified license file', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', { license: 'NONE' }), files: { LICENSE: `MIT License\n\nCopyright (c) 2020 Foo\n\n${MIT_BODY}` } }]);
      assert.equal(only(await collectLicenses(dir), 'a').license, 'MIT');
    });
  });
});

describe('adversarial: a byte order mark does not hide a manifest or a lockfile', () => {
  it('reads a package.json that starts with a BOM (npm does)', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: `\ufeff${manifestOf('a', { license: 'MIT' })}` }]);
      const p = only(await collectLicenses(dir), 'a');
      assert.deepEqual([p.license, p.source], ['MIT', 'package.json']);
    });
  });
  it('reads a package-lock.json that starts with a BOM', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', { license: 'MIT' }) }]);
      const lockPath = join(dir, 'package-lock.json');
      const { readFile } = await import('node:fs/promises');
      await writeFile(lockPath, `\ufeff${await readFile(lockPath, 'utf8')}`);
      assert.equal(only(await collectLicenses(dir), 'a').license, 'MIT');
    });
  });
});

describe('adversarial: text written next to the copyright line is not part of the license', () => {
  const refuse: ReadonlyArray<readonly [string, string]> = [
    ['a restriction after the holder', `Copyright (c) 2020 Foo Inc. Use is strictly limited to non-commercial purposes; redistribution prohibited.\n\n${MIT_BODY}`],
    ['a paid-license sentence', `MIT License\n\nCopyright 2020 Foo. Commercial use requires a paid license.\n\n${MIT_BODY}`],
    ['(c) line with a use restriction', `(c) 2020 Foo - for educational use only\n\n${MIT_BODY}`],
    ['(c) symbol line with a use restriction', `\u00a9 2020 Foo - no military use permitted\n\n${MIT_BODY}`],
    ['a restriction in a parenthesised title', `MIT License (non-commercial)\n\nCopyright (c) 2020 Foo\n\n${MIT_BODY}`],
    ['an over-long "copyright" line', `Copyright (c) 2020 ${'Someone Else '.repeat(30)}\n\n${MIT_BODY}`],
  ];
  for (const [name, text] of refuse) {
    it(`unclassified: ${name}`, () => {
      assert.equal(classifyLicenseText(text), null);
    });
  }
  const accept: ReadonlyArray<readonly [string, string]> = [
    ['several holders, an address and a URL', 'Copyright (c) 2010-2020 Foo, Bar and contributors <x@y.example> (https://foo.example)'],
    ['a project-style notice', 'Copyright (c) Node.js contributors. All rights reserved.'],
    ['a foundation notice', 'Copyright JS Foundation and other contributors <https://js.foundation/>'],
    ['a year range with "present"', 'Copyright (c) 2014-present, Example, Inc.'],
  ];
  for (const [name, notice] of accept) {
    it(`still MIT: ${name}`, () => {
      assert.equal(classifyLicenseText(`The MIT License (MIT)\n\n${notice}\n\n${MIT_BODY}`), 'MIT');
    });
  }
  it('collectLicenses reports such a package as unknown', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', {}), files: { LICENSE: `Copyright 2020 Foo. Commercial use requires a paid license.\n\n${MIT_BODY}` } }]);
      assert.equal(only(await collectLicenses(dir), 'a').source, 'unknown');
    });
  });
});

describe('adversarial: a license file that is a symlink is not the package\'s own license', () => {
  it('a LICENSE symlinked to a text outside the package is not trusted (and cannot be used to read arbitrary files)', async (t) => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', {}) }]);
      await put(join(dir, 'outside', 'MIT.txt'), `MIT License\n\nCopyright (c) 2020 Someone Else\n\n${MIT_BODY}`);
      try {
        await symlink(join(dir, 'outside', 'MIT.txt'), join(dir, 'node_modules', 'a', 'LICENSE'));
      } catch {
        t.skip('symlink creation is not permitted here');
        return;
      }
      const p = only(await collectLicenses(dir), 'a');
      assert.deepEqual([p.license, p.source], ['unknown', 'unknown']);
    });
  });
  it('a regular LICENSE next to it is still classified', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', {}), files: { LICENSE: `MIT License\n\nCopyright (c) 2020 Foo\n\n${MIT_BODY}` } }]);
      assert.equal(only(await collectLicenses(dir), 'a').license, 'MIT');
    });
  });
});

describe('adversarial: one name@version installed twice with different licenses', () => {
  it('is not silently reported with the permissive copy', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [
        { key: 'node_modules/x', manifest: manifestOf('x', { license: 'MIT' }) },
        { key: 'node_modules/y', manifest: manifestOf('y', { license: 'MIT' }) },
        { key: 'node_modules/y/node_modules/x', manifest: manifestOf('x', { license: 'GPL-3.0-only' }) },
      ]);
      const result = await collectLicenses(dir);
      const x = only(result, 'x');
      assert.equal(x.source, 'unknown', JSON.stringify(x));
      assert.ok(result.unknown.includes('x@1.0.0'));
      assert.deepEqual(blockingPackages(result).map((p) => p.name), ['x']);
    });
  });
  it('identical copies still merge into one entry', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [
        { key: 'node_modules/x', manifest: manifestOf('x', { license: 'MIT' }) },
        { key: 'node_modules/y', manifest: manifestOf('y', { license: 'MIT' }) },
        { key: 'node_modules/y/node_modules/x', manifest: manifestOf('x', { license: 'MIT' }) },
      ]);
      const result = await collectLicenses(dir);
      assert.equal(result.packages.filter((p) => p.name === 'x').length, 1);
      assert.equal(only(result, 'x').license, 'MIT');
    });
  });
});

describe('adversarial: optional packages that are not installed on this platform', () => {
  it('are still listed when the lockfile records a non-permissive license for them (the gate cannot be dodged by platform)', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [
        { key: 'node_modules/ok', manifest: manifestOf('ok', { license: 'MIT' }) },
        { key: 'node_modules/winonly', lock: { optional: true, license: 'GPL-3.0-only', os: ['win32'] } },
      ]);
      const result = await collectLicenses(dir);
      const p = only(result, 'winonly');
      assert.equal(p.license, 'GPL-3.0-only');
      assert.equal(p.dev, false);
      assert.deepEqual(blockingPackages(result).map((q) => q.name), ['winonly']);
    });
  });
  it('stay omitted when absent and permissive or undeclared (platform binaries are not a gap)', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [
        { key: 'node_modules/ok', manifest: manifestOf('ok', { license: 'MIT' }) },
        { key: 'node_modules/bin-a', lock: { optional: true, license: 'Apache-2.0', os: ['aix'] } },
        { key: 'node_modules/bin-b', lock: { optional: true, os: ['sunos'] } },
      ]);
      assert.deepEqual((await collectLicenses(dir)).packages.map((p) => p.name), ['ok']);
    });
  });
  it('a non-permissive dev-only optional package is listed as dev and never blocks', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/devbin', lock: { optional: true, dev: true, license: 'AGPL-3.0-only' } }]);
      const result = await collectLicenses(dir);
      assert.equal(only(result, 'devbin').dev, true);
      assert.deepEqual(blockingPackages(result), []);
    });
  });
});

describe('adversarial: report text cannot be spoofed with invisible or direction-changing characters', () => {
  const nasty = ['\u202e', '\u202d', '\u2066', '\u2069', '\u200e', '\u200f', '\u200b', '\u2028', '\u2029', '\ufeff', '\u00ad', '\u061c'];
  it('sanitizeForTerminal removes control, bidi and zero-width characters', () => {
    for (const ch of nasty) assert.equal(sanitizeForTerminal(`a${ch}b`), 'a b', `U+${ch.codePointAt(0)?.toString(16)}`);
    assert.equal(sanitizeForTerminal('x\u001b[2Jy\nz\r\u0007'), 'x [2Jy z');
    assert.equal(sanitizeForTerminal('plain 日本語 text'), 'plain 日本語 text');
  });
  it('the markdown report contains none of them, whatever the package declares', async () => {
    await withTempDir(async (dir) => {
      const hostile = nasty.join('');
      await makeProject(dir, [
        { key: 'node_modules/a', lock: { name: `evil${hostile}name` }, manifest: manifestOf('a', { version: `1.0.0${hostile}`, license: `MIT${hostile}` }) },
      ]);
      const report = formatLicenseReport(await collectLicenses(dir));
      for (const ch of nasty) assert.equal(report.includes(ch), false, `U+${ch.codePointAt(0)?.toString(16)} leaked into the report`);
      assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(report), false);
    });
  });
});

describe('scripts/licenses.mjs: hostile package metadata cannot write to the terminal or the CI log', () => {
  function findLauncher(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 10; depth++) {
      const candidate = join(dir, 'scripts', 'licenses.mjs');
      if (existsSync(candidate)) return candidate;
      dir = dirname(dir);
    }
    throw new Error('scripts/licenses.mjs not found above the test file');
  }
  const compiledSrc = fileURLToPath(new URL('../../src', import.meta.url));
  let base: string;
  let launcher: string;

  before(async () => {
    base = await mkdtemp(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-test-licenses-adv-'));
    await mkdir(join(base, 'scripts'), { recursive: true });
    await copyFile(findLauncher(), join(base, 'scripts', 'licenses.mjs'));
    await writeFile(join(base, 'package.json'), '{"type":"module"}');
    await cp(compiledSrc, join(base, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });
    launcher = join(base, 'scripts', 'licenses.mjs');
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [launcher, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
      return { code: 0, stdout, stderr };
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'number' && 'stdout' in e && 'stderr' in e) {
        return { code: e.code, stdout: String(e.stdout), stderr: String(e.stderr) };
      }
      throw e;
    }
  }

  it('stderr names the blocking package without raw escape sequences, line breaks or CI workflow commands', async () => {
    await withTempDir(async (dir) => {
      const evil = 'evil\u001b]0;PWNED\u0007\n::add-mask::secret\r\u202e';
      await makeProject(dir, [
        {
          key: 'node_modules/a',
          lock: { name: evil },
          manifest: manifestOf('a', { version: `1.0.0${evil}`, license: 'GPL-3.0-only' }),
        },
      ]);
      const r = await run(['--root', dir], dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^licenses: 1 runtime package\(s\) with an unknown or non-permissive license: /);
      assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/.test(r.stderr), false, JSON.stringify(r.stderr));
      assert.equal(r.stderr.trimEnd().split('\n').length, 1, 'stderr must be one line');
      assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/.test(r.stdout), false, 'stdout report must be clean too');
    });
  });

  it('--json keeps the exact metadata, JSON-escaped', async () => {
    await withTempDir(async (dir) => {
      const evil = 'x\u001b[2Jy';
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', { version: `1.0.0${evil}`, license: 'GPL-3.0-only' }) }]);
      const r = await run(['--json', '--root', dir], dir);
      assert.equal(r.code, 1);
      assert.equal(r.stdout.includes('\u001b'), false, 'JSON output must not contain raw ESC');
      const data = JSON.parse(r.stdout) as { packages: Array<{ version: string }> };
      assert.equal(data.packages[0]?.version, `1.0.0${evil}`);
    });
  });
});
