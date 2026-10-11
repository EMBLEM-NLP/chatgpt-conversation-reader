/**
 * Adversarial tests for src/db/search.ts (independent review; lens: SQL correctness, FTS escaping, CJK/diacritic search,
 * ordering and pagination, bounded work). Every test here demonstrated a real defect before the matching fix, or pins a
 * boundary the original suite did not reach. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationRecord } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { openDatabase } from '../../src/db/open.js';
import { FTS_DESIGN } from '../../src/db/schema.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import type { SearchQuery } from '../../src/db/search.js';
import { SNIPPET_MAX_CHARS, SNIPPET_PAGE_SCAN_BUDGET, buildMatchExpression, buildSnippet, compileQuery, conversationSummaryFromRow, rowNumber, rowString, rowStringOrNull, searchConversationTitles, searchMessages } from '../../src/db/search.js';
import { convo, link, msg } from '../helpers/records.js';

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

const MARK_START = '\u0001';
const MARK_END = '\u0002';

interface Spec {
  id: string;
  text: string;
  createdAt?: string | null;
}

/** One conversation with the given messages (flat list, parent chain in order). */
function conv(id: string, specs: Spec[], over: Partial<ConversationRecord> = {}): ConversationRecord {
  let prev: string | null = null;
  const msgs = specs.map((s, i) => {
    const m = msg({ id: s.id, conversationId: id, parentId: prev, text: s.text, ordinal: i, createdAt: s.createdAt === undefined ? null : s.createdAt });
    prev = s.id;
    return m;
  });
  return convo(id, link(msgs), over);
}

async function setup(records: ConversationRecord[], meta: Partial<ImportBatchMeta> = {}): Promise<{ db: DatabaseSync; repo: Repository }> {
  const h = openDatabase(':memory:');
  const repo = new Repository(h.db);
  await repo.importBatch({ batch: { ...META, ...meta }, conversations: records });
  return { db: h.db, repo };
}

const ids = (page: { items: Array<{ messageId: string }> }): string[] => page.items.map((h) => h.messageId);

/** Follow nextCursor until the end; fails the test instead of looping forever. */
function walkByCursor(db: DatabaseSync, q: SearchQuery): string[] {
  const out: string[] = [];
  let next: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = searchMessages(db, next === undefined ? q : { ...q, cursor: next });
    out.push(...ids(page));
    if (page.nextCursor === null || page.nextCursor === undefined) return out;
    next = page.nextCursor;
  }
  throw new Error('cursor walk did not terminate');
}
const isCode = (code: string) => (e: unknown): boolean => e instanceof GcrError && e.code === code;

