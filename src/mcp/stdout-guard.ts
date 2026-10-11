/**
 * Stdout guard for the MCP stdio server (SPEC section 7 / CODEX_TASK Phase 2: "no stdout noise in stdio mode").
 *
 * In stdio mode stdout IS the protocol: every byte on it must belong to a JSON-RPC frame. A stray `console.log`, a
 * dependency's debug print or `process.stdout.write` from anywhere in the process would corrupt the stream, and some MCP
 * clients disconnect on the first non-JSON line. This module makes that impossible for application code:
 *
 *  1. It keeps the real `process.stdout.write` privately.
 *  2. It replaces `process.stdout.write` with a function that forwards to stderr. `console.log/info/debug/table/dir/group*`
 *     all reach stdout through `process.stdout.write`, so patching that one function redirects all of them.
 *  3. It returns a Writable (`rpcOut`) that is the ONLY remaining path to the real stdout; the MCP transport gets that.
 *
 * Two hardening details that are easy to miss:
 *  - U+2028 / U+2029 are legal inside JSON strings and `JSON.stringify` emits them raw, but several line readers (including
 *    Node's `readline`) treat them as line terminators. An imported message containing one would then be cut in the middle
 *    of a frame by such a client (a way to smuggle a "fake frame" out of conversation text). `rpcOut` rewrites them to the
 *    escapes ` ` / ` `: still valid JSON, identical after parsing, never a line break.
 *  - A client that vanishes while we write raises EPIPE on BOTH the real stdout and our wrapper; an unhandled 'error' event
 *    on either would kill the process with exit code 1. Both get a handler that treats EPIPE as a normal shutdown request.
 *
 * Not covered (documented limitation): native code or child processes writing to file descriptor 1 directly, and
 * `fs.writeSync(1, ...)`. GCR spawns no child processes.
 *
 * Idempotent: a second call returns the first guard. No work happens at import time.
 */
import { Writable } from 'node:stream';

export interface StdoutGuard {
  /** The ONLY handle on the real file descriptor 1. Give it to the transport: `new StdioServerTransport(process.stdin, guard.rpcOut)`. */
  readonly rpcOut: Writable;
  /** Called when the reader of stdout is gone (EPIPE). Default: exit 0. The server entry replaces it with a graceful shutdown. */
  setBrokenPipeHandler(handler: () => void): void;
}

let installed: StdoutGuard | undefined;

/** Rewrite the two Unicode line separators that `JSON.stringify` leaves raw (see the file header). Other text is untouched. */
export function escapeLineSeparators(frame: string): string {
  if (!frame.includes(' ') && !frame.includes(' ')) return frame;
  return frame.replace(/[  ]/g, (c) => (c === ' ' ? '\\u2028' : '\\u2029'));
}

export function installStdoutGuard(): StdoutGuard {
  if (installed !== undefined) return installed;

  const realWrite = process.stdout.write.bind(process.stdout) as (chunk: string, encoding: BufferEncoding, cb: (err?: Error | null) => void) => boolean;
  process.stdout.write = ((...args: Parameters<typeof process.stderr.write>): boolean => process.stderr.write(...args)) as typeof process.stdout.write;

  let onBrokenPipe: () => void = () => process.exit(0);
  const onStreamError = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') {
      onBrokenPipe();
      return;
    }
    // Code only: an error message can embed paths. stderr is the log channel.
    process.stderr.write(`stdout error: ${err.code ?? 'unknown'}\n`);
    process.exit(1);
  };
  process.stdout.on('error', onStreamError);

  const rpcOut = new Writable({
    // decodeStrings:false keeps each write() one complete frame string (the SDK transport writes `JSON + "\n"` per message).
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, done): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      realWrite(escapeLineSeparators(text), 'utf8', done);
    },
  });
  rpcOut.on('error', onStreamError);

  installed = {
    rpcOut,
    setBrokenPipeHandler(handler: () => void): void {
      onBrokenPipe = handler;
    },
  };
  return installed;
}
