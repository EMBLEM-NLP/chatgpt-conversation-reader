/**
 * Robustness tests: the analysis functions must degrade to explicit warnings, never crash or lie, when stored rows were
 * damaged outside GCR (the immutability trigger is dropped here ON PURPOSE to simulate a tampered file). Synthetic data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runAudit } from '../../src/analysis/audit.js';
import { computeStats, STATS_GROUP_BY } from '../../src/analysis/stats.js';
import { chat, fresh, importAll } from './support.test.js';

async function tampered(): Promise<ReturnType<typeof fresh>> {
  const f = fresh();
  await importAll(f.repo, [chat('dm', [{}, {}, {}]), chat('ok', [{}, {}])]);
  // The importer never produces these states; a hand-edited database could.
  f.db.exec('DROP TRIGGER messages_no_update');
  return f;
}

describe('damaged stored JSON', () => {
  it('an unreadable child list is reported (STORED_JSON_INVALID) and parent pointers are used; the audit completes', async () => {
    const { db } = await tampered();
    db.prepare('UPDATE messages SET child_ids_json = ? WHERE conversation_id = ? AND message_id = ?').run('this is not json', 'dm', 'dm-m0');
    const r = runAudit(db);
    const w = r.warnings.find((x) => x.code === 'STORED_JSON_INVALID');
    assert.ok(w, 'warns about the unreadable list');
    assert.match(w.message, /^1 conversation snapshot/);
    assert.equal(r.scanned.conversations, 2);
    assert.equal(r.findings.find((f) => f.check === 'tree_integrity')?.count, 1, 'the missing declaration shows up as a parent/child disagreement, not as silence');
    assert.equal(r.branchProvenance?.conversationsWithKnownActiveBranch, 2);
  });

  it('a child list of the wrong JSON type (numbers, object) is treated the same way', async () => {
    const { db } = await tampered();
    db.prepare('UPDATE messages SET child_ids_json = ? WHERE message_id = ?').run('[1, 2]', 'dm-m0');
    db.prepare('UPDATE messages SET child_ids_json = ? WHERE message_id = ?').run('{"a": 1}', 'ok-m0');
    const r = runAudit(db);
    const w = r.warnings.find((x) => x.code === 'STORED_JSON_INVALID');
    assert.ok(w);
    assert.match(w.message, /^2 conversation snapshot/);
  });
});

describe('damaged timestamps', () => {
  it('a created_at that is not strict ISO-8601 UTC is flagged as invalid by the audit and lands in the unknown day bucket', async () => {
    const { db } = await tampered();
    db.prepare('UPDATE messages SET created_at = ? WHERE message_id = ?').run('last tuesday', 'dm-m1');
    const audit = runAudit(db, { checks: ['timestamps'] });
    const f = audit.findings[0];
    assert.deepEqual(f?.byCode, { MESSAGE_CREATED_AT_INVALID: 1 });
    assert.equal(f?.severity, 'warn');
    assert.deepEqual(f?.sampleMessageIds, ['dm-m1']);

    const days = computeStats(db, { groupBy: 'day', tz: 'Asia/Tokyo' });
    const unknown = days.rows.find((x) => x.key === null);
    assert.equal(unknown?.messages, 1, 'the unparseable timestamp is not guessed onto a day');
    assert.equal(unknown?.label, 'unknown');
    assert.equal(days.totals.messages, 5);
  });

  it('every groupBy still runs on the tampered database', async () => {
    const { db } = await tampered();
    db.prepare('UPDATE messages SET created_at = ? WHERE message_id = ?').run('???', 'dm-m1');
    db.prepare('UPDATE messages SET child_ids_json = ? WHERE message_id = ?').run('nope', 'ok-m0');
    for (const groupBy of STATS_GROUP_BY) {
      const r = computeStats(db, { groupBy });
      assert.equal(r.totals.messages, 5, groupBy);
    }
  });
});
