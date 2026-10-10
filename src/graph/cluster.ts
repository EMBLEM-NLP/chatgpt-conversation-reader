/**
 * Deterministic community detection for the derived graph (SPEC FR-12).
 *
 * Algorithm: asynchronous weighted label propagation.
 *  - Every node starts with its own label = its rank in the sorted node-id list.
 *  - Nodes are visited in SORTED-ID order, in place (a node sees the labels its predecessors already chose in this pass).
 *  - A node adopts the label with the greatest total incident edge weight among its neighbours; ties go to the SMALLEST
 *    label (= the smallest node id of that label's origin). No randomness, no clock, no hash-order dependence, so the same
 *    graph always yields the same communities (tested by byte-comparing repeated runs).
 *  - It stops when a full pass changes nothing, or after `maxIterations` passes (reported as not converged).
 *
 * Output: `graph_nodes.community_id` (1..K, communities ordered by size desc then smallest member id) and one
 * `graph_communities` row per community with a short label made of its three most connected member labels (UNTRUSTED
 * text derived from imported content). Nodes without any edge get community_id NULL and no community.
 *
 * Complexity: O(maxIterations * (V + E)) time, O(V + E) memory (compressed adjacency in typed arrays).
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { toDbError } from '../db/open.js';
import { GcrError } from '../errors.js';

export const DEFAULT_MAX_ITERATIONS = 50;
const MAX_ITERATIONS_LIMIT = 1000;
const COMMUNITY_LABEL_PARTS = 3;
const COMMUNITY_LABEL_MAX_CHARS = 160;

export interface ClusterOptions {
  /** 1..1000, default 50. */
  maxIterations?: number;
}

export interface ClusterResult {
  /** Communities written (nodes with at least one edge only). */
  communities: number;
  /** Full passes performed. */
  iterations: number;
  /** false when maxIterations was reached while labels were still changing. */
  converged: boolean;
  /** Nodes that received a community id. */
  assignedNodes: number;
}

export interface PropagationResult {
  labels: Int32Array;
  iterations: number;
  converged: boolean;
}

function badArg(field: string, why: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field } });
}

export function resolveMaxIterations(v: unknown): number {
  if (v === undefined) return DEFAULT_MAX_ITERATIONS;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_ITERATIONS_LIMIT) {
    throw badArg('maxIterations', `expected an integer from 1 to ${MAX_ITERATIONS_LIMIT}`);
  }
  return v;
}

/**
 * Pure label propagation over `nodeCount` nodes (indices 0..n-1, assumed to be in sorted-id order) and an undirected,
 * weighted edge list. Self loops, non-finite or non-positive weights and out-of-range endpoints are ignored.
 * Returns each node's final label (a node index) — isolated nodes keep their own index.
 */
export function labelPropagation(
  nodeCount: number,
  edgeSrc: ArrayLike<number>,
  edgeDst: ArrayLike<number>,
  edgeWeight: ArrayLike<number>,
  maxIterations: number,
): PropagationResult {
  const n = nodeCount;
  const m = Math.min(edgeSrc.length, edgeDst.length, edgeWeight.length);
  // Compressed sparse row adjacency: offsets[i]..offsets[i+1] index into targets/weights.
  const degree = new Int32Array(n + 1);
  const keep = new Uint8Array(m);
  for (let e = 0; e < m; e++) {
    const a = edgeSrc[e] as number;
    const b = edgeDst[e] as number;
    const w = edgeWeight[e] as number;
    if (!(w > 0) || !Number.isFinite(w) || a === b || a < 0 || b < 0 || a >= n || b >= n) continue;
    keep[e] = 1;
    degree[a] = (degree[a] as number) + 1;
    degree[b] = (degree[b] as number) + 1;
  }
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = (offsets[i] as number) + (degree[i] as number);
  const total = offsets[n] as number;
  const targets = new Int32Array(total);
  const weights = new Float64Array(total);
  const fill = Int32Array.from(offsets.subarray(0, n));
  for (let e = 0; e < m; e++) {
    if (keep[e] === 0) continue;
    const a = edgeSrc[e] as number;
    const b = edgeDst[e] as number;
    const w = edgeWeight[e] as number;
    const pa = fill[a] as number;
    targets[pa] = b;
    weights[pa] = w;
    fill[a] = pa + 1;
    const pb = fill[b] as number;
    targets[pb] = a;
    weights[pb] = w;
    fill[b] = pb + 1;
  }

  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = i;
  const score = new Float64Array(n); // score[label] = summed weight for the node being processed
  const touched: number[] = [];
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations) {
    iterations++;
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const from = offsets[i] as number;
      const to = offsets[i + 1] as number;
      if (from === to) continue; // isolated
      touched.length = 0;
      for (let p = from; p < to; p++) {
        const label = labels[targets[p] as number] as number;
        if ((score[label] as number) === 0) touched.push(label);
        score[label] = (score[label] as number) + (weights[p] as number);
      }
      let best = -1;
      let bestScore = -1;
      for (const label of touched) {
        const s = score[label] as number;
        // Weights are integers stored as doubles, so equality is exact; ties -> smallest label.
        if (s > bestScore || (s === bestScore && label < best)) {
          best = label;
          bestScore = s;
        }
        score[label] = 0;
      }
      if (best !== labels[i]) {
        labels[i] = best;
        changed++;
      }
    }
    if (changed === 0) {
      converged = true;
      break;
    }
  }
  return { labels, iterations, converged };
}

