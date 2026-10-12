/**
 * What a command handler gets: parsed options, output, and lazily opened SDK handles.
 *
 * Database policy (SPEC section 6, docs/CLI_REFERENCE.md):
 *  - location: `--db <path>`, else `$GCR_DB`, else `./.gcr/gcr.sqlite` (relative to the current directory);
 *  - READ commands open the file read-only and never create anything. A missing file is DB_NOT_FOUND with the remedy
 *    "run: gcr import <export.zip>", checked here so the answer is the same for every read command;
 *  - WRITE commands create the file (the SDK creates it with mode 0600). Only the DEFAULT location's directory
 *    (`./.gcr`) is created on demand, with mode 0700, and only at the moment of a first write. An explicit path
 *    (`--db`, `$GCR_DB`) whose directory does not exist is an error: a typo must not silently create directory trees;
 *  - ownership: a DEFAULT database (or its directory) that belongs to another user is announced on stderr (ATK-11);
 *  - `:memory:` and `file:` URIs make no sense for a one-shot process (the data would vanish / SQLite options could be
 *    smuggled in), so they are refused up front.
 *
 * The SDK (and with it node:sqlite) is imported lazily so `gcr --help` and `gcr --version` start instantly and never
 * load SQLite.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { OutputFormat } from '../domain/types.js';
import { GcrError } from '../errors.js';
import type { RenderOptions } from '../format/render.js';
import type { Gcr } from '../sdk/gcr.js';
import { DEFAULT_DB_RELATIVE } from './options.js';
import type { Output } from './output.js';
import type { ParsedArgs } from './parse.js';
import type { CommandSpec } from './spec.js';

export type Env = Readonly<Record<string, string | undefined>>;

/** stdin as the CLI needs it: a byte stream, and whether a person is typing into it. */
export interface StdinLike extends AsyncIterable<Buffer | Uint8Array> {
  readonly isTTY?: boolean | undefined;
}

/** Everything the process provides; tests replace it. */
export interface CliEnvironment {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly cwd: string;
  readonly out: Output;
  readonly stdin: StdinLike;
  readonly lifecycle: Lifecycle;
}

/** Things to close when the command ends or a signal arrives. Closers must be idempotent. */
export class Lifecycle {
  private readonly closers = new Set<() => void>();
  /** A command that runs its own graceful shutdown on SIGINT/SIGTERM (mcp) sets this; the CLI's handlers then stand down. */
  signalsDelegated = false;

  /** Register a closer; the returned function unregisters it. */
  add(closer: () => void): () => void {
    this.closers.add(closer);
    return () => {
      this.closers.delete(closer);
    };
  }

  /** Run every closer once. Returns the first failure (the rest still run) or undefined. */
  closeAll(): unknown {
    let first: unknown;
    for (const closer of [...this.closers].reverse()) {
      try {
        closer();
      } catch (e) {
        first ??= e;
      }
    }
    this.closers.clear();
    return first;
  }
}

export interface DbLocation {
  /** Absolute path. */
  readonly path: string;
  readonly origin: 'flag' | 'env' | 'default';
}

export function resolveDbLocation(flag: string | undefined, env: Env, cwd: string): DbLocation {
  const fromEnv = env['GCR_DB'];
  const origin: DbLocation['origin'] = flag !== undefined ? 'flag' : fromEnv !== undefined && fromEnv !== '' ? 'env' : 'default';
  const raw = flag ?? (origin === 'env' ? fromEnv : undefined) ?? DEFAULT_DB_RELATIVE;
  if (raw === ':memory:' || /^file:/i.test(raw)) {
    throw new GcrError('INVALID_ARGUMENT', 'The database must be a file path: ":memory:" and file: URIs are not supported by the CLI.', {
      remedy: 'Use --db <path>, set GCR_DB, or omit both to use ./.gcr/gcr.sqlite.',
      details: { option: 'db' },
    });
  }
  return { path: resolve(cwd, raw), origin };
}

