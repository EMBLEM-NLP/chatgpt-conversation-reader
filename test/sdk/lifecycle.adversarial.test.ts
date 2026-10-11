/**
 * Adversarial review of the write boundary and of error normalization:
 *  - opening a file GCR did not create (or that a newer GCR wrote) must leave it byte-for-byte alone, even though the open fails;
 *  - `doctor` is documented as creating and writing nothing, which must hold for a normal WAL-mode GCR database too;
 *  - hostile option objects must surface as GcrError from the ASYNC mutators as well (their validation runs before the lock).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { GCR_APPLICATION_ID } from '../../src/db/schema.js';
import { GcrError } from '../../src/errors.js';
import { peekOpenRefusal } from '../../src/sdk/doctor.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { ID, chat, conversationsJson, emptyDb, expectGcr, fixedClock, importBuilders, makeTempDir, removeDir, standardDb, thrown, writeText } from './sdk.helpers.test.js';

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await removeDir(dir);
  }
}

/** Creates a SQLite file with the given statements in the default (rollback-journal) mode. */
function makeFile(path: string, ...statements: string[]): void {
  const raw = new DatabaseSync(path);
  try {
    for (const s of statements) raw.exec(s);
  } finally {
    raw.close();
  }
}

describe('a failed read-write open does not touch the file', () => {
  const cases: ReadonlyArray<{ name: string; statements: string[]; code: 'DB_ERROR' | 'DB_SCHEMA_TOO_NEW'; reason?: string }> = [
    {
      name: 'a SQLite file of another application (tables, no application id)',
      statements: ['CREATE TABLE somebody_elses_table (x TEXT)', "INSERT INTO somebody_elses_table VALUES ('theirs')"],
      code: 'DB_ERROR',
      reason: 'not_gcr_database',
    },
    {
      name: 'a SQLite file with another application id and a user_version that happens to equal ours',
      statements: ['PRAGMA application_id = 305419896', 'PRAGMA user_version = 1', 'CREATE TABLE t (x TEXT)', "INSERT INTO t VALUES ('theirs')"],
      code: 'DB_ERROR',
      reason: 'not_gcr_database',
    },
    {
      name: 'a database written by a NEWER GCR',
      statements: [`PRAGMA application_id = ${GCR_APPLICATION_ID}`, 'PRAGMA user_version = 99', 'CREATE TABLE marker (x TEXT)', "INSERT INTO marker VALUES ('kept')"],
      code: 'DB_SCHEMA_TOO_NEW',
    },
  ];
  for (const c of cases) {
    it(`${c.name}: refused with ${c.code}, bytes and directory unchanged`, async () => {
      await withDir(async (dir) => {
        const path = join(dir, 'other.sqlite');
        makeFile(path, ...c.statements);
        const before = readFileSync(path);
        const listing = readdirSync(dir).sort();
        const e = expectGcr(thrown(() => Gcr.open({ dbPath: path })), c.code);
        if (c.reason !== undefined) assert.equal(e.details?.['reason'], c.reason);
        assert.ok(before.equals(readFileSync(path)), 'the file is byte-identical (the journal-mode header bytes included)');
        assert.deepEqual(readdirSync(dir).sort(), listing, 'no side file appeared');
        // and with create:false, which must not change the verdict
        expectGcr(thrown(() => Gcr.open({ dbPath: path, create: false })), c.code);
        assert.ok(before.equals(readFileSync(path)));
      });
    });
  }

  it('controls: a GCR database and an empty file are still opened (and an empty one initialized); a text file still fails as a GcrError', async () => {
    await withDir(async (dir) => {
      const own = join(dir, 'own.sqlite');
      Gcr.open({ dbPath: own }).close();
      const again = Gcr.open({ dbPath: own });
      assert.equal(again.list().data.total, 0);
      again.close();

      const empty = join(dir, 'empty.sqlite');
      await writeFile(empty, '');
      Gcr.open({ dbPath: empty }).close();
      assert.ok(statSync(empty).size > 0);

      const junk = join(dir, 'junk.sqlite');
      await writeFile(junk, 'this is plainly not a sqlite database file '.repeat(40));
      const before = readFileSync(junk);
      expectGcr(thrown(() => Gcr.open({ dbPath: junk })), 'DB_ERROR');
      assert.ok(before.equals(readFileSync(junk)));
    });
  });
});

