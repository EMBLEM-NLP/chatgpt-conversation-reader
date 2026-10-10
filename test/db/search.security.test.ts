/**
 * Security tests for the db layer (NFR-01/03): hostile FTS queries in plain mode, raw-mode syntax-error mapping,
 * SQL-injection attempts through every string parameter, cursor tampering, resource limits. "Harmless" is PROVEN by
 * checking that nothing was written (total_changes), the schema is unchanged and the row counts are unchanged.
 * All data is synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationRecord } from '../../src/domain/types.js';
import { EXIT_CODES, GcrError } from '../../src/errors.js';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { MAX_QUERY_CHARS, searchConversationTitles, searchMessages } from '../../src/db/search.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const SEED = 20261014;
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 250): void {
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

function conv(id: string, texts: string[], over: Partial<ConversationRecord> = {}): ConversationRecord {
  let prev: string | null = null;
  const msgs = texts.map((text, i) => {
    const m = msg({ id: `${id}-m${i}`, conversationId: id, parentId: prev, authorRole: i % 2 === 0 ? 'user' : 'assistant', createdAt: iso(i + 1), text, ordinal: i });
    prev = m.id;
    return m;
  });
  return convo(id, link(msgs), over);
}

const CORPUS = [
  conv('c1', ['alpha beta gamma', 'alpha only', 'beta only', 'beta alpha', 'a or b together', 'near alpha beta', 'quick brown fox', 'search text alpha', 'DROP TABLE messages drop table'], { title: 'Alpha title' }),
  conv('c2', ['これは日本語のテスト', 'Café au lait', 'Αθήνα'], { title: 'Second title' }),
];

async function setup(): Promise<{ db: DatabaseSync; repo: Repository }> {
  const h = openDatabase(':memory:');
  const repo = new Repository(h.db);
  await repo.importBatch({ batch: META, conversations: CORPUS });
  return { db: h.db, repo };
}

const TABLES = ['source_batches', 'source_batch_stats', 'conversations', 'messages', 'conversation_heads', 'messages_fts_docsize', 'conversations_fts_docsize', 'local_drafts', 'local_annotations', 'local_audit_log'];

/** Everything that must not change when a read-only operation is attacked. */
function fingerprint(db: DatabaseSync): string {
  const schema = JSON.stringify(db.prepare('SELECT type, name, tbl_name FROM sqlite_schema ORDER BY type, name').all());
  const counts = TABLES.map((t) => `${t}=${String(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.['n'])}`).join(',');
  const changes = String(db.prepare('SELECT total_changes() AS n').get()?.['n']);
  return `${schema}|${counts}|changes=${changes}`;
}

