/**
 * Privacy scanner: a dev-only gate that keeps private conversation data, databases and credentials out of Git
 * (SPEC FR-08 data minimization, NFR-01 no credentials in Git; CODEX_TASK Phase 3 "privacy-focused git scan").
 *
 * This is NOT product code. It is the only place in the repository that spawns a child process (git, via
 * `execFile` with an argument array, never a shell string) and it must never be imported by the SDK, CLI or MCP
 * server. It performs no network access of any kind (git runs with every transport and lazy fetching disabled, so a
 * partial clone fails closed instead of being completed from its remote) and it never writes to the scanned repository.
 *
 * What it checks
 *  - PATH rules: databases (and their WAL/SHM/journal sidecars), archives, key material, HAR files, logs, env files,
 *    cookie jars, raw export files and "export"/"private"/".gcr" directories, at any depth, case-insensitively, also
 *    when the name carries a backup suffix (`.bak`, `~`, ...).
 *  - SIGNATURE rule: the first bytes of every file (even one too large to read) identify a SQLite database or an
 *    archive that was renamed; ZIP-based document/package formats are told apart by extension.
 *  - CONTENT rules: PEM private keys, API keys/tokens, JWTs, Authorization/Cookie headers, ChatGPT session cookie
 *    names and cookie-jar entries, real conversation URLs, asset pointers and long high-entropy blobs. Lines that
 *    contain escaped quotes or slashes are also judged unescaped. Every pattern is linear-time (no nested or
 *    overlapping quantifiers; unbounded runs are anchored by a lookbehind so each run is scanned once). UTF-16 text
 *    with a byte-order mark is decoded; any other file with NUL bytes is binary and gets the path/signature rules only.
 *  - FIXTURE rules: raw-export-shaped files may only live under the root `fixtures/` directory, must carry the
 *    literal marker below, and must stay small. A data file (json/jsonl/ndjson/txt/dat or extension-less) that has the
 *    SHAPE of a ChatGPT or Claude export needs the marker wherever it is, whatever it is called.
 *
 * Secrets are never reproduced: a finding's `detail` shows at most the first 4 characters of a match (fewer for
 * short matches) plus its length, and line CONTENT is never copied into any output. At most `MAX_FINDINGS_PER_FILE`
 * content findings are listed per file (and per file section of a patch); a `too-many-findings` entry says so.
 *
 * Exceptions: an optional `.privacy-scan-allow` file at the repository root lists exact repo-relative paths, one
 * per line (`#` starts a comment line, no globs). An allow-listed path is exempt from every rule, so the file is
 * the single, reviewable place where exceptions live.
 *
 * Bounds: files are read up to `maxFileBytes`; the staged-diff and history passes read git's own patch text (with
 * `--text`, so .gitattributes cannot hide a file) and are bounded by `maxHistoryBytes` instead, so an oversized staged
 * file still has its added lines scanned (up to the cap).
 *
 * Known limits (reported, not hidden): the allow-file is read from the working tree only and an allow-listed path is
 * exempt in history too; unreachable objects, the reflog, stashes, commit messages and content that exists only inside
 * a merge-commit resolution are not scanned; committed content that differs from an unstaged work-tree edit is only
 * seen by `--history`; history scanning is capped (see `maxHistoryBytes`) and reports when it truncated, and it cannot
 * recognise a renamed database by signature (only the work-tree copy of a file is sniffed); credentials without
 * a distinctive shape (passwords, AWS secret keys, Basic-auth strings, base64 wrapped over several short lines) are not
 * found.
 */
import { execFile } from 'node:child_process';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { GcrError } from '../errors.js';

// ---- public types and constants -------------------------------------------------------------------------------

export type Finding = { rule: string; path: string; line?: number; detail: string };

export interface ScanOptions {
  /** Exact repo-relative paths that are exempt from every rule (normally loaded from `.privacy-scan-allow`). */
  allow?: Iterable<string>;
}

export interface RepoScanOptions {
  /** Also scan every path ever added and every added line in all refs. Default false. */
  history?: boolean;
  /** Files larger than this are not read (counted in `skippedLarge`). Default 2 MiB. */
  maxFileBytes?: number;
  /** Total stdout bytes read from each git history/staging query set before truncating. Default 64 MiB. */
  maxHistoryBytes?: number;
}

export interface HistoryStats {
  byteCap: number;
  bytesRead: number;
  /** True when the cap cut the history output short: older history was NOT fully scanned. */
  truncated: boolean;
  commitsSeen: number;
  addedPathsChecked: number;
}

export interface RepoScanResult {
  findings: Finding[];
  /** Files whose text content was scanned by the content rules. */
  scannedFiles: number;
  /** Files above `maxFileBytes`: path rules applied, content NOT read. */
  skippedLarge: number;
  /** Files containing NUL bytes: path rules applied, content NOT scanned. */
  skippedBinary: number;
  /** Listed entries that are not readable regular files (symlinks, submodules/nested repos, deleted-but-indexed). */
  skippedNonRegular: number;
  /** Everything git listed (tracked + untracked-not-ignored), before the allow-list. */
  listedFiles: number;
  /** Listed files exempted by `.privacy-scan-allow`. */
  allowListedFiles: number;
  /** null unless `history: true`. */
  history: HistoryStats | null;
  /** Human-readable coverage caveats (truncation etc.); deterministic text. */
  notes: string[];
}

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_HISTORY_BYTES = 64 * 1024 * 1024;
export const FIXTURE_MAX_BYTES = 1024 * 1024;
/** Literal that every raw-export-shaped file under fixtures/ must contain to prove it is synthetic. */
export const SYNTHETIC_MARKER = 'GCR-SYNTHETIC-FIXTURE';
export const ALLOW_FILE_NAME = '.privacy-scan-allow';
/** Findings listed per file (per scanned unit) before the rest are summarised by one `too-many-findings` entry. */
export const MAX_FINDINGS_PER_FILE = 1000;

const MAX_ALLOW_FILE_BYTES = 256 * 1024;
const FILE_READ_CONCURRENCY = 8;
/** The identifier given in SPEC section 1; the only real-looking conversation id allowed in the repository. */
const REFERENCE_CONVERSATION_ID = '6ac95b6e-9fa0-83e8-bbb0-8107079a8720';
// The nil UUID is a documented sentinel (no version/variant bits, so no real conversation can carry it); tests use it
// to exercise id validation, and it identifies nothing.
const SYNTHETIC_FILE_ID = /^file[-_]0{16}/i;
// Synthetic conversation-id forms (all-zero first group is the repo convention). The second form lets the FIRST group be anything
// as long as the other four groups are the fixed synthetic tail with ten leading zeros: a real random UUIDv4 would have to draw
// group2 = 0000, group3 = 4000, group4 = 8000 and 40 zero bits in group5 (about 2^-82), so this cannot hide a genuine conversation.
const SYNTHETIC_ID = /^(?:00000000-0000-4000-8000-[0-9a-f]{12}|[0-9a-f]{8}-0000-4000-8000-0000000000[0-9a-f]{2}|00000000-0000-0000-0000-000000000000)$/;

// ---- helpers: masking, sorting ----------------------------------------------------------------------------------

function printable(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?');
}

/**
 * Reduce a secret to a safe description. Shows at most 4 leading characters and never more than 1/8 of the
 * value, so a short secret reveals nothing beyond its length; the full value is never retained in a Finding.
 */
