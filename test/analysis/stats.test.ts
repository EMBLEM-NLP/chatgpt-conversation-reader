/**
 * Tests for src/analysis/stats.ts: every groupBy, filters, head-vs-all-batches counting, model honesty (FR-16),
 * totals/pagination bookkeeping and honest-scope warnings. Synthetic data only; databases are built through the real
 * Repository.importBatch.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { computeStats, STATS_GROUP_BY, UNKNOWN_MODEL_LABEL } from '../../src/analysis/stats.js';
import type { StatsGroupBy, StatsOptions, StatsResult } from '../../src/analysis/stats.js';
import type { Repository } from '../../src/db/repo.js';
import { chat, claudeChat, fresh, importAll, iso } from './support.test.js';

interface Sample {
  db: DatabaseSync;
  repo: Repository;
}

/**
 * Visible (non-hidden, non-structural) messages: c1/default 4, c2 3, c3 (claude) 2, c1/other 1 = 10; plus one hidden system
 * message in c1/default. Texts: c1 5+8+5+2 = 20 chars, c2 3, c3 7+5 = 12, c1/other 1; hidden text has 15 chars.
 */
async function sampleDb(): Promise<Sample> {
  const { db, repo } = fresh();
  const c1 = chat(
    'c1',
    [
      { role: 'user', text: 'hello', at: '2025-01-01T10:00:00Z', contentType: 'text' },
      { role: 'assistant', text: 'hi there', model: 'gpt-x', at: '2025-01-01T10:00:05.000Z', channel: 'final' },
      { role: 'user', text: 'again', at: '2025-01-02T09:00:00.000Z' },
      { role: 'assistant', text: 'ok', model: null, at: '2025-01-02T09:00:01Z', channel: 'analysis' },
      { role: 'system', text: 'secret scaffold', hidden: true, at: null, contentType: 'user_editable_context' },
    ],
    { defaultModelSlug: 'gpt-default', title: 'First chat' },
  );
  const c2 = chat(
    'c2',
    [
      { role: 'user', text: 'q', at: '2025-01-03T00:00:00Z' },
      { role: 'assistant', text: 'a', model: 'gpt-y', at: '2025-01-03T00:00:01Z', channel: 'final' },
      { role: 'assistant', text: 'b', model: '  ', at: '2025-01-03T00:00:02Z' },
    ],
    { title: null },
  );
  const c3 = claudeChat('c3', [
    { role: 'user', text: 'bonjour', at: '2025-01-01T11:00:00Z' },
    { role: 'assistant', text: 'salut', at: '2025-01-01T11:00:01Z' },
  ]);
  const c4 = chat('c1', [{ role: 'weird-role', text: 'x', at: '2025-01-05T00:00:00Z' }], { accountLabel: 'other', title: 'Same id other account' });
  await importAll(repo, [c1, c2, c3, c4]);
  return { db, repo };
}

function pairs(r: StatsResult): Array<[string | null, number]> {
  return r.rows.map((row) => [row.key, row.messages]);
}

