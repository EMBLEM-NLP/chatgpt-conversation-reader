/**
 * Repository: the import writer and the typed readers over the SQLite schema (ARCHITECTURE sections 2 and 3, FR-10).
 *
 * Import semantics (`importBatch`)
 *  - ONE transaction (`BEGIN IMMEDIATE` ... `COMMIT`). Any throw - a SQLite error, a validation failure, or an error
 *    raised by the (async) record iterable midway - rolls everything back, including FTS rows, and the original error
 *    is rethrown (SQLite errors are mapped to GcrError without forwarding SQLite's text).
 *  - batch_id = "b_" + first 32 hex of sha256(provider NUL accountLabel NUL contentDigest). If that batch already
 *    exists the call is an idempotent no-op: it returns `alreadyImported: true` with the counts of the first import
 *    and `newlyInserted: 0`, WITHOUT iterating the record source (the source is only asked to finish: `return()` is
 *    called on a fresh iterator so generators can release resources). Nothing is written, `imported_at` of the first
 *    import is kept. A batch row only exists after a complete, committed import, so "exists" means "complete".
 *  - `source_batches` is immutable, so its row (which carries the final counts) is inserted LAST, inside the same
 *    transaction; `PRAGMA defer_foreign_keys` postpones the foreign-key check on conversations/messages to COMMIT.
 *    The batch `warnings` array is read at that moment, so a caller may keep appending to it while streaming.
 *  - Rows use INSERT ... ON CONFLICT DO NOTHING. A conversation id repeated inside one stream keeps the FIRST
 *    occurrence; the rest are skipped and reported as warning DUPLICATE_CONVERSATION_IN_BATCH (ids only).
 *  - `conversation_heads` is recomputed after the batch for the touched conversations only: greatest updated_at (NULL
 *    lowest, compared as instants), ties -> greatest source_batches.seq.
 *  - Every record is validated with validateConversationRecord(); its provider/accountLabel must equal the batch's, so a
 *    batch can never write into another provider's or account's namespace.
 *  - Re-entrancy: starting a second import on the same connection while one is open throws DB_ERROR.
 *  - Counting convention: `messages.stored` counts every stored node (real messages AND structural_empty nodes);
 *    `messages.structural` is the structural share of it. `conversations.message_count` and
 *    `source_batches.message_count` count real messages only (the number users see).
 *
 * Readers default to each conversation's HEAD batch; `batchId` pins another snapshot. All SQL uses bound parameters;
 * the only text assembled in code are fixed fragments and allow-listed ORDER BY clauses.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { BatchInfo, ConversationSummary, Page } from '../domain/results.js';
import type {
  AttachmentRef,
  Completeness,
  ContentBlock,
  ConversationProvenance,
  ConversationRecord,
  ConversationRef,
  MessageRecord,
  Provider,
} from '../domain/types.js';
import { isIso8601Utc, validateConversationRecord } from '../domain/validate.js';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { SCHEMA_VERSION } from '../version.js';
import { buildSearchText } from './cjk.js';
import { isSqliteError, toDbError } from './open.js';
import { SUMMARY_COLUMNS, compileQuery, conversationSummaryFromRow, rowNumber, rowString, rowStringOrNull } from './search.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

export interface ImportBatchMeta {
  provider: Provider;
  accountLabel: string;
  provenance: ConversationProvenance;
  completeness: Completeness;
  /** 'zip' | 'conversations_json' | 'conversation_shards' | 'stdin_json' (open set; stored verbatim). */
  sourceKind: string;
  /** Stored as a BASENAME even if a path is passed. */
  sourceLabel: string | null;
  /** sha256 hex over the sorted "<entry>\t<sha256>" lines of the files read (computed by the import runner). */
  contentDigest: string;
  importedAt: string;
  toolVersion: string;
  /** Read when the batch row is written (after the stream is consumed). */
  warnings: Warning[];
}

export interface ImportBatchInput {
  batch: ImportBatchMeta;
  conversations: AsyncIterable<ConversationRecord> | Iterable<ConversationRecord>;
}

export interface ImportBatchResult {
  batchId: string;
  alreadyImported: boolean;
  conversations: { stored: number; newlyInserted: number };
  messages: { stored: number; newlyInserted: number; structural: number };
}

export interface ListConversationsOptions {
  provider?: string;
  accountLabel?: string;
  /** Plain-mode full-text query over titles (same normalization as message search). Empty / punctuation-only -> INVALID_ARGUMENT. */
  titleQuery?: string;
  sort?: 'updated_desc' | 'created_desc' | 'title_asc';
  /** 1..500, default 50. */
  limit?: number;
  offset?: number;
  /** List every stored snapshot instead of only each conversation's head batch. */
  includeAllBatches?: boolean;
}

