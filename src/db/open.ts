/**
 * Opening and closing GCR databases (node:sqlite), plus the SQLite -> GcrError error mapping shared by the db layer.
 *
 * Security / privacy properties:
 *  - A newly created database file is created with mode 0600 BEFORE SQLite touches it (`wx` + 0o600). SQLite gives the
 *    -wal/-shm side files the same permissions, so imported conversations are never world-readable by accident.
 *  - The path is lstat'ed first and a symbolic link is never used to CREATE or INITIALISE a database (ATK-01): `open(path, 'wx')`
 *    refuses a link, but SQLite itself follows one, so a dangling link used to make SQLite create the link's target with the
 *    default umask (0644), in a place somebody else chose. A link that is dangling, that leads to an empty file (0 or 1 byte: SQLite
 *    initialises both in place) or, for a read-write open, to a SQLite file that holds no tables yet is refused (DB_ERROR, reason
 *    SYMLINK_DB_PATH); an already initialised database reached through a link keeps working. EEXIST from the
 *    exclusive create counts as "created concurrently, fine" only when lstat shows a regular file owned by the current user.
 *  - A new database is not created next to a pre-existing `<db>-wal`, `-shm` or `-journal` (STRAY_SIDECAR_FILES): SQLite
 *    deletes or reuses such files when it opens an EMPTY database, which destroyed the operator's own files (ATK-05).
 *  - Only an ordinary file (or a link to one) is opened: a FIFO, a device or a socket is refused (DB_ERROR, reason
 *    not_a_regular_file) before SQLite sees it, because a read-only open of a FIFO would block for ever.
 *  - Read-only opens never create the file and never migrate it (`query_only` is also set, so any write attempt fails
 *    with WRITE_FORBIDDEN instead of a confusing SQLite message).
 *  - URI filenames ("file:...?mode=...&vfs=...") are refused so a path can never smuggle SQLite open options.
 *  - Error messages carry the file's BASENAME only, never an absolute path, and never SQLite's own message text
 *    (which can contain SQL fragments or paths).
 *  - `trusted_schema=OFF`, foreign keys ON, `recursive_triggers=ON` (so INSERT OR REPLACE cannot bypass the
 *    delete-immutability triggers), `busy_timeout=5000`, WAL for writable on-disk databases.
 *  - Loadable extensions stay disabled (node:sqlite default; this module never enables them).
 *
 * The node:sqlite ExperimentalWarning is emitted by Node on stderr; it is NOT suppressed here (entry points decide).
 */
import { closeSync, lstatSync, openSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GcrError } from '../errors.js';
import { log } from '../logger.js';
import { applyMigrations, assertCompatible, assertSchemaNotNewer, readUserVersion } from './schema.js';

export const BUSY_TIMEOUT_MS = 5000;

/**
 * Oldest Node.js release whose bundled SQLite includes FTS5. Verified on real binaries (2026-10-10): node:sqlite in
 * 22.13.1, 22.14.0, 22.15.0 and 22.15.1 answers "no such module: fts5"; 22.16.0 and every later 22.x tested has it.
 * GCR's search (FR-05) cannot work without FTS5, so this - not 22.13 - is the real minimum runtime.
 */
export const MIN_NODE_WITH_FTS5 = '22.16.0';

let fts5Verified = false;

/** Create a throw-away FTS5 table on a private in-memory connection (the capability belongs to the Node build, not to the target file). */
function probeFts5Support(): void {
  const probe = new DatabaseSync(':memory:');
  try {
    probe.exec('CREATE VIRTUAL TABLE gcr_fts5_probe USING fts5(x)');
  } finally {
    probe.close();
  }
}

/**
 * Fail fast, clearly and BEFORE touching any file when this Node build's SQLite was compiled without FTS5. Without this
 * check the first symptom is DB_MIGRATION_FAILED from inside the schema migration, which hides the real cause.
 * `probe` and `runtime` are test seams; the default probe result is cached for the process lifetime.
 */
