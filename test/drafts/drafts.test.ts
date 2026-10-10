/**
 * Tests for src/drafts/drafts.ts (SPEC FR-13, Mode C): drafts and annotations over the real SQLite schema.
 * Functional behaviour, validation (exact error codes), conversation resolution, namespaces, optimistic concurrency,
 * read-only handles, re-import survival and the immutability of imported tables. Audit-log and security tests live in
 * the sibling files. All data is synthetic; test databases are built through the real Repository.importBatch.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import type { GcrDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import {
  DEFAULT_NAMESPACE,
  LocalStore,
  MANUAL_CONTINUATION_NOTE,
  MAX_ANNOTATION_BODY_BYTES,
  MAX_DRAFT_BODY_BYTES,
  verifyAuditLog,
} from '../../src/drafts/drafts.js';
import type { AnnotationFilter, CreateAnnotationInput, CreateDraftInput, DraftFilter, LocalStoreOptions } from '../../src/drafts/drafts.js';
import { GcrError } from '../../src/errors.js';
import { branchedConversation, iso, linearConversation } from '../helpers/records.js';
import { withTempDir } from '../helpers/tmp.js';

const CONV = 'f00dfeed-0000-4000-8000-000000000001';
const CONV2 = 'f00dfeed-0000-4000-8000-000000000002';

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

function meta(over: Partial<ImportBatchMeta> = {}): ImportBatchMeta {
  return { ...META, ...over };
}

/** 2025-06-01T00:00:00Z, one second further on every call. */
function fixedClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2025, 5, 1, 0, 0, n++)).toISOString();
}

function counterIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

interface Env {
  h: GcrDatabase;
  db: DatabaseSync;
  repo: Repository;
  store: LocalStore;
}

async function memEnv(records: ConversationRecord[] = [linearConversation(CONV, 2)], storeOpts: LocalStoreOptions = {}): Promise<Env> {
  const h = openDatabase(':memory:');
  const repo = new Repository(h.db);
  if (records.length > 0) await repo.importBatch({ batch: meta(), conversations: records });
  const store = new LocalStore(h.db, { clock: fixedClock(), idFactory: counterIds(), ...storeOpts });
  return { h, db: h.db, repo, store };
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

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

const IMPORTED_TABLES = ['source_batches', 'source_batch_stats', 'conversations', 'messages', 'conversation_heads', 'messages_fts_docsize', 'conversations_fts_docsize'];

/** sha256 over every imported row AND the raw FTS blocks: equal hashes mean byte-identical imported content. */
function dumpHash(db: DatabaseSync): string {
  const h = createHash('sha256');
  for (const t of IMPORTED_TABLES) {
    h.update(`\n#${t}\n`);
    h.update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  }
  for (const t of ['messages_fts_data', 'conversations_fts_data']) {
    h.update(`\n#${t}\n`);
    for (const r of db.prepare(`SELECT id, block FROM ${t} ORDER BY id`).all()) {
      h.update(String(r['id']));
      const block = r['block'];
      if (block instanceof Uint8Array) h.update(block);
    }
  }
  return h.digest('hex');
}

function draftInput(over: Partial<CreateDraftInput> = {}): CreateDraftInput {
  return { conversationRef: { conversationId: CONV }, body: 'draft body', ...over };
}

function annInput(over: Partial<CreateAnnotationInput> = {}): CreateAnnotationInput {
  return { conversationRef: { conversationId: CONV }, body: 'annotation body', ...over };
}

/** Call the API with deliberately wrongly typed input (the point of the negative tests). */
function wrong<T>(v: unknown): T {
  return v as T;
}

// ===================================================================================================================
describe('drafts: create / get / list / archive', () => {
  it('round-trips a draft with exact field values and a text-only manual-continuation link', async () => {
    const { store } = await memEnv();
    const d = store.createDraft(draftInput({ anchorMessageId: `${CONV}-a1`, title: 'My title', body: 'Hello\nworld' }));
    assert.deepEqual(d, {
      draftId: 'id-1',
      namespace: 'default',
      provider: 'chatgpt',
      accountLabel: 'default',
      conversationId: CONV,
      anchorMessageId: `${CONV}-a1`,
      title: 'My title',
      body: 'Hello\nworld',
      bodySha256: sha256('Hello\nworld'),
      status: 'draft',
      createdAt: '2025-06-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
      createdVia: 'sdk',
      manualContinuation: { url: `https://chatgpt.com/c/${CONV}`, note: 'GCR never sends messages; open this link yourself and paste the draft' },
    });
    assert.equal(d.manualContinuation.note, MANUAL_CONTINUATION_NOTE);
    assert.deepEqual(store.getDraft('id-1'), d);
    assert.deepEqual(store.listDrafts(), { items: [d], limit: 50, offset: 0, total: 1, nextOffset: null });
  });

  it('archives a draft (status, updated_at) and archiving again is an idempotent no-op that consumes no clock tick', async () => {
    const { store, db } = await memEnv();
    const d = store.createDraft(draftInput());
    const a = store.archiveDraft(d.draftId);
    assert.equal(a.status, 'archived');
    assert.equal(a.createdAt, '2025-06-01T00:00:00.000Z');
    assert.equal(a.updatedAt, '2025-06-01T00:00:01.000Z');
    assert.deepEqual({ ...a, status: 'draft', updatedAt: d.updatedAt }, d, 'only status and updated_at change');
    const again = store.archiveDraft(d.draftId);
    assert.deepEqual(again, a);
    assert.equal(store.createDraft(draftInput()).createdAt, '2025-06-01T00:00:02.000Z', 'the no-op did not call the clock');
    assert.equal(count(db, 'local_audit_log'), 3, 'create, archive, create: the no-op archive wrote nothing');
  });

  it('filters by status and lists newest first with a deterministic tie-break', async () => {
    const fixed = '2025-06-01T00:00:00.000Z';
    const { store } = await memEnv(undefined, { clock: () => fixed });
    const ids = [1, 2, 3].map((i) => store.createDraft(draftInput({ body: `b${i}` })).draftId);
    store.archiveDraft(ids[1] ?? '');
    assert.deepEqual(store.listDrafts().items.map((d) => d.draftId), ['id-3', 'id-2', 'id-1'], 'equal timestamps: newest insert first');
    assert.deepEqual(store.listDrafts({ status: 'draft' }).items.map((d) => d.draftId), ['id-3', 'id-1']);
    assert.deepEqual(store.listDrafts({ status: 'archived' }).items.map((d) => d.draftId), ['id-2']);
    assert.equal(store.listDrafts({ status: 'archived' }).total, 1);
    assert.throws(() => store.listDrafts({ status: wrong<'draft'>('sent') }), code('INVALID_ARGUMENT'));
    assert.throws(() => store.listDrafts({ status: wrong<'draft'>('') }), code('INVALID_ARGUMENT'));
  });

  it('pages with limit/offset/total/nextOffset and validates the paging arguments', async () => {
    const { store } = await memEnv();
    for (let i = 0; i < 7; i++) store.createDraft(draftInput({ body: `b${i}` }));
    const p1 = store.listDrafts({ limit: 3 });
    const p2 = store.listDrafts({ limit: 3, offset: 3 });
    const p3 = store.listDrafts({ limit: 3, offset: 6 });
    assert.deepEqual([p1.items.length, p2.items.length, p3.items.length], [3, 3, 1]);
    assert.deepEqual([p1.total, p1.nextOffset, p2.nextOffset, p3.nextOffset], [7, 3, 6, null]);
    const all = [...p1.items, ...p2.items, ...p3.items].map((d) => d.draftId);
    assert.deepEqual(all, ['id-7', 'id-6', 'id-5', 'id-4', 'id-3', 'id-2', 'id-1'], 'no repeat, no skip');
    assert.deepEqual(store.listDrafts({ offset: 50 }), { items: [], limit: 50, offset: 50, total: 7, nextOffset: null });
    for (const limit of [0, -1, 201, 1.5, Number.NaN, Number.POSITIVE_INFINITY, wrong<number>('5'), wrong<number>(null)]) {
      assert.throws(() => store.listDrafts({ limit }), code('INVALID_ARGUMENT'), `limit ${String(limit)}`);
    }
    for (const offset of [-1, 1.5, Number.NaN, 10_000_001, wrong<number>('0')]) {
      assert.throws(() => store.listDrafts({ offset }), code('INVALID_ARGUMENT'), `offset ${String(offset)}`);
    }
    assert.equal(store.listDrafts({ limit: 200 }).limit, 200);
    assert.equal(store.listDrafts({ limit: 1 }).items.length, 1);
  });

  it('filters by conversation (optionally narrowed by provider/account); an unknown conversation lists nothing', async () => {
    const work: ConversationRecord = { ...linearConversation(CONV, 1), accountLabel: 'work' };
    const { store, repo } = await memEnv([linearConversation(CONV, 1), linearConversation(CONV2, 1)]);
    await repo.importBatch({ batch: meta({ accountLabel: 'work', contentDigest: 'w' }), conversations: [work] });
    const dDefault = store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'default' }, body: 'a' });
    const dWork = store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, body: 'b' });
    const d2 = store.createDraft({ conversationRef: { conversationId: CONV2 }, body: 'c' });
    const ids = (f: Parameters<LocalStore['listDrafts']>[0]): string[] => store.listDrafts(f).items.map((d) => d.draftId).sort();
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV } }), [dDefault.draftId, dWork.draftId].sort(), 'no account given: both accounts, each labelled');
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV, accountLabel: 'work' } }), [dWork.draftId]);
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV, provider: 'chatgpt', accountLabel: 'default' } }), [dDefault.draftId]);
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV2 } }), [d2.draftId]);
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV, provider: 'claude' } }), []);
    assert.deepEqual(ids({ conversationRef: { conversationId: 'f00dfeed-0000-4000-8000-0000000000ff' } }), []);
    assert.equal(ids({}).length, 3);
  });

  it('unknown ids are DRAFT_NOT_FOUND; malformed ids are INVALID_ARGUMENT', async () => {
    const { store } = await memEnv();
    for (const f of [(id: string) => store.getDraft(id), (id: string) => store.archiveDraft(id), (id: string) => store.renderDraftMarkdown(id)]) {
      assert.throws(() => f('no-such-draft'), code('DRAFT_NOT_FOUND'));
      for (const bad of ['', 'x'.repeat(129), 'a\0b', wrong<string>(42), wrong<string>(null), wrong<string>(undefined), wrong<string>({})]) {
        assert.throws(() => f(bad), code('INVALID_ARGUMENT'));
      }
    }
    assert.throws(() => store.getAnnotation('nope'), code('ANNOTATION_NOT_FOUND'));
    assert.throws(() => store.getAnnotation(''), code('INVALID_ARGUMENT'));
  });

  it('records the actor in created_via', async () => {
    for (const actor of ['cli', 'mcp', 'sdk'] as const) {
      const { store } = await memEnv(undefined, { actor });
      assert.equal(store.createDraft(draftInput()).createdVia, actor);
      assert.equal(store.createAnnotation(annInput()).createdVia, actor);
    }
  });

  it('returns manualContinuation text only for ChatGPT conversations with a UUID id', async () => {
    const claude: ConversationRecord = { ...linearConversation(CONV2, 1), provider: 'claude', provenance: 'official_claude_export' };
    const plain = linearConversation('not-a-uuid', 1);
    const upper = linearConversation('F00DFEED-0000-4000-8000-0000000000AA', 1);
    const { store, repo } = await memEnv([plain, upper]);
    await repo.importBatch({ batch: meta({ provider: 'claude', provenance: 'official_claude_export', contentDigest: 'cl' }), conversations: [claude] });
    const forClaude = store.createDraft({ conversationRef: { conversationId: CONV2 }, body: 'x' });
    assert.equal(forClaude.provider, 'claude');
    assert.equal(forClaude.manualContinuation.url, null, 'no invented link for other providers');
    assert.match(forClaude.manualContinuation.note, /^GCR never sends messages/);
    assert.equal(store.createDraft({ conversationRef: { conversationId: 'not-a-uuid' }, body: 'x' }).manualContinuation.url, null);
    const up = store.createDraft({ conversationRef: { conversationId: 'F00DFEED-0000-4000-8000-0000000000AA' }, body: 'x' });
    assert.equal(up.conversationId, 'F00DFEED-0000-4000-8000-0000000000AA', 'the stored id is not rewritten');
    assert.equal(up.manualContinuation.url, 'https://chatgpt.com/c/f00dfeed-0000-4000-8000-0000000000aa', 'the link uses the canonical lower-case form');
  });
});