/**
 * Does the database path exist? A path that cannot even be inspected (no permission on a parent directory) is a DB_ERROR with
 * a content-free message, not a raw file-system error that would surface as INTERNAL_ERROR.
 */
export function dbExists(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (e) {
    throw new GcrError('DB_ERROR', `The database path "${basename(path)}" could not be inspected.`, {
      remedy: 'Check the permissions of the directory, or choose another file with --db.',
      details: { reason: 'stat_failed' },
      cause: e,
    });
  }
}

export function dbNotFound(path: string): GcrError {
  return new GcrError('DB_NOT_FOUND', `No database found at "${basename(path)}".`, {
    remedy: 'run: gcr import <export.zip>  (or point --db / GCR_DB at an existing database)',
    details: { label: basename(path) },
  });
}

/** The names SQLite may create for one database: the file itself and its three side files. */
const DATABASE_PATH_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;
export type DatabasePathSuffix = (typeof DATABASE_PATH_SUFFIXES)[number];
/** For each name: did something (anything, a dangling symbolic link included) already have it BEFORE the command ran? */
export type DatabasePathSnapshot = Readonly<Record<DatabasePathSuffix, boolean>>;

/**
 * Record, with lstat, which of the database path and its three side files already exist. Taken BEFORE the command opens anything,
 * so that `removeCreated` can tell what the command itself created from what was the operator's (ATK-05). lstat, not stat: a
 * dangling symbolic link is a name in use, and an uninspectable name counts as in use (never delete what you cannot vouch for).
 */
export function snapshotDatabasePaths(dbPath: string): DatabasePathSnapshot {
  const present = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      return !(code === 'ENOENT' || code === 'ENOTDIR');
    }
  };
  return { '': present(dbPath), '-wal': present(`${dbPath}-wal`), '-shm': present(`${dbPath}-shm`), '-journal': present(`${dbPath}-journal`) };
}

/**
 * Remove what this command created: the database file and SQLite's side files, and, when the command also created the default
 * `./.gcr` directory, that directory too (it goes only while empty). Best effort; never throws.
 *
 * A name is removed only if it did NOT exist before the command (`before`, from `snapshotDatabasePaths`) and exists now. A
 * pre-existing file called `<db>-wal` is somebody's file, not ours: the earlier version unlinked all four names unconditionally
 * (ATK-05). Exported for tests.
 */
export function removeCreated(dbPath: string, createdDir: string | undefined, before: DatabasePathSnapshot): void {
  for (const suffix of DATABASE_PATH_SUFFIXES) {
    if (before[suffix]) continue;
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      // best effort
    }
  }
  if (createdDir !== undefined) {
    try {
      rmdirSync(createdDir); // only succeeds while the directory is empty
    } catch {
      // someone else put something there: leave it
    }
  }
}

const FOREIGN_DEFAULT_DATABASE_WARNING =
  'warning: the default database ./.gcr/gcr.sqlite (or its directory) is not owned by the current user, so someone else may have placed it in this directory; its contents, provenance and completeness included, are whatever its creator wrote. Use --db <path> or set GCR_DB to choose a database you trust.\n';

/**
 * ATK-11. The default database is `./.gcr/gcr.sqlite` relative to the CURRENT DIRECTORY, so running `gcr` inside a directory that
 * someone else prepared (a downloaded project, a shared folder) opens a database they planted, and everything in it, provenance
 * and completeness fields included, is whatever they wrote (the same trust problem as T34, triggered by the choice of directory).
 * Returns the warning text when the database or its directory belongs to somebody other than `uid`, otherwise undefined. POSIX
 * only: without a user id (Windows) there is nothing to compare. The text names neither a path nor a user id. A missing path says
 * nothing. Not called for `--db` and `GCR_DB`: naming a database is the operator's own choice.
 */
