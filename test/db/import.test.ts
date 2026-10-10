/**
 * Tests for src/db/repo.ts: the import writer (atomicity, idempotency, head semantics, scoping) and the readers.
 * All data is synthetic. Positive and negative cases for FR-10 and the identity rules of ARCHITECTURE section 2.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationRecord } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import type { Warning } from '../../src/errors.js';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import type { GcrDatabase } from '../../src/db/open.js';
import { Repository, computeBatchId } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { searchMessages } from '../../src/db/search.js';
import { withTempDir } from '../helpers/tmp.js';
import { branchedConversation, convo, iso, link, linearConversation, msg } from '../helpers/records.js';

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

function fresh(): { h: GcrDatabase; db: DatabaseSync; repo: Repository } {
  const h = openDatabase(':memory:');
  return { h, db: h.db, repo: new Repository(h.db) };
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

const ALL_COUNTED = ['source_batches', 'source_batch_stats', 'conversations', 'messages', 'conversation_heads', 'messages_fts_docsize', 'conversations_fts_docsize'];

function allCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(ALL_COUNTED.map((t) => [t, count(db, t)]));
}

/** sha256 over every imported row AND the raw FTS index blocks: equal hashes mean byte-identical content. */
function dumpHash(db: DatabaseSync): string {
  const h = createHash('sha256');
  for (const t of ALL_COUNTED) {
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

async function* asAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

function withUpdated(rec: ConversationRecord, updatedAt: string | null): ConversationRecord {
  return { ...rec, updatedAt };
}

function expectCode(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

function headBatchOf(repo: Repository, id: string): string | undefined {
  return repo.resolveConversation({ conversationId: id }).matches[0]?.batchId;
}

function richRecord(): ConversationRecord {
  const id = 'conv-rich';
  const msgs = link([
    msg({ id: 'r', conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
    msg({
      id: 'u',
      conversationId: id,
      parentId: 'r',
      authorRole: 'user',
      authorName: 'Ünï',
      createdAt: iso(1),
      updatedAt: iso(2),
      text: 'Привет, 日本語 \u{1F600} text\nwith "quotes" and \'apostrophes\'',
      blocks: [{ type: 'text', text: 'Привет' }, { type: 'unknown', metadata: { raw: [1, { deep: null }], n: 1.5 } }, { type: 'image_ref' }],
      attachments: [
        { id: 'file-abc', name: 'diagram.png', mimeType: 'image/png', sizeBytes: 1234, assetPointer: 'file-service://file-abc', presentInExportAs: 'files/file-abc-diagram.png' },
        { id: null, name: null, mimeType: null, sizeBytes: null, assetPointer: null, presentInExportAs: null },
      ],
      rawSource: { anything: ['goes', 1, null, { nested: true }] },
      ordinal: 1,
    }),
    msg({ id: 'a', conversationId: id, parentId: 'u', authorRole: 'assistant', modelSlug: 'synthetic-model-1', channel: 'final', recipient: 'all', contentType: 'text', status: 'finished_successfully', hidden: true, text: 'answer', ordinal: 2 }),
    msg({ id: 'blank', conversationId: id, parentId: 'a', authorRole: 'tool', text: '', ordinal: 3, rawSource: null }),
  ]);
  return convo(id, msgs, {
    title: 'Rïch "title" with \'quotes\'',
    sourceUri: 'https://chatgpt.com/c/6ac95b6e-9fa0-83e8-bbb0-8107079a8720',
    currentNodeId: 'a',
    defaultModelSlug: 'synthetic-model-1',
    rawMetadata: { gizmo: null, flags: [true, false], nested: { k: 'v' } },
    warnings: [{ code: 'MISSING_PARENT', message: 'a warning', ids: ['x', 'y'] }, { code: 'PLAIN', message: 'no ids' }],
  });
}

describe('importBatch: counts and storage', () => {
  it('stores conversations and messages, counts structural nodes separately, and reports consistent numbers', async () => {
    const { db, repo } = fresh();
    const res = await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 2), branchedConversation('c2')] });
    assert.equal(res.batchId, computeBatchId('chatgpt', 'default', 'digest-1'));
    assert.equal(res.alreadyImported, false);
    assert.deepEqual(res.conversations, { stored: 2, newlyInserted: 2 });
    // c1: root + 4 messages = 5 nodes; c2: root + 7 messages = 8 nodes; 2 structural
    assert.deepEqual(res.messages, { stored: 13, newlyInserted: 13, structural: 2 });
    assert.equal(count(db, 'messages'), 13);
    assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE node_kind = 'structural_empty'").get()?.['n'], 2);
    assert.equal(count(db, 'conversations'), 2);
    assert.equal(count(db, 'conversation_heads'), 2);

    const batch = repo.getBatch(res.batchId);
    assert.ok(batch);
    assert.equal(batch.seq, 1);
    assert.equal(batch.conversationCount, 2);
    assert.equal(batch.messageCount, 11, 'real messages only (structural nodes excluded)');
    assert.equal(batch.sourceKind, 'zip');
    assert.equal(batch.inputSha256, 'digest-1');
    assert.equal(batch.schemaVersion, 1);
    const summary = repo.listConversations().items.find((c) => c.conversationId === 'c1');
    assert.equal(summary?.messageCount, 4);
  });

  it('indexes real messages but never structural nodes (and not empty-text messages)', async () => {
    const { db, repo } = fresh();
    const rich = richRecord(); // 1 structural, 3 real messages of which one has empty text
    await repo.importBatch({ batch: META, conversations: [rich] });
    assert.equal(count(db, 'messages'), 4);
    assert.equal(count(db, 'messages_fts_docsize'), 2, 'only the two real messages that have text');
    assert.equal(count(db, 'conversations_fts_docsize'), 1);
  });

  it('the batch id is "b_" + first 32 hex of sha256(provider NUL accountLabel NUL digest)', () => {
    const expected = 'b_' + createHash('sha256').update('chatgpt\0default\0digest-1').digest('hex').slice(0, 32);
    assert.equal(computeBatchId('chatgpt', 'default', 'digest-1'), expected);
    assert.equal(computeBatchId('chatgpt', 'default', 'digest-1').length, 34);
    const ids = new Set([
      computeBatchId('chatgpt', 'default', 'digest-1'),
      computeBatchId('claude', 'default', 'digest-1'),
      computeBatchId('chatgpt', 'other', 'digest-1'),
      computeBatchId('chatgpt', 'default', 'digest-2'),
      computeBatchId('chatgpt', 'defaul', 'tdigest-1'), // NUL separators prevent ambiguous concatenation
    ]);
    assert.equal(ids.size, 5);
  });

  it('assigns increasing seq numbers in commit order and never consumes one for a failed import', async () => {
    const { repo } = fresh();
    const a = await repo.importBatch({ batch: meta({ contentDigest: 'a' }), conversations: [linearConversation('c1', 1)] });
    await assert.rejects(
      repo.importBatch({
        batch: meta({ contentDigest: 'boom' }),
        conversations: (function* () {
          yield linearConversation('c2', 1);
          throw new Error('mid-stream failure');
        })(),
      }),
      /mid-stream failure/,
    );
    const b = await repo.importBatch({ batch: meta({ contentDigest: 'b' }), conversations: [linearConversation('c3', 1)] });
    assert.deepEqual(
      repo.listBatches().map((x) => [x.batchId, x.seq]),
      [
        [a.batchId, 1],
        [b.batchId, 2],
      ],
    );
  });

  it('accepts an empty conversation list (a valid, empty batch) and an async iterable', async () => {
    const { repo } = fresh();
    const empty = await repo.importBatch({ batch: meta({ contentDigest: 'empty' }), conversations: [] });
    assert.deepEqual(empty.conversations, { stored: 0, newlyInserted: 0 });
    assert.deepEqual(empty.messages, { stored: 0, newlyInserted: 0, structural: 0 });
    const viaAsync = await repo.importBatch({ batch: meta({ contentDigest: 'async' }), conversations: asAsync([linearConversation('c1', 1)]) });
    assert.equal(viaAsync.conversations.stored, 1);
    assert.equal(repo.getBatch(empty.batchId)?.conversationCount, 0);
  });

  it('stores the source label as a basename only', async () => {
    const { repo } = fresh();
    const cases: Array<[string | null, string | null]> = [
      ['/home/alice/private/export.zip', 'export.zip'],
      ['C:\\Users\\alice\\Downloads\\export.zip', 'export.zip'],
      ['export.zip', 'export.zip'],
      ['..', null],
      ['/', null],
      [null, null],
    ];
    let i = 0;
    for (const [given, expected] of cases) {
      const r = await repo.importBatch({ batch: meta({ contentDigest: `label-${i++}`, sourceLabel: given }), conversations: [] });
      assert.equal(repo.getBatch(r.batchId)?.sourceLabel, expected, String(given));
    }
  });

  it('records batch warnings, including ones appended while the stream is being consumed', async () => {
    const { repo } = fresh();
    const warnings: Warning[] = [{ code: 'EARLY', message: 'known up front', ids: ['c1'] }];
    const res = await repo.importBatch({
      batch: meta({ warnings }),
      conversations: (function* () {
        yield linearConversation('c1', 1);
        warnings.push({ code: 'LATE', message: 'discovered while streaming' });
      })(),
    });
    assert.deepEqual(
      repo.getBatch(res.batchId)?.warnings.map((w) => w.code),
      ['EARLY', 'LATE'],
    );
  });

  it('a conversation id repeated inside one stream keeps the first copy and records DUPLICATE_CONVERSATION_IN_BATCH', async () => {
    const { db, repo } = fresh();
    const first = linearConversation('dup', 1);
    const second = { ...linearConversation('dup', 3), title: 'second copy' };
    const res = await repo.importBatch({ batch: META, conversations: [first, second, linearConversation('other', 1)] });
    assert.deepEqual(res.conversations, { stored: 2, newlyInserted: 2 });
    assert.equal(repo.getConversation({ conversationId: 'dup' })?.title, 'Synthetic dup');
    assert.equal(count(db, 'messages'), 3 + 3, 'messages of the skipped copy are not stored');
    const w = repo.getBatch(res.batchId)?.warnings.find((x) => x.code === 'DUPLICATE_CONVERSATION_IN_BATCH');
    assert.deepEqual(w?.ids, ['dup']);
  });
});

describe('importBatch: idempotency (FR-10)', () => {
  it('re-importing identical input is a no-op with equal counts and byte-identical content (rows AND index)', async () => {
    const { db, repo } = fresh();
    const records = [linearConversation('c1', 3), branchedConversation('c2'), richRecord()];
    const first = await repo.importBatch({ batch: META, conversations: records });
    const countsBefore = allCounts(db);
    const hashBefore = dumpHash(db);

    const second = await repo.importBatch({ batch: META, conversations: records });
    assert.equal(second.alreadyImported, true);
    assert.equal(second.batchId, first.batchId);
    assert.deepEqual(second.conversations, { stored: first.conversations.stored, newlyInserted: 0 });
    assert.deepEqual(second.messages, { stored: first.messages.stored, newlyInserted: 0, structural: first.messages.structural });
    assert.deepEqual(allCounts(db), countsBefore);
    assert.equal(dumpHash(db), hashBefore);
    assert.equal(db.isTransaction, false);
  });

  it('keeps the first import time and metadata even if the re-import carries different bookkeeping values', async () => {
    const { repo } = fresh();
    const first = await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1)] });
    await repo.importBatch({ batch: meta({ importedAt: '2030-01-01T00:00:00.000Z', sourceLabel: 'renamed.zip', toolVersion: '9.9.9' }), conversations: [linearConversation('c1', 1)] });
    const b = repo.getBatch(first.batchId);
    assert.equal(b?.importedAt, META.importedAt);
    assert.equal(b?.sourceLabel, 'export.zip');
    assert.equal(b?.toolVersion, '0.2.0-dev.0');
    assert.equal(repo.listBatches().length, 1);
  });

  it('does not iterate the record source on the no-op path, but lets it finish (return() is called)', async () => {
    const { repo } = fresh();
    await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1)] });
    let nextCalls = 0;
    let returnCalls = 0;
    const src: AsyncIterable<ConversationRecord> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            nextCalls++;
            return { done: true as const, value: undefined };
          },
          return: async () => {
            returnCalls++;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const res = await repo.importBatch({ batch: META, conversations: src });
    assert.equal(res.alreadyImported, true);
    assert.equal(nextCalls, 0);
    assert.equal(returnCalls, 1);
  });

  it('the same bytes under another accountLabel or provider are a different batch (negative case)', async () => {
    const { db, repo } = fresh();
    const a = await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1)] });
    const work: ConversationRecord = { ...linearConversation('c1', 1), accountLabel: 'work' };
    const b = await repo.importBatch({ batch: meta({ accountLabel: 'work' }), conversations: [work] });
    assert.notEqual(a.batchId, b.batchId);
    assert.equal(b.alreadyImported, false);
    assert.equal(count(db, 'source_batches'), 2);
  });

  it('a different export of the same conversation is a NEW batch and both snapshots are retained', async () => {
    const { db, repo } = fresh();
    const a = await repo.importBatch({ batch: meta({ contentDigest: 'export-a' }), conversations: [linearConversation('c1', 1)] });
    const b = await repo.importBatch({ batch: meta({ contentDigest: 'export-b' }), conversations: [{ ...linearConversation('c1', 2), updatedAt: iso(500) }] });
    assert.notEqual(a.batchId, b.batchId);
    assert.equal(b.alreadyImported, false);
    assert.equal(count(db, 'conversations'), 2);
    assert.equal(count(db, 'messages'), 3 + 5);
    assert.equal(count(db, 'conversation_heads'), 1);
  });
});

