/**
 * Adversarial tests for src/db/repo.ts (independent review; lens: storage invariants, head-batch selection,
 * transaction atomicity, idempotency, argument hygiene). Tests that demonstrated a defect before its fix say so.
 * All data is synthetic.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationRecord, Provider } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import { Repository, computeBatchId } from '../../src/db/repo.js';
import type { ImportBatchMeta, ImportBatchResult } from '../../src/db/repo.js';
import { searchMessages } from '../../src/db/search.js';
import { convo, link, linearConversation, msg } from '../helpers/records.js';
import { withTempDir } from '../helpers/tmp.js';

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'export.zip',
  contentDigest: 'digest-adv',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

const isCode = (code: string) => (e: unknown): boolean => e instanceof GcrError && e.code === code;

function fresh(): { h: ReturnType<typeof openDatabase>; db: DatabaseSync; repo: Repository } {
  const h = openDatabase(':memory:');
  return { h, db: h.db, repo: new Repository(h.db) };
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

const DUMP_TABLES = ['source_batches', 'source_batch_stats', 'conversations', 'messages', 'conversation_heads', 'messages_fts_docsize', 'conversations_fts_docsize'];

/** sha256 over every row of every imported table (and the index doc sizes): equal hashes = equal content. */
function dumpHash(db: DatabaseSync): string {
  const h = createHash('sha256');
  for (const t of DUMP_TABLES) {
    h.update(`\n#${t}\n`);
    h.update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  }
  return h.digest('hex');
}

/** A runtime older than Node 22.15/22.16 has neither `isOpen` nor `isTransaction`. */
function withoutNewerNodeApis(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'isTransaction' || prop === 'isOpen') return undefined;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('argument hygiene of the readers', () => {
  it('listConversations rejects null and non-object options with INVALID_ARGUMENT (was a raw TypeError)', () => {
    const { repo } = fresh();
    for (const bad of [null, 'x', 5, true] as unknown[]) {
      assert.throws(() => repo.listConversations(bad as never), isCode('INVALID_ARGUMENT'), String(bad));
    }
    assert.doesNotThrow(() => repo.listConversations(undefined));
    assert.doesNotThrow(() => repo.listConversations({}));
  });

  it('resolve/get/getMessage/getBatch reject malformed references without a TypeError and never echo the value', async () => {
    const { repo } = fresh();
    await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1)] });
    const secret = 'SECRET-ID-VALUE';
    const hostile: unknown[] = [
      null,
      undefined,
      5,
      {},
      { conversationId: '' },
      { conversationId: 5 },
      { conversationId: 'a\0b' },
      { conversationId: 'x'.repeat(513) },
      { conversationId: `${secret}\0` },
      { conversationId: 'c1', provider: `${secret}\0` },
      { conversationId: 'c1', accountLabel: secret.repeat(100) },
      { conversationId: 'c1', batchId: `${secret}\0` },
    ];
    for (const bad of hostile) {
      for (const call of [() => repo.resolveConversation(bad as never), () => repo.getConversation(bad as never), () => repo.getMessage(bad as never, 'm')]) {
        assert.throws(call, (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && !JSON.stringify(e.toEnvelope()).includes(secret));
      }
    }
    assert.throws(() => repo.getMessage({ conversationId: 'c1' }, ''), isCode('INVALID_ARGUMENT'));
    assert.throws(() => repo.getMessage({ conversationId: 'c1' }, 5 as unknown as string), isCode('INVALID_ARGUMENT'));
    assert.throws(() => repo.getBatch(''), isCode('INVALID_ARGUMENT'));
    assert.throws(() => repo.getBatch(`${secret}\0`), (e) => e instanceof GcrError && !e.message.includes(secret));
  });

  it('getMessage: unknown conversation, unknown message and a message of a pinned older snapshot', async () => {
    const { repo } = fresh();
    const a = await repo.importBatch({ batch: { ...META, contentDigest: 'a' }, conversations: [{ ...linearConversation('c1', 1), updatedAt: '2025-01-05T00:00:00.000Z' }] });
    await repo.importBatch({
      batch: { ...META, contentDigest: 'b' },
      conversations: [{ ...linearConversation('c1', 2), updatedAt: '2025-01-09T00:00:00.000Z' }],
    });
    assert.equal(repo.getMessage({ conversationId: 'nope' }, 'c1-u0'), null);
    assert.equal(repo.getMessage({ conversationId: 'c1' }, 'nope'), null);
    assert.ok(repo.getMessage({ conversationId: 'c1' }, 'c1-u1'), 'the head snapshot has the second exchange');
    assert.equal(repo.getMessage({ conversationId: 'c1', batchId: a.batchId }, 'c1-u1'), null, 'the older snapshot has not');
    assert.ok(repo.getMessage({ conversationId: 'c1', batchId: a.batchId }, 'c1-u0'));
    assert.equal(repo.getMessage({ conversationId: 'c1', batchId: 'b_unknown' }, 'c1-u0'), null);
  });

  it('computeBatchId is a pure function of exactly provider, account and digest', () => {
    const base = computeBatchId('chatgpt', 'default', 'd');
    assert.match(base, /^b_[0-9a-f]{32}$/);
    assert.equal(computeBatchId('chatgpt', 'default', 'd'), base);
    for (const other of [computeBatchId('claude', 'default', 'd'), computeBatchId('chatgpt', 'work', 'd'), computeBatchId('chatgpt', 'default', 'e'), computeBatchId('chatgpt', 'default', 'D')]) {
      assert.notEqual(other, base);
    }
    // The NUL separators keep ("ab","c") and ("a","bc") apart.
    assert.notEqual(computeBatchId('chatgpt', 'ab', 'c'), computeBatchId('chatgpt', 'a', 'bc'));
  });
});