// ===================================================================================================================
describe('drafts: validation (exact error codes, nothing stored on failure)', () => {
  it('body: 1 byte .. 256 KiB of UTF-8 after NUL stripping, counted in bytes', async () => {
    const { store, db } = await memEnv();
    const ok = (body: string): void => {
      store.createDraft(draftInput({ body }));
    };
    const bad = (body: unknown): void => {
      assert.throws(() => store.createDraft(draftInput({ body: wrong<string>(body) })), code('INVALID_ARGUMENT'));
    };
    ok('x'); // 1 byte
    ok('a'.repeat(MAX_DRAFT_BODY_BYTES));
    bad('a'.repeat(MAX_DRAFT_BODY_BYTES + 1));
    ok('\u{1F600}'.repeat(MAX_DRAFT_BODY_BYTES / 4)); // 4-byte characters, exactly at the limit
    bad('\u{1F600}'.repeat(MAX_DRAFT_BODY_BYTES / 4 + 1));
    ok('é'.repeat(MAX_DRAFT_BODY_BYTES / 2));
    bad('é'.repeat(MAX_DRAFT_BODY_BYTES / 2 + 1));
    bad('é'.repeat(140_000)); // fewer characters than the limit, more bytes
    ok('a'.repeat(MAX_DRAFT_BODY_BYTES) + '\0'.repeat(1000)); // NULs are stripped BEFORE measuring
    bad('a'.repeat(MAX_DRAFT_BODY_BYTES + 1) + '\0');
    bad('a'.repeat(20_000_000)); // absurd input is refused without being processed
    bad('');
    bad('\0');
    bad('\0'.repeat(50));
    for (const v of [null, undefined, 42, true, {}, [], ['a']]) bad(v);
    assert.equal(count(db, 'local_drafts'), 5, 'only the five accepted bodies were stored');
  });

  it('body: NUL bytes are stripped and the stored text and hash are those of the stripped string', async () => {
    const { store } = await memEnv();
    const d = store.createDraft(draftInput({ body: 'a\0b\0\0c' }));
    assert.equal(d.body, 'abc');
    assert.equal(d.bodySha256, sha256('abc'));
    assert.equal(store.getDraft(d.draftId).body, 'abc');
  });

  it('body and title: lone surrogates are refused (SQLite would silently rewrite them and break the hash)', async () => {
    const { store } = await memEnv();
    for (const s of ['\ud800', 'x\udc00y', 'a\ud83d', '\udc00\ud800']) {
      assert.throws(() => store.createDraft(draftInput({ body: s })), code('INVALID_ARGUMENT'));
      assert.throws(() => store.createDraft(draftInput({ title: s })), code('INVALID_ARGUMENT'));
    }
    store.createDraft(draftInput({ body: '😀', title: '😀' })); // a well-formed pair is fine
  });

  it('title: at most 200 characters (code points), null/undefined/empty mean "no title"', async () => {
    const { store, db } = await memEnv();
    assert.equal(store.createDraft(draftInput({ title: 't'.repeat(200) })).title?.length, 200);
    assert.equal(store.createDraft(draftInput({ title: '\u{1F600}'.repeat(200) })).title, '\u{1F600}'.repeat(200), '200 astral characters = 400 UTF-16 units but 200 characters');
    for (const t of ['t'.repeat(201), '\u{1F600}'.repeat(201)]) {
      assert.throws(() => store.createDraft(draftInput({ title: t })), code('INVALID_ARGUMENT'));
    }
    for (const t of [42, true, {}, ['x']]) assert.throws(() => store.createDraft(draftInput({ title: wrong<string>(t) })), code('INVALID_ARGUMENT'));
    for (const t of [undefined, null, '', '\0\0']) assert.equal(store.createDraft(draftInput({ title: t })).title, null);
    assert.equal(store.createDraft(draftInput({ title: 'ti\0tle' })).title, 'title');
    assert.equal(count(db, 'local_drafts'), 7);
  });

  it('namespace: /^[a-z0-9][a-z0-9_.-]{0,63}$/, default "default"', async () => {
    const { store } = await memEnv();
    assert.equal(store.createDraft(draftInput()).namespace, DEFAULT_NAMESPACE);
    for (const ns of ['a', '0', 'default', 'agent-1.x_y', 'a'.repeat(64), 'a.b-c_d']) {
      assert.equal(store.createDraft(draftInput({ namespace: ns })).namespace, ns);
    }
    const invalid = ['', 'Default', 'A', '-a', '_a', '.a', 'a'.repeat(65), 'a b', 'a/b', 'a\\b', 'é', 'a\n', '\na', 'a\0', "a'; DROP TABLE local_drafts;--", 'a;b', 'a%', '../x'];
    for (const ns of invalid) assert.throws(() => store.createDraft(draftInput({ namespace: ns })), code('INVALID_ARGUMENT'), JSON.stringify(ns));
    for (const ns of [null, 5, {}, true]) assert.throws(() => store.createDraft(draftInput({ namespace: wrong<string>(ns) })), code('INVALID_ARGUMENT'));
  });

  it('input shape: unknown fields (including a "status") and malformed refs/anchors are INVALID_ARGUMENT and store nothing', async () => {
    const { store, db } = await memEnv();
    const cases: unknown[] = [
      null,
      undefined,
      'text',
      42,
      [],
      { ...draftInput(), status: 'sent' },
      { ...draftInput(), send: true },
      { ...draftInput(), sent: true },
      { ...draftInput(), batchId: 'b' },
      { body: 'no ref' },
      { conversationRef: null, body: 'x' },
      { conversationRef: 'f00d', body: 'x' },
      { conversationRef: {}, body: 'x' },
      { conversationRef: { conversationId: '' }, body: 'x' },
      { conversationRef: { conversationId: 42 }, body: 'x' },
      { conversationRef: { conversationId: 'a\0b' }, body: 'x' },
      { conversationRef: { conversationId: 'x'.repeat(513) }, body: 'x' },
      { conversationRef: { conversationId: CONV, provider: 'bogus' }, body: 'x' },
      { conversationRef: { conversationId: CONV, provider: 42 }, body: 'x' },
      { conversationRef: { conversationId: CONV, accountLabel: '' }, body: 'x' },
      { conversationRef: { conversationId: CONV, extra: 1 }, body: 'x' },
      { ...draftInput(), anchorMessageId: '' },
      { ...draftInput(), anchorMessageId: 7 },
      { ...draftInput(), anchorMessageId: 'a\0b' },
      { ...draftInput(), anchorMessageId: 'x'.repeat(513) },
    ];
    for (const c of cases) {
      assert.throws(() => store.createDraft(wrong<CreateDraftInput>(c)), code('INVALID_ARGUMENT'));
    }
    assert.equal(count(db, 'local_drafts'), 0);
    assert.equal(count(db, 'local_audit_log'), 0);
    assert.equal(store.createDraft(draftInput()).draftId, 'id-1', 'failed calls did not consume ids');
  });

  it('error messages never echo the offending value', async () => {
    const { store } = await memEnv();
    const secret = 'SECRET-VALUE-9f3a';
    const probes: Array<[string, () => unknown]> = [
      ['namespace', () => store.createDraft(draftInput({ namespace: secret }))],
      ['unknown field', () => store.createDraft({ ...draftInput(), [secret]: 1 } as CreateDraftInput)],
      ['title', () => store.createDraft(draftInput({ title: secret.repeat(40) }))],
      ['anchor id with NUL', () => store.createDraft(draftInput({ anchorMessageId: `${secret}\0` }))],
      ['conversation id with NUL', () => store.createDraft({ conversationRef: { conversationId: `${secret}\0` }, body: 'x' })],
      ['provider', () => store.createDraft({ conversationRef: { conversationId: CONV, provider: secret as 'chatgpt' }, body: 'x' })],
      ['status filter', () => store.listDrafts({ status: secret as 'draft' })],
      ['kind', () => store.createAnnotation(annInput({ kind: secret }))],
      ['draft id with NUL', () => store.getDraft(`${secret}\0`)],
      ['unknown conversation', () => store.createDraft({ conversationRef: { conversationId: secret }, body: 'x' })],
      ['unknown anchor', () => store.createDraft(draftInput({ anchorMessageId: secret }))],
      ['unknown draft', () => store.getDraft(secret)],
    ];
    for (const [name, probe] of probes) {
      const e = caught(probe);
      assert.ok(!e.message.includes(secret), `${name}: message`);
      assert.ok(!(e.remedy ?? '').includes(secret), `${name}: remedy`);
      // INVALID_ARGUMENT details name the FIELD only. Lookup failures (NOT_FOUND family) may name the id the caller asked for.
      if (e.code === 'INVALID_ARGUMENT') assert.ok(!JSON.stringify(e.details ?? {}).includes(secret), `${name}: details`);
    }
  });
});