describe('computeStats: every groupBy', () => {
  it('role: counts per role, ordered by messages DESC then key ASC; unknown roles are reported verbatim', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(pairs(r), [
      ['assistant', 5],
      ['user', 4],
      ['weird-role', 1],
    ]);
    assert.deepEqual(r.rows.map((x) => x.label), ['assistant', 'user', 'weird-role']);
    assert.equal(r.groupBy, 'role');
    assert.equal(r.tz, undefined, 'tz is only reported for the day grouping');
    assert.deepEqual(r.totals, { messages: 10, conversations: 4, characters: 36 });
  });

  it('role: structural_empty nodes are never counted, hidden ones only with includeHidden', async () => {
    const { db } = await sampleDb();
    const visible = computeStats(db, { groupBy: 'role' });
    assert.ok(!visible.rows.some((x) => x.key === '' || x.key === 'system'), 'no structural (role "") and no hidden system row');
    const all = computeStats(db, { groupBy: 'role', includeHidden: true });
    assert.deepEqual(pairs(all), [
      ['assistant', 5],
      ['user', 4],
      ['system', 1],
      ['weird-role', 1],
    ]);
    assert.equal(all.totals.messages, 11);
    assert.equal(all.totals.characters, 36 + 'secret scaffold'.length);
  });

  it('model: explicit slugs are separate rows; everything else is ONE null row labelled "unknown (not supplied by source)"', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'model' });
    assert.deepEqual(pairs(r), [
      [null, 8],
      ['gpt-x', 1],
      ['gpt-y', 1],
    ]);
    assert.equal(r.rows[0]?.label, UNKNOWN_MODEL_LABEL);
    assert.equal(UNKNOWN_MODEL_LABEL, 'unknown (not supplied by source)');
    assert.equal(r.rows[1]?.label, 'gpt-x');
  });

  it('model honesty: conversation default_model_slug and neighbouring messages never fill in a model; a blank slug is unknown', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'model' });
    // c1 has defaultModelSlug "gpt-default" and its assistant message "ok" has no model: it must stay unknown.
    assert.ok(!r.rows.some((x) => x.key === 'gpt-default'), 'default_model_slug is never attributed to messages');
    // c2's "  " slug is whitespace-only: no identity, so it is unknown, not a model called "  ".
    assert.ok(!r.rows.some((x) => x.key !== null && x.key.trim() === ''));
    const p = r.modelProvenance;
    assert.equal(p.messagesWithModel, 2);
    assert.equal(p.messagesWithoutModel, 8);
    assert.equal(p.assistantMessagesWithModel, 2);
    assert.equal(p.assistantMessagesWithoutModel, 3, 'c1 "ok", c2 blank slug, c3 claude assistant');
    assert.equal(p.distinctModels, 2);
    assert.match(p.note, /never inferred/);
    assert.equal(p.messagesWithModel + p.messagesWithoutModel, r.totals.messages);
  });

  it('model honesty: a conversation whose messages all lack a model reports only the unknown row even if it has a default model', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('only', [{ role: 'user' }, { role: 'assistant' }], { defaultModelSlug: 'the-default' })]);
    const r = computeStats(db, { groupBy: 'model' });
    assert.deepEqual(pairs(r), [[null, 2]]);
    assert.equal(r.modelProvenance.distinctModels, 0);
    assert.equal(r.modelProvenance.assistantMessagesWithModel, 0);
  });

  it('channel: null channel is its own labelled row', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'channel' });
    assert.deepEqual(pairs(r), [
      [null, 7],
      ['final', 2],
      ['analysis', 1],
    ]);
    assert.equal(r.rows[0]?.label, '(no channel)');
  });

  it('content_type: null (Claude has none) is its own row; hidden types appear only with includeHidden', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'content_type' });
    assert.deepEqual(pairs(r), [
      ['text', 8],
      [null, 2],
    ]);
    const all = computeStats(db, { groupBy: 'content_type', includeHidden: true });
    assert.ok(all.rows.some((x) => x.key === 'user_editable_context' && x.messages === 1));
  });

  it('provider: one row per provider', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'provider' });
    assert.deepEqual(pairs(r), [
      ['chatgpt', 8],
      ['claude', 2],
    ]);
  });

  it('conversation: the same id under two accounts is two rows carrying their scope; label is the title (id when untitled)', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'conversation' });
    assert.deepEqual(
      r.rows.map((x) => [x.key, x.provider, x.accountLabel, x.messages, x.label]),
      [
        ['c1', 'chatgpt', 'default', 4, 'First chat'],
        ['c2', 'chatgpt', 'default', 3, 'c2'],
        ['c3', 'claude', 'default', 2, 'Title of c3'],
        ['c1', 'chatgpt', 'other', 1, 'Same id other account'],
      ],
    );
    assert.deepEqual(r.rows.map((x) => x.conversations), [1, 1, 1, 1]);
  });

  it('conversation: very long titles are truncated in the label', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('long', [{ role: 'user' }], { title: 'T'.repeat(5000) })]);
    const label = computeStats(db, { groupBy: 'conversation' }).rows[0]?.label ?? '';
    assert.ok(label.length <= 201, `label has ${label.length} chars`);
    assert.ok(label.endsWith('…'));
  });

  it('every groupBy is covered and the sums of rows equal the totals (full page)', async () => {
    const { db } = await sampleDb();
    for (const groupBy of STATS_GROUP_BY) {
      const r = computeStats(db, { groupBy, includeHidden: true });
      assert.equal(r.nextOffset, null, groupBy);
      assert.equal(r.rows.reduce((n, x) => n + x.messages, 0), r.totals.messages, `${groupBy}: messages`);
      assert.equal(r.rows.reduce((n, x) => n + x.characters, 0), r.totals.characters, `${groupBy}: characters`);
    }
    assert.equal(STATS_GROUP_BY.length, 7);
  });
});

