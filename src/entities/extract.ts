/**
 * Local-first entity extraction (SPEC FR-12, NFR-04/08; CODEX_TASK Phase 2).
 *
 * `extractEntities` turns ONE message (its text, role, recipient, content blocks and attachment metadata) into a small,
 * deterministic list of entities: URLs, UUIDs, ISO-8601 timestamps, tool names, code-fence languages, attachment file
 * names and top keywords. It is pure: no I/O, no clock, no randomness, no network. Imported text is untrusted DATA; it
 * is only ever matched against fixed patterns, never interpreted.
 *
 * Privacy (NFR-06, FR-08)
 *  - URLs keep scheme + host + path only. Userinfo (`user:password@`), query string and fragment are REMOVED before
 *    anything is stored, because signed URLs and tokens live there. The removed parts are also blanked out of the text
 *    that the other extractors see, so a token inside a query string can never resurface as a UUID, timestamp or keyword.
 *  - E-mail addresses are blanked before keyword extraction (their parts would otherwise become keywords). Phone
 *    numbers are never extracted: keywords must contain at least three letters, so digit strings are inert.
 *  - Only http(s) URLs are recognised; `javascript:`, `data:`, `file:` and friends never match. URL-shaped text with any
 *    OTHER scheme (`ftp://u:pw@h/`, `postgres://u:pw@db/x?y`, `s3://b/k?sig=..`, or `http` glued to letters as in
 *    "linkhttps://h/?token=..") is not extracted either, but its userinfo, query and fragment are blanked so that
 *    credentials and tokens cannot resurface as keywords.
 *
 * Complexity / ReDoS (all verified by test/entities/extract.redos.test.ts)
 *  - Every regular expression is free of nested or overlapping quantifiers (each repeated item is a single character
 *    class, fixed-width groups, or bounded repeats). The two scanners that would be quadratic as regexes (URL
 *    extents and e-mail addresses) are written as bounded manual scans that always consume what they inspect.
 *  - Input longer than `maxTextChars` (default 200 000 UTF-16 units) is cut BEFORE any work is done, and the NFKC-normalised
 *    text is cut to the same bound again (compatibility characters such as U+FDFA expand up to 18 times).
 *  - NFKC normalisation is quadratic in ICU for very long runs of combining marks (200 000 marks take ~10 s), so runs
 *    of more than 8 consecutive combining marks are truncated first (`normalizeNfkc`). Real scripts never need more.
 *
 * Determinism: results are sorted (kind order, count desc, normalized asc using plain `<`), ties never depend on the
 * locale, and nothing depends on Map insertion order of equal keys.
 */
import type { AttachmentRef, ContentBlock } from '../domain/types.js';
import { GcrError } from '../errors.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

export type EntityKind = 'url' | 'uuid' | 'timestamp' | 'keyword' | 'tool' | 'code_language' | 'file_name';

/** Output order of kinds (also the order used to break ties between kinds elsewhere). */
export const ENTITY_KINDS: readonly EntityKind[] = ['url', 'uuid', 'timestamp', 'tool', 'code_language', 'file_name', 'keyword'];

export interface ExtractedEntity {
  kind: EntityKind;
  /** Display form. For URLs this is the SANITIZED url (no userinfo, query or fragment). */
  value: string;
  /** Canonical key used for de-duplication and graph node ids. */
  normalized: string;
  /** Occurrences within this message (tools: one per contributing field). */
  count: number;
}

export interface ExtractInput {
  text: string;
  authorRole?: string;
  recipient?: string | null;
  authorName?: string | null;
  blocks?: ContentBlock[];
  attachments?: AttachmentRef[];
}

export interface ExtractOptions {
  /** Keywords kept per message. Default 8. */
  maxKeywords?: number;
  /** Cap per kind (keywords are additionally capped by maxKeywords). Default 64. */
  maxPerKind?: number;
  /** Longer text is processed only up to this many UTF-16 units. Default 200 000. */
  maxTextChars?: number;
}

export const DEFAULT_MAX_KEYWORDS = 8;
export const DEFAULT_MAX_PER_KIND = 64;
export const DEFAULT_MAX_TEXT_CHARS = 200_000;

const MAX_URL_CHARS = 2048;
const MAX_HOST_CHARS = 253;
const MAX_TOOL_CHARS = 128;
const MAX_FILE_NAME_CHARS = 255;
const MAX_LANGUAGE_CHARS = 32;
const MAX_BLOCKS_SCANNED = 10_000;
const MAX_ATTACHMENTS_SCANNED = 1_000;
const MAX_KEYWORD_CHARS = 40;
const FENCE_LOOKAHEAD = 160;

export function isEntityKind(x: unknown): x is EntityKind {
  return typeof x === 'string' && (ENTITY_KINDS as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------------------------------------------
// Option / input validation
// ---------------------------------------------------------------------------------------------------------------

function badArg(field: string, why: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field } });
}

