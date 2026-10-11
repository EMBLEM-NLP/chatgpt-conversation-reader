/**
 * Approved import roots (SPEC section 7: `gcr_import_export` "requires an explicit local path and refuses to read outside
 * approved roots if execution is delegated").
 *
 * WHY this exists: an MCP client is driven by a language model, and the text it reads includes imported conversations
 * (untrusted data). Without a fence, "import /etc/passwd"-style instructions hidden in a conversation could make the model
 * point the importer at any file the server process can read. The operator therefore lists, out of band, the directories
 * the model may import from (`GCR_APPROVED_IMPORT_ROOTS`); nothing else is ever opened.
 *
 * Rules (all pinned by test/mcp/approved-roots.test.ts):
 *  - The variable is a path list separated by the platform delimiter (`:` on POSIX, `;` on Windows).
 *  - Roots are resolved ONCE at startup with the native `realpath` (the same primitive that canonicalizes candidates, so both
 *    sides are spelled alike on case-insensitive file systems too) and the canonical value is what is compared later. A directory
 *    that is swapped for a symlink after startup therefore cannot widen the approval. Roots must be absolute, existing
 *    directories (a file is not a root); the filesystem root is refused (approving "/" would approve everything). Rejected entries are only
 *    counted, never echoed.
 *  - A candidate is allowed only if its `realpath` equals a root or lies below one. The test uses `path.relative` and
 *    refuses a result that is `..`, starts with `..` + separator or is absolute (another drive). A string-prefix
 *    comparison would wrongly accept the sibling `/a/root-evil` for the root `/a/root`.
 *  - Refused before any filesystem call: non-strings, empty or oversized text, NUL bytes, and any literal `..` path segment
 *    (an explicit import path never needs one, and the check is cheap defence in depth).
 *  - Non-existent files, symlinks that leave the root, devices, FIFOs and sockets are refused. EVERY refusal of the path
 *    itself has the same message and details, so the tool cannot be used as an oracle for which files exist outside the roots.
 *  - The refusal never echoes the candidate path or the configured roots.
 *
 * Limitation (stated, not hidden): the check and the later `open` are two filesystem operations. The caller passes the
 * canonical path it just verified and verifies again immediately before use, which narrows the window but cannot close it,
 * because the importer opens the path itself. Approved roots must be directories that only the operator can write to.
 */
import { realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { delimiter as PLATFORM_DELIMITER, dirname, isAbsolute, relative, sep } from 'node:path';
import { GcrError } from '../errors.js';

export interface ApprovedRoots {
  /** Canonical (realpath'd) absolute directories, in the order given, without duplicates. */
  readonly roots: readonly string[];
  /** How many configured entries were rejected (relative, missing, not a directory, filesystem root). Never their text. */
  readonly ignored: number;
}

/** Import is disabled: the state when `GCR_APPROVED_IMPORT_ROOTS` is unset or empty. */
export const NO_APPROVED_ROOTS: ApprovedRoots = Object.freeze({ roots: Object.freeze([] as string[]), ignored: 0 });

const MAX_CANDIDATE_CHARS = 4096;

/**
 * Parse the environment variable value. Synchronous (startup only). Never throws for bad entries: they are counted in
 * `ignored` so the caller can warn without printing paths.
 */
export function parseApprovedRoots(value: string | undefined, delimiter: string = PLATFORM_DELIMITER): ApprovedRoots {
  if (value === undefined || value === '') return NO_APPROVED_ROOTS;
  const roots: string[] = [];
  let ignored = 0;
  for (const raw of value.split(delimiter)) {
    if (raw === '') continue; // "a::b" or a trailing delimiter: not an entry
    if (raw.includes('\0') || !isAbsolute(raw)) {
      ignored++;
      continue;
    }
    let real: string;
    try {
      // `.native` = realpath(3), the very primitive behind `fs.promises.realpath` that canonicalizes every candidate later. The
      // plain `realpathSync` is a JavaScript re-implementation that keeps the letter case it was given where no symlink is
      // involved, so on a case-insensitive file system roots and candidates would be spelled differently and never match.
      real = realpathSync.native(raw);
      if (!statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      ignored++;
      continue;
    }
    if (dirname(real) === real) {
      ignored++; // the filesystem root (or a drive root) would approve everything
      continue;
    }
    if (!roots.includes(real)) roots.push(real);
  }
  return { roots, ignored };
}

/**
 * Pure containment test on two CANONICAL absolute paths: equal, or below. `path.relative` normalizes both sides; a result
 * that climbs out (`..`, `../x`) or is absolute (different drive) means "outside". `..foo` is a legal directory name and is
 * inside, hence the separator in the prefix test.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../');
}

/** A literal ".." path segment, with either separator style. */
function hasDotDotSegment(p: string): boolean {
  return p.split(/[\\/]+/).includes('..');
}

function notAllowed(): GcrError {
  return new GcrError('IMPORT_PATH_NOT_ALLOWED', 'The import path is not allowed.', {
    remedy:
      'Pass the path of an export file or folder that exists and lies inside one of the approved import roots the operator configured (GCR_APPROVED_IMPORT_ROOTS). Paths with ".." segments, symlinks that leave an approved root and missing files are refused.',
    details: { reason: 'not_under_approved_root' },
  });
}

/** The error returned while no root is configured: says how the OPERATOR enables the tool. */
export function importDisabledError(): GcrError {
  return new GcrError('IMPORT_PATH_NOT_ALLOWED', 'Import is disabled: no approved import roots are configured for this MCP server.', {
    remedy:
      'The operator can enable it by restarting the server with GCR_APPROVED_IMPORT_ROOTS set to one or more absolute directories that contain the export files (separated by ":" on POSIX, ";" on Windows) AND with --allow-local-writes (or GCR_MCP_ALLOW_WRITES=1). Alternatively, import with the CLI: gcr import <export> --db <database>.',
    details: { reason: 'no_approved_roots' },
  });
}

/**
 * Resolve `candidate` and decide whether it may be imported. Returns the CANONICAL path to hand to the importer (never the
 * caller's spelling, so a later symlink swap of an intermediate directory is not followed again). Throws
 * IMPORT_PATH_NOT_ALLOWED otherwise. Call it again immediately before use (see the limitation in the file header).
 */
export async function resolveApprovedImportPath(candidate: unknown, approved: ApprovedRoots): Promise<string> {
  if (approved.roots.length === 0) throw importDisabledError();
  if (typeof candidate !== 'string' || candidate === '' || candidate.length > MAX_CANDIDATE_CHARS || candidate.includes('\0')) throw notAllowed();
  if (hasDotDotSegment(candidate)) throw notAllowed();
  let real: string;
  try {
    // realpath on the raw spelling: the kernel resolves symlinks and any relative start against the process cwd.
    real = await realpath(candidate);
  } catch {
    throw notAllowed();
  }
  try {
    const st = await stat(real);
    if (!st.isFile() && !st.isDirectory()) throw notAllowed(); // device, FIFO, socket: opening it could block or read endlessly
  } catch {
    throw notAllowed();
  }
  if (!approved.roots.some((root) => isInsideRoot(root, real))) throw notAllowed();
  return real;
}
