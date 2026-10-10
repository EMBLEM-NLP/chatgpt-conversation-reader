/**
 * Duplicate-conversation resolution across shards (research Layer 0 step 4). The winner is chosen by a TOTAL order:
 * greatest update time (missing = lowest), then largest element, then earliest file order, then earliest index.
 * Levels 1-2 are properties of the data (independent of shard order); levels 3-4 follow the name-derived file order.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { runImport } from '../../src/ingest/import-runner.js';
import { OMIT, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { claudeLinearConversation, synthUuid } from '../helpers/claude-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { arrayOf, chatConv, count, fixedClock, freshRepo, writeFileIn, zipOf } from './import-runner.helpers.test.js';
import type { TestRepo } from './import-runner.helpers.test.js';

const T0 = 1_760_000_000;
const ID = 1;

/** Import a folder of shards and return the title of the stored conversation ID plus the report. */
async function winnerOf(shards: Record<string, string>, t: TestRepo = freshRepo()) {
  return withTempDir(async (dir) => {
    for (const [name, body] of Object.entries(shards)) await writeFileIn(dir, name, body);
    const report = await runImport(t.repo, { source: { kind: 'path', path: dir }, clock: fixedClock });
    const rec = t.repo.getConversation({ conversationId: syntheticUuid(ID) });
    return { title: rec?.title ?? null, report, t };
  });
}

const dup = (title: string, over: { updateTime?: unknown; pairs?: number; n?: number } = {}) =>
  chatConv(over.n ?? ID, { title, pairs: over.pairs ?? 1, ...(over.updateTime === undefined ? {} : { updateTime: over.updateTime }) });

describe('duplicate resolution: the four tie-break levels', () => {
  it('level 1: the greatest update_time wins, independent of shard order', async () => {
    const older = arrayOf([dup('OLD', { updateTime: T0 + 10 })]);
    const newer = arrayOf([dup('NEW', { updateTime: T0 + 500 })]);
    const a = await winnerOf({ 'conversations-1.json': older, 'conversations-2.json': newer });
    const b = await winnerOf({ 'conversations-1.json': newer, 'conversations-2.json': older });
    assert.equal(a.title, 'NEW');
    assert.equal(b.title, 'NEW');
    assert.equal(a.t.db.prepare('SELECT count(*) AS n FROM conversations').get()?.['n'], 1);
    a.t.close();
    b.t.close();
  });

  it('a missing update_time is the lowest (null never beats a number)', async () => {
    const missing = arrayOf([dup('NOTIME', { updateTime: null })]);
    const dated = arrayOf([dup('DATED', { updateTime: T0 })]);
    const a = await winnerOf({ 'conversations-1.json': missing, 'conversations-2.json': dated });
    const b = await winnerOf({ 'conversations-1.json': dated, 'conversations-2.json': missing });
    assert.equal(a.title, 'DATED');
    assert.equal(b.title, 'DATED');
    a.t.close();
    b.t.close();
  });

  it('level 2: equal update_time -> the larger element (more bytes) wins, independent of shard order', async () => {
    const small = arrayOf([dup('SMALL', { updateTime: T0, pairs: 1 })]);
    const large = arrayOf([dup('LARGE', { updateTime: T0, pairs: 4 })]);
    const a = await winnerOf({ 'conversations-1.json': small, 'conversations-2.json': large });
    const b = await winnerOf({ 'conversations-1.json': large, 'conversations-2.json': small });
    assert.equal(a.title, 'LARGE');
    assert.equal(b.title, 'LARGE');
    a.t.close();
    b.t.close();
  });

  it('level 3: equal time and size -> the earliest FILE ORDER wins (this level depends on the numeric shard order)', async () => {
    const x = arrayOf([dup('AAAAA', { updateTime: T0 })]);
    const y = arrayOf([dup('BBBBB', { updateTime: T0 })]);
    const a = await winnerOf({ 'conversations-2.json': x, 'conversations-10.json': y });
    assert.equal(a.title, 'AAAAA', 'conversations-2 sorts before conversations-10 (numeric, not lexical)');
    const b = await winnerOf({ 'conversations-2.json': y, 'conversations-10.json': x });
    assert.equal(b.title, 'BBBBB');
    // The plain conversations.json is first of all.
    const c = await winnerOf({ 'conversations-0.json': x, 'conversations.json': y });
    assert.equal(c.title, 'BBBBB');
    a.t.close();
    b.t.close();
    c.t.close();
  });

  it('level 4: equal time, size and file -> the earliest INDEX wins', async () => {
    const body = arrayOf([dup('FIRST', { updateTime: T0 }), dup('OTHER', { updateTime: T0 })]);
    const r = await winnerOf({ 'conversations.json': body });
    assert.equal(r.title, 'FIRST');
    assert.equal(r.report.conversations.stored, 1);
    r.t.close();
  });

  it('the result does not depend on the order of the entries inside the ZIP', async () => {
    const mk = (entries: Record<string, string>) =>
      withTempDir(async (dir) => {
        await writeFile(join(dir, 'e.zip'), zipOf(entries));
        const t = freshRepo();
        const r = await runImport(t.repo, { source: { kind: 'path', path: join(dir, 'e.zip') }, clock: fixedClock });
        const title = t.repo.getConversation({ conversationId: syntheticUuid(ID) })?.title;
        t.close();
        return { title, batchId: r.batchId };
      });
    const s1 = arrayOf([dup('S1-AAAA', { updateTime: T0 })]);
    const s2 = arrayOf([dup('S2-BBBB', { updateTime: T0 })]);
    const a = await mk({ 'conversations-1.json': s1, 'conversations-2.json': s2 });
    const b = await mk({ 'conversations-2.json': s2, 'conversations-1.json': s1 });
    assert.deepEqual(a, b);
  });
});

