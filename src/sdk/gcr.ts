/**
 * `Gcr`: the SDK facade (docs/ARCHITECTURE.md section 8; SPEC FR-06, FR-07, FR-09, FR-13, FR-14). The CLI (src/cli) and
 * the MCP server (src/mcp) are thin adapters over this class, so its method signatures, result envelopes and error
 * behaviour ARE the product.
 *
 * CONTRACT
 *  - Offline only. This class imports no network module and never turns a conversation reference into a request: a
 *    `https://chatgpt.com/c/<uuid>` link is a KEY into data the user imported (NOT_IN_LOCAL_EXPORT when it is not there).
 *  - Every method either returns a `ResultEnvelope` (source, completeness, warnings, ids, untrustedContent: see
 *    envelope.ts) or throws a `GcrError`. Nothing else ever escapes: raw SQLite/fs/JS errors are normalized with
 *    `normalizeError` (DB errors keep the codes db/open.ts mapped them to; unknown errors become INTERNAL_ERROR with a
 *    generic message, so file paths and SQL never reach a caller).
 *  - Reads are synchronous (node:sqlite is). MUTATORS ARE ASYNC (import, manual copy, graph build, drafts, annotations):
 *    they go through a per-instance writer lock, so two of them can never interleave on the one connection, and the
 *    second never meets SQLITE_BUSY or the repository's "import already in progress" guard.
 *  - While a mutator is RUNNING (an import awaits file reads between its statements), the connection holds an open
 *    write transaction. A read issued at that moment would see UNCOMMITTED rows (read-your-own-writes), i.e. a half
 *    imported batch presented as data. Reads therefore fail with DB_ERROR (reason "write_in_progress") instead; the
 *    caller awaits the write and retries.
 *  - A read-only handle (`readOnly: true`) never creates, migrates or writes: every mutator rejects with WRITE_FORBIDDEN
 *    and reads work.
 *  - Imported conversation text is untrusted DATA. Nothing in this file interprets it; it only moves through unchanged.
 *
 * Active-branch policy (ADR-0009): the active branch is NEVER guessed. Precedence for the primary thread:
 *   explicit `branch` > the source's current_node > exactly one branch in the tree > the caller's opt-in `branchPolicy`
 *   heuristic (always flagged ACTIVE_BRANCH_HEURISTIC) > ACTIVE_BRANCH_UNKNOWN.
 */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { closeDatabase, isSqliteError, openDatabase, toDbError } from '../db/open.js';
