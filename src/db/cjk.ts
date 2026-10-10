/**
 * Pure helpers for the FTS "search_text" representation (ARCHITECTURE section 3, section 6).
 *
 * WHY the stock FTS5 `unicode61` tokenizer is not enough on its own (all verified against the SQLite 3.50 build that
 * ships with Node 22):
 *
 *  1. CJK has no spaces. unicode61 only splits on characters that are not letters/digits, and every ideograph, kana and
 *     hangul syllable IS a letter, so "これは日本語のテスト" becomes ONE token. A query for "日本語" would therefore never
 *     match inside it. We insert spaces around every CJK code point (`splitCjk`) so each one is its own token, and
 *     turn a CJK substring query into a PHRASE of those tokens (adjacent, in order) at query time.
 *  2. Its `remove_diacritics` option only folds LATIN letters. Greek "ή" and Cyrillic "й" keep their accents, so
 *     "αθηνα" would not find "Αθήνα". `normalizeForSearch` therefore folds combining diacritics itself (NFD, drop the
 *     combining-mark blocks, NFC) for every script.
 *  3. It has no compatibility normalization: full-width Latin, ligatures and half-width katakana would be separate
 *     terms from their canonical forms. We apply NFKC first, to the indexed text AND to the query, with the SAME function.
 *  4. By default it treats combining marks of Indic scripts (Mn/Mc) as separators, which tears Hindi/Tamil/... words
 *     apart; schema.ts configures `categories 'L* N* Co Mn Mc'` and the token-character class below mirrors that.
 *
 * Everything here is deterministic and side-effect free (the only module state is a bounded memoization cache).
 * Imported text and queries are untrusted data: these helpers never throw on odd input and never interpret it.
 */

// ---------------------------------------------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------------------------------------------

/**
 * Scripts written without spaces between words. `Script_Extensions` (not `Script`) is used so that the prolonged
 * sound mark "ー" (U+30FC, script Common but extension Hira/Kana) and similar shared marks are covered as well.
 * Han includes every CJK Unified Ideographs block, extensions A-I (astral planes) and compatibility ideographs.
 * Thai, Lao, Khmer and Myanmar are NOT split (documented limitation).
 */
const CJK_CLASS = String.raw`\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}`;

/** Characters unicode61 (as configured in schema.ts) treats as part of a token. */
const TOKEN_CLASS = String.raw`\p{L}\p{N}\p{Co}\p{Mn}\p{Mc}`;

const CJK_ONE = new RegExp(`^[${CJK_CLASS}]$`, 'u');
const CJK_GLOBAL = new RegExp(`[${CJK_CLASS}]`, 'gu');
const TOKEN_ONE = new RegExp(`^[${TOKEN_CLASS}]$`, 'u');
/** One CJK code point, or a maximal run of non-CJK token characters. */
const TOKEN_PIECES = new RegExp(`[${CJK_CLASS}]|(?:(?![${CJK_CLASS}])[${TOKEN_CLASS}])+`, 'gu');
/** A word (maximal run of token characters, CJK included) optionally followed by an immediate `*`. */
const WORD_WITH_STAR = new RegExp(`([${TOKEN_CLASS}]+)(\\*)?`, 'gu');

/**
 * Marks removed by normalization: the combining diacritical blocks (generic, extended, supplement, for-symbols, half
 * marks) plus VARIATION SELECTORS (U+FE00-FE0F, U+180B-180D, U+E0100-E01EF). Variation selectors matter because the
 * tokenizer counts category Mn as a token character: the heart emoji sequence U+2764 U+FE0F would otherwise index a junk
 * token consisting of U+FE0F alone. Deliberately NOT all of \p{M}: Indic vowel signs etc. must stay inside their word.
 */
const DIACRITICS_GLOBAL = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F\u180B-\u180D\u{E0100}-\u{E01EF}]/gu;
const ASCII_ONLY = /^[\x00-\x7F]*$/;

