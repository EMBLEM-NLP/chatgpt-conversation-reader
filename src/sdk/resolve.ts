/**
 * Conversation reference handling and argument validation for the SDK facade.
 *
 * A reference names a conversation in the LOCAL database; it never causes any lookup elsewhere (AGENTS.md hard boundary:
 * `https://chatgpt.com/c/<uuid>` is a user's consumer link, used here only as a key into data the user imported).
 *
 *  - A STRING reference is a bare UUID or an exact `https://chatgpt.com/c/<uuid>` link (parseConversationRef). A link
 *    implies provider "chatgpt". Share links, other hosts and malformed text keep the UNSUPPORTED_URL / INVALID_URL /
 *    INVALID_UUID errors of the domain layer.
 *  - An OBJECT reference ({ conversationId, provider?, accountLabel?, batchId? }) carries an id exactly as stored,
 *    including ids that are not UUIDs (manual copies and other providers can use other id shapes).
 *  - Resolution follows ARCHITECTURE section 2: the head batch of every (provider, account) holding the id; more than one
 *    match is AMBIGUOUS_CONVERSATION, none is NOT_IN_LOCAL_EXPORT. NOT_IN_LOCAL_EXPORT never returns guessed content.
 *
 * Error messages and details never echo free-form caller text: ids are echoed only in `details` (they were validated as
 * UUIDs or are bounded identifiers), never a URL, so query strings and fragments can not travel into logs or envelopes.
 */
import type { Repository } from '../db/repo.js';
import { MAX_URL_LENGTH, isUuid, parseChatGptUrl, parseConversationRef } from '../domain/ids.js';
import type { ConversationSummary } from '../domain/results.js';
import type { ConversationRef, Provider } from '../domain/types.js';
import { GcrError } from '../errors.js';

/** Exact remedy text required by the SDK contract (SPEC FR-01, CODEX_TASK Phase 1). */
export const NOT_IN_LOCAL_EXPORT_REMEDY =
  'This conversation is not in the data you imported. GCR cannot fetch chatgpt.com conversations. Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>';

const PROVIDERS: readonly Provider[] = ['chatgpt', 'claude', 'openai_api'];
const MAX_REF_CHARS = 512;
const REF_KEYS = ['conversationId', 'provider', 'accountLabel', 'batchId'] as const;
/** Text that starts like a web link. Only these are read as links; any other text (even "col:quokka") is a RAW stored id. */
const HTTP_LINK_RE = /^[\t\n\f\r ]*https?:/i;

/** true when `text` has to be read as a chatgpt.com link (and therefore pass the domain layer's URL checks), not as a raw id. */
export function looksLikeHttpLink(text: string): boolean {
  return HTTP_LINK_RE.test(text);
}

// ---------------------------------------------------------------------------------------------------------------
// Argument validation helpers (shared by gcr.ts)
// ---------------------------------------------------------------------------------------------------------------

/** INVALID_ARGUMENT naming the field and the reason; the offending value is never echoed (it may be hostile or private). */
export function invalidArgument(field: string, why: string, extra: Record<string, unknown> = {}): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field, ...extra } });
}

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A copy of an options object that holds only allowed keys. Keys whose value is `undefined` count as absent (so
 * `{ limit: undefined }` from a CLI parser is fine); any other unknown key is INVALID_ARGUMENT, because a silently
 * ignored misspelled option ("branch_policy") would change what the caller gets without telling them.
 */
export function checkKeys(field: string, v: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObjectLike(v)) throw invalidArgument(field, 'expected an object');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v)) {
    const value = v[key];
    if (value === undefined) continue;
    if (!allowed.includes(key)) throw invalidArgument(field, 'contains an unknown option', { option: key.slice(0, 64) });
    Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true }); // defineProperty: a key named "__proto__" stays plain data
  }
  return out;
}

export function optBool(field: string, v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw invalidArgument(field, 'expected a boolean');
  return v;
}

export function optInt(field: string, v: unknown, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw invalidArgument(field, `expected an integer from ${min} to ${max}`);
  return v;
}

export function optString(field: string, v: unknown, max = MAX_REF_CHARS): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > max || v.includes('\0')) {
    throw invalidArgument(field, `expected a non-empty string of at most ${max} characters without NUL bytes`);
  }
  return v;
}

export function optEnum<T extends string>(field: string, v: unknown, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw invalidArgument(field, `expected one of ${allowed.join(', ')}`);
  return v as T;
}

// ---------------------------------------------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------------------------------------------

/**
 * String or object -> ConversationRef (no database access). Throws the domain layer's INVALID_URL / UNSUPPORTED_URL /
 * INVALID_UUID for bad strings and INVALID_ARGUMENT for a malformed object.
 */
