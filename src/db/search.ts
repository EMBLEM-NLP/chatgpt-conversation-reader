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
 *  - Total order: rank ASC, created_at ASC as an INSTANT ("Z" and ".000Z" spellings are equal; NULLs last), conversation_id, message_id, then provider, account_label and
 *    source_batch (the natural key is only unique with those three, e.g. under `allBatches`). Because the order is
 *    total, offset pagination and keyset (cursor) pagination return identical sequences with no repeat or skip, as long
 *    as the index does not change between page requests.
 *  - bm25 statistics are computed over the whole index, including superseded snapshots of a conversation.
 *
 * Attachment search (FR-15, `searchAttachments`)
 *  - METADATA ONLY: the file name and the MIME type of an attachment reference, never file content (GCR does not read attachment
 *    bytes; the export may not even contain them).
 *  - There is no FTS table for attachments and the schema is not extended for them (a migration is out of scope), so the stored
 *    `messages.attachments_json` of messages that HAVE attachments is scanned and matched in JavaScript. Matching uses the same
 *    folding as every other search (NFKC, case, accents, width, ligatures, per-character CJK) on whole tokens of the name; each
 *    search word must occur as a SUBSTRING of the folded name or MIME type. No ranking: the order is chronological and total.
 *    The cost is one scan of the messages table per call (about 45 ms for 50,000 synthetic messages with no attachment, 60 to 175 ms
 *    with attachments on 10% of them: docs/USER_GUIDE.md). Only the first MAX_ATTACHMENTS_SCANNED_PER_MESSAGE attachments of one
 *    message are searched; the result counts the messages cut that way (`truncatedMessages`) so the caller can warn. SQLite sorts every candidate row before the first one is returned, so
 *    the early exit once the page is full saves only the JavaScript matching, not the scan.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { isIso8601Utc } from '../domain/validate.js';
import type { ConversationSummary, Page, SearchHit } from '../domain/results.js';
import type { Completeness, ConversationProvenance, Provider } from '../domain/types.js';
import { GcrError } from '../errors.js';
import { iterateSearchTokens, parsePlainQuery, prepareRawQuery, rawQueryTerms, tokenizeQuery } from './cjk.js';
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
/**
 * Longest accepted cursor. A cursor carries three identifiers of up to 512 UTF-16 units each (conversation id, message id,
 * account label); as UTF-8 JSON that is at most ~4.8 KB, i.e. ~6.4k base64url characters. The limit must stay above that, or
 * a cursor this module issued itself would be refused on the next page.
 */
const MAX_CURSOR_CHARS = 8192;

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
/**
 * Total number of characters that ONE page of search hits may scan while looking for the first match to highlight (the sum
 * over all hits of the position reached). Without it a page of 200 hits on 190k-character messages scanned ~38M code
 * points (5-11 s). Hits are processed in page order; once the budget is spent the remaining hits still appear, with the
 * start of the text as their snippet and no highlight. Typical hits (match within the first few KB) cost almost nothing.
 */
export const SNIPPET_PAGE_SCAN_BUDGET = 2_000_000;
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
  /** Inclusive lower bound on message created_at (ISO-8601 UTC), compared as INSTANTS (".000Z" and "Z" spellings agree). Messages without a timestamp never match a bound. */
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

/**
 * Why a query that yields no tokens is refused (SPEC-08). Symbols and emoji are NOT indexed: the index keeps only letters,
 * digits and combining marks (see cjk.ts, `buildSearchText`), so "😀", "₽" or "!!!" can never match anything. Saying only "no
 * searchable terms" left users guessing whether the data or the query was at fault; the message names the cause and the remedy.
 */
const EMPTY_QUERY_WHY = 'the query is empty; search for words';
const SYMBOLS_ONLY_WHY = 'the query contains only symbols or punctuation, which are not indexed; search for words';