describe('computeStats: counting details', () => {
  it('characters are Unicode code points, not UTF-16 units or bytes', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('u', [{ role: 'user', text: '\u{1F600}\u{1F600}a' }, { role: 'assistant', text: '日本語' }])]);
    const r = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(r.rows.map((x) => [x.key, x.characters]), [
      ['assistant', 3],
      ['user', 3],
    ]);
    assert.equal(r.totals.characters, 6);
  });

  it('firstAt/lastAt are instants in millisecond spelling even when stored with and without ".000"', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'conversation' });
    const c1 = r.rows.find((x) => x.key === 'c1' && x.accountLabel === 'default');
    assert.equal(c1?.firstAt, '2025-01-01T10:00:00.000Z');
    assert.equal(c1?.lastAt, '2025-01-02T09:00:01.000Z');
  });

  it('firstAt/lastAt compare "...:05Z" and "...:05.000Z" as the same instant (string order would not)', async () => {
    const { db, repo } = fresh();
    // "...:05Z" sorts AFTER "...:05.000Z" as plain text ('Z' > '.'), yet both are the same instant; :04 and :06 bracket them.
    await importAll(repo, [
      chat('t', [
        { role: 'user', at: '2025-01-01T00:00:05Z' },
        { role: 'user', at: '2025-01-01T00:00:05.000Z' },
        { role: 'user', at: '2025-01-01T00:00:04.999Z' },
        { role: 'user', at: '2025-01-01T00:00:06Z' },
      ]),
    ]);
    const row = computeStats(db, { groupBy: 'role' }).rows[0];
    assert.equal(row?.firstAt, '2025-01-01T00:00:04.999Z');
    assert.equal(row?.lastAt, '2025-01-01T00:00:06.000Z');
  });

  it('a group whose messages all lack timestamps has null firstAt/lastAt', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('n', [{ role: 'user', at: null }, { role: 'user', at: null }])]);
    const row = computeStats(db, { groupBy: 'role' }).rows[0];
    assert.equal(row?.messages, 2);
    assert.equal(row?.firstAt, null);
    assert.equal(row?.lastAt, null);
  });

  it('a conversation with only a structural root contributes nothing', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('empty', [])]);
    const r = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.totals, { messages: 0, conversations: 0, characters: 0 });
    assert.ok(r.warnings.some((w) => w.code === 'NO_MATCHING_MESSAGES'));
  });

  it('an empty database yields empty rows, zero totals and a NO_MATCHING_MESSAGES warning (not an error)', () => {
    const { db } = fresh();
    for (const groupBy of STATS_GROUP_BY) {
      const r = computeStats(db, { groupBy });
      assert.deepEqual(r.rows, [], groupBy);
      assert.equal(r.nextOffset, null);
      assert.deepEqual(r.totals, { messages: 0, conversations: 0, characters: 0 });
      assert.equal(r.modelProvenance.distinctModels, 0);
    }
  });

  it('accepts the Repository as well as the raw connection, with identical results', async () => {
    const { db, repo } = await sampleDb();
    assert.deepEqual(computeStats(repo, { groupBy: 'role' }), computeStats(db, { groupBy: 'role' }));
  });

  it('is deterministic: the same call twice gives deep-equal results', async () => {
    const { db } = await sampleDb();
    for (const groupBy of STATS_GROUP_BY) {
      assert.deepEqual(computeStats(db, { groupBy }), computeStats(db, { groupBy }), groupBy);
    }
  });
});

