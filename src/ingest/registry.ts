/**
 * Adapter registry: maps a provider id to the source adapter that may normalize its export, and offers a CHEAP, SAFE
 * sniff of a single export element so the import runner can pick an adapter when the operator did not say which one.
 * Documented in docs/ADAPTERS.md (detection rules).
 *
 * Design rules:
 *  - Only export adapters are registered (`chatgpt`, `claude`). The OpenAI developer-API adapter (Mode D) is a disabled
 *    contract, not an export reader, and is deliberately NOT selectable here: asking for it gets NOT_IMPLEMENTED.
 *  - Detection never guesses: an element is attributed only when exactly one provider's marker is present; ambiguous,
 *    unreadable or unmarked elements yield `adapter: null` plus a fixed-text reason. It never throws.
 *  - Reasons are fixed strings (no element content), so they are safe to log and to return over MCP.
 *  - Pure: no I/O, no clock, no network.
 */
import { GcrError } from '../errors.js';
import type { ConversationProvenance, Provider } from '../domain/types.js';
import type { ConversationSourceAdapter } from './adapter.js';
import { ChatGPTExportAdapter } from './chatgpt-export.js';
import { ClaudeExportAdapter } from './claude-export.js';
import { modeDNotImplemented } from './openai-api.js';

export type AdapterId = 'chatgpt' | 'claude';

export const ADAPTER_IDS: readonly AdapterId[] = Object.freeze(['chatgpt', 'claude'] as AdapterId[]);

/**
 * Adapters are stateless, so one shared instance each is safe. They are FROZEN: the instances are process-wide, and a
 * caller that could assign `provenance`/`provider` would relabel every later import and `listAdapters()` result.
 * (ChatGPTExportAdapter only writes its fields in its constructor, so freezing it afterwards is safe.)
 */
const CHATGPT_ADAPTER: ConversationSourceAdapter = Object.freeze(new ChatGPTExportAdapter());
const CLAUDE_ADAPTER: ConversationSourceAdapter = Object.freeze(new ClaudeExportAdapter());

export function getAdapter(id: AdapterId): ConversationSourceAdapter {
  // A switch (not an object lookup) so ids such as "__proto__" or "constructor" can never resolve to something inherited.
  switch (id) {
    case 'chatgpt':
      return CHATGPT_ADAPTER;
    case 'claude':
      return CLAUDE_ADAPTER;
    default:
      // `id` is `never` for typed callers; this branch serves CLI/MCP input that bypassed the type.
      if ((id as unknown) === 'openai_api') throw modeDNotImplemented('getAdapter');
      throw new GcrError('INVALID_ARGUMENT', 'Unknown adapter id.', {
        remedy: `Use one of: ${ADAPTER_IDS.join(', ')}.`,
        details: { reason: 'UNKNOWN_ADAPTER', allowed: [...ADAPTER_IDS] },
      });
  }
}

export interface AdapterInfo {
  id: AdapterId;
  name: string;
  provider: Provider;
  provenance: ConversationProvenance;
}

/** Registered export adapters in a fixed order (for `gcr doctor` and documentation). */
export function listAdapters(): AdapterInfo[] {
  return ADAPTER_IDS.map((id) => {
    const a = getAdapter(id);
    return { id, name: a.name, provider: a.provider, provenance: a.provenance };
  });
}

// ------------------------------------------------------------------------------------------
// Detection
// ------------------------------------------------------------------------------------------

/**
 * Longest element text that is sniffed. Sniffing costs one JSON.parse of the element; beyond this the answer is
 * "unknown" and the operator selects the provider explicitly. Equal to a generous real conversation, far below the
 * 256 MiB element limit of the importer.
 */
export const DEFAULT_MAX_DETECT_CHARS = 64 * 1024 * 1024;

/**
 * The reason of a detection that was SKIPPED (not failed) because the element is over the sniffing limit (ATK-08b). Exported so
 * that the import runner can tell this case apart from the plain no-marker case without parsing prose: an element this large DOES have a
 * mapping (or chat_messages), nobody looked, and the operator must pass the provider. Still contains "sniffing limit".
 */
export const SNIFF_SKIPPED_TOO_LARGE = 'The element is too large to sniff (longer than the sniffing limit); pass the provider explicitly with --provider chatgpt|claude.';

export interface DetectOptions {
  /** Override the sniffing size limit (must be a positive finite number, otherwise the default applies). */
  maxChars?: number;
}

