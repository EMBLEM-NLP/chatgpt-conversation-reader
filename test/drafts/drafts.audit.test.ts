/**
 * Tests for the append-only audit log of src/drafts/drafts.ts (SPEC FR-13: "explicit namespace and audit trail").
 * One row per mutation, written in the SAME transaction as the change (forced mid-operation failures prove both roll
 * back together), append-only enforcement by the schema triggers, tamper evidence of verifyAuditLog, and the privacy
 * rule that the log holds ids, lengths and hash prefixes only: never body text or titles. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fc from 'fast-check';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import type { GcrDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { LocalStore, verifyAuditLog } from '../../src/drafts/drafts.js';
import type { LocalStoreOptions } from '../../src/drafts/drafts.js';
import { GcrError } from '../../src/errors.js';
import { linearConversation } from '../helpers/records.js';
import { withTempDir } from '../helpers/tmp.js';

const SEED = 20261010;
const CONV = 'f00dfeed-0000-4000-8000-0000000000a1';

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'export.zip',
  contentDigest: 'audit-digest',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

function fixedClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2025, 5, 1, 0, 0, n++)).toISOString();
}

function counterIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

async function memEnv(over: LocalStoreOptions = {}, records: ConversationRecord[] = [linearConversation(CONV, 2)]): Promise<{ h: GcrDatabase; db: DatabaseSync; store: LocalStore }> {
  const h = openDatabase(':memory:');
  await new Repository(h.db).importBatch({ batch: META, conversations: records });
  return { h, db: h.db, store: new LocalStore(h.db, { clock: fixedClock(), idFactory: counterIds(), ...over }) };
}

function code(c: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === c;
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

interface AuditRow {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  raw: string;
}

function auditRows(db: DatabaseSync): AuditRow[] {
  return db
    .prepare('SELECT seq, ts, actor, action, target_type, target_id, details_json FROM local_audit_log ORDER BY seq')
    .all()
    .map((r) => ({
      seq: Number(r['seq']),
      ts: String(r['ts']),
      actor: String(r['actor']),
      action: String(r['action']),
      targetType: String(r['target_type']),
      targetId: String(r['target_id']),
      details: JSON.parse(String(r['details_json'])) as Record<string, unknown>,
      raw: JSON.stringify(r),
    }));
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Characters that would be mangled or interpreted somewhere are built from code points, never typed. */
const LONE_HIGH = String.fromCharCode(0xd800);

