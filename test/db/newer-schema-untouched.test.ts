/**
 * A database file written by a NEWER tool (user_version above this tool's SCHEMA_VERSION) must be refused with
 * DB_SCHEMA_TOO_NEW and must stay byte-for-byte untouched - including when opened read-write, where the opener would
 * otherwise switch the journal mode to WAL (which rewrites the header) before looking at the version.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { GcrError } from '../../src/errors.js';
import { openDatabase } from '../../src/db/open.js';
import { SCHEMA_VERSION } from '../../src/version.js';
import { withTempDir } from '../helpers/tmp.js';

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('a newer-schema database file is left untouched', () => {
  it('read-write open: DB_SCHEMA_TOO_NEW, file bytes identical, no -wal/-shm side files', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'newer.sqlite');
      const seed = new DatabaseSync(file);
      seed.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 98}`); // e.g. 99
      seed.exec('CREATE TABLE gcr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      seed.close();
      const before = sha(file);

      assert.throws(
        () => openDatabase(file),
        (e: unknown) => e instanceof GcrError && e.code === 'DB_SCHEMA_TOO_NEW' && e.details?.['fileVersion'] === SCHEMA_VERSION + 98,
      );
      assert.equal(sha(file), before, 'the file must be byte-for-byte unchanged');
      assert.equal(existsSync(`${file}-wal`), false);
      assert.equal(existsSync(`${file}-shm`), false);
    });
  });

  it('read-only open is refused too and also leaves the file identical', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'newer-ro.sqlite');
      const seed = new DatabaseSync(file);
      seed.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      seed.exec('CREATE TABLE gcr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      seed.close();
      const before = sha(file);
      assert.throws(() => openDatabase(file, { readOnly: true }), (e: unknown) => e instanceof GcrError && e.code === 'DB_SCHEMA_TOO_NEW');
      assert.equal(sha(file), before);
    });
  });

  it('a normal fresh database still opens and migrates', async () => {
    await withTempDir(async (dir) => {
      const handle = openDatabase(join(dir, 'ok.sqlite'));
      assert.equal(handle.schemaVersion, SCHEMA_VERSION);
      handle.db.close();
    });
  });
});
