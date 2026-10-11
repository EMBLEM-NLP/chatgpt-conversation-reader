/**
 * Help text. Generated from the command table (spec.ts), so what `--help` says is exactly what the parser enforces.
 *
 * Plain text only: no colour, no box drawing, no terminal-width probing (output must be identical in a pipe, a log
 * file and a screen reader, NFR-04), wrapped at a fixed 80 columns. Deterministic: scripts/capture-cli-help.mjs stores
 * the output in docs/CLI_HELP.txt and a test compares it with the live output.
 */
import { ERROR_CODES, EXIT_CODES } from '../errors.js';
import type { ErrorCode } from '../errors.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { GLOBAL_OPTIONS, VERSION_OPTION } from './options.js';
import type { CommandSpec, GroupSpec, OptionSpec } from './spec.js';
import { ALL_GLOBALS } from './spec.js';

const WIDTH = 80;
const LEFT_COLUMN = 30;
const COMMAND_COLUMN = 22;

/** Greedy word wrap of one paragraph. A word longer than the width stays on its own line. */
export function wrap(text: string, width: number, indent: string, firstIndent = indent): string[] {
  const lines: string[] = [];
  let current = firstIndent;
  let empty = true;
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (!empty && current.length + 1 + word.length > width) {
      lines.push(current);
      current = indent + word;
    } else {
      current += (empty ? '' : ' ') + word;
    }
    empty = false;
  }
  lines.push(current);
  return lines;
}

function optionHead(o: OptionSpec): string {
  const names = o.short === undefined ? `    --${o.name}` : `-${o.short}, --${o.name}`;
  const value = o.kind === 'boolean' ? '' : ` <${o.valueName ?? (o.kind === 'int' ? 'n' : 'value')}>`;
  return `${names}${value}`;
}

function describe(o: OptionSpec): string {
  const parts = [o.description];
  if (o.choices !== undefined && o.kind !== 'boolean') parts.push(`One of: ${o.choices.join(', ')}.`);
  if (o.kind === 'list') parts.push('Repeatable; comma-separated values are accepted.');
  if (o.defaultText !== undefined) parts.push(`(default: ${o.defaultText})`);
  return parts.join(' ');
}

/** A two-column table: `head` padded to LEFT_COLUMN, description wrapped beside it (or below a long head). */
function twoColumns(rows: ReadonlyArray<readonly [string, string]>, column = LEFT_COLUMN, indent = '  '): string[] {
  const lines: string[] = [];
  const bodyIndent = indent + ' '.repeat(column);
  for (const [head, text] of rows) {
    const first = `${indent}${head}`;
    if (head.length + 2 <= column) {
      const wrapped = wrap(text, WIDTH, bodyIndent, first.padEnd(bodyIndent.length));
      lines.push(...wrapped);
    } else {
      lines.push(first);
      lines.push(...wrap(text, WIDTH, bodyIndent));
    }
  }
  return lines;
}

function usageLines(spec: CommandSpec): string[] {
  if (spec.usage !== undefined) return spec.usage.map((u) => `  gcr ${u}`);
  const args = spec.positionals.map((p) => {
    const name = p.variadic === true ? `${p.name}...` : p.name;
    return p.optional === true ? `[${name}]` : `<${name}>`;
  });
  return [`  gcr ${[...spec.path, ...args].join(' ')}${spec.options.length > 0 ? ' [options]' : ''}`];
}

/** Exit codes: one line per distinct code, listing the error codes that map to it. */
export function exitCodeLines(errors: readonly ErrorCode[], notes: readonly string[] = []): string[] {
  const byExit = new Map<number, ErrorCode[]>();
  const all = new Set<ErrorCode>([...errors, 'INVALID_ARGUMENT', 'INTERNAL_ERROR']);
  for (const code of ERROR_CODES) {
    if (!all.has(code)) continue;
    const n = EXIT_CODES[code];
    byExit.set(n, [...(byExit.get(n) ?? []), code]);
  }
  const lines = ['  0   success'];
  for (const n of [...byExit.keys()].sort((a, b) => a - b)) {
    lines.push(...wrap((byExit.get(n) ?? []).join(', '), WIDTH, '      ', `  ${String(n).padEnd(4)}`));
  }
  for (const note of notes) lines.push(...wrap(note, WIDTH, '      ', '  *   '));
  return lines;
}