describe('audit log: one row per mutation', () => {
  it('records exactly one well-formed row for each kind of mutation, with ids/lengths/hash prefixes in details', async () => {
    const { db, store } = await memEnv({ actor: 'mcp' });
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, anchorMessageId: `${CONV}-u0`, title: 'Plan', body: 'héllo', namespace: 'ns1' });
    assert.equal(auditRows(db).length, 1);
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, messageId: `${CONV}-a0`, kind: 'todo', body: 'note text', namespace: 'ns2' });
    assert.equal(auditRows(db).length, 2);
    store.updateAnnotation(a.annotationId, { body: 'second text', expectedVersion: 1 });
    assert.equal(auditRows(db).length, 3);
    store.archiveDraft(d.draftId);
    const rows = auditRows(db);
    assert.equal(rows.length, 4);

    assert.deepEqual(
      rows.map((r) => [r.seq, r.ts, r.actor, r.action, r.targetType, r.targetId]),
      [
        [1, '2025-06-01T00:00:00.000Z', 'mcp', 'draft.create', 'draft', d.draftId],
        [2, '2025-06-01T00:00:01.000Z', 'mcp', 'annotation.create', 'annotation', a.annotationId],
        [3, '2025-06-01T00:00:02.000Z', 'mcp', 'annotation.update', 'annotation', a.annotationId],
        [4, '2025-06-01T00:00:03.000Z', 'mcp', 'draft.archive', 'draft', d.draftId],
      ],
    );
    const bodyBytes = Buffer.byteLength('héllo', 'utf8');
    assert.deepEqual(rows[0]?.details, {
      namespace: 'ns1',
      provider: 'chatgpt',
      accountLabel: 'default',
      conversationId: CONV,
      anchorMessageId: `${CONV}-u0`,
      bodyBytes,
      bodySha256Prefix: sha('héllo').slice(0, 12),
      titleChars: 4,
    });
    assert.equal(bodyBytes, 6, 'a two-byte character is counted in bytes');
    assert.deepEqual(rows[1]?.details, {
      namespace: 'ns2',
      kind: 'todo',
      provider: 'chatgpt',
      accountLabel: 'default',
      conversationId: CONV,
      messageId: `${CONV}-a0`,
      bodyBytes: 9,
      bodySha256Prefix: sha('note text').slice(0, 12),
    });
    assert.deepEqual(rows[2]?.details, { namespace: 'ns2', fromVersion: 1, toVersion: 2, bodyBytes: 11, bodySha256Prefix: sha('second text').slice(0, 12) });
    assert.deepEqual(rows[3]?.details, { namespace: 'ns1', provider: 'chatgpt', accountLabel: 'default', conversationId: CONV });
    assert.deepEqual(verifyAuditLog(db), { rows: 4, ok: true });
  });

  it('records the actor of the store that made the change (cli / mcp / sdk) in both created_via and the audit row', async () => {
    const { h } = await memEnv();
    for (const actor of ['cli', 'mcp', 'sdk'] as const) {
      const s = new LocalStore(h.db, { actor, clock: fixedClock(), idFactory: counterIds(actor) });
      s.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    }
    assert.deepEqual(
      auditRows(h.db).map((r) => r.actor),
      ['cli', 'mcp', 'sdk'],
    );
    assert.deepEqual(
      h.db.prepare('SELECT created_via FROM local_drafts ORDER BY rowid').all().map((r) => String(r['created_via'])),
      ['cli', 'mcp', 'sdk'],
    );
  });

  it('reads never write: get/list/render leave the log (and the data) exactly as it was', async () => {
    const { db, store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
    const before = JSON.stringify(auditRows(db));
    store.getDraft(d.draftId);
    store.getAnnotation(a.annotationId);
    store.listDrafts();
    store.listAnnotations();
    store.renderDraftMarkdown(d.draftId);
    verifyAuditLog(db);
    assert.equal(JSON.stringify(auditRows(db)), before);
  });

  it('failed operations (validation, lookup, conflict, forbidden) write no audit row and leave no gap in seq', async () => {
    const { h, db, store } = await memEnv();
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
    const attempts: Array<[string, () => unknown, string]> = [
      ['empty body', () => store.createDraft({ conversationRef: { conversationId: CONV }, body: '' }), 'INVALID_ARGUMENT'],
      ['bad namespace', () => store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x', namespace: 'No Good' }), 'INVALID_ARGUMENT'],
      ['unknown conversation', () => store.createDraft({ conversationRef: { conversationId: 'nope' }, body: 'x' }), 'NOT_IN_LOCAL_EXPORT'],
      ['unknown anchor', () => store.createDraft({ conversationRef: { conversationId: CONV }, anchorMessageId: 'nope', body: 'x' }), 'MESSAGE_NOT_FOUND'],
      ['unknown draft', () => store.archiveDraft('nope'), 'DRAFT_NOT_FOUND'],
      ['unknown annotation', () => store.updateAnnotation('nope', { body: 'x', expectedVersion: 1 }), 'ANNOTATION_NOT_FOUND'],
      ['stale version', () => store.updateAnnotation(a.annotationId, { body: 'x', expectedVersion: 9 }), 'ANNOTATION_CONFLICT'],
      ['read-only store', () => new LocalStore(h.db, { readOnly: true }).createDraft({ conversationRef: { conversationId: CONV }, body: 'x' }), 'WRITE_FORBIDDEN'],
    ];
    for (const [name, run, expected] of attempts) assert.throws(run, code(expected), name);
    assert.equal(auditRows(db).length, 1);
    store.createDraft({ conversationRef: { conversationId: CONV }, body: 'next' });
    assert.deepEqual(
      auditRows(db).map((r) => r.seq),
      [1, 2],
      'the next successful change takes the next seq: failed attempts consumed none',
    );
    assert.deepEqual(verifyAuditLog(db), { rows: 2, ok: true });
  });

  it('an idempotent archive of an already archived draft writes no second row', async () => {
    const { db, store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    store.archiveDraft(d.draftId);
    store.archiveDraft(d.draftId);
    assert.deepEqual(
      auditRows(db).map((r) => r.action),
      ['draft.create', 'draft.archive'],
    );
  });

  it('property: over random operation sequences the log has one row per successful mutation, seq is gap-free and verifyAuditLog agrees', async () => {
    type Op =
      | { t: 'draft'; body: string; ns: string; anchor: boolean }
      | { t: 'ann'; body: string; msg: boolean }
      | { t: 'upd'; pick: number; body: string; stale: boolean }
      | { t: 'arch'; pick: number }
      | { t: 'bad' };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ t: fc.constant('draft' as const), body: fc.string({ maxLength: 12 }), ns: fc.constantFrom('a', 'b', 'Bad Ns'), anchor: fc.boolean() }),
      fc.record({ t: fc.constant('ann' as const), body: fc.string({ maxLength: 12 }), msg: fc.boolean() }),
      fc.record({ t: fc.constant('upd' as const), pick: fc.nat(5), body: fc.string({ maxLength: 12 }), stale: fc.boolean() }),
      fc.record({ t: fc.constant('arch' as const), pick: fc.nat(5) }),
      fc.constant({ t: 'bad' as const }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
        const { h, db, store } = await memEnv();
        try {
          const drafts: string[] = [];
          const anns: Array<{ id: string; version: number }> = [];
          const archived = new Set<string>();
          let expectedRows = 0;
          for (const o of ops) {
            try {
              if (o.t === 'draft') {
                const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: o.body, namespace: o.ns, ...(o.anchor ? { anchorMessageId: `${CONV}-u0` } : {}) });
                drafts.push(d.draftId);
                expectedRows++;
              } else if (o.t === 'ann') {
                const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: o.body, ...(o.msg ? { messageId: `${CONV}-a0` } : {}) });
                anns.push({ id: a.annotationId, version: 1 });
                expectedRows++;
              } else if (o.t === 'upd' && anns.length > 0) {
                const target = anns[o.pick % anns.length];
                if (target === undefined) continue;
                const u = store.updateAnnotation(target.id, { body: o.body, expectedVersion: o.stale ? target.version + 1 : target.version });
                target.version = u.version;
                expectedRows++;
              } else if (o.t === 'arch' && drafts.length > 0) {
                const id = drafts[o.pick % drafts.length] ?? '';
                store.archiveDraft(id);
                if (!archived.has(id)) expectedRows++;
                archived.add(id);
              } else if (o.t === 'bad') {
                store.createDraft({ conversationRef: { conversationId: 'missing' }, body: 'x' });
              }
            } catch (e) {
              if (!(e instanceof GcrError)) throw e; // validation / conflict / not-found are expected; anything else is a bug
            }
          }
          const rows = auditRows(db);
          assert.equal(rows.length, expectedRows);
          assert.deepEqual(
            rows.map((r) => r.seq),
            rows.map((_, i) => i + 1),
          );
          assert.deepEqual(verifyAuditLog(db), { rows: expectedRows, ok: true });
        } finally {
          closeDatabase(h);
        }
      }),
      { seed: SEED, numRuns: 60 },
    );
  });
});

