/**
 * Read-only queries over the derived graph (SPEC FR-12 "graph query, shortest path"; NFR-08 provenance).
 *
 * Every function reads `graph_nodes`, `graph_edges`, `graph_edge_evidence` (and, for explainEdge, the immutable imported
 * `messages` / `conversations` tables). All SQL is static text with BOUND parameters; the only assembled SQL is a run of
 * `?` placeholders whose count comes from code. Search terms are matched with `LIKE ? ESCAPE '\'` after escaping `%`, `_`
 * and `\` (so "%" and "_" are ordinary characters) or by exact normalized node id; they are never concatenated into SQL.
 *
 * DTOs carry node LABELS (UNTRUSTED text cut from imported conversations) and ids, never message text. Callers that render
 * labels must escape them (export-html.ts does).
 *
 * Determinism: neighbours are always visited in (weight desc, edge id asc) order, seeds in (exact match first, weight
 * desc, node id asc) order, so BFS results, truncation points and shortest-path ties are reproducible.
 * Bounds: depth 1..4, maxNodes 1..500, subgraph edges <= 5000, per-node neighbour fan-out limited, explored-node budget for
 * shortest paths; hitting a bound is reported (`truncated`), never silent.
 */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { toDbError } from '../db/open.js';
import { analyzeTree } from '../domain/branches.js';
import type { MessageRecord } from '../domain/types.js';
import { ENTITY_KINDS, normalizeNfkc, sanitizeUrl } from '../entities/extract.js';
import type { EntityKind } from '../entities/extract.js';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { EDGE_KINDS, NODE_KINDS, entityNodeId, parseNodeId } from './build.js';
import type { EdgeKind, NodeKind } from './build.js';

// ---------------------------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------------------------

export interface GraphNodeDto {
  id: string;
  kind: NodeKind;
  /** For entity and tool nodes: the entity kind ('tool' for tools); null for conversations. */
  entityKind: EntityKind | null;
  /** UNTRUSTED. */
  label: string;
  weight: number;
  communityId: number | null;
  /** Set for conversation nodes: which stored conversation the node stands for. */
  conversation: { provider: string; accountLabel: string; conversationId: string } | null;
}

export interface GraphEdgeDto {
  id: number;
  src: string;
  dst: string;
  kind: EdgeKind;
  weight: number;
}

export interface GraphQueryInput {
  term: string;
  /** 1..4, default 2. */
  depth?: number;
  /** 1..500, default 100. */
  maxNodes?: number;
  /** Node kinds ('conversation' | 'entity' | 'tool') and/or entity kinds ('url', 'keyword', ...) to keep. */
  kinds?: string[];
}

export interface GraphQueryResult {
  seeds: string[];
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  truncated: boolean;
  warnings: Warning[];
}

export interface PathResult {
  found: boolean;
  path: GraphNodeDto[];
  edges: GraphEdgeDto[];
  /** Nodes discovered by the search. */
  exploredNodes: number;
  /** true when a search budget (maxDepth is NOT one) was exhausted: found=false then means "not found within budget". */
  truncated: boolean;
}

export interface NeighborDto {
  node: GraphNodeDto;
  edge: GraphEdgeDto;
  /** 'out': the edge starts at the queried node; 'in': it ends there. */
  direction: 'out' | 'in';
}

export interface NeighborsResult {
  node: GraphNodeDto;
  neighbors: NeighborDto[];
  /** Total neighbours matching the filters. */
  total: number;
  truncated: boolean;
}

export interface GodNode {
  node: GraphNodeDto;
  degree: number;
  weightedDegree: number;
}

export interface CommunityDto {
  communityId: number;
  size: number;
  /** UNTRUSTED. */
  label: string | null;
  topNodes: GraphNodeDto[];
}

export interface EvidenceDto {
  provider: string;
  accountLabel: string;
  conversationId: string;
  messageId: string | null;
  batchId: string;
  /** Branch ids (leaf ids) whose root->leaf path contains messageId; [] when messageId is null or not in the stored tree. */
  branchIds: string[];
}

