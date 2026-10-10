/**
 * ADR-0008 `npm run licenses`: collectLicenses / formatLicenseReport / blockingPackages.
 * Every project here is fabricated in a temp directory (synthetic lock files, node_modules trees and license
 * texts); nothing is read from the real repository and nothing touches the network.
 */
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import { blockingPackages, collectLicenses, formatLicenseReport } from '../../src/devtools/licenses.js';
import type { LicenseCollection, LicensedPackage } from '../../src/devtools/licenses.js';
import { withTempDir } from '../helpers/tmp.js';

const SEED = 20261010;

// --- fixtures ---------------------------------------------------------------------------------------

const MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2024 Example Holder',
  '',
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

const ISC_TEXT = [
  'ISC License',
  '',
  'Copyright (c) 2024, Example Holder',
  '',
  'Permission to use, copy, modify, and/or distribute this software for any',
  'purpose with or without fee is hereby granted, provided that the above',
  'copyright notice and this permission notice appear in all copies.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH',
  'REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND',
  'FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,',
  'INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM',
  'LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR',
  'OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR',
  'PERFORMANCE OF THIS SOFTWARE.',
  '',
].join('\n');

const BSD2_TEXT = [
  'BSD 2-Clause License',
  '',
  'Copyright (c) 2024, Example Holder',
  'All rights reserved.',
  '',
  'Redistribution and use in source and binary forms, with or without',
  'modification, are permitted provided that the following conditions are met:',
  '',
  '1. Redistributions of source code must retain the above copyright notice, this',
  '   list of conditions and the following disclaimer.',
  '',
  '2. Redistributions in binary form must reproduce the above copyright notice,',
  '   this list of conditions and the following disclaimer in the documentation',
  '   and/or other materials provided with the distribution.',
  '',
  'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
  'AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE',
  'IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE',
  'DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE',
  'FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL',
  'DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR',
  'SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER',
  'CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,',
  'OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE',
  'OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
  '',
].join('\n');

/** Not a license of any kind: a GPL-style notice header. Must never be classified. */
const GPL_NOTICE = [
  'GNU GENERAL PUBLIC LICENSE',
  'Version 3, 29 June 2007',
  '',
  'This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License.',
  '',
].join('\n');

interface FakePackage {
  name: string;
  /** Lockfile key; defaults to `node_modules/<name>`. */
  key?: string;
  version?: string;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  link?: boolean;
  /** The `name` field npm records in the lock for `npm:` alias installs. */
  lockName?: string;
  /** package.json content; a string is written verbatim (corrupt on purpose); false = not installed on disk. */
  manifest?: Record<string, unknown> | string | false;
  /** Extra files inside the package directory. */
  files?: Record<string, string>;
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function buildProject(dir: string, packages: readonly FakePackage[], opts: { lockfileVersion?: number; nodeModules?: boolean } = {}): Promise<void> {
  const entries: Record<string, unknown> = { '': { name: 'fixture-app', version: '1.0.0', dependencies: {} } };
  for (const p of packages) {
    const key = p.key ?? `node_modules/${p.name}`;
    const version = p.version ?? '1.0.0';
    const entry: Record<string, unknown> = { version };
    if (p.link === true) entry['link'] = true;
    if (p.dev === true) entry['dev'] = true;
    if (p.optional === true) entry['optional'] = true;
    if (p.devOptional === true) entry['devOptional'] = true;
    if (p.lockName !== undefined) entry['name'] = p.lockName;
    entries[key] = entry;
    if (p.manifest === false) continue;
    const manifest = p.manifest === undefined ? { name: p.name, version } : p.manifest;
    await put(join(dir, key, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ name: p.name, version, ...manifest }));
    for (const [rel, text] of Object.entries(p.files ?? {})) await put(join(dir, key, rel), text);
  }
  await put(join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0', lockfileVersion: opts.lockfileVersion ?? 3, requires: true, packages: entries }));
  if (opts.nodeModules !== false) await mkdir(join(dir, 'node_modules'), { recursive: true });
}

const byName = (r: LicenseCollection, name: string): LicensedPackage => {
  const found = r.packages.find((p) => p.name === name);
  assert.ok(found !== undefined, `package ${name} missing from ${r.packages.map((p) => p.name).join(',')}`);
  return found;
};

function expectInvalidArgument(promise: Promise<unknown>, message: RegExp): Promise<void> {
  return assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    assert.equal(e.code, 'INVALID_ARGUMENT');
    assert.match(e.message, message);
    return true;
  });
}

