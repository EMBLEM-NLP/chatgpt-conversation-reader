/**
 * Adversarial tests for src/db/schema.ts and src/db/open.ts (independent review; lens: migration safety, storage
 * invariants, error mapping). Each test either demonstrated a real defect before its fix or pins a boundary the original
 * suite left open. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { GcrError } from '../../src/errors.js';
import { SCHEMA_VERSION } from '../../src/version.js';
import { closeDatabase, isSqliteError, openDatabase, sqliteErrcode, toDbError } from '../../src/db/open.js';
import { GCR_APPLICATION_ID, MIGRATIONS, applyMigrations, assertCompatible, readUserVersion } from '../../src/db/schema.js';
import type { Migration } from '../../src/db/schema.js';
import { withTempDir } from '../helpers/tmp.js';

const expectGcr = (code: string, reason?: string) => (e: unknown): boolean =>
  e instanceof GcrError && e.code === code && (reason === undefined || (e.details as { reason?: string } | undefined)?.reason === reason);

function objectNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT type || ':' || name AS n FROM sqlite_schema ORDER BY 1")
    .all()
    .map((r) => String(r['n']));
}

/** What a Node release older than 22.15/22.16 looks like: `isOpen` and `isTransaction` do not exist yet. */
function withoutNewerNodeApis(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'isTransaction' || prop === 'isOpen') return undefined;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('a SQLite file that is not ours is never written to', () => {
  it('a foreign database with a NEGATIVE user_version is refused (read-write and read-only) and left byte-for-byte alone', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'foreign.sqlite');
      const f = new DatabaseSync(path);
      f.exec('CREATE TABLE precious (x TEXT); INSERT INTO precious VALUES (\'keep me\'); PRAGMA user_version = -5;');
      const before = objectNames(f);
      f.close();

      assert.throws(() => openDatabase(path), expectGcr('DB_ERROR', 'not_gcr_database'));
      assert.throws(() => openDatabase(path, { readOnly: true }), expectGcr('DB_ERROR', 'not_gcr_database'));

      const check = new DatabaseSync(path);
      try {
        assert.deepEqual(objectNames(check), before, 'no GCR table was created inside the foreign file');
        assert.equal(readUserVersion(check), -5);
        assert.equal(check.prepare('SELECT x FROM precious').get()?.['x'], 'keep me');
      } finally {
        check.close();
      }
    });
  });

  it('applyMigrations on a raw handle also refuses a negative version, and assertCompatible names it as a foreign database', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec('CREATE TABLE other (x); PRAGMA user_version = -1;');
      assert.throws(() => applyMigrations(raw), expectGcr('DB_ERROR', 'not_gcr_database'));
      assert.throws(() => assertCompatible(raw), expectGcr('DB_ERROR', 'not_gcr_database'));
      assert.deepEqual(objectNames(raw), ['table:other']);
    } finally {
      raw.close();
    }
  });
});

describe('lock contention while migrating is reported as busy, not as a failed migration', () => {
  it('BEGIN IMMEDIATE losing the race maps to DB_ERROR/busy and the file stays at version 0', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'race.sqlite');
      const holder = new DatabaseSync(path);
      const loser = new DatabaseSync(path);
      try {
        holder.exec('PRAGMA journal_mode = WAL');
        holder.exec('BEGIN IMMEDIATE');
        loser.exec('PRAGMA busy_timeout = 0');
        assert.throws(
          () => applyMigrations(loser),
          (e) => {
            assert.ok(e instanceof GcrError);
            assert.equal(e.code, 'DB_ERROR', `got ${e.code}: ${e.message}`);
            assert.equal((e.details as { reason?: string } | undefined)?.reason, 'busy');
            assert.ok(!e.message.includes(dir), 'no path in the message');
            return true;
          },
        );
        holder.exec('ROLLBACK');
        assert.equal(readUserVersion(loser), 0, 'nothing was applied');
        assert.deepEqual(applyMigrations(loser), { from: 0, to: SCHEMA_VERSION }, 'and a retry succeeds');
      } finally {
        holder.close();
        loser.close();
      }
    });
  });
});