export function defaultDatabaseOwnershipWarning(dbPath: string, uid: number | undefined = process.getuid?.()): string | undefined {
  if (uid === undefined) return undefined;
  for (const path of [dirname(dbPath), dbPath]) {
    try {
      if (lstatSync(path).uid !== uid) return FOREIGN_DEFAULT_DATABASE_WARNING;
    } catch {
      // missing or not inspectable: the open reports that in its own words
    }
  }
  return undefined;
}

/** A database file (and, for the default location, its directory) that THIS command created and may therefore take back. */
interface FreshDatabase {
  readonly gcr: Gcr;
  /** The `./.gcr` directory when this command created it too. */
  readonly dir: string | undefined;
  /** Which of the database path and its side files existed before the command: only the others may be taken back. */
  readonly before: DatabasePathSnapshot;
}

export class CommandContext {
  readonly spec: CommandSpec;
  readonly args: ParsedArgs;
  readonly io: CliEnvironment;
  readonly format: OutputFormat;
  readonly tz: string;
  /** --tz was given on the command line. */
  readonly tzExplicit: boolean;
  readonly quiet: boolean;
  readonly debug: boolean;
  readonly db: DbLocation;
  /** Set by a command that finishes normally but wants a non-zero exit (doctor with problems). */
  exitCode = 0;
  private fresh: FreshDatabase | undefined;
  private foreignWarned = false;
  private readonly keptNotes: string[] = [];

  constructor(init: {
    spec: CommandSpec;
    args: ParsedArgs;
    io: CliEnvironment;
    format: OutputFormat;
    tz: string;
    tzExplicit: boolean;
    quiet: boolean;
    debug: boolean;
    db: DbLocation;
  }) {
    this.spec = init.spec;
    this.args = init.args;
    this.io = init.io;
    this.format = init.format;
    this.tz = init.tz;
    this.tzExplicit = init.tzExplicit;
    this.quiet = init.quiet;
    this.debug = init.debug;
    this.db = init.db;
    // `gcr mcp` hands the path to the MCP entry point and never goes through openRead / openWrite, and a model-driven server over a
    // planted database is the case ATK-11 worries about most: announce it here (idempotent, so a later explicit call adds nothing).
    if (this.spec.path.length === 1 && this.spec.path[0] === 'mcp') this.warnIfForeignDefaultDatabase();
  }

  get out(): Output {
    return this.io.out;
  }

  /** A non-essential note for the human on stderr; suppressed by --quiet. Never part of the result. */
  note(text: string): void {
    if (!this.quiet) this.io.out.stderr(`note: ${text}\n`);
  }

  /**
   * Print the notes about things the command did and KEPT (a directory it created). They wait until the command succeeded, so a
   * failure that takes the directory back never claims to have created it.
   */
  flushKeptNotes(): void {
    for (const text of this.keptNotes.splice(0)) this.note(text);
  }

  /**
   * Take back a database this command created when the command then FAILED. A refused import (not an export, a bad option,
   * a limit, an unsafe ZIP) must not leave an empty database behind: the next read would answer "0 conversations" instead of
   * "run: gcr import", and a failed command would have changed the file system. Only a file that did not exist before the
   * command is ever removed, and only while it holds no import: if anything was stored, or if that cannot be told, it stays.
   * Never throws.
   */
  discardFreshDatabase(): void {
    const fresh = this.fresh;
    this.fresh = undefined;
    if (fresh === undefined) return;
    try {
      if (fresh.gcr.listBatches().length > 0) return;
    } catch {
      return;
    }
    try {
      fresh.gcr.close();
    } catch {
      // the file is what matters now
    }
    removeCreated(this.db.path, fresh.dir, fresh.before);
  }

  /**
   * ATK-11: tell the operator, on stderr only, when the DEFAULT database (./.gcr/gcr.sqlite) or its directory is not theirs. It is
   * a security warning, not a note, so --quiet does not hide it; stdout is never touched. An explicit --db / GCR_DB is silent.
   * Public for commands that open their database some other way; `gcr mcp` is announced by the constructor.
   */
  warnIfForeignDefaultDatabase(): void {
    if (this.db.origin !== 'default' || this.foreignWarned) return;
    const warning = defaultDatabaseOwnershipWarning(this.db.path);
    if (warning === undefined) return;
    this.foreignWarned = true; // once per command, whichever of the open calls comes first
    this.io.out.stderr(warning);
  }