describe('peekOpenRefusal (the read-only look Gcr.open takes before a read-write open)', () => {
  it('names exactly the files the open would refuse, and says nothing about anything else', async () => {
    await withDir(async (dir) => {
      const foreign = join(dir, 'foreign.sqlite');
      makeFile(foreign, 'CREATE TABLE t (x)');
      const foreignId = join(dir, 'foreign-id.sqlite');
      makeFile(foreignId, 'PRAGMA application_id = 7', 'PRAGMA user_version = 1');
      const newer = join(dir, 'newer.sqlite');
      makeFile(newer, `PRAGMA application_id = ${GCR_APPLICATION_ID}`, 'PRAGMA user_version = 7');
      const own = join(dir, 'own.sqlite');
      Gcr.open({ dbPath: own }).close();
      const zero = join(dir, 'zero.sqlite');
      await writeFile(zero, '');
      const junk = join(dir, 'junk.sqlite');
      await writeFile(junk, 'not sqlite at all '.repeat(100));
      const emptyDatabase = join(dir, 'empty-db.sqlite');
      makeFile(emptyDatabase, 'PRAGMA user_version = 0');
      await mkdir(join(dir, 'adir'));

      assert.deepEqual(peekOpenRefusal(foreign), { kind: 'foreign' });
      assert.deepEqual(peekOpenRefusal(foreignId), { kind: 'foreign' });
      assert.deepEqual(peekOpenRefusal(newer), { kind: 'newer', fileVersion: 7 });
      for (const fine of [own, zero, junk, emptyDatabase, join(dir, 'adir'), join(dir, 'missing.sqlite'), ':memory:', '', 'file:x.sqlite', 'a\0b']) {
        assert.equal(peekOpenRefusal(fine), null, `no verdict for ${JSON.stringify(fine).slice(0, 40)}`);
      }
      assert.equal(peekOpenRefusal(5 as never), null);
    });
  });
});

describe('doctor creates and writes nothing', () => {
  it('inspecting a closed WAL-mode GCR database leaves the directory and the bytes as they were', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'gcr.sqlite');
      const g = Gcr.open({ dbPath: path });
      await importBuilders(g, dir, [chat(ID.linear, 'doctor subject', [['quokka', 'answer']])]);
      g.close();
      const before = readFileSync(path);
      const listing = readdirSync(dir).sort();
      const report = Gcr.doctor({ dbPath: path });
      assert.equal(report.database?.schemaStatus, 'ok');
      assert.equal(report.database?.schemaVersion, 1);
      assert.deepEqual(readdirSync(dir).sort(), listing, 'no -wal / -shm side files were created');
      assert.ok(before.equals(readFileSync(path)));
    });
  });

  it('a database that is open elsewhere (its WAL holds the schema) is still reported correctly', async () => {
    const t = await standardDb();
    try {
      const report = Gcr.doctor({ dbPath: t.dbPath });
      assert.equal(report.database?.schemaStatus, 'ok');
      assert.equal(report.database?.schemaVersion, 1);
      assert.equal(t.gcr.doctor().database?.schemaStatus, 'ok');
    } finally {
      await t.cleanup();
    }
  });

  it('a path full of URI-special characters (space # ? % non-ASCII) is inspected correctly, quietly, and a refusal of such a file works too', async () => {
    await withDir(async (root) => {
      const dir = join(root, 'sp ace#hash?query%25 日本 é');
      await mkdir(dir);
      const path = join(dir, 'we ird#name?.sqlite');
      Gcr.open({ dbPath: path }).close();
      const listing = readdirSync(dir).sort();
      const report = Gcr.doctor({ dbPath: path });
      assert.equal(report.database?.schemaStatus, 'ok');
      assert.equal(report.database?.label, 'we ird#name?.sqlite');
      assert.deepEqual(readdirSync(dir).sort(), listing);

      const foreign = join(dir, 'fo#reign?.sqlite');
      makeFile(foreign, 'CREATE TABLE t (x)');
      const before = readFileSync(foreign);
      expectGcr(thrown(() => Gcr.open({ dbPath: foreign })), 'DB_ERROR');
      assert.ok(before.equals(readFileSync(foreign)));
    });
  });

  it('the instance doctor keeps inspecting ITS file after the process changes directory (a relative dbPath is pinned at open)', async () => {
    await withDir(async (dir) => {
      const here = process.cwd();
      process.chdir(dir);
      try {
        const g = Gcr.open({ dbPath: 'relative.sqlite' });
        try {
          process.chdir(here);
          const report = g.doctor();
          assert.equal(report.database?.label, 'relative.sqlite');
          assert.equal(report.database?.exists, true);
          assert.equal(report.database?.schemaStatus, 'ok');
        } finally {
          g.close();
        }
      } finally {
        process.chdir(here);
      }
    });
  });

  it('a foreign or newer file is diagnosed without being modified', async () => {
    await withDir(async (dir) => {
      const foreign = join(dir, 'foreign.sqlite');
      makeFile(foreign, 'CREATE TABLE t (x)', 'PRAGMA journal_mode = WAL');
      const newer = join(dir, 'newer.sqlite');
      makeFile(newer, `PRAGMA application_id = ${GCR_APPLICATION_ID}`, 'PRAGMA user_version = 99', 'PRAGMA journal_mode = WAL', 'CREATE TABLE marker (x)');
      const before = new Map([foreign, newer].map((p) => [p, readFileSync(p)] as const));
      const listing = readdirSync(dir).sort();
      assert.equal(Gcr.doctor({ dbPath: foreign }).database?.schemaStatus, 'not_a_gcr_database');
      assert.equal(Gcr.doctor({ dbPath: newer }).database?.schemaStatus, 'newer_than_tool');
      assert.deepEqual(readdirSync(dir).sort(), listing);
      for (const [p, bytes] of before) assert.ok(bytes.equals(readFileSync(p)), 'bytes unchanged');
    });
  });
});

