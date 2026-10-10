/**
 * Conversation identifiers and the one URL form GCR accepts (SPEC FR-01, ARCHITECTURE section 4, ADR-0011).
 *
 * Hard boundary (AGENTS.md): `https://chatgpt.com/c/<uuid>` is a user's consumer ChatGPT link, NOT an API resource.
 * GCR only uses it as a *lookup key* into locally imported, user-authorized data. This module is pure string logic:
 * it never opens, resolves or downloads anything.
 *
 * Error-code policy (applied consistently, asserted by test/domain/ids.test.ts):
 *   INVALID_ARGUMENT  the argument is not a string at all (caller bug)
 *   INVALID_URL       the text is not a well-formed, canonical absolute https URL: empty, > 2048 chars, control
 *                     characters (incl. NUL), backslashes, percent-encoding anywhere in the path (module spec: "percent-
 *                     encoded or backslash path tricks"), no scheme, `https:` without `//`, empty host
 *   UNSUPPORTED_URL   well-formed but not the single accepted form: other scheme, other host (www., chat.openai.com,
 *                     look-alikes), userinfo, explicit port, any path other than `/c/<segment>[/]`, extra path segments /
 *                     dot segments after `/c/`
 *   INVALID_UUID      the URL shape is right but the single `/c/<segment>` is not a UUID (wrong length, non-hex, ...);
 *                     also used for a bare string that is not a UUID
 *
 * Error messages and `details` NEVER echo the input (it is untrusted and may carry text meant for an LLM reader).
 */
import { GcrError } from '../errors.js';

/** Longest accepted URL text (before trimming). Bounds all work done on untrusted input. */
export const MAX_URL_LENGTH = 2048;

const CANONICAL_HOST = 'chatgpt.com';
const CANONICAL_PREFIX = `https://${CANONICAL_HOST}/c/`;
const HELP = 'Use a link of the form https://chatgpt.com/c/<uuid> or a bare conversation UUID. GCR never opens the link: it only looks the id up in conversations you imported from an official export.';

/**
 * 8-4-4-4-12 hex. Only the SHAPE is checked, not the RFC 9562 version/variant nibbles: ChatGPT ids are
 * not guaranteed to be v4 (the reference id in SPEC section 1 carries version nibble 8).
 * The `i` flag is used WITHOUT the `u` flag on purpose: with `u`, case folding would let non-ASCII letters
 * (e.g. U+017F) match ASCII hex digits.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** C0 controls (incl. NUL), DEL and C1 controls. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** Scheme prefix that makes parseConversationRef treat an input as a URL (a bare UUID never contains ':'). */
const LEADING_SCHEME_RE = /^[ \t\n\f\r]*[A-Za-z][A-Za-z0-9+.-]*:/;

export interface ParsedChatGptUrl {
  /** Lower-cased UUID. */
  conversationId: string;
  /** `https://chatgpt.com/c/<lower-case uuid>`: rebuilt from the validated id, never copied from the input. */
  canonicalUrl: string;
}

export interface ParsedConversationRef {
  conversationId: string;
  /** true when the input was a chatgpt.com link (as opposed to a bare UUID). */
  viaUrl: boolean;
  /** Present only when `viaUrl` is true. */
  canonicalUrl?: string;
}

/**
 * true iff `s` is exactly a 36-character 8-4-4-4-12 UUID string (any case).
 *
 * Two signatures on purpose: for a `string` argument the result is a plain boolean, because a type predicate `s is string`
 * would narrow a string that is NOT a UUID to `never` in the false branch; for any other (e.g. `unknown`) argument it
 * narrows to `string` on success.
 */
export function isUuid(s: string): boolean;
export function isUuid(s: unknown): s is string;
export function isUuid(s: unknown): boolean {
  return typeof s === 'string' && s.length === 36 && UUID_RE.test(s);
}

/**
 * Lower-case a UUID. Throws INVALID_UUID for ANY input that is not exactly a 36-char UUID string
 * (including non-strings): no trimming, no braces, no `urn:uuid:` prefix.
 */
