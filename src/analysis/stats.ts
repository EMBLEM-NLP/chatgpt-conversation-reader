/**
 * Statistics over the local SQLite store (SPEC FR-11, FR-16, FR-09).
 *
 * `computeStats` is a PURE READ over `messages` / `conversation_heads`: it never writes, never touches the network and
 * never looks at anything but the already-imported rows. All values reach SQLite through bound parameters; the only text
 * assembled in code are fixed fragments and the allow-listed key expressions in GROUP_SPECS (chosen by `groupBy`, never
 * taken from the caller).
 *
 * What is counted
 *  - Only real messages (`node_kind = 'message'`). `structural_empty` placeholder nodes are never counted anywhere.
 *  - By default only each conversation's HEAD batch (ARCHITECTURE section 2) and only non-hidden messages. `allBatches`
 *    counts superseded snapshots too (the same message can then appear once per snapshot - a warning says so);
 *    `includeHidden` counts messages the source marked hidden.
 *  - `conversations` is the number of DISTINCT (provider, account_label, conversation_id) triples - several snapshots of
 *    one conversation count once. `characters` is the number of Unicode code points of the normalized message text
 *    (SQLite `length()` on TEXT), not UTF-16 units and not bytes.
 *  - `firstAt` / `lastAt` are the earliest / latest message `created_at` of the group, always spelled with millisecond
 *    precision (`...:SS.mmmZ`) so that the two stored spellings (`Z` and `.000Z`) compare as instants.
 *
 * Model honesty (FR-16)
 *  - The "model" grouping reports a message under its slug ONLY when the source supplied `model_slug` on that very
 *    message. Everything else (NULL, or an empty / whitespace-only slug that carries no identity) goes into ONE group with
 *    key `null` and label "unknown (not supplied by source)". Nothing is inferred from timestamps, neighbouring messages,
 *    or the conversation's `default_model_slug` (that column is not even read here).
 *
 * Ordering and pagination
 *  - Rows are sorted by (messages DESC, key ASC with NULL last). For the "conversation" grouping, where the same
 *    conversation id may exist under several providers / accounts, (provider, account_label) are two further tie-breaks.
 *    The order is therefore total, so `limit`/`offset` pages never repeat or skip a row while the database does not change.
 *  - The whole call runs inside one read transaction (when the caller has none open) so that rows, totals and warnings
 *    describe the same snapshot even if another process imports concurrently.
 *
 * Untrusted data: role strings, model slugs, channels, content types and (for the "conversation" grouping) titles come
 * from the imported export. They are returned as data, never interpreted; renderers must escape them.
 */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { toDbError } from '../db/open.js';
import type { Repository } from '../db/repo.js';
import { isIso8601Utc, parseIsoUtcToEpochMs } from '../domain/validate.js';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

export const STATS_GROUP_BY = ['role', 'model', 'channel', 'day', 'conversation', 'provider', 'content_type'] as const;
export type StatsGroupBy = (typeof STATS_GROUP_BY)[number];

export interface StatsOptions {
  groupBy: StatsGroupBy;
  provider?: string;
  accountLabel?: string;
  /** Exact author_role (an unrecognized role string can be filtered verbatim). */
  role?: string;
  /** Inclusive lower bound on message created_at (ISO-8601 UTC). Messages without a timestamp never match a bound. */
  createdAfter?: string;
  /** EXCLUSIVE upper bound on message created_at (ISO-8601 UTC). */
  createdBefore?: string;
  /** Count messages the source marked hidden. Default false. */
  includeHidden?: boolean;
  /** Count superseded snapshots too. Default false = head batches only. */
  allBatches?: boolean;
  /** IANA time zone for groupBy "day". Default "UTC". Invalid -> INVALID_ARGUMENT. */
  tz?: string;
  /** 1..1000, default 100. */
  limit?: number;
  /** Default 0. */
  offset?: number;
}