// --- collectLicenses --------------------------------------------------------------------------------

describe('collectLicenses: declared licenses', () => {
  it('keeps strings and SPDX expressions verbatim and understands the legacy object and array forms', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'a-mit', manifest: { license: 'MIT' } },
        { name: 'b-expr', manifest: { license: '(MIT OR Apache-2.0)' } },
        { name: 'c-with', manifest: { license: 'Apache-2.0 WITH LLVM-exception' } },
        { name: 'd-legacy-object', manifest: { license: { type: 'ISC', url: 'https://example.test/license' } } },
        { name: 'e-legacy-one', manifest: { licenses: [{ type: 'BSD-3-Clause', url: 'https://example.test/l' }] } },
        { name: 'f-legacy-two', manifest: { licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] } },
        { name: 'g-legacy-strings', manifest: { licenses: ['MIT', 'MIT'] } },
        { name: 'h-spaces', manifest: { license: '  MIT  ' } },
        { name: 'i-license-wins', manifest: { license: 'ISC', licenses: [{ type: 'MIT' }] } },
      ]);
      const r = await collectLicenses(dir);
      const got = Object.fromEntries(r.packages.map((p) => [p.name, [p.license, p.source]]));
      assert.deepEqual(got, {
        'a-mit': ['MIT', 'package.json'],
        'b-expr': ['(MIT OR Apache-2.0)', 'package.json'],
        'c-with': ['Apache-2.0 WITH LLVM-exception', 'package.json'],
        'd-legacy-object': ['ISC', 'package.json'],
        'e-legacy-one': ['BSD-3-Clause', 'package.json'],
        'f-legacy-two': ['(MIT OR Apache-2.0)', 'package.json'],
        'g-legacy-strings': ['MIT', 'package.json'],
        'h-spaces': ['MIT', 'package.json'],
        'i-license-wins': ['ISC', 'package.json'],
      });
      assert.deepEqual(r.unknown, []);
      assert.deepEqual(r.summary, { '(MIT OR Apache-2.0)': 2, 'Apache-2.0 WITH LLVM-exception': 1, 'BSD-3-Clause': 1, ISC: 2, MIT: 3 });
    });
  });

  it('records name, installed version and the dev flag from the lockfile', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'runtime-dep', version: '2.3.4', manifest: { license: 'MIT' } },
        { name: 'dev-dep', version: '0.1.0', dev: true, manifest: { license: 'MIT' } },
        { name: '@scope/pkg', version: '5.0.0', manifest: { license: 'ISC' } },
        { name: 'dev-or-optional', version: '1.1.1', devOptional: true, manifest: { license: 'MIT' } },
      ]);
      const r = await collectLicenses(dir);
      assert.deepEqual(r.packages.map((p) => [p.name, p.version, p.dev]), [
        ['@scope/pkg', '5.0.0', false],
        ['dev-dep', '0.1.0', true],
        ['dev-or-optional', '1.1.1', false], // devOptional is deliberately reported as runtime
        ['runtime-dep', '2.3.4', false],
      ]);
    });
  });

  it('prefers the installed version over the lock when they disagree, and falls back to the lock when the manifest has none', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'drifted', version: '1.0.0', manifest: { license: 'MIT', version: '1.0.1' } },
        { name: 'no-version', version: '3.0.0', manifest: '{"license":"MIT"}' },
      ]);
      const r = await collectLicenses(dir);
      assert.equal(byName(r, 'drifted').version, '1.0.1');
      assert.equal(byName(r, 'no-version').version, '3.0.0');
    });
  });

  it('uses the aliased real name that npm writes into the lock', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [{ name: 'my-alias', lockName: 'real-package', manifest: { license: 'MIT' } }]);
      assert.deepEqual((await collectLicenses(dir)).packages.map((p) => p.name), ['real-package']);
    });
  });

  it('lists a license string such as "__proto__" as an own key of the summary', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [{ name: 'odd', manifest: { license: '__proto__' } }]);
      const r = await collectLicenses(dir);
      assert.deepEqual(Object.keys(r.summary), ['__proto__']);
      assert.equal(Object.getPrototypeOf(r.summary), Object.prototype);
    });
  });
});

