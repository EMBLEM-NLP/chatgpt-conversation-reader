/**
 * Tests for src/db/cjk.ts: the pure search-text helpers (normalization, CJK splitting, query parsing, tokenizing the
 * ORIGINAL text with offsets). All data is synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  buildSearchText,
  isCjkChar,
  iterateSearchTokens,
  normalizeForSearch,
  parsePlainQuery,
  prepareRawQuery,
  rawQueryTerms,
  splitCjk,
  tokenizeQuery,
} from '../../src/db/cjk.js';

const SEED = 20261012;

/** true iff the string has no unpaired surrogate (String.prototype.isWellFormed is ES2024, not in this lib target). */
function isWellFormed(s: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 300): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** A pool of "interesting" characters: scripts, combining marks, CJK, astral, punctuation and query syntax. */
const POOL = [
  'a', 'B', 'z', '0', '9', ' ', '\t', '\n', '"', '*', '(', ')', ':', '-', '^', '.', ',', "'", ';',
  'é', 'É', 'ß', 'ø', 'ñ', '\u0301', '\u0308', 'Σ', 'ς', 'σ', 'ή', 'Й', 'й', 'ж',
  '日', '本', '語', 'こ', 'ー', 'ガ', 'ｶ', '한', '국', '𠀀', '𠀁',
  'ﬁ', 'Ａ', '１', '😀', '\u200D', 'ह', '\u093F', '\u094D', '\u3099',
] as const;
const uni = fc.array(fc.constantFrom(...POOL), { maxLength: 24 }).map((a) => a.join(''));

describe('normalizeForSearch', () => {
  it('folds case and diacritics for Latin, Greek and Cyrillic (the tokenizer alone only folds Latin)', () => {
    assert.equal(normalizeForSearch('Café'), 'cafe');
    assert.equal(normalizeForSearch('CAFÉ'), 'cafe');
    assert.equal(normalizeForSearch('Crème Brûlée'), 'creme brulee');
    assert.equal(normalizeForSearch('Αθήνα'), 'αθηνα');
    assert.equal(normalizeForSearch('Йод'), 'иод');
    assert.equal(normalizeForSearch('ПРИВЕТ'), 'привет');
  });

  it('applies NFKC: decomposed input, full-width forms and ligatures collapse to the canonical form', () => {
    assert.equal(normalizeForSearch('Cafe\u0301'), 'cafe');
    assert.equal(normalizeForSearch('ＨＥＬＬＯ １２３'), 'hello 123');
    assert.equal(normalizeForSearch('ﬁsh'), 'fish');
    assert.equal(normalizeForSearch('ﾃｽﾄ'), 'テスト'); // half-width katakana
  });

  it('folds Greek final sigma so a typed sigma matches an upper-case word ending', () => {
    assert.equal(normalizeForSearch('ΟΔΟΣ'), 'οδοσ');
    assert.equal(normalizeForSearch('οδος'), 'οδοσ');
    assert.equal(normalizeForSearch('οδοσ'), 'οδοσ');
  });

  it('does NOT damage scripts whose marks are meaningful: kana voiced marks, Hangul, Devanagari', () => {
    assert.equal(normalizeForSearch('がぎぐ'), 'がぎぐ');
    assert.equal(normalizeForSearch('한국어'), '한국어');
    assert.equal(normalizeForSearch('ह\u093Fन\u094Dद\u0940'), 'ह\u093Fन\u094Dद\u0940');
  });

  it('keeps documented non-goals: "ß" is not expanded to "ss" and "ø" is not folded to "o"', () => {
    assert.equal(normalizeForSearch('Straße'), 'straße');
    assert.notEqual(normalizeForSearch('Straße'), 'strasse');
    assert.equal(normalizeForSearch('Ørsted'), 'ørsted');
  });

  it('leaves ASCII alone except for case (fast path)', () => {
    assert.equal(normalizeForSearch('Hello, World_42!'), 'hello, world_42!');
    assert.equal(normalizeForSearch(''), '');
  });

  it('is idempotent and never throws, for arbitrary mixes of the character pool (property)', () => {
    runProperty(
      fc.property(uni, (s) => {
        const once = normalizeForSearch(s);
        assert.equal(normalizeForSearch(once), once);
      }),
    );
  });
});