describe('a failed BEGIN IMMEDIATE never rolls back a transaction that belongs to the caller', () => {
  it('applyMigrations inside a caller-owned transaction reports DB_MIGRATION_FAILED and leaves that transaction open', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec('BEGIN');
      assert.throws(() => applyMigrations(raw), expectGcr('DB_MIGRATION_FAILED'));
      assert.equal(raw.isTransaction, true, 'the caller\'s transaction was rolled back');
      raw.exec('COMMIT');
      assert.equal(readUserVersion(raw), 0, 'nothing was applied');
    } finally {
      raw.close();
    }
  });
});

describe('assertCompatible: every refusal path, directly', () => {
  function fresh(): DatabaseSync {
    return openDatabase(':memory:').db;
  }

  it('accepts a freshly created database (positive control)', () => {
    const db = fresh();
    try {
      assert.doesNotThrow(() => assertCompatible(db));
    } finally {
      db.close();
    }
  });

  it('an uninitialized database (version 0) needs migration', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      assert.throws(() => assertCompatible(raw), expectGcr('DB_ERROR', 'needs_migration'));
    } finally {
      raw.close();
    }
  });

  it('a missing required table is reported by name', () => {
    const db = fresh();
    try {
      db.exec('DROP TABLE local_drafts');
      assert.throws(
        () => assertCompatible(db),
        (e) => e instanceof GcrError && e.code === 'DB_ERROR' && JSON.stringify(e.details).includes('local_drafts') && (e.details as { reason?: string }).reason === 'missing_tables',
      );
    } finally {
      db.close();
    }
  });

  it('metadata that disagrees with PRAGMA user_version is rejected', () => {
    const db = fresh();
    try {
      db.exec("UPDATE gcr_meta SET value = '7' WHERE key = 'schema_version'");
      assert.throws(() => assertCompatible(db), expectGcr('DB_ERROR', 'meta_mismatch'));
      db.exec("DELETE FROM gcr_meta WHERE key = 'schema_version'");
      assert.throws(() => assertCompatible(db), expectGcr('DB_ERROR', 'meta_mismatch'));
    } finally {
      db.close();
    }
  });

  it('a foreign application id is rejected even when everything else looks right', () => {
    const db = fresh();
    try {
      db.exec(`PRAGMA application_id = ${GCR_APPLICATION_ID + 1}`);
      assert.throws(() => assertCompatible(db), expectGcr('DB_ERROR', 'not_gcr_database'));
    } finally {
      db.close();
    }
  });

  it('a newer file version is DB_SCHEMA_TOO_NEW and a failed check never modifies the file', () => {
    const db = fresh();
    try {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      const before = objectNames(db);
      assert.throws(() => assertCompatible(db), expectGcr('DB_SCHEMA_TOO_NEW'));
      assert.throws(() => applyMigrations(db), expectGcr('DB_SCHEMA_TOO_NEW'));
      assert.deepEqual(objectNames(db), before);
      assert.equal(readUserVersion(db), SCHEMA_VERSION + 1);
    } finally {
      db.close();
    }
  });
});

describe('error helpers: negative cases', () => {
  it('isSqliteError / sqliteErrcode are false/null for anything that did not come from node:sqlite', () => {
    const notSqlite: unknown[] = [new Error('x'), new GcrError('DB_ERROR', 'x'), 'ERR_SQLITE_ERROR', null, undefined, 42, { code: 'ERR_SQLITE_ERROR' }, Object.assign(new Error('x'), { code: 'ENOENT' })];
    for (const v of notSqlite) {
      assert.equal(isSqliteError(v), false, String(v));
      assert.equal(sqliteErrcode(v), null, String(v));
    }
  });

  it('a real SQLite failure is recognized and carries a numeric result code', () => {
    const db = new DatabaseSync(':memory:');
    try {
      let caught: unknown;
      try {
        db.exec('SELECT * FROM nope_zzz');
      } catch (e) {
        caught = e;
      }
      assert.equal(isSqliteError(caught), true);
      assert.equal(typeof sqliteErrcode(caught), 'number');
    } finally {
      db.close();
    }
  });
});

describe('closeDatabase', () => {
  it('is idempotent for a GcrDatabase and for a bare DatabaseSync', () => {
    const h = openDatabase(':memory:');
    closeDatabase(h);
    assert.doesNotThrow(() => closeDatabase(h));
    const raw = new DatabaseSync(':memory:');
    closeDatabase(raw);
    assert.doesNotThrow(() => closeDatabase(raw));
    assert.equal(raw.isOpen, false);
  });
});