describe('importBatch: conversation heads', () => {
  it('moves the head to the snapshot with the greatest updated_at; an older snapshot arriving later does not move it', async () => {
    const { repo } = fresh();
    const b1 = await repo.importBatch({ batch: meta({ contentDigest: 'b1' }), conversations: [withUpdated(linearConversation('c1', 1), iso(10))] });
    assert.equal(headBatchOf(repo, 'c1'), b1.batchId);
    const b2 = await repo.importBatch({ batch: meta({ contentDigest: 'b2' }), conversations: [withUpdated(linearConversation('c1', 2), iso(20))] });
    assert.equal(headBatchOf(repo, 'c1'), b2.batchId);
    await repo.importBatch({ batch: meta({ contentDigest: 'b3' }), conversations: [withUpdated(linearConversation('c1', 3), iso(5))] });
    assert.equal(headBatchOf(repo, 'c1'), b2.batchId, 'older updated_at imported later must not take over');
    assert.equal(repo.getConversation({ conversationId: 'c1' })?.messages.length, 5);
  });

  it('breaks ties by the greatest batch seq', async () => {
    const { repo } = fresh();
    await repo.importBatch({ batch: meta({ contentDigest: 'b1' }), conversations: [withUpdated(linearConversation('c1', 1), iso(10))] });
    const b2 = await repo.importBatch({ batch: meta({ contentDigest: 'b2' }), conversations: [withUpdated(linearConversation('c1', 2), iso(10))] });
    assert.equal(headBatchOf(repo, 'c1'), b2.batchId);
    const b3 = await repo.importBatch({ batch: meta({ contentDigest: 'b3' }), conversations: [withUpdated(linearConversation('c1', 3), iso(10))] });
    assert.equal(headBatchOf(repo, 'c1'), b3.batchId);
  });

  it('treats NULL updated_at as the lowest value; two NULLs tie by seq', async () => {
    const { repo } = fresh();
    const n1 = await repo.importBatch({ batch: meta({ contentDigest: 'n1' }), conversations: [withUpdated(linearConversation('c1', 1), null)] });
    assert.equal(headBatchOf(repo, 'c1'), n1.batchId);
    const dated = await repo.importBatch({ batch: meta({ contentDigest: 'dated' }), conversations: [withUpdated(linearConversation('c1', 2), iso(1))] });
    assert.equal(headBatchOf(repo, 'c1'), dated.batchId, 'a real timestamp beats NULL');
    await repo.importBatch({ batch: meta({ contentDigest: 'n2' }), conversations: [withUpdated(linearConversation('c1', 3), null)] });
    assert.equal(headBatchOf(repo, 'c1'), dated.batchId, 'NULL arriving later does not beat a real timestamp');

    const m1 = await repo.importBatch({ batch: meta({ contentDigest: 'm1' }), conversations: [withUpdated(linearConversation('c9', 1), null)] });
    const m2 = await repo.importBatch({ batch: meta({ contentDigest: 'm2' }), conversations: [withUpdated(linearConversation('c9', 1), null)] });
    assert.notEqual(m1.batchId, m2.batchId);
    assert.equal(headBatchOf(repo, 'c9'), m2.batchId, 'both NULL: greatest seq wins');
  });

  it('compares updated_at as instants, so "Z" and ".000Z" spellings of the same moment tie (seq decides)', async () => {
    const { repo } = fresh();
    await repo.importBatch({ batch: meta({ contentDigest: 'p1' }), conversations: [withUpdated(linearConversation('c1', 1), '2025-03-01T00:00:00.000Z')] });
    const p2 = await repo.importBatch({ batch: meta({ contentDigest: 'p2' }), conversations: [withUpdated(linearConversation('c1', 2), '2025-03-01T00:00:00Z')] });
    assert.equal(headBatchOf(repo, 'c1'), p2.batchId);
    const p3 = await repo.importBatch({ batch: meta({ contentDigest: 'p3' }), conversations: [withUpdated(linearConversation('c1', 3), '2025-03-01T00:00:00.001Z')] });
    assert.equal(headBatchOf(repo, 'c1'), p3.batchId);
  });

  it('only touches conversations present in the new batch', async () => {
    const { db, repo } = fresh();
    const x = await repo.importBatch({ batch: meta({ contentDigest: 'x' }), conversations: [linearConversation('keep', 1), linearConversation('move', 1)] });
    const y = await repo.importBatch({ batch: meta({ contentDigest: 'y' }), conversations: [withUpdated(linearConversation('move', 2), iso(900))] });
    assert.equal(headBatchOf(repo, 'keep'), x.batchId);
    assert.equal(headBatchOf(repo, 'move'), y.batchId);
    assert.equal(count(db, 'conversation_heads'), 2);
  });

  it('readers default to the head; batchId pins an older snapshot; search sees only the head unless allBatches', async () => {
    const { db, repo } = fresh();
    const oldRec = convo('c1', link([msg({ id: 'o1', conversationId: 'c1', authorRole: 'user', text: 'zeppelin in the old snapshot', ordinal: 0 })]), { updatedAt: iso(1) });
    const newRec = convo('c1', link([msg({ id: 'n1', conversationId: 'c1', authorRole: 'user', text: 'dirigible in the new snapshot', ordinal: 0 })]), { updatedAt: iso(2) });
    const a = await repo.importBatch({ batch: meta({ contentDigest: 'old' }), conversations: [oldRec] });
    const b = await repo.importBatch({ batch: meta({ contentDigest: 'new' }), conversations: [newRec] });

    assert.deepEqual(repo.getConversation({ conversationId: 'c1' }), newRec);
    assert.deepEqual(repo.getConversation({ conversationId: 'c1', batchId: a.batchId }), oldRec);
    assert.equal(repo.getConversation({ conversationId: 'c1', batchId: 'b_nonexistent' }), null);
    assert.equal(repo.listConversations().total, 1);
    assert.equal(repo.listConversations({ includeAllBatches: true }).total, 2);
    assert.equal(repo.getMessage({ conversationId: 'c1' }, 'n1')?.text, 'dirigible in the new snapshot');
    assert.equal(repo.getMessage({ conversationId: 'c1' }, 'o1'), null, 'the old snapshot message is not part of the head');
    assert.equal(repo.getMessage({ conversationId: 'c1', batchId: a.batchId }, 'o1')?.text, 'zeppelin in the old snapshot');

    assert.equal(searchMessages(db, { query: 'zeppelin' }).items.length, 0);
    assert.equal(searchMessages(db, { query: 'dirigible' }).items.length, 1);
    const all = searchMessages(db, { query: 'zeppelin', allBatches: true });
    assert.equal(all.items.length, 1);
    assert.equal(all.items[0]?.batchId, a.batchId);
    assert.equal(searchMessages(db, { query: 'dirigible', allBatches: true }).items[0]?.batchId, b.batchId);
  });
});

