/**
 * ClaudeExportAdapter: normalizes ONE conversation element of an official Claude data export (`conversations.json`)
 * into the provider-neutral ConversationRecord (SPEC FR-14 "same provider-neutral schema; provenance never lost").
 * Documented in docs/ADAPTERS.md.
 *
 * Data shape: the field names come from the documented DATA SHAPE inventory in the research notes (conversation
 * `uuid`/`name`/`summary`/`created_at`/`updated_at`/`account`/`chat_messages[]`; message `uuid`/`sender`/`text`/`content[]`/
 * `attachments[]`/`files[]`/`created_at`/`updated_at`, optional `parent_message_uuid`). No CCR code is used (ADR-0008).
 * Real Claude exports were not available while this was written, so every statement about the format is
 * `synthetic-only` (see docs/ADAPTERS.md); unknown fields are therefore preserved, never dropped.
 *
 * Rules (each one is covered by test/ingest/claude-export*.test.ts):
 *  - sender "human" -> authorRole "user" (exact match only); every other sender string is kept verbatim; the original
 *    sender always stays in `rawSource`.
 *  - Tree: the linear chain in file order, UNLESS any message carries an explicit `parent_message_uuid` key, in which
 *    case the pointers win for every message (no guessing for messages without one).
 *  - Completeness is `rendered_active_view_only` with warning LINEAR_EXPORT_ACTIVE_BRANCH_ONLY: the export holds one
 *    thread per conversation, so alternate branches, edits and regenerations are NOT part of it.
 *  - `currentNodeId` is the last message ONLY because the structure is a single chain (one thread by construction).
 *    If explicit pointers describe anything else (several leaves, cycle, ...) it is null + ACTIVE_BRANCH_UNKNOWN: GCR
 *    never guesses an active branch (ADR-0009).
 *  - `modelSlug` is null unless THAT message carries a string `model`; a conversation-level `model` only fills
 *    `defaultModelSlug` and is never copied onto messages (FR-16).
 *  - `thinking` blocks become `thoughts` blocks with `metadata.hidden === true` (ContentBlock is a strict schema with
 *    no `hidden` key, so the flag lives in metadata); they are never part of `message.text`.
 *  - Attachment `extracted_content` is kept as an `attachment_text` block and is NOT merged into `message.text`.
 *  - Ids with control characters or unpaired surrogates are unusable and get deterministic replacements; they are never
 *    "repaired" (a lossy repair would merge distinct ids). Duplicate message uuids get `~dupN` suffixes in linear time.
 *  - Output is bounded per conversation (MAX_ITEMS_PER_CONVERSATION blocks/attachments) as well as per message, and the
 *    text composed from several text blocks is capped like every other body.
 *  - Nothing the source said is lost without a trace: a `chat_messages` entry that is not an object is not a message, but
 *    its raw value is kept (bounded) in rawMetadata._gcr, and repeated JSON keys (which JSON.parse silently collapses to
 *    the last value) are counted from the raw text and reported as DUPLICATE_KEY.
 *
 * Security: the element is untrusted DATA. All object access is by own-property lookup; keys that come from the
 * input are never used to build objects or SQL; ids are looked up in Maps/Sets (so `__proto__` is just a string);
 * every walker is iterative (no recursion depth attacks); warning messages are fixed text and carry ids/counts only.
 * Pure: no I/O, no clock, no randomness.
 */
import { createHash } from 'node:crypto';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { isUuid } from '../domain/ids.js';
import type { AttachmentRef, ContentBlock, ConversationRecord, MessageRecord } from '../domain/types.js';
import { MAX_ID_LENGTH, MAX_TEXT_BYTES, isIso8601Utc, parseIsoUtcToEpochMs, unixSecondsToIso } from '../domain/validate.js';
import type { UnixSecondsFailure } from '../domain/validate.js';
import type { AdapterContext, AdapterOutcome, ConversationSourceAdapter, FormatObservations } from './adapter.js';

// ------------------------------------------------------------------------------------------
// Limits and vocabulary
// ------------------------------------------------------------------------------------------

/** Root sentinel seen in Claude data: a parent pointer with this value means "no parent" (unless a message really has this id). */
export const CLAUDE_ROOT_SENTINEL = '00000000-0000-4000-8000-000000000000';
/** Deepest JSON nesting accepted inside one element. JSON.stringify (used by the DB layer for raw JSON) throws RangeError far deeper. */
export const MAX_JSON_DEPTH = 128;
/** Output records are larger than their input (a 2-byte `{}` becomes a full MessageRecord), so the amplification is bounded. */
export const MAX_MESSAGES_PER_CONVERSATION = 500_000;
export const MAX_BLOCKS_PER_MESSAGE = 50_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5_000;
/**
 * Content blocks + attachment refs + attachment-text blocks converted per CONVERSATION. The per-message caps alone
 * leave the product unbounded (500 000 messages x 50 000 blocks): a 15 MB element of `1`s measured ~550 MB of block
 * objects (~36x), so a 256 MiB element would need ~9 GB. Beyond the budget the content is only in `rawSource`.
 */
export const MAX_ITEMS_PER_CONVERSATION = 2_000_000;
/** Raw values of skipped (non-object) chat_messages entries kept in rawMetadata._gcr; the rest is only counted (the element SHA-256 covers it). */
export const MAX_PRESERVED_SKIPPED_ENTRIES = 1000;
/** Nesting levels (root = 1) whose object keys are compared for duplicates; deeper structures (tool inputs, citations) are not. */
export const DUPLICATE_KEY_TRACK_DEPTH = 12;
/** Distinct keys remembered per object while looking for duplicates; an object with more keys is only checked for its first ones. */
export const DUPLICATE_KEY_TRACK_KEYS = 10_000;
/** Purely informational warnings start with this prefix (same convention as src/ingest/chatgpt-export.ts). */
export const INFO_PREFIX = '[info] ';
/** At most this many ids are listed per warning code (the total count is always reported). */
export const MAX_WARNING_IDS = 50;
/** Appended when a text exceeds MAX_TEXT_BYTES so that truncation is explicit, never silent. */
export const TEXT_TRUNCATION_MARKER = '\n[GCR: text truncated at the size limit]';

// These three mirror private constants of src/domain/validate.ts; the validator stays the authority
// (the property tests prove that no output ever exceeds them).
const MAX_SHORT_STRING = 512; //     roles, model slugs, mime types, block types
const MAX_TITLE_LENGTH = 8192;
const MAX_ATTACHMENT_STRING = 4096;