// ===================================================================================================================
describe('drafts: conversation resolution', () => {
  it('a conversation that was never imported is NOT_IN_LOCAL_EXPORT with a remedy that says to import the export', async () => {
    const { store, db } = await memEnv();
    const e = caught(() => store.createDraft({ conversationRef: { conversationId: 'f00dfeed-0000-4000-8000-0000000000ee' }, body: 'x' }));
    assert.equal(e.code, 'NOT_IN_LOCAL_EXPORT');
    assert.match(e.remedy ?? '', /import/i);
    assert.match(e.remedy ?? '', /export/i);
    assert.equal(e.details?.['conversationId'], 'f00dfeed-0000-4000-8000-0000000000ee');
    assert.equal(count(db, 'local_drafts'), 0);
    assert.equal(count(db, 'local_audit_log'), 0);
    assert.throws(() => store.createAnnotation({ conversationRef: { conversationId: 'nope' }, body: 'x' }), code('NOT_IN_LOCAL_EXPORT'));
  });

  it('an empty database (nothing imported) behaves the same way', async () => {
    const { store } = await memEnv([]);
    assert.throws(() => store.createDraft(draftInput()), code('NOT_IN_LOCAL_EXPORT'));
  });

  it('the wrong provider or account for an existing id is NOT_IN_LOCAL_EXPORT, never a silent fallback', async () => {
    const { store } = await memEnv();
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV, provider: 'claude' }, body: 'x' }), code('NOT_IN_LOCAL_EXPORT'));
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, body: 'x' }), code('NOT_IN_LOCAL_EXPORT'));
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV, batchId: 'b_doesnotexist' }, body: 'x' }), code('NOT_IN_LOCAL_EXPORT'));
  });

  it('an id present under several accounts/providers is AMBIGUOUS_CONVERSATION until the ref disambiguates', async () => {
    const work: ConversationRecord = { ...linearConversation(CONV, 1), accountLabel: 'work' };
    const claude: ConversationRecord = { ...linearConversation(CONV, 1), provider: 'claude', provenance: 'official_claude_export' };
    const { store, repo, db } = await memEnv([linearConversation(CONV, 1)]);
    await repo.importBatch({ batch: meta({ accountLabel: 'work', contentDigest: 'w' }), conversations: [work] });
    const e = caught(() => store.createDraft(draftInput()));
    assert.equal(e.code, 'AMBIGUOUS_CONVERSATION');
    assert.match(e.remedy ?? '', /provider|account/i);
    assert.equal(count(db, 'local_drafts'), 0, 'nothing was written for the ambiguous call');
    assert.throws(() => store.createAnnotation(annInput()), code('AMBIGUOUS_CONVERSATION'));

    const w = store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'work' }, body: 'x' });
    assert.equal(w.accountLabel, 'work');
    const d = store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'default' }, body: 'x' });
    assert.equal(d.accountLabel, 'default');

    await repo.importBatch({ batch: meta({ provider: 'claude', provenance: 'official_claude_export', contentDigest: 'c' }), conversations: [claude] });
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV, accountLabel: 'default' }, body: 'x' }), code('AMBIGUOUS_CONVERSATION'), 'same account label, two providers');
    assert.equal(store.createDraft({ conversationRef: { conversationId: CONV, provider: 'claude' }, body: 'x' }).provider, 'claude');
    assert.equal(store.createDraft({ conversationRef: { conversationId: CONV, provider: 'chatgpt', accountLabel: 'work' }, body: 'x' }).accountLabel, 'work');
  });

  it('the anchor message must exist in THAT conversation (MESSAGE_NOT_FOUND otherwise)', async () => {
    const { store, db } = await memEnv([linearConversation(CONV, 2), linearConversation(CONV2, 1)]);
    assert.equal(store.createDraft(draftInput({ anchorMessageId: `${CONV}-u0` })).anchorMessageId, `${CONV}-u0`);
    assert.equal(store.createDraft(draftInput({ anchorMessageId: `${CONV}-root` })).anchorMessageId, `${CONV}-root`, 'a stored structural node exists in the conversation');
    const e = caught(() => store.createDraft(draftInput({ anchorMessageId: 'no-such-message' })));
    assert.equal(e.code, 'MESSAGE_NOT_FOUND');
    assert.match(e.remedy ?? '', /message id/i);
    assert.throws(() => store.createDraft(draftInput({ anchorMessageId: `${CONV2}-u0` })), code('MESSAGE_NOT_FOUND'), 'a message of ANOTHER conversation');
    assert.throws(() => store.createDraft(draftInput({ anchorMessageId: `${CONV}-U0` })), code('MESSAGE_NOT_FOUND'), 'ids are case-sensitive');
    assert.throws(() => store.createAnnotation(annInput({ messageId: 'no-such-message' })), code('MESSAGE_NOT_FOUND'));
    assert.throws(() => store.createAnnotation(annInput({ messageId: `${CONV2}-u0` })), code('MESSAGE_NOT_FOUND'));
    assert.equal(count(db, 'local_drafts'), 2);
    assert.equal(count(db, 'local_annotations'), 0);
  });

  it('a pinned batchId resolves against that snapshot only (anchor existence included)', async () => {
    const v1 = { ...linearConversation(CONV, 1), updatedAt: iso(10) };
    const v2 = { ...linearConversation(CONV, 3), updatedAt: iso(20) };
    const { store, repo } = await memEnv([v1]);
    await repo.importBatch({ batch: meta({ contentDigest: 'v2' }), conversations: [v2] });
    const [b1, b2] = repo.listBatches();
    assert.ok(b1 && b2);
    assert.equal(repo.resolveConversation({ conversationId: CONV }).matches[0]?.batchId, b2.batchId, 'precondition: v2 is the head');
    const late = `${CONV}-u2`; // exists only in v2
    assert.equal(store.createDraft(draftInput({ anchorMessageId: late })).anchorMessageId, late);
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: CONV, batchId: b1.batchId }, anchorMessageId: late, body: 'x' }), code('MESSAGE_NOT_FOUND'));
    const pinned = store.createDraft({ conversationRef: { conversationId: CONV, batchId: b1.batchId }, anchorMessageId: `${CONV}-u0`, body: 'x' });
    assert.equal(pinned.conversationId, CONV);
    assert.equal(store.createDraft({ conversationRef: { conversationId: CONV, batchId: b2.batchId }, anchorMessageId: late, body: 'x' }).anchorMessageId, late);
    // listing ignores batch pins: anchors are batch-independent
    assert.equal(store.listDrafts({ conversationRef: { conversationId: CONV, batchId: b1.batchId } }).total, 3);
  });
});

