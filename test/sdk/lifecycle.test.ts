/**
 * Gcr.open / close / read-only handles / use after close (the lifecycle contract of the facade).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { GCR_APPLICATION_ID } from '../../src/db/schema.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { CALLS, FIXED_NOW, ID, assertCode, assertRejectCode, chat, expectGcr, fixedClock, importBuilders, makeTempDir, removeDir, standardDb, thrown } from './sdk.helpers.test.js';

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await removeDir(dir);
  }
}

describe('Gcr.open', () => {
  it('creates a missing database file readable only by its owner and reports its basename', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'new.sqlite');
      assert.equal(existsSync(dbPath), false);
      const gcr = Gcr.open({ dbPath });
      try {
        assert.equal(existsSync(dbPath), true);
        assert.equal(statSync(dbPath).mode & 0o777, 0o600, 'imported conversations are never world-readable');
        assert.equal(gcr.isOpen, true);
        assert.equal(gcr.readOnly, false);
        assert.equal(gcr.dbLabel, 'new.sqlite');
        assert.ok(!gcr.dbLabel.includes(dir));
        assert.equal(gcr.actor, 'sdk');
        assert.equal(gcr.list().data.total, 0);
      } finally {
        gcr.close();
      }
    });
  });

  it('supports ":memory:" for read-write handles only', () => {
    const gcr = Gcr.open({ dbPath: ':memory:' });
    assert.equal(gcr.dbLabel, ':memory:');
    gcr.close();
    assertCode(() => Gcr.open({ dbPath: ':memory:', readOnly: true }), 'INVALID_ARGUMENT');
  });

  it('reopens an existing database and sees what was imported', async () => {
    const t = await standardDb();
    try {
      t.gcr.close();
      const again = Gcr.open({ dbPath: t.dbPath });
      try {
        assert.equal(again.list().data.total, 9);
      } finally {
        again.close();
      }
    } finally {
      await t.cleanup();
    }
  });

  it('the actor option is validated and exposed', () => {
    for (const actor of ['cli', 'mcp', 'sdk'] as const) {
      const g = Gcr.open({ dbPath: ':memory:', actor });
      assert.equal(g.actor, actor);
      g.close();
    }
    assertCode(() => Gcr.open({ dbPath: ':memory:', actor: 'root' as never }), 'INVALID_ARGUMENT');
  });

  it('rejects malformed options with INVALID_ARGUMENT (and never creates a file for them)', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'x.sqlite');
      const bad: unknown[] = [
        undefined,
        null,
        'x.sqlite',
        {},
        { dbPath: 5 },
        { dbPath: '' },
        { dbPath: `${dbPath}\u0000.sqlite` },
        { dbPath: 'file:evil.sqlite?mode=rwc' },
        { dbPath, readOnly: 'yes' },
        { dbPath, create: 1 },
        { dbPath, clock: 'now' },
        { dbPath, unknownOption: true },
        { dbPath, readOnly: true, create: true },
      ];
      for (const o of bad) assertCode(() => Gcr.open(o as never), 'INVALID_ARGUMENT');
      assert.equal(existsSync(dbPath), false);
    });
  });
});

describe('read-only handles', () => {
  it('a missing file is DB_NOT_FOUND with a remedy that names `gcr import`, and the file is NOT created', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'missing.sqlite');
      const e = expectGcr(thrown(() => Gcr.open({ dbPath, readOnly: true })), 'DB_NOT_FOUND');
      assert.match(e.remedy ?? '', /gcr import/);
      assert.equal(existsSync(dbPath), false, 'a read-only open never creates');
      assert.ok(!JSON.stringify(e.toEnvelope()).includes(dir), 'only the basename is reported');
      assert.equal(e.exitCode, 5);
    });
  });

  it('create:false on a writable handle behaves the same', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'missing.sqlite');
      const e = expectGcr(thrown(() => Gcr.open({ dbPath, create: false })), 'DB_NOT_FOUND');
      assert.match(e.remedy ?? '', /gcr import/);
      assert.equal(existsSync(dbPath), false);
    });
  });

  it('a missing parent directory is DB_NOT_FOUND too, with a directory remedy', async () => {
    await withDir(async (dir) => {
      const e = expectGcr(thrown(() => Gcr.open({ dbPath: join(dir, 'no', 'such', 'dir', 'x.sqlite') })), 'DB_NOT_FOUND');
      assert.match(e.remedy ?? '', /directory/i);
    });
  });

  it('reads work and every mutator rejects with WRITE_FORBIDDEN', async () => {
    const t = await standardDb();
    const ro = Gcr.open({ dbPath: t.dbPath, readOnly: true });
    try {
      assert.equal(ro.readOnly, true);
      assert.equal(ro.list().data.total, 9);
      assert.equal(ro.get(ID.linear).data.thread?.messages.length, 4);
      assert.equal(ro.search({ query: 'quokka' }).data.items.length, 8);
      assert.equal(ro.branches(ID.branched).data.branches.length, 3);
      assert.equal(ro.stats({ groupBy: 'role' }).data.totals.messages > 0, true);
      assert.equal(ro.audit().data.scanned.conversations, 9);
      assert.equal(ro.listBatches().length, 1);
      assert.equal(ro.listDrafts().data.items.length, 0);
      assert.equal(ro.listAnnotations().data.items.length, 0);

      const writers = CALLS.filter((c) => c.kind === 'write');
      assert.equal(writers.length, 7, 'every mutator is in the table');
      for (const c of writers) {
        const e = await assertRejectCode(Promise.resolve().then(() => c.run(ro) as Promise<unknown>), 'WRITE_FORBIDDEN');
        assert.equal(e.exitCode, 6, c.name);
      }
      // nothing was written
      assert.equal(ro.listBatches().length, 1);
    } finally {
      ro.close();
      await t.cleanup();
    }
  });

  it('a mutator never throws synchronously: it returns a rejected promise even on a read-only handle', async () => {
    const t = await standardDb();
    const ro = Gcr.open({ dbPath: t.dbPath, readOnly: true });
    try {
      const p = ro.createDraft({ conversationRef: ID.linear, body: 'x' });
      assert.ok(p instanceof Promise);
      await assertRejectCode(p, 'WRITE_FORBIDDEN');
    } finally {
      ro.close();
      await t.cleanup();
    }
  });

  it('a read-only handle does not migrate: an uninitialized (empty) file is refused and left byte-for-byte alone', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'empty.sqlite');
      await writeFile(dbPath, '');
      const e = expectGcr(thrown(() => Gcr.open({ dbPath, readOnly: true })), 'DB_ERROR');
      assert.equal(e.details?.['reason'], 'needs_migration');
      assert.equal(statSync(dbPath).size, 0, 'nothing was written');
      // the same file IS initialized by a read-write open
      const rw = Gcr.open({ dbPath });
      rw.close();
      assert.ok(statSync(dbPath).size > 0);
      Gcr.open({ dbPath, readOnly: true }).close();
    });
  });

  it('a database written by a NEWER tool is DB_SCHEMA_TOO_NEW: never migrated, its contents untouched', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'future.sqlite');
      const raw = new DatabaseSync(dbPath);
      raw.exec(`PRAGMA application_id = ${GCR_APPLICATION_ID}`);
      raw.exec('PRAGMA user_version = 99');
      raw.exec('CREATE TABLE marker (x TEXT)');
      raw.exec("INSERT INTO marker VALUES ('kept')");
      raw.close();
      const before = readFileSync(dbPath);

      const ro = expectGcr(thrown(() => Gcr.open({ dbPath, readOnly: true })), 'DB_SCHEMA_TOO_NEW');
      assert.equal(ro.details?.['fileVersion'], 99);
      assert.ok(before.equals(readFileSync(dbPath)), 'a read-only open leaves the future database byte-identical');

      const rw = expectGcr(thrown(() => Gcr.open({ dbPath })), 'DB_SCHEMA_TOO_NEW');
      assert.equal(rw.details?.['fileVersion'], 99);
      // Invariant the SDK guarantees: no migration, no GCR table, no data change. (db/open.ts currently switches the
      // journal mode to WAL before it checks the version, which touches the header bytes: reported as a contract request.)
      const check = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(check.prepare('PRAGMA user_version').get()?.['user_version'], 99);
        assert.deepEqual(check.prepare("SELECT x FROM marker").all().map((r) => r['x']), ['kept']);
        assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((r) => r['name']), ['marker']);
      } finally {
        check.close();
      }
    });
  });

  it('refuses to use (or write into) a SQLite file that is not a GCR database', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'foreign.sqlite');
      const raw = new DatabaseSync(dbPath);
      raw.exec('CREATE TABLE somebody_elses_table (x TEXT)');
      raw.exec("INSERT INTO somebody_elses_table VALUES ('theirs')");
      raw.close();
      expectGcr(thrown(() => Gcr.open({ dbPath, readOnly: true })), 'DB_ERROR');
      const rw = expectGcr(thrown(() => Gcr.open({ dbPath })), 'DB_ERROR');
      assert.equal(rw.details?.['reason'], 'not_gcr_database');
      const check = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((r) => r['name']), ['somebody_elses_table']);
        assert.deepEqual(check.prepare('SELECT x FROM somebody_elses_table').all().map((r) => r['x']), ['theirs']);
      } finally {
        check.close();
      }
    });
  });

  it('a path that is a directory, and a file that is not SQLite at all, fail as GcrError', async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, 'adir'));
      assertCode(() => Gcr.open({ dbPath: join(dir, 'adir') }), 'DB_ERROR');
      const junk = join(dir, 'junk.sqlite');
      await writeFile(junk, 'this is plainly not a sqlite database file, just text '.repeat(40));
      const e = expectGcr(thrown(() => Gcr.open({ dbPath: junk })), 'DB_ERROR');
      assert.ok(!JSON.stringify(e.toEnvelope()).includes('plainly'), 'file content is never echoed');
    });
  });
});

describe('close and use after close', () => {
  it('close() is idempotent', async () => {
    const t = await standardDb();
    try {
      assert.equal(t.gcr.isOpen, true);
      t.gcr.close();
      assert.equal(t.gcr.isOpen, false);
      t.gcr.close();
      t.gcr.close();
      assert.equal(t.gcr.isOpen, false);
    } finally {
      await t.cleanup();
    }
  });

  it('every method after close() fails with a GcrError (DB_ERROR, reason "closed"): reads throw, mutators reject', async () => {
    const t = await standardDb();
    t.gcr.close();
    try {
      for (const c of CALLS) {
        if (c.kind === 'read') {
          const e = expectGcr(thrown(() => c.run(t.gcr)), 'DB_ERROR');
          assert.equal(e.details?.['reason'], 'closed', c.name);
        } else {
          const result = c.run(t.gcr);
          assert.ok(result instanceof Promise, `${c.name} returns a promise`);
          const e = await assertRejectCode(result, 'DB_ERROR');
          assert.equal(e.details?.['reason'], 'closed', c.name);
        }
      }
      assertCode(() => t.gcr.doctor(), 'DB_ERROR');
    } finally {
      await t.cleanup();
    }
  });

  it('close() while an import is running lets it finish; later calls fail; the data is on disk', async () => {
    const t = await standardDb();
    try {
      const path = join(t.dir, 'late', 'conversations.json');
      await mkdir(join(t.dir, 'late'));
      await writeFile(path, `[${chat(ID.empty, 'late arrival', [['late question', 'late answer']]).text()}]`);
      let closedAt = -1;
      const p = t.gcr.importExport({
        source: { kind: 'path', path },
        onProgress: (e) => {
          if (e.phase === 'import' && closedAt < 0) {
            closedAt = e.elements;
            t.gcr.close();
          }
        },
      });
      const env = await p;
      assert.equal(env.data.conversations.stored, 1, 'the import ran to completion');
      assert.ok(closedAt >= 0, 'close() was requested mid-import');
      assert.equal(t.gcr.isOpen, false);
      assertCode(() => t.gcr.list(), 'DB_ERROR');
      const check = Gcr.open({ dbPath: t.dbPath, readOnly: true });
      try {
        assert.equal(check.list().data.total, 10, 'committed before the handle was closed');
      } finally {
        check.close();
      }
    } finally {
      await t.cleanup();
    }
  });

  it('writes that are queued but have not started are rejected when the handle is closed first', async () => {
    const t = await standardDb();
    try {
      const path = join(t.dir, 'q', 'conversations.json');
      await mkdir(join(t.dir, 'q'));
      await writeFile(path, `[${chat(ID.empty, 'queued', [['q', 'a']]).text()}]`);
      // everything below is synchronous: neither write has started when close() is called
      const first = t.gcr.createDraft({ conversationRef: ID.linear, body: 'queued behind the import' });
      const second = t.gcr.importExport({ source: { kind: 'path', path } });
      t.gcr.close();
      const e1 = await assertRejectCode(first, 'DB_ERROR');
      const e2 = await assertRejectCode(second, 'DB_ERROR');
      assert.equal(e1.details?.['reason'], 'closed');
      assert.equal(e2.details?.['reason'], 'closed');
    } finally {
      await t.cleanup();
    }
  });

  it('handles are independent: closing one leaves another over the same file working', async () => {
    const t = await standardDb();
    const other = Gcr.open({ dbPath: t.dbPath, readOnly: true });
    try {
      t.gcr.close();
      assert.equal(other.list().data.total, 9);
    } finally {
      other.close();
      await t.cleanup();
    }
  });
});

describe('construction details', () => {
  it('the injected clock is used for imports and local writes (reproducible timestamps)', async () => {
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock, actor: 'cli' });
    const dir = await makeTempDir();
    try {
      const env = await importBuilders(gcr, dir, [chat(ID.linear, 'clocked', [['q', 'a']])]);
      assert.equal(env.source[0]?.importedAt, FIXED_NOW);
      const draft = await gcr.createDraft({ conversationRef: ID.linear, body: 'timed' });
      assert.equal(draft.data.draft.createdAt, FIXED_NOW);
      assert.equal(draft.data.draft.createdVia, 'cli');
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });
});
