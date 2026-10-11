/**
 * Container discovery for the import runner (SPEC FR-02/FR-09/FR-10; docs/ARCHITECTURE.md section 5; research
 * notes "chatgpt-export-format" section 9 Layer 0 and section 11.1).
 *
 * `discoverInput` answers ONE question: "which conversation files are in this input, in which order, and what else
 * is around them?". It never parses a conversation and never reads auxiliary data.
 *
 * Security model (read before changing anything):
 *  - The input is hostile until proven otherwise. ZIP names are validated by SafeZipReader and are only ever used as
 *    lookup keys. Directory names are used as file-system paths ONLY after an lstat showed a regular file, and the
 *    file is then opened with O_NOFOLLOW so a symlink swapped in between the two calls is refused (no TOCTOU escape).
 *  - Directories are walked with an explicit depth cap and an entry cap. Symlinks are NEVER followed (lstat), so a
 *    symlink loop or a link out of the tree cannot make the walk escape or run forever. FIFOs/devices are skipped
 *    (opening a FIFO would block) and every open uses O_NONBLOCK.
 *  - Only files whose basename matches the conversation pattern, plus export_manifest.json, are ever opened. The
 *    well-known auxiliary files (user.json, message_feedback.json, ...) contain personal data (e-mail address, phone
 *    number, feedback text, shared-link ids): they are counted by NAME and NEVER read. All other files are listed by
 *    name only, to tell the adapters which attachments really exist in the export.
 *  - Nested ZIPs multiply decompression-bomb risk, so ONE level is supported, the inflated inner archive is held in
 *    memory under `maxNestedZipBytes`, and every byte (outer entries, inner archives, both import passes) is charged
 *    against ONE shared budget derived from `limits.maxTotalInflatedBytes`.
 *  - Error messages carry the BASENAME of the user-supplied path at most, never an absolute path, and never an
 *    untrusted entry name unsanitized. fs errors are mapped to GcrError WITHOUT attaching the raw error as `cause`
 *    (Node's message embeds the full path).
 *
 * Detection is by CONTENT SIGNATURE, not by extension: `PK\x03\x04` / `PK\x05\x06` start a ZIP, `[` or `{` (after an
 * optional UTF-8 BOM and whitespace) start JSON/NDJSON text, UTF-16/UTF-32 byte order marks are refused with a remedy,
 * and any other start gets one chance as a ZIP whose local data is preceded by a stub (SafeZipReader's EOCD scan).
 */
import { constants as fsConstants } from 'node:fs';
import type { Dir, Stats } from 'node:fs';
import { lstat, open as fsOpen, opendir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FormatProfile } from '../domain/results.js';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { resolveLimits } from './limits.js';
import type { ImportLimits } from './limits.js';
import { SafeZipReader, sanitizeEntryName } from './zip.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------------------------------------------

export type InputSource =
  | { kind: 'path'; path: string }
  | { kind: 'stream'; stream: AsyncIterable<Buffer | Uint8Array>; label: string };

export interface DiscoveredFile {
  /** Normalized relative name inside the container (forward slashes). Nested archives: `<outer entry>!/<inner name>`. */
  name: string;
  /** 0-based position in the deterministic processing order (plain conversations.json first, then numeric shards). */
  order: number;
  /** A fresh, independent byte stream per call (the runner reads every file twice). Errors surface while iterating. */
  open(): AsyncIterable<Buffer>;
  /** Uncompressed / on-disk size when known (an upper bound for ZIP entries). */
  sizeHint: number | null;
}

export interface Discovery {
  layout: FormatProfile['layout'];
  /** Where the bytes live; becomes `source_batches.source_kind` ('zip' | 'conversations_json' | 'directory' | 'stdin_json'). */
  sourceKind: 'zip' | 'conversations_json' | 'directory' | 'stdin_json';
  /** Basename of the input (or the sanitized stream label); never an absolute path. */
  sourceLabel: string | null;
  files: DiscoveredFile[];
  manifest: FormatProfile['manifest'];
  /** Names (never contents) of the non-conversation, non-auxiliary files present; feeds AttachmentRef.presentInExportAs. */
  assetNames: Set<string>;
  /** Well-known auxiliary files that exist but are NEVER read (PII). */
  auxiliaryFilesIgnored: number;
  /** true when asset names look like `<id>.dat` (the extension-less 2026 naming). */
  assetsExtensionless: boolean;
  warnings: Warning[];
  close(): Promise<void>;
}

export interface DiscoverOptions {
  /** Reserved: the provider hint does not change which files are looked for. */
  provider?: 'chatgpt' | 'claude';
  /**
   * How many times the caller reads each conversation file (the import runner reads twice). The cumulative inflate
   * budget of a ZIP is `limits.maxTotalInflatedBytes * passes`, i.e. the configured budget applies PER PASS.
   */
  passes?: number;
  /** Override MAX_NESTED_ZIP_BYTES (positive integer). */
  maxNestedZipBytes?: number;
}

/** Largest nested archive entry (uncompressed) that is inflated into memory. ImportLimits is a contract file, so the limit lives here. */
export const MAX_NESTED_ZIP_BYTES = 256 * 1024 * 1024;
/** All nested archives together may occupy at most this many times `maxNestedZipBytes` of memory. */
export const NESTED_AGGREGATE_FACTOR = 4;
/** `export_manifest.json` larger than this is not read (warning, never a failure). */
export const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
/** Directory walk: folders deeper than this many levels below the chosen root are not entered. */
export const DIRECTORY_MAX_DEPTH = 4;
/** stdin is buffered (two passes need two reads) up to `limits.maxElementBytes * STDIN_BUFFER_FACTOR`. */
export const STDIN_BUFFER_FACTOR = 4;

