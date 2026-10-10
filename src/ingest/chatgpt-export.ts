/**
 * ChatGPTExportAdapter: turns ONE element of an official ChatGPT export (`conversations.json` /
 * `conversations-NNN.json`, as raw JSON text) into the provider-neutral ConversationRecord (SPEC FR-02/FR-03/FR-09,
 * docs/ARCHITECTURE.md section 5, docs/IMPORT_FORMAT.md).
 *
 * Evidence status: OpenAI publishes no schema for the archive. Every field handled here comes from community
 * reverse-engineering and was exercised ONLY against synthetic fixtures; no live export could be verified.
 *
 * Principles (AGENTS.md):
 *  - Imported text is untrusted DATA. Nothing here executes, evaluates or follows anything found in it. Warnings carry
 *    fixed messages, counts and ids only, never conversation text (titles, message text, key names of arbitrary
 *    objects). The one place a source string is echoed is `UNKNOWN_CONTENT_TYPE`, and that string is first reduced to
 *    at most 64 characters of [A-Za-z0-9_.:/-] (everything else becomes '?').
 *  - Unknown stays unknown: no model, timestamp, active branch or completeness is ever guessed.
 *  - The adapter is pure: no I/O, no clock, no randomness, no network. Output order is deterministic.
 *  - It never throws for a bad OPTIONAL field (a warning is recorded, the raw value stays in `rawSource` /
 *    `rawMetadata`). It throws GcrError IMPORT_PARSE_ERROR only when the element is not valid JSON.
 *
 * What `rawSource` / `rawMetadata` are, and are not (do not rely on byte-exactness): they are the objects produced by
 * JSON.parse. Consequently (1) integers beyond 2^53 and numbers with more than ~17 significant digits are rounded,
 * `1e999` becomes Infinity, (2) of two duplicate object keys only the LAST value survives (the first mapping bodies are
 * only recorded as SHA-256 hashes, see `_gcr.duplicateNodeBodySha256`), and (3) JavaScript orders integer-like keys
 * before other keys. The exact source bytes are identified by `_gcr.sourceElementSha256`.
 */
import { createHash } from 'node:crypto';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { isUuid } from '../domain/ids.js';
import type { AttachmentRef, Completeness, ContentBlock, ConversationRecord, MessageRecord } from '../domain/types.js';
import { MAX_ID_LENGTH, MAX_TEXT_BYTES, parseIsoUtcToEpochMs, unixSecondsToIso } from '../domain/validate.js';
import type { AdapterContext, AdapterOutcome, ConversationSourceAdapter, FormatObservations } from './adapter.js';

// ------------------------------------------------------------------------------------------
// Public limits and vocabularies
// ------------------------------------------------------------------------------------------

export interface ChatGPTAdapterLimits {
  /** Nodes kept per conversation; further nodes (in file order) are dropped with TOO_MANY_NODES. */
  maxNodesPerConversation: number;
  /** `parts[]` entries converted to blocks per message; the rest is dropped from blocks (kept in rawSource): PARTS_TRUNCATED. */
  maxPartsPerMessage: number;
  /** Largest `text` (UTF-8 bytes) of one message; longer text is truncated with TEXT_TRUNCATED. Must not exceed MAX_TEXT_BYTES. */
  maxTextBytesPerMessage: number;
}

export const DEFAULT_CHATGPT_ADAPTER_LIMITS: Readonly<ChatGPTAdapterLimits> = Object.freeze({
  maxNodesPerConversation: 500_000,
  maxPartsPerMessage: 50_000,
  maxTextBytesPerMessage: MAX_TEXT_BYTES,
});

/** Every warning code this adapter can emit (the domain analyzer emits further codes of its own, e.g. MISSING_PARENT). */
export const CHATGPT_ADAPTER_WARNING_CODES = [
  'DUPLICATE_NODE_ID',
  'DUPLICATE_KEY',
  'CONVERSATION_ID_MISSING',
  'ID_ALIAS_MISMATCH',
  'ID_CASE_NORMALIZED',
  'INVALID_NODE_ID',
  'NODE_ID_MISMATCH',
  'MESSAGE_ID_MISMATCH',
  'DUPLICATE_MESSAGE_ID',
  'MAPPING_INVALID',
  'NODE_NOT_OBJECT',
  'MESSAGE_NOT_OBJECT',
  'TOO_MANY_NODES',
  'KEY_ORDER_FALLBACK',
  'CHILDREN_ABSENT',
  'CHILD_NOT_FOUND',
  'DUPLICATE_CHILD_ENTRY',
  'NO_CURRENT_NODE',
  'INVALID_CURRENT_NODE',
  'CURRENT_NODE_NOT_LEAF',
  'COMPLETENESS_LOWERED',
  'TIMESTAMP_FORMAT',
  'TIMESTAMP_OUT_OF_RANGE',
  'TIMESTAMP_UNPARSEABLE',
  'UNKNOWN_CONTENT_TYPE',
  'UNKNOWN_PART_TYPE',
  'CONTENT_MALFORMED',
  'CONTENT_SHAPE_UNEXPECTED',
  'PARTS_TRUNCATED',
  'NUL_STRIPPED',
  'LONE_SURROGATE',
  'TEXT_TRUNCATED',
  'LEGACY_ROLE_FIELD',
  'UNEXPECTED_FIELD_TYPE',
] as const;
export type ChatGPTAdapterWarningCode = (typeof CHATGPT_ADAPTER_WARNING_CODES)[number];

/** Warning codes that are purely informational (their message starts with INFO_PREFIX). */
export const CHATGPT_ADAPTER_INFO_CODES: ReadonlySet<string> = new Set(['TIMESTAMP_FORMAT', 'CURRENT_NODE_NOT_LEAF', 'ID_CASE_NORMALIZED']);
export const INFO_PREFIX = '[info] ';

/** The 16 `content_type` values with an explicit handler (research section 6.5). Anything else is `unknown`. */
export const NAMED_CONTENT_TYPES = [
  'text',
  'multimodal_text',
  'code',
  'execution_output',
  'tether_quote',
  'tether_browsing_display',
  'tether_browsing_code',
  'sonic_webpage',
  'system_error',
  'user_editable_context',
  'model_editable_context',
  'thoughts',
  'reasoning_recap',
  'computer_output',
  'citable_code_output',
  'app_pairing_content',
] as const;

/**
 * Content types that carry custom instructions, memory or reasoning scaffolding. They are flagged `hidden` so default
 * search/rendering omit them (they stay stored; callers can opt in). Tool/code/execution output is NOT hidden.
 */
const HIDDEN_CONTENT_TYPES: ReadonlySet<string> = new Set(['user_editable_context', 'model_editable_context', 'thoughts', 'reasoning_recap']);

// ------------------------------------------------------------------------------------------
// Small shared constants and helpers
// ------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

const MAX_SHORT_STRING = 512; //          roles, model slugs, channels, content types (validate.ts)
const MAX_TITLE_LENGTH = 8192; //         validate.ts
const MAX_ATTACHMENT_STRING = 4096; //    validate.ts
const MAX_WARNING_IDS = 1000;
const MAX_WARNING_ID_LENGTH = MAX_ID_LENGTH;
const MAX_THOUGHTS_JSON_CHARS = 8 * 1024 * 1024;
const MAX_FRAME_POINTERS = 1000;
/** A prefix match in the asset index inspects at most this many candidates (bounds the cost of a hostile id such as "f"). */
const MAX_ASSET_PREFIX_PROBES = 64;
const MAX_TRACK_DEPTH = 24;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Own-property read. WHY not `obj[key]`: the objects come from JSON.parse so their prototype is Object.prototype, and an
 * inherited name (`constructor`, `toString`, ...) must never be mistaken for data. Using hasOwn also makes a literal
 * "__proto__" key (an own property after JSON.parse) an ordinary key.
 */
function own(obj: JsonObject, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * Define an own data property without triggering the `__proto__` setter. WHY: `target['__proto__'] = v` on a plain object
 * replaces its prototype instead of creating a key, which is the classic prototype-pollution foothold when copying
 * attacker-controlled keys.
 */
function setOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SURROGATE_QUICK_RE = /[\ud800-\udfff]/;

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** true iff `s` contains a UTF-16 surrogate that is not part of a valid pair. Fast path: no surrogate at all. */
function hasLoneSurrogate(s: string): boolean {
  if (!SURROGATE_QUICK_RE.test(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHighSurrogate(c)) {
      if (i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) i++;
      else return true;
    } else if (isLowSurrogate(c)) {
      return true;
    }
  }
  return false;
}

/** Replace every lone surrogate by U+FFFD (what any UTF-8 encoder would do silently; doing it here makes it explicit and reported). */
function replaceLoneSurrogates(s: string): string {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHighSurrogate(c)) {
      if (i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) {
        i++;
        continue;
      }
    } else if (!isLowSurrogate(c)) {
      continue;
    }
    out.push(s.slice(start, i), '�');
    start = i + 1;
  }
  out.push(s.slice(start));
  return out.join('');
}

/** An id the domain model accepts verbatim: 1..512 chars, no control characters, no lone surrogates (SQLite would rewrite those). */
function isSafeId(s: string): boolean {
  return s.length > 0 && s.length <= MAX_ID_LENGTH && !CONTROL_RE.test(s) && !hasLoneSurrogate(s);
}

/** A pointer to something that may not exist (dangling parent, phantom child): verbatim when safe, else a deterministic stand-in. */
function sanitizeRef(raw: string): string {
  return isSafeId(raw) ? raw : `gcr-ref-${sha256Hex(raw).slice(0, 24)}`;
}

