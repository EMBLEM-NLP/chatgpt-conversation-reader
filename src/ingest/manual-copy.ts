/**
 * Mode B - manual copy (SPEC section 3: "explicitly supplied/pasted messages -> partial local read and indexing;
 * completeness marker partial_user_supplied").
 *
 * The operator hands GCR a small JSON document with messages they copied out of a conversation themselves. GCR indexes
 * it locally and says, everywhere it can, that this is a PARTIAL copy:
 *  - provenance `user_supplied_copy`, completeness `partial_user_supplied` on the batch AND the conversation;
 *  - warning PARTIAL_USER_SUPPLIED on the record, in the batch row and in the import report (always);
 *  - the tree is a LINEAR chain in the order given; `currentNodeId` stays null (the user did not say which branch was
 *    active and GCR does not infer one, ADR-0009); no structural root node is invented;
 *  - `modelSlug` only when the user supplied it for that message; no timestamps are invented.
 *
 * Document format (strict, bounded):
 *   { "conversationId"?: "<uuid>", "title"?: string|null, "sourceUri"?: "https://chatgpt.com/c/<uuid>"|null,
 *     "messages": [ { "role": string, "text": string, "createdAt"?: ISO-8601|null, "modelSlug"?: string|null } ] }
 * Unknown keys are ignored with a warning (the key names are untrusted and are never echoed). `sourceUri` must pass
 * parseChatGptUrl and is stored as a LABEL ONLY: GCR never opens it (AGENTS.md hard boundary).
 *
 * Limits: at most 10,000 messages, 1 MiB of text per message, 64 MiB of text in total.
 *
 * Message text is untrusted DATA. It is never logged and never appears in an error message or report.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { computeBatchId } from '../db/repo.js';
import type { ImportBatchMeta, Repository } from '../db/repo.js';
import { parseChatGptUrl } from '../domain/ids.js';
import type { ImportReport } from '../domain/results.js';
import type { ConversationRecord, MessageRecord } from '../domain/types.js';
import { isIso8601Utc, parseIsoUtcToEpochMs } from '../domain/validate.js';
import { GcrError } from '../errors.js';
import type { ErrorCode, Warning } from '../errors.js';
import { TOOL_VERSION } from '../version.js';
import { assertAccountLabel, summariesFromStored } from './import-runner.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types and limits
// ---------------------------------------------------------------------------------------------------------------

export interface ManualCopyMessage {
  /** Preserved verbatim (for example "user", "assistant", "system", "tool" or anything else the user wrote). */
  role: string;
  text: string;
  /** ISO-8601 with an explicit zone (Z or +hh:mm); normalized to UTC milliseconds. */
  createdAt?: string | null;
  /** Only what the user states; never inferred. */
  modelSlug?: string | null;
}

export interface ManualCopyInput {
  /** UUID; when absent a deterministic UUID-shaped id is synthesized from the content hash (CONVERSATION_ID_SYNTHESIZED). */
  conversationId?: string;
  title?: string | null;
  /** Must be https://chatgpt.com/c/<uuid> (parseChatGptUrl). Stored as a label; never fetched. */
  sourceUri?: string | null;
  messages: ManualCopyMessage[];
  /** Notes made while reading the document (unknown keys, stripped NULs, ...). Produced by parseManualCopyJson. */
  warnings?: Warning[];
}

export const MANUAL_COPY_MAX_MESSAGES = 10_000;
export const MANUAL_COPY_MAX_TEXT_BYTES = 1024 * 1024;
export const MANUAL_COPY_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** The JSON document itself may be larger than the text it carries (escapes, keys), but not without bound. */
export const MANUAL_COPY_MAX_DOCUMENT_CHARS = 2 * MANUAL_COPY_MAX_TOTAL_BYTES;

const MAX_ROLE_CHARS = 64;
const MAX_TITLE_CHARS = 8192; // domain limit (validate.ts)
const MAX_MODEL_CHARS = 512;
const MAX_LABEL_CHARS = 120;
const MAX_SYNTHETIC_EPOCH_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

