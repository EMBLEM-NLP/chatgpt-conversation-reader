/**
 * Knowledge-graph builder (SPEC FR-12, NFR-08; ARCHITECTURE section 3 "Derived artifacts").
 *
 * `buildGraph` REBUILDS the derived tables `entities`, `entity_mentions`, `graph_nodes`, `graph_edges`,
 * `graph_edge_evidence` and `graph_communities` from the imported data, atomically (one BEGIN IMMEDIATE transaction:
 * either the complete new graph replaces the old one or nothing changes). Imported tables are only READ.
 *
 * Input: the messages of every conversation's HEAD batch that are real (node_kind = 'message') and not hidden. Messages
 * are streamed from SQLite one row at a time; each is run through `extractEntities`.
 *
 * Graph model (ids are strings)
 *   nodes   "conv:<provider>:<accountLabel>:<conversationId>"   kind 'conversation'  (':' and '%' in the two free-form
 *                                                                parts are percent-escaped so ids cannot collide)
 *           "ent:<entityKind>:<normalized>"                     kind 'entity'
 *           "tool:<normalized>"                                  kind 'tool'
 *   edges   mentioned_in  entity -> conversation   weight = number of messages of that conversation mentioning it
 *           uses_tool     conversation -> tool     weight = number of messages of that conversation that use the tool
 *           co_occurs     entity <-> entity/tool   stored ONCE with src < dst, weight = number of MESSAGES containing both
 *   EVERY edge has graph_edge_evidence rows (provider, account_label, conversation_id, message_id, source_batch), one per
 *   message that contributed, so every fact traces to messages (NFR-08); branch ids are resolved on demand by
 *   query.ts explainEdge. A safety cap (`maxEvidencePerEdge`, default 1000) bounds the evidence of mega-hub edges; the edge
 *   weight stays exact and a warning (EVIDENCE_TRUNCATED) says how many edges were capped.
 *
 * Noise control: an entity seen in fewer than `minEntityConversations` conversations (default 2) is dropped, except tools.
 * Co-occurrence is the quadratic part, so only the top `maxEntitiesPerMessage` entities of a message (by count desc,
 * normalized asc, kind) form pairs; the cap is applied AFTER dropping rare entities so they never use up slots.
 *
 * Determinism: no clock, randomness or hash order influences stored data. The scan order is fixed
 * (provider, account, conversation, message id), entity ids and edge ids are assigned in first-encounter order, and the
 * cluster pass is deterministic. Two builds over the same data produce identical rows (tested).
 *
 * Privacy: labels are UNTRUSTED text cut from imported content; control/bidi characters are replaced and the length
 * is capped. Entity values already exclude URL secrets (see entities/extract.ts). Nothing here logs content.
 *
 * Scope: `provider` / `accountLabel` restrict the build to one provider/account (the derived tables then describe only
 * that scope). Without them all accounts are included; entity nodes are shared across accounts (ids carry no account) but
 * every conversation node and every evidence row names its provider and account.
 */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { AttachmentRef, ContentBlock } from '../domain/types.js';
import { toDbError } from '../db/open.js';
import { extractEntities, exceedsTextCap, DEFAULT_MAX_TEXT_CHARS, ENTITY_KINDS, isEntityKind } from '../entities/extract.js';
import type { EntityKind } from '../entities/extract.js';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { clusterGraph, resolveMaxIterations } from './cluster.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------------------------------------------

export interface BuildGraphOptions {
  /** Restrict the build to one provider ('chatgpt' | 'claude' | 'openai_api'). */
  provider?: string;
  /** Restrict the build to one account label. */
  accountLabel?: string;
  /** Entities seen in fewer conversations are dropped (tools excepted). 1..1_000_000, default 2. */
  minEntityConversations?: number;
  /** Co-occurrence cap per message. 2..256, default 32. */
  maxEntitiesPerMessage?: number;
  /** Entity kinds to extract and keep. Default: all. */
  kinds?: EntityKind[];
  clusterMethod?: 'label_propagation';
  /** Label-propagation passes. 1..1000, default 50. */
  maxIterations?: number;
  /** Evidence rows kept per edge. 1..1_000_000, default 1000. */
  maxEvidencePerEdge?: number;
  /** Per-message text cap handed to the extractor. Default 200 000. */
  maxTextChars?: number;
  /** Monotonic millisecond clock used ONLY for the reported durationMs (injectable for tests). */
  now?: () => number;
}

