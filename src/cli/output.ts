/**
 * The ONE module of the CLI that touches `process.stdout` / `process.stderr`.
 *
 * Contract (SPEC NFR-04/NFR-07, docs/ARCHITECTURE.md section 1):
 *  - stdout carries the command RESULT and nothing else. Notes, progress lines and errors go to stderr, so
 *    `gcr list --format json | jq` can never be corrupted by a diagnostic.
 *  - Nothing in the CLI emits colour or any other ANSI sequence. As defense in depth every string passes through
 *    `scrub`, which turns control characters other than LF/TAB (ESC, CR, BEL, C1 controls such as CSI) into visible
 *    `\u00XX` escapes. The renderers already do this for untrusted text; the scrub guarantees it for text this CLI
 *    assembles itself (error messages, echoed arguments, help). Valid JSON never contains a raw control character, so
 *    machine formats pass through unchanged.
 *  - A closed pipe (`gcr list | head -1`) is not an error: EPIPE on stdout is detected, further output is dropped and
 *    the registered handler runs once (the caller closes the database and exits 0).
 *  - No `console.*` anywhere: console would add its own formatting and its own error handling.
 */

export interface Output {
  /** Write result text to stdout (dropped silently after a broken pipe). */
  stdout(text: string): void;
  /** Write a note, progress line or error to stderr. */
  stderr(text: string): void;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
  /** true once the reader of stdout went away. */
  readonly brokenPipe: boolean;
  /** Register the (single) handler for a broken stdout pipe; called at most once. */
  onBrokenPipe(handler: () => void): void;
  /** Resolves when everything written to stdout so far was handed to the operating system. */
  flush(): Promise<void>;
}

// Everything below 0x20 except TAB (09) and LF (0A), DEL and the C1 range. CR is included on purpose: a bare CR lets a
// terminal overwrite the line it is on.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Visible escapes for control characters; LF and TAB are kept. */
export function scrub(text: string): string {
  return text.replace(CONTROL, (m) => `\\u${m.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/** The real thing: writes to this process's stdout and stderr. */
export function createProcessOutput(): Output {
  let broken = false;
  let handler: (() => void) | undefined;
  let notified = false;

  const noteBroken = (): void => {
    broken = true;
    if (!notified && handler !== undefined) {
      notified = true;
      handler();
    }
  };

  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      noteBroken();
      return;
    }
    // Any other stdout failure (EIO, ENOSPC, ...) is a real problem: rethrow so the process-level handler reports it.
    throw err;
  });
  // Nobody can be told about a failing stderr; an unhandled 'error' event would crash the process with a stack trace.
  process.stderr.on('error', () => undefined);

  return {
    stdout(text: string): void {
      if (broken) return;
      process.stdout.write(scrub(text));
    },
    stderr(text: string): void {
      process.stderr.write(scrub(text));
    },
    stdoutIsTty: process.stdout.isTTY === true,
    stderrIsTty: process.stderr.isTTY === true,
    get brokenPipe(): boolean {
      return broken;
    },
    onBrokenPipe(fn: () => void): void {
      handler = fn;
      if (broken && !notified) noteBroken();
    },
    flush(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (broken) {
          resolve();
          return;
        }
        process.stdout.write('', () => resolve());
      });
    },
  };
}

/** In-memory output for in-process tests. */
export interface BufferOutput extends Output {
  readonly out: string[];
  readonly err: string[];
}

export function createBufferOutput(opts: { stdoutIsTty?: boolean; stderrIsTty?: boolean } = {}): BufferOutput {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string): void => {
      out.push(scrub(text));
    },
    stderr: (text: string): void => {
      err.push(scrub(text));
    },
    stdoutIsTty: opts.stdoutIsTty === true,
    stderrIsTty: opts.stderrIsTty === true,
    brokenPipe: false,
    onBrokenPipe: (): void => undefined,
    flush: (): Promise<void> => Promise.resolve(),
  };
}