export interface ExplainEdgeResult {
  edge: GraphEdgeDto;
  evidence: EvidenceDto[];
  /** All evidence rows stored for the edge (evidence may be longer than the requested limit). */
  evidenceTotal: number;
  warnings: Warning[];
}

export interface GraphStats {
  nodes: number;
  edges: number;
  communities: number;
  entities: number;
  /** false when graph_nodes is empty (never built, or built over no data). */
  built: boolean;
}

export const MAX_QUERY_NODES = 500;
export const MAX_QUERY_DEPTH = 4;
const DEFAULT_QUERY_NODES = 100;
const DEFAULT_QUERY_DEPTH = 2;
const MAX_SUBGRAPH_EDGES = 5000;
const MAX_TERM_CHARS = 512;
const SHORTEST_PATH_FANOUT = 10_000;
const DEFAULT_PATH_EXPLORE_BUDGET = 100_000;
const MAX_EVIDENCE_LIMIT = 1000;
const DEFAULT_EVIDENCE_LIMIT = 100;
const MAX_BRANCH_IDS_PER_EVIDENCE = 1000;

// ---------------------------------------------------------------------------------------------------------------
// Validation and row mapping
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

function badArg(field: string, why: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field } });
}

function intArg(field: string, v: unknown, dflt: number, min: number, max: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badArg(field, `expected an integer from ${min} to ${max}`);
  return v;
}

function idArg(field: string, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096 || v.includes('\0')) throw badArg(field, 'expected a non-empty string without NUL bytes');
  return v;
}

function str(r: Row, k: string): string {
  const v = r[k];
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function strOrNull(r: Row, k: string): string | null {
  const v = r[k];
  return v === null || v === undefined ? null : typeof v === 'string' ? v : String(v);
}

function num(r: Row, k: string): number {
  const v = r[k];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

function numOrNull(r: Row, k: string): number | null {
  const v = r[k];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw e instanceof GcrError ? e : toDbError(e);
  }
}

function notInExport(which: string): GcrError {
  // The id is deliberately not echoed: node ids embed entity text from imported conversations.
  return new GcrError('NOT_IN_LOCAL_EXPORT', `The ${which} is not a node of the local graph.`, {
    remedy: 'Run a graph query to find node ids, or rebuild the graph after importing your export.',
    details: { which },
  });
}

const NODE_COLUMNS = 'node_id, kind, label, ref, weight, community_id';

function nodeKindOf(v: string): NodeKind {
  return (NODE_KINDS as readonly string[]).includes(v) ? (v as NodeKind) : 'entity';
}

function nodeFromRow(r: Row): GraphNodeDto {
  const id = str(r, 'node_id');
  const parsed = parseNodeId(id);
  const kind = nodeKindOf(str(r, 'kind'));
  return {
    id,
    kind,
    entityKind: parsed !== null && parsed.type !== 'conversation' ? parsed.kind : null,
    label: str(r, 'label'),
    weight: num(r, 'weight'),
    communityId: numOrNull(r, 'community_id'),
    conversation:
      parsed !== null && parsed.type === 'conversation'
        ? { provider: parsed.provider, accountLabel: parsed.accountLabel, conversationId: parsed.conversationId }
        : null,
  };
}

function edgeFromRow(r: Row): GraphEdgeDto {
  const kind = str(r, 'kind');
  return {
    id: num(r, 'edge_id'),
    src: str(r, 'src'),
    dst: str(r, 'dst'),
    kind: (EDGE_KINDS as readonly string[]).includes(kind) ? (kind as EdgeKind) : 'co_occurs',
    weight: num(r, 'weight'),
  };
}

function getNode(db: DatabaseSync, id: string): GraphNodeDto | null {
  const r = db.prepare(`SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE node_id = ?`).get(id);
  return r === undefined ? null : nodeFromRow(r);
}

function requireNode(db: DatabaseSync, id: string, which: string): GraphNodeDto {
  const n = getNode(db, id);
  if (n === null) throw notInExport(which);
  return n;
}

/** Cache in front of getNode for one query. */
class NodeCache {
  private readonly map = new Map<string, GraphNodeDto | null>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Remember a node that was already read. */
  set(node: GraphNodeDto): void {
    this.map.set(node.id, node);
  }

  get(id: string): GraphNodeDto | null {
    const hit = this.map.get(id);
    if (hit !== undefined) return hit;
    const n = getNode(this.db, id);
    this.map.set(id, n);
    return n;
  }
}

function kindFilter(field: string, kinds: unknown): ReadonlySet<string> | null {
  if (kinds === undefined) return null;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > 16) throw badArg(field, 'expected a non-empty list of kinds');
  const allowed = new Set<string>([...NODE_KINDS, ...ENTITY_KINDS]);
  for (const k of kinds as unknown[]) {
    if (typeof k !== 'string' || !allowed.has(k)) throw badArg(field, `expected kinds from: ${[...allowed].join(', ')}`);
  }
  return new Set(kinds as string[]);
}