export function maskSecret(value: string): string {
  const shown = Math.min(4, Math.floor(value.length / 8));
  return `${printable(value.slice(0, shown))}*** (len ${value.length})`;
}

function cmp(a: string, b: string): number {
  // Code-unit order, not localeCompare: output must not depend on the host's locale/ICU data.
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFindings(a: Finding, b: Finding): number {
  return cmp(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.rule, b.rule) || cmp(a.detail, b.detail);
}

function findingKey(f: Finding): string {
  return `${f.rule}\u0000${f.path}\u0000${f.line ?? ''}\u0000${f.detail}`;
}

function finalize(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.sort(compareFindings);
}

function toAllowSet(allow: Iterable<string> | undefined): ReadonlySet<string> {
  return new Set(allow ?? []);
}

// ---- path classification ---------------------------------------------------------------------------------------

/**
 * Segments used for classification only. Backslashes count as separators so a Windows-style path cannot dodge
 * a directory rule; `.`/`..` are folded so `fixtures/../user.json` is judged as the root file it really is.
 */
function pathSegments(path: string): string[] {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  return normalized.split('/').filter((s) => s.length > 0 && s !== '.');
}

interface PathContext {
  segments: string[];
  base: string; // lower-cased basename
  underFixtures: boolean;
  underDocs: boolean;
}

function pathContext(path: string): PathContext {
  const segments = pathSegments(path);
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  // Case-sensitive on purpose: only the repository's own `fixtures/` directory earns the exemption.
  return { segments, base, underFixtures: segments.length > 1 && segments[0] === 'fixtures', underDocs: segments.length > 1 && segments[0] === 'docs' };
}

const FORBIDDEN_EXTENSIONS: readonly string[] = [
  '.sqlite', '.sqlite3', '.db', '.db-wal', '.db-shm',
  // WAL/SHM sidecars of .sqlite files hold the same private rows; .gitignore already lists them. Rollback journals and
  // the sidecars of .sqlite3 databases are the same data under names the list above does not end with.
  '.sqlite-wal', '.sqlite-shm', '.sqlite3-wal', '.sqlite3-shm', '.db-journal', '.sqlite-journal', '.sqlite3-journal',
  '.zip', '.tar', '.tgz', '.gz', '.7z', '.rar', '.har',
  // Other compressors people archive an export with.
  '.xz', '.bz2', '.zst', '.tbz', '.tbz2', '.txz',
  '.pem', '.key', '.p12', '.pfx', '.jks', '.kdbx',
  // SPEC FR-08 lists logs next to exports, databases and secrets (and .gitignore ignores them).
  '.log',
];

const FORBIDDEN_BASENAMES: ReadonlySet<string> = new Set([
  'cookies.json', 'cookie.json', 'session.json', 'storage_state.json', 'auth.json',
  // Netscape-format cookie jars (curl, yt-dlp, browser extensions).
  'cookies.txt', 'cookie.txt',
  // Files that make up an official ChatGPT export besides conversations*.json.
  'user.json', 'user_settings.json', 'message_feedback.json', 'shared_conversations.json', 'model_comparisons.json',
  'group_chats.json', 'conversation_asset_file_names.json', 'library_files.json', 'export_manifest.json', 'chat.html',
]);

const EXPORT_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['export', 'exports', 'private']);
/** The local GCR data directory (databases, drafts, annotations); `.gitignore` keeps it out of Git. */
const PRIVATE_DATA_DIRECTORY = '.gcr';
// `conversations.json`, the numbered parts of newer exports, and the names a browser or file manager gives a second copy.
const CONVERSATIONS_FILE = /^conversations(?:-[0-9]+|_[0-9]+| \([0-9]+\))?\.json$/;
const BACKUP_SUFFIXES: readonly string[] = ['.bak', '.old', '.orig', '.backup', '.copy', '.save', '.tmp'];

/** `chats.sqlite.bak` -> `chats.sqlite`, `user.json~` -> `user.json`: a backup copy holds exactly the same data. */
function foldBackupSuffix(base: string): string {
  if (base.length > 1 && base.endsWith('~')) return base.slice(0, -1);
  for (const suffix of BACKUP_SUFFIXES) if (base.length > suffix.length && base.endsWith(suffix)) return base.slice(0, -suffix.length);
  return base;
}

function isConversationExportName(base: string): boolean {
  return CONVERSATIONS_FILE.test(foldBackupSuffix(base));
}

/** Raw-export-shaped file in the one place such names are tolerated: it must then prove it is synthetic. */
function requiresSyntheticMarker(ctx: PathContext): boolean {
  return ctx.underFixtures && isConversationExportName(ctx.base);
}

function pathRuleFindings(path: string): Finding[] {
  const ctx = pathContext(path);
  const { base } = ctx;
  const core = foldBackupSuffix(base); // rules below also judge the name with one backup/copy suffix removed
  const out: Finding[] = [];

  const ext = FORBIDDEN_EXTENSIONS.find((e) => core.endsWith(e));
  if (ext !== undefined) {
    out.push({ rule: 'forbidden-extension', path, detail: `files with extension ${ext} (database, archive, capture or key material) must not be committed` });
  }

  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
    out.push({ rule: 'forbidden-filename', path, detail: 'environment files must not be committed (only .env.example is allowed)' });
  } else if (FORBIDDEN_BASENAMES.has(core)) {
    out.push({ rule: 'forbidden-filename', path, detail: `${core} is a credential, session or raw-export file name` });
  }

  if (isConversationExportName(base) && !ctx.underFixtures) {
    out.push({ rule: 'export-file-outside-fixtures', path, detail: 'conversation export files are only allowed under fixtures/ and only when synthetic' });
  }

  const directories = ctx.segments.slice(0, -1).map((s) => s.toLowerCase());
  if (directories.some((s) => EXPORT_DIRECTORY_NAMES.has(s)) && (core.endsWith('.json') || core.endsWith('.zip'))) {
    out.push({ rule: 'export-directory', path, detail: 'json/zip files inside an export/exports/private directory are presumed to be raw exports' });
  }
  if (directories.includes(PRIVATE_DATA_DIRECTORY)) {
    out.push({ rule: 'private-data-directory', path, detail: 'files inside the local GCR data directory (.gcr/) hold private conversation data and must not be committed' });
  }
  return out;
}

function fixtureSizeFinding(path: string, byteLength: number): Finding | null {
  if (byteLength > FIXTURE_MAX_BYTES && pathContext(path).underFixtures) {
    return { rule: 'fixture-too-large', path, detail: `fixture is ${byteLength} bytes; fixtures larger than ${FIXTURE_MAX_BYTES} bytes are presumed to be real data` };
  }
  return null;
}

function markerMissingFinding(path: string, why: string): Finding {
  return { rule: 'synthetic-marker-missing', path, detail: why };
}

export function scanPaths(paths: readonly string[], opts: ScanOptions = {}): Finding[] {
  const allow = toAllowSet(opts.allow);
  const out: Finding[] = [];
  for (const p of paths) {
    if (allow.has(p)) continue;
    out.push(...pathRuleFindings(p));
  }
  return finalize(out);
}

// ---- content rules -----------------------------------------------------------------------------------------------

