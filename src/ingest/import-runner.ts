/**
 * Import runner (SPEC FR-02, FR-03, FR-09, FR-10; CODEX_TASK Phase 1; docs/ARCHITECTURE.md sections 2 and 5): wires
 * container discovery (layout.ts), the bounded JSON splitter (json-stream.ts), the source adapters and the repository
 * into ONE atomic, idempotent import of a user-provided official export. It never fetches anything: the input is a
 * file, a folder or a byte stream the caller already holds.
 *
 * TWO PASSES, BOUNDED MEMORY (memory is O(number of conversations), never O(export size)):
 *  PASS 1 streams every conversation file once and computes, per file, the SHA-256 of its bytes; for every element a
 *    cheap IDENTITY PEEK (a linear top-level key scanner, NOT a JSON.parse of the element); wrapper expansion; the
 *    provider (registry sniffing of the first recognizable element of each file); and the duplicate-resolution winners.
 *    From the per-file hashes it derives the batch content digest and therefore the batch id, so an input that was
 *    imported before is recognised WITHOUT running the (expensive) adapters again.
 *  PASS 2 streams the files again and normalizes only the WINNING elements, feeding the records to Repository.importBatch
 *    as an async generator inside ONE transaction. If a file no longer hashes to its pass-1 digest (it changed between
 *    the passes) the generator throws and the transaction rolls back: a half-changed input can never be stored.
 *
 * Duplicate resolution (docs/IMPORT_GUIDE.md): conversations with the same id (conversation_id ?? id ?? uuid, UUIDs
 * lower-cased like the adapters do) may occur in several shards. The winner is chosen by this total order:
 *   1. greatest update time (update_time seconds, or updated_at for Claude; missing = lowest)
 *   2. greatest element size in source bytes
 *   3. earliest file order (plain conversations.json first, then numeric shard order)
 *   4. earliest element index
 * Levels 1 and 2 depend on the data only; levels 3 and 4 depend on the (deterministic, name-derived) file order.
 * Every loser is reported as DUPLICATE_CONVERSATION; the winner is decided from identity metadata alone, so if the
 * winner later fails normalization the loser is NOT tried (reported as an element failure instead).
 *
 * Security / privacy:
 *  - Element text is untrusted DATA. It is never logged, never put in an error message, never returned in a report.
 *    Reports and persisted batch warnings carry codes, counts and ids only. File names appear only as the relative
 *    names found inside the container.
 *  - All errors are GcrError. Unknown exceptions are normalized with toGcrError (generic message, no content).
 *  - Nothing here touches the network; the only I/O is reading the user-named input and writing through the repository.
 *
 * Known limits (also in docs/IMPORT_GUIDE.md): the batch-level `completeness` column is fixed when the transaction
 * starts (before any adapter ran), so it is the adapter's NOMINAL level and a COMPLETENESS_BELOW_BATCH_LEVEL warning
 * reports conversations that turned out weaker; an element larger than maxElementBytes aborts its file (the streaming
 * splitter cannot resynchronize); a winner that fails normalization is not replaced by a duplicate.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { computeBatchId } from '../db/repo.js';
import type { ImportBatchMeta, Repository } from '../db/repo.js';
import { isUuid } from '../domain/ids.js';
import type { FormatProfile, ImportReport, ImportWarningSummary } from '../domain/results.js';
import type { Completeness, ConversationRecord } from '../domain/types.js';
import { isIso8601Utc, validateConversationRecord } from '../domain/validate.js';
import { GcrError, toGcrError } from '../errors.js';
import type { ErrorCode, Warning } from '../errors.js';
import { log } from '../logger.js';
import { TOOL_VERSION } from '../version.js';
import type { AdapterContext, FormatObservations } from './adapter.js';
import { JSON_PARSE_REASONS, jsonArrayElements, jsonLinesElements } from './json-stream.js';
import { assertUtf8Head, discoverInput } from './layout.js';
import type { DiscoveredFile, Discovery, InputSource } from './layout.js';
import { resolveLimits } from './limits.js';
import type { ImportLimits } from './limits.js';
import { detectAdapterFromElementText, getAdapter } from './registry.js';
import type { AdapterId } from './registry.js';

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

export interface ImportOptions {
  source: InputSource;
  /** Account scope for this import (default "default"): /^[A-Za-z0-9][A-Za-z0-9_.@ -]{0,63}$/. */
  accountLabel?: string;
  /** Default: auto-detected per file; all files of one import must agree. A forced provider that contradicts the data adds PROVIDER_MISMATCH. */
  provider?: 'chatgpt' | 'claude';
  /** Any element failure, manifest inconsistency, framing failure, provider mismatch or duplicate loser aborts; NOTHING is stored. */
  strict?: boolean;
  limits?: Partial<ImportLimits>;
  /** ISO-8601 UTC timestamp source (injectable for reproducible tests). Called ONCE per import. */
  clock?: () => string;
  /** Counts only, never content. `file` is the relative name inside the container. */
  onProgress?: (p: { phase: 'scan' | 'import'; file: string; elements: number }) => void;
}

const ACCOUNT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.@ -]{0,63}$/;
const SAMPLE_IDS = 5;
const MAX_DUPLICATE_SAMPLES = 20;
const MAX_DETECT_ATTEMPTS = 20;
const PROGRESS_EVERY = 1000;
const MAX_ID_CHARS = 512;
/** Marker appended to persisted batch warnings so a later idempotent report can recover the count. */
const COUNT_SUFFIX_RE = / \(count=(\d+)\)$/;

/**
 * The adapters' NOMINAL completeness (docs/ADAPTERS.md section 1). Used for the batch row, which is written before any
 * adapter runs; per-conversation `completeness` is authoritative.
 */
const NOMINAL_COMPLETENESS: Readonly<Record<AdapterId, Completeness>> = { chatgpt: 'exported_tree', claude: 'rendered_active_view_only' };
/** Higher = more complete. Only used to detect conversations weaker than the batch's nominal level. */
const COMPLETENESS_RANK: Readonly<Record<Completeness, number>> = {
  exported_tree: 4,
  api_owned_conversation: 3,
  rendered_active_view_only: 2,
  partial_user_supplied: 1,
  unknown: 0,
};