describe('words next to symbols that SQLite\'s old Unicode tables call letters', () => {
  // [text, plain query that a user would type, label]
  const CASES: Array<[string, string, string]> = [
    ['pay 100₽ today', '100', 'rouble sign glued to a number'],
    ['cost 50₺ only', '50', 'lira sign glued to a number'],
    ['₿itcoin rises', 'itcoin', 'bitcoin sign glued in front of a word'],
    ['thanks\u{1F916} bro', 'thanks', 'robot emoji after a word'],
    ['great\u{1F970}', 'great', 'smiling-hearts emoji after a word'],
    ['love\u{1FAF6}now', 'now', 'heart-hands emoji between words (right word)'],
    ['love\u{1FAF6}now', 'love', 'heart-hands emoji between words (left word)'],
    ['ok\u{1F44D}\u{1F3FD} cool', 'ok', 'emoji with a skin-tone modifier'],
    ['bidi⁦isolated⁩ words', 'isolated', 'bidi isolate marks around a word'],
    ['x؜y', 'x', 'Arabic letter mark between letters'],
  ];

  it('plain queries find the word on either side of the symbol (word, prefix and phrase forms)', async () => {
    const { db } = await setup([conv('c', CASES.map(([text], i) => ({ id: `m${i}`, text })))]);
    const failures: string[] = [];
    CASES.forEach(([text, query, label], i) => {
      for (const q of [query, `${query}*`, `"${query}"`]) {
        const found = ids(searchMessages(db, { query: q, conversationId: 'c' })).includes(`m${i}`);
        if (!found) failures.push(`${label}: ${JSON.stringify(q)} did not find ${JSON.stringify(text)}`);
      }
    });
    assert.deepEqual(failures, []);
  });

  it('a phrase spans the symbol, and the symbol itself is never a search term', async () => {
    const { db } = await setup([conv('c', [{ id: 'a', text: 'pay 100₽ today' }, { id: 'b', text: 'pay today 100' }])]);
    assert.deepEqual(ids(searchMessages(db, { query: '"pay 100"' })), ['a']);
    assert.deepEqual(ids(searchMessages(db, { query: '"100 today"' })), ['a']);
    assert.throws(() => searchMessages(db, { query: '₽' }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: '\u{1F916}\u{1F970}' }), isCode('INVALID_ARGUMENT'));
  });

  it('raw mode treats the symbol as a separator too', async () => {
    const { db } = await setup([conv('c', [{ id: 'a', text: 'pay 100₽ today' }])]);
    assert.deepEqual(ids(searchMessages(db, { query: '100₽', mode: 'raw' })), ['a']);
    assert.deepEqual(ids(searchMessages(db, { query: 'pay AND 100', mode: 'raw' })), ['a']);
  });

  it('title search and the title filter of listConversations behave the same way', async () => {
    const { db, repo } = await setup([conv('c1', [{ id: 'a', text: 'x' }], { title: 'Plan 100₽\u{1F916}' }), conv('c2', [{ id: 'b', text: 'y' }], { title: 'Other' })]);
    assert.deepEqual(searchConversationTitles(db, { query: '100' }).items.map((h) => h.conversationId), ['c1']);
    assert.deepEqual(searchConversationTitles(db, { query: 'plan' }).items.map((h) => h.conversationId), ['c1']);
    assert.deepEqual(repo.listConversations({ titleQuery: '100' }).items.map((c) => c.conversationId), ['c1']);
  });

  it('the index generation marker is current for new databases, and a rebuild brings an old marker up to date', async () => {
    const { db, repo } = await setup([conv('c', [{ id: 'a', text: 'pay 100\u20BD' }])]);
    const marker = (): unknown => db.prepare("SELECT value FROM gcr_meta WHERE key = 'fts_design'").get()?.['value'];
    assert.equal(marker(), FTS_DESIGN);
    db.prepare("UPDATE gcr_meta SET value = 'contentless-unicode61-v1' WHERE key = 'fts_design'").run();
    repo.rebuildSearchIndex();
    assert.equal(marker(), FTS_DESIGN);
    assert.notEqual(FTS_DESIGN, 'contentless-unicode61-v1', 'the representation changed, so the generation must differ from v1');
  });

  it('a rebuilt index tokenizes exactly like the import did', async () => {
    const { db, repo } = await setup([conv('c', CASES.map(([text], i) => ({ id: `m${i}`, text })))]);
    const probe = (): string[] => CASES.map(([, q]) => ids(searchMessages(db, { query: q, conversationId: 'c' })).join(','));
    const before = probe();
    repo.rebuildSearchIndex();
    assert.deepEqual(probe(), before);
  });
});

describe('keyset cursors survive the longest legal identifiers', () => {
  it('a cursor issued for 512-character CJK ids is accepted on the next page and the walk equals the offset walk', async () => {
    const cid = '会'.repeat(500);
    const account = '語'.repeat(500);
    const mids = ['a', 'b', 'c', 'd'].map((x) => '文'.repeat(480) + x);
    const rec = conv(
      cid,
      mids.map((id, i) => ({ id, text: 'needle word', createdAt: `2025-01-01T00:00:0${i}.000Z` })),
      { accountLabel: account },
    );
    const { db } = await setup([rec], { accountLabel: account });
    const first = searchMessages(db, { query: 'needle', limit: 1 });
    assert.ok(first.nextCursor, 'a second page exists');
    assert.ok(first.nextCursor.length > 4096, `the scenario must exceed the old 4096-character cursor limit (was ${first.nextCursor.length})`);

    const byCursor = walkByCursor(db, { query: 'needle', limit: 1 });
    const byOffset: string[] = [];
    for (let offset = 0; offset < 4; offset++) byOffset.push(...ids(searchMessages(db, { query: 'needle', limit: 1, offset })));
    assert.deepEqual(byCursor, byOffset);
    assert.equal(new Set(byCursor).size, 4);
  });

  it('cursors of every non-string type, and the empty string, are INVALID_ARGUMENT (never a TypeError)', async () => {
    const { db } = await setup([conv('c', [{ id: 'a', text: 'alpha' }, { id: 'b', text: 'alpha' }])]);
    for (const bad of [123, true, {}, [], null, ''] as unknown[]) {
      assert.throws(() => searchMessages(db, { query: 'alpha', cursor: bad as string }), isCode('INVALID_ARGUMENT'), JSON.stringify(bad));
    }
  });
});