describe('importBatch: exotic failures leave nothing behind', () => {
  it('whatever the source throws (even a non-Error), the original value is rethrown, everything is rolled back and the connection stays usable', async () => {
    const { db, repo } = fresh();
    const thrown: unknown[] = ['plain string', undefined, null, 42, { custom: true }];
    for (const value of thrown) {
      async function* source(): AsyncGenerator<ConversationRecord> {
        yield linearConversation('c1', 3);
        yield linearConversation('c2', 3);
        throw value;
      }
      await assert.rejects(
        repo.importBatch({ batch: META, conversations: source() }),
        (e) => e === value,
        `thrown value ${String(value)}`,
      );
      assert.equal(db.isTransaction, false);
      for (const t of ['source_batches', 'source_batch_stats', 'conversations', 'messages', 'conversation_heads', 'messages_fts_docsize', 'conversations_fts_docsize']) {
        assert.equal(count(db, t), 0, `${t} must be empty after rollback`);
      }
    }
    const ok = await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1)] });
    assert.equal(ok.alreadyImported, false, 'a failed attempt must not make the next one look like a repeat');
    assert.equal(repo.listBatches()[0]?.seq, 1, 'and consumes no sequence number');
  });

  it('a sync iterable that throws on its very first step, and one that throws after thousands of rows, both roll back', async () => {
    const { db, repo } = fresh();
    function* immediately(): Generator<ConversationRecord> {
      throw new Error('first step');
    }
    await assert.rejects(repo.importBatch({ batch: META, conversations: immediately() }), /first step/);
    function* late(): Generator<ConversationRecord> {
      for (let i = 0; i < 30; i++) yield linearConversation(`c${i}`, 20);
      throw new Error('late failure');
    }
    await assert.rejects(repo.importBatch({ batch: META, conversations: late() }), /late failure/);
    assert.equal(count(db, 'messages'), 0);
    assert.equal(count(db, 'messages_fts_docsize'), 0);
    assert.equal(count(db, 'conversation_heads'), 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.['integrity_check'], 'ok');
  });

  it('rolls back and leaves no open transaction on a runtime without `isTransaction`', async () => {
    const { db } = fresh();
    const repo = new Repository(withoutNewerNodeApis(db));
    function* boom(): Generator<ConversationRecord> {
      yield linearConversation('c1', 2);
      throw new Error('midway');
    }
    await assert.rejects(repo.importBatch({ batch: META, conversations: boom() }), /midway/);
    assert.equal(db.isTransaction, false, 'a transaction stayed open (and with it the write lock)');
    assert.equal(count(db, 'messages'), 0);
    const ok = await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1)] });
    assert.equal(ok.alreadyImported, false);
    assert.equal(count(db, 'conversations'), 1);
  });

  it('a validation failure on the LAST record discards the earlier valid ones, and a repeated id cannot slip through on retry', async () => {
    const { db, repo } = fresh();
    const bad = { ...linearConversation('bad', 1), createdAt: 'yesterday' } as unknown as ConversationRecord;
    await assert.rejects(repo.importBatch({ batch: META, conversations: [linearConversation('ok1', 2), linearConversation('ok2', 2), bad] }), isCode('IMPORT_PARSE_ERROR'));
    assert.equal(count(db, 'conversations'), 0);
    assert.equal(count(db, 'messages_fts_docsize'), 0);
    const retry = await repo.importBatch({ batch: META, conversations: [linearConversation('ok1', 2)] });
    assert.deepEqual(retry.conversations, { stored: 1, newlyInserted: 1 });
  });

  it('a file database keeps the committed batch intact when the next import fails (durability across reopen)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'g.sqlite');
      const first = openDatabase(path);
      await new Repository(first.db).importBatch({ batch: META, conversations: [linearConversation('c1', 2)] });
      function* boom(): Generator<ConversationRecord> {
        yield linearConversation('c2', 2);
        throw new Error('midway');
      }
      await assert.rejects(new Repository(first.db).importBatch({ batch: { ...META, contentDigest: 'other' }, conversations: boom() }), /midway/);
      closeDatabase(first);
      const again = openDatabase(path, { readOnly: true });
      try {
        assert.equal(count(again.db, 'conversations'), 1);
        assert.equal(new Repository(again.db).listBatches().length, 1);
        assert.equal(again.db.prepare('PRAGMA integrity_check').get()?.['integrity_check'], 'ok');
      } finally {
        closeDatabase(again);
      }
    });
  });
});