/** Warning codes that make `strict` mode abort (also checked against the stored warnings of an already-imported batch). */
const STRICT_FATAL_CODES: ReadonlySet<string> = new Set([
  'ELEMENT_PARSE_FAILED',
  'ELEMENT_INTERNAL_ERROR',
  'FILE_PARSE_FAILED',
  'NOT_A_CONVERSATION',
  'DUPLICATE_CONVERSATION',
  'PROVIDER_MISMATCH',
  'MANIFEST_INVALID',
  'MANIFEST_SHARD_MISSING',
  'SHARD_NOT_IN_MANIFEST',
  'MANIFEST_COUNT_MISMATCH',
]);

const STRICT_REMEDY = 'Re-run without --strict to import what can be read (the problem is then recorded as a warning), or obtain a fresh export.';

// ---------------------------------------------------------------------------------------------------------------
// Element identity peek (linear, allocation-light, never throws)
// ---------------------------------------------------------------------------------------------------------------

export interface ElementPeek {
  kind: 'object' | 'empty_object' | 'non_object';
  conversationId: string | null;
  id: string | null;
  uuid: string | null;
  /** update_time (unix seconds, converted) or updated_at (ISO string); null when absent or unusable. */
  updateMs: number | null;
  hasMapping: boolean;
  conversationsIsArray: boolean;
  /** The scan met something that is not well-formed JSON structure; identity fields read so far are still reported. */
  malformed: boolean;
}

const CH_QUOTE = 0x22;
const CH_BACKSLASH = 0x5c;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;
const CH_LBRACKET = 0x5b;
const CH_RBRACKET = 0x5d;
const CH_COMMA = 0x2c;
const CH_COLON = 0x3a;

function skipWs(t: string, i: number, n: number): number {
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
    else break;
  }
  return i;
}

/** Index just after the closing quote of the string starting at `i`, or -1. Escape-aware without per-character work. */
function skipString(t: string, i: number, n: number): number {
  let from = i + 1;
  while (from < n) {
    const q = t.indexOf('"', from);
    if (q < 0) return -1;
    // The quote is real iff it is preceded by an EVEN number of backslashes.
    let b = q - 1;
    let backslashes = 0;
    while (b > i && t.charCodeAt(b) === CH_BACKSLASH) {
      backslashes++;
      b--;
    }
    if ((backslashes & 1) === 0) return q + 1;
    from = q + 1;
  }
  return -1;
}