// ===================================================================================================================
describe('drafts: independence from imported data', () => {
  it('a draft and its anchor survive a re-import of the same conversation as a NEW batch', async () => {
    const v1 = { ...branchedConversation(CONV), updatedAt: iso(10) };
    const { store, repo, db } = await memEnv([v1]);
    const anchor = `${CONV}-a1_new`;
    const draft = store.createDraft(draftInput({ anchorMessageId: anchor, title: 'keep me' }));
    const ann = store.createAnnotation(annInput({ messageId: anchor }));
    const headBefore = repo.resolveConversation({ conversationId: CONV }).matches[0]?.batchId;

    // A later export of the same conversation: same message ids, newer updated_at, edited title -> a new batch and a new head.
    const v2: ConversationRecord = { ...branchedConversation(CONV), updatedAt: iso(99), title: 'edited later' };
    const re = await repo.importBatch({ batch: meta({ contentDigest: 'export-2' }), conversations: [v2] });
    assert.equal(re.alreadyImported, false);
    const headAfter = repo.resolveConversation({ conversationId: CONV }).matches[0]?.batchId;
    assert.notEqual(headAfter, headBefore, 'the head moved to the new batch');

    assert.deepEqual(store.listDrafts({ conversationRef: { conversationId: CONV } }).items, [draft], 'still listed');
    assert.deepEqual(store.getDraft(draft.draftId), draft);
    assert.deepEqual(store.getAnnotation(ann.annotationId), ann);
    assert.ok(repo.getMessage({ conversationId: CONV }, anchor), 'the anchor message resolves in the NEW head batch');
    assert.equal(store.createDraft(draftInput({ anchorMessageId: anchor })).anchorMessageId, anchor, 'new drafts anchor into the new head');

    const cols = db.prepare('PRAGMA table_info(local_drafts)').all().map((r) => String(r['name']));
    assert.ok(!cols.some((c) => /batch/i.test(c)), 'drafts carry no source-batch column');
    const acols = db.prepare('PRAGMA table_info(local_annotations)').all().map((r) => String(r['name']));
    assert.ok(!acols.some((c) => /batch/i.test(c)), 'annotations carry no source-batch column');
  });

  it('re-importing the very same input (an idempotent no-op) leaves local data untouched', async () => {
    const { store, repo } = await memEnv();
    const d = store.createDraft(draftInput());
    const again = await repo.importBatch({ batch: meta(), conversations: [linearConversation(CONV, 2)] });
    assert.equal(again.alreadyImported, true);
    assert.deepEqual(store.getDraft(d.draftId), d);
  });

  it('imported tables stay byte-identical across every draft/annotation operation, successful or failing', async () => {
    const { store, db } = await memEnv([linearConversation(CONV, 3), branchedConversation(CONV2)]);
    const before = dumpHash(db);
    const d = store.createDraft(draftInput({ anchorMessageId: `${CONV}-a2`, title: 't', body: "'; DELETE FROM messages; --" }));
    const a = store.createAnnotation(annInput({ messageId: `${CONV}-u1`, kind: 'todo' }));
    store.updateAnnotation(a.annotationId, { body: 'v2', expectedVersion: 1 });
    store.archiveDraft(d.draftId);
    assert.throws(() => store.updateAnnotation(a.annotationId, { body: 'stale', expectedVersion: 1 }), code('ANNOTATION_CONFLICT'));
    assert.throws(() => store.createDraft(draftInput({ anchorMessageId: 'missing' })), code('MESSAGE_NOT_FOUND'));
    assert.throws(() => store.createDraft(draftInput({ body: '' })), code('INVALID_ARGUMENT'));
    store.listDrafts();
    store.listAnnotations();
    store.renderDraftMarkdown(d.draftId);
    assert.equal(dumpHash(db), before);
    assert.equal(count(db, 'local_drafts'), 1);
    assert.equal(count(db, 'local_annotations'), 1);
  });

  it('the imported tables cannot be reached through the store: a hostile id only ever matches as data', async () => {
    const { store, db } = await memEnv();
    const before = dumpHash(db);
    const payload = "x' OR '1'='1";
    assert.throws(() => store.createDraft({ conversationRef: { conversationId: payload }, body: 'x' }), code('NOT_IN_LOCAL_EXPORT'));
    assert.throws(() => store.createDraft(draftInput({ anchorMessageId: payload })), code('MESSAGE_NOT_FOUND'));
    assert.equal(dumpHash(db), before);
  });
});