describe('importBatch: provider and account scoping', () => {
  it('the same conversation and message ids under another provider or accountLabel never collide', async () => {
    const { db, repo } = fresh();
    const mk = (provider: 'chatgpt' | 'claude', accountLabel: string, text: string): ConversationRecord => ({
      ...convo('shared-id', link([msg({ id: 'shared-msg', conversationId: 'shared-id', text, ordinal: 0 })])),
      provider,
      accountLabel,
      provenance: provider === 'claude' ? 'official_claude_export' : 'official_chatgpt_export',
    });
    const claude = mk('claude', 'default', 'text from claude default');
    const other = mk('chatgpt', 'other', 'text from chatgpt other');
    const main = mk('chatgpt', 'default', 'text from chatgpt default');
    const m = (r: ConversationRecord, d: string): ImportBatchMeta => meta({ provider: r.provider, accountLabel: r.accountLabel, provenance: r.provenance, contentDigest: d });
    await repo.importBatch({ batch: m(claude, 'same-digest'), conversations: [claude] });
    await repo.importBatch({ batch: m(other, 'same-digest'), conversations: [other] });
    await repo.importBatch({ batch: m(main, 'same-digest'), conversations: [main] });

    assert.equal(count(db, 'source_batches'), 3, 'identical digest under different scopes: three batches');
    assert.equal(count(db, 'messages'), 3);
    assert.equal(count(db, 'conversation_heads'), 3);

    assert.deepEqual(repo.getConversation({ conversationId: 'shared-id', provider: 'claude', accountLabel: 'default' }), claude);
    assert.deepEqual(repo.getConversation({ conversationId: 'shared-id', provider: 'chatgpt', accountLabel: 'other' }), other);
    assert.deepEqual(repo.getConversation({ conversationId: 'shared-id', provider: 'chatgpt', accountLabel: 'default' }), main);
    assert.equal(repo.getMessage({ conversationId: 'shared-id', provider: 'claude' }, 'shared-msg')?.text, 'text from claude default');

    const matches = repo.resolveConversation({ conversationId: 'shared-id' }).matches;
    assert.equal(matches.length, 3);
    assert.deepEqual(matches.map((x) => `${x.provider}/${x.accountLabel}`), ['chatgpt/default', 'chatgpt/other', 'claude/default']);
    assert.equal(repo.resolveConversation({ conversationId: 'shared-id', provider: 'chatgpt' }).matches.length, 2);

    // searching is scoped as well
    assert.equal(searchMessages(db, { query: 'text', provider: 'claude' }).items.length, 1);
    assert.equal(searchMessages(db, { query: 'text', provider: 'chatgpt', accountLabel: 'other' }).items[0]?.accountLabel, 'other');
    assert.equal(searchMessages(db, { query: 'text' }).items.length, 3);
  });

  it('getConversation / getMessage throw AMBIGUOUS_CONVERSATION when the id exists in several scopes and the ref does not choose', async () => {
    const { repo } = fresh();
    for (const [provider, accountLabel] of [
      ['chatgpt', 'a'],
      ['chatgpt', 'b'],
    ] as const) {
      const rec = { ...linearConversation('twin', 1), accountLabel };
      await repo.importBatch({ batch: meta({ provider, accountLabel, contentDigest: accountLabel }), conversations: [rec] });
    }
    assert.throws(
      () => repo.getConversation({ conversationId: 'twin' }),
      (e) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'AMBIGUOUS_CONVERSATION');
        const cands = (e.details as { candidates: Array<{ accountLabel: string }> }).candidates;
        assert.deepEqual(cands.map((c) => c.accountLabel), ['a', 'b']);
        return true;
      },
    );
    assert.throws(() => repo.getMessage({ conversationId: 'twin' }, 'twin-u0'), expectCode('AMBIGUOUS_CONVERSATION'));
    assert.equal(repo.getConversation({ conversationId: 'twin', accountLabel: 'b' })?.accountLabel, 'b');
    assert.equal(repo.getConversation({ conversationId: 'unknown' }), null);
    assert.equal(repo.getMessage({ conversationId: 'unknown' }, 'x'), null);
  });

  it('a record whose provider or account differs from the batch is rejected and rolled back', async () => {
    const { db, repo } = fresh();
    const stranger = { ...linearConversation('c2', 1), accountLabel: 'someone-else' };
    await assert.rejects(repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1), stranger] }), expectCode('INVALID_ARGUMENT'));
    assert.deepEqual(allCounts(db), Object.fromEntries(ALL_COUNTED.map((t) => [t, 0])));
    const claudeRec = { ...linearConversation('c3', 1), provider: 'claude' as const, provenance: 'official_claude_export' as const };
    await assert.rejects(repo.importBatch({ batch: META, conversations: [claudeRec] }), expectCode('INVALID_ARGUMENT'));
  });
});