/** Deterministic batch id (ARCHITECTURE section 2). Exported so the import runner can pre-check for a no-op. */
export function computeBatchId(provider: string, accountLabel: string, contentDigest: string): string {
  return 'b_' + createHash('sha256').update(`${provider}\0${accountLabel}\0${contentDigest}`, 'utf8').digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------------------------

const PROVIDERS = ['chatgpt', 'claude', 'openai_api'] as const satisfies readonly Provider[];
const PROVENANCES = [
  'official_chatgpt_export',
  'user_supplied_copy',
  'manual_browser_capture',
  'openai_developer_api',
  'official_claude_export',
] as const satisfies readonly ConversationProvenance[];
const COMPLETENESSES = ['exported_tree', 'rendered_active_view_only', 'partial_user_supplied', 'api_owned_conversation', 'unknown'] as const satisfies readonly Completeness[];
// Compile-time exhaustiveness: adding a union member without extending the allow-list above fails the build.
type MissingProvider = Exclude<Provider, (typeof PROVIDERS)[number]>;
type MissingProvenance = Exclude<ConversationProvenance, (typeof PROVENANCES)[number]>;
type MissingCompleteness = Exclude<Completeness, (typeof COMPLETENESSES)[number]>;
const _exhaustive: [MissingProvider, MissingProvenance, MissingCompleteness] extends [never, never, never] ? true : never = true;
void _exhaustive;

const MAX_ID_CHARS = 512;
const MAX_DUPLICATE_IDS_REPORTED = 20;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 500;

function badArg(field: string, why: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field } });
}

function reqString(field: string, v: unknown, max = MAX_ID_CHARS): string {
  if (typeof v !== 'string' || v.length === 0) throw badArg(field, 'expected a non-empty string');
  if (v.length > max) throw badArg(field, `longer than ${max} characters`);
  if (v.includes('\0')) throw badArg(field, 'contains a NUL byte');
  return v;
}

function optString(field: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > MAX_ID_CHARS || v.includes('\0')) throw badArg(field, 'expected a string without NUL bytes (max 512 characters)');
  return v;
}

function oneOf<T extends string>(field: string, v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw badArg(field, `expected one of ${allowed.join(', ')}`);
  return v as T;
}

/** Keep only the last path segment: source labels must never carry an absolute private path (NFR-07). */
function toBasename(s: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replaceAll('\\', '/').replace(/[\u0000-\u001f\u007f]/g, '');
  const last = cleaned.split('/').filter((p) => p !== '').at(-1);
  return last === undefined || last === '.' || last === '..' ? null : last.slice(0, 255);
}

function normalizeWarnings(field: string, v: unknown): Warning[] {
  if (!Array.isArray(v)) throw badArg(field, 'expected an array');
  return v.map((w: unknown): Warning => {
    if (typeof w !== 'object' || w === null) throw badArg(field, 'expected warning objects');
    const { code, message, ids } = w as { code?: unknown; message?: unknown; ids?: unknown };
    if (typeof code !== 'string' || typeof message !== 'string') throw badArg(field, 'warnings need string code and message');
    if (ids === undefined) return { code, message };
    if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === 'string')) throw badArg(field, 'warning ids must be strings');
    return { code, message, ids };
  });
}

function validateBatchMeta(b: unknown): ImportBatchMeta {
  if (typeof b !== 'object' || b === null) throw badArg('batch', 'expected an object');
  const x = b as Record<string, unknown>;
  if (!isIso8601Utc(x['importedAt'])) throw badArg('batch.importedAt', 'expected an ISO-8601 UTC timestamp');
  const label = x['sourceLabel'];
  if (label !== null && typeof label !== 'string') throw badArg('batch.sourceLabel', 'expected a string or null');
  return {
    provider: oneOf('batch.provider', x['provider'], PROVIDERS),
    accountLabel: reqString('batch.accountLabel', x['accountLabel']),
    provenance: oneOf('batch.provenance', x['provenance'], PROVENANCES),
    completeness: oneOf('batch.completeness', x['completeness'], COMPLETENESSES),
    sourceKind: reqString('batch.sourceKind', x['sourceKind'], 64),
    sourceLabel: label === null || label === undefined ? null : toBasename(label),
    contentDigest: reqString('batch.contentDigest', x['contentDigest'], 256),
    importedAt: x['importedAt'],
    toolVersion: reqString('batch.toolVersion', x['toolVersion'], 64),
    warnings: x['warnings'] === undefined ? [] : normalizeWarnings('batch.warnings', x['warnings']),
  };
}

