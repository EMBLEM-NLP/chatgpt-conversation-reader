/**
 * Adversarial tests for src/drafts/drafts.ts (SPEC FR-13, Mode C), written by an independent reviewer. Lens: the write
 * boundary. Each suite below either demonstrated a defect (and now pins its fix) or closes a gap that the builder's own
 * limitations list admitted (no true parallel race, unexercised corrupt-row and busy branches, no per-function
 * negative-test inventory). Synthetic data only.
 *
 * Special characters are built from code points so that this file contains no literal invisible character.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import type { GcrDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import * as drafts from '../../src/drafts/drafts.js';
import { LocalStore, verifyAuditLog } from '../../src/drafts/drafts.js';
import type { AnnotationFilter, CreateAnnotationInput, CreateDraftInput, DraftFilter, LocalStoreOptions } from '../../src/drafts/drafts.js';
import { GcrError } from '../../src/errors.js';
import { iso, linearConversation } from '../helpers/records.js';
import { withTempDir } from '../helpers/tmp.js';

const CONV = '00000000-0000-4000-8000-0000000000c1';
const CONV2 = '00000000-0000-4000-8000-0000000000c2';

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'export.zip',
  contentDigest: 'adversarial-digest-1',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

function meta(over: Partial<ImportBatchMeta> = {}): ImportBatchMeta {
  return { ...META, ...over };
}

function fixedClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2025, 5, 1, 0, 0, n++)).toISOString();
}

function counterIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function wrong<T>(v: unknown): T {
  return v as T;
}

function code(c: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === c;
}

function caught(fn: () => unknown): GcrError {
  try {
    fn();
  } catch (e) {
    if (e instanceof GcrError) return e;
    throw e;
  }
  throw new assert.AssertionError({ message: 'expected a GcrError to be thrown' });
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

async function memEnv(
  records: ConversationRecord[] = [linearConversation(CONV, 2)],
  opts: LocalStoreOptions = {},
): Promise<{ h: GcrDatabase; db: DatabaseSync; repo: Repository; store: LocalStore }> {
  const h = openDatabase(':memory:');
  const repo = new Repository(h.db);
  if (records.length > 0) await repo.importBatch({ batch: meta(), conversations: records });
  return { h, db: h.db, repo, store: new LocalStore(h.db, { clock: fixedClock(), idFactory: counterIds(), ...opts }) };
}

/**
 * A DatabaseSync look-alike that calls `before(sql)` just before every get/all/run of a prepared statement. It lets a test
 * play "another process commits right now" at an exact point INSIDE a multi-statement read, which is the only way to make
 * a snapshot-consistency defect deterministic.
 */