/** Warning codes emitted by this adapter (documented in docs/ADAPTERS.md). Tree anomalies are left to branches.ts. */
export const CLAUDE_WARNING_CODES = {
  LINEAR_EXPORT_ACTIVE_BRANCH_ONLY: 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY',
  CHILDREN_ABSENT: 'CHILDREN_ABSENT',
  ACTIVE_BRANCH_UNKNOWN: 'ACTIVE_BRANCH_UNKNOWN',
  CONVERSATION_ID_MISSING: 'CONVERSATION_ID_MISSING',
  CONVERSATION_ID_INVALID: 'CONVERSATION_ID_INVALID',
  ID_CASE_NORMALIZED: 'ID_CASE_NORMALIZED',
  MESSAGE_ID_MISSING: 'MESSAGE_ID_MISSING',
  MESSAGE_ID_INVALID: 'MESSAGE_ID_INVALID',
  DUPLICATE_MESSAGE_ID: 'DUPLICATE_MESSAGE_ID',
  NON_OBJECT_MESSAGE: 'NON_OBJECT_MESSAGE',
  PARENT_POINTER_ABSENT: 'PARENT_POINTER_ABSENT',
  INVALID_PARENT_POINTER: 'INVALID_PARENT_POINTER',
  SENDER_MISSING: 'SENDER_MISSING',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  INVALID_TITLE: 'INVALID_TITLE',
  INVALID_MODEL_SLUG: 'INVALID_MODEL_SLUG',
  INVALID_TEXT_FIELD: 'INVALID_TEXT_FIELD',
  INVALID_CONTENT: 'INVALID_CONTENT',
  UNKNOWN_CONTENT_TYPE: 'UNKNOWN_CONTENT_TYPE',
  MALFORMED_CONTENT_BLOCK: 'MALFORMED_CONTENT_BLOCK',
  TEXT_FIELD_MISMATCH: 'TEXT_FIELD_MISMATCH',
  INVALID_ATTACHMENT: 'INVALID_ATTACHMENT',
  INVALID_ATTACHMENT_FIELD: 'INVALID_ATTACHMENT_FIELD',
  NUL_STRIPPED: 'NUL_STRIPPED',
  LONE_SURROGATE: 'LONE_SURROGATE',
  FIELD_TRUNCATED: 'FIELD_TRUNCATED',
  TEXT_TRUNCATED: 'TEXT_TRUNCATED',
  BLOCKS_TRUNCATED: 'BLOCKS_TRUNCATED',
  ATTACHMENTS_TRUNCATED: 'ATTACHMENTS_TRUNCATED',
  FOREIGN_PROVIDER_MARKER: 'FOREIGN_PROVIDER_MARKER',
  DUPLICATE_KEY: 'DUPLICATE_KEY',
} as const;

const W = CLAUDE_WARNING_CODES;

type JsonObject = Record<string, unknown>;