/**
 * Roll back whatever transaction is open on `db`, quietly. Deliberately NOT guarded by `db.isTransaction`: that property
 * only exists from Node 22.16 while `engines` allows 22.13, and `undefined` would silently skip the rollback and keep the
 * write lock for the life of the connection. ROLLBACK without an open transaction is a harmless SQLite error.
 * Only call this after this code's own BEGIN succeeded (never to clean up after a failed BEGIN: that could roll back a
 * transaction that belongs to the caller).
 */
function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    /* no transaction was open (already rolled back), or the connection is gone: the first failure is the one worth reporting */
  }
}

/** JSON text for a column, or null for "absent". Non-serializable values (BigInt, cycles) are a caller bug, not data. */
function jsonOrNull(field: string, v: unknown): string | null {
  if (v === undefined) return null;
  let text: string | undefined;
  try {
    text = JSON.stringify(v);
  } catch {
    throw new GcrError('INVALID_ARGUMENT', `The value of "${field}" is not JSON-serializable.`, { details: { field } });
  }
  return text ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Defensive JSON column readers
// ---------------------------------------------------------------------------------------------------------------

type Parsed = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string | null): Parsed {
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArrayOf(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : null;
}

function blocksOf(v: unknown): ContentBlock[] | null {
  if (!Array.isArray(v)) return null;
  const out: ContentBlock[] = [];
  for (const el of v as unknown[]) {
    if (!isRecord(el) || typeof el['type'] !== 'string') return null;
    const b: ContentBlock = { type: el['type'] };
    if (typeof el['text'] === 'string') b.text = el['text'];
    if ('metadata' in el) b.metadata = el['metadata'];
    out.push(b);
  }
  return out;
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function attachmentsOf(v: unknown): AttachmentRef[] | null {
  if (!Array.isArray(v)) return null;
  const out: AttachmentRef[] = [];
  for (const el of v as unknown[]) {
    if (!isRecord(el)) return null;
    out.push({
      id: strOrNull(el['id']),
      name: strOrNull(el['name']),
      mimeType: strOrNull(el['mimeType']),
      sizeBytes: typeof el['sizeBytes'] === 'number' ? el['sizeBytes'] : null,
      assetPointer: strOrNull(el['assetPointer']),
      presentInExportAs: strOrNull(el['presentInExportAs']),
    });
  }
  return out;
}

function warningsOf(v: unknown): Warning[] | null {
  if (!Array.isArray(v)) return null;
  const out: Warning[] = [];
  for (const el of v as unknown[]) {
    if (!isRecord(el) || typeof el['code'] !== 'string' || typeof el['message'] !== 'string') return null;
    const ids = stringArrayOf(el['ids']);
    out.push(ids === null ? { code: el['code'], message: el['message'] } : { code: el['code'], message: el['message'], ids });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------------------------------------------

/** Connections with an import in flight (guards re-entrancy even across several Repository instances). */
const IMPORTS_IN_FLIGHT = new WeakSet<DatabaseSync>();

type Row = Record<string, SQLOutputValue>;

const ORDER_BY: Readonly<Record<NonNullable<ListConversationsOptions['sort']>, string>> = {
  updated_desc:
    "ORDER BY unixepoch(c.updated_at, 'subsec') DESC NULLS LAST, c.conversation_id ASC, c.provider ASC, c.account_label ASC, c.source_batch ASC ",
  created_desc:
    "ORDER BY unixepoch(c.created_at, 'subsec') DESC NULLS LAST, c.conversation_id ASC, c.provider ASC, c.account_label ASC, c.source_batch ASC ",
  title_asc:
    'ORDER BY (c.title IS NULL) ASC, c.title COLLATE NOCASE ASC, c.title ASC, c.conversation_id ASC, c.provider ASC, c.account_label ASC, c.source_batch ASC ',
};

const HEAD_JOIN_C =
  'JOIN conversation_heads h ON h.provider = c.provider AND h.account_label = c.account_label ' +
  'AND h.conversation_id = c.conversation_id AND h.source_batch = c.source_batch ';

// ---------------------------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------------------------

export class Repository {
  /** The underlying connection, exposed for sibling modules (search, analysis, graph, drafts). */
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ------------------------------------------------------------------------------------------- import

  /** See the file header for the full contract. */
  async importBatch(input: ImportBatchInput): Promise<ImportBatchResult> {
    if (typeof input !== 'object' || input === null) throw badArg('input', 'expected an object');
    const meta = validateBatchMeta(input.batch);
    const source = input.conversations as unknown;
    if (typeof source !== 'object' || source === null || (!(Symbol.asyncIterator in source) && !(Symbol.iterator in source))) {
      throw badArg('conversations', 'expected an iterable or async iterable of conversation records');
    }
    if (IMPORTS_IN_FLIGHT.has(this.db)) {
      throw new GcrError('DB_ERROR', 'An import is already in progress on this database connection.', { details: { reason: 'import_in_progress' } });
    }
    const queryOnly = this.db.prepare('PRAGMA query_only').get();
    if (queryOnly?.['query_only'] === 1) throw new GcrError('WRITE_FORBIDDEN', 'The database is read-only.');
    IMPORTS_IN_FLIGHT.add(this.db);
    try {
      return await this.runImport(meta, input.batch, input.conversations);
    } finally {
      IMPORTS_IN_FLIGHT.delete(this.db);
    }
  }

  private async runImport(
    meta: ImportBatchMeta,
    liveBatch: ImportBatchMeta,
    source: AsyncIterable<ConversationRecord> | Iterable<ConversationRecord>,
  ): Promise<ImportBatchResult> {
    const db = this.db;
    const batchId = computeBatchId(meta.provider, meta.accountLabel, meta.contentDigest);
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (e) {
      throw toDbError(e);
    }
    let committed = false;
    try {
      // Checked inside the write transaction so two processes importing the same input cannot both proceed.
      const existing = this.existingBatchResult(batchId);
      if (existing !== null) {
        db.exec('ROLLBACK'); // nothing was written; releases the write lock
        await releaseUnused(source);
        return existing;
      }
      db.exec('PRAGMA defer_foreign_keys = ON');

      const insertConversation = db.prepare(
        'INSERT INTO conversations (provider, account_label, conversation_id, source_batch, title, source_uri, provenance, completeness, ' +
          'imported_at, created_at, updated_at, current_node_id, default_model_slug, message_count, raw_metadata_json, warnings_json) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      );
      const insertMessage = db.prepare(
        'INSERT INTO messages (provider, account_label, conversation_id, message_id, source_batch, ordinal, parent_id, child_ids_json, node_kind, ' +
          'author_role, author_name, model_slug, channel, recipient, content_type, status, hidden, created_at, updated_at, text, blocks_json, ' +
          'attachments_json, raw_source_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      );
      const insertConversationFts = db.prepare('INSERT INTO conversations_fts (rowid, title_text) VALUES (?, ?)');
      const insertMessageFts = db.prepare('INSERT INTO messages_fts (rowid, search_text) VALUES (?, ?)');

      let conversations = 0;
      let realMessages = 0;
      let nodes = 0;
      let structural = 0;
      const duplicates: string[] = [];
      let duplicateCount = 0;

      for await (const candidate of source) {
        const rec = validateConversationRecord(candidate);
        if (rec.provider !== meta.provider || rec.accountLabel !== meta.accountLabel) {
          throw new GcrError('INVALID_ARGUMENT', 'A conversation record does not belong to the batch provider/account.', {
            details: { reason: 'record_scope_mismatch' },
          });
        }
        const messageCount = rec.messages.reduce((n, m) => n + (m.nodeKind === 'message' ? 1 : 0), 0);
        const res = insertConversation.run(
          rec.provider,
          rec.accountLabel,
          rec.id,
          batchId,
          rec.title,
          rec.sourceUri,
          rec.provenance,
          rec.completeness,
          rec.importedAt,
          rec.createdAt,
          rec.updatedAt,
          rec.currentNodeId,
          rec.defaultModelSlug,
          messageCount,
          jsonOrNull('rawMetadata', rec.rawMetadata),
          JSON.stringify(rec.warnings),
        );
        if (res.changes === 0) {
          // Same conversation id twice in one stream: keep the first, skip the rest, say so.
          duplicateCount++;
          if (duplicates.length < MAX_DUPLICATE_IDS_REPORTED && !duplicates.includes(rec.id)) duplicates.push(rec.id);
          continue;
        }
        conversations++;
        realMessages += messageCount;
        if (rec.title !== null && rec.title !== '') insertConversationFts.run(res.lastInsertRowid, buildSearchText(rec.title));

        for (const m of rec.messages) {
          const mr = insertMessage.run(...messageParams(batchId, rec, m));
          if (mr.changes === 0) continue;
          nodes++;
          if (m.nodeKind === 'structural_empty') {
            structural++;
          } else if (m.text !== '') {
            // Structural nodes carry no text and are never indexed; empty messages have no tokens to index.
            insertMessageFts.run(mr.lastInsertRowid, buildSearchText(m.text));
          }
        }
      }

      const warnings = [...normalizeWarnings('batch.warnings', liveBatch.warnings ?? [])];
      if (duplicateCount > 0) {
        warnings.push({
          code: 'DUPLICATE_CONVERSATION_IN_BATCH',
          message: `${duplicateCount} repeated conversation id(s) in the input were skipped (the first occurrence was kept).`,
          ids: duplicates,
        });
      }
      this.writeBatchRow(batchId, meta, warnings, conversations, realMessages, nodes, structural);
      this.updateHeads(batchId);
      db.exec('COMMIT');
      committed = true;
      return {
        batchId,
        alreadyImported: false,
        conversations: { stored: conversations, newlyInserted: conversations },
        messages: { stored: nodes, newlyInserted: nodes, structural },
      };
    } catch (e) {
      if (!committed) rollbackQuietly(db);
      throw isSqliteError(e) ? toDbError(e) : e;
    }
  }

  private existingBatchResult(batchId: string): ImportBatchResult | null {
    const row = this.db.prepare('SELECT conversation_count, message_count FROM source_batches WHERE batch_id = ?').get(batchId);
    if (row === undefined) return null;
    const stats = this.db.prepare('SELECT node_count, structural_count FROM source_batch_stats WHERE batch_id = ?').get(batchId);
    let nodes: number;
    let structural: number;
    if (stats !== undefined) {
      nodes = rowNumber(stats, 'node_count');
      structural = rowNumber(stats, 'structural_count');
    } else {
      // Defensive fallback for a database written without the helper row: count (slow path, never expected).
      const c = this.db.prepare("SELECT count(*) AS n, sum(node_kind = 'structural_empty') AS s FROM messages WHERE source_batch = ?").get(batchId);
      nodes = c === undefined ? 0 : rowNumber(c, 'n');
      structural = c === undefined ? 0 : rowNumber(c, 's');
    }
    const conversations = rowNumber(row, 'conversation_count');
    return {
      batchId,
      alreadyImported: true,
      conversations: { stored: conversations, newlyInserted: 0 },
      messages: { stored: nodes, newlyInserted: 0, structural },
    };
  }

  private writeBatchRow(
    batchId: string,
    meta: ImportBatchMeta,
    warnings: Warning[],
    conversations: number,
    realMessages: number,
    nodes: number,
    structural: number,
  ): void {
    // seq is assigned inside the write transaction, so it is strictly increasing in commit order.
    this.db
      .prepare(
        'INSERT INTO source_batches (batch_id, seq, provider, account_label, provenance, completeness, source_kind, source_label, input_sha256, ' +
          'imported_at, tool_version, schema_version, conversation_count, message_count, warnings_json) ' +
          'VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM source_batches), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        batchId,
        meta.provider,
        meta.accountLabel,
        meta.provenance,
        meta.completeness,
        meta.sourceKind,
        meta.sourceLabel,
        meta.contentDigest,
        meta.importedAt,
        meta.toolVersion,
        SCHEMA_VERSION,
        conversations,
        realMessages,
        JSON.stringify(warnings),
      );
    this.db.prepare('INSERT INTO source_batch_stats (batch_id, node_count, structural_count) VALUES (?, ?, ?)').run(batchId, nodes, structural);
  }

  /**
   * Point conversation_heads at the best snapshot of every conversation touched by `batchId`: greatest updated_at
   * (compared as instants via unixepoch so ".000Z" vs "Z" spellings agree; NULL = lowest), ties -> greatest seq.
   */
  private updateHeads(batchId: string): void {
    this.db
      .prepare(
        'INSERT INTO conversation_heads (provider, account_label, conversation_id, source_batch) ' +
          'SELECT c.provider, c.account_label, c.conversation_id, (' +
          'SELECT c2.source_batch FROM conversations c2 JOIN source_batches b2 ON b2.batch_id = c2.source_batch ' +
          'WHERE c2.provider = c.provider AND c2.account_label = c.account_label AND c2.conversation_id = c.conversation_id ' +
          "ORDER BY unixepoch(c2.updated_at, 'subsec') DESC NULLS LAST, b2.seq DESC LIMIT 1) " +
          'FROM conversations c WHERE c.source_batch = ? ' +
          'ON CONFLICT (provider, account_label, conversation_id) DO UPDATE SET source_batch = excluded.source_batch',
      )
      .run(batchId);
  }

  // ------------------------------------------------------------------------------------------- readers

  /** Conversations at their head batch (or every snapshot with includeAllBatches), with `total`. */
  listConversations(opts: ListConversationsOptions = {}): Page<ConversationSummary> {
    if (typeof opts !== 'object' || opts === null) throw badArg('options', 'expected an object');
    const provider = optString('provider', opts.provider);
    const accountLabel = optString('accountLabel', opts.accountLabel);
    const sort = opts.sort === undefined ? 'updated_desc' : oneOf('sort', opts.sort, ['updated_desc', 'created_desc', 'title_asc'] as const);
    const limit = opts.limit === undefined ? LIST_LIMIT_DEFAULT : opts.limit;
    const offset = opts.offset === undefined ? 0 : opts.offset;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) throw badArg('limit', `expected an integer from 1 to ${LIST_LIMIT_MAX}`);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000_000) throw badArg('offset', 'expected a non-negative integer');
    if (opts.includeAllBatches !== undefined && typeof opts.includeAllBatches !== 'boolean') throw badArg('includeAllBatches', 'expected a boolean');

    // Fixed fragments only; values are bound.
    let from = 'FROM conversations c ';
    if (opts.includeAllBatches !== true) from += HEAD_JOIN_C;
    let where = 'WHERE 1 = 1 ';
    const params: SQLInputValue[] = [];
    if (provider !== undefined) {
      where += 'AND c.provider = ? ';
      params.push(provider);
    }
    if (accountLabel !== undefined) {
      where += 'AND c.account_label = ? ';
      params.push(accountLabel);
    }
    if (opts.titleQuery !== undefined) {
      const compiled = compileQuery(opts.titleQuery, 'plain');
      where += 'AND c.rowid IN (SELECT rowid FROM conversations_fts WHERE conversations_fts MATCH ?) ';
      params.push(compiled.match);
    }
    return this.guard(() => {
      const total = rowNumber(this.db.prepare(`SELECT count(*) AS n ${from}${where}`).get(...params) ?? {}, 'n');
      const rows = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} ${from}${where}${ORDER_BY[sort]}LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const items = rows.map(conversationSummaryFromRow);
      const next = offset + items.length;
      return { items, limit, offset, total, nextOffset: next < total ? next : null };
    });
  }

  /**
   * All conversations matching the ref: the head batch of every (provider, account) that has this id, or - with
   * `batchId` - the single snapshot in that batch. More than one match means the id is ambiguous.
   */
  resolveConversation(ref: ConversationRef): { matches: ConversationSummary[] } {
    const conversationId = reqString('conversationId', ref?.conversationId);
    const provider = optString('provider', ref.provider);
    const accountLabel = optString('accountLabel', ref.accountLabel);
    const batchId = optString('batchId', ref.batchId);
    const params: SQLInputValue[] = [conversationId];
    let sql: string;
    if (batchId !== undefined) {
      sql = `SELECT ${SUMMARY_COLUMNS} FROM conversations c WHERE c.conversation_id = ? AND c.source_batch = ? `;
      params.push(batchId);
    } else {
      sql = `SELECT ${SUMMARY_COLUMNS} FROM conversations c ${HEAD_JOIN_C}WHERE c.conversation_id = ? `;
    }
    if (provider !== undefined) {
      sql += 'AND c.provider = ? ';
      params.push(provider);
    }
    if (accountLabel !== undefined) {
      sql += 'AND c.account_label = ? ';
      params.push(accountLabel);
    }
    sql += 'ORDER BY c.provider ASC, c.account_label ASC, c.source_batch ASC';
    return this.guard(() => ({ matches: this.db.prepare(sql).all(...params).map(conversationSummaryFromRow) }));
  }

  /**
   * The full record (messages ordered by ordinal) or null when unknown. Throws AMBIGUOUS_CONVERSATION when the id exists
   * under several providers/accounts and the ref does not disambiguate. JSON columns are parsed defensively: a damaged
   * column yields an empty value plus a STORED_JSON_INVALID warning instead of an exception.
   */
  getConversation(ref: ConversationRef): ConversationRecord | null {
    const summary = this.single(ref);
    return summary === null ? null : this.guard(() => this.loadRecord(summary));
  }

  /** One message of a conversation (same resolution rules as getConversation) or null. */
  getMessage(ref: ConversationRef, messageId: string): MessageRecord | null {
    const id = reqString('messageId', messageId);
    const summary = this.single(ref);
    if (summary === null) return null;
    return this.guard(() => {
      const row = this.db
        .prepare('SELECT * FROM messages WHERE provider = ? AND account_label = ? AND conversation_id = ? AND source_batch = ? AND message_id = ?')
        .get(summary.provider, summary.accountLabel, summary.conversationId, summary.batchId, id);
      if (row === undefined) return null;
      return messageFromRow(row, []);
    });
  }

  /** All import batches in import order (seq ascending). */
  listBatches(): BatchInfo[] {
    return this.guard(() => this.db.prepare('SELECT * FROM source_batches ORDER BY seq ASC').all().map(batchFromRow));
  }

  getBatch(batchId: string): BatchInfo | null {
    const id = reqString('batchId', batchId);
    return this.guard(() => {
      const row = this.db.prepare('SELECT * FROM source_batches WHERE batch_id = ?').get(id);
      return row === undefined ? null : batchFromRow(row);
    });
  }

  /**
   * Maintenance: drop and recreate both full-text indexes from the imported tables. Needed only if the index is
   * suspected stale (for example after an external tool renumbered rowids). One transaction; returns the rows indexed.
   */
  rebuildSearchIndex(): { messages: number; conversations: number } {
    const db = this.db;
    if (IMPORTS_IN_FLIGHT.has(db)) throw new GcrError('DB_ERROR', 'An import is in progress on this database connection.');
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (e) {
      throw toDbError(e); // a failed BEGIN has nothing to roll back; never touch a transaction that is not ours
    }
    try {
      db.exec("INSERT INTO messages_fts (messages_fts) VALUES ('delete-all')");
      db.exec("INSERT INTO conversations_fts (conversations_fts) VALUES ('delete-all')");
      const insertMessage = db.prepare('INSERT INTO messages_fts (rowid, search_text) VALUES (?, ?)');
      let messages = 0;
      for (const r of db.prepare("SELECT rowid AS rid, text FROM messages WHERE node_kind = 'message' AND text <> ''").iterate()) {
        insertMessage.run(Number(r['rid']), buildSearchText(rowString(r, 'text')));
        messages++;
      }
      const insertConversation = db.prepare('INSERT INTO conversations_fts (rowid, title_text) VALUES (?, ?)');
      let conversations = 0;
      for (const r of db.prepare("SELECT rowid AS rid, title FROM conversations WHERE title IS NOT NULL AND title <> ''").iterate()) {
        insertConversation.run(Number(r['rid']), buildSearchText(rowString(r, 'title')));
        conversations++;
      }
      db.exec('COMMIT');
      return { messages, conversations };
    } catch (e) {
      rollbackQuietly(db);
      throw toDbError(e);
    }
  }

  // ------------------------------------------------------------------------------------------- internals

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof GcrError) throw e;
      throw toDbError(e);
    }
  }

  private single(ref: ConversationRef): ConversationSummary | null {
    const { matches } = this.resolveConversation(ref);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new GcrError('AMBIGUOUS_CONVERSATION', 'The conversation id exists under more than one provider or account.', {
        remedy: 'Pass provider and/or accountLabel (or a batch id) to choose one.',
        details: {
          conversationId: ref.conversationId,
          candidates: matches.map((m) => ({ provider: m.provider, accountLabel: m.accountLabel, batchId: m.batchId })),
        },
      });
    }
    return matches[0] ?? null;
  }

  private loadRecord(s: ConversationSummary): ConversationRecord {
    const crow = this.db
      .prepare('SELECT source_uri, raw_metadata_json, warnings_json FROM conversations WHERE provider = ? AND account_label = ? AND conversation_id = ? AND source_batch = ?')
      .get(s.provider, s.accountLabel, s.conversationId, s.batchId);
    const damaged: string[] = [];
    const extra: Warning[] = [];

    const warnParsed = parseJson(crow === undefined ? null : rowStringOrNull(crow, 'warnings_json'));
    const storedWarnings = warnParsed.ok ? warningsOf(warnParsed.value) : null;
    if (storedWarnings === null) damaged.push('conversation.warnings');

    const rec: ConversationRecord = {
      provider: s.provider,
      accountLabel: s.accountLabel,
      id: s.conversationId,
      title: s.title,
      sourceUri: crow === undefined ? null : rowStringOrNull(crow, 'source_uri'),
      provenance: s.provenance,
      completeness: s.completeness,
      importedAt: s.importedAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      currentNodeId: s.currentNodeId,
      defaultModelSlug: s.defaultModelSlug,
      messages: [],
      warnings: storedWarnings ?? [],
    };
    const rawMeta = crow === undefined ? null : rowStringOrNull(crow, 'raw_metadata_json');
    if (rawMeta !== null) {
      const p = parseJson(rawMeta);
      if (p.ok) rec.rawMetadata = p.value;
      else damaged.push('conversation.rawMetadata');
    }

    const rows = this.db
      .prepare('SELECT * FROM messages WHERE provider = ? AND account_label = ? AND conversation_id = ? AND source_batch = ? ORDER BY ordinal ASC, message_id ASC')
      .all(s.provider, s.accountLabel, s.conversationId, s.batchId);
    for (const r of rows) rec.messages.push(messageFromRow(r, damaged));
    if (damaged.length > 0) {
      extra.push({
        code: 'STORED_JSON_INVALID',
        message: `${damaged.length} stored JSON column(s) could not be read and were replaced by empty values.`,
        ids: [s.conversationId, ...damaged.slice(0, MAX_DUPLICATE_IDS_REPORTED)],
      });
    }
    rec.warnings = [...rec.warnings, ...extra];
    return rec;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Row <-> record mapping
// ---------------------------------------------------------------------------------------------------------------

function messageParams(batchId: string, c: ConversationRecord, m: MessageRecord): SQLInputValue[] {
  return [
    c.provider,
    c.accountLabel,
    c.id,
    m.id,
    batchId,
    m.ordinal,
    m.parentId,
    JSON.stringify(m.childIds),
    m.nodeKind,
    m.authorRole,
    m.authorName,
    m.modelSlug,
    m.channel,
    m.recipient,
    m.contentType,
    m.status,
    m.hidden ? 1 : 0,
    m.createdAt,
    m.updatedAt,
    m.text,
    JSON.stringify(m.blocks),
    JSON.stringify(m.attachments),
    jsonOrNull('rawSource', m.rawSource),
  ];
}

/** `damaged` collects "message:<id>.<column>" markers for columns whose JSON could not be used. */
function messageFromRow(r: Row, damaged: string[]): MessageRecord {
  const id = rowString(r, 'message_id');
  const mark = (column: string): void => {
    damaged.push(`message:${id}.${column}`);
  };
  const childIdsParsed = parseJson(rowStringOrNull(r, 'child_ids_json'));
  const childIds = childIdsParsed.ok ? stringArrayOf(childIdsParsed.value) : null;
  if (childIds === null) mark('childIds');
  const blocksParsed = parseJson(rowStringOrNull(r, 'blocks_json'));
  const blocks = blocksParsed.ok ? blocksOf(blocksParsed.value) : null;
  if (blocks === null) mark('blocks');
  const attParsed = parseJson(rowStringOrNull(r, 'attachments_json'));
  const attachments = attParsed.ok ? attachmentsOf(attParsed.value) : null;
  if (attachments === null) mark('attachments');

  const m: MessageRecord = {
    id,
    conversationId: rowString(r, 'conversation_id'),
    parentId: rowStringOrNull(r, 'parent_id'),
    childIds: childIds ?? [],
    nodeKind: rowString(r, 'node_kind') === 'structural_empty' ? 'structural_empty' : 'message',
    authorRole: rowString(r, 'author_role'),
    authorName: rowStringOrNull(r, 'author_name'),
    modelSlug: rowStringOrNull(r, 'model_slug'),
    channel: rowStringOrNull(r, 'channel'),
    recipient: rowStringOrNull(r, 'recipient'),
    contentType: rowStringOrNull(r, 'content_type'),
    status: rowStringOrNull(r, 'status'),
    hidden: rowNumber(r, 'hidden') === 1,
    createdAt: rowStringOrNull(r, 'created_at'),
    updatedAt: rowStringOrNull(r, 'updated_at'),
    text: rowString(r, 'text'),
    blocks: blocks ?? [],
    attachments: attachments ?? [],
    ordinal: rowNumber(r, 'ordinal'),
  };
  const raw = rowStringOrNull(r, 'raw_source_json');
  if (raw !== null) {
    const p = parseJson(raw);
    if (p.ok) m.rawSource = p.value;
    else mark('rawSource');
  }
  return m;
}

function batchFromRow(r: Row): BatchInfo {
  const warnParsed = parseJson(rowStringOrNull(r, 'warnings_json'));
  return {
    provider: rowString(r, 'provider') as Provider,
    accountLabel: rowString(r, 'account_label'),
    provenance: rowString(r, 'provenance') as ConversationProvenance,
    completeness: rowString(r, 'completeness') as Completeness,
    batchId: rowString(r, 'batch_id'),
    sourceLabel: rowStringOrNull(r, 'source_label'),
    importedAt: rowString(r, 'imported_at'),
    toolVersion: rowString(r, 'tool_version'),
    seq: rowNumber(r, 'seq'),
    sourceKind: rowString(r, 'source_kind'),
    inputSha256: rowString(r, 'input_sha256'),
    schemaVersion: rowNumber(r, 'schema_version'),
    conversationCount: rowNumber(r, 'conversation_count'),
    messageCount: rowNumber(r, 'message_count'),
    warnings: (warnParsed.ok ? warningsOf(warnParsed.value) : null) ?? [],
  };
}

/** Let an unused record source finish (generators run their `finally` blocks). Called only on the idempotent no-op path. */
async function releaseUnused(source: AsyncIterable<ConversationRecord> | Iterable<ConversationRecord>): Promise<void> {
  const iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  await iterator.return?.();
}