export interface StatsRow {
  /** Group value; null = "not supplied" / "no timestamp" (see label). For "conversation" this is the conversation id. */
  key: string | null;
  /** Human-readable label. UNTRUSTED for the "conversation" grouping (it is the conversation title, id as fallback). */
  label: string;
  messages: number;
  /** Distinct (provider, account_label, conversation_id). */
  conversations: number;
  /** Unicode code points of the normalized message text. */
  characters: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Only for groupBy "conversation": the scope of the id (the same id can exist under several providers / accounts). */
  provider?: string;
  accountLabel?: string;
}

export interface StatsResult {
  groupBy: StatsGroupBy;
  /** Only for groupBy "day": the time zone the day keys are expressed in. */
  tz?: string;
  rows: StatsRow[];
  limit: number;
  offset: number;
  /** Offset of the next page, or null when exhausted. */
  nextOffset: number | null;
  /** Over ALL matching messages, not just this page. */
  totals: { messages: number; conversations: number; characters: number };
  modelProvenance: {
    messagesWithModel: number;
    messagesWithoutModel: number;
    assistantMessagesWithModel: number;
    assistantMessagesWithoutModel: number;
    distinctModels: number;
    note: string;
  };
  warnings: Warning[];
}

export const STATS_LIMIT_DEFAULT = 100;
export const STATS_LIMIT_MAX = 1000;
/** Label of the single group that holds every message whose source did not name a model (FR-16). */
export const UNKNOWN_MODEL_LABEL = 'unknown (not supplied by source)';

const MODEL_PROVENANCE_NOTE =
  'A message is counted under a model only when the source supplied model_slug on that message. ' +
  'Missing values are never inferred from timestamps, neighbouring messages or the conversation default model (FR-16).';

// ---------------------------------------------------------------------------------------------------------------
// Argument validation (never echoes the offending value: arguments may be hostile or private)
// ---------------------------------------------------------------------------------------------------------------

const MAX_FILTER_CHARS = 512;
const MAX_OFFSET = 10_000_000;
const MAX_TZ_CHARS = 64;
const LABEL_MAX_CHARS = 200;
const SAMPLE_IDS_IN_WARNINGS = 5;

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

/**
 * Strict ISO-8601 UTC bound, returned in the millisecond spelling used by the SQL comparison (see normTs). Comparing
 * the raw strings would be wrong: "...:05Z" sorts AFTER "...:05.000Z" although both are the same instant.
 */
function optTimestamp(field: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!isIso8601Utc(v)) throw badArg(field, 'expected an ISO-8601 UTC timestamp like 2025-01-01T00:00:00Z');
  return v.length === 20 ? `${v.slice(0, 19)}.000Z` : v;
}

/**
 * Accepts exactly what the runtime's Intl implementation accepts as a time zone (IANA names, "UTC", and the offset
 * forms current engines understand). Invalid names, the empty string and NUL-bearing strings are INVALID_ARGUMENT.
 */
function resolveTimeZone(v: unknown): string {
  if (v === undefined) return 'UTC';
  if (typeof v !== 'string' || v === '' || v.length > MAX_TZ_CHARS || v.includes('\0')) throw badArg('tz', 'expected an IANA time zone name such as "UTC" or "America/New_York"');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
  } catch {
    throw badArg('tz', 'unknown time zone');
  }
  return v;
}

interface Filters {
  groupBy: StatsGroupBy;
  provider: string | undefined;
  accountLabel: string | undefined;
  role: string | undefined;
  after: string | undefined;
  before: string | undefined;
  includeHidden: boolean;
  allBatches: boolean;
  tz: string;
  limit: number;
  offset: number;
}