// ------------------------------------------------------------------------------------------
// Safe readers
// ------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Own-property read: an inherited property (`constructor`, `toString`, ...) is never mistaken for source data. */
function own(obj: JsonObject, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// ------------------------------------------------------------------------------------------
// Warnings: aggregated per code so a hostile 50k-message conversation cannot produce 50k Warning objects.
// ------------------------------------------------------------------------------------------

interface WarningEntry {
  message: string;
  count: number;
  ids: string[];
  idSet: Set<string>;
}

class WarningLog {
  private readonly entries = new Map<string, WarningEntry>();

  /** `message` must be FIXED text: warnings never carry conversation content. `id` is a conversation/message id. `times` counts several occurrences at once. */
  add(code: string, message: string, id?: string, times = 1): void {
    let entry = this.entries.get(code);
    if (entry === undefined) {
      entry = { message, count: 0, ids: [], idSet: new Set() };
      this.entries.set(code, entry);
    }
    entry.count += times;
    if (id !== undefined && !entry.idSet.has(id)) {
      entry.idSet.add(id);
      if (entry.ids.length < MAX_WARNING_IDS) entry.ids.push(id);
    }
  }

  /** Map insertion order = order of first occurrence, which is deterministic for a given input. */
  toArray(): Warning[] {
    const out: Warning[] = [];
    for (const [code, e] of this.entries) {
      let message = e.count > 1 ? `${e.message} (${e.count} occurrences)` : e.message;
      if (e.idSet.size > e.ids.length) message += ` (first ${MAX_WARNING_IDS} ids listed)`;
      out.push(e.ids.length > 0 ? { code, message, ids: [...e.ids] } : { code, message });
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------
// Sanitization (same policy as the ChatGPT adapter: NUL stripped, lone surrogates -> U+FFFD, hard size caps)
// ------------------------------------------------------------------------------------------

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. No `u` flag: code UNITS are inspected. */
const LONE_SURROGATE_SOURCE = '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]';
const LONE_SURROGATE_TEST = new RegExp(LONE_SURROGATE_SOURCE);
const LONE_SURROGATE_ALL = new RegExp(LONE_SURROGATE_SOURCE, 'g');
/** C0 controls (incl. NUL) and DEL: invalid inside an identifier (they would forge lines in text output). */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface SanitizeResult {
  value: string;
  nulStripped: boolean;
  loneSurrogates: boolean;
}

/**
 * WHY: NUL breaks C-string consumers and SQLite text functions; a lone surrogate cannot be encoded as UTF-8 and the
 * database would silently turn it into U+FFFD (two different strings could then collide). Doing it here makes the
 * replacement explicit, deterministic and reported. NUL is removed BEFORE surrogate repair so the function is idempotent.
 */
export function sanitizeString(s: string): SanitizeResult {
  let value = s;
  let nulStripped = false;
  let loneSurrogates = false;
  if (value.includes('\u0000')) {
    nulStripped = true;
    value = value.replaceAll('\u0000', '');
  }
  if (LONE_SURROGATE_TEST.test(value)) {
    loneSurrogates = true;
    value = value.replace(LONE_SURROGATE_ALL, '\uFFFD');
  }
  return { value, nulStripped, loneSurrogates };
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function capUnits(s: string, max: number): { value: string; truncated: boolean } {
  if (s.length <= max) return { value: s, truncated: false };
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // the pair's low half would be cut off
  return { value: s.slice(0, end), truncated: true };
}

/**
 * Limit `s` (well-formed) to `maxBytes` of UTF-8 INCLUDING the marker, cutting on a character boundary. The cheap
 * length pre-check mirrors validate.ts: a string of at most maxBytes/3 units can never exceed the byte limit.
 */
export function truncateUtf8(s: string, maxBytes: number, marker: string = TEXT_TRUNCATION_MARKER): { value: string; truncated: boolean } {
  if (s.length * 3 <= maxBytes || Buffer.byteLength(s, 'utf8') <= maxBytes) return { value: s, truncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const buf = Buffer.from(s, 'utf8');
  let end = Math.min(budget, buf.length);
  // buf[end] is the first byte that is NOT kept. A continuation byte (10xxxxxx) there means we stand inside a character.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { value: buf.subarray(0, end).toString('utf8') + marker, truncated: true };
}

/** Room left for "~dupNNNNNN" (10 units) under the 512-unit id limit; ids sharing this stem share one suffix counter. */
const DUP_STEM_UNITS = MAX_ID_LENGTH - 16;

const SANITIZED_NOTE = 'the original value is kept in rawSource/rawMetadata';

/** Strip NUL, repair surrogates and report. Does not cap. */
function cleanString(log: WarningLog, raw: string, id: string): string {
  const r = sanitizeString(raw);
  if (r.nulStripped) log.add(W.NUL_STRIPPED, `NUL characters were removed from a text field (${SANITIZED_NOTE}).`, id);
  if (r.loneSurrogates) log.add(W.LONE_SURROGATE, `Unpaired UTF-16 surrogates were replaced with U+FFFD in a text field (${SANITIZED_NOTE}).`, id);
  return r.value;
}

/** Short free-form field (role, model, mime type, title, file name): sanitized and capped in UTF-16 units. */
function cleanBounded(log: WarningLog, raw: string, maxUnits: number, id: string): string {
  const capped = capUnits(cleanString(log, raw, id), maxUnits);
  if (capped.truncated) log.add(W.FIELD_TRUNCATED, `A field longer than its limit was truncated (${SANITIZED_NOTE}).`, id);
  return capped.value;
}

/** Message / block body: sanitized and capped at MAX_TEXT_BYTES UTF-8 bytes with an explicit marker. */
function cleanBody(log: WarningLog, raw: string, id: string): string {
  const t = truncateUtf8(cleanString(log, raw, id), MAX_TEXT_BYTES);
  if (t.truncated) log.add(W.TEXT_TRUNCATED, `A text longer than the size limit was truncated and marked (${SANITIZED_NOTE}).`, id);
  return t.value;
}

/**
 * A usable identifier: non-empty, <= 512 units, no control characters (NUL included) and no unpaired surrogates.
 * Returns null when `raw` cannot be an id; the caller decides between "missing" and "invalid".
 *
 * WHY unpaired surrogates are NOT repaired (unlike text): repairing maps many different ids to the same U+FFFD string
 * ("a\uD800" and "a\uD801" would both become "a\uFFFD"), which would silently merge two conversations (or make a
 * parent pointer match the wrong message). An unusable id gets a deterministic distinct replacement instead, exactly
 * like the ChatGPT adapter's isSafeId().
 */
function cleanId(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ID_LENGTH || CONTROL_RE.test(raw) || LONE_SURROGATE_TEST.test(raw)) return null;
  return raw;
}

/** `base` + `suffix` within the id length limit (the base is shortened, never the suffix, so ids stay unique). */
function withSuffix(base: string, suffix: string): string {
  return capUnits(base, MAX_ID_LENGTH - suffix.length).value + suffix;
}

// ------------------------------------------------------------------------------------------
// Timestamps
// ------------------------------------------------------------------------------------------

/**
 * ISO-8601 with a MANDATORY zone designator (`Z` or +-HH[:MM]) and 1..9 fractional digits. A zone-less time is local
 * time of an unknown zone: reading it as UTC would be a guess, so it is rejected (null + warning).
 */
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)$/;

export type TimestampFailure = 'not_string' | 'bad_format' | 'impossible_date' | 'bad_offset' | UnixSecondsFailure;

/**
 * Claude exports use ISO-8601 strings with microseconds (`2025-03-04T05:06:07.123456Z`). Result: the strict GCR form
 * `YYYY-MM-DDTHH:MM:SS.fffZ` (UTC; extra fraction digits are truncated, not rounded; offsets are applied), or null.
 * Pure integer arithmetic: no Date object, so neither the clock nor the process time zone can matter. The same
 * plausibility window as the ChatGPT adapter (2015..2100) applies via unixSecondsToIso. Numbers are NOT accepted: the
 * format is a string and a number's unit would be a guess.
 */
export function normalizeClaudeTimestamp(value: unknown): { iso: string | null; reason?: TimestampFailure } {
  if (typeof value !== 'string') return { iso: null, reason: 'not_string' };
  if (value.length > 64) return { iso: null, reason: 'bad_format' };
  const m = TIMESTAMP_RE.exec(value);
  if (m === null) return { iso: null, reason: 'bad_format' };
  const part = (i: number): string => m[i] ?? '';
  const millis = part(7).padEnd(3, '0').slice(0, 3);
  const localMs = parseIsoUtcToEpochMs(`${part(1)}-${part(2)}-${part(3)}T${part(4)}:${part(5)}:${part(6)}.${millis}Z`);
  if (localMs === null) return { iso: null, reason: 'impossible_date' };
  let offsetMinutes = 0;
  if (m[9] !== undefined) {
    const hours = Number.parseInt(part(10), 10);
    const minutes = part(11) === '' ? 0 : Number.parseInt(part(11), 10);
    if (hours > 23 || minutes > 59) return { iso: null, reason: 'bad_offset' };
    offsetMinutes = (m[9] === '-' ? -1 : 1) * (hours * 60 + minutes);
  }
  // ms/1000*1000 is exact after rounding for every epoch in the plausibility window (error << 0.5 ms).
  const converted = unixSecondsToIso((localMs - offsetMinutes * 60_000) / 1000);
  return converted.iso !== null ? { iso: converted.iso } : { iso: null, reason: converted.reason ?? 'out_of_range' };
}

function readTimestamp(log: WarningLog, raw: unknown, id: string): string | null {
  if (raw === undefined || raw === null) return null; // absent: unknown stays unknown
  const r = normalizeClaudeTimestamp(raw);
  if (r.iso === null) log.add(W.INVALID_TIMESTAMP, 'A timestamp was not a valid zone-qualified ISO-8601 instant in the supported range and was recorded as null.', id);
  return r.iso;
}

// ------------------------------------------------------------------------------------------
// JSON depth guard
// ------------------------------------------------------------------------------------------

/**
 * true when `root` nests objects/arrays deeper than `maxDepth` (root = depth 1). Iterative on purpose: V8's JSON.parse
 * accepts nesting a recursive walker (or JSON.stringify, used later for raw storage) would overflow the stack on.
 */
export function jsonDepthExceeds(root: unknown, maxDepth: number): boolean {
  const stack: unknown[] = [root];
  const depths: number[] = [1];
  while (stack.length > 0) {
    const value = stack.pop();
    const depth = depths.pop() ?? 1;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > maxDepth) return true;
    const children: unknown[] = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (typeof child === 'object' && child !== null) {
        stack.push(child);
        depths.push(depth + 1);
      }
    }
  }
  return false;
}

// ------------------------------------------------------------------------------------------
// Duplicate keys (invisible after JSON.parse)
// ------------------------------------------------------------------------------------------

function decodeJsonKey(rawBody: string): string {
  try {
    const v: unknown = JSON.parse(`"${rawBody}"`);
    return typeof v === 'string' ? v : rawBody;
  } catch {
    return rawBody; // unreachable for text that JSON.parse already accepted as a whole; never lose the key
  }
}

/**
 * How many object keys repeat inside an object of the (already valid) JSON `text`.
 *
 * WHY: `JSON.parse` keeps only the LAST of two equal keys, so a repeated `chat_messages` hides the first array, a repeated
 * `sender` flips a role, and a differential parser (first-wins) would see another conversation: none of it would leave a
 * trace. Keys are compared after JSON decoding (`"a"` equals `"\u0061"`). The scan is one left-to-right pass with an
 * explicit frame stack (no recursion, no regular expressions), string contents are skipped with `indexOf` plus
 * backslash-parity counting (so a string VALUE that looks like `"a":1,"a":2` is never read as keys), and it is bounded:
 * only the first DUPLICATE_KEY_TRACK_DEPTH levels are compared and at most DUPLICATE_KEY_TRACK_KEYS distinct keys are
 * remembered per object. Pure and deterministic.
 */
export function countDuplicateKeys(text: string): number {
  const n = text.length;
  // One entry per tracked open container: the keys seen so far for an object, null for an array.
  const keysOf: Array<Set<string> | null> = [];
  const expectKey: boolean[] = [];
  let untracked = 0; // open containers below the tracked depth
  let duplicates = 0;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      let end = i + 1;
      for (;;) {
        const q = text.indexOf('"', end);
        if (q === -1) {
          end = n;
          break;
        }
        let back = q - 1;
        while (back > i && text.charCodeAt(back) === 0x5c) back--;
        if (((q - 1 - back) & 1) === 0) {
          end = q;
          break;
        }
        end = q + 1;
      }
      const top = keysOf.length - 1;
      if (untracked === 0 && top >= 0 && expectKey[top] === true) {
        expectKey[top] = false;
        const keys = keysOf[top];
        if (keys !== null && keys !== undefined) {
          let key = text.slice(i + 1, end);
          if (key.includes('\\')) key = decodeJsonKey(key);
          if (keys.has(key)) duplicates++;
          else if (keys.size < DUPLICATE_KEY_TRACK_KEYS) keys.add(key);
        }
      }
      i = end + 1;
      continue;
    }
    if (c === 0x7b || c === 0x5b) {
      if (untracked > 0 || keysOf.length >= DUPLICATE_KEY_TRACK_DEPTH) {
        untracked++;
      } else {
        keysOf.push(c === 0x7b ? new Set<string>() : null);
        expectKey.push(c === 0x7b);
      }
    } else if (c === 0x7d || c === 0x5d) {
      if (untracked > 0) {
        untracked--;
      } else {
        keysOf.pop();
        expectKey.pop();
      }
    } else if (c === 0x2c && untracked === 0) {
      const top = keysOf.length - 1;
      if (top >= 0 && keysOf[top] !== null) expectKey[top] = true;
    }
    i++;
  }
  return duplicates;
}