const TOP_KEYS: ReadonlySet<string> = new Set(['conversationId', 'title', 'sourceUri', 'messages']);
const MESSAGE_KEYS: ReadonlySet<string> = new Set(['role', 'text', 'createdAt', 'modelSlug']);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE_TEST = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_REPLACE = new RegExp(LONE_SURROGATE_TEST.source, 'g');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PARTIAL_MESSAGE =
  'This conversation is a PARTIAL copy supplied by the user (Mode B): only the messages given were indexed, nothing was read from ChatGPT, and the active branch is unknown.';

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

/** Field paths and reason codes only: the offending value is untrusted and never shown. */
function bad(code: ErrorCode, field: string, reason: string): GcrError {
  const message =
    code === 'IMPORT_PARSE_ERROR'
      ? `The manual-copy document is invalid at "${field}" (${reason}).`
      : `Invalid manual-copy input at "${field}" (${reason}).`;
  return new GcrError(code, message, {
    remedy:
      'Expected {"conversationId"?, "title"?, "sourceUri"?, "messages": [{"role", "text", "createdAt"?, "modelSlug"?}]} with at most 10,000 messages, 1 MiB of text per message and 64 MiB in total. See docs/IMPORT_GUIDE.md section "Manual copy".',
    details: { field, reason },
  });
}