describe('importBatch: atomicity', () => {
  const EMPTY = Object.fromEntries(ALL_COUNTED.map((t) => [t, 0]));

  it('an error thrown by a synchronous iterable midway rolls back everything, including the index and heads', async () => {
    const { db, repo } = fresh();
    const boom = new Error('iterable exploded');
    await assert.rejects(
      repo.importBatch({
        batch: META,
        conversations: (function* () {
          yield linearConversation('c1', 2);
          yield branchedConversation('c2');
          throw boom;
        })(),
      }),
      (e) => e === boom,
    );
    assert.deepEqual(allCounts(db), EMPTY);
    assert.equal(db.isTransaction, false);
    // the connection is healthy afterwards and the same batch can now be imported for real
    const ok = await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 2)] });
    assert.equal(ok.alreadyImported, false);
    assert.equal(count(db, 'messages'), 5);
  });

  it('an error thrown by an ASYNC iterable midway rolls back everything', async () => {
    const { db, repo } = fresh();
    await assert.rejects(
      repo.importBatch({
        batch: META,
        conversations: (async function* () {
          yield linearConversation('c1', 2);
          await new Promise((r) => setImmediate(r));
          yield linearConversation('c2', 2);
          throw new GcrError('IMPORT_ZIP_UNSAFE', 'unsafe entry');
        })(),
      }),
      expectCode('IMPORT_ZIP_UNSAFE'),
    );
    assert.deepEqual(allCounts(db), EMPTY);
    assert.equal(db.isTransaction, false);
  });

  it('a record that fails validation midway aborts the whole batch with IMPORT_PARSE_ERROR (field paths only)', async () => {
    const { db, repo } = fresh();
    const bad = { ...linearConversation('c2', 1), createdAt: 'LEAKMARKER-not-a-date' } as ConversationRecord;
    await assert.rejects(
      repo.importBatch({ batch: META, conversations: [linearConversation('c1', 1), bad] }),
      (e) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_PARSE_ERROR');
        assert.ok(!JSON.stringify(e.toEnvelope()).includes('LEAKMARKER'));
        return true;
      },
    );
    assert.deepEqual(allCounts(db), EMPTY);
  });

  it('a SQLite failure inside the transaction (violated constraint) rolls back and maps to a GcrError without SQL text', async () => {
    const { db, repo } = fresh();
    // Sabotage: a trigger that makes the 3rd message insert fail with a SQLite error.
    db.exec(
      "CREATE TRIGGER sabotage BEFORE INSERT ON messages WHEN (SELECT count(*) FROM messages) >= 2 BEGIN SELECT RAISE(ABORT, 'SQL-SECRET-DETAIL sabotage'); END",
    );
    await assert.rejects(
      repo.importBatch({ batch: META, conversations: [linearConversation('c1', 2)] }),
      (e) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'DB_ERROR');
        assert.ok(!e.message.includes('SECRET'));
        return true;
      },
    );
    db.exec('DROP TRIGGER sabotage');
    assert.deepEqual(allCounts(db), EMPTY);
    assert.equal(db.isTransaction, false);
  });

  it('refuses a second import on the same connection while one is open (even through another Repository), then recovers', async () => {
    const { db, repo } = fresh();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = repo.importBatch({
      batch: meta({ contentDigest: 'first' }),
      conversations: (async function* () {
        yield linearConversation('c1', 1);
        await gate;
        yield linearConversation('c2', 1);
      })(),
    });
    await new Promise((r) => setImmediate(r)); // let the first import reach its await
    assert.equal(db.isTransaction, true);
    await assert.rejects(repo.importBatch({ batch: meta({ contentDigest: 'second' }), conversations: [linearConversation('c3', 1)] }), expectCode('DB_ERROR'));
    await assert.rejects(new Repository(db).importBatch({ batch: meta({ contentDigest: 'third' }), conversations: [] }), expectCode('DB_ERROR'));
    assert.throws(() => repo.rebuildSearchIndex(), expectCode('DB_ERROR'));
    release();
    const res = await first;
    assert.equal(res.conversations.stored, 2);
    const later = await repo.importBatch({ batch: meta({ contentDigest: 'fourth' }), conversations: [linearConversation('c4', 1)] });
    assert.equal(later.conversations.stored, 1);
    assert.equal(count(db, 'source_batches'), 2);
  });

  it('rejects malformed batch metadata and sources before touching the database', async () => {
    const { db, repo } = fresh();
    const bad: Array<[string, () => Promise<unknown>]> = [
      ['provider', () => repo.importBatch({ batch: { ...META, provider: 'bing' as never }, conversations: [] })],
      ['provenance', () => repo.importBatch({ batch: { ...META, provenance: 'made_up' as never }, conversations: [] })],
      ['completeness', () => repo.importBatch({ batch: { ...META, completeness: 'full' as never }, conversations: [] })],
      ['importedAt', () => repo.importBatch({ batch: { ...META, importedAt: 'yesterday' }, conversations: [] })],
      ['accountLabel', () => repo.importBatch({ batch: { ...META, accountLabel: '' }, conversations: [] })],
      ['digest', () => repo.importBatch({ batch: { ...META, contentDigest: 'x\0y' }, conversations: [] })],
      ['warnings', () => repo.importBatch({ batch: { ...META, warnings: [{ code: 1 } as never] }, conversations: [] })],
      ['source', () => repo.importBatch({ batch: META, conversations: 42 as never })],
      ['input', () => repo.importBatch(null as never)],
    ];
    for (const [name, run] of bad) await assert.rejects(run(), expectCode('INVALID_ARGUMENT'), name);
    assert.deepEqual(allCounts(db), Object.fromEntries(ALL_COUNTED.map((t) => [t, 0])));
  });
});