function globalLines(spec: CommandSpec | undefined): string[] {
  const names = spec?.globals ?? ALL_GLOBALS;
  return twoColumns(names.map((n) => [optionHead(GLOBAL_OPTIONS[n]), describe(GLOBAL_OPTIONS[n])] as const));
}

export function renderCommandHelp(spec: CommandSpec): string {
  const name = `gcr ${spec.path.join(' ')}`;
  const out: string[] = [`${name} - ${spec.summary}`, '', 'Usage:', ...usageLines(spec)];
  if (spec.details !== undefined && spec.details.length > 0) {
    out.push('');
    for (const d of spec.details) out.push(...wrap(d, WIDTH, ''));
  }
  if (spec.positionals.length > 0) {
    out.push('', 'Arguments:', ...twoColumns(spec.positionals.map((p) => [p.variadic === true ? `<${p.name}>...` : `<${p.name}>`, p.description] as const)));
  }
  if (spec.options.length > 0) out.push('', 'Options:', ...twoColumns(spec.options.map((o) => [optionHead(o), describe(o)] as const)));
  out.push('', 'Global options:', ...globalLines(spec));
  out.push('', 'Examples:');
  for (const ex of spec.examples) {
    out.push(`  gcr ${ex.command}`);
    out.push(...wrap(ex.note, WIDTH, '      '));
  }
  out.push('', 'Exit codes:', ...exitCodeLines(spec.errors, spec.exitNotes));
  out.push('', 'stdout carries only the result; notes and errors go to stderr. GCR never contacts chatgpt.com.');
  return `${out.join('\n')}\n`;
}

export function renderGroupHelp(group: GroupSpec): string {
  const out: string[] = [
    `gcr ${group.name} - ${group.summary}`,
    '',
    'Usage:',
    `  gcr ${group.name} <command> [options]`,
    '',
    'Commands:',
    ...twoColumns(group.children.map((c) => [c.path.slice(1).join(' '), c.summary] as const), COMMAND_COLUMN),
    '',
    `Run "gcr help ${group.name} <command>" for the options, examples and exit codes of one command.`,
  ];
  return `${out.join('\n')}\n`;
}

export interface RootEntry {
  readonly name: string;
  readonly summary: string;
}

const ROOT_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['gcr import ~/Downloads/chatgpt-export.zip', 'Import an official export into ./.gcr/gcr.sqlite.'],
  ['gcr list --limit 10', 'The ten most recently updated conversations.'],
  ['gcr get 00000000-0000-4000-8000-000000000001', 'Print one imported conversation.'],
  ['gcr search "release notes" --format json', 'Full-text search, machine-readable.'],
];

export function renderRootHelp(entries: readonly RootEntry[]): string {
  const out: string[] = [
    `${TOOL_NAME} ${TOOL_VERSION} - read, search and annotate your own ChatGPT export data, offline`,
    '',
    'Usage:',
    '  gcr <command> [options]',
    '  gcr help [command]',
    '',
    ...wrap(
      'GCR works on conversations you imported from an official export. It never contacts chatgpt.com, never sends a message and never reads browser data: a chatgpt.com link is only a key into the data you imported.',
      WIDTH,
      '',
    ),
    '',
    'Commands:',
    ...twoColumns(entries.map((e) => [e.name, e.summary] as const), COMMAND_COLUMN),
    '',
    'Global options (before or after the command):',
    ...twoColumns([...ALL_GLOBALS.map((n) => GLOBAL_OPTIONS[n]), VERSION_OPTION].map((o) => [optionHead(o), describe(o)] as const)),
    '',
    'Examples:',
  ];
  for (const [cmd, note] of ROOT_EXAMPLES) {
    out.push(`  ${cmd}`);
    out.push(...wrap(note, WIDTH, '      '));
  }
  out.push('', 'Exit codes:', ...exitCodeLines([], ['The full table, per error code, is in docs/CLI_REFERENCE.md; each command lists the codes it can return.']));
  out.push('', 'Run "gcr help <command>" for the options, examples and exit codes of one command.');
  return `${out.join('\n')}\n`;
}

export function renderVersion(): string {
  return `${TOOL_NAME} ${TOOL_VERSION}\n`;
}