  renderOptions(extra: { includeHidden?: boolean } = {}): RenderOptions {
    return { format: this.format, tz: this.tz, ...(extra.includeHidden === true ? { includeHidden: true } : {}) };
  }

  /** Open the database read-only (never creates, never migrates). */
  async openRead(): Promise<Gcr> {
    if (!dbExists(this.db.path)) throw dbNotFound(this.db.path);
    this.warnIfForeignDefaultDatabase();
    const { Gcr: GcrClass } = await import('../sdk/gcr.js');
    let gcr: Gcr;
    try {
      gcr = GcrClass.open({ dbPath: this.db.path, readOnly: true, actor: 'cli' });
    } catch (e) {
      // A read-only open can only be refused for writing when SQLite itself needs to write: a WAL database wants its -wal and
      // -shm files next to it, even to read. In a read-only location (a mounted backup, another user's directory) WRITE_FORBIDDEN
      // ("local write path", exit 6, "open it read-write") would blame a write nobody asked for and offer an option that does not
      // exist. Say what is going on, as the storage error it is.
      if (e instanceof GcrError && e.code === 'WRITE_FORBIDDEN') {
        throw new GcrError('DB_ERROR', `The database "${basename(this.db.path)}" cannot be read where it is: SQLite has to create its -wal and -shm files next to it, and that location is read-only.`, {
          remedy: 'Copy the database file (and its -wal file, if one exists) to a directory you can write to and point --db there, or make this directory writable.',
          details: { reason: 'READ_ONLY_LOCATION' },
          cause: e,
        });
      }
      throw e;
    }
    this.io.lifecycle.add(() => gcr.close());
    return gcr;
  }

  /**
   * Open the database for writing. By default a missing file is created (and, for the default location only, its
   * directory); `mustExist` is for commands that only make sense on imported data (graph build, drafts, annotations):
   * they fail with DB_NOT_FOUND instead of leaving an empty database behind.
   */
  async openWrite(opts: { mustExist?: boolean } = {}): Promise<Gcr> {
    // Before anything is opened or created: what is already there is not ours to take back if this command fails.
    const before = snapshotDatabasePaths(this.db.path);
    const existed = dbExists(this.db.path);
    if (opts.mustExist === true && !existed) throw dbNotFound(this.db.path);
    // Also when the database does not exist yet: a foreign ./.gcr directory is the cheapest way to plant the trap (the first import
    // would create the database in a directory somebody else owns). A missing directory has no owner to compare, and one this
    // command is about to create is its own.
    this.warnIfForeignDefaultDatabase();
    const dir = dirname(this.db.path);
    let createdDir: string | undefined;
    if (this.db.origin === 'default' && !existsSync(dir)) {
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (e) {
        throw new GcrError('DB_ERROR', 'The default database directory ./.gcr could not be created.', {
          remedy: 'Choose a writable location with --db <path> or GCR_DB.',
          details: { reason: 'cannot_create_directory' },
          cause: e,
        });
      }
      createdDir = dir;
      this.keptNotes.push('created ./.gcr (mode 0700) for the default database');
    }
    const { Gcr: GcrClass } = await import('../sdk/gcr.js');
    let gcr: Gcr;
    try {
      gcr = GcrClass.open({ dbPath: this.db.path, actor: 'cli' });
    } catch (e) {
      if (!existed) removeCreated(this.db.path, createdDir, before); // the open itself failed: take back what was prepared for it
      throw e;
    }
    this.io.lifecycle.add(() => gcr.close());
    if (!existed) this.fresh = { gcr, dir: createdDir, before };
    return gcr;
  }
}
