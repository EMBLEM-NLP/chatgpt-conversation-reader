/**
 * Full-text search over imported messages and conversation titles (FR-05, ARCHITECTURE section 6).
 *
 * Security model
 *  - The query string is DATA. Every value reaches SQLite through a bound parameter (`?`). The SQL text is assembled
 *    only from fixed fragments chosen by code (never from user input), so there is no string-built SQL.
 *  - Plain mode (default) cannot express FTS5 syntax at all: the user's text is normalized and tokenized in JS, every
 *    token is emitted as a double-quoted FTS5 string (embedded quotes doubled), so operators, NEAR, column filters,
 *    parentheses, `-`, `^` and SQL fragments are inert words. Raw mode passes FTS5 syntax through on purpose; a
 *    syntax error becomes FTS_SYNTAX_ERROR with a fixed message (SQLite's text is never forwarded).
 *  - Snippets are plain text cut from the ORIGINAL message, with U+0001/U+0002 around matches. Those two control
 *    characters (and all other control/bidi characters) are removed from the source text first, so message content
 *    can neither forge a highlight nor smuggle terminal escapes; renderers translate the markers (never raw HTML).
 *
 * Ordering and pagination
 *  - Total order: rank ASC, created_at ASC (NULLs last), conversation_id, message_id, then provider, account_label and
 *    source_batch (the natural key is only unique with those three, e.g. under `allBatches`). Because the order is
 *    total, offset pagination and keyset (cursor) pagination return identical sequences with no repeat or skip, as long
 *    as the index does not change between page requests.
 *  - bm25 statistics are computed over the whole index, including superseded snapshots of a conversation.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { isIso8601Utc } from '../domain/validate.js';
import type { ConversationSummary, Page, SearchHit } from '../domain/results.js';
import type { Completeness, ConversationProvenance, Provider } from '../domain/types.js';
import { GcrError } from '../errors.js';
import { iterateSearchTokens, parsePlainQuery, prepareRawQuery, rawQueryTerms } from './cjk.js';
import type { QueryTerm, SearchToken } from './cjk.js';
import { sqliteErrcode, toDbError } from './open.js';

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 200;
/** Longest accepted query string (characters). Bounds the work an adversarial query can cause. */
export const MAX_QUERY_CHARS = 2000;
const MAX_QUERY_TERMS = 32;
const MAX_QUERY_TOKENS = 128;
const MAX_FILTER_CHARS = 512;
const MAX_OFFSET = 10_000_000;
const MAX_CURSOR_CHARS = 4096;

export const SNIPPET_MAX_CHARS = 160;
const SNIPPET_LEAD_CHARS = 40;
const SNIPPET_SCAN_SPAN = 640;
/**
 * Only the first SNIPPET_SOURCE_CHARS characters of a message are fetched for snippet building (SQL substr), so a page of
 * hits on enormous messages cannot exhaust memory. A match located only beyond that point still produces a hit; its
 * snippet then falls back to the start of the text without highlight.
 */
const SNIPPET_SOURCE_CHARS = 200_000;
const SNIPPET_SCAN_LIMIT = SNIPPET_SOURCE_CHARS;
const MARK_START = '\u0001';
const MARK_END = '\u0002';
const ELLIPSIS = '…';

export type SearchMode = 'plain' | 'raw';

export interface SearchQuery {
  query: string;
  /** 'plain' (default): safe, tokenized, implicit AND. 'raw': FTS5 syntax passed through. */
  mode?: SearchMode;
  provider?: string;
  accountLabel?: string;
  conversationId?: string;
  role?: string;
  channel?: string;
  /** true: only messages with an explicit model slug; false: only messages without one. */
  hasModel?: boolean;
  /** Inclusive lower bound on message created_at (ISO-8601 UTC). Messages without a timestamp never match a bound. */
  createdAfter?: string;
  /** EXCLUSIVE upper bound on message created_at (ISO-8601 UTC). */
  createdBefore?: string;
  includeHidden?: boolean;
  /** Search superseded snapshots too (default: only each conversation's head batch). */
  allBatches?: boolean;
  /** 1..200, default 20. */
  limit?: number;
  /** Offset pagination (mutually exclusive with `cursor`). */
  offset?: number;
  /**
   * Opaque keyset cursor from a previous page's `nextCursor`; must be used with the same query and filters (limit may
   * differ). In cursor mode `offset` stays 0 and `nextOffset` is always null: continue with `nextCursor`.
   */
  cursor?: string;
}