function tooLarge(field: string, limit: string, max: number): GcrError {
  return new GcrError('IMPORT_LIMIT_EXCEEDED', `The manual-copy input exceeds a size limit at "${field}".`, {
    remedy: 'Split the copy into several smaller documents, or import an official export instead.',
    details: { reason: 'MANUAL_COPY_TOO_LARGE', field, limit, max },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization (shared by the document parser and the programmatic entry point)
// ---------------------------------------------------------------------------------------------------------------

class Notes {
  private readonly counts = new Map<string, number>();
  private readonly texts = new Map<string, string>();
  note(code: string, text: string): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    if (!this.texts.has(code)) this.texts.set(code, text);
  }
  /** One warning per code; the count rides in the message like the import runner's persisted warnings. */
  toWarnings(): Warning[] {
    return [...this.counts.keys()].sort().map((code) => ({ code, message: `${this.texts.get(code) ?? code} (count=${this.counts.get(code) ?? 0})` }));
  }
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(o: Record<string, unknown>, k: string): unknown {
  return Object.hasOwn(o, k) ? o[k] : undefined;
}

/** Text cleaning shared with the adapters' behaviour: NUL stripped, lone surrogates replaced by U+FFFD, both noted. */
function cleanText(s: string, notes: Notes): string {
  let out = s;
  if (out.includes('\u0000')) {
    out = out.replaceAll('\u0000', '');
    notes.note('NUL_STRIPPED', 'NUL characters were removed from text.');
  }
  if (LONE_SURROGATE_TEST.test(out)) {
    out = out.replace(LONE_SURROGATE_REPLACE, String.fromCharCode(0xfffd));
    notes.note('LONE_SURROGATE', 'Unpaired UTF-16 surrogates were replaced by U+FFFD.');
  }
  return out;
}

/**
 * ISO-8601 with an explicit zone -> `YYYY-MM-DDTHH:MM:SS.mmmZ`, or null. The calendar check is the domain's strict one
 * (Date.parse would roll 2025-02-30 over to March 2). Fractions beyond milliseconds are truncated.
 */
export function normalizeUserTimestamp(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (m === null) return null;
  const frac = (m[2] ?? '').padEnd(3, '0').slice(0, 3);
  const base = parseIsoUtcToEpochMs(`${m[1] ?? ''}.${frac}Z`);
  if (base === null) return null;
  let ms = base;
  const zone = m[3] ?? 'Z';
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const hh = Number(zone.slice(1, 3));
    const mm = Number(zone.slice(4, 6));
    if (hh > 23 || mm > 59) return null;
    ms -= sign * (hh * 60 + mm) * 60_000;
  }
  if (ms < 0 || ms > MAX_SYNTHETIC_EPOCH_MS) return null;
  const iso = new Date(ms).toISOString();
  return isIso8601Utc(iso) ? iso : null;
}

/**
 * Validate + normalize. `shape` is the error code for structural problems: IMPORT_PARSE_ERROR when reading a document,
 * INVALID_ARGUMENT for a programmatic call. Idempotent: normalizing its own output changes nothing.
 */
function normalize(raw: unknown, shape: 'IMPORT_PARSE_ERROR' | 'INVALID_ARGUMENT', allowWarningsKey: boolean): Required<Pick<ManualCopyInput, 'messages' | 'warnings'>> & {
  conversationId: string | undefined;
  title: string | null;
  sourceUri: string | null;
} {
  const err = (field: string, reason: string): GcrError => bad(shape, field, reason);
  if (!isPlain(raw)) throw err('$', 'not_an_object');
  const notes = new Notes();
  let unknownTop = 0;
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k) && !(allowWarningsKey && k === 'warnings')) unknownTop++;
  if (unknownTop > 0) for (let i = 0; i < unknownTop; i++) notes.note('UNKNOWN_KEY_IGNORED', 'Unknown keys in the document were ignored.');

  const idRaw = own(raw, 'conversationId');
  let conversationId: string | undefined;
  if (idRaw !== undefined && idRaw !== null) {
    if (typeof idRaw !== 'string') throw err('conversationId', 'not_a_string');
    if (!UUID_RE.test(idRaw)) throw new GcrError('INVALID_UUID', 'conversationId is not a valid UUID (expected 8-4-4-4-12 hexadecimal digits).', { details: { field: 'conversationId', reason: 'not_a_uuid' } });
    conversationId = idRaw.toLowerCase();
  }

  const titleRaw = own(raw, 'title');
  let title: string | null = null;
  if (titleRaw !== undefined && titleRaw !== null) {
    if (typeof titleRaw !== 'string') throw err('title', 'not_a_string');
    title = cleanText(titleRaw, notes);
    if (title.length > MAX_TITLE_CHARS) throw err('title', 'too_long');
  }

  const uriRaw = own(raw, 'sourceUri');
  let sourceUri: string | null = null;
  if (uriRaw !== undefined && uriRaw !== null) {
    if (typeof uriRaw !== 'string') throw err('sourceUri', 'not_a_string');
    try {
      sourceUri = parseChatGptUrl(uriRaw).canonicalUrl; // rebuilt from the validated id, never copied from the input
    } catch (e) {
      // Whatever the parser objected to (share link, other host, bad uuid ...), the contract here is one code. The input is never echoed.
      const reason = e instanceof GcrError ? String(e.details?.['reason'] ?? e.code) : 'unparseable';
      throw new GcrError('INVALID_URL', 'sourceUri is not a https://chatgpt.com/c/<uuid> link.', {
        remedy: 'Give the exact conversation link (https://chatgpt.com/c/<uuid>) or omit sourceUri. GCR stores it as a label only and never opens it.',
        details: { field: 'sourceUri', reason },
      });
    }
    if (conversationId !== undefined && !sourceUri.endsWith(`/${conversationId}`)) {
      notes.note('SOURCE_URI_ID_MISMATCH', 'sourceUri names a different conversation id than conversationId; both were kept as given.');
    }
  }

  const msgsRaw = own(raw, 'messages');
  if (!Array.isArray(msgsRaw)) throw err('messages', 'not_an_array');
  if (msgsRaw.length === 0) throw err('messages', 'empty');
  if (msgsRaw.length > MANUAL_COPY_MAX_MESSAGES) throw tooLarge('messages', 'MANUAL_COPY_MAX_MESSAGES', MANUAL_COPY_MAX_MESSAGES);

  const messages: ManualCopyMessage[] = [];
  let total = 0;
  for (let i = 0; i < msgsRaw.length; i++) {
    const m: unknown = msgsRaw[i];
    const at = `messages[${i}]`;
    if (!isPlain(m)) throw err(at, 'not_an_object');
    for (const k of Object.keys(m)) if (!MESSAGE_KEYS.has(k)) notes.note('UNKNOWN_KEY_IGNORED', 'Unknown keys in the document were ignored.');
    const role = own(m, 'role');
    if (typeof role !== 'string' || role.length === 0) throw err(`${at}.role`, 'missing_or_not_a_string');
    if (role.length > MAX_ROLE_CHARS || CONTROL_RE.test(role)) throw err(`${at}.role`, 'invalid');
    const textRaw = own(m, 'text');
    if (typeof textRaw !== 'string') throw err(`${at}.text`, 'missing_or_not_a_string');
    const text = cleanText(textRaw, notes);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MANUAL_COPY_MAX_TEXT_BYTES) throw tooLarge(`${at}.text`, 'MANUAL_COPY_MAX_TEXT_BYTES', MANUAL_COPY_MAX_TEXT_BYTES);
    total += bytes;
    if (total > MANUAL_COPY_MAX_TOTAL_BYTES) throw tooLarge('messages', 'MANUAL_COPY_MAX_TOTAL_BYTES', MANUAL_COPY_MAX_TOTAL_BYTES);

    let createdAt: string | null = null;
    const createdRaw = own(m, 'createdAt');
    if (createdRaw !== undefined && createdRaw !== null) {
      if (typeof createdRaw !== 'string') throw err(`${at}.createdAt`, 'not_a_string');
      createdAt = normalizeUserTimestamp(createdRaw);
      if (createdAt === null) throw err(`${at}.createdAt`, 'not_an_iso_8601_instant_with_zone');
    }
    let modelSlug: string | null = null;
    const modelRaw = own(m, 'modelSlug');
    if (modelRaw !== undefined && modelRaw !== null) {
      if (typeof modelRaw !== 'string') throw err(`${at}.modelSlug`, 'not_a_string');
      if (modelRaw.length > MAX_MODEL_CHARS || CONTROL_RE.test(modelRaw)) throw err(`${at}.modelSlug`, 'invalid');
      modelSlug = modelRaw === '' ? null : modelRaw; // '' = "not stated"
    }
    messages.push({ role, text, createdAt, modelSlug });
  }
  return { conversationId, title, sourceUri, messages, warnings: notes.toWarnings() };
}