/** Reduce an untrusted protocol string to a short, harmless token for use inside a warning message. */
function safeToken(s: string, max = 64): string {
  const head = s.length > 256 ? s.slice(0, 256) : s;
  let out = '';
  for (let i = 0; i < head.length && out.length < max; i++) {
    const c = head.charCodeAt(i);
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2e || c === 0x3a || c === 0x2d || c === 0x2f;
    out += ok ? head[i] : '?';
  }
  return out;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (s.length * 3 <= maxBytes) return s; // 3 bytes/UTF-16 unit is the maximum, so it fits for sure
  let bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= maxBytes) return s;
  let cut = s.slice(0, Math.min(s.length, maxBytes));
  bytes = Buffer.byteLength(cut, 'utf8');
  while (bytes > maxBytes) {
    // Shrink proportionally (always by at least one unit) until it fits; converges in a few rounds.
    cut = cut.slice(0, Math.max(0, Math.min(cut.length - 1, Math.floor((cut.length * maxBytes) / bytes))));
    bytes = Buffer.byteLength(cut, 'utf8');
  }
  if (cut.length > 0 && isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  return cut;
}

function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  if (cut.length > 0 && isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  return cut;
}

// ------------------------------------------------------------------------------------------
// Warning aggregation (ids only, never content)
// ------------------------------------------------------------------------------------------

interface WarnEntry {
  code: ChatGPTAdapterWarningCode;
  message: string;
  count: number;
  ids: string[];
  idSet: Set<string>;
}

/**
 * Collects warnings for ONE conversation. Warnings with the same (code, variant) are merged into a single Warning with
 * an occurrence count and a capped, de-duplicated id list: a 50k-message export with one recurring anomaly yields one
 * warning, not 50k.
 */
class WarningCollector {
  private readonly entries = new Map<string, WarnEntry>();

  /** `ids` may be one id, several ids (counted as ONE occurrence) or none. `count` lets a caller report many occurrences at once. */
  add(code: ChatGPTAdapterWarningCode, message: string, ids?: string | readonly string[], variant = '', count = 1): void {
    const key = variant === '' ? code : `${code}\u0001${variant}`;
    let e = this.entries.get(key);
    if (e === undefined) {
      e = { code, message, count: 0, ids: [], idSet: new Set() };
      this.entries.set(key, e);
    }
    e.count += count;
    if (ids === undefined) return;
    const list = typeof ids === 'string' ? [ids] : ids;
    for (const id of list) {
      if (e.ids.length >= MAX_WARNING_IDS) break;
      if (e.idSet.has(id)) continue;
      e.idSet.add(id);
      e.ids.push(id.length > MAX_WARNING_ID_LENGTH ? id.slice(0, MAX_WARNING_ID_LENGTH) : id);
    }
  }

  has(code: ChatGPTAdapterWarningCode): boolean {
    for (const e of this.entries.values()) if (e.code === code) return true;
    return false;
  }

  toWarnings(): Warning[] {
    const out: Warning[] = [];
    for (const e of this.entries.values()) {
      const w: Warning = { code: e.code, message: e.count > 1 ? `${e.message} (${e.count} occurrences)` : e.message };
      if (e.ids.length > 0) w.ids = e.ids;
      out.push(w);
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------
// Pre-pass: key scanner (duplicate keys, key order). Linear time, iterative, no regular expressions.
// ------------------------------------------------------------------------------------------

export interface ElementScan {
  /** Distinct keys of the LAST top-level "mapping" object, in order of first occurrence; null if there is none or it is not an object. */
  mappingKeys: string[] | null;
  /** Keys that occur more than once in that mapping object, each listed once. */
  duplicateMappingKeys: string[];
  /**
   * For each duplicated mapping key: SHA-256 (hex) of the source text of every OBJECT body, in file order. The last
   * body is the one JSON.parse keeps. Non-object bodies (null, numbers...) are not hashed.
   */
  duplicateBodySha256: Map<string, string[]>;
  /** Duplicate keys found INSIDE node objects (not at mapping level): mapping key of the node -> number of duplicates. */
  nodeKeyDuplicates: Map<string, number>;
  /** Duplicate keys in the conversation object itself or in nested objects outside the mapping. */
  conversationKeyDuplicates: number;
}

const K_OTHER = 0;
const K_ROOT = 1;
const K_MAPPING = 2;
const K_NODE = 3;

interface ScanFrame {
  isObject: boolean;
  kind: number;
  underMapping: boolean;
  expectKey: boolean;
  pendingKey: string | null;
  keys: string[] | null;
  keySet: Set<string> | null;
  /** K_MAPPING frames: index/duplicate flag of the key whose value is being read. K_NODE frames: that same pair, fixed at open. */
  pendingIdx: number;
  pendingDup: boolean;
  start: number;
  nodeKey: string;
}

function decodeKey(rawBody: string): string {
  try {
    const v: unknown = JSON.parse(`"${rawBody}"`);
    return typeof v === 'string' ? v : rawBody;
  } catch {
    // Unreachable for text that JSON.parse already accepted as a whole; keep the raw body rather than lose the key.
    return rawBody;
  }
}

/** Register `key` in a (non-mapping) object frame; true if it was already present. Small objects use a list, large ones a Set. */
function frameHasKey(f: ScanFrame, key: string): boolean {
  if (f.keySet !== null) {
    if (f.keySet.has(key)) return true;
    f.keySet.add(key);
    return false;
  }
  const ks = f.keys;
  if (ks === null) return false;
  for (let j = 0; j < ks.length; j++) if (ks[j] === key) return true;
  ks.push(key);
  if (ks.length > 16) {
    f.keySet = new Set(ks);
    f.keys = null;
  }
  return false;
}

/**
 * Scans the RAW TEXT of one conversation object (already known to be valid JSON) and reports what JSON.parse hides:
 * duplicate object keys and the file order of the `mapping` keys.
 *
 * WHY a separate scanner: `JSON.parse` keeps only the last of two equal keys (a duplicate node id would vanish without a
 * trace) and orders integer-like keys numerically before all others (so "10" would precede "9" regardless of the file),
 * which would corrupt the ordinal used as a deterministic tie-break.
 *
 * It is a single left-to-right pass over the characters with an explicit frame stack (no recursion, so nesting depth
 * cannot overflow the stack) and no regular expressions (so no backtracking). String contents are skipped with
 * `indexOf` plus backslash-parity counting, therefore a string VALUE that merely looks like `"a":1,"a":2` is never read as
 * keys. Only the first MAX_TRACK_DEPTH nesting levels are tracked; deeper levels are skipped by counting brackets.
 */
export function scanConversationElement(text: string): ElementScan {
  const n = text.length;
  const frames: ScanFrame[] = [];
  let extra = 0; // nesting levels beyond MAX_TRACK_DEPTH (untracked)

  let mappingKeys: string[] | null = null;
  let mappingIndex: Map<string, number> | null = null;
  let firstStart: number[] = [];
  let firstEnd: number[] = [];
  let duplicateMappingKeys: string[] = [];
  let dupRanges = new Map<string, Array<[number, number]>>();
  let nodeKeyDuplicates = new Map<string, number>();
  let conversationKeyDuplicates = 0;
  let currentNodeKey = '';

  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);

    if (c === 0x22) {
      // --- string: find the closing quote (an odd run of backslashes before a quote means the quote is escaped) ---
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) {
          j = n;
          break;
        }
        let back = q - 1;
        while (back > i && text.charCodeAt(back) === 0x5c) back--;
        if (((q - 1 - back) & 1) === 0) {
          j = q;
          break;
        }
        j = q + 1;
      }
      const top = extra === 0 ? frames[frames.length - 1] : undefined;
      if (top !== undefined && top.isObject && top.expectKey) {
        let key = text.slice(i + 1, j);
        if (key.includes('\\')) key = decodeKey(key);
        top.expectKey = false;
        top.pendingKey = key;
        if (top.kind === K_MAPPING && mappingIndex !== null && mappingKeys !== null) {
          currentNodeKey = key;
          const idx = mappingIndex.get(key);
          if (idx === undefined) {
            top.pendingIdx = mappingKeys.length;
            top.pendingDup = false;
            mappingIndex.set(key, top.pendingIdx);
            mappingKeys.push(key);
            firstStart.push(-1);
            firstEnd.push(-1);
          } else {
            top.pendingIdx = idx;
            top.pendingDup = true;
            if (!dupRanges.has(key)) {
              duplicateMappingKeys.push(key);
              const s = firstStart[idx];
              const e = firstEnd[idx];
              dupRanges.set(key, s !== undefined && e !== undefined && s >= 0 && e >= 0 ? [[s, e]] : []);
            }
          }
        } else {
          if (frameHasKey(top, key)) {
            if (top.underMapping) nodeKeyDuplicates.set(currentNodeKey, (nodeKeyDuplicates.get(currentNodeKey) ?? 0) + 1);
            else conversationKeyDuplicates++;
          }
          if (top.kind === K_ROOT && key === 'mapping') {
            // JSON.parse keeps the LAST "mapping": whatever was collected for an earlier one no longer exists.
            mappingKeys = null;
            mappingIndex = null;
          }
        }
      }
      i = j + 1;
      continue;
    }

    if (c === 0x7b || c === 0x5b) {
      if (extra > 0 || frames.length >= MAX_TRACK_DEPTH) {
        extra++;
        i++;
        continue;
      }
      const isObject = c === 0x7b;
      const parent = frames.length > 0 ? frames[frames.length - 1] : undefined;
      let kind = K_OTHER;
      let underMapping = false;
      let pendingIdx = -1;
      let pendingDup = false;
      let nodeKey = '';
      if (parent === undefined) {
        if (isObject) kind = K_ROOT;
      } else {
        underMapping = parent.kind === K_MAPPING || parent.underMapping;
        if (parent.isObject && isObject) {
          if (parent.kind === K_ROOT && parent.pendingKey === 'mapping') {
            kind = K_MAPPING;
          } else if (parent.kind === K_MAPPING) {
            kind = K_NODE;
            pendingIdx = parent.pendingIdx;
            pendingDup = parent.pendingDup;
            nodeKey = currentNodeKey;
          }
        }
      }
      if (kind === K_MAPPING) {
        mappingKeys = [];
        mappingIndex = new Map();
        firstStart = [];
        firstEnd = [];
        duplicateMappingKeys = [];
        dupRanges = new Map();
        nodeKeyDuplicates = new Map();
        currentNodeKey = '';
      }
      frames.push({
        isObject,
        kind,
        underMapping,
        expectKey: isObject,
        pendingKey: null,
        keys: isObject && kind !== K_MAPPING ? [] : null,
        keySet: null,
        pendingIdx,
        pendingDup,
        start: i,
        nodeKey,
      });
      i++;
      continue;
    }

