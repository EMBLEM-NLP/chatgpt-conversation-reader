/**
 * Tests for src/db/schema.ts and src/db/open.ts: migrations, compatibility refusal, rollback, open modes, file
 * permissions, error hygiene, and the immutability triggers. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { GcrError } from '../../src/errors.js';
import { SCHEMA_VERSION } from '../../src/version.js';
import { closeDatabase, openDatabase, toDbError } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { MIGRATIONS, GCR_APPLICATION_ID, applyMigrations, assertCompatible, readUserVersion } from '../../src/db/schema.js';
import type { Migration } from '../../src/db/schema.js';
import { withTempDir } from '../helpers/tmp.js';
import { branchedConversation, linearConversation } from '../helpers/records.js';

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'export.zip',
  contentDigest: 'digest-1',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

const EXPECTED_TABLES = [
  'gcr_meta',
  'source_batches',
  'source_batch_stats',
  'conversations',
  'messages',
  'conversation_heads',
  'messages_fts',
  'conversations_fts',
  'local_drafts',
  'local_annotations',
  'local_audit_log',
  'entities',
  'entity_mentions',
  'graph_nodes',
  'graph_edges',
  'graph_edge_evidence',
  'graph_communities',
];

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table') ORDER BY name")
    .all()
    .map((r) => String(r['name']));
}

function pragmaValue(db: DatabaseSync, sql: string, column: string): unknown {
  return db.prepare(sql).get()?.[column];
}

function expectGcr(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

describe('migrations', () => {
  it('a fresh database gets schema v1 with every table, meta mirror, application id and the required pragmas', () => {
    const h = openDatabase(':memory:');
    try {
      assert.equal(h.schemaVersion, SCHEMA_VERSION);
      assert.deepEqual(h.migrated, { from: 0, to: 1 });
      assert.equal(readUserVersion(h.db), SCHEMA_VERSION);
      assert.equal(pragmaValue(h.db, 'PRAGMA application_id', 'application_id'), GCR_APPLICATION_ID);
      assert.equal(h.db.prepare("SELECT value FROM gcr_meta WHERE key = 'schema_version'").get()?.['value'], String(SCHEMA_VERSION));
      const names = new Set(tableNames(h.db));
      for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `missing table ${t}`);
      assert.equal(pragmaValue(h.db, 'PRAGMA foreign_keys', 'foreign_keys'), 1);
      assert.equal(pragmaValue(h.db, 'PRAGMA trusted_schema', 'trusted_schema'), 0);
      assert.equal(pragmaValue(h.db, 'PRAGMA recursive_triggers', 'recursive_triggers'), 1);
      assert.equal(pragmaValue(h.db, 'PRAGMA busy_timeout', 'timeout'), 5000);
      assert.equal(pragmaValue(h.db, 'PRAGMA journal_mode', 'journal_mode'), 'memory'); // WAL is not applicable to :memory:
      assertCompatible(h.db);
    } finally {
      closeDatabase(h);
    }
  });

  it('all relational tables are STRICT (no silent type coercion) and the FTS tables are contentless', () => {
    const h = openDatabase(':memory:');
    try {
      const regular = EXPECTED_TABLES.filter((t) => !t.endsWith('_fts'));
      const strict = new Map(h.db.prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'").all().map((r) => [String(r['name']), Number(r['strict'])]));
      for (const t of regular) assert.equal(strict.get(t), 1, `${t} must be STRICT`);
      // contentless: no *_content shadow table exists
      const names = tableNames(h.db);
      assert.ok(!names.includes('messages_fts_content'));
      assert.ok(!names.includes('conversations_fts_content'));
      assert.throws(() => h.db.exec("INSERT INTO local_annotations (annotation_id, provider, account_label, conversation_id, body, version, created_at, updated_at, created_via) VALUES ('a','p','l','c','b','not-an-int','t','t','cli')"));
    } finally {
      closeDatabase(h);
    }
  });

  it('a file database uses WAL, is created with mode 0600, and reopening is a no-op', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'g.sqlite');
      const h1 = openDatabase(path);
      assert.deepEqual(h1.migrated, { from: 0, to: 1 });
      assert.equal(pragmaValue(h1.db, 'PRAGMA journal_mode', 'journal_mode'), 'wal');
      h1.db.exec("INSERT INTO local_audit_log (ts, actor, action, target_type, target_id) VALUES ('t', 'cli', 'x', 'draft', 'd1')");
      closeDatabase(h1);
      if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);

      const h2 = openDatabase(path);
      try {
        assert.equal(h2.migrated, null, 'nothing to migrate on reopen');
        assert.equal(count(h2.db, 'local_audit_log'), 1, 'data survives a reopen');
        assert.deepEqual(applyMigrations(h2.db), { from: 1, to: 1 });
      } finally {
        closeDatabase(h2);
      }
      closeDatabase(h2); // idempotent
    });
  });

  it('refuses a database written by a NEWER tool (DB_SCHEMA_TOO_NEW) and leaves it untouched', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'future.sqlite');
      closeDatabase(openDatabase(path));
      const raw = new DatabaseSync(path);
      raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 41}`);
      const tablesBefore = tableNames(raw);
      raw.close();

      for (const opts of [{}, { readOnly: true }]) {
        assert.throws(
          () => openDatabase(path, opts),
          (e) => e instanceof GcrError && e.code === 'DB_SCHEMA_TOO_NEW' && (e.details as { fileVersion: number }).fileVersion === SCHEMA_VERSION + 41,
        );
      }
      const check = new DatabaseSync(path);
      try {
        assert.equal(readUserVersion(check), SCHEMA_VERSION + 41);
        assert.deepEqual(tableNames(check), tablesBefore);
        assert.throws(() => applyMigrations(check), expectGcr('DB_SCHEMA_TOO_NEW'));
        assert.throws(() => assertCompatible(check), expectGcr('DB_SCHEMA_TOO_NEW'));
      } finally {
        check.close();
      }
    });
  });

  it('rolls back a failing migration completely and reports DB_MIGRATION_FAILED without leaking its message', () => {
    const h = openDatabase(':memory:');
    try {
      const boom: Migration = {
        version: 2,
        name: 'boom',
        up: (db) => {
          db.exec('CREATE TABLE half_done (x TEXT)');
          db.exec("INSERT INTO gcr_meta (key, value) VALUES ('leak', 'SECRET-INSIDE-MIGRATION')");
          throw new Error('SECRET-INSIDE-MIGRATION');
        },
      };
      assert.throws(
        () => applyMigrations(h.db, [...MIGRATIONS, boom]),
        (e) => {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'DB_MIGRATION_FAILED');
          assert.ok(!e.message.includes('SECRET'), 'message must not carry the inner error text');
          assert.deepEqual(e.details, { fromVersion: 1, toVersion: 2 });
          assert.ok(e.cause instanceof Error);
          return true;
        },
      );
      assert.equal(readUserVersion(h.db), 1, 'version unchanged');
      assert.ok(!tableNames(h.db).includes('half_done'), 'DDL rolled back');
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM gcr_meta WHERE key = 'leak'").get()?.['n'], 0, 'DML rolled back');
      assert.equal(h.db.isTransaction, false, 'no transaction left open');
      assertCompatible(h.db);
    } finally {
      closeDatabase(h);
    }
  });

  it('a failing FIRST migration leaves an empty database (version 0, no tables)', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      const bad: Migration = {
        version: 1,
        name: 'bad_sql',
        up: (db) => {
          db.exec('CREATE TABLE t1 (x TEXT)');
          db.exec('THIS IS NOT SQL');
        },
      };
      assert.throws(() => applyMigrations(raw, [bad]), expectGcr('DB_MIGRATION_FAILED'));
      assert.equal(readUserVersion(raw), 0);
      assert.deepEqual(tableNames(raw), []);
    } finally {
      raw.close();
    }
  });

  it('applies several pending migrations in order, each committed, and records the version in gcr_meta', () => {
    const h = openDatabase(':memory:');
    try {
      const extra: Migration[] = [
        { version: 2, name: 'add_a', up: (db) => db.exec('CREATE TABLE extra_a (x TEXT)') },
        { version: 3, name: 'add_b', up: (db) => db.exec('CREATE TABLE extra_b (x TEXT)') },
      ];
      assert.deepEqual(applyMigrations(h.db, [...MIGRATIONS, ...extra]), { from: 1, to: 3 });
      assert.equal(h.db.prepare("SELECT value FROM gcr_meta WHERE key = 'schema_version'").get()?.['value'], '3');
      // This tool only supports SCHEMA_VERSION, so the very same file is "newer" for it afterwards.
      assert.throws(() => assertCompatible(h.db), expectGcr('DB_SCHEMA_TOO_NEW'));
    } finally {
      closeDatabase(h);
    }
  });

  it('rejects a migration list that is not a gap-free sequence from 1', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      assert.throws(() => applyMigrations(raw, [{ version: 2, name: 'gap', up: () => undefined }]), expectGcr('INTERNAL_ERROR'));
      assert.deepEqual(tableNames(raw), []);
    } finally {
      raw.close();
    }
  });

  it('MIGRATIONS is gap-free and ends at SCHEMA_VERSION', () => {
    assert.equal(MIGRATIONS.at(-1)?.version, SCHEMA_VERSION);
    MIGRATIONS.forEach((m, i) => assert.equal(m.version, i + 1));
  });
});

describe('openDatabase', () => {
  it('refuses to create tables inside somebody else\'s SQLite database', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'other.sqlite');
      const raw = new DatabaseSync(path);
      raw.exec('CREATE TABLE someone_elses_table (x TEXT)');
      raw.close();
      assert.throws(() => openDatabase(path), (e) => e instanceof GcrError && e.code === 'DB_ERROR' && (e.details as { reason: string }).reason === 'not_gcr_database');
      const check = new DatabaseSync(path);
      try {
        assert.deepEqual(tableNames(check), ['someone_elses_table']);
      } finally {
        check.close();
      }
    });
  });

  it('refuses a SQLite file carrying another application id', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'app.sqlite');
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA application_id = 1234567');
      raw.exec('PRAGMA user_version = 1');
      raw.close();
      assert.throws(() => openDatabase(path, { readOnly: true }), (e) => e instanceof GcrError && e.code === 'DB_ERROR');
    });
  });

  it('reports a non-database file as DB_ERROR, leaves its bytes alone and does not leak the path', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'junk.sqlite');
      const junk = Buffer.from('definitely not a sqlite database '.repeat(200));
      writeFileSync(path, junk);
      assert.throws(
        () => openDatabase(path),
        (e) => {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'DB_ERROR');
          assert.ok(!e.message.includes(dir));
          assert.ok(!JSON.stringify(e.toEnvelope()).includes(dir));
          return true;
        },
      );
      assert.ok(readFileSync(path).equals(junk), 'file untouched');
    });
  });

  it('missing file: DB_NOT_FOUND for read-only and create:false; nothing is created; message shows the basename only', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'nope.sqlite');
      for (const opts of [{ readOnly: true }, { create: false }]) {
        assert.throws(
          () => openDatabase(path, opts),
          (e) => {
            assert.ok(e instanceof GcrError);
            assert.equal(e.code, 'DB_NOT_FOUND');
            assert.ok(e.message.includes('nope.sqlite'));
            assert.ok(!e.message.includes(dir));
            assert.ok(!JSON.stringify(e.toEnvelope()).includes(dir));
            return true;
          },
        );
      }
      assert.throws(() => statSync(path), 'file must not have been created');
    });
  });

  it('missing parent directory is DB_NOT_FOUND, not a raw filesystem error', async () => {
    await withTempDir(async (dir) => {
      assert.throws(
        () => openDatabase(join(dir, 'no', 'such', 'dir', 'g.sqlite')),
        (e) => e instanceof GcrError && e.code === 'DB_NOT_FOUND' && !e.message.includes(dir),
      );
    });
  });

  it('a path that is a directory is DB_ERROR', async () => {
    await withTempDir(async (dir) => {
      const sub = join(dir, 'adir.sqlite');
      mkdirSync(sub);
      assert.throws(() => openDatabase(sub), expectGcr('DB_ERROR'));
    });
  });

  it('read-only never creates, never migrates and never writes', async () => {
    await withTempDir(async (dir) => {
      // (a) an existing EMPTY file is not initialized by a read-only open
      const empty = join(dir, 'empty.sqlite');
      writeFileSync(empty, '');
      assert.throws(() => openDatabase(empty, { readOnly: true }), (e) => e instanceof GcrError && e.code === 'DB_ERROR' && (e.details as { reason: string }).reason === 'needs_migration');
      assert.equal(statSync(empty).size, 0);

      // (b) a healthy database opens, reads work, and every write path is WRITE_FORBIDDEN
      const path = join(dir, 'g.sqlite');
      const rw = openDatabase(path);
      await new Repository(rw.db).importBatch({ batch: META, conversations: [linearConversation('c1', 1)] });
      closeDatabase(rw);

      const ro = openDatabase(path, { readOnly: true });
      try {
        assert.equal(ro.readOnly, true);
        assert.equal(ro.migrated, null);
        assert.equal(count(ro.db, 'messages'), 3);
        assert.throws(
          () => ro.db.exec("INSERT INTO gcr_meta (key, value) VALUES ('x', 'y')"),
          (e) => toDbError(e).code === 'WRITE_FORBIDDEN',
        );
        await assert.rejects(new Repository(ro.db).importBatch({ batch: { ...META, contentDigest: 'other' }, conversations: [linearConversation('c2', 1)] }), expectGcr('WRITE_FORBIDDEN'));
        assert.equal(count(ro.db, 'messages'), 3);
      } finally {
        closeDatabase(ro);
      }
    });
  });

  it('rejects unsafe or contradictory arguments', () => {
    for (const p of ['', 'file:memdb1?mode=memory&cache=shared', 'FILE:x.sqlite', 'a\0b.sqlite']) {
      assert.throws(() => openDatabase(p), expectGcr('INVALID_ARGUMENT'), JSON.stringify(p));
    }
    assert.throws(() => openDatabase(':memory:', { readOnly: true }), expectGcr('INVALID_ARGUMENT'));
    assert.throws(() => openDatabase('whatever.sqlite', { readOnly: true, create: true }), expectGcr('INVALID_ARGUMENT'));
  });

  it('no error produced while opening ever contains the absolute path of the directory (property over failure kinds)', async () => {
    await withTempDir(async (dir) => {
      const cases: Array<() => unknown> = [
        () => openDatabase(join(dir, 'x', 'g.sqlite')),
        () => openDatabase(join(dir, 'missing.sqlite'), { readOnly: true }),
        () => {
          writeFileSync(join(dir, 'j.sqlite'), 'junk junk junk junk');
          return openDatabase(join(dir, 'j.sqlite'));
        },
        () => openDatabase(dir),
      ];
      for (const run of cases) {
        try {
          run();
          assert.fail('expected a failure');
        } catch (e) {
          assert.ok(e instanceof GcrError, String(e));
          assert.ok(!e.message.includes(dir));
          assert.ok(!(e.remedy ?? '').includes(dir));
          assert.ok(!JSON.stringify(e.details ?? {}).includes(dir));
        }
      }
    });
  });

  it('does not write anything to stdout (the ExperimentalWarning, if any, goes to stderr)', () => {
    const openUrl = new URL('../../src/db/open.js', import.meta.url).href;
    const code = `import { openDatabase, closeDatabase } from ${JSON.stringify(openUrl)}; closeDatabase(openDatabase(':memory:'));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  });

  it('toDbError passes GcrError through, maps unknown values to a generic DB_ERROR and never echoes SQLite text', () => {
    const g = new GcrError('DB_NOT_FOUND', 'x');
    assert.equal(toDbError(g), g);
    assert.equal(toDbError(new Error('SELECT secret FROM t')).code, 'DB_ERROR');
    assert.ok(!toDbError(new Error('SELECT secret FROM t')).message.includes('secret'));
    const h = openDatabase(':memory:');
    try {
      let caught: unknown;
      try {
        h.db.exec('SELECT * FROM table_that_does_not_exist_zzz');
      } catch (e) {
        caught = e;
      }
      const mapped = toDbError(caught);
      assert.equal(mapped.code, 'DB_ERROR');
      assert.ok(!mapped.message.includes('table_that_does_not_exist_zzz'));
    } finally {
      closeDatabase(h);
    }
  });
});

describe('immutability triggers and table roles', () => {
  async function seeded(): Promise<{ h: ReturnType<typeof openDatabase>; repo: Repository }> {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 2), branchedConversation('c2')] });
    return { h, repo };
  }

  function snapshot(db: DatabaseSync): string {
    const parts: string[] = [];
    for (const t of ['source_batches', 'source_batch_stats', 'conversations', 'messages', 'conversation_heads']) {
      parts.push(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    }
    return parts.join('\n');
  }

  it('UPDATE and DELETE on every imported table abort with a fixed message and change nothing', async () => {
    const { h } = await seeded();
    try {
      const before = snapshot(h.db);
      const statements = [
        "UPDATE source_batches SET source_label = 'tampered'",
        'DELETE FROM source_batches',
        'UPDATE source_batch_stats SET node_count = 0',
        'DELETE FROM source_batch_stats',
        "UPDATE conversations SET title = 'tampered'",
        'DELETE FROM conversations',
        "UPDATE messages SET text = 'tampered'",
        "UPDATE messages SET hidden = 1 WHERE message_id = 'c1-u0'",
        'DELETE FROM messages',
        "DELETE FROM messages WHERE message_id = 'c1-u0'",
      ];
      for (const sql of statements) {
        assert.throws(() => h.db.exec(sql), /imported data is immutable/, sql);
      }
      assert.equal(snapshot(h.db), before);
    } finally {
      closeDatabase(h);
    }
  });

  it('INSERT OR REPLACE cannot overwrite an imported row (recursive triggers make the implicit delete abort)', async () => {
    const { h } = await seeded();
    try {
      const before = snapshot(h.db);
      assert.throws(
        () =>
          h.db.exec(
            "INSERT OR REPLACE INTO messages (provider, account_label, conversation_id, message_id, source_batch, ordinal, node_kind, author_role, text, blocks_json) " +
              "SELECT provider, account_label, conversation_id, message_id, source_batch, ordinal, node_kind, author_role, 'replaced', blocks_json FROM messages WHERE message_id = 'c1-u0'",
          ),
        /immutable/,
      );
      // A plain duplicate insert is a PRIMARY KEY violation, never a silent overwrite.
      assert.throws(() =>
        h.db.exec(
          "INSERT INTO messages (provider, account_label, conversation_id, message_id, source_batch, ordinal, node_kind, author_role, text, blocks_json) " +
            "SELECT provider, account_label, conversation_id, message_id, source_batch, ordinal, node_kind, author_role, 'dup', blocks_json FROM messages WHERE message_id = 'c1-u0'",
        ),
      );
      assert.equal(snapshot(h.db), before);
    } finally {
      closeDatabase(h);
    }
  });

  it('local_* tables are writable, local_audit_log is append-only, and local data survives a re-import', async () => {
    const { h, repo } = await seeded();
    try {
      h.db.exec(
        "INSERT INTO local_drafts (draft_id, provider, account_label, conversation_id, body, body_sha256, created_at, updated_at, created_via) VALUES ('d1','chatgpt','default','c1','body','h','t','t','cli')",
      );
      h.db.exec("UPDATE local_drafts SET body = 'edited' WHERE draft_id = 'd1'");
      h.db.exec(
        "INSERT INTO local_annotations (annotation_id, provider, account_label, conversation_id, kind, body, created_at, updated_at, created_via) VALUES ('a1','chatgpt','default','c1','note','n','t','t','cli')",
      );
      h.db.exec("UPDATE local_annotations SET body = 'edited', version = version + 1 WHERE annotation_id = 'a1'");
      h.db.exec("INSERT INTO local_audit_log (ts, actor, action, target_type, target_id) VALUES ('t','cli','create','draft','d1')");
      assert.throws(() => h.db.exec("UPDATE local_audit_log SET actor = 'x'"), /append-only/);
      assert.throws(() => h.db.exec('DELETE FROM local_audit_log'), /append-only/);
      assert.throws(() => h.db.exec("INSERT INTO local_drafts (draft_id, provider, account_label, conversation_id, body, body_sha256, status, created_at, updated_at, created_via) VALUES ('d2','p','a','c','b','h','sent','t','t','cli')"), 'there is deliberately no sent status');

      await repo.importBatch({ batch: { ...META, contentDigest: 'digest-2' }, conversations: [linearConversation('c3', 1)] });
      assert.equal(count(h.db, 'local_drafts'), 1);
      assert.equal(h.db.prepare("SELECT body FROM local_drafts WHERE draft_id = 'd1'").get()?.['body'], 'edited');
      assert.equal(count(h.db, 'local_annotations'), 1);
      assert.equal(count(h.db, 'local_audit_log'), 1);
      h.db.exec("DELETE FROM local_drafts WHERE draft_id = 'd1'");
      h.db.exec("DELETE FROM local_annotations WHERE annotation_id = 'a1'");
    } finally {
      closeDatabase(h);
    }
  });

  it('derived graph tables are freely rewritable and their foreign keys are enforced', async () => {
    const { h } = await seeded();
    try {
      h.db.exec("INSERT INTO entities (entity_id, kind, value, normalized) VALUES (1, 'topic', 'Topic', 'topic')");
      h.db.exec("INSERT INTO entity_mentions (entity_id, provider, account_label, conversation_id, message_id, source_batch, count) VALUES (1,'chatgpt','default','c1','c1-u0','b',2)");
      assert.throws(
        () => h.db.exec("INSERT INTO entity_mentions (entity_id, provider, account_label, conversation_id, message_id, source_batch, count) VALUES (99,'chatgpt','default','c1','c1-u0','b',2)"),
        /FOREIGN KEY/,
      );
      h.db.exec("INSERT INTO graph_nodes (node_id, kind, label) VALUES ('n1', 'entity', 'Topic')");
      h.db.exec("UPDATE graph_nodes SET weight = 2.5 WHERE node_id = 'n1'");
      h.db.exec('DELETE FROM entity_mentions');
      h.db.exec('DELETE FROM entities');
      h.db.exec('DELETE FROM graph_nodes');
    } finally {
      closeDatabase(h);
    }
  });

  it('constraints hold: unknown source_batch, bad node_kind and bad hidden flag are rejected', async () => {
    const { h } = await seeded();
    try {
      const base = "INSERT INTO messages (provider, account_label, conversation_id, message_id, source_batch, ordinal, node_kind, author_role, hidden, text, blocks_json) VALUES ";
      assert.throws(() => h.db.exec(`${base}('chatgpt','default','cX','m1','no-such-batch',0,'message','user',0,'t','[]')`), /FOREIGN KEY/);
      const realBatch = String(h.db.prepare('SELECT batch_id FROM source_batches').get()?.['batch_id']);
      assert.throws(() => h.db.exec(`${base}('chatgpt','default','cX','m1','${realBatch}',0,'bogus','user',0,'t','[]')`), /CHECK/);
      assert.throws(() => h.db.exec(`${base}('chatgpt','default','cX','m1','${realBatch}',0,'message','user',2,'t','[]')`), /CHECK/);
    } finally {
      closeDatabase(h);
    }
  });

  it('after an import the database has no foreign-key violations (deferred checks were satisfied)', async () => {
    const { h } = await seeded();
    try {
      assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(h.db.prepare('PRAGMA integrity_check').get()?.['integrity_check'], 'ok');
    } finally {
      closeDatabase(h);
    }
  });
});