describe('splitCjk', () => {
  it('puts every CJK / kana / hangul code point in its own token', () => {
    assert.equal(splitCjk('日本語').replace(/\s+/g, ' ').trim(), '日 本 語');
    assert.equal(splitCjk('これは日本語のテスト').split(/\s+/).filter(Boolean).join(''), 'これは日本語のテスト');
    assert.deepEqual(splitCjk('これは日本語').split(/\s+/).filter(Boolean), ['こ', 'れ', 'は', '日', '本', '語']);
    assert.deepEqual(splitCjk('한국어').split(/\s+/).filter(Boolean), ['한', '국', '어']);
  });

  it('handles astral CJK extension code points as single characters (no surrogate halves)', () => {
    assert.deepEqual(splitCjk('a𠀀𠀁b').split(/\s+/).filter(Boolean), ['a', '𠀀', '𠀁', 'b']);
    assert.ok(isWellFormed(splitCjk('𠀀')));
  });

  it('treats the prolonged sound mark and kana as CJK, but not Latin, digits, emoji or other scripts', () => {
    for (const ch of ['日', 'こ', 'カ', 'ー', '한', '𠀀', '漢']) assert.equal(isCjkChar(ch), true, ch);
    for (const ch of ['a', '1', 'é', 'Σ', 'ж', '😀', ' ', 'ह']) assert.equal(isCjkChar(ch), false, ch);
  });

  it('leaves text without CJK byte-for-byte unchanged and handles the empty string', () => {
    assert.equal(splitCjk('plain ASCII and Привет and Αθήνα'), 'plain ASCII and Привет and Αθήνα');
    assert.equal(splitCjk(''), '');
  });

  it('only inserts whitespace, and isolates each CJK character (property)', () => {
    runProperty(
      fc.property(uni, (s) => {
        const out = splitCjk(s);
        assert.equal(out.replace(/\s/gu, ''), s.replace(/\s/gu, ''));
        for (const m of out.matchAll(/\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul}/gu)) {
          const i = m.index ?? 0;
          if (i > 0) assert.match(out.charAt(i - 1), /\s/u);
          if (i + m[0].length < out.length) assert.match(out.charAt(i + m[0].length), /\s/u);
        }
      }),
    );
  });

  it('buildSearchText = splitCjk(normalizeForSearch(x))', () => {
    assert.equal(buildSearchText('Café 日本'), splitCjk(normalizeForSearch('Café 日本')));
    assert.match(buildSearchText('Café 日本'), /cafe\s+日\s+本/u);
  });
});

