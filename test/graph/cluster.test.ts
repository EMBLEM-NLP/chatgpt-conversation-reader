/**
 * Tests for src/graph/cluster.ts: deterministic label propagation (pure function and the database writer).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { openDatabase } from '../../src/db/open.js';
import { GcrError } from '../../src/errors.js';
import { clusterGraph, labelPropagation } from '../../src/graph/cluster.js';

const SEED = 20261010;

type Edge = readonly [number, number, number];

function lp(n: number, edges: readonly Edge[], maxIterations = 50): ReturnType<typeof labelPropagation> {
  return labelPropagation(
    n,
    edges.map((e) => e[0]),
    edges.map((e) => e[1]),
    edges.map((e) => e[2]),
    maxIterations,
  );
}

function groups(labels: Int32Array): number[][] {
  const m = new Map<number, number[]>();
  labels.forEach((l, i) => m.set(l, [...(m.get(l) ?? []), i]));
  return [...m.values()].sort((a, b) => (a[0] as number) - (b[0] as number));
}

function clique(nodes: number[], w = 5): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) out.push([nodes[i] as number, nodes[j] as number, w]);
  return out;
}

function expectCode(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

describe('labelPropagation (pure)', () => {
  it('splits two dense groups joined by one weak edge into two communities', () => {
    const edges = [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), [3, 4, 1] as const];
    const r = lp(8, edges);
    assert.equal(r.converged, true);
    assert.deepEqual(groups(r.labels), [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
  });

  it('keeps disconnected components apart and isolated nodes alone', () => {
    const r = lp(7, [...clique([0, 1, 2]), ...clique([3, 4])]);
    assert.deepEqual(groups(r.labels), [[0, 1, 2], [3, 4], [5], [6]]);
  });

  it('breaks ties toward the smallest label and is exact on a tiny case', () => {
    // Two nodes, one edge: node 0 adopts label 1 (its only neighbour), node 1 keeps it.
    const r = lp(2, [[0, 1, 1]]);
    assert.deepEqual([...r.labels], [1, 1]);
    assert.equal(r.iterations, 2);
    // Star: the centre (node 0) sees labels 1,2,3 with equal weight -> smallest label (1); the leaves then follow it.
    const star = lp(4, [
      [0, 1, 1],
      [0, 2, 1],
      [0, 3, 1],
    ]);
    assert.equal(new Set(star.labels).size, 1);
  });

  it('the heavier neighbour group wins', () => {
    // Node 4 is pulled by {0,1,2} (weight 1 each) and by {3} (weight 10): it follows 3's group.
    const edges: Edge[] = [...clique([0, 1, 2], 9), [4, 0, 1], [4, 1, 1], [4, 2, 1], [4, 3, 10]];
    const r = lp(5, edges);
    assert.equal(r.labels[4], r.labels[3]);
  });

  it('honours the iteration bound and reports non-convergence', () => {
    const path: Edge[] = Array.from({ length: 29 }, (_, i) => [i, i + 1, 1] as const);
    const capped = lp(30, path, 1);
    assert.equal(capped.iterations, 1);
    assert.equal(capped.converged, false);
    const full = lp(30, path, 50);
    assert.equal(full.converged, true);
    assert.ok(full.iterations <= 50);
  });

  it('ignores self loops, non-positive or non-finite weights and out-of-range endpoints', () => {
    const r = lp(4, [
      [0, 0, 5],
      [0, 1, 0],
      [1, 2, -3],
      [2, 3, Number.NaN],
      [0, 9, 1],
      [-1, 2, 1],
      [2, 3, Number.POSITIVE_INFINITY],
    ]);
    assert.deepEqual(groups(r.labels), [[0], [1], [2], [3]]);
  });

  it('is independent of edge order and deterministic (property)', () => {
    const edgeArb = fc.array(fc.tuple(fc.integer({ min: 0, max: 14 }), fc.integer({ min: 0, max: 14 }), fc.integer({ min: 1, max: 5 })), { maxLength: 50 });
    fc.assert(
      fc.property(edgeArb, fc.integer(), (edges, shuffleSeed) => {
        const base = lp(15, edges);
        assert.deepEqual([...lp(15, edges).labels], [...base.labels]);
        // Reorder deterministically (rotate + reverse): neighbour accumulation is exact for integer weights.
        const k = edges.length === 0 ? 0 : Math.abs(shuffleSeed) % edges.length;
        const rotated = [...edges.slice(k), ...edges.slice(0, k)].reverse();
        assert.deepEqual([...lp(15, rotated).labels], [...base.labels]);
        // Labels are node indices, and a node's label never exceeds the number of nodes.
        for (const l of base.labels) assert.ok(l >= 0 && l < 15);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('handles a large sparse graph quickly', () => {
    const n = 20_000;
    const src: number[] = [];
    const dst: number[] = [];
    const w: number[] = [];
    let x = 12345;
    for (let i = 0; i < 80_000; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const a = x % n;
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const b = x % n;
      src.push(a);
      dst.push(b);
      w.push(1 + (i % 3));
    }
    const start = performance.now();
    const r = labelPropagation(n, src, dst, w, 50);
    const ms = performance.now() - start;
    assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
    assert.equal(r.labels.length, n);
  });
});

describe('clusterGraph (database writer)', () => {
  function seedGraph(): ReturnType<typeof openDatabase>['db'] {
    const { db } = openDatabase(':memory:');
    const node = db.prepare("INSERT INTO graph_nodes (node_id, kind, label, weight) VALUES (?, ?, ?, 1)");
    const edge = db.prepare("INSERT INTO graph_edges (src, dst, kind, weight) VALUES (?, ?, 'co_occurs', ?)");
    // Two triangles, one weak bridge, one isolated conversation node, one dangling edge.
    for (const id of ['ent:keyword:a1', 'ent:keyword:a2', 'ent:keyword:a3', 'ent:keyword:b1', 'ent:keyword:b2', 'ent:keyword:b3']) node.run(id, 'entity', id.slice(12));
    node.run('conv:chatgpt:default:lonely', 'conversation', 'Lonely');
    for (const [a, b, w] of [
      ['a1', 'a2', 4],
      ['a1', 'a3', 4],
      ['a2', 'a3', 4],
      ['b1', 'b2', 3],
      ['b1', 'b3', 3],
      ['b2', 'b3', 3],
      ['a3', 'b1', 1],
    ] as const) {
      edge.run(`ent:keyword:${a}`, `ent:keyword:${b}`, w);
    }
    edge.run('ent:keyword:a1', 'ent:keyword:missing', 2);
    return db;
  }

  it('assigns contiguous community ids ordered by size then smallest member, names them, leaves isolated nodes NULL', () => {
    const db = seedGraph();
    const r = clusterGraph(db);
    assert.deepEqual([r.communities, r.converged, r.assignedNodes], [2, true, 6]);
    const community = (id: string): unknown => db.prepare('SELECT community_id AS c FROM graph_nodes WHERE node_id = ?').get(id)?.['c'];
    for (const id of ['a1', 'a2', 'a3']) assert.equal(community(`ent:keyword:${id}`), 1);
    for (const id of ['b1', 'b2', 'b3']) assert.equal(community(`ent:keyword:${id}`), 2);
    assert.equal(community('conv:chatgpt:default:lonely'), null);
    const rows = db.prepare('SELECT community_id, size, label FROM graph_communities ORDER BY community_id').all().map((x) => ({ ...x }));
    assert.deepEqual(
      rows.map((x) => [x['community_id'], x['size']]),
      [
        [1, 3],
        [2, 3],
      ],
    );
    assert.match(String(rows[0]?.['label']), /^a\d, a\d, a\d$/);
  });

  it('is deterministic and replaces previous assignments completely', () => {
    const db = seedGraph();
    db.exec("INSERT INTO graph_communities (community_id, size, label) VALUES (77, 1, 'stale')");
    db.exec("UPDATE graph_nodes SET community_id = 77 WHERE node_id = 'conv:chatgpt:default:lonely'");
    clusterGraph(db);
    const dump = () => JSON.stringify([db.prepare('SELECT node_id, community_id FROM graph_nodes ORDER BY node_id').all(), db.prepare('SELECT * FROM graph_communities ORDER BY community_id').all()]);
    const first = dump();
    clusterGraph(db);
    assert.equal(dump(), first);
    assert.equal(db.prepare('SELECT count(*) AS n FROM graph_communities WHERE community_id = 77').get()?.['n'], 0);
    assert.equal(db.prepare("SELECT community_id AS c FROM graph_nodes WHERE node_id = 'conv:chatgpt:default:lonely'").get()?.['c'], null);
  });

  it('runs inside the caller transaction when there is one (and commits nothing itself)', () => {
    const db = seedGraph();
    db.exec('BEGIN');
    clusterGraph(db);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS n FROM graph_communities').get()?.['n'], 0);
  });

  it('a community name that has to be cut never ends in half a surrogate pair', () => {
    const { db } = openDatabase(':memory:');
    const node = db.prepare("INSERT INTO graph_nodes (node_id, kind, label, weight) VALUES (?, 'entity', ?, 1)");
    const edge = db.prepare("INSERT INTO graph_edges (src, dst, kind, weight) VALUES (?, ?, 'co_occurs', 1)");
    // The first label is 161 UTF-16 units long: a plain slice(0, 160) would leave the high surrogate of the emoji behind.
    node.run('ent:keyword:a1', `${'a'.repeat(159)}\u{1F600}`);
    node.run('ent:keyword:a2', 'b');
    node.run('ent:keyword:a3', 'c');
    edge.run('ent:keyword:a1', 'ent:keyword:a2');
    edge.run('ent:keyword:a1', 'ent:keyword:a3');
    edge.run('ent:keyword:a2', 'ent:keyword:a3');
    clusterGraph(db);
    const label = String(db.prepare('SELECT label FROM graph_communities').get()?.['label']);
    assert.equal(label.length, 159);
    assert.doesNotThrow(() => encodeURIComponent(label), 'encodeURIComponent throws on a lone surrogate');
  });

  it('an empty graph clusters to nothing', () => {
    const { db } = openDatabase(':memory:');
    assert.deepEqual(clusterGraph(db), { communities: 0, iterations: 1, converged: true, assignedNodes: 0 });
  });

  it('rejects a bad maxIterations', () => {
    const { db } = openDatabase(':memory:');
    for (const v of [0, -1, 1001, 1.5, '5']) assert.throws(() => clusterGraph(db, { maxIterations: v as never }), expectCode('INVALID_ARGUMENT'), String(v));
  });

  it('a failure inside its own transaction rolls back and reports DB_ERROR', () => {
    const db = seedGraph();
    db.exec("CREATE TRIGGER no_community BEFORE INSERT ON graph_communities BEGIN SELECT RAISE(ABORT, 'nope'); END");
    assert.throws(() => clusterGraph(db), expectCode('DB_ERROR'));
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM graph_nodes WHERE community_id IS NOT NULL').get()?.['n'], 0);
  });
});