describe('hostile option objects surface as GcrError from the asynchronous mutators too', () => {
  const secret = 'boom while reading an option: /abs/secret/location';
  const getterThrows = (): Record<string, unknown> =>
    Object.defineProperty({}, 'source', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
  const proxyThrows = (): Record<string, unknown> =>
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(secret);
        },
        getOwnPropertyDescriptor() {
          throw new Error(secret);
        },
        get() {
          throw new Error(secret);
        },
      },
    );

  it('importExport, importManualCopy, buildGraph, createDraft, createAnnotation: a rejection with a GcrError that does not carry the thrown text', async () => {
    const t = await standardDb();
    try {
      const calls: Array<[string, () => Promise<unknown>]> = [];
      for (const [label, make] of [['getter', getterThrows], ['proxy', proxyThrows]] as const) {
        calls.push([`importExport/${label}`, () => t.gcr.importExport(make() as never)]);
        calls.push([`importManualCopy/${label}`, () => t.gcr.importManualCopy('{"messages":[{"role":"user","text":"x"}]}', make() as never)]);
        calls.push([`buildGraph/${label}`, () => t.gcr.buildGraph(make() as never)]);
        calls.push([`createDraft/${label}`, () => t.gcr.createDraft(make() as never)]);
        calls.push([`createAnnotation/${label}`, () => t.gcr.createAnnotation(make() as never)]);
      }
      for (const [name, run] of calls) {
        const outcome = await run().then(
          () => null,
          (e: unknown) => e,
        );
        assert.ok(outcome instanceof GcrError, `${name}: expected a GcrError, got ${outcome instanceof Error ? `${outcome.constructor.name}: ${outcome.message}` : String(outcome)}`);
        assert.ok(!JSON.stringify(outcome.toEnvelope()).includes('/abs/secret'), `${name}: the hostile text is not forwarded`);
      }
      // the handle is still healthy afterwards (no stuck lock, no open transaction)
      await t.gcr.createDraft({ conversationRef: ID.linear, body: 'still works' });
      assert.equal(t.gcr.list().data.total, 9);
    } finally {
      await t.cleanup();
    }
  });

  it('the same objects given to the synchronous reads were already normalized (control)', async () => {
    const t = await standardDb();
    try {
      for (const make of [getterThrows, proxyThrows]) {
        assert.ok(thrown(() => t.gcr.list(make() as never)) instanceof GcrError);
        assert.ok(thrown(() => t.gcr.search(make() as never)) instanceof GcrError);
        assert.ok(thrown(() => t.gcr.stats(make() as never)) instanceof GcrError);
      }
    } finally {
      await t.cleanup();
    }
  });

  it('the import runs with the options that were VALIDATED: an option getter is read once, not once for the check and once for the use', async () => {
    const t = await emptyDb();
    try {
      const good = await writeText(t.dir, 'good/conversations.json', conversationsJson([chat(ID.linear, 'checked once', [['quokka', 'answer']])]));
      let reads = 0;
      const opts = Object.defineProperty({}, 'source', {
        enumerable: true,
        get() {
          reads++;
          // The first read is the valid one; any later read points somewhere that does not exist.
          return reads === 1 ? { kind: 'path', path: good } : { kind: 'path', path: join(t.dir, 'swapped', 'does-not-exist.json') };
        },
      });
      const env = await t.gcr.importExport(opts as never);
      assert.equal(env.data.conversations.stored, 1);
      assert.equal(reads, 1, 'one read of the option');
    } finally {
      await t.cleanup();
    }
  });

  it('a mutator on a read-only handle is WRITE_FORBIDDEN before any option is evaluated', async () => {
    const t = await standardDb();
    try {
      t.gcr.close();
      const ro = Gcr.open({ dbPath: t.dbPath, readOnly: true, clock: fixedClock });
      try {
        let touched = false;
        const spy = new Proxy(
          {},
          {
            get() {
              touched = true;
              return undefined;
            },
            ownKeys() {
              touched = true;
              return [];
            },
          },
        );
        await ro.importExport(spy as never).then(
          () => assert.fail('expected a rejection'),
          (e: unknown) => expectGcr(e, 'WRITE_FORBIDDEN'),
        );
        await ro.buildGraph(spy as never).then(
          () => assert.fail('expected a rejection'),
          (e: unknown) => expectGcr(e, 'WRITE_FORBIDDEN'),
        );
        assert.equal(touched, false);
        assert.equal(ro.list().data.total, 9, 'reads on the read-only handle work');
      } finally {
        ro.close();
      }
    } finally {
      await removeDir(t.dir);
    }
  });
});