// ===================================================================================================================
describe('audit log: same transaction as the change', () => {
  /** A test-only trigger makes ONE statement fail at a precise point, exactly like a disk-full or constraint error would. */
  function failOn(db: DatabaseSync, table: string, when: 'INSERT' | 'UPDATE', condition = '1'): void {
    db.exec(`CREATE TEMP TRIGGER force_fail_${table}_${when.toLowerCase()} BEFORE ${when} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
  }

  it('createDraft: if the AUDIT insert fails, the draft insert is rolled back too', async () => {
    const { db, store } = await memEnv();
    failOn(db, 'local_audit_log', 'INSERT', "NEW.action = 'draft.create'");
    const e = (() => {
      try {
        store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
      } catch (err) {
        return err;
      }
      return null;
    })();
    assert.ok(e instanceof GcrError);
    assert.equal(e.code, 'DB_ERROR');
    assert.ok(!e.message.includes('forced failure'), 'SQLite text is not forwarded');
    assert.equal(count(db, 'local_drafts'), 0);
    assert.equal(count(db, 'local_audit_log'), 0);
    assert.equal(db.isTransaction, false);
    db.exec('DROP TRIGGER force_fail_local_audit_log_insert');
    assert.equal(store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' }).draftId, 'id-2', 'the store is usable again');
    assert.deepEqual(verifyAuditLog(db), { rows: 1, ok: true });
  });

  it('createDraft: if the DRAFT insert fails, no audit row is written either', async () => {
    const { db, store } = await memEnv();
    failOn(db, 'local_drafts', 'INSERT');
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' }), code('DB_ERROR'));
    assert.equal(count(db, 'local_drafts') + count(db, 'local_audit_log'), 0);
    assert.equal(db.isTransaction, false);
  });

  it('createAnnotation: audit failure rolls the annotation back', async () => {
    const { db, store } = await memEnv();
    failOn(db, 'local_audit_log', 'INSERT', "NEW.action = 'annotation.create'");
    assert.throws(() => store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'x' }), code('DB_ERROR'));
    assert.equal(count(db, 'local_annotations') + count(db, 'local_audit_log'), 0);
    assert.equal(db.isTransaction, false);
  });

  it('updateAnnotation: audit failure leaves body, version and updated_at exactly as they were', async () => {
    const { db, store } = await memEnv();
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'original' });
    failOn(db, 'local_audit_log', 'INSERT', "NEW.action = 'annotation.update'");
    assert.throws(() => store.updateAnnotation(a.annotationId, { body: 'changed', expectedVersion: 1 }), code('DB_ERROR'));
    assert.deepEqual(store.getAnnotation(a.annotationId), a);
    assert.equal(auditRows(db).length, 1);
    db.exec('DROP TRIGGER force_fail_local_audit_log_insert');
    assert.equal(store.updateAnnotation(a.annotationId, { body: 'changed', expectedVersion: 1 }).version, 2, 'retry with the same version succeeds');
  });

  it('archiveDraft: audit failure leaves the draft in status "draft"', async () => {
    const { db, store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    failOn(db, 'local_audit_log', 'INSERT', "NEW.action = 'draft.archive'");
    assert.throws(() => store.archiveDraft(d.draftId), code('DB_ERROR'));
    assert.deepEqual(store.getDraft(d.draftId), d);
    assert.equal(auditRows(db).length, 1);
  });

  it('archiveDraft: if the UPDATE fails there is no audit row', async () => {
    const { db, store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    failOn(db, 'local_drafts', 'UPDATE');
    assert.throws(() => store.archiveDraft(d.draftId), code('DB_ERROR'));
    assert.equal(store.getDraft(d.draftId).status, 'draft');
    assert.equal(auditRows(db).length, 1);
  });

  it('the change and its audit row become visible to another connection together, and not before commit', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'atomic.sqlite');
      const writer = openDatabase(path);
      const reader = openDatabase(path, { readOnly: true });
      try {
        await new Repository(writer.db).importBatch({ batch: META, conversations: [linearConversation(CONV, 1)] });
        const seen: Array<[number, number]> = [];
        const snapshot = (): void => {
          seen.push([count(reader.db, 'local_drafts'), count(reader.db, 'local_audit_log')]);
        };
        // The id factory runs INSIDE the store's transaction (after BEGIN IMMEDIATE, before the INSERTs).
        const ids = counterIds('tx');
        const store = new LocalStore(writer.db, {
          clock: fixedClock(),
          idFactory: () => {
            snapshot();
            return ids();
          },
        });
        snapshot();
        store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
        snapshot();
        assert.deepEqual(seen, [
          [0, 0], // before
          [0, 0], // inside the transaction, before any write
          [1, 1], // after commit: both at once
        ]);
      } finally {
        closeDatabase(reader);
        closeDatabase(writer);
      }
    });
  });
});

// ===================================================================================================================
describe('audit log: append-only', () => {
  async function withRows(): Promise<{ db: DatabaseSync; store: LocalStore }> {
    const env = await memEnv();
    env.store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    env.store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
    return env;
  }

  it('UPDATE of any column of any row is aborted by the schema trigger', async () => {
    const { db } = await withRows();
    const before = JSON.stringify(auditRows(db));
    for (const sql of [
      "UPDATE local_audit_log SET details_json = '{}'",
      "UPDATE local_audit_log SET actor = 'cli' WHERE seq = 1",
      "UPDATE local_audit_log SET action = 'draft.archive' WHERE seq = 2",
      'UPDATE local_audit_log SET seq = seq + 100',
      "UPDATE local_audit_log SET ts = '1999-01-01T00:00:00.000Z', target_id = 'x'",
      "UPDATE local_audit_log SET details_json = '{}' WHERE 0",
    ]) {
      if (sql.endsWith('WHERE 0')) {
        // a statement that matches no row fires no row trigger: it cannot change anything
        db.exec(sql);
        continue;
      }
      assert.throws(() => db.exec(sql), /audit log is append-only/, sql);
    }
    assert.equal(JSON.stringify(auditRows(db)), before);
  });

  it('DELETE of one row or all rows is aborted, including via INSERT OR REPLACE onto an existing seq', async () => {
    const { db } = await withRows();
    const before = JSON.stringify(auditRows(db));
    for (const sql of [
      'DELETE FROM local_audit_log',
      'DELETE FROM local_audit_log WHERE seq = 2',
      'DELETE FROM local_audit_log WHERE seq > 0',
      "INSERT OR REPLACE INTO local_audit_log (seq, ts, actor, action, target_type, target_id) VALUES (1, 't', 'cli', 'x', 'draft', 'forged')",
      "REPLACE INTO local_audit_log (seq, ts, actor, action, target_type, target_id) VALUES (2, 't', 'cli', 'x', 'draft', 'forged')",
    ]) {
      assert.throws(() => db.exec(sql), /audit log is append-only/, sql);
    }
    assert.equal(JSON.stringify(auditRows(db)), before);
    assert.deepEqual(verifyAuditLog(db), { rows: 2, ok: true });
  });

  it('the store itself never issues UPDATE or DELETE against the log (it only appends)', async () => {
    const { db, store } = await memEnv();
    // If the store ever tried to rewrite history, these aborting triggers would make every operation below fail.
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: 'x' });
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'y' });
    store.updateAnnotation(a.annotationId, { body: 'z', expectedVersion: 1 });
    store.archiveDraft(d.draftId);
    assert.equal(auditRows(db).length, 4);
  });

  it('verifyAuditLog is tamper EVIDENCE: removing a middle row, the last row, or all rows (triggers dropped) is detected', async () => {
    const tamper = async (mutate: (db: DatabaseSync) => void): Promise<{ rows: number; ok: boolean }> => {
      const { db, store } = await memEnv();
      for (let i = 0; i < 4; i++) store.createDraft({ conversationRef: { conversationId: CONV }, body: `b${i}` });
      assert.deepEqual(verifyAuditLog(db), { rows: 4, ok: true });
      db.exec('DROP TRIGGER local_audit_log_no_delete');
      db.exec('DROP TRIGGER local_audit_log_no_update');
      mutate(db);
      return verifyAuditLog(db);
    };
    assert.deepEqual(await tamper((db) => db.exec('DELETE FROM local_audit_log WHERE seq = 2')), { rows: 3, ok: false }, 'middle row');
    assert.deepEqual(await tamper((db) => db.exec('DELETE FROM local_audit_log WHERE seq = 4')), { rows: 3, ok: false }, 'last row (a plain 1..n check would miss this)');
    assert.deepEqual(await tamper((db) => db.exec('DELETE FROM local_audit_log WHERE seq = 1')), { rows: 3, ok: false }, 'first row');
    assert.deepEqual(await tamper((db) => db.exec('DELETE FROM local_audit_log')), { rows: 0, ok: false }, 'everything');
    assert.deepEqual(await tamper((db) => db.exec('UPDATE local_audit_log SET seq = seq + 10 WHERE seq = 4')), { rows: 4, ok: false }, 'renumbered row');
    assert.deepEqual(await tamper(() => undefined), { rows: 4, ok: true }, 'control: dropping the triggers alone changes no row');
  });

  it('verifyAuditLog: a fresh database is fine; a damaged schema surfaces as a GcrError, not a raw SQLite error', async () => {
    const h = openDatabase(':memory:');
    assert.deepEqual(verifyAuditLog(h.db), { rows: 0, ok: true });
    const bare = new DatabaseSync(':memory:');
    try {
      assert.throws(() => verifyAuditLog(bare), code('DB_ERROR'));
    } finally {
      bare.close();
    }
  });
});

// ===================================================================================================================
describe('audit log: privacy (no body or title text, ever)', () => {
  const NEEDLE_BODY = 'ZEBRA-QUOKKA-body-7731';
  const NEEDLE_TITLE = 'WOMBAT-LLAMA-title-4410';
  const NEEDLE_NOTE = 'OKAPI-DINGO-note-9082';
  const NEEDLE_EDIT = 'TAPIR-IBEX-edit-5523';

  it('plants distinctive strings in every text field and finds none of them (or any 6-character piece) in any audit column', async () => {
    const { db, store } = await memEnv({ actor: 'cli' });
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, title: NEEDLE_TITLE, body: `intro ${NEEDLE_BODY} outro` });
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: `see ${NEEDLE_NOTE}` });
    store.updateAnnotation(a.annotationId, { body: `now ${NEEDLE_EDIT}`, expectedVersion: 1 });
    store.archiveDraft(d.draftId);
    // control: the data tables DO contain the text, so the scan below could find it if it were there
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_drafts WHERE body LIKE ?').get(`%${NEEDLE_BODY}%`)?.['n'], 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_drafts WHERE title = ?').get(NEEDLE_TITLE)?.['n'], 1);

    const everything = auditRows(db)
      .map((r) => r.raw)
      .join('\n')
      .toLowerCase();
    for (const needle of [NEEDLE_BODY, NEEDLE_TITLE, NEEDLE_NOTE, NEEDLE_EDIT, 'intro', 'outro']) {
      assert.ok(!everything.includes(needle.toLowerCase()), `audit log contains ${needle}`);
      for (let i = 0; i + 6 <= needle.length; i++) {
        const piece = needle.slice(i, i + 6).toLowerCase();
        // the word "draft"/"title"/"note"-like tokens legitimately occur in keys (titleChars) and action names
        if (/^(draft|title|body-|-body|-note|note|titlec)/.test(piece)) continue;
        assert.ok(!everything.includes(piece), `audit log contains the fragment ${piece} of ${needle}`);
      }
    }
  });

  it('holds only a SHORT hash prefix: the full body hash never appears, and the prefix is 12 hex characters', async () => {
    const { db, store } = await memEnv();
    const d = store.createDraft({ conversationRef: { conversationId: CONV }, body: NEEDLE_BODY });
    const rows = auditRows(db);
    assert.ok(!/[0-9a-f]{64}/.test(rows.map((r) => r.raw).join('')), 'no full sha256 in the log');
    const prefix = rows[0]?.details['bodySha256Prefix'];
    assert.equal(typeof prefix, 'string');
    assert.match(String(prefix), /^[0-9a-f]{12}$/);
    assert.ok(d.bodySha256.startsWith(String(prefix)));
  });

  it('every detail value is an id, a number, a short token or null: no value is longer than the longest id', async () => {
    const { db, store } = await memEnv();
    store.createDraft({ conversationRef: { conversationId: CONV }, anchorMessageId: `${CONV}-u0`, title: 'x'.repeat(200), body: 'y'.repeat(100_000), namespace: 'ns' });
    const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: 'z'.repeat(50_000) });
    store.updateAnnotation(a.annotationId, { body: 'w'.repeat(60_000), expectedVersion: 1 });
    for (const r of auditRows(db)) {
      assert.ok(r.raw.length < 700, `audit row is small (${r.raw.length} chars) regardless of body size`);
      for (const v of Object.values(r.details)) assert.ok(v === null || typeof v === 'number' || (typeof v === 'string' && v.length <= 80), JSON.stringify(v));
    }
  });

  it('a hostile title or body (control characters, lone-surrogate attempts, SQL) is not reflected into the log; rejected input leaves no trace', async () => {
    const { db, store } = await memEnv();
    const payload = "'); DROP TABLE local_audit_log; --";
    store.createDraft({ conversationRef: { conversationId: CONV }, title: payload, body: payload });
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV }, title: payload + LONE_HIGH, body: payload }), code('INVALID_ARGUMENT'));
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV }, body: payload, namespace: payload }), code('INVALID_ARGUMENT'));
    const log = auditRows(db).map((r) => r.raw).join('\n');
    assert.ok(!log.includes('DROP TABLE'));
    assert.equal(auditRows(db).length, 1);
    assert.deepEqual(verifyAuditLog(db), { rows: 1, ok: true });
  });

  it('nothing is written to stdout or stderr by any store operation (log hygiene)', async () => {
    const { store } = await memEnv();
    const captured: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const grab = ((chunk: unknown): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    // Only OBSERVES: replaced for the duration of the synchronous calls below and always restored.
    process.stdout.write = grab;
    process.stderr.write = grab;
    try {
      const d = store.createDraft({ conversationRef: { conversationId: CONV }, title: NEEDLE_TITLE, body: NEEDLE_BODY });
      const a = store.createAnnotation({ conversationRef: { conversationId: CONV }, body: NEEDLE_NOTE });
      store.updateAnnotation(a.annotationId, { body: NEEDLE_EDIT, expectedVersion: 1 });
      store.archiveDraft(d.draftId);
      store.listDrafts();
      store.renderDraftMarkdown(d.draftId);
      try {
        store.createDraft({ conversationRef: { conversationId: 'missing' }, body: NEEDLE_BODY });
      } catch {
        /* expected */
      }
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    assert.deepEqual(captured, []);
  });
});