function isCode(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

function ids(page: { items: Array<{ messageId: string }> }): string[] {
  return page.items.map((h) => h.messageId).sort();
}

describe('plain mode: hostile queries are inert', () => {
  const HOSTILE = [
    '"', '""', '"unbalanced', 'unbalanced"', '"a" "b', '(', ')', '((a', 'a)', '()', 'a OR b', 'a AND b', 'a NOT b', 'NEAR(a b)', 'NEAR(', 'NEAR/3', 'a AND',
    'OR a', '*', '**', '*a', 'a*b', 'a**', '"a"*"b"', 'col:val', 'search_text:alpha', 'search_text : alpha', 'rowid:1', '-a', 'a -b', '^a', '^ a', '{a b}', '{a}: b',
    'a + b', 'a, b', "'", "''", "'; DROP TABLE messages;--", '"; DROP TABLE messages;--', '" OR 1=1 --', "x') UNION SELECT * FROM source_batches --", '\\', '\\"', '%',
    '_', 'a%', 'a_b', '/* comment */', '-- comment', 'a;b', '<script>alert(1)</script>', '${jndi:ldap://x}', '`rm -rf /`', '$(whoami)', 'a\tb\nc', LONE_SURROGATE,
    LINE_SEPARATOR, '\u{1F600}', 'ALPHA', 'alpha*', '"alpha beta"*', "alpha' OR '1'='1", 'MATCH', 'messages_fts MATCH alpha', "') ; ATTACH DATABASE ':memory:' AS evil; --",
  ];

  it('every hostile string either searches harmlessly or is rejected as INVALID_ARGUMENT - never any other error - and nothing is written', async () => {
    const { db } = await setup();
    const before = fingerprint(db);
    for (const q of HOSTILE) {
      try {
        const page = searchMessages(db, { query: q });
        assert.ok(Array.isArray(page.items), JSON.stringify(q));
        const titles = searchConversationTitles(db, { query: q });
        assert.ok(Array.isArray(titles.items));
      } catch (e) {
        assert.ok(e instanceof GcrError, `${JSON.stringify(q)}: ${String(e)}`);
        assert.equal(e.code, 'INVALID_ARGUMENT', JSON.stringify(q));
        assert.ok(!e.message.includes(q) || q.length < 2, 'the query text is never echoed');
      }
    }
    assert.equal(fingerprint(db), before);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.['integrity_check'], 'ok');
    assert.equal(searchMessages(db, { query: 'alpha' }).items.length > 0, true, 'the connection is still healthy');
  });

  it('operators are plain words, not FTS5 syntax (negative proof for OR, NOT, NEAR, -, ^, column filters, prefix inside a word)', async () => {
    const { db } = await setup();
    const q = (query: string) => ids(searchMessages(db, { query }));
    // "alpha OR beta": if OR were an operator, 'alpha only' would match; as a word it must also contain "or" (only 'a or b together' has or, but lacks alpha)
    assert.deepEqual(q('alpha OR beta'), []);
    assert.deepEqual(q('a OR b'), ['c1-m4']);
    // NEAR is a word: only the message that literally contains "near" matches
    assert.deepEqual(q('NEAR(alpha beta)'), ['c1-m5']);
    // "-beta" must NOT exclude: it requires alpha AND beta
    assert.deepEqual(q('alpha -beta'), ['c1-m0', 'c1-m3', 'c1-m5']);
    assert.deepEqual(q('^alpha'), q('alpha'));
    // a column filter is not a filter: tokens search, text and alpha must all be present
    assert.deepEqual(q('search_text:alpha'), ['c1-m7']);
    assert.deepEqual(q('alp*ha'), [], 'alp* AND ha: no message has a "ha" token');
    // injection-looking text is just words that happen to be present in the corpus
    assert.deepEqual(q('DROP TABLE messages'), ['c1-m8']);
    assert.deepEqual(q("'; DROP TABLE messages;--"), ['c1-m8']);
  });

  it('enforces size limits: 2000 characters, 32 terms, 128 tokens', async () => {
    const { db } = await setup();
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    assert.doesNotThrow(() => searchMessages(db, { query: words(32) }));
    assert.throws(() => searchMessages(db, { query: words(33) }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: `"${words(129)}"` }), isCode('INVALID_ARGUMENT'));
    assert.doesNotThrow(() => searchMessages(db, { query: `"${words(60)}"` }));
    assert.throws(() => searchMessages(db, { query: 'a'.repeat(MAX_QUERY_CHARS + 1) }), isCode('INVALID_ARGUMENT'));
    assert.doesNotThrow(() => searchMessages(db, { query: 'a'.repeat(MAX_QUERY_CHARS) }));
    assert.throws(() => searchMessages(db, { query: `${'a'.repeat(MAX_QUERY_CHARS)}b`, mode: 'raw' }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: `alpha${NUL}beta` }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: `alpha${NUL}beta`, mode: 'raw' }), isCode('INVALID_ARGUMENT'));
  });

  it('arbitrary Unicode query strings never produce anything but a result page or INVALID_ARGUMENT (property)', async () => {
    const { db } = await setup();
    const pool = ['a', 'b', 'Z', '1', ' ', '"', '*', '(', ')', ':', '-', '^', '+', ',', "'", ';', '\\', '日', '本', 'é', 'ς', '\u0301', '\u{1F600}', '\u200D', 'NEAR', 'OR', 'AND', 'NOT', '{', '}', '%', '_'];
    const arb = fc.array(fc.constantFrom(...pool), { maxLength: 30 }).map((a) => a.join(''));
    const before = fingerprint(db);
    runProperty(
      fc.property(arb, (q) => {
        try {
          searchMessages(db, { query: q });
        } catch (e) {
          assert.ok(e instanceof GcrError && e.code === 'INVALID_ARGUMENT', `${JSON.stringify(q)}: ${String(e)}`);
        }
      }),
    );
    assert.equal(fingerprint(db), before);
  });
});