export function normalizeUuid(s: string): string {
  if (!isUuid(s)) {
    throw new GcrError('INVALID_UUID', 'Not a valid UUID (expected 8-4-4-4-12 hexadecimal digits).', {
      remedy: HELP,
      details: { reason: 'not_a_uuid' },
    });
  }
  return s.toLowerCase();
}

/** Remove leading/trailing ASCII whitespace (WHATWG set: TAB, LF, FF, CR, SPACE). Nothing else is trimmed. */
function trimAsciiWhitespace(s: string): string {
  const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
  let start = 0;
  let end = s.length;
  while (start < end && isWs(s.charCodeAt(start))) start++;
  while (end > start && isWs(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/** ASCII-only lower-casing. `String.prototype.toLowerCase` also maps some non-ASCII code points onto ASCII letters. */
function asciiLowerCase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function fail(code: 'INVALID_ARGUMENT' | 'INVALID_URL' | 'UNSUPPORTED_URL' | 'INVALID_UUID', message: string, reason: string, extra: Record<string, unknown> = {}): never {
  throw new GcrError(code, message, { remedy: HELP, details: { reason, ...extra } });
}

/**
 * Accepts EXACTLY `https://chatgpt.com/c/<uuid>` (scheme, host and uuid case-insensitive; one optional trailing
 * `/`; a query string and/or fragment are ignored; surrounding ASCII whitespace is trimmed) and nothing else.
 *
 * SECURITY: WHATWG `new URL()` is deliberately NOT trusted to decide acceptance, because it silently "repairs" input:
 *   - strips TAB/LF/CR anywhere in the string          -> control characters are rejected up front
 *   - treats `\` as `/` for https                      -> backslashes are rejected
 *   - accepts `https:host`, `https:/host`, `https:///host` -> the literal `https://` is required
 *   - applies IDNA (full-width `ｃhatgpt.com` -> `chatgpt.com`) and strips a default `:443` -> the RAW authority text
 *     must equal `chatgpt.com` (ASCII case-insensitive)
 *   - resolves `/c/../c/<uuid>` and `/share/../c/<uuid>` -> the RAW path text is inspected, never `pathname`
 * The WHATWG result is only used as a second, independent confirmation of what the strict raw checks accepted.
 * The query and fragment are cut off before any parsing, so they can neither influence nor break the decision.
 */
export function parseChatGptUrl(input: string): ParsedChatGptUrl {
  if (typeof input !== 'string') fail('INVALID_ARGUMENT', 'The URL must be a string.', 'not_a_string');
  // Length is checked on the raw input first so every later step works on a bounded string.
  if (input.length > MAX_URL_LENGTH) {
    fail('INVALID_URL', `The URL is longer than ${MAX_URL_LENGTH} characters.`, 'too_long', { maxLength: MAX_URL_LENGTH, length: input.length });
  }
  const trimmed = trimAsciiWhitespace(input);
  if (trimmed.length === 0) fail('INVALID_URL', 'The URL is empty.', 'empty');
  if (CONTROL_RE.test(trimmed)) fail('INVALID_URL', 'The URL contains control characters.', 'control_character');

  // Everything from the first `?` or `#` on is ignored (and never parsed).
  let cut = trimmed.length;
  const q = trimmed.indexOf('?');
  const h = trimmed.indexOf('#');
  if (q !== -1) cut = q;
  if (h !== -1 && h < cut) cut = h;
  const base = trimmed.slice(0, cut);

  if (base.includes('\\')) fail('INVALID_URL', 'The URL contains a backslash.', 'backslash');

  const scheme = SCHEME_RE.exec(base);
  if (scheme === null) fail('INVALID_URL', 'The text is not an absolute URL.', 'no_scheme');
  const schemeName = asciiLowerCase(scheme[1] ?? '');
  if (schemeName !== 'https') {
    fail('UNSUPPORTED_URL', 'Only https://chatgpt.com/c/<uuid> links are supported.', 'scheme');
  }
  // Require the literal "//": WHATWG would also accept "https:host" / "https:/host" for special schemes.
  if (!base.startsWith('//', scheme[0].length)) fail('INVALID_URL', 'The URL must start with https://.', 'missing_authority_slashes');

  const afterSlashes = base.slice(scheme[0].length + 2);
  const firstSlash = afterSlashes.indexOf('/');
  const authority = firstSlash === -1 ? afterSlashes : afterSlashes.slice(0, firstSlash);
  const path = firstSlash === -1 ? '' : afterSlashes.slice(firstSlash);

  if (authority.length === 0) fail('INVALID_URL', 'The URL has no host.', 'empty_host');
  // "https://chatgpt.com@evil.com/..." and "https://evil.com@chatgpt.com/..." are both refused: no userinfo at all.
  if (authority.includes('@')) fail('UNSUPPORTED_URL', 'URLs with credentials (userinfo) are not supported.', 'userinfo');
  // Any ':' in the authority is a port (or an IPv6 literal); even ":443" is refused rather than normalized away.
  if (authority.includes(':')) fail('UNSUPPORTED_URL', 'URLs with an explicit port are not supported.', 'port');
  if (asciiLowerCase(authority) !== CANONICAL_HOST) {
    fail('UNSUPPORTED_URL', 'Only the host chatgpt.com is supported (not www., chat.openai.com or look-alike hosts).', 'host');
  }

  // Percent-encoding is never part of the accepted shape; refusing it removes every decode-ambiguity trick
  // (%2e%2e, %2F, %63 for "c", encoded hex digits inside the uuid). Like backslashes and control characters it makes the
  // text a non-canonical URL, so it is INVALID_URL (module spec), not UNSUPPORTED_URL.
  if (path.includes('%')) fail('INVALID_URL', 'Percent-encoded paths are not supported.', 'percent_encoding');
  // Case-sensitive "/c/": covers "", "/", "/share/...", "/g/.../c/...", "//c/...", "/C/..." and "/c".
  if (!path.startsWith('/c/')) fail('UNSUPPORTED_URL', 'Only /c/<uuid> conversation links are supported (share links and other paths are not).', 'path');
  let segment = path.slice(3);
  if (segment.endsWith('/')) segment = segment.slice(0, -1); // exactly ONE optional trailing slash
  // A '/' left in the segment means extra path segments, "..", "." or "//" after /c/ -> never normalized, always refused.
  if (segment.includes('/')) fail('UNSUPPORTED_URL', 'Extra path segments after the conversation id are not supported.', 'extra_path_segments');
  if (!UUID_RE.test(segment)) fail('INVALID_UUID', 'The conversation id in the link is not a valid UUID.', 'uuid');

  // Independent confirmation with the WHATWG parser. For input that passed the strict raw checks this cannot
  // disagree; if it ever does (parser/spec drift), refuse rather than guess.
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return fail('INVALID_URL', 'The URL could not be parsed.', 'whatwg_parse');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hostname !== CANONICAL_HOST ||
    parsed.pathname !== path
  ) {
    fail('UNSUPPORTED_URL', 'The URL failed canonical re-verification.', 'reverification');
  }

  const conversationId = segment.toLowerCase();
  return { conversationId, canonicalUrl: CANONICAL_PREFIX + conversationId };
}

/**
 * A bare UUID or a chatgpt.com link. Anything that starts with a URL scheme (`<scheme>:`, so also `http:`, `ftp:`,
 * `javascript:`) is treated as a URL and must pass parseChatGptUrl (giving UNSUPPORTED_URL for non-https schemes);
 * everything else must be a bare UUID (surrounding ASCII whitespace trimmed) or INVALID_UUID is thrown.
 */
export function parseConversationRef(input: string): ParsedConversationRef {
  if (typeof input !== 'string') fail('INVALID_ARGUMENT', 'The conversation reference must be a string.', 'not_a_string');
  if (LEADING_SCHEME_RE.test(input)) {
    const { conversationId, canonicalUrl } = parseChatGptUrl(input);
    return { conversationId, viaUrl: true, canonicalUrl };
  }
  return { conversationId: normalizeUuid(trimAsciiWhitespace(input)), viaUrl: false };
}