describe('importBatch: duplicate conversation ids inside one stream', () => {
  it('lists each repeated id once (not once per repetition) and counts every skipped copy', async () => {
    const { repo } = fresh();
    const copies = [linearConversation('dup', 1), linearConversation('dup', 2), linearConversation('dup', 3), linearConversation('other', 1), linearConversation('other', 2)];
    const res = await repo.importBatch({ batch: META, conversations: copies });
    assert.deepEqual(res.conversations, { stored: 2, newlyInserted: 2 });
    const w = repo.getBatch(res.batchId)?.warnings.find((x) => x.code === 'DUPLICATE_CONVERSATION_IN_BATCH');
    assert.deepEqual(w?.ids, ['dup', 'other']);
    assert.match(w?.message ?? '', /^3 repeated/);
  });

  it('the list of ids is capped even for thousands of distinct repeats', async () => {
    const { repo } = fresh();
    const records: ConversationRecord[] = [];
    for (let i = 0; i < 60; i++) records.push(convo(`d${i}`, []), convo(`d${i}`, []));
    const res = await repo.importBatch({ batch: META, conversations: records });
    const w = repo.getBatch(res.batchId)?.warnings.find((x) => x.code === 'DUPLICATE_CONVERSATION_IN_BATCH');
    assert.equal(w?.ids?.length, 20);
    assert.match(w?.message ?? '', /^60 repeated/);
  });
});

describe('immutability: bypass attempts beyond plain UPDATE / DELETE', () => {
  it('REPLACE and UPSERT on every immutable table abort and change nothing; the derived head pointers stay writable', async () => {
    const { db, repo } = fresh();
    await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1)] });
    const before = dumpHash(db);
    const statements = [
      "INSERT OR REPLACE INTO source_batches SELECT batch_id, seq, provider, account_label, provenance, completeness, source_kind, 'x', input_sha256, imported_at, tool_version, schema_version, conversation_count, message_count, warnings_json FROM source_batches",
      'REPLACE INTO source_batch_stats SELECT batch_id, 0, 0 FROM source_batch_stats',
      'INSERT INTO source_batch_stats SELECT batch_id, 99, 0 FROM source_batch_stats WHERE true ON CONFLICT DO UPDATE SET node_count = 99',
      "INSERT OR REPLACE INTO conversations (provider, account_label, conversation_id, source_batch, provenance, completeness, imported_at, message_count, title) SELECT provider, account_label, conversation_id, source_batch, provenance, completeness, imported_at, message_count, 'x' FROM conversations",
      "INSERT INTO conversations (provider, account_label, conversation_id, source_batch, provenance, completeness, imported_at, message_count, title) SELECT provider, account_label, conversation_id, source_batch, provenance, completeness, imported_at, message_count, 'x' FROM conversations WHERE true ON CONFLICT DO UPDATE SET title = 'x'",
      "UPDATE OR IGNORE messages SET text = 'x'",
      "UPDATE OR REPLACE messages SET text = 'x'",
      "UPDATE OR FAIL messages SET text = 'x'",
      "UPDATE OR ROLLBACK messages SET text = 'x'",
      'DELETE FROM conversations WHERE 1',
    ];
    for (const sql of statements) assert.throws(() => db.exec(sql), /imported data is immutable/, sql);
    assert.equal(dumpHash(db), before);
    assert.equal(db.isTransaction, false);
  });
});

