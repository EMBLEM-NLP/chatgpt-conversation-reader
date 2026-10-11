/**
 * Every failure of every wrapped layer reaches the caller as a GcrError (never a raw SQLite/fs/JS error), DB errors keep
 * their mapped codes, and nothing foreign (paths, SQL, thrown text) leaks into messages or envelopes.
 * Failures are injected for real: a connection closed behind the facade's back, tables dropped by another connection,
 * a read-only SQLite handle, and caller-supplied callbacks that throw odd values.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { Gcr, normalizeError } from '../../src/sdk/gcr.js';
import { CALLS, ID, assertCode, assertRejectCode, chat, conversationsJson, expectGcr, fixedClock, importBuilders, makeTempDir, rejected, removeDir, standardDb, thrown, writeText } from './sdk.helpers.test.js';

/** The raw node:sqlite connection behind a handle (test-only reach into a private field to simulate a crash). */
function rawConnection(gcr: Gcr): DatabaseSync {
  const handle = (gcr as unknown as { handle: { db: DatabaseSync } }).handle;
  return handle.db;
}

describe('normalizeError', () => {
  it('passes a GcrError through unchanged (same object)', () => {
    const e = new GcrError('BRANCH_NOT_FOUND', 'x');
    assert.equal(normalizeError(e), e);
  });

  it('maps real SQLite errors by result code: read-only -> WRITE_FORBIDDEN, constraint -> DB_ERROR, missing table -> DB_ERROR', () => {
    const mem = new DatabaseSync(':memory:');
    try {
      mem.exec('CREATE TABLE t (x INTEGER PRIMARY KEY)');
      mem.exec('INSERT INTO t VALUES (1)');
      const constraint = normalizeError(thrown(() => mem.exec('INSERT INTO t VALUES (1)')));
      assert.equal(constraint.code, 'DB_ERROR');
      assert.equal(constraint.details?.['reason'], 'constraint');
      const missing = normalizeError(thrown(() => mem.prepare('SELECT * FROM no_such_table').all()));
      assert.equal(missing.code, 'DB_ERROR');
      assert.ok(!missing.message.includes('no_such_table'), 'SQLite\'s own text is not forwarded');
    } finally {
      mem.close();
    }
  });

  it('a connection closed behind our back is DB_ERROR with reason "closed"', () => {
    const mem = new DatabaseSync(':memory:');
    mem.close();
    const e = normalizeError(thrown(() => mem.prepare('SELECT 1')));
    assert.equal(e.code, 'DB_ERROR');
    assert.equal(e.details?.['reason'], 'closed');
  });

  it('everything else becomes the generic INTERNAL_ERROR: no text, no stack, no cause content in message/remedy/details', () => {
    const values: unknown[] = [new Error('boom at /home/someone/secret.txt'), new TypeError('x is not a function'), 'a thrown string', 42, null, undefined, { message: 'object' }, Symbol('s')];
    for (const v of values) {
      const e = normalizeError(v);
      assert.ok(e instanceof GcrError);
      assert.equal(e.code, 'INTERNAL_ERROR');
      const wire = JSON.stringify(e.toEnvelope());
      assert.ok(!wire.includes('secret.txt') && !wire.includes('thrown string') && !wire.includes('not a function'), 'foreign text is not forwarded');
      assert.equal(e.exitCode, 1);
    }
  });
});

