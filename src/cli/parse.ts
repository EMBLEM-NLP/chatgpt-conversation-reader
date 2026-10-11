/**
 * Command-line parsing on top of `node:util` parseArgs, driven by the option specs (spec.ts).
 *
 * parseArgs does the tokenizing (`--db=path`, `--db path`, `--` terminator, `-h`, `-` as a positional). This module adds
 * what a script-friendly tool needs and parseArgs does not do:
 *  - strict, typed values: integers must be plain decimal digits within the option's range, choices must be one of the
 *    documented values, text values must be non-empty;
 *  - a repeated value option (`--db a --db b`) is an ERROR instead of "last one wins": two different answers to the
 *    same question must never be resolved silently. Switches may repeat; list options (`--kinds`) accumulate;
 *  - errors are GcrError INVALID_ARGUMENT with a remedy (and a "did you mean" for misspelled options), never a raw
 *    Node error, and a typed value is never echoed back verbatim except for option NAMES, which are sanitized.
 *
 * Disambiguation rules worth knowing (all documented in docs/CLI_REFERENCE.md):
 *  - `--db -x` is rejected by parseArgs as ambiguous; write `--db=-x` to pass a value that starts with a dash.
 *  - an argument that starts with a dash and is meant as a positional (a file called `-weird.zip`) goes after `--`.
 *  - a lone `-` is a positional (stdin) for the commands that read input.
 */
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';
import { GcrError } from '../errors.js';
import { GLOBAL_OPTIONS } from './options.js';
import { ALL_GLOBALS } from './spec.js';
import type { CommandSpec, OptionSpec, PositionalSpec } from './spec.js';
import { humanList, nearest, printable } from './text.js';

const MAX_TEXT_CHARS = 4096;
const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_CHARS = 128;

type Value = string | number | boolean | string[];

/** Typed accessors over the validated option values and the positional arguments. */
export class ParsedArgs {
  readonly positionals: readonly string[];
  private readonly values: ReadonlyMap<string, Value>;

  constructor(positionals: readonly string[], values: ReadonlyMap<string, Value>) {
    this.positionals = positionals;
    this.values = values;
  }

  /** The option appeared on the command line (a switch counts only when present, whatever its value). */
  has(name: string): boolean {
    return this.values.has(name);
  }

  string(name: string): string | undefined {
    const v = this.values.get(name);
    return typeof v === 'string' ? v : undefined;
  }

  int(name: string): number | undefined {
    const v = this.values.get(name);
    return typeof v === 'number' ? v : undefined;
  }

  /** false when absent. */
  flag(name: string): boolean {
    return this.values.get(name) === true;
  }

  list(name: string): string[] | undefined {
    const v = this.values.get(name);
    return Array.isArray(v) ? [...v] : undefined;
  }

  /** A `choice` option, narrowed by the caller to its union (the parser already checked membership). */
  choice<T extends string>(name: string): T | undefined {
    return this.string(name) as T | undefined;
  }
}

/** The options a command accepts: the global ones it lists (default: all) followed by its own. */
export function effectiveOptions(spec: CommandSpec): OptionSpec[] {
  const globals = spec.globals ?? ALL_GLOBALS;
  return [...globals.map((g) => GLOBAL_OPTIONS[g]), ...spec.options];
}

function usageError(message: string, remedy: string, details?: Record<string, unknown>): GcrError {
  return new GcrError('INVALID_ARGUMENT', message, { remedy, ...(details === undefined ? {} : { details }) });
}

function optionLabel(name: string): string {
  return `--${printable(name, 40)}`;
}

function rangeText(spec: OptionSpec): string {
  const min = spec.min ?? 0;
  return spec.max === undefined ? `${min} or more` : `${min} to ${spec.max}`;
}

function convert(spec: OptionSpec, raw: string): string | number {
  const label = optionLabel(spec.name);
  switch (spec.kind) {
    case 'int': {
      // Plain digits only: Number('1e3'), Number('0x10') and Number(' 5 ') would all be accepted by a lazy parse.
      if (!/^[0-9]{1,15}$/.test(raw)) {
        throw usageError(`Option ${label} needs a whole number from ${rangeText(spec)}.`, `Example: ${label} ${spec.min ?? 1}`, { option: spec.name });
      }
      const n = Number(raw);
      const min = spec.min ?? 0;
      if (n < min || (spec.max !== undefined && n > spec.max)) {
        throw usageError(`Option ${label} is out of range: allowed ${rangeText(spec)}.`, `Choose a value from ${rangeText(spec)}.`, { option: spec.name, min, ...(spec.max === undefined ? {} : { max: spec.max }) });
      }
      return n;
    }
    case 'choice': {
      const choices = spec.choices ?? [];
      if (!choices.includes(raw)) {
        throw usageError(`Option ${label} must be one of: ${choices.join(', ')}.`, `Example: ${label} ${choices[0] ?? ''}`.trimEnd(), { option: spec.name, valid: [...choices] });
      }
      return raw;
    }
    case 'string': {
      if (raw === '' || raw.includes('\0') || raw.length > MAX_TEXT_CHARS) {
        throw usageError(`Option ${label} needs a non-empty value of at most ${MAX_TEXT_CHARS} characters.`, `Pass a value, for example ${label}=<${spec.valueName ?? 'value'}>.`, { option: spec.name });
      }
      return raw;
    }
    default:
      return raw;
  }
}