export interface TitleSearchQuery {
  query: string;
  mode?: SearchMode;
  provider?: string;
  accountLabel?: string;
  allBatches?: boolean;
  limit?: number;
  offset?: number;
}

/** A conversation whose TITLE matched. Offset pagination only (`nextCursor` is always null). */
export type TitleHit = ConversationSummary & { snippet: string; rank: number };

// ---------------------------------------------------------------------------------------------------------------
// Argument validation (never echoes the offending value: arguments may be hostile or private)
// ---------------------------------------------------------------------------------------------------------------

function badArg(field: string, why: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field } });
}

function optString(field: string, v: unknown, max = MAX_FILTER_CHARS): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badArg(field, 'expected a string');
  if (v.length > max) throw badArg(field, `longer than ${max} characters`);
  if (v.includes('\0')) throw badArg(field, 'contains a NUL byte');
  return v;
}

function optBool(field: string, v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw badArg(field, 'expected a boolean');
  return v;
}

function intArg(field: string, v: unknown, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badArg(field, `expected an integer from ${min} to ${max}`);
  return v;
}

function optIso(field: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!isIso8601Utc(v)) throw badArg(field, 'expected an ISO-8601 UTC timestamp like 2025-01-01T00:00:00Z');
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// Query compilation
// ---------------------------------------------------------------------------------------------------------------

export interface CompiledQuery {
  mode: SearchMode;
  /** The exact string bound to `MATCH ?`. */
  match: string;
  /** Terms used only to place highlights in snippets. */
  terms: QueryTerm[];
}

/**
 * Turn parsed plain-mode terms into an FTS5 expression. Every token is a quoted string; a multi-token term is a quoted
 * PHRASE; a trailing `*` after the closing quote is FTS5's prefix operator; terms are separated by a space (implicit AND).
 * Because tokens consist only of letters/digits/marks the quote-doubling is defense in depth, not a requirement.
 */
export function buildMatchExpression(terms: readonly QueryTerm[]): string {
  return terms
    .map((t) => {
      const phrase = `"${t.tokens.map((tok) => tok.replaceAll('"', '""')).join(' ')}"`;
      return t.prefix ? `${phrase}*` : phrase;
    })
    .join(' ');
}

/** Validate and compile a user query. Empty / punctuation-only queries are INVALID_ARGUMENT. */
export function compileQuery(query: unknown, mode: unknown): CompiledQuery {
  if (typeof query !== 'string') throw badArg('query', 'expected a string');
  if (query.length > MAX_QUERY_CHARS) throw badArg('query', `longer than ${MAX_QUERY_CHARS} characters`);
  if (query.includes('\0')) throw badArg('query', 'contains a NUL byte');
  if (mode !== undefined && mode !== 'plain' && mode !== 'raw') throw badArg('mode', "expected 'plain' or 'raw'");

  if (mode === 'raw') {
    const match = prepareRawQuery(query);
    if (match.trim() === '') throw badArg('query', 'the query is empty');
    return { mode: 'raw', match, terms: rawQueryTerms(query) };
  }
  const terms = parsePlainQuery(query);
  if (terms.length === 0) throw badArg('query', 'the query has no searchable terms (it is empty or only punctuation)');
  const tokenCount = terms.reduce((n, t) => n + t.tokens.length, 0);
  if (terms.length > MAX_QUERY_TERMS || tokenCount > MAX_QUERY_TOKENS) {
    throw badArg('query', `too many terms (limit ${MAX_QUERY_TERMS} terms / ${MAX_QUERY_TOKENS} tokens)`);
  }
  return { mode: 'plain', match: buildMatchExpression(terms), terms };
}

