/**
 * Runtime validation of the provider-neutral domain model (src/domain/types.ts) at the adapter -> db boundary,
 * plus the strict timestamp helpers shared by every adapter.
 *
 * Design rules:
 *  - The zod schemas MIRROR types.ts exactly (compile-time two-way assignability checks at the bottom of this file
 *    fail the build if the two ever drift) and are strict: an unknown key is an error, never silently dropped.
 *  - Failures become `GcrError('IMPORT_PARSE_ERROR')` whose message and details carry ONLY field paths, fixed reason
 *    codes and counts. Conversation text, titles, ids and unknown key names are untrusted content and are never echoed
 *    (zod's own messages are not used for that reason: e.g. "Unrecognized key: <name>" embeds a value).
 *  - Tree anomalies (missing parent, cycles, self-parent, dangling currentNodeId) are NOT validation errors: they are
 *    reported as warnings by branches.ts so a damaged export still imports.
 */
import { z } from 'zod';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import type { AttachmentRef, ContentBlock, ConversationRecord, MessageRecord } from './types.js';

// ------------------------------------------------------------------------------------------
// Limits
// ------------------------------------------------------------------------------------------

/** Longest id of a conversation, message, parent/child pointer, account label or attachment. */
export const MAX_ID_LENGTH = 512;
/** Longest message / block text, measured in UTF-8 bytes (64 MiB). */
export const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_SHORT_STRING = 512; //     roles, model slugs, channels, content types, block types ...
const MAX_TITLE_LENGTH = 8192;
const MAX_URI_LENGTH = 2048;
const MAX_ATTACHMENT_STRING = 4096;
const MAX_WARNING_CODE = 64;
const MAX_WARNING_MESSAGE = 2048;
/** At most this many issues are listed in the error details (the total count is always reported). */
const MAX_REPORTED_ISSUES = 20;

// ------------------------------------------------------------------------------------------
// Timestamps
// ------------------------------------------------------------------------------------------

/** Strict UTC form `YYYY-MM-DDTHH:MM:SS(.fff)Z`: exactly 0 or 3 fractional digits, upper-case `T` and `Z`, no offsets. */
const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