function observed(real: DatabaseSync, before: (sql: string) => void): DatabaseSync {
  const wrap = (stmt: StatementSync, sql: string): StatementSync =>
    new Proxy(stmt, {
      get(target, prop): unknown {
        const v: unknown = Reflect.get(target, prop, target);
        if (typeof v !== 'function') return v;
        const fn = v as (...a: unknown[]) => unknown;
        if (prop === 'get' || prop === 'all' || prop === 'run') {
          return (...a: unknown[]): unknown => {
            before(sql);
            return fn.apply(target, a);
          };
        }
        return fn.bind(target);
      },
    });
  return new Proxy(real, {
    get(target, prop): unknown {
      const v: unknown = Reflect.get(target, prop, target);
      if (prop === 'prepare') return (sql: string): StatementSync => wrap(target.prepare(sql), sql);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// ===================================================================================================================
describe('failures are always GcrErrors: a CLOSED connection', () => {
  it('every reader, every mutator and verifyAuditLog fail with DB_ERROR, never a raw ERR_INVALID_STATE Error', async () => {
    const { h, store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
    closeDatabase(h);
    const calls: Array<[string, () => unknown]> = [
      ['getDraft', () => store.getDraft(d.draftId)],
      ['listDrafts', () => store.listDrafts()],
      ['renderDraftMarkdown', () => store.renderDraftMarkdown(d.draftId)],
      ['getAnnotation', () => store.getAnnotation(a.annotationId)],
      ['listAnnotations', () => store.listAnnotations()],
      ['verifyAuditLog', () => verifyAuditLog(h.db)],
      ['createDraft', () => store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' })],
      ['archiveDraft', () => store.archiveDraft(d.draftId)],
      ['createAnnotation', () => store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'x' })],
      ['updateAnnotation', () => store.updateAnnotation(a.annotationId, { body: 'z', expectedVersion: 1 })],
    ];
    for (const [name, run] of calls) {
      let thrown: unknown;
      try {
        run();
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown instanceof GcrError, `${name}: expected a GcrError, got ${String((thrown as Error | undefined)?.constructor?.name)} ${String((thrown as { code?: unknown } | undefined)?.code)}`);
      assert.equal(thrown.code, 'DB_ERROR', name);
      assert.ok(!/not open|ERR_INVALID_STATE/i.test(thrown.message), `${name}: the SQLite/Node message is not forwarded`);
    }
  });
});

// ===================================================================================================================
describe('listings and verifyAuditLog read ONE consistent snapshot', () => {
  it('listDrafts/listAnnotations: a commit from another connection between the count and the page cannot make items exceed total', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'snap.sqlite');
      const reading = openDatabase(path);
      const writing = openDatabase(path);
      try {
        await new Repository(reading.db).importBatch({ batch: meta(), conversations: [linearConversation(CONV, 1)] });
        const seed = new LocalStore(reading.db, { clock: fixedClock(), idFactory: counterIds('seed') });
        const other = new LocalStore(writing.db, { clock: fixedClock(), idFactory: counterIds('other') });
        for (let i = 0; i < 3; i++) {
          seed.createDraft({ conversationRef: { conversationId: CONV }, body: `d${i}` });
          seed.createAnnotation({ conversationRef: { conversationId: CONV }, body: `a${i}` });
        }
        let fired = 0;
        const probe = observed(reading.db, (sql) => {
          // exactly once per listing: right before the PAGE statement, i.e. after the count statement already ran
          if (/^SELECT \* FROM local_drafts/.test(sql) && fired === 0) {
            fired++;
            other.createDraft({ conversationRef: { conversationId: CONV }, body: 'sneaked in' });
          }
          if (/^SELECT \* FROM local_annotations/.test(sql) && fired === 1) {
            fired++;
            other.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'sneaked in' });
          }
        });
        const reader = new LocalStore(probe, { readOnly: true });

        const dp = reader.listDrafts();
        assert.equal(fired, 1, 'precondition: the concurrent commit really happened between the two statements');
        assert.equal(dp.total, 3);
        assert.equal(dp.items.length, 3, 'the page belongs to the same snapshot as the total');
        assert.equal(dp.nextOffset, null);
        assert.equal(seed.listDrafts().total, 4, 'the new row is visible to the NEXT listing');

        const ap = reader.listAnnotations();
        assert.equal(fired, 2);
        assert.equal(ap.total, 3);
        assert.equal(ap.items.length, 3);
        assert.equal(seed.listAnnotations().total, 4);
        assert.equal(reading.db.isTransaction, false, 'the read snapshot was closed again');
      } finally {
        closeDatabase(reading);
        closeDatabase(writing);
      }
    });
  });

  it('listings keep working inside a caller-owned transaction (they join it instead of failing or committing it)', async () => {
    const { db, store } = await memEnv();
    store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    db.exec('BEGIN');
    try {
      assert.equal(store.listDrafts().total, 1);
      assert.equal(store.listAnnotations().total, 0);
      assert.equal(db.isTransaction, true, 'the caller\'s transaction is still open');
    } finally {
      db.exec('ROLLBACK');
    }
  });

  it('verifyAuditLog: an append from another connection while it runs is NOT reported as tampering', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'verify.sqlite');
      const a = openDatabase(path);
      const b = openDatabase(path);
      try {
        await new Repository(a.db).importBatch({ batch: meta(), conversations: [linearConversation(CONV, 1)] });
        const seed = new LocalStore(a.db, { clock: fixedClock(), idFactory: counterIds('seed') });
        const other = new LocalStore(b.db, { clock: fixedClock(), idFactory: counterIds('other') });
        for (let i = 0; i < 3; i++) seed.createDraft({ conversationRef: { conversationId: CONV }, body: `d${i}` });
        let fired = 0;
        const probe = observed(a.db, (sql) => {
          if (fired === 0 && /sqlite_sequence/.test(sql)) {
            fired++;
            other.createDraft({ conversationRef: { conversationId: CONV }, body: 'appended while verifying' });
          }
        });
        const verdict = verifyAuditLog(probe);
        assert.equal(fired, 1, 'precondition: an append happened during verification');
        assert.equal(verdict.ok, true, 'a healthy log must never be reported as tampered because a writer was active');
        assert.ok(verdict.rows === 3 || verdict.rows === 4);
        assert.deepEqual(verifyAuditLog(a.db), { rows: 4, ok: true });
      } finally {
        closeDatabase(a);
        closeDatabase(b);
      }
    });
  });
});