// ---------------------------------------------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------------------------------------------

/**
 * Strict, bounded reader for the manual-copy document. Throws IMPORT_PARSE_ERROR for invalid JSON or a wrong shape,
 * IMPORT_LIMIT_EXCEEDED beyond the documented limits, INVALID_UUID / INVALID_URL for bad identifiers. Error messages
 * contain field paths and reason codes only.
 */
export function parseManualCopyJson(text: string): ManualCopyInput {
  if (typeof text !== 'string') throw new GcrError('INVALID_ARGUMENT', 'The manual-copy document must be a string.', { details: { reason: 'not_a_string' } });
  if (text.length > MANUAL_COPY_MAX_DOCUMENT_CHARS) throw tooLarge('$', 'MANUAL_COPY_MAX_DOCUMENT_CHARS', MANUAL_COPY_MAX_DOCUMENT_CHARS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // No `cause`: V8's SyntaxError message quotes a fragment of the input.
    throw new GcrError('IMPORT_PARSE_ERROR', 'The manual-copy document is not valid JSON.', {
      remedy: 'Provide a JSON object like {"messages": [{"role": "user", "text": "..."}]}. See docs/IMPORT_GUIDE.md section "Manual copy".',
      details: { reason: 'NOT_JSON' },
    });
  }
  const n = normalize(parsed, 'IMPORT_PARSE_ERROR', false);
  const out: ManualCopyInput = { title: n.title, sourceUri: n.sourceUri, messages: n.messages, warnings: n.warnings };
  if (n.conversationId !== undefined) out.conversationId = n.conversationId;
  return out;
}