describe('raw mode', () => {
  it('passes real FTS5 syntax through (operators, prefix, phrases, NEAR, column filters, initial token)', async () => {
    const { db } = await setup();
    const q = (query: string) => ids(searchMessages(db, { query, mode: 'raw' }));
    assert.deepEqual(q('alpha NOT beta'), ['c1-m1', 'c1-m7']);
    assert.deepEqual(q('only AND (alpha OR beta)'), ['c1-m1', 'c1-m2']);
    assert.deepEqual(q('quick + brown'), ['c1-m6']);
    assert.deepEqual(q('"quick brown"'), ['c1-m6']);
    assert.deepEqual(q('NEAR(quick fox, 3)'), ['c1-m6']);
    assert.deepEqual(q('NEAR(quick fox, 0)'), []);
    assert.deepEqual(q('alp*'), q('alpha'));
    assert.deepEqual(q('search_text : alpha'), q('alpha'));
    assert.deepEqual(q('^alpha'), ['c1-m0', 'c1-m1']);
    assert.deepEqual(q('alpha or beta'), [], 'lower-case "or" is a word, only upper-case operators are operators');
  });

  it('applies the same Unicode handling as plain mode (diacritic folding, CJK phrases and prefixes)', async () => {
    const { db } = await setup();
    const q = (query: string) => ids(searchMessages(db, { query, mode: 'raw' }));
    assert.deepEqual(q('Café'), ['c2-m1']);
    assert.deepEqual(q('Αθήνα'), ['c2-m2']);
    assert.deepEqual(q('"日本語"'), ['c2-m0']);
    assert.deepEqual(q('日本*'), ['c2-m0']);
    assert.deepEqual(q('"語日"'), []);
  });

  it('maps every FTS5 syntax error to FTS_SYNTAX_ERROR with a fixed message that leaks neither SQLite text nor the query', async () => {
    const { db } = await setup();
    const before = fingerprint(db);
    const BAD = ['"abc', '(a', 'a AND', 'NEAR(', 'foo:bar', 'title:alpha', '*', '^', 'a; DROP TABLE messages', 'x" OR 1=1 --', ')', 'AND', 'NEAR(a b, x)'];
    for (const query of BAD) {
      assert.throws(
        () => searchMessages(db, { query, mode: 'raw' }),
        (e) => {
          assert.ok(e instanceof GcrError, `${JSON.stringify(query)}: ${String(e)}`);
          assert.equal(e.code, 'FTS_SYNTAX_ERROR', JSON.stringify(query));
          assert.equal(e.exitCode, EXIT_CODES.FTS_SYNTAX_ERROR);
          const text = JSON.stringify(e.toEnvelope());
          assert.doesNotMatch(text, /fts5:|syntax error|unterminated|no such column|near "/i, 'no SQLite text');
          if (query.length >= 5) assert.ok(!text.includes(query), 'the query text is not echoed');
          return true;
        },
        JSON.stringify(query),
      );
      assert.throws(() => searchConversationTitles(db, { query, mode: 'raw' }), isCode('FTS_SYNTAX_ERROR'), JSON.stringify(query));
    }
    assert.equal(fingerprint(db), before);
    assert.equal(searchMessages(db, { query: 'alpha', mode: 'raw' }).items.length > 0, true, 'the connection survives a syntax error');
  });

  it('rejects empty raw queries and unknown modes with INVALID_ARGUMENT', async () => {
    const { db } = await setup();
    for (const query of ['', '   ', '\u0301']) assert.throws(() => searchMessages(db, { query, mode: 'raw' }), isCode('INVALID_ARGUMENT'), JSON.stringify(query));
    assert.throws(() => searchMessages(db, { query: 'a', mode: 'regex' as never }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: 'a', mode: 5 as never }), isCode('INVALID_ARGUMENT'));
  });

  it('arbitrary raw strings only ever yield results, INVALID_ARGUMENT or FTS_SYNTAX_ERROR (property)', async () => {
    const { db } = await setup();
    const pool = ['alpha', 'beta', ' ', '"', '*', '(', ')', ':', '-', '^', '+', ',', ';', "'", 'AND', 'OR', 'NOT', 'NEAR', '{', '}', '日', 'é', '0', '3', '\u{1F600}', 'search_text'];
    const arb = fc.array(fc.constantFrom(...pool), { maxLength: 14 }).map((a) => a.join(''));
    const before = fingerprint(db);
    runProperty(
      fc.property(arb, (q) => {
        try {
          searchMessages(db, { query: q, mode: 'raw' });
        } catch (e) {
          assert.ok(e instanceof GcrError && (e.code === 'INVALID_ARGUMENT' || e.code === 'FTS_SYNTAX_ERROR'), `${JSON.stringify(q)}: ${String(e)}`);
        }
      }),
    );
    assert.equal(fingerprint(db), before);
  });
});

