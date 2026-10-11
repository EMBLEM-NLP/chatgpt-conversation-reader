/**
 * Adversarial tests for src/db/cjk.ts (independent review, lens: CJK / Unicode search correctness).
 *
 * Two defects are pinned here:
 *  1. `isCjkChar` was defined with Script_Extensions, which also matches CJK PUNCTUATION and symbols (U+3002 "。", U+3001 "、",
 *     U+300C "「", U+30FB "・", U+00B7 "·", ...). Those were reported as one-character TOKENS by the snippet tokenizer and by
 *     the quoted-phrase parser although the index never contains them, so a hit such as "好世" in "你好。世界" got no highlight.
 *  2. The JS tokenizer (what queries and snippets assume) and SQLite's unicode61 tokenizer disagree about characters that
 *     were added to Unicode after SQLite's character tables were generated (currency signs such as "₽" "₿" "₺", emoji
 *     such as "🤖" "🥰", bidi isolates U+2066-2069 ...): SQLite glued them onto the neighbouring word, so "100₽" was indexed
 *     as the single token "100₽" and a search for "100" (or "thanks" in "thanks🤖") found nothing. The differential test
 *     below compares the two tokenizers on every assigned code point.
 * All data is synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { buildSearchText, isCjkChar, iterateSearchTokens, normalizeForSearch, parsePlainQuery, prepareRawQuery, rawQueryTerms, splitCjk, tokenizeQuery } from '../../src/db/cjk.js';
import { openDatabase } from '../../src/db/open.js';

const SEED = 20261014;

describe('isCjkChar: only characters that are tokens, never CJK punctuation', () => {
  const PUNCTUATION_AND_SYMBOLS = ['。', '、', '「', '」', '『', '』', '【', '】', '〈', '〉', '《', '》', '〜', '〰', '・', '·', '゠', '꜀', '〃'];
  const REAL_CJK = ['日', '本', '語', 'こ', 'ん', 'ガ', 'ー', 'ヽ', '々', '〆', '〇', '한', '국', '\u{20000}', '\u{2A700}'];

  it('is false for CJK punctuation / symbols that merely share a script extension with Han, kana or Hangul', () => {
    for (const ch of PUNCTUATION_AND_SYMBOLS) assert.equal(isCjkChar(ch), false, `U+${ch.codePointAt(0)?.toString(16)} must not be a CJK token`);
  });

  it('is true for ideographs, kana, the prolonged sound mark, iteration marks and hangul (negative control)', () => {
    for (const ch of REAL_CJK) assert.equal(isCjkChar(ch), true, `U+${ch.codePointAt(0)?.toString(16)}`);
  });

  it('is false for the empty string, several characters, Latin, digits and emoji', () => {
    for (const s of ['', '日本', 'a', '5', '😀', ' ']) assert.equal(isCjkChar(s), false, JSON.stringify(s));
  });

  it('iterateSearchTokens never reports CJK punctuation as a token and keeps the ideographs around it', () => {
    const norms = [...iterateSearchTokens('你好。世界・テスト「引用」')].map((t) => t.norm);
    assert.deepEqual(norms, ['你', '好', '世', '界', 'テ', 'ス', 'ト', '引', '用']);
  });

  it('quoted phrases and bare words drop CJK punctuation instead of turning it into phrase tokens', () => {
    assert.deepEqual(parsePlainQuery('"你好。世界"'), [{ tokens: ['你', '好', '世', '界'], prefix: false }]);
    assert.deepEqual(tokenizeQuery('好、世'), ['好', '世']);
    assert.deepEqual(parsePlainQuery('"「引用」"*'), [{ tokens: ['引', '用'], prefix: true }]);
  });

  it('splitCjk still isolates every real CJK character when punctuation sits between them', () => {
    const tokens = splitCjk('你好。世界').split(/\s+/).filter((x) => x !== '');
    assert.deepEqual(
      tokens.filter((t) => isCjkChar(t)),
      ['你', '好', '世', '界'],
    );
  });
});

describe('index text is tokenized by SQLite exactly like the JS tokenizer (differential)', () => {
  /** Characters SQLite 3.50 (Unicode tables older than the emoji/currency additions) treats as word characters. */
  const GLUED_BY_SQLITE = ['₽', '₿', '₺', '\u{1F916}', '\u{1F970}', '\u{1FAF6}', '\u{1F3FD}', '⁦', '⁩', '؜', '⏺', '꜀', '֍'];

  function ftsTerms(texts: Map<number, string>): Map<number, string[]> {
    const h = openDatabase(':memory:');
    try {
      const db = h.db;
      db.exec("CREATE VIRTUAL TABLE temp.vocab USING fts5vocab(main, messages_fts, 'instance')");
      const insert = db.prepare('INSERT INTO messages_fts (rowid, search_text) VALUES (?, ?)');
      db.exec('BEGIN');
      for (const [id, text] of texts) insert.run(id, buildSearchText(text));
      db.exec('COMMIT');
      const out = new Map<number, string[]>();
      for (const r of db.prepare('SELECT term, doc FROM temp.vocab ORDER BY doc, offset').iterate()) {
        const doc = Number(r['doc']);
        const list = out.get(doc) ?? [];
        list.push(String(r['term']));
        out.set(doc, list);
      }
      return out;
    } finally {
      h.db.close();
    }
  }

  function jsTerms(text: string): string[] {
    return [...iterateSearchTokens(text)].map((t) => t.norm);
  }

  it('symbols newer than SQLite\'s tables are separators in the index, not glued onto the neighbouring word', () => {
    const texts = new Map<number, string>();
    GLUED_BY_SQLITE.forEach((ch, i) => texts.set(i + 1, `ab${ch}cd`));
    const fts = ftsTerms(texts);
    const failures: string[] = [];
    texts.forEach((text, id) => {
      const got = JSON.stringify(fts.get(id) ?? []);
      const want = JSON.stringify(jsTerms(text));
      if (got !== want) failures.push(`${JSON.stringify(text)}: FTS ${got} vs JS ${want}`);
    });
    assert.deepEqual(failures, []);
  });

  it('agrees on every assigned code point (one text "ab<char>cd" each; unassigned code points are sampled)', () => {
    const texts = new Map<number, string>();
    const NON_TEXT = /^[\p{Co}]$/u;
    const UNASSIGNED = /^\p{Cn}$/u;
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates cannot be stored as UTF-8
      const ch = String.fromCodePoint(cp);
      if (NON_TEXT.test(ch)) continue; // private use: a word character on both sides (137k code points of no interest)
      if (UNASSIGNED.test(ch) && cp % 61 !== 0) continue; // SQLite counts unassigned code points as word characters; sample them
      texts.set(cp, `ab${ch}cd`);
    }
    const fts = ftsTerms(texts);
    const failures: string[] = [];
    for (const [cp, text] of texts) {
      const got = JSON.stringify(fts.get(cp) ?? []);
      const want = JSON.stringify(jsTerms(text));
      if (got !== want && failures.length < 25) failures.push(`U+${cp.toString(16)}: FTS ${got} vs JS ${want}`);
    }
    assert.deepEqual(failures, []);
  });

  it('agrees on random strings built from tricky characters (property)', () => {
    const POOL = [
      'a', 'B', '7', ' ', '-', '.', "'", 'é', 'é', 'Σ', 'ς', 'Й', '日', '本', '。', '・', '「', '·', 'ー',
      '한', '\u{20000}', '₽', '₿', '\u{1F916}', '\u{1F970}', '❤️', '‍', '⁦', '⁩', '؜', 'हि', '²', '㏏', 'ﬁ', 'Ａ',
    ];
    const textArb = fc.array(fc.constantFrom(...POOL), { minLength: 1, maxLength: 25 }).map((a) => a.join(''));
    const samples: string[] = [];
    fc.assert(
      fc.property(textArb, (t) => {
        samples.push(t);
        return true;
      }),
      { seed: SEED, numRuns: 400 },
    );
    const texts = new Map<number, string>();
    samples.forEach((t, i) => texts.set(i + 1, t));
    const fts = ftsTerms(texts);
    const failures: string[] = [];
    texts.forEach((text, id) => {
      const got = JSON.stringify(fts.get(id) ?? []);
      const want = JSON.stringify(jsTerms(text));
      if (got !== want && failures.length < 10) failures.push(`${JSON.stringify(text)}: FTS ${got} vs JS ${want}`);
    });
    assert.deepEqual(failures, []);
  });

  it('buildSearchText leaves ASCII untouched apart from case and never grows unboundedly (no control characters added)', () => {
    assert.equal(buildSearchText('Hello, World 42'), 'hello, world 42');
    assert.equal(buildSearchText(''), '');
    // Only whitespace is added/collapsed: every non-space character of the output comes from the (normalized) input.
    const out = buildSearchText('x₽y \u{1F916}z');
    assert.ok(/^[xyz ]+$/.test(out), JSON.stringify(out));
  });

  it('raw queries get the same treatment: a symbol inside a bareword is a separator, ASCII query syntax is kept', () => {
    assert.ok(!prepareRawQuery('100₽ OR "pay \u{1F916}"').includes('₽'));
    assert.ok(!prepareRawQuery('100₽ OR "pay \u{1F916}"').includes('\u{1F916}'));
    const kept = prepareRawQuery('a* OR (b NOT "c d") NEAR(e f, 3) search_text:g ^h');
    for (const syntax of ['*', 'OR', '(', ')', 'NOT', '"', 'NEAR(', ',', ':', '^']) assert.ok(kept.includes(syntax), `lost ${syntax}`);
  });
});

