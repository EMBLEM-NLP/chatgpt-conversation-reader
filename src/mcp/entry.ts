#!/usr/bin/env node
// The first import MUST be the bootstrap: when this file is the process entry it installs the stdout guard before any other
// module of the graph is evaluated (see stdio-bootstrap.ts; test/mcp/source.boundary.test.ts pins the order).
import { runningAsEntry } from './stdio-bootstrap.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EXIT_CODES, GcrError } from '../errors.js';
import { log } from '../logger.js';
import type { Gcr } from '../sdk/gcr.js';
import { TOOL_VERSION } from '../version.js';
import { parseApprovedRoots } from './approved-roots.js';
import { parseMaxResultBytes } from './envelope.js';
import type { createGcrMcpServer } from './server.js';
import { installStdoutGuard } from './stdout-guard.js';

/**
 * Process entry of the local MCP server (SPEC FR-07): `node dist/mcp/entry.js --db <path> [--allow-local-writes]`.
 *
 * The server speaks MCP over stdio. stdout carries ONLY JSON-RPC frames (the guard redirects everything else to stderr);
 * stderr is the log channel and never receives conversation text or absolute private paths (NFR-07). The database is
 * opened READ-ONLY unless local writes are enabled by `--allow-local-writes` or `GCR_MCP_ALLOW_WRITES=1`.
 *
 * Environment:
 *   GCR_DB                      database path when --db is not given
 *   GCR_MCP_ALLOW_WRITES        "1" enables drafts, annotations and import (anything else keeps the server read-only)
 *   GCR_APPROVED_IMPORT_ROOTS   absolute directories (platform path delimiter) that gcr_import_export may read from
 *   GCR_MCP_MAX_RESULT_BYTES    result size cap, 8192 to 3000000 (default 200000)
 *   GCR_LOG_LEVEL / GCR_DEBUG   stderr log threshold (error | warn | info | debug)
 *
 * Known and documented (docs/MCP_TOOLS.md sections 5 and 9, ATK-11): one request or response frame over the SDK transport's
 * 10 MiB read buffer does not fail a single call, it closes the connection and this process exits (logged as
 * `mcp_transport_error`). GCR keeps its own frames below the limit with the result cap; a hostile CLIENT can still end the session.
 */

export interface McpArgs {
  dbPath: string | undefined;
  allowLocalWrites: boolean;
  help: boolean;
  version: boolean;
}

export const MCP_USAGE = [
  'Usage: node dist/mcp/entry.js --db <database> [--allow-local-writes]',
  '',
  'Local MCP server (stdio) over a GCR database. Read-only unless --allow-local-writes is given.',
  '',
  '  --db <path>             database file (default: $GCR_DB)',
  '  --allow-local-writes    enable gcr_create_local_draft, gcr_update_local_annotation and gcr_import_export',
  '                          (also: GCR_MCP_ALLOW_WRITES=1). gcr_import_export additionally needs',
  '                          GCR_APPROVED_IMPORT_ROOTS.',
  '  -h, --help              show this help',
  '  -v, --version           show the version',
  '',
  'Environment: GCR_DB, GCR_MCP_ALLOW_WRITES, GCR_APPROVED_IMPORT_ROOTS, GCR_MCP_MAX_RESULT_BYTES, GCR_LOG_LEVEL.',
  '',
].join('\n');

/** Pure argument parser. Throws GcrError(INVALID_ARGUMENT) with a content-free message. */
export function parseMcpArgs(argv: readonly string[]): McpArgs {
  const out: McpArgs = { dbPath: undefined, allowLocalWrites: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--allow-local-writes') out.allowLocalWrites = true;
    else if (arg === '--db' || arg.startsWith('--db=')) {
      let value: string | undefined;
      if (arg === '--db') {
        value = argv[i + 1];
        i++;
      } else {
        value = arg.slice('--db='.length);
      }
      if (value === undefined || value === '' || value.startsWith('--')) throw new GcrError('INVALID_ARGUMENT', '--db needs a database path.');
      if (out.dbPath !== undefined) throw new GcrError('INVALID_ARGUMENT', '--db was given more than once.');
      out.dbPath = value;
    } else {
      // The unknown argument is not echoed: it may be anything the launcher passed.
      throw new GcrError('INVALID_ARGUMENT', 'Unknown argument. See --help.');
    }
  }
  return out;
}

