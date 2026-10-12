/**
 * NFR-05 scale tests for src/analysis: a 50,000-message database (about 75 MB of message text) is analysed within a
 * generous wall-clock bound and with BOUNDED MEMORY.
 *
 * How bounded memory is proven: a child process opens the on-disk database READ-ONLY and runs the full audit plus every
 * groupBy with `--max-old-space-size=48` (MB). The text alone is ~75 MB, so any implementation that materialises message
 * text (or all messages) cannot finish. A CONTROL child that does exactly that (SELECT every text into an array) under the
 * same limit must die with "heap out of memory" - which shows the limit really discriminates. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runAudit } from '../../src/analysis/audit.js';
import { computeStats, STATS_GROUP_BY } from '../../src/analysis/stats.js';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import type { GcrDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { batchMeta, chat, star } from './support.test.js';

const CHAINS = 499; //          chain conversations of 100 messages each ...
const PER_CHAIN = 100;
const STAR_LEAVES = 100; //     ... plus one star conversation with 100 leaf messages = exactly 50,000 real messages
const TEXT_CHARS = 1500;
const DEADLINE_MS = 60_000; //  generous: the real run takes a few seconds

interface Counters {
  messages: number;
  hidden: number;
  characters: number;
  unknownRoles: number;
  assistantVisibleWithModel: number;
  assistantVisibleWithoutModel: number;
  untitled: number;
  noCurrentNode: number;
}

const counters: Counters = { messages: 0, hidden: 0, characters: 0, unknownRoles: 0, assistantVisibleWithModel: 0, assistantVisibleWithoutModel: 0, untitled: 0, noCurrentNode: 0 };

/** Streams the synthetic conversations (one at a time) while counting what the analysis must find. */
function* generate(): Generator<ConversationRecord> {
  for (let c = 0; c < CHAINS; c++) {
    const specs = [];
    for (let i = 0; i < PER_CHAIN; i++) {
      const assistant = i % 2 === 1;
      const hidden = i % 50 === 7;
      const unknownRole = c % 100 === 3 && i === 5;
      const role = unknownRole ? 'tool_weird' : assistant ? 'assistant' : 'user';
      const model = assistant && i % 3 !== 0 ? `synthetic-model-${c % 4}` : null;
      const text = `w${c}_${i} `.repeat(Math.ceil(TEXT_CHARS / 6)).slice(0, TEXT_CHARS);
      specs.push({ role, model, hidden, text, at: new Date(Date.UTC(2025, 0, 1) + (c * PER_CHAIN + i) * 60_000).toISOString() });
      counters.messages++;
      counters.characters += text.length;
      if (hidden) counters.hidden++;
      if (unknownRole) counters.unknownRoles++;
      if (role === 'assistant' && !hidden) {
        if (model === null) counters.assistantVisibleWithoutModel++;
        else counters.assistantVisibleWithModel++;
      }
    }
    const untitled = c % 17 === 0;
    const noCurrent = c % 25 === 0;
    if (untitled) counters.untitled++;
    if (noCurrent) counters.noCurrentNode++;
    yield chat(`conv-${String(c).padStart(5, '0')}`, specs, { title: untitled ? null : `Synthetic ${c}`, ...(noCurrent ? { currentNodeId: null } : {}) });
  }
  const s = star('conv-star', STAR_LEAVES);
  for (const m of s.messages) {
    if (m.nodeKind !== 'message') continue;
    counters.messages++;
    counters.characters += m.text.length;
    if (m.authorRole === 'assistant') counters.assistantVisibleWithoutModel++; // star leaves carry no model
  }
  yield s;
}

let dir = '';
let dbPath = '';
let handle: GcrDatabase | undefined;
let buildMs = 0;