/**
 * Run an FTS query. In raw mode a generic SQLite error (SQLITE_ERROR) can only come from the user's FTS5 expression
 * (unbalanced quote, bad NEAR, unknown column filter, ...), because every other part of the statement is fixed and
 * covered by tests; it is mapped to FTS_SYNTAX_ERROR without forwarding SQLite's text. Everything else goes through
 * toDbError.
 */
function runFtsQuery<T>(mode: SearchMode, run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof GcrError) throw e;
    const code = sqliteErrcode(e);
    if (mode === 'raw' && code !== null && (code & 0xff) === 1) {
      throw new GcrError('FTS_SYNTAX_ERROR', 'The query is not valid FTS5 syntax.', {
        remedy: 'Use plain mode, or fix the raw FTS5 expression (quote phrases, balance parentheses, use AND/OR/NOT in upper case).',
        cause: e,
      });
    }
    throw toDbError(e);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Row mapping helpers (shared with repo.ts)
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

export function rowString(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

export function rowStringOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : typeof v === 'string' ? v : String(v);
}

export function rowNumber(row: Row, key: string): number {
  const v = row[key];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

/** SELECT list that `conversationSummaryFromRow` understands; `c` must be an alias of the conversations table. */
export const SUMMARY_COLUMNS =
  'c.provider AS provider, c.account_label AS account_label, c.conversation_id AS conversation_id, c.title AS title, ' +
  'c.created_at AS created_at, c.updated_at AS updated_at, c.message_count AS message_count, c.current_node_id AS current_node_id, ' +
  'c.default_model_slug AS default_model_slug, c.provenance AS provenance, c.completeness AS completeness, ' +
  'c.source_batch AS source_batch, c.imported_at AS imported_at';

export function conversationSummaryFromRow(row: Row): ConversationSummary {
  return {
    provider: rowString(row, 'provider') as Provider,
    accountLabel: rowString(row, 'account_label'),
    conversationId: rowString(row, 'conversation_id'),
    title: rowStringOrNull(row, 'title'),
    createdAt: rowStringOrNull(row, 'created_at'),
    updatedAt: rowStringOrNull(row, 'updated_at'),
    messageCount: rowNumber(row, 'message_count'),
    currentNodeId: rowStringOrNull(row, 'current_node_id'),
    defaultModelSlug: rowStringOrNull(row, 'default_model_slug'),
    provenance: rowString(row, 'provenance') as ConversationProvenance,
    completeness: rowString(row, 'completeness') as Completeness,
    batchId: rowString(row, 'source_batch'),
    importedAt: rowString(row, 'imported_at'),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------------------------------------------

interface Region {
  start: number;
  end: number;
}

function tokensMatchTerm(buf: readonly SearchToken[], term: QueryTerm): boolean {
  const len = term.tokens.length;
  if (buf.length < len) return false;
  const base = buf.length - len;
  for (let k = 0; k < len; k++) {
    const have = buf[base + k]?.norm;
    const want = term.tokens[k];
    if (have === undefined || want === undefined) return false;
    // Only the last token of a prefix term may match by prefix; all others must be equal (phrase semantics).
    if (k === len - 1 && term.prefix ? !have.startsWith(want) : have !== want) return false;
  }
  return true;
}

/**
 * Find regions that match any term, scanning tokens that START in `[from, startLimit)` (a token that starts before the
 * limit is scanned to its end, so one enormous matching token is still found). A multi-token term (phrase / CJK
 * substring) matches only when its tokens are adjacent in the text, so a CJK phrase highlights its characters
 * together and never a stray single character.
 */
function findRegions(text: string, terms: readonly QueryTerm[], from: number, startLimit: number, stopAtFirst: boolean): Region[] {
  const longest = terms.reduce((m, t) => Math.max(m, t.tokens.length), 0);
  if (longest === 0) return [];
  const buf: SearchToken[] = [];
  const found: Region[] = [];
  for (const tok of iterateSearchTokens(text, from)) {
    if (tok.start >= startLimit) break;
    buf.push(tok);
    if (buf.length > longest) buf.shift();
    for (const term of terms) {
      if (!tokensMatchTerm(buf, term)) continue;
      const first = buf[buf.length - term.tokens.length];
      if (first === undefined) continue;
      found.push({ start: first.start, end: tok.end });
      if (stopAtFirst) return found;
    }
  }
  return found;
}

function mergeRegions(regions: Region[]): Region[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Region[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

const BIDI_CONTROLS = /^[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]$/u;
const CONTROL = /^\p{Cc}$/u;
const SPACE = /^\s$/u;

/**
 * One source character -> the character allowed into a snippet. The marker characters become U+FFFD (so message text
 * can never forge a highlight), other control characters (incl. ESC, NUL, CR/LF/TAB) and all whitespace become a plain
 * space, bidi controls become U+FFFD.
 */
function cleanChar(ch: string): string {
  if (ch === MARK_START || ch === MARK_END || BIDI_CONTROLS.test(ch)) return '\uFFFD';
  if (CONTROL.test(ch) || SPACE.test(ch)) return ' ';
  return ch;
}

function cleanSegment(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = cleanChar(ch);
    if (c === ' ' && out.endsWith(' ')) continue;
    out += c;
  }
  return out;
}

function takeCodePoints(s: string, maxUnits: number): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > maxUnits) break;
    out += ch;
  }
  return out;
}

/** Start of the window: a little before the first hit, on a code point boundary, preferably right after whitespace. */
function chooseWindowStart(text: string, hitStart: number): number {
  let ws = Math.max(0, hitStart - SNIPPET_LEAD_CHARS);
  if (ws === 0) return 0;
  const low = text.charCodeAt(ws);
  if (low >= 0xdc00 && low <= 0xdfff) ws += 1; // never start in the middle of a surrogate pair
  ws = Math.min(ws, hitStart);
  for (let k = ws; k < hitStart; k++) {
    if (SPACE.test(text.charAt(k))) {
      ws = k + 1;
      break;
    }
  }
  return ws;
}

function renderWindow(text: string, ws: number, regions: readonly Region[], maxLen: number): string {
  const n = text.length;
  const lead = ws > 0 ? ELLIPSIS : '';
  let out = lead;
  let used = lead.length;
  let i = ws;
  let ri = 0;
  while (i < n) {
    while (ri < regions.length && (regions[ri]?.end ?? 0) <= i) ri++;
    const r = regions[ri];
    if (r !== undefined && r.start === i) {
      // Cap the slice: a single enormous token must not be copied just to be refused.
      const piece = cleanSegment(text.slice(r.start, Math.min(r.end, r.start + maxLen + 8)));
      const reserve = r.end < n ? ELLIPSIS.length : 0;
      if (used + piece.length + 2 + reserve > maxLen) {
        if (out === lead) {
          // Not even one match fits: show a truncated, still highlighted, head of it.
          const room = maxLen - used - 2 - ELLIPSIS.length;
          if (room > 0) {
            const cut = takeCodePoints(piece, room);
            out += MARK_START + cut + MARK_END;
            i = r.start + cut.length; // approximate: only used to decide that an ellipsis follows
          }
        }
        break;
      }
      out += MARK_START + piece + MARK_END;
      used += piece.length + 2;
      i = r.end;
      ri++;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    const c = cleanChar(text.slice(i, i + len));
    if (c === ' ' && (out === lead || out.endsWith(' '))) {
      i += len;
      continue;
    }
    const reserve = i + len < n ? ELLIPSIS.length : 0;
    if (used + c.length + reserve > maxLen) break;
    out += c;
    used += c.length;
    i += len;
  }
  const trimmed = out.trimEnd();
  return i < n ? trimmed + ELLIPSIS : trimmed;
}

/**
 * Build a plain-text excerpt (at most `maxLen` UTF-16 units INCLUDING markers and ellipses) around the first match,
 * cut from the ORIGINAL text. Matches are wrapped in U+0001 ... U+0002. If nothing can be located (e.g. an exotic raw
 * query, or a match beyond the scan limit) the excerpt is simply the start of the text, without markers.
 * Deterministic and pure.
 */
export function buildSnippet(text: string, terms: readonly QueryTerm[], maxLen: number = SNIPPET_MAX_CHARS): string {
  if (text === '') return '';
  const budget = Math.max(8, Math.floor(maxLen));
  const first = terms.length === 0 ? [] : findRegions(text, terms, 0, SNIPPET_SCAN_LIMIT, true);
  const hit = first[0];
  if (hit === undefined) return renderWindow(text, 0, [], budget);
  const ws = chooseWindowStart(text, hit.start);
  // The first hit is always included, even if re-scanning from a window start that fell inside a word misses it.
  const regions = mergeRegions([hit, ...findRegions(text, terms, ws, ws + SNIPPET_SCAN_SPAN, false).filter((r) => r.start >= ws)]);
  return renderWindow(text, ws, regions, budget);
}

// ---------------------------------------------------------------------------------------------------------------
// Cursor (keyset) encoding
// ---------------------------------------------------------------------------------------------------------------

/** rank, created_at IS NULL, coalesce(created_at,''), conversation_id, message_id, provider, account_label, source_batch */
type CursorKey = [number, number, string, string, string, string, string, string];

function fingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function encodeCursor(fp: string, key: CursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, f: fp, k: key }), 'utf8').toString('base64url');
}

