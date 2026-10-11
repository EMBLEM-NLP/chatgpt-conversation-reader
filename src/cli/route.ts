/**
 * From the raw argument list to "what was asked for": version, help, or a command to run with the remaining arguments.
 *
 * The command words are found by scanning for the first non-option word(s). Global options that take a value (`--db x`,
 * `--format json`, `--tz Europe/Berlin`) may precede the command, so their values are skipped; every other option is
 * left for the command's own parser. A command-specific option placed BEFORE the command name is therefore not
 * understood (its value would be taken for the command) and gives "unknown command": options go after the command name.
 *
 * An unknown command is NEVER executed or guessed: the error suggests the nearest known name (edit distance) and exits 2.
 */
import { GcrError } from '../errors.js';
import { findChild, findGroup, findLeaf, TOP_LEVEL_NAMES } from './commands/index.js';
import { GLOBAL_OPTIONS } from './options.js';
import type { CommandSpec, GroupSpec } from './spec.js';
import { humanList, nearest, printable } from './text.js';

export type Route =
  | { kind: 'version' }
  | { kind: 'help-root' }
  | { kind: 'help-group'; group: GroupSpec }
  | { kind: 'help-command'; spec: CommandSpec }
  | { kind: 'run'; spec: CommandSpec; rest: string[] };

const VALUE_GLOBALS: ReadonlySet<string> = new Set(Object.values(GLOBAL_OPTIONS).filter((o) => o.kind !== 'boolean').map((o) => o.name));

function isOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/** The tokens before a "--" terminator. */
export function beforeTerminator(argv: readonly string[]): string[] {
  const end = argv.indexOf('--');
  return end === -1 ? [...argv] : argv.slice(0, end);
}

export function wantsHelp(argv: readonly string[]): boolean {
  return beforeTerminator(argv).some((t) => t === '--help' || t === '-h');
}

export function wantsVersion(argv: readonly string[]): boolean {
  return beforeTerminator(argv).some((t) => t === '--version' || t === '-V');
}

/** `--format json` / `--format=json` anywhere before "--": errors are then printed as JSON. */
export function wantsJsonErrors(argv: readonly string[]): boolean {
  const tokens = beforeTerminator(argv);
  return tokens.some((t, i) => t === '--format=json' || (t === '--format' && tokens[i + 1] === 'json'));
}

export function wantsDebug(argv: readonly string[]): boolean {
  return beforeTerminator(argv).includes('--debug');
}

function unknownCommand(word: string, pool: readonly string[], parent?: string): GcrError {
  const guess = nearest(word, pool);
  const where = parent === undefined ? '' : ` for "gcr ${parent}"`;
  const hint = parent === undefined ? 'gcr --help' : `gcr help ${parent}`;
  const suggestion = guess === undefined ? '' : `Did you mean "${parent === undefined ? guess : `${parent} ${guess}`}"? `;
  return new GcrError('INVALID_ARGUMENT', `Unknown command "${printable(word, 60)}"${where}.`, {
    remedy: `${suggestion}Run "${hint}" to see the available commands. Nothing was run.`,
    details: { command: printable(word, 60), ...(guess === undefined ? {} : { suggestion: guess }) },
  });
}

export function resolveRoute(argv: readonly string[]): Route {
  const words: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (isOption(token)) {
      rest.push(token);
      if (token.startsWith('--') && !token.includes('=') && VALUE_GLOBALS.has(token.slice(2)) && i + 1 < argv.length) {
        i++;
        rest.push(argv[i] as string);
      }
      continue;
    }
    const first = words[0];
    if (first === undefined) words.push(token);
    else if (first === 'help') words.push(token);
    else if (words.length === 1 && findGroup(first) !== undefined) words.push(token);
    else rest.push(token);
  }

  const head = words[0];
  if (head === undefined) {
    if (wantsVersion(rest)) return { kind: 'version' };
    if (wantsHelp(rest)) return { kind: 'help-root' };
    throw new GcrError('INVALID_ARGUMENT', 'No command given.', { remedy: 'Run "gcr --help" to see the commands, for example: gcr list --limit 10' });
  }

  if (head === 'help') {
    const target = words.slice(1);
    if (target.length === 0) return { kind: 'help-root' };
    const leaf = findLeaf(target[0] as string);
    if (leaf !== undefined) {
      if (target.length > 1) throw unknownCommand(target[1] as string, [], leaf.path[0]);
      return { kind: 'help-command', spec: leaf };
    }
    const group = findGroup(target[0] as string);
    if (group !== undefined) {
      if (target.length === 1) return { kind: 'help-group', group };
      const child = findChild(group, target[1] as string);
      if (child === undefined) throw unknownCommand(target[1] as string, group.children.map((c) => c.path[1] ?? ''), group.name);
      return { kind: 'help-command', spec: child };
    }
    throw unknownCommand(target[0] as string, TOP_LEVEL_NAMES);
  }

  const leaf = findLeaf(head);
  if (leaf !== undefined) return { kind: 'run', spec: leaf, rest };

  const group = findGroup(head);
  if (group !== undefined) {
    const sub = words[1];
    if (sub === undefined) {
      if (wantsHelp(rest)) return { kind: 'help-group', group };
      throw new GcrError('INVALID_ARGUMENT', `"gcr ${group.name}" needs a subcommand: ${humanList(group.children.map((c) => c.path[1] ?? ''), 'or')}.`, {
        remedy: `Run "gcr help ${group.name}" for details.`,
      });
    }
    const child = findChild(group, sub);
    if (child === undefined) throw unknownCommand(sub, group.children.map((c) => c.path[1] ?? ''), group.name);
    return { kind: 'run', spec: child, rest };
  }
  throw unknownCommand(head, TOP_LEVEL_NAMES);
}
