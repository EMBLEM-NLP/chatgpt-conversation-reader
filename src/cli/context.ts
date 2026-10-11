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
 *  - `:memory:` and `file:` URIs make no sense for a one-shot process (the data would vanish / SQLite options could be
 *    smuggled in), so they are refused up front.
 *
 * The SDK (and with it node:sqlite) is imported lazily so `gcr --help` and `gcr --version` start instantly and never
 * load SQLite.
 */
import { existsSync, mkdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
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

/** A database file (and, for the default location, its directory) that THIS command created and may therefore take back. */
interface FreshDatabase {
  readonly gcr: Gcr;
  /** The `./.gcr` directory when this command created it too. */
  readonly dir: string | undefined;
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
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        rmSync(this.db.path + suffix, { force: true });
      } catch {
        // best effort
      }
    }
    if (fresh.dir !== undefined) {
      try {
        rmdirSync(fresh.dir); // only succeeds while the directory is empty
      } catch {
        // someone else put something there: leave it
      }
    }
  }

  renderOptions(extra: { includeHidden?: boolean } = {}): RenderOptions {
    return { format: this.format, tz: this.tz, ...(extra.includeHidden === true ? { includeHidden: true } : {}) };
  }

  /** Open the database read-only (never creates, never migrates). */
  async openRead(): Promise<Gcr> {
    if (!dbExists(this.db.path)) throw dbNotFound(this.db.path);
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
    const existed = dbExists(this.db.path);
    if (opts.mustExist === true && !existed) throw dbNotFound(this.db.path);
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
    const gcr = GcrClass.open({ dbPath: this.db.path, actor: 'cli' });
    this.io.lifecycle.add(() => gcr.close());
    if (!existed) this.fresh = { gcr, dir: createdDir };
    return gcr;
  }
}