export interface AdapterDetection {
  adapter: AdapterId | null;
  /** Fixed-text explanation; never contains element content. */
  reason: string;
}

function undetected(reason: string): AdapterDetection {
  return { adapter: null, reason };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sniff(text: string, options: DetectOptions): AdapterDetection {
  if (typeof text !== 'string') return undetected('The element is not a string.');
  const requested: unknown = typeof options === 'object' && options !== null ? options.maxChars : undefined;
  const max = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_MAX_DETECT_CHARS;
  // Checked BEFORE parsing so a hostile huge element costs nothing.
  if (text.length > max) return undetected(SNIFF_SKIPPED_TOO_LARGE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undetected('The element is not valid JSON.');
  }
  if (Array.isArray(parsed)) return undetected('The element is a JSON array, not a conversation object.');
  if (!isObject(parsed)) return undetected('The element is not a JSON object.');

  // Own-property reads only: a marker must be a TOP-LEVEL key of the element, never inherited, never nested in a value.
  const mapping = Object.hasOwn(parsed, 'mapping') ? parsed['mapping'] : undefined;
  const chatMessages = Object.hasOwn(parsed, 'chat_messages') ? parsed['chat_messages'] : undefined;
  const looksChatGpt = isObject(mapping);
  const looksClaude = Array.isArray(chatMessages);
  if (looksChatGpt && looksClaude) return undetected('Ambiguous: the element has both an object "mapping" and a "chat_messages" array.');
  if (looksChatGpt) return { adapter: 'chatgpt', reason: 'The element has an object "mapping" (ChatGPT export conversation).' };
  if (looksClaude) return { adapter: 'claude', reason: 'The element has a "chat_messages" array (Claude export conversation).' };
  if (mapping !== undefined) return undetected('The element has a "mapping" key that is not an object, and no "chat_messages" array.');
  if (chatMessages !== undefined) return undetected('The element has a "chat_messages" key that is not an array, and no object "mapping".');
  if (Array.isArray(parsed['conversations'])) return undetected('The element looks like a wrapper object with a "conversations" array; sniff its elements instead.');
  return undetected('The element has neither an object "mapping" nor a "chat_messages" array.');
}

/**
 * Cheap, safe sniffing of ONE export element (the raw JSON text of one conversation).
 *   chatgpt  <=> top-level object "mapping"
 *   claude   <=> top-level array "chat_messages"
 * Both, neither, wrong types, invalid JSON, arrays and oversized text all return `adapter: null` with a reason.
 * Never guesses, never throws.
 */
export function detectAdapterFromElementText(text: string, options: DetectOptions = {}): AdapterDetection {
  try {
    return sniff(text, options);
  } catch {
    return undetected('Detection failed unexpectedly; select the provider explicitly.');
  }
}

/**
 * The error of an import in which no element identified a provider and none was forced (`resolveProvider` in import-runner.ts).
 * Code and `details.reason` are the ones the runner has always used; only the text differs when `tooLarge` says that at least one
 * element carrying a provider marker was NOT sniffed because it is over `DEFAULT_MAX_DETECT_CHARS`: then "no element has a mapping"
 * would be untrue (ATK-08b: a conversation with a 100 MB message was reported that way although it has a mapping).
 */
export function providerUndetectedError(opts: { tooLarge: boolean }): GcrError {
  if (opts.tooLarge) {
    return new GcrError(
      'IMPORT_UNSUPPORTED_FORMAT',
      `The conversation provider could not be detected: an element is too large to sniff (over ${DEFAULT_MAX_DETECT_CHARS / (1024 * 1024)} Mi characters), so its "mapping" or "chat_messages" marker was not looked at.`,
      {
        remedy: 'The provider must be passed explicitly for an element this large: --provider chatgpt|claude.',
        details: { reason: 'PROVIDER_UNDETECTED', sniffSkipped: 'ELEMENT_TOO_LARGE', maxDetectChars: DEFAULT_MAX_DETECT_CHARS },
      },
    );
  }
  return new GcrError('IMPORT_UNSUPPORTED_FORMAT', 'The conversation provider could not be detected: no element has a ChatGPT "mapping" or a Claude "chat_messages" array.', {
    remedy: 'Check that this is an official export, or select the provider explicitly (--provider chatgpt | claude).',
    details: { reason: 'PROVIDER_UNDETECTED' },
  });
}
