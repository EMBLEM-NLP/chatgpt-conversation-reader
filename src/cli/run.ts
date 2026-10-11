/**
 * `runCli`: one invocation of the CLI, from arguments to exit code. No process-level side effects (signals, exit) here:
 * main.ts owns those, so this function is testable in-process with a fake environment.
 *
 * Order of events (each step fails with a GcrError that reportError prints):
 *   1. route the command words (unknown command -> exit 2, nothing runs);
 *   2. parse and validate the options (a help request wins over a parse error, so `gcr list --bogus --help` helps);
 *   3. validate the global values (--tz), resolve the database location;
 *   4. run the handler, which validates its own arguments BEFORE it opens the database;
 *   5. close every handle (also on failure) and return the exit code.
 */
import type { OutputFormat } from '../domain/types.js';
import { GcrError } from '../errors.js';
import { assertValidTimeZone } from '../format/time.js';
import { rootEntries } from './commands/index.js';
import { CommandContext, resolveDbLocation } from './context.js';
import type { CliEnvironment } from './context.js';
import { renderCommandHelp, renderGroupHelp, renderRootHelp, renderVersion } from './help.js';
import { DEFAULT_FORMAT } from './options.js';
import { checkPositionals, effectiveOptions, parseCommandArgs } from './parse.js';
import type { ParsedArgs } from './parse.js';
import { reportError } from './report-error.js';
import { resolveRoute, wantsDebug, wantsHelp, wantsJsonErrors } from './route.js';
import type { CommandSpec } from './spec.js';

/**
 * Every failure the CLI prints carries a next step. SDK validation errors (a wrong option value, a malformed id) have none
 * of their own, so they get the generic one here: where to read about the command, or how to inspect the database.
 */
function withDefaultRemedy(e: unknown, commandLine: string): unknown {
  if (!(e instanceof GcrError) || e.remedy !== undefined) return e;
  const remedy = e.code.startsWith('DB_') ? 'Run "gcr doctor --db <path>" to inspect the database, or choose another file with --db.' : `Run "${commandLine} --help" for usage.`;
  return new GcrError(e.code, e.message, { remedy, warnings: e.warnings, cause: e, ...(e.details === undefined ? {} : { details: e.details }) });
}

async function runCommand(spec: CommandSpec, rest: readonly string[], io: CliEnvironment): Promise<number> {
  const commandLine = `gcr ${spec.path.join(' ')}`;
  let args: ParsedArgs;
  try {
    args = parseCommandArgs(rest, effectiveOptions(spec), commandLine);
  } catch (e) {
    // Someone who typed --help wants help, not a complaint about the rest of the line.
    if (wantsHelp(rest)) {
      io.out.stdout(renderCommandHelp(spec));
      return 0;
    }
    throw e;
  }
  if (args.flag('help')) {
    io.out.stdout(renderCommandHelp(spec));
    return 0;
  }
  checkPositionals(args.positionals, spec.positionals, commandLine);

  const tz = args.string('tz') ?? 'UTC';
  assertValidTimeZone(tz); // before anything is opened or written, whatever the format
  const debug = args.flag('debug') || io.env['GCR_DEBUG'] === '1';
  if (debug) process.env['GCR_DEBUG'] = '1'; // the shared logger reads the real environment
  const ctx = new CommandContext({
    spec,
    args,
    io,
    format: args.choice<OutputFormat>('format') ?? DEFAULT_FORMAT,
    tz,
    tzExplicit: args.has('tz'),
    quiet: args.flag('quiet'),
    debug,
    db: resolveDbLocation(args.string('db'), io.env, io.cwd),
  });
  try {
    await spec.run(ctx);
  } catch (e) {
    ctx.discardFreshDatabase(); // a failed command does not leave the empty database it created
    throw withDefaultRemedy(e, commandLine);
  }
  ctx.flushKeptNotes();
  return ctx.exitCode;
}

/** Run one invocation. Resolves to the process exit code; never throws. */
export async function runCli(io: CliEnvironment): Promise<number> {
  const json = wantsJsonErrors(io.argv);
  const debug = wantsDebug(io.argv) || io.env['GCR_DEBUG'] === '1';
  let code: number;
  let failure: unknown;
  try {
    const route = resolveRoute(io.argv);
    switch (route.kind) {
      case 'version':
        io.out.stdout(renderVersion());
        code = 0;
        break;
      case 'help-root':
        io.out.stdout(renderRootHelp(rootEntries()));
        code = 0;
        break;
      case 'help-group':
        io.out.stdout(renderGroupHelp(route.group));
        code = 0;
        break;
      case 'help-command':
        io.out.stdout(renderCommandHelp(route.spec));
        code = 0;
        break;
      case 'run':
        code = await runCommand(route.spec, route.rest, io);
        break;
    }
  } catch (e) {
    failure = e;
    code = 0;
  }
  // Close the database handles whether or not the command worked; a failure to close only matters if nothing else failed.
  const closeFailure = io.lifecycle.closeAll();
  if (failure === undefined && closeFailure !== undefined) failure = closeFailure;
  if (failure !== undefined) {
    return reportError(io.out, failure, { json, debug });
  }
  return code;
}