function stderrLine(text: string): void {
  process.stderr.write(`${text}\n`);
}

function exitCodeFor(e: unknown): number {
  return e instanceof GcrError ? EXIT_CODES[e.code] : 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Run the server until stdin ends, SIGINT/SIGTERM arrives, the transport closes or the reader of stdout disappears; then
 * close the server and the database and RESOLVE with the exit code (0 after a clean shutdown, 2 for a usage error, the
 * code of the failing GcrError class otherwise). It never calls `process.exit` itself: the file's own bootstrap (below) does,
 * and an embedding program decides for itself.
 *
 * The stdout guard is installed first thing (idempotent), so even when this function is called from another program no
 * byte but a JSON-RPC frame reaches stdout from here on.
 */
export async function runMcpServer(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const guard = installStdoutGuard();
  // The shared filter (src/suppress-warnings.ts: it drops ONLY the node:sqlite ExperimentalWarning). Imported dynamically, here,
  // for two reasons: importing it has the side effect of installing it, which `entry.ts` must not have when merely imported;
  // and it has to be in place BEFORE `node:sqlite` loads (see below).
  const { installSqliteWarningFilter } = await import('../suppress-warnings.js');
  installSqliteWarningFilter();

  let args: McpArgs;
  let maxResultBytes: number;
  try {
    args = parseMcpArgs(argv);
    maxResultBytes = parseMaxResultBytes(env['GCR_MCP_MAX_RESULT_BYTES']);
  } catch (e) {
    stderrLine(`gcr-mcp: ${e instanceof GcrError ? e.message : 'invalid arguments'}`);
    stderrLine(MCP_USAGE);
    return 2;
  }
  if (args.help || args.version) {
    // Human invocation (no protocol session): the real stdout is the right place, and rpcOut is the only handle on it.
    await new Promise<void>((resolve) => guard.rpcOut.write(args.help ? MCP_USAGE : `gcr-mcp ${TOOL_VERSION}\n`, () => resolve()));
    return 0;
  }

  const dbPath = args.dbPath ?? (env['GCR_DB'] === '' ? undefined : env['GCR_DB']);
  if (dbPath === undefined) {
    stderrLine('gcr-mcp: no database given. Pass --db <path> or set GCR_DB.');
    return 2;
  }
  const writesFlag = env['GCR_MCP_ALLOW_WRITES'];
  if (writesFlag !== undefined && writesFlag !== '' && writesFlag !== '0' && writesFlag !== '1') {
    // Fail closed: only the exact value "1" enables writes.
    log.warn('mcp_allow_writes_value_ignored');
  }
  const allowWrites = args.allowLocalWrites || writesFlag === '1';
  const approvedImportRoots = parseApprovedRoots(env['GCR_APPROVED_IMPORT_ROOTS']);
  if (approvedImportRoots.ignored > 0) log.warn('mcp_approved_roots_ignored', { count: approvedImportRoots.ignored });

  // Loaded only now, after the warning filter is in place: Node prints the node:sqlite ExperimentalWarning when that builtin
  // LOADS, which for a static import happens before ANY module code runs, so only a dynamic import can still filter it.
  // (--help, --version and usage errors above therefore never load SQLite at all.)
  const { Gcr: GcrClass } = await import('../sdk/gcr.js');
  const { createGcrMcpServer: buildServer } = await import('./server.js');

  let gcr: Gcr;
  try {
    // Read-only by default: the handle itself cannot write, whatever a tool (or a bug) attempts.
    gcr = GcrClass.open({ dbPath, readOnly: !allowWrites, actor: 'mcp' });
  } catch (e) {
    if (e instanceof GcrError) {
      stderrLine(`gcr-mcp: cannot open the database (${e.code}): ${e.message}${e.remedy === undefined ? '' : ` ${e.remedy}`}`);
    } else {
      stderrLine('gcr-mcp: cannot open the database.');
    }
    return exitCodeFor(e);
  }

  let server: ReturnType<typeof createGcrMcpServer>;
  try {
    server = buildServer(gcr, { allowWrites, approvedImportRoots, maxResultBytes });
  } catch (e) {
    gcr.close();
    stderrLine('gcr-mcp: cannot build the server.');
    return exitCodeFor(e);
  }
  // Transport-level problems (an unparseable line, an oversize message) are otherwise silent. Log the error NAME only:
  // a SyntaxError message quotes the offending input.
  server.server.onerror = (e) => log.error('mcp_transport_error', { error: e.name });

  return await new Promise<number>((resolve) => {
    let closing = false;
    const listeners: Array<[NodeJS.EventEmitter, string, () => void]> = [];
    const on = (emitter: NodeJS.EventEmitter, event: string, fn: () => void): void => {
      emitter.on(event, fn);
      listeners.push([emitter, event, fn]);
    };
    // A second signal during the shutdown means "do not wait for a slow reader any longer" (see `shutdown`).
    let impatient = false;
    let stopWaiting: () => void = () => {
      impatient = true;
    };
    const shutdown = async (reason: string, code = 0): Promise<void> => {
      if (closing) return;
      closing = true;
      log.info('mcp_shutdown', { reason });
      try {
        // Bounded: a transport that never finishes closing must not keep the process alive.
        await Promise.race([server.close(), delay(1500)]);
      } catch {
        log.warn('mcp_server_close_failed');
      }
      // Answers that were already computed must reach the reader before the process leaves: stdout is a pipe, its writes are
      // asynchronous and it holds only 64 KiB, so leaving now would drop queued frames (or cut one in half). The wait is
      // bounded, and a second SIGINT/SIGTERM ends it at once.
      if (!impatient) {
        await Promise.race([
          guard.flush(),
          new Promise<void>((done) => {
            stopWaiting = done;
          }),
        ]);
      }
      // Only now are the signal handlers given back (they stay installed until here so that `onSignal` can see a second signal).
      for (const [emitter, event, fn] of listeners) emitter.off(event, fn);
      try {
        gcr.close();
      } catch {
        log.warn('mcp_database_close_failed');
      }
      resolve(code);
    };
    const onSignal = (name: string): void => {
      if (closing) stopWaiting();
      else void shutdown(name);
    };

    // The SDK stdio transport ignores stdin EOF: without this a server holding any other handle (the database) never exits.
    on(process.stdin, 'end', () => void shutdown('stdin_end'));
    on(process, 'SIGINT', () => onSignal('SIGINT'));
    on(process, 'SIGTERM', () => onSignal('SIGTERM'));
    guard.setBrokenPipeHandler(() => void shutdown('broken_pipe'));
    server.server.onclose = () => void shutdown('transport_closed');

    server.connect(new StdioServerTransport(process.stdin, guard.rpcOut)).then(
      () => log.info('mcp_ready', { writes: allowWrites, importRoots: approvedImportRoots.roots.length }),
      (e: unknown) => {
        log.error('mcp_connect_failed', { error: e instanceof Error ? e.name : typeof e });
        void shutdown('connect_failed', 1);
      },
    );
  });
}

// Started directly (node dist/mcp/entry.js): run, then leave. process.exit is needed because the stdin handle may linger.
if (runningAsEntry) {
  runMcpServer(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      log.error('mcp_fatal', { error: e instanceof Error ? e.name : typeof e });
      process.exit(1);
    },
  );
}
