/**
 * Read-only run of the license inventory against THIS repository's real lockfile and node_modules.
 *
 * It prints the summary into the test output (so CI logs carry the dependency license picture, ADR-0008) but does
 * not assert any specific third-party license name or count: those belong to upstream packages and change with
 * upgrades. It asserts only structural invariants of the result. Nothing is written and nothing leaves the machine.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { blockingPackages, collectLicenses, formatLicenseReport } from '../../src/devtools/licenses.js';
import type { LicenseCollection } from '../../src/devtools/licenses.js';

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    // Both markers: the compiled output directory contains src/ but no package.json.
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'package-lock.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repository root (package.json + package-lock.json) not found above the test file');
}

describe('license inventory of this repository (read-only)', () => {
  const root = findRepoRoot();
  let result: LicenseCollection;

  before(async () => {
    result = await collectLicenses(root);
  });

  it('inventories the installed dependency tree and prints the summary', (t) => {
    const runtime = result.packages.filter((p) => !p.dev).length;
    const lines = [
      `packages: ${result.packages.length} (runtime ${runtime}, dev ${result.packages.length - runtime})`,
      ...Object.entries(result.summary).map(([license, count]) => `  ${count.toString().padStart(4)}  ${license}`),
      `unknown: ${result.unknown.length === 0 ? 'none' : result.unknown.join(', ')}`,
      `release gate (runtime packages that are unknown or non-permissive): ${blockingPackages(result).length}`,
    ];
    for (const line of lines) t.diagnostic(line);
    assert.ok(result.packages.length > 0, 'the lockfile lists no installed packages');
  });

  it('has well-formed, sorted, de-duplicated entries', () => {
    const seen = new Set<string>();
    let previous = '';
    for (const p of result.packages) {
      assert.ok(p.name !== '' && p.version !== '' && p.license !== '', `incomplete entry ${JSON.stringify(p)}`);
      assert.ok(['package.json', 'license-file', 'unknown'].includes(p.source));
      assert.equal(p.license === 'unknown', p.source === 'unknown', `license/source disagree for ${p.name}@${p.version}`);
      const id = `${p.name}@${p.version}`;
      assert.equal(seen.has(id), false, `duplicate ${id}`);
      seen.add(id);
      const key = `${p.name}\u0000${p.version}`;
      assert.ok(previous < key, `not sorted at ${id}`);
      previous = key;
    }
  });

  it('summary and unknown list are consistent with the package list', () => {
    assert.equal(Object.values(result.summary).reduce((sum, n) => sum + n, 0), result.packages.length);
    for (const [license, count] of Object.entries(result.summary)) {
      assert.equal(result.packages.filter((p) => p.license === license).length, count, license);
    }
    assert.deepEqual(result.unknown, result.packages.filter((p) => p.source === 'unknown').map((p) => `${p.name}@${p.version}`));
    assert.deepEqual(Object.keys(result.summary), [...Object.keys(result.summary)].sort());
  });

  it('every direct runtime dependency of package.json is present and not marked dev', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const found = result.packages.find((p) => p.name === name);
      assert.ok(found !== undefined, `${name} missing from the inventory`);
      assert.equal(found.dev, false, `${name} is a runtime dependency but was reported as dev`);
    }
  });

  it('renders a deterministic report that mentions every package once in the table', () => {
    const report = formatLicenseReport(result);
    assert.equal(formatLicenseReport(result), report);
    assert.match(report, /^# Dependency license report\n/);
    assert.equal(report.includes(root), false, 'the report must not contain the checkout path');
    const lines = report.slice(report.indexOf('## All packages')).split('\n');
    const header = lines.findIndex((l) => l.startsWith('| License | Package |'));
    assert.ok(header >= 0, 'package table header not found');
    const rows = lines.slice(header + 2).filter((l) => l.startsWith('| '));
    assert.equal(rows.length, result.packages.length);
  });
});