function nodeAllowed(node: GraphNodeDto, kinds: ReadonlySet<string> | null): boolean {
  if (kinds === null) return true;
  return kinds.has(node.kind) || (node.entityKind !== null && kinds.has(node.entityKind));
}

// ---------------------------------------------------------------------------------------------------------------
// Neighbour access
// ---------------------------------------------------------------------------------------------------------------

const NEIGHBOR_SQL =
  'SELECT edge_id, src, dst, kind, weight FROM graph_edges WHERE src = ? UNION ALL ' +
  'SELECT edge_id, src, dst, kind, weight FROM graph_edges WHERE dst = ? ORDER BY weight DESC, edge_id ASC LIMIT ?';

function neighborEdges(db: DatabaseSync, id: string, limit: number): GraphEdgeDto[] {
  return db.prepare(NEIGHBOR_SQL).all(id, id, limit).map(edgeFromRow);
}

function otherEnd(e: GraphEdgeDto, id: string): string {
  return e.src === id ? e.dst : e.src;
}

/** `(?, ?, ...)` with exactly `n` placeholders; n comes from code, never from user text. */
function placeholders(n: number): string {
  return `(${new Array<string>(n).fill('?').join(', ')})`;
}

// ---------------------------------------------------------------------------------------------------------------
// graphQuery
// ---------------------------------------------------------------------------------------------------------------

/** Escape LIKE metacharacters so the term is matched literally (paired with ESCAPE '\'). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function termCandidates(term: string): { patterns: string[]; ids: string[]; lowered: string } {
  const folded = normalizeNfkc(term);
  const lower = folded.toLowerCase();
  const upper = folded.toUpperCase();
  const patterns = Array.from(new Set([term, lower, upper])).map((t) => `%${escapeLike(t)}%`);
  const ids: string[] = [term];
  // Exact normalized node ids: "python" is both a keyword and a tool, a URL is looked up in its sanitized form.
  for (const kind of ENTITY_KINDS) ids.push(entityNodeId(kind, lower));
  const url = sanitizeUrl(term);
  if (url !== null) ids.push(entityNodeId('url', url.normalized));
  return { patterns, ids: Array.from(new Set(ids)), lowered: lower };
}

function findSeeds(db: DatabaseSync, term: string, kinds: ReadonlySet<string> | null, limit: number): { seeds: GraphNodeDto[]; more: boolean } {
  const c = termCandidates(term);
  // ids.length is bounded by ENTITY_KINDS.length + 2, patterns.length <= 3.
  const likeClauses = c.patterns.map(() => "label LIKE ? ESCAPE '\\'").join(' OR ');
  const sql =
    `SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE node_id IN ${placeholders(c.ids.length)} OR ${likeClauses} ` +
    'ORDER BY CASE WHEN node_id IN ' +
    placeholders(c.ids.length) +
    ' THEN 0 WHEN lower(label) = ? THEN 1 ELSE 2 END ASC, weight DESC, node_id ASC';
  const params: SQLInputValue[] = [...c.ids, ...c.patterns, ...c.ids, c.lowered];
  const seeds: GraphNodeDto[] = [];
  let more = false;
  for (const r of db.prepare(sql).iterate(...params)) {
    const node = nodeFromRow(r);
    if (!nodeAllowed(node, kinds)) continue;
    if (seeds.length >= limit) {
      more = true;
      break;
    }
    seeds.push(node);
  }
  return { seeds, more };
}

/** Edges among `ids` (each edge is found once, from its src side, using the (src, dst, kind) unique index). */
function inducedEdges(db: DatabaseSync, ids: readonly string[]): GraphEdgeDto[] {
  if (ids.length === 0) return [];
  const sql = `SELECT edge_id, src, dst, kind, weight FROM graph_edges WHERE src = ? AND dst IN ${placeholders(ids.length)}`;
  const stmt = db.prepare(sql);
  const out: GraphEdgeDto[] = [];
  for (const id of ids) {
    for (const r of stmt.all(id, ...ids)) out.push(edgeFromRow(r));
  }
  return out;
}