describe('created_at filters and tie ordering compare INSTANTS, not strings', () => {
  // "...:00Z" (whole second) and "...:00.500Z" (milliseconds) are both legal spellings (validate.ts); as strings
  // "00.500Z" < "00Z" because "." < "Z", although 00.500 is LATER than 00.000.
  const T = (s: string): string => `2025-01-01T00:00:${s}Z`;
  const SPECS: Spec[] = [
    { id: 'half', text: 'needle', createdAt: T('00.500') },
    { id: 'whole0', text: 'needle', createdAt: T('00') },
    { id: 'half1', text: 'needle', createdAt: T('01.500') },
    { id: 'whole1', text: 'needle', createdAt: T('01') },
    { id: 'none', text: 'needle', createdAt: null },
  ];

  it('createdAfter is inclusive and createdBefore exclusive for every mix of spellings', async () => {
    const { db } = await setup([conv('c', SPECS)]);
    const at = (opts: { createdAfter?: string; createdBefore?: string }): string[] => ids(searchMessages(db, { query: 'needle', ...opts })).sort();
    assert.deepEqual(at({ createdAfter: T('00') }), ['half', 'half1', 'whole0', 'whole1']);
    assert.deepEqual(at({ createdAfter: T('00.000') }), ['half', 'half1', 'whole0', 'whole1']);
    assert.deepEqual(at({ createdAfter: T('00.500') }), ['half', 'half1', 'whole1']);
    assert.deepEqual(at({ createdAfter: T('01') }), ['half1', 'whole1']);
    assert.deepEqual(at({ createdAfter: T('01.000') }), ['half1', 'whole1']);
    assert.deepEqual(at({ createdBefore: T('01') }), ['half', 'whole0']);
    assert.deepEqual(at({ createdBefore: T('01.000') }), ['half', 'whole0']);
    assert.deepEqual(at({ createdBefore: T('00.500') }), ['whole0']);
    assert.deepEqual(at({ createdBefore: T('00') }), []);
    assert.deepEqual(at({ createdAfter: T('00.500'), createdBefore: T('01.500') }), ['half', 'whole1']);
    assert.deepEqual(at({ createdAfter: T('02') }), []);
  });

  it('equal-rank hits are ordered by instant (NULL last), identically by offset and by cursor', async () => {
    const { db } = await setup([conv('c', SPECS)]);
    const want = ['whole0', 'half', 'whole1', 'half1', 'none'];
    assert.deepEqual(ids(searchMessages(db, { query: 'needle' })), want);
    const byOffset: string[] = [];
    for (let offset = 0; offset < want.length; offset++) byOffset.push(...ids(searchMessages(db, { query: 'needle', limit: 1, offset })));
    assert.deepEqual(byOffset, want);
    assert.deepEqual(walkByCursor(db, { query: 'needle', limit: 2 }), want);
  });

  it('two spellings of the same instant tie and fall through to conversation_id / message_id (total order)', async () => {
    const { db } = await setup([
      conv('c1', [{ id: 'm', text: 'needle', createdAt: T('05') }]),
      conv('c2', [{ id: 'm', text: 'needle', createdAt: T('05.000') }]),
    ]);
    assert.deepEqual(searchMessages(db, { query: 'needle' }).items.map((h) => h.conversationId), ['c1', 'c2']);
  });

  it('bounds that are not strict ISO timestamps (or that try SQL) stay INVALID_ARGUMENT', async () => {
    const { db } = await setup([conv('c', SPECS)]);
    for (const bad of ['2025-01-01', "2025-01-01T00:00:00Z' OR 1=1 --", '2025-01-01T00:00:00+01:00', '2025-13-01T00:00:00Z', '']) {
      assert.throws(() => searchMessages(db, { query: 'needle', createdAfter: bad }), isCode('INVALID_ARGUMENT'), bad);
      assert.throws(() => searchMessages(db, { query: 'needle', createdBefore: bad }), isCode('INVALID_ARGUMENT'), bad);
    }
  });
});

describe('snippets and CJK punctuation', () => {
  it('a hit across an ideographic full stop is highlighted as one region (the punctuation is not a token)', async () => {
    const { db } = await setup([conv('c', [{ id: 'a', text: '你好。世界' }])]);
    const hit = searchMessages(db, { query: '好世' }).items[0];
    assert.equal(hit?.snippet, `你${MARK_START}好。世${MARK_END}界`);
    const word = searchMessages(db, { query: '世界' }).items[0];
    assert.equal(word?.snippet, `你好。${MARK_START}世界${MARK_END}`);
  });

  it('buildSnippet agrees: corner brackets and the katakana middle dot do not break a CJK phrase', () => {
    const s = buildSnippet('「日本」・テスト', [{ tokens: ['本', 'テ'], prefix: false }]);
    assert.ok(s.includes(`${MARK_START}本」・テ${MARK_END}`), JSON.stringify(s));
  });
});