// ------------------------------------------------------------------------------------------
// Content blocks
// ------------------------------------------------------------------------------------------

function optionalBoundedString(log: WarningLog, raw: unknown, max: number, id: string): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = cleanBounded(log, raw, max, id);
  return cleaned === '' ? null : cleaned;
}

/**
 * One FIXED text for the code: warnings are aggregated per code and keep the message of the FIRST occurrence, so a message that
 * named one malformed shape would misdescribe the others counted under the same code.
 */
const MALFORMED_BLOCK_MESSAGE =
  'A content block is malformed (a block without a string "type", or a text/thinking/voice_note block without a text string); it is kept without text or as an "unknown" block with the raw value, and the raw message is in rawSource.';

function textBlock(log: WarningLog, raw: JsonObject, id: string): ContentBlock {
  const t = own(raw, 'text');
  if (typeof t === 'string') return { type: 'text', text: cleanBody(log, t, id) };
  log.add(W.MALFORMED_CONTENT_BLOCK, MALFORMED_BLOCK_MESSAGE, id);
  return { type: 'text' };
}

function thinkingBlock(log: WarningLog, raw: JsonObject, id: string): ContentBlock {
  // `thinking` is the documented key; `text` is accepted defensively. The block is HIDDEN by default: it is model
  // reasoning, never part of message.text, and renderers must exclude it unless the operator opts in.
  const body = own(raw, 'thinking') ?? own(raw, 'text');
  const metadata = { hidden: true, sourceType: 'thinking' };
  if (typeof body === 'string') return { type: 'thoughts', text: cleanBody(log, body, id), metadata };
  // The unusable body stays in rawSource; the block is kept (still hidden) and the loss of its text is reported.
  log.add(W.MALFORMED_CONTENT_BLOCK, MALFORMED_BLOCK_MESSAGE, id);
  return { type: 'thoughts', metadata };
}

function toolUseBlock(log: WarningLog, raw: JsonObject, id: string): ContentBlock {
  const metadata: Record<string, unknown> = {
    sourceType: 'tool_use',
    toolName: optionalBoundedString(log, own(raw, 'name'), MAX_SHORT_STRING, id),
    toolUseId: optionalBoundedString(log, own(raw, 'id'), MAX_SHORT_STRING, id),
  };
  if (Object.hasOwn(raw, 'input')) metadata['input'] = raw['input']; // JSON value kept by reference (depth already capped)
  return { type: 'tool_use', metadata };
}

function toolResultBlock(log: WarningLog, raw: JsonObject, id: string): ContentBlock {
  const metadata: Record<string, unknown> = {
    sourceType: 'tool_result',
    toolUseId: optionalBoundedString(log, own(raw, 'tool_use_id'), MAX_SHORT_STRING, id),
    toolName: optionalBoundedString(log, own(raw, 'name'), MAX_SHORT_STRING, id),
    isError: typeof own(raw, 'is_error') === 'boolean' ? own(raw, 'is_error') : null,
  };
  // Nested result content is kept (CCR's importer dropped it; research defect D-05): nested text becomes the block
  // text, anything that is not plain text is preserved untouched under metadata.nonTextContent.
  const nested = own(raw, 'content');
  let text: string | undefined;
  if (typeof nested === 'string') {
    text = cleanBody(log, nested, id);
  } else if (Array.isArray(nested)) {
    const parts: string[] = [];
    const nonText: unknown[] = [];
    for (const element of nested) {
      if (isRecord(element) && own(element, 'type') === 'text' && typeof own(element, 'text') === 'string') parts.push(own(element, 'text') as string);
      else nonText.push(element);
    }
    if (parts.length > 0) text = cleanBody(log, parts.join('\n'), id);
    if (nonText.length > 0) metadata['nonTextContent'] = nonText;
  } else if (nested !== undefined && nested !== null) {
    metadata['content'] = nested;
  }
  return text === undefined ? { type: 'tool_result', metadata } : { type: 'tool_result', text, metadata };
}

function imageBlock(log: WarningLog, raw: JsonObject, id: string): ContentBlock {
  // The (possibly huge, base64) image payload is NOT copied into metadata; it remains in rawSource.
  const source = own(raw, 'source');
  const mediaType = isRecord(source) ? optionalBoundedString(log, own(source, 'media_type'), MAX_SHORT_STRING, id) : null;
  return { type: 'image_ref', metadata: { sourceType: 'image', mediaType } };
}

function voiceNoteBlock(log: WarningLog, raw: JsonObject, id: string): ContentBlock {
  const t = own(raw, 'text');
  const metadata = { sourceType: 'voice_note' };
  if (typeof t === 'string') return { type: 'voice_note', text: cleanBody(log, t, id), metadata };
  log.add(W.MALFORMED_CONTENT_BLOCK, MALFORMED_BLOCK_MESSAGE, id);
  return { type: 'voice_note', metadata };
}

function unknownBlock(log: WarningLog, raw: unknown, id: string): ContentBlock {
  const sourceType = isRecord(raw) ? own(raw, 'type') : undefined;
  if (typeof sourceType === 'string') {
    log.add(W.UNKNOWN_CONTENT_TYPE, 'A content block has a type this adapter does not know; it is kept as an "unknown" block with the raw value.', id);
    return { type: 'unknown', metadata: { sourceType: cleanBounded(log, sourceType, MAX_SHORT_STRING, id), raw } };
  }
  log.add(W.MALFORMED_CONTENT_BLOCK, MALFORMED_BLOCK_MESSAGE, id);
  return { type: 'unknown', metadata: { sourceType: null, raw } };
}

function buildBlock(log: WarningLog, raw: unknown, id: string): ContentBlock {
  if (!isRecord(raw)) return unknownBlock(log, raw, id);
  switch (own(raw, 'type')) {
    case 'text':
      return textBlock(log, raw, id);
    case 'thinking':
      return thinkingBlock(log, raw, id);
    case 'tool_use':
      return toolUseBlock(log, raw, id);
    case 'tool_result':
      return toolResultBlock(log, raw, id);
    case 'image':
      return imageBlock(log, raw, id);
    case 'voice_note':
      return voiceNoteBlock(log, raw, id);
    case 'token_budget':
      return { type: 'token_budget', metadata: { sourceType: 'token_budget' } };
    default:
      return unknownBlock(log, raw, id);
  }
}

/** Items (blocks, attachment refs, attachment-text blocks) still allowed for the rest of the conversation (MAX_ITEMS_PER_CONVERSATION). */
interface ItemBudget {
  remaining: number;
}

