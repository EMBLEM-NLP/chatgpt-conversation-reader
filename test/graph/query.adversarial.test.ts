/**
 * Adversarial tests from an independent review of src/graph/query.ts (BFS / shortest-path correctness and bounds,
 * giant hubs, determinism). The graphs are written straight into the derived tables so that edge weights, hub sizes and
 * kinds are exactly what each scenario needs; the database is the real schema from openDatabase.
 *
 * "defects found by review" failed against the reviewed code before the matching fix and stay as regression tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { GcrError } from '../../src/errors.js';
import { communities, communityMembers, escapeLike, explainEdge, godNodes, graphQuery, graphStats, neighbors, shortestPath } from '../../src/graph/query.js';

function rawDb(): DatabaseSync {
  return openDatabase(':memory:').db;
}

const kwId = (w: string): string => `ent:keyword:${w}`;
const cvId = (c: string): string => `conv:chatgpt:default:${c}`;

function addNode(db: DatabaseSync, id: string, kind: 'conversation' | 'entity' | 'tool', label: string, weight = 1): void {
  db.prepare('INSERT INTO graph_nodes (node_id, kind, label, ref, weight) VALUES (?, ?, ?, NULL, ?)').run(id, kind, label, weight);
}

function addEdge(db: DatabaseSync, src: string, dst: string, kind: 'mentioned_in' | 'co_occurs' | 'uses_tool', weight: number): number {
  return Number(db.prepare('INSERT INTO graph_edges (src, dst, kind, weight) VALUES (?, ?, ?, ?)').run(src, dst, kind, weight).lastInsertRowid);
}

function inTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function expectCode(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

describe('defects found by review: graphQuery with a kinds filter next to a giant hub', () => {
  // The neighbour fetch was limited to maxNodes + visited + 1 rows BEFORE the kinds filter was applied, so a hub whose
  // heaviest edges all lead to filtered-out kinds silently lost every allowed neighbour (and truncated stayed false).
  function hubDb(conversationNeighbours: number, keywordNeighbours: number): DatabaseSync {
    const db = rawDb();
    inTransaction(db, () => {
      addNode(db, kwId('hub'), 'entity', 'hub');
      for (let i = 0; i < conversationNeighbours; i++) {
        addNode(db, cvId(`c${i}`), 'conversation', `Conversation ${i}`);
        addEdge(db, kwId('hub'), cvId(`c${i}`), 'mentioned_in', 5);
      }
      for (let i = 0; i < keywordNeighbours; i++) {
        addNode(db, kwId(`k${String(i).padStart(3, '0')}`), 'entity', `k${i}`);
        addEdge(db, kwId('hub'), kwId(`k${String(i).padStart(3, '0')}`), 'co_occurs', 1);
      }
    });
    return db;
  }

  it('finds every allowed neighbour even when thousands of heavier edges lead to filtered-out kinds', () => {
    const db = hubDb(300, 5);
    const r = graphQuery(db, { term: 'hub', depth: 1, maxNodes: 100, kinds: ['entity'] });
    assert.deepEqual(r.nodes.map((n) => n.id).sort(), [kwId('hub'), ...[0, 1, 2, 3, 4].map((i) => kwId(`k00${i}`))].sort());
    assert.equal(r.truncated, false);
    assert.equal(r.edges.length, 5);
  });

  it('works for entity-kind filters, deeper levels and tiny maxNodes as well', () => {
    const db = hubDb(300, 5);
    const byKeyword = graphQuery(db, { term: 'hub', depth: 2, maxNodes: 100, kinds: ['keyword'] });
    assert.equal(byKeyword.nodes.length, 6);
    const small = graphQuery(db, { term: 'hub', depth: 1, maxNodes: 3, kinds: ['keyword'] });
    assert.equal(small.nodes.length, 3);
    assert.equal(small.truncated, true, 'allowed neighbours were left out, so the result must say so');
  });

  it('reports truncation when MORE allowed neighbours exist than fit', () => {
    const db = hubDb(300, 250);
    const r = graphQuery(db, { term: 'hub', depth: 1, maxNodes: 100, kinds: ['entity'] });
    assert.equal(r.nodes.length, 100);
    assert.equal(r.truncated, true);
    assert.ok(r.nodes.every((n) => n.kind === 'entity'));
  });

  it('an unfiltered query is unchanged: the heaviest neighbours come first', () => {
    const db = hubDb(300, 5);
    const r = graphQuery(db, { term: 'hub', depth: 1, maxNodes: 10 });
    assert.equal(r.nodes.length, 10);
    assert.equal(r.truncated, true);
    assert.ok(r.nodes.slice(1).every((n) => n.kind === 'conversation'), 'weight 5 edges outrank weight 1 edges');
  });
});

describe('defects found by review: shortestPath must stay exact next to a hub with more than 10 000 edges', () => {
  // Only the 10 000 heaviest edges of a node were expanded. A path through a lighter edge was never seen, the longer path
  // through heavy edges was returned as "the shortest", and truncated was false.
  function hubPathDb(extraEdges: number): DatabaseSync {
    const db = rawDb();
    inTransaction(db, () => {
      for (const w of ['s', 't', 'm', 'x1', 'x2', 'x3']) addNode(db, kwId(w), 'entity', w);
      addEdge(db, kwId('m'), kwId('s'), 'co_occurs', 1); // short path s - m - t over light edges
      addEdge(db, kwId('m'), kwId('t'), 'co_occurs', 1);
      addEdge(db, kwId('s'), kwId('x1'), 'co_occurs', 100); // long path s - x1 - x2 - x3 - t over heavy edges
      addEdge(db, kwId('x1'), kwId('x2'), 'co_occurs', 100);
      addEdge(db, kwId('x2'), kwId('x3'), 'co_occurs', 100);
      addEdge(db, kwId('t'), kwId('x3'), 'co_occurs', 100);
      for (let i = 0; i < extraEdges; i++) {
        addNode(db, kwId(`f${i}`), 'entity', `f${i}`);
        addEdge(db, kwId('s'), kwId(`f${i}`), 'co_occurs', 50);
      }
    });
    return db;
  }

  it('returns the two-hop path although 10 005 heavier edges leave the start node', () => {
    const db = hubPathDb(10_005);
    const r = shortestPath(db, kwId('s'), kwId('t'));
    assert.equal(r.found, true);
    assert.deepEqual(r.path.map((n) => n.id), [kwId('s'), kwId('m'), kwId('t')]);
    assert.equal(r.edges.length, 2);
    assert.equal(r.truncated, false);
  });

  it('agrees with a small hub (same graph, 5 filler edges)', () => {
    const db = hubPathDb(5);
    assert.deepEqual(shortestPath(db, kwId('s'), kwId('t')).path.map((n) => n.id), [kwId('s'), kwId('m'), kwId('t')]);
  });

  it('a hub in the middle of the path does not hide the light edge either', () => {
    const db = rawDb();
    inTransaction(db, () => {
      for (const w of ['a', 'b', 'hub']) addNode(db, kwId(w), 'entity', w);
      addEdge(db, kwId('a'), kwId('hub'), 'co_occurs', 1);
      addEdge(db, kwId('hub'), kwId('b'), 'co_occurs', 1);
      for (let i = 0; i < 10_050; i++) {
        addNode(db, kwId(`f${i}`), 'entity', `f${i}`);
        addEdge(db, kwId('hub'), kwId(`f${i}`), 'co_occurs', 9);
      }
    });
    const r = shortestPath(db, kwId('a'), kwId('b'));
    assert.deepEqual(r.path.map((n) => n.id), [kwId('a'), kwId('hub'), kwId('b')]);
  });

  it('the exploration budget is still honoured and reported on a hub', () => {
    const db = hubPathDb(10_005);
    const r = shortestPath(db, kwId('s'), kwId('t'), { maxExplored: 50 });
    assert.equal(r.found, false);
    assert.equal(r.truncated, true);
    assert.ok(r.exploredNodes <= 50);
  });
});

describe('differential check against a reference breadth-first search (kinds filter, random graphs)', () => {
  // Small deterministic PRNG so the graphs are reproducible without extra dependencies.
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('graphQuery(depth, kinds) equals the ball of that radius over allowed nodes only', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = prng(seed);
      const db = rawDb();
      const n = 12 + Math.floor(rnd() * 25);
      const ids: string[] = [];
      const kindOf = new Map<string, 'conversation' | 'entity' | 'tool'>();
      inTransaction(db, () => {
        for (let i = 0; i < n; i++) {
          const k = rnd() < 0.3 ? 'conversation' : rnd() < 0.2 ? 'tool' : 'entity';
          const id = k === 'conversation' ? cvId(`n${i}`) : k === 'tool' ? `tool:n${i}` : kwId(`n${i}`);
          ids.push(id);
          kindOf.set(id, k);
          addNode(db, id, k, `label ${i}`);
        }
        const seen = new Set<string>();
        for (let e = 0; e < n * 2; e++) {
          const a = ids[Math.floor(rnd() * n)] as string;
          const b = ids[Math.floor(rnd() * n)] as string;
          if (a === b || seen.has(`${a}|${b}`) || seen.has(`${b}|${a}`)) continue;
          seen.add(`${a}|${b}`);
          addEdge(db, a, b, 'co_occurs', 1 + Math.floor(rnd() * 5));
        }
      });
      const adj = new Map<string, string[]>(ids.map((i) => [i, []]));
      for (const r of db.prepare('SELECT src, dst FROM graph_edges').all()) {
        adj.get(String(r['src']))?.push(String(r['dst']));
        adj.get(String(r['dst']))?.push(String(r['src']));
      }
      const kindsChoices: string[][] = [['entity'], ['conversation', 'tool'], ['entity', 'tool'], ['conversation']];
      const kinds = kindsChoices[seed % kindsChoices.length] as string[];
      const allowed = (id: string): boolean => kinds.includes(kindOf.get(id) as string);
      const seedId = ids.find(allowed);
      if (seedId === undefined) continue;
      const depth = 1 + (seed % 4);
      const dist = new Map<string, number>([[seedId, 0]]);
      const queue = [seedId];
      while (queue.length > 0) {
        const cur = queue.shift() as string;
        if ((dist.get(cur) as number) >= depth) continue;
        for (const o of adj.get(cur) ?? []) {
          if (dist.has(o) || !allowed(o)) continue;
          dist.set(o, (dist.get(cur) as number) + 1);
          queue.push(o);
        }
      }
      const got = graphQuery(db, { term: seedId, depth, maxNodes: 500, kinds });
      assert.deepEqual(got.nodes.map((x) => x.id).sort(), [...dist.keys()].sort(), `seed ${seed}`);
      assert.equal(got.truncated, false, `seed ${seed}`);
    }
  });
});

describe('determinism and ordering', () => {
  it('equal-weight neighbours are visited in edge-id order, whatever the order of the node rows', () => {
    const build = (reverse: boolean): string => {
      const db = rawDb();
      const names = ['a', 'b', 'c', 'd', 'e', 'f'];
      inTransaction(db, () => {
        addNode(db, kwId('root'), 'entity', 'root');
        for (const w of reverse ? [...names].reverse() : names) addNode(db, kwId(w), 'entity', w);
        for (const w of names) addEdge(db, kwId('root'), kwId(w), 'co_occurs', 2);
      });
      return JSON.stringify(graphQuery(db, { term: 'root', depth: 1, maxNodes: 4 }));
    };
    assert.equal(build(false), build(true));
  });

  it('godNodes and neighbors give a total order on weight ties', () => {
    const db = rawDb();
    inTransaction(db, () => {
      for (const w of ['p', 'q', 'r', 's']) addNode(db, kwId(w), 'entity', w);
      addEdge(db, kwId('p'), kwId('q'), 'co_occurs', 3);
      addEdge(db, kwId('r'), kwId('s'), 'co_occurs', 3);
    });
    const ids = godNodes(db, { limit: 4 }).map((g) => g.node.id);
    assert.deepEqual(ids, [kwId('p'), kwId('q'), kwId('r'), kwId('s')]);
    assert.deepEqual(godNodes(db, { limit: 4 }).map((g) => g.node.id), ids);
  });
});

describe('negative tests for every exported query function', () => {
  it('escapeLike leaves nothing that LIKE would treat as a wildcard unescaped', () => {
    assert.equal(escapeLike(''), '');
    assert.equal(escapeLike('%_\\%_\\'), '\\%\\_\\\\\\%\\_\\\\');
    assert.equal(escapeLike("it's [a-z]*"), "it's [a-z]*");
  });

  it('every function maps a closed or foreign database to a GcrError, never to a raw error', () => {
    const closed = rawDb();
    closed.close();
    const calls: Array<() => unknown> = [
      () => graphQuery(closed, { term: 'x' }),
      () => shortestPath(closed, 'a', 'b'),
      () => neighbors(closed, 'a'),
      () => godNodes(closed),
      () => communities(closed),
      () => communityMembers(closed, 1),
      () => graphStats(closed),
      () => explainEdge(closed, { edgeId: 1 }),
    ];
    for (const call of calls) {
      assert.throws(call, (e: unknown) => e instanceof GcrError && ['DB_ERROR', 'WRITE_FORBIDDEN'].includes(e.code), String(call));
    }
  });

  it('bad arguments are rejected before the database is touched', () => {
    const closed = rawDb();
    closed.close();
    assert.throws(() => graphQuery(closed, { term: '' }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => shortestPath(closed, '', 'b'), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => neighbors(closed, 'a', { limit: 0 }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => godNodes(closed, { limit: 501 }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => communities(closed, { topNodes: -1 }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => communityMembers(closed, 0), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => explainEdge(closed, { edgeId: 0 }), expectCode('INVALID_ARGUMENT'));
  });

  it('terms with lone surrogates, NUL-free control characters and 512 characters do not throw', () => {
    const db = rawDb();
    addNode(db, kwId('alpha'), 'entity', 'alpha');
    for (const term of ['\ud800', 'a\u0001b', '\u{202E}', 'x'.repeat(512), '%'.repeat(512), '\\'.repeat(512)]) {
      assert.doesNotThrow(() => graphQuery(db, { term }), JSON.stringify(term.slice(0, 20)));
    }
  });

  it('a node id that is a prefix or LIKE pattern of other ids is only matched exactly by the id path', () => {
    const db = rawDb();
    addNode(db, kwId('alpha'), 'entity', 'one');
    addNode(db, kwId('alphabet'), 'entity', 'two');
    assert.deepEqual(graphQuery(db, { term: kwId('alpha'), depth: 1 }).seeds, [kwId('alpha')]);
    assert.deepEqual(graphQuery(db, { term: `${kwId('alpha')}%`, depth: 1 }).seeds, []);
  });

  it('explainEdge on an edge whose evidence rows were removed returns an empty list, not an error', () => {
    const db = rawDb();
    addNode(db, kwId('a'), 'entity', 'a');
    addNode(db, kwId('b'), 'entity', 'b');
    const id = addEdge(db, kwId('a'), kwId('b'), 'co_occurs', 1);
    const r = explainEdge(db, { edgeId: id });
    assert.deepEqual([r.evidence, r.evidenceTotal], [[], 0]);
  });
});