describe('does not depend on node:sqlite members newer than the supported minimum (engines: node >= 22.13)', () => {
  it('closeDatabase really closes a handle on a runtime without `isOpen`', () => {
    const raw = new DatabaseSync(':memory:');
    const legacy = withoutNewerNodeApis(raw);
    assert.equal((legacy as { isOpen?: boolean }).isOpen, undefined, 'the seam hides isOpen');
    closeDatabase(legacy);
    assert.equal(raw.isOpen, false, 'the connection must be closed even though isOpen is not available');
    assert.doesNotThrow(() => closeDatabase(legacy), 'closing twice stays harmless');
  });

  it('a failing migration is rolled back on a runtime without `isTransaction`', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      const boom: Migration = {
        version: 2,
        name: 'boom',
        up: (db) => {
          db.exec('CREATE TABLE half_done (x TEXT)');
          throw new Error('boom');
        },
      };
      applyMigrations(raw);
      assert.throws(() => applyMigrations(withoutNewerNodeApis(raw), [...MIGRATIONS, boom]), expectGcr('DB_MIGRATION_FAILED'));
      assert.equal(raw.isTransaction, false, 'no transaction may stay open');
      assert.equal(readUserVersion(raw), 1);
      assert.ok(!objectNames(raw).includes('table:half_done'));
    } finally {
      raw.close();
    }
  });
});

describe('open modes: boundaries', () => {
  it('create:false on an existing file opens it read-write without touching the file mode', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'existing.sqlite');
      closeDatabase(openDatabase(path));
      const mode = statSync(path).mode & 0o777;
      const h = openDatabase(path, { create: false });
      try {
        assert.equal(h.readOnly, false);
        assert.equal(h.migrated, null, 'nothing to migrate on reopen');
        assert.equal(statSync(path).mode & 0o777, mode);
      } finally {
        closeDatabase(h);
      }
    });
  });

  it('an empty read-write database file created elsewhere (0 bytes) is initialized, not rejected', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'empty.sqlite');
      new DatabaseSync(path).close(); // SQLite creates a 0-byte file until the first write
      const h = openDatabase(path);
      try {
        assert.deepEqual(h.migrated, { from: 0, to: SCHEMA_VERSION });
      } finally {
        closeDatabase(h);
      }
    });
  });
});

describe('toDbError maps every SQLite result class to a fixed, content-free GcrError', () => {
  const sqliteLike = (errcode: number, message = 'SECRET-SQL-TEXT /abs/path/secret.db'): Error => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });

  it('table of primary/extended result codes (extended codes are masked to their primary class)', () => {
    const table: Array<[number, string, string | null]> = [
      [5, 'DB_ERROR', 'busy'],
      [261, 'DB_ERROR', 'busy'], // SQLITE_BUSY_RECOVERY
      [6, 'DB_ERROR', 'busy'],
      [8, 'WRITE_FORBIDDEN', null],
      [1032, 'WRITE_FORBIDDEN', null], // SQLITE_READONLY_DBMOVED
      [11, 'DB_ERROR', 'corrupt'],
      [13, 'DB_ERROR', 'full'],
      [14, 'DB_ERROR', 'cannot_open'],
      [19, 'DB_ERROR', 'constraint'],
      [1555, 'DB_ERROR', 'constraint'], // SQLITE_CONSTRAINT_PRIMARYKEY
      [26, 'DB_ERROR', 'not_a_database'],
      [1, 'DB_ERROR', null],
      [999, 'DB_ERROR', null],
    ];
    for (const [errcode, code, reason] of table) {
      const mapped = toDbError(sqliteLike(errcode));
      assert.equal(mapped.code, code, `errcode ${errcode}`);
      assert.equal((mapped.details as { reason?: string } | undefined)?.reason ?? null, reason, `errcode ${errcode}`);
      const shown = JSON.stringify(mapped.toEnvelope());
      assert.ok(!shown.includes('SECRET') && !shown.includes('/abs/path'), `errcode ${errcode} leaked SQLite text: ${shown}`);
    }
  });

  it('only the trigger\'s own fixed message is recognized as the immutability violation', () => {
    assert.deepEqual((toDbError(sqliteLike(19, 'constraint failed: imported data is immutable')).details as { reason: string }).reason, 'immutable');
    assert.deepEqual((toDbError(sqliteLike(19, 'UNIQUE constraint failed: x.y')).details as { reason: string }).reason, 'constraint');
  });

  it('a closed handle (ERR_INVALID_STATE "database is not open") is reported as such; other invalid states stay generic', () => {
    const closed = Object.assign(new Error('database is not open'), { code: 'ERR_INVALID_STATE' });
    const mapped = toDbError(closed);
    assert.equal(mapped.code, 'DB_ERROR');
    assert.equal((mapped.details as { reason?: string }).reason, 'closed');
    assert.ok(!mapped.message.includes('not open'));
    const other = toDbError(Object.assign(new Error('statement has been finalized'), { code: 'ERR_INVALID_STATE' }));
    assert.equal(other.message, 'A database operation failed.');
  });

  it('values that are not SQLite errors become a generic DB_ERROR, even when they look like one', () => {
    for (const v of [undefined, null, 'ERR_SQLITE_ERROR', 7, { code: 'ERR_SQLITE_ERROR', errcode: 5 }, Object.assign(new Error('x'), { errcode: 5 })]) {
      const mapped = toDbError(v);
      assert.equal(mapped.code, 'DB_ERROR');
      assert.equal(mapped.message, 'A database operation failed.');
    }
  });
});