export interface BuildGraphResult {
  nodes: number;
  edges: number;
  /** Entity rows kept (all kinds, tools included). */
  entities: number;
  communities: number;
  messagesScanned: number;
  durationMs: number;
  warnings: Warning[];
}

export type NodeKind = 'conversation' | 'entity' | 'tool';
export type EdgeKind = 'mentioned_in' | 'co_occurs' | 'uses_tool';

export const NODE_KINDS: readonly NodeKind[] = ['conversation', 'entity', 'tool'];
export const EDGE_KINDS: readonly EdgeKind[] = ['mentioned_in', 'co_occurs', 'uses_tool'];

export const DEFAULT_MIN_ENTITY_CONVERSATIONS = 2;
export const DEFAULT_MAX_ENTITIES_PER_MESSAGE = 32;
export const DEFAULT_MAX_EVIDENCE_PER_EDGE = 1000;
const LABEL_MAX_CHARS = 200;
const WARNING_ID_SAMPLE = 20;

/** Indexes created on the derived tables by buildGraph (the contract DDL has none; lookups by dst / edge_id would scan). */
const DERIVED_INDEXES: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'graph_edges_dst', ddl: 'CREATE INDEX graph_edges_dst ON graph_edges(dst)' },
  { name: 'graph_edge_evidence_edge', ddl: 'CREATE INDEX graph_edge_evidence_edge ON graph_edge_evidence(edge_id)' },
  { name: 'graph_nodes_community', ddl: 'CREATE INDEX graph_nodes_community ON graph_nodes(community_id)' },
];

// ---------------------------------------------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------------------------------------------

function escapePart(s: string): string {
  return s.replace(/%/g, '%25').replace(/:/g, '%3A');
}

function unescapePart(s: string): string {
  return s.replace(/%3A/g, ':').replace(/%25/g, '%');
}

export function conversationNodeId(provider: string, accountLabel: string, conversationId: string): string {
  return `conv:${escapePart(provider)}:${escapePart(accountLabel)}:${escapePart(conversationId)}`;
}

export function entityNodeId(kind: EntityKind, normalized: string): string {
  return kind === 'tool' ? `tool:${normalized}` : `ent:${kind}:${normalized}`;
}

export type ParsedNodeId =
  | { type: 'conversation'; provider: string; accountLabel: string; conversationId: string }
  | { type: 'entity'; kind: EntityKind; normalized: string }
  | { type: 'tool'; kind: 'tool'; normalized: string };

/**
 * Inverse of conversationNodeId / entityNodeId; null for anything that is not a graph node id (callers pass ids that came
 * from users or tool input, so a non-string is "not an id", never a TypeError).
 */
export function parseNodeId(id: string): ParsedNodeId | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith('tool:')) return { type: 'tool', kind: 'tool', normalized: id.slice(5) };
  if (id.startsWith('ent:')) {
    const rest = id.slice(4);
    const colon = rest.indexOf(':');
    if (colon < 1) return null;
    const kind = rest.slice(0, colon);
    if (!isEntityKind(kind) || kind === 'tool') return null;
    return { type: 'entity', kind, normalized: rest.slice(colon + 1) };
  }
  if (id.startsWith('conv:')) {
    const parts = id.slice(5).split(':');
    if (parts.length !== 3) return null;
    const [provider, accountLabel, conversationId] = parts as [string, string, string];
    return { type: 'conversation', provider: unescapePart(provider), accountLabel: unescapePart(accountLabel), conversationId: unescapePart(conversationId) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------------------------------------------

function badArg(field: string, why: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field } });
}

function intOption(field: string, v: unknown, dflt: number, min: number, max: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badArg(field, `expected an integer from ${min} to ${max}`);
  return v;
}

function scopeOption(field: string, v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v !== 'string' || v.length === 0 || v.length > 512 || v.includes('\0')) throw badArg(field, 'expected a non-empty string without NUL bytes (max 512 characters)');
  return v;
}

interface Config {
  provider: string | null;
  accountLabel: string | null;
  minConversations: number;
  maxPerMessage: number;
  kinds: ReadonlySet<EntityKind>;
  maxIterations: number;
  maxEvidence: number;
  maxTextChars: number;
  now: () => number;
}