describe('SQL injection through every string parameter', () => {
  const PAYLOADS = [
    "' OR '1'='1",
    "'; DROP TABLE messages;--",
    '" OR ""="',
    "x' UNION SELECT batch_id, seq, provider, account_label, provenance, completeness, source_kind, source_label, input_sha256 FROM source_batches--",
    '%',
    '_',
    '\\',
    "1; ATTACH DATABASE '/tmp/gcr-evil.sqlite' AS evil;--",
    "'; PRAGMA writable_schema=ON;--",
    `a${LINE_SEPARATOR}b`,
    '\u{1F600}',
    '日本語',
    '',
  ];

  it('filters of searchMessages are compared literally: no payload widens, errors or writes', async () => {
    const { db } = await setup();
    const before = fingerprint(db);
    const baseline = searchMessages(db, { query: 'alpha' }).items.length;
    assert.ok(baseline > 0);
    for (const field of ['provider', 'accountLabel', 'conversationId', 'role', 'channel'] as const) {
      for (const payload of PAYLOADS) {
        const page = searchMessages(db, { query: 'alpha', [field]: payload });
        assert.equal(page.items.length, 0, `${field}=${JSON.stringify(payload)} must match nothing`);
        assert.equal(searchMessages(db, { query: 'alpha', mode: 'raw', [field]: payload }).items.length, 0);
      }
      assert.throws(() => searchMessages(db, { query: 'alpha', [field]: `x${NUL}y` }), isCode('INVALID_ARGUMENT'));
    }
    assert.equal(fingerprint(db), before);
  });

  it('titles, listConversations and all lookups treat payloads as plain data', async () => {
    const { db, repo } = await setup();
    const before = fingerprint(db);
    for (const payload of PAYLOADS) {
      assert.equal(searchConversationTitles(db, { query: 'title', provider: payload }).items.length, 0);
      assert.equal(searchConversationTitles(db, { query: 'title', accountLabel: payload }).items.length, 0);
      assert.equal(repo.listConversations({ provider: payload }).total, 0);
      assert.equal(repo.listConversations({ accountLabel: payload }).total, 0);
      try {
        const r = repo.listConversations({ titleQuery: payload });
        assert.ok((r.total ?? 0) <= 2);
      } catch (e) {
        assert.ok(e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
      }
      if (payload !== '') {
        assert.deepEqual(repo.resolveConversation({ conversationId: payload }).matches, []);
        assert.deepEqual(repo.resolveConversation({ conversationId: 'c1', provider: payload as never }).matches, []);
        assert.deepEqual(repo.resolveConversation({ conversationId: 'c1', accountLabel: payload }).matches, []);
        assert.deepEqual(repo.resolveConversation({ conversationId: 'c1', batchId: payload }).matches, []);
        assert.equal(repo.getConversation({ conversationId: payload }), null);
        assert.equal(repo.getMessage({ conversationId: payload }, 'c1-m0'), null);
        assert.equal(repo.getMessage({ conversationId: 'c1' }, payload), null);
        assert.equal(repo.getBatch(payload), null);
      }
    }
    assert.equal(fingerprint(db), before);
    for (const bad of [`a${NUL}b`]) {
      assert.throws(() => repo.listConversations({ provider: bad }), isCode('INVALID_ARGUMENT'));
      assert.throws(() => repo.getConversation({ conversationId: bad }), isCode('INVALID_ARGUMENT'));
      assert.throws(() => repo.getBatch(bad), isCode('INVALID_ARGUMENT'));
    }
  });

  it('the unfiltered baseline proves the filters really constrain (positive control)', async () => {
    const { db, repo } = await setup();
    assert.equal(searchMessages(db, { query: 'alpha', provider: 'chatgpt' }).items.length, searchMessages(db, { query: 'alpha' }).items.length);
    assert.equal(searchMessages(db, { query: 'alpha', role: 'user' }).items.length < searchMessages(db, { query: 'alpha' }).items.length, true);
    assert.equal(repo.getConversation({ conversationId: 'c1' })?.id, 'c1');
  });

  it('hostile values stored through the import path are stored literally and cannot alter the schema', async () => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const before = JSON.stringify(h.db.prepare('SELECT type, name FROM sqlite_schema ORDER BY type, name').all());
    const p = "'); DROP TABLE messages; --";
    const rec = conv(p, [p, `Robert'); DROP TABLE conversations;-- ${p}`], { title: p, accountLabel: p, sourceUri: p });
    await repo.importBatch({ batch: { ...META, accountLabel: p, sourceLabel: p, contentDigest: p, toolVersion: p }, conversations: [rec] });
    assert.equal(JSON.stringify(h.db.prepare('SELECT type, name FROM sqlite_schema ORDER BY type, name').all()), before);
    assert.deepEqual(repo.getConversation({ conversationId: p, accountLabel: p }), rec);
    assert.equal(searchMessages(h.db, { query: 'Robert', accountLabel: p }).items.length, 1);
    assert.equal(searchMessages(h.db, { query: 'robert', conversationId: p }).items[0]?.conversationTitle, p);
    assert.equal(h.db.prepare('PRAGMA integrity_check').get()?.['integrity_check'], 'ok');
  });
});

