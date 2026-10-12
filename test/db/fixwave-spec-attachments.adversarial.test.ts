/**
 * SPEC-04 adversarial review, storage layer: a stored attachment list longer than the per-message scan cap (5,000) was cut
 * SILENTLY: the ChatGPT importer accepts up to 50,000 attachments per message (`maxPartsPerMessage`), so attachment 5,001 and
 * beyond of such a message were stored, shown by `get`, and never findable, with no warning. FR-09 ("no false claim of
 * completeness") forbids that: the search result must say how many messages were cut. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { searchAttachments } from '../../src/db/search.js';
import type { AttachmentRef, ConversationRecord } from '../../src/domain/types.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'export.zip',
  contentDigest: 'att-adv-1',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

const att = (i: number, name: string = `bulk-${i}.txt`): AttachmentRef => ({ id: `file-${i}`, name, mimeType: 'text/plain', sizeBytes: 1, assetPointer: null, presentInExportAs: null });

async function dbWith(counts: number[]): Promise<DatabaseSync> {
  const h = openDatabase(':memory:');
  const repo = new Repository(h.db);
  const msgs = counts.map((n, i) => msg({ id: `m${i}`, conversationId: 'c1', parentId: i === 0 ? null : `m${i - 1}`, createdAt: iso(i + 1), attachments: Array.from({ length: n }, (_, k) => att(k)), ordinal: i }));
  const c: ConversationRecord = convo('c1', link(msgs), { currentNodeId: `m${counts.length - 1}` });
  await repo.importBatch({ batch: META, conversations: [c] });
  return h.db;
}

describe('SPEC-04 review: an attachment list longer than the scan cap is reported, not silently cut', () => {
  it('5,000 attachments are all searched and nothing is reported as cut', async () => {
    const db = await dbWith([5000]);
    const r = searchAttachments(db, { query: 'bulk-4999' });
    assert.equal(r.page.items.length, 1);
    assert.equal(r.truncatedMessages, 0);
  });

  it('5,001 attachments: the first 5,000 are searched, the message is counted as cut', async () => {
    const db = await dbWith([5001]);
    const first = searchAttachments(db, { query: 'bulk-4999' });
    assert.equal(first.page.items.length, 1);
    assert.equal(first.truncatedMessages, 1, 'the message whose list was cut is counted');
    const beyond = searchAttachments(db, { query: 'bulk-5000' });
    assert.equal(beyond.page.items.length, 0, 'the cap itself is unchanged (bounded work per message)');
    assert.equal(beyond.truncatedMessages, 1, 'an empty answer must say that part of a list was not looked at');
  });

  it('counts messages, not attachments, and ignores short lists', async () => {
    const db = await dbWith([3, 6000, 5001, 5000]);
    const r = searchAttachments(db, { query: 'bulk', limit: 1 });
    // The scan stops at the first full page, so only a lower bound is known when more hits exist...
    assert.ok(r.truncatedMessages <= 2);
    // ...and it is exact when the scan reads everything.
    const all = searchAttachments(db, { query: 'bulk-4999', limit: 200 });
    assert.equal(all.page.items.length, 3, 'index 4999 exists in the 6000, 5001 and 5000 long lists');
    assert.equal(all.page.nextOffset, null);
    assert.equal(all.truncatedMessages, 2, 'the 6000 and the 5001 long lists were cut; 5000 and 3 were read whole');
  });
});

describe('SPEC-04 review: a file is always found by its own name (matching and indexing fold identically)', () => {
  // Pieces that stress the folding: quotes, prefix stars, SQL / LIKE metacharacters, accents in both forms, width, ligatures, CJK,
  // Hangul, Cyrillic, Greek, RTL, Thai, emoji, ZWJ sequences, combining runs, odd spaces, dotted capital I, sharp s.
  const PIECES = [
    'report', 'Report', 'REPORT', 'caf\u00e9', 'cafe\u0301', '\uff21\uff22\uff23', '\ufb01nal', '\u6771\u4eac', '\u65e5\u672c\u8a9e', '\ud55c\uad6d\uc5b4',
    '\u041e\u0442\u0447\u0451\u0442', '\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac', '\u0645\u0644\u0641', '\u0e44\u0e17\u0e22', '\ud83d\ude00', '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67', 'e\u0301\u0301\u0301\u0301',
    '\u00a0', '\u3000', '\u0130stanbul', 'Stra\u00dfe', '100%', 'a_b', '50%_off', 'back\\slash', "o'neil", '"quoted"', '"', '*', 'star*', '(paren)', '[x]', '-dash-', '.dot.', 'v2.3.1', 'file (1)', 'a;b', "'; DROP TABLE messages; --",
  ];
  const EXTS = ['.txt', '.PDF', '.tar.gz', '', '.\u6587\u4ef6'];
  function rng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 0x100000000;
    };
  }

  it('300 generated names: querying the whole name finds the attachment (or the query is refused as symbols only)', async () => {
    const r = rng(20261012);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const names = Array.from({ length: 300 }, () => {
      const parts = Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(PIECES));
      return parts.join(pick([' ', '-', '_', '.', ''])) + pick(EXTS);
    });
    const unique = [...new Set(names)];
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const msgs = unique.map((n, i) => msg({ id: `m${i}`, conversationId: 'c1', parentId: i === 0 ? null : `m${i - 1}`, createdAt: iso(i + 1), attachments: [att(i, n)], ordinal: i }));
    await repo.importBatch({ batch: META, conversations: [convo('c1', link(msgs), { currentNodeId: `m${msgs.length - 1}` })] });
    let found = 0;
    let refused = 0;
    const missing: string[] = [];
    for (let i = 0; i < unique.length; i++) {
      const name = unique[i] as string;
      if (name.length > 1000) continue;
      let hits;
      try {
        hits = searchAttachments(h.db, { query: name, limit: 200 }).page.items;
      } catch (e) {
        // Only the documented refusal is acceptable: nothing in the name is indexed.
        assert.ok(e instanceof Error && /only symbols or punctuation|query is empty/.test(e.message), `unexpected error for ${JSON.stringify(name)}: ${String(e)}`);
        refused++;
        continue;
      }
      if (hits.some((x) => x.messageId === `m${i}`)) found++;
      else missing.push(name);
    }
    assert.deepEqual(missing, [], 'every attachment must be found by its own name');
    assert.ok(found > 250, `most generated names are searchable (found ${found}, refused ${refused})`);
  });
});

describe('SPEC-04 review: paging is stable when every sort key ties', () => {
  it('600 messages at one instant (and some undated), three identical names each, in three conversations: pages of 7 and of 200 give the same sequence', async () => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const convs: ConversationRecord[] = ['ca', 'cb', 'cc'].map((cid, ci) => {
      const msgs = Array.from({ length: 200 }, (_, i) =>
        msg({
          id: `m${i}`, // the same message ids in every conversation
          conversationId: cid,
          parentId: i === 0 ? null : `m${i - 1}`,
          createdAt: i % 10 === 0 ? null : iso(1), // identical instants, and undated ones
          attachments: [0, 1, 2].map((k) => ({ id: `f-${ci}-${i}-${k}`, name: 'dup.txt', mimeType: 'text/plain', sizeBytes: 1, assetPointer: null, presentInExportAs: null })),
          ordinal: i,
        }),
      );
      return convo(cid, link(msgs), { currentNodeId: 'm199' });
    });
    await repo.importBatch({ batch: META, conversations: convs });
    const key = (x: { conversationId: string; messageId: string; attachmentIndex: number }): string => `${x.conversationId}/${x.messageId}#${x.attachmentIndex}`;
    const walk = (size: number): string[] => {
      const seen: string[] = [];
      let offset = 0;
      for (let guard = 0; guard < 2000; guard++) {
        const { page } = searchAttachments(h.db, { query: 'dup', limit: size, offset });
        seen.push(...page.items.map(key));
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      return seen;
    };
    const big = walk(200);
    assert.equal(big.length, 1800);
    assert.equal(new Set(big).size, 1800, 'no attachment is repeated');
    assert.deepEqual(walk(7), big, 'pages of 7 give the same sequence as pages of 200');
    // Dated messages come first, undated last, as documented.
    const undated = (k: string): boolean => Number(/\/m(\d+)#/.exec(k)?.[1]) % 10 === 0;
    const firstUndated = big.findIndex(undated);
    assert.equal(firstUndated, 1620, 'the 1,620 attachments of the dated messages come first');
    assert.ok(big.slice(firstUndated).every(undated), 'and then only undated ones');
  });
});