function buildBlocks(log: WarningLog, content: readonly unknown[], id: string, budget: ItemBudget): ContentBlock[] {
  const limit = Math.min(content.length, MAX_BLOCKS_PER_MESSAGE, budget.remaining);
  const out: ContentBlock[] = [];
  for (let i = 0; i < limit; i++) out.push(buildBlock(log, content[i], id));
  budget.remaining -= out.length;
  if (content.length > limit) log.add(W.BLOCKS_TRUNCATED, 'A message has more content blocks than the per-message or per-conversation limit allows; the rest are only in rawSource.', id);
  return out;
}

// ------------------------------------------------------------------------------------------
// Attachments
// ------------------------------------------------------------------------------------------

function firstUsableId(log: WarningLog, a: JsonObject, keys: readonly string[], msgId: string): string | null {
  let sawUnusable = false;
  for (const key of keys) {
    const raw = own(a, key);
    if (raw === undefined || raw === null) continue;
    const id = cleanId(raw);
    if (id !== null) return id;
    sawUnusable = true;
  }
  if (sawUnusable) log.add(W.INVALID_ATTACHMENT_FIELD, 'An attachment field had an unusable value and was recorded as null.', msgId);
  return null;
}

function firstString(log: WarningLog, a: JsonObject, keys: readonly string[], max: number, msgId: string): string | null {
  let sawUnusable = false;
  for (const key of keys) {
    const raw = own(a, key);
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string') {
      const cleaned = cleanBounded(log, raw, max, msgId);
      if (cleaned !== '') return cleaned;
    } else {
      sawUnusable = true;
    }
  }
  if (sawUnusable) log.add(W.INVALID_ATTACHMENT_FIELD, 'An attachment field had an unusable value and was recorded as null.', msgId);
  return null;
}

function attachmentSize(log: WarningLog, a: JsonObject, msgId: string): number | null {
  const raw = own(a, 'file_size');
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw === 0 ? 0 : raw; // JSON "-0" parses to -0: store a plain 0
  log.add(W.INVALID_ATTACHMENT_FIELD, 'An attachment field had an unusable value and was recorded as null.', msgId);
  return null;
}

/**
 * Metadata only (FR-15). GCR never dereferences anything: `assetPointer` stays null, and `presentInExportAs` is ALWAYS
 * null because Claude exports are not known to contain attachment bytes and matching on a file name could falsely
 * claim a file is present (ctx.availableAssetNames is deliberately ignored; see docs/ADAPTERS.md).
 */
function buildAttachments(log: WarningLog, el: JsonObject, msgId: string, budget: ItemBudget): { refs: AttachmentRef[]; blocks: ContentBlock[] } {
  const refs: AttachmentRef[] = [];
  const blocks: ContentBlock[] = [];
  for (const key of ['attachments', 'files'] as const) {
    const list = own(el, key);
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      log.add(W.INVALID_ATTACHMENT, `A message "${key}" value is not an array; it is kept only in rawSource.`, msgId);
      continue;
    }
    for (const a of list) {
      if (!isRecord(a)) {
        log.add(W.INVALID_ATTACHMENT, 'An attachment entry is not an object; it is kept only in rawSource.', msgId);
        continue;
      }
      if (refs.length >= MAX_ATTACHMENTS_PER_MESSAGE || budget.remaining <= 0) {
        log.add(W.ATTACHMENTS_TRUNCATED, 'A message has more attachments than the per-message or per-conversation limit allows; the rest are only in rawSource.', msgId);
        break;
      }
      budget.remaining--;
      const ref: AttachmentRef = {
        id: firstUsableId(log, a, ['id', 'uuid', 'file_uuid', 'file_id'], msgId),
        name: firstString(log, a, ['file_name', 'name'], MAX_ATTACHMENT_STRING, msgId),
        mimeType: firstString(log, a, ['file_type', 'mime_type'], MAX_SHORT_STRING, msgId),
        sizeBytes: attachmentSize(log, a, msgId),
        assetPointer: null,
        presentInExportAs: null,
      };
      refs.push(ref);
      const extracted = own(a, 'extracted_content');
      if (typeof extracted === 'string' && extracted !== '') {
        if (budget.remaining > 0) {
          budget.remaining--;
          // Kept as its own block so it stays searchable by block type, but never merged into message.text (FR-15: metadata by default).
          blocks.push({
            type: 'attachment_text',
            text: cleanBody(log, extracted, msgId),
            metadata: { sourceType: `${key}.extracted_content`, attachmentIndex: refs.length - 1, fileName: ref.name },
          });
        } else {
          log.add(W.ATTACHMENTS_TRUNCATED, 'A message has more attachments than the per-message or per-conversation limit allows; the rest are only in rawSource.', msgId);
        }
      }
    }
  }
  return { refs, blocks };
}

// ------------------------------------------------------------------------------------------
// Messages
// ------------------------------------------------------------------------------------------

interface Draft {
  ordinal: number;
  source: JsonObject;
  id: string;
  parentId: string | null;
  authorRole: string;
  modelSlug: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  text: string;
  blocks: ContentBlock[];
  attachments: AttachmentRef[];
}

function readRole(log: WarningLog, el: JsonObject, id: string): string {
  const raw = own(el, 'sender');
  if (raw === 'human') return 'user'; // the ONLY normalization; "Human", "HUMAN", "user" are kept verbatim
  const cleaned = typeof raw === 'string' ? cleanBounded(log, raw, MAX_SHORT_STRING, id) : '';
  if (cleaned === '') {
    // '' is reserved for structural nodes, so a missing sender is "unknown" rather than an empty role.
    log.add(W.SENDER_MISSING, 'A message has no usable "sender" string; its role is recorded as "unknown".', id);
    return 'unknown';
  }
  return cleaned;
}

function readModel(log: WarningLog, raw: unknown, id: string): string | null {
  if (raw === undefined || raw === null) return null;
  const model = optionalBoundedString(log, raw, MAX_SHORT_STRING, id);
  if (model === null && typeof raw !== 'string') log.add(W.INVALID_MODEL_SLUG, 'A "model" value was not a string and was ignored.', id);
  return model;
}

/** message.text per research notes: the top-level `text` field if non-empty, else the visible `text` blocks joined. */
function composeText(log: WarningLog, el: JsonObject, id: string, blocks: ContentBlock[]): { text: string; blocks: ContentBlock[] } {
  const rawText = own(el, 'text');
  let topText = '';
  if (typeof rawText === 'string') topText = cleanBody(log, rawText, id);
  else if (rawText !== undefined && rawText !== null) log.add(W.INVALID_TEXT_FIELD, 'A message "text" value is not a string and was ignored.', id);

  const textParts = blocks.filter((b) => b.type === 'text' && b.text !== undefined && b.text !== '').map((b) => b.text as string);
  const joined = textParts.join('\n\n');
  if (topText !== '' && joined !== '' && topText !== joined && topText !== textParts.join('') && topText !== textParts.join('\n')) {
    log.add(W.TEXT_FIELD_MISMATCH, 'A message "text" field differs from its text blocks; "text" was used for message.text and both are kept.', id);
  }
  // A top-level text with no text block (older/trimmed exports) gets one derived block so blocks stay complete.
  if (topText !== '' && !blocks.some((b) => b.type === 'text')) {
    return { text: topText, blocks: [{ type: 'text', text: topText, metadata: { derivedFrom: 'text' } }, ...blocks] };
  }
  if (topText !== '') return { text: topText, blocks };
  // The joined text is NOT bounded by the per-block caps (many blocks of up to 64 MiB each): cap it like every other body,
  // or the record would fail validation (text_too_large) and the whole conversation would be lost.
  return { text: capJoined(log, joined, id), blocks };
}