/** Validate and compile a user query. Empty / punctuation-only queries are INVALID_ARGUMENT. */
export function compileQuery(query: unknown, mode: unknown): CompiledQuery {
  if (typeof query !== 'string') throw badArg('query', 'expected a string');
  if (query.length > MAX_QUERY_CHARS) throw badArg('query', `longer than ${MAX_QUERY_CHARS} characters`);
  if (query.includes('\0')) throw badArg('query', 'contains a NUL byte');
  if (mode !== undefined && mode !== 'plain' && mode !== 'raw') throw badArg('mode', "expected 'plain' or 'raw'");

  if (mode === 'raw') {
    const match = prepareRawQuery(query);
    // Raw mode turns characters the index does not hold (emoji, currency signs) into spaces first, so "😀" arrives here as blank.
    if (match.trim() === '') throw badArg('query', query.trim() === '' ? EMPTY_QUERY_WHY : SYMBOLS_ONLY_WHY);
    return { mode: 'raw', match, terms: rawQueryTerms(query) };
  }
  const terms = parsePlainQuery(query);
  if (terms.length === 0) throw badArg('query', query.trim() === '' ? EMPTY_QUERY_WHY : SYMBOLS_ONLY_WHY);
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
  return buildSnippetScan(text, terms, maxLen, SNIPPET_SCAN_LIMIT).snippet;
}

/**
 * buildSnippet with an explicit scan limit (characters examined while looking for the first match; 0 = do not look) that
 * also reports how many characters it examined, so a caller can enforce a budget over many snippets.
 */
function buildSnippetScan(text: string, terms: readonly QueryTerm[], maxLen: number, scanLimit: number): { snippet: string; scanned: number } {
  if (text === '') return { snippet: '', scanned: 0 };
  const budget = Math.max(8, Math.floor(maxLen));
  const limit = Math.max(0, Math.min(scanLimit, SNIPPET_SCAN_LIMIT));
  const first = terms.length === 0 || limit === 0 ? [] : findRegions(text, terms, 0, limit, true);
  const hit = first[0];
  if (hit === undefined) return { snippet: renderWindow(text, 0, [], budget), scanned: Math.min(limit, text.length) };
  const ws = chooseWindowStart(text, hit.start);
  // The first hit is always included, even if re-scanning from a window start that fell inside a word misses it.
  const regions = mergeRegions([hit, ...findRegions(text, terms, ws, ws + SNIPPET_SCAN_SPAN, false).filter((r) => r.start >= ws)]);
  return { snippet: renderWindow(text, ws, regions, budget), scanned: hit.end + SNIPPET_SCAN_SPAN };
}

// ---------------------------------------------------------------------------------------------------------------
// Cursor (keyset) encoding
// ---------------------------------------------------------------------------------------------------------------

/** rank, created_at IS NULL, canonical created_at instant ('' when NULL), conversation_id, message_id, provider, account_label, source_batch */
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

function cursorKeyOf(hit: SearchHit, createdKey: string): CursorKey {
  return [hit.rank, hit.createdAt === null ? 1 : 0, createdKey, hit.conversationId, hit.messageId, hit.provider, hit.accountLabel, hit.batchId];
}

// ---------------------------------------------------------------------------------------------------------------
// searchMessages
// ---------------------------------------------------------------------------------------------------------------

/** Joined to conversation_heads unless allBatches; fragments are fixed text. */
const HEAD_JOIN =
  'JOIN conversation_heads ch ON ch.provider = m.provider AND ch.account_label = m.account_label ' +
  'AND ch.conversation_id = m.conversation_id AND ch.source_batch = m.source_batch ';

/**
 * created_at as a canonical instant string `YYYY-MM-DDTHH:MM:SS.fffZ`. Stored values may be spelled with or without the
 * ".fff" part (validate.ts allows both); compared as raw strings "00.500Z" would sort BEFORE "00Z" (because "." < "Z") and
 * range filters would be off by up to a second. strftime() normalizes every spelling; NULL stays NULL.
 */
const CANON_INSTANT = "strftime('%Y-%m-%dT%H:%M:%fZ', ";
const CREATED_KEY = `COALESCE(${CANON_INSTANT}m.created_at), '')`;

const MESSAGE_ORDER =
  `ORDER BY h.rank ASC, (m.created_at IS NULL) ASC, ${CREATED_KEY} ASC, m.conversation_id ASC, m.message_id ASC, ` +
  'm.provider ASC, m.account_label ASC, m.source_batch ASC ';

const CURSOR_PREDICATE =
  `AND (h.rank, (m.created_at IS NULL), ${CREATED_KEY}, m.conversation_id, m.message_id, m.provider, m.account_label, m.source_batch) ` +
  '> (?, ?, ?, ?, ?, ?, ?, ?) ';

