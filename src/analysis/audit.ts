/**
 * Local-store audit: data-quality, structure and provenance checks (SPEC FR-11, FR-16, FR-09; CODEX_TASK Phase 3
 * "branch/model provenance audit").
 *
 * `runAudit` is a PURE READ. It never writes, never touches the network, and every value reaches SQLite through a bound
 * parameter (the SQL text is built from fixed fragments only).
 *
 * PRIVACY: findings carry COUNTS and IDS only - never message text, titles, attachment names or raw source. The few
 * caller-visible strings that come from the data are short vocabulary values used as `byCode` keys (author roles and
 * content types for the "unknown_*" and "hidden" checks); they are identifiers, never conversation content. Ids are
 * untrusted data like everything imported: renderers must escape them.
 *
 * Unit of counting
 *  - Conversation-level checks (empty, untitled, tree_integrity, no_current_node) count conversation SNAPSHOTS: by default
 *    one per conversation (its head batch); with `allBatches` every stored snapshot is audited independently, because
 *    each one is a separate tree. `scanned.conversations` uses the same unit.
 *  - Message-level checks count real messages (`node_kind = 'message'`); `structural_empty` placeholders are never counted.
 *  - "timestamps" counts ITEMS (messages plus conversations) - see its description string and byCode keys.
 *
 * Streaming: the tree checks run `analyzeTree` (src/domain/branches.ts) on ONE conversation at a time, so memory is
 * bounded by the largest single conversation, not by the database. Message text is never read for that pass (only ids,
 * parent pointers, child lists, kind, hidden flag, timestamps and ordinal).
 *
 * Determinism: sample ids are the lowest ids (Unicode code point order = SQLite BINARY, for SQL- and tree-derived samples alike) among the offenders; byCode entries are ordered by
 * count (descending) then key; nothing depends on the clock, randomness or row order.
 *
 * Model honesty (FR-16): "missing_model" only COUNTS messages whose source gave no model; it never fills one in.
 */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { toDbError } from '../db/open.js';
import type { Repository } from '../db/repo.js';
import { analyzeTree } from '../domain/branches.js';
import type { MessageRecord } from '../domain/types.js';
import { parseIsoUtcToEpochMs } from '../domain/validate.js';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { NAMED_CONTENT_TYPES } from '../ingest/chatgpt-export.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

/** Frozen: the check allow-list (and the canonical result order) must not be changeable at run time by another module. */
export const AUDIT_CHECKS = Object.freeze([
  'missing_model',
  'empty',
  'untitled',
  'tree_integrity',
  'no_current_node',
  'unknown_roles',
  'unknown_content_types',
  'timestamps',
  'hidden',
] as const);
export type AuditCheck = (typeof AUDIT_CHECKS)[number];

export interface AuditOptions {
  /** Default: all checks. An empty list or an unknown check name is INVALID_ARGUMENT. */
  checks?: AuditCheck[];
  provider?: string;
  accountLabel?: string;
  /** Audit superseded snapshots too (default false = head batches only). */
  allBatches?: boolean;
  /** Number of sample ids per finding, 1..50, default 5. */
  sampleSize?: number;
}

export interface AuditFinding {
  check: AuditCheck;
  /** 'info' whenever count is 0; otherwise the check's own level (see SEVERITY_WHEN_FOUND). */
  severity: 'info' | 'warn' | 'error';
  /** Offenders (unit: see the file header and `description`). */
  count: number;
  /** Population the check examined (same unit as count). */
  total: number;
  /** Fixed text with numbers only. Never contains conversation content. */
  description: string;
  /** Lowest conversation ids among the offenders. */
  sampleConversationIds: string[];
  /** Lowest message ids among the offenders (empty for conversation-level checks). */
  sampleMessageIds: string[];
  /** Breakdown: warning codes (tree_integrity, no_current_node, timestamps) or vocabulary values (roles, content types). */
  byCode?: Record<string, number>;
}

export interface AuditResult {
  scanned: { conversations: number; messages: number };
  findings: AuditFinding[];
  /**
   * Computed from the tree pass, so it is `null` (NOT zeros) when no tree-based check (tree_integrity, no_current_node,
   * timestamps) was selected: zeros would read as a measurement ("no conversation has a known active branch"), and a script
   * that ignores warnings would believe it (SPEC-07). The BRANCH_PROVENANCE_NOT_COMPUTED warning accompanies the null.
   * "Known" means the source gave a VALID active-branch pointer (the complement of the no_current_node finding), even if branch
   * enumeration was truncated before that branch; "unknown" is exactly the conversations no_current_node flags.
   */
  branchProvenance: {
    conversationsWithMultipleBranches: number;
    maxBranchesInOneConversation: number;
    conversationsWithKnownActiveBranch: number;
    conversationsWithUnknownActiveBranch: number;
  } | null;
  /** Always present: a single pass over the assistant messages, independent of the tree pass (so it never needs a null). */
  modelProvenance: {
    assistantMessagesWithModel: number;
    assistantMessagesWithoutModel: number;
    conversationsWithAnyModel: number;
  };
  warnings: Warning[];
}

