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
import { cp, copyFile, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
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

// ===================================================================================================
// Second adversarial pass (continuation of the review above).
// ===================================================================================================

describe('adversarial: non-SPDX strings joined by any separator are checked word by word', () => {
  const restricted: ReadonlyArray<readonly [string, string]> = [
    ['MIT|GPL-3.0', 'GPL'],
    ['MIT&GPL-3.0', 'GPL'],
    ['MIT+GPL-3.0', 'GPL'],
    ['"GPL-3.0"', 'GPL'],
    ["'LGPL-2.1'", 'LGPL'],
    ['[GPL-3.0]', 'GPL'],
    ['{AGPL-3.0}', 'AGPL'],
    ['<AGPL-3.0>', 'AGPL'],
    ['MIT:GPL-3.0', 'GPL'],
    ['MIT\\GPL-3.0', 'GPL'],
    ['MIT​GPL-3.0', 'GPL'],
    ['Apache-2.0|SSPL-1.0', 'SSPL'],
    ['ISC&BUSL-1.1', 'BUSL'],
  ];
  for (const [license, family] of restricted) {
    it(`${JSON.stringify(license)} is ${family}`, () => {
      assert.equal(nonPermissiveFamily(license), family);
    });
  }
  for (const license of ['MIT|Apache-2.0', 'MIT&ISC', 'MIT+', 'BSD-2-Clause+', '"MIT"', '[Apache-2.0]', 'MIT:ISC']) {
    it(`${JSON.stringify(license)} is not flagged`, () => {
      assert.equal(nonPermissiveFamily(license), null);
    });
  }
});

describe('adversarial: spellings of "unlicensed" and custom references', () => {
  for (const [license, family] of [
    ['UNLICENCED', 'UNLICENSED'],
    ['unlicenced', 'UNLICENSED'],
    ['UNLICENSED', 'UNLICENSED'],
    ['DocumentRef-tool-1.2:LicenseRef-Proprietary', 'custom license reference'],
    ['LicenseRef-Proprietary', 'custom license reference'],
    ['MIT AND DocumentRef-x:LicenseRef-y', 'custom license reference'],
  ] as const) {
    it(`${license} is ${family}`, () => {
      assert.equal(nonPermissiveFamily(license), family);
    });
  }
  it('Unlicense (the public-domain dedication) is not "unlicensed"', () => {
    assert.equal(nonPermissiveFamily('Unlicense'), null);
  });
});

describe('adversarial: the party-name slots of a BSD text cannot carry a condition', () => {
  const head = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
`;
  const endorsement = (name: string): string =>
    `\n3. Neither the name of ${name} nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n`;
  const disclaimer = (name: string): string => `
THIS SOFTWARE IS PROVIDED BY ${name} "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL ${name} BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;
  const bsd2 = (name: string): string => `Copyright (c) 2020 Example Holder\n\n${head}${disclaimer(name)}`;
  const bsd3 = (endorsed: string, name: string): string => `Copyright (c) 2020 Example Holder\n\n${head}${endorsement(endorsed)}${disclaimer(name)}`;

  for (const name of ['THE COPYRIGHT HOLDER', 'THE REGENTS OF THE UNIVERSITY OF CALIFORNIA', 'XEROX PALO ALTO RESEARCH CENTER', 'MICROSOFT RESEARCH', 'THE AUTHOR(S)', 'EXAMPLE HOLDER, INC.']) {
    it(`ordinary party name still classifies: ${name}`, () => {
      assert.equal(classifyLicenseText(bsd2(name)), 'BSD-2-Clause');
      assert.equal(classifyLicenseText(bsd3(name.toLowerCase(), name)), 'BSD-3-Clause');
    });
  }
  for (const condition of [
    'the author but commercial use requires a paid license',
    'the author except for commercial use',
    'the author unless a fee is paid',
    'the author for non-commercial purposes only',
    'the author but no military use',
    'the author, redistribution prohibited',
  ]) {
    it(`a condition in the disclaimer slot is not a name: ${condition}`, () => {
      assert.equal(classifyLicenseText(bsd2(condition.toUpperCase())), null);
      assert.equal(classifyLicenseText(bsd3('the author', condition.toUpperCase())), null);
    });
    it(`a condition in the endorsement slot is not a name: ${condition}`, () => {
      assert.equal(classifyLicenseText(bsd3(condition, 'THE AUTHOR')), null);
    });
  }
  it('collectLicenses reports such a package as unknown', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', {}), files: { LICENSE: bsd2('THE AUTHOR BUT COMMERCIAL USE REQUIRES A PAID LICENSE') } }]);
      assert.equal(only(await collectLicenses(dir), 'a').source, 'unknown');
    });
  });
});

