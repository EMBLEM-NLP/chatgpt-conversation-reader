/**
 * Tests for src/db/search.ts: Unicode matching, prefix/phrase/AND semantics, ordering, filters, hidden/structural
 * exclusion, head-batch scoping, snippets built from the original text, and title search. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationRecord } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { parsePlainQuery } from '../../src/db/cjk.js';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { buildMatchExpression, buildSnippet, searchConversationTitles, searchMessages } from '../../src/db/search.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const SEED = 20261013;

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 150): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

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

interface Spec {
  id?: string;
  text: string;
  role?: string;
  channel?: string | null;
  model?: string | null;
  hidden?: boolean;
  createdAt?: string | null;
}

/** Linear conversation whose messages carry the given texts / attributes. */
function conv(id: string, specs: Array<string | Spec>, over: Partial<ConversationRecord> = {}): ConversationRecord {
  let prev: string | null = null;
  const msgs = specs.map((sp, i) => {
    const s: Spec = typeof sp === 'string' ? { text: sp } : sp;
    const mid = s.id ?? `${id}-m${i}`;
    const m = msg({
      id: mid,
      conversationId: id,
      parentId: prev,
      authorRole: s.role ?? 'user',
      channel: s.channel ?? null,
      modelSlug: s.model ?? null,
      hidden: s.hidden ?? false,
      createdAt: s.createdAt === undefined ? iso(i + 1) : s.createdAt,
      text: s.text,
      ordinal: i,
    });
    prev = mid;
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

function isWellFormed(s: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

const MARK_START = '\u0001';
const MARK_END = '\u0002';

describe('searchMessages: Unicode term matching (FR-05)', () => {
  // [label, text, query, expected match]
  const CASES: Array<[string, string, string, boolean]> = [
    ['latin: accent in text, plain query', 'Un petit Café noir', 'cafe', true],
    ['latin: accent in query, plain text', 'a plain cafe', 'Café', true],
    ['latin: decomposed accent in text', 'Cafe\u0301 society', 'café', true],
    ['latin: upper case', 'CAFÉ', 'cafe', true],
    ['latin: other accents', 'Naïve Zoë à la Crème', 'naive zoe creme', true],
    ['latin: different word is not a match', 'Café', 'cafes', false],
    ['latin: sharp s is NOT expanded (documented non-goal)', 'Straße', 'strasse', false],
    ['latin: sharp s matches itself', 'Straße', 'straße', true],
    ['latin: full-width letters (NFKC)', 'ＨＥＬＬＯ world', 'hello', true],
    ['latin: ligature (NFKC)', 'ﬁsh and chips', 'fish', true],
    ['cyrillic: case', 'ПРИВЕТ мир', 'привет', true],
    ['cyrillic: breve is folded', 'Йод и соль', 'иод', true],
    ['cyrillic: different word', 'привет', 'пока', false],
    ['greek: tonos folded', 'Αθήνα είναι όμορφη', 'αθηνα', true],
    ['greek: final sigma typed as sigma', 'ΟΔΟΣ', 'οδοσ', true],
    ['greek: final sigma typed as final sigma', 'ΟΔΟΣ', 'οδος', true],
    ['emoji text: word before an emoji', 'I ❤\uFE0F pizza 🍕 tonight', 'pizza', true],
    ['emoji text: word after an emoji', 'I ❤\uFE0F pizza 🍕 tonight', 'tonight', true],
    ['emoji text: ZWJ sequence does not hide neighbours', 'family 👨\u200D👩\u200D👧 photo', 'photo', true],
    ['emoji text: surrounding words stay adjacent for phrases', 'pizza 🍕 tonight', '"pizza tonight"', true],
    ['cjk 1 char', 'これは日本語のテスト', '日', true],
    ['cjk 1 char kana', 'これは日本語のテスト', 'の', true],
    ['cjk 2 chars', 'これは日本語のテスト', '日本', true],
    ['cjk 2 chars crossing scripts', 'これは日本語のテスト', 'は日', true],
    ['cjk 3 chars', 'これは日本語のテスト', '日本語', true],
    ['cjk 3 chars katakana', 'これは日本語のテスト', 'テスト', true],
    ['cjk 2 chars inside', 'これは日本語のテスト', '本語', true],
    ['cjk non-adjacent characters do not match', 'これは日本語のテスト', '日語', false],
    ['cjk reversed order does not match', 'これは日本語のテスト', '本日', false],
    ['cjk longer than the text does not match', 'これは日本語のテスト', '日本語です', false],
    ['cjk absent character', 'これは日本語のテスト', '韓', false],
    ['cjk long vowel mark', 'コーヒーを飲む', 'ーヒ', true],
    ['cjk half-width katakana (NFKC)', 'ﾃｽﾄです', 'テスト', true],
    ['cjk chinese substring', '今天天气很好', '天气', true],
    ['cjk chinese absent', '今天天气很好', '天很', false],
    ['cjk hangul substring', '대한민국 한국어 공부', '한국', true],
    ['cjk hangul inside a word', '대한민국 한국어 공부', '국어', true],
    ['cjk hangul non-adjacent', '대한민국 한국어 공부', '한어', false],
    ['cjk astral extension B characters', '𠀀𠀁𠀂 chars', '𠀁', true],
    ['cjk astral pair', '𠀀𠀁𠀂 chars', '𠀁𠀂', true],
    ['cjk astral non-adjacent', '𠀀𠀁𠀂 chars', '𠀀𠀂', false],
    ['mixed: latin attached to cjk', 'Hello世界 and more', 'hello世', true],
    ['mixed: latin word and cjk word are ANDed', 'Hello世界 and more', '界 and', true],
    ['mixed: cjk word wrong neighbour', 'Hello世界 and more', 'hello界', false],
    ['mixed: scripts in one message', 'Café 日本語 Привет Αθήνα', 'cafe привет', true],
    ['devanagari word stays whole', 'ह\u093Fन\u094Dद\u0940 भ\u093Eष\u093E स\u0941\u0902दर ह\u0948', 'ह\u093Fन\u094Dद\u0940', true],
    ['devanagari other word', 'ह\u093Fन\u094Dद\u0940 भ\u093Eष\u093E स\u0941\u0902दर ह\u0948', 'भ\u093Eष\u093E', true],
  ];

  it('table of positive and negative Unicode cases', async () => {
    const records = CASES.map(([, text], i) => conv(`case-${i}`, [text]));
    const { db } = await setup(records);
    const failures: string[] = [];
    CASES.forEach(([label, , query, expected], i) => {
      const found = searchMessages(db, { query, conversationId: `case-${i}` }).items.length > 0;
      if (found !== expected) failures.push(`${label}: query ${JSON.stringify(query)} expected ${expected} got ${found}`);
    });
    assert.deepEqual(failures, []);
  });

  it('CJK hits are found across the whole corpus and ranked/limited like any other', async () => {
    const { db } = await setup([conv('c1', ['これは日本語のテスト', '日本の首都は東京', 'plain english only'])]);
    assert.deepEqual(ids(searchMessages(db, { query: '日本' })).sort(), ['c1-m0', 'c1-m1']);
    assert.deepEqual(ids(searchMessages(db, { query: '日本語' })), ['c1-m0']);
    assert.deepEqual(ids(searchMessages(db, { query: '東京' })), ['c1-m1']);
    assert.deepEqual(ids(searchMessages(db, { query: '京日' })), []);
  });

  it('punctuation between CJK characters does not break adjacency (documented, same as for Latin phrases)', async () => {
    const { db } = await setup([conv('c1', ['你好，世界！'])]);
    assert.equal(searchMessages(db, { query: '好世' }).items.length, 1);
  });

  it('an emoji-only or punctuation-only query has no searchable terms: INVALID_ARGUMENT, never a full scan', async () => {
    const { db } = await setup([conv('c1', ['I ❤\uFE0F pizza 🍕'])]);
    for (const q of ['🍕', '❤\uFE0F', '!!!', '   ', '', '""', '*']) {
      assert.throws(() => searchMessages(db, { query: q }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', JSON.stringify(q));
    }
  });
});

describe('searchMessages: prefix, phrase, AND', () => {
  const TEXTS = ['Programming languages are fun', 'the quick brown fox', 'brown quick', 'alpha beta gamma', 'alpha only', 'beta only', 'Café au lait'];

  it('trailing * is a prefix match on the last token; a bare word is exact', async () => {
    const { db } = await setup([conv('c1', TEXTS)]);
    assert.deepEqual(ids(searchMessages(db, { query: 'prog*' })), ['c1-m0']);
    assert.deepEqual(ids(searchMessages(db, { query: 'PROG*' })), ['c1-m0']);
    assert.deepEqual(ids(searchMessages(db, { query: 'languages*' })), ['c1-m0']);
    assert.deepEqual(ids(searchMessages(db, { query: 'caf*' })), ['c1-m6'], 'prefix works on folded diacritics');
    assert.deepEqual(ids(searchMessages(db, { query: 'prog' })), [], 'no star: no prefix');
    assert.deepEqual(ids(searchMessages(db, { query: 'prog *' })), [], 'a detached star is punctuation, not a prefix');
    assert.deepEqual(ids(searchMessages(db, { query: 'ming*' })), [], 'prefix, not infix');
  });

  it('quoted text is a phrase: adjacent and ordered', async () => {
    const { db } = await setup([conv('c1', TEXTS)]);
    assert.deepEqual(ids(searchMessages(db, { query: '"quick brown"' })), ['c1-m1']);
    assert.deepEqual(ids(searchMessages(db, { query: '"brown quick"' })), ['c1-m2']);
    assert.deepEqual(ids(searchMessages(db, { query: '"quick fox"' })), [], 'not adjacent');
    assert.deepEqual(ids(searchMessages(db, { query: '"quick bro"*' })), ['c1-m1'], 'prefix on the last word of a phrase');
    assert.deepEqual(ids(searchMessages(db, { query: '"quick bro"' })), [], 'phrase without star is exact');
    assert.deepEqual(ids(searchMessages(db, { query: '"Quick,  BROWN"' })), ['c1-m1'], 'phrase ignores punctuation and case');
  });

  it('unquoted words are ANDed in any order, and AND/OR/NOT are ordinary words in plain mode', async () => {
    const { db } = await setup([conv('c1', TEXTS), conv('c2', ['this or that', 'something and other', 'not here'])]);
    assert.deepEqual(ids(searchMessages(db, { query: 'quick brown' })).sort(), ['c1-m1', 'c1-m2']);
    assert.deepEqual(ids(searchMessages(db, { query: 'beta alpha' })), ['c1-m3']);
    assert.deepEqual(ids(searchMessages(db, { query: 'alpha OR beta' })), [], 'OR is a word that must be present');
    assert.deepEqual(ids(searchMessages(db, { query: 'this OR that' })), ['c2-m0']);
    assert.deepEqual(ids(searchMessages(db, { query: 'something AND other' })), ['c2-m1']);
    assert.deepEqual(ids(searchMessages(db, { query: 'NOT here' })), ['c2-m2']);
  });

  it('buildMatchExpression quotes every token and doubles embedded quotes', () => {
    assert.equal(buildMatchExpression(parsePlainQuery('Hello world*')), '"hello" "world"*');
    assert.equal(buildMatchExpression(parsePlainQuery('"a b" c')), '"a b" "c"');
    assert.equal(buildMatchExpression(parsePlainQuery('日本語')), '"日 本 語"');
    assert.equal(buildMatchExpression([{ tokens: ['we"ird'], prefix: false }]), '"we""ird"');
  });
});

describe('searchMessages: scoping, hidden and structural nodes', () => {
  it('structural nodes are stored but never returned; hidden messages are excluded unless includeHidden', async () => {
    const rec = conv('c1', [{ text: 'visible needle' }, { text: 'hidden needle', hidden: true }, { text: 'another visible needle' }]);
    const structuralRoot = msg({ id: 'c1-root', conversationId: 'c1', nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 99 });
    rec.messages.push(structuralRoot);
    const { db } = await setup([rec]);
    assert.deepEqual(ids(searchMessages(db, { query: 'needle' })).sort(), ['c1-m0', 'c1-m2']);
    const all = searchMessages(db, { query: 'needle', includeHidden: true });
    assert.deepEqual(ids(all).sort(), ['c1-m0', 'c1-m1', 'c1-m2']);
    assert.deepEqual(all.items.filter((h) => h.hidden).map((h) => h.messageId), ['c1-m1']);
    assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE node_kind = 'structural_empty'").get()?.['n'], 1);
  });

  it('applies provider, accountLabel, conversationId, role, channel and hasModel filters (and their combinations)', async () => {
    const a = conv('ca', [
      { text: 'needle user', role: 'user' },
      { text: 'needle assistant final', role: 'assistant', channel: 'final', model: 'm-1' },
      { text: 'needle assistant analysis', role: 'assistant', channel: 'analysis', model: null },
      { text: 'needle tool', role: 'tool', channel: null, model: 'm-2' },
    ]);
    const b = conv('cb', [{ text: 'needle other conversation', role: 'user' }]);
    const w: ConversationRecord = { ...conv('cw', [{ text: 'needle work account', role: 'user' }]), accountLabel: 'work' };
    const c: ConversationRecord = { ...conv('cc', [{ text: 'needle claude', role: 'user' }]), provider: 'claude', provenance: 'official_claude_export' };
    const { db, repo } = await setup([a, b]);
    await repo.importBatch({ batch: { ...META, accountLabel: 'work', contentDigest: 'w' }, conversations: [w] });
    await repo.importBatch({ batch: { ...META, provider: 'claude', provenance: 'official_claude_export', contentDigest: 'c' }, conversations: [c] });
    const q = (extra: object) => ids(searchMessages(db, { query: 'needle', ...extra })).sort();

    assert.equal(q({}).length, 7);
    assert.deepEqual(q({ provider: 'claude' }), ['cc-m0']);
    assert.deepEqual(q({ accountLabel: 'work' }), ['cw-m0']);
    assert.deepEqual(q({ provider: 'chatgpt', accountLabel: 'default' }), ['ca-m0', 'ca-m1', 'ca-m2', 'ca-m3', 'cb-m0']);
    assert.deepEqual(q({ conversationId: 'ca' }), ['ca-m0', 'ca-m1', 'ca-m2', 'ca-m3']);
    assert.deepEqual(q({ role: 'assistant' }), ['ca-m1', 'ca-m2']);
    assert.deepEqual(q({ role: 'Assistant' }), [], 'roles are matched verbatim (case-sensitive)');
    assert.deepEqual(q({ channel: 'final' }), ['ca-m1']);
    assert.deepEqual(q({ hasModel: true }), ['ca-m1', 'ca-m3']);
    assert.deepEqual(q({ hasModel: false }).length, 5);
    assert.deepEqual(q({ conversationId: 'ca', role: 'assistant', hasModel: true }), ['ca-m1']);
    assert.deepEqual(q({ conversationId: 'ca', provider: 'claude' }), [], 'filters combine with AND');
    assert.deepEqual(q({ conversationId: 'does-not-exist' }), []);
  });

  it('createdAfter is inclusive, createdBefore is exclusive; messages without a timestamp never match a bound', async () => {
    const rec = conv('c1', [
      { text: 'needle early', createdAt: iso(1) },
      { text: 'needle middle', createdAt: iso(10) },
      { text: 'needle late', createdAt: iso(20) },
      { text: 'needle undated', createdAt: null },
    ]);
    const { db } = await setup([rec]);
    const q = (extra: object) => ids(searchMessages(db, { query: 'needle', ...extra })).sort();
    assert.deepEqual(q({}), ['c1-m0', 'c1-m1', 'c1-m2', 'c1-m3']);
    assert.deepEqual(q({ createdAfter: iso(10) }), ['c1-m1', 'c1-m2']);
    assert.deepEqual(q({ createdBefore: iso(10) }), ['c1-m0']);
    assert.deepEqual(q({ createdAfter: iso(2), createdBefore: iso(20) }), ['c1-m1']);
    assert.deepEqual(q({ createdAfter: iso(21) }), []);
    assert.deepEqual(q({ createdAfter: iso(10), createdBefore: iso(10) }), [], 'empty range');
    for (const bad of ['yesterday', '2025-01-01', '2025-13-01T00:00:00Z', '2025-01-01T00:00:00+02:00', 5 as never, '']) {
      assert.throws(() => searchMessages(db, { query: 'needle', createdAfter: bad }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', String(bad));
      assert.throws(() => searchMessages(db, { query: 'needle', createdBefore: bad }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', String(bad));
    }
  });

  it('validates every argument with INVALID_ARGUMENT and never echoes the offending value', async () => {
    const { db } = await setup([conv('c1', ['needle'])]);
    const marker = 'LEAKMARKER-xyz';
    const bad: object[] = [
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { limit: '5' },
      { limit: Number.NaN },
      { offset: -1 },
      { offset: 0.5 },
      { offset: '1' },
      { mode: marker },
      { provider: 5 },
      { accountLabel: marker + '\0' },
      { conversationId: 'x'.repeat(513) },
      { role: {} },
      { channel: [] },
      { hasModel: 'true' },
      { includeHidden: 1 },
      { allBatches: 'yes' },
      { cursor: 5 },
      { cursor: '' },
    ];
    for (const extra of bad) {
      assert.throws(
        () => searchMessages(db, { query: 'needle', ...extra }),
        (e) => {
          assert.ok(e instanceof GcrError, JSON.stringify(extra));
          assert.equal(e.code, 'INVALID_ARGUMENT', JSON.stringify(extra));
          assert.ok(!JSON.stringify(e.toEnvelope()).includes(marker));
          return true;
        },
      );
    }
    assert.throws(() => searchMessages(db, null as never), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
    assert.throws(() => searchMessages(db, { query: 5 as never }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
    assert.throws(() => searchMessages(db, {} as never), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
  });
});

describe('searchMessages: ordering', () => {
  it('ranks by bm25 first: a short message about the term beats a long one', async () => {
    const { db } = await setup([conv('c1', [{ text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda alpha', createdAt: iso(1) }, { text: 'alpha', createdAt: iso(5) }, { text: 'unrelated filler text here', createdAt: iso(2) }])]);
    const page = searchMessages(db, { query: 'alpha' });
    assert.deepEqual(ids(page), ['c1-m1', 'c1-m0']);
    assert.ok((page.items[0]?.rank ?? 0) < (page.items[1]?.rank ?? 0), 'rank: lower is better');
  });

  it('breaks rank ties by created_at ASC with NULLs last, then conversation_id, then message_id', async () => {
    const same = 'tie token';
    const { db } = await setup([
      conv('c-b', [{ id: 'm2', text: same, createdAt: iso(5) }, { id: 'm1', text: same, createdAt: iso(5) }]),
      conv('c-a', [{ id: 'm9', text: same, createdAt: iso(5) }, { id: 'undated', text: same, createdAt: null }, { id: 'early', text: same, createdAt: iso(3) }]),
      conv('c-0', [{ id: 'undated-too', text: same, createdAt: null }]),
    ]);
    const order = searchMessages(db, { query: 'tie token' }).items.map((h) => `${h.conversationId}/${h.messageId}`);
    assert.deepEqual(order, ['c-a/early', 'c-a/m9', 'c-b/m1', 'c-b/m2', 'c-0/undated-too', 'c-a/undated']);
  });

  it('is a TOTAL order even when conversation and message ids repeat across provider / account / batch (allBatches)', async () => {
    const mk = (updated: number, over: Partial<ConversationRecord> = {}) => conv('same', [{ id: 'same-msg', text: 'identical text', createdAt: iso(1) }], { updatedAt: iso(updated), ...over });
    const { db, repo } = await setup([mk(1)], { contentDigest: 'v1' });
    await repo.importBatch({ batch: { ...META, contentDigest: 'v2' }, conversations: [mk(2)] });
    await repo.importBatch({ batch: { ...META, accountLabel: 'other', contentDigest: 'o' }, conversations: [mk(1, { accountLabel: 'other' })] });
    await repo.importBatch({ batch: { ...META, provider: 'claude', provenance: 'official_claude_export', contentDigest: 'c' }, conversations: [mk(1, { provider: 'claude', provenance: 'official_claude_export' })] });

    const hits = searchMessages(db, { query: 'identical', allBatches: true }).items;
    assert.equal(hits.length, 4);
    assert.equal(new Set(hits.map((h) => `${h.provider}|${h.accountLabel}|${h.batchId}`)).size, 4);
    const key = (h: (typeof hits)[number]) => [h.provider, h.accountLabel, h.batchId];
    const sorted = [...hits].sort((x, y) => (JSON.stringify(key(x)) < JSON.stringify(key(y)) ? -1 : 1));
    // identical text/created_at => identical rank => the tail of the order is (provider, account_label, source_batch)
    assert.deepEqual(hits.map(key), sorted.map(key));
    // by default only head batches count: v2, other, claude
    assert.equal(searchMessages(db, { query: 'identical' }).items.length, 3);
  });
});

describe('searchMessages: snippets (plain text from the ORIGINAL message, markers U+0001/U+0002)', () => {
  const NEEDLE = [{ tokens: ['needle'], prefix: false }];

  it('wraps the match in markers and keeps the original case and accents', async () => {
    const { db } = await setup([conv('c1', ['Un petit Café noir et un thé'])]);
    const hit = searchMessages(db, { query: 'cafe' }).items[0];
    assert.equal(hit?.snippet, `Un petit ${MARK_START}Café${MARK_END} noir et un thé`);
  });

  it('CJK snippets come from the original text: contiguous characters, highlighted as one region', async () => {
    const text = 'これは日本語のテストです';
    const { db } = await setup([conv('c1', [text])]);
    const hit = searchMessages(db, { query: '日本語' }).items[0];
    assert.equal(hit?.snippet, `これは${MARK_START}日本語${MARK_END}のテストです`);
    assert.equal(hit?.snippet.replace(/[\u0001\u0002]/g, ''), text, 'no spaces were introduced between CJK characters');
    // a stray single character elsewhere is NOT highlighted when the query is a phrase
    const { db: db2 } = await setup([conv('c2', ['日曜日と日本語'])]);
    assert.equal(searchMessages(db2, { query: '日本語' }).items[0]?.snippet, `日曜日と${MARK_START}日本語${MARK_END}`);
  });

  it('highlights the whole word for a prefix query and the whole phrase for a quoted query', async () => {
    const { db } = await setup([conv('c1', ['I enjoy programming languages a lot'])]);
    assert.equal(searchMessages(db, { query: 'prog*' }).items[0]?.snippet, `I enjoy ${MARK_START}programming${MARK_END} languages a lot`);
    assert.equal(searchMessages(db, { query: '"programming languages"' }).items[0]?.snippet, `I enjoy ${MARK_START}programming languages${MARK_END} a lot`);
    assert.equal(
      searchMessages(db, { query: 'enjoy lot' }).items[0]?.snippet,
      `I ${MARK_START}enjoy${MARK_END} programming languages a ${MARK_START}lot${MARK_END}`,
      'every term is highlighted',
    );
  });

  it('is at most 160 characters INCLUDING markers and ellipses, for hits at the start, middle and end of a long text', async () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const texts = [`needle ${filler(2000)}`, `${filler(1000)} needle ${filler(1000)}`, `${filler(2000)} needle`];
    const { db } = await setup([conv('c1', texts)]);
    const page = searchMessages(db, { query: 'needle' });
    assert.equal(page.items.length, 3);
    for (const hit of page.items) {
      assert.ok(hit.snippet.length <= 160, `${hit.messageId}: ${hit.snippet.length}`);
      assert.ok(hit.snippet.includes(`${MARK_START}needle${MARK_END}`), hit.messageId);
      assert.ok(isWellFormed(hit.snippet));
    }
    const byId = new Map(page.items.map((h) => [h.messageId, h.snippet]));
    assert.ok(!byId.get('c1-m0')?.startsWith('…'), 'hit at the start: no leading ellipsis');
    assert.ok(byId.get('c1-m0')?.endsWith('…'));
    assert.ok(byId.get('c1-m1')?.startsWith('…') && byId.get('c1-m1')?.endsWith('…'));
    assert.ok(byId.get('c1-m2')?.startsWith('…'));
    assert.ok(!byId.get('c1-m2')?.endsWith('…'), 'hit at the end: no trailing ellipsis');
  });

  it('is a faithful excerpt: with markers and ellipses removed it is a substring of the (whitespace-collapsed) original', async () => {
    const original = Array.from({ length: 300 }, (_, i) => `tok${i}`).join(' ') + ' needle ' + Array.from({ length: 300 }, (_, i) => `end${i}`).join(' ');
    const snippet = buildSnippet(original, NEEDLE);
    assert.ok(original.includes(snippet.replace(/[\u0001\u0002…]/g, '')));
  });

  it('message text can neither forge a highlight nor smuggle control characters', () => {
    const forged = buildSnippet('before \u0001FORGED\u0002 needle after \u001b[31mred\u0007 line1\nline2\ttab\u202Eevil', NEEDLE);
    assert.equal([...forged].filter((c) => c === MARK_START).length, 1, 'exactly the one real highlight');
    assert.equal([...forged].filter((c) => c === MARK_END).length, 1);
    assert.ok(forged.includes('\uFFFD'), 'forged markers and bidi controls are replaced');
    assert.doesNotMatch(forged, /[\u001b\u0007\n\t\u202E]/u);
    assert.ok(forged.includes(`${MARK_START}needle${MARK_END}`));
  });

  it('leaves HTML-looking text as plain text (escaping is a renderer concern; markers are never HTML)', () => {
    const s = buildSnippet('<script>alert(1)</script> needle <b>bold</b> &amp;', NEEDLE);
    assert.ok(s.includes('<script>alert(1)</script>'));
    assert.ok(s.includes('&amp;'), 'no entity encoding or decoding');
    assert.ok(!s.includes('<mark>'));
  });

  it('never splits a surrogate pair or an emoji, wherever the window falls (property)', () => {
    runProperty(
      fc.property(fc.integer({ min: 0, max: 220 }), fc.integer({ min: 0, max: 220 }), fc.constantFrom('😀', '𠀀', 'é', '👨\u200D👩\u200D👧', 'ab'), (before, after, glyph) => {
        const text = `${glyph.repeat(before)} needle ${glyph.repeat(after)}`;
        const snippet = buildSnippet(text, NEEDLE);
        assert.ok(isWellFormed(snippet), 'well-formed UTF-16');
        assert.ok(snippet.length <= 160);
        assert.ok(snippet.includes(`${MARK_START}needle${MARK_END}`));
      }),
    );
  });

  it('always respects the budget and keeps markers balanced for arbitrary text and budgets (property)', () => {
    runProperty(
      fc.property(fc.array(fc.constantFrom('needle', 'hay', 'Needle', ' ', '\n', '日', '本', '😀', 'x', 'needles'), { maxLength: 80 }).map((a) => a.join('')), fc.integer({ min: 8, max: 200 }), (text, budget) => {
        const snippet = buildSnippet(text, NEEDLE, budget);
        assert.ok(snippet.length <= budget);
        assert.ok(isWellFormed(snippet));
        const opens = [...snippet].filter((c) => c === MARK_START).length;
        const closes = [...snippet].filter((c) => c === MARK_END).length;
        assert.equal(opens, closes);
        assert.doesNotMatch(snippet, /\u0001[^\u0002]*\u0001/u, 'markers never nest');
      }),
    );
  });

  it('truncates (but still highlights) a single enormous matching token and stays within budget', () => {
    const snippet = buildSnippet('a'.repeat(50_000), [{ tokens: ['a'.repeat(50_000)], prefix: false }]);
    assert.ok(snippet.length <= 160);
    assert.ok(snippet.startsWith(MARK_START) && snippet.includes(MARK_END));
  });

  it('falls back to the start of the text without markers when no term can be located; empty text gives an empty snippet', () => {
    assert.equal(buildSnippet('hello world', [{ tokens: ['zebra'], prefix: false }]), 'hello world');
    assert.equal(buildSnippet('hello world', []), 'hello world');
    assert.equal(buildSnippet('', NEEDLE), '');
    assert.ok(buildSnippet('x '.repeat(500), [{ tokens: ['zebra'], prefix: false }]).length <= 160);
  });
});

describe('searchConversationTitles', () => {
  async function titled(): Promise<{ db: DatabaseSync; repo: Repository }> {
    return setup([
      conv('t1', ['body about cafe'], { title: 'Café planning notes' }),
      conv('t2', ['body'], { title: '日本語の勉強' }),
      conv('t3', ['body'], { title: 'Рецепт борща' }),
      conv('t4', ['body'], { title: 'Alpha release plan' }),
      conv('t5', ['body'], { title: null }),
    ]);
  }

  it('finds titles with the same Unicode handling as message search, and only titles', async () => {
    const { db } = await titled();
    const t = (q: string) => searchConversationTitles(db, { query: q }).items.map((i) => i.conversationId).sort();
    assert.deepEqual(t('cafe'), ['t1']);
    assert.deepEqual(t('日本'), ['t2']);
    assert.deepEqual(t('勉強'), ['t2']);
    assert.deepEqual(t('БОРЩ*'), ['t3']);
    assert.deepEqual(t('plan*'), ['t1', 't4']);
    assert.deepEqual(t('"release plan"'), ['t4']);
    assert.deepEqual(t('body'), [], 'message text is not searched by the title search');
    assert.deepEqual(ids(searchMessages(db, { query: 'planning' })), [], 'titles are not searched by the message search');
  });

  it('returns summaries with a highlighted snippet of the ORIGINAL title and a rank', async () => {
    const { db } = await titled();
    const hit = searchConversationTitles(db, { query: 'cafe' }).items[0];
    assert.equal(hit?.snippet, `${MARK_START}Café${MARK_END} planning notes`);
    assert.equal(hit?.title, 'Café planning notes');
    assert.equal(hit?.conversationId, 't1');
    assert.equal(typeof hit?.rank, 'number');
    assert.equal(hit?.messageCount, 1);
    assert.equal(searchConversationTitles(db, { query: '日本' }).items[0]?.snippet, `${MARK_START}日本${MARK_END}語の勉強`);
  });

  it('is scoped to the head batch unless allBatches, supports provider/account filters and offset pagination', async () => {
    const { db, repo } = await titled();
    await repo.importBatch({ batch: { ...META, contentDigest: 'v2' }, conversations: [conv('t4', ['body'], { title: 'Beta release plan', updatedAt: iso(900) })] });
    assert.deepEqual(searchConversationTitles(db, { query: 'alpha' }).items, [], 'the old title belongs to a superseded snapshot');
    assert.equal(searchConversationTitles(db, { query: 'alpha', allBatches: true }).items.length, 1);
    assert.equal(searchConversationTitles(db, { query: 'beta' }).items.length, 1);
    assert.equal(searchConversationTitles(db, { query: 'release', provider: 'claude' }).items.length, 0);
    assert.equal(searchConversationTitles(db, { query: 'release', accountLabel: 'default' }).items.length, 1);

    const p1 = searchConversationTitles(db, { query: 'plan*', allBatches: true, limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p1.nextOffset, 2);
    assert.equal(p1.nextCursor, null);
    const p2 = searchConversationTitles(db, { query: 'plan*', allBatches: true, limit: 2, offset: 2 });
    assert.equal(p2.items.length, 1);
    assert.equal(p2.nextOffset, null);
    assert.equal(new Set([...p1.items, ...p2.items].map((i) => `${i.conversationId}|${i.batchId}`)).size, 3);
  });

  it('rejects empty queries and bad arguments', async () => {
    const { db } = await titled();
    for (const q of ['', '   ', '!!', '🍕']) assert.throws(() => searchConversationTitles(db, { query: q }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
    assert.throws(() => searchConversationTitles(db, { query: 'a', limit: 0 }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
    assert.throws(() => searchConversationTitles(db, { query: 'a', provider: 5 as never }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
  });
});