describe('readUserVersion', () => {
  it('is 0 for a brand-new database and tracks PRAGMA user_version exactly (including large values)', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      assert.equal(readUserVersion(raw), 0);
      raw.exec('PRAGMA user_version = 2147483647');
      assert.equal(readUserVersion(raw), 2147483647);
    } finally {
      raw.close();
    }
  });
});

describe('the schema satisfies the documented contract (docs/ARCHITECTURE.md section 3)', () => {
  /** Run the DDL of section 3 into a scratch database; comments (including the FTS / trigger design notes) are dropped. */
  function documentedSchema(): DatabaseSync {
    const doc = readFileSync(new URL('../../../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
    const start = doc.indexOf('## 3. SQLite schema v1');
    const end = doc.indexOf('### Migrations');
    assert.ok(start >= 0 && end > start, 'section 3 of ARCHITECTURE.md must still contain the schema contract');
    const sql = [...doc.slice(start, end).matchAll(/```sql\n([\s\S]*?)```/g)]
      .map((m) => m[1] ?? '')
      .join('\n')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const ref = new DatabaseSync(':memory:');
    for (const statement of sql.split(/;\s*\n/).map((x) => x.trim())) {
      if (/^CREATE (TABLE|INDEX)/i.test(statement)) ref.exec(statement);
    }
    return ref;
  }

  function describeTable(db: DatabaseSync, table: string): unknown {
    const cols = db.prepare(`PRAGMA table_xinfo(${table})`).all().map((c) => [c['name'], c['type'], c['notnull'], c['dflt_value'], c['pk']]);
    const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all().map((f) => [f['table'], f['from'], f['to']]);
    const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(table)?.['strict'];
    return { cols, fks, strict };
  }

  it('every documented table exists with the same columns, types, NOT NULL, defaults, primary keys, foreign keys and STRICT flag', () => {
    const ref = documentedSchema();
    const real = openDatabase(':memory:').db;
    try {
      const tables = ref
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
        .all()
        .map((r) => String(r['name']));
      assert.ok(tables.length >= 14, `the documented DDL defines ${tables.length} tables`);
      for (const t of tables) assert.deepEqual(describeTable(real, t), describeTable(ref, t), `table ${t}`);
      const realIndexes = new Set(real.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all().map((r) => String(r['name'])));
      for (const r of ref.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all()) {
        assert.ok(realIndexes.has(String(r['name'])), `documented index ${String(r['name'])}`);
      }
    } finally {
      ref.close();
      real.close();
    }
  });

  it('the documented immutability triggers exist for the three imported tables (plus the helper table), by name', () => {
    const real = openDatabase(':memory:').db;
    try {
      const triggers = new Set(real.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all().map((r) => String(r['name'])));
      for (const t of ['source_batches', 'conversations', 'messages']) {
        assert.ok(triggers.has(`${t}_no_update`) && triggers.has(`${t}_no_delete`), t);
      }
      assert.ok(triggers.has('local_audit_log_no_update') && triggers.has('local_audit_log_no_delete'));
    } finally {
      real.close();
    }
  });
});