describe('head selection: model-based test against an independent oracle', () => {
  interface Scope {
    provider: Provider;
    accountLabel: string;
  }
  const SCOPES: Scope[] = [
    { provider: 'chatgpt', accountLabel: 'default' },
    { provider: 'chatgpt', accountLabel: 'work' },
    { provider: 'claude', accountLabel: 'default' },
  ];
  const CONVS = ['c1', 'c2', 'c3', 'c4'];
  /** Instants chosen to collide: equal instants with different spellings, a NULL, and close neighbours. */
  const UPDATED: Array<string | null> = [
    null,
    '2025-03-01T00:00:00Z',
    '2025-03-01T00:00:00.000Z',
    '2025-03-01T00:00:00.500Z',
    '2025-03-01T00:00:01Z',
    '2025-02-28T23:59:59.999Z',
    '2025-03-02T00:00:00.000Z',
  ];

  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  interface Snapshot {
    seq: number;
    batchId: string;
    ms: number | null;
  }

  function snapshotRecord(scope: Scope, id: string, step: number, updatedAt: string | null): ConversationRecord {
    const m1 = msg({ id: `${id}-m1`, conversationId: id, text: `needle step${step} first`, ordinal: 0, createdAt: '2025-01-01T00:00:01.000Z' });
    const m2 = msg({ id: `${id}-m2`, conversationId: id, parentId: m1.id, text: `needle step${step} second`, ordinal: 1, createdAt: '2025-01-01T00:00:02.000Z' });
    return convo(id, link([m1, m2]), {
      provider: scope.provider,
      accountLabel: scope.accountLabel,
      provenance: scope.provider === 'claude' ? 'official_claude_export' : 'official_chatgpt_export',
      updatedAt,
    });
  }

  for (const seed of [1, 2, 3, 20261014]) {
    it(`heads follow "greatest updated_at instant, NULL lowest, ties -> greatest seq" for a random import history (seed ${seed})`, async () => {
      const rnd = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const { db, repo } = fresh();
      const model = new Map<string, Snapshot[]>();
      const key = (s: Scope, c: string): string => `${s.provider}/${s.accountLabel}/${c}`;
      const history: Array<{ scope: Scope; records: ConversationRecord[]; digest: string; result: ImportBatchResult }> = [];
      let seq = 0;

      for (let step = 0; step < 40; step++) {
        const replay = history.length > 0 && rnd() < 0.2;
        if (replay) {
          const old = pick(history);
          const again = await repo.importBatch({ batch: { ...META, ...old.scope, provenance: old.scope.provider === 'claude' ? 'official_claude_export' : 'official_chatgpt_export', contentDigest: old.digest }, conversations: old.records });
          assert.equal(again.alreadyImported, true);
          assert.deepEqual(again.conversations, { stored: old.result.conversations.stored, newlyInserted: 0 });
          assert.deepEqual(again.messages, { stored: old.result.messages.stored, newlyInserted: 0, structural: old.result.messages.structural });
          continue;
        }
        const scope = pick(SCOPES);
        const howMany = 1 + Math.floor(rnd() * 3);
        const chosen = [...new Set(Array.from({ length: howMany }, () => pick(CONVS)))];
        const records = chosen.map((c) => snapshotRecord(scope, c, step, pick(UPDATED)));
        const digest = `step-${step}`;
        const result = await repo.importBatch({
          batch: { ...META, ...scope, provenance: scope.provider === 'claude' ? 'official_claude_export' : 'official_chatgpt_export', contentDigest: digest },
          conversations: records,
        });
        assert.equal(result.alreadyImported, false);
        seq++;
        history.push({ scope, records, digest, result });
        for (const r of records) {
          const list = model.get(key(scope, r.id)) ?? [];
          list.push({ seq, batchId: result.batchId, ms: r.updatedAt === null ? null : Date.parse(r.updatedAt) });
          model.set(key(scope, r.id), list);
        }
        // Oracle: compare the touched conversations immediately.
        for (const r of records) {
          const snaps = model.get(key(scope, r.id)) ?? [];
          const best = snaps.reduce((a, b) => {
            const am = a.ms ?? Number.NEGATIVE_INFINITY;
            const bm = b.ms ?? Number.NEGATIVE_INFINITY;
            return bm > am || (bm === am && b.seq > a.seq) ? b : a;
          });
          const got = repo.resolveConversation({ conversationId: r.id, provider: scope.provider, accountLabel: scope.accountLabel }).matches;
          assert.equal(got.length, 1, 'exactly one head per scope');
          assert.equal(got[0]?.batchId, best.batchId, `step ${step}: head of ${key(scope, r.id)}`);
        }
      }

      // Global invariants after the whole history.
      assert.deepEqual(
        repo.listBatches().map((b) => b.seq),
        Array.from({ length: seq }, (_, i) => i + 1),
        'seq is gap-free and in commit order',
      );
      assert.equal(count(db, 'conversation_heads'), model.size);
      assert.equal(repo.listConversations({ limit: 500 }).total, model.size);
      for (const [k, snaps] of model) {
        const [provider, accountLabel, conversationId] = k.split('/') as [Provider, string, string];
        const heads = repo.resolveConversation({ conversationId, provider, accountLabel }).matches;
        assert.equal(heads.length, 1, k);
        // default search sees only the head snapshot of each conversation; allBatches sees every snapshot
        const hits = searchMessages(db, { query: 'needle', provider, accountLabel, conversationId, limit: 200 });
        assert.equal(hits.items.length, 2, k);
        assert.ok(hits.items.every((h) => h.batchId === heads[0]?.batchId), `${k}: default search must only return head-batch messages`);
        const all = searchMessages(db, { query: 'needle', provider, accountLabel, conversationId, limit: 200, allBatches: true });
        assert.equal(all.items.length, 2 * snaps.length, k);
      }

      // Idempotency of the whole history: replaying every batch changes nothing at all.
      const before = dumpHash(db);
      for (const h of history) {
        const again = await repo.importBatch({
          batch: { ...META, ...h.scope, provenance: h.scope.provider === 'claude' ? 'official_claude_export' : 'official_chatgpt_export', contentDigest: h.digest },
          conversations: h.records,
        });
        assert.equal(again.alreadyImported, true);
        assert.equal(again.batchId, h.result.batchId);
      }
      assert.equal(dumpHash(db), before);
    });
  }
});