describe('collectLicenses: license files (conservative)', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, string>, string, string]> = [
    ['MIT in LICENSE', { LICENSE: MIT_TEXT }, 'MIT', 'license-file'],
    ['MIT in LICENSE.md', { 'LICENSE.md': MIT_TEXT }, 'MIT', 'license-file'],
    ['MIT in a British-spelled LICENCE.txt', { 'LICENCE.txt': MIT_TEXT }, 'MIT', 'license-file'],
    ['ISC in COPYING', { COPYING: ISC_TEXT }, 'ISC', 'license-file'],
    ['BSD-2-Clause in license', { license: BSD2_TEXT }, 'BSD-2-Clause', 'license-file'],
    ['the same license in two files', { LICENSE: MIT_TEXT, 'LICENSE-MIT': MIT_TEXT }, 'MIT', 'license-file'],
    ['GPL notice is never classified', { LICENSE: GPL_NOTICE }, 'unknown', 'unknown'],
    ['MIT with an added restriction is not an obvious case', { LICENSE: `${MIT_TEXT}\nThe Software shall not be used by anyone named Bob.\n` }, 'unknown', 'unknown'],
    ['two different licenses (dual-license layout) are not guessed', { 'LICENSE-MIT': MIT_TEXT, 'LICENSE-ISC': ISC_TEXT }, 'unknown', 'unknown'],
    ['one recognised and one unrecognised file', { LICENSE: MIT_TEXT, 'COPYING.LESSER': GPL_NOTICE }, 'unknown', 'unknown'],
    ['an empty LICENSE file', { LICENSE: '' }, 'unknown', 'unknown'],
    ['no license file at all', { 'README.md': MIT_TEXT }, 'unknown', 'unknown'],
    ['a script named license-checker.js is not a license text', { 'license-checker.js': MIT_TEXT }, 'unknown', 'unknown'],
  ];
  for (const [name, files, license, source] of cases) {
    it(name, async () => {
      await withTempDir(async (dir) => {
        await buildProject(dir, [{ name: 'p', files }]);
        const [p] = (await collectLicenses(dir)).packages;
        assert.ok(p !== undefined);
        assert.equal(p.license, license);
        assert.equal(p.source, source);
      });
    });
  }

  it('a declared license wins over the license file; "SEE LICENSE IN" and "unknown" defer to the file', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'declared', manifest: { license: 'Apache-2.0' }, files: { LICENSE: MIT_TEXT } },
        { name: 'see-license', manifest: { license: 'SEE LICENSE IN LICENSE.md' }, files: { 'LICENSE.md': ISC_TEXT } },
        { name: 'literal-unknown', manifest: { license: 'unknown' }, files: { LICENSE: BSD2_TEXT } },
        { name: 'see-license-no-file', manifest: { license: 'SEE LICENSE IN LICENSE.md' } },
      ]);
      const r = await collectLicenses(dir);
      assert.deepEqual(
        r.packages.map((p) => [p.name, p.license, p.source]),
        [
          ['declared', 'Apache-2.0', 'package.json'],
          ['literal-unknown', 'BSD-2-Clause', 'license-file'],
          ['see-license', 'ISC', 'license-file'],
          ['see-license-no-file', 'unknown', 'unknown'],
        ],
      );
      assert.deepEqual(r.unknown, ['see-license-no-file@1.0.0']);
    });
  });

  it('ignores oversized license files', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [{ name: 'big', files: { LICENSE: `${MIT_TEXT}\n${'x'.repeat(200 * 1024)}` } }]);
      assert.equal((await collectLicenses(dir)).packages[0]?.source, 'unknown');
    });
  });
});

