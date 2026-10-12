/**
 * Privacy scanner: a dev-only gate that keeps private conversation data, databases and credentials out of Git
 * (SPEC FR-08 data minimization, NFR-01 no credentials in Git; CODEX_TASK Phase 3 "privacy-focused git scan").
 *
 * This is NOT product code. It is the only place in the repository that spawns a child process (git, via
 * `execFile` with an argument array, never a shell string) and it must never be imported by the SDK, CLI or MCP
 * server. It performs no network access of any kind (git runs with every transport and lazy fetching disabled, so a
 * partial clone fails closed instead of being completed from its remote) and it never writes to the scanned repository.
 *
 * FAIL CLOSED is the governing rule: anything the scanner cannot judge is a finding, not a silent skip.
 *
 * What it checks
 *  - PATH rules: databases (and their WAL/SHM/journal sidecars), archives, key material, HAR files, logs, env files,
 *    cookie jars, netrc files, raw export files and "export"/"private"/".gcr" directories (also directories whose name
 *    contains the word export, such as `chatgpt-export/`), at any depth, case-insensitively, also when the name carries
 *    a backup suffix (`.bak`, `~`, ...).
 *  - SIGNATURE rule: the first bytes of every file (even one too large to read in full) identify a SQLite database or
 *    an archive that was renamed; ZIP-based document/package formats are told apart by extension.
 *  - CONTENT rules: PEM private keys, API keys/tokens (OpenAI, GitHub, Slack, Google, npm, Stripe live keys, GitLab,
 *    Hugging Face), AWS access key ids and `aws_secret_access_key` assignments, JWTs, Authorization and Proxy-Authorization
 *    Bearer/Basic headers, Cookie headers, credentials embedded in a URL (`scheme://user:password@host`), password parameters in a
 *    query string or connection string (`?password=...`, `;Password=...;`), netrc password lines,
 *    ChatGPT session cookie names and cookie-jar entries, real conversation URLs, asset pointers and long
 *    high-entropy blobs. Lines that contain escaped quotes or slashes are also judged unescaped, and every Unicode
 *    Default_Ignorable_Code_Point (zero-width space and joiners, direction marks, soft hyphen, Hangul fillers, variation
 *    selectors, the byte-order mark, TAG characters, ...) is removed before matching so it cannot be used to split a key. Every pattern is
 *    linear-time (no nested or overlapping quantifiers; unbounded runs are anchored by a lookbehind so each run is
 *    scanned once). UTF-16 text with a byte-order mark is decoded; any other file with NUL bytes is binary and gets
 *    the path/signature rules only.
 *  - FIXTURE rules: raw-export-shaped files may only live under the root `fixtures/` directory, must carry the
 *    literal marker below, and must stay small. A file that has the SHAPE of a ChatGPT or Claude export (keys such as
 *    `mapping` with `current_node`/`create_time`/`conversation_id`, or `chat_messages` with `uuid`/`sender`) needs the
 *    marker wherever it is, whatever it is called: a data file (json/jsonl/ndjson/txt/dat or extension-less) or any
 *    file whose content starts like JSON (after any amount of white space, blank lines or a byte-order mark; in history
 *    too). The keys are also looked for in the raw bytes of a binary file, which finds an
 *    export stored uncompressed inside a tar or similar container.
 *  - OUTPUT rules (`gcr-output-file`): files that GCR itself wrote hold titles, entity labels and conversation text,
 *    so they are private too. Recognised by content, whatever the name: a graph page (an HTML document carrying the
 *    exporter's `graph-data` block or its fixed footer sentence), a CLI/MCP result envelope (JSON or JSONL with
 *    `"untrustedContent": true|false` plus `provenance`/`completeness`, or starting with the `ok`/`data` envelope), the
 *    Markdown/compact renderings (their fixed preamble), and the renderings of local drafts and annotations. Exempt: a file under `fixtures/` that carries the marker.
 *
 * Large files (above `maxFileBytes`, default 2 MiB) are NEVER silently skipped. Their first `LARGE_FILE_HEAD_BYTES`
 * and last `LARGE_FILE_TAIL_BYTES` are read in bounded chunks (never the whole file) and judged by every rule above:
 * signature, export shape, output shape, marker and secrets. The bytes in between were not judged, so the file is
 * reported as `unscanned-large-file` (a failing finding) unless its path is allow-listed or it lives below a
 * `node_modules`, `dist`, `dist-test*` or `coverage` directory. `allowLargeUnscanned` / `--allow-large-unscanned`
 * downgrades that finding (and `scan-truncated`) to a note for LOCAL use; CI never passes it. A file that fits entirely
 * inside the two windows is scanned in full and is not "large" for any purpose but the threshold.
 *
 * Modes. Default: the work tree (tracked files plus untracked files that are not ignored) and, additionally, the added
 * lines of the staged diff. `staged`: exactly what `git commit` would record, read from the INDEX (blobs, not the work
 * tree), for the pre-commit hook (scripts/git-hooks/pre-commit). `history`: every path ever added and every added line
 * in all refs. In history and staged-diff text a file's shape is judged from ALL its added lines (not only a head
 * window), and a stream cut by `maxHistoryBytes` is a `scan-truncated` finding because older history was not judged.
 *
 * Secrets are never reproduced: a finding's `detail` shows at most the first 4 characters of a match (fewer for
 * short matches) plus its length, and line CONTENT is never copied into any output. At most `MAX_FINDINGS_PER_FILE`
 * content findings are listed per file (and per file section of a patch); a `too-many-findings` entry says so.
 *
 * Exceptions: an optional `.privacy-scan-allow` file at the repository root lists exact repo-relative paths, one
 * per line (`#` starts a comment line, no globs). An allow-listed path is exempt from every rule, so the file is
 * the single, reviewable place where exceptions live.
 *
 * Bounds: files up to `maxFileBytes` are read whole; larger ones only through the two windows; the staged-diff and
 * history passes read git's own patch text (with `--text`, so .gitattributes cannot hide a file) and are bounded by
 * `maxHistoryBytes` instead, so an oversized staged file still has its added lines scanned (up to the cap).
 *
 * Known limits (reported, not hidden): the allow-file is read from the working tree only and an allow-listed path is
 * exempt in history too; unreachable objects, the reflog, stashes, commit messages and content that exists only inside
 * a merge-commit resolution are not scanned; committed content that differs from an unstaged work-tree edit is only
 * seen by `--history`; history scanning is capped (see `maxHistoryBytes`), a cut is a finding, and it cannot
 * recognise a renamed database by signature (only the work-tree copy of a file is sniffed) nor judge the SHAPE of a
 * file that a later commit only MODIFIED unless it has a data-like name (then the lines that commit added are judged, except for a
 * path that carries the marker in any commit or lies under fixtures/; the final version is judged by the work-tree scan); in a large file only the
 * two windows are judged for secrets (a staged large blob: only its head, plus its added lines up to the diff cap); an
 * export ZIP renamed to a ZIP-based document or package extension (.docx, .epub, .jar, ...) is tolerated by the signature rule
 * on purpose, because those formats ARE ZIP files; the synthetic marker is a plain text match, so a real export whose message
 * text happens to contain the literal marker is waived by it; a file with NUL bytes and no UTF-16 byte-order mark (UTF-16 without
 * a mark, text padded with NULs) is binary for the content rules, and so is an export encoded as base64 wrapped at 76 columns;
 * and intentional gaps in the content rules: passwords without a distinctive shape (a bare `password=...` outside a URL
 * query string or connection string, `curl -u`),
 * placeholder-looking URL credentials (documentation hosts such as example.com, single-character user names, template
 * text, short passwords on http(s) URLs), a key split over several string fragments or lines, base64 or hex-encoded
 * or encrypted secrets, secrets that are only reassembled at run time, and vendor token formats that are not listed
 * above.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
  /** Also scan every path ever added and every added line in all refs. Default false. Cannot be combined with `staged`. */
  history?: boolean;
  /**
   * Scan exactly what `git commit` would record, reading the INDEX (staged blobs) instead of the work tree. This is the
   * mode of the pre-commit hook. When git runs a hook for `git commit -a` or `git commit <paths>` it points
   * GIT_INDEX_FILE at a temporary index; that variable is honoured in this mode (and only in this mode).
   */
  staged?: boolean;
  /**
   * Files larger than this are not read in full: only their first `LARGE_FILE_HEAD_BYTES` and last `LARGE_FILE_TAIL_BYTES`
   * are judged (counted in `skippedLarge`) and the rest is an `unscanned-large-file` finding. Default 2 MiB.
   */
  maxFileBytes?: number;
  /** Total stdout bytes read from each git history/staging query set before truncating. Default 64 MiB. */
  maxHistoryBytes?: number;
  /**
   * LOCAL USE ONLY. Report `unscanned-large-file` and `scan-truncated` as notes instead of findings. Coverage is then
   * incomplete, so a clean result no longer proves that nothing private is committed. CI must not set it.
   */
  allowLargeUnscanned?: boolean;
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
  /** Files above `maxFileBytes` that were judged only through their head/tail windows (the middle was NOT read). */
  skippedLarge: number;
  /** Files containing NUL bytes: path rules applied, content NOT scanned. */
  skippedBinary: number;
  /** Listed entries that are not readable regular files (symlinks, submodules/nested repos, deleted-but-indexed). */
  skippedNonRegular: number;
  /** Everything git listed (tracked + untracked-not-ignored), before the allow-list. */
  listedFiles: number;
  /** Listed files exempted by `.privacy-scan-allow`. */
  allowListedFiles: number;
  /**
   * Large files left partly unjudged WITHOUT a finding: below an excluded directory (node_modules, dist, ...) or because
   * `allowLargeUnscanned` was set. Always 0 in a default CI run unless such a directory was force-added.
   */
  unscannedLarge: number;
  /** True when the index (not the work tree) was scanned. */
  staged: boolean;
  /** null unless `history: true`. */
  history: HistoryStats | null;
  /** Human-readable coverage caveats (truncation etc.); deterministic text. */
  notes: string[];
}

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_HISTORY_BYTES = 64 * 1024 * 1024;
/**
 * Window sizes for files above `maxFileBytes`. A real export starts with its first conversation (the shape keys and
 * the first secrets are in the head) and a result envelope ends with its `untrustedContent`/`completeness` keys (the tail),
 * so both ends are judged; reading two bounded windows keeps memory flat for a multi-gigabyte file.
 */
