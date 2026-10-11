/**
 * The command table: every command GCR has, in the order `gcr --help` lists them. There is deliberately no command that
 * sends, posts, opens a browser or contacts chatgpt.com (a test asserts the absence of such names).
 */
import type { RootEntry } from '../help.js';
import type { CommandSpec, GroupSpec } from '../spec.js';
import { GRAPH_COMMANDS } from './graph.js';
import { importCommand, importCopyCommand } from './import.js';
import { ANNOTATE_COMMANDS, DRAFT_COMMANDS } from './local.js';
import { auditCommand, batchesCommand, branchesCommand, getCommand, listCommand, searchCommand, statsCommand, threadCommand } from './read.js';
import { doctorCommand, mcpCommand } from './system.js';

export const GROUPS: readonly GroupSpec[] = [
  { name: 'graph', summary: 'Knowledge graph: build, query, path, neighbors, god-nodes, explain, export.', children: GRAPH_COMMANDS },
  { name: 'draft', summary: 'Local drafts (never sent): create, list, show, archive.', children: DRAFT_COMMANDS },
  { name: 'annotate', summary: 'Local notes on conversations and messages: create, update, list, show.', children: ANNOTATE_COMMANDS },
];

/** Top-level commands in help order (groups are listed where their name appears in ROOT_ORDER). */
const LEAVES: readonly CommandSpec[] = [
  doctorCommand,
  importCommand,
  importCopyCommand,
  batchesCommand,
  listCommand,
  getCommand,
  searchCommand,
  branchesCommand,
  threadCommand,
  statsCommand,
  auditCommand,
  mcpCommand,
];

export const HELP_SUMMARY = 'Show help for a command: gcr help <command>.';

const ROOT_ORDER: readonly string[] = ['doctor', 'import', 'import-copy', 'batches', 'list', 'get', 'search', 'branches', 'thread', 'stats', 'audit', 'graph', 'draft', 'annotate', 'mcp', 'help'];

/** Every command with a handler, groups expanded. */
export const COMMANDS: readonly CommandSpec[] = [...LEAVES, ...GROUPS.flatMap((g) => g.children)];

/** Names that can start a command line. */
export const TOP_LEVEL_NAMES: readonly string[] = ROOT_ORDER;

export function findLeaf(name: string): CommandSpec | undefined {
  return LEAVES.find((c) => c.path[0] === name);
}

export function findGroup(name: string): GroupSpec | undefined {
  return GROUPS.find((g) => g.name === name);
}

export function findChild(group: GroupSpec, name: string): CommandSpec | undefined {
  return group.children.find((c) => c.path[1] === name);
}

export function rootEntries(): RootEntry[] {
  return ROOT_ORDER.map((name) => {
    const leaf = findLeaf(name);
    if (leaf !== undefined) return { name, summary: leaf.summary };
    const group = findGroup(name);
    if (group !== undefined) return { name: `${name} <command>`, summary: group.summary };
    return { name, summary: HELP_SUMMARY };
  });
}