import type { GcrDatabase } from '../db/open.js';
import { Repository } from '../db/repo.js';
import type { ListConversationsOptions } from '../db/repo.js';
import { SEARCH_LIMIT_MAX, searchConversationTitles, searchMessages } from '../db/search.js';
import type { SearchMode, SearchQuery, TitleHit } from '../db/search.js';
import { computeStats } from '../analysis/stats.js';
import type { StatsOptions, StatsResult } from '../analysis/stats.js';
import { runAudit } from '../analysis/audit.js';
import type { AuditOptions, AuditResult } from '../analysis/audit.js';
import { analyzeTree, selectBranchByPolicy } from '../domain/branches.js';
import type { BranchPolicy } from '../domain/branches.js';
import { isUuid, parseChatGptUrl, parseConversationRef } from '../domain/ids.js';
import type { BatchInfo, BranchListResult, ConversationSummary, FormatProfile, ImportReport, Page, SearchHit, ThreadResult } from '../domain/results.js';
import type { Branch, BranchActiveness, Completeness, ConversationRecord, ConversationRef, MessageRecord, ResultEnvelope, TreeAnalysis } from '../domain/types.js';
import { LocalStore } from '../drafts/drafts.js';
import type { AnnotationDto, AnnotationFilter, AnnotationPatch, CreateAnnotationInput, CreateDraftInput, DraftDto, DraftFilter, LocalActor } from '../drafts/drafts.js';
import { GcrError, toGcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { buildGraph as buildGraphImpl, conversationNodeId } from '../graph/build.js';
import type { BuildGraphOptions, BuildGraphResult } from '../graph/build.js';
import { exportGraphHtml } from '../graph/export-html.js';
import type { ExportHtmlOptions } from '../graph/export-html.js';
import { explainEdge, godNodes, graphQuery as graphQueryImpl, neighbors as neighborsImpl, shortestPath } from '../graph/query.js';
import type {
  EdgeRef,
  ExplainEdgeOptions,
  ExplainEdgeResult,
  GodNode,
  GodNodesOptions,
  GraphEdgeDto,
  GraphNodeDto,
  GraphQueryInput,
  GraphQueryResult,
  NeighborsOptions,
  NeighborsResult,
  PathResult,
  ShortestPathOptions,
} from '../graph/query.js';
import { runImport } from '../ingest/import-runner.js';
import type { ImportOptions } from '../ingest/import-runner.js';
import { runManualCopyImport } from '../ingest/manual-copy.js';
import { log } from '../logger.js';
import { buildEnvelope, buildProvenance, mergeWarnings, normalizeCompleteness, uniq, warningsCarryIds } from './envelope.js';
import type { BatchLookup, Contribution, EnvelopeParts, Provenance } from './envelope.js';
import { runDoctor } from './doctor.js';
import type { DoctorOptions, DoctorReport } from './doctor.js';
import { checkKeys, invalidArgument, normalizeRef, optBool, optEnum, optInt, optString, resolveSummary, withBatchPin } from './resolve.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

export interface GcrOpenOptions {
  /** Database file, or ":memory:" (read-write only). */
  dbPath: string;
  /** Never create, migrate or write. A missing file is DB_NOT_FOUND. Default false. */
  readOnly?: boolean;
  /** Create the file when missing. Default: true unless `readOnly`. */
  create?: boolean;
  /** Recorded as `created_via` on drafts/annotations and in the audit log. Default "sdk". */
  actor?: LocalActor;
  /** ISO-8601 UTC timestamp source for imports and local writes (injectable for reproducible output). */
  clock?: () => string;
}

export interface ListOptions {
  provider?: string;
  accountLabel?: string;
  /** Full-text query over titles (plain mode). */
  titleQuery?: string;
  sort?: 'updated_desc' | 'created_desc' | 'title_asc';
  /** 1..500, default 50. */
  limit?: number;
  offset?: number;
  /** List every stored snapshot, not only each conversation's newest (head) one. */
  allBatches?: boolean;
  /** Alias of `allBatches` (the repository's own spelling). */
  includeAllBatches?: boolean;
}

/** Branch selection and shaping options shared by `get` and `thread`. */
export interface ThreadOptions {
  /** A branch id (= its leaf message id, see `branches`). Wins over everything else. */
  branch?: string;
  /** Opt-in heuristic used ONLY when the source gives no active branch and the tree has several (flagged ACTIVE_BRANCH_HEURISTIC). */
  branchPolicy?: BranchPolicy;
  /** Include messages the source marked hidden (system scaffolding, memory, ...). Default false; they are counted in `omittedHidden`. */
  includeHidden?: boolean;
  /** Read this import snapshot instead of the conversation's newest one. */
  batchId?: string;
  /** Keep `rawSource` on messages (the source message object as parsed). Default false: it is large and for local use only. */
  includeRaw?: boolean;
}

export interface GetOptions extends ThreadOptions {
  /** Also return one ThreadResult per branch (in branch order) in `threads`. */
  allBranches?: boolean;
}

export interface BranchesOptions {
  batchId?: string;
}

export interface GetResult {
  conversation: ConversationSummary;
  /**
   * The primary thread chosen by the precedence rules. null only when `allBranches` was requested and the source did not
   * identify the active branch (nothing is guessed), or the conversation has no messages at all.
   */
  thread: ThreadResult | null;
  /**
   * Present with `allBranches`: every branch in branch order. Their `selectionPolicy` is always "explicit_branch" (the
   * caller asked for all of them); the real choice is `thread.selectionPolicy`. Only `thread` carries the tree warnings.
   */
  threads?: ThreadResult[];
}

export type SearchScope = 'messages' | 'titles' | 'all';

export interface SearchOptions {
  query: string;
  /** "plain" (default, safe) or "raw" FTS5 syntax. */
  mode?: SearchMode;
  provider?: string;
  accountLabel?: string;
  /** Raw id, bare UUID or chatgpt.com link. Message scope only. */
  conversationId?: string;
  /** Message scope only. */
  role?: string;
  /** Message scope only. */
  channel?: string;
  /** Message scope only: true = only messages with an explicit model slug, false = only those without. */
  hasModel?: boolean;
  /** Message scope only; inclusive ISO-8601 UTC. */
  createdAfter?: string;
  /** Message scope only; exclusive ISO-8601 UTC. */
  createdBefore?: string;
  /** Message scope only. */
  includeHidden?: boolean;
  /** Search superseded snapshots too (default: newest snapshot of each conversation). */
  allBatches?: boolean;
  /** 1..200, default 20. */
  limit?: number;
  offset?: number;
  /** Keyset cursor from a previous page's `nextCursor`. Message scope only. */
  cursor?: string;
  /** "messages" (default), "titles" or "all" (titles first, then messages). */
  scope?: SearchScope;
}

export type MessageSearchItem = SearchHit & { kind: 'message' };
export type TitleSearchItem = TitleHit & { kind: 'title' };
/** Discriminated by `kind`: scope "all" interleaves nothing, it lists every title hit first and then the message hits. */
export type SearchItem = MessageSearchItem | TitleSearchItem;

/** The FormatProfile an import observed, for batches imported through THIS handle (it is not persisted in the database). */
export interface BatchFormatProfile {
  batchId: string;
  formatProfile: FormatProfile;
}
export type StatsReport = StatsResult & { formatProfiles: BatchFormatProfile[] };
export type AuditReport = AuditResult & { formatProfiles: BatchFormatProfile[] };

export interface ManualCopyOptions {
  accountLabel?: string;
  /** Basename-only label recorded as the batch's source label. */
  sourceLabel?: string;
  clock?: () => string;
}

export interface GraphHtmlOptions extends ExportHtmlOptions {
  /** Export the neighbourhood of this term (graphQuery). Absent: the most connected nodes of the whole graph. */
  term?: string;
  /** 1..4 (term only). */
  depth?: number;
  /** 1..500. Default 100. */
  maxNodes?: number;
  kinds?: string[];
}

/** The graph HTML export: the document plus provenance (the page is built from imported labels, so it is untrusted data). */
export interface GraphHtmlExport extends Provenance {
  html: string;
  nodes: number;
  edges: number;
}

export interface CreateLocalDraftInput extends Omit<CreateDraftInput, 'conversationRef'> {
  conversationRef: string | ConversationRef;
}
export interface CreateLocalAnnotationInput extends Omit<CreateAnnotationInput, 'conversationRef'> {
  conversationRef: string | ConversationRef;
}
export interface ListDraftsFilter extends Omit<DraftFilter, 'conversationRef'> {
  conversationRef?: string | ConversationRef;
}
export interface ListAnnotationsFilter extends Omit<AnnotationFilter, 'conversationRef'> {
  conversationRef?: string | ConversationRef;
}

/** `localOnly: true` on every local-write result: drafts and annotations never leave this database and nothing is sent anywhere. */
export interface LocalDraftData {
  localOnly: true;
  draft: DraftDto;
}
export interface LocalDraftListData extends Page<DraftDto> {
  localOnly: true;
}
export interface LocalDraftMarkdownData {
  localOnly: true;
  draftId: string;
  markdown: string;
}
export interface LocalAnnotationData {
  localOnly: true;
  annotation: AnnotationDto;
}
export interface LocalAnnotationListData extends Page<AnnotationDto> {
  localOnly: true;
}

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

const ACTORS: readonly LocalActor[] = ['cli', 'mcp', 'sdk'];
const BRANCH_POLICIES: readonly BranchPolicy[] = ['last_child', 'latest_leaf'];
const SEARCH_SCOPES: readonly SearchScope[] = ['messages', 'titles', 'all'];
const SEARCH_MODES: readonly SearchMode[] = ['plain', 'raw'];

const OPEN_KEYS = ['dbPath', 'readOnly', 'create', 'actor', 'clock'];
const LIST_KEYS = ['provider', 'accountLabel', 'titleQuery', 'sort', 'limit', 'offset', 'allBatches', 'includeAllBatches'];
const THREAD_KEYS = ['branch', 'branchPolicy', 'includeHidden', 'batchId', 'includeRaw'];
const GET_KEYS = [...THREAD_KEYS, 'allBranches'];
const BRANCHES_KEYS = ['batchId'];
const SEARCH_KEYS = [
  'query', 'mode', 'provider', 'accountLabel', 'conversationId', 'role', 'channel', 'hasModel', 'createdAfter', 'createdBefore',
  'includeHidden', 'allBatches', 'limit', 'offset', 'cursor', 'scope',
];
/** Filters that only make sense for messages: rejected for the title scopes instead of being silently ignored. */
const MESSAGE_ONLY_FILTERS = ['conversationId', 'role', 'channel', 'hasModel', 'createdAfter', 'createdBefore', 'cursor'];
const IMPORT_KEYS = ['source', 'accountLabel', 'provider', 'strict', 'limits', 'clock', 'onProgress'];
const MANUAL_COPY_KEYS = ['accountLabel', 'sourceLabel', 'clock'];
const GRAPH_HTML_KEYS = ['term', 'depth', 'maxNodes', 'kinds', 'title', 'layoutSeed', 'maxOverviewNodes'];
const DRAFT_INPUT_KEYS = ['conversationRef', 'anchorMessageId', 'title', 'body', 'namespace'];
const ANNOTATION_INPUT_KEYS = ['conversationRef', 'messageId', 'kind', 'body', 'namespace'];
const DRAFT_FILTER_KEYS = ['conversationRef', 'namespace', 'status', 'limit', 'offset'];
const ANNOTATION_FILTER_KEYS = ['conversationRef', 'messageId', 'namespace', 'kind', 'limit', 'offset'];

/** Scope "all" scans the title stream up to offset+limit hits to find where the message stream starts; this bounds that work. */
const MAX_ALL_SCOPE_WINDOW = 10_000;
const MAX_BRANCH_IDS_IN_ERROR = 50;
const MAX_OVERVIEW_NODES = 500;

const HEAD_JOIN_C =
  'JOIN conversation_heads h ON h.provider = c.provider AND h.account_label = c.account_label ' +
  'AND h.conversation_id = c.conversation_id AND h.source_batch = c.source_batch ';

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

/** node:sqlite throws ERR_INVALID_STATE ("database is not open") when the connection was closed behind our back. */
function isClosedConnectionError(e: unknown): boolean {
  return e instanceof Error && (e as { code?: unknown }).code === 'ERR_INVALID_STATE';
}

/**
 * ANY thrown value -> GcrError. GcrErrors pass through; SQLite errors get their mapped DB codes (a missing table in a
 * damaged file is a DB_ERROR, not an INTERNAL_ERROR); a connection closed behind our back is DB_ERROR "closed";
 * everything else becomes the generic INTERNAL_ERROR of toGcrError (its message never carries paths, SQL or content).
 */
export function normalizeError(e: unknown): GcrError {
  if (e instanceof GcrError) return e;
  if (isSqliteError(e)) return toDbError(e);
  if (isClosedConnectionError(e)) {
    return new GcrError('DB_ERROR', 'The database connection is closed.', { remedy: 'Open a new handle with Gcr.open().', details: { reason: 'closed' }, cause: e });
  }
  return toGcrError(e);
}

function closedError(): GcrError {
  return new GcrError('DB_ERROR', 'This Gcr handle is closed.', { remedy: 'Open a new handle with Gcr.open().', details: { reason: 'closed' } });
}

function writeInProgressError(): GcrError {
  return new GcrError('DB_ERROR', 'A write (import, graph build or local write) is in progress on this handle; reads are refused until it finishes so they cannot see uncommitted data.', {
    remedy: 'Await the pending write, then retry the read.',
    details: { reason: 'write_in_progress' },
  });
}

function writeForbiddenError(): GcrError {
  return new GcrError('WRITE_FORBIDDEN', 'This handle was opened read-only; imports, graph builds, drafts and annotations are not allowed.', {
    remedy: 'Open the database without readOnly to change it.',
  });
}

function echoId(id: string): string {
  return id.length > 128 ? `${id.slice(0, 127)}…` : id;
}

function branchNotFound(s: ConversationSummary, analysis: TreeAnalysis, branchId: string): GcrError {
  const skippedByLimits = analysis.leafIds.includes(branchId);
  return new GcrError('BRANCH_NOT_FOUND', skippedByLimits ? 'This leaf exists but its branch was not enumerated (the tree exceeds the branch limits).' : 'No such branch in this conversation.', {
    remedy: 'List the branches (gcr branches <conversation>) and pass one of the returned branch ids; a branch id is the id of its leaf message.',
    details: { conversationId: s.conversationId, branchId: echoId(branchId), branchCount: analysis.branches.length, reason: skippedByLimits ? 'not_enumerated' : 'unknown_branch' },
  });
}

function noBranches(s: ConversationSummary): GcrError {
  return new GcrError('BRANCH_NOT_FOUND', 'This conversation has no branches (its stored message tree is empty).', {
    remedy: 'There is nothing to read in this snapshot. Import an export that contains messages for it.',
    details: { conversationId: s.conversationId, branchCount: 0, reason: 'no_branches' },
  });
}

const ACTIVE_BRANCH_REMEDY =
  'GCR does not guess which branch is active. List the branches with "gcr branches <conversation>" and pass --branch <id>, or opt in to a labelled heuristic with --branch-policy last_child|latest_leaf (the result is then flagged ACTIVE_BRANCH_HEURISTIC).';

function activeBranchUnknown(s: ConversationSummary, analysis: TreeAnalysis, extra: Record<string, unknown> = {}): GcrError {
  const ids = analysis.branches.map((b) => b.branchId);
  return new GcrError('ACTIVE_BRANCH_UNKNOWN', `The source did not identify the active branch (no valid current_node) and the conversation has ${ids.length} branches.`, {
    remedy: ACTIVE_BRANCH_REMEDY,
    details: {
      conversationId: s.conversationId,
      branchCount: ids.length,
      branchIds: ids.slice(0, MAX_BRANCH_IDS_IN_ERROR),
      branchIdsTruncated: ids.length > MAX_BRANCH_IDS_IN_ERROR,
      ...extra,
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Branch selection and thread building (pure)
// ---------------------------------------------------------------------------------------------------------------

interface Selected {
  branch: Branch;
  /** Root -> end of the thread. Shorter than branch.path when the source's current node is not a leaf. */
  path: readonly string[];
  activeness: BranchActiveness;
  policy: ThreadResult['selectionPolicy'];
  /** Warnings that explain this particular choice. */
  warnings: Warning[];
  /** Tree-analysis warning codes this selection supersedes with a more specific warning of its own. */
  supersedes: readonly string[];
}

/**
 * The primary thread by the documented precedence. `required: false` (allBranches) returns null instead of throwing
 * ACTIVE_BRANCH_UNKNOWN / "no branches": the caller then still has every branch to show.
 */
function selectPrimary(a: {
  summary: ConversationSummary;
  analysis: TreeAnalysis;
  messages: readonly MessageRecord[];
  branch: string | undefined;
  branchPolicy: BranchPolicy | undefined;
  required: boolean;
}): Selected | null {
  const { analysis, summary } = a;
  const branches = analysis.branches;

  // 1. Explicit branch id.
  if (a.branch !== undefined) {
    const b = branches.find((x) => x.branchId === a.branch);
    if (b === undefined) throw branchNotFound(summary, analysis, a.branch);
    return { branch: b, path: b.path, activeness: b.activeness, policy: 'explicit_branch', warnings: [], supersedes: [] };
  }
  if (branches.length === 0) {
    if (a.required) throw noBranches(summary);
    return null;
  }

  // 2. The source's own current_node (analysis.activeBranchId is non-null only for a VALID pointer).
  if (analysis.activeBranchId !== null) {
    const b = branches.find((x) => x.branchId === analysis.activeBranchId);
    if (b !== undefined && b.activeness === 'active') {
      return { branch: b, path: b.path, activeness: 'active', policy: 'source_current_node', warnings: [], supersedes: [] };
    }
    const current = summary.currentNodeId;
    const at = b !== undefined && current !== null ? b.path.indexOf(current) : -1;
    if (b !== undefined && current !== null && at >= 0) {
      // The current node is an inner node: what the user last saw ends THERE. Messages below it exist in the tree but
      // were not on the active path, so the thread is cut at the current node and says so.
      const through = branches.filter((x) => x.activeness === 'contains_current_node').length;
      return {
        branch: b,
        path: b.path.slice(0, at + 1),
        activeness: 'contains_current_node',
        policy: 'source_current_node',
        warnings: [
          {
            code: 'CURRENT_NODE_NOT_LEAF',
            message: `The source's current_node is not a leaf: the thread runs from the root to it and omits what follows (${through} branch(es) pass through it; branchId is the first of them).`,
            ids: [current, b.branchId],
          },
        ],
        supersedes: ['CURRENT_NODE_NOT_LEAF'],
      };
    }
  }

  // 3. Exactly one branch: nothing is inferred, there is nothing to choose between.
  const only = branches[0];
  if (only !== undefined && branches.length === 1 && analysis.leafIds.length === 1) {
    return { branch: only, path: only.path, activeness: only.activeness, policy: 'only_branch', warnings: [], supersedes: [] };
  }

  // 4. Explicit, labelled heuristic (never the default).
  if (a.branchPolicy !== undefined) {
    const chosen = selectBranchByPolicy(analysis, a.messages, a.branchPolicy);
    if (chosen !== null) {
      return {
        branch: chosen.branch,
        path: chosen.branch.path,
        activeness: chosen.branch.activeness,
        policy: a.branchPolicy,
        warnings: [chosen.warning],
        supersedes: [],
      };
    }
    if (a.required) throw activeBranchUnknown(summary, analysis, { reason: 'heuristic_unavailable', branchPolicy: a.branchPolicy });
    return null;
  }

  // 5. Unknown.
  if (a.required) throw activeBranchUnknown(summary, analysis);
  return null;
}

/**
 * Import-time warnings stored with the conversation, minus the ones the read-time tree analysis reports again (same code,
 * e.g. NO_CURRENT_NODE) or that a more specific selection warning replaces. The analysis is recomputed from the stored
 * tree on every read, so it is the authority for tree-shape facts; the stored warnings keep what only the importer knew
 * (CHILDREN_ABSENT, COMPLETENESS_LOWERED, unknown content types, ...).
 */
function storedWarnings(record: ConversationRecord, analysis: TreeAnalysis, supersedes: readonly string[]): Warning[] {
  const covered = new Set<string>([...analysis.warnings.map((w) => w.code), ...supersedes]);
  return record.warnings.filter((w) => !covered.has(w.code));
}

interface ThreadContext {
  summary: ConversationSummary;
  byId: ReadonlyMap<string, MessageRecord>;
  includeHidden: boolean;
  includeRaw: boolean;
  /** One output copy per message, shared by every thread that contains it. */
  views: Map<string, MessageRecord>;
}

function viewOf(ctx: ThreadContext, m: MessageRecord): MessageRecord {
  if (ctx.includeRaw || m.rawSource === undefined) return m;
  let v = ctx.views.get(m.id);
  if (v === undefined) {
    v = { ...m };
    delete v.rawSource;
    ctx.views.set(m.id, v);
  }
  return v;
}

/**
 * Messages along `path`, structural nodes dropped, hidden ones dropped (and counted) unless requested. Same semantics as
 * domain/branches.ts threadForBranch, but indexed ONCE per conversation: allBranches would otherwise rescan every message
 * for every branch (branches x messages).
 */
function makeThread(ctx: ThreadContext, p: { branchId: string; path: readonly string[]; activeness: BranchActiveness; policy: ThreadResult['selectionPolicy']; warnings: Warning[] }): ThreadResult {
  const messages: MessageRecord[] = [];
  let omittedHidden = 0;
  for (const id of p.path) {
    const m = ctx.byId.get(id);
    if (m === undefined) {
      throw new GcrError('MESSAGE_NOT_FOUND', 'A message on the branch path is missing from the stored conversation.', { details: { conversationId: ctx.summary.conversationId, messageId: echoId(id) } });
    }
    if (m.nodeKind !== 'message') continue;
    if (m.hidden && !ctx.includeHidden) {
      omittedHidden++;
      continue;
    }
    messages.push(viewOf(ctx, m));
  }
  return { conversation: ctx.summary, branchId: p.branchId, activeness: p.activeness, messages, omittedHidden, selectionPolicy: p.policy, warnings: p.warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

function rowStr(r: Row, k: string): string {
  const v = r[k];
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function noop(): void {
  /* intentionally empty: used to swallow the settled outcome of the writer-lock chain */
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

/** A conversation filter given as a link or UUID is reduced to the id the database stores; anything else is a raw id. */
function conversationFilter(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > 512 || v.includes('\0')) throw invalidArgument('conversationId', 'expected a non-empty string without NUL bytes (max 512 characters)');
  if (isUuid(v)) return v.toLowerCase();
  if (/^[\t\n\f\r ]*[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) return parseConversationRef(v).conversationId;
  return v;
}

function pickDefined(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) Object.defineProperty(out, k, { value: o[k], writable: true, enumerable: true, configurable: true });
  return out;
}

/**
 * The input of an import is a file/folder path or a byte stream the caller already holds. A missing or malformed source
 * is a caller bug reported as INVALID_ARGUMENT here, before the writer lock is taken. (Which paths may be read at all is
 * the MCP adapter's decision: GCR_APPROVED_IMPORT_ROOTS; this layer reads exactly what it is told to.)
 */
function assertImportSource(source: unknown): void {
  if (typeof source !== 'object' || source === null) throw invalidArgument('source', 'expected { kind: "path", path } or { kind: "stream", stream, label }');
  const s = source as { kind?: unknown; path?: unknown; stream?: unknown; label?: unknown };
  if (s.kind === 'path') {
    if (typeof s.path !== 'string' || s.path === '' || s.path.includes('\0')) throw invalidArgument('source.path', 'expected a non-empty path string without NUL bytes');
    return;
  }
  if (s.kind === 'stream') {
    const iterable = typeof s.stream === 'object' && s.stream !== null && Symbol.asyncIterator in s.stream;
    if (!iterable || typeof s.label !== 'string') throw invalidArgument('source.stream', 'expected an async iterable of bytes and a string label');
    return;
  }
  throw invalidArgument('source.kind', 'expected "path" or "stream"');
}

interface Anchor {
  provider: string;
  accountLabel: string;
  conversationId: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Gcr
// ---------------------------------------------------------------------------------------------------------------

export class Gcr {
  private readonly handle: GcrDatabase;
  private readonly dbPath: string;
  private readonly repo: Repository;
  private readonly store: LocalStore;
  private readonly clock: () => string;
  private readonly actorName: LocalActor;
  /** FormatProfiles observed by imports made through this handle (the database does not store them). */
  private readonly profiles = new Map<string, FormatProfile>();
  private closed = false;
  /** Tail of the writer-lock chain: every mutator runs after the previous one has settled. */
  private writeTail: Promise<void> = Promise.resolve();
  /** true only while a mutator's body is executing (see "While a mutator is RUNNING" in the file header). */
  private writing = false;

  private constructor(handle: GcrDatabase, dbPath: string, actor: LocalActor, clock: () => string) {
    this.handle = handle;
    this.dbPath = dbPath;
    this.actorName = actor;
    this.clock = clock;
    this.repo = new Repository(handle.db);
    this.store = new LocalStore(handle.db, { readOnly: handle.readOnly, clock, actor });
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  /**
   * Open a database. Synchronous. `readOnly` never creates or migrates: a missing file is DB_NOT_FOUND with the remedy to
   * run `gcr import`; a file written by a newer tool is DB_SCHEMA_TOO_NEW and is left untouched.
   */
  static open(opts: GcrOpenOptions): Gcr {
    try {
      const o = checkKeys('options', opts, OPEN_KEYS);
      const dbPath = o['dbPath'];
      if (typeof dbPath !== 'string') throw invalidArgument('dbPath', 'expected a database file path (or ":memory:")');
      const readOnly = optBool('readOnly', o['readOnly']) === true;
      const create = optBool('create', o['create']);
      if (readOnly && create === true) throw invalidArgument('create', 'a read-only handle never creates the database file');
      const actor = optEnum<LocalActor>('actor', o['actor'], ACTORS) ?? 'sdk';
      const clockOpt = o['clock'];
      if (clockOpt !== undefined && typeof clockOpt !== 'function') throw invalidArgument('clock', 'expected a function');
      const clock = (clockOpt as (() => string) | undefined) ?? ((): string => new Date().toISOString());

      let handle: GcrDatabase;
      try {
        handle = openDatabase(dbPath, { readOnly, ...(create === undefined ? {} : { create }) });
      } catch (e) {
        // A missing database file is the one "open" failure whose fix is a Gcr command, so it always says which.
        if (e instanceof GcrError && e.code === 'DB_NOT_FOUND' && !/parent directory/i.test(e.remedy ?? '') && !/gcr import/.test(e.remedy ?? '')) {
          throw new GcrError('DB_NOT_FOUND', e.message, {
            remedy: 'No database exists at this path. Create one by importing your official export: gcr import <export.zip> --db <path>. A read-only handle never creates a database.',
            ...(e.details === undefined ? {} : { details: e.details }),
          });
        }
        throw e;
      }
      try {
        return new Gcr(handle, dbPath, actor, clock);
      } catch (e) {
        closeDatabase(handle);
        throw e;
      }
    } catch (e) {
      throw normalizeError(e);
    }
  }

  /** The offline self-check without a handle (use it when the database may not exist or may be unusable). */
  static doctor(opts: DoctorOptions = {}): DoctorReport {
    return runDoctor(opts);
  }

  /** Close the connection. Idempotent. A mutator that is still running finishes first; queued mutators are rejected. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.writing) this.closeHandle(false);
  }

  private closeHandle(quiet: boolean): void {
    try {
      closeDatabase(this.handle);
    } catch (e) {
      if (!quiet) throw normalizeError(e);
      log.warn('close_failed');
    }
  }

  get isOpen(): boolean {
    return !this.closed;
  }
  get readOnly(): boolean {
    return this.handle.readOnly;
  }
  /** Basename of the database file (or ":memory:"). Safe to print. */
  get dbLabel(): string {
    return this.handle.label;
  }
  get actor(): LocalActor {
    return this.actorName;
  }

  /** Doctor report for this handle's database (basename only). Unlike every other method it opens nothing else. */
  doctor(): DoctorReport {
    this.assertOpen();
    return runDoctor({ dbPath: this.dbPath });
  }

  // ------------------------------------------------------------------------------------------- plumbing

  private assertOpen(): void {
    if (this.closed) throw closedError();
  }

  /** Synchronous read wrapper: open check, no-uncommitted-data guard, error normalization. */
  private read<T>(fn: () => T): T {
    this.assertOpen();
    if (this.writing) throw writeInProgressError();
    try {
      return fn();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  /**
   * The writer lock. `fn` runs after every earlier mutator has settled (success or failure), and `writing` is true only
   * while it executes. A synchronous `fn` never yields before the flag is cleared, so a read cannot observe the flag
   * between its last statement and the end of the lock. Rejections are normalized.
   */
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(closedError());
    const run = this.writeTail.then(async (): Promise<T> => {
      if (this.closed) throw closedError();
      this.writing = true;
      try {
        const result = fn();
        return isPromiseLike(result) ? ((await result) as T) : result;
      } catch (e) {
        throw normalizeError(e);
      } finally {
        this.writing = false;
        // close() while this ran: the handle could not be closed under the running write, so do it now.
        if (this.closed) this.closeHandle(true);
      }
    });
    this.writeTail = run.then(noop, noop);
    return run;
  }

  private assertWritableHandle(): void {
    this.assertOpen();
    if (this.handle.readOnly) throw writeForbiddenError();
  }

  private get db(): DatabaseSync {
    return this.handle.db;
  }

  private readonly lookupBatch: BatchLookup = (batchId) => this.repo.getBatch(batchId);

  private envelope<T>(parts: EnvelopeParts<T>): ResultEnvelope<T> {
    return buildEnvelope(this.lookupBatch, parts);
  }

  // ------------------------------------------------------------------------------------------- provenance queries

  /** Completeness of one stored conversation snapshot (the column is authoritative; damaged values count as unknown). */
  private conversationCompleteness(provider: string, accountLabel: string, conversationId: string, batchId: string): Completeness {
    const row = this.db
      .prepare('SELECT completeness FROM conversations WHERE provider = ? AND account_label = ? AND conversation_id = ? AND source_batch = ?')
      .get(provider, accountLabel, conversationId, batchId);
    return row === undefined ? 'unknown' : normalizeCompleteness(rowStr(row, 'completeness'));
  }

  /** Distinct (batch, completeness) pairs of the conversations in a scope: newest snapshots, or every snapshot with allBatches. */
  private scopeContributions(scope: { provider?: string | undefined; accountLabel?: string | undefined; allBatches?: boolean | undefined }): Contribution[] {
    // Fixed fragments only; every value is a bound parameter.
    let sql = 'SELECT DISTINCT c.source_batch AS source_batch, c.completeness AS completeness FROM conversations c ';
    if (scope.allBatches !== true) sql += HEAD_JOIN_C;
    sql += 'WHERE 1 = 1 ';
    const params: SQLInputValue[] = [];
    if (scope.provider !== undefined) {
      sql += 'AND c.provider = ? ';
      params.push(scope.provider);
    }
    if (scope.accountLabel !== undefined) {
      sql += 'AND c.account_label = ? ';
      params.push(scope.accountLabel);
    }
    sql += 'ORDER BY c.source_batch ASC, c.completeness ASC';
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => ({ batchId: rowStr(r, 'source_batch'), completeness: normalizeCompleteness(rowStr(r, 'completeness')) }));
  }

  /** Newest snapshot (batch, completeness) of each named conversation that is still stored. */
  private anchorContributions(anchors: readonly Anchor[]): Contribution[] {
    const stmt = this.db.prepare(
      'SELECT c.source_batch AS source_batch, c.completeness AS completeness FROM conversation_heads h ' +
        'JOIN conversations c ON c.provider = h.provider AND c.account_label = h.account_label AND c.conversation_id = h.conversation_id AND c.source_batch = h.source_batch ' +
        'WHERE h.provider = ? AND h.account_label = ? AND h.conversation_id = ?',
    );
    const seen = new Set<string>();
    const out: Contribution[] = [];
    for (const a of anchors) {
      const key = `${a.provider}\0${a.accountLabel}\0${a.conversationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = stmt.get(a.provider, a.accountLabel, a.conversationId);
      if (row !== undefined) out.push({ batchId: rowStr(row, 'source_batch'), completeness: normalizeCompleteness(rowStr(row, 'completeness')) });
    }
    return out;
  }

  /**
   * The conversations the derived graph describes: its conversation nodes, resolved to their newest snapshot. The graph
   * has no stored build scope, so the nodes it actually contains ARE the scope (a graph built for one provider does not
   * drag the other provider's completeness into the envelope).
   */
  private graphContributions(): Contribution[] {
    const nodeIds = new Set<string>();
    for (const r of this.db.prepare("SELECT node_id FROM graph_nodes WHERE kind = 'conversation'").iterate()) nodeIds.add(rowStr(r, 'node_id'));
    if (nodeIds.size === 0) return [];
    const seen = new Set<string>();
    const out: Contribution[] = [];
    const heads = this.db.prepare(
      'SELECT c.provider AS provider, c.account_label AS account_label, c.conversation_id AS conversation_id, c.source_batch AS source_batch, c.completeness AS completeness ' +
        'FROM conversation_heads h JOIN conversations c ON c.provider = h.provider AND c.account_label = h.account_label ' +
        'AND c.conversation_id = h.conversation_id AND c.source_batch = h.source_batch',
    );
    for (const r of heads.iterate()) {
      if (!nodeIds.has(conversationNodeId(rowStr(r, 'provider'), rowStr(r, 'account_label'), rowStr(r, 'conversation_id')))) continue;
      const c: Contribution = { batchId: rowStr(r, 'source_batch'), completeness: normalizeCompleteness(rowStr(r, 'completeness')) };
      const key = `${c.batchId}\0${c.completeness}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  private formatProfilesFor(contributions: readonly Contribution[]): BatchFormatProfile[] {
    const out: BatchFormatProfile[] = [];
    for (const batchId of uniq(contributions.map((c) => c.batchId)).sort()) {
      const formatProfile = this.profiles.get(batchId);
      if (formatProfile !== undefined) out.push({ batchId, formatProfile });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------- import (mutators)

  /**
   * Import an official export (ZIP, conversations.json, shards, directory or stream) as ONE atomic, idempotent batch.
   * Rejects with WRITE_FORBIDDEN on a read-only handle. Serialized with every other mutator of this handle.
   * The envelope's completeness is the imported conversations' own (a Claude export is "rendered_active_view_only").
   */
  async importExport(opts: ImportOptions): Promise<ResultEnvelope<ImportReport>> {
    this.assertWritableHandle();
    const o = checkKeys('options', opts, IMPORT_KEYS);
    assertImportSource(o['source']);
    return this.exclusive(async () => {
      const report = await runImport(this.repo, { ...opts, clock: opts.clock ?? this.clock });
      return this.importEnvelope(report);
    });
  }

  /**
   * Index a manual copy (Mode B): a small JSON document of messages the user copied themselves. The result is always
   * "partial_user_supplied" and says so (SOURCE_NOT_FULL_HISTORY), because only the copied messages exist.
   */
  async importManualCopy(text: string, opts: ManualCopyOptions = {}): Promise<ResultEnvelope<ImportReport>> {
    this.assertWritableHandle();
    if (typeof text !== 'string') throw invalidArgument('text', 'expected the manual-copy JSON document as a string');
    const o = checkKeys('options', opts, MANUAL_COPY_KEYS);
    return this.exclusive(async () => {
      const report = await runManualCopyImport(this.repo, {
        text,
        ...(o['accountLabel'] === undefined ? {} : { accountLabel: o['accountLabel'] as string }),
        ...(o['sourceLabel'] === undefined ? {} : { sourceLabel: o['sourceLabel'] as string }),
        clock: (o['clock'] as (() => string) | undefined) ?? this.clock,
      });
      return this.importEnvelope(report);
    });
  }

  private importEnvelope(report: ImportReport): ResultEnvelope<ImportReport> {
    if (report.formatProfile !== undefined && !report.alreadyImported) this.profiles.set(report.batchId, report.formatProfile);
    const batch = this.repo.getBatch(report.batchId);
    const contributions: Contribution[] = this.db
      .prepare('SELECT DISTINCT completeness FROM conversations WHERE source_batch = ? ORDER BY completeness ASC')
      .all(report.batchId)
      .map((r) => ({ batchId: report.batchId, completeness: normalizeCompleteness(rowStr(r, 'completeness')) }));
    // The batch row keeps the full warning texts; the report only has per-code summaries.
    const warnings: Warning[] =
      batch !== null
        ? batch.warnings
        : report.warnings.map((w) => ({ code: w.code, message: `${w.count} occurrence(s) were recorded during the import.`, ids: w.sampleIds }));
    return this.envelope({ data: report, contributions, extraBatchIds: [report.batchId], warnings });
  }

  // ------------------------------------------------------------------------------------------- list / get / branches / thread

  /** Conversations (newest snapshot of each, or every snapshot with `allBatches`). */
  list(opts: ListOptions = {}): ResultEnvelope<Page<ConversationSummary>> {
    return this.read(() => {
      const o = checkKeys('options', opts, LIST_KEYS);
      const a = optBool('allBatches', o['allBatches']);
      const b = optBool('includeAllBatches', o['includeAllBatches']);
      if (a !== undefined && b !== undefined && a !== b) throw invalidArgument('allBatches', 'conflicts with includeAllBatches');
      const all = a ?? b;
      const page = this.repo.listConversations({
        ...pickDefined(o, ['provider', 'accountLabel', 'titleQuery', 'sort', 'limit', 'offset']),
        ...(all === undefined ? {} : { includeAllBatches: all }),
      } as ListConversationsOptions);
      return this.envelope({
        data: page,
        contributions: page.items.map((s) => ({ batchId: s.batchId, completeness: normalizeCompleteness(s.completeness) })),
        ids: { conversationIds: page.items.map((s) => s.conversationId) },
      });
    });
  }

  private parseThreadOptions(o: Record<string, unknown>): {
    branch: string | undefined;
    branchPolicy: BranchPolicy | undefined;
    includeHidden: boolean;
    includeRaw: boolean;
    batchId: string | undefined;
  } {
    return {
      branch: optString('branch', o['branch']),
      branchPolicy: optEnum<BranchPolicy>('branchPolicy', o['branchPolicy'], BRANCH_POLICIES),
      includeHidden: optBool('includeHidden', o['includeHidden']) === true,
      includeRaw: optBool('includeRaw', o['includeRaw']) === true,
      batchId: optString('batchId', o['batchId']),
    };
  }

  /** Resolve a reference, load the pinned snapshot and analyse its tree once. */
  private loadConversation(refInput: unknown, batchId: string | undefined): { summary: ConversationSummary; record: ConversationRecord; analysis: TreeAnalysis } {
    const ref = withBatchPin(normalizeRef('ref', refInput), batchId);
    const summary = resolveSummary(this.repo, ref);
    // Pin the exact snapshot that was resolved, so a concurrent newer import can never swap the tree under us.
    const record = this.repo.getConversation({ conversationId: summary.conversationId, provider: summary.provider, accountLabel: summary.accountLabel, batchId: summary.batchId });
    if (record === null) throw new GcrError('NOT_IN_LOCAL_EXPORT', 'The conversation disappeared while it was being read.', { details: { conversationId: summary.conversationId } });
    const analysis = analyzeTree(record.id, record.messages, record.currentNodeId);
    return { summary, record, analysis };
  }

  /**
   * One conversation and its primary thread. `ref` is a bare UUID, an exact https://chatgpt.com/c/<uuid> link or a
   * ConversationRef. NOT_IN_LOCAL_EXPORT when the id is not in the imported data (never guessed, never fetched);
   * AMBIGUOUS_CONVERSATION when several provider/account pairs hold it. See the file header for branch precedence.
   */
  get(ref: string | ConversationRef, opts: GetOptions = {}): ResultEnvelope<GetResult> {
    return this.read(() => {
      const o = checkKeys('options', opts, GET_KEYS);
      const sel = this.parseThreadOptions(o);
      const allBranches = optBool('allBranches', o['allBranches']) === true;
      const { summary, record, analysis } = this.loadConversation(ref, sel.batchId);

      // A snapshot with no messages at all has nothing to select: get() then returns the conversation with thread null.
      const nothingToSelect = analysis.branches.length === 0 && sel.branch === undefined;
      const primary = nothingToSelect
        ? null
        : selectPrimary({ summary, analysis, messages: record.messages, branch: sel.branch, branchPolicy: sel.branchPolicy, required: !allBranches });
      const supersedes = primary === null ? [] : primary.supersedes;
      const shared = mergeWarnings(
        analysis.warnings.filter((w) => !supersedes.includes(w.code)),
        storedWarnings(record, analysis, supersedes),
      );
      const ctx: ThreadContext = { summary, byId: new Map(record.messages.map((m) => [m.id, m])), includeHidden: sel.includeHidden, includeRaw: sel.includeRaw, views: new Map() };

      const extra: Warning[] = [];
      let thread: ThreadResult | null = null;
      if (primary !== null) {
        thread = makeThread(ctx, {
          branchId: primary.branch.branchId,
          path: primary.path,
          activeness: primary.activeness,
          policy: primary.policy,
          warnings: mergeWarnings(primary.warnings, shared),
        });
      } else if (analysis.branches.length === 0) {
        extra.push({ code: 'NO_BRANCHES', message: 'The stored message tree of this snapshot is empty: there is no thread to show.', ids: [summary.conversationId] });
      } else {
        // Only reachable with allBranches: say plainly why `thread` is null instead of leaving it to be guessed.
        extra.push({
          code: 'ACTIVE_BRANCH_UNKNOWN',
          message: `The source did not identify the active branch; thread is null and all ${analysis.branches.length} branches are listed in threads. Nothing was guessed.`,
          ids: [summary.conversationId],
        });
      }
      const data: GetResult = { conversation: summary, thread };
      let threads: ThreadResult[] | undefined;
      if (allBranches) {
        threads = analysis.branches.map((b) =>
          makeThread(ctx, {
            branchId: b.branchId,
            path: b.path,
            activeness: b.activeness,
            policy: 'explicit_branch',
            warnings: primary !== null && primary.branch.branchId === b.branchId ? primary.warnings : [],
          }),
        );
        data.threads = threads;
      }
      const shown = threads ?? (thread === null ? [] : [thread]);
      return this.envelope({
        data,
        contributions: [{ batchId: summary.batchId, completeness: summary.completeness }],
        warnings: mergeWarnings(thread?.warnings, extra, shared),
        ids: {
          conversationIds: [summary.conversationId],
          messageIds: [...(thread?.messages ?? []), ...shown.flatMap((t) => t.messages)].map((m) => m.id),
          branchIds: [...(thread === null ? [] : [thread.branchId]), ...shown.map((t) => t.branchId)],
        },
      });
    });
  }

  /**
   * `get` for callers that hold a link: ONLY an exact https://chatgpt.com/c/<uuid> URL is accepted (a bare UUID is
   * INVALID_URL here; use `get`). The link is a lookup key into the local database, never opened.
   */
  getByUrl(url: string, opts: GetOptions = {}): ResultEnvelope<GetResult> {
    return this.read(() => {
      if (typeof url !== 'string') throw invalidArgument('url', 'expected an https://chatgpt.com/c/<uuid> link');
      const { conversationId } = parseChatGptUrl(url);
      return this.get({ conversationId, provider: 'chatgpt' }, opts);
    });
  }

  /** Every branch (root -> leaf path) of a conversation with its activeness, plus the tree warnings. */
  branches(ref: string | ConversationRef, opts: BranchesOptions = {}): ResultEnvelope<BranchListResult> {
    return this.read(() => {
      const o = checkKeys('options', opts, BRANCHES_KEYS);
      const { summary, record, analysis } = this.loadConversation(ref, optString('batchId', o['batchId']));
      const data: BranchListResult = { conversation: summary, activeBranchId: analysis.activeBranchId, branches: analysis.branches, warnings: analysis.warnings };
      return this.envelope({
        data,
        contributions: [{ batchId: summary.batchId, completeness: summary.completeness }],
        warnings: mergeWarnings(analysis.warnings, storedWarnings(record, analysis, [])),
        ids: { conversationIds: [summary.conversationId], branchIds: analysis.branches.map((b) => b.branchId) },
      });
    });
  }

  /** One thread, chosen by the documented precedence. ACTIVE_BRANCH_UNKNOWN when it cannot be chosen without guessing. */
  thread(ref: string | ConversationRef, opts: ThreadOptions = {}): ResultEnvelope<ThreadResult> {
    return this.read(() => {
      const o = checkKeys('options', opts, THREAD_KEYS);
      const sel = this.parseThreadOptions(o);
      const { summary, record, analysis } = this.loadConversation(ref, sel.batchId);
      const primary = selectPrimary({ summary, analysis, messages: record.messages, branch: sel.branch, branchPolicy: sel.branchPolicy, required: true });
      if (primary === null) throw activeBranchUnknown(summary, analysis); // unreachable with required: true; keeps the type honest
      const shared = mergeWarnings(
        analysis.warnings.filter((w) => !primary.supersedes.includes(w.code)),
        storedWarnings(record, analysis, primary.supersedes),
      );
      const ctx: ThreadContext = { summary, byId: new Map(record.messages.map((m) => [m.id, m])), includeHidden: sel.includeHidden, includeRaw: sel.includeRaw, views: new Map() };
      const thread = makeThread(ctx, {
        branchId: primary.branch.branchId,
        path: primary.path,
        activeness: primary.activeness,
        policy: primary.policy,
        warnings: mergeWarnings(primary.warnings, shared),
      });
      return this.envelope({
        data: thread,
        contributions: [{ batchId: summary.batchId, completeness: summary.completeness }],
        warnings: thread.warnings,
        ids: { conversationIds: [summary.conversationId], messageIds: thread.messages.map((m) => m.id), branchIds: [thread.branchId] },
      });
    });
  }

  // ------------------------------------------------------------------------------------------- search

  /**
   * Full-text search. Scope "messages" (default) returns message hits; "titles" returns conversations whose title matched;
   * "all" lists every title hit first and then the message hits (the two rankings are not comparable, so they are not
   * interleaved). Every item carries `kind` so a client can tell which is which.
   */
  search(opts: SearchOptions & { scope?: 'messages' }): ResultEnvelope<Page<MessageSearchItem>>;
  search(opts: SearchOptions): ResultEnvelope<Page<SearchItem>>;
  search(opts: SearchOptions): ResultEnvelope<Page<SearchItem>> {
    return this.read(() => {
      const o = checkKeys('options', opts, SEARCH_KEYS);
      const scope = optEnum<SearchScope>('scope', o['scope'], SEARCH_SCOPES) ?? 'messages';
      const mode = optEnum<SearchMode>('mode', o['mode'], SEARCH_MODES);
      const conversationId = conversationFilter(o['conversationId']);
      const includeHidden = optBool('includeHidden', o['includeHidden']);
      if (scope !== 'messages') {
        for (const k of MESSAGE_ONLY_FILTERS) {
          if (o[k] !== undefined) throw invalidArgument(k, `applies to message hits only and cannot be combined with scope "${scope}"`, { scope });
        }
        if (includeHidden === true) throw invalidArgument('includeHidden', `applies to message hits only and cannot be combined with scope "${scope}"`, { scope });
      }
      const base: Record<string, unknown> = {
        ...pickDefined(o, ['query', 'provider', 'accountLabel', 'allBatches']),
        ...(mode === undefined ? {} : { mode }),
      };

      let page: Page<SearchItem>;
      let contributions: Contribution[];
      if (scope === 'messages') {
        const hits = searchMessages(this.db, {
          ...base,
          ...pickDefined(o, ['role', 'channel', 'hasModel', 'createdAfter', 'createdBefore', 'limit', 'offset', 'cursor']),
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(includeHidden === undefined ? {} : { includeHidden }),
        } as unknown as SearchQuery);
        page = { ...hits, items: hits.items.map((h): SearchItem => ({ kind: 'message', ...h })) };
        contributions = this.messageHitContributions(hits.items);
      } else if (scope === 'titles') {
        const hits = searchConversationTitles(this.db, { ...base, ...pickDefined(o, ['limit', 'offset']) } as unknown as Parameters<typeof searchConversationTitles>[1]);
        page = { ...hits, items: hits.items.map((h): SearchItem => ({ kind: 'title', ...h })) };
        contributions = hits.items.map((h) => ({ batchId: h.batchId, completeness: normalizeCompleteness(h.completeness) }));
      } else {
        const limit = optInt('limit', o['limit'], 1, SEARCH_LIMIT_MAX) ?? 20;
        const offset = optInt('offset', o['offset'], 0, MAX_ALL_SCOPE_WINDOW) ?? 0;
        page = this.searchAll(base, limit, offset);
        contributions = [
          ...page.items.filter((i): i is TitleSearchItem => i.kind === 'title').map((h) => ({ batchId: h.batchId, completeness: normalizeCompleteness(h.completeness) })),
          ...this.messageHitContributions(page.items.filter((i): i is MessageSearchItem => i.kind === 'message')),
        ];
      }
      const warnings: Warning[] =
        o['allBatches'] === true
          ? [{ code: 'SUPERSEDED_SNAPSHOTS_INCLUDED', message: 'Superseded import snapshots were searched too: the same message can appear once per snapshot.' }]
          : [];
      return this.envelope({
        data: page,
        contributions,
        warnings,
        ids: {
          conversationIds: page.items.map((i) => i.conversationId),
          messageIds: page.items.filter((i): i is MessageSearchItem => i.kind === 'message').map((i) => i.messageId),
        },
      });
    });
  }

  private messageHitContributions(hits: readonly SearchHit[]): Contribution[] {
    const cache = new Map<string, Completeness>();
    return hits.map((h) => {
      const key = `${h.provider}\0${h.accountLabel}\0${h.conversationId}\0${h.batchId}`;
      let completeness = cache.get(key);
      if (completeness === undefined) {
        completeness = this.conversationCompleteness(h.provider, h.accountLabel, h.conversationId, h.batchId);
        cache.set(key, completeness);
      }
      return { batchId: h.batchId, completeness };
    });
  }

  /** Scope "all": title hits first (exact count found by paging the title stream), then message hits. */
  private searchAll(base: Record<string, unknown>, limit: number, offset: number): Page<SearchItem> {
    const window = offset + limit;
    if (window > MAX_ALL_SCOPE_WINDOW) {
      throw invalidArgument('offset', `offset + limit may not exceed ${MAX_ALL_SCOPE_WINDOW} with scope "all"`, { scope: 'all' });
    }
    const titleHits: TitleHit[] = [];
    let titlesExhausted = false;
    while (titleHits.length < window) {
      const pageSize = Math.min(SEARCH_LIMIT_MAX, window - titleHits.length);
      const p = searchConversationTitles(this.db, { ...base, limit: pageSize, offset: titleHits.length } as unknown as Parameters<typeof searchConversationTitles>[1]);
      titleHits.push(...p.items);
      if (p.nextOffset === null) {
        titlesExhausted = true;
        break;
      }
    }
    const items: SearchItem[] = titleHits.slice(offset, window).map((h): SearchItem => ({ kind: 'title', ...h }));
    let moreMessages = false;
    if (titlesExhausted) {
      const want = limit - items.length;
      if (want > 0) {
        // Messages start where the titles end; skip as many of them as the requested offset reaches past the titles.
        const skip = Math.max(0, offset - titleHits.length);
        const hits = searchMessages(this.db, { ...base, limit: want, offset: skip } as unknown as SearchQuery);
        items.push(...hits.items.map((h): SearchItem => ({ kind: 'message', ...h })));
        moreMessages = hits.nextOffset !== null;
      } else {
        // The page is full of titles and the titles ended exactly here: are there messages after them?
        moreMessages = searchMessages(this.db, { ...base, limit: 1, offset: 0 } as unknown as SearchQuery).items.length > 0;
      }
    }
    const more = !titlesExhausted || moreMessages;
    return { items, limit, offset, nextOffset: more ? offset + items.length : null, nextCursor: null };
  }

  // ------------------------------------------------------------------------------------------- stats / audit / batches

  /** Message statistics by role, model, channel, day, conversation, provider or content type (src/analysis/stats.ts). */
  stats(opts: StatsOptions): ResultEnvelope<StatsReport> {
    return this.read(() => {
      const result = computeStats(this.db, opts);
      const contributions = this.scopeContributions({ provider: opts.provider, accountLabel: opts.accountLabel, allBatches: opts.allBatches });
      // Grouping by day or provider yields only dates/provider ids; every other grouping returns imported strings (roles, models, titles).
      const untrusted = (result.groupBy !== 'day' && result.groupBy !== 'provider') || warningsCarryIds(result.warnings);
      return this.envelope({
        data: { ...result, formatProfiles: this.formatProfilesFor(contributions) },
        contributions,
        warnings: result.warnings,
        untrustedContent: untrusted,
      });
    });
  }

  /** Data-quality and provenance audit (src/analysis/audit.ts): counts and ids only, never message text. */
  audit(opts: AuditOptions = {}): ResultEnvelope<AuditReport> {
    return this.read(() => {
      const result = runAudit(this.db, opts);
      const contributions = this.scopeContributions({ provider: opts.provider, accountLabel: opts.accountLabel, allBatches: opts.allBatches });
      return this.envelope({
        data: { ...result, formatProfiles: this.formatProfilesFor(contributions) },
        contributions,
        warnings: result.warnings,
        ids: { conversationIds: result.findings.flatMap((f) => f.sampleConversationIds), messageIds: result.findings.flatMap((f) => f.sampleMessageIds) },
      });
    });
  }

  /** Every import batch in import order. A plain list (it is metadata about the database, not conversation data). */
  listBatches(): BatchInfo[] {
    return this.read(() => this.repo.listBatches());
  }

  // ------------------------------------------------------------------------------------------- graph

  /** Rebuild the derived graph tables (a write to derived tables only; imported data is never touched). */
  async buildGraph(opts: BuildGraphOptions = {}): Promise<ResultEnvelope<BuildGraphResult>> {
    this.assertWritableHandle();
    return this.exclusive(() => {
      const result = buildGraphImpl(this.db, opts);
      return this.envelope({ data: result, contributions: this.graphContributions(), warnings: result.warnings, untrustedContent: warningsCarryIds(result.warnings) });
    });
  }

  private graphEnvelope<T>(data: T, nodes: readonly GraphNodeDto[], warnings: readonly Warning[]): ResultEnvelope<T> {
    return this.envelope({
      data,
      contributions: this.graphContributions(),
      warnings,
      ids: { conversationIds: nodes.flatMap((n) => (n.conversation === null ? [] : [n.conversation.conversationId])) },
    });
  }

  /** Breadth-first neighbourhood of every graph node matching `term`. */
  graphQuery(q: GraphQueryInput): ResultEnvelope<GraphQueryResult> {
    return this.read(() => {
      const r = graphQueryImpl(this.db, q);
      return this.graphEnvelope(r, r.nodes, r.warnings);
    });
  }

  /** Fewest-hop path between two node ids. Unknown ids are NOT_IN_LOCAL_EXPORT (graph nodes, not conversations). */
  graphPath(from: string, to: string, opts: ShortestPathOptions = {}): ResultEnvelope<PathResult> {
    return this.read(() => {
      const r = shortestPath(this.db, from, to, opts);
      const warnings: Warning[] =
        !r.found && r.truncated ? [{ code: 'PATH_SEARCH_TRUNCATED', message: 'The search budget was exhausted: "not found" means not found within the budget, not that no path exists.' }] : [];
      return this.graphEnvelope(r, r.path, warnings);
    });
  }

  graphNeighbors(nodeId: string, opts: NeighborsOptions = {}): ResultEnvelope<NeighborsResult> {
    return this.read(() => {
      const r = neighborsImpl(this.db, nodeId, opts);
      const warnings: Warning[] = r.truncated ? [{ code: 'NEIGHBORS_TRUNCATED', message: `Only ${r.neighbors.length} of ${r.total} neighbours are listed.` }] : [];
      return this.graphEnvelope(r, [r.node, ...r.neighbors.map((n) => n.node)], warnings);
    });
  }

  /** Most connected nodes (weighted degree). */
  graphGodNodes(opts: GodNodesOptions = {}): ResultEnvelope<GodNode[]> {
    return this.read(() => {
      const r = godNodes(this.db, opts);
      return this.graphEnvelope(
        r,
        r.map((g) => g.node),
        [],
      );
    });
  }

  /**
   * The evidence behind one edge: every cited (conversation, message, batch) with the ids of the branches whose path
   * contains the message. Provenance is taken from the cited snapshots themselves.
   */
  graphExplain(ref: EdgeRef, opts: ExplainEdgeOptions = {}): ResultEnvelope<ExplainEdgeResult> {
    return this.read(() => {
      const r = explainEdge(this.db, ref, opts);
      const cache = new Map<string, Completeness>();
      const contributions = r.evidence.map((e) => {
        const key = `${e.provider}\0${e.accountLabel}\0${e.conversationId}\0${e.batchId}`;
        let completeness = cache.get(key);
        if (completeness === undefined) {
          completeness = this.conversationCompleteness(e.provider, e.accountLabel, e.conversationId, e.batchId);
          cache.set(key, completeness);
        }
        return { batchId: e.batchId, completeness };
      });
      return this.envelope({
        data: r,
        contributions,
        warnings: r.warnings,
        ids: {
          conversationIds: r.evidence.map((e) => e.conversationId),
          messageIds: r.evidence.flatMap((e) => (e.messageId === null ? [] : [e.messageId])),
          branchIds: r.evidence.flatMap((e) => e.branchIds),
        },
      });
    });
  }

  /**
   * One self-contained, offline HTML page of a graph neighbourhood (`term`) or of the most connected nodes. Returned as a
   * string: the SDK writes no files. Escaping is the graph module's job (labels live only in a JSON data block).
   */
  graphExportHtml(opts: GraphHtmlOptions = {}): GraphHtmlExport {
    return this.read(() => {
      const o = checkKeys('options', opts, GRAPH_HTML_KEYS);
      let nodes: GraphNodeDto[];
      let edges: GraphEdgeDto[];
      const warnings: Warning[] = [];
      if (o['term'] !== undefined) {
        const r = graphQueryImpl(this.db, pickDefined(o, ['term', 'depth', 'maxNodes', 'kinds']) as unknown as GraphQueryInput);
        nodes = r.nodes;
        edges = r.edges;
        warnings.push(...r.warnings);
      } else {
        if (o['depth'] !== undefined) throw invalidArgument('depth', 'applies to a term query only');
        const limit = optInt('maxNodes', o['maxNodes'], 1, MAX_OVERVIEW_NODES) ?? 100;
        nodes = godNodes(this.db, { limit, ...(o['kinds'] === undefined ? {} : { kinds: o['kinds'] as string[] }) }).map((g) => g.node);
        edges = this.edgesAmong(nodes.map((n) => n.id));
        if (nodes.length === 0) warnings.push({ code: 'GRAPH_EMPTY', message: 'The graph has no nodes. Import an export and build the graph first.' });
      }
      const html = exportGraphHtml({ nodes, edges }, pickDefined(o, ['title', 'layoutSeed', 'maxOverviewNodes']) as ExportHtmlOptions);
      const provenance = buildProvenance(this.lookupBatch, { contributions: this.graphContributions(), warnings, untrustedContent: true });
      return { html, nodes: nodes.length, edges: edges.length, ...provenance };
    });
  }

  /** Alias of `graphExportHtml` (the name used in docs/ARCHITECTURE.md section 8). */
  graphExport(opts: GraphHtmlOptions = {}): GraphHtmlExport {
    return this.graphExportHtml(opts);
  }

  /** Edges whose both ends are in `ids` (bound placeholders only; the id count is capped by MAX_OVERVIEW_NODES). */
  private edgesAmong(ids: readonly string[]): GraphEdgeDto[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT edge_id, src, dst, kind, weight FROM graph_edges WHERE src IN (${marks}) AND dst IN (${marks}) ORDER BY edge_id ASC`)
      .all(...ids, ...ids);
    return rows.map((r): GraphEdgeDto => {
      const kind = rowStr(r, 'kind');
      return {
        id: Number(r['edge_id']),
        src: rowStr(r, 'src'),
        dst: rowStr(r, 'dst'),
        kind: kind === 'mentioned_in' || kind === 'uses_tool' ? kind : 'co_occurs',
        weight: Number(r['weight']),
      };
    });
  }

  // ------------------------------------------------------------------------------------------- drafts and annotations

  private draftEnvelope<T>(data: T, anchors: readonly Anchor[], ids: { draftIds?: string[]; annotationIds?: string[]; messageIds?: string[] }): ResultEnvelope<T> {
    return this.envelope({
      data,
      contributions: this.anchorContributions(anchors),
      ids: { conversationIds: anchors.map((a) => a.conversationId), ...ids },
    });
  }

  /** Resolve a reference to the exact (provider, account) the local store must anchor to. Runs inside the writer lock. */
  private anchorRef(field: string, input: unknown): { ref: ConversationRef; summary: ConversationSummary } {
    const ref = normalizeRef(field, input);
    const summary = resolveSummary(this.repo, ref);
    return {
      summary,
      ref: { conversationId: summary.conversationId, provider: summary.provider, accountLabel: summary.accountLabel, ...(ref.batchId === undefined ? {} : { batchId: ref.batchId }) },
    };
  }

  /** A filter reference needs no stored conversation: it only narrows which local rows are listed. */
  private filterRef(field: string, input: unknown): ConversationRef {
    const ref = normalizeRef(field, input);
    const out: ConversationRef = { conversationId: ref.conversationId };
    if (ref.provider !== undefined) out.provider = ref.provider;
    if (ref.accountLabel !== undefined) out.accountLabel = ref.accountLabel;
    return out;
  }

  /**
   * Create a LOCAL draft anchored to a conversation (and optionally a message). It is stored in this database only; no
   * message is sent anywhere and GCR has no way to send one. Audited with this handle's actor.
   */
  async createDraft(input: CreateLocalDraftInput): Promise<ResultEnvelope<LocalDraftData>> {
    this.assertWritableHandle();
    const o = checkKeys('input', input, DRAFT_INPUT_KEYS);
    return this.exclusive(() => {
      const { ref } = this.anchorRef('conversationRef', o['conversationRef']);
      const draft = this.store.createDraft({ ...(o as unknown as CreateDraftInput), conversationRef: ref });
      return this.draftEnvelope<LocalDraftData>({ localOnly: true, draft }, [draft], {
        draftIds: [draft.draftId],
        messageIds: draft.anchorMessageId === null ? [] : [draft.anchorMessageId],
      });
    });
  }

  getDraft(id: string): ResultEnvelope<LocalDraftData> {
    return this.read(() => {
      const draft = this.store.getDraft(id);
      return this.draftEnvelope<LocalDraftData>({ localOnly: true, draft }, [draft], { draftIds: [draft.draftId] });
    });
  }

  listDrafts(filter: ListDraftsFilter = {}): ResultEnvelope<LocalDraftListData> {
    return this.read(() => {
      const f = checkKeys('filter', filter, DRAFT_FILTER_KEYS);
      const page = this.store.listDrafts({
        ...(f as unknown as DraftFilter),
        ...(f['conversationRef'] === undefined ? {} : { conversationRef: this.filterRef('conversationRef', f['conversationRef']) }),
      });
      return this.draftEnvelope<LocalDraftListData>({ localOnly: true, ...page }, page.items, { draftIds: page.items.map((d) => d.draftId) });
    });
  }

  /** Archive a draft (idempotent). There is deliberately no "sent" state. */
  async archiveDraft(id: string): Promise<ResultEnvelope<LocalDraftData>> {
    this.assertWritableHandle();
    return this.exclusive(() => {
      const draft = this.store.archiveDraft(id);
      return this.draftEnvelope<LocalDraftData>({ localOnly: true, draft }, [draft], { draftIds: [draft.draftId] });
    });
  }

  /** Markdown view of a draft (body in a fenced block longer than any backtick run inside it: the body cannot close it). */
  renderDraftMarkdown(id: string): ResultEnvelope<LocalDraftMarkdownData> {
    return this.read(() => {
      const draft = this.store.getDraft(id);
      const markdown = this.store.renderDraftMarkdown(id);
      return this.draftEnvelope<LocalDraftMarkdownData>({ localOnly: true, draftId: draft.draftId, markdown }, [draft], { draftIds: [draft.draftId] });
    });
  }

  async createAnnotation(input: CreateLocalAnnotationInput): Promise<ResultEnvelope<LocalAnnotationData>> {
    this.assertWritableHandle();
    const o = checkKeys('input', input, ANNOTATION_INPUT_KEYS);
    return this.exclusive(() => {
      const { ref } = this.anchorRef('conversationRef', o['conversationRef']);
      const annotation = this.store.createAnnotation({ ...(o as unknown as CreateAnnotationInput), conversationRef: ref });
      return this.draftEnvelope<LocalAnnotationData>({ localOnly: true, annotation }, [annotation], {
        annotationIds: [annotation.annotationId],
        messageIds: annotation.messageId === null ? [] : [annotation.messageId],
      });
    });
  }

  /** Optimistic concurrency: `patch.expectedVersion` must equal the stored version, else ANNOTATION_CONFLICT. */
  async updateAnnotation(id: string, patch: AnnotationPatch): Promise<ResultEnvelope<LocalAnnotationData>> {
    this.assertWritableHandle();
    return this.exclusive(() => {
      const annotation = this.store.updateAnnotation(id, patch);
      return this.draftEnvelope<LocalAnnotationData>({ localOnly: true, annotation }, [annotation], {
        annotationIds: [annotation.annotationId],
        messageIds: annotation.messageId === null ? [] : [annotation.messageId],
      });
    });
  }

  getAnnotation(id: string): ResultEnvelope<LocalAnnotationData> {
    return this.read(() => {
      const annotation = this.store.getAnnotation(id);
      return this.draftEnvelope<LocalAnnotationData>({ localOnly: true, annotation }, [annotation], { annotationIds: [annotation.annotationId] });
    });
  }

  listAnnotations(filter: ListAnnotationsFilter = {}): ResultEnvelope<LocalAnnotationListData> {
    return this.read(() => {
      const f = checkKeys('filter', filter, ANNOTATION_FILTER_KEYS);
      const page = this.store.listAnnotations({
        ...(f as unknown as AnnotationFilter),
        ...(f['conversationRef'] === undefined ? {} : { conversationRef: this.filterRef('conversationRef', f['conversationRef']) }),
      });
      return this.draftEnvelope<LocalAnnotationListData>({ localOnly: true, ...page }, page.items, { annotationIds: page.items.map((a) => a.annotationId) });
    });
  }
}