function capJoined(log: WarningLog, joined: string, id: string): string {
  const t = truncateUtf8(joined, MAX_TEXT_BYTES);
  if (t.truncated) log.add(W.TEXT_TRUNCATED, `A text longer than the size limit was truncated and marked (${SANITIZED_NOTE}).`, id);
  return t.value;
}

/** chat_messages entries that are not objects: not messages, but their raw values are kept (bounded) so the skip loses nothing. */
interface SkippedEntries {
  kept: Array<{ ordinal: number; value: unknown }>;
  total: number;
}

function assignMessageIds(log: WarningLog, chatMessages: readonly unknown[], convId: string, skipped: SkippedEntries): { sources: Array<{ ordinal: number; source: JsonObject; id: string }>; firstIdByOriginal: Map<string, string> } {
  const sources: Array<{ ordinal: number; source: JsonObject; id: string }> = [];
  const used = new Set<string>();
  const firstIdByOriginal = new Map<string, string>();
  const nextDupSuffix = new Map<string, number>();
  for (let ordinal = 0; ordinal < chatMessages.length; ordinal++) {
    const el = chatMessages[ordinal];
    if (!isRecord(el)) {
      log.add(W.NON_OBJECT_MESSAGE, `A chat_messages entry is not an object, so it is not a message; its raw value is kept in rawMetadata._gcr.nonObjectChatMessages (at most the first ${MAX_PRESERVED_SKIPPED_ENTRIES}, the rest is counted).`, convId);
      skipped.total++;
      if (skipped.kept.length < MAX_PRESERVED_SKIPPED_ENTRIES) skipped.kept.push({ ordinal, value: el });
      continue;
    }
    const rawId = own(el, 'uuid');
    const original = cleanId(rawId);
    let base: string;
    if (original === null) {
      // Deterministic positional fallback: the position inside this conversation snapshot, never a clock or random value.
      base = `synthetic-msg-${ordinal}`;
      const missing = rawId === undefined || rawId === null;
      log.add(missing ? W.MESSAGE_ID_MISSING : W.MESSAGE_ID_INVALID, missing ? 'A message has no "uuid"; a positional id was assigned.' : 'A message "uuid" was not a usable identifier; a positional id was assigned.', base);
    } else {
      base = original;
    }
    // Message ids must be unique per conversation or content would be silently dropped/overwritten downstream.
    // The next suffix to try is remembered per STEM: restarting at ~dup2 for every duplicate is quadratic (k copies of one
    // uuid cost k^2/2 probes: 16 000 copies took 10 s) and so is a family of long ids whose truncated candidates collide.
    // Every number below the remembered one is already taken, so the result equals "smallest unused n >= 2".
    let id = base;
    if (used.has(id)) {
      const stem = capUnits(base, DUP_STEM_UNITS).value;
      let n = nextDupSuffix.get(stem) ?? 2;
      do id = withSuffix(base, `~dup${n++}`);
      while (used.has(id));
      nextDupSuffix.set(stem, n);
    }
    if (id !== base) log.add(W.DUPLICATE_MESSAGE_ID, 'A message uuid occurs more than once; later occurrences received a deterministic suffix (the original uuid is in rawSource).', base);
    used.add(id);
    if (original !== null && !firstIdByOriginal.has(original)) firstIdByOriginal.set(original, id);
    sources.push({ ordinal, source: el, id });
  }
  return { sources, firstIdByOriginal };
}

/** Parent of one message in EXPLICIT mode. Dangling pointers are kept verbatim: branches.ts reports MISSING_PARENT. */
function explicitParent(log: WarningLog, d: { source: JsonObject; id: string }, isFirst: boolean, firstIdByOriginal: ReadonlyMap<string, string>): string | null {
  if (!Object.hasOwn(d.source, 'parent_message_uuid')) {
    // Mixed data: no pointer on this message. Linking it to its file-order predecessor would be a guess, so it is a root.
    if (!isFirst) log.add(W.PARENT_POINTER_ABSENT, 'A message has no parent_message_uuid although others do; it is treated as a root (no parent inferred).', d.id);
    return null;
  }
  const raw = d.source['parent_message_uuid'];
  if (raw === null) return null;
  const pointer = cleanId(raw);
  if (pointer === null) {
    log.add(W.INVALID_PARENT_POINTER, 'A parent_message_uuid was not a usable identifier; the message is treated as a root.', d.id);
    return null;
  }
  const resolved = firstIdByOriginal.get(pointer);
  if (resolved === undefined && pointer === CLAUDE_ROOT_SENTINEL) return null; // Claude's "no parent" sentinel
  return resolved ?? pointer;
}

function compareDrafts(a: Draft, b: Draft): number {
  if (a.createdAt !== b.createdAt) {
    if (a.createdAt === null) return 1;
    if (b.createdAt === null) return -1;
    return a.createdAt < b.createdAt ? -1 : 1; // fixed-width ISO strings sort chronologically
  }
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // code-unit order, never locale-dependent
}

function buildDrafts(log: WarningLog, chatMessages: readonly unknown[], convId: string, skipped: SkippedEntries): Draft[] {
  const { sources, firstIdByOriginal } = assignMessageIds(log, chatMessages, convId, skipped);
  // Explicit mode as soon as ANY message carries the key: "explicit pointers win" (task rule), decided per conversation.
  const explicit = sources.some((s) => Object.hasOwn(s.source, 'parent_message_uuid'));
  const drafts: Draft[] = [];
  const budget: ItemBudget = { remaining: MAX_ITEMS_PER_CONVERSATION };
  let previousId: string | null = null;
  sources.forEach((s, position) => {
    const el = s.source;
    const rawContent = own(el, 'content');
    let blocks: ContentBlock[] = [];
    if (Array.isArray(rawContent)) blocks = buildBlocks(log, rawContent, s.id, budget);
    else if (rawContent !== undefined && rawContent !== null) log.add(W.INVALID_CONTENT, 'A message "content" value is not an array; it is kept only in rawSource.', s.id);
    const composed = composeText(log, el, s.id, blocks);
    const attachments = buildAttachments(log, el, s.id, budget);
    drafts.push({
      ordinal: s.ordinal,
      source: el,
      id: s.id,
      // Linear mode: file order IS the thread (the export holds exactly one thread), so each message hangs off its predecessor.
      parentId: explicit ? explicitParent(log, s, position === 0, firstIdByOriginal) : previousId,
      authorRole: readRole(log, el, s.id),
      modelSlug: readModel(log, own(el, 'model'), s.id),
      createdAt: readTimestamp(log, own(el, 'created_at'), s.id),
      updatedAt: readTimestamp(log, own(el, 'updated_at'), s.id),
      text: composed.text,
      blocks: [...composed.blocks, ...attachments.blocks],
      attachments: attachments.refs,
    });
    previousId = s.id;
  });
  return drafts;
}

