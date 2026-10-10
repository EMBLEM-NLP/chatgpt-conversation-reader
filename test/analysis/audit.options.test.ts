/**
 * Tests for the option handling and scoping of src/analysis/audit.ts: check selection, sampleSize, provider / account
 * filters, head-vs-all-batches, honest-scope warnings, determinism, validation, SQL-injection resistance and
 * transaction hygiene. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AUDIT_CHECKS, runAudit } from '../../src/analysis/audit.js';
import type { AuditCheck, AuditOptions } from '../../src/analysis/audit.js';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { withTempDir } from '../helpers/tmp.js';
import { chat, claudeChat, countTable, fresh, importAll, iso, link, msg } from './support.test.js';

function isInvalid(e: unknown): boolean {
  return e instanceof GcrError && e.code === 'INVALID_ARGUMENT';
}

describe('audit: check selection', () => {
  it('returns only the selected checks, once each, in canonical order whatever order the caller used', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('a', [{}, {}], { title: null })]);
    const r = runAudit(db, { checks: ['hidden', 'untitled', 'hidden', 'missing_model'] });
    assert.deepEqual(r.findings.map((f) => f.check), ['missing_model', 'untitled', 'hidden']);
    for (const check of AUDIT_CHECKS) {
      const single = runAudit(db, { checks: [check] });
      assert.deepEqual(single.findings.map((f) => f.check), [check]);
    }
  });

  it('a selected check yields the same finding as in the full run (selection does not change results)', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('a', [{}, {}], { title: null }), chat('b', [{ role: 'function' }])]);
    const full = runAudit(db);
    for (const f of full.findings) {
      assert.deepEqual(runAudit(db, { checks: [f.check] }).findings, [f], f.check);
    }
  });

  it('rejects an empty list, unknown names, wrong types and injection-looking names', async () => {
    const { db } = fresh();
    const bad: unknown[] = [[], ['nope'], 'untitled', [5], [null], ['untitled', 'x'], ["untitled'; DROP TABLE messages; --"], ['UNTITLED'], {}, null];
    for (const checks of bad) {
      assert.throws(() => runAudit(db, { checks: checks as AuditCheck[] }), isInvalid, JSON.stringify(checks));
    }
  });
});

describe('audit: sampleSize and deterministic samples', () => {
  async function manyUntitled(): Promise<ReturnType<typeof fresh>> {
    const f = fresh();
    // Imported in REVERSE id order on purpose: samples must be the lowest ids, not the first imported.
    const recs: ConversationRecord[] = [];
    for (let i = 12; i >= 1; i--) recs.push(chat(`u${String(i).padStart(2, '0')}`, [{ role: 'assistant', model: null }], { title: null }));
    await importAll(f.repo, recs);
    return f;
  }

  it('default is 5 samples, lowest ids first', async () => {
    const { db } = await manyUntitled();
    const r = runAudit(db);
    const untitled = r.findings.find((f) => f.check === 'untitled');
    assert.equal(untitled?.count, 12);
    assert.deepEqual(untitled?.sampleConversationIds, ['u01', 'u02', 'u03', 'u04', 'u05']);
    const missing = r.findings.find((f) => f.check === 'missing_model');
    assert.deepEqual(missing?.sampleMessageIds, ['u01-m0', 'u02-m0', 'u03-m0', 'u04-m0', 'u05-m0']);
    assert.deepEqual(missing?.sampleConversationIds, ['u01', 'u02', 'u03', 'u04', 'u05']);
  });

  it('sampleSize 1 and 50 are honoured (never more than there are offenders)', async () => {
    const { db } = await manyUntitled();
    assert.deepEqual(runAudit(db, { checks: ['untitled'], sampleSize: 1 }).findings[0]?.sampleConversationIds, ['u01']);
    assert.equal(runAudit(db, { checks: ['untitled'], sampleSize: 50 }).findings[0]?.sampleConversationIds.length, 12);
    assert.deepEqual(runAudit(db, { checks: ['untitled'], sampleSize: 3 }).findings[0]?.sampleConversationIds, ['u01', 'u02', 'u03']);
  });

  it('the pass-based checks also keep the lowest ids when conversations arrive in another order', async () => {
    const { db, repo } = fresh();
    const recs: ConversationRecord[] = [];
    for (const id of ['z9', 'a1', 'm5', 'b2', 'y8', 'c3', 'x7']) recs.push(chat(id, [{}], { currentNodeId: null }));
    await importAll(repo, recs);
    const f = runAudit(db, { checks: ['no_current_node'], sampleSize: 4 }).findings[0];
    assert.deepEqual(f?.sampleConversationIds, ['a1', 'b2', 'c3', 'm5']);
  });

  it('rejects out-of-range or non-integer sampleSize', () => {
    const { db } = fresh();
    for (const sampleSize of [0, 51, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number, null as unknown as number]) {
      assert.throws(() => runAudit(db, { sampleSize }), isInvalid, String(sampleSize));
    }
  });
});

describe('audit: scoping filters', () => {
  async function multi(): Promise<ReturnType<typeof fresh>> {
    const f = fresh();
    await importAll(f.repo, [
      chat('g1', [{ role: 'assistant', model: null }], { title: null }),
      chat('g1', [{ role: 'assistant', model: 'x' }], { accountLabel: 'work' }),
      claudeChat('k1', [{ role: 'user' }, { role: 'assistant' }]),
    ]);
    return f;
  }

  it('provider and accountLabel narrow every count; the same conversation id in two accounts is audited separately', async () => {
    const { db } = await multi();
    const all = runAudit(db);
    assert.deepEqual(all.scanned, { conversations: 3, messages: 4 });
    const chatgptDefault = runAudit(db, { provider: 'chatgpt', accountLabel: 'default' });
    assert.deepEqual(chatgptDefault.scanned, { conversations: 1, messages: 1 });
    assert.equal(chatgptDefault.findings.find((f) => f.check === 'missing_model')?.count, 1);
    const work = runAudit(db, { accountLabel: 'work' });
    assert.deepEqual(work.scanned, { conversations: 1, messages: 1 });
    assert.equal(work.findings.find((f) => f.check === 'missing_model')?.count, 0);
    assert.deepEqual(runAudit(db, { provider: 'claude' }).scanned, { conversations: 1, messages: 2 });
  });

  it('unknown_content_types only ever looks at the chatgpt provider', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [claudeChat('k', [{ contentType: 'something_claude_specific' }])]);
    const f = runAudit(db).findings.find((x) => x.check === 'unknown_content_types');
    assert.equal(f?.count, 0);
    assert.equal(f?.total, 0);
  });

  it('a scope that matches nothing is explicit about it', async () => {
    const { db } = await multi();
    const r = runAudit(db, { provider: 'openai_api' });
    assert.deepEqual(r.scanned, { conversations: 0, messages: 0 });
    assert.ok(r.warnings.some((w) => w.code === 'NO_CONVERSATIONS_IN_SCOPE'));
  });

  it('SQL-injection payloads in provider / accountLabel are inert values: nothing matches and nothing is damaged', async () => {
    const { db } = await multi();
    const before = [countTable(db, 'messages'), countTable(db, 'conversations'), countTable(db, 'source_batches')];
    const payloads = ["' OR 1=1 --", "'; DROP TABLE messages; --", '" OR ""="', "') UNION SELECT 1 --", '%', '_', "chatgpt' --", '\\'];
    for (const payload of payloads) {
      for (const key of ['provider', 'accountLabel'] as const) {
        const r = runAudit(db, { [key]: payload });
        assert.deepEqual(r.scanned, { conversations: 0, messages: 0 }, `${key}=${payload}`);
        for (const f of r.findings) assert.equal(f.count, 0);
      }
    }
    assert.deepEqual([countTable(db, 'messages'), countTable(db, 'conversations'), countTable(db, 'source_batches')], before);
    assert.equal(runAudit(db).scanned.conversations, 3, 'the audit still works afterwards');
  });

  it('rejects wrong types, NUL bytes, over-long strings and non-boolean allBatches without echoing the value', async () => {
    const { db } = await multi();
    const secret = 'LEAK-CANARY-0042';
    const bad: AuditOptions[] = [
      { provider: 5 as never },
      { provider: `${secret}\0` },
      { accountLabel: secret.repeat(100) },
      { accountLabel: { toString: () => secret } as never },
      { allBatches: 'true' as never },
    ];
    for (const opts of bad) {
      try {
        runAudit(db, opts);
        assert.fail('expected a throw');
      } catch (e) {
        assert.ok(e instanceof GcrError && e.code === 'INVALID_ARGUMENT', String(e));
        assert.ok(!JSON.stringify(e.toEnvelope()).includes(secret));
      }
    }
    for (const bad2 of [null, undefined, 'x', 3, []]) {
      if (bad2 === undefined) continue; // undefined means "defaults"
      assert.throws(() => runAudit(db, bad2 as never), isInvalid);
    }
  });
});

describe('audit: head batches vs all batches', () => {
  async function twoSnapshots(): Promise<ReturnType<typeof fresh>> {
    const f = fresh();
    // OLD snapshot (older updated_at): has a parent cycle and no title. NEW snapshot (head): clean and titled.
    const c = (s: string): string => `x-${s}`;
    const oldMsgs = link([
      msg({ id: c('root'), conversationId: 'x', nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
      msg({ id: c('a'), conversationId: 'x', parentId: c('root'), authorRole: 'user', createdAt: iso(1), text: 'a', ordinal: 1 }),
      msg({ id: c('p'), conversationId: 'x', parentId: c('q'), authorRole: 'user', createdAt: iso(2), text: 'p', ordinal: 2 }),
      msg({ id: c('q'), conversationId: 'x', parentId: c('p'), authorRole: 'user', createdAt: iso(3), text: 'q', ordinal: 3 }),
    ]);
    const oldSnap: ConversationRecord = chat('x', [], { title: null, updatedAt: iso(10), currentNodeId: c('a'), messages: oldMsgs });
    const newSnap = chat('x', [{ role: 'user' }, { role: 'assistant', model: 'm' }], { title: 'Clean', updatedAt: iso(20) });
    await importAll(f.repo, [oldSnap], 'old');
    await importAll(f.repo, [newSnap], 'new');
    return f;
  }

  it('default audits only the head (newest) snapshot: the damaged old one is not reported', async () => {
    const { db } = await twoSnapshots();
    const r = runAudit(db);
    assert.deepEqual(r.scanned, { conversations: 1, messages: 2 });
    assert.equal(r.findings.find((f) => f.check === 'tree_integrity')?.count, 0);
    assert.equal(r.findings.find((f) => f.check === 'untitled')?.count, 0);
    assert.ok(!r.warnings.some((w) => w.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED'));
  });

  it('allBatches audits every stored snapshot as its own conversation and says so', async () => {
    const { db } = await twoSnapshots();
    const r = runAudit(db, { allBatches: true });
    assert.deepEqual(r.scanned, { conversations: 2, messages: 5 });
    const tree = r.findings.find((f) => f.check === 'tree_integrity');
    assert.equal(tree?.count, 1);
    assert.deepEqual(tree?.byCode, { CYCLE_DETECTED: 1 });
    assert.equal(tree?.total, 2);
    assert.equal(r.findings.find((f) => f.check === 'untitled')?.count, 1);
    const w = r.warnings.find((x) => x.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED');
    assert.ok(w);
    assert.match(w.message, /^1 superseded/);
  });

  it('the head is not the most recently IMPORTED snapshot but the one with the newest updated_at', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('y', [{}, {}, {}], { updatedAt: iso(50) })], 'first');
    await importAll(repo, [chat('y', [{}], { updatedAt: iso(5) })], 'second');
    assert.equal(runAudit(db).scanned.messages, 3, 'the first import (newer updated_at) stays the head');
    assert.equal(runAudit(db, { allBatches: true }).scanned.messages, 4);
  });
});

describe('audit: honest-scope warnings', () => {
  it('INCOMPLETE_SOURCE lists how many snapshots are not exported trees, with sample ids (FR-09)', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('p1', [{}], { completeness: 'partial_user_supplied', provenance: 'user_supplied_copy' }),
      chat('p2', [{}], { completeness: 'rendered_active_view_only', provenance: 'manual_browser_capture' }),
      chat('full', [{}]),
    ]);
    const w = runAudit(db).warnings.find((x) => x.code === 'INCOMPLETE_SOURCE');
    assert.ok(w);
    assert.match(w.message, /^2 conversation snapshot/);
    assert.match(w.message, /partial_user_supplied: 1/);
    assert.match(w.message, /rendered_active_view_only: 1/);
    assert.deepEqual(w.ids, ['p1', 'p2']);
  });

  it('BYCODE_TRUNCATED when more than 100 distinct values would be listed; counts and samples still cover everything', async () => {
    const { db, repo } = fresh();
    const specs = Array.from({ length: 120 }, (_, i) => ({ role: `custom-role-${String(i).padStart(3, '0')}` }));
    await importAll(repo, [chat('many', specs)]);
    const r = runAudit(db, { checks: ['unknown_roles'] });
    const f = r.findings[0];
    assert.equal(f?.count, 120);
    assert.equal(Object.keys(f?.byCode ?? {}).length, 100);
    const w = r.warnings.find((x) => x.code === 'BYCODE_TRUNCATED');
    assert.ok(w);
    assert.match(w.message, /unknown_roles/);
    assert.equal(f?.sampleMessageIds.length, 5);
  });

  it('no BYCODE_TRUNCATED at exactly 100 distinct values', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('exact', Array.from({ length: 100 }, (_, i) => ({ role: `r-${i}` })))]);
    const r = runAudit(db, { checks: ['unknown_roles'] });
    assert.equal(Object.keys(r.findings[0]?.byCode ?? {}).length, 100);
    assert.ok(!r.warnings.some((w) => w.code === 'BYCODE_TRUNCATED'));
  });
});

describe('audit: determinism and independence from import order', () => {
  function dataset(): ConversationRecord[] {
    return [
      chat('d1', [{ role: 'user' }, { role: 'assistant', model: null }], { title: null }),
      chat('d2', [{ role: 'function', hidden: true }, { at: null }], { currentNodeId: null }),
      claudeChat('d3', [{ text: ' ' }]),
      chat('d1', [{ role: 'assistant', model: 'm' }], { accountLabel: 'other' }),
    ];
  }

  it('the same call twice returns deep-equal results', async () => {
    const { db, repo } = fresh();
    await importAll(repo, dataset());
    assert.deepEqual(runAudit(db), runAudit(db));
    assert.equal(JSON.stringify(runAudit(db)), JSON.stringify(runAudit(db)), 'even key order is stable');
  });

  it('importing the same conversations in a different order gives the identical audit', async () => {
    const a = fresh();
    const b = fresh();
    await importAll(a.repo, dataset());
    await importAll(b.repo, dataset().reverse());
    assert.deepEqual(runAudit(a.db), runAudit(b.db));
  });
});

describe('audit: read-only operation and transaction hygiene', () => {
  it('works on a read-only connection and leaves no transaction behind', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'audit-ro.sqlite');
      const rw = openDatabase(path);
      await importAll(new Repository(rw.db), [chat('r1', [{ role: 'user' }, { role: 'assistant' }], { title: null })]);
      closeDatabase(rw);
      const ro = openDatabase(path, { readOnly: true });
      try {
        const r = runAudit(ro.db);
        assert.equal(r.findings.find((f) => f.check === 'untitled')?.count, 1);
        assert.equal(ro.db.isTransaction, false);
      } finally {
        closeDatabase(ro);
      }
    });
  });

  it('does not disturb a caller transaction and does not leave one after a failure', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('t', [{}])]);
    db.exec('BEGIN');
    try {
      runAudit(db);
      assert.equal(db.isTransaction, true);
    } finally {
      db.exec('ROLLBACK');
    }
    assert.throws(() => runAudit(db, { checks: [] as AuditCheck[] }), isInvalid);
    assert.equal(db.isTransaction, false);
  });

  it('writes nothing: row counts and the head table are unchanged by a full audit with allBatches', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('w', [{}, {}])]);
    const snap = (): string => JSON.stringify([countTable(db, 'messages'), countTable(db, 'conversations'), countTable(db, 'source_batches'), countTable(db, 'conversation_heads')]);
    const before = snap();
    runAudit(db, { allBatches: true });
    assert.equal(snap(), before);
  });

  it('a closed database yields a content-free DB_ERROR', async () => {
    await withTempDir(async (dir) => {
      const h = openDatabase(join(dir, 'closed-audit.sqlite'));
      closeDatabase(h);
      try {
        runAudit(h.db);
        assert.fail('expected a throw');
      } catch (e) {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'DB_ERROR');
        assert.ok(!e.message.includes(dir));
      }
    });
  });
});