export function assertFts5Available(probe: () => void = probeFts5Support, runtime: { node: string } = { node: process.versions.node }): void {
  if (probe === probeFts5Support && fts5Verified) return;
  try {
    probe();
    if (probe === probeFts5Support) fts5Verified = true;
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (/no such module:\s*fts5/i.test(message)) {
      throw new GcrError('DB_ERROR', 'This Node.js build of SQLite does not include FTS5, which GCR needs for full-text search.', {
        remedy: `Upgrade Node.js to ${MIN_NODE_WITH_FTS5} or newer (node:sqlite in Node 22.13 to 22.15 is built without FTS5). Running: ${runtime.node}.`,
        details: { reason: 'FTS5_UNAVAILABLE', node: runtime.node, minimumNode: MIN_NODE_WITH_FTS5 },
        cause: e,
      });
    }
    throw toDbError(e);
  }
}

export interface OpenOptions {
  /** Open without any write capability: never creates, never migrates. Default false. */
  readOnly?: boolean;
  /** Create the file when missing. Default: true for read-write, and must not be true when readOnly. */
  create?: boolean;
}

/** A connection plus what the opener learned. `db` is what Repository and searchMessages take. */
export interface GcrDatabase {
  readonly db: DatabaseSync;
  readonly readOnly: boolean;
  /** Basename of the database file, or ':memory:'. Safe to print. */
  readonly label: string;
  /** Schema version of the open database (equals SCHEMA_VERSION). */
  readonly schemaVersion: number;
  /** Set when this open created or migrated the schema. */
  readonly migrated: { from: number; to: number } | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------------------------------------------

const IMMUTABLE_MARKER = 'imported data is immutable';

interface SqliteErrorShape {
  code?: unknown;
  errcode?: unknown;
  message?: unknown;
}

/** true for errors thrown by node:sqlite itself (as opposed to JS errors or GcrError). */
export function isSqliteError(e: unknown): boolean {
  return e instanceof Error && (e as SqliteErrorShape).code === 'ERR_SQLITE_ERROR';
}

/** SQLite extended result code of a node:sqlite error, or null. */
export function sqliteErrcode(e: unknown): number | null {
  if (!isSqliteError(e)) return null;
  const c = (e as SqliteErrorShape).errcode;
  return typeof c === 'number' ? c : null;
}

/**
 * Convert any thrown value from the db layer into a GcrError. GcrErrors pass through unchanged. SQLite errors are
 * mapped by their (primary) result code to a fixed, content-free message. The original error is kept as `cause`
 * (for GCR_DEBUG output only).
 */
export function toDbError(e: unknown): GcrError {
  if (e instanceof GcrError) return e;
  // node:sqlite refuses every call on a closed handle with ERR_INVALID_STATE ("database is not open"): a usage error that
  // deserves a precise, content-free answer rather than the generic fallback (or, worse, escaping as a raw Error).
  const state = e as { code?: unknown; message?: unknown } | null;
  if (state?.code === 'ERR_INVALID_STATE' && typeof state.message === 'string' && state.message.includes('not open')) {
    return new GcrError('DB_ERROR', 'The database connection is closed.', { remedy: 'Open the database again.', details: { reason: 'closed' }, cause: e });
  }
  const code = sqliteErrcode(e);
  if (code !== null) {
    const primary = code & 0xff;
    switch (primary) {
      case 5: // SQLITE_BUSY
      case 6: // SQLITE_LOCKED
        return new GcrError('DB_ERROR', 'The database is busy (locked by another process).', {
          remedy: 'Close other programs using the database file, then retry.',
          details: { reason: 'busy' },
          cause: e,
        });
      case 8: // SQLITE_READONLY
        return new GcrError('WRITE_FORBIDDEN', 'The database is read-only.', {
          remedy: 'Open the database in read-write mode to import or write local data.',
          cause: e,
        });
      case 11: // SQLITE_CORRUPT
        return new GcrError('DB_ERROR', 'The database file is damaged (malformed database image).', {
          remedy: 'Restore the database from a backup or re-import your export into a new file.',
          details: { reason: 'corrupt' },
          cause: e,
        });
      case 13: // SQLITE_FULL
        return new GcrError('DB_ERROR', 'The disk is full or the database reached its size limit.', { details: { reason: 'full' }, cause: e });
      case 14: // SQLITE_CANTOPEN
        return new GcrError('DB_ERROR', 'The database file could not be opened.', {
          remedy: 'Check that the path exists and that you have permission to access it.',
          details: { reason: 'cannot_open' },
          cause: e,
        });
      case 19: {
        // SQLITE_CONSTRAINT. Only the fixed trigger message is recognised; nothing else from SQLite is echoed.
        const msg = (e as SqliteErrorShape).message;
        if (typeof msg === 'string' && msg.includes(IMMUTABLE_MARKER)) {
          return new GcrError('DB_ERROR', 'Imported data is immutable and cannot be changed.', { details: { reason: 'immutable' }, cause: e });
        }
        return new GcrError('DB_ERROR', 'A database constraint was violated.', { details: { reason: 'constraint' }, cause: e });
      }
      case 26: // SQLITE_NOTADB
        return new GcrError('DB_ERROR', 'The file is not a SQLite database (or is encrypted).', {
          remedy: 'Choose a different --db path.',
          details: { reason: 'not_a_database' },
          cause: e,
        });
      default:
        break;
    }
  }
  return new GcrError('DB_ERROR', 'A database operation failed.', { cause: e });
}

// ---------------------------------------------------------------------------------------------------------------
// open / close
// ---------------------------------------------------------------------------------------------------------------

function invalidPath(): GcrError {
  return new GcrError('INVALID_ARGUMENT', 'The database path must be a non-empty file path (or ":memory:") without NUL bytes and not a "file:" URI.');
}

function notFound(label: string, what: 'file' | 'directory'): GcrError {
  return new GcrError('DB_NOT_FOUND', `Database ${what} not found: ${label}`, {
    remedy: what === 'file' ? 'Import an export first (gcr import ...) or check the --db path.' : 'Create the parent directory first.',
    details: { label },
  });
}

function errnoCode(e: unknown): unknown {
  return (e as { code?: unknown } | null)?.code;
}

function isDirectoryError(label: string): GcrError {
  return new GcrError('DB_ERROR', 'The database path is a directory.', { details: { reason: 'is_directory', label } });
}

/**
 * A FIFO, a device or a socket (or a link to one) is not a database file. This is not only tidiness: a READ-ONLY open of a FIFO
 * blocks the process for ever (SQLite's open(2) waits for a writer), so a planted `./.gcr/gcr.sqlite` that is a FIFO would hang
 * `gcr list` and `gcr mcp`; /dev/null "opens" and then fails in confusing ways. Answered before SQLite sees the path.
 */
function notRegularFile(label: string): GcrError {
  return new GcrError('DB_ERROR', 'The database path is not a regular file (it is a FIFO, a device or a socket).', {
    remedy: 'Choose a different --db path: GCR only opens ordinary files.',
    details: { reason: 'not_a_regular_file', label },
  });
}

function statFailed(label: string, cause: unknown): GcrError {
  return new GcrError('DB_ERROR', 'The database path could not be inspected.', { details: { reason: 'stat_failed', label }, cause });
}

function cannotCreate(label: string, message: string, cause?: unknown): GcrError {
  return new GcrError('DB_ERROR', message, { details: { reason: 'cannot_create', label }, ...(cause === undefined ? {} : { cause }) });
}

/** ATK-01. The remedy is the same for every way of getting here. */
function symlinkDbPath(label: string): GcrError {
  return new GcrError('DB_ERROR', 'The database path is a symbolic link that does not lead to an existing GCR database; GCR will not create or initialise a database through a link.', {
    remedy: 'Pass the real path of the database file instead of the link. (A link to a GCR database that is already initialised still works.)',
    details: { reason: 'SYMLINK_DB_PATH', label },
  });
}

/**
 * Create an empty file readable only by the owner. `wx` (O_CREAT | O_EXCL) makes creation race-free and never follows a planted
 * symlink: it fails with EEXIST for a link, dangling or not. That EEXIST must NOT be mistaken for "someone else created it
 * concurrently, fine" (it was, and the code then let SQLite follow the link and create the target with the default umask,
 * ATK-01): success is only a REGULAR file, owned by the current user where the platform has owners. Exported for tests.
 */
export function createPrivateFile(path: string, label: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600));
    return;
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT') throw notFound(label, 'directory');
    if (code !== 'EEXIST') throw cannotCreate(label, 'The database file could not be created.', e);
  }
  let existing: Stats;
  try {
    existing = lstatSync(path); // lstat: look at the name itself, not at what it points to
  } catch (e) {
    throw cannotCreate(label, 'The database file could not be created.', e);
  }
  if (existing.isSymbolicLink()) throw symlinkDbPath(label);
  if (!existing.isFile()) throw cannotCreate(label, 'The database path exists and is not a regular file.');
  const uid = process.getuid?.();
  if (uid !== undefined && existing.uid !== uid) throw cannotCreate(label, 'The database file was created by another user in the meantime; GCR will not write into it.');
  // a regular file of ours that appeared between the check and the create: a concurrent opener, the normal race. Fine.
}