export const LARGE_FILE_HEAD_BYTES = 256 * 1024;
export const LARGE_FILE_TAIL_BYTES = 64 * 1024;
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
  // `.db3` is another common SQLite extension (and has the same sidecars).
  '.db3', '.db3-wal', '.db3-shm', '.db3-journal',
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
  // Private keys and credential stores that are usually found under exactly these names (a public key, id_rsa.pub, is fine).
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.pgpass', '.git-credentials', '.htpasswd',
]);

/** netrc files (`.netrc`, `_netrc`, `curl.netrc`) hold `password` lines in a format with no distinctive token shape. */
const NETRC_NAME = /(?:^|[._-])netrc$/;

const EXPORT_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['export', 'exports', 'private']);
/** File extensions that are presumed to be raw export data when they sit inside an export directory. */
const EXPORT_DIRECTORY_EXTENSIONS: readonly string[] = ['.json', '.jsonl', '.ndjson', '.zip'];

/**
 * An unzipped export usually lands in a directory such as `chatgpt-export-2026-10-01/` or `claude_export/`. A directory
 * is treated as an export directory when its name IS export/exports/private or contains the word "export"/"exports" as
 * a separate token (split at anything that is not a letter or digit). `exporter`, `exported` and `export2` are not tokens.
 */
function isExportDirectoryName(dir: string): boolean {
  if (EXPORT_DIRECTORY_NAMES.has(dir)) return true;
  return dir.split(/[^a-z0-9]+/).some((token) => token === 'export' || token === 'exports');
}
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

  if (NETRC_NAME.test(core)) {
    out.push({ rule: 'forbidden-filename', path, detail: 'netrc files hold login passwords and must not be committed' });
  }

  const directories = ctx.segments.slice(0, -1).map((s) => s.toLowerCase());
  if (directories.some(isExportDirectoryName) && EXPORT_DIRECTORY_EXTENSIONS.some((e) => core.endsWith(e))) {
    out.push({ rule: 'export-directory', path, detail: 'json/jsonl/zip files inside an export, exports or private directory (or one named like chatgpt-export) are presumed to be raw exports' });
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

// ---- credential shapes added after the black-box review (ATK-09) ------------------------------------------------------
// The vendor prefixes below are literal text in this file. Each pattern is written so that its own source text cannot
// match it (the body is a bracket expression, and a bracket is never one of the body characters), which keeps the
// scanner clean on itself.

/** Host names of documentation (RFC 2606 / 6761 reserved names, `.internal`) and of the developer's own machine. */
const DOCUMENTATION_HOST = /(?:^|\.)(?:example(?:\.com|\.org|\.net)?|invalid|test|localhost|internal)$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);

function isDocumentationHost(rawHost: string): boolean {
  // Drop a trailing :port (not inside an IPv6 literal), brackets and the trailing dot of a fully qualified name.
  let host = rawHost.toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']') === -1 ? undefined : host.indexOf(']'));
  else host = host.replace(/:[0-9]{0,5}$/, '');
  host = host.replace(/\.$/, '');
  return LOOPBACK_HOSTS.has(host) || DOCUMENTATION_HOST.test(host);
}

/** Words people put where a password goes in documentation and examples. */
const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'pass', 'password', 'passwd', 'pwd', 'secret', 'token', 'changeme', 'change-me', 'redacted', 'hidden', 'example', 'yourpassword',
  'your-password', 'your_password', 'mypassword', 'my-password', 'my_password', 'null', 'none', 'undefined',
]);