function convertList(spec: OptionSpec, raws: readonly string[]): string[] {
  const label = optionLabel(spec.name);
  const out: string[] = [];
  for (const raw of raws) {
    for (const piece of raw.split(',')) {
      const item = piece.trim();
      if (item === '' || item.length > MAX_LIST_ITEM_CHARS || item.includes('\0')) {
        throw usageError(`Option ${label} needs a comma-separated list without empty entries.`, `Example: ${label} ${spec.choices?.slice(0, 2).join(',') ?? 'a,b'}`, { option: spec.name });
      }
      if (spec.choices !== undefined && !spec.choices.includes(item)) {
        throw usageError(`Option ${label} accepts only: ${spec.choices.join(', ')}.`, `Example: ${label} ${spec.choices[0] ?? ''}`.trimEnd(), { option: spec.name, valid: [...spec.choices] });
      }
      if (!out.includes(item)) out.push(item);
    }
  }
  if (out.length > MAX_LIST_ITEMS) throw usageError(`Option ${label} accepts at most ${MAX_LIST_ITEMS} entries.`, 'Shorten the list.', { option: spec.name });
  return out;
}

interface NodeParseError {
  code?: unknown;
  message?: unknown;
}

function translateParseError(e: unknown, specs: readonly OptionSpec[], commandLine: string): GcrError {
  const err = (e ?? {}) as NodeParseError;
  const message = typeof err.message === 'string' ? err.message : '';
  const code = typeof err.code === 'string' ? err.code : '';
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const shown = /Unknown option '([^']*)'/.exec(message)?.[1] ?? '';
    const bare = shown.replace(/^-{1,2}/, '');
    const guess = nearest(bare, specs.map((s) => s.name));
    return usageError(
      `Unknown option "${printable(shown, 60)}" for "${commandLine}".`,
      `${guess === undefined ? '' : `Did you mean "--${guess}"? `}Run "${commandLine} --help" to list the options. To pass a value that starts with "-", put it after "--" or write --option=<value>.`,
      { option: printable(shown, 60) },
    );
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const name = /Option '(-{1,2}[^' <]+)/.exec(message)?.[1] ?? '';
    if (/does not take an argument/.test(message)) {
      return usageError(`Option "${printable(name, 40)}" is a switch and does not take a value.`, `Write ${printable(name, 40)} without "=<value>".`, { option: printable(name, 40) });
    }
    return usageError(
      `Option "${printable(name, 40)}" needs a value.`,
      `Write ${printable(name, 40)} <value> or ${printable(name, 40)}=<value>; a value that starts with "-" must use the "=" form.`,
      { option: printable(name, 40) },
    );
  }
  return usageError('The command line could not be parsed.', `Run "${commandLine} --help" for usage.`);
}

function runParseArgs(args: readonly string[], config: ParseArgsOptionsConfig, specs: readonly OptionSpec[], commandLine: string) {
  try {
    return parseArgs({ args: [...args], options: config, allowPositionals: true, strict: true, tokens: true });
  } catch (e) {
    throw translateParseError(e, specs, commandLine);
  }
}

/**
 * Parse `args` (everything after the command words) for a command. Throws INVALID_ARGUMENT for every problem.
 * `commandLine` is only used in messages ("gcr graph build").
 */
export function parseCommandArgs(args: readonly string[], specs: readonly OptionSpec[], commandLine: string): ParsedArgs {
  const config: ParseArgsOptionsConfig = {};
  for (const s of specs) {
    config[s.name] = {
      type: s.kind === 'boolean' ? 'boolean' : 'string',
      ...(s.kind === 'list' ? { multiple: true } : {}),
      ...(s.short === undefined ? {} : { short: s.short }),
    };
  }
  const parsed = runParseArgs(args, config, specs, commandLine);

  const seen = new Map<string, number>();
  for (const t of parsed.tokens ?? []) {
    if (t.kind === 'option') seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
  }

  const values = new Map<string, Value>();
  for (const s of specs) {
    const raw = parsed.values[s.name];
    if (raw === undefined) continue;
    if (s.kind === 'boolean') {
      values.set(s.name, true);
      continue;
    }
    if (s.kind === 'list') {
      values.set(s.name, convertList(s, (Array.isArray(raw) ? raw : [raw]).map(String)));
      continue;
    }
    if ((seen.get(s.name) ?? 0) > 1) {
      throw usageError(`Option ${optionLabel(s.name)} was given more than once.`, 'Give each option once; GCR does not pick one of two different values for you.', { option: s.name });
    }
    values.set(s.name, convert(s, String(Array.isArray(raw) ? raw[0] : raw)));
  }
  return new ParsedArgs(parsed.positionals, values);
}

/** Check the number of positional arguments against the spec; empty arguments are never valid. */
export function checkPositionals(positionals: readonly string[], specs: readonly PositionalSpec[], commandLine: string): void {
  const required = specs.filter((p) => p.optional !== true).length;
  const variadic = specs.some((p) => p.variadic === true);
  const max = variadic ? Number.POSITIVE_INFINITY : specs.length;
  if (positionals.length < required) {
    const missing = specs.filter((p) => p.optional !== true).slice(positionals.length).map((p) => `<${p.name}>`);
    throw usageError(`Missing argument ${humanList(missing, 'and')} for "${commandLine}".`, `Run "${commandLine} --help" for usage.`, { missing: missing.length });
  }
  if (positionals.length > max) {
    throw usageError(
      `Too many arguments for "${commandLine}": expected ${specs.length === 0 ? 'none' : String(specs.length)}, got ${positionals.length}.`,
      `Quote arguments that contain spaces. Run "${commandLine} --help" for usage.`,
      { expected: specs.length, got: positionals.length },
    );
  }
  for (const p of positionals) {
    if (p === '' || p.includes('\0')) throw usageError(`An argument of "${commandLine}" is empty.`, `Run "${commandLine} --help" for usage.`);
  }
}