function digits(s: string | undefined): number {
  return s === undefined ? 0 : Number.parseInt(s, 10);
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's days_from_civil). Pure integer arithmetic. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12; // March = 0
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil (Howard Hinnant's civil_from_days) for days >= 0 (1970-01-01 onwards). */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * `YYYY-MM-DDTHH:MM:SS.fffZ` for an integer epoch-millisecond value in 1970..9999. Pure integer arithmetic (no Date
 * object, so nothing here can ever consult a clock or the process time zone).
 */
function epochMsToIso(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const msOfDay = ms - days * 86_400_000;
  const { year, month, day } = civilFromDays(days);
  const hour = Math.floor(msOfDay / 3_600_000);
  const minute = Math.floor((msOfDay % 3_600_000) / 60_000);
  const second = Math.floor((msOfDay % 60_000) / 1000);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(msOfDay % 1000, 3)}Z`;
}

/**
 * Epoch milliseconds for a strict ISO-8601 UTC string, or null when `s` is not exactly that form or names an
 * impossible instant (2025-02-30, hour 24, second 60, ...).
 *
 * WHY not `Date.parse`: for anything outside the exact ISO form its legacy fallback is implementation-defined and a
 * string without `Z` is read as LOCAL time, which would make branch ordering depend on the machine's time zone.
 */
export function parseIsoUtcToEpochMs(s: unknown): number | null {
  if (typeof s !== 'string' || s.length > 24) return null;
  const m = ISO_UTC_RE.exec(s);
  if (m === null) return null;
  const year = digits(m[1]);
  const month = digits(m[2]);
  const day = digits(m[3]);
  const hour = digits(m[4]);
  const minute = digits(m[5]);
  const second = digits(m[6]);
  const millis = digits(m[7]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return daysFromCivil(year, month, day) * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + millis;
}

/** true iff `s` is a string in the strict `YYYY-MM-DDTHH:MM:SS(.fff)Z` form AND a real calendar instant. */
export function isIso8601Utc(s: unknown): s is string {
  return parseIsoUtcToEpochMs(s) !== null;
}

/** Plausibility window for ChatGPT unix-SECONDS timestamps, both ends inclusive. */
export const UNIX_SECONDS_MIN = 1_420_070_400; // 2015-01-01T00:00:00Z
export const UNIX_SECONDS_MAX = 4_102_444_800; // 2100-01-01T00:00:00Z

export type UnixSecondsFailure = 'not_number' | 'non_finite' | 'out_of_range' | 'looks_like_milliseconds';

export interface UnixSecondsResult {
  /** ISO-8601 UTC with millisecond precision, or null. */
  iso: string | null;
  /** Present exactly when `iso` is null. */
  reason?: UnixSecondsFailure;
}

/**
 * ChatGPT exports use unix SECONDS as floats (e.g. 1700000000.123456). Converts to `YYYY-MM-DDTHH:MM:SS.fffZ`
 * (the fraction is rounded to the nearest millisecond). Anything that is not a finite number inside
 * [2015-01-01, 2100-01-01] UTC becomes `{ iso: null, reason }`: GCR never guesses a timestamp. A value that would
 * be plausible if read as milliseconds is reported as `looks_like_milliseconds` but is NOT converted.
 * Numeric strings are rejected (`not_number`): the source format is a JSON number.
 */
export function unixSecondsToIso(value: unknown): UnixSecondsResult {
  if (typeof value !== 'number') return { iso: null, reason: 'not_number' };
  if (!Number.isFinite(value)) return { iso: null, reason: 'non_finite' };
  if (value < UNIX_SECONDS_MIN || value > UNIX_SECONDS_MAX) {
    const asSeconds = value / 1000;
    const reason = asSeconds >= UNIX_SECONDS_MIN && asSeconds <= UNIX_SECONDS_MAX ? 'looks_like_milliseconds' : 'out_of_range';
    return { iso: null, reason };
  }
  return { iso: epochMsToIso(Math.round(value * 1000)) };
}

// ------------------------------------------------------------------------------------------
// Field-level building blocks
// ------------------------------------------------------------------------------------------

/** C0 controls (incl. NUL) and DEL: never legitimate inside a machine identifier. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const noNul = (s: string): boolean => !s.includes('\u0000');

/** Free-form string: bounded, no NUL (NUL breaks C-string consumers and SQLite text functions). */
function boundedString(max: number, min = 0) {
  return z.string().min(min).max(max).refine(noNul, { message: 'contains_nul' });
}

/** Machine identifier: non-empty, bounded, no control characters (they would forge lines in text/markdown output). */
function identifier(max: number = MAX_ID_LENGTH) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !CONTROL_RE.test(s), { message: 'control_character' });
}

const isoTimestamp = z.string().refine(isIso8601Utc, { message: 'invalid_timestamp' });

/**
 * Text is bounded in UTF-8 BYTES. `.max(MAX_TEXT_BYTES)` on the UTF-16 length is a cheap pre-filter that is always
 * safe (bytes >= length); the exact byte count is only computed when the string could possibly exceed the limit.
 */
function withinByteLimit(s: string): boolean {
  return s.length * 3 <= MAX_TEXT_BYTES || Buffer.byteLength(s, 'utf8') <= MAX_TEXT_BYTES;
}
const boundedText = z
  .string()
  .max(MAX_TEXT_BYTES)
  .refine(noNul, { message: 'contains_nul' })
  .refine(withinByteLimit, { message: 'text_too_large' });

/**
 * `presentInExportAs` names an entry of the import ZIP. It is never used as a filesystem path, but a hostile value
 * must not survive validation and later reach a path join: no absolute paths, drive letters, backslashes, `..`
 * segments or control characters.
 */
function isSafeArchiveRelativePath(p: string): boolean {
  if (p.length === 0 || CONTROL_RE.test(p)) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').includes('..');
}

// ------------------------------------------------------------------------------------------
// Schemas (mirror src/domain/types.ts)
// ------------------------------------------------------------------------------------------

export const attachmentRefSchema = z.strictObject({
  id: identifier().nullable(),
  name: boundedString(MAX_ATTACHMENT_STRING).nullable(),
  mimeType: boundedString(MAX_SHORT_STRING).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  assetPointer: boundedString(MAX_ATTACHMENT_STRING).nullable(),
  presentInExportAs: boundedString(MAX_ATTACHMENT_STRING, 1)
    .refine(isSafeArchiveRelativePath, { message: 'unsafe_archive_path' })
    .nullable(),
});

export const contentBlockSchema = z.strictObject({
  type: boundedString(MAX_SHORT_STRING, 1),
  text: boundedText.optional(),
  metadata: z.unknown().optional(),
});

const warningSchema = z.strictObject({
  code: boundedString(MAX_WARNING_CODE, 1),
  message: boundedString(MAX_WARNING_MESSAGE),
  // Warning ids may name dangling references copied from a damaged export, so they get the weaker no-NUL rule.
  ids: z.array(boundedString(MAX_ID_LENGTH)).optional(),
});

export const messageRecordSchema = z
  .strictObject({
    id: identifier(),
    conversationId: identifier(),
    // Non-null parent pointers must be (non-empty) strings. A dangling or self pointer is a branches.ts warning, not an error.
    parentId: identifier().nullable(),
    childIds: z.array(identifier()),
    nodeKind: z.enum(['message', 'structural_empty']),
    authorRole: boundedString(MAX_SHORT_STRING),
    authorName: boundedString(MAX_SHORT_STRING).nullable(),
    modelSlug: boundedString(MAX_SHORT_STRING).nullable(),
    channel: boundedString(MAX_SHORT_STRING).nullable(),
    recipient: boundedString(MAX_SHORT_STRING).nullable(),
    contentType: boundedString(MAX_SHORT_STRING).nullable(),
    status: boundedString(MAX_SHORT_STRING).nullable(),
    hidden: z.boolean(),
    createdAt: isoTimestamp.nullable(),
    updatedAt: isoTimestamp.nullable(),
    text: boundedText,
    blocks: z.array(contentBlockSchema),
    attachments: z.array(attachmentRefSchema),
    ordinal: z.number().int().nonnegative(),
    rawSource: z.unknown().optional(),
  })
  .superRefine((m, ctx) => {
    // zod skips this callback when a field has a TYPE error, so `m` is well-typed here.
    if (m.nodeKind === 'structural_empty') {
      // A structural node (e.g. ChatGPT's client-created root) is a pure placeholder: it must not carry content.
      if (m.authorRole !== '') ctx.addIssue({ code: 'custom', path: ['authorRole'], message: 'structural_node_has_role' });
      if (m.text !== '') ctx.addIssue({ code: 'custom', path: ['text'], message: 'structural_node_has_text' });
      if (m.blocks.length !== 0) ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'structural_node_has_blocks' });
    }
    if (m.childIds.length > 1 && new Set(m.childIds).size !== m.childIds.length) {
      ctx.addIssue({ code: 'custom', path: ['childIds'], message: 'duplicate_child_id' });
    }
  });

export const conversationRecordSchema = z
  .strictObject({
    provider: z.enum(['chatgpt', 'claude', 'openai_api']),
    accountLabel: identifier(),
    id: identifier(),
    title: boundedString(MAX_TITLE_LENGTH).nullable(),
    sourceUri: boundedString(MAX_URI_LENGTH).nullable(),
    provenance: z.enum([
      'official_chatgpt_export',
      'user_supplied_copy',
      'manual_browser_capture',
      'openai_developer_api',
      'official_claude_export',
    ]),
    completeness: z.enum(['exported_tree', 'rendered_active_view_only', 'partial_user_supplied', 'api_owned_conversation', 'unknown']),
    importedAt: isoTimestamp,
    createdAt: isoTimestamp.nullable(),
    updatedAt: isoTimestamp.nullable(),
    currentNodeId: identifier().nullable(),
    defaultModelSlug: boundedString(MAX_SHORT_STRING).nullable(),
    messages: z.array(messageRecordSchema),
    rawMetadata: z.unknown().optional(),
    warnings: z.array(warningSchema),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.messages.forEach((m, i) => {
      // Message identity is (provider, account, conversation, message id): a repeated id would silently overwrite
      // (or, with ON CONFLICT DO NOTHING, silently drop) content, so it is rejected.
      if (seen.has(m.id)) ctx.addIssue({ code: 'custom', path: ['messages', i, 'id'], message: 'duplicate_message_id' });
      seen.add(m.id);
      // A message that names another conversation would be stored under the wrong key.
      if (m.conversationId !== c.id) ctx.addIssue({ code: 'custom', path: ['messages', i, 'conversationId'], message: 'conversation_id_mismatch' });
    });
  });

// ------------------------------------------------------------------------------------------
// Compile-time proof that the schemas mirror types.ts (both directions). A drift fails `tsc`.
// ------------------------------------------------------------------------------------------

type AssertAssignable<_Sub extends Super, Super> = true;
export type SchemaMirrorsTypes = [
  AssertAssignable<z.infer<typeof attachmentRefSchema>, AttachmentRef>,
  AssertAssignable<AttachmentRef, z.infer<typeof attachmentRefSchema>>,
  AssertAssignable<z.infer<typeof contentBlockSchema>, ContentBlock>,
  AssertAssignable<ContentBlock, z.infer<typeof contentBlockSchema>>,
  AssertAssignable<z.infer<typeof messageRecordSchema>, MessageRecord>,
  AssertAssignable<MessageRecord, z.infer<typeof messageRecordSchema>>,
  AssertAssignable<z.infer<typeof conversationRecordSchema>, ConversationRecord>,
  AssertAssignable<ConversationRecord, z.infer<typeof conversationRecordSchema>>,
  AssertAssignable<z.infer<typeof warningSchema>, Warning>,
  AssertAssignable<Warning, z.infer<typeof warningSchema>>,
];

// ------------------------------------------------------------------------------------------
// validateConversationRecord
// ------------------------------------------------------------------------------------------

/** Fixed vocabulary of reasons our own refinements can report; anything else is reported as plain 'custom'. */
const CUSTOM_REASONS: ReadonlySet<string> = new Set([
  'contains_nul',
  'control_character',
  'invalid_timestamp',
  'text_too_large',
  'unsafe_archive_path',
  'structural_node_has_role',
  'structural_node_has_text',
  'structural_node_has_blocks',
  'duplicate_child_id',
  'duplicate_message_id',
  'conversation_id_mismatch',
]);

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `messages[3].createdAt`. Field names come from the schemas; anything else is masked so no input text can leak. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (typeof seg === 'string' && FIELD_NAME_RE.test(seg) && seg.length <= 40) out += out === '' ? seg : `.${seg}`;
    else out += '[key]';
  }
  return out === '' ? '$' : out;
}

function messageCountOf(x: unknown): number | null {
  try {
    if (typeof x !== 'object' || x === null) return null;
    const messages = (x as { messages?: unknown }).messages;
    return Array.isArray(messages) ? messages.length : null;
  } catch {
    return null; // an accessor threw: report no count rather than failing while reporting a failure
  }
}

/**
 * Validates an untrusted `ConversationRecord` (e.g. produced by an adapter from a hostile export) and returns the
 * validated value. On failure throws IMPORT_PARSE_ERROR with `details = { issueCount, fieldPathCount, issues:
 * [{ path, reason }] (first 20), truncated, messageCount }`: field paths, reason codes and counts only.
 *
 * The RETURNED object is zod's parsed copy, not `x`: if `x` is an exotic object with getters that change between
 * reads, what was validated is exactly what the caller gets (no check-then-use gap). `rawSource` / `rawMetadata` /
 * block `metadata` are opaque and returned by reference.
 */
export function validateConversationRecord(x: unknown): ConversationRecord {
  let result: ReturnType<typeof conversationRecordSchema.safeParse>;
  try {
    result = conversationRecordSchema.safeParse(x);
  } catch {
    // Exotic input (a getter or Proxy that throws) escapes zod as an exception. Report it as a parse error WITHOUT
    // the original exception: its message could embed attacker-controlled text.
    throw new GcrError('IMPORT_PARSE_ERROR', 'Conversation record could not be read (an accessor threw).', {
      details: { issueCount: 1, fieldPathCount: 1, issues: [{ path: '$', reason: 'unreadable' }], truncated: false, messageCount: null },
    });
  }
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    reason: issue.code === 'custom' ? (CUSTOM_REASONS.has(issue.message) ? issue.message : 'custom') : issue.code,
  }));
  const fieldPathCount = new Set(issues.map((i) => i.path)).size;
  const first = issues[0];
  const where = first === undefined ? '$' : `${first.path} (${first.reason})`;
  throw new GcrError(
    'IMPORT_PARSE_ERROR',
    `Conversation record failed validation: ${issues.length} issue(s) in ${fieldPathCount} field path(s); first at ${where}.`,
    {
      remedy: 'This indicates a malformed or hostile export or an adapter bug. Field values are intentionally not shown; inspect the listed field paths.',
      details: {
        issueCount: issues.length,
        fieldPathCount,
        issues: issues.slice(0, MAX_REPORTED_ISSUES),
        truncated: issues.length > MAX_REPORTED_ISSUES,
        messageCount: messageCountOf(x),
      },
    },
  );
}
