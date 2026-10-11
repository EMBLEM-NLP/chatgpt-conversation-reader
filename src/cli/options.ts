/**
 * Option specs shared by several commands, and the global options.
 */
import type { OutputFormat, Provider } from '../domain/types.js';
import type { GlobalName, OptionSpec } from './spec.js';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['json', 'markdown', 'compact', 'jsonl'];
export const DEFAULT_FORMAT: OutputFormat = 'markdown';
export const DEFAULT_DB_RELATIVE = '.gcr/gcr.sqlite';

/** Every provider a stored conversation can have. */
export const PROVIDERS: readonly Provider[] = ['chatgpt', 'claude', 'openai_api'];
/** Providers `gcr import` can read (openai_api is a separate, disabled adapter). */
export const IMPORT_PROVIDERS: readonly Provider[] = ['chatgpt', 'claude'];

export const GLOBAL_OPTIONS: Readonly<Record<GlobalName, OptionSpec>> = {
  db: {
    name: 'db',
    kind: 'string',
    valueName: 'path',
    description: 'SQLite database file.',
    defaultText: '$GCR_DB, else ./.gcr/gcr.sqlite',
  },
  format: {
    name: 'format',
    kind: 'choice',
    valueName: 'format',
    choices: OUTPUT_FORMATS,
    description: 'Output format: json, markdown, compact (token-light text) or jsonl (one JSON value per line).',
    defaultText: 'markdown',
  },
  tz: {
    name: 'tz',
    kind: 'string',
    valueName: 'IANA',
    description: 'Time zone for human-readable times (for example Europe/Berlin). JSON keeps UTC.',
    defaultText: 'UTC',
  },
  quiet: {
    name: 'quiet',
    kind: 'boolean',
    description: 'Suppress non-essential notes on stderr. Errors are always printed.',
  },
  debug: {
    name: 'debug',
    kind: 'boolean',
    description: 'Print stack traces on stderr when a command fails (sets GCR_DEBUG=1).',
  },
  help: {
    name: 'help',
    short: 'h',
    kind: 'boolean',
    description: 'Show help for this command and exit.',
  },
};

/** Root-only switches (`gcr --version`). */
export const VERSION_OPTION: OptionSpec = {
  name: 'version',
  short: 'V',
  kind: 'boolean',
  description: 'Print the version and exit.',
};

export function providerOption(choices: readonly string[] = PROVIDERS, description = 'Only conversations of this provider.'): OptionSpec {
  return { name: 'provider', kind: 'choice', valueName: 'provider', choices, description };
}

export function accountOption(description = 'Only conversations imported under this account label.'): OptionSpec {
  return { name: 'account', kind: 'string', valueName: 'label', description };
}

export function limitOption(max: number, defaultValue: number, what = 'results'): OptionSpec {
  return { name: 'limit', kind: 'int', valueName: 'n', min: 1, max, description: `Maximum number of ${what} (1-${max}).`, defaultText: String(defaultValue) };
}

export function offsetOption(): OptionSpec {
  return { name: 'offset', kind: 'int', valueName: 'n', min: 0, max: 10_000_000, description: 'Number of results to skip (paging).', defaultText: '0' };
}

export function cursorOption(): OptionSpec {
  return { name: 'cursor', kind: 'string', valueName: 'cursor', description: 'Continue after the `nextCursor` printed by the previous page.' };
}

export function includeHiddenOption(what: string): OptionSpec {
  return { name: 'include-hidden', kind: 'boolean', description: `Include ${what} the export marks as hidden (system scaffolding, memory, ...).` };
}

export function allBatchesOption(what: string): OptionSpec {
  return { name: 'all-batches', kind: 'boolean', description: `Include superseded import snapshots, not only the newest one of each conversation (${what}).` };
}

export function batchOption(): OptionSpec {
  return { name: 'batch', kind: 'string', valueName: 'id', description: 'Read this import snapshot (a batch id from "gcr batches") instead of the newest one.' };
}