// ===================================================================================================================
describe('paging normalisation', () => {
  it('a negative-zero offset is reported as +0 (deepStrictEqual and Object.is distinguish them)', async () => {
    const { store } = await memEnv();
    store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
    for (const page of [store.listDrafts({ offset: -0 }), store.listAnnotations({ offset: -0 })]) {
      assert.ok(Object.is(page.offset, 0), 'offset is +0');
      assert.equal(page.nextOffset, null);
    }
    const p = store.listDrafts({ offset: -0, limit: 1 });
    assert.deepEqual({ offset: p.offset, nextOffset: p.nextOffset }, { offset: 0, nextOffset: null });
  });
});

// ===================================================================================================================
describe('corrupt local rows fail closed and can never present a draft as sent', () => {
  it('a provider or creator outside the allowed sets is DB_ERROR (invalid_local_row) for get, list and render', async () => {
    const { db, store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
    const reasonOf = (fn: () => unknown): unknown => caught(fn).details?.['reason'];

    db.exec("UPDATE local_drafts SET provider = 'bogus'");
    assert.equal(caught(() => store.getDraft(d.draftId)).code, 'DB_ERROR');
    assert.equal(reasonOf(() => store.getDraft(d.draftId)), 'invalid_local_row');
    assert.equal(reasonOf(() => store.listDrafts()), 'invalid_local_row');
    assert.equal(db.isTransaction, false, 'a failing listing does not leave its read snapshot open');
    assert.equal(reasonOf(() => store.renderDraftMarkdown(d.draftId)), 'invalid_local_row');
    assert.equal(reasonOf(() => store.archiveDraft(d.draftId)), 'invalid_local_row', 'a damaged row is not silently mutated (and no stale transaction blocks the call)');
    db.exec("UPDATE local_drafts SET provider = 'chatgpt', created_via = 'robot'");
    assert.equal(reasonOf(() => store.getDraft(d.draftId)), 'invalid_local_row');

    db.exec("UPDATE local_annotations SET provider = 'bogus'");
    assert.equal(reasonOf(() => store.getAnnotation(a.annotationId)), 'invalid_local_row');
    assert.equal(reasonOf(() => store.listAnnotations()), 'invalid_local_row');
    assert.equal(db.isTransaction, false);
    assert.equal(reasonOf(() => store.updateAnnotation(a.annotationId, { body: 'z', expectedVersion: 1 })), 'invalid_local_row');
    db.exec("UPDATE local_annotations SET provider = 'chatgpt', created_via = 'root'");
    assert.equal(reasonOf(() => store.getAnnotation(a.annotationId)), 'invalid_local_row');
    assert.equal(count(db, 'local_audit_log'), 2, 'the refused mutations left no audit rows');
  });

  it('a database whose CHECK constraint was removed and that holds a "sent" status is refused on every read path', async () => {
    const { db, store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    // Somebody rebuilds the table without its CHECK constraint (the one thing that makes a sent state impossible).
    db.exec(`
      CREATE TABLE local_drafts_unchecked (
        draft_id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default',
        provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
        anchor_message_id TEXT, title TEXT, body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_via TEXT NOT NULL
      ) STRICT;
      INSERT INTO local_drafts_unchecked SELECT * FROM local_drafts;
      DROP TABLE local_drafts;
      ALTER TABLE local_drafts_unchecked RENAME TO local_drafts;
    `);
    for (const status of ['sent', 'SENT', 'delivered', 'Draft', '']) {
      db.prepare('UPDATE local_drafts SET status = ? WHERE draft_id = ?').run(status, d.draftId);
      for (const [name, run] of [
        ['getDraft', () => store.getDraft(d.draftId)],
        ['listDrafts', () => store.listDrafts()],
        ['renderDraftMarkdown', () => store.renderDraftMarkdown(d.draftId)],
        ['archiveDraft', () => store.archiveDraft(d.draftId)],
      ] as Array<[string, () => unknown]>) {
        const e = caught(run);
        assert.equal(e.code, 'DB_ERROR', `${name} with status ${JSON.stringify(status)}`);
        assert.equal(e.details?.['reason'], 'invalid_local_row', name);
      }
    }
    db.prepare('UPDATE local_drafts SET status = ? WHERE draft_id = ?').run('archived', d.draftId);
    assert.equal(store.getDraft(d.draftId).status, 'archived', 'control: a legal status reads fine again');
  });
});

// ===================================================================================================================
describe('busy database: contention is a DB_ERROR, never a half write', () => {
  it('while another connection holds the write lock every mutator fails fast with reason "busy" and writes nothing', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'busy.sqlite');
      const holder = openDatabase(path);
      const victim = openDatabase(path);
      try {
        await new Repository(holder.db).importBatch({ batch: meta(), conversations: [linearConversation(CONV, 1)] });
        const store = new LocalStore(victim.db, { clock: fixedClock(), idFactory: counterIds('v') });
        const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
        const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
        victim.db.exec('PRAGMA busy_timeout = 0'); // do not wait: the point is the error mapping, not the wait

        holder.db.exec('BEGIN IMMEDIATE');
        try {
          const attempts: Array<[string, () => unknown]> = [
            ['createDraft', () => store.createDraft({ conversationRef: { conversationId: CONV }, body: 'blocked' })],
            ['archiveDraft', () => store.archiveDraft(d.draftId)],
            ['createAnnotation', () => store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'blocked' })],
            ['updateAnnotation', () => store.updateAnnotation(a.annotationId, { body: 'blocked', expectedVersion: 1 })],
          ];
          for (const [name, run] of attempts) {
            const e = caught(run);
            assert.equal(e.code, 'DB_ERROR', name);
            assert.equal(e.details?.['reason'], 'busy', name);
            assert.equal(victim.db.isTransaction, false, `${name}: no transaction left open`);
          }
          // invalid input is still reported as invalid, without touching the lock
          assert.throws(() => store.createDraft(wrong<CreateDraftInput>({ conversationRef: { conversationId: CONV }, body: '' })), code('INVALID_ARGUMENT'));
          // readers are not blocked by a writer in WAL mode
          assert.equal(store.listDrafts().total, 1);
          assert.equal(store.getAnnotation(a.annotationId).body, 'y');
        } finally {
          holder.db.exec('ROLLBACK');
        }
        assert.equal(store.getDraft(d.draftId).status, 'draft');
        assert.equal(store.getAnnotation(a.annotationId).version, 1);
        assert.equal(count(victim.db, 'local_audit_log'), 2, 'no audit row for any refused call');
        assert.equal(store.archiveDraft(d.draftId).status, 'archived', 'the store works again once the lock is released');
        assert.deepEqual(verifyAuditLog(victim.db), { rows: 3, ok: true });
      } finally {
        closeDatabase(holder);
        closeDatabase(victim);
      }
    });
  });
});

