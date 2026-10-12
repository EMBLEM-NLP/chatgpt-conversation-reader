/**
 * `gcr graph ...`: the derived knowledge graph (entities, tools and conversations linked by co-occurrence).
 *
 * `build` rewrites only the derived graph tables (imported data is never touched) and needs an existing database. Every
 * other subcommand is read-only. `export` writes a self-contained HTML page to a file the operator names, with the
 * overwrite and symlink protections of export-file.ts.
 */
import { basename } from 'node:path';
import type { EntityKind } from '../../entities/extract.js';
import { ENTITY_KINDS } from '../../entities/extract.js';
import { GcrError } from '../../errors.js';
import type { ErrorCode } from '../../errors.js';
import { renderEnvelope } from '../../format/render.js';
import type { ResultEnvelope } from '../../domain/types.js';
import type { CommandContext } from '../context.js';
import { writeExportFile } from '../export-file.js';
import { accountOption, limitOption, providerOption } from '../options.js';
import type { CommandSpec, OptionSpec } from '../spec.js';
import { defined, emit, first } from './common.js';
import { DB_READ_ERRORS } from './read.js';

/** Node kinds of the graph (pinned against the SDK's by test/cli/spec.test.ts). */
const NODE_KINDS = ['conversation', 'entity', 'tool'] as const;
const EDGE_KINDS = ['mentioned_in', 'co_occurs', 'uses_tool'] as const;
// "tool" is both a node kind and an entity kind (a tool name becomes a `tool:<name>` node): list it once.
const NODE_OR_ENTITY_KINDS: readonly string[] = [...new Set<string>([...NODE_KINDS, ...ENTITY_KINDS])];

const GRAPH_ERRORS: readonly ErrorCode[] = ['NOT_IN_LOCAL_EXPORT', ...DB_READ_ERRORS];

function kindsOption(what: string): OptionSpec {
  return { name: 'kinds', kind: 'list', valueName: 'kinds', choices: NODE_OR_ENTITY_KINDS, description: `Only ${what} of these kinds. Node kinds: conversation, entity, tool. Entity kinds (they keep the entity nodes of that kind): url, uuid, timestamp, code_language, file_name, keyword. "tool" is both: it keeps the tool nodes.` };
}

function nodeIdNote(): string {
  return 'Node ids are printed by "gcr graph query" and "gcr graph god-nodes".';
}

export const graphBuild: CommandSpec = {
  path: ['graph', 'build'],
  summary: 'Build (or rebuild) the knowledge graph from the imported conversations.',
  details: [
    'Extracts URLs, UUIDs, timestamps, tool names, code languages, file names and keywords from message text (locally, with fixed patterns) and links the conversations they appear in. Only derived tables are rewritten; imported data is never touched. Rebuild after importing.',
    'Every edge keeps its evidence (conversation, message and branch ids): see "gcr graph explain".',
  ],
  positionals: [],
  options: [
    { name: 'min-conversations', kind: 'int', valueName: 'n', min: 1, max: 1_000_000, description: 'Keep an entity only if it occurs in at least this many conversations (tool names are always kept).', defaultText: '2' },
    { name: 'kinds', kind: 'list', valueName: 'kinds', choices: ENTITY_KINDS, description: 'Entity kinds to extract.', defaultText: 'all' },
    providerOption(undefined, 'Build the graph from this provider only.'),
    accountOption('Build the graph from this account label only.'),
  ],
  examples: [
    { command: 'graph build', note: 'Build the graph from everything imported.' },
    { command: 'graph build --min-conversations 3 --kinds url,tool --format json', note: 'Keep only URLs and tool names that occur in at least three conversations. This replaces the graph built before: run "gcr graph build" again to get the full graph back.' },
  ],
  errors: [...DB_READ_ERRORS, 'WRITE_FORBIDDEN'],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const gcr = await ctx.openWrite({ mustExist: true });
    const env = await gcr.buildGraph(
      defined({
        provider: a.string('provider'),
        accountLabel: a.string('account'),
        minEntityConversations: a.int('min-conversations'),
        kinds: a.list('kinds') as EntityKind[] | undefined,
      }),
    );
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};

