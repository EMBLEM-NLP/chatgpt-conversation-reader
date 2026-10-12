/**
 * ATK-07: the root entry of package-lock.json carried `engines.node ">=22.13"` while package.json says ">=22.16.0" (the first
 * Node 22 whose bundled SQLite has FTS5, ADR-0012). `npm ci` accepted the mismatch without a word, so nothing flagged it.
 * The three places that state the minimum Node must agree: package.json, the lock file's root package, and what the code
 * (database opener, `gcr doctor`) enforces and reports.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { MIN_NODE_WITH_FTS5 } from '../../src/db/open.js';
import { Gcr } from '../../src/sdk/gcr.js';

// Compiled tests live at <repo>/<outDir>/test/security.
const repoFile = (name: string): string => fileURLToPath(new URL(`../../../${name}`, import.meta.url));

interface PackageJson {
  version?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
}
interface LockFile {
  lockfileVersion?: number;
  version?: string;
  packages?: Record<string, { version?: string; engines?: { node?: string }; dependencies?: Record<string, string> }>;
}

const pkg = JSON.parse(readFileSync(repoFile('package.json'), 'utf8')) as PackageJson;
const lock = JSON.parse(readFileSync(repoFile('package-lock.json'), 'utf8')) as LockFile;

describe('the declared Node floor is stated identically everywhere', () => {
  it('package-lock.json root engines.node equals package.json engines.node', () => {
    const declared = pkg.engines?.node;
    assert.equal(typeof declared, 'string', 'package.json declares engines.node');
    const root = lock.packages?.[''];
    assert.ok(root !== undefined, 'the lock file has a root package entry');
    assert.equal(root.engines?.node, declared, 'packages[""].engines.node of package-lock.json');
  });

  it('is the floor the database opener enforces (FTS5, ADR-0012) and the doctor reports', () => {
    const declared = pkg.engines?.node ?? '';
    const m = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(declared);
    assert.ok(m !== null, `engines.node is a simple ">=major.minor[.patch]" range, got ${JSON.stringify(declared)}`);
    const floor = `${m[1]}.${m[2]}.${m[3] ?? '0'}`;
    assert.equal(floor, MIN_NODE_WITH_FTS5, 'src/db/open.ts MIN_NODE_WITH_FTS5');
    const reported = Gcr.doctor().node.requiredRange;
    const r = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(reported);
    assert.ok(r !== null, `doctor requiredRange is a simple range, got ${JSON.stringify(reported)}`);
    assert.equal(`${r[1]}.${r[2]}.${r[3] ?? '0'}`, floor, 'gcr doctor reports the same floor');
  });

  it('the lock file root also agrees with package.json on name-independent facts that npm ci checks (version and runtime dependencies)', () => {
    const root = lock.packages?.[''];
    assert.equal(root?.version, pkg.version);
    assert.deepEqual(root?.dependencies, pkg.dependencies);
  });
});