    if (c === 0x7d || c === 0x5d) {
      if (extra > 0) {
        extra--;
      } else {
        const f = frames.pop();
        if (f !== undefined && f.kind === K_NODE && f.pendingIdx >= 0) {
          if (!f.pendingDup) {
            firstStart[f.pendingIdx] = f.start;
            firstEnd[f.pendingIdx] = i + 1;
          } else {
            dupRanges.get(f.nodeKey)?.push([f.start, i + 1]);
          }
        }
      }
      i++;
      continue;
    }

    if (c === 0x2c) {
      if (extra === 0) {
        const top = frames[frames.length - 1];
        if (top !== undefined && top.isObject) top.expectKey = true;
      }
      i++;
      continue;
    }

    i++;
  }

  const duplicateBodySha256 = new Map<string, string[]>();
  for (const [key, ranges] of dupRanges) {
    if (ranges.length > 0) duplicateBodySha256.set(key, ranges.map(([s, e]) => sha256Hex(text.slice(s, e))));
  }
  return { mappingKeys, duplicateMappingKeys, duplicateBodySha256, nodeKeyDuplicates, conversationKeyDuplicates };
}

/**
 * The iteration order of the mapping's nodes. The scanner order is trusted only when it agrees with what JSON.parse produced
 * (same number of distinct keys); otherwise the engine's own order is used and the caller reports KEY_ORDER_FALLBACK.
 */
export function resolveNodeOrder(scanKeys: readonly string[] | null, mapping: JsonObject): { keys: string[]; fallback: boolean } {
  const parsedKeys = Object.keys(mapping);
  if (scanKeys !== null && scanKeys.length === parsedKeys.length) {
    let consistent = true;
    for (const k of scanKeys) {
      if (!Object.hasOwn(mapping, k)) {
        consistent = false;
        break;
      }
    }
    if (consistent) return { keys: scanKeys.slice(), fallback: false };
  }
  return { keys: parsedKeys, fallback: true };
}

// ------------------------------------------------------------------------------------------
// Timestamps (tolerant reader on top of the strict unixSecondsToIso)
// ------------------------------------------------------------------------------------------

type TimeIssue = 'format' | 'out_of_range' | 'unparseable' | null;
interface TimeResult {
  iso: string | null;
  issue: TimeIssue;
}

const NUMERIC_STRING_RE = /^[0-9]{1,20}(?:\.[0-9]{1,12})?$/;
const ISO_TOLERANT_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?:([Zz])|([+-])(\d{2}):?(\d{2}))$/;

/**
 * ChatGPT writes unix SECONDS as JSON numbers. This reader additionally accepts numeric strings and ISO-8601 strings that
 * carry an explicit zone (reported as the info code TIMESTAMP_FORMAT, because the source then deviates from the documented
 * shape). A zone-less ISO string is refused: its zone would have to be guessed. Millisecond-scale numbers, 0, negatives,
 * non-finite values and anything outside 2015..2100 become null (TIMESTAMP_OUT_OF_RANGE): a timestamp is never invented.
 */
