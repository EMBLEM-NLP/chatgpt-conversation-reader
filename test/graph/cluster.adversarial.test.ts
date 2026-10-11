/**
 * Adversarial tests from an independent review of src/graph/cluster.ts (determinism, argument handling, hostile weights).
 *
 * "defects found by review" failed against the reviewed code before the matching fix and stay as regression tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { GcrError } from '../../src/errors.js';
import { clusterGraph, labelPropagation, resolveMaxIterations } from '../../src/graph/cluster.js';

function expectCode(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

describe('defects found by review: labelPropagation validates its scalar arguments like every public entry point', () => {
  const none: number[] = [];

  it('rejects a negative, fractional, non-finite or absurd node count with INVALID_ARGUMENT (not a RangeError)', () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e12, 20_000_001, '3', null, undefined]) {
      assert.throws(() => labelPropagation(n as never, none, none, none, 5), expectCode('INVALID_ARGUMENT'), String(n));
    }
  });

  it('rejects a bad iteration bound instead of silently skipping the algorithm (or never terminating)', () => {
    for (const v of [0, -4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001, '5', null]) {
      assert.throws(() => labelPropagation(3, [0], [1], [1], v as never), expectCode('INVALID_ARGUMENT'), String(v));
    }
  });

  it('rejects edge lists that are not array-like', () => {
    for (const bad of [null, undefined, 5, 'abc' as unknown as number[]]) {
      assert.throws(() => labelPropagation(3, bad as never, none, none, 5), expectCode('INVALID_ARGUMENT'));
      assert.throws(() => labelPropagation(3, none, bad as never, none, 5), expectCode('INVALID_ARGUMENT'));
      assert.throws(() => labelPropagation(3, none, none, bad as never, 5), expectCode('INVALID_ARGUMENT'));
    }
  });

  it('error messages never echo the offending value', () => {
    try {
      labelPropagation('zqx-secret' as never, none, none, none, 5);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof GcrError);
      assert.equal(JSON.stringify(e.toEnvelope()).includes('zqx-secret'), false);
    }
  });

  it('valid boundary values still work: zero nodes, one node, typed-array edges, the maximum iteration bound', () => {
    assert.deepEqual([...labelPropagation(0, none, none, none, 1).labels], []);
    assert.deepEqual([...labelPropagation(1, none, none, none, 1).labels], [0]);
    const r = labelPropagation(3, Int32Array.of(0, 1), Int32Array.of(1, 2), Float64Array.of(2, 1), 1000);
    assert.equal(r.converged, true);
    assert.equal(new Set(r.labels).size, 1);
  });
});

describe('resolveMaxIterations', () => {
  it('defaults to 50 and accepts exactly 1..1000', () => {
    assert.equal(resolveMaxIterations(undefined), 50);
    assert.equal(resolveMaxIterations(1), 1);
    assert.equal(resolveMaxIterations(1000), 1000);
  });

  it('rejects everything else with INVALID_ARGUMENT', () => {
    for (const v of [0, -1, 1001, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '50', null, true, {}, []]) {
      assert.throws(() => resolveMaxIterations(v), expectCode('INVALID_ARGUMENT'), String(v));
    }
  });
});

describe('clusterGraph: determinism and hostile stored data', () => {
  const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'];
  const EDGES: ReadonlyArray<readonly [string, string, number]> = [
    ['n0', 'n1', 4],
    ['n1', 'n2', 4],
    ['n0', 'n2', 4],
    ['n3', 'n4', 3],
    ['n4', 'n5', 3],
    ['n3', 'n5', 3],
    ['n2', 'n3', 1],
    ['n6', 'n7', 2],
    ['n7', 'n8', 2],
    ['n6', 'n8', 2],
    ['n8', 'n9', 2],
  ];

  function build(nodes: readonly string[], edges: ReadonlyArray<readonly [string, string, number]>): DatabaseSync {
    const { db } = openDatabase(':memory:');
    const node = db.prepare("INSERT INTO graph_nodes (node_id, kind, label, weight) VALUES (?, 'entity', ?, 1)");
    const edge = db.prepare("INSERT INTO graph_edges (src, dst, kind, weight) VALUES (?, ?, 'co_occurs', ?)");
    for (const n of nodes) node.run(`ent:keyword:${n}`, n);
    for (const [a, b, w] of edges) edge.run(`ent:keyword:${a}`, `ent:keyword:${b}`, w);
    return db;
  }

  function snapshot(db: DatabaseSync): string {
    return JSON.stringify([
      db.prepare('SELECT node_id, community_id FROM graph_nodes ORDER BY node_id').all(),
      db.prepare('SELECT community_id, size, label FROM graph_communities ORDER BY community_id').all(),
    ]);
  }

  it('the result does not depend on the order in which node and edge rows were stored', () => {
    const a = build(NODES, EDGES);
    const b = build([...NODES].reverse(), [...EDGES].reverse());
    // Edges stored with swapped endpoints, nodes in an interleaved order.
    const c = build([...NODES.filter((_, i) => i % 2 === 1), ...NODES.filter((_, i) => i % 2 === 0)], EDGES.map(([x, y, w]) => [y, x, w] as const));
    clusterGraph(a);
    clusterGraph(b);
    clusterGraph(c);
    assert.equal(snapshot(b), snapshot(a));
    assert.equal(snapshot(c), snapshot(a));
  });

  it('non-finite stored weights are ignored: such an edge neither joins nodes nor crashes the run', () => {
    const { db } = openDatabase(':memory:');
    const node = db.prepare("INSERT INTO graph_nodes (node_id, kind, label, weight) VALUES (?, 'entity', ?, 1)");
    for (const n of ['x', 'y', 'z']) node.run(`ent:keyword:${n}`, n);
    db.exec("INSERT INTO graph_edges (src, dst, kind, weight) VALUES ('ent:keyword:x', 'ent:keyword:y', 'co_occurs', 1e999)");
    db.exec("INSERT INTO graph_edges (src, dst, kind, weight) VALUES ('ent:keyword:y', 'ent:keyword:z', 'co_occurs', -3)");
    db.exec("INSERT INTO graph_edges (src, dst, kind, weight) VALUES ('ent:keyword:x', 'ent:keyword:z', 'co_occurs', 0)");
    const r = clusterGraph(db);
    assert.deepEqual([r.communities, r.assignedNodes], [0, 0]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM graph_nodes WHERE community_id IS NOT NULL').get()?.['n'], 0);
  });

  it('a bound that is too small is reported as not converged, and the partial result is still stored and valid', () => {
    const db = build(NODES, EDGES);
    const r = clusterGraph(db, { maxIterations: 1 });
    assert.equal(r.iterations, 1);
    assert.equal(r.converged, false);
    assert.ok(r.communities >= 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM graph_communities').get()?.['n'], r.communities);
    // Community ids are contiguous from 1.
    const ids = db.prepare('SELECT community_id FROM graph_communities ORDER BY community_id').all().map((x) => Number(x['community_id']));
    assert.deepEqual(ids, ids.map((_, i) => i + 1));
  });

  it('refuses to run on a read-only connection with WRITE_FORBIDDEN and changes nothing', () => {
    const db = build(NODES, EDGES);
    db.exec('PRAGMA query_only = ON');
    assert.throws(() => clusterGraph(db), expectCode('WRITE_FORBIDDEN'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM graph_communities').get()?.['n'], 0);
  });
});