/** What is at the database path, WITHOUT letting a final symbolic link hide it. */
type PathState = 'absent' | 'file' | 'symlink_to_file' | 'symlink_to_empty_file' | 'symlink_dangling';

function inspectDatabasePath(path: string, label: string): PathState {
  let named: Stats;
  try {
    named = lstatSync(path);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return 'absent';
    throw statFailed(label, e);
  }
  if (!named.isSymbolicLink()) {
    if (named.isDirectory()) throw isDirectoryError(label);
    if (!named.isFile()) throw notRegularFile(label);
    return 'file';
  }
  try {
    const target = statSync(path); // follows the link (and every link after it)
    if (target.isDirectory()) throw isDirectoryError(label);
    if (!target.isFile()) throw notRegularFile(label);
    // SQLite treats a file of 0 OR 1 byte as a database that does not exist yet and initialises it in place (measured on Node 22.22.0:
    // a 1-byte file became a 192 KiB database, a 2-byte one is refused as "not a database"). "Empty" must mean both.
    return target.size <= 1 ? 'symlink_to_empty_file' : 'symlink_to_file';
  } catch (e) {
    if (e instanceof GcrError) throw e;
    if (errnoCode(e) === 'ENOENT') return 'symlink_dangling';
    throw statFailed(label, e);
  }
}