describe('collectLicenses: packages missing from or odd on disk', () => {
  it('omits absent optional packages (other platforms) but reports other absent packages as unknown', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'present', manifest: { license: 'MIT' } },
        { name: 'other-platform', optional: true, dev: true, manifest: false },
        { name: 'missing-runtime', version: '9.9.9', manifest: false },
        { name: 'missing-dev', version: '8.8.8', dev: true, manifest: false },
      ]);
      const r = await collectLicenses(dir);
      assert.deepEqual(r.packages.map((p) => [p.name, p.version, p.license, p.source, p.dev]), [
        ['missing-dev', '8.8.8', 'unknown', 'unknown', true],
        ['missing-runtime', '9.9.9', 'unknown', 'unknown', false],
        ['present', '1.0.0', 'MIT', 'package.json', false],
      ]);
      assert.deepEqual(r.unknown, ['missing-dev@8.8.8', 'missing-runtime@9.9.9']);
    });
  });

  it('an installed optional package is included like any other', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [{ name: 'native-here', optional: true, manifest: { license: 'MIT' } }]);
      assert.deepEqual((await collectLicenses(dir)).packages.map((p) => p.name), ['native-here']);
    });
  });

  it('a corrupt or non-object package.json is unknown rather than an error', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'corrupt', manifest: '{ not json' },
        { name: 'array', manifest: '[1,2]' },
        { name: 'null-json', manifest: 'null' },
      ]);
      const r = await collectLicenses(dir);
      assert.deepEqual(r.packages.map((p) => [p.name, p.license]), [['array', 'unknown'], ['corrupt', 'unknown'], ['null-json', 'unknown']]);
    });
  });

  it('wrong-typed license fields are treated as absent', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'number', manifest: { license: 42 } },
        { name: 'empty', manifest: { license: '   ' } },
        { name: 'object-without-type', manifest: { license: { url: 'https://example.test' } } },
        { name: 'array-of-junk', manifest: { licenses: [1, null, {}, ''] } },
      ]);
      const r = await collectLicenses(dir);
      assert.deepEqual(r.packages.map((p) => p.license), ['unknown', 'unknown', 'unknown', 'unknown']);
    });
  });

  it('never reads outside the project root, even for a hostile lockfile key', async () => {
    await withTempDir(async (outer) => {
      const root = join(outer, 'project');
      await put(join(outer, 'secret', 'package.json'), JSON.stringify({ name: 'secret', version: '1.0.0', license: 'MIT' }));
      await buildProject(root, [{ name: 'escape', key: 'node_modules/../../secret', manifest: false }]);
      const [p] = (await collectLicenses(root)).packages;
      assert.ok(p !== undefined);
      assert.equal(p.license, 'unknown');
      assert.equal(p.source, 'unknown');
    });
  });
});

