/**
 * `gcr doctor` and `gcr mcp`.
 */
import { statSync } from 'node:fs';
import type { CommandContext } from '../context.js';
import { dbNotFound } from '../context.js';
import { renderDoctor } from '../render-local.js';
import type { CommandSpec } from '../spec.js';
import { emit } from './common.js';

/** Database states that make `doctor` exit 5 (storage) instead of 1 (the environment). */
const DATABASE_PROBLEMS: ReadonlySet<string> = new Set(['newer_than_tool', 'not_a_gcr_database', 'unreadable', 'not_a_file', 'invalid_path', 'unsupported_runtime']);

export const doctorCommand: CommandSpec = {
  path: ['doctor'],
  summary: 'Check this machine and the database; list what GCR supports and what it does not.',
  details: [
    'Fully offline: reports the Node version, node:sqlite and FTS5, the supported schema version, the state of the database file (read-only inspection, nothing is created or changed) and the capability modes A to E, stated honestly (for example "no live export verified").',
    'Environment variables are reported as present or absent; their values are never read. Paths are reduced to file names.',
  ],
  positionals: [],
  options: [],
  examples: [
    { command: 'doctor', note: 'Check the environment and the default database.' },
    { command: 'doctor --db ./work.sqlite --format json', note: 'Inspect a specific database file, machine-readable.' },
  ],
  errors: [],
  exitNotes: ['doctor exits 0 when every check passes, 5 when the inspected database is unusable (newer schema, not a GCR database, unreadable) and 1 when the environment is missing a prerequisite (old Node, no FTS5). The report is printed in every case.'],
  async run(ctx: CommandContext): Promise<void> {
    const { Gcr } = await import('../../sdk/gcr.js');
    const report = Gcr.doctor({ dbPath: ctx.db.path });
    emit(ctx, renderDoctor(report, ctx.renderOptions()));
    if (!report.ok) ctx.exitCode = report.database !== null && DATABASE_PROBLEMS.has(report.database.schemaStatus) ? 5 : 1;
  },
};

export const mcpCommand: CommandSpec = {
  path: ['mcp'],
  summary: 'Run the local MCP server on stdio over the database.',
  details: [
    'Speaks the Model Context Protocol over stdin/stdout for an MCP client such as VS Code or Codex. While it runs NOTHING but JSON-RPC is written to stdout; logs go to stderr. The database is opened read-only unless --allow-local-writes is given.',
    'Read tools: list, get, search, branches, thread, stats, audit, graph query. With --allow-local-writes the server may also create local drafts and annotations (it can never send a message anywhere). Importing through MCP additionally needs GCR_APPROVED_IMPORT_ROOTS.',
    'The server exits cleanly when its input closes. It handles SIGINT and SIGTERM itself and then exits 0 after closing the database.',
  ],
  positionals: [],
  options: [{ name: 'allow-local-writes', kind: 'boolean', description: 'Let MCP clients create local drafts and annotations (and, with approved roots, import). Without it the database is read-only.' }],
  examples: [
    { command: 'mcp --db ./work.sqlite', note: 'Read-only MCP server over work.sqlite (configure your MCP client to run exactly this command).' },
    { command: 'mcp --db ./work.sqlite --allow-local-writes', note: 'Also allow local drafts and annotations.' },
  ],
  errors: ['DB_NOT_FOUND', 'DB_SCHEMA_TOO_NEW', 'DB_ERROR'],
  exitNotes: ['The exit code is the one the server reports: 0 after a clean shutdown, otherwise the code of the failure.'],
  globals: ['db', 'quiet', 'debug', 'help'],
  async run(ctx: CommandContext): Promise<void> {
    // The server never creates or migrates a database from here: a missing file is the same answer as for every other command.
    if (statSync(ctx.db.path, { throwIfNoEntry: false }) === undefined) throw dbNotFound(ctx.db.path);
    // The server installs its own SIGINT/SIGTERM handlers (graceful shutdown) and its own broken-pipe handling on the
    // JSON-RPC channel; the CLI's would race with them and cut the shutdown short.
    ctx.io.lifecycle.signalsDelegated = true;
    ctx.out.onBrokenPipe(() => undefined);
    const { runMcpServer } = await import('../../mcp/entry.js');
    const argv = ['--db', ctx.db.path, ...(ctx.args.flag('allow-local-writes') ? ['--allow-local-writes'] : [])];
    ctx.exitCode = await runMcpServer(argv, { ...ctx.io.env });
  },
};