function intOption(field: string, v: unknown, dflt: number, min: number, max: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badArg(field, `expected an integer from ${min} to ${max}`);
  return v;
}

interface Limits {
  maxKeywords: number;
  maxPerKind: number;
  maxTextChars: number;
}

function resolveLimits(opts: ExtractOptions | undefined): Limits {
  const o = opts ?? {};
  return {
    maxKeywords: intOption('maxKeywords', o.maxKeywords, DEFAULT_MAX_KEYWORDS, 0, 1000),
    maxPerKind: intOption('maxPerKind', o.maxPerKind, DEFAULT_MAX_PER_KIND, 0, 10_000),
    maxTextChars: intOption('maxTextChars', o.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 1, 16_777_216),
  };
}

/** Cut to `max` UTF-16 units without splitting a surrogate pair. */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Largest NFKC expansion of one UTF-16 unit (U+FDFA becomes 18 units). */
const MAX_NFKC_EXPANSION = 18;

/**
 * true when `extractEntities` would not look at the whole text because of `maxTextChars`: the text is longer than the
 * cap, or it is NFKC-normalised to something longer than the cap. Lets callers (graph/build.ts) warn about cuts instead
 * of swallowing them. Costs a second normalisation only for non-ASCII text that could possibly expand past the cap.
 */
export function exceedsTextCap(text: string, maxTextChars: number): boolean {
  if (text.length > maxTextChars) return true;
  if (text.length * MAX_NFKC_EXPANSION <= maxTextChars || ASCII_ONLY.test(text)) return false;
  return normalizeNfkc(text).length > maxTextChars;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------------------------

const ASCII_ONLY = /^[\x00-\x7f]*$/;
/** A combining mark that follows at least 8 other marks. Lookbehind width is fixed (8), so this is linear. */
const MARK_RUN_TAIL = /(?<=\p{M}{8})\p{M}/gu;
/** A UTF-16 surrogate that is not half of a valid pair (no `u` flag: the pattern works on code units). One-unit look-around: linear. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * NFKC with a guard against ICU's quadratic reordering of long combining-mark runs ("Zalgo" text): marks beyond the
 * eighth in a row are dropped first. Lone surrogates (malformed UTF-16, e.g. from a JSON "\\ud800" escape) become U+FFFD,
 * which is what SQLite stores for them: an entity string must be identical in memory and in the database, otherwise two
 * strings that differ only in their lone surrogates are two entities here and one row there. Pure-ASCII text (the common
 * case) is returned untouched.
 */
export function normalizeNfkc(s: string): string {
  if (ASCII_ONLY.test(s)) return s;
  return s.replace(MARK_RUN_TAIL, '').replace(LONE_SURROGATE, '\ufffd').normalize('NFKC');
}

// ---------------------------------------------------------------------------------------------------------------
// Range blanking (keeps string length, so offsets stay valid between passes)
// ---------------------------------------------------------------------------------------------------------------

type Range = readonly [number, number];

/** Replace every [start, end) range by spaces. Ranges must not overlap; order does not matter. */
function blank(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of sorted) {
    const from = Math.max(a, pos); // overlapping ranges are clipped, so nothing is blanked twice
    if (b <= from) continue;
    out += text.slice(pos, from) + ' '.repeat(b - from);
    pos = b;
  }
  return out + text.slice(pos);
}

// ---------------------------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------------------------

/** Longest run of scheme characters (letters, digits, `+ - .`) in front of "://" that is still treated as a scheme. */
const MAX_SCHEME_CHARS = 32;
/** First character that cannot be part of a URL (whitespace, controls, quotes, brackets of markup, CJK punctuation, bidi/zero-width). */
const URL_END = /[\s\u0000-\u001f\u007f-\u009f<>"'`\\\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{3000}-\u{303f}\u{ff00}-\u{ffef}]/gu;
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '*', '\u{2026}']);

interface UrlHit {
  start: number;
  /** Exclusive end of the URL proper (after trailing punctuation was trimmed). */
  end: number;
  value: string;
  normalized: string;
  /** Ranges (absolute offsets) holding userinfo and query/fragment: blanked for all later passes. */
  secretRanges: Range[];
}

interface UrlScan {
  hits: UrlHit[];
  /**
   * Ranges blanked for every later pass: whole runs that started like an http(s) URL but were not acceptable, and the
   * secret parts (userinfo, query, fragment) of URL-shaped text with any OTHER scheme (see scanUrls).
   */
  rejected: Range[];
}