function invalidCursor(): GcrError {
  return new GcrError('INVALID_ARGUMENT', 'Invalid value for "cursor": it is malformed or does not belong to this query.', { details: { field: 'cursor' } });
}

/** Strictly validates a client-supplied cursor; it is only ever used as bound parameters, never as SQL text. */
function decodeCursor(raw: unknown, fp: string): CursorKey {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { v, f, k } = parsed as { v?: unknown; f?: unknown; k?: unknown };
  if (v !== 1 || f !== fp || !Array.isArray(k) || k.length !== 8) throw invalidCursor();
  const [rank, nullFlag, created, conv, msg, provider, account, batch] = k as unknown[];
  const strings = [created, conv, msg, provider, account, batch];
  if (typeof rank !== 'number' || !Number.isFinite(rank)) throw invalidCursor();
  if (nullFlag !== 0 && nullFlag !== 1) throw invalidCursor();
  if (!strings.every((x): x is string => typeof x === 'string' && x.length <= MAX_FILTER_CHARS * 2 && !x.includes('\0'))) throw invalidCursor();
  return [rank, nullFlag, created as string, conv as string, msg as string, provider as string, account as string, batch as string];
}

function cursorKeyOf(hit: SearchHit): CursorKey {
  return [hit.rank, hit.createdAt === null ? 1 : 0, hit.createdAt ?? '', hit.conversationId, hit.messageId, hit.provider, hit.accountLabel, hit.batchId];
}