interface ContentRule {
  readonly id: string;
  /** Global, linear-time pattern. Reused across lines (lastIndex is reset by exec), so scanning is synchronous only. */
  readonly pattern: RegExp;
  readonly exempt?: (ctx: PathContext) => boolean;
  /** Returns the masked description, or null to reject this candidate. */
  readonly detail: (m: RegExpExecArray) => string | null;
  /** Skip candidates overlapping an earlier rule's match on the same line (avoids double-reporting one secret). */
  readonly yieldsToOthers?: boolean;
}

/** Shannon entropy in bits per character of an ASCII string. */
function entropyBits(s: string): number {
  const counts = new Uint32Array(128);
  for (let i = 0; i < s.length; i++) counts[s.charCodeAt(i) & 127] = (counts[s.charCodeAt(i) & 127] ?? 0) + 1;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Entropy floors for runs of >= 80 characters. Random hex over 80 symbols measures about 3.86 bits/char and random
 * base64 about 5.4, each with a spread near 0.1, so 3.0 and 4.5 separate them from repeated patterns, ASCII-art
 * rules and identifier/path text (about 4.0) with a wide margin.
 */
const HEX_MIN_BITS = 3.0;
const BASE64_MIN_BITS = 4.5;

function blobDetail(run: string): string | null {
  if (/^[0-9a-fA-F]+$/.test(run)) return null; // pure hex is judged by the dedicated hex rule
  let lower = 0;
  let upper = 0;
  let digit = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    if (c >= 97 && c <= 122) lower++;
    else if (c >= 65 && c <= 90) upper++;
    else if (c >= 48 && c <= 57) digit++;
  }
  // Random base64 is about 41% lower, 41% upper and 16% digits; URLs, paths, kebab-case slugs and identifiers are
  // overwhelmingly lower-case (or CamelCase) with almost no digits. The floors sit about 4 sigma below the random
  // mean for an 80-character run (and further away for longer ones), so real blobs are not missed.
  const n = run.length;
  if (lower < n * 0.15 || upper < n * 0.15 || digit < n * 0.03) return null;
  if (entropyBits(run) < BASE64_MIN_BITS) return null;
  return `high-entropy base64-like string ${maskSecret(run)}`;
}

// Fragments keep the names of ChatGPT session cookies out of this file's own text, so the scanner passes itself.
const SESSION_COOKIE = new RegExp(String.raw`(?<![A-Za-z0-9_-])(?:__Secure-)?next-` + 'auth' + String.raw`\.session-` + 'token', 'gi');
const CLEARANCE_COOKIE = new RegExp(String.raw`(?<![A-Za-z0-9_])cf_` + 'clearance=' + String.raw`([^\s;"'` + '`' + String.raw`]*)`, 'g');
const DEVICE_ID = new RegExp(String.raw`(?<![A-Za-z0-9_-])oai-(?:device-` + 'id|d' + 'id)' + String.raw`["']?[ \t]*[=:][ \t]*["'` + '`' + String.raw`]?([A-Za-z0-9-]{8,})`, 'gi');
const PUID_COOKIE = new RegExp(String.raw`(?<![A-Za-z0-9_])_pu` + 'id=' + String.raw`([^\s;"'` + '`' + String.raw`]*)`, 'g');

// Cookie JARS (as opposed to header lines): a browser-automation storage state or extension export names the cookie in
// a `"name": "<cookie>"` field with the value on another line, a Netscape cookies.txt separates name and value with a
// TAB, and a Python/JS dict quotes both. The names are assembled from fragments for the same reason as above.
const JAR_COOKIE_NAMES = ['cf_' + 'clearance', '_pu' + 'id', 'oai-' + 'did', 'oai-device-' + 'id'].join('|');
// The device-id rule above already reads `"<name>": "<value>"` pairs, so the quoted-pair form only adds the other two.
const JAR_PAIR_NAMES = ['cf_' + 'clearance', '_pu' + 'id'].join('|');
const JAR_NAME_FIELD = new RegExp(String.raw`["']name["']\s*:\s*["'](${JAR_COOKIE_NAMES})["']`, 'gi');
const JAR_NETSCAPE_LINE = new RegExp(String.raw`(?<![A-Za-z0-9_-])(${JAR_COOKIE_NAMES})\t(\S{8,})`, 'g');
const JAR_QUOTED_PAIR = new RegExp(String.raw`["'](${JAR_PAIR_NAMES})["']\s*:\s*["']([^\s"']{8,})`, 'gi');