describe('50,000-message scale (NFR-05)', { timeout: 300_000 }, () => {
  before(async () => {
    dir = await mkdtemp(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-test-'));
    dbPath = join(dir, 'big.sqlite');
    handle = openDatabase(dbPath);
    const t0 = performance.now();
    await new Repository(handle.db).importBatch({ batch: batchMeta('chatgpt', 'default', 'scale'), conversations: generate() });
    buildMs = performance.now() - t0;
  });

  after(async () => {
    if (handle !== undefined) closeDatabase(handle);
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('the fixture really holds 50,000 messages and tens of megabytes of text', () => {
    assert.equal(counters.messages, 50_000);
    assert.ok(counters.characters > 70_000_000, `text characters: ${counters.characters}`);
    assert.ok(buildMs < DEADLINE_MS, `import took ${buildMs.toFixed(0)} ms`);
  });

  it('computeStats: every groupBy over 50k messages is exact and fast', () => {
    const db = (handle as GcrDatabase).db;
    const t0 = performance.now();
    for (const groupBy of STATS_GROUP_BY) {
      const r = computeStats(db, { groupBy, includeHidden: true, limit: 1000 });
      assert.equal(r.totals.messages, counters.messages, groupBy);
      assert.equal(r.totals.characters, counters.characters, groupBy);
      assert.equal(r.totals.conversations, CHAINS + 1, groupBy);
      assert.equal(r.rows.reduce((n, x) => n + x.messages, 0), counters.messages, `${groupBy}: rows add up`);
      assert.equal(r.nextOffset, null, groupBy);
    }
    const ms = performance.now() - t0;
    assert.ok(ms < DEADLINE_MS, `stats took ${ms.toFixed(0)} ms`);

    const roles = computeStats(db, { groupBy: 'role', includeHidden: true });
    assert.equal(roles.rows.find((x) => x.key === 'tool_weird')?.messages, counters.unknownRoles);
    const visible = computeStats(db, { groupBy: 'model' });
    assert.equal(visible.modelProvenance.assistantMessagesWithModel, counters.assistantVisibleWithModel);
    assert.equal(visible.modelProvenance.assistantMessagesWithoutModel, counters.assistantVisibleWithoutModel);
    assert.equal(visible.totals.messages, counters.messages - counters.hidden);
    assert.equal(visible.modelProvenance.distinctModels, 4);
  });

  it('runAudit: all checks over 50k messages are exact and fast', () => {
    const db = (handle as GcrDatabase).db;
    const t0 = performance.now();
    const r = runAudit(db);
    const ms = performance.now() - t0;
    assert.ok(ms < DEADLINE_MS, `audit took ${ms.toFixed(0)} ms`);
    assert.deepEqual(r.scanned, { conversations: CHAINS + 1, messages: counters.messages });
    const by = (check: string) => r.findings.find((f) => f.check === check);
    assert.equal(by('untitled')?.count, counters.untitled);
    assert.equal(by('no_current_node')?.count, counters.noCurrentNode);
    assert.equal(by('hidden')?.count, counters.hidden);
    assert.equal(by('unknown_roles')?.count, counters.unknownRoles);
    assert.equal(by('missing_model')?.count, counters.assistantVisibleWithoutModel);
    assert.equal(by('missing_model')?.total, counters.assistantVisibleWithModel + counters.assistantVisibleWithoutModel);
    assert.equal(by('tree_integrity')?.count, 0);
    assert.equal(by('empty')?.count, 0);
    assert.equal(r.branchProvenance?.maxBranchesInOneConversation, STAR_LEAVES);
    assert.equal(r.branchProvenance?.conversationsWithMultipleBranches, 1);
    assert.equal(r.branchProvenance?.conversationsWithKnownActiveBranch, CHAINS + 1 - counters.noCurrentNode);
    assert.equal(r.branchProvenance?.conversationsWithUnknownActiveBranch, counters.noCurrentNode);
  });

  it('bounded memory: audit + every groupBy finish in a child limited to 48 MB of old space; a materialising control dies', async () => {
    const auditUrl = new URL('../../src/analysis/audit.js', import.meta.url).href;
    const statsUrl = new URL('../../src/analysis/stats.js', import.meta.url).href;
    const openUrl = new URL('../../src/db/open.js', import.meta.url).href;
    const script = join(dir, 'child.mjs');
    await writeFile(
      script,
      `
import { openDatabase } from ${JSON.stringify(openUrl)};
import { runAudit } from ${JSON.stringify(auditUrl)};
import { computeStats, STATS_GROUP_BY } from ${JSON.stringify(statsUrl)};
const h = openDatabase(process.argv[2], { readOnly: true });
if (process.argv[3] === 'control') {
  // What an implementation that holds the data would do. It must NOT fit into the limit.
  const rows = h.db.prepare("SELECT text FROM messages WHERE node_kind = 'message'").all();
  console.log(JSON.stringify({ materialised: rows.length }));
} else {
  const a = runAudit(h.db);
  const totals = STATS_GROUP_BY.map((g) => computeStats(h.db, { groupBy: g, includeHidden: true, limit: 1000 }).totals.messages);
  console.log(JSON.stringify({ scanned: a.scanned, totals }));
}
`,
      'utf8',
    );
    const run = (mode: string) =>
      spawnSync(process.execPath, ['--max-old-space-size=48', '--disable-warning=ExperimentalWarning', script, dbPath, mode], { encoding: 'utf8', timeout: 180_000 });

    const control = run('control');
    assert.ok(control.status !== 0 || control.signal !== null, 'the materialising control must not fit into 48 MB');
    assert.match(control.stderr, /heap out of memory|Reached heap limit/i, 'and it must fail because of memory, not for another reason');

    const t0 = performance.now();
    const real = run('stream');
    const ms = performance.now() - t0;
    assert.equal(real.status, 0, `child failed: ${real.stderr.slice(0, 500)}`);
    const out = JSON.parse(real.stdout.trim().split('\n').at(-1) ?? '{}') as { scanned: { conversations: number; messages: number }; totals: number[] };
    assert.deepEqual(out.scanned, { conversations: CHAINS + 1, messages: counters.messages });
    assert.deepEqual(out.totals, STATS_GROUP_BY.map(() => counters.messages));
    assert.ok(ms < DEADLINE_MS, `child run took ${ms.toFixed(0)} ms`);
  });
});