describe('readers', () => {
  it('round-trips a rich record exactly (FR-03): nulls, hidden flags, unknown blocks, attachments, raw source, warnings, Unicode', async () => {
    const { repo } = fresh();
    const rich = richRecord();
    await repo.importBatch({ batch: META, conversations: [rich, linearConversation('c1', 2), branchedConversation('c2')] });
    assert.deepEqual(repo.getConversation({ conversationId: 'conv-rich' }), rich);
    assert.deepEqual(repo.getConversation({ conversationId: 'c1' }), linearConversation('c1', 2));
    assert.deepEqual(repo.getConversation({ conversationId: 'c2' }), branchedConversation('c2'));
    const m = repo.getMessage({ conversationId: 'conv-rich' }, 'u');
    assert.deepEqual(m, rich.messages[1]);
    assert.equal(repo.getMessage({ conversationId: 'conv-rich' }, 'no-such-message'), null);
    // explicit null rawSource survives as null, an absent one stays absent
    assert.equal(repo.getMessage({ conversationId: 'conv-rich' }, 'blank')?.rawSource, null);
    assert.ok(!('rawSource' in (repo.getMessage({ conversationId: 'conv-rich' }, 'a') ?? {})));
  });

  it('orders messages by ordinal, not by insertion or id order', async () => {
    const { repo } = fresh();
    const rec = convo('c1', [
      msg({ id: 'zzz', conversationId: 'c1', ordinal: 0, text: 'first' }),
      msg({ id: 'aaa', conversationId: 'c1', ordinal: 2, text: 'third' }),
      msg({ id: 'mmm', conversationId: 'c1', ordinal: 1, text: 'second' }),
    ]);
    await repo.importBatch({ batch: META, conversations: [rec] });
    assert.deepEqual(repo.getConversation({ conversationId: 'c1' })?.messages.map((m) => m.id), ['zzz', 'mmm', 'aaa']);
  });

  it('round-trips ids and text containing quotes, SQL fragments and large payloads', async () => {
    const { repo, db } = fresh();
    const evilId = "x'; DROP TABLE messages;--";
    const big = 'lorem ipsum 日本語 '.repeat(60_000); // ~1.1M chars
    const rec = convo(evilId, link([msg({ id: "m'1\"", conversationId: evilId, text: big, ordinal: 0 })]), { title: "'; DELETE FROM conversations;--" });
    await repo.importBatch({ batch: meta({ accountLabel: "acct'; DROP TABLE x;--" }), conversations: [{ ...rec, accountLabel: "acct'; DROP TABLE x;--" }] });
    const got = repo.getConversation({ conversationId: evilId, accountLabel: "acct'; DROP TABLE x;--" });
    assert.equal(got?.messages[0]?.text.length, big.length);
    assert.equal(got?.title, "'; DELETE FROM conversations;--");
    assert.equal(count(db, 'messages'), 1);
  });

  it('parses damaged JSON columns defensively: empty values plus a STORED_JSON_INVALID warning, never an exception', async () => {
    const { db, repo } = fresh();
    await repo.importBatch({ batch: META, conversations: [richRecord()] });
    db.exec('DROP TRIGGER messages_no_update');
    db.exec('DROP TRIGGER conversations_no_update');
    db.exec("UPDATE messages SET blocks_json = '{not json', child_ids_json = '\"scalar\"', attachments_json = '5', raw_source_json = 'nope' WHERE message_id = 'u'");
    db.exec("UPDATE messages SET blocks_json = '[{\"text\":\"no type\"}]' WHERE message_id = 'a'");
    db.exec("UPDATE conversations SET raw_metadata_json = '[[', warnings_json = '{}'");
    const got = repo.getConversation({ conversationId: 'conv-rich' });
    assert.ok(got);
    const u = got.messages.find((m) => m.id === 'u');
    assert.deepEqual(u?.blocks, []);
    assert.deepEqual(u?.childIds, []);
    assert.deepEqual(u?.attachments, []);
    assert.ok(!('rawSource' in (u ?? {})));
    assert.deepEqual(got.messages.find((m) => m.id === 'a')?.blocks, []);
    assert.ok(!('rawMetadata' in got));
    const w = got.warnings.find((x) => x.code === 'STORED_JSON_INVALID');
    assert.ok(w, 'the damage is reported');
    assert.ok(w.ids?.includes('conv-rich'));
    // the text, which is not JSON, is untouched
    assert.equal(u?.text, richRecord().messages[1]?.text);
  });

  it('listBatches / getBatch expose full provenance; unknown batch is null', async () => {
    const { repo } = fresh();
    const a = await repo.importBatch({ batch: meta({ contentDigest: 'a', sourceLabel: 'one.zip' }), conversations: [linearConversation('c1', 1)] });
    const b = await repo.importBatch({
      batch: meta({ provider: 'claude', provenance: 'official_claude_export', completeness: 'unknown', contentDigest: 'b', sourceKind: 'conversations_json', sourceLabel: 'two.json' }),
      conversations: [],
    });
    const list = repo.listBatches();
    assert.deepEqual(list.map((x) => x.batchId), [a.batchId, b.batchId]);
    assert.equal(list[1]?.provider, 'claude');
    assert.equal(list[1]?.completeness, 'unknown');
    assert.equal(list[1]?.sourceKind, 'conversations_json');
    assert.equal(list[0]?.accountLabel, 'default');
    assert.equal(repo.getBatch(a.batchId)?.sourceLabel, 'one.zip');
    assert.equal(repo.getBatch('b_does_not_exist'), null);
  });

  it('works on a file database across a close/reopen, including from a read-only handle', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'g.sqlite');
      const rw = openDatabase(path);
      const rich = richRecord();
      await new Repository(rw.db).importBatch({ batch: META, conversations: [rich] });
      closeDatabase(rw);
      const ro = openDatabase(path, { readOnly: true });
      try {
        const repo = new Repository(ro.db);
        assert.deepEqual(repo.getConversation({ conversationId: 'conv-rich' }), rich);
        assert.equal(searchMessages(ro.db, { query: '日本語' }).items.length, 1);
        assert.equal(repo.listBatches().length, 1);
      } finally {
        closeDatabase(ro);
      }
    });
  });

  it('VACUUM does not break the index: rowids (the link between messages and the FTS index) are preserved', async () => {
    const { db, repo } = fresh();
    await repo.importBatch({ batch: META, conversations: [linearConversation('c1', 3, { text: (i, r) => `${r} alpha${i}` }), linearConversation('c2', 3, { text: (i, r) => `${r} beta${i}` }), linearConversation('c3', 3, { text: (i, r) => `${r} gamma${i}` })] });
    // create rowid gaps the hard way: delete one conversation's rows (test-only: drop the immutability trigger first)
    db.exec('DROP TRIGGER messages_no_delete');
    db.exec("DELETE FROM messages WHERE conversation_id = 'c2'");
    const rowids = () => JSON.stringify(db.prepare('SELECT rowid, message_id FROM messages ORDER BY rowid').all());
    const before = rowids();
    const hitsBefore = JSON.stringify(searchMessages(db, { query: 'gamma2' }).items.map((h) => h.messageId));
    db.exec('VACUUM');
    assert.equal(rowids(), before, 'VACUUM must not renumber rowids of the messages table');
    assert.equal(JSON.stringify(searchMessages(db, { query: 'gamma2' }).items.map((h) => h.messageId)), hitsBefore);
    assert.deepEqual(searchMessages(db, { query: 'gamma2' }).items.map((h) => h.messageId).sort(), ['c3-a2', 'c3-u2']);
  });

  it('rebuildSearchIndex recreates a lost index with identical search results', async () => {
    const { db, repo } = fresh();
    await repo.importBatch({ batch: META, conversations: [richRecord(), linearConversation('c1', 3), branchedConversation('c2')] });
    const snapshot = () => JSON.stringify([searchMessages(db, { query: 'first' }).items, searchMessages(db, { query: '日本語' }).items, searchMessages(db, { query: 'prompt*' }).items]);
    const before = snapshot();
    const expectedIndexed = Number(db.prepare("SELECT count(*) AS n FROM messages WHERE node_kind = 'message' AND text <> ''").get()?.['n']);
    assert.equal(count(db, 'messages_fts_docsize'), expectedIndexed);
    db.exec("INSERT INTO messages_fts (messages_fts) VALUES ('delete-all')");
    assert.equal(searchMessages(db, { query: '日本語' }).items.length, 0, 'index really is gone');
    const res = repo.rebuildSearchIndex();
    assert.equal(res.messages, expectedIndexed);
    assert.equal(res.conversations, 3);
    assert.equal(snapshot(), before);
  });
});