// ===================================================================================================================
describe('resolution: ambiguity and old batches', () => {
  it('an id present under two accounts is resolved by a pinned batchId alone, and the draft is anchored to THAT account', async () => {
    const work: ConversationRecord = { ...linearConversation(CONV, 1), accountLabel: 'work' };
    const { store, repo } = await memEnv([linearConversation(CONV, 1)]);
    await repo.importBatch({ batch: meta({ accountLabel: 'work', contentDigest: 'adv-work' }), conversations: [work] });
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' }), code('AMBIGUOUS_CONVERSATION'));
    const [defaultBatch, workBatch] = repo.listBatches();
    assert.ok(defaultBatch && workBatch);
    const w = store.createDraft({ conversationRef: { conversationId: CONV, batchId: workBatch.batchId }, body: 'x' });
    const d = store.createAnnotation({ conversationRef: { conversationId: CONV, batchId: defaultBatch.batchId }, body: 'y' });
    assert.equal(w.accountLabel, 'work');
    assert.equal(d.accountLabel, 'default');
    // a batch pin that disagrees with an explicit account is not silently preferred over it
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'default', batchId: workBatch.batchId }, body: 'x' }), code('NOT_IN_LOCAL_EXPORT'));
  });

  it('a conversation that only an OLDER batch contains still resolves and anchors; messages dropped by a newer head are refused', async () => {
    const v1 = { ...linearConversation(CONV, 3), updatedAt: iso(10) };
    const other = linearConversation(CONV2, 1);
    const v2 = { ...linearConversation(CONV, 1), updatedAt: iso(20) }; // newer head that no longer has the later turns
    const { store, repo } = await memEnv([v1]);
    // a later batch with an unrelated conversation does not move CONV's head
    await repo.importBatch({ batch: meta({ contentDigest: 'adv-other' }), conversations: [other] });
    const late = `${CONV}-u2`;
    assert.equal(store.createDraft({ conversationRef: { conversationId: CONV }, anchorMessageId: late, body: 'x' }).anchorMessageId, late);

    await repo.importBatch({ batch: meta({ contentDigest: 'adv-v2' }), conversations: [v2] });
    const [b1] = repo.listBatches();
    assert.ok(b1);
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV }, anchorMessageId: late, body: 'x' }), code('MESSAGE_NOT_FOUND'), 'the head no longer has it');
    assert.equal(
      store.createDraft({ conversationRef: { conversationId: CONV, batchId: b1.batchId }, anchorMessageId: late, body: 'x' }).anchorMessageId,
      late,
      'the older snapshot is still addressable on purpose',
    );
    // the first draft is untouched by the head move and still listed
    assert.equal(store.listDrafts({ conversationRef: { conversationId: CONV } }).total, 2);
  });
});

