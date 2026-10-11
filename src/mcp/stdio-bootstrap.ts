/**
 * Side-effect module: it MUST be the first import of `entry.ts`.
 *
 * ES modules evaluate their imports in order, so everything imported AFTER this module runs with the stdout guard
 * already installed: a module that prints while it loads cannot reach stdout. (Calling the guard in the body of
 * `entry.ts` would be too late for those top-level prints; a test pins this import order.)
 *
 * It installs the guard ONLY when this process was started on `entry.js` itself. (The node:sqlite warning filter is NOT
 * installed here: Node prints that warning while the builtin LOADS, before any module code runs, so `entry.ts` installs the
 * filter and only then loads the modules that import SQLite, with dynamic imports.) Importing `entry.ts` from another program (the CLI's `gcr mcp`, a test)
 * has no side effect at all: redirecting stdout in the middle of an unrelated program would break its output.
 * `runMcpServer` installs the same (idempotent) guard before it does anything else, so that path is covered as well.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installStdoutGuard } from './stdout-guard.js';

function startedOnEntryFile(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  let started: string;
  try {
    started = realpathSync(argv1);
  } catch {
    return false;
  }
  for (const name of ['./entry.js', './entry.ts']) {
    try {
      if (realpathSync(fileURLToPath(new URL(name, import.meta.url))) === started) return true;
    } catch {
      /* this spelling does not exist next to us (compiled vs. source layout) */
    }
  }
  return false;
}

/** true when this process is the MCP server process (started directly on entry.js). */
export const runningAsEntry: boolean = startedOnEntryFile();

if (runningAsEntry) {
  installStdoutGuard();
}