export function normalizeRef(field: string, input: unknown): ConversationRef {
  if (typeof input === 'string') {
    const parsed = parseConversationRef(input);
    // A chatgpt.com link can only name a ChatGPT conversation; a bare UUID names none in particular.
    return parsed.viaUrl ? { conversationId: parsed.conversationId, provider: 'chatgpt' } : { conversationId: parsed.conversationId };
  }
  const o = checkKeys(field, input, REF_KEYS);
  const rawId = o['conversationId'];
  // A link may be longer than a stored id can be (query strings); the domain layer bounds it at MAX_URL_LENGTH and cuts the query off.
  const conversationId = optString(`${field}.conversationId`, rawId, typeof rawId === 'string' && looksLikeHttpLink(rawId) ? MAX_URL_LENGTH : MAX_REF_CHARS);
  if (conversationId === undefined) throw invalidArgument(`${field}.conversationId`, 'is required');
  let provider = optEnum<Provider>(`${field}.provider`, o['provider'], PROVIDERS);
  let id = isUuid(conversationId) ? conversationId.toLowerCase() : conversationId;
  if (looksLikeHttpLink(conversationId)) {
    // A link handed over in an object is the same thing as the string form: a key for a ChatGPT conversation. It must pass
    // the strict URL checks (share links, other hosts: UNSUPPORTED_URL) and is reduced to the bare id at once, so neither a
    // query string nor a fragment can travel into an error, a log or a lookup.
    if (provider !== undefined && provider !== 'chatgpt') throw invalidArgument(`${field}.provider`, 'conflicts with a chatgpt.com link used as conversationId');
    id = parseChatGptUrl(conversationId).conversationId;
    provider = 'chatgpt';
  }
  const ref: ConversationRef = { conversationId: id };
  if (provider !== undefined) ref.provider = provider;
  const accountLabel = optString(`${field}.accountLabel`, o['accountLabel']);
  if (accountLabel !== undefined) ref.accountLabel = accountLabel;
  const batchId = optString(`${field}.batchId`, o['batchId']);
  if (batchId !== undefined) ref.batchId = batchId;
  return ref;
}

/** Apply a batch pin given separately (options.batchId); a conflicting pin inside the reference is INVALID_ARGUMENT. */
export function withBatchPin(ref: ConversationRef, batchId: string | undefined): ConversationRef {
  if (batchId === undefined) return ref;
  if (ref.batchId !== undefined && ref.batchId !== batchId) throw invalidArgument('batchId', 'conflicts with the batch id inside the conversation reference');
  return { ...ref, batchId };
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------------------------

export function notInLocalExport(ref: ConversationRef, reason?: 'unknown_batch'): GcrError {
  const details: Record<string, unknown> = { conversationId: ref.conversationId };
  if (ref.provider !== undefined) details['provider'] = ref.provider;
  if (ref.accountLabel !== undefined) details['accountLabel'] = ref.accountLabel;
  if (ref.batchId !== undefined) details['batchId'] = ref.batchId;
  if (reason !== undefined) details['reason'] = reason;
  return new GcrError('NOT_IN_LOCAL_EXPORT', 'The conversation is not present in the locally imported data.', {
    remedy:
      reason === 'unknown_batch'
        ? 'No import batch has this id. List the batches (listBatches / gcr batches) and pass one of their ids, or omit the batch to read the newest snapshot.'
        : NOT_IN_LOCAL_EXPORT_REMEDY,
    details,
  });
}

/** Distinct, sorted (provider, accountLabel) pairs of the candidates. */
export function candidatePairs(matches: readonly ConversationSummary[]): Array<{ provider: Provider; accountLabel: string }> {
  const seen = new Set<string>();
  const out: Array<{ provider: Provider; accountLabel: string }> = [];
  for (const m of matches) {
    const key = `${m.provider}\0${m.accountLabel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider: m.provider, accountLabel: m.accountLabel });
  }
  out.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.accountLabel < b.accountLabel ? -1 : a.accountLabel > b.accountLabel ? 1 : 0));
  return out;
}

export function ambiguousConversation(ref: ConversationRef, matches: readonly ConversationSummary[]): GcrError {
  return new GcrError('AMBIGUOUS_CONVERSATION', 'The conversation id exists under more than one provider or account.', {
    remedy: 'Name one of the candidates: pass an object reference { conversationId, provider, accountLabel } (CLI: --provider and --account) to choose.',
    details: { conversationId: ref.conversationId, candidates: candidatePairs(matches) },
  });
}

/**
 * The single stored conversation snapshot a reference names: the head batch of the only (provider, account) holding the id,
 * or the pinned batch. NOT_IN_LOCAL_EXPORT when nothing matches (never guessed content, never any network attempt),
 * AMBIGUOUS_CONVERSATION when several (provider, account) pairs match.
 */
export function resolveSummary(repo: Repository, ref: ConversationRef): ConversationSummary {
  const { matches } = repo.resolveConversation(ref);
  const first = matches[0];
  if (first === undefined) {
    if (ref.batchId !== undefined && repo.getBatch(ref.batchId) === null) throw notInLocalExport(ref, 'unknown_batch');
    throw notInLocalExport(ref);
  }
  if (matches.length > 1) throw ambiguousConversation(ref, matches);
  return first;
}
