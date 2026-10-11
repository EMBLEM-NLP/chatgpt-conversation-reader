/**
 * NFR-05 performance baseline for the graph pipeline: 50 000 synthetic messages (1 000 conversations x 50) are imported
 * through the real importer, then extracted and turned into a graph by buildGraph. Timings and sizes are recorded as test
 * diagnostics (node:test prints them); the assertions use generous bounds so slow CI machines do not flake, while still
 * failing for an accidentally quadratic build.
 *
 * Data is generated from a seeded integer generator (no Math.random), so the corpus and therefore the counts are the same
 * on every run.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { buildGraph } from '../../src/graph/build.js';
import { communities, godNodes, graphQuery, shortestPath } from '../../src/graph/query.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const CONVERSATIONS = 1000;
const MESSAGES_PER_CONVERSATION = 50;
const TOTAL = CONVERSATIONS * MESSAGES_PER_CONVERSATION;
const BUILD_BUDGET_MS = 60_000;

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'perf.zip',
  contentDigest: 'perf-50k',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

function* corpus(): Generator<ConversationRecord> {
  let seed = 123_456_789;
  const next = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  const vocab = Array.from({ length: 400 }, (_, i) => `perfword${i.toString(36)}x`);
  for (let c = 0; c < CONVERSATIONS; c++) {
    const id = `perf-${String(c).padStart(4, '0')}`;
    const rootId = `${id}-root`;
    const msgs = [msg({ id: rootId, conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 })];
    let prev = rootId;
    for (let i = 0; i < MESSAGES_PER_CONVERSATION; i++) {
      const words: string[] = [];
      for (let k = 0; k < 6; k++) words.push(vocab[Math.floor(next() * next() * vocab.length)] as string); // skewed: a few words are very common
      let text = words.join(' ');
      if (next() < 0.1) text += ` see https://site${Math.floor(next() * 50)}.example.com/page${Math.floor(next() * 20)}?utm=${i}`;
      const mid = `${id}-m${i}`;
      msgs.push(
        msg({
          id: mid,
          conversationId: id,
          parentId: prev,
          authorRole: i % 2 === 0 ? 'user' : 'assistant',
          recipient: i % 2 === 1 && next() < 0.2 ? (next() < 0.5 ? 'python' : 'browser') : null,
          text,
          createdAt: iso(i + 1),
          ordinal: i + 1,
        }),
      );
      prev = mid;
    }
    yield convo(id, link(msgs), { currentNodeId: prev, title: `Perf conversation ${c}` });
  }
}

describe('graph build performance baseline (50 000 messages)', () => {
  it('imports, builds and queries within budget; every edge has evidence', async (t) => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);

    const importStart = performance.now();
    const imported = await repo.importBatch({ batch: META, conversations: corpus() });
    const importMs = performance.now() - importStart;
    assert.equal(imported.conversations.stored, CONVERSATIONS);
    assert.equal(imported.messages.stored, CONVERSATIONS * (MESSAGES_PER_CONVERSATION + 1)); // + one structural root each

    const buildStart = performance.now();
    const r = buildGraph(h.db);
    const buildMs = performance.now() - buildStart;

    assert.equal(r.messagesScanned, TOTAL);
    assert.ok(r.nodes > CONVERSATIONS, `nodes ${r.nodes}`);
    assert.ok(r.edges > 10_000, `edges ${r.edges}`);
    assert.ok(r.entities > 100, `entities ${r.entities}`);
    assert.ok(r.communities >= 1);
    assert.deepEqual(r.warnings.filter((w) => w.code !== 'EVIDENCE_TRUNCATED'), []);
    assert.ok(buildMs < BUILD_BUDGET_MS, `build took ${buildMs.toFixed(0)} ms (budget ${BUILD_BUDGET_MS} ms)`);

    const orphanEdges = Number(
      h.db.prepare('SELECT count(*) AS n FROM graph_edges e WHERE NOT EXISTS (SELECT 1 FROM graph_edge_evidence v WHERE v.edge_id = e.edge_id)').get()?.['n'],
    );
    assert.equal(orphanEdges, 0, 'every edge carries evidence');
    assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), []);

    const queryStart = performance.now();
    const top = godNodes(h.db, { limit: 5 });
    const q = graphQuery(h.db, { term: 'perfword', depth: 2, maxNodes: 200 });
    const first = top[0];
    const path = first === undefined ? null : shortestPath(h.db, first.node.id, (top[1] ?? first).node.id);
    const comms = communities(h.db, { topNodes: 3 });
    const queryMs = performance.now() - queryStart;
    assert.equal(top.length, 5);
    assert.ok(q.nodes.length > 0 && q.nodes.length <= 200);
    assert.ok(path !== null && path.found);
    assert.ok(comms.length >= 1);
    assert.ok(queryMs < 15_000, `queries took ${queryMs.toFixed(0)} ms`);

    const count = (table: string): number => Number(h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
    t.diagnostic(
      `messages=${TOTAL} import=${importMs.toFixed(0)}ms build=${buildMs.toFixed(0)}ms (${((TOTAL / buildMs) * 1000).toFixed(0)} msg/s) ` +
        `queries=${queryMs.toFixed(0)}ms nodes=${r.nodes} edges=${r.edges} entities=${r.entities} communities=${r.communities} ` +
        `mentions=${count('entity_mentions')} evidence=${count('graph_edge_evidence')} rssMB=${Math.round(process.memoryUsage().rss / 1048576)}`,
    );
  });
});