describe('collectLicenses: lockfile structure', () => {
  it('skips the root entry, workspace packages outside node_modules and link entries', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'real', manifest: { license: 'MIT' } },
        { name: 'workspace-pkg', key: 'packages/workspace-pkg', manifest: { license: 'GPL-3.0' } },
        { name: 'linked', link: true, manifest: false },
      ]);
      assert.deepEqual((await collectLicenses(dir)).packages.map((p) => p.name), ['real']);
    });
  });

  it('merges one name@version installed in several places: dev only if every copy is dev', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'dup', manifest: { license: 'MIT' }, dev: true },
        { name: 'dup', key: 'node_modules/host/node_modules/dup', manifest: { license: 'MIT' } },
        { name: 'dup-dev-only', manifest: { license: 'MIT' }, dev: true },
        { name: 'dup-dev-only', key: 'node_modules/host/node_modules/dup-dev-only', manifest: { license: 'MIT' }, dev: true },
        { name: 'host', manifest: { license: 'ISC' } },
      ]);
      const r = await collectLicenses(dir);
      assert.deepEqual(r.packages.map((p) => [p.name, p.dev]), [['dup', false], ['dup-dev-only', true], ['host', false]]);
    });
  });

  it('lists different versions of the same package separately', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'multi', version: '1.0.0', manifest: { license: 'MIT' } },
        { name: 'multi', version: '2.0.0', key: 'node_modules/host/node_modules/multi', manifest: { license: 'ISC' } },
      ]);
      assert.deepEqual((await collectLicenses(dir)).packages.map((p) => [p.name, p.version, p.license]), [
        ['multi', '1.0.0', 'MIT'],
        ['multi', '2.0.0', 'ISC'],
      ]);
    });
  });

  it('if one copy of a duplicate is unknown, the merged entry is unknown (never hides a gap)', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'dup', manifest: { license: 'MIT' } },
        { name: 'dup', key: 'node_modules/host/node_modules/dup', manifest: {} },
        { name: 'host', manifest: { license: 'ISC' } },
      ]);
      assert.equal(byName(await collectLicenses(dir), 'dup').source, 'unknown');
    });
  });

  it('accepts lockfileVersion 2 as well as 3', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [{ name: 'p', manifest: { license: 'MIT' } }], { lockfileVersion: 2 });
      assert.equal((await collectLicenses(dir)).packages.length, 1);
    });
  });

  it('an empty lock needs no node_modules and yields an empty result', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [], { nodeModules: false });
      assert.deepEqual(await collectLicenses(dir), { packages: [], summary: {}, unknown: [] });
    });
  });
});

describe('collectLicenses: errors are structured GcrErrors without absolute paths', () => {
  it('missing lockfile', async () => {
    await withTempDir(async (dir) => {
      await expectInvalidArgument(collectLicenses(dir), /package-lock\.json was not found/);
      await assert.rejects(collectLicenses(dir), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.message.includes(dir), false);
        assert.match(e.remedy ?? '', /npm install/);
        return true;
      });
    });
  });
  it('invalid JSON, non-object, lockfileVersion 1, no packages map', async () => {
    await withTempDir(async (dir) => {
      await put(join(dir, 'package-lock.json'), '{ nope');
      await expectInvalidArgument(collectLicenses(dir), /not valid JSON/);
      await put(join(dir, 'package-lock.json'), '[]');
      await expectInvalidArgument(collectLicenses(dir), /not a JSON object/);
      await put(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
      await expectInvalidArgument(collectLicenses(dir), /lockfileVersion 2 or 3/);
      await put(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
      await expectInvalidArgument(collectLicenses(dir), /lockfileVersion 2 or 3/);
    });
  });
  it('rejects other lockfile versions even when a "packages" map is present (no guessing at unknown formats)', async () => {
    await withTempDir(async (dir) => {
      for (const lockfileVersion of [1, 4, '3', null]) {
        await put(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion, packages: {} }));
        await expectInvalidArgument(collectLicenses(dir), /lockfileVersion 2 or 3/);
      }
    });
  });
  it('packages locked but node_modules absent', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [{ name: 'p', manifest: false }], { nodeModules: false });
      await expectInvalidArgument(collectLicenses(dir), /node_modules was not found/);
    });
  });
});

