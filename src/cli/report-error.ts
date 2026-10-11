/**
 * The error contract of the CLI (SPEC NFR-07, src/errors.ts):
 *
 *  - stdout stays EMPTY when a command fails; the error goes to stderr.
 *  - `--format json`: the ErrorEnvelope from src/errors.ts as ONE line of JSON (parseable with `jq`).
 *  - any other format: `error[CODE]: message` and, when there is one, an indented `remedy:` line.
 *  - the process exit code is EXIT_CODES[code] (usage errors 2, lookups 3, imports 4, storage 5, ...).
 *  - anything that is not a GcrError becomes INTERNAL_ERROR (exit 1) with the generic message of toGcrError: raw messages
 *    from SQLite, the file system or a JSON parser can embed content or absolute paths, so they are never forwarded.
 *  - `--debug` (GCR_DEBUG=1) additionally prints the stack and the cause chain: that is the point of the switch and the
 *    reason it is off by default. In JSON mode the stack travels inside `error.details.stack`, so stderr stays one
 *    parseable document.
 */
import { GcrError, toGcrError } from '../errors.js';
import type { ErrorEnvelope } from '../errors.js';
import type { Output } from './output.js';
import { printable } from './text.js';

const MAX_LINE = 4000;

// JSON.stringify leaves these raw although a terminal must never receive them: line/paragraph separators, bidi controls and
// Unicode TAG characters. Inside JSON text they can only occur within string values, so escaping them is lossless.
const JSON_HAZARD = new RegExp(
  [
    '[\\u007f-\\u009f]', // DEL and C1 controls (JSON.stringify only escapes C0)
    `[${[0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => `\\u${c.toString(16)}`).join('')}]`, // separators, bidi
    '\\uDB40[\\uDC00-\\uDC7F]', // Unicode TAG characters (a surrogate pair)
  ].join('|'),
  'g',
);

function escapeJsonHazards(json: string): string {
  // Per UTF-16 code unit (a TAG character is a surrogate pair and JSON escapes each half).
  return json.replace(JSON_HAZARD, (m) => Array.from({ length: m.length }, (_, i) => `\\u${m.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));
}

function stackOf(e: unknown): string {
  if (e instanceof Error) {
    const lines = [e.stack ?? `${e.name}: ${e.message}`];
    let cause: unknown = e.cause;
    for (let depth = 0; cause !== undefined && depth < 5; depth++) {
      if (cause instanceof Error) {
        lines.push(`caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`);
        cause = cause.cause;
      } else {
        lines.push(`caused by: (non-Error value of type ${typeof cause})`);
        break;
      }
    }
    return lines.join('\n');
  }
  return `(non-Error value of type ${typeof e} was thrown)`;
}

/** Sanitize line by line (newlines survive), indenting continuation lines. */
function indentBlock(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? printable(line, MAX_LINE) : `${prefix}${printable(line, MAX_LINE)}`))
    .join('\n');
}

export function errorText(err: GcrError, original: unknown, debug: boolean): string {
  const lines = [`error[${err.code}]: ${indentBlock(err.message, '  ')}`];
  if (err.remedy !== undefined) lines.push(`  remedy: ${indentBlock(err.remedy, '    ')}`);
  if (debug) {
    lines.push('  debug:');
    for (const line of stackOf(original).split('\n')) lines.push(`    ${printable(line, MAX_LINE)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function errorJson(err: GcrError, original: unknown, debug: boolean): string {
  const envelope: ErrorEnvelope = err.toEnvelope();
  if (debug) envelope.error.details = { ...(envelope.error.details ?? {}), stack: stackOf(original) };
  return `${escapeJsonHazards(JSON.stringify(envelope))}\n`;
}

/** Print the error for `e` and return the process exit code. */
export function reportError(out: Output, e: unknown, opts: { json: boolean; debug: boolean }): number {
  const err = toGcrError(e);
  out.stderr(opts.json ? errorJson(err, e, opts.debug) : errorText(err, e, opts.debug));
  return err.exitCode;
}