describe('duplicate resolution: reporting and identity', () => {
  it('every loser is counted as DUPLICATE_CONVERSATION with the conversation id as sample and says which one won', async () => {
    const a = arrayOf([dup('W', { updateTime: T0 + 9 }), chatConv(2, { title: 'two' })]);
    const b = arrayOf([dup('L1', { updateTime: T0 }), dup('L2', { updateTime: T0 + 1, n: 3 })]);
    const c = arrayOf([dup('L3', { updateTime: T0 + 2 }), dup('L4', { updateTime: T0 + 3, n: 3 })]);
    const r = await winnerOf({ 'conversations-1.json': a, 'conversations-2.json': b, 'conversations-3.json': c });
    const w = r.report.warnings.find((x) => x.code === 'DUPLICATE_CONVERSATION');
    assert.ok(w);
    assert.equal(w.count, 3); // L1, L3 lost to W ; one of the two id-3 elements lost
    assert.deepEqual([...w.sampleIds].sort(), [syntheticUuid(1), syntheticUuid(3)].sort());
    assert.equal(r.report.conversations.read, 6);
    assert.equal(r.report.conversations.stored, 3);
    const stored = r.t.repo.getBatch(r.report.batchId)?.warnings.find((x) => x.code === 'DUPLICATE_CONVERSATION');
    assert.match(stored?.message ?? '', /kept conversations-1\.json#0, skipped conversations-2\.json#0/);
    assert.match(stored?.message ?? '', /\(count=3\)$/);
    assert.equal(r.title, 'W');
    r.t.close();
  });

  it('upper- and lower-case spellings of one UUID are the same conversation (like the adapter)', async () => {
    const lower = arrayOf([dup('LOWER', { updateTime: T0 })]);
    const upper = lower.replaceAll(syntheticUuid(ID), syntheticUuid(ID).toUpperCase()).replace('LOWER', 'UPPER');
    const r = await winnerOf({ 'conversations-1.json': lower, 'conversations-2.json': upper });
    assert.equal(r.report.warnings.find((x) => x.code === 'DUPLICATE_CONVERSATION')?.count, 1);
    assert.equal(r.report.conversations.stored, 1);
    r.t.close();
  });

  it('different ids are never duplicates; elements WITHOUT any id are never duplicates of each other', async () => {
    const noId = (title: string) => chatConv(9, { title, id: OMIT, conversationId: OMIT });
    const body = arrayOf([noId('N1'), noId('N2'), chatConv(2), chatConv(3)]);
    const r = await winnerOf({ 'conversations.json': body });
    assert.ok(!r.report.warnings.some((x) => x.code === 'DUPLICATE_CONVERSATION'));
    assert.equal(r.report.conversations.stored, 4);
    assert.ok(r.report.warnings.some((x) => x.code === 'CONVERSATION_ID_MISSING'));
    r.t.close();
  });

  it('duplicates between a plain conversations.json and shards are resolved the same way', async () => {
    const r = await winnerOf({
      'conversations.json': arrayOf([dup('PLAIN', { updateTime: T0 + 1 })]),
      'conversations-000.json': arrayOf([dup('SHARD', { updateTime: T0 + 2 })]),
    });
    assert.equal(r.title, 'SHARD');
    r.t.close();
  });

  it('wrapper members take part in duplicate resolution', async () => {
    const wrapper = JSON.stringify({ conversations: [JSON.parse(dup('IN-WRAPPER', { updateTime: T0 + 50 }).text())] });
    const r = await winnerOf({ 'conversations-1.json': wrapper, 'conversations-2.json': arrayOf([dup('PLAIN', { updateTime: T0 })]) });
    assert.equal(r.title, 'IN-WRAPPER');
    assert.equal(r.report.warnings.find((x) => x.code === 'DUPLICATE_CONVERSATION')?.count, 1);
    r.t.close();
  });

  it('Claude exports: duplicates are keyed by uuid and ordered by updated_at', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const mk = (name: string, minute: number) =>
          JSON.stringify([claudeLinearConversation(2, { uuid: synthUuid(7), name, updated_at: `2025-03-04T05:${String(minute).padStart(2, '0')}:00.000000Z` })]);
        await writeFileIn(dir, 'conversations-1.json', mk('CLAUDE-NEWER', 30));
        await writeFileIn(dir, 'conversations-2.json', mk('CLAUDE-OLDER', 10));
        const r = await runImport(t.repo, { source: { kind: 'path', path: dir }, clock: fixedClock });
        assert.equal(r.provider, 'claude');
        assert.equal(r.warnings.find((x) => x.code === 'DUPLICATE_CONVERSATION')?.count, 1);
        assert.equal(t.repo.getConversation({ conversationId: synthUuid(7) })?.title, 'CLAUDE-NEWER');
      });
    } finally {
      t.close();
    }
  });

  it('--strict aborts on a duplicate loser with the precise error and stores nothing', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        await writeFileIn(dir, 'conversations-1.json', arrayOf([dup('A', { updateTime: T0 })]));
        await writeFileIn(dir, 'conversations-2.json', arrayOf([dup('B', { updateTime: T0 + 1 })]));
        await assert.rejects(runImport(t.repo, { source: { kind: 'path', path: dir }, strict: true, clock: fixedClock }), (e: unknown) => {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'IMPORT_PARSE_ERROR');
          assert.equal(e.details?.['reason'], 'DUPLICATE_CONVERSATION');
          assert.equal(e.details?.['conversationId'], syntheticUuid(ID));
          assert.deepEqual(e.details?.['kept'], { file: 'conversations-2.json', index: 0 });
          assert.deepEqual(e.details?.['skipped'], { file: 'conversations-1.json', index: 0 });
          return true;
        });
        for (const tb of ['source_batches', 'conversations', 'messages']) assert.equal(count(t.db, tb), 0);
      });
    } finally {
      t.close();
    }
  });

  it('a duplicate that is NOT a duplicate across batches: a later import of a different export keeps both snapshots', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const a = await writeFileIn(dir, 'a/conversations.json', arrayOf([dup('V1', { updateTime: T0 })]));
        const b = await writeFileIn(dir, 'b/conversations.json', arrayOf([dup('V2', { updateTime: T0 + 100 })]));
        const r1 = await runImport(t.repo, { source: { kind: 'path', path: a }, clock: fixedClock });
        const r2 = await runImport(t.repo, { source: { kind: 'path', path: b }, clock: fixedClock });
        assert.notEqual(r1.batchId, r2.batchId);
        assert.equal(count(t.db, 'conversations'), 2);
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(ID) })?.title, 'V2', 'head = greatest updated_at');
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(ID), batchId: r1.batchId })?.title, 'V1', 'older snapshot kept and pinnable');
      });
    } finally {
      t.close();
    }
  });
});
