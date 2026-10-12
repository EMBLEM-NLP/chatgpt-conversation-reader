/**
 * SPEC-08 regression tests (low): an emoji/symbol-only query was refused with "the query has no searchable terms (it is empty or
 * only punctuation)", which did not say that symbols are simply not indexed, and the limit was nowhere in the user documentation.
 *
 * Reproduction (before the fix): a synthetic message holding "😀" and a ZWJ family emoji; `gcr search "😀" --format json` ->
 * exit 2, INVALID_ARGUMENT "the query has no searchable terms (it is empty or only punctuation)".
 *
 * Fixed: the error now says "the query contains only symbols or punctuation, which are not indexed; search for words" (and an
 * empty query says it is empty). The test also pins the documented fold list (case, accents, width, ligatures, CJK substrings)
 * and the documented non-fold (ß vs ss) so docs/USER_GUIDE.md and docs/CLI_REFERENCE.md cannot drift from the behaviour.
 * SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { expectGcr, fixedClock, importBuilders, makeTempDir, removeDir, thrown, title } from './sdk.helpers.test.js';

const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466); // ZWJ family emoji
const GRIN = String.fromCodePoint(0x1f600);
const NFD_CAFE = 'Café';
const FULLWIDTH = String.fromCodePoint(0xff21, 0xff22, 0xff23);
const LIGATURE_FI = String.fromCodePoint(0xfb01);
const SHARP_S = String.fromCodePoint(0xdf);

const TEXTS = [
  `plain greeting ${GRIN} with a grin and ${FAMILY} a family`,
  'Café au lait',
  `decomposed ${NFD_CAFE} here`,
  `${FULLWIDTH} wide letters`,
  `a ${LIGATURE_FI}ne day`,
  'ПРИВЕТ мир', // ПРИВЕТ мир
  '東京と日本の首都', // 東京と日本の首都
  `Stra${SHARP_S}e in Berlin`,
];

let dir = '';
let gcr: Gcr;
const CONV = syntheticUuid(0x81);

before(async () => {
  dir = await makeTempDir();
  gcr = Gcr.open({ dbPath: join(dir, 'sym.sqlite'), clock: fixedClock });
  const b = new ConversationBuilder({ id: CONV, title: title('symbols and folding') });
  let prev = b.root();
  for (const t of TEXTS) prev = b.user(prev, t);
  await importBuilders(gcr, dir, [b]);
});

after(async () => {
  gcr.close();
  await removeDir(dir);
});

const hits = (query: string): number => gcr.search({ query }).data.items.length;

describe('SPEC-08: symbol-only queries fail with a message that says why', () => {
  const SYMBOLS: Array<[string, string]> = [
    ['an emoji', GRIN],
    ['a ZWJ family emoji sequence', FAMILY],
    ['two emoji', `${GRIN}${GRIN}`],
    ['a currency sign', String.fromCodePoint(0x20bd)],
    ['ASCII punctuation', '!!!'],
    ['empty quotes', '""'],
    ['a lone star', '*'],
  ];
  for (const [what, query] of SYMBOLS) {
    it(`${what}: INVALID_ARGUMENT naming symbols/punctuation and the remedy (plain mode)`, () => {
      const e = expectGcr(thrown(() => gcr.search({ query })), 'INVALID_ARGUMENT');
      assert.match(e.message, /the query contains only symbols or punctuation, which are not indexed; search for words/);
      assert.equal(e.details?.['field'], 'query');
      assert.doesNotMatch(e.message, /no searchable terms/);
    });
  }

  it('raw mode: an emoji-only query says the same instead of "empty"', () => {
    const e = expectGcr(thrown(() => gcr.search({ query: GRIN, mode: 'raw' })), 'INVALID_ARGUMENT');
    assert.match(e.message, /only symbols or punctuation, which are not indexed/);
  });

  it('title and attachment-free scopes share the message (the compiler is common)', () => {
    const e = expectGcr(thrown(() => gcr.search({ query: GRIN, scope: 'titles' })), 'INVALID_ARGUMENT');
    assert.match(e.message, /only symbols or punctuation/);
  });

  it('an empty or blank query is reported as empty, not as symbols', () => {
    for (const query of ['', '   ', '\t\n']) {
      const e = expectGcr(thrown(() => gcr.search({ query })), 'INVALID_ARGUMENT');
      assert.match(e.message, /the query is empty; search for words/, JSON.stringify(query));
      assert.doesNotMatch(e.message, /symbols/);
    }
  });

  it('a symbol next to a word is fine: the symbol is dropped and the word searched', () => {
    assert.equal(hits(`${GRIN} grin`), 1);
    assert.equal(hits(`grin ${FAMILY}`), 1);
  });
});

describe('SPEC-08: what IS folded (documented) and what is not', () => {
  it('case and accents: cafe / Café / CAFE / NFD all find both spellings', () => {
    for (const q of ['cafe', 'Café', 'CAFE', NFD_CAFE]) assert.equal(hits(q), 2, q);
  });
  it('width: fullwidth letters fold to ASCII, in both directions', () => {
    assert.equal(hits('abc'), 1);
    assert.equal(hits(FULLWIDTH), 1);
  });
  it('ligatures: "fine" finds the fi ligature and the ligature finds "fine"', () => {
    assert.equal(hits('fine'), 1);
    assert.equal(hits(`${LIGATURE_FI}ne`), 1);
  });
  it('Cyrillic case: lower case finds upper case', () => {
    assert.equal(hits('привет'), 1);
  });
  it('CJK: any run of characters is found as a substring, but not out of order', () => {
    assert.equal(hits('東京'), 1); // 東京
    assert.equal(hits('日本'), 1); // 日本
    assert.equal(hits('京東'), 0);
  });
  it('NOT folded: sharp s is not "ss" (documented limitation)', () => {
    assert.equal(hits('strasse'), 0);
    assert.equal(hits(`stra${SHARP_S}e`), 1);
  });
  it('NOT indexed: the emoji text itself cannot be found, only the words around it', () => {
    assert.equal(hits('family'), 1);
  });
});