// ===================================================================================================================
describe('drafts: there is no "sent" state', () => {
  it('the CHECK constraint refuses any status except draft/archived, on INSERT and on UPDATE', async () => {
    const { store, db } = await memEnv();
    const d = store.createDraft(draftInput());
    const ins = (status: string): void => {
      db.prepare(
        "INSERT INTO local_drafts (draft_id, namespace, provider, account_label, conversation_id, body, body_sha256, status, created_at, updated_at, created_via) VALUES (?, 'default', 'chatgpt', 'default', ?, 'b', 'h', ?, 't', 't', 'sdk')",
      ).run(`raw-${status}`, CONV, status);
    };
    for (const s of ['sent', 'SENT', 'Draft', 'published', 'delivered', '', 'draft ', ' archived']) {
      assert.throws(() => ins(s), /CHECK constraint/i, JSON.stringify(s));
      assert.throws(() => db.prepare('UPDATE local_drafts SET status = ? WHERE draft_id = ?').run(s, d.draftId), /CHECK constraint/i, JSON.stringify(s));
    }
    ins('draft');
    ins('archived');
    assert.equal(store.getDraft(d.draftId).status, 'draft', 'the failed UPDATEs changed nothing');
    assert.equal(count(db, 'local_drafts'), 3);
  });

  it('no method of the store can send or change a status, and no input field accepts one', async () => {
    const methods = Object.getOwnPropertyNames(LocalStore.prototype).filter((n) => n !== 'constructor');
    for (const m of methods) assert.ok(!/send|sent|transmit|publish|post|submit|deliver|dispatch|upload|push/i.test(m), `method name ${m}`);
    for (const m of ['createDraft', 'getDraft', 'listDrafts', 'archiveDraft', 'renderDraftMarkdown', 'createAnnotation', 'updateAnnotation', 'listAnnotations', 'getAnnotation']) {
      assert.ok(methods.includes(m), `public method ${m}`);
    }
    const { store } = await memEnv();
    assert.throws(() => store.createDraft(wrong<CreateDraftInput>({ ...draftInput(), status: 'draft' })), code('INVALID_ARGUMENT'), 'even a legal status value is not an input');
    assert.throws(() => store.listDrafts(wrong<DraftFilter>({ status: 'sent' })), code('INVALID_ARGUMENT'));
    const d = store.createDraft(draftInput());
    assert.ok(d.status === 'draft' || d.status === 'archived');
    assert.equal(Object.keys(d).includes('sentAt'), false);
  });
});

// ===================================================================================================================
describe('namespaces', () => {
  it('isolate drafts and annotations in listings; ids stay globally unique; archiving one does not touch another', async () => {
    const { store } = await memEnv();
    const a = store.createDraft(draftInput({ namespace: 'alpha', body: 'same body' }));
    const b = store.createDraft(draftInput({ namespace: 'beta', body: 'same body' }));
    const c = store.createDraft(draftInput({ body: 'same body' }));
    assert.notEqual(a.draftId, b.draftId);
    assert.equal(a.bodySha256, b.bodySha256);
    const ids = (ns?: string): string[] => store.listDrafts(ns === undefined ? {} : { namespace: ns }).items.map((d) => d.draftId).sort();
    assert.deepEqual(ids('alpha'), [a.draftId]);
    assert.deepEqual(ids('beta'), [b.draftId]);
    assert.deepEqual(ids('default'), [c.draftId]);
    assert.deepEqual(ids('gamma'), []);
    assert.deepEqual(ids(), [a.draftId, b.draftId, c.draftId].sort(), 'no namespace filter = every namespace');
    assert.equal(store.listDrafts({ namespace: 'alpha' }).total, 1);
    assert.throws(() => store.listDrafts({ namespace: 'Bad Name' }), code('INVALID_ARGUMENT'));
    assert.throws(() => store.listDrafts({ namespace: wrong<string>(null) }), code('INVALID_ARGUMENT'));

    store.archiveDraft(a.draftId);
    assert.equal(store.getDraft(b.draftId).status, 'draft');
    assert.deepEqual(store.listDrafts({ namespace: 'alpha', status: 'draft' }).items, []);
    assert.equal(store.getDraft(a.draftId).namespace, 'alpha', 'lookup by id works across namespaces and reports the namespace');

    const n1 = store.createAnnotation(annInput({ namespace: 'alpha' }));
    const n2 = store.createAnnotation(annInput({ namespace: 'beta' }));
    assert.deepEqual(store.listAnnotations({ namespace: 'alpha' }).items.map((x) => x.annotationId), [n1.annotationId]);
    assert.deepEqual(store.listAnnotations({ namespace: 'beta' }).items.map((x) => x.annotationId), [n2.annotationId]);
    assert.equal(store.listAnnotations({ namespace: 'default' }).total, 0);
    assert.equal(store.listAnnotations().total, 2);
  });
});