const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** true when something (anything, a dangling link included) is named `path`. An uninspectable path counts as present: fail closed. */
function nameInUse(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    const code = errnoCode(e);
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
}

/**
 * Do not create a database where files of an earlier one are lying around (ATK-05). Opening an EMPTY database makes SQLite
 * delete a pre-existing `-wal` and `-journal` and reinitialise a pre-existing `-shm` (measured on 2026-10-12 with Node 22.22.0):
 * the operator's own files would be destroyed by the act of creating a database next to them, and no cleanup after a failed
 * command can bring them back. A stale `-wal` may even be the only copy of changes to a database that was removed by hand.
 *
 * Race-free against a genuine concurrent creator: that process makes the database file BEFORE any side file exists, so side
 * files are listed first and the database is looked at second; if it exists by then, they are its, not strays.
 */
function refuseStraySidecars(path: string, label: string): void {
  const strays = SIDECAR_SUFFIXES.filter((suffix) => nameInUse(path + suffix));
  if (strays.length === 0 || nameInUse(path)) return;
  throw new GcrError('DB_ERROR', `Files that look like the side files of a database (${strays.join(', ')}) already exist next to "${label}", which does not exist.`, {
    remedy: 'GCR will not create a new database over them: SQLite would delete or reuse them. Move or delete them yourself (a leftover -wal can hold the only copy of recent changes to a database that was removed by hand), or choose another --db path.',
    details: { reason: 'STRAY_SIDECAR_FILES', label, files: strays },
  });
}