export const AUDIT_SAMPLE_DEFAULT = 5;
export const AUDIT_SAMPLE_MAX = 50;

/** Author roles the importers produce for ChatGPT / Claude conversations. Anything else is "unknown". */
export const KNOWN_ROLES: readonly string[] = Object.freeze(['user', 'assistant', 'system', 'tool']);

/**
 * `content_type` values the ChatGPT adapter has an explicit handler for. A frozen COPY of the adapter's own list (imported, so
 * the two cannot drift; copied, so freezing it does not touch the adapter's array); the "unknown_content_types" check applies to provider 'chatgpt' only, because other providers use
 * their own vocabulary (the Claude adapter stores no content_type at all).
 */
export const KNOWN_CHATGPT_CONTENT_TYPES: readonly string[] = Object.freeze([...NAMED_CONTENT_TYPES]);

/** Level used when a check finds something. Count 0 is always reported as 'info'. */
const SEVERITY_WHEN_FOUND: Readonly<Record<AuditCheck, 'info' | 'warn' | 'error'>> = {
  missing_model: 'info', // many exports simply omit the model; informational by design
  empty: 'warn',
  untitled: 'info',
  tree_integrity: 'warn', // raised to 'error' for cycles / self-parents (unreachable messages), see integritySeverity
  no_current_node: 'warn',
  unknown_roles: 'warn',
  unknown_content_types: 'warn',
  timestamps: 'info', // raised to 'warn' for order anomalies, see timestampSeverity
  hidden: 'info',
};

/** analyzeTree warning codes that describe a damaged tree (the current-node codes belong to no_current_node). */
const INTEGRITY_CODES: ReadonlySet<string> = new Set([
  'MISSING_PARENT',
  'CYCLE_DETECTED',
  'CHILD_PARENT_MISMATCH',
  'SELF_PARENT',
  'DUPLICATE_NODE_ID',
  'BRANCH_LIMIT_EXCEEDED',
]);
const CURRENT_NODE_CODES: ReadonlySet<string> = new Set(['NO_CURRENT_NODE', 'INVALID_CURRENT_NODE']);

/** Distinct byCode keys reported for the vocabulary checks; more are dropped and a BYCODE_TRUNCATED warning says so. */
const BYCODE_CAP = 100;

// ---------------------------------------------------------------------------------------------------------------
// Argument validation (never echoes the offending value)
// ---------------------------------------------------------------------------------------------------------------

const MAX_FILTER_CHARS = 512;

function badArg(field: string, why: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field } });
}

function optString(field: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badArg(field, 'expected a string');
  if (v.length > MAX_FILTER_CHARS) throw badArg(field, `longer than ${MAX_FILTER_CHARS} characters`);
  if (v.includes('\0')) throw badArg(field, 'contains a NUL byte');
  return v;
}

interface Filters {
  checks: AuditCheck[];
  provider: string | undefined;
  accountLabel: string | undefined;
  allBatches: boolean;
  sampleSize: number;
}