export const graphQuery: CommandSpec = {
  path: ['graph', 'query'],
  summary: 'Show the neighbourhood of a term in the graph (breadth-first).',
  details: [
    'The term is matched against node labels and ids (plain text). Results are bounded by --depth and --max-nodes, and truncation is reported.',
    'Keywords are single words: a name such as EMBLEM-NLP is stored as the keywords "emblem" and "nlp". When no node matches the whole term and it contains a hyphen, underscore, dot between letters or space, it is split the same way and every keyword node that matches one of its words is a seed (warning TERM_SPLIT names the words). When nothing matches, the answer is an empty graph with the warning NO_MATCHING_NODE, never a silent one.',
  ],
  positionals: [{ name: 'term', description: 'Word or phrase to look for in node labels (quote it when it has spaces).' }],
  options: [
    { name: 'depth', kind: 'int', valueName: 'n', min: 1, max: 4, description: 'How many hops to follow from the matching nodes (1-4).', defaultText: '2' },
    { name: 'max-nodes', kind: 'int', valueName: 'n', min: 1, max: 500, description: 'Most nodes in the answer (1-500).', defaultText: '100' },
    kindsOption('nodes'),
  ],
  examples: [
    { command: 'graph query quokka', note: 'Everything within two hops of nodes that mention "quokka".' },
    { command: 'graph query "release notes" --depth 1 --kinds url --format json', note: 'URL nodes next to "release notes", machine-readable.' },
    { command: 'graph query "EMBLEM-NLP" --depth 2', note: 'A hyphenated name is split into its keywords (emblem, nlp) when no node has that exact name; TERM_SPLIT says so.' },
  ],
  errors: [...GRAPH_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const gcr = await ctx.openRead();
    const env = gcr.graphQuery({ term: first(ctx), ...defined({ depth: a.int('depth'), maxNodes: a.int('max-nodes'), kinds: a.list('kinds') }) });
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};

export const graphPath: CommandSpec = {
  path: ['graph', 'path'],
  summary: 'Find the shortest path between two graph nodes.',
  details: [nodeIdNote(), 'A search budget bounds the work; if it is exhausted the answer says "not found within the budget", not "no path exists".'],
  positionals: [
    { name: 'from', description: 'Node id to start from.' },
    { name: 'to', description: 'Node id to reach.' },
  ],
  options: [{ name: 'max-depth', kind: 'int', valueName: 'n', min: 1, max: 12, description: 'Longest path in hops (1-12).', defaultText: '6' }],
  examples: [
    { command: 'graph path conv:chatgpt:default:00000000-0000-4000-8000-000000000001 conv:chatgpt:default:00000000-0000-4000-8000-000000000002', note: 'The shortest chain of shared entities between two conversations (use the ids printed by graph query).' },
    { command: 'graph path tool:python ent:keyword:synthetic --max-depth 3 --format json', note: 'Limit the search to three hops (a tool node and a keyword node of the demo data in docs/USER_GUIDE.md).' },
  ],
  errors: [...GRAPH_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const [from, to] = ctx.args.positionals;
    const gcr = await ctx.openRead();
    const env = gcr.graphPath(from ?? '', to ?? '', defined({ maxDepth: ctx.args.int('max-depth') }));
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};

export const graphNeighbors: CommandSpec = {
  path: ['graph', 'neighbors'],
  summary: 'List the direct neighbours of one graph node.',
  details: [nodeIdNote()],
  positionals: [{ name: 'node', description: 'Node id.' }],
  options: [
    limitOption(500, 50, 'neighbours'),
    kindsOption('neighbours'),
    { name: 'edge-kinds', kind: 'list', valueName: 'kinds', choices: EDGE_KINDS, description: 'Only follow edges of these kinds.' },
  ],
  examples: [
    { command: 'graph neighbors conv:chatgpt:default:00000000-0000-4000-8000-000000000001 --limit 10', note: 'The ten strongest neighbours of a conversation node.' },
    { command: 'graph neighbors conv:chatgpt:default:00000000-0000-4000-8000-000000000001 --edge-kinds uses_tool --format json', note: 'Only the tools a conversation used.' },
  ],
  errors: [...GRAPH_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const gcr = await ctx.openRead();
    const env = gcr.graphNeighbors(first(ctx), defined({ limit: a.int('limit'), kinds: a.list('kinds'), edgeKinds: a.list('edge-kinds') }));
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};

export const graphGodNodes: CommandSpec = {
  path: ['graph', 'god-nodes'],
  summary: 'List the most connected nodes (highest weighted degree).',
  details: ['Useful as a map of what your conversations are about: the entities and tools that appear everywhere.'],
  positionals: [],
  options: [limitOption(500, 10, 'nodes'), kindsOption('nodes')],
  examples: [
    { command: 'graph god-nodes', note: 'The ten most connected nodes.' },
    { command: 'graph god-nodes --limit 25 --kinds tool,url --format json', note: 'The 25 most connected tools and URLs.' },
  ],
  errors: [...GRAPH_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const gcr = await ctx.openRead();
    const env = gcr.graphGodNodes(defined({ limit: a.int('limit'), kinds: a.list('kinds') }));
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};

export const graphExplain: CommandSpec = {
  path: ['graph', 'explain'],
  summary: 'Show the evidence behind one graph edge: the messages and branches that support it.',
  details: ['Name the edge by its numeric id (from graph query or neighbors) or by its source node, target node and kind. Every graph fact traces back to message ids and the branch ids that contain them.'],
  usage: ['graph explain <edge-id> [options]', 'graph explain <src> <dst> <kind> [options]'],
  positionals: [
    { name: 'edge-id', description: 'Numeric edge id, or the source node id when dst and kind follow.' },
    { name: 'dst', description: 'Target node id.', optional: true },
    { name: 'kind', description: 'Edge kind: mentioned_in, co_occurs or uses_tool.', optional: true },
  ],
  options: [{ name: 'limit', kind: 'int', valueName: 'n', min: 1, max: 1000, description: 'Most evidence rows (1-1000).', defaultText: '100' }],
  examples: [
    { command: 'graph explain 12', note: 'Evidence for edge number 12 (edge ids are printed by graph query and graph neighbors; they depend on your graph).' },
    { command: 'graph explain ent:keyword:active ent:keyword:synthetic co_occurs --format json', note: 'Evidence for the co-occurrence edge between two keyword nodes of the demo data.' },
  ],
  errors: [...GRAPH_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const positionals = ctx.args.positionals;
    const opts = defined({ limit: ctx.args.int('limit') });
    let ref: { edgeId: number } | { src: string; dst: string; kind: string };
    if (positionals.length === 1) {
      const raw = positionals[0] ?? '';
      if (!/^[0-9]{1,15}$/.test(raw) || Number(raw) < 1) {
        throw new GcrError('INVALID_ARGUMENT', 'A single argument must be a positive edge id.', { remedy: 'Pass an edge id (for example 12) or three arguments: <src> <dst> <kind>.' });
      }
      ref = { edgeId: Number(raw) };
    } else if (positionals.length === 3) {
      ref = { src: positionals[0] ?? '', dst: positionals[1] ?? '', kind: positionals[2] ?? '' };
    } else {
      throw new GcrError('INVALID_ARGUMENT', `"gcr graph explain" takes one argument (an edge id) or three (<src> <dst> <kind>); got ${positionals.length}.`, {
        remedy: 'Run "gcr graph explain --help" for usage.',
      });
    }
    const gcr = await ctx.openRead();
    emit(ctx, renderEnvelope(gcr.graphExplain(ref, opts), ctx.renderOptions()));
  },
};

export const graphExport: CommandSpec = {
  path: ['graph', 'export'],
  summary: 'Write the graph (or the neighbourhood of a term) as a self-contained offline HTML page.',
  details: [
    'The page loads nothing from the network and escapes every label. It contains labels from your conversations, so the file is created with mode 0600. An existing file is never overwritten unless --force is given, and a symbolic link is never written through.',
    'Prints the path written (JSON output prints only the file name).',
  ],
  positionals: [],
  options: [
    { name: 'out', kind: 'string', valueName: 'file.html', description: 'File to create (required; must end in .html and its directory must exist).' },
    { name: 'force', kind: 'boolean', description: 'Replace an existing regular file. Links and directories are still refused.' },
    { name: 'term', kind: 'string', valueName: 'term', description: 'Export the neighbourhood of this term instead of the most connected nodes.' },
    { name: 'depth', kind: 'int', valueName: 'n', min: 1, max: 4, description: 'Hops to follow from the term (with --term).', defaultText: '2' },
    { name: 'max-nodes', kind: 'int', valueName: 'n', min: 1, max: 500, description: 'Most nodes on the page (1-500).', defaultText: '100' },
    kindsOption('nodes'),
    { name: 'title', kind: 'string', valueName: 'text', description: 'Page title (up to 200 characters).', defaultText: 'GCR graph export' },
  ],
  examples: [
    { command: 'graph export --out graph.html', note: 'The most connected nodes of the whole graph.' },
    { command: 'graph export --term quokka --depth 2 --out quokka.html --force', note: 'The neighbourhood of "quokka", replacing quokka.html if it exists.' },
  ],
  errors: [...GRAPH_ERRORS, 'WRITE_FORBIDDEN'],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const out = a.string('out');
    if (out === undefined) {
      throw new GcrError('INVALID_ARGUMENT', 'Option --out is required.', { remedy: 'Name the file to create, for example: gcr graph export --out graph.html', details: { option: 'out' } });
    }
    const gcr = await ctx.openRead();
    const page = gcr.graphExportHtml(
      defined({ term: a.string('term'), depth: a.int('depth'), maxNodes: a.int('max-nodes'), kinds: a.list('kinds'), title: a.string('title') }),
    );
    const written = await writeExportFile(out, page.html, a.flag('force'));
    // JSON/JSONL must not leak the directory layout into logs and pipelines: only the file name. People get the path they typed.
    const machine = ctx.format === 'json' || ctx.format === 'jsonl';
    const env: ResultEnvelope<Record<string, unknown>> = {
      ok: true,
      data: { file: machine ? basename(out) : out, bytes: written.bytes, nodes: page.nodes, edges: page.edges, mode: written.mode },
      source: page.source,
      completeness: page.completeness,
      warnings: page.warnings,
      ids: {},
      untrustedContent: page.untrustedContent,
    };
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};

export const GRAPH_COMMANDS: readonly CommandSpec[] = [graphBuild, graphQuery, graphPath, graphNeighbors, graphGodNodes, graphExplain, graphExport];