/** true iff `ch` (exactly one code point) is Han/Hiragana/Katakana/Hangul, i.e. gets its own token. */
export function isCjkChar(ch: string): boolean {
  return CJK_ONE.test(ch);
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------------------------

function foldText(s: string, lowerCase: boolean): string {
  // Fast path: pure ASCII needs neither NFKC nor diacritic folding (the overwhelmingly common case).
  if (ASCII_ONLY.test(s)) return lowerCase ? s.toLowerCase() : s;
  let t = s.normalize('NFKC');
  if (lowerCase) t = t.toLowerCase();
  // Decompose, drop combining diacritics, recompose. Recomposition (NFC) matters: Japanese voiced marks (U+3099/309A),
  // Hangul jamo and Indic vowel signs are NOT in the stripped blocks and must come back as the composed forms the
  // indexed text and the query both end up with.
  t = t.normalize('NFD').replace(DIACRITICS_GLOBAL, '').normalize('NFC');
  // Greek final sigma: toLowerCase() yields "ς" at a word end but "σ" elsewhere; fold both to "σ" so a typed "σασ"
  // finds "ΣΑΣ" (SQLite's own case folding is not relied on for this).
  return t.replace(/ς/g, 'σ');
}

/**
 * The single normalization applied to indexed text AND to queries: NFKC, lower-case, combining diacritics removed
 * ("Café" -> "cafe", "Αθήνα" -> "αθηνα", "Привет" stays, "й" -> "и"). It does NOT fold ligatures such as "ß" -> "ss"
 * ("strasse" does not find "Straße"; accepted). Diacritic folding is done here (not only by the tokenizer) because the
 * tokenizer's own folding covers Latin only.
 */
export function normalizeForSearch(s: string): string {
  return foldText(s, true);
}

/**
 * Put a space on both sides of every CJK/Hiragana/Katakana/Hangul code point (astral extensions included, handled as
 * whole code points thanks to the `u` flag) so that FTS5 sees each one as its own token. Only inserts spaces.
 */
export function splitCjk(s: string): string {
  return s.replace(CJK_GLOBAL, ' $& ');
}

/** The exact string stored in the FTS index for a message body or a title. Original text is never modified in the tables. */
export function buildSearchText(s: string): string {
  return splitCjk(normalizeForSearch(s));
}

// ---------------------------------------------------------------------------------------------------------------
// Plain-mode query parsing
// ---------------------------------------------------------------------------------------------------------------

/**
 * One unit of a plain-mode query. `tokens.length > 1` means a PHRASE (tokens must be adjacent and in order); that arises
 * from a double-quoted phrase or from a CJK substring (an unbroken run of CJK characters, optionally with attached
 * Latin/digits). `prefix` applies to the LAST token (`foo*`, `"two wor"*`).
 */
export interface QueryTerm {
  tokens: string[];
  prefix: boolean;
}

/** Split an ALREADY normalized fragment into tokens: each CJK code point alone, other token characters as maximal runs. */
function tokensOfNormalized(s: string): string[] {
  return s.match(TOKEN_PIECES) ?? [];
}

/**
 * Parse a user query for plain mode. The grammar is deliberately tiny so nothing a user types can become FTS5 syntax:
 *  - words are maximal runs of letters/digits/marks; everything else (punctuation, operators, parentheses, colons,
 *    dashes, SQL fragments) is just a separator;
 *  - "double quoted" text is one phrase; an UNBALANCED quote is treated as a separator;
 *  - a `*` immediately after a word or a closing quote marks a prefix search;
 *  - AND/OR/NOT/NEAR are ordinary words here (they get quoted by the caller);
 *  - a word that contains CJK becomes a phrase of its tokens, so "日本語" means the three characters ADJACENT.
 * The query is normalized with `normalizeForSearch`, i.e. exactly like the indexed text.
 */
export function parsePlainQuery(q: string): QueryTerm[] {
  const normalized = normalizeForSearch(q);
  const parts = normalized.split('"');
  // parts[odd] is inside quotes only if a closing quote exists for it.
  const lastQuoted = 2 * Math.floor((parts.length - 1) / 2) - 1;
  const terms: QueryTerm[] = [];
  let consumeLeadingStar = false;

  for (let i = 0; i < parts.length; i++) {
    let part = parts[i] ?? '';
    const inside = i % 2 === 1 && i <= lastQuoted;
    if (inside) {
      const tokens = tokensOfNormalized(part);
      const next = parts[i + 1];
      const prefix = next !== undefined && next.startsWith('*');
      consumeLeadingStar = prefix;
      if (tokens.length > 0) terms.push({ tokens, prefix: prefix && tokens.length > 0 });
      continue;
    }
    if (consumeLeadingStar) {
      part = part.slice(1); // the `*` that belonged to the preceding closing quote
      consumeLeadingStar = false;
    }
    for (const m of part.matchAll(WORD_WITH_STAR)) {
      const tokens = tokensOfNormalized(m[1] ?? '');
      if (tokens.length > 0) terms.push({ tokens, prefix: m[2] === '*' });
    }
  }
  return terms;
}

/** All query tokens in order (phrases flattened, prefix markers dropped), using the identical transform as indexing. */
export function tokenizeQuery(q: string): string[] {
  return parsePlainQuery(q).flatMap((t) => t.tokens);
}

// ---------------------------------------------------------------------------------------------------------------
// Raw-mode query preparation
// ---------------------------------------------------------------------------------------------------------------

/**
 * Raw mode passes FTS5 syntax through, but the CJK/diacritic transforms still have to be applied or no raw query could
 * ever match the index. Differences from plain mode: the case is PRESERVED (FTS5 operators AND/OR/NOT/NEAR are
 * upper-case only; unicode61 lower-cases barewords itself), and no space is inserted between a CJK character and an
 * immediately following `*` so `日本*` keeps its prefix meaning. Quoted CJK text becomes a phrase of per-character tokens;
 * an UNQUOTED CJK bareword becomes an implicit AND of its characters (use quotes for adjacency).
 */
export function prepareRawQuery(q: string): string {
  const folded = foldText(q, false);
  return folded.replace(CJK_GLOBAL, (m: string, offset: number, whole: string) => (whole.charAt(offset + m.length) === '*' ? ` ${m}` : ` ${m} `));
}

/**
 * Best-effort extraction of the words a raw query is looking for, used ONLY to highlight snippets. Operators, column
 * filters and punctuation are dropped; negated terms are not special-cased (they cannot appear in a hit anyway).
 */
export function rawQueryTerms(q: string): QueryTerm[] {
  const withoutSyntax = q.replace(/\b(?:AND|OR|NOT|NEAR)\b/g, ' ').replace(/[A-Za-z_][A-Za-z0-9_]*\s*:/g, ' ');
  return parsePlainQuery(withoutSyntax);
}

// ---------------------------------------------------------------------------------------------------------------
// Tokenizing ORIGINAL text with offsets (for snippets)
// ---------------------------------------------------------------------------------------------------------------

/** A token of the original text: `norm` is its normalized form, [start, end) are UTF-16 offsets into the ORIGINAL string. */
export interface SearchToken {
  norm: string;
  start: number;
  end: number;
}

const FOLD_CACHE = new Map<string, string>();
const FOLD_CACHE_MAX = 8192;

/** `normalizeForSearch` of a single code point, memoized (pure function, so the cache cannot change any result). */
function foldCodePoint(ch: string): string {
  if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return ch.toLowerCase();
  let folded = FOLD_CACHE.get(ch);
  if (folded === undefined) {
    folded = normalizeForSearch(ch);
    if (FOLD_CACHE.size >= FOLD_CACHE_MAX) FOLD_CACHE.clear();
    FOLD_CACHE.set(ch, folded);
  }
  return folded;
}

/**
 * Lazily tokenize `text[from, to)` the way the index tokenizes `buildSearchText(text)`, but reporting offsets into the
 * ORIGINAL string so a snippet can be cut from, and highlighted in, the original text (never from the transformed
 * copy, which is space-separated for CJK). The normalization is applied per code point, which differs from whole-string
 * normalization only for exotic cross-character compositions (e.g. decomposed Hangul jamo); in that case the worst
 * outcome is a missing highlight, never a wrong search result (matching is done by FTS5, not by this function).
 * Combining marks that fold away attach to the token in progress.
 */
export function* iterateSearchTokens(text: string, from = 0, to: number = text.length): Generator<SearchToken, void, undefined> {
  const limit = Math.min(to, text.length);
  let cur = '';
  let curStart = 0;
  let curEnd = 0;
  let i = Math.max(0, from);
  while (i < limit) {
    const cp = text.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    const folded = foldCodePoint(text.slice(i, i + len));
    if (folded === '') {
      if (cur !== '') curEnd = i + len; // a folded-away combining mark belongs to the word it modifies
      i += len;
      continue;
    }
    for (const f of folded) {
      if (isCjkChar(f)) {
        if (cur !== '') {
          yield { norm: cur, start: curStart, end: curEnd };
          cur = '';
        }
        yield { norm: f, start: i, end: i + len };
      } else if (TOKEN_ONE.test(f)) {
        if (cur === '') curStart = i;
        cur += f;
        curEnd = i + len;
      } else if (cur !== '') {
        yield { norm: cur, start: curStart, end: curEnd };
        cur = '';
      }
    }
    i += len;
  }
  if (cur !== '') yield { norm: cur, start: curStart, end: curEnd };
}