describe('a connection that was closed behind the facade\'s back', () => {
  it('every read throws and every mutator rejects with a GcrError (DB_ERROR "closed"); the handle can still be closed', async () => {
    const t = await standardDb();
    try {
      rawConnection(t.gcr).close();
      assert.ok(t.gcr.isOpen, 'the facade did not notice');
      for (const c of CALLS) {
        if (c.kind === 'read') {
          const e = expectGcr(thrown(() => c.run(t.gcr)), 'DB_ERROR');
          assert.equal(e.details?.['reason'], 'closed', c.name);
        } else if (c.name === 'importExport') {
          // The table's import points at a file that does not exist: the input is checked before the database is touched.
          await assertRejectCode(Promise.resolve().then(() => c.run(t.gcr) as Promise<unknown>), 'IMPORT_INPUT_NOT_FOUND');
          const real = await writeText(t.dir, 'closed/conversations.json', conversationsJson([chat(ID.empty, 'closed', [['q', 'a']])]));
          const e = await assertRejectCode(t.gcr.importExport({ source: { kind: 'path', path: real } }), 'DB_ERROR');
          assert.equal(e.details?.['reason'], 'closed', c.name);
        } else {
          const e = await assertRejectCode(Promise.resolve().then(() => c.run(t.gcr) as Promise<unknown>), 'DB_ERROR');
          assert.equal(e.details?.['reason'], 'closed', c.name);
        }
      }
      t.gcr.close();
      t.gcr.close();
    } finally {
      await t.cleanup();
    }
  });

  it('a failed mutator does not leave the writer lock stuck: a later call still fails cleanly instead of hanging', async () => {
    const t = await standardDb();
    try {
      rawConnection(t.gcr).close();
      await assertRejectCode(t.gcr.createDraft({ conversationRef: ID.linear, body: 'x' }), 'DB_ERROR');
      await assertRejectCode(t.gcr.createDraft({ conversationRef: ID.linear, body: 'y' }), 'DB_ERROR');
      assertCode(() => t.gcr.list(), 'DB_ERROR');
    } finally {
      await t.cleanup();
    }
  });
});

describe('a damaged database file', () => {
  /** Another connection drops tables the facade depends on (a file anyone can edit). */
  async function damaged(drop: string[]): Promise<{ gcr: Gcr; cleanup: () => Promise<void> }> {
    const t = await standardDb();
    const raw = new DatabaseSync(t.dbPath);
    try {
      raw.exec('PRAGMA foreign_keys = OFF');
      for (const table of drop) raw.exec(`DROP TABLE ${table}`);
    } finally {
      raw.close();
    }
    return { gcr: t.gcr, cleanup: t.cleanup };
  }

  it('a missing full-text index is DB_ERROR for search (not an unhandled SQLite error) and does not break other reads', async () => {
    const d = await damaged(['messages_fts']);
    try {
      const e = expectGcr(thrown(() => d.gcr.search({ query: 'quokka' })), 'DB_ERROR');
      assert.ok(!/messages_fts/.test(JSON.stringify(e.toEnvelope())), 'no SQL or table name in the envelope');
      assert.equal(d.gcr.list().data.total, 9);
    } finally {
      await d.cleanup();
    }
  });

  it('missing local tables fail draft and annotation methods with DB_ERROR', async () => {
    const d = await damaged(['local_drafts', 'local_annotations']);
    try {
      assertCode(() => d.gcr.listDrafts(), 'DB_ERROR');
      assertCode(() => d.gcr.getDraft('x'), 'DB_ERROR');
      assertCode(() => d.gcr.listAnnotations(), 'DB_ERROR');
      await assertRejectCode(d.gcr.createDraft({ conversationRef: ID.linear, body: 'x' }), 'DB_ERROR');
      await assertRejectCode(d.gcr.createAnnotation({ conversationRef: ID.linear, body: 'x' }), 'DB_ERROR');
    } finally {
      await d.cleanup();
    }
  });

  it('missing imported tables fail every conversation read with DB_ERROR, never INTERNAL_ERROR', async () => {
    const d = await damaged(['conversation_heads']);
    try {
      for (const read of [() => d.gcr.list(), () => d.gcr.get(ID.linear), () => d.gcr.branches(ID.linear), () => d.gcr.thread(ID.linear), () => d.gcr.search({ query: 'quokka' }), () => d.gcr.stats({ groupBy: 'role' }), () => d.gcr.audit()]) {
        assertCode(read, 'DB_ERROR');
      }
    } finally {
      await d.cleanup();
    }
  });

  it('a missing graph table fails graph methods with DB_ERROR', async () => {
    const d = await damaged(['graph_nodes', 'graph_edges']);
    try {
      assertCode(() => d.gcr.graphQuery({ term: 'quokka' }), 'DB_ERROR');
      assertCode(() => d.gcr.graphGodNodes(), 'DB_ERROR');
      assertCode(() => d.gcr.graphExportHtml(), 'DB_ERROR');
      await assertRejectCode(d.gcr.buildGraph(), 'DB_ERROR');
    } finally {
      await d.cleanup();
    }
  });

  it('damaged stored JSON is read defensively: the conversation still loads and says STORED_JSON_INVALID', async () => {
    const t = await standardDb();
    const raw = new DatabaseSync(t.dbPath);
    try {
      // The immutability triggers abort UPDATEs; a tampered file is simulated by dropping the trigger first (someone editing the file).
      raw.exec('DROP TRIGGER messages_no_update');
      raw.prepare("UPDATE messages SET blocks_json = 'not json' WHERE conversation_id = ? AND node_kind = 'message'").run(ID.linear);
    } finally {
      raw.close();
    }
    try {
      const env = t.gcr.get(ID.linear);
      assert.ok(env.warnings.some((w) => w.code === 'STORED_JSON_INVALID'));
      assert.ok((env.data.thread?.messages.length ?? 0) > 0);
    } finally {
      await t.cleanup();
    }
  });
});