/** Index just after the JSON value starting at `i`, or -1. Brackets are only counted (the splitter already validated framing). */
function skipValue(t: string, i: number, n: number): number {
  const c = t.charCodeAt(i);
  if (c === CH_QUOTE) return skipString(t, i, n);
  if (c === CH_LBRACE || c === CH_LBRACKET) {
    let depth = 0;
    let j = i;
    while (j < n) {
      const ch = t.charCodeAt(j);
      if (ch === CH_QUOTE) {
        j = skipString(t, j, n);
        if (j < 0) return -1;
        continue;
      }
      if (ch === CH_LBRACE || ch === CH_LBRACKET) depth++;
      else if (ch === CH_RBRACE || ch === CH_RBRACKET) {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return -1;
  }
  let j = i;
  while (j < n) {
    const ch = t.charCodeAt(j);
    if (ch === CH_COMMA || ch === CH_RBRACE || ch === CH_RBRACKET || ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09) break;
    j++;
  }
  return j > i ? j : -1;
}

function decodeJsonString(t: string, start: number, end: number, maxChars: number): string | null {
  if (end - start > maxChars) return null;
  const raw = t.slice(start + 1, end - 1);
  if (!raw.includes('\\')) return raw;
  try {
    const v: unknown = JSON.parse(t.slice(start, end));
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function blankPeek(kind: ElementPeek['kind']): ElementPeek {
  return { kind, conversationId: null, id: null, uuid: null, updateMs: null, hasMapping: false, conversationsIsArray: false, malformed: false };
}

/**
 * Reads the top-level keys of one JSON object element WITHOUT parsing its (potentially huge) values. For duplicate
 * keys the last occurrence wins, exactly like JSON.parse. Only the fields the runner needs are decoded:
 * conversation_id / id / uuid (strings), update_time (number) or updated_at (ISO string), and the type of the
 * `mapping` and `conversations` values. Total work is linear in the text length; it never throws.
 */
export function peekElement(text: string): ElementPeek {
  const n = text.length;
  let i = skipWs(text, text.charCodeAt(0) === 0xfeff ? 1 : 0, n);
  if (i >= n || text.charCodeAt(i) !== CH_LBRACE) return blankPeek('non_object');
  i = skipWs(text, i + 1, n);
  if (text.charCodeAt(i) === CH_RBRACE) return blankPeek('empty_object');
  const out = blankPeek('object');
  let updateTime: number | null = null;
  let updatedAt: number | null = null;
  for (;;) {
    i = skipWs(text, i, n);
    if (text.charCodeAt(i) !== CH_QUOTE) break;
    const keyEnd = skipString(text, i, n);
    if (keyEnd < 0) break;
    const key = decodeJsonString(text, i, keyEnd, 64);
    i = skipWs(text, keyEnd, n);
    if (text.charCodeAt(i) !== CH_COLON) break;
    i = skipWs(text, i + 1, n);
    const vs = i;
    const ve = skipValue(text, vs, n);
    if (ve < 0) break;
    const first = text.charCodeAt(vs);
    switch (key) {
      case 'conversation_id':
        out.conversationId = first === CH_QUOTE ? decodeJsonString(text, vs, ve, 4096) : null;
        break;
      case 'id':
        out.id = first === CH_QUOTE ? decodeJsonString(text, vs, ve, 4096) : null;
        break;
      case 'uuid':
        out.uuid = first === CH_QUOTE ? decodeJsonString(text, vs, ve, 4096) : null;
        break;
      case 'update_time': {
        const seconds = first === 0x2d || (first >= 0x30 && first <= 0x39) ? Number(text.slice(vs, ve)) : Number.NaN;
        updateTime = Number.isFinite(seconds) ? seconds * 1000 : null;
        break;
      }
      case 'updated_at': {
        const s = first === CH_QUOTE ? decodeJsonString(text, vs, ve, 64) : null;
        // Only strings with an explicit zone are read: a zone-less string would be parsed in LOCAL time (machine dependent).
        const ms = s !== null && ISO_INSTANT_RE.test(s) ? Date.parse(s) : Number.NaN;
        updatedAt = Number.isFinite(ms) ? ms : null;
        break;
      }
      case 'mapping':
        out.hasMapping = true;
        break;
      case 'conversations':
        out.conversationsIsArray = first === CH_LBRACKET;
        break;
      default:
        break;
    }
    i = skipWs(text, ve, n);
    const c = text.charCodeAt(i);
    if (c === CH_COMMA) {
      i++;
      continue;
    }
    if (c === CH_RBRACE) {
      out.updateMs = updateTime ?? updatedAt;
      return out;
    }
    break;
  }
  out.malformed = true;
  out.updateMs = updateTime ?? updatedAt;
  return out;
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Same usability test as the adapters' isSafeId: 1..512 chars, no control characters, no lone surrogates. */
function isUsableId(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return s.length > 0 && s.length <= MAX_ID_CHARS && !/[\u0000-\u001f\u007f]/.test(s) && !LONE_SURROGATE_RE.test(s);
}

/** conversation_id ?? id ?? uuid, canonicalized like the adapters (UUIDs lower-cased). null = no usable id (never a duplicate). */
function conversationKeyOf(p: ElementPeek): string | null {
  for (const v of [p.conversationId, p.id, p.uuid]) {
    if (v !== null && isUsableId(v)) return isUuid(v) ? v.toLowerCase() : v;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Wrapper objects: {"conversations": [...]} without "mapping"
// ---------------------------------------------------------------------------------------------------------------

/** Placeholder text for a wrapper member that cannot be re-serialized: it fails normalization (counted) instead of vanishing. */
const UNSERIALIZABLE_MEMBER = '{';

/**
 * Members of a wrapper object, re-serialized with JSON.stringify. NOTE: re-serialization changes number spellings,
 * duplicate keys and key order, so the element hash and raw preservation are weaker for wrapper members (documented).
 * Returns null when the element does not parse as such a wrapper; the caller then treats it as an ordinary element.
 */
function expandWrapper(text: string): Array<{ text: string; bytes: number }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const members: unknown = Object.hasOwn(parsed, 'conversations') ? (parsed as Record<string, unknown>)['conversations'] : undefined;
  if (!Array.isArray(members)) return null;
  return members.map((m: unknown) => {
    let s: string | undefined;
    try {
      s = JSON.stringify(m);
    } catch {
      s = undefined; // e.g. RangeError on pathological depth
    }
    const t = s ?? UNSERIALIZABLE_MEMBER;
    return { text: t, bytes: Buffer.byteLength(t, 'utf8') };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Hashing source: SHA-256 of every byte, encoding check, first significant byte
// ---------------------------------------------------------------------------------------------------------------

/**
 * Wraps a file's byte stream. It hashes every chunk that passes through and, crucially, has NO `return()` method: when
 * the JSON splitter fails on a framing error `for await` would otherwise close the stream, and the rest of the file
 * (needed for the whole-file hash and for the ZIP CRC check) could not be read. `close()` releases the source
 * explicitly in a `finally`.
 */
class HashedSource implements AsyncIterable<Buffer> {
  private readonly it: AsyncIterator<Buffer>;
  private readonly hash = createHash('sha256');
  private digest: string | null = null;
  private head: Buffer[] = [];
  private headLen = 0;
  private headChecked = false;
  private closed = false;
  /** First byte that is neither a BOM byte nor whitespace, or -1 (used to decide NDJSON vs single-object). */
  firstSignificant = -1;
  bytes = 0;
  ended = false;

  constructor(src: AsyncIterable<Buffer>) {
    this.it = src[Symbol.asyncIterator]();
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return { next: () => this.next() };
  }

  private async next(): Promise<IteratorResult<Buffer>> {
    if (this.ended) return { done: true, value: undefined };
    const r = await this.it.next();
    if (r.done === true) {
      this.ended = true;
      this.checkHead();
      return { done: true, value: undefined };
    }
    const chunk = r.value;
    this.hash.update(chunk);
    this.bytes += chunk.length;
    if (!this.headChecked) {
      this.head.push(chunk.subarray(0, Math.max(0, 4 - this.headLen)));
      this.headLen += Math.min(chunk.length, Math.max(0, 4 - this.headLen));
      if (this.headLen >= 4) this.checkHead();
    }
    if (this.firstSignificant < 0) {
      for (const b of chunk) {
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0xef || b === 0xbb || b === 0xbf) continue;
        this.firstSignificant = b;
        break;
      }
    }
    return { done: false, value: chunk };
  }

  /** UTF-16/UTF-32 text would otherwise surface as a confusing "unexpected byte" parse error. */
  private checkHead(): void {
    if (this.headChecked) return;
    this.headChecked = true;
    assertUtf8Head(Buffer.concat(this.head, this.headLen));
  }

  /** Read (and hash) whatever is left, e.g. after a framing error, so the digest always covers the WHOLE file. */
  async drain(): Promise<void> {
    while (!this.ended) await this.next();
  }

  sha256(): string {
    this.digest ??= this.hash.digest('hex');
    return this.digest;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.it.return?.(undefined);
    } catch {
      /* the interesting error, if any, was already thrown */
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Element iteration shared by both passes
// ---------------------------------------------------------------------------------------------------------------

type Framing = 'array' | 'lines';

interface Item {
  /** Index among the EXPANDED elements of the file (wrapper members count; the wrapper itself does not). */
  index: number;
  text: string;
  bytes: number;
  /** Pass 1 only, and only for non-wrapper-member items. */
  peek: ElementPeek | undefined;
}

/**
 * Yields the conversation elements of one file. `wrapperOrdinals === null` (pass 1) detects wrappers by peeking and
 * records their raw ordinals in `found`; pass 2 passes that set back so no element has to be peeked twice. A wrapper
 * that does not parse is yielded as an ordinary element in BOTH passes, so indexes agree.
 */
async function* iterateElements(
  source: HashedSource,
  framing: Framing,
  maxElementBytes: number,
  wrapperOrdinals: ReadonlySet<number> | null,
  found: Set<number>,
): AsyncGenerator<Item, void, undefined> {
  const elements =
    framing === 'array' ? jsonArrayElements(source, { maxElementBytes, allowSingleObject: true }) : jsonLinesElements(source, { maxElementBytes });
  let index = 0;
  for await (const el of elements) {
    let peek: ElementPeek | undefined;
    let wrapper: boolean;
    if (wrapperOrdinals === null) {
      peek = peekElement(el.text);
      wrapper = peek.kind === 'object' && peek.conversationsIsArray && !peek.hasMapping;
    } else {
      wrapper = wrapperOrdinals.has(el.index);
    }
    if (wrapper) {
      const members = expandWrapper(el.text);
      if (members !== null) {
        found.add(el.index);
        for (const m of members) yield { index: index++, text: m.text, bytes: m.bytes, peek: undefined };
        continue;
      }
    }
    yield { index: index++, text: el.text, bytes: el.byteLength, peek };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Warning aggregation
// ---------------------------------------------------------------------------------------------------------------

interface WarnBucket {
  count: number;
  message: string;
  ids: string[];
}

/** Collects warnings by code: a count, a representative message and up to SAMPLE_IDS distinct ids. Deterministic output order. */
class WarningAgg {
  private readonly buckets = new Map<string, WarnBucket>();

  add(code: string, message: string, ids: readonly string[] = [], n = 1): void {
    let b = this.buckets.get(code);
    if (b === undefined) {
      b = { count: 0, message: message.replace(COUNT_SUFFIX_RE, '').slice(0, 400), ids: [] };
      this.buckets.set(code, b);
    }
    b.count += n;
    for (const id of ids) {
      if (b.ids.length >= SAMPLE_IDS) break;
      if (!b.ids.includes(id)) b.ids.push(id);
    }
  }

  addWarning(w: Warning): void {
    this.add(w.code, w.message, w.ids ?? []);
  }

  count(code: string): number {
    return this.buckets.get(code)?.count ?? 0;
  }

  codes(): string[] {
    return [...this.buckets.keys()].sort(cmp);
  }

  /** Persisted form: the count rides in the message so a later idempotent report can restore it. */
  toWarnings(): Warning[] {
    return this.codes().map((code) => {
      const b = this.buckets.get(code) as WarnBucket;
      const w: Warning = { code, message: `${b.message} (count=${b.count})` };
      if (b.ids.length > 0) w.ids = [...b.ids];
      return w;
    });
  }

  toSummaries(): ImportWarningSummary[] {
    return this.codes().map((code) => {
      const b = this.buckets.get(code) as WarnBucket;
      return { code, count: b.count, sampleIds: [...b.ids] };
    });
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Rebuilds report summaries from persisted batch warnings (message suffix `(count=N)`; the repository's own warning starts with its count). */
export function summariesFromStored(ws: readonly Warning[]): ImportWarningSummary[] {
  return ws
    .map((w): ImportWarningSummary => {
      const suffix = COUNT_SUFFIX_RE.exec(w.message);
      const lead = /^(\d+) /.exec(w.message); // the repository's own DUPLICATE_CONVERSATION_IN_BATCH starts with its count
      const count = suffix !== null ? Number(suffix[1]) : lead !== null ? Number(lead[1]) : 1;
      return { code: w.code, count, sampleIds: (w.ids ?? []).slice(0, SAMPLE_IDS) };
    })
    .sort((a, b) => cmp(a.code, b.code));
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 1
// ---------------------------------------------------------------------------------------------------------------

interface Cand {
  key: string | null;
  idx: number;
  updateMs: number | null;
  bytes: number;
}

interface FileScan {
  file: DiscoveredFile;
  framing: Framing;
  sha256: string;
  bytes: number;
  /** Expanded elements read (wrapper members count; the wrapper itself does not). */
  expanded: number;
  wrappers: Set<number>;
  objectElements: number;
  provider: AdapterId | null;
  /** A framing error (truncated file, trailing data, ...): elements before it are kept, the rest of the file is lost. */
  failure: GcrError | null;
  /** Expanded indexes that lost duplicate resolution. */
  losers: Set<number>;
}

function isFramingError(e: unknown): e is GcrError {
  // The splitter reports every structural problem as IMPORT_PARSE_ERROR with one of JSON_PARSE_REASONS; sources (ZIP,
  // disk) never do, and neither do the runner's own strict aborts (their reasons are warning codes), so this cannot be confused.
  if (!(e instanceof GcrError) || e.code !== 'IMPORT_PARSE_ERROR') return false;
  const reason = e.details?.['reason'];
  return typeof reason === 'string' && (JSON_PARSE_REASONS as readonly string[]).includes(reason);
}

async function scanAttempt(
  file: DiscoveredFile,
  framing: Framing,
  limits: ImportLimits,
  progress: (file: string, elements: number) => void,
): Promise<{ scan: FileScan; cands: Cand[]; firstSignificant: number }> {
  const hashed = new HashedSource(file.open());
  const wrappers = new Set<number>();
  const cands: Cand[] = [];
  let expanded = 0;
  let objectElements = 0;
  let detectAttempts = 0;
  let provider: AdapterId | null = null;
  let failure: GcrError | null = null;
  try {
    try {
      for await (const item of iterateElements(hashed, framing, limits.maxElementBytes, null, wrappers)) {
        const peek = item.peek ?? peekElement(item.text);
        cands.push({ key: conversationKeyOf(peek), idx: item.index, updateMs: peek.updateMs, bytes: item.bytes });
        expanded++;
        if (peek.kind === 'object') {
          objectElements++;
          // Registry sniffing costs one JSON.parse; it stops at the first recognizable element of the file.
          if (provider === null && detectAttempts < MAX_DETECT_ATTEMPTS) {
            detectAttempts++;
            provider = detectAdapterFromElementText(item.text).adapter;
          }
        }
        if (expanded % PROGRESS_EVERY === 0) progress(file.name, expanded);
      }
    } catch (e) {
      if (!isFramingError(e)) throw e;
      failure = e;
      // Keep reading (hash only) so the digest covers the whole file and a ZIP CRC mismatch at the end is still caught.
      await hashed.drain();
    }
  } finally {
    await hashed.close();
  }
  const scan: FileScan = {
    file,
    framing,
    sha256: hashed.sha256(),
    bytes: hashed.bytes,
    expanded,
    wrappers,
    objectElements,
    provider,
    failure,
    losers: new Set<number>(),
  };
  return { scan, cands, firstSignificant: hashed.firstSignificant };
}

/**
 * One file, pass 1. A file starting with "{" is first read as a single object / wrapper; if more data follows the
 * first value (TRAILING_DATA) it is re-read as NDJSON (one object per line). Candidates are buffered per attempt so
 * a discarded attempt leaves no trace.
 */
async function scanFile(
  file: DiscoveredFile,
  limits: ImportLimits,
  progress: (file: string, elements: number) => void,
): Promise<{ scan: FileScan; cands: Cand[] }> {
  const first = await scanAttempt(file, 'array', limits, progress);
  const f = first.scan.failure;
  if (f !== null && first.firstSignificant === CH_LBRACE && (f.details as { reason?: unknown } | undefined)?.reason === 'TRAILING_DATA') {
    const second = await scanAttempt(file, 'lines', limits, progress);
    return { scan: second.scan, cands: second.cands };
  }
  return { scan: first.scan, cands: first.cands };
}

interface Winner {
  fileIdx: number;
  idx: number;
  updateMs: number | null;
  bytes: number;
}

/** Deterministic duplicate rule (see the file header). `a` is always LATER in (file order, index) than `b`, so ties keep `b`. */
function beats(a: Winner, b: Winner): boolean {
  const au = a.updateMs ?? Number.NEGATIVE_INFINITY;
  const bu = b.updateMs ?? Number.NEGATIVE_INFINITY;
  if (au !== bu) return au > bu;
  return a.bytes > b.bytes;
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------------------------

function realClock(): string {
  return new Date().toISOString();
}

function strictAbort(code: ErrorCode, reason: string, message: string, details: Record<string, unknown> = {}): GcrError {
  return new GcrError(code, message, { remedy: STRICT_REMEDY, details: { reason, strict: true, ...details } });
}

/** Validates the operator-chosen account scope (shared with Mode B). The value is never echoed in the error. */
export function assertAccountLabel(label: unknown): string {
  if (typeof label !== 'string' || !ACCOUNT_LABEL_RE.test(label)) {
    throw new GcrError('INVALID_ARGUMENT', 'The account label must be 1-64 characters: letters, digits, "_", ".", "@", "-" or space, starting with a letter or digit.', {
      details: { field: 'accountLabel' },
    });
  }
  return label;
}

function validateOptions(opts: ImportOptions): { accountLabel: string; strict: boolean; limits: ImportLimits; clock: () => string } {
  if (typeof opts !== 'object' || opts === null) throw new GcrError('INVALID_ARGUMENT', 'Import options are required.', { details: { reason: 'NO_OPTIONS' } });
  const accountLabel = assertAccountLabel(opts.accountLabel ?? 'default');
  if (opts.provider !== undefined) getAdapter(opts.provider); // INVALID_ARGUMENT for unknown ids, NOT_IMPLEMENTED for openai_api
  if (opts.strict !== undefined && typeof opts.strict !== 'boolean') throw new GcrError('INVALID_ARGUMENT', 'strict must be a boolean.', { details: { field: 'strict' } });
  if (opts.onProgress !== undefined && typeof opts.onProgress !== 'function') throw new GcrError('INVALID_ARGUMENT', 'onProgress must be a function.', { details: { field: 'onProgress' } });
  if (opts.clock !== undefined && typeof opts.clock !== 'function') throw new GcrError('INVALID_ARGUMENT', 'clock must be a function.', { details: { field: 'clock' } });
  return { accountLabel, strict: opts.strict === true, limits: resolveLimits(opts.limits), clock: opts.clock ?? realClock };
}

/** Throws a source that must never be iterated: used to ask the repository for the counts of a batch that already exists. */
async function* neverIterated(): AsyncGenerator<ConversationRecord, void, undefined> {
  yield* [];
  throw new GcrError('INTERNAL_ERROR', 'The repository iterated the record source of an already existing batch.', { details: { reason: 'UNEXPECTED_ITERATION' } });
}

export async function runImport(repo: Repository, opts: ImportOptions): Promise<ImportReport> {
  const t0 = performance.now();
  let discovery: Discovery | undefined;
  try {
    const { accountLabel, strict, limits, clock } = validateOptions(opts);
    const importedAt = clock();
    if (!isIso8601Utc(importedAt)) {
      throw new GcrError('INVALID_ARGUMENT', 'The clock must return an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.fff]Z).', { details: { field: 'clock' } });
    }
    const onProgress = opts.onProgress;
    const progress = (phase: 'scan' | 'import', file: string, elements: number): void => onProgress?.({ phase, file, elements });

    // The runner reads every conversation file twice, so the ZIP inflate budget applies per pass.
    discovery = await discoverInput(opts.source, limits, { ...(opts.provider === undefined ? {} : { provider: opts.provider }), passes: 2 });
    return await runWithDiscovery(repo, opts, discovery, { accountLabel, strict, limits, importedAt, progress, t0 });
  } catch (e) {
    throw toGcrError(e);
  } finally {
    await discovery?.close().catch(() => undefined);
  }
}

interface RunContext {
  accountLabel: string;
  strict: boolean;
  limits: ImportLimits;
  importedAt: string;
  progress: (phase: 'scan' | 'import', file: string, elements: number) => void;
  t0: number;
}

async function runWithDiscovery(repo: Repository, opts: ImportOptions, discovery: Discovery, ctx: RunContext): Promise<ImportReport> {
  const { accountLabel, strict, limits, importedAt, progress } = ctx;
  const agg = new WarningAgg();
  for (const w of discovery.warnings) agg.addWarning(w);

  // ---------------------------------------------------------------- PASS 1
  const scans: FileScan[] = [];
  const winners = new Map<string, Winner>();
  let duplicateCount = 0;
  const duplicateSamples: Array<{ key: string; loser: { fileIdx: number; idx: number } }> = [];
  let totalExpanded = 0;
  let totalObjects = 0;
  let wrapperCount = 0;

  for (const file of discovery.files) {
    const { scan, cands } = await scanFile(file, limits, (name, n) => progress('scan', name, n));
    const fileIdx = scans.length;
    scans.push(scan);
    totalExpanded += scan.expanded;
    totalObjects += scan.objectElements;
    wrapperCount += scan.wrappers.size;
    for (const c of cands) {
      if (c.key === null) continue; // no usable id: can never be a duplicate
      const cur: Winner = { fileIdx, idx: c.idx, updateMs: c.updateMs, bytes: c.bytes };
      const prev = winners.get(c.key);
      if (prev === undefined) {
        winners.set(c.key, cur);
        continue;
      }
      duplicateCount++;
      const loser = beats(cur, prev) ? prev : cur;
      if (loser === prev) winners.set(c.key, cur);
      (scans[loser.fileIdx] as FileScan).losers.add(loser.idx);
      if (duplicateSamples.length < MAX_DUPLICATE_SAMPLES) duplicateSamples.push({ key: c.key, loser: { fileIdx: loser.fileIdx, idx: loser.idx } });
    }
    progress('scan', file.name, scan.expanded);
  }

  // A file whose framing failed keeps the elements before the break; if NOTHING at all could be read the import fails loudly.
  const failedFiles = scans.filter((s) => s.failure !== null);
  if (failedFiles.length > 0 && totalExpanded === 0) throw failedFiles[0]?.failure as GcrError;
  for (const s of failedFiles) {
    agg.add('FILE_PARSE_FAILED', 'A conversation file is not well-formed JSON from some point on; the elements before that point were kept and the rest of the file was not imported.', [s.file.name]);
  }
  if (wrapperCount > 0) {
    agg.add('WRAPPER_OBJECT_FORMAT', '[info] Some elements were wrapper objects with a "conversations" array; their members were imported (members are re-serialized, so raw byte-exactness is lost for them).', [], wrapperCount);
  }

  // ---- provider ---------------------------------------------------------------------------------------------
  const provider = resolveProvider(opts.provider, scans, totalObjects, agg);

  // ---- duplicates ---------------------------------------------------------------------------------------------
  if (duplicateCount > 0) {
    const where = (p: { fileIdx: number; idx: number }): string => `${(scans[p.fileIdx] as FileScan).file.name}#${p.idx}`;
    const first = duplicateSamples[0];
    const keptFor = first === undefined ? undefined : winners.get(first.key);
    const example = first === undefined || keptFor === undefined ? '' : ` Example: kept ${where(keptFor)}, skipped ${where(first.loser)}.`;
    agg.add(
      'DUPLICATE_CONVERSATION',
      `A conversation id occurs more than once; the winner is the element with the greatest update time, then the largest size, then the earliest file order and index, and the losers were skipped.${example}`,
      duplicateSamples.map((d) => d.key),
      duplicateCount,
    );
  }

  // ---- strict: everything known before any adapter ran ----------------------------------------------------------
  if (strict) {
    const f = failedFiles[0];
    if (f?.failure) throw f.failure;
    for (const code of ['MANIFEST_INVALID', 'MANIFEST_SHARD_MISSING', 'SHARD_NOT_IN_MANIFEST', 'MANIFEST_COUNT_MISMATCH']) {
      if (agg.count(code) > 0) throw strictAbort('IMPORT_UNSUPPORTED_FORMAT', code, 'The export does not match its export_manifest.json.');
    }
    if (agg.count('PROVIDER_MISMATCH') > 0) throw strictAbort('IMPORT_UNSUPPORTED_FORMAT', 'PROVIDER_MISMATCH', 'The data does not match the requested provider.');
    const d = duplicateSamples[0];
    if (d !== undefined) {
      const w = winners.get(d.key) as Winner;
      throw strictAbort('IMPORT_PARSE_ERROR', 'DUPLICATE_CONVERSATION', 'A conversation id occurs more than once in the input.', {
        conversationId: d.key,
        kept: { file: (scans[w.fileIdx] as FileScan).file.name, index: w.idx },
        skipped: { file: (scans[d.loser.fileIdx] as FileScan).file.name, index: d.loser.idx },
        duplicates: duplicateCount,
      });
    }
  }

  // ---- identity of this batch ------------------------------------------------------------------------------------
  const lines = scans.map((s) => `${s.file.name}\t${s.sha256}`).sort(cmp);
  const contentDigest = createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
  const adapter = getAdapter(provider);
  const batchId = computeBatchId(provider, accountLabel, contentDigest);
  const nominal: Completeness = totalObjects === 0 ? 'unknown' : NOMINAL_COMPLETENESS[provider];
  const meta: ImportBatchMeta = {
    provider,
    accountLabel,
    provenance: adapter.provenance,
    completeness: nominal,
    sourceKind: discovery.sourceKind,
    sourceLabel: discovery.sourceLabel,
    contentDigest,
    importedAt,
    toolVersion: TOOL_VERSION,
    warnings: [],
  };
  // `failed` per file: elements that failed normalization (pass 2) plus 1 for an unreadable tail (framing failure, known from pass 1).
  const filesFromScans = (failed: Map<string, number>): ImportReport['files'] =>
    scans.map((s) => ({ name: s.file.name, conversations: s.expanded, failed: (failed.get(s.file.name) ?? 0) + (s.failure !== null ? 1 : 0) }));

  // ---- FR-10: this exact input was imported before -> cheap no-op ------------------------------------------------------
  const existing = repo.getBatch(batchId);
  if (existing !== null) {
    if (strict) {
      for (const w of existing.warnings) {
        if (STRICT_FATAL_CODES.has(w.code)) throw strictAbort('IMPORT_PARSE_ERROR', w.code, 'The earlier import of this input recorded a problem that --strict does not accept.');
      }
    }
    return reportForExisting(repo, meta, batchId, existing.warnings, totalExpanded, filesFromScans(new Map()), ctx.t0);
  }

  // ---------------------------------------------------------------- PASS 2
  const stats = new Stats();
  const failedPerFile = new Map<string, number>();
  const adapterCtx: AdapterContext = { provider, accountLabel, importedAt, availableAssetNames: discovery.assetNames };
  const changed = (name: string): GcrError =>
    new GcrError('IMPORT_PARSE_ERROR', 'The input changed while it was being imported (concurrent modification); nothing was stored.', {
      remedy: 'Do not modify or replace the input during an import. Re-run the import.',
      details: { reason: 'CONCURRENT_MODIFICATION', file: name },
    });

  async function* records(): AsyncGenerator<ConversationRecord, void, undefined> {
    for (const s of scans) {
      const hashed = new HashedSource(s.file.open());
      let seen = 0;
      try {
        try {
          for await (const item of iterateElements(hashed, s.framing, limits.maxElementBytes, s.wrappers, new Set<number>())) {
            seen++;
            if (s.losers.has(item.index)) continue;
            const where = `${s.file.name}#${item.index}`;
            let outcome;
            try {
              outcome = adapter.normalizeElementText(item.text, adapterCtx, item.index);
              // WHY validate here although the repository validates again: a record the validator rejects would
              // otherwise abort the WHOLE transaction (one bad conversation losing a multi-GB import). Validating
              // first turns it into an ordinary per-element failure (strict mode still aborts). Cost: about 20% of
              // the import time (measured on 50k messages), which buys the isolation.
              // The validated COPY is discarded on purpose (the repository validates the original again): keeping it would hold
              // two full copies of a large conversation at once.
              if (outcome.kind === 'record') validateConversationRecord(outcome.record);
            } catch (e) {
              if (strict) {
                // The precise failure: the adapter's own code and (content-free) details plus where it happened.
                throw e instanceof GcrError
                  ? new GcrError(e.code, e.message, { remedy: STRICT_REMEDY, details: { ...(e.details ?? {}), strict: true, file: s.file.name, elementIndex: item.index } })
                  : toGcrError(e);
              }
              const known = e instanceof GcrError;
              agg.add(
                known ? 'ELEMENT_PARSE_FAILED' : 'ELEMENT_INTERNAL_ERROR',
                known ? 'A conversation element could not be normalized and was skipped.' : 'An unexpected error occurred while normalizing a conversation element; it was skipped.',
                [where],
              );
              if (!known) log.warn('element normalization raised an unexpected error', { file: s.file.name, element: item.index });
              failedPerFile.set(s.file.name, (failedPerFile.get(s.file.name) ?? 0) + 1);
              stats.failed++;
              continue;
            }
            if (outcome.kind === 'skipped') {
              if (outcome.reason === 'NOT_A_CONVERSATION' && strict) {
                throw strictAbort('IMPORT_PARSE_ERROR', 'NOT_A_CONVERSATION', 'An element is not a conversation of the selected provider.', { file: s.file.name, elementIndex: item.index });
              }
              agg.add(outcome.reason, `A ${outcome.reason === 'EMPTY_CONVERSATION_ENTRY' ? 'empty object' : outcome.reason === 'NON_OBJECT_ENTRY' ? 'non-object entry' : 'non-conversation object'} was skipped.`, [where]);
              stats.skipped++;
              continue;
            }
            const rec = outcome.record;
            stats.add(rec, outcome.observations, nominal);
            for (const w of rec.warnings) agg.add(w.code, w.message, w.ids !== undefined && w.ids.length > 0 ? w.ids : [rec.id]);
            yield rec;
            if (stats.records % PROGRESS_EVERY === 0) progress('import', s.file.name, stats.records);
          }
        } catch (e) {
          if (!(isFramingError(e) && s.failure !== null)) throw e;
          // The same framing error pass 1 saw: expected. Read the rest (hash only) to verify the whole file below.
          await hashed.drain();
        }
        if (!hashed.ended) await hashed.drain();
      } finally {
        await hashed.close();
      }
      if (hashed.sha256() !== s.sha256 || hashed.bytes !== s.bytes || seen !== s.expanded) throw changed(s.file.name);
      progress('import', s.file.name, stats.records);
    }
    // Everything the batch row should say. The repository reads `meta.warnings` after the stream ended and before it writes the row.
    stats.finish(agg, nominal);
    meta.warnings.push(...agg.toWarnings());
  }

  const result = await repo.importBatch({ batch: meta, conversations: records() });
  if (result.alreadyImported) {
    // Another process stored the same input between our check and the transaction: report it as the no-op it is.
    const stored = repo.getBatch(result.batchId);
    return reportForExisting(repo, meta, result.batchId, stored?.warnings ?? [], totalExpanded, filesFromScans(new Map()), ctx.t0);
  }

  const summaries = agg.toSummaries();
  const inBatchDuplicates = stats.records - result.conversations.stored;
  if (inBatchDuplicates > 0) {
    // Two winners normalized to the same record id although their raw ids differed (the repository kept the first).
    summaries.push({ code: 'DUPLICATE_CONVERSATION_IN_BATCH', count: inBatchDuplicates, sampleIds: [] });
    summaries.sort((a, b) => cmp(a.code, b.code));
  }
  const failed = stats.failed + failedFiles.length;
  return {
    batchId: result.batchId,
    provider,
    accountLabel,
    sourceKind: discovery.sourceKind,
    sourceLabel: discovery.sourceLabel,
    alreadyImported: false,
    files: filesFromScans(failedPerFile),
    conversations: { read: totalExpanded, stored: result.conversations.stored, failed, newlyInserted: result.conversations.newlyInserted },
    messages: result.messages,
    warnings: summaries,
    formatProfile: stats.profile(discovery, wrapperCount > 0),
    durationMs: Math.round(performance.now() - ctx.t0),
  };
}

/** Provider resolution: per-file registry sniffing, one provider per import, PROVIDER_MISMATCH for a contradicting forced provider. */
function resolveProvider(forced: AdapterId | undefined, scans: readonly FileScan[], totalObjects: number, agg: WarningAgg): AdapterId {
  const detected = new Set<AdapterId>();
  for (const s of scans) if (s.provider !== null) detected.add(s.provider);
  if (forced !== undefined) {
    for (const s of scans) {
      if (s.provider !== null && s.provider !== forced) {
        agg.add(
          'PROVIDER_MISMATCH',
          `A file looks like a ${s.provider} export but the provider was set to ${forced}; its elements are normalized as ${forced} and will most likely be skipped.`,
          [s.file.name],
        );
      }
    }
    return forced;
  }
  if (detected.size > 1) {
    throw new GcrError('IMPORT_UNSUPPORTED_FORMAT', 'The input mixes files of different providers (ChatGPT and Claude).', {
      remedy: 'Import the files of each provider separately (for example with --provider chatgpt and --provider claude).',
      details: { reason: 'MIXED_PROVIDERS', providers: [...detected].sort(cmp) },
    });
  }
  const only = [...detected][0];
  if (only !== undefined) return only;
  if (totalObjects > 0) {
    throw new GcrError('IMPORT_UNSUPPORTED_FORMAT', 'The conversation provider could not be detected: no element has a ChatGPT "mapping" or a Claude "chat_messages" array.', {
      remedy: 'Check that this is an official export, or select the provider explicitly (--provider chatgpt | claude).',
      details: { reason: 'PROVIDER_UNDETECTED' },
    });
  }
  return 'chatgpt'; // an export without any conversation object (for example `[]`): nothing to attribute, the primary provider is used
}

// ---------------------------------------------------------------------------------------------------------------
// Pass-2 statistics and the idempotent report
// ---------------------------------------------------------------------------------------------------------------

class Stats {
  records = 0;
  failed = 0;
  skipped = 0;
  private withCurrentNode = 0;
  private childrenDeclared = 0;
  private childrenAbsent = 0;
  private withRecipient = 0;
  private withStatus = 0;
  private withModelSlug = 0;
  private hidden = 0;
  private allLiteralRoot = true;
  private readonly roles = new Map<string, number>();
  private belowNominal = 0;
  private readonly belowIds: string[] = [];
  private weakest: Completeness | null = null;

  add(rec: ConversationRecord, o: FormatObservations, nominal: Completeness): void {
    this.records++;
    if (o.hasCurrentNode) this.withCurrentNode++;
    this.childrenDeclared += o.nodesWithChildrenDeclared;
    this.childrenAbsent += o.nodesWithChildrenAbsent;
    this.withRecipient += o.messagesWithRecipient;
    this.withStatus += o.messagesWithStatus;
    this.withModelSlug += o.messagesWithModelSlug;
    this.hidden += o.hiddenMessages;
    if (!o.rootIsLiteralClientCreatedRoot) this.allLiteralRoot = false;
    for (const [role, n] of Object.entries(o.roleCounts)) this.roles.set(role, (this.roles.get(role) ?? 0) + n);
    if (COMPLETENESS_RANK[rec.completeness] < COMPLETENESS_RANK[nominal]) {
      this.belowNominal++;
      if (this.belowIds.length < SAMPLE_IDS) this.belowIds.push(rec.id);
    }
    if (this.weakest === null || COMPLETENESS_RANK[rec.completeness] < COMPLETENESS_RANK[this.weakest]) this.weakest = rec.completeness;
  }

  /** The batch row's completeness was fixed up front; say so when reality turned out weaker. */
  finish(agg: WarningAgg, nominal: Completeness): void {
    if (this.belowNominal > 0) {
      agg.add(
        'COMPLETENESS_BELOW_BATCH_LEVEL',
        `Some conversations are less complete than the batch's nominal level (${nominal}); the weakest observed is ${this.weakest ?? 'unknown'}. Each conversation's own completeness is authoritative.`,
        this.belowIds,
        this.belowNominal,
      );
    }
  }

  profile(d: Discovery, wrapperObject: boolean): FormatProfile {
    const roleCounts: Record<string, number> = Object.fromEntries([...this.roles.entries()].sort((a, b) => cmp(a[0], b[0])));
    return {
      layout: d.layout,
      manifest: d.manifest,
      wrapperObject,
      conversations: this.records,
      conversationsWithCurrentNode: this.withCurrentNode,
      nodesWithChildrenDeclared: this.childrenDeclared,
      nodesWithChildrenAbsent: this.childrenAbsent,
      roleCounts,
      messagesWithRecipient: this.withRecipient,
      messagesWithStatus: this.withStatus,
      messagesWithModelSlug: this.withModelSlug,
      hiddenMessages: this.hidden,
      rootIsLiteralClientCreatedRoot: this.records > 0 && this.allLiteralRoot,
      auxiliaryFilesIgnored: d.auxiliaryFilesIgnored,
      assetsExtensionless: d.assetsExtensionless,
    };
  }
}

/**
 * Report for an input whose batch already exists. The repository returns the counts of the first import WITHOUT
 * iterating the source (we pass one that throws if it is touched). Warnings come from the stored batch row, so they are
 * the first import's summaries; per-file failure counts and the format profile are only available on the first import.
 */
async function reportForExisting(
  repo: Repository,
  meta: ImportBatchMeta,
  batchId: string,
  stored: readonly Warning[],
  read: number,
  files: ImportReport['files'],
  t0: number,
): Promise<ImportReport> {
  const res = await repo.importBatch({ batch: meta, conversations: neverIterated() });
  const warnings = summariesFromStored(stored);
  const failed = warnings.filter((w) => w.code === 'ELEMENT_PARSE_FAILED' || w.code === 'ELEMENT_INTERNAL_ERROR' || w.code === 'FILE_PARSE_FAILED').reduce((n, w) => n + w.count, 0);
  return {
    batchId,
    provider: meta.provider,
    accountLabel: meta.accountLabel,
    sourceKind: meta.sourceKind,
    sourceLabel: meta.sourceLabel,
    alreadyImported: true,
    files,
    conversations: { read, stored: res.conversations.stored, failed, newlyInserted: 0 },
    messages: res.messages,
    warnings,
    durationMs: Math.round(performance.now() - t0),
  };
}