// ===================================================================================================================
describe('annotations', () => {
  it('creates with defaults (kind "note", version 1, conversation-level) and with a message anchor and kind', async () => {
    const { store } = await memEnv();
    const a = store.createAnnotation(annInput());
    assert.deepEqual(a, {
      annotationId: 'id-1',
      namespace: 'default',
      provider: 'chatgpt',
      accountLabel: 'default',
      conversationId: CONV,
      messageId: null,
      kind: 'note',
      body: 'annotation body',
      version: 1,
      createdAt: '2025-06-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
      createdVia: 'sdk',
    });
    const b = store.createAnnotation(annInput({ messageId: `${CONV}-a0`, kind: 'todo_item' }));
    assert.equal(b.messageId, `${CONV}-a0`);
    assert.equal(b.kind, 'todo_item');
    assert.deepEqual(store.getAnnotation('id-2'), b);
  });

  it('kind: /^[a-z][a-z0-9_]{0,31}$/; body: 1 byte .. 64 KiB after NUL stripping', async () => {
    const { store } = await memEnv();
    for (const k of ['a', 'note', 'a_b9', 'k'.repeat(32)]) assert.equal(store.createAnnotation(annInput({ kind: k })).kind, k);
    for (const k of ['', 'Note', '1a', '_a', 'a-b', 'a.b', 'k'.repeat(33), 'a b', 'a\n', 'café', "a'; --", wrong<string>(null), wrong<string>(3)]) {
      assert.throws(() => store.createAnnotation(annInput({ kind: k })), code('INVALID_ARGUMENT'), JSON.stringify(k));
    }
    store.createAnnotation(annInput({ body: 'a'.repeat(MAX_ANNOTATION_BODY_BYTES) }));
    store.createAnnotation(annInput({ body: '\u{1F600}'.repeat(MAX_ANNOTATION_BODY_BYTES / 4) }));
    store.createAnnotation(annInput({ body: 'a'.repeat(MAX_ANNOTATION_BODY_BYTES) + '\0\0' }));
    for (const b of ['a'.repeat(MAX_ANNOTATION_BODY_BYTES + 1), 'é'.repeat(MAX_ANNOTATION_BODY_BYTES / 2 + 1), '', '\0', '\ud800', wrong<string>(1), wrong<string>(undefined)]) {
      assert.throws(() => store.createAnnotation(annInput({ body: b })), code('INVALID_ARGUMENT'));
    }
    assert.throws(() => store.createAnnotation(wrong<CreateAnnotationInput>({ ...annInput(), version: 9 })), code('INVALID_ARGUMENT'), 'version is not an input');
    assert.throws(() => store.createAnnotation(wrong<CreateAnnotationInput>({ ...annInput(), anchorMessageId: 'x' })), code('INVALID_ARGUMENT'));
  });

  it('lists and filters by conversation, message (null = conversation-level), kind and namespace', async () => {
    const { store } = await memEnv([linearConversation(CONV, 2), linearConversation(CONV2, 1)]);
    const c1 = store.createAnnotation(annInput());
    const m1 = store.createAnnotation(annInput({ messageId: `${CONV}-u0`, kind: 'todo' }));
    const m2 = store.createAnnotation(annInput({ messageId: `${CONV}-a0` }));
    const o1 = store.createAnnotation({ conversationRef: { conversationId: CONV2 }, body: 'other' });
    const ids = (f: Parameters<LocalStore['listAnnotations']>[0]): string[] => store.listAnnotations(f).items.map((x) => x.annotationId);
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV } }), [m2.annotationId, m1.annotationId, c1.annotationId], 'newest first');
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV }, messageId: null }), [c1.annotationId]);
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV }, messageId: `${CONV}-u0` }), [m1.annotationId]);
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV }, kind: 'todo' }), [m1.annotationId]);
    assert.deepEqual(ids({ conversationRef: { conversationId: CONV2 } }), [o1.annotationId]);
    assert.equal(ids({}).length, 4);
    assert.deepEqual(ids({ limit: 2, offset: 1 }), [m2.annotationId, m1.annotationId]);
    assert.equal(store.listAnnotations({ limit: 2 }).nextOffset, 2);
    assert.throws(() => store.listAnnotations({ messageId: `${CONV}-u0` }), code('INVALID_ARGUMENT'), 'a message id needs its conversation');
    assert.throws(() => store.listAnnotations({ kind: 'Bad' }), code('INVALID_ARGUMENT'));
    assert.throws(() => store.listAnnotations({ limit: 0 }), code('INVALID_ARGUMENT'));
    assert.throws(() => store.listAnnotations(wrong<AnnotationFilter>({ author: 'x' })), code('INVALID_ARGUMENT'));
  });

  it('updateAnnotation replaces the body, increments the version by one and refreshes updated_at only', async () => {
    const { store } = await memEnv();
    const a = store.createAnnotation(annInput({ messageId: `${CONV}-u0`, kind: 'todo' }));
    const u = store.updateAnnotation(a.annotationId, { body: 'second', expectedVersion: 1 });
    assert.deepEqual(u, { ...a, body: 'second', version: 2, updatedAt: '2025-06-01T00:00:01.000Z' });
    const u2 = store.updateAnnotation(a.annotationId, { body: 'second', expectedVersion: 2 });
    assert.equal(u2.version, 3, 'an identical body still counts as an edit');
    assert.deepEqual(store.getAnnotation(a.annotationId), u2);
  });

  it('optimistic concurrency: a stale version is ANNOTATION_CONFLICT, an unknown id ANNOTATION_NOT_FOUND, bad versions INVALID_ARGUMENT', async () => {
    const { store } = await memEnv();
    const a = store.createAnnotation(annInput());
    store.updateAnnotation(a.annotationId, { body: 'v2', expectedVersion: 1 });
    const e = caught(() => store.updateAnnotation(a.annotationId, { body: 'stale', expectedVersion: 1 }));
    assert.equal(e.code, 'ANNOTATION_CONFLICT');
    assert.match(e.remedy ?? '', /re-read|retry/i);
    assert.equal(e.details?.['currentVersion'], 2);
    assert.equal(e.details?.['expectedVersion'], 1);
    assert.throws(() => store.updateAnnotation(a.annotationId, { body: 'future', expectedVersion: 3 }), code('ANNOTATION_CONFLICT'));
    assert.equal(store.getAnnotation(a.annotationId).body, 'v2', 'rejected updates change nothing');
    assert.equal(store.getAnnotation(a.annotationId).version, 2);
    assert.throws(() => store.updateAnnotation('missing', { body: 'x', expectedVersion: 1 }), code('ANNOTATION_NOT_FOUND'));
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, wrong<number>('2'), wrong<number>(null), wrong<number>(undefined)]) {
      assert.throws(() => store.updateAnnotation(a.annotationId, { body: 'x', expectedVersion: v }), code('INVALID_ARGUMENT'), String(v));
    }
    for (const b of ['', '\0', 'a'.repeat(MAX_ANNOTATION_BODY_BYTES + 1), wrong<string>(5)]) {
      assert.throws(() => store.updateAnnotation(a.annotationId, { body: b, expectedVersion: 2 }), code('INVALID_ARGUMENT'));
    }
    assert.throws(() => store.updateAnnotation(a.annotationId, wrong<{ body: string; expectedVersion: number }>({ body: 'x', expectedVersion: 2, kind: 'k' })), code('INVALID_ARGUMENT'));
    assert.throws(() => store.updateAnnotation('', { body: 'x', expectedVersion: 2 }), code('INVALID_ARGUMENT'));
    assert.equal(store.getAnnotation(a.annotationId).version, 2);
  });

  it('two interleaved updaters that both read version 1: exactly one wins, the loser must re-read', async () => {
    const { h, store } = await memEnv();
    const other = new LocalStore(h.db, { clock: fixedClock(), idFactory: counterIds('other') });
    const a = store.createAnnotation(annInput({ body: 'base' }));
    const seenByA = store.getAnnotation(a.annotationId);
    const seenByB = other.getAnnotation(a.annotationId);
    assert.equal(seenByA.version, 1);
    assert.equal(seenByB.version, 1);
    assert.equal(store.updateAnnotation(a.annotationId, { body: 'A wins', expectedVersion: seenByA.version }).version, 2);
    assert.throws(() => other.updateAnnotation(a.annotationId, { body: 'B loses', expectedVersion: seenByB.version }), code('ANNOTATION_CONFLICT'));
    const fresh = other.getAnnotation(a.annotationId);
    assert.equal(fresh.body, 'A wins');
    assert.equal(other.updateAnnotation(a.annotationId, { body: 'B merged', expectedVersion: fresh.version }).version, 3);
    assert.throws(() => store.updateAnnotation(a.annotationId, { body: 'A again, stale', expectedVersion: 2 }), code('ANNOTATION_CONFLICT'));
    assert.equal(store.getAnnotation(a.annotationId).body, 'B merged');
  });

  it('the same race across two SEPARATE connections to one database file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'two.sqlite');
      const c1 = openDatabase(path);
      const c2 = openDatabase(path);
      try {
        await new Repository(c1.db).importBatch({ batch: meta(), conversations: [linearConversation(CONV, 1)] });
        const s1 = new LocalStore(c1.db, { clock: fixedClock(), idFactory: counterIds('one') });
        const s2 = new LocalStore(c2.db, { clock: fixedClock(), idFactory: counterIds('two') });
        const a = s1.createAnnotation(annInput());
        assert.equal(s2.getAnnotation(a.annotationId).version, 1, 'the second connection sees the committed row');
        s1.updateAnnotation(a.annotationId, { body: 'from one', expectedVersion: 1 });
        assert.throws(() => s2.updateAnnotation(a.annotationId, { body: 'from two', expectedVersion: 1 }), code('ANNOTATION_CONFLICT'));
        assert.equal(s2.updateAnnotation(a.annotationId, { body: 'from two, merged', expectedVersion: 2 }).version, 3);
        assert.equal(s1.getAnnotation(a.annotationId).body, 'from two, merged');
        assert.deepEqual(verifyAuditLog(c1.db), { rows: 3, ok: true });
      } finally {
        closeDatabase(c1);
        closeDatabase(c2);
      }
    });
  });
});