/** Declared children, derived from parent pointers in (createdAt asc nulls last, ordinal, id) order (ARCHITECTURE section 4). */
function deriveChildren(drafts: readonly Draft[], byId: ReadonlyMap<string, Draft>, explicit: boolean): Map<string, string[]> {
  const ordered = explicit ? [...drafts].sort(compareDrafts) : drafts;
  const children = new Map<string, string[]>();
  for (const d of ordered) {
    if (d.parentId === null || !byId.has(d.parentId)) continue; // a dangling pointer names no existing child list
    const list = children.get(d.parentId);
    if (list === undefined) children.set(d.parentId, [d.id]);
    else list.push(d.id);
  }
  return children;
}

/**
 * The active-branch pointer. A Claude export is, by construction, ONE thread (the branch the user sees), so when the
 * messages form a single chain its only leaf is the end of that thread and is reported as currentNodeId. This is NOT
 * inference from timestamps or file order alone: it is only returned when the structure leaves no alternative. Any
 * other shape (several leaves, cycle, unreachable nodes) returns null: no active branch is guessed (ADR-0009).
 * A chain whose first node points at a missing parent is still a single chain (branches.ts reports MISSING_PARENT).
 */
function resolveCurrentNodeId(drafts: readonly Draft[], byId: ReadonlyMap<string, Draft>, children: ReadonlyMap<string, string[]>): string | null {
  const leaves = drafts.filter((d) => !children.has(d.id));
  const leaf = leaves.length === 1 ? leaves[0] : undefined;
  if (leaf === undefined) return null;
  const seen = new Set<string>();
  let current: Draft | undefined = leaf;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  // Every message must lie on the single leaf->root path; a revisited node (cycle) ends the walk early and fails this.
  return seen.size === drafts.length && current === undefined ? leaf.id : null;
}

/** Own data property, also for the key "__proto__" (plain assignment would change the prototype instead). */
function defineOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The conversation object minus its message tree. When entries were skipped, the adapter's own `_gcr` block is added (same
 * convention as the ChatGPT adapter): a source key named `_gcr` is kept as `_gcr_original` (or `_gcr_original_2`, ...), so it can
 * neither spoof the block nor be lost. Without skipped entries rawMetadata is exactly the source minus `chat_messages`.
 */
function buildRawMetadata(parsed: JsonObject, skipped: SkippedEntries): JsonObject {
  const { chat_messages: _messageTree, ...rest } = parsed;
  if (skipped.total === 0) return rest;
  const out: JsonObject = {};
  let moved = '_gcr_original';
  for (let n = 2; Object.hasOwn(rest, moved); n++) moved = `_gcr_original_${n}`;
  for (const key of Object.keys(rest)) defineOwn(out, key === '_gcr' ? moved : key, rest[key]);
  const gcr: JsonObject = { nonObjectChatMessages: skipped.kept.map((e) => ({ ordinal: e.ordinal, value: e.value })) };
  if (skipped.total > skipped.kept.length) gcr['nonObjectChatMessagesOmitted'] = skipped.total - skipped.kept.length;
  defineOwn(out, '_gcr', gcr);
  return out;
}

function countRoles(messages: readonly MessageRecord[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.authorRole, (counts.get(m.authorRole) ?? 0) + 1);
  const out: Record<string, number> = {};
  // defineProperty, not assignment: a role named "__proto__" must become an own key, not change the prototype.
  for (const [role, n] of counts) Object.defineProperty(out, role, { value: n, enumerable: true, writable: true, configurable: true });
  return out;
}

// ------------------------------------------------------------------------------------------
// Conversation
// ------------------------------------------------------------------------------------------

/** The conversation id, or a deterministic replacement plus the reason (reported by the caller so warning order stays fixed). */
function readConversationId(parsed: JsonObject, sha256: string, elementIndex: number): { id: string; problem: 'missing' | 'invalid' | 'case' | null } {
  const raw = own(parsed, 'uuid');
  const id = cleanId(raw);
  if (id !== null) {
    // A UUID-shaped conversation id is lower-cased, like the ChatGPT adapter does, because lookups (parseConversationRef)
    // lower-case what the operator types: an upper-case stored id could never be found again. Message ids stay verbatim
    // (parent pointers must keep matching them exactly). The raw value remains in rawMetadata.
    return isUuid(id) && id !== id.toLowerCase() ? { id: id.toLowerCase(), problem: 'case' } : { id, problem: null };
  }
  // Same form as the ChatGPT adapter's fallback. Deterministic from the element's bytes AND its position: re-importing
  // the same file reproduces the id (FR-10), while two byte-identical id-less elements stay two distinct conversations.
  return { id: `gcr-synth-${sha256.slice(0, 32)}-${elementIndex}`, problem: raw === undefined || raw === null ? 'missing' : 'invalid' };
}

function readTitle(log: WarningLog, parsed: JsonObject, convId: string): string | null {
  const raw = own(parsed, 'name');
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    log.add(W.INVALID_TITLE, 'The conversation "name" is not a string and was recorded as null.', convId);
    return null;
  }
  const title = cleanBounded(log, raw, MAX_TITLE_LENGTH, convId);
  return title === '' ? null : title; // "" = untitled; the raw value stays in rawMetadata
}

function skipped(reason: 'EMPTY_CONVERSATION_ENTRY' | 'NON_OBJECT_ENTRY' | 'NOT_A_CONVERSATION', elementIndex: number, why: string): AdapterOutcome {
  return { kind: 'skipped', reason, warnings: [{ code: reason, message: `Element ${elementIndex} was skipped: ${why}` }] };
}

function limitExceeded(what: string, details: Record<string, unknown>): GcrError {
  return new GcrError('IMPORT_LIMIT_EXCEEDED', `The Claude conversation element exceeds a safety limit (${what}).`, {
    remedy: 'This element is skipped; the rest of the import continues. A conversation this large or deeply nested is not expected from a real export.',
    details,
  });
}

function assertContext(ctx: AdapterContext): void {
  if (typeof ctx !== 'object' || ctx === null) {
    throw new GcrError('INVALID_ARGUMENT', 'The adapter context must be an object.', { details: { reason: 'CONTEXT_NOT_OBJECT' } });
  }
  if (ctx.provider !== 'claude') {
    // Fail loudly: silently labelling Claude data with another provider would destroy provenance (FR-14).
    throw new GcrError('INVALID_ARGUMENT', 'ClaudeExportAdapter was called with a context for a different provider.', {
      remedy: 'Select the adapter through getAdapter() in src/ingest/registry.ts and pass a context with provider "claude".',
      details: { reason: 'PROVIDER_MISMATCH', expected: 'claude' },
    });
  }
  if (cleanId(ctx.accountLabel) === null) {
    throw new GcrError('INVALID_ARGUMENT', 'The adapter context accountLabel is not a usable identifier.', { details: { reason: 'BAD_ACCOUNT_LABEL' } });
  }
  if (!isIso8601Utc(ctx.importedAt)) {
    throw new GcrError('INVALID_ARGUMENT', 'The adapter context importedAt is not an ISO-8601 UTC timestamp.', { details: { reason: 'BAD_IMPORTED_AT' } });
  }
}

function parseElementJson(text: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // No `cause`: V8's SyntaxError message quotes the offending input, and input is untrusted content.
    throw new GcrError('IMPORT_PARSE_ERROR', 'The Claude conversation element is not valid JSON.', {
      remedy: 'The element is skipped. Re-download the export or check the file for truncation or corruption.',
      details: { reason: 'INVALID_JSON' },
    });
  }
}