describe('computeStats: filters', () => {
  it('provider and accountLabel narrow the scope; an unknown value matches nothing (no error)', async () => {
    const { db } = await sampleDb();
    assert.deepEqual(computeStats(db, { groupBy: 'role', provider: 'claude' }).totals, { messages: 2, conversations: 1, characters: 12 });
    assert.equal(computeStats(db, { groupBy: 'role', accountLabel: 'other' }).totals.messages, 1);
    assert.equal(computeStats(db, { groupBy: 'role', provider: 'chatgpt', accountLabel: 'default' }).totals.messages, 7);
    const none = computeStats(db, { groupBy: 'role', provider: 'nobody' });
    assert.equal(none.totals.messages, 0);
    assert.ok(none.warnings.some((w) => w.code === 'NO_MATCHING_MESSAGES'));
  });

  it('role filters on the exact (case-sensitive) role string, including an unknown role', async () => {
    const { db } = await sampleDb();
    assert.equal(computeStats(db, { groupBy: 'provider', role: 'assistant' }).totals.messages, 5);
    assert.equal(computeStats(db, { groupBy: 'provider', role: 'weird-role' }).totals.messages, 1);
    assert.equal(computeStats(db, { groupBy: 'provider', role: 'Assistant' }).totals.messages, 0, 'roles are matched exactly');
    assert.equal(computeStats(db, { groupBy: 'provider', role: 'system' }).totals.messages, 0, 'hidden system message excluded by default');
    assert.equal(computeStats(db, { groupBy: 'provider', role: 'system', includeHidden: true }).totals.messages, 1);
  });

  it('date bounds: createdAfter is inclusive, createdBefore exclusive, compared as instants whatever the spelling', async () => {
    const { db } = await sampleDb();
    // Messages by time: Jan1 10:00:00 (stored WITHOUT ms), 10:00:05, 11:00:00, 11:00:01; Jan2 09:00:00, 09:00:01; Jan3 x3; Jan5 x1 (10 total).
    assert.equal(computeStats(db, { groupBy: 'role', createdAfter: '2025-01-01T10:00:00.000Z' }).totals.messages, 10, 'lower bound spelled with ms matches a stored value without ms');
    assert.equal(computeStats(db, { groupBy: 'role', createdAfter: '2025-01-01T10:00:00Z' }).totals.messages, 10, 'inclusive lower bound');
    assert.equal(computeStats(db, { groupBy: 'role', createdAfter: '2025-01-01T10:00:00.001Z' }).totals.messages, 9);
    assert.equal(computeStats(db, { groupBy: 'role', createdBefore: '2025-01-01T10:00:00Z' }).totals.messages, 0, 'exclusive upper bound');
    assert.equal(computeStats(db, { groupBy: 'role', createdBefore: '2025-01-01T10:00:00.001Z' }).totals.messages, 1);
    assert.equal(
      computeStats(db, { groupBy: 'role', createdAfter: '2025-01-02T00:00:00Z', createdBefore: '2025-01-04T00:00:00Z' }).totals.messages,
      5,
      'Jan 2 (2) + Jan 3 (3)',
    );
    assert.equal(computeStats(db, { groupBy: 'role', createdAfter: '2025-01-04T00:00:00Z', createdBefore: '2025-01-03T00:00:00Z' }).totals.messages, 0, 'empty window');
  });

  it('messages without a timestamp never match a bound, and the exclusion is reported', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'role', includeHidden: true, createdAfter: '2025-01-01T00:00:00Z' });
    assert.equal(r.totals.messages, 10, 'the hidden system message has no timestamp and is not counted');
    const w = r.warnings.find((x) => x.code === 'UNDATED_MESSAGES_EXCLUDED');
    assert.ok(w, 'warns about undated messages');
    assert.match(w.message, /^1 message/);
    // Without bounds there is nothing to warn about.
    assert.ok(!computeStats(db, { groupBy: 'role', includeHidden: true }).warnings.some((x) => x.code === 'UNDATED_MESSAGES_EXCLUDED'));
  });
});