// ===================================================================================================================
describe('read-only stores', () => {
  const mutators: Array<[string, (s: LocalStore) => unknown]> = [
    ['createDraft', (s) => s.createDraft(draftInput())],
    ['createDraft(garbage)', (s) => s.createDraft(wrong<CreateDraftInput>(null))],
    ['archiveDraft', (s) => s.archiveDraft('id-d')],
    ['archiveDraft(garbage)', (s) => s.archiveDraft(wrong<string>(7))],
    ['createAnnotation', (s) => s.createAnnotation(annInput())],
    ['createAnnotation(garbage)', (s) => s.createAnnotation(wrong<CreateAnnotationInput>({}))],
    ['updateAnnotation', (s) => s.updateAnnotation('id-a', { body: 'x', expectedVersion: 1 })],
    ['updateAnnotation(garbage)', (s) => s.updateAnnotation('', wrong<{ body: string; expectedVersion: number }>(null))],
  ];

  async function seeded(path: string): Promise<{ draftId: string; annotationId: string }> {
    const rw = openDatabase(path);
    try {
      await new Repository(rw.db).importBatch({ batch: meta(), conversations: [linearConversation(CONV, 2)] });
      const w = new LocalStore(rw.db, { clock: fixedClock(), idFactory: counterIds('seed') });
      const d = w.createDraft(draftInput({ title: 'T', body: 'persisted' }));
      const a = w.createAnnotation(annInput({ body: 'persisted note' }));
      return { draftId: d.draftId, annotationId: a.annotationId };
    } finally {
      closeDatabase(rw);
    }
  }

  it('a database opened read-only: every mutator throws WRITE_FORBIDDEN (before looking at its arguments), readers work', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'ro.sqlite');
      const { draftId, annotationId } = await seeded(path);
      const ro = openDatabase(path, { readOnly: true });
      try {
        const s = new LocalStore(ro.db, { clock: fixedClock(), idFactory: counterIds() });
        for (const [name, run] of mutators) {
          const e = caught(() => run(s));
          assert.equal(e.code, 'WRITE_FORBIDDEN', name);
          assert.match(e.remedy ?? '', /read-write/i, name);
        }
        const d = s.getDraft(draftId);
        assert.equal(d.body, 'persisted');
        assert.equal(s.getAnnotation(annotationId).body, 'persisted note');
        assert.equal(s.listDrafts().total, 1);
        assert.equal(s.listAnnotations().total, 1);
        assert.match(s.renderDraftMarkdown(draftId), /persisted/);
        assert.deepEqual(verifyAuditLog(ro.db), { rows: 2, ok: true });
      } finally {
        closeDatabase(ro);
      }
      const rw = openDatabase(path);
      try {
        assert.equal(Number(rw.db.prepare('SELECT count(*) AS n FROM local_drafts').get()?.['n']), 1, 'nothing changed on disk');
        assert.equal(Number(rw.db.prepare('SELECT count(*) AS n FROM local_audit_log').get()?.['n']), 2);
      } finally {
        closeDatabase(rw);
      }
    });
  });

  it('opts.readOnly forces WRITE_FORBIDDEN on a perfectly writable connection', async () => {
    const { h, db } = await memEnv();
    const s = new LocalStore(h.db, { readOnly: true });
    for (const [name, run] of mutators) assert.equal(caught(() => run(s)).code, 'WRITE_FORBIDDEN', name);
    assert.equal(count(db, 'local_drafts'), 0);
    assert.equal(count(db, 'local_audit_log'), 0);
    const writable = new LocalStore(h.db, { readOnly: false });
    writable.createDraft(draftInput());
    assert.equal(s.listDrafts().total, 1, 'a read-only store still reads what a writable one wrote');
  });

  it('a raw read-only connection WITHOUT query_only is still refused (SQLITE_READONLY maps to WRITE_FORBIDDEN, nothing half-written)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'raw.sqlite');
      const { annotationId } = await seeded(path);
      const raw = new DatabaseSync(path, { readOnly: true });
      try {
        const s = new LocalStore(raw, { clock: fixedClock(), idFactory: counterIds('raw') });
        assert.equal(caught(() => s.createDraft(draftInput())).code, 'WRITE_FORBIDDEN');
        assert.equal(caught(() => s.createAnnotation(annInput())).code, 'WRITE_FORBIDDEN');
        assert.equal(caught(() => s.updateAnnotation(annotationId, { body: 'x', expectedVersion: 1 })).code, 'WRITE_FORBIDDEN');
        assert.equal(raw.isTransaction, false, 'the failed attempt was rolled back');
        assert.equal(s.listDrafts().total, 1);
      } finally {
        raw.close();
      }
    });
  });
});

