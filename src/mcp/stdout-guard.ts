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
 *  - U+2028, U+2029 and U+0085 are legal inside JSON strings and `JSON.stringify` emits them raw, but several line readers
 *    (Node's `readline`, Python's `splitlines`) treat them as line terminators. An imported message containing one would then
 *    be cut in the middle of a frame by such a client (a way to smuggle a "fake frame" out of conversation text). `rpcOut`
 *    rewrites them to the JSON escapes (backslash, u, four hex digits): still valid JSON, identical after parsing, never a
 *    line break. (Tool results no longer carry these characters in the first place: mcp/envelope.ts writes them, and the other
 *    hazardous ones, as visible escapes in the data itself, ATK-04. This frame-level rewrite is lossless and stays as the second
 *    line of defence for every other frame.)
 *  - A client that vanishes while we write raises EPIPE on BOTH the real stdout and our wrapper; an unhandled 'error' event
 *    on either would kill the process with exit code 1. Both get a handler that treats EPIPE as a normal shutdown request.
 *
 *  - Leaving the process must not cut an answer. A pipe holds only 64 KiB and its writes are asynchronous, so frames that were
 *    already computed can still be queued when the server decides to exit (stdin ended, SIGTERM): `process.exit` then drops them,
 *    possibly in the middle of a frame. `flush()` waits (bounded) until everything written to `rpcOut` has been handed to the OS.
 *    The wrapper also lifts Node's listener-count warning: the SDK transport adds one `drain` listener per write that meets a
 *    full buffer, which a client that pipelines large requests triggers legitimately (they are one-shot and bounded by the
 *    number of requests in flight), and Node would otherwise print "possible EventEmitter memory leak" on stderr.
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
  /**
   * Resolves when every frame written to `rpcOut` so far has been handed to the operating system, or after `timeoutMs`
   * (a reader that is alive but never reads must not keep the process alive). Never rejects. Call it before leaving the
   * process, after the server stopped producing frames.
   */
  flush(timeoutMs?: number): Promise<void>;
}

/** How long the process waits for a slow reader to take the frames that are already written before it leaves anyway. */
export const STDOUT_FLUSH_TIMEOUT_MS = 3000;

let installed: StdoutGuard | undefined;

/**
 * Characters that some line readers treat as a line end although the MCP framing only means "\n": LINE SEPARATOR (U+2028) and
 * PARAGRAPH SEPARATOR (U+2029), which Node's readline splits on, and NEXT LINE (U+0085), which Python's str.splitlines()
 * splits on. `JSON.stringify` leaves all three raw. They are built from code points here, never written as escapes in this
 * source: a regex literal containing them is re-printed by TypeScript 7 with the raw character, which ends the line inside the
 * literal and makes the emitted file a syntax error, and some tools rewrite such escapes in source text.
 */
const LINE_BREAKERS: ReadonlyArray<readonly [raw: string, escaped: string]> = [0x2028, 0x2029, 0x85].map((code) => [String.fromCharCode(code), `${String.fromCharCode(0x5c)}u${code.toString(16).padStart(4, '0')}`] as const);

/** Rewrite the line-breaking characters that `JSON.stringify` leaves raw (see the file header). Other text is untouched. */
export function escapeLineSeparators(frame: string): string {
  let out = frame;
  for (const [raw, escaped] of LINE_BREAKERS) if (out.includes(raw)) out = out.replaceAll(raw, escaped);
  return out;
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
  // One-shot `drain` listeners of blocked writes (see the file header): bounded by the requests in flight, not a leak.
  rpcOut.setMaxListeners(0);

  installed = {
    rpcOut,
    setBrokenPipeHandler(handler: () => void): void {
      onBrokenPipe = handler;
    },
    flush(timeoutMs: number = STDOUT_FLUSH_TIMEOUT_MS): Promise<void> {
      return new Promise<void>((resolve) => {
        // Writes complete in order: the callback of an empty write fires after every earlier frame reached the OS (or failed,
        // for example with EPIPE when the reader is gone: the frames are lost then, but nobody is waiting for them).
        const timer = setTimeout(resolve, timeoutMs);
        rpcOut.write('', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  return installed;
}
