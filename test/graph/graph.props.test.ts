/**
 * Property tests (fast-check, fixed seed) for the graph pipeline on real databases.
 *
 * Differential oracle: for random small corpora the expected edge set is recomputed IN THE TEST, straight from
 * extractEntities and the documented rules (minEntityConversations, per-message cap, src < dst for co_occurs), and must
 * equal what buildGraph stored. Structural invariants (evidence for every edge, no dangling edges, foreign keys,
 * determinism) are checked on the same databases. Graph queries are compared with an independent breadth-first search
 * over the stored edge list: shortestPath finds a path exactly when one exists and with exactly the minimal hop count;
 * graphQuery(depth d) returns exactly the ball of radius d around its seed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import fc from 'fast-check';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { extractEntities } from '../../src/entities/extract.js';
import type { EntityKind } from '../../src/entities/extract.js';
import { buildGraph, conversationNodeId, entityNodeId } from '../../src/graph/build.js';
import { graphQuery, shortestPath } from '../../src/graph/query.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const SEED = 20261010;
const RUNS = 40;

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'props.zip',
  contentDigest: 'props',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

// ---------------------------------------------------------------------------------------------------------------------
// Generators: plain vocabulary words only (no URLs/uuids), so every entity is a keyword or a recipient tool.
// ---------------------------------------------------------------------------------------------------------------------

const VOCAB = ['alphaw', 'betaw', 'gammaw', 'deltaw', 'epsilw', 'zetaww', 'etaww', 'thetaw'] as const;

interface MessageSpec {
  words: string[];
  recipient: string | null;
}

const messageArb: fc.Arbitrary<MessageSpec> = fc.record({
  words: fc.array(fc.constantFrom(...VOCAB), { maxLength: 6 }),
  recipient: fc.constantFrom<string | null>(null, null, 'python', 'browser'),
});
const corpusArb = fc.array(fc.array(messageArb, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 6 });
const paramsArb = fc.record({ min: fc.integer({ min: 1, max: 3 }), cap: fc.integer({ min: 2, max: 5 }) });

function conversationId(ci: number): string {
  return `p${ci}`;
}

function toRecords(corpus: readonly (readonly MessageSpec[])[]): ConversationRecord[] {
  return corpus.map((specs, ci) => {
    const id = conversationId(ci);
    const root = msg({ id: `${id}-root`, conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 });
    const msgs = [root];
    let prev = root.id;
    specs.forEach((s, mi) => {
      const m = msg({
        id: `${id}-m${mi}`,
        conversationId: id,
        parentId: prev,
        authorRole: mi % 2 === 0 ? 'user' : 'assistant',
        recipient: s.recipient,
        text: s.words.join(' '),
        createdAt: iso(mi + 1),
        ordinal: mi + 1,
      });
      msgs.push(m);
      prev = m.id;
    });
    return convo(id, link(msgs), { currentNodeId: prev });
  });
}

async function build(corpus: readonly (readonly MessageSpec[])[], min: number, cap: number): Promise<{ db: DatabaseSync; result: ReturnType<typeof buildGraph> }> {
  const h = openDatabase(':memory:');
  await new Repository(h.db).importBatch({ batch: META, conversations: toRecords(corpus) });
  return { db: h.db, result: buildGraph(h.db, { minEntityConversations: min, maxEntitiesPerMessage: cap }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------------------------------

interface Ent {
  node: string;
  kind: EntityKind;
  normalized: string;
  count: number;
}

function expectedEdges(corpus: readonly (readonly MessageSpec[])[], min: number, cap: number): { edges: Map<string, number>; entityNodes: Set<string> } {
  const perMessage: Array<{ conv: string; ents: Ent[] }> = [];
  const conversationsOf = new Map<string, Set<string>>();
  corpus.forEach((specs, ci) => {
    const conv = conversationNodeId('chatgpt', 'default', conversationId(ci));
    specs.forEach((s, mi) => {
      const found = extractEntities({ text: s.words.join(' '), authorRole: mi % 2 === 0 ? 'user' : 'assistant', recipient: s.recipient, blocks: [], attachments: [] });
      const ents = found.map((e): Ent => ({ node: entityNodeId(e.kind, e.normalized), kind: e.kind, normalized: e.normalized, count: e.count }));
      perMessage.push({ conv, ents });
      for (const e of ents) {
        const set = conversationsOf.get(e.node) ?? new Set<string>();
        set.add(conv);
        conversationsOf.set(e.node, set);
      }
    });
  });
  const keep = (e: Ent): boolean => e.kind === 'tool' || (conversationsOf.get(e.node)?.size ?? 0) >= min;
  const edges = new Map<string, number>();
  const entityNodes = new Set<string>();
  const bump = (key: string): void => void edges.set(key, (edges.get(key) ?? 0) + 1);
  for (const { conv, ents } of perMessage) {
    const kept = ents.filter(keep);
    for (const e of kept) {
      entityNodes.add(e.node);
      bump(e.kind === 'tool' ? `${conv}|${e.node}|uses_tool` : `${e.node}|${conv}|mentioned_in`);
    }
    const ranked = [...kept].sort((a, b) => b.count - a.count || (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    const top = ranked.slice(0, cap);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = (top[i] as Ent).node;
        const b = (top[j] as Ent).node;
        bump(a < b ? `${a}|${b}|co_occurs` : `${b}|${a}|co_occurs`);
      }
    }
  }
  return { edges, entityNodes };
}

function storedEdges(db: DatabaseSync): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.prepare('SELECT src, dst, kind, weight FROM graph_edges').all()) out.set(`${String(r['src'])}|${String(r['dst'])}|${String(r['kind'])}`, Number(r['weight']));
  return out;
}

function dump(db: DatabaseSync): string {
  const h = createHash('sha256');
  for (const t of ['entities', 'entity_mentions', 'graph_nodes', 'graph_edges', 'graph_edge_evidence', 'graph_communities']) {
    h.update(`#${t}\n${JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())}`);
  }
  return h.digest('hex');
}

/** Undirected adjacency over the stored edges, independent of query.ts. */
function adjacency(db: DatabaseSync): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const r of db.prepare('SELECT node_id FROM graph_nodes').all()) adj.set(String(r['node_id']), new Set());
  for (const r of db.prepare('SELECT src, dst FROM graph_edges').all()) {
    adj.get(String(r['src']))?.add(String(r['dst']));
    adj.get(String(r['dst']))?.add(String(r['src']));
  }
  return adj;
}