/** Trailing sentence punctuation and UNBALANCED closing brackets are not part of the URL. */
function trimUrlTail(raw: string): string {
  let paren = 0;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < raw.length; i++) {
    switch (raw.charCodeAt(i)) {
      case 40:
        paren++;
        break;
      case 41:
        paren--;
        break;
      case 91:
        square++;
        break;
      case 93:
        square--;
        break;
      case 123:
        curly++;
        break;
      case 125:
        curly--;
        break;
      default:
        break;
    }
  }
  let end = raw.length;
  while (end > 0) {
    const c = raw.charAt(end - 1);
    if (TRAILING_PUNCT.has(c)) {
      end--;
    } else if (c === ')' && paren < 0) {
      paren++;
      end--;
    } else if (c === ']' && square < 0) {
      square++;
      end--;
    } else if (c === '}' && curly < 0) {
      curly++;
      end--;
    } else {
      break;
    }
  }
  return raw.slice(0, end);
}

function isHostChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) return true; // 0-9 a-z (input is already lower-cased)
  return c > 127 && /^[\p{L}\p{N}\p{M}]$/u.test(ch);
}

/** Lower-cased host or null. Labels: 1-63 chars, letters/digits/hyphen, no leading or trailing hyphen. IPv4-looking hosts must be valid. */
function validHostname(hostIn: string): string | null {
  let host = hostIn.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > MAX_HOST_CHARS) return null;
  const labels = host.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
    for (const ch of label) {
      if (ch !== '-' && !isHostChar(ch)) return null;
    }
  }
  if (/^[0-9.]+$/.test(host)) {
    if (labels.length !== 4) return null;
    for (const l of labels) {
      if (Number(l) > 255) return null;
    }
  }
  return host;
}

interface HostPort {
  host: string;
  port: string;
}

function parseHostPort(hostport: string, scheme: 'http' | 'https'): HostPort | null {
  let host: string;
  let portStr = '';
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    if (close < 2) return null;
    const inner = hostport.slice(1, close);
    if (!/^[0-9a-fA-F:.]+$/.test(inner) || !inner.includes(':')) return null;
    const rest = hostport.slice(close + 1);
    if (rest !== '') {
      if (!/^:\d{1,5}$/.test(rest)) return null;
      portStr = rest.slice(1);
    }
    host = `[${inner.toLowerCase()}]`;
  } else {
    const colon = hostport.lastIndexOf(':');
    let hostStr = hostport;
    if (colon >= 0) {
      portStr = hostport.slice(colon + 1);
      hostStr = hostport.slice(0, colon);
      if (!/^\d{1,5}$/.test(portStr)) return null; // also rejects the empty port of "http://http://"
    }
    const valid = validHostname(hostStr);
    if (valid === null) return null;
    host = valid;
  }
  if (portStr !== '') {
    const n = Number(portStr);
    if (n > 65535) return null;
    portStr = String(n); // drop leading zeros
    if ((scheme === 'http' && n === 80) || (scheme === 'https' && n === 443)) portStr = '';
  }
  return { host, port: portStr };
}

/** Parse one candidate (already trimmed). Returns null when it is not an acceptable http(s) URL. */
function parseUrlCandidate(core: string, start: number): Omit<UrlHit, 'start' | 'end'> | null {
  const scheme: 'http' | 'https' = core.charCodeAt(4) === 58 ? 'http' : 'https';
  const authStart = scheme === 'http' ? 7 : 8;
  let i = authStart;
  while (i < core.length) {
    const c = core.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) break; // / ? #
    i++;
  }
  const authority = core.slice(authStart, i);
  if (authority.length === 0) return null;
  let j = i;
  while (j < core.length) {
    const c = core.charCodeAt(j);
    if (c === 63 || c === 35) break; // ? #
    j++;
  }
  const pathRaw = core.slice(i, j);
  // Userinfo is everything up to the LAST '@' of the authority: "http://good.com@evil.com/" has host evil.com.
  const at = authority.lastIndexOf('@');
  const userinfoLen = at >= 0 ? at + 1 : 0;
  const hp = parseHostPort(authority.slice(userinfoLen), scheme);
  if (hp === null) return null;
  const hostPort = hp.port === '' ? hp.host : `${hp.host}:${hp.port}`;
  const path = pathRaw === '' ? '/' : pathRaw;
  const secretRanges: Range[] = [];
  if (userinfoLen > 0) secretRanges.push([start + authStart, start + authStart + userinfoLen]);
  if (j < core.length) secretRanges.push([start + j, start + core.length]);
  return { value: `${scheme}://${hostPort}${path}`, normalized: `${hostPort}${path}`, secretRanges };
}

function isSchemeCharCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46; // 0-9 A-Z a-z + - .
}