describe('errors raised by caller-supplied callbacks', () => {
  it('a clock that throws (any value) fails the local write as INTERNAL_ERROR with nothing forwarded, and stores nothing', async () => {
    const dir = await makeTempDir();
    let broken = false;
    const gcr = Gcr.open({
      dbPath: ':memory:',
      clock: () => {
        if (broken) throw new Error('clock exploded at /private/place with TOP-SECRET');
        return '2026-02-03T04:05:06.007Z';
      },
    });
    try {
      await importBuilders(gcr, dir, [chat(ID.linear, 'clock', [['q', 'a']])]);
      broken = true;
      const e = expectGcr(await rejected(gcr.createDraft({ conversationRef: ID.linear, body: 'x' })), 'INTERNAL_ERROR');
      assert.ok(!JSON.stringify(e.toEnvelope()).includes('TOP-SECRET'));
      broken = false;
      assert.equal(gcr.listDrafts().data.total, 0, 'the failed write was rolled back');
      assert.equal((await gcr.createDraft({ conversationRef: ID.linear, body: 'fine now' })).data.draft.body, 'fine now');
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });

  it('a clock that returns something that is not an ISO-8601 UTC time is a GcrError, not a crash', async () => {
    const gcr = Gcr.open({ dbPath: ':memory:', clock: () => 'tomorrow' });
    const dir = await makeTempDir();
    try {
      const path = `${dir}/c/conversations.json`;
      await importBuilders(Gcr.open({ dbPath: ':memory:', clock: fixedClock }), dir, []).catch(() => undefined);
      const e = await rejected(gcr.importExport({ source: { kind: 'path', path } }));
      assert.ok(e instanceof GcrError);
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });

  it('a progress callback that throws a non-Error value fails the import as a GcrError', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      const path = await writeText(dir, 'p/conversations.json', conversationsJson([chat(ID.linear, 'cb', [['q', 'a']])]));
      for (const thrownValue of ['a string', 7, null, undefined, { message: 'obj' }]) {
        const e = await rejected(
          gcr.importExport({
            source: { kind: 'path', path },
            onProgress: () => {
              throw thrownValue;
            },
          }),
        );
        assert.ok(e instanceof GcrError, String(thrownValue));
      }
      assert.equal(gcr.listBatches().length, 0, 'nothing was stored');
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });
});

describe('GcrError contract on every thrown error', () => {
  it('each error has a stable code, an exit code, an envelope with ok:false, and no absolute directory of the machine', async () => {
    const t = await standardDb();
    try {
      const errors: unknown[] = [
        thrown(() => t.gcr.get('nonsense')),
        thrown(() => t.gcr.get(`https://chatgpt.com/share/${ID.linear}`)),
        thrown(() => t.gcr.get('00000000-0000-4000-8000-0000000000ff')),
        thrown(() => t.gcr.thread(ID.noCurrent)),
        thrown(() => t.gcr.thread(ID.linear, { branch: 'zzz' })),
        thrown(() => t.gcr.list({ limit: 0 })),
        thrown(() => t.gcr.search({ query: '"x', mode: 'raw' })),
        thrown(() => Gcr.open({ dbPath: `${t.dir}/nope/never.sqlite`, readOnly: true })),
        await rejected(t.gcr.importExport({ source: { kind: 'path', path: `${t.dir}/absent.zip` } })),
      ];
      for (const e of errors) {
        assert.ok(e instanceof GcrError);
        const env = e.toEnvelope();
        assert.equal(env.ok, false);
        assert.equal(env.error.code, e.code);
        assert.ok(Number.isInteger(e.exitCode) && e.exitCode > 0);
        assert.ok(!JSON.stringify(env).includes(t.dir), `${e.code}: the temp directory leaked into the error`);
        assert.ok(Array.isArray(env.warnings));
      }
    } finally {
      await t.cleanup();
    }
  });
});