describe('collectLicenses: determinism', () => {
  it('is independent of lock key order and repeatable', async () => {
    await withTempDir(async (a) => {
      await withTempDir(async (b) => {
        const pkgs: FakePackage[] = [
          { name: 'zeta', manifest: { license: 'MIT' } },
          { name: 'alpha', manifest: { license: 'ISC' }, dev: true },
          { name: 'mid', manifest: {}, files: { LICENSE: MIT_TEXT } },
          { name: 'none', manifest: {} },
        ];
        await buildProject(a, pkgs);
        await buildProject(b, [...pkgs].reverse());
        const ra = await collectLicenses(a);
        assert.equal(JSON.stringify(ra), JSON.stringify(await collectLicenses(b)));
        assert.equal(JSON.stringify(ra), JSON.stringify(await collectLicenses(a)));
        assert.deepEqual(ra.packages.map((p) => p.name), ['alpha', 'mid', 'none', 'zeta']);
        assert.deepEqual(Object.keys(ra.summary), ['ISC', 'MIT', 'unknown']);
      });
    });
  });

  it('matches an independently computed expectation for random projects (property)', async () => {
    const licenseArb = fc.constantFrom<string | null>('MIT', 'ISC', 'Apache-2.0', '(MIT OR Apache-2.0)', 'GPL-3.0-only', 'UNLICENSED', null);
    const projectArb = fc.uniqueArray(
      fc.record({
        name: fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/),
        license: licenseArb,
        dev: fc.boolean(),
      }),
      { selector: (p) => p.name, minLength: 0, maxLength: 8 },
    );
    await fc.assert(
      fc.asyncProperty(projectArb, async (list) => {
        await withTempDir(async (dir) => {
          await buildProject(
            dir,
            list.map((p) => ({ name: p.name, dev: p.dev, manifest: p.license === null ? {} : { license: p.license } })),
          );
          const r = await collectLicenses(dir);
          const expected = [...list]
            .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
            .map((p) => [p.name, p.license ?? 'unknown', p.license === null ? 'unknown' : 'package.json', p.dev]);
          assert.deepEqual(r.packages.map((p) => [p.name, p.license, p.source, p.dev]), expected);
          assert.equal(Object.values(r.summary).reduce((s, n) => s + n, 0), r.packages.length);
          assert.deepEqual(r.unknown, list.filter((p) => p.license === null).map((p) => p.name).sort().map((n) => `${n}@1.0.0`));
          const blocking = blockingPackages(r).map((p) => p.name);
          const expectedBlocking = list
            .filter((p) => !p.dev && (p.license === null || p.license === 'GPL-3.0-only' || p.license === 'UNLICENSED'))
            .map((p) => p.name)
            .sort();
          assert.deepEqual(blocking, expectedBlocking);
        });
      }),
      { seed: SEED, numRuns: 25 },
    );
  });
});

// --- formatLicenseReport / blockingPackages ---------------------------------------------------------

function collection(rows: ReadonlyArray<readonly [name: string, version: string, license: string, source: LicensedPackage['source'], dev: boolean]>): LicenseCollection {
  const packages: LicensedPackage[] = rows.map(([name, version, license, source, dev]) => ({ name, version, license, source, dev }));
  const counts = new Map<string, number>();
  for (const p of packages) counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
  return {
    packages,
    summary: Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    unknown: packages.filter((p) => p.source === 'unknown').map((p) => `${p.name}@${p.version}`).sort(),
  };
}

describe('blockingPackages', () => {
  const rows = [
    ['rt-ok', '1.0.0', 'MIT', 'package.json', false],
    ['rt-unknown', '1.0.0', 'unknown', 'unknown', false],
    ['dev-unknown', '1.0.0', 'unknown', 'unknown', true],
    ['rt-gpl', '1.0.0', 'GPL-3.0-only', 'package.json', false],
    ['dev-gpl', '1.0.0', 'GPL-3.0-only', 'package.json', true],
    ['rt-choice', '1.0.0', '(MIT OR GPL-3.0-or-later)', 'package.json', false],
    ['rt-both', '1.0.0', '(MIT AND GPL-3.0-or-later)', 'package.json', false],
    ['rt-unlicensed', '1.0.0', 'UNLICENSED', 'package.json', false],
    ['rt-unlicense', '1.0.0', 'Unlicense', 'package.json', false],
    ['rt-file-mit', '1.0.0', 'MIT', 'license-file', false],
  ] as const;
  it('returns only runtime packages that are unknown or non-permissive', () => {
    assert.deepEqual(
      blockingPackages(collection(rows)).map((p) => p.name),
      ['rt-unknown', 'rt-gpl', 'rt-both', 'rt-unlicensed'],
    );
  });
  it('is empty for a clean runtime set even with problem dev packages', () => {
    assert.deepEqual(blockingPackages(collection(rows.filter((r) => r[0] === 'rt-ok' || r[4]))), []);
  });
});