// ===================================================================================================================
describe('the write boundary', () => {
  it('a draft DTO has exactly the documented keys: nothing named like a delivery state can appear unnoticed', async () => {
    const { store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    assert.deepEqual(Object.keys(d).sort(), [
      'accountLabel', 'anchorMessageId', 'body', 'bodySha256', 'conversationId', 'createdAt', 'createdVia', 'draftId',
      'manualContinuation', 'namespace', 'provider', 'status', 'title', 'updatedAt',
    ]);
    assert.deepEqual(Object.keys(d.manualContinuation).sort(), ['note', 'url']);
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
    assert.deepEqual(Object.keys(a).sort(), [
      'accountLabel', 'annotationId', 'body', 'conversationId', 'createdAt', 'createdVia', 'kind', 'messageId', 'namespace', 'provider', 'updatedAt', 'version',
    ]);
    const archived = store.archiveDraft(d.draftId);
    assert.equal(archived.status, 'archived');
    assert.match(store.renderDraftMarkdown(d.draftId), /^# GCR local draft \(not sent\)$/m, 'an archived draft is still presented as not sent');
    // archiving is final: no API moves a draft back or forward
    assert.equal(store.archiveDraft(d.draftId).status, 'archived');
  });

  it('failures never carry the body or title in the error envelope (message, remedy, details, warnings)', async () => {
    const work: ConversationRecord = { ...linearConversation(CONV, 1), accountLabel: 'work' };
    const { store, repo, db } = await memEnv([linearConversation(CONV, 1)], { idFactory: () => 'dup-id' });
    await repo.importBatch({ batch: meta({ accountLabel: 'work', contentDigest: 'adv-env' }), conversations: [work] });
    const BODY = 'PLANTED-BODY-ZXQ-5521';
    const TITLE = 'PLANTED-TITLE-ZXQ-8830';
    store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, body: BODY });
    store.createAnnotation({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, body: BODY, kind: 'k' });
    const failures: Array<[string, () => unknown]> = [
      ['not in export', () => store.createDraft({ conversationRef: { conversationId: 'nope' }, title: TITLE, body: BODY })],
      ['ambiguous', () => store.createDraft({ conversationRef: { conversationId: CONV }, title: TITLE, body: BODY })],
      ['anchor missing', () => store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, anchorMessageId: 'missing', title: TITLE, body: BODY })],
      ['duplicate id (constraint)', () => store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, title: TITLE, body: BODY })],
      ['conflict', () => store.updateAnnotation('dup-id', { body: BODY, expectedVersion: 9 })],
      ['annotation anchor missing', () => store.createAnnotation({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, messageId: 'missing', body: BODY })],
      ['invalid namespace', () => store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, namespace: 'Bad Name', title: TITLE, body: BODY })],
      ['read only', () => new LocalStore(db, { readOnly: true }).createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, title: TITLE, body: BODY })],
    ];
    for (const [name, run] of failures) {
      const e = caught(run);
      const everything = JSON.stringify(e.toEnvelope()) + e.message + String(e.remedy) + JSON.stringify(e.details) + JSON.stringify(e.warnings);
      assert.ok(!everything.includes(BODY), `${name}: body text leaked`);
      assert.ok(!everything.includes(TITLE), `${name}: title text leaked`);
      assert.ok(!/UNIQUE|constraint failed|local_drafts\./i.test(everything), `${name}: SQLite text leaked`);
    }
  });
});