function resolveConfig(opts: BuildGraphOptions): Config {
  if (typeof opts !== 'object' || opts === null) throw badArg('opts', 'expected an object');
  if (opts.clusterMethod !== undefined && opts.clusterMethod !== 'label_propagation') throw badArg('clusterMethod', "only 'label_propagation' is supported");
  let kinds: ReadonlySet<EntityKind> = new Set(ENTITY_KINDS);
  if (opts.kinds !== undefined) {
    if (!Array.isArray(opts.kinds) || opts.kinds.length === 0 || opts.kinds.length > ENTITY_KINDS.length || !opts.kinds.every(isEntityKind)) {
      throw badArg('kinds', `expected a non-empty list of: ${ENTITY_KINDS.join(', ')}`);
    }
    kinds = new Set(opts.kinds);
  }
  if (opts.now !== undefined && typeof opts.now !== 'function') throw badArg('now', 'expected a function');
  return {
    provider: scopeOption('provider', opts.provider),
    accountLabel: scopeOption('accountLabel', opts.accountLabel),
    minConversations: intOption('minEntityConversations', opts.minEntityConversations, DEFAULT_MIN_ENTITY_CONVERSATIONS, 1, 1_000_000),
    maxPerMessage: intOption('maxEntitiesPerMessage', opts.maxEntitiesPerMessage, DEFAULT_MAX_ENTITIES_PER_MESSAGE, 2, 256),
    kinds,
    maxIterations: resolveMaxIterations(opts.maxIterations),
    maxEvidence: intOption('maxEvidencePerEdge', opts.maxEvidencePerEdge, DEFAULT_MAX_EVIDENCE_PER_EDGE, 1, 1_000_000),
    maxTextChars: intOption('maxTextChars', opts.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 1, 16_777_216),
    now: opts.now ?? (() => performance.now()),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

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

/** Control characters, bidi overrides/isolates and line/paragraph separators: replaced because labels end up in UIs and terminals. */
const UNSAFE_LABEL_CHARS = /[\u0000-\u001f\u007f-\u009f\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

/** Label used when neither the text nor the fallback has anything printable left. */
const UNNAMED_LABEL = '(unnamed)';

function sanitizeLabel(raw: string): string {
  let s = raw.length > 4 * LABEL_MAX_CHARS ? raw.slice(0, 4 * LABEL_MAX_CHARS) : raw;
  s = s.replace(UNSAFE_LABEL_CHARS, ' ').trim();
  if (s.length > LABEL_MAX_CHARS) {
    const last = s.charCodeAt(LABEL_MAX_CHARS - 1);
    s = s.slice(0, last >= 0xd800 && last <= 0xdbff ? LABEL_MAX_CHARS - 1 : LABEL_MAX_CHARS);
  }
  return s;
}

/**
 * Untrusted text -> single-line label of at most LABEL_MAX_CHARS UTF-16 units (never cut inside a surrogate pair).
 * The fallback (typically an id taken from the import, which is just as untrusted) goes through the same cleaning, so
 * the result never contains control or bidi characters whatever the inputs are.
 */
export function cleanLabel(raw: string, fallback: string): string {
  const s = sanitizeLabel(raw);
  if (s.length > 0) return s;
  const f = sanitizeLabel(fallback);
  return f.length > 0 ? f : UNNAMED_LABEL;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Stored blocks_json -> the subset of ContentBlock the extractor reads. null = unusable JSON. */
function parseBlocks(json: string): ContentBlock[] | null {
  if (json === '[]') return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const out: ContentBlock[] = [];
  for (const el of v as unknown[]) {
    if (!isRecord(el) || typeof el['type'] !== 'string') continue;
    const b: ContentBlock = { type: el['type'] };
    if ('metadata' in el) b.metadata = el['metadata'];
    out.push(b);
  }
  return out;
}

function parseAttachments(json: string): AttachmentRef[] | null {
  if (json === '[]') return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const out: AttachmentRef[] = [];
  for (const el of v as unknown[]) {
    if (!isRecord(el)) continue;
    out.push({ id: null, name: typeof el['name'] === 'string' ? el['name'] : null, mimeType: null, sizeBytes: null, assetPointer: null, presentInExportAs: null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 1: stream messages, extract, write entities + mentions
// ---------------------------------------------------------------------------------------------------------------

interface EntityState {
  id: number;
  kind: EntityKind;
  normalized: string;
  value: string;
  nodeId: string;
  /** Distinct conversations (in scope) that mention it. */
  conversations: number;
  lastConversation: string;
  /** Messages that mention it. */
  messages: number;
}

interface ScanState {
  entities: Map<string, EntityState>;
  byId: Map<number, EntityState>;
  /** conversation node id -> scanned messages */
  conversationMessages: Map<string, number>;
  messagesScanned: number;
  truncatedMessageIds: string[];
  truncatedCount: number;
  invalidJsonCount: number;
}

// CROSS JOIN pins the join order (SQLite never reorders it): conversation_heads is walked in primary-key order and each
// conversation's messages are read through the messages primary key, i.e. already ordered by message id. EXPLAIN QUERY
// PLAN shows no temp B-tree, so message text (up to the cap per row) never sits in a sorter: the scan really streams.
const MESSAGE_SCAN_SQL =
  'SELECT m.provider AS provider, m.account_label AS account_label, m.conversation_id AS conversation_id, m.message_id AS message_id, ' +
  'm.source_batch AS source_batch, m.author_role AS author_role, m.author_name AS author_name, m.recipient AS recipient, ' +
  'substr(m.text, 1, ?) AS text, length(m.text) AS text_len, m.blocks_json AS blocks_json, m.attachments_json AS attachments_json ' +
  'FROM conversation_heads h CROSS JOIN messages m ON m.provider = h.provider AND m.account_label = h.account_label ' +
  'AND m.conversation_id = h.conversation_id AND m.source_batch = h.source_batch ' +
  "WHERE m.node_kind = 'message' AND m.hidden = 0 AND (? IS NULL OR h.provider = ?) AND (? IS NULL OR h.account_label = ?) " +
  'ORDER BY h.provider, h.account_label, h.conversation_id, m.message_id';

function scanMessages(db: DatabaseSync, cfg: Config): ScanState {
  const state: ScanState = {
    entities: new Map(),
    byId: new Map(),
    conversationMessages: new Map(),
    messagesScanned: 0,
    truncatedMessageIds: [],
    truncatedCount: 0,
    invalidJsonCount: 0,
  };
  const insertEntity = db.prepare('INSERT INTO entities (kind, value, normalized) VALUES (?, ?, ?)');
  const insertMention = db.prepare(
    'INSERT INTO entity_mentions (entity_id, provider, account_label, conversation_id, message_id, source_batch, count) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const params: SQLInputValue[] = [cfg.maxTextChars, cfg.provider, cfg.provider, cfg.accountLabel, cfg.accountLabel];

  for (const r of db.prepare(MESSAGE_SCAN_SQL).iterate(...params)) {
    state.messagesScanned++;
    const provider = str(r, 'provider');
    const accountLabel = str(r, 'account_label');
    const conversationId = str(r, 'conversation_id');
    const messageId = str(r, 'message_id');
    const convNode = conversationNodeId(provider, accountLabel, conversationId);
    state.conversationMessages.set(convNode, (state.conversationMessages.get(convNode) ?? 0) + 1);

    // Several lengths are compared on purpose: SQLite's substr()/length() count Unicode CODE POINTS while
    // extractEntities caps UTF-16 code UNITS (a message of astral characters, e.g. emoji, can be cut by the extractor
    // even though SQLite did not cut it) and also caps the NFKC-normalised text (compatibility characters expand).
    // Every kind of cut must be reported, never swallowed silently.
    const text = str(r, 'text');
    if (num(r, 'text_len') > cfg.maxTextChars || exceedsTextCap(text, cfg.maxTextChars)) {
      state.truncatedCount++;
      if (state.truncatedMessageIds.length < WARNING_ID_SAMPLE) state.truncatedMessageIds.push(messageId);
    }
    const blocks = parseBlocks(str(r, 'blocks_json'));
    const attachments = parseAttachments(str(r, 'attachments_json'));
    if (blocks === null || attachments === null) state.invalidJsonCount++;
    const found = extractEntities(
      {
        text,
        authorRole: str(r, 'author_role'),
        recipient: strOrNull(r, 'recipient'),
        authorName: strOrNull(r, 'author_name'),
        blocks: blocks ?? [],
        attachments: attachments ?? [],
      },
      { maxTextChars: cfg.maxTextChars },
    );
    const sourceBatch = str(r, 'source_batch');
    for (const e of found) {
      if (!cfg.kinds.has(e.kind)) continue;
      const key = `${e.kind}\0${e.normalized}`;
      let ent = state.entities.get(key);
      if (ent === undefined) {
        const res = insertEntity.run(e.kind, e.value, e.normalized);
        ent = {
          id: Number(res.lastInsertRowid),
          kind: e.kind,
          normalized: e.normalized,
          value: e.value,
          nodeId: entityNodeId(e.kind, e.normalized),
          conversations: 0,
          lastConversation: '',
          messages: 0,
        };
        state.entities.set(key, ent);
        state.byId.set(ent.id, ent);
      }
      if (ent.lastConversation !== convNode) {
        ent.lastConversation = convNode;
        ent.conversations++;
      }
      ent.messages++;
      insertMention.run(ent.id, provider, accountLabel, conversationId, messageId, sourceBatch, e.count);
    }
  }
  return state;
}

/** Drop entities below the conversation threshold (tools are always kept). Mentions go first: entity_mentions references entities. */
function pruneEntities(db: DatabaseSync, state: ScanState, cfg: Config): void {
  const deleteMentions = db.prepare('DELETE FROM entity_mentions WHERE entity_id = ?');
  const deleteEntity = db.prepare('DELETE FROM entities WHERE entity_id = ?');
  for (const ent of Array.from(state.entities.values())) {
    if (ent.kind === 'tool' || ent.conversations >= cfg.minConversations) continue;
    deleteMentions.run(ent.id);
    deleteEntity.run(ent.id);
    state.entities.delete(`${ent.kind}\0${ent.normalized}`);
    state.byId.delete(ent.id);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 2: nodes and edges
// ---------------------------------------------------------------------------------------------------------------

interface EvidenceRef {
  provider: string;
  accountLabel: string;
  conversationId: string;
  messageId: string;
  sourceBatch: string;
}

interface ConversationEdgeAgg {
  entityNodeId: string;
  tool: boolean;
  weight: number;
  evidence: EvidenceRef[];
}

interface WriteStats {
  evidenceCappedEdges: number;
}

function writeConversationNodes(db: DatabaseSync, cfg: Config, state: ScanState): number {
  const insertNode = db.prepare('INSERT INTO graph_nodes (node_id, kind, label, ref, weight, community_id) VALUES (?, ?, ?, ?, ?, NULL)');
  const sql =
    'SELECT h.provider AS provider, h.account_label AS account_label, h.conversation_id AS conversation_id, c.title AS title ' +
    'FROM conversation_heads h JOIN conversations c ON c.provider = h.provider AND c.account_label = h.account_label ' +
    'AND c.conversation_id = h.conversation_id AND c.source_batch = h.source_batch ' +
    'WHERE (? IS NULL OR h.provider = ?) AND (? IS NULL OR h.account_label = ?) ORDER BY h.provider, h.account_label, h.conversation_id';
  let count = 0;
  for (const r of db.prepare(sql).iterate(cfg.provider, cfg.provider, cfg.accountLabel, cfg.accountLabel)) {
    const provider = str(r, 'provider');
    const accountLabel = str(r, 'account_label');
    const conversationId = str(r, 'conversation_id');
    const nodeId = conversationNodeId(provider, accountLabel, conversationId);
    const label = cleanLabel(strOrNull(r, 'title') ?? '', cleanLabel(conversationId, conversationId));
    insertNode.run(nodeId, 'conversation', label, JSON.stringify([provider, accountLabel, conversationId]), state.conversationMessages.get(nodeId) ?? 0);
    count++;
  }
  return count;
}

function writeEntityNodes(db: DatabaseSync, state: ScanState): void {
  const insertNode = db.prepare('INSERT INTO graph_nodes (node_id, kind, label, ref, weight, community_id) VALUES (?, ?, ?, ?, ?, NULL)');
  const sorted = Array.from(state.byId.values()).sort((a, b) => a.id - b.id);
  for (const ent of sorted) {
    insertNode.run(ent.nodeId, ent.kind === 'tool' ? 'tool' : 'entity', cleanLabel(ent.value, ent.normalized), String(ent.id), ent.messages);
  }
}

interface MentionEntity {
  node: string;
  normalized: string;
  kind: EntityKind;
  count: number;
  tool: boolean;
}

function compareMentionEntities(a: MentionEntity, b: MentionEntity): number {
  if (a.count !== b.count) return b.count - a.count;
  if (a.normalized !== b.normalized) return a.normalized < b.normalized ? -1 : 1;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

function writeEdges(db: DatabaseSync, cfg: Config, state: ScanState): WriteStats {
  const insertEdge = db.prepare('INSERT INTO graph_edges (src, dst, kind, weight) VALUES (?, ?, ?, ?)');
  const upsertCooccur = db.prepare(
    "INSERT INTO graph_edges (src, dst, kind, weight) VALUES (?, ?, 'co_occurs', 1) ON CONFLICT (src, dst, kind) DO UPDATE SET weight = weight + 1 RETURNING edge_id, weight",
  );
  const insertEvidence = db.prepare(
    'INSERT INTO graph_edge_evidence (edge_id, provider, account_label, conversation_id, message_id, source_batch) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const stats: WriteStats = { evidenceCappedEdges: 0 };

  // Per-conversation aggregates (mentioned_in / uses_tool); flushed when the conversation changes.
  let currentConversation = '';
  let currentConvNode = '';
  let agg = new Map<string, ConversationEdgeAgg>();
  const flush = (): void => {
    for (const a of agg.values()) {
      const src = a.tool ? currentConvNode : a.entityNodeId;
      const dst = a.tool ? a.entityNodeId : currentConvNode;
      const res = insertEdge.run(src, dst, a.tool ? 'uses_tool' : 'mentioned_in', a.weight);
      const edgeId = Number(res.lastInsertRowid);
      for (const ev of a.evidence) insertEvidence.run(edgeId, ev.provider, ev.accountLabel, ev.conversationId, ev.messageId, ev.sourceBatch);
      if (a.weight > a.evidence.length) stats.evidenceCappedEdges++;
    }
    agg = new Map();
  };

  // Current message group.
  let group: MentionEntity[] = [];
  let groupRef: EvidenceRef | null = null;
  const flushMessage = (): void => {
    const ref = groupRef;
    if (ref === null || group.length === 0) {
      group = [];
      return;
    }
    const convNode = conversationNodeId(ref.provider, ref.accountLabel, ref.conversationId);
    const convKey = `${ref.provider}\0${ref.accountLabel}\0${ref.conversationId}`;
    if (convKey !== currentConversation) {
      flush();
      currentConversation = convKey;
      currentConvNode = convNode;
    }
    for (const e of group) {
      let a = agg.get(e.node);
      if (a === undefined) {
        a = { entityNodeId: e.node, tool: e.tool, weight: 0, evidence: [] };
        agg.set(e.node, a);
      }
      a.weight += 1;
      if (a.evidence.length < cfg.maxEvidence) a.evidence.push(ref);
    }
    // Co-occurrence among the top-N entities of the message.
    const top = group.length > cfg.maxPerMessage ? [...group].sort(compareMentionEntities).slice(0, cfg.maxPerMessage) : group;
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const x = (top[i] as MentionEntity).node;
        const y = (top[j] as MentionEntity).node;
        const row = x < y ? upsertCooccur.get(x, y) : upsertCooccur.get(y, x);
        if (row === undefined) continue;
        if (num(row, 'weight') <= cfg.maxEvidence) {
          insertEvidence.run(num(row, 'edge_id'), ref.provider, ref.accountLabel, ref.conversationId, ref.messageId, ref.sourceBatch);
        } else if (num(row, 'weight') === cfg.maxEvidence + 1) {
          stats.evidenceCappedEdges++;
        }
      }
    }
    group = [];
  };

  const sql =
    'SELECT entity_id, provider, account_label, conversation_id, message_id, source_batch, count FROM entity_mentions ' +
    'ORDER BY provider, account_label, conversation_id, message_id, source_batch, entity_id';
  for (const r of db.prepare(sql).iterate()) {
    const ent = state.byId.get(num(r, 'entity_id'));
    if (ent === undefined) continue;
    const provider = str(r, 'provider');
    const accountLabel = str(r, 'account_label');
    const conversationId = str(r, 'conversation_id');
    const messageId = str(r, 'message_id');
    const sourceBatch = str(r, 'source_batch');
    if (
      groupRef === null ||
      groupRef.messageId !== messageId ||
      groupRef.conversationId !== conversationId ||
      groupRef.accountLabel !== accountLabel ||
      groupRef.provider !== provider ||
      groupRef.sourceBatch !== sourceBatch
    ) {
      flushMessage();
      groupRef = { provider, accountLabel, conversationId, messageId, sourceBatch };
    }
    group.push({ node: ent.nodeId, normalized: ent.normalized, kind: ent.kind, count: num(r, 'count'), tool: ent.kind === 'tool' });
  }
  flushMessage();
  flush();
  return stats;
}

// ---------------------------------------------------------------------------------------------------------------
// Transaction wrapper
// ---------------------------------------------------------------------------------------------------------------

/** The only identifiers that may be interpolated into SQL here: a closed union, so a caller cannot pass anything else. */
type CountableTable = 'graph_edges';

function count(db: DatabaseSync, table: CountableTable): number {
  const r = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
  return r === undefined ? 0 : num(r, 'n');
}

/** Children before parents (foreign keys): graph_edge_evidence -> graph_edges, entity_mentions -> entities. Static allow-list. */
const DERIVED_TABLES_CHILDREN_FIRST: readonly string[] = ['graph_edge_evidence', 'graph_edges', 'graph_communities', 'graph_nodes', 'entity_mentions', 'entities'];

function clearDerived(db: DatabaseSync): void {
  // Both interpolated identifiers come from static lists in this file (DERIVED_INDEXES, DERIVED_TABLES_CHILDREN_FIRST).
  for (const ix of DERIVED_INDEXES) db.exec(`DROP INDEX IF EXISTS ${ix.name}`);
  for (const t of DERIVED_TABLES_CHILDREN_FIRST) db.exec(`DELETE FROM ${t}`);
}

/**
 * Rebuild the derived graph tables. Throws WRITE_FORBIDDEN on a read-only connection, DB_ERROR when called inside
 * another transaction, INVALID_ARGUMENT for bad options. On any failure the previous derived data is left untouched.
 */
export function buildGraph(db: DatabaseSync, opts: BuildGraphOptions = {}): BuildGraphResult {
  const cfg = resolveConfig(opts);
  const started = cfg.now();
  const qo = db.prepare('PRAGMA query_only').get();
  if (qo !== undefined && num(qo, 'query_only') === 1) throw new GcrError('WRITE_FORBIDDEN', 'The database is read-only; the graph cannot be built.');
  if (db.isTransaction) throw new GcrError('DB_ERROR', 'buildGraph cannot run inside another transaction.', { details: { reason: 'nested_transaction' } });

  const warnings: Warning[] = [];
  let committed = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    clearDerived(db);
    const state = scanMessages(db, cfg);
    pruneEntities(db, state, cfg);
    const convNodes = writeConversationNodes(db, cfg, state);
    writeEntityNodes(db, state);
    const stats = writeEdges(db, cfg, state);
    const cluster = clusterGraph(db, { maxIterations: cfg.maxIterations });
    for (const ix of DERIVED_INDEXES) db.exec(ix.ddl);

    if (state.messagesScanned === 0) {
      warnings.push({ code: 'NO_MESSAGES_IN_SCOPE', message: 'No imported messages matched the requested scope; the graph is empty.' });
    }
    if (state.truncatedCount > 0) {
      warnings.push({
        code: 'TEXT_TRUNCATED_FOR_EXTRACTION',
        message: `${state.truncatedCount} message(s) are longer than ${cfg.maxTextChars} characters; entities were extracted from the first ${cfg.maxTextChars} characters only.`,
        ids: state.truncatedMessageIds,
      });
    }
    if (state.invalidJsonCount > 0) {
      warnings.push({ code: 'STORED_JSON_INVALID', message: `${state.invalidJsonCount} message(s) had unreadable stored block/attachment JSON; those fields were ignored.` });
    }
    if (stats.evidenceCappedEdges > 0) {
      warnings.push({
        code: 'EVIDENCE_TRUNCATED',
        message: `${stats.evidenceCappedEdges} edge(s) occur in more than ${cfg.maxEvidence} messages; only the first ${cfg.maxEvidence} are listed as evidence (edge weights are exact).`,
      });
    }
    if (!cluster.converged) {
      warnings.push({ code: 'CLUSTER_NOT_CONVERGED', message: `Label propagation stopped after ${cluster.iterations} passes without converging; communities are approximate.` });
    }
    const result: BuildGraphResult = {
      nodes: convNodes + state.byId.size,
      edges: count(db, 'graph_edges'),
      entities: state.byId.size,
      communities: cluster.communities,
      messagesScanned: state.messagesScanned,
      durationMs: 0,
      warnings,
    };
    db.exec('COMMIT');
    committed = true;
    result.durationMs = Math.max(0, Math.round(cfg.now() - started));
    return result;
  } catch (e) {
    if (!committed && db.isTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the first failure is the one worth reporting */
      }
    }
    throw e instanceof GcrError ? e : toDbError(e);
  }
}