/**
 * Breadth-first neighbourhood of every node matching `term`. A node matches when its id equals the term (or its
 * normalized form), or its label contains the term (case-insensitive for ASCII; NFKC lower/upper variants are tried too).
 * `kinds` restricts the whole subgraph (seeds and traversal) to those node/entity kinds.
 * Nodes beyond `maxNodes` are not returned and `truncated` is true; edges are those among the returned nodes.
 */
export function graphQuery(db: DatabaseSync, q: GraphQueryInput): GraphQueryResult {
  if (typeof q !== 'object' || q === null) throw badArg('query', 'expected an object');
  if (typeof q.term !== 'string') throw badArg('term', 'expected a string');
  const term = q.term.trim();
  if (term.length === 0) throw badArg('term', 'expected a non-empty string');
  if (term.length > MAX_TERM_CHARS || term.includes('\0')) throw badArg('term', `expected at most ${MAX_TERM_CHARS} characters without NUL bytes`);
  const depth = intArg('depth', q.depth, DEFAULT_QUERY_DEPTH, 1, MAX_QUERY_DEPTH);
  const maxNodes = intArg('maxNodes', q.maxNodes, DEFAULT_QUERY_NODES, 1, MAX_QUERY_NODES);
  const kinds = kindFilter('kinds', q.kinds);

  return guard(() => {
    const warnings: Warning[] = [];
    const cache = new NodeCache(db);
    const { seeds, more: seedsTruncated } = findSeeds(db, term, kinds, maxNodes);
    let truncated = seedsTruncated;
    if (seedsTruncated) {
      warnings.push({ code: 'SEEDS_TRUNCATED', message: `More than ${maxNodes} nodes match the term; only the best ${maxNodes} are used as seeds.` });
    }
    if (seeds.length === 0 && count(db, 'graph_nodes') === 0) {
      warnings.push({ code: 'GRAPH_EMPTY', message: 'The graph has no nodes. Import an export and build the graph first.' });
    }

    const order: string[] = [];
    const visited = new Set<string>();
    for (const s of seeds) {
      visited.add(s.id);
      order.push(s.id);
      cache.set(s);
    }
    let frontier = [...order];
    expand: for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        // Enough rows that, even if every already-visited node is among them, maxNodes unvisited ones remain.
        for (const e of neighborEdges(db, id, maxNodes + visited.size + 1)) {
          const other = otherEnd(e, id);
          if (visited.has(other)) continue;
          const node = cache.get(other);
          if (node === null || !nodeAllowed(node, kinds)) continue;
          if (visited.size >= maxNodes) {
            truncated = true;
            break expand;
          }
          visited.add(other);
          order.push(other);
          next.push(other);
        }
      }
      frontier = next;
    }

    const nodes = order.map((id) => cache.get(id)).filter((n): n is GraphNodeDto => n !== null);
    let edges = inducedEdges(db, order);
    if (edges.length > MAX_SUBGRAPH_EDGES) {
      edges.sort((a, b) => b.weight - a.weight || a.id - b.id);
      edges = edges.slice(0, MAX_SUBGRAPH_EDGES);
      truncated = true;
      warnings.push({ code: 'EDGES_TRUNCATED', message: `The subgraph has more than ${MAX_SUBGRAPH_EDGES} edges; the heaviest ${MAX_SUBGRAPH_EDGES} are returned.` });
    }
    edges.sort((a, b) => a.id - b.id);
    if (truncated && !warnings.some((w) => w.code === 'SEEDS_TRUNCATED' || w.code === 'EDGES_TRUNCATED')) {
      warnings.push({ code: 'NODES_TRUNCATED', message: `The neighbourhood has more than ${maxNodes} nodes; only the first ${maxNodes} in breadth-first order are returned.` });
    }
    return { seeds: seeds.map((s) => s.id), nodes, edges, truncated, warnings };
  });
}