/**
 * Secret parts of URL-shaped text whose scheme is NOT http(s) (`ftp://u:pw@h/`, `postgres://u:pw@db/x?y`, `s3://b/k?sig=..`,
 * and also an http scheme glued to preceding letters such as "linkhttps://h/?token=..."): userinfo, query and fragment.
 * Such text is never extracted as a URL entity, but its secrets must not resurface as keywords either (privacy), so
 * they are blanked like those of an http(s) URL. Host and path stay ordinary text. `authStart` is the index just after
 * "://" and `runEnd` the exclusive end of the run. One forward pass over the run: linear.
 */
function otherSchemeSecrets(text: string, authStart: number, runEnd: number, out: Range[]): void {
  let i = authStart;
  let lastAt = -1;
  while (i < runEnd) {
    const c = text.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) break; // / ? #
    if (c === 64) lastAt = i; // userinfo ends at the LAST '@' of the authority
    i++;
  }
  if (lastAt >= 0) out.push([authStart, lastAt + 1]);
  while (i < runEnd) {
    const c = text.charCodeAt(i);
    if (c === 63 || c === 35) break; // ? #
    i++;
  }
  if (i < runEnd) out.push([i, runEnd]);
}

/**
 * Find http(s) URLs (and blank the secrets of other URL-shaped text, see otherSchemeSecrets). Every "://" is examined
 * once: the scheme is the maximal run of scheme characters in front of it (at most MAX_SCHEME_CHARS). An http(s)
 * candidate consumes its whole run (up to the next URL-terminating character) whether it is accepted or not, so nested
 * "http://" inside its query string is never examined; text with any other scheme is only blanked once per run and
 * scanning continues INSIDE it, so an http(s) URL nested in it (as in "ftp://h/p?u=http://x.example/") is still found.
 * The end of a run is computed once and reused for the "://" inside it, so no character is inspected more than a
 * constant number of times: linear in the text length even for "http://http://http://..." or one gigantic run.
 */
function scanUrls(text: string): UrlScan {
  const hits: UrlHit[] = [];
  const rejected: Range[] = [];
  if (text.length < 4) return { hits, rejected };
  let from = 0;
  let runEndCache = -1; // exclusive end of the run found for the last "://" (valid for every "://" before it)
  let secretsDoneUntil = -1; // otherSchemeSecrets already blanked the run that ends here
  for (;;) {
    const sep = text.indexOf('://', from);
    if (sep < 0) break;
    // Walk back over scheme characters; never past the previous run and never more than MAX_SCHEME_CHARS + 1 of them.
    const lowest = Math.max(from, sep - (MAX_SCHEME_CHARS + 1));
    let start = sep;
    while (start > lowest && isSchemeCharCode(text.charCodeAt(start - 1))) start--;
    if (start === sep) {
      from = sep + 3; // "://" without a scheme in front of it
      continue;
    }
    let runEnd: number;
    if (sep + 3 < runEndCache) {
      runEnd = runEndCache; // nested in the run found earlier: no URL-terminating character lies in between
    } else {
      URL_END.lastIndex = sep + 3;
      const t = URL_END.exec(text);
      runEnd = t === null ? text.length : t.index;
      runEndCache = runEnd;
    }
    if (runEnd - start > MAX_URL_CHARS) {
      rejected.push([start, runEnd]);
      from = runEnd;
      continue;
    }
    // Only a scheme that is exactly "http" or "https" starts a URL: "xhttp://" and "git+https://" are other schemes.
    const schemeLen = sep - start;
    if (schemeLen < 4 || schemeLen > 5 || !/^https?$/i.test(text.slice(start, sep))) {
      if (sep + 3 >= secretsDoneUntil) {
        otherSchemeSecrets(text, sep + 3, runEnd, rejected);
        secretsDoneUntil = runEnd;
      }
      from = sep + 3;
      continue;
    }
    from = runEnd; // continue AFTER an http(s) run: nested "http://" inside a query string is never examined
    const core = trimUrlTail(text.slice(start, runEnd));
    const parsed = parseUrlCandidate(core, start);
    if (parsed === null) {
      rejected.push([start, runEnd]);
      continue;
    }
    hits.push({ start, end: start + core.length, ...parsed });
  }
  return { hits, rejected };
}

/**
 * Sanitize a user-typed URL the same way the extractor does (for graph lookups). Null when it is not an acceptable
 * http(s) URL.
 */
export function sanitizeUrl(input: string): { value: string; normalized: string } | null {
  if (typeof input !== 'string' || input.length > MAX_URL_CHARS) return null;
  const scan = scanUrls(normalizeNfkc(input.trim()));
  const hit = scan.hits[0];
  return hit === undefined ? null : { value: hit.value, normalized: hit.normalized };
}

// ---------------------------------------------------------------------------------------------------------------
// E-mail addresses (blanked, never extracted)
// ---------------------------------------------------------------------------------------------------------------

const MAX_EMAIL_LOCAL = 64;
const MAX_EMAIL_DOMAIN = 255;

function isEmailLocalChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
  if (c === 46 || c === 95 || c === 37 || c === 43 || c === 45) return true; // . _ % + -
  return c > 127 && /^[\p{L}\p{N}]$/u.test(ch);
}

function isEmailDomainChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45) return true;
  return c > 127 && /^[\p{L}\p{N}]$/u.test(ch);
}

/**
 * Ranges of e-mail-shaped substrings. Anchored on '@' and bounded to 64 + 255 characters around it, so the cost per '@'
 * is constant (a regex such as `[\w.]+@[\w.]+\.\w+` is quadratic on long runs of word characters).
 */
function findEmailRanges(text: string): Range[] {
  const out: Range[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('@', from);
    if (at < 0) break;
    from = at + 1;
    let left = at;
    while (left > 0 && at - left < MAX_EMAIL_LOCAL && isEmailLocalChar(text.charAt(left - 1))) left--;
    if (left === at) continue;
    let right = at + 1;
    while (right < text.length && right - at - 1 < MAX_EMAIL_DOMAIN && isEmailDomainChar(text.charAt(right))) right++;
    let domainEnd = right;
    while (domainEnd > at + 1 && (text.charAt(domainEnd - 1) === '.' || text.charAt(domainEnd - 1) === '-')) domainEnd--;
    const domain = text.slice(at + 1, domainEnd);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot < 1 || domain.length - lastDot - 1 < 2) continue; // needs "label.tld" with a tld of 2+ chars
    out.push([left, domainEnd]);
    from = domainEnd;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// UUIDs and timestamps
// ---------------------------------------------------------------------------------------------------------------

const UUID_RE = /(?<![0-9A-Za-z])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Za-z])/g;

/**
 * ISO-8601 date or date-time. Every repeat is a bounded run of digits and every optional group is fixed-shape, so the
 * pattern cannot backtrack beyond a constant number of steps per start position.
 *
 * Maximal munch (tricky): the token is first captured greedily inside a LOOKAHEAD and only then consumed with the
 * backreference `\1`. JavaScript lookaheads are atomic, so if the trailing `(?![0-9A-Za-z])` fails the engine cannot go back
 * and settle for a shorter prefix. Without this, "2025-01-15T10:30:00Zextra" would silently yield the lower-precision
 * (and wrong) timestamp "2025-01-15T10:30". Capture groups: 1 = whole token, 2..4 = Y-M-D, 5 = hour, 6 = minute,
 * 7 = second, 8 = fraction, 9 = zone.
 */
const TIMESTAMP_RE =
  /(?<![0-9A-Za-z])(?=((\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?)?))\1(?![0-9A-Za-z])/g;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Days since 1970-01-01 (proleptic Gregorian). Integer arithmetic only: no Date object, no time-zone or clock access. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

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

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

interface TimestampParts {
  year: number;
  month: number;
  day: number;
  hour: number | null;
  minute: number;
  second: number | null;
  fraction: string;
  zone: string | null;
}