describe('formatLicenseReport', () => {
  const rows = [
    ['zlib-like', '1.0.0', 'MIT', 'package.json', false],
    ['alpha', '2.0.0', 'Apache-2.0', 'package.json', false],
    ['beta', '1.0.0', 'MIT', 'license-file', true],
    ['gamma', '3.1.0', 'unknown', 'unknown', false],
    ['delta', '0.0.1', 'unknown', 'unknown', true],
    ['copyleft', '4.0.0', 'GPL-3.0-only', 'package.json', false],
    ['dev-copyleft', '4.0.0', 'AGPL-3.0-or-later', 'package.json', true],
    ['epsilon', '1.2.3', 'ISC', 'package.json', false],
  ] as const;

  it('lists unknown and non-permissive packages prominently, before the tables, with their scope', () => {
    const report = formatLicenseReport(collection(rows));
    const needs = report.indexOf('## Needs attention');
    const summary = report.indexOf('## Summary by license');
    const all = report.indexOf('## All packages');
    assert.ok(needs > 0 && needs < summary && summary < all, 'section order');
    const attention = report.slice(needs, summary);
    assert.match(attention, /### Unknown license \(2\)/);
    assert.match(attention, /\*\*delta@0\.0\.1\*\* \(dev\)/);
    assert.match(attention, /\*\*gamma@3\.1\.0\*\* \(runtime\)/);
    assert.match(attention, /### Non-permissive license.*\(2\)/);
    assert.match(attention, /\*\*copyleft@4\.0\.0\*\*: `GPL-3\.0-only` \[GPL\] \(runtime\)/);
    assert.match(attention, /\*\*dev-copyleft@4\.0\.0\*\*: `AGPL-3\.0-or-later` \[AGPL\] \(dev\)/);
    assert.match(report, /- Release gate: FAIL \(2 runtime package\(s\)/);
  });

  it('sorts the package table by license, then name', () => {
    const report = formatLicenseReport(collection(rows));
    const table = report.slice(report.indexOf('## All packages')).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| License') && !l.startsWith('| ---'));
    const order = table.map((l) => l.split(' | ').slice(0, 2).map((c) => c.replace(/^\| /, '')).join(' / '));
    assert.deepEqual(order, [
      'AGPL-3.0-or-later / dev-copyleft',
      'Apache-2.0 / alpha',
      'GPL-3.0-only / copyleft',
      'ISC / epsilon',
      'MIT / beta',
      'MIT / zlib-like',
      'unknown / delta',
      'unknown / gamma',
    ]);
  });

  it('summarises counts per license, sorted', () => {
    const report = formatLicenseReport(collection(rows));
    const section = report.slice(report.indexOf('## Summary by license'), report.indexOf('## All packages'));
    const lines = section.split('\n').filter((l) => /^\| [^-L]/.test(l));
    assert.deepEqual(lines, ['| AGPL-3.0-or-later | 1 |', '| Apache-2.0 | 1 |', '| GPL-3.0-only | 1 |', '| ISC | 1 |', '| MIT | 2 |', '| unknown | 2 |']);
  });

  it('says "None." and PASS when there is nothing to report, and ignores dev problems for the gate', () => {
    const clean = formatLicenseReport(collection([['a', '1.0.0', 'MIT', 'package.json', false], ['b', '1.0.0', 'ISC', 'license-file', false]]));
    assert.match(clean, /### Unknown license \(0\)\n\nNone\./);
    assert.match(clean, /- Release gate: PASS/);
    const devOnly = formatLicenseReport(collection([['a', '1.0.0', 'MIT', 'package.json', false], ['d', '1.0.0', 'unknown', 'unknown', true]]));
    assert.match(devOnly, /- Release gate: PASS/);
    assert.match(devOnly, /\*\*d@1\.0\.0\*\* \(dev\)/);
  });

  it('handles an empty result', () => {
    const report = formatLicenseReport({ packages: [], summary: {}, unknown: [] });
    assert.match(report, /- Packages: 0 \(runtime 0, dev 0\)/);
    assert.match(report, /- Release gate: PASS/);
  });

  it('neutralises markdown table syntax and terminal control characters in hostile metadata', () => {
    const hostile = 'MIT | `evil`\u001b[31m\nnext-line\u0007';
    const report = formatLicenseReport(collection([['pkg|name', '1.0.0', hostile, 'package.json', false]]));
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(report), false, 'control characters leaked into the report');
    assert.ok(report.includes('MIT \\| \\`evil\\`'), 'pipes and backticks must be escaped');
    const rows2 = report.split('\n').filter((l) => l.includes('pkg\\|name') && l.startsWith('|'));
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0]?.replace(/\\\|/g, '').split('|').length, 7, 'row keeps exactly five columns');
  });

  it('truncates absurdly long license strings', () => {
    const report = formatLicenseReport(collection([['p', '1.0.0', 'x'.repeat(5000), 'package.json', false]]));
    assert.ok(report.length < 5000);
    assert.match(report, /x\.\.\./);
  });

  it('is deterministic and contains no timestamps or absolute paths', async () => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [{ name: 'a', manifest: { license: 'MIT' } }, { name: 'b' }]);
      const r = await collectLicenses(dir);
      const first = formatLicenseReport(r);
      assert.equal(formatLicenseReport(r), first);
      assert.equal(first.includes(dir), false);
      assert.equal(/\b20\d\d-\d\d-\d\d/.test(first), false);
    });
  });

  it('does not mutate its input', () => {
    const input = collection(rows);
    const before = JSON.stringify(input);
    formatLicenseReport(input);
    assert.equal(JSON.stringify(input), before);
  });

  it('never throws for arbitrary license, name and version strings (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), fc.boolean(), (license, name, version, dev) => {
        const report = formatLicenseReport(collection([[name, version, license, 'package.json', dev]]));
        assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(report), false);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

