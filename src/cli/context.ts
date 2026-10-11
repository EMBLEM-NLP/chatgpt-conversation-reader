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
import { existsSync, mkdirSync, statSync } from 'node:fs';
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

export function dbNotFound(path: string): GcrError {
  return new GcrError('DB_NOT_FOUND', `No database found at "${basename(path)}".`, {
    remedy: 'run: gcr import <export.zip>  (or point --db / GCR_DB at an existing database)',
    details: { label: basename(path) },
  });
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

  renderOptions(extra: { includeHidden?: boolean } = {}): RenderOptions {
    return { format: this.format, tz: this.tz, ...(extra.includeHidden === true ? { includeHidden: true } : {}) };
  }

  /** Open the database read-only (never creates, never migrates). */
  async openRead(): Promise<Gcr> {
    const st = statSync(this.db.path, { throwIfNoEntry: false });
    if (st === undefined) throw dbNotFound(this.db.path);
    const { Gcr: GcrClass } = await import('../sdk/gcr.js');
    const gcr = GcrClass.open({ dbPath: this.db.path, readOnly: true, actor: 'cli' });
    this.io.lifecycle.add(() => gcr.close());
    return gcr;
  }

  /**
   * Open the database for writing. By default a missing file is created (and, for the default location only, its
   * directory); `mustExist` is for commands that only make sense on imported data (graph build, drafts, annotations):
   * they fail with DB_NOT_FOUND instead of leaving an empty database behind.
   */
  async openWrite(opts: { mustExist?: boolean } = {}): Promise<Gcr> {
    if (opts.mustExist === true && statSync(this.db.path, { throwIfNoEntry: false }) === undefined) throw dbNotFound(this.db.path);
    const dir = dirname(this.db.path);
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
      this.note('created ./.gcr (mode 0700) for the default database');
    }
    const { Gcr: GcrClass } = await import('../sdk/gcr.js');
    const gcr = GcrClass.open({ dbPath: this.db.path, actor: 'cli' });
    this.io.lifecycle.add(() => gcr.close());
    return gcr;
  }
}