function normalizeOptions(opts: unknown): Filters {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) throw badArg('opts', 'expected an object');
  const o = opts as Record<string, unknown>;
  const groupBy = o['groupBy'];
  if (typeof groupBy !== 'string' || !(STATS_GROUP_BY as readonly string[]).includes(groupBy)) {
    throw badArg('groupBy', `expected one of ${STATS_GROUP_BY.join(', ')}`);
  }
  return {
    groupBy: groupBy as StatsGroupBy,
    provider: optString('provider', o['provider']),
    accountLabel: optString('accountLabel', o['accountLabel']),
    role: optString('role', o['role']),
    after: optTimestamp('createdAfter', o['createdAfter']),
    before: optTimestamp('createdBefore', o['createdBefore']),
    includeHidden: optBool('includeHidden', o['includeHidden']) ?? false,
    allBatches: optBool('allBatches', o['allBatches']) ?? false,
    tz: resolveTimeZone(o['tz']),
    limit: intArg('limit', o['limit'], 1, STATS_LIMIT_MAX, STATS_LIMIT_DEFAULT),
    offset: intArg('offset', o['offset'], 0, MAX_OFFSET, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SQL building blocks. Everything below is a FIXED fragment; user values only ever travel as bound parameters.
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

/**
 * ASCII + Unicode whitespace and zero-width separators that make a string "blank". SQLite's trim() only strips the
 * characters it is given (default: the space), so the set is spelled out. Used for model slugs here.
 */
const BLANK_CHARS =
  'char(32, 9, 10, 11, 12, 13, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8232, 8233, 8239, 8287, 8288, 12288, 65279)';

/** The source explicitly named a model on this message. NULL and blank slugs carry no identity, so they do not count. */
const HAS_MODEL = `(m.model_slug IS NOT NULL AND trim(m.model_slug, ${BLANK_CHARS}) <> '')`;

/**
 * created_at in a fixed-width millisecond spelling. validate.ts allows `...SSZ` (20 chars) and `...SS.mmmZ` (24 chars);
 * padding the short form makes plain string comparison equal to instant comparison. `col` is a literal from this file.
 */
function normTs(col: string): string {
  return `(CASE WHEN length(${col}) = 20 THEN substr(${col}, 1, 19) || '.000Z' ELSE ${col} END)`;
}

function normalizeStoredTs(s: string): string {
  return s.length === 20 ? `${s.slice(0, 19)}.000Z` : s;
}

/** Unambiguous (provider, account, conversation) key: ids cannot contain control characters (validate.ts), so char(31) is a safe separator. */
const CONV_KEY = '(m.provider || char(31) || m.account_label || char(31) || m.conversation_id)';

const HEAD_JOIN_M =
  'JOIN conversation_heads h ON h.provider = m.provider AND h.account_label = m.account_label ' +
  'AND h.conversation_id = m.conversation_id AND h.source_batch = m.source_batch ';
const CONV_JOIN_M =
  'JOIN conversations c ON c.provider = m.provider AND c.account_label = m.account_label ' +
  'AND c.conversation_id = m.conversation_id AND c.source_batch = m.source_batch ';
const HEAD_JOIN_C =
  'JOIN conversation_heads h ON h.provider = c.provider AND h.account_label = c.account_label ' +
  'AND h.conversation_id = c.conversation_id AND h.source_batch = c.source_batch ';

interface Scope {
  from: string;
  where: string;
  params: SQLInputValue[];
}

interface ScopeVariant {
  /** Join `conversations c` (needed only for the conversation title). */
  conversationJoin?: boolean;
  /** 'apply' (default): honour includeHidden. 'only': just the hidden messages. */
  hidden?: 'apply' | 'only';
  /** false: ignore createdAfter / createdBefore (used to count what the date bounds exclude). */
  dates?: boolean;
  /** Literal predicate appended as-is (code-supplied, never caller-supplied). */
  extraWhere?: string;
}

/** FROM / WHERE for "the messages this call counts". Parameter order follows placeholder order. */
function messageScope(f: Filters, v: ScopeVariant = {}): Scope {
  let from = 'FROM messages m ';
  if (!f.allBatches) from += HEAD_JOIN_M;
  if (v.conversationJoin === true) from += CONV_JOIN_M;
  let where = "WHERE m.node_kind = 'message' ";
  const params: SQLInputValue[] = [];
  if (v.hidden === 'only') where += 'AND m.hidden = 1 ';
  else if (!f.includeHidden) where += 'AND m.hidden = 0 ';
  if (f.provider !== undefined) {
    where += 'AND m.provider = ? ';
    params.push(f.provider);
  }
  if (f.accountLabel !== undefined) {
    where += 'AND m.account_label = ? ';
    params.push(f.accountLabel);
  }
  if (f.role !== undefined) {
    where += 'AND m.author_role = ? ';
    params.push(f.role);
  }
  if (v.dates !== false) {
    if (f.after !== undefined) {
      where += `AND ${normTs('m.created_at')} >= ? `;
      params.push(f.after);
    }
    if (f.before !== undefined) {
      where += `AND ${normTs('m.created_at')} < ? `;
      params.push(f.before);
    }
  }
  if (v.extraWhere !== undefined) where += v.extraWhere;
  return { from, where, params };
}

/** FROM / WHERE for the conversation snapshots in scope (provider / account filters and allBatches only). */
function conversationScope(f: Filters, extraWhere = ''): Scope {
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
  where += extraWhere;
  return { from, where, params };
}

/**
 * One read transaction for the whole call so rows, totals and warnings agree. Skipped when the caller already has a
 * transaction open (it then defines the snapshot). ROLLBACK, not COMMIT: nothing was written.
 */
function inReadSnapshot<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The result (or the original error) is what matters; a failing ROLLBACK of a read-only transaction means the
      // connection itself is gone, which the caller's next statement will report.
    }
  }
}