/**
 * A READ-ONLY open of a SQLite file that is not ours. It used to fall through to assertCompatible, which says "has not been
 * initialized ... run an import": true for an empty file, wrong for a file with another application's tables (the import refuses
 * it, ATK-08). Same answer as the read-write refusal in schema.ts (applyMigrations), so a reader and a writer cannot disagree.
 */
function assertNotForeignFile(db: DatabaseSync): void {
  const appId = Number(db.prepare('PRAGMA application_id').get()?.['application_id'] ?? 0);
  if (appId !== 0 || readUserVersion(db) !== 0) return; // a foreign application id and a negative version are assertCompatible's to refuse
  if (countUserObjects(db) > 0) {
    throw new GcrError('DB_ERROR', 'The file is a SQLite database but not a GCR database; refusing to use or modify it.', {
      remedy: 'Choose a different --db path. GCR never writes into databases it did not create.',
      details: { reason: 'not_gcr_database' },
    });
  }
}

/**
 * A read-write open THROUGH a symbolic link may only continue into a database that is already initialised (ATK-01). The size test in
 * `inspectDatabasePath` cannot know that a file of 4 KiB is a valid SQLite file without a single table (what `sqlite3 f 'vacuum'`
 * leaves behind): migration 1 would build the whole GCR schema in it, and every conversation imported afterwards would live in a file
 * somebody else chose. A file with another application's tables (version 0, objects present) is left to applyMigrations, which refuses
 * it as "not a GCR database". Reads only: nothing is written before this check passes.
 */
function assertLinkLeadsToInitialisedDatabase(db: DatabaseSync, label: string): void {
  if (readUserVersion(db) !== 0) return; // initialised (a newer or negative version is refused elsewhere)
  if (countUserObjects(db) > 0) return;
  throw symlinkDbPath(label);
}

/** Tables, indexes, views and triggers other than SQLite's own `sqlite_*` bookkeeping. */
function countUserObjects(db: DatabaseSync): number {
  return Number(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get()?.['n'] ?? 0);
}

/**
 * `PRAGMA journal_mode = WAL` with a bounded retry on SQLITE_BUSY. SQLite does not call the busy handler for a journal-mode
 * switch (`busy_timeout` does not apply), so when several processes create the same brand-new database at the same moment all but
 * one used to fail with DB_ERROR "busy" although waiting a few milliseconds would have worked (round-2 review: 6 of 90 runs of
 * the six-processes test failed). Only a busy/locked answer is retried; any other failure surfaces at once, and after the last
 * attempt the busy error itself is thrown (about two seconds in all).
 */
const WAL_SWITCH_ATTEMPTS = 200;
const WAL_SWITCH_PAUSE_MS = 10;
/** Exported as a test seam only (the attempts and the pause are parameters so that the give-up path can be tested quickly). */
export function switchToWal(db: DatabaseSync, attempts: number = WAL_SWITCH_ATTEMPTS, pauseMs: number = WAL_SWITCH_PAUSE_MS): Record<string, unknown> | undefined {
  for (let attempt = 1; ; attempt++) {
    try {
      return db.prepare('PRAGMA journal_mode = WAL').get() as Record<string, unknown> | undefined;
    } catch (e) {
      const code = (e as { errcode?: unknown } | null)?.errcode;
      const busy = typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
      if (!busy || attempt >= attempts) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
    }
  }
}

