/**
 * Filter for the one process warning Node prints when `node:sqlite` loads ("SQLite is an experimental feature ...",
 * ADR-0003). It goes to stderr, so it can never corrupt the stdio protocol; it is dropped only to keep the log channel
 * readable. EVERY other warning (including other ExperimentalWarnings) passes through untouched.
 *
 * Local equivalent of the CLI's suppression: the MCP entry must not depend on the CLI module being present.
 * Idempotent; no work at import time.
 */

let installed = false;

/** true for the `node:sqlite` ExperimentalWarning, whichever of Node's `emitWarning` call shapes carried it. */
export function isSqliteExperimentalWarning(warning: unknown, rest: readonly unknown[]): boolean {
  const first = rest[0];
  const typeFromArgs = typeof first === 'string' ? first : typeof first === 'object' && first !== null ? (first as { type?: unknown }).type : undefined;
  const message = warning instanceof Error ? warning.message : typeof warning === 'string' ? warning : '';
  const type = warning instanceof Error ? warning.name : typeFromArgs;
  return type === 'ExperimentalWarning' && /sqlite/i.test(message);
}

export function installSqliteWarningFilter(): void {
  if (installed) return;
  installed = true;
  const original = process.emitWarning.bind(process) as (warning: string | Error, ...rest: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    original(warning, ...rest);
  }) as typeof process.emitWarning;
}