function normalizeOptions(opts: unknown): Filters {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) throw badArg('opts', 'expected an object');
  const o = opts as Record<string, unknown>;

  const rawChecks = o['checks'];
  let checks: AuditCheck[];
  if (rawChecks === undefined) {
    checks = [...AUDIT_CHECKS];
  } else {
    if (!Array.isArray(rawChecks) || rawChecks.length === 0) throw badArg('checks', 'expected a non-empty array of check names');
    for (const c of rawChecks as unknown[]) {
      if (typeof c !== 'string' || !(AUDIT_CHECKS as readonly string[]).includes(c)) throw badArg('checks', `expected names from ${AUDIT_CHECKS.join(', ')}`);
    }
    // Canonical order and no duplicates, whatever order the caller used: the result must not depend on it.
    const wanted = new Set<string>(rawChecks as string[]);
    checks = AUDIT_CHECKS.filter((c) => wanted.has(c));
  }

  const allBatches = o['allBatches'];
  if (allBatches !== undefined && typeof allBatches !== 'boolean') throw badArg('allBatches', 'expected a boolean');

  const sampleSize = o['sampleSize'];
  if (sampleSize !== undefined && (typeof sampleSize !== 'number' || !Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > AUDIT_SAMPLE_MAX)) {
    throw badArg('sampleSize', `expected an integer from 1 to ${AUDIT_SAMPLE_MAX}`);
  }

  return {
    checks,
    provider: optString('provider', o['provider']),
    accountLabel: optString('accountLabel', o['accountLabel']),
    allBatches: allBatches === true,
    sampleSize: sampleSize === undefined ? AUDIT_SAMPLE_DEFAULT : sampleSize,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SQL building blocks (fixed fragments only; values are bound)
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

function num(row: Row, key: string): number {
  const v = row[key];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : typeof v === 'string' ? v : String(v);
}

/** Whitespace and zero-width separators that make a string "blank" (SQLite's trim() strips only what it is given). */
const BLANK_CHARS =
  'char(32, 9, 10, 11, 12, 13, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8232, 8233, 8239, 8287, 8288, 12288, 65279)';

/** The source explicitly named a model. NULL and blank slugs carry no identity, so they count as "missing". */
const HAS_MODEL = `(m.model_slug IS NOT NULL AND trim(m.model_slug, ${BLANK_CHARS}) <> '')`;

const HEAD_JOIN_M =
  'JOIN conversation_heads h ON h.provider = m.provider AND h.account_label = m.account_label ' +
  'AND h.conversation_id = m.conversation_id AND h.source_batch = m.source_batch ';
const HEAD_JOIN_C =
  'JOIN conversation_heads h ON h.provider = c.provider AND h.account_label = c.account_label ' +
  'AND h.conversation_id = c.conversation_id AND h.source_batch = c.source_batch ';

interface Scope {
  from: string;
  where: string;
  params: SQLInputValue[];
}

/** Real messages in scope. `extra` is a literal predicate from this file; `extraParams` its bound values. */
function messageScope(f: Filters, extra = '', extraParams: SQLInputValue[] = []): Scope {
  let from = 'FROM messages m ';
  if (!f.allBatches) from += HEAD_JOIN_M;
  let where = "WHERE m.node_kind = 'message' ";
  const params: SQLInputValue[] = [];
  if (f.provider !== undefined) {
    where += 'AND m.provider = ? ';
    params.push(f.provider);
  }
  if (f.accountLabel !== undefined) {
    where += 'AND m.account_label = ? ';
    params.push(f.accountLabel);
  }
  return { from, where: where + extra, params: [...params, ...extraParams] };
}

/** Conversation snapshots in scope. */
function conversationScope(f: Filters, extra = ''): Scope {
  let from = 'FROM conversations c ';
  if (!f.allBatches) from += HEAD_JOIN_C;
  let where = 'WHERE 1 = 1 ';
  const params: SQLInputValue[] = [];
  if (f.provider !== undefined) {
    where += 'AND c.provider = ? ';
    params.push(f.provider);
  }
  if (f.accountLabel !== undefined) {
    where += 'AND c.account_label = ? ';
    params.push(f.accountLabel);
  }
  return { from, where: where + extra, params };
}

function countRows(db: DatabaseSync, scope: Scope): number {
  return num(db.prepare(`SELECT count(*) AS n ${scope.from}${scope.where}`).get(...scope.params) ?? {}, 'n');
}

/** Lowest distinct values of `column` (a literal such as "m.message_id") among the rows of `scope`. */
function lowestDistinct(db: DatabaseSync, scope: Scope, column: string, k: number): string[] {
  const rows = db.prepare(`SELECT DISTINCT ${column} AS id ${scope.from}${scope.where}ORDER BY ${column} COLLATE BINARY ASC LIMIT ?`).all(...scope.params, k);
  return rows.map((r) => strOrNull(r, 'id') ?? '');
}

interface Samples {
  conversationIds: string[];
  messageIds: string[];
}

function messageSamples(db: DatabaseSync, scope: Scope, k: number): Samples {
  return { conversationIds: lowestDistinct(db, scope, 'm.conversation_id', k), messageIds: lowestDistinct(db, scope, 'm.message_id', k) };
}

interface GroupCounts {
  entries: Array<[string, number]>;
  truncated: boolean;
}

/** count(*) per value of `keyExpr` (a literal), most frequent first, at most BYCODE_CAP keys. */
function groupCounts(db: DatabaseSync, scope: Scope, keyExpr: string): GroupCounts {
  const rows = db
    .prepare(`SELECT ${keyExpr} AS k, count(*) AS n ${scope.from}${scope.where}GROUP BY k ORDER BY n DESC, k ASC LIMIT ?`)
    .all(...scope.params, BYCODE_CAP + 1);
  const entries: Array<[string, number]> = rows.slice(0, BYCODE_CAP).map((r): [string, number] => [strOrNull(r, 'k') ?? '', num(r, 'n')]);
  return { entries, truncated: rows.length > BYCODE_CAP };
}

/**
 * Object from entries WITHOUT assignment syntax: `obj['__proto__'] = n` would silently set the prototype instead of
 * adding a key, and a hostile export can name its role anything. fromEntries defines own properties.
 */
function toRecord(entries: Iterable<[string, number]>): Record<string, number> {
  return Object.fromEntries(entries);
}

/**
 * Orders strings by Unicode CODE POINT, which is exactly SQLite's BINARY collation (UTF-8 byte order). JavaScript's `<`
 * compares UTF-16 code units and disagrees for an astral character (surrogate pair, U+10000+) against U+E000..U+FFFF, so
 * "lowest id first" would mean different things for SQL-derived samples and tree-pass samples. Surrogates are remapped
 * above the rest of the BMP, the standard trick for turning a code unit comparison into a code point comparison.
 */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    }
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1; // a proper prefix is smaller (a !== b, so the lengths differ here)
}