describe('tokenizeQuery / parsePlainQuery', () => {
  it('tokenizes with the same transform as indexing', () => {
    assert.deepEqual(tokenizeQuery('Hello, World!'), ['hello', 'world']);
    assert.deepEqual(tokenizeQuery('Café ÉCOLE'), ['cafe', 'ecole']);
    assert.deepEqual(tokenizeQuery('日本語'), ['日', '本', '語']);
    assert.deepEqual(tokenizeQuery('hello世界'), ['hello', '世', '界']);
  });

  it('returns no tokens for empty or punctuation-only input (the caller turns that into INVALID_ARGUMENT)', () => {
    for (const q of ['', '   ', '!!!', '"', '"" ""', '*', '()', ':-^', '😀', '\u0301']) assert.deepEqual(tokenizeQuery(q), [], JSON.stringify(q));
  });

  it('turns query syntax into inert words', () => {
    assert.deepEqual(tokenizeQuery('a OR b'), ['a', 'or', 'b']);
    assert.deepEqual(tokenizeQuery('NEAR(a b)'), ['near', 'a', 'b']);
    assert.deepEqual(tokenizeQuery('col:val -x ^y'), ['col', 'val', 'x', 'y']);
    assert.deepEqual(tokenizeQuery("'; DROP TABLE messages;--"), ['drop', 'table', 'messages']);
  });

  it('recognizes prefix stars only when attached to a word or a closing quote', () => {
    assert.deepEqual(parsePlainQuery('prog*'), [{ tokens: ['prog'], prefix: true }]);
    assert.deepEqual(parsePlainQuery('prog *'), [{ tokens: ['prog'], prefix: false }]);
    assert.deepEqual(parsePlainQuery('prog.*'), [{ tokens: ['prog'], prefix: false }]);
    assert.deepEqual(parsePlainQuery('"two wor"*'), [{ tokens: ['two', 'wor'], prefix: true }]);
    assert.deepEqual(parsePlainQuery('"two wor" *'), [{ tokens: ['two', 'wor'], prefix: false }]);
    assert.deepEqual(parsePlainQuery('a*b'), [
      { tokens: ['a'], prefix: true },
      { tokens: ['b'], prefix: false },
    ]);
  });

  it('builds phrases from quotes and from CJK runs, and AND terms from separate words', () => {
    assert.deepEqual(parsePlainQuery('"quick brown" fox'), [
      { tokens: ['quick', 'brown'], prefix: false },
      { tokens: ['fox'], prefix: false },
    ]);
    assert.deepEqual(parsePlainQuery('日本語'), [{ tokens: ['日', '本', '語'], prefix: false }]);
    assert.deepEqual(parsePlainQuery('日本 語'), [
      { tokens: ['日', '本'], prefix: false },
      { tokens: ['語'], prefix: false },
    ]);
    assert.deepEqual(parsePlainQuery('abc日本'), [{ tokens: ['abc', '日', '本'], prefix: false }]);
    assert.deepEqual(parsePlainQuery('日本*'), [{ tokens: ['日', '本'], prefix: true }]);
  });

  it('treats an unbalanced quote as a separator instead of swallowing the rest', () => {
    assert.deepEqual(parsePlainQuery('alpha "beta gamma'), [
      { tokens: ['alpha'], prefix: false },
      { tokens: ['beta'], prefix: false },
      { tokens: ['gamma'], prefix: false },
    ]);
    assert.deepEqual(parsePlainQuery('"alpha beta" "gamma'), [
      { tokens: ['alpha', 'beta'], prefix: false },
      { tokens: ['gamma'], prefix: false },
    ]);
  });

  it('never throws and never yields an empty token, whatever the input (property)', () => {
    runProperty(
      fc.property(uni, (q) => {
        for (const t of parsePlainQuery(q)) {
          assert.ok(t.tokens.length > 0);
          for (const tok of t.tokens) {
            assert.ok(tok.length > 0);
            assert.doesNotMatch(tok, /[\s"*()]/u);
          }
        }
      }),
    );
  });
});

describe('prepareRawQuery / rawQueryTerms', () => {
  it('keeps operator case and syntax characters, but folds diacritics and splits CJK', () => {
    assert.equal(prepareRawQuery('foo AND bar'), 'foo AND bar');
    assert.equal(prepareRawQuery('NEAR(foo bar, 3)'), 'NEAR(foo bar, 3)');
    assert.equal(prepareRawQuery('Αθήνα OR Café'), 'Αθηνα OR Cafe');
    assert.deepEqual(prepareRawQuery('"日本語"').split(/\s+/).filter(Boolean), ['"', '日', '本', '語', '"']);
  });

  it('does not put a space between a CJK character and an immediately following star', () => {
    assert.match(prepareRawQuery('日本*'), /本\*/u);
    assert.doesNotMatch(prepareRawQuery('日本*'), /本\s+\*/u);
  });

  it('rawQueryTerms drops operators and column filters (used only for snippet highlighting)', () => {
    assert.deepEqual(
      rawQueryTerms('search_text : alpha AND (beta OR "gamma delta") NOT eps*').flatMap((t) => t.tokens),
      ['alpha', 'beta', 'gamma', 'delta', 'eps'],
    );
  });
});

describe('iterateSearchTokens (tokens of the ORIGINAL text, with original offsets)', () => {
  const tokens = (s: string) => [...iterateSearchTokens(s)].map((t) => ({ n: t.norm, s: s.slice(t.start, t.end) }));

  it('reports normalized tokens with spans into the original text', () => {
    assert.deepEqual(tokens('Café au LAIT'), [
      { n: 'cafe', s: 'Café' },
      { n: 'au', s: 'au' },
      { n: 'lait', s: 'LAIT' },
    ]);
    assert.deepEqual(tokens('Cafe\u0301!'), [{ n: 'cafe', s: 'Cafe\u0301' }]); // decomposed accent stays inside its word
  });

  it('splits CJK per character and keeps surrogate pairs whole', () => {
    assert.deepEqual(tokens('x日本y'), [
      { n: 'x', s: 'x' },
      { n: '日', s: '日' },
      { n: '本', s: '本' },
      { n: 'y', s: 'y' },
    ]);
    assert.deepEqual(tokens('a𠀀b'), [
      { n: 'a', s: 'a' },
      { n: '𠀀', s: '𠀀' },
      { n: 'b', s: 'b' },
    ]);
  });

  it('treats emoji and punctuation as separators, and expands compatibility characters', () => {
    assert.deepEqual(tokens('hi 😀 there'), [
      { n: 'hi', s: 'hi' },
      { n: 'there', s: 'there' },
    ]);
    assert.deepEqual(tokens('ﬁsh'), [{ n: 'fish', s: 'ﬁsh' }]);
  });

  it('honours from/to bounds', () => {
    const text = 'alpha beta gamma';
    assert.deepEqual([...iterateSearchTokens(text, 6, 10)].map((t) => t.norm), ['beta']);
  });

  it('spans are in range, ordered and non-overlapping for arbitrary text (property)', () => {
    runProperty(
      fc.property(uni, (s) => {
        let lastEnd = 0;
        for (const t of iterateSearchTokens(s)) {
          assert.ok(t.start >= lastEnd || t.start === lastEnd);
          assert.ok(t.start < t.end && t.end <= s.length);
          assert.ok(t.norm.length > 0);
          lastEnd = t.end;
        }
      }),
    );
  });
});