describe('listConversations', () => {
  async function seeded(): Promise<{ repo: Repository }> {
    const { repo } = fresh();
    const mk = (id: string, title: string | null, created: number | null, updated: number | null): ConversationRecord => ({
      ...linearConversation(id, 1),
      title,
      createdAt: created === null ? null : iso(created),
      updatedAt: updated === null ? null : iso(updated),
    });
    const claude: ConversationRecord = { ...mk('c-claude', 'Claude thread', 7, 70), provider: 'claude', provenance: 'official_claude_export' };
    const work: ConversationRecord = { ...mk('c-work', 'Work thread', 8, 80), accountLabel: 'work' };
    await repo.importBatch({
      batch: META,
      conversations: [mk('c1', 'banana', 3, 30), mk('c2', 'Apple', 1, 10), mk('c3', null, 2, null), mk('c4', 'cherry', null, 40), mk('c5', 'apple', 5, 50)],
    });
    await repo.importBatch({ batch: meta({ provider: 'claude', provenance: 'official_claude_export', contentDigest: 'cl' }), conversations: [claude] });
    await repo.importBatch({ batch: meta({ accountLabel: 'work', contentDigest: 'wk' }), conversations: [work] });
    return { repo };
  }

  it('sorts by updated_desc (NULL last), created_desc (NULL last) and title_asc (case-insensitive, NULL last) with a total order', async () => {
    const { repo } = await seeded();
    const ids = (sort: 'updated_desc' | 'created_desc' | 'title_asc') => repo.listConversations({ sort, provider: 'chatgpt', accountLabel: 'default' }).items.map((c) => c.conversationId);
    assert.deepEqual(ids('updated_desc'), ['c5', 'c4', 'c1', 'c2', 'c3']);
    assert.deepEqual(ids('created_desc'), ['c5', 'c1', 'c3', 'c2', 'c4']);
    assert.deepEqual(ids('title_asc'), ['c2', 'c5', 'c1', 'c4', 'c3']); // Apple, apple (binary tie-break), banana, cherry, NULL
    assert.deepEqual(repo.listConversations({ provider: 'chatgpt', accountLabel: 'default' }).items.map((c) => c.conversationId), ids('updated_desc'), 'default sort is updated_desc');
  });

  it('filters by provider and accountLabel, reports total, and paginates without gaps or repeats', async () => {
    const { repo } = await seeded();
    assert.equal(repo.listConversations().total, 7);
    assert.equal(repo.listConversations({ provider: 'claude' }).total, 1);
    assert.equal(repo.listConversations({ provider: 'chatgpt' }).total, 6);
    assert.equal(repo.listConversations({ accountLabel: 'work' }).items[0]?.conversationId, 'c-work');
    assert.equal(repo.listConversations({ provider: 'claude', accountLabel: 'work' }).total, 0);

    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = repo.listConversations({ limit: 3, offset });
      assert.equal(page.total, 7);
      assert.equal(page.limit, 3);
      assert.equal(page.offset, offset);
      seen.push(...page.items.map((c) => c.conversationId));
      if (page.nextOffset === null) break;
      assert.equal(page.nextOffset, offset + page.items.length);
      offset = page.nextOffset;
    }
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
    assert.deepEqual(seen, repo.listConversations({ limit: 500 }).items.map((c) => c.conversationId));
    assert.deepEqual(repo.listConversations({ offset: 100 }).items, []);
    assert.equal(repo.listConversations({ offset: 100 }).nextOffset, null);
  });

  it('titleQuery uses the title index: case/diacritic-insensitive, prefix-capable, combinable with other filters', async () => {
    const { repo } = await seeded();
    assert.deepEqual(repo.listConversations({ titleQuery: 'APPLE' }).items.map((c) => c.conversationId).sort(), ['c2', 'c5']);
    assert.deepEqual(repo.listConversations({ titleQuery: 'thre*' }).items.map((c) => c.conversationId).sort(), ['c-claude', 'c-work']);
    assert.deepEqual(repo.listConversations({ titleQuery: 'thread', provider: 'claude' }).items.map((c) => c.conversationId), ['c-claude']);
    assert.equal(repo.listConversations({ titleQuery: 'nonexistentword' }).total, 0);
    assert.equal(repo.listConversations({ titleQuery: 'ban' }).total, 0, 'a bare prefix without * is not a match');
  });

  it('validates its arguments (INVALID_ARGUMENT) and never echoes them', async () => {
    const { repo } = await seeded();
    const bad: Array<Parameters<Repository['listConversations']>[0]> = [
      { limit: 0 },
      { limit: 501 },
      { limit: 1.5 },
      { limit: '5' as never },
      { offset: -1 },
      { offset: 0.5 },
      { sort: 'random' as never },
      { titleQuery: '' },
      { titleQuery: '!!!' },
      { titleQuery: 42 as never },
      { provider: 5 as never },
      { accountLabel: 'x\0y' },
      { includeAllBatches: 'yes' as never },
    ];
    for (const opts of bad) assert.throws(() => repo.listConversations(opts), expectCode('INVALID_ARGUMENT'), JSON.stringify(opts));
  });
});