describe('negative and boundary cases of the remaining helpers', () => {
  it('iterateSearchTokens yields nothing for empty text, an empty or inverted range, and a start beyond the end', () => {
    assert.deepEqual([...iterateSearchTokens('')], []);
    assert.deepEqual([...iterateSearchTokens('alpha beta', 4, 4)], []);
    assert.deepEqual([...iterateSearchTokens('alpha beta', 8, 2)], []);
    assert.deepEqual([...iterateSearchTokens('alpha beta', 99)], []);
    assert.deepEqual([...iterateSearchTokens('alpha beta', -5, 5)].map((t) => t.norm), ['alpha']);
    assert.deepEqual([...iterateSearchTokens('   ...   \n\t')], []);
  });

  it('prepareRawQuery and rawQueryTerms of nothing, or of only operators, are empty', () => {
    assert.equal(prepareRawQuery(''), '');
    assert.deepEqual(rawQueryTerms(''), []);
    assert.deepEqual(rawQueryTerms('AND OR NOT NEAR'), []);
    assert.deepEqual(rawQueryTerms('title_text: ( ) , 5'), [{ tokens: ['5'], prefix: false }]);
  });

  it('normalizeForSearch and buildSearchText are total: lone surrogates, control characters and empty input never throw', () => {
    for (const s of ['', '\uD800', '\uDC00x', 'a\u0000b'.replace('\u0000', ' '), '\u0001\u0002', '\uFFFE\uFFFF', '\u{10FFFF}']) {
      assert.doesNotThrow(() => normalizeForSearch(s), JSON.stringify(s));
      assert.doesNotThrow(() => buildSearchText(s), JSON.stringify(s));
    }
    assert.equal(buildSearchText('\uD800'), ' ', 'a lone surrogate is a separator, never part of the indexed text');
  });
});
