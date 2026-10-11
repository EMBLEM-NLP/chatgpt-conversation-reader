/**
 * Opening and closing GCR databases (node:sqlite), plus the SQLite -> GcrError error mapping shared by the db layer.
 *
 * Security / privacy properties:
 *  - A newly created database file is created with mode 0600 BEFORE SQLite touches it (`wx` + 0o600). SQLite gives the
 *    -wal/-shm side files the same permissions, so imported conversations are never world-readable by accident.
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
import { closeSync, openSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GcrError } from '../errors.js';
import { log } from '../logger.js';
import { applyMigrations, assertCompatible, readUserVersion } from './schema.js';

export const BUSY_TIMEOUT_MS = 5000;

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

/** Create an empty file readable only by the owner. `wx` makes creation race-free and refuses to follow a planted symlink. */
function createPrivateFile(path: string, label: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'EEXIST') return; // created concurrently by someone else: fine
    if (code === 'ENOENT') throw notFound(label, 'directory');
    throw new GcrError('DB_ERROR', 'The database file could not be created.', { details: { reason: 'cannot_create', label }, cause: e });
  }
}

function fileExists(path: string, label: string): boolean {
  try {
    const st = statSync(path);
    if (st.isDirectory()) throw new GcrError('DB_ERROR', 'The database path is a directory.', { details: { reason: 'is_directory', label } });
    return true;
  } catch (e) {
    if (e instanceof GcrError) throw e;
    if ((e as { code?: unknown } | null)?.code === 'ENOENT') return false;
    throw new GcrError('DB_ERROR', 'The database path could not be inspected.', { details: { reason: 'stat_failed', label }, cause: e });
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
    const row = db.prepare('PRAGMA journal_mode = WAL').get();
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

  if (!memory && !fileExists(path, label)) {
    if (!create) throw notFound(label, 'file');
    createPrivateFile(path, label);
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly, timeout: BUSY_TIMEOUT_MS });
    configureConnection(db, readOnly, memory);
    let migrated: { from: number; to: number } | null = null;
    if (!readOnly) {
      const result = applyMigrations(db);
      migrated = result.from === result.to ? null : result;
    }
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
