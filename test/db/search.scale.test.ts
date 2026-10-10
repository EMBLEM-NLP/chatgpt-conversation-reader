/**
 * NFR-05 baseline: 50k synthetic messages. Records import and search timings and the FTS index-size ratio in the test
 * output (diagnostics), and asserts only GENEROUS bounds so the test is not flaky on a slow runner.
 * Synthetic data only (deterministic LCG, no real text).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationRecord } from '../../src/domain/types.js';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { searchMessages } from '../../src/db/search.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'synthetic.zip',
  contentDigest: 'scale-digest',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

const CONVERSATIONS = 500;
const PER_CONVERSATION = 100; // 500 x 100 = 50,000 messages (+500 structural roots)
const UNIQUE_TOKEN = 'zzuniquetokenzz';
const UNIQUE_AT = { conversation: 123, message: 45 };
const PHRASE_AT = { conversation: 321, message: 7 };

/** Deterministic pseudo-random generator (numerical recipes LCG). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ter', 'ban', 'qua', 'ver', 'dis', 'pro', 'tex', 'nal', 'sol', 'ium', 'arc', 'eon', 'fos', 'gra', 'hel', 'ind', 'jur'];

function makeVocabulary(rnd: () => number, size: number): string[] {
  return Array.from({ length: size }, () => {
    let w = '';
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rnd() * SYLLABLES.length)] ?? 'ka';
    return w + String(Math.floor(rnd() * 50));
  });
}

function* syntheticConversations(rnd: () => number, vocab: string[]): Generator<ConversationRecord> {
  const word = () => vocab[Math.floor(Math.pow(rnd(), 2) * vocab.length)] ?? 'ka0'; // skewed: a few very common words
  for (let c = 0; c < CONVERSATIONS; c++) {
    const id = `conv-${c}`;
    const nodes = [msg({ id: `${id}-root`, conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 })];
    let prev = `${id}-root`;
    for (let i = 0; i < PER_CONVERSATION; i++) {
      const mid = `${id}-m${i}`;
      const n = 20 + Math.floor(rnd() * 80);
      const words: string[] = [];
      for (let k = 0; k < n; k++) words.push(word());
      if (c === UNIQUE_AT.conversation && i === UNIQUE_AT.message) words.splice(5, 0, UNIQUE_TOKEN);
      if (c === PHRASE_AT.conversation && i === PHRASE_AT.message) words.splice(3, 0, 'needle', 'in', 'haystack');
      if (i % 100 === 99) words.push('これは日本語のテスト'); // CJK sentence in 1% of messages
      nodes.push(msg({ id: mid, conversationId: id, parentId: prev, authorRole: i % 2 === 0 ? 'user' : 'assistant', createdAt: iso(c * PER_CONVERSATION + i), text: words.join(' '), ordinal: i + 1 }));
      prev = mid;
    }
    yield convo(id, link(nodes), { currentNodeId: prev });
  }
}

/** Bytes used by the FTS shadow tables of `table` (dbstat), and by everything else, for the size-ratio report. */
function ftsBytes(db: DatabaseSync, table: string): number {
  const row = db.prepare("SELECT coalesce(sum(pgsize), 0) AS n FROM dbstat WHERE name = ? OR name LIKE ? ESCAPE '\\'").get(table, `${table}\\_%`);
  return Number(row?.['n']);
}