function distances(adj: Map<string, Set<string>>, from: string): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as string;
    for (const next of adj.get(cur) ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, (dist.get(cur) as number) + 1);
      queue.push(next);
    }
  }
  return dist;
}

describe('buildGraph properties (differential oracle)', () => {
  it('stores exactly the edges, weights and entity nodes the documented rules imply', async () => {
    await fc.assert(
      fc.asyncProperty(corpusArb, paramsArb, async (corpus, { min, cap }) => {
        const { db, result } = await build(corpus, min, cap);
        const want = expectedEdges(corpus, min, cap);
        assert.deepEqual([...storedEdges(db)].sort(), [...want.edges].sort());
        const entityNodes = new Set(
          db
            .prepare("SELECT node_id FROM graph_nodes WHERE kind <> 'conversation'")
            .all()
            .map((r) => String(r['node_id'])),
        );
        assert.deepEqual([...entityNodes].sort(), [...want.entityNodes].sort());
        assert.equal(result.entities, want.entityNodes.size);
        assert.equal(result.nodes, corpus.length + want.entityNodes.size);
        assert.equal(result.edges, want.edges.size);
        assert.equal(result.messagesScanned, corpus.reduce((n, c) => n + c.length, 0));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('keeps the structural invariants: evidence for every edge, no dangling edges, valid foreign keys, src < dst', async () => {
    await fc.assert(
      fc.asyncProperty(corpusArb, paramsArb, async (corpus, { min, cap }) => {
        const { db } = await build(corpus, min, cap);
        const n = (sql: string): number => Number(db.prepare(sql).get()?.['n']);
        assert.equal(n('SELECT count(*) AS n FROM graph_edges e WHERE NOT EXISTS (SELECT 1 FROM graph_edge_evidence v WHERE v.edge_id = e.edge_id)'), 0);
        assert.equal(n('SELECT count(*) AS n FROM graph_edges e WHERE e.weight <> (SELECT count(*) FROM graph_edge_evidence v WHERE v.edge_id = e.edge_id)'), 0, 'nothing is capped on small corpora');
        assert.equal(n('SELECT count(*) AS n FROM graph_edges e WHERE NOT EXISTS (SELECT 1 FROM graph_nodes x WHERE x.node_id = e.src) OR NOT EXISTS (SELECT 1 FROM graph_nodes y WHERE y.node_id = e.dst)'), 0);
        assert.equal(n("SELECT count(*) AS n FROM graph_edges WHERE kind = 'co_occurs' AND src >= dst"), 0);
        assert.equal(n('SELECT count(*) AS n FROM graph_edges WHERE src = dst'), 0);
        assert.equal(
          n(
            'SELECT count(*) AS n FROM graph_edge_evidence v WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.provider = v.provider AND m.account_label = v.account_label AND m.conversation_id = v.conversation_id AND m.message_id = v.message_id AND m.source_batch = v.source_batch AND m.node_kind = \'message\')',
          ),
          0,
          'every citation names a stored, non-structural message',
        );
        assert.equal(n('SELECT count(*) AS n FROM entity_mentions m WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.entity_id = m.entity_id)'), 0);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        // Communities: exactly the nodes with an edge belong to one; sizes add up.
        assert.equal(
          n('SELECT count(*) AS n FROM graph_nodes x WHERE (x.community_id IS NULL) = EXISTS (SELECT 1 FROM graph_edges e WHERE e.src = x.node_id OR e.dst = x.node_id)'),
          0,
        );
        assert.equal(n('SELECT coalesce(sum(size), 0) AS n FROM graph_communities'), n('SELECT count(*) AS n FROM graph_nodes WHERE community_id IS NOT NULL'));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('is deterministic: a second build over the same data is byte-identical', async () => {
    await fc.assert(
      fc.asyncProperty(corpusArb, paramsArb, async (corpus, { min, cap }) => {
        const { db } = await build(corpus, min, cap);
        const first = dump(db);
        buildGraph(db, { minEntityConversations: min, maxEntitiesPerMessage: cap });
        assert.equal(dump(db), first);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

describe('graph query properties (reference breadth-first search)', () => {
  it('shortestPath finds a path exactly when one exists within maxDepth, with exactly the minimal hop count and consistent edges', async () => {
    await fc.assert(
      // maxDepth is generated too: the random graphs are small, so only small bounds reach the "distance == maxDepth" edge.
      fc.asyncProperty(corpusArb, paramsArb, fc.nat(), fc.nat(), fc.integer({ min: 1, max: 6 }), async (corpus, { min, cap }, i, j, maxDepth) => {
        const { db } = await build(corpus, min, cap);
        const adj = adjacency(db);
        const ids = [...adj.keys()].sort();
        const from = ids[i % ids.length] as string;
        const to = ids[j % ids.length] as string;
        const want = distances(adj, from).get(to);
        const got = shortestPath(db, from, to, { maxDepth });
        if (want === undefined || want > maxDepth) {
          assert.equal(got.found, false);
          assert.deepEqual([got.path, got.edges], [[], []]);
          return;
        }
        assert.equal(got.found, true);
        assert.equal(got.path.length, want + 1);
        assert.equal(got.edges.length, want);
        assert.equal(got.path[0]?.id, from);
        assert.equal(got.path[got.path.length - 1]?.id, to);
        got.edges.forEach((e, k) => {
          const a = (got.path[k] as { id: string }).id;
          const b = (got.path[k + 1] as { id: string }).id;
          assert.ok((e.src === a && e.dst === b) || (e.src === b && e.dst === a), 'edge joins consecutive path nodes');
        });
        // Determinism: asking again gives the same path.
        assert.deepEqual(
          shortestPath(db, from, to, { maxDepth }).path.map((x) => x.id),
          got.path.map((x) => x.id),
        );
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('graphQuery(depth) returns exactly the ball of that radius around an exact-id seed, with only induced edges', async () => {
    await fc.assert(
      fc.asyncProperty(corpusArb, paramsArb, fc.nat(), fc.integer({ min: 1, max: 4 }), async (corpus, { min, cap }, i, depth) => {
        const { db } = await build(corpus, min, cap);
        const adj = adjacency(db);
        const ids = [...adj.keys()].sort();
        const seed = ids[i % ids.length] as string;
        const r = graphQuery(db, { term: seed, depth, maxNodes: 500 });
        assert.deepEqual(r.seeds, [seed]);
        const ball = [...distances(adj, seed)].filter(([, d]) => d <= depth).map(([id]) => id).sort();
        assert.deepEqual(r.nodes.map((n) => n.id).sort(), ball);
        assert.equal(r.truncated, false);
        const inBall = new Set(ball);
        assert.ok(r.edges.every((e) => inBall.has(e.src) && inBall.has(e.dst)));
        const expectedInduced = Number(
          db
            .prepare('SELECT edge_id, src, dst FROM graph_edges')
            .all()
            .filter((e) => inBall.has(String(e['src'])) && inBall.has(String(e['dst']))).length,
        );
        assert.equal(r.edges.length, expectedInduced);
        // A tighter node budget never returns more nodes than allowed and flags the cut.
        if (ball.length > 2) {
          const cut = graphQuery(db, { term: seed, depth, maxNodes: 2 });
          assert.equal(cut.nodes.length, 2);
          assert.equal(cut.truncated, true);
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});