function mapToSortedEntries(m: Map<string, number>): Array<[string, number]> {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]));
}

/** Keeps the `cap` smallest distinct strings seen (code point order, see compareCodePoints) in O(cap) memory. */
class SmallestK {
  private readonly cap: number;
  private readonly items: string[] = [];

  constructor(cap: number) {
    this.cap = cap;
  }

  add(id: string): void {
    const items = this.items;
    const last = items[items.length - 1];
    if (items.length >= this.cap && last !== undefined && compareCodePoints(id, last) >= 0) return;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareCodePoints(items[mid] as string, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (items[lo] === id) return;
    items.splice(lo, 0, id);
    if (items.length > this.cap) items.pop();
  }

  toArray(): string[] {
    return this.items.slice();
  }
}

function inReadSnapshot<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing was written; a failing ROLLBACK means the connection is gone, which the caller's next statement reports.
    }
  }
}

/** A node:sqlite connection, recognised by behaviour (exec/prepare), not by class, so a closed one still passes and reports DB_ERROR later. */
function isConnection(x: unknown): x is DatabaseSync {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as { exec?: unknown; prepare?: unknown };
  return typeof c.exec === 'function' && typeof c.prepare === 'function';
}

/**
 * Accepts the raw connection or a Repository. Anything else (null, a string, `{}`...) is INVALID_ARGUMENT: a raw TypeError
 * from the `in` operator, or a misleading DB_ERROR for an object that is no database, would break the GcrError contract.
 */
function resolveDb(h: unknown): DatabaseSync {
  if (typeof h === 'object' && h !== null) {
    const inner = (h as { db?: unknown }).db;
    if (isConnection(inner)) return inner;
    if (isConnection(h)) return h;
  }
  throw badArg('db', 'expected a DatabaseSync connection or a Repository');
}

function pct(count: number, total: number): string {
  return total > 0 ? ((count * 100) / total).toFixed(1) : '0.0';
}

function makeFinding(
  check: AuditCheck,
  level: 'info' | 'warn' | 'error',
  count: number,
  total: number,
  description: string,
  samples: Samples,
  byCode?: Record<string, number>,
): AuditFinding {
  const f: AuditFinding = {
    check,
    severity: count === 0 ? 'info' : level,
    count,
    total,
    description,
    sampleConversationIds: samples.conversationIds,
    sampleMessageIds: samples.messageIds,
  };
  if (byCode !== undefined) f.byCode = byCode;
  return f;
}

const NO_SAMPLES: Samples = { conversationIds: [], messageIds: [] };

// ---------------------------------------------------------------------------------------------------------------
// Tree pass: one conversation at a time
// ---------------------------------------------------------------------------------------------------------------

interface TreeAgg {
  /** Conversations with at least one finding. */
  conversations: number;
  byCode: Map<string, number>;
  conversationIds: SmallestK;
  messageIds: SmallestK;
}

function newAgg(k: number): TreeAgg {
  return { conversations: 0, byCode: new Map(), conversationIds: new SmallestK(k), messageIds: new SmallestK(k) };
}

function bump(m: Map<string, number>, code: string, by = 1): void {
  m.set(code, (m.get(code) ?? 0) + by);
}

interface PassOutcome {
  integrity: TreeAgg;
  currentNode: TreeAgg;
  /** Items flagged: messages (message codes) + conversations (conversation codes). */
  timestamps: TreeAgg & { flagged: number; examined: number };
  branch: { multiple: number; max: number; known: number; unknown: number };
  /** Snapshots where a stored child list could not be read as a JSON array of strings. */
  unreadableChildLists: number;
}