// ---------------------------------------------------------------------------------------------------------------
// searchMessages
// ---------------------------------------------------------------------------------------------------------------

/** Joined to conversation_heads unless allBatches; fragments are fixed text. */
const HEAD_JOIN =
  'JOIN conversation_heads ch ON ch.provider = m.provider AND ch.account_label = m.account_label ' +
  'AND ch.conversation_id = m.conversation_id AND ch.source_batch = m.source_batch ';

const MESSAGE_ORDER =
  'ORDER BY h.rank ASC, (m.created_at IS NULL) ASC, m.created_at ASC, m.conversation_id ASC, m.message_id ASC, ' +
  'm.provider ASC, m.account_label ASC, m.source_batch ASC ';

const CURSOR_PREDICATE =
  'AND (h.rank, (m.created_at IS NULL), COALESCE(m.created_at, \'\'), m.conversation_id, m.message_id, m.provider, m.account_label, m.source_batch) ' +
  '> (?, ?, ?, ?, ?, ?, ?, ?) ';

function hitFromRow(row: Row, terms: readonly QueryTerm[]): SearchHit {
  return {
    provider: rowString(row, 'provider') as Provider,
    accountLabel: rowString(row, 'account_label'),
    conversationId: rowString(row, 'conversation_id'),
    conversationTitle: rowStringOrNull(row, 'title'),
    messageId: rowString(row, 'message_id'),
    authorRole: rowString(row, 'author_role'),
    modelSlug: rowStringOrNull(row, 'model_slug'),
    channel: rowStringOrNull(row, 'channel'),
    createdAt: rowStringOrNull(row, 'created_at'),
    hidden: rowNumber(row, 'hidden') === 1,
    snippet: buildSnippet(rowString(row, 'text'), terms),
    rank: rowNumber(row, 'rank'),
    batchId: rowString(row, 'source_batch'),
  };
}