function count(db: DatabaseSync, table: 'graph_nodes' | 'graph_edges' | 'graph_communities' | 'entities'): number {
  const r = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
  return r === undefined ? 0 : num(r, 'n');
}

// ---------------------------------------------------------------------------------------------------------------
// shortestPath
// ---------------------------------------------------------------------------------------------------------------

export interface ShortestPathOptions {
  /** 1..12, default 6. */
  maxDepth?: number;
  /** Nodes the search may discover before giving up. 1..1_000_000, default 100 000. */
  maxExplored?: number;
}

/**
 * Fewest-hop path between two node ids (edges are traversed in both directions). Breadth-first with the deterministic
 * neighbour order, so among equally short paths the same one is always returned. Unknown ids -> NOT_IN_LOCAL_EXPORT.
 */
export function shortestPath(db: DatabaseSync, from: string, to: string, opts: ShortestPathOptions = {}): PathResult {
  const fromId = idArg('from', from);
  const toId = idArg('to', to);
  const maxDepth = intArg('maxDepth', opts.maxDepth, 6, 1, 12);
  const budget = intArg('maxExplored', opts.maxExplored, DEFAULT_PATH_EXPLORE_BUDGET, 1, 1_000_000);

  return guard(() => {
    const start = requireNode(db, fromId, 'start node');
    const goal = requireNode(db, toId, 'target node');
    if (start.id === goal.id) return { found: true, path: [start], edges: [], exploredNodes: 1, truncated: false };

    const parent = new Map<string, { prev: string; edge: GraphEdgeDto }>();
    const seen = new Set<string>([start.id]);
    let frontier = [start.id];
    let truncated = false;
    let found = false;
    search: for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = neighborEdges(db, id, SHORTEST_PATH_FANOUT);
        if (edges.length >= SHORTEST_PATH_FANOUT) truncated = true;
        for (const e of edges) {
          const other = otherEnd(e, id);
          if (seen.has(other)) continue;
          seen.add(other);
          parent.set(other, { prev: id, edge: e });
          if (other === goal.id) {
            found = true;
            break search;
          }
          if (seen.size >= budget) {
            truncated = true;
            break search;
          }
          next.push(other);
        }
      }
      frontier = next;
    }
    if (!found) return { found: false, path: [], edges: [], exploredNodes: seen.size, truncated };

    const ids: string[] = [goal.id];
    const pathEdges: GraphEdgeDto[] = [];
    for (let cur = goal.id; cur !== start.id; ) {
      const p = parent.get(cur);
      if (p === undefined) break; // unreachable: every discovered node has a parent
      pathEdges.push(p.edge);
      ids.push(p.prev);
      cur = p.prev;
    }
    ids.reverse();
    pathEdges.reverse();
    const cache = new NodeCache(db);
    const path = ids.map((id) => cache.get(id)).filter((n): n is GraphNodeDto => n !== null);
    return { found: true, path, edges: pathEdges, exploredNodes: seen.size, truncated: false };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// neighbors / godNodes / communities / stats
// ---------------------------------------------------------------------------------------------------------------

export interface NeighborsOptions {
  /** 1..500, default 50. */
  limit?: number;
  /** Restrict to neighbours of these node/entity kinds. */
  kinds?: string[];
  /** Restrict to these edge kinds. */
  edgeKinds?: string[];
}

export function neighbors(db: DatabaseSync, nodeId: string, opts: NeighborsOptions = {}): NeighborsResult {
  const id = idArg('nodeId', nodeId);
  const limit = intArg('limit', opts.limit, 50, 1, MAX_QUERY_NODES);
  const kinds = kindFilter('kinds', opts.kinds);
  let edgeKinds: ReadonlySet<string> | null = null;
  if (opts.edgeKinds !== undefined) {
    if (!Array.isArray(opts.edgeKinds) || opts.edgeKinds.length === 0 || !opts.edgeKinds.every((k) => (EDGE_KINDS as readonly string[]).includes(k))) {
      throw badArg('edgeKinds', `expected a non-empty list of: ${EDGE_KINDS.join(', ')}`);
    }
    edgeKinds = new Set(opts.edgeKinds);
  }
  return guard(() => {
    const node = requireNode(db, id, 'node');
    const cache = new NodeCache(db);
    const out: NeighborDto[] = [];
    let total = 0;
    const sql =
      'SELECT edge_id, src, dst, kind, weight FROM graph_edges WHERE src = ? UNION ALL ' +
      'SELECT edge_id, src, dst, kind, weight FROM graph_edges WHERE dst = ? ORDER BY weight DESC, edge_id ASC';
    for (const r of db.prepare(sql).iterate(id, id)) {
      const edge = edgeFromRow(r);
      if (edgeKinds !== null && !edgeKinds.has(edge.kind)) continue;
      const other = cache.get(otherEnd(edge, id));
      if (other === null || !nodeAllowed(other, kinds)) continue;
      total++;
      if (out.length < limit) out.push({ node: other, edge, direction: edge.src === id ? 'out' : 'in' });
    }
    return { node, neighbors: out, total, truncated: total > out.length };
  });
}

export interface GodNodesOptions {
  /** 1..500, default 10. */
  limit?: number;
  /** Restrict to node/entity kinds (default: all nodes, conversations included). */
  kinds?: string[];
}

/** Nodes with the highest weighted degree (sum of incident edge weights); ties by degree desc, then node id (SQLite BINARY order). */
export function godNodes(db: DatabaseSync, opts: GodNodesOptions = {}): GodNode[] {
  const limit = intArg('limit', opts.limit, 10, 1, MAX_QUERY_NODES);
  const kinds = kindFilter('kinds', opts.kinds);
  return guard(() => {
    const sql =
      'SELECT id, COUNT(*) AS degree, SUM(weight) AS wdeg FROM (SELECT src AS id, weight FROM graph_edges UNION ALL SELECT dst AS id, weight FROM graph_edges) ' +
      'GROUP BY id ORDER BY wdeg DESC, degree DESC, id ASC';
    const out: GodNode[] = [];
    for (const r of db.prepare(sql).iterate()) {
      const node = getNode(db, str(r, 'id'));
      if (node === null || !nodeAllowed(node, kinds)) continue;
      out.push({ node, degree: num(r, 'degree'), weightedDegree: num(r, 'wdeg') });
      if (out.length >= limit) break;
    }
    return out;
  });
}

export interface CommunitiesOptions {
  /** Top nodes listed per community (by node weight). 0..50, default 5. */
  topNodes?: number;
}

/** All communities, largest first, each with its heaviest member nodes. */
export function communities(db: DatabaseSync, opts: CommunitiesOptions = {}): CommunityDto[] {
  const top = intArg('topNodes', opts.topNodes, 5, 0, 50);
  return guard(() => {
    const out: CommunityDto[] = db
      .prepare('SELECT community_id, size, label FROM graph_communities ORDER BY community_id ASC')
      .all()
      .map((r) => ({ communityId: num(r, 'community_id'), size: num(r, 'size'), label: strOrNull(r, 'label'), topNodes: [] }));
    if (top === 0 || out.length === 0) return out;
    const byId = new Map(out.map((c) => [c.communityId, c] as const));
    // One ordered pass: the first `top` rows of each community are its heaviest members.
    const sql = `SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE community_id IS NOT NULL ORDER BY community_id ASC, weight DESC, node_id ASC`;
    for (const r of db.prepare(sql).iterate()) {
      const c = byId.get(num(r, 'community_id'));
      if (c !== undefined && c.topNodes.length < top) c.topNodes.push(nodeFromRow(r));
    }
    return out;
  });
}

/** Members of one community (heaviest first). Unknown community id -> NOT_IN_LOCAL_EXPORT. */
export function communityMembers(db: DatabaseSync, communityId: number, opts: { limit?: number } = {}): GraphNodeDto[] {
  if (typeof communityId !== 'number' || !Number.isInteger(communityId) || communityId < 1) throw badArg('communityId', 'expected a positive integer');
  const limit = intArg('limit', opts.limit, 50, 1, MAX_QUERY_NODES);
  return guard(() => {
    const exists = db.prepare('SELECT 1 AS x FROM graph_communities WHERE community_id = ?').get(communityId);
    if (exists === undefined) throw notInExport('community');
    return db
      .prepare(`SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE community_id = ? ORDER BY weight DESC, node_id ASC LIMIT ?`)
      .all(communityId, limit)
      .map(nodeFromRow);
  });
}

export function graphStats(db: DatabaseSync): GraphStats {
  return guard(() => {
    const nodes = count(db, 'graph_nodes');
    return { nodes, edges: count(db, 'graph_edges'), communities: count(db, 'graph_communities'), entities: count(db, 'entities'), built: nodes > 0 };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// explainEdge
// ---------------------------------------------------------------------------------------------------------------

export type EdgeRef = { edgeId: number } | { src: string; dst: string; kind: string };

export interface ExplainEdgeOptions {
  /** Evidence rows returned. 1..1000, default 100. */
  limit?: number;
}

function lookupEdge(db: DatabaseSync, ref: EdgeRef): GraphEdgeDto {
  if (typeof ref !== 'object' || ref === null) throw badArg('ref', 'expected an object');
  if ('edgeId' in ref) {
    if (typeof ref.edgeId !== 'number' || !Number.isInteger(ref.edgeId) || ref.edgeId < 1) throw badArg('edgeId', 'expected a positive integer');
    const r = db.prepare('SELECT edge_id, src, dst, kind, weight FROM graph_edges WHERE edge_id = ?').get(ref.edgeId);
    if (r === undefined) throw notInExport('edge');
    return edgeFromRow(r);
  }
  const src = idArg('src', ref.src);
  const dst = idArg('dst', ref.dst);
  const kind = idArg('kind', ref.kind);
  const stmt = db.prepare('SELECT edge_id, src, dst, kind, weight FROM graph_edges WHERE src = ? AND dst = ? AND kind = ?');
  // co_occurs is stored once with src < dst; accept either order.
  const r = stmt.get(src, dst, kind) ?? (kind === 'co_occurs' ? stmt.get(dst, src, kind) : undefined);
  if (r === undefined) throw notInExport('edge');
  return edgeFromRow(r);
}

function minimalMessage(r: Row, conversationId: string): MessageRecord {
  let childIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(str(r, 'child_ids_json'));
    if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) childIds = parsed;
  } catch {
    /* a damaged column only loses sibling ordering hints */
  }
  return {
    id: str(r, 'message_id'),
    conversationId,
    parentId: strOrNull(r, 'parent_id'),
    childIds,
    nodeKind: str(r, 'node_kind') === 'structural_empty' ? 'structural_empty' : 'message',
    authorRole: '',
    authorName: null,
    modelSlug: null,
    channel: null,
    recipient: null,
    contentType: null,
    status: null,
    hidden: num(r, 'hidden') === 1,
    createdAt: strOrNull(r, 'created_at'),
    updatedAt: null,
    text: '',
    blocks: [],
    attachments: [],
    ordinal: num(r, 'ordinal'),
  };
}

/** message id -> ids of the branches (leaf ids) whose path contains it, for the wanted ids of one stored conversation snapshot. */
function branchesContaining(
  db: DatabaseSync,
  key: { provider: string; accountLabel: string; conversationId: string; batchId: string },
  wanted: ReadonlySet<string>,
  warnings: Warning[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db
    .prepare(
      'SELECT message_id, parent_id, child_ids_json, node_kind, hidden, created_at, ordinal FROM messages ' +
        'WHERE provider = ? AND account_label = ? AND conversation_id = ? AND source_batch = ? ORDER BY ordinal ASC, message_id ASC',
    )
    .all(key.provider, key.accountLabel, key.conversationId, key.batchId);
  if (rows.length === 0) return out;
  const cur = db
    .prepare('SELECT current_node_id FROM conversations WHERE provider = ? AND account_label = ? AND conversation_id = ? AND source_batch = ?')
    .get(key.provider, key.accountLabel, key.conversationId, key.batchId);
  const analysis = analyzeTree(
    key.conversationId,
    rows.map((r) => minimalMessage(r, key.conversationId)),
    cur === undefined ? null : strOrNull(cur, 'current_node_id'),
  );
  for (const w of analysis.warnings) {
    // Structural observations about the stored tree that affect which branches could be listed.
    if (w.code === 'BRANCH_LIMIT_EXCEEDED') warnings.push({ code: w.code, message: w.message, ...(w.ids === undefined ? {} : { ids: w.ids }) });
  }
  for (const b of analysis.branches) {
    for (const id of b.path) {
      if (!wanted.has(id)) continue;
      const list = out.get(id);
      if (list === undefined) out.set(id, [b.branchId]);
      else if (list.length < MAX_BRANCH_IDS_PER_EVIDENCE) list.push(b.branchId);
    }
  }
  return out;
}

/**
 * The evidence behind one edge: every stored (conversation, message, batch) citation, each with the ids of the branches
 * whose path contains the message (computed on demand from the stored message tree with analyzeTree). Unknown edge ->
 * NOT_IN_LOCAL_EXPORT.
 */
export function explainEdge(db: DatabaseSync, ref: EdgeRef, opts: ExplainEdgeOptions = {}): ExplainEdgeResult {
  const limit = intArg('limit', opts.limit, DEFAULT_EVIDENCE_LIMIT, 1, MAX_EVIDENCE_LIMIT);
  return guard(() => {
    const edge = lookupEdge(db, ref);
    const total = num(db.prepare('SELECT count(*) AS n FROM graph_edge_evidence WHERE edge_id = ?').get(edge.id) ?? {}, 'n');
    const rows = db
      .prepare(
        'SELECT provider, account_label, conversation_id, message_id, source_batch FROM graph_edge_evidence WHERE edge_id = ? ORDER BY rowid ASC LIMIT ?',
      )
      .all(edge.id, limit);
    const warnings: Warning[] = [];

    // Group wanted message ids per stored conversation snapshot, then analyse each tree once.
    const groups = new Map<string, { key: { provider: string; accountLabel: string; conversationId: string; batchId: string }; wanted: Set<string> }>();
    for (const r of rows) {
      const messageId = strOrNull(r, 'message_id');
      if (messageId === null) continue;
      const key = { provider: str(r, 'provider'), accountLabel: str(r, 'account_label'), conversationId: str(r, 'conversation_id'), batchId: str(r, 'source_batch') };
      const gk = `${key.provider}\0${key.accountLabel}\0${key.conversationId}\0${key.batchId}`;
      let g = groups.get(gk);
      if (g === undefined) {
        g = { key, wanted: new Set() };
        groups.set(gk, g);
      }
      g.wanted.add(messageId);
    }
    const index = new Map<string, Map<string, string[]>>();
    for (const [gk, g] of groups) index.set(gk, branchesContaining(db, g.key, g.wanted, warnings));

    const evidence: EvidenceDto[] = rows.map((r) => {
      const provider = str(r, 'provider');
      const accountLabel = str(r, 'account_label');
      const conversationId = str(r, 'conversation_id');
      const batchId = str(r, 'source_batch');
      const messageId = strOrNull(r, 'message_id');
      const branchIds = messageId === null ? [] : (index.get(`${provider}\0${accountLabel}\0${conversationId}\0${batchId}`)?.get(messageId) ?? []);
      return { provider, accountLabel, conversationId, messageId, batchId, branchIds: [...branchIds] };
    });
    if (evidence.some((e) => e.branchIds.length >= MAX_BRANCH_IDS_PER_EVIDENCE)) {
      warnings.push({ code: 'BRANCH_IDS_TRUNCATED', message: `A cited message lies on more than ${MAX_BRANCH_IDS_PER_EVIDENCE} branches; only the first ${MAX_BRANCH_IDS_PER_EVIDENCE} are listed.` });
    }
    // De-duplicate warnings coming from several snapshots.
    const seen = new Set<string>();
    const unique = warnings.filter((w) => {
      const k = `${w.code}\0${w.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { edge, evidence, evidenceTotal: total, warnings: unique };
  });
}