/** Canonical form, or null when the match is not a real instant (month 13, Feb 30, hour 24, leap second, absurd offset). */
function canonicalTimestamp(p: TimestampParts): string | null {
  if (p.year < 1000 || p.month < 1 || p.month > 12 || p.day < 1 || p.day > daysInMonth(p.year, p.month)) return null;
  const datePart = `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
  if (p.hour === null) return datePart;
  if (p.hour > 23 || p.minute > 59 || (p.second !== null && p.second > 59)) return null;
  const second = p.second ?? 0;
  if (p.zone === null) {
    // No zone in the text: keep the local form as written (only the separator is canonicalised to "T").
    const secPart = p.second === null ? '' : `:${pad(second, 2)}${p.fraction === '' ? '' : `.${p.fraction}`}`;
    return `${datePart}T${pad(p.hour, 2)}:${pad(p.minute, 2)}${secPart}`;
  }
  let offsetMinutes = 0;
  if (p.zone !== 'Z' && p.zone !== 'z') {
    const sign = p.zone.startsWith('-') ? -1 : 1;
    const digits = p.zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (oh > 23 || om > 59) return null;
    offsetMinutes = sign * (oh * 60 + om);
  }
  const ms = Number((p.fraction + '000').slice(0, 3));
  const utcMs =
    daysFromCivil(p.year, p.month, p.day) * 86_400_000 + p.hour * 3_600_000 + p.minute * 60_000 + second * 1000 + ms - offsetMinutes * 60_000;
  const days = Math.floor(utcMs / 86_400_000);
  const rem = utcMs - days * 86_400_000;
  const c = civilFromDays(days);
  if (c.year < 1000 || c.year > 9999) return null;
  const hh = Math.floor(rem / 3_600_000);
  const mm = Math.floor((rem % 3_600_000) / 60_000);
  const ss = Math.floor((rem % 60_000) / 1000);
  const msOut = rem % 1000;
  return `${pad(c.year, 4)}-${pad(c.month, 2)}-${pad(c.day, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}${msOut === 0 ? '' : `.${pad(msOut, 3)}`}Z`;
}

// ---------------------------------------------------------------------------------------------------------------
// Code fences, tools, file names
// ---------------------------------------------------------------------------------------------------------------

const LANGUAGE_RE = /^[A-Za-z][A-Za-z0-9_+#.-]*$/;
const TOOL_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.:/-]*$/u;
/** Values that name a role or "nobody" rather than a tool. */
const NOT_A_TOOL: ReadonlySet<string> = new Set(['all', 'assistant', 'user', 'system', 'none', 'null', 'undefined']);

function validLanguage(raw: string): string | null {
  const word = raw.trim();
  if (word.length === 0 || word.length > MAX_LANGUAGE_CHARS || !LANGUAGE_RE.test(word)) return null;
  if (word.toLowerCase() === 'unknown') return null; // ChatGPT exports use "unknown" for "not stated"
  return word;
}

/** First word of the info string of every OPENING markdown fence (``` or ~~~, optionally indented by up to 3 spaces). */
function fenceLanguages(text: string): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    const lineEnd = Math.min(nl, pos + FENCE_LOOKAHEAD);
    let i = pos;
    while (i < lineEnd && i - pos < 3 && text.charCodeAt(i) === 32) i++;
    const fenceChar = text.charAt(i);
    if (fenceChar === '`' || fenceChar === '~') {
      let j = i;
      while (j < lineEnd && text.charAt(j) === fenceChar) j++;
      if (j - i >= 3) {
        const info = text.slice(j, lineEnd);
        // CommonMark: a backtick fence's info string cannot contain backticks (that would be inline code).
        if (!(fenceChar === '`' && info.includes('`'))) {
          const word = /^[ \t]*([^\s{]+)/.exec(info);
          const lang = word === null || word[1] === undefined ? null : validLanguage(word[1]);
          if (lang !== null) out.push(lang);
        }
      }
    }
    pos = nl + 1;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function blockLanguages(blocks: readonly ContentBlock[] | undefined): string[] {
  const out: string[] = [];
  if (!Array.isArray(blocks)) return out;
  const n = Math.min(blocks.length, MAX_BLOCKS_SCANNED);
  for (let i = 0; i < n; i++) {
    const b: unknown = blocks[i];
    if (!isRecord(b)) continue;
    const meta = b['metadata'];
    if (!isRecord(meta)) continue;
    const lang = meta['language'];
    if (typeof lang !== 'string') continue;
    const ok = validLanguage(normalizeNfkc(lang.slice(0, 64)));
    if (ok !== null) out.push(ok);
  }
  return out;
}

function toolName(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4 * MAX_TOOL_CHARS) return null;
  const v = normalizeNfkc(raw).trim();
  if (v.length === 0 || v.length > MAX_TOOL_CHARS || !TOOL_RE.test(v)) return null;
  if (NOT_A_TOOL.has(v.toLowerCase())) return null;
  return v;
}

/** Last path segment, control characters removed, length-capped. Directory components of an attachment name are never stored. */
function fileNameOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const cleaned = normalizeNfkc(raw.slice(0, 4 * MAX_FILE_NAME_CHARS)).replace(/[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu, '');
  const parts = cleaned.split(/[\\/]/);
  const base = (parts[parts.length - 1] ?? '').trim();
  if (base.length === 0 || base === '.' || base === '..') return null;
  return capText(base, MAX_FILE_NAME_CHARS); // surrogate-safe cut
}

// ---------------------------------------------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------------------------------------------

/**
 * Compact stop-word list: English plus the most frequent function words of es, fr, de, pt, it, nl and ru. Only words of
 * three or more letters are listed because shorter tokens are dropped anyway. Stored NFKC + lower-case.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    // English
    'about above after again against all also and any are aren because been before being below between both but can cannot could did does doing dont down during each ' +
    'few for from further get got had has have having her here hers herself him himself his how into its itself just let like more most myself nor not now off once only ' +
    'other our ours ourselves out over own same she should some such than that the their theirs them themselves then there these they this those through too under until ' +
    'very was were what when where which while who whom why will with would you your yours yourself yourselves ' +
    'also able actually already always another anyone anything around away back bit come comes did done else enough even ever every everything get gets give going gone ' +
    'good great hello help here however isnt itll ive know least less likely look made make many may maybe might much must need never new okay one please really right ' +
    'said say see seem seems should since something sometimes still sure take thank thanks thats theres thing things think though thus two use used using want wasnt way well ' +
    'went whether whose within without wont wouldnt yes yet youre ' +
    // Spanish
    'que los las del una por con para como más pero sus este esta está son ese esa entre cuando muy sin sobre también hasta hay donde quien desde todo nos durante todos uno ' +
    'les ' +
    // French
    'des une qui dans pour pas sur est avec ses mais aux par plus nous vous ils elle elles cette ces être avoir fait sont tout leur très aussi bien sans ' +
    // German
    'der die das und ist nicht ein eine einen mit von den dem des auf für sich auch als wie aber oder wenn wird sind noch nach bei aus nur über wir ihr sie ich mir mich ' +
    'dass kann hat haben war werden einer ' +
    // Portuguese
    'não uma mais mas dos das foi são tem seu sua ele ela isso você também quando muito já até sem ' +
    // Italian
    'che non per del della dei delle sono più anche gli nel nella alla questo questa essere hanno suo loro tra fra cui dove ' +
    // Dutch
    'het een van dat niet zijn voor met ook maar aan bij dan nog wel deze dit wat door naar uit ' +
    // Russian
    'это как что так для при или был она они его ещё уже только быть этого все еще мне меня тебя вас нас там тут где когда если чтобы который которые'
  )
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w.normalize('NFKC').toLowerCase()),
);

/** Particles and function words of Chinese, Japanese and Korean: bigrams containing one of them carry no topic. */
const CJK_FUNCTION_CHARS: ReadonlySet<string> = new Set(
  Array.from('的了是在和有不这那就都也与及或被把对为之个吗吧呢啊我你他她它们のはがをにでともかてしたんねよへや이가은는을를에의와과도로'),
);

const CJK_CLASS = String.raw`\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}`;
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['\u{2019}][\p{L}\p{M}\p{N}]+)*/gu;
const HAS_CJK = new RegExp(`[${CJK_CLASS}]`, 'u');
const CJK_SPLIT = new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, 'gu');
const LETTER = /^\p{L}$/u;
const POSSESSIVE = /['\u{2019}]s$/u;
const HEX_BLOB = /^[0-9a-f]+$/;

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function addWordToken(piece: string, counts: Map<string, number>): void {
  let word = piece;
  if (word.includes("'") || word.includes('\u{2019}')) {
    word = word.replace(POSSESSIVE, '').replace(/['\u{2019}]/gu, '');
  }
  if (word.length < 3 || word.length > MAX_KEYWORD_CHARS) return;
  let letters = 0;
  let digits = 0;
  for (const ch of word) {
    if (LETTER.test(ch)) letters++;
    else if (ch >= '0' && ch <= '9') digits++;
  }
  if (letters < 3 || digits > letters) return;
  if (word.length >= 12 && HEX_BLOB.test(word)) return; // hashes and ids are not topics
  if (STOP_WORDS.has(word)) return;
  bump(counts, word);
}

function addCjkBigrams(run: string, counts: Map<string, number>): void {
  const cps = Array.from(run);
  for (let i = 0; i + 1 < cps.length; i++) {
    const a = cps[i] as string;
    const b = cps[i + 1] as string;
    if (CJK_FUNCTION_CHARS.has(a) || CJK_FUNCTION_CHARS.has(b)) continue;
    bump(counts, a + b);
  }
}

/** Frequency table of keyword candidates of already NFKC-normalised text. Text is lower-cased here. */
function keywordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  WORD_RE.lastIndex = 0;
  const lower = text.toLowerCase();
  for (let m = WORD_RE.exec(lower); m !== null; m = WORD_RE.exec(lower)) {
    const token = m[0];
    if (!HAS_CJK.test(token)) {
      addWordToken(token, counts);
      continue;
    }
    CJK_SPLIT.lastIndex = 0;
    for (let p = CJK_SPLIT.exec(token); p !== null; p = CJK_SPLIT.exec(token)) {
      const piece = p[0];
      if (HAS_CJK.test(piece)) addCjkBigrams(piece, counts);
      else addWordToken(piece, counts);
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------------------------
// Accumulation and output
// ---------------------------------------------------------------------------------------------------------------

interface Slot {
  value: string;
  count: number;
}

class Bucket {
  private readonly map = new Map<string, Slot>();

  add(value: string, normalized: string, n = 1): void {
    const slot = this.map.get(normalized);
    if (slot === undefined) this.map.set(normalized, { value, count: n });
    else slot.count += n;
  }

  /** count desc, normalized asc (plain code-unit comparison: no locale dependence). */
  top(kind: EntityKind, limit: number): ExtractedEntity[] {
    if (limit <= 0 || this.map.size === 0) return [];
    const all = Array.from(this.map, ([normalized, s]) => ({ kind, value: s.value, normalized, count: s.count }));
    all.sort((a, b) => b.count - a.count || (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0));
    return all.length > limit ? all.slice(0, limit) : all;
  }
}

/**
 * Extract entities from one message. Pure and deterministic; throws INVALID_ARGUMENT only for malformed arguments
 * (never for odd text). See the file header for the privacy and complexity guarantees.
 */
export function extractEntities(input: ExtractInput, opts?: ExtractOptions): ExtractedEntity[] {
  const limits = resolveLimits(opts);
  if (typeof input !== 'object' || input === null || typeof input.text !== 'string') throw badArg('input.text', 'expected a string');

  // The cap is applied twice: before normalisation (so ICU never sees more than maxTextChars units) and again after it,
  // because NFKC can expand one unit into up to 18 (U+FDFA): without the second cut a capped text could still become
  // 18 times larger than the documented bound.
  const text = capText(normalizeNfkc(capText(input.text, limits.maxTextChars)), limits.maxTextChars);
  const buckets: Record<EntityKind, Bucket> = {
    url: new Bucket(),
    uuid: new Bucket(),
    timestamp: new Bucket(),
    tool: new Bucket(),
    code_language: new Bucket(),
    file_name: new Bucket(),
    keyword: new Bucket(),
  };

  // 1. URLs. Their secrets (userinfo, query, fragment) and any rejected URL-shaped run are blanked for every later pass.
  const urls = scanUrls(text);
  const secretRanges: Range[] = [...urls.rejected];
  for (const h of urls.hits) {
    buckets.url.add(h.value, h.normalized);
    secretRanges.push(...h.secretRanges);
  }
  const cleaned = blank(text, secretRanges);

  // 2. E-mail addresses are blanked (their local parts and domains must not become keywords).
  const noEmail = blank(cleaned, findEmailRanges(cleaned));

  // 3. UUIDs and timestamps (also remembered as ranges so keyword extraction can skip them).
  const keywordSkip: Range[] = urls.hits.map((h): Range => [h.start, h.end]);
  UUID_RE.lastIndex = 0;
  for (let m = UUID_RE.exec(noEmail); m !== null; m = UUID_RE.exec(noEmail)) {
    const id = m[0].toLowerCase();
    buckets.uuid.add(id, id);
    keywordSkip.push([m.index, m.index + m[0].length]);
  }
  TIMESTAMP_RE.lastIndex = 0;
  for (let m = TIMESTAMP_RE.exec(noEmail); m !== null; m = TIMESTAMP_RE.exec(noEmail)) {
    const canonical = canonicalTimestamp({
      year: Number(m[2]),
      month: Number(m[3]),
      day: Number(m[4]),
      hour: m[5] === undefined ? null : Number(m[5]),
      minute: m[6] === undefined ? 0 : Number(m[6]),
      second: m[7] === undefined ? null : Number(m[7]),
      fraction: m[8] === undefined ? '' : m[8],
      zone: m[9] === undefined ? null : m[9],
    });
    if (canonical === null) continue;
    buckets.timestamp.add(m[0], canonical);
    keywordSkip.push([m.index, m.index + m[0].length]);
  }

  // 4. Tools: the message recipient, and the author name of tool-role messages.
  const recipientTool = toolName(input.recipient);
  if (recipientTool !== null) buckets.tool.add(recipientTool, recipientTool.toLowerCase());
  if (input.authorRole === 'tool') {
    const nameTool = toolName(input.authorName);
    if (nameTool !== null) buckets.tool.add(nameTool, nameTool.toLowerCase());
  }

  // 5. Code languages: structured blocks first, then markdown fences in the text.
  for (const lang of blockLanguages(input.blocks)) buckets.code_language.add(lang, lang.toLowerCase());
  for (const lang of fenceLanguages(text)) buckets.code_language.add(lang, lang.toLowerCase());

  // 6. Attachment file names (metadata only).
  if (Array.isArray(input.attachments)) {
    const n = Math.min(input.attachments.length, MAX_ATTACHMENTS_SCANNED);
    for (let i = 0; i < n; i++) {
      const a: unknown = input.attachments[i];
      if (!isRecord(a)) continue;
      const name = fileNameOf(a['name']);
      if (name !== null) buckets.file_name.add(name, name.toLowerCase());
    }
  }

  // 7. Keywords from what is left: URLs, e-mails, UUIDs and timestamps are blanked.
  const keywordLimit = Math.min(limits.maxKeywords, limits.maxPerKind);
  if (keywordLimit > 0) {
    const counts = keywordCounts(blank(noEmail, keywordSkip));
    for (const [word, n] of counts) buckets.keyword.add(word, word, n);
  }

  const out: ExtractedEntity[] = [];
  for (const kind of ENTITY_KINDS) {
    out.push(...buckets[kind].top(kind, kind === 'keyword' ? keywordLimit : limits.maxPerKind));
  }
  return out;
}
