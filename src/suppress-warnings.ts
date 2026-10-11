/**
 * Drops exactly ONE Node warning from stderr: the `ExperimentalWarning` that `node:sqlite` prints when it is first
 * loaded ("SQLite is an experimental feature and might change at any time"). ADR-0003 explains why GCR uses node:sqlite
 * and why the CLI and the MCP entry silence that one line: it carries no information for a user of a command-line tool
 * and, for an MCP server whose stderr is shown in a client's log pane, it is noise on every start.
 *
 * Why this is a filter on `process.emitWarning` and not `--no-warnings` / NODE_NO_WARNINGS:
 *  - those switches hide EVERY warning (deprecations, unhandled-rejection notices, MaxListeners leaks), which are
 *    exactly the signals a maintainer wants to see on stderr;
 *  - they must be set before the process starts (a flag or an environment variable), but a `bin` script cannot choose
 *    how Node is launched.
 * Node's `emitExperimentalWarning` calls `process.emitWarning(message, 'ExperimentalWarning')` through the `process`
 * object at call time, so replacing the property BEFORE `node:sqlite` is first imported intercepts it. This module must
 * therefore be the first import of every entry point; importing it installs the filter (a side effect on purpose, so a
 * bare `import '../suppress-warnings.js'` is enough) and `installSqliteWarningFilter()` is the same thing as an explicit,
 * idempotent call.
 *
 * What is matched (name AND message, so a different experimental feature or a differently worded warning still shows):
 *  - the warning is an `ExperimentalWarning` (given as an Error object, as a `type` string or as `{ type }` options), and
 *  - its message is "SQLite is an experimental feature", optionally followed by " and might change at any time".
 * Everything else is forwarded unchanged to the original `process.emitWarning`.
 */

/** Marks the replacement function so a second install (another copy of this module) does not stack wrappers. */
const INSTALLED = Symbol.for('gcr.suppressWarnings.installed');

const SQLITE_MESSAGE = /^SQLite is an experimental feature(?: and might change at any time)?\.?$/;

interface WarningOptionsLike {
  type?: unknown;
}

/**
 * true only for the node:sqlite ExperimentalWarning. `warning` and `typeOrOptions` are the first two arguments of
 * `process.emitWarning`.
 */
export function isNodeSqliteExperimentalWarning(warning: unknown, typeOrOptions?: unknown): boolean {
  let name: string | undefined;
  let message: string | undefined;
  if (warning instanceof Error) {
    // For an Error argument Node ignores `type` and uses the error's own name.
    name = warning.name;
    message = warning.message;
  } else if (typeof warning === 'string') {
    message = warning;
    if (typeof typeOrOptions === 'string') name = typeOrOptions;
    else if (typeof typeOrOptions === 'object' && typeOrOptions !== null && typeof (typeOrOptions as WarningOptionsLike).type === 'string') {
      name = (typeOrOptions as WarningOptionsLike).type as string;
    } else name = 'Warning';
  }
  return name === 'ExperimentalWarning' && message !== undefined && SQLITE_MESSAGE.test(message);
}

/** Install the filter. Idempotent. Returns true when this call installed it, false when it was already in place. */
export function installSqliteWarningFilter(): boolean {
  const current = process.emitWarning as typeof process.emitWarning & { [INSTALLED]?: true };
  if (current[INSTALLED] === true) return false;
  const original = process.emitWarning;
  const filtered = function emitWarningFiltered(...args: unknown[]): void {
    if (isNodeSqliteExperimentalWarning(args[0], args[1])) return;
    Reflect.apply(original, process, args);
  } as typeof process.emitWarning & { [INSTALLED]?: true };
  Object.defineProperty(filtered, INSTALLED, { value: true });
  process.emitWarning = filtered;
  return true;
}

installSqliteWarningFilter();