// ===================================================================================================================
describe('every exported function has a negative test', () => {
  it('the exported function inventory is exactly LocalStore and verifyAuditLog; every public method is exercised with bad input below', async () => {
    const exportedFunctions = Object.entries(drafts)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    assert.deepEqual(exportedFunctions, ['LocalStore', 'verifyAuditLog'], 'a new exported function needs a negative test here');

    const { h, store } = await memEnv();
    const negatives: Record<string, () => unknown> = {
      createDraft: () => store.createDraft(wrong<CreateDraftInput>({ conversationRef: { conversationId: CONV }, body: '' })),
      getDraft: () => store.getDraft('no-such-draft'),
      listDrafts: () => store.listDrafts(wrong<DraftFilter>({ status: 'sent' })),
      archiveDraft: () => store.archiveDraft('no-such-draft'),
      renderDraftMarkdown: () => store.renderDraftMarkdown('no-such-draft'),
      createAnnotation: () => store.createAnnotation(wrong<CreateAnnotationInput>({ conversationRef: { conversationId: CONV }, body: 'x', kind: 'Bad Kind' })),
      getAnnotation: () => store.getAnnotation('no-such-annotation'),
      listAnnotations: () => store.listAnnotations(wrong<AnnotationFilter>({ limit: 0 })),
      updateAnnotation: () => store.updateAnnotation('no-such-annotation', { body: 'x', expectedVersion: 1 }),
    };
    const publicMethods = Object.getOwnPropertyNames(LocalStore.prototype).filter((n) => n !== 'constructor' && typeof (store as unknown as Record<string, unknown>)[n] === 'function');
    const callable = publicMethods.filter((n) => !isPrivateMethod(n));
    assert.deepEqual([...callable].sort(), Object.keys(negatives).sort(), 'every public method has a negative case (and none is stale)');
    for (const [name, run] of Object.entries(negatives)) {
      const e = caught(run);
      assert.ok(e.code === 'INVALID_ARGUMENT' || e.code.endsWith('_NOT_FOUND'), `${name} -> ${e.code}`);
    }
    // the constructor and verifyAuditLog
    assert.throws(() => new LocalStore(wrong<DatabaseSync>(undefined)), code('INVALID_ARGUMENT'));
    const bare = new DatabaseSync(':memory:');
    try {
      assert.throws(() => verifyAuditLog(bare), code('DB_ERROR'));
    } finally {
      bare.close();
    }
    h.db.exec('DROP TRIGGER local_audit_log_no_delete');
    store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    h.db.exec('DELETE FROM local_audit_log');
    assert.equal(verifyAuditLog(h.db).ok, false);
  });
});

