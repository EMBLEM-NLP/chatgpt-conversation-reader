/**
 * Security and robustness tests for src/analysis/stats.ts: SQL-injection attempts through every string filter, hostile
 * values stored in the data itself, argument validation (no value is ever echoed), read-only operation and transaction
 * hygiene, and the absence of message text in the output. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { computeStats, STATS_GROUP_BY } from '../../src/analysis/stats.js';
import type { StatsOptions } from '../../src/analysis/stats.js';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import { GcrError } from '../../src/errors.js';
import { withTempDir } from '../helpers/tmp.js';
import { chat, claudeChat, countTable, fresh, importAll } from './support.test.js';

const INJECTIONS: readonly string[] = [
  "' OR 1=1 --",
  "x' OR '1'='1",
  "'; DROP TABLE messages; --",
  '" OR ""="',
  "') UNION SELECT author_role FROM messages --",
  '1; ATTACH DATABASE \'/tmp/gcr-evil.db\' AS evil; --',
  '%',
  '_',
  '*',
  '\\',
  "chatgpt' --",
  '‮evil',
  'robert\'); DROP TABLE conversations;--',
];

async function seeded(): Promise<ReturnType<typeof fresh>> {
  const f = fresh();
  await importAll(f.repo, [
    chat('s1', [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b', model: 'm' }]),
    claudeChat('s2', [{ role: 'user', text: 'c' }]),
    chat('s1', [{ role: 'user', text: 'd' }], { accountLabel: 'acct-2' }),
  ]);
  return f;
}

function isCode(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

describe('SQL injection through filters is harmless', () => {
  for (const field of ['provider', 'accountLabel', 'role'] as const) {
    it(`${field}: hostile strings are plain values that match nothing; the data stays intact`, async () => {
      const { db } = await seeded();
      const messagesBefore = countTable(db, 'messages');
      const conversationsBefore = countTable(db, 'conversations');
      for (const payload of INJECTIONS) {
        for (const groupBy of STATS_GROUP_BY) {
          const opts: StatsOptions = { groupBy, [field]: payload };
          const r = computeStats(db, opts);
          assert.equal(r.totals.messages, 0, `${field}=${JSON.stringify(payload)} groupBy=${groupBy} must match nothing (no "OR 1=1" effect)`);
          assert.deepEqual(r.rows, []);
        }
      }
      assert.equal(countTable(db, 'messages'), messagesBefore);
      assert.equal(countTable(db, 'conversations'), conversationsBefore);
      // The same call with a legitimate value still works afterwards.
      const legit = { provider: 'chatgpt', accountLabel: 'default', role: 'user' }[field];
      assert.ok(computeStats(db, { groupBy: 'role', [field]: legit }).totals.messages > 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'evil'").get()?.['n'], 0);
    });
  }

  it('LIKE wildcards are not wildcards: "%" and "_" do not match every provider / role (equality, not LIKE)', async () => {
    const { db } = await seeded();
    assert.equal(computeStats(db, { groupBy: 'role', provider: '%' }).totals.messages, 0);
    assert.equal(computeStats(db, { groupBy: 'role', provider: 'chatgp_' }).totals.messages, 0);
    assert.equal(computeStats(db, { groupBy: 'role', role: 'us%' }).totals.messages, 0);
    assert.equal(computeStats(db, { groupBy: 'role', accountLabel: 'acct-_' }).totals.messages, 0);
  });

  it('groupBy is an allow-list: injection strings and unknown names are INVALID_ARGUMENT, never interpolated', async () => {
    const { db } = await seeded();
    for (const bad of ['role; DROP TABLE messages', 'm.author_role', 'ROLE', '', 'role,model', "role' --", undefined, null, 5, {}]) {
      assert.throws(() => computeStats(db, { groupBy: bad as never }), isCode('INVALID_ARGUMENT'), JSON.stringify(bad));
    }
    assert.ok(countTable(db, 'messages') > 0);
  });
});

describe('hostile values stored in the data are reported as data', () => {
  it('SQL, quotes, newlines, bidi controls and "__proto__" as role / model / channel / content type / title', async () => {
    const { db, repo } = fresh();
    const evil = "'; DROP TABLE messages; --";
    await importAll(repo, [
      chat(
        'h1',
        [
          { role: evil, model: 'm"odel\nx', channel: '__proto__', contentType: '‮bidi', text: 'one' },
          { role: '__proto__', model: '__proto__', channel: 'constructor', contentType: 'toString', text: 'two' },
        ],
        { title: evil },
      ),
    ]);
    const before = countTable(db, 'messages');
    const role = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(role.rows.map((x) => x.key).sort(), [evil, '__proto__'].sort());
    const model = computeStats(db, { groupBy: 'model' });
    assert.deepEqual(model.rows.map((x) => x.key).sort(), ['__proto__', 'm"odel\nx']);
    assert.ok(computeStats(db, { groupBy: 'channel' }).rows.some((x) => x.key === '__proto__'));
    assert.ok(computeStats(db, { groupBy: 'content_type' }).rows.some((x) => x.key === 'toString'));
    assert.equal(computeStats(db, { groupBy: 'conversation' }).rows[0]?.label, evil);
    assert.equal(countTable(db, 'messages'), before);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'no prototype pollution');
    assert.equal(Object.getPrototypeOf(role.rows[0]), Object.prototype, 'rows are ordinary objects');
  });

  it('a role that is the empty string is reported verbatim (key "") with a readable label', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('e', [{ role: '' }])]);
    const r = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(r.rows.map((x) => [x.key, x.label]), [['', '(empty)']]);
  });
});

describe('argument validation', () => {
  it('rejects bad types, NUL bytes and over-long strings without echoing them', async () => {
    const { db } = await seeded();
    const secret = 'SECRET-VALUE-7731';
    const cases: Array<[string, unknown]> = [
      ['provider', 123],
      ['provider', `${secret}\0`],
      ['accountLabel', { toString: () => secret }],
      ['accountLabel', secret.repeat(100)],
      ['role', [secret]],
      ['role', true],
    ];
    for (const [field, value] of cases) {
      try {
        computeStats(db, { groupBy: 'role', [field]: value });
        assert.fail(`expected INVALID_ARGUMENT for ${field}`);
      } catch (e) {
        assert.ok(e instanceof GcrError && e.code === 'INVALID_ARGUMENT', `${field}: ${String(e)}`);
        assert.ok(!e.message.includes(secret), 'message does not echo the value');
        assert.ok(!JSON.stringify(e.toEnvelope()).includes(secret), 'envelope does not echo the value');
        assert.equal(e.details?.['field'], field);
      }
    }
  });

  it('limit, offset, booleans and timestamps are bounds-checked', async () => {
    const { db } = await seeded();
    const bad: Array<Partial<StatsOptions>> = [
      { limit: 0 },
      { limit: 1001 },
      { limit: 1.5 },
      { limit: -1 },
      { limit: '5' as never },
      { limit: Number.NaN },
      { offset: -1 },
      { offset: 0.5 },
      { offset: 10_000_001 },
      { includeHidden: 'yes' as never },
      { allBatches: 1 as never },
      { createdAfter: '2025-01-01' },
      { createdAfter: '2025-01-01 00:00:00' },
      { createdBefore: '2025-01-01T00:00:00+02:00' },
      { createdBefore: '2025-02-30T00:00:00Z' },
      { createdAfter: 20250101 as never },
    ];
    for (const extra of bad) {
      assert.throws(() => computeStats(db, { groupBy: 'role', ...extra }), isCode('INVALID_ARGUMENT'), JSON.stringify(extra));
    }
    for (const okOpts of [{ limit: 1 }, { limit: 1000 }, { offset: 0 }, { offset: 10_000_000 }, { createdAfter: '2025-01-01T00:00:00.123Z' }]) {
      assert.doesNotThrow(() => computeStats(db, { groupBy: 'role', ...okOpts }), JSON.stringify(okOpts));
    }
  });

  it('options must be an object', async () => {
    const { db } = await seeded();
    for (const bad of [null, undefined, 'role', 5, []]) {
      assert.throws(() => computeStats(db, bad as never), isCode('INVALID_ARGUMENT'));
    }
  });
});

describe('read-only operation and transaction hygiene', () => {
  it('works on a read-only connection (nothing needs to be written) and leaves no transaction open', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'ro.sqlite');
      const rw = openDatabase(path);
      await importAll(new Repository(rw.db), [chat('r1', [{ role: 'user', text: 'abc' }, { role: 'assistant', text: 'de', model: 'm' }])]);
      closeDatabase(rw);
      const ro = openDatabase(path, { readOnly: true });
      try {
        for (const groupBy of STATS_GROUP_BY) {
          const r = computeStats(ro.db, { groupBy, includeHidden: true });
          assert.equal(r.totals.messages, 2, groupBy);
          assert.equal(ro.db.isTransaction, false, `${groupBy}: no dangling transaction`);
        }
      } finally {
        closeDatabase(ro);
      }
    });
  });

  it('does not disturb a transaction the caller already opened', async () => {
    const { db } = await seeded();
    db.exec('BEGIN');
    try {
      const r = computeStats(db, { groupBy: 'role' });
      assert.ok(r.totals.messages > 0);
      assert.equal(db.isTransaction, true, 'the caller transaction is still open');
    } finally {
      db.exec('ROLLBACK');
    }
    assert.equal(db.isTransaction, false);
  });

  it('a failing call (bad options) leaves no transaction open either', async () => {
    const { db } = await seeded();
    assert.throws(() => computeStats(db, { groupBy: 'role', tz: 'No/Such' }), isCode('INVALID_ARGUMENT'));
    assert.equal(db.isTransaction, false);
  });

  it('a closed database yields a content-free DB_ERROR, not a raw exception', async () => {
    await withTempDir(async (dir) => {
      const h = openDatabase(join(dir, 'closed.sqlite'));
      closeDatabase(h);
      try {
        computeStats(h.db, { groupBy: 'role' });
        assert.fail('expected a throw');
      } catch (e) {
        assert.ok(e instanceof GcrError, String(e));
        assert.equal(e.code, 'DB_ERROR');
        assert.ok(!e.message.includes(dir), 'no absolute path in the message');
      }
    });
  });

  it('the imported tables are untouched by a stats run (row counts and head table)', async () => {
    const { db } = await seeded();
    const snapshot = (): string => JSON.stringify([countTable(db, 'messages'), countTable(db, 'conversations'), countTable(db, 'source_batches'), countTable(db, 'conversation_heads'), db.prepare('PRAGMA user_version').get()]);
    const before = snapshot();
    for (const groupBy of STATS_GROUP_BY) computeStats(db, { groupBy, allBatches: true, includeHidden: true });
    assert.equal(snapshot(), before);
  });
});

describe('message text never appears in the output', () => {
  it('a distinctive string planted in text, raw source and attachments is absent from every groupBy; titles appear only as conversation labels', async () => {
    const SECRET = 'ZZ-SECRET-PLANT-4f9a1c';
    const { db, repo } = fresh();
    const rec = chat('p1', [{ role: 'user', text: `${SECRET} in text` }, { role: 'assistant', text: 'plain', model: 'm' }], { title: `${SECRET} in title`, rawMetadata: { note: SECRET } });
    const first = rec.messages[1];
    assert.ok(first);
    first.rawSource = { leak: SECRET };
    first.attachments = [{ id: 'a1', name: `${SECRET}.png`, mimeType: 'image/png', sizeBytes: 1, assetPointer: null, presentInExportAs: null }];
    first.authorName = SECRET;
    await importAll(repo, [rec]);
    for (const groupBy of STATS_GROUP_BY) {
      const text = JSON.stringify(computeStats(db, { groupBy, includeHidden: true }));
      if (groupBy === 'conversation') {
        assert.ok(text.includes(`${SECRET} in title`), 'the conversation label is the title (documented, untrusted)');
        assert.ok(!text.includes('in text'), 'but never message text');
      } else {
        assert.ok(!text.includes(SECRET), `${groupBy} leaks nothing`);
      }
    }
  });
});