describe('cursor tampering', () => {
  async function firstCursor(): Promise<{ db: DatabaseSync; cursor: string; fpOf: () => { v: number; f: string; k: unknown[] } }> {
    const { db } = await setup();
    const page = searchMessages(db, { query: 'alpha', limit: 1 });
    const cursor = page.nextCursor;
    assert.ok(cursor, 'a second page exists');
    const decode = () => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v: number; f: string; k: unknown[] };
    return { db, cursor, fpOf: decode };
  }

  const encode = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

  it('accepts its own cursor (positive control) and the next page continues exactly after the first', async () => {
    const { db, cursor } = await firstCursor();
    const all = searchMessages(db, { query: 'alpha', limit: 50 }).items.map((h) => h.messageId);
    const second = searchMessages(db, { query: 'alpha', limit: 2, cursor });
    assert.deepEqual(second.items.map((h) => h.messageId), all.slice(1, 3));
    // the page size may differ between requests
    assert.deepEqual(searchMessages(db, { query: 'alpha', limit: 5, cursor }).items.map((h) => h.messageId), all.slice(1, 6));
  });

  it('rejects malformed, truncated, foreign and mismatched cursors with INVALID_ARGUMENT, without echoing them', async () => {
    const { db, cursor, fpOf } = await firstCursor();
    const good = fpOf();
    const variants: Array<[string, string]> = [
      ['not base64url', '!!!not-base64!!!'],
      ['base64 of garbage', Buffer.from('not json at all').toString('base64url')],
      ['json null', encode(null)],
      ['json array', encode([1, 2, 3])],
      ['json number', encode(7)],
      ['wrong version', encode({ ...good, v: 2 })],
      ['missing fingerprint', encode({ v: 1, k: good.k })],
      ['foreign fingerprint', encode({ ...good, f: '0000000000000000' })],
      ['short key', encode({ ...good, k: good.k.slice(0, 7) })],
      ['long key', encode({ ...good, k: [...good.k, 'x'] })],
      ['rank is a string', encode({ ...good, k: ['0.5', ...good.k.slice(1)] })],
      ['null flag out of range', encode({ ...good, k: [good.k[0], 2, ...good.k.slice(2)] })],
      ['string field is a number', encode({ ...good, k: [good.k[0], good.k[1], 5, ...good.k.slice(3)] })],
      ['string field is an object', encode({ ...good, k: [good.k[0], good.k[1], {}, ...good.k.slice(3)] })],
      ['infinite rank', Buffer.from(`{"v":1,"f":"${good.f}","k":[1e999,0,"","a","b","c","d","e"]}`).toString('base64url')],
      ['nul in field', encode({ ...good, k: [good.k[0], good.k[1], good.k[2], `x${NUL}y`, ...good.k.slice(4)] })],
      ['oversized', 'A'.repeat(5000)],
      ['truncated real cursor', cursor.slice(0, Math.floor(cursor.length / 2))],
      ['padded with garbage', cursor + '!!'],
    ];
    for (const [label, bad] of variants) {
      assert.throws(
        () => searchMessages(db, { query: 'alpha', cursor: bad }),
        (e) => {
          assert.ok(e instanceof GcrError, label);
          assert.equal(e.code, 'INVALID_ARGUMENT', label);
          assert.ok(!JSON.stringify(e.toEnvelope()).includes(bad.slice(0, 12)) || bad.length < 12, 'cursor not echoed');
          return true;
        },
        label,
      );
    }
  });

  it('a cursor only works for the exact query and filters it was issued for, and not together with an offset', async () => {
    const { db, cursor } = await firstCursor();
    assert.throws(() => searchMessages(db, { query: 'beta', cursor }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: 'alpha', role: 'user', cursor }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: 'alpha', allBatches: true, cursor }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: 'alpha', mode: 'raw', cursor }), isCode('INVALID_ARGUMENT'));
    assert.throws(() => searchMessages(db, { query: 'alpha', cursor, offset: 1 }), isCode('INVALID_ARGUMENT'));
    assert.doesNotThrow(() => searchMessages(db, { query: 'alpha', cursor, offset: 0 }));
    assert.doesNotThrow(() => searchMessages(db, { query: 'alpha', cursor, limit: 7 }));
  });

  it('SQL text planted in the key fields of a validly-fingerprinted cursor is only ever a bound parameter', async () => {
    const { db, fpOf } = await firstCursor();
    const good = fpOf();
    const before = fingerprint(db);
    for (const payload of ["'; DROP TABLE messages;--", "' OR '1'='1", '%', '日本語']) {
      const forged = encode({ ...good, k: [good.k[0], good.k[1], payload, payload, payload, payload, payload, payload] });
      const page = searchMessages(db, { query: 'alpha', cursor: forged });
      assert.ok(Array.isArray(page.items));
    }
    // extreme ranks are fine numerically
    for (const rank of [1e308, -1e308, 0, -0.0000001]) {
      assert.doesNotThrow(() => searchMessages(db, { query: 'alpha', cursor: encode({ ...good, k: [rank, ...good.k.slice(1)] }) }));
    }
    assert.equal(fingerprint(db), before);
  });
});