// ===================================================================================================================
describe('options, determinism and transactions', () => {
  it('constructor validates its arguments', async () => {
    const { h } = await memEnv();
    assert.throws(() => new LocalStore(wrong<DatabaseSync>(null)), code('INVALID_ARGUMENT'));
    assert.throws(() => new LocalStore(wrong<DatabaseSync>({})), code('INVALID_ARGUMENT'));
    assert.throws(() => new LocalStore(h.db, { actor: wrong<'cli'>('root') }), code('INVALID_ARGUMENT'));
    assert.throws(() => new LocalStore(h.db, { clock: wrong<() => string>('now') }), code('INVALID_ARGUMENT'));
    assert.throws(() => new LocalStore(h.db, { idFactory: wrong<() => string>(1) }), code('INVALID_ARGUMENT'));
    assert.throws(() => new LocalStore(h.db, { readOnly: wrong<boolean>('yes') }), code('INVALID_ARGUMENT'));
    assert.throws(() => new LocalStore(h.db, wrong<LocalStoreOptions>({ extra: 1 })), code('INVALID_ARGUMENT'));
    assert.ok(new LocalStore(h.db));
  });

  it('defaults: crypto-random UUID ids and a real UTC timestamp', async () => {
    const { h } = await memEnv();
    const s = new LocalStore(h.db);
    const a = s.createDraft(draftInput());
    const b = s.createDraft(draftInput());
    assert.match(a.draftId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a.draftId, b.draftId);
    assert.match(a.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(a.createdAt) - Date.now()) < 60_000);
  });

  it('an injected clock/idFactory make the whole outcome reproducible, byte for byte', async () => {
    const run = async (): Promise<string> => {
      const { store, db } = await memEnv();
      const d = store.createDraft(draftInput({ title: 't', body: 'b', anchorMessageId: `${CONV}-u0` }));
      const a = store.createAnnotation(annInput());
      store.updateAnnotation(a.annotationId, { body: 'again', expectedVersion: 1 });
      store.archiveDraft(d.draftId);
      const rows = ['local_drafts', 'local_annotations', 'local_audit_log'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
      return JSON.stringify([rows, store.renderDraftMarkdown(d.draftId)]);
    };
    assert.equal(await run(), await run());
  });

  it('timestamps are canonicalized to milliseconds so text order equals time order', async () => {
    const stamps = ['2025-06-01T00:00:00.500Z', '2025-06-01T00:00:01Z', '2025-06-01T00:00:00.999Z'];
    let i = 0;
    const { store } = await memEnv(undefined, { clock: () => stamps[i++ % 3] ?? '' });
    const d1 = store.createDraft(draftInput({ body: 'one' }));
    const d2 = store.createDraft(draftInput({ body: 'two' }));
    const d3 = store.createDraft(draftInput({ body: 'three' }));
    assert.deepEqual([d1.createdAt, d2.createdAt, d3.createdAt], ['2025-06-01T00:00:00.500Z', '2025-06-01T00:00:01.000Z', '2025-06-01T00:00:00.999Z']);
    assert.deepEqual(store.listDrafts().items.map((d) => d.body), ['two', 'three', 'one'], 'newest first by instant, not by spelling');
  });

  it('a clock or id factory that misbehaves fails closed (INTERNAL_ERROR) and writes nothing', async () => {
    for (const clock of [() => 'yesterday', () => '2025-02-30T00:00:00Z', () => '2025-06-01T00:00:00+02:00', () => wrong<string>(1700000000), () => wrong<string>(undefined)]) {
      const { store, db } = await memEnv(undefined, { clock });
      assert.throws(() => store.createDraft(draftInput()), code('INTERNAL_ERROR'));
      assert.throws(() => store.createAnnotation(annInput()), code('INTERNAL_ERROR'));
      assert.equal(count(db, 'local_drafts') + count(db, 'local_annotations') + count(db, 'local_audit_log'), 0);
      assert.equal(db.isTransaction, false);
    }
    for (const idFactory of [() => '', () => 'has space', () => '../x', () => 'a\0b', () => 'x'.repeat(129), () => wrong<string>(42), () => "id'; DROP TABLE local_drafts;--"]) {
      const { store, db } = await memEnv(undefined, { idFactory });
      assert.throws(() => store.createDraft(draftInput()), code('INTERNAL_ERROR'));
      assert.equal(count(db, 'local_drafts') + count(db, 'local_audit_log'), 0);
      assert.equal(db.isTransaction, false);
    }
  });

  it('a factory that throws leaves no partial write and the store usable', async () => {
    let fail = true;
    const { store, db } = await memEnv(undefined, {
      idFactory: () => {
        if (fail) throw new Error('boom');
        return 'ok-1';
      },
    });
    assert.throws(() => store.createDraft(draftInput()), /boom/);
    assert.equal(db.isTransaction, false);
    fail = false;
    assert.equal(store.createDraft(draftInput()).draftId, 'ok-1');
    assert.deepEqual(verifyAuditLog(db), { rows: 1, ok: true });
  });

  it('a duplicate id from the factory is a constraint failure that rolls back the audit row too', async () => {
    const { store, db } = await memEnv(undefined, { idFactory: () => 'same-id' });
    store.createDraft(draftInput());
    const e = caught(() => store.createDraft(draftInput({ body: 'second' })));
    assert.equal(e.code, 'DB_ERROR');
    assert.equal(count(db, 'local_drafts'), 1);
    assert.deepEqual(verifyAuditLog(db), { rows: 1, ok: true });
    assert.equal(store.getDraft('same-id').body, 'draft body');
  });

  it('refuses to run inside somebody else\'s open transaction and leaves that transaction alone', async () => {
    const { store, db } = await memEnv();
    db.exec('BEGIN');
    try {
      const e = caught(() => store.createDraft(draftInput()));
      assert.equal(e.code, 'DB_ERROR');
      assert.equal(e.details?.['reason'], 'transaction_open');
      assert.equal(db.isTransaction, true, 'the caller\'s transaction is still open');
    } finally {
      db.exec('ROLLBACK');
    }
    assert.equal(count(db, 'local_drafts'), 0);
    assert.equal(store.createDraft(draftInput()).draftId, 'id-1');
  });
});