function resolveDb(h: DatabaseSync | Repository): DatabaseSync {
  return 'db' in h ? h.db : h;
}

// ---------------------------------------------------------------------------------------------------------------
// Groupings
// ---------------------------------------------------------------------------------------------------------------

interface GroupSpec {
  /** SQL expression for the group key (a literal from this file). */
  key: string;
  /** Label for the NULL key. */
  nullLabel: string;
}

const GROUP_SPECS: Readonly<Record<Exclude<StatsGroupBy, 'day' | 'conversation'>, GroupSpec>> = {
  role: { key: 'm.author_role', nullLabel: '(no role)' },
  model: { key: `CASE WHEN ${HAS_MODEL} THEN m.model_slug ELSE NULL END`, nullLabel: UNKNOWN_MODEL_LABEL },
  channel: { key: 'm.channel', nullLabel: '(no channel)' },
  provider: { key: 'm.provider', nullLabel: '(no provider)' },
  content_type: { key: 'm.content_type', nullLabel: '(no content type)' },
};

/** Verbatim for any non-empty key: a role / slug the tool does not know is reported as it is. */
function labelOf(key: string | null, nullLabel: string): string {
  if (key === null) return nullLabel;
  return key === '' ? '(empty)' : key;
}

function truncateLabel(s: string): string {
  const cps = Array.from(s);
  return cps.length <= LABEL_MAX_CHARS ? s : `${cps.slice(0, LABEL_MAX_CHARS).join('')}…`;
}

/** Fixed aggregate select list shared by every SQL-side grouping. */
const AGGREGATES =
  `count(*) AS n_messages, count(DISTINCT ${CONV_KEY}) AS n_conversations, coalesce(sum(length(m.text)), 0) AS n_chars, ` +
  `min(${normTs('m.created_at')}) AS first_at, max(${normTs('m.created_at')}) AS last_at `;