function normalizeElement(text: string, ctx: AdapterContext, rawElementIndex: number): AdapterOutcome {
  assertContext(ctx);
  // The index only feeds a fallback id and a warning text, so a bogus value (NaN, negative, non-number) becomes 0.
  const elementIndex = Number.isSafeInteger(rawElementIndex) && rawElementIndex >= 0 ? rawElementIndex : 0;
  if (typeof text !== 'string') {
    throw new GcrError('INVALID_ARGUMENT', 'The element text must be a string.', { details: { reason: 'TEXT_NOT_STRING' } });
  }
  const parsed = parseElementJson(text);
  if (!isRecord(parsed)) return skipped('NON_OBJECT_ENTRY', elementIndex, 'the element is not a JSON object.');
  if (Object.keys(parsed).length === 0) return skipped('EMPTY_CONVERSATION_ENTRY', elementIndex, 'the element is an empty object.');
  const chatMessages = own(parsed, 'chat_messages');
  // `chat_messages` as an array is THE conversation marker (the registry sniffs the same way); without it an object with
  // a uuid could equally be a project or user record, and turning it into an empty conversation would be a guess.
  if (!Array.isArray(chatMessages)) return skipped('NOT_A_CONVERSATION', elementIndex, 'the object has no chat_messages array.');
  if (jsonDepthExceeds(parsed, MAX_JSON_DEPTH)) throw limitExceeded('nesting depth', { limit: 'MAX_JSON_DEPTH', max: MAX_JSON_DEPTH });
  if (chatMessages.length > MAX_MESSAGES_PER_CONVERSATION) {
    throw limitExceeded('message count', { limit: 'MAX_MESSAGES_PER_CONVERSATION', max: MAX_MESSAGES_PER_CONVERSATION, count: chatMessages.length });
  }

  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const log = new WarningLog();
  const identity = readConversationId(parsed, sha256, elementIndex);
  const convId = identity.id;
  // Always first: every Claude record states that it is one thread, even an empty one (completeness is not about message count).
  log.add(W.LINEAR_EXPORT_ACTIVE_BRANCH_ONLY, 'A Claude export holds one linear thread per conversation (the branch rendered at export time); alternate branches, edits and regenerations are not part of it, so this is not the full conversation tree.', convId);
  if (identity.problem === 'missing') log.add(W.CONVERSATION_ID_MISSING, 'The conversation has no "uuid"; an id derived from the element hash and position was assigned.', convId);
  if (identity.problem === 'case') log.add(W.ID_CASE_NORMALIZED, `${INFO_PREFIX}An upper-case UUID conversation id was lower-cased (the raw value is kept in rawMetadata).`, convId);
  if (identity.problem === 'invalid') log.add(W.CONVERSATION_ID_INVALID, 'The conversation "uuid" was not a usable identifier; an id derived from the element hash and position was assigned.', convId);
  // A ChatGPT-style object `mapping` next to `chat_messages` is the registry's "ambiguous" case. This adapter was chosen by the
  // operator (or by a caller that ignored the registry's null), so it still converts `chat_messages`, but it must not hide
  // that a second provider's message tree exists in the element and was NOT read (it stays in rawMetadata).
  if (isRecord(own(parsed, 'mapping'))) {
    log.add(W.FOREIGN_PROVIDER_MARKER, 'The element also has a ChatGPT-style object "mapping"; only chat_messages was converted and the mapping was not read (it is kept in rawMetadata).', convId);
  }

  const duplicateKeys = countDuplicateKeys(text);
  if (duplicateKeys > 0) {
    log.add(W.DUPLICATE_KEY, 'An object contains the same key more than once; like JSON.parse, the LAST value was kept (the element SHA-256 covers the exact bytes).', convId, duplicateKeys);
  }

  const skippedEntries: SkippedEntries = { kept: [], total: 0 };
  const drafts = buildDrafts(log, chatMessages, convId, skippedEntries);
  const explicit = drafts.some((d) => Object.hasOwn(d.source, 'parent_message_uuid'));
  const byId = new Map(drafts.map((d) => [d.id, d] as const));
  const children = deriveChildren(drafts, byId, explicit);
  const currentNodeId = resolveCurrentNodeId(drafts, byId, children);
  if (drafts.length > 0) {
    // Claude never has a `children` key; childIds are derived from the (linear or explicit) parent pointers.
    log.add(W.CHILDREN_ABSENT, 'The Claude export has no child lists; childIds were derived from the parent pointers.', convId);
    if (currentNodeId === null) {
      log.add(W.ACTIVE_BRANCH_UNKNOWN, 'The explicit parent pointers do not form a single chain, so no active branch can be identified (none is guessed).', convId);
    }
  }

  const messages: MessageRecord[] = drafts.map((d) => ({
    id: d.id,
    conversationId: convId,
    parentId: d.parentId,
    childIds: children.get(d.id) ?? [],
    nodeKind: 'message',
    authorRole: d.authorRole,
    authorName: null,
    modelSlug: d.modelSlug,
    channel: null,
    recipient: null,
    contentType: null, // the source has no content_type; unknown stays null
    status: null,
    hidden: false, // the source never marks a whole message hidden; hidden reasoning is block-level (thoughts)
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    text: d.text,
    blocks: d.blocks,
    attachments: d.attachments,
    ordinal: d.ordinal,
    rawSource: d.source,
  }));

  const rawMetadata = buildRawMetadata(parsed, skippedEntries);
  const record: ConversationRecord = {
    provider: 'claude',
    accountLabel: ctx.accountLabel,
    id: convId,
    title: readTitle(log, parsed, convId),
    sourceUri: null,
    provenance: 'official_claude_export',
    completeness: 'rendered_active_view_only',
    importedAt: ctx.importedAt,
    createdAt: readTimestamp(log, own(parsed, 'created_at'), convId),
    updatedAt: readTimestamp(log, own(parsed, 'updated_at'), convId),
    currentNodeId,
    defaultModelSlug: readModel(log, own(parsed, 'model'), convId),
    messages,
    rawMetadata,
    warnings: [],
  };
  record.warnings = log.toArray();

  const observations: FormatObservations = {
    nodesWithChildrenDeclared: 0,
    nodesWithChildrenAbsent: messages.length,
    hasCurrentNode: currentNodeId !== null,
    roleCounts: countRoles(messages),
    messagesWithRecipient: 0,
    messagesWithStatus: 0,
    messagesWithModelSlug: messages.filter((m) => m.modelSlug !== null).length,
    hiddenMessages: 0,
    rootIsLiteralClientCreatedRoot: false,
  };
  return { kind: 'record', record, observations, sourceElementSha256: sha256 };
}

export class ClaudeExportAdapter implements ConversationSourceAdapter {
  readonly name = 'claude-export';
  readonly provider = 'claude' as const;
  readonly provenance = 'official_claude_export' as const;

  normalizeElementText(text: string, ctx: AdapterContext, elementIndex: number): AdapterOutcome {
    try {
      return normalizeElement(text, ctx, elementIndex);
    } catch (e) {
      if (e instanceof GcrError) throw e;
      // Contract: only GcrError escapes. This branch means an adapter bug, so it is marked as such in `details`
      // (the property tests assert it is never reached) and the raw error is attached as `cause` for GCR_DEBUG.
      throw new GcrError('IMPORT_PARSE_ERROR', 'The Claude conversation element could not be normalized (unexpected adapter condition).', {
        remedy: 'This element is skipped. Report the issue without attaching private data.',
        details: { reason: 'UNEXPECTED_ADAPTER_FAILURE' },
        cause: e,
      });
    }
  }
}
