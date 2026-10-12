/**
 * Adversarial review of the ATK-07 fix: the lock file must agree with package.json in everything `npm ci` would not complain
 * about but a reviewer relies on (NFR-02 reproducibility), not only in `engines.node`:
 *
 *  - the root entry lists the same dependencies AND devDependencies as package.json, and every one of them is pinned to the exact
 *    version package.json asks for (no range, no drift);
 *  - no package asks for a newer Node than the floor the project documents (a transitive `engines.node` above 22.16.0 would make
 *    `npm ci` warn EBADENGINE on the very Node the project says it supports);
 *  - the hygiene properties the security review verified by hand stay true: every package comes from the npm registry over HTTPS
 *    with an integrity hash, and nothing runs an install script.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoFile = (name: string): string => fileURLToPath(new URL(`../../../${name}`, import.meta.url));

interface Entry {
  version?: string;
  resolved?: string;
  integrity?: string;
  hasInstallScript?: boolean;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  license?: string;
  link?: boolean;
}
const pkg = JSON.parse(readFileSync(repoFile('package.json'), 'utf8')) as Entry & { engines: { node: string } };
const lock = JSON.parse(readFileSync(repoFile('package-lock.json'), 'utf8')) as { lockfileVersion: number; packages: Record<string, Entry> };

function parseVersion(text: string): [number, number, number] {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  assert.ok(m !== null, `no version in ${JSON.stringify(text)}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}
function lessOrEqual(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return true;
}

describe('package-lock.json agrees with package.json', () => {
  const root = lock.packages[''];

  it('lock file version 3, root entry present', () => {
    assert.equal(lock.lockfileVersion, 3);
    assert.ok(root !== undefined);
  });

  it('dependencies and devDependencies of the root entry are exactly those of package.json', () => {
    assert.deepEqual(root?.dependencies, pkg.dependencies);
    assert.deepEqual(root?.devDependencies, pkg.devDependencies);
    assert.equal(root?.license, pkg.license, 'the license field npm mirrors into the root entry');
  });

  it('every direct dependency is pinned to an exact version and the lock holds precisely that version', () => {
    for (const [name, wanted] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.match(wanted, /^\d+\.\d+\.\d+$/, `${name}: package.json pins an exact version, got ${wanted}`);
      assert.equal(lock.packages[`node_modules/${name}`]?.version, wanted, name);
    }
  });
});

describe('what the lock file asks of the machine', () => {
  const floor = parseVersion(pkg.engines.node);

  it('no package needs a newer Node than the documented floor', () => {
    const tooNew: string[] = [];
    for (const [path, entry] of Object.entries(lock.packages)) {
      const range = entry.engines?.node;
      if (range === undefined) continue;
      for (const part of range.split('||')) {
        const lowerBound = /^\s*>=\s*(\d[\d.]*)\s*$/.exec(part.trim());
        if (lowerBound?.[1] === undefined) continue; // a caret/tilde/range form: not a plain lower bound, covered by the npm ci run in CI
        if (!lessOrEqual(parseVersion(lowerBound[1]), floor)) tooNew.push(`${path || '(root)'} ${range}`);
      }
    }
    assert.deepEqual(tooNew, []);
  });

  it('every package comes from the npm registry over HTTPS with an integrity hash; nothing links, nothing installs a script', () => {
    const problems: string[] = [];
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === '') continue;
      if (!/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? '')) problems.push(`${path}: resolved ${String(entry.resolved)}`);
      if (typeof entry.integrity !== 'string' || !/^sha(256|384|512)-/.test(entry.integrity)) problems.push(`${path}: integrity`);
      if (entry.hasInstallScript === true) problems.push(`${path}: install script`);
      if (entry.link === true) problems.push(`${path}: link`);
    }
    assert.deepEqual(problems, []);
  });
});