function sqlGroupRows(db: DatabaseSync, f: Filters): { rows: StatsRow[]; hasMore: boolean } {
  const isConversation = f.groupBy === 'conversation';
  const scope = messageScope(f, { conversationJoin: isConversation });
  let keyExpr: string;
  let extraSelect = '';
  let extraGroup = '';
  let extraOrder = '';
  let nullLabel = '(none)';
  if (f.groupBy === 'conversation') {
    keyExpr = 'm.conversation_id';
    // The same id can exist under several providers / accounts: they are separate groups, tie-broken deterministically.
    extraSelect = ', m.provider AS p, m.account_label AS a, max(c.title) AS title';
    extraGroup = ', p, a';
    extraOrder = ', p ASC, a ASC';
  } else if (f.groupBy !== 'day') {
    const spec = GROUP_SPECS[f.groupBy];
    keyExpr = spec.key;
    nullLabel = spec.nullLabel;
  } else {
    throw new GcrError('INTERNAL_ERROR', 'The day grouping is not computed in SQL.');
  }
  const sql =
    `SELECT ${keyExpr} AS k${extraSelect}, ${AGGREGATES}` +
    `${scope.from}${scope.where}GROUP BY k${extraGroup} ` +
    `ORDER BY n_messages DESC, (k IS NULL) ASC, k ASC${extraOrder} LIMIT ? OFFSET ?`;
  // One extra row tells us whether another page exists without a second COUNT query.
  const raw = db.prepare(sql).all(...scope.params, f.limit + 1, f.offset);
  const hasMore = raw.length > f.limit;
  const rows = raw.slice(0, f.limit).map((r): StatsRow => {
    const key = strOrNull(r, 'k');
    const row: StatsRow = {
      key,
      label: labelOf(key, nullLabel),
      messages: num(r, 'n_messages'),
      conversations: num(r, 'n_conversations'),
      characters: num(r, 'n_chars'),
      firstAt: strOrNull(r, 'first_at'),
      lastAt: strOrNull(r, 'last_at'),
    };
    if (isConversation) {
      const title = strOrNull(r, 'title');
      row.label = truncateLabel(title !== null && title.trim() !== '' ? title : (key ?? ''));
      row.provider = strOrNull(r, 'p') ?? '';
      row.accountLabel = strOrNull(r, 'a') ?? '';
    }
    return row;
  });
  return { rows, hasMore };
}

// ----- day grouping (time-zone aware, computed in JS) -----------------------------------------------------------

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Returns a function mapping an epoch-millisecond instant to the LOCAL calendar date `YYYY-MM-DD` in `tz`.
 * WHY Intl and not an offset table: the offset of a zone depends on the instant (DST, historical changes), and Intl
 * applies the engine's tz database. The Gregorian calendar and Latin digits are forced so the user's locale can never
 * change the key. Era is read so proleptic years before 1 CE get an astronomical year number instead of a wrong one.
 */
function makeDayKey(tz: string): (ms: number) => string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    calendar: 'gregory',
    numberingSystem: 'latn',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (ms: number): string => {
    let year = Number.NaN;
    let month = '';
    let day = '';
    let bc = false;
    for (const part of fmt.formatToParts(ms)) {
      if (part.type === 'year') year = Number.parseInt(part.value, 10);
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
      else if (part.type === 'era') bc = part.value.startsWith('B');
    }
    if (!Number.isFinite(year) || month === '' || day === '') {
      throw new GcrError('INTERNAL_ERROR', 'The time zone formatter returned an unexpected shape.');
    }
    const astronomical = bc ? 1 - year : year;
    const y = astronomical < 0 ? `-${pad(-astronomical, 4)}` : pad(astronomical, 4);
    return `${y}-${month}-${day}`;
  };
}

interface DayAcc {
  messages: number;
  characters: number;
  firstAt: string | null;
  lastAt: string | null;
  conversations: Set<string>;
}

function compareDayRows(a: StatsRow, b: StatsRow): number {
  if (a.messages !== b.messages) return b.messages - a.messages;
  if (a.key === b.key) return 0;
  if (a.key === null) return 1; // NULL (unknown day) last
  if (b.key === null) return -1;
  return a.key < b.key ? -1 : 1;
}