/** The unmodified text, as published by the Apache Software Foundation (identical in 40 of the 46 copies found on the review machine). */
const APACHE_2_0 = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
`;

describe('adversarial: Apache-2.0 is recognised only when the whole text is unmodified', () => {
  const body = APACHE_2_0.slice(0, APACHE_2_0.indexOf('APPENDIX: How to apply'));
  /** TypeScript ships the same text without the (a)-(d) list markers of section 4 and without the appendix. */
  const markerless = body.replace(/^(\s*)\([a-d]\) /gm, '$1');
  const filledAppendix = APACHE_2_0.replace('Copyright [yyyy] [name of copyright owner]', 'Copyright 2020 Example Holder, Inc.');
  /** The layout Playwright ships: notice lines in place of the placeholder. */
  const portionsAppendix = APACHE_2_0.replace('Copyright [yyyy] [name of copyright owner]', 'Portions Copyright (c) Example Corporation.\n   Portions Copyright 2017 Other Inc.');

  it('the genuine text classifies, in every layout it is found in', () => {
    assert.equal(classifyLicenseText(APACHE_2_0), 'Apache-2.0');
    assert.equal(classifyLicenseText(APACHE_2_0.replace(/\n/g, '\r\n')), 'Apache-2.0');
    assert.equal(classifyLicenseText(`﻿${APACHE_2_0}`), 'Apache-2.0');
    assert.equal(classifyLicenseText(body), 'Apache-2.0');
    assert.equal(classifyLicenseText(markerless), 'Apache-2.0');
    assert.equal(classifyLicenseText(filledAppendix), 'Apache-2.0');
    assert.equal(classifyLicenseText(portionsAppendix), 'Apache-2.0');
    assert.equal(classifyLicenseText(APACHE_2_0.replace(/^ +/gm, '').replace(/\n(?!\n)/g, ' ')), 'Apache-2.0');
  });

  const modified: ReadonlyArray<readonly [string, string]> = [
    ['a sentence added to section 2', APACHE_2_0.replace('2. Grant of Copyright License.', '2. Grant of Copyright License. Commercial use requires a paid license.')],
    ['a sentence added to section 4', APACHE_2_0.replace('4. Redistribution.', '4. Redistribution. Redistribution is prohibited.')],
    ['a sentence added just before the end marker', APACHE_2_0.replace('END OF TERMS AND CONDITIONS', 'Use by competitors is not permitted.\n\n   END OF TERMS AND CONDITIONS')],
    ['one word changed (perpetual -> revocable)', APACHE_2_0.replace('perpetual,', 'revocable,')],
    ['the trademark clause inverted', APACHE_2_0.replace('This License does not grant permission', 'This License grants permission')],
    ['a clause deleted (the warranty disclaimer title)', APACHE_2_0.replace('7. Disclaimer of Warranty.', '')],
    ['text after the appendix', `${APACHE_2_0}\n   Additional term: commercial use is prohibited.\n`],
    ['text appended to the appendix boilerplate', APACHE_2_0.replace('limitations under the License.', 'limitations under the License. Commercial use prohibited.')],
    ['the appendix boilerplate altered', APACHE_2_0.replace('you may not use this file except in compliance with the License.', 'you may not use this file except for personal use.')],
    ['a condition in the appendix copyright notice', APACHE_2_0.replace('Copyright [yyyy] [name of copyright owner]', 'Copyright 2020 Example Holder. Commercial use requires a paid license.')],
    ['an appendix without any copyright notice', APACHE_2_0.replace('Copyright [yyyy] [name of copyright owner]', 'See the website.')],
    ['text after the end marker that is not the appendix', `${body}\n   Additional term: commercial use is prohibited.\n`],
    ['a copyright line before the header', `Copyright 2020 Example Holder\n\n${APACHE_2_0}`],
    ['a restriction before the header', `Commons Clause: no selling.\n\n${APACHE_2_0}`],
    ['the Apache 1.1 header on the 2.0 body', APACHE_2_0.replace('Version 2.0, January 2004', 'Version 1.1, January 2004')],
  ];
  for (const [name, text] of modified) {
    it(`unclassified: ${name}`, () => {
      assert.notEqual(text, APACHE_2_0, 'the fixture edit did not apply');
      assert.equal(classifyLicenseText(text), null);
    });
  }

  it('collectLicenses reports a package whose license file is a modified Apache text as unknown', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [
        { key: 'node_modules/ok', manifest: manifestOf('ok', {}), files: { LICENSE: APACHE_2_0 } },
        { key: 'node_modules/bad', manifest: manifestOf('bad', {}), files: { LICENSE: `${APACHE_2_0}\n   Additional term: commercial use is prohibited.\n` } },
      ]);
      const result = await collectLicenses(dir);
      assert.deepEqual([only(result, 'ok').license, only(result, 'ok').source], ['Apache-2.0', 'license-file']);
      assert.equal(only(result, 'bad').source, 'unknown');
    });
  });
});

describe('adversarial: package metadata cannot inject markdown links, images or HTML into the report', () => {
  const evil = '![x](https://tracker.invalid/p.gif)<img src=x onerror=alert(1)>[y](javascript:alert(1))<https://autolink.invalid>';
  it('brackets and angle brackets from the name, version and license are escaped in every table and list', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [
        { key: 'node_modules/a', lock: { name: `a${evil}` }, manifest: manifestOf('a', { version: `1.0.0${evil}`, license: `MIT${evil}` }) },
        { key: 'node_modules/b', manifest: manifestOf('b', {}) },
      ]);
      const report = formatLicenseReport(await collectLicenses(dir));
      assert.equal(/(?<!\\)[\[\]<>]/.test(report), false, `unescaped markup characters in:\n${report}`);
      assert.ok(report.includes('!\\[x\\](https://tracker.invalid'), 'the text itself is still shown, escaped, not dropped');
    });
  });
  it('the same holds for the entry of a restricted license, which is printed in a list item', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', { license: `GPL-3.0-only ${evil}` }) }]);
      const report = formatLicenseReport(await collectLicenses(dir));
      const restrictedLine = report.split('\n').find((l) => l.startsWith('- **a@'));
      assert.ok(restrictedLine !== undefined, report);
      // the only unescaped brackets on that line are the family tag that the report itself writes: [GPL]
      assert.equal(restrictedLine.replace('[GPL]', '').match(/(?<!\\)[\[\]<>]/), null, restrictedLine);
    });
  });
});

describe('adversarial: an absurdly large package-lock.json is refused before it is read', () => {
  it('reports a clear error instead of loading hundreds of megabytes into memory', async () => {
    await withTempDir(async (dir) => {
      const lock = join(dir, 'package-lock.json');
      await writeFile(lock, '');
      await truncate(lock, 128 * 1024 * 1024 + 1); // sparse: no disk is used
      await assert.rejects(collectLicenses(dir), (e: unknown) => e instanceof Error && /too large/i.test(e.message) && 'code' in e && e.code === 'INVALID_ARGUMENT');
    });
  });
  it('a lockfile of ordinary size is unaffected', async () => {
    await withTempDir(async (dir) => {
      await makeProject(dir, [{ key: 'node_modules/a', manifest: manifestOf('a', { license: 'MIT' }) }]);
      assert.equal(only(await collectLicenses(dir), 'a').license, 'MIT');
    });
  });
});