function hitFromRow(row: Row, terms: readonly QueryTerm[], scanLimit: number): { hit: SearchHit; scanned: number } {
  const snippet = buildSnippetScan(rowString(row, 'text'), terms, SNIPPET_MAX_CHARS, scanLimit);
  const hit: SearchHit = {
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
    snippet: snippet.snippet,
    rank: rowNumber(row, 'rank'),
    batchId: rowString(row, 'source_batch'),
  };
  return { hit, scanned: snippet.scanned };
}

/** The validated message filters shared by message search, the attachment scan and the hit counter. */
interface MessageFilters {
  provider: string | undefined;
  accountLabel: string | undefined;
  conversationId: string | undefined;
  role: string | undefined;
  channel: string | undefined;
  hasModel: boolean | undefined;
  createdAfter: string | undefined;
  createdBefore: string | undefined;
  includeHidden: boolean;
  allBatches: boolean;
}

/** Validation (never echoes the offending value). The order of the checks is fixed so the first error reported never changes. */
function parseMessageFilters(q: Partial<Record<keyof MessageFilters, unknown>>): MessageFilters {
  return {
    provider: optString('provider', q.provider),
    accountLabel: optString('accountLabel', q.accountLabel),
    conversationId: optString('conversationId', q.conversationId),
    role: optString('role', q.role),
    channel: optString('channel', q.channel),
    hasModel: optBool('hasModel', q.hasModel),
    createdAfter: optIso('createdAfter', q.createdAfter),
    createdBefore: optIso('createdBefore', q.createdBefore),
    includeHidden: optBool('includeHidden', q.includeHidden) === true,
    allBatches: optBool('allBatches', q.allBatches) === true,
  };
}

/**
 * WHERE fragments and their bound values for the aliases `m` (messages) of a statement. Fixed text only; values are parameters.
 * Structural nodes are never part of a result, hidden messages only with `includeHidden`.
 */