function dayGroupRows(db: DatabaseSync, f: Filters): { rows: StatsRow[]; hasMore: boolean } {
  const scope = messageScope(f);
  const dayKey = makeDayKey(f.tz);
  const buckets = new Map<string | null, DayAcc>();
  // Streamed row by row: memory is O(distinct days + distinct (day, conversation) pairs), not O(messages).
  const stmt = db.prepare(
    `SELECT ${CONV_KEY} AS ck, m.created_at AS created_at, length(m.text) AS n_chars ${scope.from}${scope.where}`,
  );
  for (const r of stmt.iterate(...scope.params)) {
    const createdAt = strOrNull(r, 'created_at');
    // A timestamp that is not strict ISO-8601 UTC cannot be placed on a day: it joins the "unknown" bucket rather than being guessed.
    const ms = createdAt === null ? null : parseIsoUtcToEpochMs(createdAt);
    const key = ms === null ? null : dayKey(ms);
    let acc = buckets.get(key);
    if (acc === undefined) {
      acc = { messages: 0, characters: 0, firstAt: null, lastAt: null, conversations: new Set() };
      buckets.set(key, acc);
    }
    acc.messages++;
    acc.characters += num(r, 'n_chars');
    const ck = strOrNull(r, 'ck');
    if (ck !== null) acc.conversations.add(ck);
    if (createdAt !== null && ms !== null) {
      const t = normalizeStoredTs(createdAt);
      if (acc.firstAt === null || t < acc.firstAt) acc.firstAt = t;
      if (acc.lastAt === null || t > acc.lastAt) acc.lastAt = t;
    }
  }
  const all: StatsRow[] = [];
  for (const [key, acc] of buckets) {
    all.push({
      key,
      label: key === null ? 'unknown' : key,
      messages: acc.messages,
      conversations: acc.conversations.size,
      characters: acc.characters,
      firstAt: acc.firstAt,
      lastAt: acc.lastAt,
    });
  }
  all.sort(compareDayRows);
  return { rows: all.slice(f.offset, f.offset + f.limit), hasMore: all.length > f.offset + f.limit };
}

// ---------------------------------------------------------------------------------------------------------------
// Totals, provenance, warnings
// ---------------------------------------------------------------------------------------------------------------

function summarize(db: DatabaseSync, f: Filters): Pick<StatsResult, 'totals' | 'modelProvenance'> {
  const scope = messageScope(f);
  const sql =
    'SELECT count(*) AS n_messages, ' +
    `count(DISTINCT ${CONV_KEY}) AS n_conversations, ` +
    'coalesce(sum(length(m.text)), 0) AS n_chars, ' +
    `coalesce(sum(CASE WHEN ${HAS_MODEL} THEN 1 ELSE 0 END), 0) AS with_model, ` +
    `coalesce(sum(CASE WHEN ${HAS_MODEL} THEN 0 ELSE 1 END), 0) AS without_model, ` +
    `coalesce(sum(CASE WHEN m.author_role = 'assistant' AND ${HAS_MODEL} THEN 1 ELSE 0 END), 0) AS a_with, ` +
    `coalesce(sum(CASE WHEN m.author_role = 'assistant' AND NOT ${HAS_MODEL} THEN 1 ELSE 0 END), 0) AS a_without, ` +
    `count(DISTINCT CASE WHEN ${HAS_MODEL} THEN m.model_slug END) AS distinct_models ` +
    `${scope.from}${scope.where}`;
  const r = db.prepare(sql).get(...scope.params) ?? {};
  return {
    totals: { messages: num(r, 'n_messages'), conversations: num(r, 'n_conversations'), characters: num(r, 'n_chars') },
    modelProvenance: {
      messagesWithModel: num(r, 'with_model'),
      messagesWithoutModel: num(r, 'without_model'),
      assistantMessagesWithModel: num(r, 'a_with'),
      assistantMessagesWithoutModel: num(r, 'a_without'),
      distinctModels: num(r, 'distinct_models'),
      note: MODEL_PROVENANCE_NOTE,
    },
  };
}