/**
 * Search message bodies. Structural nodes are never indexed, hidden messages are excluded unless `includeHidden`, and
 * only each conversation's head batch is searched unless `allBatches`.
 * Throws INVALID_ARGUMENT (bad/empty query, bad filter, bad cursor, cursor together with offset) and, in raw mode,
 * FTS_SYNTAX_ERROR.
 */
export function searchMessages(db: DatabaseSync, q: SearchQuery): Page<SearchHit> {
  if (typeof q !== 'object' || q === null) throw badArg('query', 'expected an object');
  const compiled = compileQuery(q.query, q.mode);
  const limit = intArg('limit', q.limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  const offset = intArg('offset', q.offset, 0, MAX_OFFSET, 0);
  const provider = optString('provider', q.provider);
  const accountLabel = optString('accountLabel', q.accountLabel);
  const conversationId = optString('conversationId', q.conversationId);
  const role = optString('role', q.role);
  const channel = optString('channel', q.channel);
  const hasModel = optBool('hasModel', q.hasModel);
  const createdAfter = optIso('createdAfter', q.createdAfter);
  const createdBefore = optIso('createdBefore', q.createdBefore);
  const includeHidden = optBool('includeHidden', q.includeHidden) === true;
  const allBatches = optBool('allBatches', q.allBatches) === true;

  // The cursor is only valid for the exact query + filters it was issued for (limit and offset may differ).
  const fp = fingerprint([compiled.mode, compiled.match, provider, accountLabel, conversationId, role, channel, hasModel, createdAfter, createdBefore, includeHidden, allBatches]);
  let cursor: CursorKey | null = null;
  if (q.cursor !== undefined) {
    if (offset !== 0) throw badArg('cursor', 'cannot be combined with a non-zero offset');
    cursor = decodeCursor(q.cursor, fp);
  }

  // SQL text below is assembled from FIXED fragments only; every value is a bound parameter.
  const where: string[] = ["m.node_kind = 'message' "];
  // Bound parameters in textual order: MATCH expression, snippet source length, then the WHERE/cursor values, LIMIT, OFFSET.
  const params: SQLInputValue[] = [compiled.match, SNIPPET_SOURCE_CHARS];
  const add = (fragment: string, ...values: SQLInputValue[]): void => {
    where.push(fragment);
    params.push(...values);
  };
  if (!includeHidden) add('AND m.hidden = 0 ');
  if (provider !== undefined) add('AND m.provider = ? ', provider);
  if (accountLabel !== undefined) add('AND m.account_label = ? ', accountLabel);
  if (conversationId !== undefined) add('AND m.conversation_id = ? ', conversationId);
  if (role !== undefined) add('AND m.author_role = ? ', role);
  if (channel !== undefined) add('AND m.channel = ? ', channel);
  if (hasModel === true) add('AND m.model_slug IS NOT NULL ');
  if (hasModel === false) add('AND m.model_slug IS NULL ');
  if (createdAfter !== undefined) add('AND m.created_at >= ? ', createdAfter);
  if (createdBefore !== undefined) add('AND m.created_at < ? ', createdBefore);
  if (cursor !== null) add(CURSOR_PREDICATE, ...cursor);

  const sql =
    'WITH h AS MATERIALIZED (SELECT rowid AS rid, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ?) ' +
    'SELECT m.provider AS provider, m.account_label AS account_label, m.conversation_id AS conversation_id, c.title AS title, ' +
    'm.message_id AS message_id, m.author_role AS author_role, m.model_slug AS model_slug, m.channel AS channel, ' +
    'm.created_at AS created_at, m.hidden AS hidden, substr(m.text, 1, ?) AS text, h.rank AS rank, m.source_batch AS source_batch ' +
    'FROM h JOIN messages m ON m.rowid = h.rid ' +
    'JOIN conversations c ON c.provider = m.provider AND c.account_label = m.account_label AND c.conversation_id = m.conversation_id AND c.source_batch = m.source_batch ' +
    (allBatches ? '' : HEAD_JOIN) +
    `WHERE ${where.join('')}${MESSAGE_ORDER}LIMIT ? OFFSET ?`;
  params.push(limit + 1, offset);

  const rows = runFtsQuery(compiled.mode, () => db.prepare(sql).all(...params));
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => hitFromRow(r, compiled.terms));
  const last = items[items.length - 1];
  return {
    items,
    limit,
    offset,
    nextOffset: hasMore && cursor === null ? offset + items.length : null,
    nextCursor: hasMore && last !== undefined ? encodeCursor(fp, cursorKeyOf(last)) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// searchConversationTitles
// ---------------------------------------------------------------------------------------------------------------

/**
 * Search conversation titles (same query language and normalization as message search). Results are conversations at
 * their head batch unless `allBatches`; order: rank, conversation_id, provider, account_label, source_batch.
 */
export function searchConversationTitles(db: DatabaseSync, q: TitleSearchQuery): Page<TitleHit> {
  if (typeof q !== 'object' || q === null) throw badArg('query', 'expected an object');
  const compiled = compileQuery(q.query, q.mode);
  const limit = intArg('limit', q.limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  const offset = intArg('offset', q.offset, 0, MAX_OFFSET, 0);
  const provider = optString('provider', q.provider);
  const accountLabel = optString('accountLabel', q.accountLabel);
  const allBatches = optBool('allBatches', q.allBatches) === true;

  const where: string[] = ['1 = 1 '];
  const params: SQLInputValue[] = [compiled.match];
  const add = (fragment: string, value: SQLInputValue): void => {
    where.push(fragment);
    params.push(value);
  };
  if (provider !== undefined) add('AND c.provider = ? ', provider);
  if (accountLabel !== undefined) add('AND c.account_label = ? ', accountLabel);
  const sql =
    'WITH h AS MATERIALIZED (SELECT rowid AS rid, bm25(conversations_fts) AS rank FROM conversations_fts WHERE conversations_fts MATCH ?) ' +
    `SELECT ${SUMMARY_COLUMNS}, h.rank AS rank ` +
    'FROM h JOIN conversations c ON c.rowid = h.rid ' +
    (allBatches
      ? ''
      : 'JOIN conversation_heads ch ON ch.provider = c.provider AND ch.account_label = c.account_label AND ch.conversation_id = c.conversation_id AND ch.source_batch = c.source_batch ') +
    `WHERE ${where.join('')}` +
    'ORDER BY h.rank ASC, c.conversation_id ASC, c.provider ASC, c.account_label ASC, c.source_batch ASC LIMIT ? OFFSET ?';
  params.push(limit + 1, offset);

  const rows = runFtsQuery(compiled.mode, () => db.prepare(sql).all(...params));
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(
    (r): TitleHit => ({ ...conversationSummaryFromRow(r), snippet: buildSnippet(rowStringOrNull(r, 'title') ?? '', compiled.terms), rank: rowNumber(r, 'rank') }),
  );
  return { items, limit, offset, nextOffset: hasMore ? offset + items.length : null, nextCursor: null };
}