describe('bounded work per page: snippet scanning has a page-level budget', () => {
  it('100 hits on huge messages cannot make one page scan 100 x 150k characters', async () => {
    const filler = 'lorem ipsum dolor sit amet ';
    const body = filler.repeat(Math.ceil(150_000 / filler.length)).slice(0, 150_000);
    const specs: Spec[] = [];
    for (let i = 0; i < 100; i++) specs.push({ id: `m${String(i).padStart(3, '0')}`, text: `${body} zzzneedle`, createdAt: `2025-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` });
    const { db } = await setup([conv('c', specs)]);
    const t0 = performance.now();
    const page = searchMessages(db, { query: 'zzzneedle', limit: 100 });
    const elapsed = performance.now() - t0;
    assert.equal(page.items.length, 100, 'every hit is still returned');
    const highlighted = page.items.filter((h) => h.snippet.includes(MARK_START)).length;
    assert.ok(highlighted >= 1, 'the first hits still get a highlighted snippet');
    // Independent of the constant's value on purpose: a page may spend at most ~5M characters on finding highlights.
    assert.ok(SNIPPET_PAGE_SCAN_BUDGET <= 5_000_000, 'the page budget itself must stay small enough to bound a page well under a second');
    assert.ok(highlighted * 150_000 <= 5_000_000 + 150_000, `scan budget exceeded: ${highlighted} highlighted snippets of 150k characters`);
    assert.ok(highlighted * 150_000 <= SNIPPET_PAGE_SCAN_BUDGET + 150_000, 'and it never exceeds the declared budget');
    for (const h of page.items) {
      assert.ok(h.snippet.length > 0 && h.snippet.length <= SNIPPET_MAX_CHARS, 'every hit has a bounded, non-empty snippet');
      if (!h.snippet.includes(MARK_START)) assert.ok(h.snippet.startsWith('lorem'), 'beyond the budget the snippet falls back to the start of the text');
    }
    assert.ok(elapsed < 5000, `one page of hits took ${Math.round(elapsed)} ms`);
  });
});