function convertTimestamp(value: unknown): TimeResult {
  if (value === null || value === undefined) return { iso: null, issue: null };
  if (typeof value === 'number') {
    const r = unixSecondsToIso(value);
    return r.iso === null ? { iso: null, issue: 'out_of_range' } : { iso: r.iso, issue: null };
  }
  if (typeof value === 'string') {
    if (value.length > 40) return { iso: null, issue: 'unparseable' };
    if (NUMERIC_STRING_RE.test(value)) {
      const r = unixSecondsToIso(Number(value));
      return r.iso === null ? { iso: null, issue: 'out_of_range' } : { iso: r.iso, issue: 'format' };
    }
    const m = ISO_TOLERANT_RE.exec(value);
    if (m === null) return { iso: null, issue: 'unparseable' };
    const wholeSecondMs = parseIsoUtcToEpochMs(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`);
    if (wholeSecondMs === null) return { iso: null, issue: 'unparseable' };
    let ms = wholeSecondMs;
    if (m[7] !== undefined) ms += Math.round(Number(`0.${m[7]}`) * 1000);
    if (m[9] !== undefined) {
      const hh = Number(m[10]);
      const mm = Number(m[11]);
      if (hh > 23 || mm > 59) return { iso: null, issue: 'unparseable' };
      const offset = (hh * 60 + mm) * 60_000;
      ms += m[9] === '+' ? -offset : offset;
    }
    const r = unixSecondsToIso(ms / 1000);
    return r.iso === null ? { iso: null, issue: 'out_of_range' } : { iso: r.iso, issue: 'format' };
  }
  return { iso: null, issue: 'unparseable' };
}

function noteTime(t: TimeResult, wc: WarningCollector, id: string): string | null {
  if (t.issue === 'format') wc.add('TIMESTAMP_FORMAT', `${INFO_PREFIX}A timestamp was given as a string instead of a number of seconds and was converted.`, id);
  else if (t.issue === 'out_of_range') wc.add('TIMESTAMP_OUT_OF_RANGE', 'A timestamp is not a plausible unix-seconds value (0, negative, non-finite, millisecond-scale or outside 2015..2100) and was set to null; the raw value is kept in rawSource.', id);
  else if (t.issue === 'unparseable') wc.add('TIMESTAMP_UNPARSEABLE', 'A timestamp has an unsupported type or format and was set to null; the raw value is kept in rawSource.', id);
  return t.iso;
}

// ------------------------------------------------------------------------------------------
// Text sanitation
// ------------------------------------------------------------------------------------------

/** Strip NUL (breaks C-string consumers and SQLite text functions) and replace lone surrogates; both are reported once per id. */
function sanitizeText(s: string, wc: WarningCollector, id: string): string {
  let out = s;
  if (out.includes('\u0000')) {
    out = out.replaceAll('\u0000', '');
    wc.add('NUL_STRIPPED', 'NUL characters were removed from text; the raw value is kept in rawSource.', id);
  }
  if (hasLoneSurrogate(out)) {
    out = replaceLoneSurrogates(out);
    wc.add('LONE_SURROGATE', 'Unpaired UTF-16 surrogates were replaced by U+FFFD in text; the raw value is kept in rawSource.', id);
  }
  return out;
}

/** `label` is always a static string from this file (never source text), so it is safe inside the message. */
function unexpected(wc: WarningCollector, id: string, label: string): void {
  wc.add('UNEXPECTED_FIELD_TYPE', `Optional field "${label}" is absent or has an unexpected type and was treated as absent.`, id, label);
}

/** A short optional string field: wrong type -> null + warning; cleaned; over-long -> truncated + warning. */
function shortString(value: unknown, max: number, wc: WarningCollector, id: string, label: string, opts: { warnWrongType?: boolean } = {}): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    if (opts.warnWrongType !== false) unexpected(wc, id, label);
    return null;
  }
  let s = sanitizeText(value, wc, id);
  if (s.length > max) {
    s = truncateChars(s, max);
    wc.add('TEXT_TRUNCATED', `Text field "${label}" exceeded its size limit and was truncated; the raw value is kept in rawSource.`, id, label);
  }
  return s;
}

function nonNegativeSafeInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// ------------------------------------------------------------------------------------------
// Asset index (AttachmentRef.presentInExportAs: only for names that really exist in the container)
// ------------------------------------------------------------------------------------------

interface AssetIndex {
  size: number;
  exact: Set<string>;
  /** Sorted by (basename, full name) in UTF-16 code unit order. */
  byBase: Array<{ base: string; name: string }>;
}

const assetIndexCache = new WeakMap<ReadonlySet<string>, AssetIndex>();

/** Mirrors validate.ts: names that could escape or confuse a path join never become `presentInExportAs`. */
function isSafeArchiveRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > MAX_ATTACHMENT_STRING || CONTROL_RE.test(p)) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').includes('..');
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildAssetIndex(names: ReadonlySet<string>): AssetIndex {
  const exact = new Set<string>();
  const byBase: Array<{ base: string; name: string }> = [];
  for (const name of names) {
    if (typeof name !== 'string' || !isSafeArchiveRelativePath(name)) continue;
    exact.add(name);
    byBase.push({ base: name.slice(name.lastIndexOf('/') + 1), name });
  }
  byBase.sort((a, b) => cmp(a.base, b.base) || cmp(a.name, b.name));
  return { size: names.size, exact, byBase };
}

function getAssetIndex(names: ReadonlySet<string> | undefined): AssetIndex | null {
  if (names === undefined || names.size === 0) return null;
  let idx = assetIndexCache.get(names);
  // The set is declared read-only, but a size change still invalidates the cache rather than serving stale answers.
  if (idx === undefined || idx.size !== names.size) {
    idx = buildAssetIndex(names);
    assetIndexCache.set(names, idx);
  }
  return idx;
}

function isIdBoundary(c: number): boolean {
  return c === 0x2d || c === 0x5f || c === 0x2e; // '-' '_' '.'
}

/**
 * Finds the container entry for an attachment id, in this priority: (1) an entry named exactly like the id, (2) `<id>.dat`
 * (the extension-less 2026 naming), (3) the smallest entry whose BASENAME starts with the id followed by '-', '_' or '.'.
 * The boundary rule avoids claiming `file-10-x.png` for id `file-1`. Returns null when nothing matches: GCR never
 * fabricates an asset, and a missed match is the safe direction of error.
 */
function resolvePresentName(index: AssetIndex | null, id: string | null): string | null {
  if (index === null || id === null || id.length === 0) return null;
  if (index.exact.has(id)) return id;
  const dat = `${id}.dat`;
  if (index.exact.has(dat)) return dat;
  const arr = index.byBase;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const entry = arr[mid];
    if (entry !== undefined && cmp(entry.base, id) < 0) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo, probes = 0; k < arr.length && probes < MAX_ASSET_PREFIX_PROBES; k++, probes++) {
    const entry = arr[k];
    if (entry === undefined || !entry.base.startsWith(id)) break;
    if (entry.base.length === id.length || isIdBoundary(entry.base.charCodeAt(id.length))) return entry.name;
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// Per-message content: blocks, text, attachments
// ------------------------------------------------------------------------------------------

interface AttachmentDraft {
  id: string | null;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  assetPointer: string | null;
}

interface MsgCtx {
  wc: WarningCollector;
  /** Safe id of the message (for warning ids). */
  mid: string;
  limits: ChatGPTAdapterLimits;
  /** message.metadata when it is an object. */
  meta: JsonObject | null;
  blocks: ContentBlock[];
  pieces: string[];
  attachments: AttachmentDraft[];
  usedBytes: number;
  truncated: boolean;
}

function newMsgCtx(wc: WarningCollector, mid: string, limits: ChatGPTAdapterLimits, meta: JsonObject | null): MsgCtx {
  return { wc, mid, limits, meta, blocks: [], pieces: [], attachments: [], usedBytes: 0, truncated: false };
}

/** Reserve room in the per-message text budget; returns the (possibly shortened) text that may be stored. */
function takeBudget(mc: MsgCtx, s: string): string {
  if (s.length === 0) return s;
  const sep = mc.pieces.length > 0 ? 1 : 0;
  const remaining = mc.limits.maxTextBytesPerMessage - mc.usedBytes - sep;
  const t = remaining <= 0 ? '' : truncateToBytes(s, remaining);
  if (t.length < s.length) mc.truncated = true;
  if (t.length > 0) {
    mc.usedBytes += sep + Buffer.byteLength(t, 'utf8');
    mc.pieces.push(t);
  }
  return t;
}

/** A block whose `text` is readable content (it also becomes part of message.text). */
function addTextBlock(mc: MsgCtx, type: string, raw: string, metadata?: unknown): void {
  const clean = sanitizeText(raw, mc.wc, mc.mid);
  const text = takeBudget(mc, clean);
  const block: ContentBlock = { type, text };
  if (metadata !== undefined) block.metadata = metadata;
  mc.blocks.push(block);
}

/** A reference block (image/audio/file/citation...): no text of its own; `placeholder` is the generic text shown in message.text. */
function addRefBlock(mc: MsgCtx, type: string, placeholder: string | null, metadata: unknown): void {
  if (placeholder !== null) takeBudget(mc, placeholder);
  mc.blocks.push({ type, metadata });
}

function addUnknownBlock(mc: MsgCtx, metadata: unknown): void {
  mc.blocks.push({ type: 'unknown', metadata });
}

function shapeWarning(mc: MsgCtx, label: string): void {
  mc.wc.add('CONTENT_SHAPE_UNEXPECTED', `A known content_type has an unexpected shape at "${label}"; the unexpected value is kept raw in the block metadata.`, mc.mid, label);
}

const POINTER_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/([\s\S]*)$/;

/**
 * The file id inside an asset pointer: `sediment://file_X` -> `file_X`, `file-service://file-ABC` -> `file-ABC`,
 * `sediment://<hash>#file_X#p_2.jpg` -> `file_X`. Pure string work; the pointer itself is never dereferenced.
 */
function fileIdFromPointer(pointer: string): string | null {
  const m = POINTER_SCHEME_RE.exec(pointer);
  const rest = m === null ? pointer : (m[1] ?? '');
  const segments = rest.split('#');
  const pick = segments.find((s) => s.startsWith('file-') || s.startsWith('file_')) ?? segments[0] ?? '';
  const last = pick.slice(pick.lastIndexOf('/') + 1);
  return isSafeId(last) ? last : null;
}

function addPointer(mc: MsgCtx, pointer: unknown, size: unknown): void {
  if (typeof pointer !== 'string') return;
  const ap = shortString(pointer, MAX_ATTACHMENT_STRING, mc.wc, mc.mid, 'asset_pointer');
  if (ap === null || ap.length === 0) return;
  mc.attachments.push({ id: fileIdFromPointer(ap), name: null, mimeType: null, sizeBytes: nonNegativeSafeInt(size), assetPointer: ap });
}

function pickStrings(obj: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const k of keys) {
    const v = own(obj, k);
    if (typeof v === 'string') setOwn(out, k, v);
  }
  return out;
}

function partKind(part: JsonObject): string | null {
  const ct = own(part, 'content_type');
  if (typeof ct === 'string') return ct;
  const t = own(part, 'type');
  return typeof t === 'string' ? t : null;
}

function addUnknownPart(mc: MsgCtx, part: unknown): void {
  mc.wc.add('UNKNOWN_PART_TYPE', 'Content parts with no recognised type were kept as raw unknown blocks and contribute no text.', mc.mid);
  addUnknownBlock(mc, { raw: part });
}

/** Typed block for an asset-pointer part. The raw part rides along; pointers become attachment METADATA only. */
function addPointerPart(mc: MsgCtx, type: string, placeholder: string, part: JsonObject, kind: string): void {
  const pointer = own(part, 'asset_pointer');
  addPointer(mc, pointer, own(part, 'size_bytes'));
  addRefBlock(mc, type, placeholder, { contentType: kind, ...(typeof pointer === 'string' ? { assetPointer: truncateChars(pointer, MAX_ATTACHMENT_STRING) } : {}), raw: part });
}

/**
 * One element of `parts[]`. Strings are text; objects are typed by their `content_type` (or `type`) and keep the raw
 * object in `metadata.raw`; numbers, booleans, null and nested arrays become `unknown` blocks. Nothing is ever coerced with
 * String(), so "[object Object]" cannot appear in text.
 */
function handlePart(part: unknown, mc: MsgCtx): void {
  if (typeof part === 'string') {
    addTextBlock(mc, 'text', part);
    return;
  }
  if (!isPlainObject(part)) {
    addUnknownPart(mc, part);
    return;
  }
  const kind = partKind(part);
  switch (kind) {
    case 'image_asset_pointer':
      addPointerPart(mc, 'image_ref', '[image]', part, kind);
      return;
    case 'audio_asset_pointer':
      addPointerPart(mc, 'audio_ref', '[audio]', part, kind);
      return;
    case 'video_container_asset_pointer':
      addPointerPart(mc, 'file_ref', '[file]', part, kind);
      return;
    case 'real_time_user_audio_video_asset_pointer': {
      // A live voice/video turn: the audio, the video container and every frame are separate pointers nested in the part.
      addPointer(mc, own(part, 'asset_pointer'), own(part, 'size_bytes'));
      for (const field of ['audio_asset_pointer', 'video_container_asset_pointer']) {
        const nested = own(part, field);
        if (isPlainObject(nested)) addPointer(mc, own(nested, 'asset_pointer'), own(nested, 'size_bytes'));
      }
      const frames = own(part, 'frames_asset_pointers');
      if (Array.isArray(frames)) {
        const limit = Math.min(frames.length, MAX_FRAME_POINTERS);
        for (let i = 0; i < limit; i++) {
          const f: unknown = frames[i];
          if (isPlainObject(f)) addPointer(mc, own(f, 'asset_pointer'), own(f, 'size_bytes'));
        }
      }
      addRefBlock(mc, 'audio_ref', '[audio]', { contentType: kind, raw: part });
      return;
    }
    case 'audio_transcription': {
      const t = own(part, 'text');
      if (typeof t === 'string') {
        const direction = own(part, 'direction');
        addTextBlock(mc, 'text', t, { contentType: kind, ...(typeof direction === 'string' ? { direction } : {}), raw: part });
      } else {
        addUnknownPart(mc, part);
      }
      return;
    }
    case 'search_result_group':
    case 'search_result':
      addRefBlock(mc, 'citation', null, { contentType: kind, raw: part });
      return;
    default: {
      if (kind !== null && kind.endsWith('_asset_pointer') && typeof own(part, 'asset_pointer') === 'string') {
        addPointerPart(mc, 'file_ref', '[file]', part, kind);
        return;
      }
      addUnknownPart(mc, part);
    }
  }
}

type ContentHandler = (content: JsonObject, mc: MsgCtx, ct: string) => void;

/** `text` / `multimodal_text`: `parts` is null/absent (fine), an array (normal, possibly mixed), or something else (kept raw + warning). */
const handleParts: ContentHandler = (content, mc, ct) => {
  const parts = own(content, 'parts');
  if (parts === undefined || parts === null) return;
  if (!Array.isArray(parts)) {
    shapeWarning(mc, `${ct}.parts`);
    addUnknownBlock(mc, { contentType: ct, field: 'parts', raw: parts });
    return;
  }
  const limit = Math.min(parts.length, mc.limits.maxPartsPerMessage);
  for (let i = 0; i < limit; i++) handlePart(parts[i], mc);
  if (parts.length > limit) {
    mc.wc.add('PARTS_TRUNCATED', 'A message has more parts than the per-message limit; the extra parts were not converted to blocks (they remain in rawSource).', mc.mid);
  }
};

/** A single string field becomes one block; a missing or non-string field is a shape warning and an empty typed block. */
function stringFieldHandler(blockType: string, field: string, metaKeys: readonly string[]): ContentHandler {
  return (content, mc, ct) => {
    const value = own(content, field);
    const metadata = { contentType: ct, ...pickStrings(content, metaKeys) };
    if (typeof value === 'string') {
      addTextBlock(mc, blockType, value, metadata);
    } else {
      shapeWarning(mc, `${ct}.${field}`);
      mc.blocks.push({ type: blockType, metadata: value === undefined || value === null ? metadata : { ...metadata, raw: value } });
    }
  };
}

/** `code`: the model's code (often a tool call; the target is in message.recipient). Not hidden. */
const handleCode: ContentHandler = (content, mc, ct) => {
  const text = own(content, 'text');
  const lang = own(content, 'language');
  const fmt = own(content, 'response_format_name');
  const metadata = { contentType: ct, ...(typeof lang === 'string' ? { language: lang } : {}), ...(typeof fmt === 'string' ? { responseFormatName: fmt } : {}) };
  if (typeof text === 'string') {
    addTextBlock(mc, 'code', text, metadata);
  } else {
    shapeWarning(mc, 'code.text');
    mc.blocks.push({ type: 'code', metadata });
  }
};

const handleBrowsingDisplay: ContentHandler = (content, mc, ct) => {
  const result = own(content, 'result');
  const assets = own(content, 'assets');
  const metadata = { contentType: ct, ...pickStrings(content, ['summary', 'tether_id']), ...(assets === undefined || assets === null ? {} : { assets }) };
  if (typeof result === 'string') {
    addTextBlock(mc, 'tool_output', result, metadata);
  } else {
    shapeWarning(mc, 'tether_browsing_display.result');
    mc.blocks.push({ type: 'tool_output', metadata });
  }
};

/** `thoughts`: array of {summary, content, chunks, finished} OR a JSON-encoded string of that array. Reasoning is kept, flagged hidden, never invented. */
const handleThoughts: ContentHandler = (content, mc, ct) => {
  let list: unknown = own(content, 'thoughts');
  const source = own(content, 'source_analysis_msg_id');
  const sourceMeta = typeof source === 'string' ? { sourceAnalysisMsgId: truncateChars(source, MAX_SHORT_STRING) } : {};
  if (typeof list === 'string') {
    const rawString = list;
    list = undefined;
    if (rawString.length <= MAX_THOUGHTS_JSON_CHARS) {
      try {
        list = JSON.parse(rawString);
      } catch {
        // Not JSON: keep the string raw below (reported as a shape warning); never interpret it.
        list = undefined;
      }
    }
    if (!Array.isArray(list)) {
      shapeWarning(mc, 'thoughts.thoughts_string');
      mc.blocks.push({ type: 'thoughts', metadata: { contentType: ct, ...sourceMeta, rawThoughts: rawString.length <= MAX_THOUGHTS_JSON_CHARS ? rawString : null } });
      return;
    }
  }
  if (!Array.isArray(list)) {
    if (list !== undefined && list !== null) shapeWarning(mc, 'thoughts.thoughts');
    mc.blocks.push({ type: 'thoughts', metadata: { contentType: ct, ...sourceMeta, ...(list === undefined || list === null ? {} : { raw: list }) } });
    return;
  }
  const limit = Math.min(list.length, mc.limits.maxPartsPerMessage);
  for (let i = 0; i < limit; i++) {
    const item: unknown = list[i];
    if (!isPlainObject(item)) {
      shapeWarning(mc, 'thoughts.item');
      mc.blocks.push({ type: 'thoughts', metadata: { contentType: ct, ...sourceMeta, index: i, raw: item } });
      continue;
    }
    const summary = own(item, 'summary');
    const body = own(item, 'content');
    const chunks = own(item, 'chunks');
    const finished = own(item, 'finished');
    const pieces: string[] = [];
    if (typeof summary === 'string' && summary.length > 0) pieces.push(summary);
    if (typeof body === 'string' && body.length > 0) pieces.push(body);
    else if (Array.isArray(chunks) && chunks.length > 0 && chunks.every((c) => typeof c === 'string')) pieces.push((chunks as string[]).join(''));
    const metadata = { contentType: ct, ...sourceMeta, index: i, ...(typeof finished === 'boolean' ? { finished } : {}) };
    if (pieces.length > 0) addTextBlock(mc, 'thoughts', pieces.join('\n'), metadata);
    else mc.blocks.push({ type: 'thoughts', metadata: { ...metadata, raw: item } });
  }
};

/**
 * Custom instructions / memory. The real values may live only in metadata.user_context_message_data (the content fields can
 * be empty or the string "None"); that is the only place this handler reaches outside `content`.
 */
const handleUserEditableContext: ContentHandler = (content, mc, ct) => {
  let any = false;
  for (const field of ['user_profile', 'user_instructions']) {
    const v = own(content, field);
    if (typeof v === 'string' && v.length > 0 && v !== 'None') {
      addTextBlock(mc, 'context', v, { contentType: ct, field });
      any = true;
    }
  }
  if (!any && mc.meta !== null) {
    const data = own(mc.meta, 'user_context_message_data');
    if (isPlainObject(data)) {
      for (const field of ['about_user_message', 'about_model_message']) {
        const v = own(data, field);
        if (typeof v === 'string' && v.length > 0) addTextBlock(mc, 'context', v, { contentType: ct, field: `metadata.user_context_message_data.${field}` });
      }
    }
  }
};

const handleModelEditableContext: ContentHandler = (content, mc, ct) => {
  for (const field of ['model_set_context', 'repository', 'repo_summary', 'structured_context']) {
    const v = own(content, field);
    if (typeof v === 'string') {
      if (v.length > 0) addTextBlock(mc, 'context', v, { contentType: ct, field });
    } else if (v !== undefined && v !== null) {
      mc.blocks.push({ type: 'context', metadata: { contentType: ct, field, raw: v } });
    }
  }
};

const handleComputerOutput: ContentHandler = (content, mc, ct) => {
  const screenshot = own(content, 'screenshot');
  const ephemeral = own(content, 'is_ephemeral');
  mc.blocks.push({ type: 'tool_output', metadata: { contentType: ct, ...pickStrings(content, ['computer_id', 'tether_id', 'state']), ...(typeof ephemeral === 'boolean' ? { isEphemeral: ephemeral } : {}) } });
  if (isPlainObject(screenshot)) handlePart(screenshot, mc);
  else if (screenshot !== undefined && screenshot !== null) addUnknownPart(mc, screenshot);
};

/** Named types whose field set is unknown (research 6.5): keep the whole payload raw, interpret nothing, no warning. */
const handleRawOnly: ContentHandler = (content, mc, ct) => {
  addUnknownBlock(mc, { contentType: ct, raw: content });
};

const CONTENT_HANDLERS: ReadonlyMap<string, ContentHandler> = new Map<string, ContentHandler>([
  ['text', handleParts],
  ['multimodal_text', handleParts],
  ['code', handleCode],
  ['execution_output', stringFieldHandler('tool_output', 'text', [])],
  ['tether_quote', stringFieldHandler('citation', 'text', ['url', 'domain', 'title'])],
  ['tether_browsing_display', handleBrowsingDisplay],
  ['tether_browsing_code', handleRawOnly],
  ['sonic_webpage', stringFieldHandler('citation', 'text', ['url', 'domain', 'title', 'snippet', 'pub_date', 'crawl_date', 'ref_id'])],
  ['system_error', stringFieldHandler('error', 'text', ['name'])],
  ['user_editable_context', handleUserEditableContext],
  ['model_editable_context', handleModelEditableContext],
  ['thoughts', handleThoughts],
  ['reasoning_recap', stringFieldHandler('reasoning_recap', 'content', [])],
  ['computer_output', handleComputerOutput],
  ['citable_code_output', stringFieldHandler('tool_output', 'output_str', [])],
  ['app_pairing_content', handleRawOnly],
]);

/** Builds blocks/text for one message's `content`. Returns the content_type string (verbatim, sanitized) or null. */
function buildContent(content: unknown, mc: MsgCtx): string | null {
  if (content === undefined || content === null) {
    mc.wc.add('CONTENT_MALFORMED', 'A message has no usable content object; it was kept with no content blocks.', mc.mid, 'absent');
    return null;
  }
  if (!isPlainObject(content)) {
    mc.wc.add('CONTENT_MALFORMED', 'A message has a content value that is not an object; it is kept raw in an unknown block.', mc.mid, 'not_object');
    addUnknownBlock(mc, { raw: content });
    return null;
  }
  const ctRaw = own(content, 'content_type');
  if (typeof ctRaw !== 'string') {
    mc.wc.add('CONTENT_MALFORMED', 'A message content object has no content_type; it is kept raw in an unknown block.', mc.mid, 'no_content_type');
    addUnknownBlock(mc, { raw: content });
    return null;
  }
  // The SANITIZED type is what is stored on the message, so it is also what selects the handler (stored and interpreted agree).
  const ct = shortString(ctRaw, MAX_SHORT_STRING, mc.wc, mc.mid, 'content_type') ?? '';
  const handler = CONTENT_HANDLERS.get(ct);
  if (handler !== undefined) {
    handler(content, mc, ct);
  } else {
    // WHY aggregated per type: a drifting export can carry one new type thousands of times; one warning with a count is enough.
    mc.wc.add('UNKNOWN_CONTENT_TYPE', `Unknown content_type "${safeToken(ct)}" was kept as raw 'unknown' blocks and contributes no text.`, mc.mid, ct.length <= 256 ? ct : sha256Hex(ct));
    addUnknownBlock(mc, { contentType: ct, raw: content });
  }
  return ct;
}

/** metadata.attachments[] (id, name, mime_type|mimeType, size variants). Token-count size fields are NOT bytes and are ignored. */
function collectMetadataAttachments(mc: MsgCtx): void {
  if (mc.meta === null) return;
  const list = own(mc.meta, 'attachments');
  if (list === undefined || list === null) return;
  if (!Array.isArray(list)) {
    unexpected(mc.wc, mc.mid, 'metadata.attachments');
    return;
  }
  const limit = Math.min(list.length, mc.limits.maxPartsPerMessage);
  for (let i = 0; i < limit; i++) {
    const a: unknown = list[i];
    if (!isPlainObject(a)) {
      unexpected(mc.wc, mc.mid, 'metadata.attachments[]');
      continue;
    }
    const idRaw = own(a, 'id');
    const id = typeof idRaw === 'string' && isSafeId(idRaw) ? idRaw : null;
    if (idRaw !== undefined && idRaw !== null && id === null) {
      unexpected(mc.wc, mc.mid, 'attachment.id');
    }
    const mime = own(a, 'mime_type') ?? own(a, 'mimeType');
    const sizeRaw = [own(a, 'size'), own(a, 'size_bytes'), own(a, 'file_size_bytes'), own(a, 'sizeBytes')].find((v) => v !== undefined && v !== null);
    const pointer = own(a, 'asset_pointer');
    mc.attachments.push({
      id,
      name: shortString(own(a, 'name'), MAX_ATTACHMENT_STRING, mc.wc, mc.mid, 'attachment.name'),
      mimeType: shortString(mime, MAX_SHORT_STRING, mc.wc, mc.mid, 'attachment.mime_type'),
      sizeBytes: nonNegativeSafeInt(sizeRaw),
      assetPointer: shortString(pointer, MAX_ATTACHMENT_STRING, mc.wc, mc.mid, 'attachment.asset_pointer'),
    });
  }
}

/** Merge drafts that describe the same file (same id, or same pointer when there is no id) and resolve presence in the container. */
function finalizeAttachments(drafts: readonly AttachmentDraft[], index: AssetIndex | null): AttachmentRef[] {
  if (drafts.length === 0) return [];
  const merged: AttachmentDraft[] = [];
  const byId = new Map<string, AttachmentDraft>();
  const byPointer = new Map<string, AttachmentDraft>();
  for (const d of drafts) {
    const existing = d.id !== null ? byId.get(d.id) : d.assetPointer !== null ? byPointer.get(d.assetPointer) : undefined;
    if (existing === undefined) {
      const copy = { ...d };
      merged.push(copy);
      if (copy.id !== null) byId.set(copy.id, copy);
      else if (copy.assetPointer !== null) byPointer.set(copy.assetPointer, copy);
    } else {
      existing.name ??= d.name;
      existing.mimeType ??= d.mimeType;
      existing.sizeBytes ??= d.sizeBytes;
      existing.assetPointer ??= d.assetPointer;
    }
  }
  return merged.map((d) => ({
    id: d.id,
    name: d.name,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    assetPointer: d.assetPointer,
    presentInExportAs: resolvePresentName(index, d.id),
  }));
}

// ------------------------------------------------------------------------------------------
// Conversation conversion
// ------------------------------------------------------------------------------------------

interface NodeDraft {
  /** Raw mapping key. */
  key: string;
  /** Safe record id (== key unless the key is unusable as an identifier). */
  id: string;
  ordinal: number;
  parentRaw: string | null;
  /** Declared children (raw ids, strings only), or null when the source omitted / garbled the list. */
  declared: string[] | null;
  /** -2 root (null parent), -1 dangling parent, >= 0 index of the parent draft. */
  parentIdx: number;
  createdMs: number;
  record: MessageRecord;
}

const PARENT_ROOT = -2;
const PARENT_DANGLING = -1;

interface MessageFacts {
  role: string;
  hasRecipient: boolean;
  hasStatus: boolean;
  hasModel: boolean;
}

function buildMessageRecord(
  msg: JsonObject,
  base: { id: string; conversationId: string; ordinal: number },
  wc: WarningCollector,
  limits: ChatGPTAdapterLimits,
  assets: AssetIndex | null,
): { record: MessageRecord; facts: MessageFacts } {
  const mid = base.id;

  // --- author / role (open strings, verbatim) ---
  const authorVal = own(msg, 'author');
  let role: string | null = null;
  let authorName: string | null = null;
  if (isPlainObject(authorVal)) {
    role = shortString(own(authorVal, 'role'), MAX_SHORT_STRING, wc, mid, 'author.role', { warnWrongType: false });
    authorName = shortString(own(authorVal, 'name'), MAX_SHORT_STRING, wc, mid, 'author.name');
  } else if (authorVal !== undefined && authorVal !== null) {
    unexpected(wc, mid, 'message.author');
  }
  if (role === null) {
    // Very early backend payloads carried a flat `role`; accepted as a fallback only (research 6.4 / EC-62).
    const legacy = shortString(own(msg, 'role'), MAX_SHORT_STRING, wc, mid, 'role', { warnWrongType: false });
    if (legacy !== null) {
      role = legacy;
      wc.add('LEGACY_ROLE_FIELD', 'The role was read from a legacy flat "role" field because author.role is missing.', mid);
    }
  }
  if (role === null) {
    unexpected(wc, mid, 'author.role');
    role = '';
  }

  // --- metadata (object or absent) ---
  const metaVal = own(msg, 'metadata');
  let meta: JsonObject | null = null;
  if (isPlainObject(metaVal)) meta = metaVal;
  else if (metaVal !== undefined && metaVal !== null) unexpected(wc, mid, 'message.metadata');

  // modelSlug: ONLY the per-message metadata.model_slug. default_model_slug (message- or conversation-level) is never used.
  const modelSlugRaw = meta === null ? null : shortString(own(meta, 'model_slug'), MAX_SHORT_STRING, wc, mid, 'metadata.model_slug');
  const modelSlug = modelSlugRaw === null || modelSlugRaw.length === 0 ? null : modelSlugRaw;

  const channel = shortString(own(msg, 'channel'), MAX_SHORT_STRING, wc, mid, 'message.channel');
  const recipient = shortString(own(msg, 'recipient'), MAX_SHORT_STRING, wc, mid, 'message.recipient');
  const status = shortString(own(msg, 'status'), MAX_SHORT_STRING, wc, mid, 'message.status');

  const createdAt = noteTime(convertTimestamp(own(msg, 'create_time')), wc, mid);
  const updatedAt = noteTime(convertTimestamp(own(msg, 'update_time')), wc, mid);

  // --- content ---
  const mc = newMsgCtx(wc, mid, limits, meta);
  const contentType = buildContent(own(msg, 'content'), mc);
  collectMetadataAttachments(mc);
  if (mc.truncated) wc.add('TEXT_TRUNCATED', 'Text field "message.text" exceeded the per-message size limit and was truncated; the raw value is kept in rawSource.', mid, 'message.text');
  const text = mc.pieces.length === 1 ? (mc.pieces[0] as string) : mc.pieces.join('\n');

  const hidden = (meta !== null && own(meta, 'is_visually_hidden_from_conversation') === true) || role === 'system' || (contentType !== null && HIDDEN_CONTENT_TYPES.has(contentType));

  const record: MessageRecord = {
    id: base.id,
    conversationId: base.conversationId,
    parentId: null,
    childIds: [],
    nodeKind: 'message',
    authorRole: role,
    authorName,
    modelSlug,
    channel,
    recipient,
    contentType,
    status,
    hidden,
    createdAt,
    updatedAt,
    text,
    blocks: mc.blocks,
    attachments: finalizeAttachments(mc.attachments, assets),
    ordinal: base.ordinal,
    rawSource: msg,
  };
  return { record, facts: { role, hasRecipient: recipient !== null, hasStatus: status !== null, hasModel: modelSlug !== null } };
}

function structuralRecord(base: { id: string; conversationId: string; ordinal: number }, raw: unknown): MessageRecord {
  const rec: MessageRecord = {
    id: base.id,
    conversationId: base.conversationId,
    parentId: null,
    childIds: [],
    nodeKind: 'structural_empty',
    authorRole: '',
    authorName: null,
    modelSlug: null,
    channel: null,
    recipient: null,
    contentType: null,
    status: null,
    hidden: false,
    createdAt: null,
    updatedAt: null,
    text: '',
    blocks: [],
    attachments: [],
    ordinal: base.ordinal,
  };
  if (raw !== undefined) rec.rawSource = raw;
  return rec;
}

/** Iterative cycle / dangling-parent census over the parent-index array (each node has at most one parent). */
function censusForest(parentIdx: Int32Array): { cycleNodes: number; dangling: number; edges: number } {
  const n = parentIdx.length;
  const state = new Uint8Array(n); // 0 new, 1 on the current walk, 2 finished
  let cycleNodes = 0;
  let dangling = 0;
  let edges = 0;
  const walk: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = parentIdx[i] as number;
    if (p === PARENT_DANGLING) dangling++;
    else if (p >= 0) edges++;
    if (state[i] !== 0) continue;
    walk.length = 0;
    let cur = i;
    while (cur >= 0 && state[cur] === 0) {
      state[cur] = 1;
      walk.push(cur);
      cur = parentIdx[cur] as number;
    }
    if (cur >= 0 && state[cur] === 1) {
      // The walk ran into itself: count the members of that cycle (from `cur` around to `cur`).
      let m = cur;
      do {
        cycleNodes++;
        m = parentIdx[m] as number;
      } while (m !== cur);
    }
    for (const w of walk) state[w] = 2;
  }
  return { cycleNodes, dangling, edges };
}

export interface ChatGPTAdapterOptions {
  limits?: Partial<ChatGPTAdapterLimits>;
  /** Replaceable key scanner (test seam; the default is scanConversationElement). */
  scanner?: (text: string) => ElementScan;
}

function resolveLimits(partial: Partial<ChatGPTAdapterLimits> | undefined): ChatGPTAdapterLimits {
  const merged: ChatGPTAdapterLimits = { ...DEFAULT_CHATGPT_ADAPTER_LIMITS };
  if (partial !== undefined) {
    for (const k of Object.keys(DEFAULT_CHATGPT_ADAPTER_LIMITS) as Array<keyof ChatGPTAdapterLimits>) {
      const v = partial[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
        throw new GcrError('INVALID_ARGUMENT', 'Adapter limits must be positive safe integers.', { details: { limit: k } });
      }
      merged[k] = v;
    }
  }
  if (merged.maxTextBytesPerMessage > MAX_TEXT_BYTES) {
    throw new GcrError('INVALID_ARGUMENT', 'maxTextBytesPerMessage cannot exceed the domain limit.', { details: { limit: 'maxTextBytesPerMessage', max: MAX_TEXT_BYTES } });
  }
  return merged;
}

function parseError(elementIndex: number, reason: string): GcrError {
  return new GcrError('IMPORT_PARSE_ERROR', 'A conversation element is not valid JSON.', {
    remedy: 'The element is skipped unless --strict is used. If every element fails, the file is probably truncated or not a ChatGPT export: obtain a fresh export.',
    details: { elementIndex, reason },
  });
}

export class ChatGPTExportAdapter implements ConversationSourceAdapter {
  readonly name = 'chatgpt-export';
  readonly provider = 'chatgpt' as const;
  readonly provenance = 'official_chatgpt_export' as const;

  private readonly limits: ChatGPTAdapterLimits;
  private readonly scan: (text: string) => ElementScan;

  constructor(options: ChatGPTAdapterOptions = {}) {
    this.limits = resolveLimits(options.limits);
    this.scan = options.scanner ?? scanConversationElement;
  }

  normalizeElementText(text: string, ctx: AdapterContext, elementIndex: number): AdapterOutcome {
    if (typeof text !== 'string') throw parseError(elementIndex, 'not_text');
    const sha = sha256Hex(text);

    // (2) Parse. The error never carries the parser's message: V8 quotes a fragment of the input in it.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      throw parseError(elementIndex, 'invalid_json');
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return skipped('NON_OBJECT_ENTRY', 'The element is not a JSON object and was skipped.');
    }
    const conv = parsed as JsonObject;
    if (Object.keys(conv).length === 0) {
      return skipped('EMPTY_CONVERSATION_ENTRY', 'The element is an empty object and was skipped.');
    }
    // A `{"conversations":[...]}` wrapper is the runner's job to unwrap; if one arrives here it is NOT a conversation.
    if (!Object.hasOwn(conv, 'mapping') || Array.isArray(own(conv, 'conversations'))) {
      return skipped('NOT_A_CONVERSATION', 'The element has no conversation mapping (or is a wrapper object) and was skipped.');
    }
    return this.convert(conv, text, sha, ctx, Number.isSafeInteger(elementIndex) && elementIndex >= 0 ? elementIndex : 0);
  }

  private convert(conv: JsonObject, text: string, sha: string, ctx: AdapterContext, elementIndex: number): AdapterOutcome {
    const wc = new WarningCollector();
    const limits = this.limits;

    // ---- identity: conversation_id ?? id --------------------------------------------------------------------------
    const cidRaw = own(conv, 'conversation_id');
    const idRaw = own(conv, 'id');
    const usable = (v: unknown): v is string => typeof v === 'string' && isSafeId(v);
    const canon = (s: string): string => (isUuid(s) ? s.toLowerCase() : s);
    let conversationId: string;
    let idWasSynthesized = false;
    if (usable(cidRaw)) conversationId = canon(cidRaw);
    else if (usable(idRaw)) conversationId = canon(idRaw);
    else {
      conversationId = `gcr-synth-${sha.slice(0, 32)}-${elementIndex}`;
      idWasSynthesized = true;
    }
    const chosenRaw = usable(cidRaw) ? cidRaw : usable(idRaw) ? idRaw : null;
    if (idWasSynthesized) {
      wc.add('CONVERSATION_ID_MISSING', 'The conversation has no usable id or conversation_id; a deterministic id was derived from the element hash and position.', conversationId);
    } else {
      if (chosenRaw !== null && canon(chosenRaw) !== chosenRaw) {
        wc.add('ID_CASE_NORMALIZED', `${INFO_PREFIX}An upper-case UUID conversation id was lower-cased (the raw value is kept in rawMetadata).`, conversationId);
      }
      if (cidRaw !== undefined && cidRaw !== null && !usable(cidRaw)) unexpected(wc, conversationId, 'conversation_id');
      if (usable(cidRaw) && usable(idRaw) && canon(cidRaw) !== canon(idRaw)) {
        wc.add('ID_ALIAS_MISMATCH', 'id and conversation_id differ; conversation_id was used (both are kept in rawMetadata).', [conversationId, sanitizeRef(canon(idRaw))]);
      }
    }

    // ---- simple conversation fields ---------------------------------------------------------------------------------
    const titleVal = own(conv, 'title');
    let title: string | null = null;
    if (typeof titleVal === 'string') {
      title = sanitizeText(titleVal, wc, conversationId);
      if (title.length > MAX_TITLE_LENGTH) {
        title = truncateChars(title, MAX_TITLE_LENGTH);
        wc.add('TEXT_TRUNCATED', 'Text field "title" exceeded its size limit and was truncated; the raw value is kept in rawMetadata.', conversationId, 'title');
      }
    } else if (titleVal !== undefined && titleVal !== null) {
      unexpected(wc, conversationId, 'title');
    }
    const createdAt = noteTime(convertTimestamp(own(conv, 'create_time')), wc, conversationId);
    const updatedAt = noteTime(convertTimestamp(own(conv, 'update_time')), wc, conversationId);
    // Conversation-level model: informational default only. `default_model_slug` first, then the newer `model_slug`.
    const defaultModelSlug =
      shortString(own(conv, 'default_model_slug'), MAX_SHORT_STRING, wc, conversationId, 'default_model_slug') ??
      shortString(own(conv, 'model_slug'), MAX_SHORT_STRING, wc, conversationId, 'model_slug');

    // ---- the mapping --------------------------------------------------------------------------------------------------
    const mappingVal = own(conv, 'mapping');
    const gcrExtra: JsonObject = {};
    let nodeKeys: string[] = [];
    let mapping: JsonObject | null = null;
    let scan: ElementScan | null = null;
    const completenessReasons: string[] = [];
    if (isPlainObject(mappingVal)) {
      mapping = mappingVal;
      scan = this.scan(text);
      const order = resolveNodeOrder(scan.mappingKeys, mapping);
      nodeKeys = order.keys;
      if (order.fallback) {
        wc.add('KEY_ORDER_FALLBACK', 'The file order of the mapping keys could not be established; the JSON engine order was used for node ordinals.', conversationId);
      }
    } else {
      wc.add('MAPPING_INVALID', 'The mapping is not an object; the conversation was kept with no messages (the raw value is kept in rawMetadata).', conversationId);
      setOwn(gcrExtra, 'unsupportedMapping', mappingVal);
      completenessReasons.push('mapping_invalid');
    }

    if (nodeKeys.length > limits.maxNodesPerConversation) {
      wc.add('TOO_MANY_NODES', `The mapping has ${nodeKeys.length} nodes; only the first ${limits.maxNodesPerConversation} (file order) were kept.`, conversationId);
      nodeKeys = nodeKeys.slice(0, limits.maxNodesPerConversation);
      completenessReasons.push('node_limit');
    }
    if (nodeKeys.length === 0 && mapping !== null) completenessReasons.push('empty_mapping');

    // ---- node ids: the mapping key is the identity (never node.id / message.id) ------------------------------------
    const nodeCount = nodeKeys.length;
    const ids: string[] = new Array<string>(nodeCount);
    const usedIds = new Set<string>();
    for (let k = 0; k < nodeCount; k++) {
      const key = nodeKeys[k] as string;
      if (isSafeId(key)) {
        ids[k] = key;
        usedIds.add(key);
      }
    }
    for (let k = 0; k < nodeCount; k++) {
      if (ids[k] !== undefined) continue;
      // An unusable key (empty, > 512 chars, control character, lone surrogate) gets a stand-in derived from the key itself.
      const hash = sha256Hex(nodeKeys[k] as string).slice(0, 24);
      let cand = `gcr-node-${hash}`;
      for (let bump = 1; usedIds.has(cand); bump++) cand = `gcr-node-${hash}-${bump}`;
      ids[k] = cand;
      usedIds.add(cand);
      wc.add('INVALID_NODE_ID', 'A mapping key is not usable as an identifier (empty, too long, or containing control characters); a deterministic stand-in id was used.', cand);
    }
    const idByKey = new Map<string, string>();
    for (let k = 0; k < nodeCount; k++) idByKey.set(nodeKeys[k] as string, ids[k] as string);
    const resolveId = (raw: string): string => idByKey.get(raw) ?? sanitizeRef(raw);

    // ---- duplicates found by the pre-pass ----------------------------------------------------------------------------
    let hadDuplicateNodes = false;
    if (scan !== null) {
      for (const dupKey of scan.duplicateMappingKeys) {
        hadDuplicateNodes = true;
        wc.add('DUPLICATE_NODE_ID', 'A node id occurs more than once in the mapping; like JSON.parse, the LAST body was kept (all bodies are hashed in rawMetadata._gcr.duplicateNodeBodySha256).', resolveId(dupKey));
      }
      if (hadDuplicateNodes) completenessReasons.push('duplicate_node_id');
      const dupKeyMessage = 'An object contains the same key more than once; like JSON.parse, the LAST value was kept.';
      if (scan.conversationKeyDuplicates > 0) wc.add('DUPLICATE_KEY', dupKeyMessage, conversationId, '', scan.conversationKeyDuplicates);
      for (const [nodeKey, count] of scan.nodeKeyDuplicates) wc.add('DUPLICATE_KEY', dupKeyMessage, resolveId(nodeKey), '', count);
      if (scan.duplicateBodySha256.size > 0) {
        const entries: JsonObject[] = [];
        for (const [dupKey, hashes] of scan.duplicateBodySha256) {
          if (entries.length >= MAX_WARNING_IDS) break;
          entries.push({ id: resolveId(dupKey), bodySha256: hashes });
        }
        setOwn(gcrExtra, 'duplicateNodeBodySha256', entries);
      }
    }

    // ---- phase A: drafts and records ---------------------------------------------------------------------------------
    const assets = getAssetIndex(ctx.availableAssetNames);
    const drafts: NodeDraft[] = [];
    const idxByKey = new Map<string, number>();
    const seenMessageIds = new Map<string, string>();
    const obs: FormatObservations = {
      nodesWithChildrenDeclared: 0,
      nodesWithChildrenAbsent: 0,
      hasCurrentNode: false,
      roleCounts: {},
      messagesWithRecipient: 0,
      messagesWithStatus: 0,
      messagesWithModelSlug: 0,
      hiddenMessages: 0,
      rootIsLiteralClientCreatedRoot: false,
    };
    const roleCounts = new Map<string, number>();
    let malformedParents = 0;
    let anyNonEmptyDeclared = false;

    for (let k = 0; k < nodeCount; k++) {
      const key = nodeKeys[k] as string;
      const id = ids[k] as string;
      const rawNode = mapping === null ? undefined : own(mapping, key);
      let nodeObj: JsonObject | null = null;
      if (isPlainObject(rawNode)) nodeObj = rawNode;
      else wc.add('NODE_NOT_OBJECT', 'A mapping value is not an object; it was kept as a structural node with no parent.', id);

      // parent: authoritative edge
      let parentRaw: string | null = null;
      if (nodeObj !== null) {
        const pv = own(nodeObj, 'parent');
        if (typeof pv === 'string') parentRaw = pv;
        else if (pv !== undefined && pv !== null) {
          unexpected(wc, id, 'node.parent');
          malformedParents++;
        }
      }

      // children: optional ordering hint
      let declared: string[] | null = null;
      const cv = nodeObj === null ? undefined : own(nodeObj, 'children');
      if (Array.isArray(cv)) {
        declared = [];
        for (const c of cv) {
          if (typeof c === 'string') declared.push(c);
          else unexpected(wc, id, 'node.children[]');
        }
        if (declared.length > 0) anyNonEmptyDeclared = true;
        obs.nodesWithChildrenDeclared++;
      } else {
        if (cv !== undefined && cv !== null) unexpected(wc, id, 'node.children');
        obs.nodesWithChildrenAbsent++;
      }

      // identity cross-checks (recorded, not trusted)
      if (nodeObj !== null) {
        const nid = own(nodeObj, 'id');
        if (typeof nid === 'string' && nid !== key) wc.add('NODE_ID_MISMATCH', 'A node has an id field that differs from its mapping key; the mapping key is the identity.', id);
      }

      // message
      const messageVal = nodeObj === null ? undefined : own(nodeObj, 'message');
      const base = { id, conversationId, ordinal: k };
      let record: MessageRecord;
      if (isPlainObject(messageVal)) {
        const built = buildMessageRecord(messageVal, base, wc, limits, assets);
        record = built.record;
        const mv = own(messageVal, 'id');
        if (typeof mv === 'string') {
          if (mv !== key) wc.add('MESSAGE_ID_MISMATCH', 'A message has an id field that differs from its node key; the node key is the identity.', id);
          const first = seenMessageIds.get(mv);
          if (first === undefined) seenMessageIds.set(mv, id);
          else {
            wc.add('DUPLICATE_MESSAGE_ID', 'The same message.id appears in more than one node.', [first, id]);
          }
        }
        roleCounts.set(built.facts.role, (roleCounts.get(built.facts.role) ?? 0) + 1);
        if (built.facts.hasRecipient) obs.messagesWithRecipient++;
        if (built.facts.hasStatus) obs.messagesWithStatus++;
        if (built.facts.hasModel) obs.messagesWithModelSlug++;
        if (record.hidden) obs.hiddenMessages++;
      } else {
        if (messageVal !== undefined && messageVal !== null) wc.add('MESSAGE_NOT_OBJECT', 'A node has a message value that is not an object; it was kept as a structural node.', id);
        // A structural node keeps its whole node object as rawSource (a null message has nothing else to preserve).
        record = structuralRecord(base, messageVal === undefined || messageVal === null ? rawNode : messageVal);
      }

      const ms = parseIsoUtcToEpochMs(record.createdAt);
      drafts.push({ key, id, ordinal: k, parentRaw, declared, parentIdx: PARENT_ROOT, createdMs: ms === null ? Number.POSITIVE_INFINITY : ms, record });
      idxByKey.set(key, k);
    }

    // ---- phase B: edges ---------------------------------------------------------------------------------------------
    const parentIdx = new Int32Array(drafts.length);
    for (let k = 0; k < drafts.length; k++) {
      const d = drafts[k] as NodeDraft;
      if (d.parentRaw === null) {
        d.parentIdx = PARENT_ROOT;
        d.record.parentId = null;
        if (d.key === 'client-created-root') obs.rootIsLiteralClientCreatedRoot = true;
      } else {
        const pi = idxByKey.get(d.parentRaw);
        d.parentIdx = pi === undefined ? PARENT_DANGLING : pi;
        d.record.parentId = pi === undefined ? sanitizeRef(d.parentRaw) : (drafts[pi] as NodeDraft).id;
      }
      parentIdx[k] = d.parentIdx;
    }
    const census = censusForest(parentIdx);
    if (census.cycleNodes > 0) completenessReasons.push('cycle');
    if (census.dangling > 0) completenessReasons.push('missing_parent');
    if (malformedParents > 0) completenessReasons.push('malformed_parent');

    // children: declared order when usable, else derived from parent pointers.
    const treatEmptyAsAbsent = !anyNonEmptyDeclared && census.edges > 0;
    const derive = (d: NodeDraft): boolean => d.declared === null || (treatEmptyAsAbsent && d.declared.length === 0);
    let needsDerivation = treatEmptyAsAbsent;
    for (const d of drafts) {
      if (d.declared === null) {
        needsDerivation = true;
        break;
      }
    }
    let derivedKids: Array<string[] | undefined> = [];
    const hasChild = new Uint8Array(drafts.length);
    for (let k = 0; k < drafts.length; k++) {
      const p = (drafts[k] as NodeDraft).parentIdx;
      if (p >= 0) hasChild[p] = 1;
    }
    if (needsDerivation) {
      derivedKids = new Array<string[] | undefined>(drafts.length);
      // Derived order: createdAt asc (unknown last), file ordinal, id.
      const order: NodeDraft[] = drafts.filter((d) => d.parentIdx >= 0);
      order.sort((a, b) => (a.createdMs !== b.createdMs ? (a.createdMs < b.createdMs ? -1 : 1) : a.ordinal !== b.ordinal ? a.ordinal - b.ordinal : cmp(a.id, b.id)));
      for (const d of order) {
        const list = derivedKids[d.parentIdx];
        if (list === undefined) derivedKids[d.parentIdx] = [d.id];
        else list.push(d.id);
      }
      if (obs.nodesWithChildrenAbsent > 0 || treatEmptyAsAbsent) {
        wc.add(
          'CHILDREN_ABSENT',
          treatEmptyAsAbsent && obs.nodesWithChildrenAbsent === 0
            ? "Every 'children' list is empty although parent pointers define edges; child lists were derived from parent pointers."
            : "Some nodes have no 'children' list (reported for exports since mid-2026); child lists were derived from parent pointers.",
          conversationId,
        );
      }
    }
    for (let k = 0; k < drafts.length; k++) {
      const d = drafts[k] as NodeDraft;
      if (derive(d)) {
        d.record.childIds = derivedKids[k] ?? [];
        continue;
      }
      // Declared list: kept as declared (order is meaningful); inconsistencies are reported by the domain analyzer.
      const declared = d.declared as string[];
      const out: string[] = [];
      if (declared.length > 1) {
        const seen = new Set<string>();
        let dup = false;
        for (const raw of declared) {
          if (seen.has(raw)) {
            dup = true;
            continue;
          }
          seen.add(raw);
          out.push(resolveId(raw));
        }
        if (dup) wc.add('DUPLICATE_CHILD_ENTRY', 'A children list names the same child more than once; the repeats were dropped.', d.id);
      } else {
        for (const raw of declared) out.push(resolveId(raw));
      }
      for (const raw of declared) {
        if (!idxByKey.has(raw)) wc.add('CHILD_NOT_FOUND', 'A children list names a node that does not exist; the phantom edge is ignored by the tree analysis.', resolveId(raw));
      }
      d.record.childIds = out;
    }

    // ---- current node (the active-branch pointer): only a real mapping key counts ---------------------------------------
    const cnVal = own(conv, 'current_node');
    let currentNodeId: string | null = null;
    if (cnVal === undefined || cnVal === null) {
      wc.add('NO_CURRENT_NODE', 'The source gives no current_node; the active branch is unknown and is not guessed.', conversationId);
      completenessReasons.push('no_current_node');
    } else if (typeof cnVal === 'string' && idxByKey.has(cnVal)) {
      const ci = idxByKey.get(cnVal) as number;
      currentNodeId = (drafts[ci] as NodeDraft).id;
      if (hasChild[ci] === 1) {
        wc.add('CURRENT_NODE_NOT_LEAF', `${INFO_PREFIX}current_node is not a leaf; the active branch passes through it.`, currentNodeId);
      }
    } else {
      wc.add('INVALID_CURRENT_NODE', 'current_node does not name a node of this conversation; the active branch is unknown and is not guessed.', typeof cnVal === 'string' ? sanitizeRef(cnVal) : conversationId);
      completenessReasons.push('invalid_current_node');
    }
    obs.hasCurrentNode = currentNodeId !== null;

    // ---- completeness (FR-09): claim a full tree only when the evidence supports it --------------------------------------
    let completeness: Completeness = 'exported_tree';
    if (completenessReasons.length > 0) {
      completeness = 'unknown';
      wc.add('COMPLETENESS_LOWERED', `Completeness was lowered from exported_tree to unknown because: ${completenessReasons.join(', ')}.`, conversationId);
    }

    // ---- raw metadata: every conversation key except `mapping`, plus provenance of the exact input text ------------------
    const rawMetadata: JsonObject = {};
    for (const key of Object.keys(conv)) {
      if (key === 'mapping') continue;
      setOwn(rawMetadata, key === '_gcr' ? '_gcr_original' : key, conv[key]);
    }
    const gcr: JsonObject = { sourceElementSha256: sha };
    for (const k of Object.keys(gcrExtra)) setOwn(gcr, k, gcrExtra[k]);
    setOwn(rawMetadata, '_gcr', gcr);

    obs.roleCounts = Object.fromEntries(roleCounts);

    const record: ConversationRecord = {
      provider: 'chatgpt',
      accountLabel: ctx.accountLabel,
      id: conversationId,
      title,
      sourceUri: null, // the export carries no URL; a chatgpt.com link is never fabricated from the id
      provenance: 'official_chatgpt_export',
      completeness,
      importedAt: ctx.importedAt,
      createdAt,
      updatedAt,
      currentNodeId,
      defaultModelSlug,
      messages: drafts.map((d) => d.record),
      rawMetadata,
      warnings: wc.toWarnings(),
    };
    return { kind: 'record', record, observations: obs, sourceElementSha256: sha };
  }
}

function skipped(reason: 'EMPTY_CONVERSATION_ENTRY' | 'NON_OBJECT_ENTRY' | 'NOT_A_CONVERSATION', message: string): AdapterOutcome {
  return { kind: 'skipped', reason, warnings: [{ code: reason, message }] };
}

export const chatGptExportAdapter = new ChatGPTExportAdapter();
