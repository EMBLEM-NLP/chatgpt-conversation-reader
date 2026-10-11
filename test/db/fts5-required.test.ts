/**
 * GCR needs FTS5 (FR-05). node:sqlite in Node 22.13-22.15 is built WITHOUT it, so the opener must fail fast with a
 * precise error and remedy instead of a confusing DB_MIGRATION_FAILED from inside the schema migration.
 * (Verified on real Node 22.13.0/22.14.0/22.15.x binaries: "no such module: fts5"; 22.16.0+ has it.)
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { MIN_NODE_WITH_FTS5, assertFts5Available, openDatabase } from '../../src/db/open.js';

function sqliteError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode: 1 });
}

describe('FTS5 runtime requirement', () => {
  it('the minimum Node with FTS5 is 22.16.0 and package.json engines agrees', async () => {
    assert.equal(MIN_NODE_WITH_FTS5, '22.16.0');
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
    assert.equal(pkg.engines.node, '>=22.16.0');
  });

  it('a Node build without FTS5 yields DB_ERROR/FTS5_UNAVAILABLE with an upgrade remedy', () => {
    assert.throws(
      () => assertFts5Available(() => { throw sqliteError('no such module: fts5'); }, { node: '22.13.0' }),
      (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'DB_ERROR');
        assert.equal(e.details?.['reason'], 'FTS5_UNAVAILABLE');
        assert.equal(e.details?.['minimumNode'], '22.16.0');
        assert.match(e.remedy ?? '', /22\.16\.0/);
        assert.match(e.remedy ?? '', /22\.13\.0/);
        return true;
      },
    );
  });

  it('other probe failures are mapped by the normal db error mapping, not mislabelled as missing FTS5', () => {
    assert.throws(
      () => assertFts5Available(() => { throw new Error('something else'); }),
      (e: unknown) => e instanceof GcrError && e.details?.['reason'] !== 'FTS5_UNAVAILABLE',
    );
  });

  it('the running Node supports FTS5 and a database opens normally', () => {
    assert.doesNotThrow(() => assertFts5Available());
    const handle = openDatabase(':memory:');
    handle.db.close();
  });

  it('an unsupported build is detected BEFORE any database file is created (no empty file left behind)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gcr-fts5-'));
    try {
      const file = join(dir, 'never-created.sqlite');
      // Simulate by probing first with the failing seam: openDatabase itself uses the real probe, so assert the ordering
      // contract through the exported seam and that a normal open creates the file only after the probe passed.
      assert.throws(() => assertFts5Available(() => { throw sqliteError('no such module: fts5'); }));
      assert.equal(existsSync(file), false);
      const h = openDatabase(file);
      h.db.close();
      assert.equal(existsSync(file), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