/** Canonical JSON of the NORMALIZED content (fixed key order, no warnings): the identity of a manual copy. */
function canonicalJson(n: { conversationId: string | undefined; title: string | null; sourceUri: string | null; messages: ManualCopyMessage[] }): string {
  return JSON.stringify({
    conversationId: n.conversationId ?? null,
    title: n.title,
    sourceUri: n.sourceUri,
    messages: n.messages.map((m) => ({ role: m.role, text: m.text, createdAt: m.createdAt ?? null, modelSlug: m.modelSlug ?? null })),
  });
}

/** sha256 hex of the canonical JSON; equivalent inputs (same content, different whitespace/zone spelling) share one digest. */
export function manualCopyDigest(input: ManualCopyInput): string {
  return createHash('sha256').update(canonicalJson(normalize(input, 'INVALID_ARGUMENT', true)), 'utf8').digest('hex');
}

/** UUID-shaped id from a content hash (version nibble 8 = "custom", RFC 9562; RFC variant bits). Deterministic. */
function syntheticConversationId(digest: string): string {
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(digest.charAt(16), 16) & 3] ?? '8';
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * The record for a manual copy: provider chatgpt, provenance user_supplied_copy, completeness partial_user_supplied, a
 * LINEAR tree in the order given, currentNodeId null, no structural root, no invented timestamps or models.
 */
export function manualCopyToRecord(input: ManualCopyInput, ctx: { accountLabel: string; importedAt: string }): ConversationRecord {
  assertAccountLabel(ctx?.accountLabel);
  if (!isIso8601Utc(ctx.importedAt)) throw new GcrError('INVALID_ARGUMENT', 'importedAt must be an ISO-8601 UTC timestamp.', { details: { field: 'importedAt' } });
  const n = normalize(input, 'INVALID_ARGUMENT', true);
  // Parse-time notes of the caller's document are carried over; normalize() above produced the notes of THIS call.
  const carried: Warning[] = [];
  if (isPlain(input) && Array.isArray(input.warnings)) {
    for (const w of input.warnings as unknown[]) {
      if (isPlain(w) && typeof w['code'] === 'string' && typeof w['message'] === 'string') carried.push({ code: w['code'].slice(0, 64), message: w['message'].slice(0, 2000) });
    }
  }
  const digest = createHash('sha256').update(canonicalJson(n), 'utf8').digest('hex');
  const synthesized = n.conversationId === undefined;
  const id = n.conversationId ?? syntheticConversationId(digest);

  const messages: MessageRecord[] = n.messages.map((m, i): MessageRecord => {
    const mid = `manual-${String(i + 1).padStart(5, '0')}`;
    return {
      id: mid,
      conversationId: id,
      parentId: i === 0 ? null : `manual-${String(i).padStart(5, '0')}`,
      childIds: i + 1 < n.messages.length ? [`manual-${String(i + 2).padStart(5, '0')}`] : [],
      nodeKind: 'message',
      authorRole: m.role,
      authorName: null,
      modelSlug: m.modelSlug ?? null,
      channel: null,
      recipient: null,
      contentType: 'text',
      status: null,
      hidden: false,
      createdAt: m.createdAt ?? null,
      updatedAt: null,
      text: m.text,
      blocks: m.text === '' ? [] : [{ type: 'text', text: m.text }],
      attachments: [],
      ordinal: i,
    };
  });

  const warnings: Warning[] = [{ code: 'PARTIAL_USER_SUPPLIED', message: PARTIAL_MESSAGE, ids: [id] }];
  if (synthesized) {
    warnings.push({ code: 'CONVERSATION_ID_SYNTHESIZED', message: 'No conversationId was given; a deterministic id was derived from the content hash.', ids: [id] });
  }
  const seen = new Set(warnings.map((w) => w.code));
  for (const w of [...carried, ...n.warnings]) {
    if (!seen.has(w.code)) {
      seen.add(w.code);
      warnings.push({ code: w.code, message: w.message });
    }
  }
  return {
    provider: 'chatgpt',
    accountLabel: ctx.accountLabel,
    id,
    title: n.title,
    sourceUri: n.sourceUri,
    provenance: 'user_supplied_copy',
    completeness: 'partial_user_supplied',
    importedAt: ctx.importedAt,
    createdAt: null,
    updatedAt: null,
    currentNodeId: null,
    defaultModelSlug: null,
    messages,
    rawMetadata: { _gcr: { manualCopy: true, inputSha256: digest, messageCount: messages.length } },
    warnings,
  };
}