function countRows(db: DatabaseSync, scope: Scope): number {
  return num(db.prepare(`SELECT count(*) AS n ${scope.from}${scope.where}`).get(...scope.params) ?? {}, 'n');
}

function sampleConversationIds(db: DatabaseSync, scope: Scope, k: number): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT c.conversation_id AS id ${scope.from}${scope.where}ORDER BY c.conversation_id COLLATE BINARY ASC LIMIT ?`)
    .all(...scope.params, k);
  return rows.map((r) => strOrNull(r, 'id') ?? '');
}

/**
 * Honest-scope warnings (FR-09): they tell the reader what the numbers do NOT cover. Ids only, never content.
 * Codes: SUPERSEDED_SNAPSHOTS_INCLUDED, INCOMPLETE_SOURCE, HIDDEN_MESSAGES_EXCLUDED, UNDATED_MESSAGES_EXCLUDED,
 * NO_MATCHING_MESSAGES.
 */
function scopeWarnings(db: DatabaseSync, f: Filters, totalMessages: number): Warning[] {
  const warnings: Warning[] = [];

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
        message: `${superseded} superseded conversation snapshot(s) are included (allBatches); a message that exists in several snapshots is counted once per snapshot.`,
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
      message: `${incomplete} conversation snapshot(s) in scope come from sources whose completeness is not 'exported_tree' (${kinds}); the numbers describe only what those sources contained, not the full history.`,
      ids: sampleConversationIds(db, incompleteScope, SAMPLE_IDS_IN_WARNINGS),
    });
  }

  if (!f.includeHidden) {
    const hidden = countRows(db, messageScope(f, { hidden: 'only' }));
    if (hidden > 0) {
      warnings.push({
        code: 'HIDDEN_MESSAGES_EXCLUDED',
        message: `${hidden} message(s) the source marked hidden are not counted (set includeHidden to count them).`,
      });
    }
  }

  if (f.after !== undefined || f.before !== undefined) {
    const undated = countRows(db, messageScope(f, { dates: false, extraWhere: 'AND m.created_at IS NULL ' }));
    if (undated > 0) {
      warnings.push({
        code: 'UNDATED_MESSAGES_EXCLUDED',
        message: `${undated} message(s) without a timestamp are excluded because a date bound was given; a message with unknown time never matches a bound.`,
      });
    }
  }

  if (totalMessages === 0) {
    warnings.push({ code: 'NO_MATCHING_MESSAGES', message: 'No messages matched the filters; an empty result is not evidence that the source is empty.' });
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------------------------------------------

/**
 * Statistics grouped by `opts.groupBy`. Accepts the raw connection or the Repository. Throws INVALID_ARGUMENT for a bad
 * option and DB_ERROR (content-free) for a database failure. Read-only; deterministic for a given database state.
 */
export function computeStats(db: DatabaseSync | Repository, opts: StatsOptions): StatsResult {
  const handle = resolveDb(db);
  const f = normalizeOptions(opts);
  try {
    return inReadSnapshot(handle, () => {
      const { rows, hasMore } = f.groupBy === 'day' ? dayGroupRows(handle, f) : sqlGroupRows(handle, f);
      const summary = summarize(handle, f);
      const result: StatsResult = {
        groupBy: f.groupBy,
        rows,
        limit: f.limit,
        offset: f.offset,
        nextOffset: hasMore ? f.offset + f.limit : null,
        totals: summary.totals,
        modelProvenance: summary.modelProvenance,
        warnings: scopeWarnings(handle, f, summary.totals.messages),
      };
      if (f.groupBy === 'day') result.tz = f.tz;
      return result;
    });
  } catch (e) {
    throw e instanceof GcrError ? e : toDbError(e);
  }
}