describe('computeStats: head batches vs all batches', () => {
  async function twoSnapshots(headIsSecond: boolean): Promise<DatabaseSync> {
    const { db, repo } = fresh();
    const first = chat('x', [{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two', model: 'm-old' }], { updatedAt: iso(headIsSecond ? 10 : 30) });
    const second = chat(
      'x',
      [{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two', model: 'm-new' }, { role: 'user', text: 'three' }, { role: 'assistant', text: 'four' }],
      { updatedAt: iso(headIsSecond ? 30 : 10) },
    );
    await importAll(repo, [first], 'a');
    await importAll(repo, [second], 'b');
    return db;
  }

  it('default counts only the head batch (the newer snapshot): 4 messages, 1 conversation', async () => {
    const db = await twoSnapshots(true);
    const r = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(r.totals, { messages: 4, conversations: 1, characters: 'one'.length + 'two'.length + 'three'.length + 'four'.length });
    assert.ok(!r.warnings.some((w) => w.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED'));
    assert.deepEqual(pairs(computeStats(db, { groupBy: 'model' })), [[null, 3], ['m-new', 1]]);
  });

  it('allBatches also counts the superseded snapshot (6 messages) but the conversation is still counted once, with a warning', async () => {
    const db = await twoSnapshots(true);
    const r = computeStats(db, { groupBy: 'role', allBatches: true });
    assert.equal(r.totals.messages, 6);
    assert.equal(r.totals.conversations, 1);
    const w = r.warnings.find((x) => x.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED');
    assert.ok(w);
    assert.match(w.message, /^1 superseded/);
    assert.deepEqual(pairs(computeStats(db, { groupBy: 'model', allBatches: true })), [[null, 4], ['m-new', 1], ['m-old', 1]]);
  });

  it('the head is chosen by conversation updated_at, not by import order', async () => {
    const db = await twoSnapshots(false); // the SECOND import has the OLDER updated_at: the first snapshot stays the head
    assert.equal(computeStats(db, { groupBy: 'role' }).totals.messages, 2);
    assert.deepEqual(pairs(computeStats(db, { groupBy: 'model' })), [['m-old', 1], [null, 1]], 'tie on 1 message: key ASC, NULL last');
    assert.equal(computeStats(db, { groupBy: 'role', allBatches: true }).totals.messages, 6);
  });

  it('with a single snapshot allBatches adds nothing and raises no superseded warning', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('solo', [{ role: 'user' }])]);
    const r = computeStats(db, { groupBy: 'role', allBatches: true });
    assert.equal(r.totals.messages, 1);
    assert.ok(!r.warnings.some((w) => w.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED'));
  });

  it('re-importing identical input (idempotent) does not change any count', async () => {
    const { db, repo } = fresh();
    const rec = chat('same', [{ role: 'user' }, { role: 'assistant' }]);
    await importAll(repo, [rec], 'a');
    const before = computeStats(db, { groupBy: 'role', allBatches: true });
    await importAll(repo, [rec], 'a');
    assert.deepEqual(computeStats(db, { groupBy: 'role', allBatches: true }), before);
  });
});

describe('computeStats: pagination bookkeeping and warnings', () => {
  it('limit/offset/nextOffset walk the rows; totals describe ALL rows, not the page', async () => {
    const { db } = await sampleDb();
    const full = computeStats(db, { groupBy: 'conversation' });
    const p1 = computeStats(db, { groupBy: 'conversation', limit: 3 });
    assert.equal(p1.rows.length, 3);
    assert.equal(p1.nextOffset, 3);
    assert.deepEqual(p1.totals, full.totals);
    const p2 = computeStats(db, { groupBy: 'conversation', limit: 3, offset: 3 });
    assert.equal(p2.rows.length, 1);
    assert.equal(p2.nextOffset, null);
    assert.deepEqual([...p1.rows, ...p2.rows], full.rows);
    assert.equal(p2.limit, 3);
    assert.equal(p2.offset, 3);
    // Exactly-full last page: limit equal to the row count must not advertise a phantom next page.
    assert.equal(computeStats(db, { groupBy: 'conversation', limit: 4 }).nextOffset, null);
    assert.equal(computeStats(db, { groupBy: 'conversation', limit: 4, offset: 4 }).rows.length, 0);
  });

  it('INCOMPLETE_SOURCE warns (FR-09) when a snapshot is not an exported tree', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('partial', [{ role: 'user' }], { completeness: 'partial_user_supplied', provenance: 'user_supplied_copy' }), chat('full', [{ role: 'user' }])]);
    const r = computeStats(db, { groupBy: 'role' });
    const w = r.warnings.find((x) => x.code === 'INCOMPLETE_SOURCE');
    assert.ok(w);
    assert.match(w.message, /1 conversation snapshot/);
    assert.match(w.message, /partial_user_supplied: 1/);
    assert.deepEqual(w.ids, ['partial']);
    const onlyFull = computeStats(db, { groupBy: 'role', provider: 'claude' });
    assert.ok(!onlyFull.warnings.some((x) => x.code === 'INCOMPLETE_SOURCE'));
  });

  it('HIDDEN_MESSAGES_EXCLUDED reports what the default filter left out; includeHidden removes the warning', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'role' });
    const w = r.warnings.find((x) => x.code === 'HIDDEN_MESSAGES_EXCLUDED');
    assert.ok(w);
    assert.match(w.message, /^1 message/);
    assert.ok(!computeStats(db, { groupBy: 'role', includeHidden: true }).warnings.some((x) => x.code === 'HIDDEN_MESSAGES_EXCLUDED'));
  });

  it('warnings never contain message text', async () => {
    const { db } = await sampleDb();
    for (const groupBy of STATS_GROUP_BY) {
      const text = JSON.stringify(computeStats(db, { groupBy, includeHidden: groupBy === 'day' }).warnings);
      assert.ok(!text.includes('secret scaffold'));
      assert.ok(!text.includes('bonjour'));
    }
  });
});

describe('computeStats: result shape', () => {
  it('has exactly the documented top-level fields', async () => {
    const { db } = await sampleDb();
    const r = computeStats(db, { groupBy: 'role' });
    assert.deepEqual(Object.keys(r).sort(), ['groupBy', 'limit', 'modelProvenance', 'nextOffset', 'offset', 'rows', 'totals', 'warnings']);
    assert.deepEqual(Object.keys(r.rows[0] ?? {}).sort(), ['characters', 'conversations', 'firstAt', 'key', 'label', 'lastAt', 'messages']);
    assert.equal(r.limit, 100);
    assert.equal(r.offset, 0);
  });

  it('types: StatsOptions/StatsGroupBy are usable as declared', () => {
    const g: StatsGroupBy = 'day';
    const o: StatsOptions = { groupBy: g, tz: 'UTC', limit: 5 };
    assert.equal(o.groupBy, 'day');
  });
});