function parseStringArray(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

/**
 * A MessageRecord carrying only what analyzeTree reads (id, parent, children, kind, hidden, createdAt, ordinal). The
 * message text and every other column are deliberately NOT loaded: the audit must not hold content in memory.
 */
function skeleton(conversationId: string, r: Row, flags: { unreadable: boolean }): MessageRecord {
  const childIds = parseStringArray(strOrNull(r, 'child_ids_json'));
  if (childIds === null) flags.unreadable = true;
  return {
    id: strOrNull(r, 'message_id') ?? '',
    conversationId,
    parentId: strOrNull(r, 'parent_id'),
    childIds: childIds ?? [],
    nodeKind: strOrNull(r, 'node_kind') === 'structural_empty' ? 'structural_empty' : 'message',
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

function treePass(db: DatabaseSync, f: Filters): PassOutcome {
  const k = f.sampleSize;
  const out: PassOutcome = {
    integrity: newAgg(k),
    currentNode: newAgg(k),
    timestamps: { ...newAgg(k), flagged: 0, examined: 0 },
    branch: { multiple: 0, max: 0, known: 0, unknown: 0 },
    unreadableChildLists: 0,
  };

  const scope = conversationScope(f);
  const snapshots = db.prepare(
    'SELECT c.provider AS provider, c.account_label AS account_label, c.conversation_id AS conversation_id, c.source_batch AS source_batch, ' +
      'c.current_node_id AS current_node_id, c.created_at AS created_at, c.updated_at AS updated_at ' +
      `${scope.from}${scope.where}ORDER BY c.provider, c.account_label, c.conversation_id, c.source_batch`,
  );
  const messages = db.prepare(
    'SELECT message_id, parent_id, child_ids_json, node_kind, hidden, created_at, ordinal FROM messages ' +
      'WHERE provider = ? AND account_label = ? AND conversation_id = ? AND source_batch = ?',
  );

  for (const snap of snapshots.iterate(...scope.params)) {
    const conversationId = strOrNull(snap, 'conversation_id') ?? '';
    const flags = { unreadable: false };
    const msgs = messages
      .all(strOrNull(snap, 'provider') ?? '', strOrNull(snap, 'account_label') ?? '', conversationId, strOrNull(snap, 'source_batch') ?? '')
      .map((r) => skeleton(conversationId, r, flags));
    if (flags.unreadable) out.unreadableChildLists++;

    // ---- tree analysis (default limits, exactly what `gcr branches` would show) ----
    const analysis = analyzeTree(conversationId, msgs, strOrNull(snap, 'current_node_id'));
    const integrityCodes = new Set<string>();
    const currentCodes = new Set<string>();
    for (const w of analysis.warnings) {
      if (INTEGRITY_CODES.has(w.code)) {
        integrityCodes.add(w.code);
        for (const id of w.ids ?? []) out.integrity.messageIds.add(id);
      } else if (CURRENT_NODE_CODES.has(w.code)) {
        currentCodes.add(w.code);
      }
    }
    if (integrityCodes.size > 0) {
      out.integrity.conversations++;
      out.integrity.conversationIds.add(conversationId);
      for (const c of integrityCodes) bump(out.integrity.byCode, c);
    }
    if (currentCodes.size > 0) {
      out.currentNode.conversations++;
      out.currentNode.conversationIds.add(conversationId);
      for (const c of currentCodes) bump(out.currentNode.byCode, c);
    }

    // ---- branch provenance (leafIds lists ALL reachable leaves, even when enumeration was truncated) ----
    // "Known" = the source gave a VALID active-branch pointer (analyzeTree raised neither NO_CURRENT_NODE nor
    // INVALID_CURRENT_NODE), i.e. exactly the conversations the no_current_node check does not flag. It must not depend on
    // `analysis.activeBranchId`: that is null when BRANCH_LIMIT_EXCEEDED stopped enumeration before the active branch,
    // although the pointer is valid and the branch is known (merely not enumerated).
    const leaves = analysis.leafIds.length;
    if (leaves > 1) out.branch.multiple++;
    if (leaves > out.branch.max) out.branch.max = leaves;
    if (currentCodes.size === 0) out.branch.known++;
    else out.branch.unknown++;

    // ---- timestamps ----
    const ts = out.timestamps;
    const ms = new Map<string, number | null>();
    for (const m of msgs) ms.set(m.id, parseIsoUtcToEpochMs(m.createdAt));
    let convFlagged = false;
    ts.examined++; // the conversation itself
    const convCreated = strOrNull(snap, 'created_at');
    const convUpdated = strOrNull(snap, 'updated_at');
    const created = parseIsoUtcToEpochMs(convCreated);
    const updated = parseIsoUtcToEpochMs(convUpdated);
    // A value that is present but not a strict ISO-8601 UTC instant (a file damaged outside GCR) is reported as such, exactly
    // like MESSAGE_CREATED_AT_INVALID: "no finding" must never mean "could not be read".
    if (convCreated === null) {
      bump(ts.byCode, 'CONVERSATION_CREATED_AT_NULL');
      convFlagged = true;
    } else if (created === null) {
      bump(ts.byCode, 'CONVERSATION_CREATED_AT_INVALID');
      convFlagged = true;
    }
    if (convUpdated !== null && updated === null) {
      bump(ts.byCode, 'CONVERSATION_UPDATED_AT_INVALID');
      convFlagged = true;
    }
    if (created !== null && updated !== null && updated < created) {
      bump(ts.byCode, 'CONVERSATION_UPDATED_BEFORE_CREATED');
      convFlagged = true;
    }
    let msgFlagged = false;
    for (const m of msgs) {
      if (m.nodeKind !== 'message') continue;
      ts.examined++;
      const own = ms.get(m.id) ?? null;
      let code: string | null = null;
      if (m.createdAt === null) {
        code = 'MESSAGE_CREATED_AT_NULL';
      } else if (own === null) {
        code = 'MESSAGE_CREATED_AT_INVALID';
      } else if (m.parentId !== null) {
        // A structural root or a parent without a usable timestamp gives no order evidence: skipped, not guessed.
        const parentMs = ms.get(m.parentId) ?? null;
        if (parentMs !== null && own < parentMs) code = 'MESSAGE_BEFORE_PARENT';
      }
      if (code !== null) {
        bump(ts.byCode, code);
        ts.messageIds.add(m.id);
        ts.flagged++;
        msgFlagged = true;
      }
    }
    if (convFlagged) ts.flagged++;
    if (convFlagged || msgFlagged) {
      ts.conversations++;
      ts.conversationIds.add(conversationId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------------------------------------------

function scopeWarnings(db: DatabaseSync, f: Filters, scannedConversations: number): Warning[] {
  const warnings: Warning[] = [];
  if (scannedConversations === 0) {
    warnings.push({ code: 'NO_CONVERSATIONS_IN_SCOPE', message: 'No conversations matched the filters; a clean result here is not evidence that the source is clean.' });
  }
  if (f.allBatches) {
    const superseded = countRows(
      db,
      conversationScope(
        f,
        'AND NOT EXISTS (SELECT 1 FROM conversation_heads hh WHERE hh.provider = c.provider AND hh.account_label = c.account_label ' +
          'AND hh.conversation_id = c.conversation_id AND hh.source_batch = c.source_batch) ',
      ),
    );
    if (superseded > 0) {
      warnings.push({
        code: 'SUPERSEDED_SNAPSHOTS_INCLUDED',
        message: `${superseded} superseded conversation snapshot(s) are audited as separate conversations (allBatches).`,
      });
    }
  }
  const incompleteScope = conversationScope(f, "AND c.completeness <> 'exported_tree' ");
  const incomplete = countRows(db, incompleteScope);
  if (incomplete > 0) {
    const kinds = db
      .prepare(`SELECT c.completeness AS completeness, count(*) AS n ${incompleteScope.from}${incompleteScope.where}GROUP BY c.completeness ORDER BY c.completeness`)
      .all(...incompleteScope.params)
      .map((r) => `${strOrNull(r, 'completeness') ?? ''}: ${num(r, 'n')}`)
      .join(', ');
    warnings.push({
      code: 'INCOMPLETE_SOURCE',
      message: `${incomplete} conversation snapshot(s) in scope come from sources whose completeness is not 'exported_tree' (${kinds}); findings describe only what those sources contained, not the full history.`,
      ids: lowestDistinct(db, incompleteScope, 'c.conversation_id', f.sampleSize),
    });
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------------------------
// runAudit
// ---------------------------------------------------------------------------------------------------------------

function integritySeverity(byCode: Record<string, number>): 'warn' | 'error' {
  // Cycles and self-parents make messages unreachable from any root: they are lost to branch views, so they are errors.
  return 'CYCLE_DETECTED' in byCode || 'SELF_PARENT' in byCode ? 'error' : 'warn';
}

function timestampSeverity(byCode: Record<string, number>): 'info' | 'warn' {
  // Null timestamps are common and merely informative; invalid values or time running backwards are real anomalies.
  return 'MESSAGE_BEFORE_PARENT' in byCode ||
    'CONVERSATION_UPDATED_BEFORE_CREATED' in byCode ||
    'MESSAGE_CREATED_AT_INVALID' in byCode ||
    'CONVERSATION_CREATED_AT_INVALID' in byCode ||
    'CONVERSATION_UPDATED_AT_INVALID' in byCode
    ? 'warn'
    : 'info';
}

/**
 * Runs the selected checks (default: all) and returns findings in canonical check order. Accepts the raw connection or
 * the Repository. Throws INVALID_ARGUMENT for a bad option and a content-free DB_ERROR for a database failure.
 *
 * The tree pass (tree_integrity, no_current_node, timestamps) is the only expensive part. When none of those checks is
 * selected it is skipped and `branchProvenance` is `null` TOGETHER WITH a BRANCH_PROVENANCE_NOT_COMPUTED warning, so an
 * unmeasured value is never mistaken for a measured zero.
 */
export function runAudit(db: DatabaseSync | Repository, opts: AuditOptions = {}): AuditResult {
  const handle = resolveDb(db);
  const f = normalizeOptions(opts);
  try {
    return inReadSnapshot(handle, () => audit(handle, f));
  } catch (e) {
    throw e instanceof GcrError ? e : toDbError(e);
  }
}

function audit(db: DatabaseSync, f: Filters): AuditResult {
  const k = f.sampleSize;
  const selected = new Set<AuditCheck>(f.checks);
  const warnings: Warning[] = [];

  const scanned = {
    conversations: countRows(db, conversationScope(f)),
    messages: countRows(db, messageScope(f)),
  };

  // Model provenance is always reported (cheap, single pass over assistant messages).
  const assistantScope = messageScope(f, "AND m.author_role = 'assistant' AND m.hidden = 0 ");
  const am =
    db
      .prepare(
        `SELECT coalesce(sum(CASE WHEN ${HAS_MODEL} THEN 1 ELSE 0 END), 0) AS with_model, ` +
          `coalesce(sum(CASE WHEN ${HAS_MODEL} THEN 0 ELSE 1 END), 0) AS without_model ${assistantScope.from}${assistantScope.where}`,
      )
      .get(...assistantScope.params) ?? {};
  const anyModelScope = messageScope(f, `AND ${HAS_MODEL} `);
  const anyModel = num(
    db
      .prepare(
        "SELECT count(DISTINCT m.provider || char(31) || m.account_label || char(31) || m.conversation_id || char(31) || m.source_batch) AS n " +
          `${anyModelScope.from}${anyModelScope.where}`,
      )
      .get(...anyModelScope.params) ?? {},
    'n',
  );
  const modelProvenance = {
    assistantMessagesWithModel: num(am, 'with_model'),
    assistantMessagesWithoutModel: num(am, 'without_model'),
    conversationsWithAnyModel: anyModel,
  };

  const needsPass = selected.has('tree_integrity') || selected.has('no_current_node') || selected.has('timestamps');
  const pass = needsPass ? treePass(db, f) : null;
  // Only reachable for checks that made needsPass true, so pass is non-null; the throw documents (and enforces) that.
  const passResult = (): PassOutcome => {
    if (pass === null) throw new GcrError('INTERNAL_ERROR', 'The tree pass was not run for a tree-based check.');
    return pass;
  };
  if (pass === null) {
    warnings.push({
      code: 'BRANCH_PROVENANCE_NOT_COMPUTED',
      message: 'branchProvenance is null because no tree-based check (tree_integrity, no_current_node, timestamps) was selected; it was not measured.',
    });
  } else if (pass.unreadableChildLists > 0) {
    warnings.push({
      code: 'STORED_JSON_INVALID',
      message: `${pass.unreadableChildLists} conversation snapshot(s) have a stored child list that could not be read; parent pointers were used instead.`,
    });
  }

  const findings: AuditFinding[] = [];
  const truncated: AuditCheck[] = [];

  for (const check of f.checks) {
    switch (check) {
      case 'missing_model': {
        const total = modelProvenance.assistantMessagesWithModel + modelProvenance.assistantMessagesWithoutModel;
        const count = modelProvenance.assistantMessagesWithoutModel;
        const samples = count > 0 ? messageSamples(db, messageScope(f, `AND m.author_role = 'assistant' AND m.hidden = 0 AND NOT ${HAS_MODEL} `), k) : NO_SAMPLES;
        findings.push(
          makeFinding(
            check,
            SEVERITY_WHEN_FOUND.missing_model,
            count,
            total,
            `${count} of ${total} visible assistant messages (${pct(count, total)}%) carry no explicit model_slug from the source. ` +
              'GCR never infers a model from timestamps, neighbouring messages or the conversation default (FR-16); many exports simply omit it.',
            samples,
          ),
        );
        break;
      }
      case 'empty': {
        const scope = conversationScope(
          f,
          "AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.provider = c.provider AND m.account_label = c.account_label " +
            "AND m.conversation_id = c.conversation_id AND m.source_batch = c.source_batch AND m.node_kind = 'message' " +
            `AND m.text <> '' AND trim(m.text, ${BLANK_CHARS}) <> '') `,
        );
        const count = countRows(db, scope);
        findings.push(
          makeFinding(
            check,
            SEVERITY_WHEN_FOUND.empty,
            count,
            scanned.conversations,
            `${count} of ${scanned.conversations} conversations contain no message with non-blank text (no messages at all, or only empty / whitespace text).`,
            count > 0 ? { conversationIds: lowestDistinct(db, scope, 'c.conversation_id', k), messageIds: [] } : NO_SAMPLES,
          ),
        );
        break;
      }
      case 'untitled': {
        const scope = conversationScope(f, `AND (c.title IS NULL OR trim(c.title, ${BLANK_CHARS}) = '') `);
        const count = countRows(db, scope);
        findings.push(
          makeFinding(
            check,
            SEVERITY_WHEN_FOUND.untitled,
            count,
            scanned.conversations,
            `${count} of ${scanned.conversations} conversations have no title (missing or blank).`,
            count > 0 ? { conversationIds: lowestDistinct(db, scope, 'c.conversation_id', k), messageIds: [] } : NO_SAMPLES,
          ),
        );
        break;
      }
      case 'tree_integrity': {
        const agg = passResult().integrity;
        const byCode = toRecord(mapToSortedEntries(agg.byCode));
        findings.push(
          makeFinding(
            check,
            agg.conversations > 0 ? integritySeverity(byCode) : SEVERITY_WHEN_FOUND.tree_integrity,
            agg.conversations,
            scanned.conversations,
            `${agg.conversations} of ${scanned.conversations} conversations have message-tree anomalies (missing parents, cycles, self-parents, ` +
              'child/parent disagreements, duplicate ids or truncated branch enumeration); byCode counts conversations per warning code.',
            { conversationIds: agg.conversationIds.toArray(), messageIds: agg.messageIds.toArray() },
            byCode,
          ),
        );
        break;
      }
      case 'no_current_node': {
        const agg = passResult().currentNode;
        findings.push(
          makeFinding(
            check,
            SEVERITY_WHEN_FOUND.no_current_node,
            agg.conversations,
            scanned.conversations,
            `${agg.conversations} of ${scanned.conversations} conversations have no valid active-branch pointer (current_node_id is missing, ` +
              'names no node, or names an unreachable node); their active branch is unknown and GCR does not guess it.',
            { conversationIds: agg.conversationIds.toArray(), messageIds: [] },
            toRecord(mapToSortedEntries(agg.byCode)),
          ),
        );
        break;
      }
      case 'unknown_roles': {
        const placeholders = KNOWN_ROLES.map(() => '?').join(', ');
        const scope = messageScope(f, `AND m.author_role NOT IN (${placeholders}) `, [...KNOWN_ROLES]);
        const count = countRows(db, scope);
        const groups = count > 0 ? groupCounts(db, scope, 'm.author_role') : { entries: [], truncated: false };
        if (groups.truncated) truncated.push(check);
        findings.push(
          makeFinding(
            check,
            SEVERITY_WHEN_FOUND.unknown_roles,
            count,
            scanned.messages,
            `${count} of ${scanned.messages} messages have an author role outside ${KNOWN_ROLES.join('/')}; the role strings are kept verbatim in byCode.`,
            count > 0 ? messageSamples(db, scope, k) : NO_SAMPLES,
            toRecord(groups.entries),
          ),
        );
        break;
      }
      case 'unknown_content_types': {
        const placeholders = KNOWN_CHATGPT_CONTENT_TYPES.map(() => '?').join(', ');
        const base = "AND m.provider = 'chatgpt' AND m.content_type IS NOT NULL ";
        const total = countRows(db, messageScope(f, base));
        const scope = messageScope(f, `${base}AND m.content_type NOT IN (${placeholders}) `, [...KNOWN_CHATGPT_CONTENT_TYPES]);
        const count = countRows(db, scope);
        const groups = count > 0 ? groupCounts(db, scope, 'm.content_type') : { entries: [], truncated: false };
        if (groups.truncated) truncated.push(check);
        findings.push(
          makeFinding(
            check,
            SEVERITY_WHEN_FOUND.unknown_content_types,
            count,
            total,
            `${count} of ${total} ChatGPT messages that carry a content_type use one the importer has no handler for (kept as raw 'unknown' blocks); ` +
              'the content types are in byCode.',
            count > 0 ? messageSamples(db, scope, k) : NO_SAMPLES,
            toRecord(groups.entries),
          ),
        );
        break;
      }
      case 'timestamps': {
        const ts = passResult().timestamps;
        const byCode = toRecord(mapToSortedEntries(ts.byCode));
        findings.push(
          makeFinding(
            check,
            ts.flagged > 0 ? timestampSeverity(byCode) : SEVERITY_WHEN_FOUND.timestamps,
            ts.flagged,
            ts.examined,
            `${ts.flagged} of ${ts.examined} items (messages and conversations) have a missing / invalid created_at or a message earlier than its parent; ` +
              'byCode counts messages for MESSAGE_* codes and conversations for CONVERSATION_* codes.',
            { conversationIds: ts.conversationIds.toArray(), messageIds: ts.messageIds.toArray() },
            byCode,
          ),
        );
        break;
      }
      case 'hidden': {
        const scope = messageScope(f, 'AND m.hidden = 1 ');
        const count = countRows(db, scope);
        const groups = count > 0 ? groupCounts(db, scope, 'm.author_role') : { entries: [], truncated: false };
        if (groups.truncated) truncated.push(check);
        findings.push(
          makeFinding(
            check,
            SEVERITY_WHEN_FOUND.hidden,
            count,
            scanned.messages,
            `${count} of ${scanned.messages} messages are marked hidden by the source (system scaffolding, memory, reasoning...); byCode counts them per author role.`,
            count > 0 ? messageSamples(db, scope, k) : NO_SAMPLES,
            toRecord(groups.entries),
          ),
        );
        break;
      }
    }
  }

  for (const check of truncated) {
    warnings.push({ code: 'BYCODE_TRUNCATED', message: `byCode of the "${check}" finding lists only the ${BYCODE_CAP} most frequent values; counts and samples still cover everything.` });
  }
  warnings.push(...scopeWarnings(db, f, scanned.conversations));

  return {
    scanned,
    findings,
    branchProvenance:
      pass === null
        ? null
        : {
            conversationsWithMultipleBranches: pass.branch.multiple,
            maxBranchesInOneConversation: pass.branch.max,
            conversationsWithKnownActiveBranch: pass.branch.known,
            conversationsWithUnknownActiveBranch: pass.branch.unknown,
          },
    modelProvenance,
    warnings,
  };
}