/** True for template syntax, masks and well-known placeholder words: text that is code or documentation, not a captured secret. */
function isPlaceholderSecret(value: string): boolean {
  if (value === '' || /[$<>{}[\]%]/.test(value)) return true; // ${PASS}, <password>, {{ pw }}, [redacted], %s / %(pw)s
  if (/^(.)\1*$/.test(value)) return true; // xxxxxxxx, ********, ........
  if (/^[*x.#_-]+$/i.test(value)) return true;
  return PLACEHOLDER_SECRETS.has(value.toLowerCase());
}

/** Number of distinct character classes (lower, upper, digit, other) in a value: 1 for `hunter`, 3 for `Xk29aPqLm`. */
function characterClasses(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  if (/[^A-Za-z0-9]/.test(value)) classes++;
  return classes;
}

/** Schemes whose URLs are connection strings: a password in them is a credential even when it is short. */
const CONNECTION_SCHEMES: ReadonlySet<string> = new Set([
  'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'rediss', 'amqp', 'amqps', 'mssql', 'sqlserver', 'oracle', 'cockroachdb',
  'clickhouse', 'ftp', 'ftps', 'sftp', 'smtp', 'smtps', 'imap', 'imaps', 'ldap', 'ldaps', 'mqtt', 'mqtts', 'nats', 'cassandra', 'neo4j', 'bolt',
]);

/**
 * `scheme://user:password@host`. The password is judged, never printed. Reported when it is a real-looking secret (8+
 * characters mixing at least two character classes) on any host, or any non-placeholder password on a connection-string
 * scheme (postgres, redis, ftp, ...). A weak password is not reported on documentation hosts (example.com, *.invalid,
 * *.test, localhost, *.internal), nor with a single-character user name (`u:pw@h`); template or placeholder text is never
 * reported. Those are exactly the forms in which URL parsing is documented and tested.
 */
function urlCredentialsDetail(m: RegExpExecArray): string | null {
  const scheme = (m[1] ?? '').toLowerCase();
  const user = m[2] ?? '';
  const password = m[3] ?? '';
  const host = m[4] ?? '';
  // Template text anywhere in the userinfo (`${USER}:${PASS}@`) means code or documentation that builds a URL.
  if (isPlaceholderSecret(password) || /[$<>{}[\]%]/.test(user)) return null;
  if (/[$<>{}[\]%]/.test(host)) return null; // a template in the host is code that builds a URL
  const strong = password.length >= 8 && characterClasses(password) >= 2;
  const connection = CONNECTION_SCHEMES.has(scheme.split('+')[0] ?? scheme);
  // A documentation or loopback host only excuses a password that does not look real: a random-looking password is reported
  // wherever it points, because people reuse them and `localhost` in a committed file is still a committed password.
  if (!strong && isDocumentationHost(host)) return null;
  if (user.length <= 1 && !strong) return null;
  if (!strong && !connection) return null;
  return `credentials embedded in a ${scheme}:// URL, password ${maskSecret(password)}`;
}

/**
 * Not exempted on purpose: the AWS documentation's sample key (it ends in EXAMPLEKEY). The scanner cannot tell a sample
 * from a copy of it, a repository has no reason to quote it, and a false positive costs one edited line.
 */
function awsSecretDetail(m: RegExpExecArray): string | null {
  const value = m[1] ?? '';
  if (isPlaceholderSecret(value)) return null; // x repeated 40 times, a mask
  return `AWS secret access key assignment ${maskSecret(value)}`;
}

/**
 * A Basic credential is base64("user:password"), so a candidate that does not decode to something with a colon and a
 * non-empty password is not one. Sample passwords such as "user:password" are NOT exempted (unlike in a URL, where
 * `user:password@host` is the universal way to write an example): a header with a decodable credential is a captured header.
 */
function basicAuthDetail(m: RegExpExecArray): string | null {
  const token = m[1] ?? '';
  const decoded = Buffer.from(token, 'base64').toString('latin1');
  const colon = decoded.indexOf(':');
  if (colon === -1 || colon === decoded.length - 1) return null;
  return `Authorization Basic credentials ${maskSecret(token)}`;
}

function netrcDetail(raw: string): string | null {
  // A bare token ends at white space, so punctuation that follows it in prose or markup (`pw`, "pw") is not part of the secret.
  const password = raw.replace(/[`'")\],;.]+$/, '');
  return isPlaceholderSecret(password) ? null : `netrc password ${maskSecret(password)}`;
}

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
    id: 'google-api-key',
    pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g,
    detail: (m) => `Google API key ${maskSecret(m[0])}`,
  },
  {
    id: 'npm-token',
    pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36,}/g,
    detail: (m) => `npm access token ${maskSecret(m[0])}`,
  },
  {
    id: 'stripe-key',
    // Live keys only (test-mode keys move no money). pk_live_ is publishable, not secret, but is listed with its siblings
    // so a whole key set pasted into a file is reported once for each member.
    pattern: /(?<![A-Za-z0-9_])(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/g,
    detail: (m) => `Stripe live API key ${maskSecret(m[0])}`,
  },
  {
    id: 'gitlab-token',
    pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g,
    detail: (m) => `GitLab personal access token ${maskSecret(m[0])}`,
  },
  {
    id: 'huggingface-token',
    pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g,
    detail: (m) => `Hugging Face access token ${maskSecret(m[0])}`,
  },
  {
    id: 'aws-secret-access-key',
    // Assignment forms only (`aws_secret_access_key = <40 chars>`, the JSON key SecretAccessKey): 40 base64 characters on
    // their own have no distinctive shape. Bounded separators and no nested quantifier keep it linear.
    pattern: /(?<![A-Za-z0-9_])(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secretaccesskey)["']?[ \t]*[:=][ \t]*["'`]?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    detail: awsSecretDetail,
  },
  {
    id: 'url-credentials',
    // scheme://user:password@host. Every part is length-bounded and the lookbehind starts one candidate per scheme word.
    pattern: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{1,30}):\/\/([^\s:@/?#"'`<>\\]{0,128}):([^\s@/?#"'`<>\\]{1,256})@([^\s@/?#"'`<>\\]{1,255})/g,
    detail: urlCredentialsDetail,
  },
  {
    id: 'basic-auth-header',
    // `Proxy-Authorization` carries the same credential for a proxy; the optional prefix is part of the match, so the lookbehind still guards its start.
    pattern: /(?<![A-Za-z0-9_-])(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["'`]?basic[ \t]+([A-Za-z0-9+/]{8,}={0,2})/gi,
    detail: basicAuthDetail,
  },
  {
    id: 'password-parameter',
    // A password in a URL query string or a connection string (`?password=...`, `&pwd=...`, `;Password=...;`). The delimiter in
    // front makes it a parameter, which prose and code do not produce; a bare `password=...` (an .env line, a shell
    // assignment) has no distinctive shape and stays a documented gap.
    pattern: /(?<=[?&;])(?:password|passwd|pwd)=([^\s&;"'`<>]{4,})/gi,
    detail: (m) => (isPlaceholderSecret(m[1] ?? '') ? null : `password parameter in a URL or connection string ${maskSecret(m[1] ?? '')}`),
  },
  {
    id: 'netrc-password',
    // The one-line netrc form: the keywords machine (or default), login and password, each followed by its value, on one line.
    pattern: /(?<![A-Za-z0-9_-])(?:machine[ \t]+\S{1,255}|default)[ \t]+login[ \t]+\S{1,255}[ \t]+password[ \t]+(\S{1,255})/gi,
    detail: (m) => netrcDetail(m[1] ?? ''),
  },
  {
    id: 'netrc-password',
    // The multi-line form puts the word password and its value on a line of their own, which is too common in prose to match in every file.
    pattern: /^[ \t]*password[ \t]+(\S{1,255})[ \t]*$/gi,
    exempt: (ctx) => !NETRC_NAME.test(foldBackupSuffix(ctx.base)),
    detail: (m) => netrcDetail(m[1] ?? ''),
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
    pattern: /(?<![A-Za-z0-9_-])(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["'`]?bearer[ \t]+([A-Za-z0-9._~+/=_-]{20,})/gi,
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

// Invisible format characters: every Unicode Default_Ignorable_Code_Point (soft hyphen, combining grapheme joiner, Arabic letter
// mark, Hangul fillers, Khmer inherent vowels, Mongolian variation selectors, zero-width space/joiners and direction marks,
// bidi embeddings, word joiner and invisible operators, bidi isolates, variation selectors and their supplement, the byte-order
// mark, the reserved format range and the whole TAG block). A credential with one of these in the middle looks the same to a
// reader and works the same when copied out of an editor, but a pattern would not match it. They are removed before matching;
// the line numbers are unaffected because a line break is never in this set.
const INVISIBLE_TEST = /\p{Default_Ignorable_Code_Point}/u;
const INVISIBLE_ALL = new RegExp(INVISIBLE_TEST.source, 'gu');

/**
 * Apply the rules to one line and, when the line contains escaped quotes or slashes, to its unescaped form as well, so
 * `{\"Authorization\": \"Bearer ...\"}` is judged like the header it encodes. Duplicates are dropped.
 */
function lineHits(rules: readonly ContentRule[], rawLine: string): RuleHit[] {
  const line = INVISIBLE_TEST.test(rawLine) ? rawLine.replace(INVISIBLE_ALL, '') : rawLine;
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

// ---- export-shaped data and GCR's own output -----------------------------------------------------------------------------

const DATA_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.jsonl', '.ndjson', '.txt', '.dat', '.data']);

/** Data-like file names: JSON/text/data files and extension-less files, optionally with a backup suffix. */
function isDataLikeName(base: string): boolean {
  const core = foldBackupSuffix(base);
  const dot = core.lastIndexOf('.');
  return dot <= 0 || DATA_EXTENSIONS.has(core.slice(dot));
}

/** Keys whose presence (as a quoted JSON key) says "this is a conversation export". */
const SHAPE_KEYS: readonly string[] = ['mapping', 'current_node', 'create_time', 'update_time', 'conversation_id', 'chat_messages', 'uuid', 'sender'];
/** Exact text the graph exporter (src/graph/export-html.ts) writes into every page; the title can be customised, these cannot. */
const GRAPH_PAGE_MARKERS: readonly string[] = ['id="graph-data"', 'Generated locally by GCR from your own imported data', '<title>GCR graph export</title>'];
// CLI/MCP result envelopes: a boolean `untrustedContent` VALUE (a schema document has an object there) next to provenance or
// completeness, or the `ok`/`data` lead of the envelope, or the header line of a JSONL rendering.
// The backslash-quote forms are the same keys inside a JSON string: the text block of a logged JSON-RPC response (an MCP client keeps the
// envelope there as an escaped string, next to a `structuredContent` copy that some logs leave out).
const ENVELOPE_FLAG = /\\?"untrustedContent\\?"[ \t]*:[ \t]*(?:true|false)/;
const ENVELOPE_PROVENANCE = /\\?"(?:completeness|provenance)\\?"[ \t]*:[ \t]*\\?"/;
const ENVELOPE_LEAD = /^\{\s*"ok"\s*:\s*(?:true|false)\s*,\s*"(?:data|error)"\s*:/;
const JSONL_HEADER_LEAD = /^\{\s*"type"\s*:\s*"header"\s*,\s*"ok"\s*:\s*(?:true|false)/;
const HTML_LEAD = /^<(?:!doctype\s+html|html)[\s>]/i;
// The fixed preambles of the compact and Markdown renderings (src/format/render.ts).
const COMPACT_LEAD = /^# [^\n]*\n# source: provenance=[A-Za-z_]+ \| account=/;
const MARKDOWN_LEAD = /^# [^\n]{1,500}\n\n- [^\n]*\n/;
const MARKDOWN_TOOL_LINE = /\n- Tool version: gcr [0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?\n/;

// Renderings of local drafts and annotations (src/drafts/drafts.ts, src/cli/render-local.ts). `draft show` and `annotate show` print the
// user's own text (a draft body, a note) and the lists print draft titles, so these preambles are private output like the ones above.
const LOCAL_OUTPUT_LEADS: readonly RegExp[] = [
  /^# GCR local draft \(not sent\)\n\n> This is a local draft\. /,
  /^# (?:Draft|Annotation) (?:created|updated|shown|archived) \(local only\)\n\n- (?:Draft|Annotation) id: /,
  /^# Local (?:drafts|annotations)\n\n- Page: [0-9]+ item\(s\) at offset [0-9]+ \(limit [0-9]+\)\n/,
  /^# (?:draft|annotation) (?:created|updated|shown|archived) \| local only \| id=/,
  /^# (?:drafts|annotations) \| local only \| [0-9]+ item\(s\) \| next=/,
];

const PROBE_PREFIX_CHARS = 2048;
const LEADING_SPACE = /^[\uFEFF\s]*/;

/**
 * Collects the facts about a text that the shape rules need, from any number of chunks (a whole file, a head and a tail
 * window, or the added lines of a patch section): which export keys occur, whether the synthetic marker occurs, which
 * envelope or graph-page markers occur, and the first characters of the text. A chunk is never retained.
 */
class ContentProbe {
  private prefix = '';
  private readonly keys = new Set<string>();
  private marker = false;
  private untrustedFlag = false;
  private provenanceKey = false;
  private graphMarker = false;

  get hasMarker(): boolean {
    return this.marker;
  }

  add(text: string): void {
    if (this.prefix.length < PROBE_PREFIX_CHARS) this.addToPrefix(text);
    for (const key of SHAPE_KEYS) if (!this.keys.has(key) && text.includes(`"${key}"`)) this.keys.add(key);
    if (!this.marker && text.includes(SYNTHETIC_MARKER)) this.marker = true;
    if (!this.untrustedFlag && text.includes('untrustedContent')) this.untrustedFlag = ENVELOPE_FLAG.test(text);
    if (!this.provenanceKey && (text.includes('completeness') || text.includes('provenance'))) this.provenanceKey = ENVELOPE_PROVENANCE.test(text);
    if (!this.graphMarker) this.graphMarker = GRAPH_PAGE_MARKERS.some((m) => text.includes(m));
  }

  /**
   * Leading white space and a byte-order mark are skipped while the prefix is still empty: a JSON parser (and a browser) accepts any
   * amount of it, so a lead that begins after thousands of blank characters or lines must still be seen.
   */
  private addToPrefix(text: string): void {
    let from = 0;
    if (this.prefix === '') {
      from = (LEADING_SPACE.exec(text)?.[0] ?? '').length;
      if (from === text.length) return;
    }
    this.prefix += `${this.prefix === '' ? '' : '\n'}${text.slice(from, from + PROBE_PREFIX_CHARS - this.prefix.length)}`;
  }

  /** The start of the text without a byte-order mark and leading white space, with CRLF folded to LF. */
  private lead(): string {
    return this.prefix.replace(/^[\uFEFF\s]+/, '').replace(/\r\n/g, '\n');
  }

  private startsLikeJson(): boolean {
    const lead = this.lead();
    return lead.startsWith('{') || lead.startsWith('[');
  }

  /**
   * Official ChatGPT exports carry `mapping` + `current_node`/`create_time`/`conversation_id`; Claude exports carry
   * `chat_messages` + `uuid`/`sender`. A data file, or any file whose content starts like JSON, with that shape is a
   * conversation export whatever it is called, so it must prove it is synthetic. Source code and documents only MENTION
   * these keys, which is why only data-like names and JSON-looking content are judged.
   */
  exportShape(dataLikeName: boolean): boolean {
    if (!dataLikeName && !this.startsLikeJson()) return false;
    const k = this.keys;
    return (
      (k.has('mapping') && (k.has('current_node') || k.has('create_time') || k.has('update_time') || k.has('conversation_id'))) ||
      (k.has('current_node') && k.has('conversation_id')) ||
      (k.has('chat_messages') && (k.has('uuid') || k.has('sender')))
    );
  }

  /** A description of the kind of GCR output this text is, or null. Judged from the content only, never the name. */
  gcrOutput(): string | null {
    const lead = this.lead();
    if (HTML_LEAD.test(lead) && this.graphMarker) return 'a GCR graph page';
    // `[` is an array of envelopes (`jq -s`); only the two flags decide there, the lead patterns below describe a single envelope.
    if (lead.startsWith('{') || lead.startsWith('[')) {
      if (this.untrustedFlag && this.provenanceKey) return 'a GCR result envelope (JSON or JSONL)';
      if ((ENVELOPE_LEAD.test(lead) || JSONL_HEADER_LEAD.test(lead)) && (this.untrustedFlag || this.provenanceKey)) return 'a GCR result envelope (JSON or JSONL)';
    }
    if (COMPACT_LEAD.test(lead)) return 'GCR compact output';
    if (MARKDOWN_LEAD.test(lead) && MARKDOWN_TOOL_LINE.test(lead)) return 'GCR Markdown output';
    if (LOCAL_OUTPUT_LEADS.some((re) => re.test(lead))) return 'GCR draft or annotation output';
    return null;
  }
}

interface ProbeContext {
  path: string;
  ctx: PathContext;
  probe: ContentProbe;
  /** Only part of the file was read, so a missing marker proves nothing. */
  partial: boolean;
  /** Appended to every detail (history: the commit). */
  suffix: string;
  /** The caller judges the fixture-name marker rule itself (history does, from the pass-1 name list). */
  skipRequiredMarker?: boolean;
}

/** Marker, export-shape and GCR-output findings for a text that has been fed to a probe. */
function probeFindings(p: ProbeContext): Finding[] {
  const out: Finding[] = [];
  const hasMarker = p.probe.hasMarker;
  if (!hasMarker) {
    if (requiresSyntheticMarker(p.ctx)) {
      if (p.skipRequiredMarker !== true) {
        const why = p.partial
          ? 'raw-export-shaped fixture is larger than the scan limit, so the synthetic-fixture marker cannot be verified'
          : 'raw-export-shaped fixture does not contain the synthetic-fixture marker';
        out.push(markerMissingFinding(p.path, `${why}${p.suffix}`));
      }
    } else if (p.probe.exportShape(isDataLikeName(p.ctx.base))) {
      out.push(markerMissingFinding(p.path, `file has the shape of a raw conversation export but does not contain the synthetic-fixture marker${p.suffix}`));
    }
  }
  const output = p.probe.gcrOutput();
  if (output !== null && !(p.ctx.underFixtures && hasMarker)) {
    out.push({
      rule: 'gcr-output-file',
      path: p.path,
      detail: `file looks like ${output}; GCR output holds titles, entity labels and conversation text and must not be committed (a synthetic file under fixtures/ needs the synthetic-fixture marker)${p.suffix}`,
    });
  }
  return out;
}

interface Listing {
  listed: number;
  done: boolean;
}

/**
 * Apply the content rules to every line of `text`. `numbered` is false for a window whose position in the file is not
 * known (the tail of a large file): its findings carry no line number rather than a wrong one.
 */
function scanBody(path: string, rules: readonly ContentRule[], text: string, numbered: boolean, listing: Listing, out: Finding[], suffix: string): void {
  let pos = 0;
  let lineNo = 0;
  while (pos <= text.length && !listing.done) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    lineNo++;
    for (const hit of lineHits(rules, text.slice(pos, nl))) {
      if (listing.listed === MAX_FINDINGS_PER_FILE) {
        // Bounded output and memory: a file can match hundreds of thousands of times; one summary replaces the rest.
        out.push({ rule: 'too-many-findings', path, detail: TOO_MANY_FINDINGS_DETAIL });
        listing.done = true;
        break;
      }
      const finding: Finding = { rule: hit.rule, path, detail: `${hit.detail}${suffix}` };
      if (numbered) finding.line = lineNo;
      out.push(finding);
      listing.listed++;
    }
    pos = nl + 1;
  }
}

/** The part of a large file that was not its first window, decoded; `partial` says bytes in between were never read. */
interface TextWindows {
  tail: string | null;
  partial: boolean;
}

const TAIL_SUFFIX = ' [in the last bytes of a large file]';

function textFindings(path: string, content: string, byteLength: number, windows: TextWindows | null = null): Finding[] {
  const ctx = pathContext(path);
  const out: Finding[] = [];
  const sizeFinding = fixtureSizeFinding(path, byteLength);
  if (sizeFinding !== null) out.push(sizeFinding);
  const probe = new ContentProbe();
  probe.add(content);
  if (windows?.tail !== undefined && windows.tail !== null) probe.add(windows.tail);
  appendAll(out, probeFindings({ path, ctx, probe, partial: windows?.partial === true, suffix: '' }));
  const rules = activeRules(ctx);
  const listing: Listing = { listed: 0, done: false };
  scanBody(path, rules, content, true, listing, out, '');
  if (windows?.tail !== undefined && windows.tail !== null) scanBody(path, rules, windows.tail, false, listing, out, TAIL_SUFFIX);
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
function gitEnv(honourIndexFile: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Staged mode keeps GIT_INDEX_FILE on purpose: for `git commit -a` and `git commit <paths>` git runs the pre-commit hook
    // against a TEMPORARY index, and the staged scan must judge exactly that index. Every other location variable is dropped.
    if (honourIndexFile && k === 'GIT_INDEX_FILE') {
      env[k] = v;
      continue;
    }
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
async function runGit(root: string, args: readonly string[], maxBytes: number, opts: { honourIndexFile?: boolean } = {}): Promise<{ stdout: Buffer; truncated: boolean }> {
  // core.fsmonitor from the repository's own config is EXECUTED by ls-files/diff/status; forcing it off means scanning
  // an untrusted clone cannot run code. --no-optional-locks keeps the scan from writing to the index.
  // protocol.allow=never blocks every transport, so even a git that predates GIT_NO_LAZY_FETCH cannot reach a remote.
  const full = ['--no-optional-locks', '-C', root, '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args];
  try {
    const { stdout } = await execFileAsync('git', full, { encoding: 'buffer', maxBuffer: Math.max(1, maxBytes), env: gitEnv(opts.honourIndexFile === true), windowsHide: true });
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
  /** Paths with at least one added line (in any commit) that contains the synthetic marker. */
  markerPaths: Set<string>;
}

interface PatchScanOptions {
  /**
   * `<commit>\u0000<path>` of every file ADDED by a commit. Only the sections of these files are judged for export shape
   * and GCR-output shape: a patch of a MODIFIED file shows a few changed lines, from which "this file has the shape of an
   * export" (or "has no marker") cannot be decided.
   */
  addedKeys?: ReadonlySet<string>;
  /**
   * History: also judge the export SHAPE of the lines a commit added to a data-like file that already existed (a stub that was
   * filled with an export later). A hunk shows only a few lines, so a finding is dropped when the path carries the synthetic marker in
   * ANY commit's added lines (the marker may sit in a line this commit did not touch) and files under fixtures/ are not judged here.
   */
  judgeModifications?: boolean;
  /** Report content-rule findings only for these paths (staged mode: the blobs that could not be read in full). */
  onlyPaths?: ReadonlySet<string>;
}

/** First characters of a file that make a shape judgement worthwhile for a name that is not data-like (JSON, HTML, Markdown preamble). */
const SHAPE_WORTHWHILE_LEAD = /^[\uFEFF\s]*[[{<#]/;

function scanPatchText(text: string, allow: ReadonlySet<string>, suffix: (commit: string) => string, opts: PatchScanOptions = {}): AddedLineScan {
  const result: AddedLineScan = { findings: [], commitsSeen: new Set(), markerSeen: new Set(), markerPaths: new Set() };
  const deferred: Finding[] = []; // shape findings for modified files, decided once every marker in the stream is known
  let commit = '';
  let path: string | null = null;
  let rules: readonly ContentRule[] = [];
  const fileInfo = new Map<string, readonly ContentRule[]>();
  // Same per-file bound as the work-tree scan, applied to each file section of each commit.
  let listed = 0;
  let suppressed = false;
  // The shape of a file is judged from ALL its added lines (a stronger check than a head window): the probe keeps a few
  // flags and the first characters, never the lines. `decided` is false until the first added line with content says whether the
  // section is worth probing at all (a name that is not data-like and does not start like JSON, HTML or Markdown is not).
  const section: { probe: ContentProbe | null; path: string; commit: string; decided: boolean; modification: boolean } = {
    probe: null,
    path: '',
    commit: '',
    decided: false,
    modification: false,
  };
  const endSection = (): void => {
    if (section.probe !== null) {
      const found = probeFindings({ path: section.path, ctx: pathContext(section.path), probe: section.probe, partial: false, suffix: suffix(section.commit), skipRequiredMarker: true });
      // The first lines of a modification say nothing about the kind of file, so only the shape of its added lines is judged, and later.
      if (section.modification) appendAll(deferred, found.filter((f) => f.rule === 'synthetic-marker-missing'));
      else appendAll(result.findings, found);
    }
    section.probe = null;
    section.decided = false;
    section.modification = false;
  };
  parsePatch(text, {
    commit(hash) {
      commit = hash;
      if (hash !== '') result.commitsSeen.add(hash);
    },
    file(p) {
      endSection();
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
        if (opts.addedKeys?.has(`${commit}\u0000${path}`) === true) {
          section.probe = new ContentProbe();
          section.path = path;
          section.commit = commit;
        } else if (opts.judgeModifications === true && isDataLikeName(pathContext(path).base) && !pathContext(path).underFixtures) {
          section.probe = new ContentProbe();
          section.path = path;
          section.commit = commit;
          section.modification = true;
        }
      }
    },
    added(lineNo, line) {
      if (path === null) return;
      if (line.includes(SYNTHETIC_MARKER)) {
        result.markerSeen.add(`${commit}\u0000${path}`);
        result.markerPaths.add(path);
      }
      if (section.probe !== null) {
        // Blank lines in front of the first line with content (or a lone byte-order mark) say nothing about the file: keep waiting.
        if (!section.decided && /\S/.test(line)) {
          section.decided = true;
          if (!isDataLikeName(pathContext(path).base) && !SHAPE_WORTHWHILE_LEAD.test(line)) section.probe = null;
        }
        section.probe?.add(line);
      }
      if (suppressed) return;
      if (opts.onlyPaths !== undefined && !opts.onlyPaths.has(path)) return;
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
  endSection();
  for (const f of deferred) if (!result.markerPaths.has(f.path)) result.findings.push(f);
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
/** Pseudo paths for findings that concern a whole scan pass rather than one file. */
const HISTORY_PSEUDO_PATH = '(git history)';
const STAGED_DIFF_PSEUDO_PATH = '(staged diff)';

async function scanHistory(root: string, allow: ReadonlySet<string>, byteCap: number, allowLarge: boolean): Promise<{ findings: Finding[]; stats: HistoryStats; notes: string[] }> {
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
  const scanned = scanPatchText(patch.stdout.toString('utf8'), allow, (c) => ` [in history, commit ${shortCommit(c)}]`, { addedKeys: added, judgeModifications: true });
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
    const why = `history scan truncated after ${bytesRead} bytes (cap ${byteCap}): older history was NOT fully scanned; raise the cap to scan more`;
    notes.push(why);
    // Fail closed: history the scanner could not read is history it could not judge.
    if (!allowLarge) findings.push({ rule: 'scan-truncated', path: HISTORY_PSEUDO_PATH, detail: why });
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

interface FileOutcome {
  kind: 'scanned' | 'large' | 'binary' | 'nonregular' | 'allowed';
  findings: Finding[];
  /** A large file was judged only in part and that is NOT reported (excluded directory, or `allowLargeUnscanned`). */
  unscannedSuppressed?: boolean;
}

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

/** The tail window has no byte-order mark of its own; it is decoded like the head it follows (UTF-16 windows start on an even offset). */
function decodeTail(head: Buffer, tail: Buffer): string | null {
  const even = tail.subarray(0, tail.length - (tail.length % 2));
  if (head[0] === 0xff && head[1] === 0xfe) return even.toString('utf16le');
  if (head[0] === 0xfe && head[1] === 0xff) return Buffer.from(even).swap16().toString('utf16le');
  if (tail.includes(0)) return null;
  return tail.toString('utf8');
}

// ---- large files: bounded windows ---------------------------------------------------------------------------------------------

/** What was read of a file or staged blob. */
interface FileWindows {
  /** Full size in bytes. */
  size: number;
  /** The first bytes: the whole content unless `partial`. */
  head: Buffer;
  /** The last bytes when they are not already part of `head`; null when there are none or none could be read (a staged blob). */
  tail: Buffer | null;
  /** True when bytes between `head` and `tail` (or after `head`) were never read. */
  partial: boolean;
}

interface InspectOptions {
  allowLarge: boolean;
}

// O_NOFOLLOW: a symlink swapped in between the lstat and the open is refused instead of followed out of the repository.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, position + filled);
    if (bytesRead === 0) break; // the file shrank while it was being read
    filled += bytesRead;
  }
  return buf.subarray(0, filled);
}

/**
 * Read a work-tree file. Up to `max(maxFileBytes, head + tail)` bytes it is read whole; above that only the two windows
 * are read, so memory stays flat however large the file is.
 */
async function readWindows(abs: string, size: number, maxFileBytes: number): Promise<FileWindows> {
  if (size <= Math.max(maxFileBytes, LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES)) {
    const whole = await readFile(abs);
    return { size: whole.length, head: whole, tail: null, partial: false };
  }
  const handle = await open(abs, READ_FLAGS);
  try {
    const head = await readExact(handle, 0, LARGE_FILE_HEAD_BYTES);
    const tailLength = Math.min(LARGE_FILE_TAIL_BYTES, size - LARGE_FILE_HEAD_BYTES);
    const tail = await readExact(handle, size - tailLength, tailLength);
    return { size, head, tail, partial: true };
  } finally {
    await handle.close();
  }
}

/**
 * Directories whose content is generated or third-party and is never committed (.gitignore): a large file there is not reported as
 * unscanned. Judged on the repository path itself, split at '/' only: on POSIX a backslash is an ordinary file-name character, so
 * `dist\big.json` is a file in the root, not a file in `dist/` (the classification of the other path rules folds backslashes the
 * other way round, which is right for them: it can only make a rule fire more often).
 */
function isExcludedBulkPath(path: string): boolean {
  if (path.includes('\\')) return false;
  const segments = path.split('/');
  if (segments.length < 2) return false;
  const first = segments[0] ?? '';
  return segments.slice(0, -1).includes('node_modules') || first === 'dist' || first === 'coverage' || first.startsWith('dist-test');
}

/**
 * Outcome for a file that was judged only through its windows: a failing `unscanned-large-file` finding, unless the path
 * is below an excluded directory or the caller accepted partial coverage (`allowLarge`). Allow-listed paths never get here.
 */
function partialOutcome(path: string, w: FileWindows, findings: Finding[], opts: InspectOptions, binary: boolean): FileOutcome {
  if (isExcludedBulkPath(path) || opts.allowLarge) return { kind: 'large', findings, unscannedSuppressed: true };
  const covered = w.head.length + (w.tail?.length ?? 0);
  const windows = w.tail === null ? `its first ${w.head.length} bytes` : `its first ${w.head.length} and last ${w.tail.length} bytes`;
  findings.push({
    rule: 'unscanned-large-file',
    path,
    detail:
      `file is ${w.size} bytes and above the scan limit: only ${windows} were scanned${binary ? ' (it looks binary, so only the path and signature rules apply)' : ''}, ` +
      `the other ${w.size - covered} bytes were NOT judged; remove it from the repository, or list its exact path in ${ALLOW_FILE_NAME} once it is known to be safe`,
  });
  return { kind: 'large', findings };
}

/**
 * A file with NUL bytes is not text, but an uncompressed container (a tar, a ZIP entry stored without compression, a
 * database page) still holds the export's JSON verbatim. The shape keys are looked for in the raw bytes, whatever the name.
 */
function binaryShapeFinding(path: string, w: FileWindows): Finding | null {
  const probe = new ContentProbe();
  probe.add(w.head.toString('latin1'));
  if (w.tail !== null) probe.add(w.tail.toString('latin1'));
  if (probe.hasMarker || !probe.exportShape(true)) return null;
  return markerMissingFinding(path, 'binary file contains the keys of a raw conversation export (an uncompressed archive or container?) but not the synthetic-fixture marker');
}

/** Judge what was read of one file with every content rule. `findings` already holds the path-rule findings. */
function inspectWindows(path: string, w: FileWindows, findings: Finding[], opts: InspectOptions): FileOutcome {
  const ctx = pathContext(path);
  // A file whose NAME already gives it away is not reported a second time for its content signature.
  if (!findings.some((f) => f.rule === 'forbidden-extension')) {
    // The first bytes are read even for a file too large to read in full: a renamed database or archive is exactly the kind of file that is large.
    const sig = signatureFinding(path, w.head.subarray(0, SIGNATURE_BYTES));
    if (sig !== null) findings.push(sig);
  }
  const text = decodeText(w.head);
  if (text === null) {
    const sizeFinding = fixtureSizeFinding(path, w.size);
    if (sizeFinding !== null) findings.push(sizeFinding);
    if (requiresSyntheticMarker(ctx) && !w.head.includes(SYNTHETIC_MARKER) && !(w.tail?.includes(SYNTHETIC_MARKER) ?? false)) {
      findings.push(
        markerMissingFinding(
          path,
          w.partial
            ? 'raw-export-shaped fixture is binary and larger than the scan limit, so the synthetic-fixture marker cannot be verified'
            : 'raw-export-shaped fixture is binary and does not contain the synthetic-fixture marker',
        ),
      );
    }
    const shape = binaryShapeFinding(path, w);
    if (shape !== null) findings.push(shape);
    return w.partial ? partialOutcome(path, w, findings, opts, true) : { kind: 'binary', findings };
  }
  if (!w.partial) {
    appendAll(findings, textFindings(path, text, w.size));
    return { kind: 'scanned', findings };
  }
  const tail = w.tail === null ? null : decodeTail(w.head, w.tail);
  appendAll(findings, textFindings(path, text, w.size, { tail, partial: true }));
  // A tail that cannot be decoded (NUL bytes in a file that starts as text) is bytes that were not judged either.
  return partialOutcome(path, w, findings, opts, w.tail !== null && tail === null);
}

async function scanOneFile(root: string, path: string, allow: ReadonlySet<string>, maxFileBytes: number, opts: InspectOptions): Promise<FileOutcome> {
  if (allow.has(path)) return { kind: 'allowed', findings: [] };
  const findings = pathRuleFindings(path);
  if (path.includes('\uFFFD')) {
    // git hands over raw bytes; a non-UTF-8 name decodes lossily, so the real file cannot be opened by that string.
    // Fail closed with a finding rather than treating it as a deleted file.
    findings.push({ rule: 'unreadable-file', path, detail: 'path is not valid UTF-8, so the file cannot be opened by name; content was not scanned' });
    return { kind: 'nonregular', findings };
  }
  const ctx = pathContext(path);
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
    if (requiresSyntheticMarker(ctx)) findings.push(markerMissingFinding(path, 'raw-export-shaped fixture is not a regular file, so the synthetic-fixture marker cannot be verified'));
    return { kind: 'nonregular', findings };
  }
  let windows: FileWindows;
  try {
    windows = await readWindows(abs, st.size, maxFileBytes);
  } catch (e) {
    findings.push({ rule: 'unreadable-file', path, detail: `could not read file (${errorCode(e) ?? 'error'}); content was not scanned` });
    return { kind: 'nonregular', findings };
  }
  return inspectWindows(path, windows, findings, opts);
}

// ---- staged mode: the index, not the work tree --------------------------------------------------------------------------------

interface StagedEntry {
  path: string;
  /** Octal mode of the staged file: 100644/100755 regular, 120000 symlink, 160000 submodule. */
  mode: string;
  sha: string;
}

/** `git diff --cached --raw -z`: `:<old mode> <new mode> <old sha> <new sha> <status>` NUL `<path>` NUL, one pair per changed path. */
function parseStagedRaw(stdout: Buffer): StagedEntry[] {
  const tokens = stdout.toString('utf8').split('\u0000');
  const entries: StagedEntry[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])[0-9]*$/.exec(tokens[i] ?? '');
    const path = tokens[i + 1] ?? '';
    if (meta === null || path === '') continue;
    entries.push({ mode: meta[2] ?? '', sha: meta[4] ?? '', path });
  }
  return entries.sort((a, b) => cmp(a.path, b.path));
}

/**
 * Read a staged blob (never the work-tree file, which may differ). Up to `max(maxFileBytes, head + tail)` bytes it is
 * read whole; beyond that git's output is cut at that size, only the head window is judged, and the blob's added lines
 * are additionally covered by the staged-diff pass. `cat-file` cannot seek, so a staged blob has no tail window.
 */
async function readBlobWindows(root: string, sha: string, maxFileBytes: number): Promise<FileWindows> {
  const limit = Math.max(maxFileBytes, LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES);
  const blob = await runGit(root, ['cat-file', 'blob', sha], limit + 1);
  if (!blob.truncated) return { size: blob.stdout.length, head: blob.stdout, tail: null, partial: false };
  const sizeText = (await runGit(root, ['cat-file', '-s', sha], 64)).stdout.toString('utf8').trim();
  const size = /^[0-9]{1,15}$/.test(sizeText) ? Number(sizeText) : blob.stdout.length;
  return { size, head: blob.stdout.subarray(0, LARGE_FILE_HEAD_BYTES), tail: null, partial: true };
}

async function scanStagedEntry(root: string, entry: StagedEntry, allow: ReadonlySet<string>, maxFileBytes: number, opts: InspectOptions): Promise<FileOutcome> {
  const { path } = entry;
  if (allow.has(path)) return { kind: 'allowed', findings: [] };
  const findings = pathRuleFindings(path);
  if (path.includes('\uFFFD')) {
    findings.push({ rule: 'unreadable-file', path, detail: 'path is not valid UTF-8, so the staged file cannot be named; content was not scanned' });
    return { kind: 'nonregular', findings };
  }
  if (entry.mode === '120000' || entry.mode === '160000') {
    // A symlink or submodule commit records a target, not content.
    if (requiresSyntheticMarker(pathContext(path))) findings.push(markerMissingFinding(path, 'raw-export-shaped fixture is not a regular file, so the synthetic-fixture marker cannot be verified'));
    return { kind: 'nonregular', findings };
  }
  let windows: FileWindows;
  try {
    windows = await readBlobWindows(root, entry.sha, maxFileBytes);
  } catch (e) {
    if (e instanceof GcrError && e.code === 'INVALID_ARGUMENT') throw e; // partial clone: nothing sensible to report per file
    findings.push({ rule: 'unreadable-file', path, detail: 'could not read the staged file from the object database; content was not scanned' });
    return { kind: 'nonregular', findings };
  }
  return inspectWindows(path, windows, findings, opts);
}

// ---- the scan -----------------------------------------------------------------------------------------------------------------------

/** At most this many paths are named in the note about large files that were left partly unjudged. */
const NOTE_PATH_LIMIT = 10;

export async function scanRepo(root: string, opts: RepoScanOptions = {}): Promise<RepoScanResult> {
  const maxFileBytes = requirePositiveInteger('maxFileBytes', opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const byteCap = requirePositiveInteger('maxHistoryBytes', opts.maxHistoryBytes, DEFAULT_MAX_HISTORY_BYTES);
  const stagedMode = opts.staged === true;
  if (stagedMode && opts.history === true) {
    throw new GcrError('INVALID_ARGUMENT', 'staged and history cannot be combined: the staged scan judges the index, the history scan judges commits');
  }
  const allowLarge = opts.allowLargeUnscanned === true;
  const inspect: InspectOptions = { allowLarge };
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
  const findings: Finding[] = [...allowFindings];
  const notes: string[] = [];
  let outcomes: FileOutcome[];
  let paths: string[];

  if (stagedMode) {
    // The pre-commit hook's view: only what is about to be recorded, read from the index the commit will use.
    const raw = await runGit(rootAbs, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--diff-filter=AMT'], 256 * 1024 * 1024, { honourIndexFile: true });
    if (raw.truncated) throw new GcrError('INTERNAL_ERROR', 'staged file listing exceeded its size bound');
    const entries = parseStagedRaw(raw.stdout);
    paths = entries.map((e) => e.path);
    outcomes = await mapLimit(entries, FILE_READ_CONCURRENCY, (e) => scanStagedEntry(rootAbs, e, allow, maxFileBytes, inspect));
    // A blob that was read only in part, or not decoded, still has all its ADDED lines in the staged diff.
    const partial = new Set(paths.filter((_, i) => outcomes[i]?.kind === 'large' || outcomes[i]?.kind === 'binary'));
    if (partial.size > 0) {
      const diff = await runGit(rootAbs, ['diff', '--cached', ...PATCH_FLAGS], byteCap, { honourIndexFile: true });
      if (diff.truncated) truncationFinding(findings, notes, STAGED_DIFF_PSEUDO_PATH, `staged-diff scan truncated after ${diff.stdout.length} bytes (cap ${byteCap}): part of the index was NOT scanned`, allowLarge);
      appendAll(findings, scanPatchText(diff.stdout.toString('utf8'), allow, () => '', { onlyPaths: partial }).findings);
    }
  } else {
    const listing = await runGit(rootAbs, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 256 * 1024 * 1024);
    if (listing.truncated) throw new GcrError('INTERNAL_ERROR', 'file listing exceeded its size bound');
    paths = [...new Set(listing.stdout.toString('utf8').split('\u0000').filter((p) => p !== ''))].sort(cmp);
    outcomes = await mapLimit(paths, FILE_READ_CONCURRENCY, (p) => scanOneFile(rootAbs, p, allow, maxFileBytes, inspect));
  }

  const counts = { scanned: 0, large: 0, binary: 0, nonregular: 0, allowed: 0 };
  const suppressedPaths: string[] = [];
  outcomes.forEach((o, i) => {
    counts[o.kind]++;
    appendAll(findings, o.findings);
    if (o.unscannedSuppressed === true) suppressedPaths.push(paths[i] ?? '');
  });
  if (suppressedPaths.length > 0) {
    const shown = suppressedPaths.slice(0, NOTE_PATH_LIMIT).map((p) => safeText(p)).join(', ');
    const more = suppressedPaths.length > NOTE_PATH_LIMIT ? `, and ${suppressedPaths.length - NOTE_PATH_LIMIT} more` : '';
    notes.push(`${suppressedPaths.length} large file(s) were judged only in part and not reported (excluded directory or --allow-large-unscanned): ${shown}${more}`);
  }

  if (!stagedMode) {
    // Staged content can differ from the work tree (secret staged, then edited away without re-staging); a commit would
    // still contain the staged version, so added lines in the index are scanned as well.
    const workTreeKeys = new Set(findings.map(findingKey));
    const staged = await runGit(rootAbs, ['diff', '--cached', ...PATCH_FLAGS], byteCap);
    if (staged.truncated) truncationFinding(findings, notes, STAGED_DIFF_PSEUDO_PATH, `staged-diff scan truncated after ${staged.stdout.length} bytes (cap ${byteCap}): part of the index was NOT scanned`, allowLarge);
    for (const f of scanPatchText(staged.stdout.toString('utf8'), allow, () => '').findings) {
      if (!workTreeKeys.has(findingKey(f))) findings.push({ ...f, detail: `${f.detail} [staged]` });
    }
  }

  let history: HistoryStats | null = null;
  if (opts.history === true) {
    const h = await scanHistory(rootAbs, allow, byteCap, allowLarge);
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
    unscannedLarge: suppressedPaths.length,
    staged: stagedMode,
    history,
    notes,
  };
}

/** Coverage that stopped at a byte cap is a finding (fail closed) unless the caller accepted partial coverage; the note is always kept. */
function truncationFinding(findings: Finding[], notes: string[], path: string, why: string, allowLarge: boolean): void {
  notes.push(why);
  if (!allowLarge) findings.push({ rule: 'scan-truncated', path, detail: why });
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
  'Usage: privacy-scan [--root <dir>] [--history | --staged] [--json] [--max-file-bytes <n>] [--max-history-bytes <n>] [--allow-large-unscanned]',
  '',
  '  --root <dir>             repository top level to scan (default: current directory)',
  '  --history                also scan every path and added line in all refs (bounded; a cut is a finding)',
  '  --staged                 scan what `git commit` would record, read from the index (for the pre-commit hook);',
  '                           cannot be combined with --history',
  '  --json                   machine-readable output (secrets are masked here too)',
  `  --max-file-bytes <n>     files larger than n bytes are judged only through their first ${LARGE_FILE_HEAD_BYTES / 1024} KiB and last ${LARGE_FILE_TAIL_BYTES / 1024} KiB`,
  '                           and reported as unscanned-large-file (default 2097152)',
  '  --max-history-bytes <n>  byte cap for each git history/staging query set (default 67108864)',
  '  --allow-large-unscanned  LOCAL USE ONLY: report unscanned-large-file and scan-truncated as notes, not findings.',
  '                           A clean result then does not prove the repository is clean; CI never uses this flag.',
  '',
  'Exit status: 0 clean, 1 findings, 2 error.',
  '',
].join('\n');

interface CliArgs {
  root: string;
  history: boolean;
  staged: boolean;
  json: boolean;
  help: boolean;
  allowLargeUnscanned: boolean;
  maxFileBytes?: number;
  maxHistoryBytes?: number;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { root: process.cwd(), history: false, staged: false, json: false, help: false, allowLargeUnscanned: false };
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
      case '--staged':
        args.staged = true;
        break;
      case '--allow-large-unscanned':
        args.allowLargeUnscanned = true;
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
  if (args.staged && args.history) throw new GcrError('INVALID_ARGUMENT', '--staged and --history cannot be combined');
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
    const options: RepoScanOptions = { history: args.history, staged: args.staged, allowLargeUnscanned: args.allowLargeUnscanned };
    if (args.maxFileBytes !== undefined) options.maxFileBytes = args.maxFileBytes;
    if (args.maxHistoryBytes !== undefined) options.maxHistoryBytes = args.maxHistoryBytes;
    const result = await scanRepo(args.root, options);
    const exitCode = result.findings.length > 0 ? 1 : 0;
    if (args.json) {
      return { exitCode, stdout: `${JSON.stringify({ ok: exitCode === 0, ...result }, null, 2)}\n`, stderr: '' };
    }
    const summary =
      `privacy-scan: ${result.findings.length === 0 ? 'clean' : `${result.findings.length} finding(s)`}; ` +
      `${result.scannedFiles} ${result.staged ? 'staged ' : ''}file(s) scanned, skipped ${result.skippedLarge} large / ${result.skippedBinary} binary / ${result.skippedNonRegular} non-regular, ` +
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