type Row = Record<string, SQLOutputValue>;

function str(r: Row, k: string): string {
  const v = r[k];
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function num(r: Row, k: string): number {
  const v = r[k];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

/** Plain `<` comparison: identical on every platform (no locale), and the order the algorithm documents. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recompute graph_nodes.community_id and graph_communities from the current graph_nodes/graph_edges.
 * Runs inside the caller's transaction when there is one, otherwise in its own BEGIN IMMEDIATE ... COMMIT.
 */
export function clusterGraph(db: DatabaseSync, opts: ClusterOptions = {}): ClusterResult {
  const maxIterations = resolveMaxIterations(opts.maxIterations);
  const ownTransaction = !db.isTransaction;
  try {
    if (ownTransaction) db.exec('BEGIN IMMEDIATE');
    const result = clusterInTransaction(db, maxIterations);
    if (ownTransaction) db.exec('COMMIT');
    return result;
  } catch (e) {
    if (ownTransaction && db.isTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the first failure is the one worth reporting */
      }
    }
    throw e instanceof GcrError ? e : toDbError(e);
  }
}

function clusterInTransaction(db: DatabaseSync, maxIterations: number): ClusterResult {
  // Sorted node list: this order IS the processing order, so it must not depend on SQLite's collation.
  const nodes: Array<{ id: string; kind: string; label: string }> = [];
  for (const r of db.prepare('SELECT node_id, kind, label FROM graph_nodes').iterate()) {
    nodes.push({ id: str(r, 'node_id'), kind: str(r, 'kind'), label: str(r, 'label') });
  }
  nodes.sort((a, b) => compareIds(a.id, b.id));
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));

  const src: number[] = [];
  const dst: number[] = [];
  const weight: number[] = [];
  for (const r of db.prepare('SELECT src, dst, weight FROM graph_edges ORDER BY edge_id').iterate()) {
    const a = index.get(str(r, 'src'));
    const b = index.get(str(r, 'dst'));
    if (a === undefined || b === undefined) continue; // dangling edge: cannot belong to a community
    src.push(a);
    dst.push(b);
    weight.push(num(r, 'weight'));
  }

  const { labels, iterations, converged } = labelPropagation(nodes.length, src, dst, weight, maxIterations);

  // Weighted degree decides which members name a community (and which nodes are isolated).
  const wdeg = new Float64Array(nodes.length);
  const hasEdge = new Uint8Array(nodes.length);
  for (let e = 0; e < src.length; e++) {
    const a = src[e] as number;
    const b = dst[e] as number;
    const w = weight[e] as number;
    if (a === b || !(w > 0) || !Number.isFinite(w)) continue;
    wdeg[a] = (wdeg[a] as number) + w;
    wdeg[b] = (wdeg[b] as number) + w;
    hasEdge[a] = 1;
    hasEdge[b] = 1;
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    if (hasEdge[i] === 0) continue;
    const label = labels[i] as number;
    const list = members.get(label);
    if (list === undefined) members.set(label, [i]);
    else list.push(i);
  }
  // Members are already in ascending index (= id) order, so members[0] is the smallest id of the community.
  const ordered = Array.from(members.values()).sort((a, b) => b.length - a.length || (a[0] as number) - (b[0] as number));

  db.exec('DELETE FROM graph_communities');
  db.exec('UPDATE graph_nodes SET community_id = NULL');
  const setCommunity = db.prepare('UPDATE graph_nodes SET community_id = ? WHERE node_id = ?');
  const insertCommunity = db.prepare('INSERT INTO graph_communities (community_id, size, label) VALUES (?, ?, ?)');
  let communityId = 0;
  let assigned = 0;
  for (const list of ordered) {
    communityId++;
    for (const i of list) {
      setCommunity.run(communityId, (nodes[i] as { id: string }).id);
      assigned++;
    }
    // Name: the three most connected members, preferring entities/tools over conversation titles.
    const preferred = list.filter((i) => (nodes[i] as { kind: string }).kind !== 'conversation');
    const pool = preferred.length > 0 ? preferred : list;
    const top = [...pool].sort((a, b) => (wdeg[b] as number) - (wdeg[a] as number) || a - b).slice(0, COMMUNITY_LABEL_PARTS);
    let label = top.map((i) => (nodes[i] as { label: string }).label).join(', ');
    if (label.length > COMMUNITY_LABEL_MAX_CHARS) label = label.slice(0, COMMUNITY_LABEL_MAX_CHARS);
    insertCommunity.run(communityId, list.length, label);
  }
  return { communities: communityId, iterations, converged, assignedNodes: assigned };
}