describe('rebuildSearchIndex: negative cases', () => {
  it('a read-only handle gets WRITE_FORBIDDEN, keeps its (still working) index and is left outside any transaction', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'ro.sqlite');
      const rw = openDatabase(path);
      await new Repository(rw.db).importBatch({ batch: META, conversations: [linearConversation('c1', 2)] });
      closeDatabase(rw);
      const ro = openDatabase(path, { readOnly: true });
      try {
        const repo = new Repository(ro.db);
        assert.throws(() => repo.rebuildSearchIndex(), isCode('WRITE_FORBIDDEN'));
        assert.equal(ro.db.isTransaction, false);
        assert.ok(searchMessages(ro.db, { query: 'topic0' }).items.length > 0, 'index untouched');
        await assert.rejects(repo.importBatch({ batch: { ...META, contentDigest: 'z' }, conversations: [] }), isCode('WRITE_FORBIDDEN'));
      } finally {
        closeDatabase(ro);
      }
    });
  });

  it('rebuilding twice is idempotent and reports what it indexed (empty messages and structural nodes are not indexed)', async () => {
    const { db, repo } = fresh();
    const rec = linearConversation('c1', 2);
    rec.messages.push(msg({ id: 'empty', conversationId: 'c1', text: '', ordinal: 99 }));
    await repo.importBatch({ batch: META, conversations: [rec] });
    const first = repo.rebuildSearchIndex();
    assert.deepEqual(first, { messages: 4, conversations: 1 });
    assert.deepEqual(repo.rebuildSearchIndex(), first);
    assert.equal(count(db, 'messages_fts_docsize'), 4);
    assert.equal(count(db, 'conversations_fts_docsize'), 1);
  });
});