/** Basename rule for conversation files, case-insensitive, any depth. Group 1 = shard number. */
export const CONVERSATION_FILE_RE = /^conversations(?:-(\d+))?\.json$/i;
const MANIFEST_FILE_RE = /^export_manifest\.json$/i;

/**
 * Well-known auxiliary files (research section 2.2). They are NEVER read: user.json holds an e-mail address and a phone
 * number, the feedback/shared-link/library files hold free text and ids. Matching is by lower-cased basename.
 */
export const AUXILIARY_FILE_NAMES: ReadonlySet<string> = new Set([
  'user.json',
  'user_settings.json',
  'message_feedback.json',
  'shared_conversations.json',
  'model_comparisons.json',
  'group_chats.json',
  'library_files.json',
  'conversation_asset_file_names.json',
  'chat.html',
  // Claude exports ship similar person/project files; same rule: counted by name, never read.
  'users.json',
  'projects.json',
]);

const READ_CHUNK_BYTES = 256 * 1024;
const HEAD_BYTES = 4096;
const MAX_MANIFEST_IDS = 50;
const MAX_NAME_BYTES = 1024;

const REMEDY_FILES =
  'GCR looks for conversations.json or sharded conversations-<N>.json files: anywhere inside a ZIP, up to 4 folder levels deep in an extracted folder, ' +
  'or inside ONE nested "Conversations*.zip". Import the official export ZIP, the extracted folder, or the conversations file itself.';
const REMEDY_NESTING =
  'Extract the inner "Conversations" part archive and import that ZIP, or import the extracted folder. GCR opens only ONE level of nested archives.';
const REMEDY_UTF8 = 'GCR reads UTF-8 only. Re-save the file as UTF-8 (for example with your editor\'s "Save with encoding" option) or download a fresh export.';

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

function errnoOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code: unknown = (e as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Single-line, bounded, printable rendering of an untrusted/user-supplied name for messages. */
function shown(name: string): string {
  return sanitizeEntryName(name, 80);
}

/** Map a file-system failure to a GcrError carrying the BASENAME only; the raw error (full path inside) is dropped. */
function fsFailure(e: unknown, name: string): GcrError {
  const code = errnoOf(e);
  const label = shown(name);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new GcrError('IMPORT_INPUT_NOT_FOUND', `The import path "${label}" does not exist.`, {
      remedy: 'Check the path. GCR never downloads anything: provide a file or folder that is already on this machine.',
      details: { reason: 'NOT_FOUND', name: label },
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new GcrError('IMPORT_INPUT_NOT_FOUND', `The import path "${label}" is not readable.`, {
      remedy: 'Check the file permissions.',
      details: { reason: 'NOT_READABLE', name: label },
    });
  }
  if (code === 'ELOOP') {
    return new GcrError('IMPORT_UNSUPPORTED_FORMAT', `"${label}" is a symbolic link; GCR never follows symbolic links inside an import.`, {
      remedy: 'Copy the real file next to the others, or import the extracted folder after removing the link.',
      details: { reason: 'SYMLINK_REFUSED', name: label },
    });
  }
  if (code === 'EISDIR') {
    return new GcrError('IMPORT_UNSUPPORTED_FORMAT', `"${label}" is a directory where a file was expected.`, { remedy: REMEDY_FILES, details: { reason: 'IS_DIRECTORY', name: label } });
  }
  return new GcrError('INTERNAL_ERROR', `Failed to read the import input "${label}".`, {
    remedy: 'Check that the input is still present and readable, then retry.',
    details: { reason: 'READ_FAILED', name: label, ...(code === undefined ? {} : { errno: code }) },
  });
}

function noConversationFiles(entriesSeen: number, extra: Record<string, unknown> = {}): GcrError {
  return new GcrError('IMPORT_UNSUPPORTED_FORMAT', 'No conversation file (conversations.json or conversations-<N>.json) was found in the input.', {
    remedy: REMEDY_FILES,
    details: { reason: 'NO_CONVERSATION_FILE', entriesSeen, ...extra },
  });
}

function notAnExport(label: string, why: string, reason: string): GcrError {
  return new GcrError('IMPORT_UNSUPPORTED_FORMAT', `"${shown(label)}" is not a supported import (${why}).`, { remedy: REMEDY_FILES, details: { reason } });
}

function utf16Error(): GcrError {
  return new GcrError('IMPORT_UNSUPPORTED_FORMAT', 'The file is UTF-16 or UTF-32 encoded; GCR reads UTF-8 only.', {
    remedy: REMEDY_UTF8,
    details: { reason: 'UNSUPPORTED_ENCODING' },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Content-signature classification
// ---------------------------------------------------------------------------------------------------------------

export type HeadKind = 'zip' | 'json' | 'utf16' | 'other';

const isAsciiWs = (b: number): boolean => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/**
 * Classify the first bytes of an input. Exported because the runner applies the same encoding check to every
 * conversation file it opens (a UTF-16 conversations.json inside an otherwise fine ZIP is just as unreadable).
 */
export function classifyHead(head: Uint8Array): HeadKind {
  const n = head.length;
  const b = (i: number): number => head[i] ?? -1;
  if (n >= 2 && b(0) === 0x50 && b(1) === 0x4b && ((b(2) === 3 && b(3) === 4) || (b(2) === 5 && b(3) === 6) || (b(2) === 7 && b(3) === 8))) return 'zip';
  // Byte order marks: UTF-32 LE/BE (FF FE 00 00 / 00 00 FE FF) and UTF-16 LE/BE (FF FE / FE FF).
  if (n >= 2 && ((b(0) === 0xff && b(1) === 0xfe) || (b(0) === 0xfe && b(1) === 0xff))) return 'utf16';
  if (n >= 4 && b(0) === 0 && b(1) === 0 && b(2) === 0xfe && b(3) === 0xff) return 'utf16';
  // BOM-less UTF-16: JSON text always starts with an ASCII structural/whitespace byte, so a NUL right beside one is the tell.
  if (n >= 2) {
    const structural = (x: number): boolean => x === 0x5b || x === 0x7b || isAsciiWs(x);
    if ((b(1) === 0 && structural(b(0))) || (b(0) === 0 && structural(b(1)))) return 'utf16';
  }
  let i = 0;
  if (n >= 3 && b(0) === 0xef && b(1) === 0xbb && b(2) === 0xbf) i = 3;
  while (i < n && isAsciiWs(b(i))) i++;
  if (i >= n) return 'json'; // empty / whitespace-only: the JSON layer reports EMPTY_INPUT precisely
  return b(i) === 0x5b || b(i) === 0x7b ? 'json' : 'other';
}

/** Throws the UTF-16 remedy when the head of a conversation file is UTF-16/32 text. Cheap; call on the first chunk. */
export function assertUtf8Head(head: Uint8Array): void {
  if (classifyHead(head) === 'utf16') throw utf16Error();
}

// ---------------------------------------------------------------------------------------------------------------
// Shared candidate collection
// ---------------------------------------------------------------------------------------------------------------

interface ConvCandidate {
  displayName: string;
  /** Name inside its own container (no nested prefix). */
  innerName: string;
  suffix: bigint | null;
  size: number | null;
  open: () => AsyncIterable<Buffer>;
}

interface ManifestCandidate {
  displayName: string;
  innerName: string;
  /** Directory of the manifest inside its container, with trailing slash ('' at the root). */
  dir: string;
  level: number;
  depth: number;
  size: number | null;
  read: () => Promise<Buffer>;
}

interface Collected {
  conv: ConvCandidate[];
  manifests: ManifestCandidate[];
  assetNames: Set<string>;
  auxiliary: number;
  warnings: Warning[];
  nested: boolean;
  /** Regular files seen (conversation, manifest, auxiliary, asset), for the manifest count check. */
  fileCount: number;
}

function newCollected(): Collected {
  return { conv: [], manifests: [], assetNames: new Set(), auxiliary: 0, warnings: [], nested: false, fileCount: 0 };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isJunkName(name: string): boolean {
  const segments = name.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (base.startsWith('._') || base === '.DS_Store') return true;
  return segments.some((s) => s.toLowerCase() === '__macosx');
}

function baseOf(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** Bounded scan for the digits of `conversations-<N>.json`; the number can be arbitrarily long, hence BigInt. */
function shardSuffix(match: RegExpExecArray): bigint | null {
  const digits = match[1];
  return digits === undefined ? null : BigInt(digits);
}

/** Order: plain `conversations.json` first, then ascending INTEGER suffix (2 before 10), ties by name (code units). */
export function compareConversationFiles(a: { suffix: bigint | null; name: string }, b: { suffix: bigint | null; name: string }): number {
  if (a.suffix === null && b.suffix !== null) return -1;
  if (a.suffix !== null && b.suffix === null) return 1;
  if (a.suffix !== null && b.suffix !== null && a.suffix !== b.suffix) return a.suffix < b.suffix ? -1 : 1;
  return cmp(a.name, b.name);
}

function isInfo(message: string): string {
  return `[info] ${message}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest (export_manifest.json): parsed leniently, only ever produces warnings
// ---------------------------------------------------------------------------------------------------------------

interface ManifestOutcome {
  status: FormatProfile['manifest'];
  /** Expected conversation shard paths, relative to the manifest's directory, already validated. */
  expected: string[] | null;
  warnings: Warning[];
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(o: Record<string, unknown>, k: string): unknown {
  return Object.hasOwn(o, k) ? o[k] : undefined;
}

/** A manifest path is usable only when it stays inside the container: no absolute paths, drive letters, `..`, NUL/control chars. */
function safeManifestPath(p: string): string | null {
  if (p.length === 0 || p.length > MAX_NAME_BYTES) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  const q = p.replaceAll('\\', '/');
  if (q.startsWith('/') || /^[A-Za-z]:/.test(q)) return null;
  const segs = q.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.length === 0 || segs.includes('..')) return null;
  return segs.join('/');
}

function parseManifest(buf: Buffer): ManifestOutcome {
  const invalid = (reason: string, message: string): ManifestOutcome => ({
    status: 'invalid',
    expected: null,
    warnings: [{ code: 'MANIFEST_INVALID', message: `export_manifest.json was ignored: ${message}`, ids: [reason] }],
  });
  let parsed: unknown;
  try {
    const text = buf.toString('utf8');
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return invalid('not_json', 'it is not valid JSON.');
  }
  if (!isPlain(parsed)) return invalid('not_object', 'it is not a JSON object.');
  if (own(parsed, 'version') !== 1) return invalid('unknown_version', 'its "version" is missing or not 1 (the only layout GCR knows).');
  const logical = own(parsed, 'logical_files');
  const warnings: Warning[] = [];
  let expected: string[] | null = null;
  if (logical !== undefined) {
    if (!isPlain(logical)) return invalid('logical_files_not_object', '"logical_files" is not an object.');
    const entry = own(logical, 'conversations.json');
    if (entry !== undefined) {
      if (!isPlain(entry)) return invalid('conversations_entry_not_object', '"logical_files[conversations.json]" is not an object.');
      const files = own(entry, 'files');
      if (files !== undefined) {
        if (!Array.isArray(files) || !files.every((f): f is string => typeof f === 'string')) {
          return invalid('files_not_string_array', '"logical_files[conversations.json].files" is not an array of strings.');
        }
        if (files.length > 0) {
          const ok: string[] = [];
          let ignored = 0;
          for (const f of files) {
            const safe = safeManifestPath(f);
            if (safe === null) ignored++;
            else ok.push(safe);
          }
          if (ignored > 0) {
            warnings.push({
              code: 'MANIFEST_INVALID',
              message: `${ignored} manifest path(s) that leave the container or are malformed were ignored.`,
              ids: ['unsafe_paths_ignored'],
            });
          }
          expected = ok;
        }
      }
    }
    const logicalCount = own(parsed, 'logical_files_count');
    if (typeof logicalCount === 'number' && Number.isInteger(logicalCount) && logicalCount !== Object.keys(logical).length) {
      warnings.push({ code: 'MANIFEST_COUNT_MISMATCH', message: 'The manifest\'s logical_files_count differs from the number of logical files it lists.' });
    }
  }
  const exportFiles = own(parsed, 'export_files');
  const exportCount = own(parsed, 'export_files_count');
  if (Array.isArray(exportFiles) && typeof exportCount === 'number' && Number.isInteger(exportCount) && exportCount !== exportFiles.length) {
    warnings.push({ code: 'MANIFEST_COUNT_MISMATCH', message: 'The manifest\'s export_files_count differs from the length of its export_files list.' });
  }
  return { status: 'present', expected, warnings };
}

/** Key used to compare manifest paths with discovered names: case-insensitive, NFC. */
function matchKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

function reconcileManifest(m: ManifestOutcome, dir: string, files: ConvCandidate[]): Warning[] {
  const out: Warning[] = [...m.warnings];
  if (m.status !== 'present' || m.expected === null || m.expected.length === 0) return out;
  const expectedKeys = new Map<string, string>(); // exact (dir-relative) key -> listed path
  for (const p of m.expected) expectedKeys.set(matchKey(dir + p), p);
  const expectedBases = new Set(m.expected.map((p) => matchKey(baseOf(p))));
  const foundExact = new Set(files.map((f) => matchKey(f.innerName)));
  const foundBases = new Set(files.map((f) => matchKey(baseOf(f.innerName))));

  // Listed but absent. A multipart export lists files that live in another part, so the basename also counts as found.
  const missing: string[] = [];
  for (const [key, listed] of expectedKeys) {
    if (!foundExact.has(key) && !foundBases.has(matchKey(baseOf(listed)))) missing.push(listed);
  }
  if (missing.length > 0) {
    out.push({
      code: 'MANIFEST_SHARD_MISSING',
      message: `${missing.length} conversation file(s) listed in export_manifest.json are not in the input.`,
      ids: missing.slice(0, MAX_MANIFEST_IDS).map((n) => shown(n)),
    });
  }
  const unlisted = files.filter((f) => !expectedKeys.has(matchKey(f.innerName)) && !expectedBases.has(matchKey(baseOf(f.innerName))));
  if (unlisted.length > 0) {
    out.push({
      code: 'SHARD_NOT_IN_MANIFEST',
      message: `${unlisted.length} conversation file(s) in the input are not listed in export_manifest.json.`,
      ids: unlisted.slice(0, MAX_MANIFEST_IDS).map((f) => shown(f.displayName)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Finishing: ordering, manifest, layout
// ---------------------------------------------------------------------------------------------------------------

interface FinishArgs {
  collected: Collected;
  sourceKind: Discovery['sourceKind'];
  sourceLabel: string | null;
  close: () => Promise<void>;
  /** Zero-file diagnosis details (entries seen, depth cap hit, ...). */
  entriesSeen: number;
  noFilesExtra?: Record<string, unknown>;
  /** Shared inflate pool for ZIP inputs: conversation files are charged `size * passes` (+ the manifest). */
  pool?: Pool;
  passes: number;
  forceLayout?: FormatProfile['layout'];
}

/** Budget shared by the outer archive, every inner archive and both import passes. */
class Pool {
  private used = 0;
  private readonly total: number;
  constructor(total: number) {
    this.total = total;
  }
  charge(bytes: number): void {
    if (this.used + bytes > this.total) {
      throw new GcrError('IMPORT_LIMIT_EXCEEDED', 'The input would exceed the cumulative decompression budget (nested archives and both import passes share one budget).', {
        remedy: 'The archive is larger or denser than the configured import limits. Raise maxTotalInflatedBytes only if you trust the file.',
        details: { reason: 'TOTAL_BUDGET', limit: 'maxTotalInflatedBytes', max: this.total },
      });
    }
    this.used += bytes;
  }
}

async function finish(a: FinishArgs): Promise<Discovery> {
  const c = a.collected;
  if (c.conv.length === 0) throw noConversationFiles(a.entriesSeen, a.noFilesExtra);

  // Early budget check: every conversation file is read `passes` times.
  if (a.pool !== undefined) {
    for (const f of c.conv) a.pool.charge((f.size ?? 0) * a.passes);
  }

  // Total order: (plain first, integer suffix, display name, inner name). The last key only matters for the contrived archive
  // that holds both a nested "x.zip" and a literal entry named "x.zip!/<inner>": without it their order (and so the batch
  // identity and the duplicate rule) would follow the entry order of the archive.
  const sorted = [...c.conv].sort(
    (x, y) => compareConversationFiles({ suffix: x.suffix, name: x.displayName }, { suffix: y.suffix, name: y.displayName }) || cmp(x.innerName, y.innerName),
  );
  // Names are the identity of a file in digests, reports and warning ids, so they must be unique within one discovery.
  const used = new Set<string>();
  const files: DiscoveredFile[] = sorted.map((f, order) => {
    let name = f.displayName;
    for (let n = 2; used.has(name); n++) name = `${f.displayName}~${n}`;
    used.add(name);
    return { name, order, open: f.open, sizeHint: f.size };
  });
  const warnings: Warning[] = [...c.warnings];

  // ---- manifest ---------------------------------------------------------------------------------------------
  let manifest: Discovery['manifest'] = 'absent';
  const sharded = sorted.length > 1 || sorted.some((f) => f.suffix !== null);
  if (c.manifests.length > 0) {
    const ms = [...c.manifests].sort((x, y) => x.level - y.level || x.depth - y.depth || cmp(x.displayName, y.displayName));
    const chosen = ms[0] as ManifestCandidate;
    if (ms.length > 1) {
      warnings.push({ code: 'MANIFEST_AMBIGUOUS', message: isInfo(`${ms.length} export_manifest.json files were found; the outermost one was used.`) });
    }
    let outcome: ManifestOutcome;
    if (chosen.size !== null && chosen.size > MANIFEST_MAX_BYTES) {
      outcome = { status: 'invalid', expected: null, warnings: [{ code: 'MANIFEST_INVALID', message: 'export_manifest.json was ignored: it is larger than 16 MiB.', ids: ['too_large'] }] };
    } else {
      if (a.pool !== undefined) a.pool.charge(chosen.size ?? 0);
      outcome = parseManifest(await chosen.read());
    }
    manifest = outcome.status;
    // Only the manifest's INTERNAL consistency (counts versus its own lists) is checked for MANIFEST_COUNT_MISMATCH: a
    // multipart export's first manifest legitimately lists files of OTHER parts, so comparing its totals with what this
    // container holds would raise false alarms (documented in docs/IMPORT_GUIDE.md).
    warnings.push(...reconcileManifest(outcome, chosen.dir, sorted));
  } else if (sharded) {
    warnings.push({ code: 'MANIFEST_ABSENT', message: isInfo('The input has several conversation files but no export_manifest.json; the files found were used as they are.') });
  }

  // ---- shard gaps (informational) ---------------------------------------------------------------------------
  const nums = [...new Set(sorted.filter((f) => f.suffix !== null).map((f) => f.suffix as bigint))].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
  if (nums.length > 1) {
    const lo = nums[0] as bigint;
    const hi = nums[nums.length - 1] as bigint;
    const span = hi - lo + 1n;
    if (span <= 1_000_000n && span > BigInt(nums.length)) {
      const gaps: string[] = [];
      const have = new Set(nums.map((n) => n.toString()));
      for (let n = lo; n <= hi && gaps.length < MAX_MANIFEST_IDS; n++) if (!have.has(n.toString())) gaps.push(n.toString());
      warnings.push({
        code: 'SHARD_GAP',
        message: `The shard numbers are not contiguous (${Number(span) - nums.length} missing between ${lo.toString()} and ${hi.toString()}).`,
        ids: gaps,
      });
    }
  }

  const layout: FormatProfile['layout'] = a.forceLayout ?? (c.nested ? 'nested' : sharded ? 'sharded' : 'single');
  let extensionless = false;
  for (const name of c.assetNames) {
    if (/\.dat$/i.test(baseOf(name))) {
      extensionless = true;
      break;
    }
  }
  return {
    layout,
    sourceKind: a.sourceKind,
    sourceLabel: a.sourceLabel,
    files,
    manifest,
    assetNames: c.assetNames,
    auxiliaryFilesIgnored: c.auxiliary,
    assetsExtensionless: extensionless,
    warnings,
    close: a.close,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------------------------------------------

const O_NOFOLLOW: number = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
/** O_NONBLOCK: opening a FIFO/device read-only would otherwise BLOCK until a writer appears. Regular files are unaffected. */
const OPEN_FLAGS_FOLLOW = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;
const OPEN_FLAGS = OPEN_FLAGS_FOLLOW | O_NOFOLLOW;

async function readHead(path: string, label: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await fsOpen(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (e) {
    throw fsFailure(e, label);
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } catch (e) {
    throw fsFailure(e, label);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Stream a regular file in bounded chunks. O_NOFOLLOW + fstat make the open refuse anything that is not the regular
 * file the earlier lstat saw, even if the path was swapped for a symlink in between.
 */
async function* readRegularFile(abs: string, label: string, followLink = false): AsyncGenerator<Buffer, void, undefined> {
  let handle: FileHandle;
  try {
    // `followLink` is true ONLY for the path the user typed themselves; everything found by walking a folder is opened with O_NOFOLLOW.
    handle = await fsOpen(abs, followLink ? OPEN_FLAGS_FOLLOW : OPEN_FLAGS);
  } catch (e) {
    throw fsFailure(e, label);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw notAnExport(label, 'not a regular file', 'NOT_REGULAR_FILE');
    let pos = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let n: number;
      try {
        ({ bytesRead: n } = await handle.read(buf, 0, READ_CHUNK_BYTES, pos));
      } catch (e) {
        throw fsFailure(e, label);
      }
      if (n === 0) break;
      pos += n;
      yield n === READ_CHUNK_BYTES ? buf : buf.subarray(0, n);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readSmallFile(abs: string, label: string, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of readRegularFile(abs, label)) {
    total += c.length;
    if (total > cap) throw new GcrError('IMPORT_LIMIT_EXCEEDED', 'A support file is larger than its size cap.', { details: { reason: 'SUPPORT_FILE_TOO_LARGE', max: cap } });
    chunks.push(c);
  }
  return Buffer.concat(chunks, total);
}

/**
 * C1 controls, line/paragraph separators and bidi overrides/isolates: invisible or spoofable in logs and terminals. ZIP names
 * containing them are refused by SafeZipReader (FORBIDDEN_NAME_CHARS); folder names get the same rule so that a name echoed
 * in a report (`files[].name`, warning ids, `presentInExportAs`) is as clean for a folder as for an archive.
 * Built with RegExp(...) from escaped text so that no invisible character lives in this source file.
 */
const FORBIDDEN_FS_NAME_CHARS = new RegExp('[\\u0080-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]');

function safeFsName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.length > 0 && Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES && !/[\u0000-\u001f\u007f\\]/.test(name) && !FORBIDDEN_FS_NAME_CHARS.test(name);
}

// ---------------------------------------------------------------------------------------------------------------
// Directory input
// ---------------------------------------------------------------------------------------------------------------

async function discoverDirectory(root: string, label: string, limits: ImportLimits, passes: number): Promise<Discovery> {
  const c = newCollected();
  let entriesSeen = 0;
  let symlinksSkipped = 0;
  let depthLimitHit = false;
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: root, rel: '', depth: 0 }];
  for (let q = 0; q < queue.length; q++) {
    const dir = queue[q] as { abs: string; rel: string; depth: number };
    const names: string[] = [];
    let handle: Dir;
    try {
      handle = await opendir(dir.abs);
      for await (const ent of handle) {
        names.push(ent.name);
        entriesSeen++;
        // The cap is checked while listing, so a directory with millions of entries is refused without being held in memory.
        if (entriesSeen > limits.maxEntries) {
          throw new GcrError('IMPORT_LIMIT_EXCEEDED', 'The folder contains more entries than the configured limit.', {
            remedy: 'Raise maxEntries only if you trust the folder, or import the export ZIP instead.',
            details: { reason: 'TOO_MANY_ENTRIES', limit: 'maxEntries', max: limits.maxEntries },
          });
        }
      }
    } catch (e) {
      if (e instanceof GcrError) throw e;
      throw fsFailure(e, dir.rel === '' ? label : baseOf(dir.rel));
    }
    // Deterministic order independent of the file system's own enumeration order.
    names.sort(cmp);
    for (const name of names) {
      if (!safeFsName(name)) continue;
      const rel = dir.rel === '' ? name : `${dir.rel}/${name}`;
      if (isJunkName(rel)) continue;
      const abs = `${dir.abs}${dir.abs.endsWith('/') ? '' : '/'}${name}`;
      let st: Stats;
      try {
        st = await lstat(abs); // lstat: a symlink is reported as a symlink, never followed
      } catch (e) {
        throw fsFailure(e, name);
      }
      if (st.isSymbolicLink()) {
        symlinksSkipped++;
        continue;
      }
      if (st.isDirectory()) {
        if (dir.depth + 1 <= DIRECTORY_MAX_DEPTH) queue.push({ abs, rel, depth: dir.depth + 1 });
        else depthLimitHit = true;
        continue;
      }
      if (!st.isFile()) continue; // FIFO, socket, device: never opened
      c.fileCount++;
      classifyFile(c, rel, st.size, () => readRegularFile(abs, rel), () => readSmallFile(abs, rel, MANIFEST_MAX_BYTES));
    }
  }
  if (symlinksSkipped > 0) {
    c.warnings.push({ code: 'SYMLINK_SKIPPED', message: `${symlinksSkipped} symbolic link(s) inside the folder were skipped (GCR never follows symbolic links).` });
  }
  if (depthLimitHit) {
    c.warnings.push({ code: 'DIRECTORY_DEPTH_LIMIT', message: `Folders deeper than ${DIRECTORY_MAX_DEPTH} levels below the chosen folder were not searched.` });
  }
  return finish({
    collected: c,
    sourceKind: 'directory',
    sourceLabel: label,
    close: async () => undefined,
    entriesSeen,
    noFilesExtra: { depthLimitReached: depthLimitHit, symlinksSkipped },
    passes,
    forceLayout: 'directory',
  });
}

/** Route one regular file by basename into the right bucket. Shared by directory and ZIP scanning. */
function classifyFile(c: Collected, rel: string, size: number | null, open: () => AsyncIterable<Buffer>, readManifest: () => Promise<Buffer>, displayPrefix = '', level = 0): void {
  const base = baseOf(rel);
  const match = CONVERSATION_FILE_RE.exec(base);
  if (match !== null) {
    c.conv.push({ displayName: displayPrefix + rel, innerName: rel, suffix: shardSuffix(match), size, open });
    return;
  }
  if (MANIFEST_FILE_RE.test(base)) {
    const slash = rel.lastIndexOf('/');
    c.manifests.push({
      displayName: displayPrefix + rel,
      innerName: rel,
      dir: slash === -1 ? '' : rel.slice(0, slash + 1),
      level,
      depth: rel.split('/').length - 1,
      size,
      read: readManifest,
    });
    return;
  }
  if (AUXILIARY_FILE_NAMES.has(base.toLowerCase())) {
    // PII: counted by name, never opened.
    c.auxiliary++;
    return;
  }
  c.assetNames.add(rel);
}

// ---------------------------------------------------------------------------------------------------------------
// ZIP input (including ONE level of nested archives)
// ---------------------------------------------------------------------------------------------------------------

function isNestedConversationZip(base: string): boolean {
  return /\.zip$/i.test(base) && base.toLowerCase().includes('conversations');
}

async function discoverZip(path: string, label: string, limits: ImportLimits, opts: Required<Pick<DiscoverOptions, 'passes' | 'maxNestedZipBytes'>>): Promise<Discovery> {
  const pool = new Pool(Math.min(limits.maxTotalInflatedBytes * opts.passes, Number.MAX_SAFE_INTEGER));
  const readerLimits: Partial<ImportLimits> = { ...limits, maxTotalInflatedBytes: Math.min(limits.maxTotalInflatedBytes * opts.passes, Number.MAX_SAFE_INTEGER) };
  let outer: SafeZipReader;
  try {
    outer = await SafeZipReader.open(path, readerLimits);
  } catch (e) {
    throw rewrapZipOpenError(e, label);
  }
  const readers: SafeZipReader[] = [outer];
  const close = async (): Promise<void> => {
    for (const r of readers) await r.close().catch(() => undefined);
  };
  try {
    const c = newCollected();
    const nestedQueue: Array<{ name: string; size: number }> = [];
    let entriesSeen = 0;
    scanReader(outer, c, '', 0, nestedQueue, (n) => (entriesSeen += n));

    // Nested archives, one level: inflated into memory under maxNestedZipBytes; every byte is charged to the shared pool.
    nestedQueue.sort((x, y) => cmp(x.name, y.name));
    let nestedBytes = 0;
    for (const nz of nestedQueue) {
      c.nested = true;
      if (nz.size > opts.maxNestedZipBytes) throw nestedTooLarge(nz.size, opts.maxNestedZipBytes);
      nestedBytes += nz.size;
      if (nestedBytes > opts.maxNestedZipBytes * NESTED_AGGREGATE_FACTOR) throw nestedTooLarge(nestedBytes, opts.maxNestedZipBytes * NESTED_AGGREGATE_FACTOR);
      pool.charge(nz.size);
      const buf = await outer.readBuffer(nz.name, opts.maxNestedZipBytes);
      let inner: SafeZipReader;
      try {
        inner = SafeZipReader.fromBuffer(buf, readerLimits);
      } catch (e) {
        throw rewrapZipOpenError(e, baseOf(nz.name));
      }
      readers.push(inner);
      const deeper: Array<{ name: string; size: number }> = [];
      scanReader(inner, c, `${nz.name}!/`, 1, deeper, (n) => (entriesSeen += n));
      if (deeper.length > 0) {
        throw new GcrError('IMPORT_UNSUPPORTED_FORMAT', 'A nested archive contains another archive of conversations; GCR opens only ONE level of nested ZIPs.', {
          remedy: REMEDY_NESTING,
          details: { reason: 'NESTING_TOO_DEEP', nestedArchives: nestedQueue.length },
        });
      }
    }
    return await finish({
      collected: c,
      sourceKind: 'zip',
      sourceLabel: label,
      close,
      entriesSeen,
      noFilesExtra: { nestedArchivesOpened: nestedQueue.length },
      pool,
      passes: opts.passes,
    });
  } catch (e) {
    await close();
    throw e;
  }
}

function nestedTooLarge(size: number, max: number): GcrError {
  return new GcrError('IMPORT_LIMIT_EXCEEDED', 'A nested archive is larger than GCR will inflate into memory.', {
    remedy: REMEDY_NESTING,
    details: { reason: 'NESTED_ZIP_TOO_LARGE', limit: 'maxNestedZipBytes', max, observed: size },
  });
}

function scanReader(
  reader: SafeZipReader,
  c: Collected,
  prefix: string,
  level: number,
  nested: Array<{ name: string; size: number }>,
  seen: (n: number) => void,
): void {
  const entries = reader.entries();
  seen(entries.length);
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (isJunkName(e.name)) continue;
    c.fileCount++;
    const base = baseOf(e.name);
    if (isNestedConversationZip(base)) {
      nested.push({ name: e.name, size: e.uncompressedSize });
      continue;
    }
    classifyFile(
      c,
      e.name,
      e.uncompressedSize,
      () => reader.stream(e.name),
      () => reader.readBuffer(e.name, MANIFEST_MAX_BYTES),
      prefix,
      level,
    );
  }
}

/** SafeZipReader's NOT_A_ZIP is a plain "not a zip"; the runner's remedy explains which files GCR wants instead. */
function rewrapZipOpenError(e: unknown, label: string): unknown {
  if (e instanceof GcrError && e.code === 'IMPORT_UNSUPPORTED_FORMAT') return notAnExport(label, 'neither a ZIP archive nor JSON text', 'NOT_A_ZIP');
  return e;
}

// ---------------------------------------------------------------------------------------------------------------
// Stream (stdin) input
// ---------------------------------------------------------------------------------------------------------------

async function discoverStream(src: { stream: AsyncIterable<Buffer | Uint8Array>; label: string }, limits: ImportLimits, passes: number): Promise<Discovery> {
  const cap = limits.maxElementBytes * STDIN_BUFFER_FACTOR;
  // The bytes are COPIED into one growing buffer (never held as a list of the producer's chunks):
  //  - a producer is free to reuse ONE buffer for every chunk (the usual read loop), so keeping references would make every
  //    chunk alias the last bytes read;
  //  - a list costs ~100 bytes of heap per chunk, so a stream of 1-byte chunks would defeat the "maxElementBytes x 4" memory
  //    bound by two orders of magnitude. The buffer never grows beyond `cap`.
  let buf = Buffer.allocUnsafe(Math.max(1, Math.min(Math.ceil(cap), READ_CHUNK_BYTES)));
  let total = 0;
  const iterator = src.stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) break;
      const raw: unknown = step.value;
      let chunk: Buffer;
      if (Buffer.isBuffer(raw)) chunk = raw;
      else if (raw instanceof Uint8Array) chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      else throw new GcrError('INVALID_ARGUMENT', 'The input stream must yield Buffer or Uint8Array chunks.', { details: { reason: 'BAD_CHUNK_TYPE' } });
      if (total + chunk.length > cap) {
        throw new GcrError('IMPORT_LIMIT_EXCEEDED', 'The data read from standard input is larger than the buffering limit (maxElementBytes x 4).', {
          remedy: 'Save the data to a file and import the file instead, or raise maxElementBytes only if you trust the data.',
          details: { reason: 'STDIN_TOO_LARGE', limit: 'maxElementBytes', max: cap },
        });
      }
      if (total + chunk.length > buf.length) {
        const grown = Buffer.allocUnsafe(Math.min(Math.ceil(cap), Math.max(buf.length * 2, total + chunk.length)));
        buf.copy(grown, 0, 0, total);
        buf = grown;
      }
      chunk.copy(buf, total);
      total += chunk.length;
    }
  } catch (e) {
    await iterator.return?.().catch(() => undefined);
    throw e;
  }
  const data = buf.subarray(0, total);
  const kind = classifyHead(data.subarray(0, HEAD_BYTES));
  if (kind === 'utf16') throw utf16Error();
  if (kind === 'zip') {
    throw new GcrError('IMPORT_UNSUPPORTED_FORMAT', 'A ZIP archive was piped to standard input; ZIP needs random access.', {
      remedy: 'Pass the ZIP file path instead of "-", or pipe the extracted conversations.json.',
      details: { reason: 'ZIP_ON_STDIN' },
    });
  }
  if (kind === 'other') throw notAnExport(src.label, 'standard input must be the JSON text of conversations.json', 'STDIN_NOT_JSON');
  const label = safeLabel(src.label);
  const c = newCollected();
  c.conv.push({
    displayName: 'conversations.json',
    innerName: 'conversations.json',
    suffix: null,
    size: data.length,
    open: () => bufferStream(data),
  });
  return finish({ collected: c, sourceKind: 'stdin_json', sourceLabel: label, close: async () => undefined, entriesSeen: 1, passes, forceLayout: 'stdin' });
}

async function* bufferStream(data: Buffer): AsyncGenerator<Buffer, void, undefined> {
  for (let o = 0; o < data.length; o += READ_CHUNK_BYTES) yield data.subarray(o, Math.min(o + READ_CHUNK_BYTES, data.length));
}

/** A caller-supplied label becomes `source_label`: basename only, printable, bounded. */
function safeLabel(label: string): string | null {
  if (typeof label !== 'string') return null;
  const b = baseOf(label.replaceAll('\\', '/'));
  const cleaned = sanitizeEntryName(b, 120);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? null : cleaned;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

export async function discoverInput(src: InputSource, limits: ImportLimits, opts: DiscoverOptions = {}): Promise<Discovery> {
  const resolved = resolveLimits(limits);
  const passes = opts.passes ?? 1;
  if (!Number.isInteger(passes) || passes < 1 || passes > 4) {
    throw new GcrError('INVALID_ARGUMENT', 'passes must be an integer from 1 to 4.', { details: { reason: 'BAD_PASSES' } });
  }
  const maxNested = opts.maxNestedZipBytes ?? MAX_NESTED_ZIP_BYTES;
  if (!Number.isSafeInteger(maxNested) || maxNested < 1) {
    throw new GcrError('INVALID_ARGUMENT', 'maxNestedZipBytes must be a positive integer.', { details: { reason: 'BAD_NESTED_LIMIT' } });
  }
  if (typeof src !== 'object' || src === null) throw new GcrError('INVALID_ARGUMENT', 'An import source is required.', { details: { reason: 'NO_SOURCE' } });

  if (src.kind === 'stream') {
    if (typeof src.stream !== 'object' || src.stream === null || typeof src.stream[Symbol.asyncIterator] !== 'function') {
      throw new GcrError('INVALID_ARGUMENT', 'The stream source needs an async iterable of Buffer chunks.', { details: { reason: 'BAD_STREAM' } });
    }
    return discoverStream(src, resolved, passes);
  }
  if (src.kind !== 'path') throw new GcrError('INVALID_ARGUMENT', 'Unknown import source kind.', { details: { reason: 'BAD_SOURCE_KIND' } });
  const path = src.path;
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new GcrError('INVALID_ARGUMENT', 'A file or folder path is required.', { details: { reason: 'BAD_PATH' } });
  }
  const label = basename(path) || path;
  let st: Stats;
  try {
    // stat (not lstat): the user named this path themselves, so a top-level symlink is followed. Inside a folder it never is.
    st = await stat(path);
  } catch (e) {
    throw fsFailure(e, label);
  }
  if (st.isDirectory()) return discoverDirectory(path, shown(label), resolved, passes);
  if (!st.isFile()) throw notAnExport(label, 'not a regular file or folder', 'NOT_REGULAR_FILE');

  const head = await readHead(path, label);
  const kind = classifyHead(head);
  if (kind === 'utf16') throw utf16Error();
  if (kind === 'json') {
    const base = basename(path);
    const m = CONVERSATION_FILE_RE.exec(base);
    // An explicit file keeps a conversation-pattern name; any other name is recorded as conversations.json so that
    // renaming the file never changes the batch identity (idempotent re-import, FR-10).
    const name = m !== null ? base : 'conversations.json';
    const suffix = m !== null ? shardSuffix(m) : null;
    const c = newCollected();
    c.conv.push({ displayName: name, innerName: name, suffix, size: st.size, open: () => readRegularFile(path, label, true) });
    return finish({ collected: c, sourceKind: 'conversations_json', sourceLabel: shown(label), close: async () => undefined, entriesSeen: 1, passes });
  }
  // 'zip' by signature, or 'other': one chance as a ZIP whose local data is preceded by a stub (EOCD scan).
  return discoverZip(path, shown(label), resolved, { passes, maxNestedZipBytes: maxNested });
}