/** Static pragma set (no user input is ever interpolated into these statements). */
function configureConnection(db: DatabaseSync, readOnly: boolean, memory: boolean): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (readOnly) {
    db.exec('PRAGMA query_only = ON');
  } else if (!memory) {
    // WAL gives readers and the single writer independence; it needs a real file (not :memory:) and write access.
    const row = switchToWal(db);
    const mode = row?.['journal_mode'];
    if (mode !== 'wal') log.warn('journal_mode_not_wal', { mode: String(mode) });
  }
}

/**
 * Open (and for read-write handles create/migrate) a GCR database.
 *  - `:memory:` is supported for read-write only.
 *  - Missing file: DB_NOT_FOUND when `readOnly` or `create === false`; otherwise it is created with mode 0600.
 *  - Read-only: the schema must already be at exactly this tool's version (assertCompatible), otherwise
 *    DB_SCHEMA_TOO_NEW / DB_ERROR; nothing is written.
 *  - Read-write: pending migrations are applied; a file from a newer tool throws DB_SCHEMA_TOO_NEW untouched.
 * On any failure the connection is closed before the error is thrown.
 */
export function openDatabase(path: string, opts: OpenOptions = {}): GcrDatabase {
  if (typeof path !== 'string' || path === '' || path.includes('\0') || /^file:/i.test(path)) throw invalidPath();
  const readOnly = opts.readOnly === true;
  const memory = path === ':memory:';
  if (memory && readOnly) throw new GcrError('INVALID_ARGUMENT', 'An in-memory database cannot be opened read-only.');
  if (readOnly && opts.create === true) throw new GcrError('INVALID_ARGUMENT', 'A read-only open never creates the database file.');
  const create = opts.create ?? !readOnly;
  const label = memory ? ':memory:' : basename(path);

  // Before the file is created or touched: an unsupported Node build must not leave an empty database behind.
  assertFts5Available();

  let viaLink = false;
  if (!memory) {
    const state = inspectDatabasePath(path, label);
    viaLink = state === 'symlink_to_file' || state === 'symlink_to_empty_file';
    if (state === 'absent') {
      if (!create) throw notFound(label, 'file');
      refuseStraySidecars(path, label);
      createPrivateFile(path, label);
    } else if (state === 'symlink_dangling') {
      // Nothing is created: SQLite would follow the link and create its target with the default umask (ATK-01).
      if (!create) throw notFound(label, 'file');
      throw symlinkDbPath(label);
    } else if (state === 'symlink_to_empty_file' && !readOnly) {
      // Initialising a database in a file that somebody pointed us at is the same act as creating one there.
      throw symlinkDbPath(label);
    }
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly, timeout: BUSY_TIMEOUT_MS });
    // A file from a newer tool must stay byte-for-byte untouched: check BEFORE configureConnection switches the journal mode to WAL.
    if (!memory) assertSchemaNotNewer(db);
    if (viaLink && !readOnly) assertLinkLeadsToInitialisedDatabase(db, label); // before anything is written (configureConnection switches to WAL)
    configureConnection(db, readOnly, memory);
    let migrated: { from: number; to: number } | null = null;
    if (!readOnly) {
      const result = applyMigrations(db);
      migrated = result.from === result.to ? null : result;
    }
    if (readOnly) assertNotForeignFile(db);
    assertCompatible(db);
    return { db, readOnly, label, schemaVersion: readUserVersion(db), migrated };
  } catch (e) {
    try {
      db?.close();
    } catch {
      /* the open failure is the interesting error */
    }
    throw toDbError(e);
  }
}

/**
 * Close a handle (idempotent). Accepts the GcrDatabase or a bare DatabaseSync. `db.isOpen` is deliberately not consulted: it
 * only exists from Node 22.15 (`engines` allows 22.13), where `undefined` would turn this function into a silent no-op and
 * leak the connection. Closing a closed database raises ERR_INVALID_STATE, which is the "already closed" answer.
 */
export function closeDatabase(handle: GcrDatabase | DatabaseSync): void {
  const db = handle instanceof DatabaseSync ? handle : handle.db;
  try {
    db.close();
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code !== 'ERR_INVALID_STATE') throw e;
  }
}