describe('collectLicenses + formatLicenseReport end to end', () => {
  it('reports a realistic mixed project', async (t) => {
    await withTempDir(async (dir) => {
      await buildProject(dir, [
        { name: 'sdk-like', version: '1.2.3', manifest: { license: 'MIT' } },
        { name: 'validator', version: '4.5.6', manifest: { license: '(MIT OR Apache-2.0)' } },
        { name: 'old-style', version: '0.9.0', manifest: {}, files: { LICENSE: BSD2_TEXT } },
        { name: 'mystery', version: '0.0.1', manifest: {}, files: { README: 'no license here' } },
        { name: 'copyleft-dev', version: '2.0.0', dev: true, manifest: { license: 'LGPL-3.0' } },
        { name: 'symlinked-license', version: '1.0.0', manifest: {} },
      ]);
      try {
        await symlink(join(dir, 'node_modules', 'sdk-like', 'package.json'), join(dir, 'node_modules', 'symlinked-license', 'LICENSE'));
      } catch {
        t.diagnostic('symlink creation not permitted here; continuing without it');
      }
      const r = await collectLicenses(dir);
      assert.deepEqual(blockingPackages(r).map((p) => p.name), ['mystery', 'symlinked-license']);
      const report = formatLicenseReport(r);
      assert.match(report, /Release gate: FAIL \(2 runtime/);
      assert.match(report, /\*\*copyleft-dev@2\.0\.0\*\*: `LGPL-3\.0` \[LGPL\] \(dev\)/);
    });
  });
});