function messageWhere(f: MessageFilters): { fragments: string[]; params: SQLInputValue[] } {
  const fragments: string[] = ["m.node_kind = 'message' "];
  const params: SQLInputValue[] = [];
  const add = (fragment: string, ...values: SQLInputValue[]): void => {
    fragments.push(fragment);
    params.push(...values);
  };
  if (!f.includeHidden) add('AND m.hidden = 0 ');
  if (f.provider !== undefined) add('AND m.provider = ? ', f.provider);
  if (f.accountLabel !== undefined) add('AND m.account_label = ? ', f.accountLabel);
  if (f.conversationId !== undefined) add('AND m.conversation_id = ? ', f.conversationId);
  if (f.role !== undefined) add('AND m.author_role = ? ', f.role);
  if (f.channel !== undefined) add('AND m.channel = ? ', f.channel);
  if (f.hasModel === true) add('AND m.model_slug IS NOT NULL ');
  if (f.hasModel === false) add('AND m.model_slug IS NULL ');
  // Instants, not strings (see CANON_INSTANT). Rows without created_at give NULL and therefore never match a bound.
  if (f.createdAfter !== undefined) add(`AND ${CANON_INSTANT}m.created_at) >= ${CANON_INSTANT}?) `, f.createdAfter);
  if (f.createdBefore !== undefined) add(`AND ${CANON_INSTANT}m.created_at) < ${CANON_INSTANT}?) `, f.createdBefore);
  return { fragments, params };
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
  const filters = parseMessageFilters(q);
  const { provider, accountLabel, conversationId, role, channel, hasModel, createdAfter, createdBefore, includeHidden, allBatches } = filters;

  // The cursor is only valid for the exact query + filters it was issued for (limit and offset may differ).
  const fp = fingerprint([compiled.mode, compiled.match, provider, accountLabel, conversationId, role, channel, hasModel, createdAfter, createdBefore, includeHidden, allBatches]);
  let cursor: CursorKey | null = null;
  if (q.cursor !== undefined) {
    if (offset !== 0) throw badArg('cursor', 'cannot be combined with a non-zero offset');
    cursor = decodeCursor(q.cursor, fp);
  }

  // SQL text below is assembled from FIXED fragments only; every value is a bound parameter.
  const built = messageWhere(filters);
  const where: string[] = [...built.fragments];
  // Bound parameters in textual order: MATCH expression, snippet source length, then the WHERE/cursor values, LIMIT, OFFSET.
  const params: SQLInputValue[] = [compiled.match, SNIPPET_SOURCE_CHARS, ...built.params];
  if (cursor !== null) {
    where.push(CURSOR_PREDICATE);
    params.push(...cursor);
  }

  const sql =
    'WITH h AS MATERIALIZED (SELECT rowid AS rid, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ?) ' +
    'SELECT m.provider AS provider, m.account_label AS account_label, m.conversation_id AS conversation_id, c.title AS title, ' +
    'm.message_id AS message_id, m.author_role AS author_role, m.model_slug AS model_slug, m.channel AS channel, ' +
    `m.created_at AS created_at, ${CREATED_KEY} AS created_key, m.hidden AS hidden, substr(m.text, 1, ?) AS text, h.rank AS rank, m.source_batch AS source_batch ` +
    'FROM h JOIN messages m ON m.rowid = h.rid ' +
    'JOIN conversations c ON c.provider = m.provider AND c.account_label = m.account_label AND c.conversation_id = m.conversation_id AND c.source_batch = m.source_batch ' +
    (allBatches ? '' : HEAD_JOIN) +
    `WHERE ${where.join('')}${MESSAGE_ORDER}LIMIT ? OFFSET ?`;
  params.push(limit + 1, offset);

  const rows = runFtsQuery(compiled.mode, () => db.prepare(sql).all(...params));
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  // Snippet work is budgeted per page (see SNIPPET_PAGE_SCAN_BUDGET); hits are served in page order.
  let scanBudget = SNIPPET_PAGE_SCAN_BUDGET;
  const items: SearchHit[] = [];
  for (const r of pageRows) {
    const { hit, scanned } = hitFromRow(r, compiled.terms, Math.min(SNIPPET_SCAN_LIMIT, scanBudget));
    scanBudget = Math.max(0, scanBudget - scanned);
    items.push(hit);
  }
  const last = items[items.length - 1];
  const lastRow = pageRows[pageRows.length - 1];
  return {
    items,
    limit,
    offset,
    nextOffset: hasMore && cursor === null ? offset + items.length : null,
    nextCursor: hasMore && last !== undefined && lastRow !== undefined ? encodeCursor(fp, cursorKeyOf(last, rowString(lastRow, 'created_key'))) : null,
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

// ---------------------------------------------------------------------------------------------------------------
// countMessageHits
// ---------------------------------------------------------------------------------------------------------------

/**
 * How many message hits a query has, counted up to `cap` (the answer is exact below the cap and equals `cap` at or above it).
 * Same query language and the same filters as `searchMessages` (offset / limit / cursor do not apply). Used to place the
 * attachment hits after the message hits when scope "all" is paged: no snippets are built, so it is far cheaper than paging.
 */
export function countMessageHits(db: DatabaseSync, q: SearchQuery, cap: number): number {
  if (typeof q !== 'object' || q === null) throw badArg('query', 'expected an object');
  const compiled = compileQuery(q.query, q.mode);
  const limit = intArg('cap', cap, 1, 1_000_000, 1);
  const filters = parseMessageFilters(q);
  const built = messageWhere(filters);
  const sql =
    'WITH h AS MATERIALIZED (SELECT rowid AS rid FROM messages_fts WHERE messages_fts MATCH ?) ' +
    'SELECT count(*) AS n FROM (SELECT 1 FROM h JOIN messages m ON m.rowid = h.rid ' +
    'JOIN conversations c ON c.provider = m.provider AND c.account_label = m.account_label AND c.conversation_id = m.conversation_id AND c.source_batch = m.source_batch ' +
    (filters.allBatches ? '' : HEAD_JOIN) +
    `WHERE ${built.fragments.join('')}LIMIT ?)`;
  const row = runFtsQuery(compiled.mode, () => db.prepare(sql).get(compiled.match, ...built.params, limit));
  return row === undefined ? 0 : rowNumber(row, 'n');
}

// ---------------------------------------------------------------------------------------------------------------
// searchAttachments
// ---------------------------------------------------------------------------------------------------------------

export interface AttachmentSearchQuery {
  /** Words to find in attachment file names and MIME types (plain mode only: see `mode`). */
  query: string;
  /** Only 'plain' is meaningful: FTS5 syntax cannot be applied to file names, so 'raw' is INVALID_ARGUMENT. */
  mode?: SearchMode;
  provider?: string;
  accountLabel?: string;
  conversationId?: string;
  role?: string;
  channel?: string;
  hasModel?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  includeHidden?: boolean;
  allBatches?: boolean;
  /** 1..200, default 20. */
  limit?: number;
  /** Offset pagination (there is no cursor for attachments). */
  offset?: number;
}

/** One attachment of one message whose file name or MIME type matched. METADATA only: no file content is ever read or returned. */
export interface AttachmentHit {
  provider: Provider;
  accountLabel: string;
  conversationId: string;
  /** UNTRUSTED */
  conversationTitle: string | null;
  messageId: string;
  authorRole: string;
  modelSlug: string | null;
  channel: string | null;
  createdAt: string | null;
  hidden: boolean;
  /** 0-based position of the attachment in the message's attachment list (with messageId it identifies the attachment). */
  attachmentIndex: number;
  attachmentId: string | null;
  /** UNTRUSTED file name as the export gave it. */
  attachmentName: string | null;
  attachmentMimeType: string | null;
  attachmentSizeBytes: number | null;
  /** UNTRUSTED. Plain text naming the attachment ("name (mime type)"); matched words that align with whole words are wrapped in U+0001 / U+0002. */
  snippet: string;
  batchId: string;
}

export interface AttachmentSearchResult {
  page: Page<AttachmentHit>;
  /** Messages whose stored attachment list could not be read as JSON (their attachments were NOT searched). */
  unreadableMessages: number;
  /**
   * Messages whose stored list is longer than the scan cap: only its first MAX_ATTACHMENTS_SCANNED_PER_MESSAGE entries were
   * searched (the ChatGPT importer accepts far more per message). Like `unreadableMessages` it counts the messages the scan
   * READ: when the page stopped the scan early (`page.nextOffset !== null`) it is a lower bound.
   */
  truncatedMessages: number;
}

/** Most attachments looked at per message (a damaged or hostile list cannot make one message cost unbounded time). */
export const MAX_ATTACHMENTS_SCANNED_PER_MESSAGE = 5_000;
/** An attachment name or MIME type is cut to this many UTF-16 units before it is tokenized (validate.ts allows 4,096). */
const MAX_ATTACHMENT_FIELD_CHARS = 4_096;

/** The attachment tokens in order, joined by single spaces: the string every search word is looked up in ('' for null). */
function attachmentHaystack(value: string | null): string {
  if (value === null || value === '') return '';
  return tokenizeQuery(value.length > MAX_ATTACHMENT_FIELD_CHARS ? value.slice(0, MAX_ATTACHMENT_FIELD_CHARS) : value).join(' ');
}

interface StoredAttachment {
  id: string | null;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

/**
 * The stored list (the importer writes objects with these keys), or null when it is not a JSON array of objects. `truncated`
 * is true when the list was longer than the per-message cap and only its head is returned.
 */
function parseStoredAttachments(json: string): { list: StoredAttachment[]; truncated: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: StoredAttachment[] = [];
  const n = Math.min(parsed.length, MAX_ATTACHMENTS_SCANNED_PER_MESSAGE);
  const truncated = parsed.length > n;
  for (let i = 0; i < n; i++) {
    const el: unknown = parsed[i];
    if (typeof el !== 'object' || el === null || Array.isArray(el)) {
      out.push({ id: null, name: null, mimeType: null, sizeBytes: null });
      continue; // keep the index: attachmentIndex is the position in the stored list
    }
    const o = el as Record<string, unknown>;
    out.push({
      id: typeof o['id'] === 'string' ? o['id'] : null,
      name: typeof o['name'] === 'string' ? o['name'] : null,
      mimeType: typeof o['mimeType'] === 'string' ? o['mimeType'] : null,
      sizeBytes: typeof o['sizeBytes'] === 'number' && Number.isFinite(o['sizeBytes']) ? o['sizeBytes'] : null,
    });
  }
  return { list: out, truncated };
}

/** Name and MIME type as one displayable string, e.g. "synthetic-notes.txt (text/plain)". */
function attachmentLabel(a: StoredAttachment): string {
  const name = a.name === null || a.name === '' ? '(no name)' : a.name;
  return a.mimeType === null || a.mimeType === '' ? name : `${name} (${a.mimeType})`;
}

/**
 * Search the file names and MIME types of attachment references (FR-15, metadata only; see the file header).
 *
 * Matching: the query is compiled exactly like a plain message query (so an empty or symbol-only query is the same
 * INVALID_ARGUMENT), its terms are reduced to space-joined token strings, and an attachment matches when EVERY term occurs as a
 * substring of its folded name or of its folded MIME type ("diagram", "notes txt" and "synthetic-notes.txt" all find
 * synthetic-notes.txt; "image/png" finds every png). Hits are one per matching attachment, ordered by message time (NULL last),
 * conversation id, message id, provider, account, batch and attachment index: a total order, so offset paging never repeats or
 * skips an attachment while the data does not change. Structural nodes are skipped, hidden messages only with `includeHidden`,
 * only each conversation's head batch is searched unless `allBatches`.
 */
export function searchAttachments(db: DatabaseSync, q: AttachmentSearchQuery): AttachmentSearchResult {
  if (typeof q !== 'object' || q === null) throw badArg('query', 'expected an object');
  if (q.mode === 'raw') {
    throw new GcrError('INVALID_ARGUMENT', 'Invalid value for "mode": raw FTS5 syntax cannot be applied to attachment file names.', {
      remedy: 'Use plain mode: attachment names are matched as words (case, accents and width are ignored).',
      details: { field: 'mode' },
    });
  }
  const compiled = compileQuery(q.query, q.mode);
  const limit = intArg('limit', q.limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  const offset = intArg('offset', q.offset, 0, MAX_OFFSET, 0);
  const filters = parseMessageFilters(q);
  const needles = compiled.terms.map((t) => t.tokens.join(' '));

  const built = messageWhere(filters);
  // Only messages that HAVE attachments are read back; the folded comparison cannot be done by SQLite (its lower() is ASCII only).
  const sql =
    'SELECT m.provider AS provider, m.account_label AS account_label, m.conversation_id AS conversation_id, c.title AS title, ' +
    'm.message_id AS message_id, m.author_role AS author_role, m.model_slug AS model_slug, m.channel AS channel, ' +
    'm.created_at AS created_at, m.hidden AS hidden, m.attachments_json AS attachments_json, m.source_batch AS source_batch ' +
    'FROM messages m ' +
    'JOIN conversations c ON c.provider = m.provider AND c.account_label = m.account_label AND c.conversation_id = m.conversation_id AND c.source_batch = m.source_batch ' +
    (filters.allBatches ? '' : HEAD_JOIN) +
    `WHERE ${built.fragments.join('')}AND m.attachments_json <> '[]' ` +
    `ORDER BY (m.created_at IS NULL) ASC, ${CREATED_KEY} ASC, m.conversation_id ASC, m.message_id ASC, m.provider ASC, m.account_label ASC, m.source_batch ASC`;

  const items: AttachmentHit[] = [];
  let skipped = 0;
  let hasMore = false;
  let unreadableMessages = 0;
  let truncatedMessages = 0;
  // The whole scan runs inside runFtsQuery: the rows are streamed, so an SQLite failure can surface in the middle of the loop,
  // and it must still be mapped to a coded GcrError (never a raw driver error).
  runFtsQuery('plain', () => {
    const stmt = db.prepare(sql);
    scan: for (const row of stmt.iterate(...built.params)) {
      const parsed = parseStoredAttachments(rowString(row, 'attachments_json'));
      if (parsed === null) {
        unreadableMessages++;
        continue;
      }
      if (parsed.truncated) truncatedMessages++;
      const list = parsed.list;
      for (let index = 0; index < list.length; index++) {
        const a = list[index];
        if (a === undefined) continue;
        const name = attachmentHaystack(a.name);
        const mime = attachmentHaystack(a.mimeType);
        if (name === '' && mime === '') continue;
        if (!needles.every((n) => name.includes(n) || mime.includes(n))) continue;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        if (items.length >= limit) {
          hasMore = true; // one more match exists beyond the page: stop reading (the early exit that bounds the cost)
          break scan;
        }
        items.push({
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
          attachmentIndex: index,
          attachmentId: a.id,
          attachmentName: a.name,
          attachmentMimeType: a.mimeType,
          attachmentSizeBytes: a.sizeBytes,
          snippet: buildSnippet(attachmentLabel(a), compiled.terms),
          batchId: rowString(row, 'source_batch'),
        });
      }
    }
  });
  return {
    page: { items, limit, offset, nextOffset: hasMore ? offset + items.length : null, nextCursor: null },
    unreadableMessages,
    truncatedMessages,
  };
}