function rawTextBytes(db: DatabaseSync): number {
  return Number(db.prepare("SELECT sum(length(CAST(text AS BLOB))) AS n FROM messages WHERE node_kind = 'message'").get()?.['n']);
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

function report(t: TestContext, line: string): void {
  t.diagnostic(line);
}

describe('50k-message baseline (NFR-05)', { timeout: 180_000 }, () => {
  it('imports 50,000 messages, searches in well under a second, keeps the index within 3x the raw text', async (t) => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const rnd = lcg(20261016);
    const vocab = makeVocabulary(rnd, 20_000);

    const t0 = performance.now();
    const res = await repo.importBatch({ batch: META, conversations: syntheticConversations(rnd, vocab) });
    const importMs = Math.round(performance.now() - t0);
    assert.equal(res.messages.stored, CONVERSATIONS * (PER_CONVERSATION + 1));
    assert.equal(res.messages.structural, CONVERSATIONS);
    assert.equal(repo.getBatch(res.batchId)?.messageCount, CONVERSATIONS * PER_CONVERSATION);
    report(t, `import: ${res.messages.stored} nodes (${CONVERSATIONS * PER_CONVERSATION} messages) in ${importMs} ms = ${Math.round((CONVERSATIONS * PER_CONVERSATION) / (importMs / 1000))} messages/s`);
    assert.ok(importMs < 60_000, `import took ${importMs} ms (bound 60000)`);

    // idempotent re-import must not re-read anything
    const t1 = performance.now();
    const reimport = await repo.importBatch({ batch: META, conversations: syntheticConversations(rnd, vocab) });
    const reimportMs = Math.round((performance.now() - t1) * 10) / 10;
    assert.equal(reimport.alreadyImported, true);
    assert.equal(reimport.messages.stored, res.messages.stored);
    report(t, `idempotent re-import: ${reimportMs} ms (no data read)`);
    assert.ok(reimportMs < 1000);

    // ---- searches -----------------------------------------------------------------------------------------------
    const common = vocab[0] ?? 'ka0';
    const rare = vocab[19_999] ?? 'ka0';
    const queries: Array<[string, Parameters<typeof searchMessages>[1]]> = [
      ['most common word', { query: common }],
      ['common word, hidden/all batches off, page 2 via offset', { query: common, offset: 20 }],
      ['rare word', { query: rare }],
      ['two words (AND)', { query: `${common} ${vocab[3] ?? 'ka0'}` }],
      ['prefix ka*', { query: 'ka*' }],
      ['phrase', { query: '"needle in haystack"' }],
      ['unique token', { query: UNIQUE_TOKEN }],
      ['CJK substring', { query: '日本語' }],
      ['filtered by role + date range', { query: common, role: 'assistant', createdAfter: iso(1000), createdBefore: iso(30000) }],
      ['raw mode OR', { query: `${common} OR ${rare}`, mode: 'raw' }],
    ];
    for (const [label, q] of queries) {
      const { value, ms } = timed(() => searchMessages(h.db, q));
      report(t, `search [${label}]: ${value.items.length} hits on page, ${ms} ms`);
      assert.ok(ms < 1000, `search "${label}" took ${ms} ms (bound 1000)`);
      for (const hit of value.items) assert.ok(hit.snippet.length <= 160);
    }

    // correctness spot checks at scale
    const unique = searchMessages(h.db, { query: UNIQUE_TOKEN });
    assert.deepEqual(unique.items.map((x) => `${x.conversationId}/${x.messageId}`), [`conv-${UNIQUE_AT.conversation}/conv-${UNIQUE_AT.conversation}-m${UNIQUE_AT.message}`]);
    assert.ok(unique.items[0]?.snippet.includes(`\u0001${UNIQUE_TOKEN}\u0002`));
    const phrase = searchMessages(h.db, { query: '"needle in haystack"' });
    assert.equal(phrase.items.length, 1);
    assert.equal(phrase.items[0]?.messageId, `conv-${PHRASE_AT.conversation}-m${PHRASE_AT.message}`);
    let cjkTotal = 0;
    let cjkCursor: string | undefined;
    do {
      const page = searchMessages(h.db, cjkCursor === undefined ? { query: '\u65E5\u672C\u8A9E', limit: 200 } : { query: '\u65E5\u672C\u8A9E', limit: 200, cursor: cjkCursor });
      cjkTotal += page.items.length;
      cjkCursor = page.nextCursor ?? undefined;
    } while (cjkCursor !== undefined);
    assert.equal(cjkTotal, CONVERSATIONS, 'one CJK message per conversation, found by walking all cursor pages');

    // deep keyset walk: 5 consecutive cursor pages equal the corresponding offset pages
    const first = searchMessages(h.db, { query: common, limit: 50 });
    let cursor = first.nextCursor ?? undefined;
    const viaCursor = [...first.items];
    for (let i = 0; i < 4 && cursor !== undefined; i++) {
      const page = searchMessages(h.db, { query: common, limit: 50, cursor });
      viaCursor.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    }
    const viaOffset = [...searchMessages(h.db, { query: common, limit: 200 }).items, ...searchMessages(h.db, { query: common, limit: 50, offset: 200 }).items];
    assert.equal(viaCursor.length, 250);
    assert.deepEqual(viaCursor.map((x) => `${x.conversationId}/${x.messageId}`), viaOffset.map((x) => `${x.conversationId}/${x.messageId}`));
    const deep = timed(() => searchMessages(h.db, { query: common, offset: 5000, limit: 20 }));
    assert.equal(deep.value.items.length, 20, 'the common word matches well over 5,000 messages');
    report(t, `deep offset 5000 on the common word: ${deep.value.items.length} hits, ${deep.ms} ms`);
    assert.ok(deep.ms < 1000);

    // ---- index size ---------------------------------------------------------------------------------------------
    const raw = rawTextBytes(h.db);
    const fts = ftsBytes(h.db, 'messages_fts');
    const ratio = fts / raw;
    report(t, `index size: raw message text ${raw} bytes; messages_fts shadow tables ${fts} bytes; ratio ${ratio.toFixed(2)}x (budget: 3x)`);
    report(t, `whole database: ${Number(h.db.prepare('SELECT sum(pgsize) AS n FROM dbstat').get()?.['n'])} bytes (tables + indexes + FTS)`);
    assert.ok(ratio < 3, `index/raw ratio ${ratio.toFixed(2)} exceeds 3x`);
    h.db.close();
  });

  it('keeps the index within 3x the raw text for CJK-heavy content as well (every character is a token)', async (t) => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const rnd = lcg(7);
    const hanzi = Array.from({ length: 3000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const records: ConversationRecord[] = Array.from({ length: 50 }, (_, c) => {
      const id = `cjk-${c}`;
      const msgs = Array.from({ length: 100 }, (_, i) => {
        let text = '';
        for (let k = 0; k < 150; k++) text += hanzi[Math.floor(Math.pow(rnd(), 1.5) * hanzi.length)] ?? '一';
        return msg({ id: `${id}-m${i}`, conversationId: id, text, ordinal: i, createdAt: iso(i) });
      });
      return convo(id, link(msgs));
    });
    const { value: res, ms } = await (async () => {
      const t0 = performance.now();
      const value = await repo.importBatch({ batch: { ...META, contentDigest: 'cjk' }, conversations: records });
      return { value, ms: Math.round(performance.now() - t0) };
    })();
    assert.equal(res.messages.stored, 5000);
    const raw = rawTextBytes(h.db);
    const fts = ftsBytes(h.db, 'messages_fts');
    report(t, `CJK corpus: ${res.messages.stored} messages imported in ${ms} ms; raw ${raw} bytes; index ${fts} bytes; ratio ${(fts / raw).toFixed(2)}x`);
    assert.ok(fts / raw < 3, `CJK index/raw ratio ${(fts / raw).toFixed(2)} exceeds 3x`);
    const probe = records[7]?.messages[40]?.text.slice(20, 23) ?? '';
    const hits = searchMessages(h.db, { query: probe, conversationId: 'cjk-7' });
    assert.ok(hits.items.some((x) => x.messageId === 'cjk-7-m40'), 'a 3-character CJK substring of a known message finds it');
    h.db.close();
  });
});