const CONTENT_RULES: readonly ContentRule[] = [
  {
    id: 'pem-private-key',
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
    detail: () => 'PEM private key block',
  },
  {
    id: 'openai-api-key',
    // Lookbehind keeps "task-...", "disk-..." and kebab-case words from matching, and limits starts to one per run.
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    detail: (m) => `OpenAI-style API key ${maskSecret(m[0])}`,
  },
  {
    id: 'github-token',
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
    detail: (m) => `GitHub token ${maskSecret(m[0])}`,
  },
  {
    id: 'aws-access-key-id',
    pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
    detail: (m) => `AWS access key id ${maskSecret(m[0])}`,
  },
  {
    id: 'slack-token',
    pattern: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g,
    detail: (m) => `Slack token ${maskSecret(m[0])}`,
  },
  {
    id: 'jwt',
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    detail: (m) => `JSON Web Token ${maskSecret(m[0])}`,
  },
  {
    id: 'bearer-token',
    // [ \t] instead of \s: a header never spans lines, and a single \s* pair around an optional quote would make
    // long whitespace runs quadratic.
    pattern: /(?<![A-Za-z0-9_-])authorization["']?[ \t]*[:=][ \t]*["'`]?bearer[ \t]+([A-Za-z0-9._~+/=_-]{20,})/gi,
    detail: (m) => `Authorization Bearer token ${maskSecret(m[1] ?? '')}`,
  },
  {
    id: 'cookie-header',
    // The value may be wrapped in quotes (RFC 6265 allows a DQUOTE-wrapped cookie-value).
    pattern: /(?<![A-Za-z0-9_-])(?:set-)?cookie["']?[ \t]*:[ \t]*["'`]?[A-Za-z0-9_.%-]{1,128}=["']?([^\s;"'`]{1,4096})/gi,
    detail: (m) => {
      const value = m[1] ?? '';
      // A template/placeholder value ("${token}", "<value>", "{{ value }}") is code or documentation that builds a
      // header, not a captured credential; real cookie values do not start with these characters.
      if (/^[$<{]/.test(value)) return null;
      return `Cookie header value ${maskSecret(value)}`;
    },
  },
  { id: 'session-cookie-name', pattern: SESSION_COOKIE, detail: () => 'ChatGPT web session cookie name' },
  {
    id: 'cloudflare-clearance-cookie',
    pattern: CLEARANCE_COOKIE,
    detail: (m) => `Cloudflare clearance cookie assignment, value ${maskSecret(m[1] ?? '')}`,
  },
  { id: 'device-id', pattern: DEVICE_ID, detail: (m) => `OpenAI device id value ${maskSecret(m[1] ?? '')}` },
  { id: 'user-id-cookie', pattern: PUID_COOKIE, detail: (m) => `ChatGPT user-id cookie assignment, value ${maskSecret(m[1] ?? '')}` },
  { id: 'cookie-jar-entry', pattern: JAR_NAME_FIELD, detail: (m) => `cookie jar entry for ${m[1] ?? 'a ChatGPT session cookie'}` },
  { id: 'cookie-jar-entry', pattern: JAR_NETSCAPE_LINE, detail: (m) => `cookie jar entry for ${m[1] ?? ''}, value ${maskSecret(m[2] ?? '')}` },
  { id: 'cookie-jar-entry', pattern: JAR_QUOTED_PAIR, detail: (m) => `cookie jar entry for ${m[1] ?? ''}, value ${maskSecret(m[2] ?? '')}` },
  {
    id: 'chatgpt-conversation-url',
    // The scheme is optional: a link pasted without it identifies the same private conversation. The lookbehind keeps
    // look-alike hosts ("notchatgpt.com", "sub.chatgpt.com", "user@chatgpt.com") out and limits starts to one per host.
    pattern: /(?<![A-Za-z0-9.@-])(?:https?:\/\/)?(?:www\.)?(chatgpt\.com|chat\.openai\.com)(?:\/g\/[A-Za-z0-9_-]{1,100})?\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gi,
    detail: (m) => {
      const id = (m[2] ?? '').toLowerCase();
      if (id === REFERENCE_CONVERSATION_ID || SYNTHETIC_ID.test(id)) return null;
      return `${(m[1] ?? '').toLowerCase()} conversation URL with a non-synthetic id ${maskSecret(id)}`;
    },
  },
  {
    id: 'asset-pointer',
    // Real pointers carry a long random id ("file-" or "file_" plus 20+ characters), so requiring 16+ id characters
    // flags them while leaving documentation placeholders such as a three-letter file id alone, and code that merely
    // names or strips the scheme. A truncated pointer shorter than that no longer identifies a file anyway.
    pattern: /(?<![A-Za-z0-9_-])(file-service|sediment):\/\/([A-Za-z0-9][A-Za-z0-9_-]{15,200})/g,
    exempt: (ctx) => ctx.underFixtures || ctx.underDocs,
    detail: (m) => {
      const id = m[2] ?? '';
      // Synthetic form (mirrors the all-zero conversation-id form): 16+ leading zeros after "file-"/"file_". Real ids
      // are random after at most an 8-digit zero prefix, so this cannot hide a genuine pointer.
      if (SYNTHETIC_FILE_ID.test(id)) return null;
      return `${m[1] ?? 'asset'} asset pointer ${maskSecret(id)}`;
    },
  },
  {
    id: 'high-entropy-blob',
    // Pure hex run (separators such as "_" or "-" before it do not hide it).
    pattern: /(?<![A-Za-z0-9])[0-9a-fA-F]{80,}(?![A-Za-z0-9])/g,
    exempt: (ctx) => ctx.underFixtures || ctx.base === 'package-lock.json',
    detail: (m) => (entropyBits(m[0]) >= HEX_MIN_BITS ? `high-entropy hex string ${maskSecret(m[0])}` : null),
    yieldsToOthers: true,
  },
  {
    id: 'high-entropy-blob',
    pattern: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{80,}/g,
    exempt: (ctx) => ctx.underFixtures || ctx.base === 'package-lock.json',
    detail: (m) => blobDetail(m[0]),
    yieldsToOthers: true,
  },
];

/** Exposed for the test-suite's ReDoS audit and for documentation: rule ids in evaluation order, de-duplicated. */
export const CONTENT_RULE_IDS: readonly string[] = [...new Set(CONTENT_RULES.map((r) => r.id))];
export const CONTENT_RULE_SOURCES: ReadonlyArray<{ id: string; source: string }> = CONTENT_RULES.map((r) => ({ id: r.id, source: r.pattern.source }));

interface RuleHit {
  rule: string;
  detail: string;
}

function activeRules(ctx: PathContext): readonly ContentRule[] {
  return CONTENT_RULES.filter((r) => !(r.exempt?.(ctx) ?? false));
}

/** True when any character of [start, end) was already claimed by an earlier match on the line. */
function overlapsClaimed(claimed: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (claimed[i] === 1) return true;
  return false;
}

/** Apply the already path-filtered rules to ONE line as written. Never retains or returns the line text. */
function scanLine(rules: readonly ContentRule[], line: string): RuleHit[] {
  if (line.length < 6) return []; // shortest meaningful token is the 6-char cookie assignment
  const hits: RuleHit[] = [];
  // One byte per character instead of a list of spans: a candidate is compared with the claimed characters it covers
  // (cost proportional to its own length), not with every earlier match on the line (quadratic on a minified file).
  let claimed: Uint8Array | undefined;
  for (const rule of rules) {
    const re = rule.pattern;
    re.lastIndex = 0;
    for (let m = re.exec(line); m !== null; m = re.exec(line)) {
      if (m[0].length === 0) re.lastIndex++; // defensive: no rule can match empty, but never loop forever
      const start = m.index;
      const end = start + m[0].length;
      if (rule.yieldsToOthers === true && claimed !== undefined && overlapsClaimed(claimed, start, end)) continue;
      const detail = rule.detail(m);
      if (detail === null) continue;
      hits.push({ rule: rule.id, detail });
      claimed ??= new Uint8Array(line.length);
      claimed.fill(1, start, end);
    }
  }
  return hits;
}

// Backslash-escaped delimiters: `\"` (JSON inside JSON, header text inside a string literal), `\\\"` (twice escaped)
// and `\/` (PHP-style JSON). The lookbehind starts the match at the FIRST backslash of a run so the scan stays linear.
const ESCAPED_DELIMITER = /(?<!\\)\\+(["'/])/g;

/**
 * Apply the rules to one line and, when the line contains escaped quotes or slashes, to its unescaped form as well, so
 * `{\"Authorization\": \"Bearer ...\"}` is judged like the header it encodes. Duplicates are dropped.
 */
function lineHits(rules: readonly ContentRule[], line: string): RuleHit[] {
  const hits = scanLine(rules, line);
  if (!line.includes('\\')) return hits;
  const plain = line.replace(ESCAPED_DELIMITER, '$1');
  if (plain === line) return hits;
  const seen = new Set(hits.map((h) => `${h.rule}\u0000${h.detail}`));
  for (const h of scanLine(rules, plain)) {
    const k = `${h.rule}\u0000${h.detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    hits.push(h);
  }
  return hits;
}

const TOO_MANY_FINDINGS_DETAIL = `more than ${MAX_FINDINGS_PER_FILE} findings in this file; further findings in this file were not listed`;

// ---- export-shaped data -------------------------------------------------------------------------------------------------

const DATA_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.jsonl', '.ndjson', '.txt', '.dat', '.data']);

/** Data-like file names: JSON/text/data files and extension-less files, optionally with a backup suffix. */
function isDataLikeName(base: string): boolean {
  const core = foldBackupSuffix(base);
  const dot = core.lastIndexOf('.');
  return dot <= 0 || DATA_EXTENSIONS.has(core.slice(dot));
}

/**
 * Official ChatGPT exports carry `mapping` + `current_node`/`create_time`; Claude exports carry `chat_messages` +
 * `uuid`/`sender`. A data file with that shape is a conversation export whatever it is called, so it must prove it is
 * synthetic. Source code and documents only MENTION these keys, which is why only data-like names are judged.
 */
function looksLikeConversationExport(ctx: PathContext, content: string): boolean {
  if (!isDataLikeName(ctx.base)) return false;
  const has = (key: string): boolean => content.includes(`"${key}"`);
  return (has('mapping') && (has('current_node') || has('create_time'))) || (has('chat_messages') && (has('uuid') || has('sender')));
}

function textFindings(path: string, content: string, byteLength: number): Finding[] {
  const ctx = pathContext(path);
  const out: Finding[] = [];
  const sizeFinding = fixtureSizeFinding(path, byteLength);
  if (sizeFinding !== null) out.push(sizeFinding);
  if (!content.includes(SYNTHETIC_MARKER)) {
    if (requiresSyntheticMarker(ctx)) {
      out.push(markerMissingFinding(path, 'raw-export-shaped fixture does not contain the synthetic-fixture marker'));
    } else if (looksLikeConversationExport(ctx, content)) {
      out.push(markerMissingFinding(path, 'file has the shape of a raw conversation export but does not contain the synthetic-fixture marker'));
    }
  }
  const rules = activeRules(ctx);
  let pos = 0;
  let lineNo = 0;
  let listed = 0;
  scan: while (pos <= content.length) {
    let nl = content.indexOf('\n', pos);
    if (nl === -1) nl = content.length;
    lineNo++;
    for (const hit of lineHits(rules, content.slice(pos, nl))) {
      if (listed === MAX_FINDINGS_PER_FILE) {
        // Bounded output and memory: a file can match hundreds of thousands of times; one summary replaces the rest.
        out.push({ rule: 'too-many-findings', path, detail: TOO_MANY_FINDINGS_DETAIL });
        break scan;
      }
      out.push({ rule: hit.rule, path, line: lineNo, detail: hit.detail });
      listed++;
    }
    pos = nl + 1;
  }
  return out;
}

export function scanContent(path: string, content: string, opts: ScanOptions = {}): Finding[] {
  if (toAllowSet(opts.allow).has(path)) return [];
  return finalize(textFindings(path, content, Buffer.byteLength(content, 'utf8')));
}

// ---- allow-file ------------------------------------------------------------------------------------------------

function allowEntryProblem(entry: string): string | null {
  if (/[*?]/.test(entry)) return 'glob characters are not supported; list exact repo-relative file paths';
  if (/[\u0000-\u001f\u007f]/.test(entry)) return 'control characters are not allowed in a path';
  if (entry.includes('\\')) return 'use forward slashes';
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) return 'path must be repo-relative';
  if (entry.endsWith('/')) return 'directories are not supported; list files';
  if (entry.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'path must be normalized (no empty, "." or ".." segments)';
  if (entry.includes(' #')) return 'inline comments are not supported; put the comment on its own line';
  return null;
}

/** Parse `.privacy-scan-allow`. Invalid lines never widen the allow-list; they become findings instead. */
export function parseAllowFile(text: string): { entries: Set<string>; findings: Finding[] } {
  const entries = new Set<string>();
  const findings: Finding[] = [];
  text.split('\n').forEach((raw, i) => {
    const entry = raw.replace(/\r$/, '').trim();
    if (entry === '' || entry.startsWith('#')) return;
    const problem = allowEntryProblem(entry);
    if (problem !== null) {
      findings.push({ rule: 'allow-file-invalid', path: ALLOW_FILE_NAME, line: i + 1, detail: `entry ignored: ${problem}` });
      return;
    }
    entries.add(entry);
  });
  return { entries, findings };
}

async function loadAllowFile(root: string): Promise<{ entries: Set<string>; findings: Finding[] }> {
  const file = join(root, ALLOW_FILE_NAME);
  let text: string;
  try {
    const st = await lstat(file);
    if (!st.isFile()) throw new GcrError('INVALID_ARGUMENT', `${ALLOW_FILE_NAME} must be a regular file`);
    if (st.size > MAX_ALLOW_FILE_BYTES) throw new GcrError('INVALID_ARGUMENT', `${ALLOW_FILE_NAME} is larger than ${MAX_ALLOW_FILE_BYTES} bytes`);
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return { entries: new Set(), findings: [] };
    throw e;
  }
  return parseAllowFile(text);
}

// ---- git plumbing ------------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function errorCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Environment for git children. Repository-location variables are dropped so an enclosing hook or test runner
 * (which may export GIT_DIR / GIT_INDEX_FILE) can never redirect the scan at a different repository.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/.test(k)) continue;
    env[k] = v;
  }
  env['GIT_TERMINAL_PROMPT'] = '0';
  // A partial clone (--filter=blob:none) would otherwise fetch missing blobs from its remote while `git log -p` or
  // `git diff` runs: network access, and objects written into the repository being scanned. Fail instead (see runGit).
  env['GIT_NO_LAZY_FETCH'] = '1';
  return env;
}

/** Run git with an argument array (never a shell). Output beyond `maxBytes` is cut and reported, not an error. */
async function runGit(root: string, args: readonly string[], maxBytes: number): Promise<{ stdout: Buffer; truncated: boolean }> {
  // core.fsmonitor from the repository's own config is EXECUTED by ls-files/diff/status; forcing it off means scanning
  // an untrusted clone cannot run code. --no-optional-locks keeps the scan from writing to the index.
  // protocol.allow=never blocks every transport, so even a git that predates GIT_NO_LAZY_FETCH cannot reach a remote.
  const full = ['--no-optional-locks', '-C', root, '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args];
  try {
    const { stdout } = await execFileAsync('git', full, { encoding: 'buffer', maxBuffer: Math.max(1, maxBytes), env: gitEnv(), windowsHide: true });
    return { stdout, truncated: false };
  } catch (e) {
    if (errorCode(e) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const partial = (e as { stdout?: unknown }).stdout;
      return { stdout: Buffer.isBuffer(partial) ? partial : Buffer.alloc(0), truncated: true };
    }
    // Deliberately not forwarding git's stderr: it can contain absolute paths. Only its classification is used.
    const stderr = (e as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr) && /promisor remote|lazy fetching disabled|transport '[a-z]+' not allowed/.test(stderr.toString('utf8'))) {
      throw new GcrError('INVALID_ARGUMENT', 'the repository is a partial clone and some objects are not available locally; the scanner never fetches them, so fetch the full history and run it again', { cause: e });
    }
    throw new GcrError('INTERNAL_ERROR', `git ${args[0] ?? ''} failed`, { cause: e });
  }
}

/** Hunk-aware parser for unified diffs (`git log -p`, `git diff --cached`) that reports ADDED lines only. */
interface PatchVisitor {
  commit(hash: string): void;
  /** Called for each file section; path is null for deletions. */
  file(path: string | null): void;
  added(lineNo: number, text: string): void;
}

/** Undo git's C-style path quoting (used for names with quotes, backslashes, tabs or newlines). */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const body = quoted.slice(1, -1);
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? '';
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (simple[next] !== undefined) {
      bytes.push(simple[next] as number);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function pathFromPlusHeader(rest: string): string | null {
  // Git appends a TAB after names containing spaces so the header stays parseable.
  let value = rest.endsWith('\t') ? rest.slice(0, -1) : rest;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = unquoteGitPath(value);
  if (value === '/dev/null') return null;
  return value.startsWith('b/') ? value.slice(2) : value;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parsePatch(text: string, v: PatchVisitor): void {
  let inHunk = false;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const line of text.split('\n')) {
    // Inside a hunk the declared line counts decide what a line is. This matters because an added line whose text
    // starts with "++ " is printed as "+++ ..." and would otherwise be mistaken for a file header.
    if (inHunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line.charCodeAt(0);
      if (c === 45 /* - */ && oldLeft > 0) {
        oldLeft--;
        continue;
      }
      if (c === 43 /* + */ && newLeft > 0) {
        newLeft--;
        v.added(newLine++, line.slice(1));
        continue;
      }
      if (c === 92 /* \ */) continue; // "\ No newline at end of file"
      inHunk = false; // truncated or malformed output: resynchronize on the next header
    }
    if (line.charCodeAt(0) === 1) {
      v.commit(line.slice(1).trim());
      v.file(null);
      inHunk = false;
    } else if (line.startsWith('diff --git ')) {
      v.file(null);
      inHunk = false;
    } else if (line.startsWith('+++ ')) {
      v.file(pathFromPlusHeader(line.slice(4)));
    } else if (line.startsWith('@@ ')) {
      const m = HUNK_HEADER.exec(line);
      if (m !== null) {
        oldLeft = m[2] === undefined ? 1 : Number(m[2]);
        newLeft = m[4] === undefined ? 1 : Number(m[4]);
        newLine = Number(m[3]);
        inHunk = true;
      }
    }
  }
}

interface AddedLineScan {
  findings: Finding[];
  commitsSeen: Set<string>;
  /** `<commit>\u0000<path>` for every added line containing the synthetic marker. */
  markerSeen: Set<string>;
}

function scanPatchText(text: string, allow: ReadonlySet<string>, suffix: (commit: string) => string): AddedLineScan {
  const result: AddedLineScan = { findings: [], commitsSeen: new Set(), markerSeen: new Set() };
  let commit = '';
  let path: string | null = null;
  let rules: readonly ContentRule[] = [];
  const fileInfo = new Map<string, readonly ContentRule[]>();
  // Same per-file bound as the work-tree scan, applied to each file section of each commit.
  let listed = 0;
  let suppressed = false;
  parsePatch(text, {
    commit(hash) {
      commit = hash;
      if (hash !== '') result.commitsSeen.add(hash);
    },
    file(p) {
      listed = 0;
      suppressed = false;
      path = p !== null && !allow.has(p) ? p : null;
      if (path !== null) {
        let r = fileInfo.get(path);
        if (r === undefined) {
          r = activeRules(pathContext(path));
          fileInfo.set(path, r);
        }
        rules = r;
      }
    },
    added(lineNo, line) {
      if (path === null) return;
      if (line.includes(SYNTHETIC_MARKER)) result.markerSeen.add(`${commit}\u0000${path}`);
      if (suppressed) return;
      for (const hit of lineHits(rules, line)) {
        if (listed === MAX_FINDINGS_PER_FILE) {
          result.findings.push({ rule: 'too-many-findings', path, detail: `${TOO_MANY_FINDINGS_DETAIL}${suffix(commit)}` });
          suppressed = true;
          return;
        }
        result.findings.push({ rule: hit.rule, path, line: lineNo, detail: `${hit.detail}${suffix(commit)}` });
        listed++;
      }
    },
  });
  return result;
}

// `--text` makes git show the added lines of files that .gitattributes (`-diff`, `binary`, a binary diff driver) would
// otherwise reduce to "Binary files differ", which would hide exactly the files someone wanted kept out of review.
// `--inter-hunk-context=0` stops a `diff.interHunkContext` setting from merging hunks, which prints unchanged lines
// inside a hunk that the line-count based parser below does not expect.
const PATCH_FLAGS = [
  '-U0', '--inter-hunk-context=0', '--text', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
] as const;
const shortCommit = (hash: string): string => hash.slice(0, 12);

async function scanHistory(root: string, allow: ReadonlySet<string>, byteCap: number): Promise<{ findings: Finding[]; stats: HistoryStats; notes: string[] }> {
  const findings: Finding[] = [];
  const notes: string[] = [];
  let remaining = byteCap;
  let bytesRead = 0;
  let truncated = false;

  // Pass 1: every path ever ADDED. --no-renames makes a rename show as delete+add so a renamed-to forbidden name is
  // still reported. Merge commits print no diff here (same as pass 2), so a file that exists ONLY in a merge
  // resolution is a known gap; both passes see exactly the same commits, which keeps the marker check consistent.
  const names = await runGit(root, ['log', '--all', '--no-renames', '--name-only', '--diff-filter=A', '-z', '--format=%x01%H'], remaining);
  bytesRead += names.stdout.length;
  remaining -= names.stdout.length;
  truncated ||= names.truncated;
  const tokens = names.stdout.toString('utf8').split('\u0000');
  if (names.truncated) tokens.pop(); // the last token may be a cut-off path
  const added = new Set<string>(); // `<commit>\u0000<path>`
  let commit = '';
  let afterHeader = false;
  for (const token of tokens) {
    if (token.charCodeAt(0) === 1 && /^[0-9a-f]{40,64}$/.test(token.slice(1))) {
      commit = token.slice(1);
      afterHeader = true;
      continue;
    }
    let name = token;
    if (afterHeader) {
      if (name.startsWith('\n')) name = name.slice(1); // git separates the --format header from the first name with "\n"
      afterHeader = false;
    }
    if (name !== '') added.add(`${commit}\u0000${name}`);
  }
  const markerRequired = new Set<string>();
  const checkedPaths = new Set<string>();
  for (const key of [...added].sort(cmp)) {
    const sep = key.indexOf('\u0000');
    const c = key.slice(0, sep);
    const p = key.slice(sep + 1);
    checkedPaths.add(p);
    if (allow.has(p)) continue;
    for (const f of pathRuleFindings(p)) findings.push({ ...f, detail: `${f.detail} [in history, commit ${shortCommit(c)}]` });
    if (requiresSyntheticMarker(pathContext(p))) markerRequired.add(key);
  }

  // Pass 2: lines ADDED by any commit. Deleted lines are not scanned: a secret that was removed was added first.
  const patch = await runGit(root, ['log', '--all', '-p', '--no-show-signature', ...PATCH_FLAGS, '--format=%x01%H'], Math.max(1, remaining));
  bytesRead += patch.stdout.length;
  truncated ||= patch.truncated;
  const scanned = scanPatchText(patch.stdout.toString('utf8'), allow, (c) => ` [in history, commit ${shortCommit(c)}]`);
  appendAll(findings, scanned.findings);
  if (!patch.truncated) {
    for (const key of [...markerRequired].sort(cmp)) {
      if (scanned.markerSeen.has(key)) continue;
      const sep = key.indexOf('\u0000');
      findings.push(markerMissingFinding(key.slice(sep + 1), `raw-export-shaped fixture added without the synthetic-fixture marker [in history, commit ${shortCommit(key.slice(0, sep))}]`));
    }
  } else if (markerRequired.size > 0) {
    notes.push('history scan truncated: synthetic-marker checks for historical fixtures could not be completed');
  }
  if (truncated) {
    notes.push(`history scan truncated after ${bytesRead} bytes (cap ${byteCap}): older history was NOT fully scanned; raise the cap to scan more`);
  }
  return {
    findings,
    notes,
    stats: { byteCap, bytesRead, truncated, commitsSeen: scanned.commitsSeen.size, addedPathsChecked: checkedPaths.size },
  };
}

// ---- repository scan ---------------------------------------------------------------------------------------------

function requirePositiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  // Rejecting NaN/0/negative/Infinity: any of them would silently disable the bound they are meant to set.
  if (!Number.isSafeInteger(value) || value <= 0) throw new GcrError('INVALID_ARGUMENT', `${name} must be a positive integer`);
  return value;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type FileOutcome = { kind: 'scanned' | 'large' | 'binary' | 'nonregular' | 'allowed'; findings: Finding[] };

// ---- content signatures and text decoding ---------------------------------------------------------------------------------

/** `target.push(...items)` throws RangeError once `items` exceeds the engine's argument limit; append in a loop instead. */
function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

const SIGNATURE_BYTES = 16;

function startsWithBytes(head: Buffer, bytes: readonly number[]): boolean {
  if (head.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (head[i] !== bytes[i]) return false;
  return true;
}

interface FileSignature {
  label: string;
  /** ZIP containers: legitimate document/package formats share the signature and are told apart by extension. */
  zipContainer?: true;
  matches: (head: Buffer) => boolean;
}

// Magic numbers of the file types the path rules forbid by NAME, so renaming one (`chats.sqlite` -> `chats.dat`) or
// dropping its extension does not get it past the scan. Only unambiguous signatures: a text file cannot start with these.
const FILE_SIGNATURES: readonly FileSignature[] = [
  { label: 'SQLite database', matches: (h) => startsWithBytes(h, [...Buffer.from('SQLite format 3\u0000', 'latin1')]) },
  { label: 'ZIP archive', zipContainer: true, matches: (h) => startsWithBytes(h, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(h, [0x50, 0x4b, 0x05, 0x06]) },
  { label: 'gzip stream', matches: (h) => startsWithBytes(h, [0x1f, 0x8b, 0x08]) },
  { label: '7-Zip archive', matches: (h) => startsWithBytes(h, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { label: 'RAR archive', matches: (h) => startsWithBytes(h, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) },
  { label: 'xz stream', matches: (h) => startsWithBytes(h, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { label: 'zstd frame', matches: (h) => startsWithBytes(h, [0x28, 0xb5, 0x2f, 0xfd]) },
  { label: 'bzip2 stream', matches: (h) => h.length >= 10 && /^BZh[1-9]1AY&SY$/.test(h.toString('latin1', 0, 10)) },
];

const ZIP_CONTAINER_EXTENSIONS: readonly string[] = [
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.jar', '.war', '.ear', '.aar', '.apk', '.epub', '.vsix', '.nupkg', '.whl', '.xpi', '.crx', '.ipa', '.egg',
];

function signatureFinding(path: string, head: Buffer): Finding | null {
  const base = foldBackupSuffix(pathContext(path).base);
  for (const sig of FILE_SIGNATURES) {
    if (!sig.matches(head)) continue;
    if (sig.zipContainer === true && ZIP_CONTAINER_EXTENSIONS.some((e) => base.endsWith(e))) return null;
    return { rule: 'forbidden-file-signature', path, detail: `file content is a ${sig.label} although its name does not say so; databases and archives must not be committed under any name` };
  }
  return null;
}

async function readHead(abs: string): Promise<Buffer> {
  const handle = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SIGNATURE_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Decode file bytes as text, or return null when they are binary (contain NUL bytes). UTF-16 text with a byte-order
 * mark (PowerShell redirection, Windows editors) contains NULs by construction but is text, so it is decoded, not skipped.
 */
function decodeText(buf: Buffer): string | null {
  const evenEnd = buf.length - ((buf.length - 2) % 2);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2, Math.max(2, evenEnd)).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2, Math.max(2, evenEnd))).swap16().toString('utf16le');
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

async function scanOneFile(root: string, path: string, allow: ReadonlySet<string>, maxFileBytes: number): Promise<FileOutcome> {
  if (allow.has(path)) return { kind: 'allowed', findings: [] };
  const findings = pathRuleFindings(path);
  if (path.includes('\uFFFD')) {
    // git hands over raw bytes; a non-UTF-8 name decodes lossily, so the real file cannot be opened by that string.
    // Fail closed with a finding rather than treating it as a deleted file.
    findings.push({ rule: 'unreadable-file', path, detail: 'path is not valid UTF-8, so the file cannot be opened by name; content was not scanned' });
    return { kind: 'nonregular', findings };
  }
  const ctx = pathContext(path);
  const markerRequired = requiresSyntheticMarker(ctx);
  const abs = join(root, path);

  let st;
  try {
    st = await lstat(abs);
  } catch (e) {
    // Indexed but deleted from the work tree: path rules above still apply, staged changes are covered by the staged-diff
    // pass, and content that is only committed is covered by --history (this scan reads the work tree, not HEAD).
    if (errorCode(e) === 'ENOENT') return { kind: 'nonregular', findings };
    findings.push({ rule: 'unreadable-file', path, detail: `could not inspect file (${errorCode(e) ?? 'error'}); content was not scanned` });
    return { kind: 'nonregular', findings };
  }
  if (!st.isFile()) {
    // Symlinks are never followed (they could point outside the repository); submodule/nested-repo entries are directories.
    if (markerRequired) findings.push(markerMissingFinding(path, 'raw-export-shaped fixture is not a regular file, so the synthetic-fixture marker cannot be verified'));
    return { kind: 'nonregular', findings };
  }
  // Size is checked here from stat for files whose text is never decoded; scanned text gets the same check inside textFindings.
  const sizeFinding = fixtureSizeFinding(path, st.size);
  // A file whose NAME already gives it away is not reported a second time for its content signature.
  const nameGivesItAway = findings.some((f) => f.rule === 'forbidden-extension');
  if (st.size > maxFileBytes) {
    if (sizeFinding !== null) findings.push(sizeFinding);
    if (markerRequired) {
      // Nothing was read, so the marker cannot be verified: fail closed instead of waving the file through.
      findings.push(markerMissingFinding(path, 'raw-export-shaped fixture is larger than the scan limit, so the synthetic-fixture marker cannot be verified'));
    }
    if (!nameGivesItAway) {
      // The body is not read, but its first bytes are: a renamed database or archive is exactly the kind of file that is large.
      try {
        const sig = signatureFinding(path, await readHead(abs));
        if (sig !== null) findings.push(sig);
      } catch (e) {
        findings.push({ rule: 'unreadable-file', path, detail: `could not read file (${errorCode(e) ?? 'error'}); content was not scanned` });
      }
    }
    return { kind: 'large', findings };
  }

  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (e) {
    findings.push({ rule: 'unreadable-file', path, detail: `could not read file (${errorCode(e) ?? 'error'}); content was not scanned` });
    return { kind: 'nonregular', findings };
  }
  if (!nameGivesItAway) {
    const sig = signatureFinding(path, buf.subarray(0, SIGNATURE_BYTES));
    if (sig !== null) findings.push(sig);
  }
  const text = decodeText(buf);
  if (text === null) {
    if (sizeFinding !== null) findings.push(sizeFinding);
    if (markerRequired && !buf.includes(SYNTHETIC_MARKER)) {
      findings.push(markerMissingFinding(path, 'raw-export-shaped fixture is binary and does not contain the synthetic-fixture marker'));
    }
    return { kind: 'binary', findings };
  }
  appendAll(findings, textFindings(path, text, buf.length));
  return { kind: 'scanned', findings };
}

export async function scanRepo(root: string, opts: RepoScanOptions = {}): Promise<RepoScanResult> {
  const maxFileBytes = requirePositiveInteger('maxFileBytes', opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const byteCap = requirePositiveInteger('maxHistoryBytes', opts.maxHistoryBytes, DEFAULT_MAX_HISTORY_BYTES);
  const rootAbs = resolve(root);

  // Paths from `git log` are relative to the work-tree top level, so the scan root must BE that top level.
  let top: string;
  try {
    top = (await runGit(rootAbs, ['rev-parse', '--show-toplevel'], 64 * 1024)).stdout.toString('utf8').trim();
  } catch (e) {
    throw new GcrError('INVALID_ARGUMENT', 'root is not inside a git work tree, or git could not open it', { cause: e });
  }
  if ((await realpath(rootAbs)) !== (await realpath(top))) {
    throw new GcrError('INVALID_ARGUMENT', 'root must be the top-level directory of the git work tree');
  }

  const { entries: allow, findings: allowFindings } = await loadAllowFile(rootAbs);
  const listing = await runGit(rootAbs, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 256 * 1024 * 1024);
  if (listing.truncated) throw new GcrError('INTERNAL_ERROR', 'file listing exceeded its size bound');
  const paths = [...new Set(listing.stdout.toString('utf8').split('\u0000').filter((p) => p !== ''))].sort(cmp);

  const outcomes = await mapLimit(paths, FILE_READ_CONCURRENCY, (p) => scanOneFile(rootAbs, p, allow, maxFileBytes));
  const findings: Finding[] = [...allowFindings];
  const counts = { scanned: 0, large: 0, binary: 0, nonregular: 0, allowed: 0 };
  for (const o of outcomes) {
    counts[o.kind]++;
    appendAll(findings, o.findings);
  }
  const notes: string[] = [];

  // Staged content can differ from the work tree (secret staged, then edited away without re-staging); a commit would
  // still contain the staged version, so added lines in the index are scanned as well.
  const workTreeKeys = new Set(findings.map(findingKey));
  const staged = await runGit(rootAbs, ['diff', '--cached', ...PATCH_FLAGS], byteCap);
  if (staged.truncated) notes.push(`staged-diff scan truncated after ${staged.stdout.length} bytes (cap ${byteCap}): part of the index was NOT scanned`);
  for (const f of scanPatchText(staged.stdout.toString('utf8'), allow, () => '').findings) {
    if (!workTreeKeys.has(findingKey(f))) findings.push({ ...f, detail: `${f.detail} [staged]` });
  }

  let history: HistoryStats | null = null;
  if (opts.history === true) {
    const h = await scanHistory(rootAbs, allow, byteCap);
    appendAll(findings, h.findings);
    appendAll(notes, h.notes);
    history = h.stats;
  }

  return {
    findings: finalize(findings),
    scannedFiles: counts.scanned,
    skippedLarge: counts.large,
    skippedBinary: counts.binary,
    skippedNonRegular: counts.nonregular,
    listedFiles: paths.length,
    allowListedFiles: counts.allowed,
    history,
    notes,
  };
}

// ---- output + CLI entry ---------------------------------------------------------------------------------------------

// Built from char codes: U+2028/U+2029 written literally (or as escapes in a regex literal) are line terminators in JS source.
const UNSAFE_TEXT = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

function safeText(s: string): string {
  // Paths come from the repository and may contain terminal escape sequences; show them inert.
  return s.replace(UNSAFE_TEXT, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function formatFindings(findings: readonly Finding[]): string {
  return [...findings]
    .sort(compareFindings)
    .map((f) => `${safeText(f.path)}${f.line === undefined ? '' : `:${f.line}`}: [${f.rule}] ${safeText(f.detail)}`)
    .join('\n');
}

export interface CliResult {
  /** 0 = clean, 1 = findings, 2 = usage or internal error. */
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

const USAGE = [
  'Usage: privacy-scan [--root <dir>] [--history] [--json] [--max-file-bytes <n>] [--max-history-bytes <n>]',
  '',
  '  --root <dir>             repository top level to scan (default: current directory)',
  '  --history                also scan every path and added line in all refs (bounded)',
  '  --json                   machine-readable output (secrets are masked here too)',
  '  --max-file-bytes <n>     skip content scan of files larger than n bytes (default 2097152)',
  '  --max-history-bytes <n>  byte cap for each git history/staging query set (default 67108864)',
  '',
  'Exit status: 0 clean, 1 findings, 2 error.',
  '',
].join('\n');

interface CliArgs {
  root: string;
  history: boolean;
  json: boolean;
  help: boolean;
  maxFileBytes?: number;
  maxHistoryBytes?: number;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { root: process.cwd(), history: false, json: false, help: false };
  const number = (flag: string, raw: string | undefined): number => {
    if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) throw new GcrError('INVALID_ARGUMENT', `${flag} needs a positive integer`);
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string | undefined => inline ?? argv[++i];
    switch (flag) {
      case '--history':
        args.history = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--root': {
        const v = value();
        if (v === undefined || v === '') throw new GcrError('INVALID_ARGUMENT', '--root needs a directory');
        args.root = v;
        break;
      }
      case '--max-file-bytes':
        args.maxFileBytes = number(flag, value());
        break;
      case '--max-history-bytes':
        args.maxHistoryBytes = number(flag, value());
        break;
      default:
        throw new GcrError('INVALID_ARGUMENT', `unknown argument: ${safeText(arg).slice(0, 60)}`);
    }
  }
  return args;
}

/**
 * CLI body. Returns the text to print instead of printing it, so this library code stays free of console/process
 * output and the thin launcher (scripts/privacy-scan.mjs) owns all I/O.
 */
export async function main(argv: readonly string[]): Promise<CliResult> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    const message = e instanceof GcrError ? e.message : 'invalid arguments';
    return { exitCode: 2, stdout: '', stderr: `privacy-scan: ${message}\n\n${USAGE}` };
  }
  if (args.help) return { exitCode: 0, stdout: USAGE, stderr: '' };

  try {
    const options: RepoScanOptions = { history: args.history };
    if (args.maxFileBytes !== undefined) options.maxFileBytes = args.maxFileBytes;
    if (args.maxHistoryBytes !== undefined) options.maxHistoryBytes = args.maxHistoryBytes;
    const result = await scanRepo(args.root, options);
    const exitCode = result.findings.length > 0 ? 1 : 0;
    if (args.json) {
      return { exitCode, stdout: `${JSON.stringify({ ok: exitCode === 0, ...result }, null, 2)}\n`, stderr: '' };
    }
    const summary =
      `privacy-scan: ${result.findings.length === 0 ? 'clean' : `${result.findings.length} finding(s)`}; ` +
      `${result.scannedFiles} file(s) scanned, skipped ${result.skippedLarge} large / ${result.skippedBinary} binary / ${result.skippedNonRegular} non-regular, ` +
      `${result.allowListedFiles} allow-listed` +
      (result.history === null ? '' : `; history: ${result.history.commitsSeen} commit(s), ${result.history.addedPathsChecked} added path(s), ${result.history.bytesRead} byte(s) read`);
    const body = formatFindings(result.findings);
    return {
      exitCode,
      stdout: `${body === '' ? '' : `${body}\n`}${summary}\n`,
      stderr: result.notes.map((n) => `privacy-scan: note: ${n}\n`).join(''),
    };
  } catch (e) {
    // Only GcrError messages are safe to show (they never carry paths or content); anything else is generic.
    const message = e instanceof GcrError ? e.message : 'unexpected internal error';
    return { exitCode: 2, stdout: '', stderr: `privacy-scan: error: ${message}\n` };
  }
}
