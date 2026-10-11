/**
 * The declarative shape of the command table. ONE table drives three things, so they cannot drift apart:
 *  - the parser (parse.ts builds `node:util` parseArgs options and validates values from these specs),
 *  - the help text (help.ts prints exactly these descriptions, defaults and examples),
 *  - the documentation capture (scripts/capture-cli-help.mjs runs the built CLI's `--help` for every entry).
 */
import type { ErrorCode } from '../errors.js';
import type { CommandContext } from './context.js';

/**
 *  - boolean: a switch, never takes a value.
 *  - string:  a non-empty text value (no NUL bytes, bounded length).
 *  - int:     a non-negative decimal integer in [min, max]; "1e3", "0x10", "+5", "5.0" and " 5" are rejected.
 *  - choice:  exactly one of `choices`.
 *  - list:    one or more values from repeated flags and/or comma-separated text (`--kinds a,b --kinds c`).
 */
export type OptionKind = 'boolean' | 'string' | 'int' | 'choice' | 'list';

export interface OptionSpec {
  /** Long name without the leading dashes. */
  readonly name: string;
  /** One-letter alias (only -h and -V exist). */
  readonly short?: string;
  readonly kind: OptionKind;
  /** Placeholder in help: `--db <path>`. */
  readonly valueName?: string;
  /** Allowed values for `choice`; documented (not enforced) for `list`. */
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly description: string;
  /** What applies when the option is absent, as help text ("default: ..."). */
  readonly defaultText?: string;
}

export interface PositionalSpec {
  readonly name: string;
  readonly description: string;
  readonly optional?: boolean;
  readonly variadic?: boolean;
}

export interface ExampleSpec {
  /** The command line WITHOUT the leading "gcr ". Synthetic ids only (00000000-0000-4000-8000-<12 hex>). */
  readonly command: string;
  readonly note: string;
}

/** Names of the global options (options.ts) a command accepts. Anything else is "unknown option" for that command. */
export type GlobalName = 'db' | 'format' | 'tz' | 'quiet' | 'debug' | 'help';

export interface CommandSpec {
  /** `['list']` or `['graph', 'build']`. */
  readonly path: readonly string[];
  /** One line: what the command does. */
  readonly summary: string;
  /** Extra paragraphs for `--help` (each entry is one line; keep them short). */
  readonly details?: readonly string[];
  readonly positionals: readonly PositionalSpec[];
  /** Alternative usage lines when positionals alone cannot express the forms (graph explain). */
  readonly usage?: readonly string[];
  readonly options: readonly OptionSpec[];
  readonly examples: readonly ExampleSpec[];
  /** Error codes this command can fail with (the help derives the exit-code table from EXIT_CODES). */
  readonly errors: readonly ErrorCode[];
  /** Extra lines in the exit-code section (for example doctor's own exit rule). */
  readonly exitNotes?: readonly string[];
  /** Global options that apply. Default: all but nothing hidden. */
  readonly globals?: readonly GlobalName[];
  run(ctx: CommandContext): Promise<void>;
}

/** A command word that only groups subcommands (`graph`, `draft`, `annotate`). */
export interface GroupSpec {
  readonly name: string;
  readonly summary: string;
  readonly children: readonly CommandSpec[];
}

export const ALL_GLOBALS: readonly GlobalName[] = ['db', 'format', 'tz', 'quiet', 'debug', 'help'];