/** Private helpers of LocalStore are plain prototype methods in the compiled output; they are the ones below. */
function isPrivateMethod(name: string): boolean {
  return ['assertWritable', 'guard', 'transact', 'snapshot', 'now', 'newId', 'audit', 'resolveTarget', 'requireMessage', 'loadDraft', 'loadAnnotation', 'page'].includes(name);
}

// ===================================================================================================================
describe('true parallel writers (worker threads, separate connections to one file)', () => {
  // The worker is plain JavaScript evaluated by node: it re-imports the COMPILED modules by URL, so it exercises exactly the
  // code under test with its own connection. Everything it does is synchronous; the interleaving is decided by the OS.
  const WORKER_SOURCE = `
    const { parentPort, workerData } = require('node:worker_threads');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    parentPort.on('message', (m) => { if (m === 'go') release(); });
    (async () => {
      const { openDatabase, closeDatabase } = await import(workerData.openUrl);
      const { LocalStore } = await import(workerData.draftsUrl);
      const h = openDatabase(workerData.path);
      const store = new LocalStore(h.db, { actor: 'sdk' });
      parentPort.postMessage({ type: 'ready' });
      await gate;
      const out = { updates: 0, conflicts: 0, drafts: 0, archives: 0, other: [] };
      for (let round = 0; round < workerData.rounds; round++) {
        for (;;) {
          const seen = store.getAnnotation(workerData.annotationId);
          try {
            store.updateAnnotation(workerData.annotationId, { body: 'w' + workerData.index + 'r' + round, expectedVersion: seen.version });
            out.updates++;
            break;
          } catch (e) {
            if (e && e.code === 'ANNOTATION_CONFLICT') { out.conflicts++; continue; }
            out.other.push(String(e && e.code));
            break;
          }
        }
        try {
          store.createDraft({ conversationRef: { conversationId: workerData.conversationId }, body: 'd' + workerData.index + 'r' + round });
          out.drafts++;
        } catch (e) { out.other.push(String(e && e.code)); }
        try { store.archiveDraft(workerData.draftId); out.archives++; } catch (e) { out.other.push(String(e && e.code)); }
      }
      closeDatabase(h);
      parentPort.postMessage({ type: 'done', out });
    })().catch((e) => { parentPort.postMessage({ type: 'crash', message: String(e && e.message) }); });
  `;

  interface WorkerOut {
    updates: number;
    conflicts: number;
    drafts: number;
    archives: number;
    other: string[];
  }

  it('compare-and-set updates never lose or duplicate a version, one archive writes one audit row, and the log stays gap-free', { timeout: 90_000 }, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'parallel.sqlite');
      const main = openDatabase(path);
      const workers: Worker[] = [];
      try {
        await new Repository(main.db).importBatch({ batch: meta(), conversations: [linearConversation(CONV, 2)] });
        const store = new LocalStore(main.db, { clock: fixedClock(), idFactory: counterIds('main') });
        const annotation = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'base' });
        const draft = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'to be archived by everybody' });

        const WORKERS = 6;
        const ROUNDS = 6;
        const ready: Array<Promise<void>> = [];
        const done: Array<Promise<WorkerOut>> = [];
        for (let index = 0; index < WORKERS; index++) {
          const w = new Worker(WORKER_SOURCE, {
            eval: true,
            // the experimental-SQLite notice is printed once per process already; do not repeat it for every worker
            execArgv: ['--disable-warning=ExperimentalWarning'],
            workerData: {
              path,
              index,
              rounds: ROUNDS,
              annotationId: annotation.annotationId,
              draftId: draft.draftId,
              conversationId: CONV,
              openUrl: new URL('../../src/db/open.js', import.meta.url).href,
              draftsUrl: new URL('../../src/drafts/drafts.js', import.meta.url).href,
            },
          });
          workers.push(w);
          ready.push(
            new Promise<void>((resolve, reject) => {
              w.on('error', reject);
              w.on('message', (m: { type: string; message?: string }) => {
                if (m.type === 'ready') resolve();
                if (m.type === 'crash') reject(new Error(`worker crashed: ${String(m.message)}`));
              });
            }),
          );
          done.push(
            new Promise<WorkerOut>((resolve, reject) => {
              w.on('error', reject);
              w.on('message', (m: { type: string; out?: WorkerOut; message?: string }) => {
                if (m.type === 'done' && m.out !== undefined) resolve(m.out);
                if (m.type === 'crash') reject(new Error(`worker crashed: ${String(m.message)}`));
              });
            }),
          );
        }
        await Promise.all(ready);
        for (const w of workers) w.postMessage('go');
        const results = await Promise.all(done);

        const total = WORKERS * ROUNDS;
        assert.deepEqual(results.flatMap((r) => r.other), [], 'no error other than a version conflict reached any worker');
        assert.equal(results.reduce((n, r) => n + r.updates, 0), total, 'every worker eventually won every round');
        assert.equal(results.reduce((n, r) => n + r.drafts, 0), total);
        assert.equal(results.reduce((n, r) => n + r.archives, 0), total, 'archiving is idempotent for every caller');

        const final = store.getAnnotation(annotation.annotationId);
        assert.equal(final.version, 1 + total, 'no update was lost and none was applied twice');
        assert.equal(store.listDrafts().total, 1 + total);
        assert.equal(store.getDraft(draft.draftId).status, 'archived');

        const rows = main.db.prepare('SELECT seq, action, target_id, details_json FROM local_audit_log ORDER BY seq').all();
        const byAction = new Map<string, number>();
        for (const r of rows) byAction.set(String(r['action']), (byAction.get(String(r['action'])) ?? 0) + 1);
        assert.equal(byAction.get('annotation.create'), 1);
        assert.equal(byAction.get('draft.create'), 1 + total);
        assert.equal(byAction.get('annotation.update'), total);
        assert.equal(byAction.get('draft.archive'), 1, 'six concurrent archives, one real change, one audit row');
        assert.equal(rows.length, 1 + (1 + total) + total + 1);
        const fromVersions = rows
          .filter((r) => r['action'] === 'annotation.update')
          .map((r) => Number((JSON.parse(String(r['details_json'])) as { fromVersion: number }).fromVersion))
          .sort((x, y) => x - y);
        assert.deepEqual(fromVersions, Array.from({ length: total }, (_, i) => i + 1), 'each version was left exactly once: two writers never won from the same version');
        assert.deepEqual(verifyAuditLog(main.db), { rows: rows.length, ok: true });
      } finally {
        await Promise.all(workers.map((w) => w.terminate()));
        closeDatabase(main);
      }
    });
  });
});