function safeLabel(label: string | undefined): string {
  if (label === undefined) return 'manual-copy';
  const last = label.replaceAll('\\', '/').split('/').filter((p) => p !== '').at(-1) ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_LABEL_CHARS);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'manual-copy' : cleaned;
}

/**
 * Parse, convert and store a manual copy as ONE batch (sourceKind "manual_copy"). Idempotent: the batch digest is the
 * sha256 of the canonical JSON, so importing the same content again is a no-op reported with alreadyImported=true.
 * The report carries completeness context through its warnings (PARTIAL_USER_SUPPLIED is always present).
 */
export async function runManualCopyImport(
  repo: Repository,
  opts: { text: string; accountLabel?: string; clock?: () => string; sourceLabel?: string },
): Promise<ImportReport> {
  const t0 = performance.now();
  if (typeof opts !== 'object' || opts === null) throw new GcrError('INVALID_ARGUMENT', 'Options are required.', { details: { reason: 'NO_OPTIONS' } });
  const accountLabel = assertAccountLabel(opts.accountLabel ?? 'default');
  if (opts.clock !== undefined && typeof opts.clock !== 'function') throw new GcrError('INVALID_ARGUMENT', 'clock must be a function.', { details: { field: 'clock' } });
  const importedAt = (opts.clock ?? ((): string => new Date().toISOString()))();
  if (!isIso8601Utc(importedAt)) throw new GcrError('INVALID_ARGUMENT', 'The clock must return an ISO-8601 UTC timestamp.', { details: { field: 'clock' } });

  const input = parseManualCopyJson(opts.text);
  const record = manualCopyToRecord(input, { accountLabel, importedAt });
  const digest = manualCopyDigest(input);
  const sourceLabel = safeLabel(opts.sourceLabel);
  const meta: ImportBatchMeta = {
    provider: 'chatgpt',
    accountLabel,
    provenance: 'user_supplied_copy',
    completeness: 'partial_user_supplied',
    sourceKind: 'manual_copy',
    sourceLabel,
    contentDigest: digest,
    importedAt,
    toolVersion: TOOL_VERSION,
    warnings: record.warnings.map((w) => ({ code: w.code, message: /\(count=\d+\)$/.test(w.message) ? w.message : `${w.message} (count=1)`, ...(w.ids === undefined ? {} : { ids: w.ids }) })),
  };
  const result = await repo.importBatch({ batch: meta, conversations: [record] });
  // The stored warnings of an existing batch are the first import's; for a new batch they are exactly `meta.warnings`.
  const batchId = computeBatchId('chatgpt', accountLabel, digest);
  const stored = result.alreadyImported ? (repo.getBatch(batchId)?.warnings ?? meta.warnings) : meta.warnings;
  return {
    batchId: result.batchId,
    provider: 'chatgpt',
    accountLabel,
    sourceKind: 'manual_copy',
    sourceLabel,
    alreadyImported: result.alreadyImported,
    files: [{ name: sourceLabel, conversations: 1, failed: 0 }],
    conversations: { read: 1, stored: result.conversations.stored, failed: 0, newlyInserted: result.conversations.newlyInserted },
    messages: result.messages,
    warnings: summariesFromStored(stored),
    durationMs: Math.round(performance.now() - t0),
  };
}
