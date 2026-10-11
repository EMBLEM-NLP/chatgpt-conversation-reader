#!/usr/bin/env node
/**
 * Process entry of the `gcr` command (package.json "bin"). Everything with process-wide effect lives here: the warning
 * filter, signal handling, broken-pipe handling and the final exit. The logic is in run.ts.
 *
 * The FIRST import installs the filter that drops the node:sqlite ExperimentalWarning (and only that); it has to run
 * before `node:sqlite` is loaded, and ES module imports evaluate in order. The SDK itself is imported lazily by the
 * commands that need it, so `gcr --help` never loads SQLite at all.
 */
import '../suppress-warnings.js';
import { Lifecycle } from './context.js';
import { createProcessOutput } from './output.js';
import { reportError } from './report-error.js';
import { runCli } from './run.js';
import { wantsDebug, wantsJsonErrors } from './route.js';

const argv = process.argv.slice(2);
const out = createProcessOutput();
const lifecycle = new Lifecycle();

/** Close the database handles and leave. Closing errors cannot matter any more. */
function leave(code: number): never {
  lifecycle.closeAll();
  process.exit(code);
}

// `gcr list | head`: the reader went away. That is not an error for us: stop quietly, success.
out.onBrokenPipe(() => leave(0));

// Ctrl-C / kill: close the database (an import in flight is rolled back by SQLite on the next open) and exit with the
// conventional 128 + signal number. `gcr mcp` runs its own graceful shutdown and tells us to stand down.
process.on('SIGINT', () => {
  if (!lifecycle.signalsDelegated) leave(130);
});
process.on('SIGTERM', () => {
  if (!lifecycle.signalsDelegated) leave(143);
});

// Anything that escapes a handler is a bug: the same error contract as every other failure (generic message, exit 1).
function fatal(e: unknown): never {
  const code = reportError(out, e, { json: wantsJsonErrors(argv), debug: wantsDebug(argv) || process.env['GCR_DEBUG'] === '1' });
  leave(code);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const code = await runCli({ argv, env: process.env, cwd: process.cwd(), out, stdin: process.stdin, lifecycle });
process.exitCode = code;
await out.flush();
// Normally the event loop is empty now and the process ends by itself, which also lets any buffered output drain. The
// timer is only a safety net against a stray handle keeping a finished command alive; it does not keep the process alive.
setTimeout(() => process.exit(code), 2000).unref();