describe('plain search agrees with an independent oracle (differential property, both directions)', () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const WORDS = ['alpha', 'beta', 'gamma', 'Café', 'cafe', 'Naïve', 'Привет', 'Αθήνα', 'ΟΔΟΣ', '日本語', '東京', '한국어', 'テスト', '100', 'x', 'ab', 'abc', 'abcd', 'ﬁsh', 'ＨＥＬＬＯ', 'don\'t'];
  const SEPARATORS = [' ', ' ', ' ', ', ', '₽', '\u{1F916}', '。', ' - ', '\n', '(', '"', '⁦'];

  interface Term {
    tokens: string[];
    prefix: boolean;
  }

  function termMatches(doc: readonly string[], term: Term): boolean {
    const n = term.tokens.length;
    for (let i = 0; i + n <= doc.length; i++) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        const have = doc[i + k] ?? '';
        const want = term.tokens[k] ?? '';
        ok = k === n - 1 && term.prefix ? have.startsWith(want) : have === want;
      }
      if (ok) return true;
    }
    return false;
  }

  for (const seed of [7, 8, 20261014]) {
    it(`every plain query returns exactly the messages whose tokens satisfy it (seed ${seed})`, async () => {
      const { iterateSearchTokens, parsePlainQuery } = await import('../../src/db/cjk.js');
      const rnd = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const texts: string[] = [];
      for (let d = 0; d < 80; d++) {
        const n = 3 + Math.floor(rnd() * 8);
        let t = '';
        for (let i = 0; i < n; i++) t += pick(WORDS) + pick(SEPARATORS);
        texts.push(t);
      }
      const { db } = await setup([conv('c', texts.map((text, i) => ({ id: `m${String(i).padStart(3, '0')}`, text })))]);
      const docs = texts.map((t) => [...iterateSearchTokens(t)].map((x) => x.norm));

      const failures: string[] = [];
      for (let iteration = 0; iteration < 300; iteration++) {
        const terms: Term[] = [];
        const termCount = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < termCount; k++) {
          const doc = pick(docs.filter((d) => d.length > 0));
          const run = 1 + Math.floor(rnd() * 3);
          const start = Math.floor(rnd() * doc.length);
          const tokens = doc.slice(start, start + run);
          if (rnd() < 0.15) tokens.push(pick(WORDS).toLowerCase().replace(/[^a-z]/g, '') || 'zzz'); // sometimes break the phrase
          const prefix = rnd() < 0.3;
          if (prefix && tokens.length > 0) {
            // cut the last token (by code points) to make a real prefix query
            const last = [...(tokens[tokens.length - 1] ?? '')];
            tokens[tokens.length - 1] = last.slice(0, 1 + Math.floor(rnd() * last.length)).join('');
          }
          if (tokens.length > 0 && tokens.every((t) => t !== '')) terms.push({ tokens, prefix });
        }
        if (terms.length === 0) continue;
        let query = terms.map((t) => (t.tokens.length === 1 ? t.tokens[0] : `"${t.tokens.join(' ')}"`) + (t.prefix ? '*' : '')).join(' ');
        if (rnd() < 0.4) query = query.toUpperCase();

        const expected = docs.flatMap((d, i) => (terms.every((t) => termMatches(d, t)) ? [`m${String(i).padStart(3, '0')}`] : []));
        const actual = ids(searchMessages(db, { query, limit: 200 })).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${JSON.stringify(query)}: expected ${expected.length} hits, got ${actual.length}`);
        const parsed = parsePlainQuery(query);
        if (JSON.stringify(parsed) !== JSON.stringify(terms)) failures.push(`parse mismatch for ${JSON.stringify(query)}: ${JSON.stringify(parsed)}`);
        if (failures.length >= 10) break;
      }
      assert.deepEqual(failures, []);
    });
  }
});

describe('direct negative tests for the exported helpers', () => {
  it('compileQuery rejects non-strings, NUL bytes, oversized input, unknown modes and empty raw queries', () => {
    for (const q of [undefined, null, 5, {}, ['a']] as unknown[]) assert.throws(() => compileQuery(q, 'plain'), isCode('INVALID_ARGUMENT'));
    assert.throws(() => compileQuery('a\0b', 'plain'), isCode('INVALID_ARGUMENT'));
    assert.throws(() => compileQuery('a'.repeat(2001), 'plain'), isCode('INVALID_ARGUMENT'));
    assert.throws(() => compileQuery('a', 'fuzzy'), isCode('INVALID_ARGUMENT'));
    assert.throws(() => compileQuery('   ', 'raw'), isCode('INVALID_ARGUMENT'));
    assert.throws(() => compileQuery('...', 'plain'), isCode('INVALID_ARGUMENT'));
    assert.deepEqual(compileQuery('Hello World*', undefined).match, '"hello" "world"*');
  });

  it('buildMatchExpression of no terms is empty, and a hostile token can never leave its quotes', () => {
    assert.equal(buildMatchExpression([]), '');
    const expr = buildMatchExpression([{ tokens: ['a"b', 'x") OR (y'], prefix: true }]);
    assert.equal(expr, '"a""b x"") OR (y"*');
  });

  it('buildSnippet: empty text, no terms, absurd budgets and unmatched terms never throw and stay within the budget', () => {
    assert.equal(buildSnippet('', [{ tokens: ['a'], prefix: false }]), '');
    assert.equal(buildSnippet('hello world', []), 'hello world');
    for (const budget of [-5, 0, 1, 7, 8, 9, 1000]) {
      const out = buildSnippet('x '.repeat(400) + 'needle', [{ tokens: ['needle'], prefix: false }], budget);
      assert.ok(out.length <= Math.max(8, budget), `budget ${budget} gave ${out.length}`);
    }
    assert.equal(buildSnippet('hello world', [{ tokens: ['absent'], prefix: false }]), 'hello world');
  });

  it('row helpers tolerate NULL, missing columns, bigint and wrong types without throwing', () => {
    const row = { s: 'x', n: null, i: 7, b: 9n, t: 'text' } as unknown as Record<string, never>;
    assert.equal(rowString(row, 's'), 'x');
    assert.equal(rowString(row, 'n'), '');
    assert.equal(rowString(row, 'missing'), '');
    assert.equal(rowString(row, 'i'), '7');
    assert.equal(rowStringOrNull(row, 'n'), null);
    assert.equal(rowStringOrNull(row, 'missing'), null);
    assert.equal(rowStringOrNull(row, 'i'), '7');
    assert.equal(rowNumber(row, 'i'), 7);
    assert.equal(rowNumber(row, 'b'), 9);
    assert.equal(rowNumber(row, 't'), 0);
    assert.equal(rowNumber(row, 'n'), 0);
    const summary = conversationSummaryFromRow({} as Record<string, never>);
    assert.equal(summary.title, null);
    assert.equal(summary.messageCount, 0);
    assert.equal(summary.conversationId, '');
  });
});
