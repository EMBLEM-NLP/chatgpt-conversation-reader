/**
 * Bounded, defensive reading of the text a command is given with `--input <file|->` (drafts, annotations, manual copies).
 *
 * Why every rule exists (the input is a file or pipe the operator names, but it may well be a path produced by another
 * program or a shared folder, so it is treated with the same care as an import):
 *  - SIZE: at most `maxBytes` are ever read (256 KiB for drafts and annotations, 64 MiB for manual copies). The size is
 *    checked before reading AND while reading, so a file that grows or an endless pipe cannot exhaust memory.
 *  - KIND: only regular files. A directory is refused; a FIFO or device is refused after the open (the open itself is
 *    non-blocking, so a named pipe with no writer cannot hang the command).
 *  - SYMLINKS: a symbolic link is followed only when its final target lies inside the directory that CONTAINS the link
 *    (after resolving both). A link planted next to a document that points at `/etc/...` or at a key in the home
 *    directory is refused instead of being read into a local database. The file is then opened by its resolved path with
 *    O_NOFOLLOW, so a swap of the link between the check and the open fails closed.
 *  - HARD LINKS are NOT detected (ATK-10, documented in docs/SECURITY_AND_BOUNDARIES.md section 9): a hard link is a second name for
 *    the same file, so neither the symlink rule above nor `realpath` can tell that a name in this directory is a file that lives
 *    elsewhere. The CLI is not fenced (the operator names the path); the MCP import refuses multi-link files (mcp/approved-roots.ts).
 *  - ENCODING: strict UTF-8. Invalid bytes are an error, not replacement characters, so what is stored is what the
 *    operator wrote.
 * Error messages never contain file contents; they name the file by its basename only.
 */
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { GcrError } from '../errors.js';
import type { ErrorCode } from '../errors.js';
import type { StdinLike } from './context.js';
import { printable } from './text.js';

export interface InputCodes {
  /** The file does not exist or cannot be read. */
  readonly missing: ErrorCode;
  /** Not a regular file, a refused symlink, or not valid UTF-8. */
  readonly invalid: ErrorCode;
  /** Over the size bound. */
  readonly tooLarge: ErrorCode;
}

export interface ReadInputOptions {
  /** A file path, or "-" for standard input. */
  readonly spec: string;
  readonly maxBytes: number;
  /** For messages: "draft text", "annotation text", "manual copy". */
  readonly what: string;
  readonly codes: InputCodes;
  readonly stdin: StdinLike;
  /** Called once before reading stdin when a person is typing into it. */
  readonly onTty?: () => void;
}

export interface InputText {
  readonly text: string;
  /** Basename of the file, or "stdin". Safe to store as a source label. */
  readonly label: string;
}

function fail(code: ErrorCode, message: string, reason: string, remedy?: string, extra: Record<string, unknown> = {}): GcrError {
  return new GcrError(code, message, { ...(remedy === undefined ? {} : { remedy }), details: { reason, ...extra } });
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MiB`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KiB`;
  return `${n} bytes`;
}

function decodeUtf8(bytes: Buffer, o: ReadInputOptions): string {
  try {
    // Fatal: invalid sequences throw instead of becoming U+FFFD. A leading BOM is removed by the decoder.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail(o.codes.invalid, `The ${o.what} is not valid UTF-8 text.`, 'NOT_UTF8', 'Save the file as UTF-8 and try again.');
  }
}

function tooLarge(o: ReadInputOptions): GcrError {
  return fail(o.codes.tooLarge, `The ${o.what} is larger than ${formatBytes(o.maxBytes)}.`, 'INPUT_TOO_LARGE', `Shorten it: at most ${formatBytes(o.maxBytes)} are read.`, { limitBytes: o.maxBytes });
}

async function readStdin(o: ReadInputOptions): Promise<Buffer> {
  if (o.stdin.isTTY === true) o.onTty?.();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of o.stdin) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += piece.length;
    if (total > o.maxBytes) throw tooLarge(o);
    chunks.push(piece);
  }
  return Buffer.concat(chunks, total);
}

/** true when `target` lies strictly inside directory `dir` (both already resolved with realpath). */
export function isInside(dir: string, target: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return target.startsWith(prefix) && target.length > prefix.length;
}

export async function readBoundedText(o: ReadInputOptions): Promise<InputText> {
  if (o.spec === '-') return { text: decodeUtf8(await readStdin(o), o), label: 'stdin' };

  const shown = printable(basename(o.spec), 60);
  const absolute = resolve(o.spec);
  let st: Stats;
  try {
    st = await lstat(absolute);
  } catch {
    throw fail(o.codes.missing, `The ${o.what} file "${shown}" does not exist or cannot be read.`, 'NOT_FOUND', 'Check the path and your permissions.');
  }

  let real = absolute;
  if (st.isSymbolicLink()) {
    let parent: string;
    let target: string;
    try {
      parent = await realpath(dirname(absolute));
      target = await realpath(absolute);
    } catch {
      throw fail(o.codes.missing, `The ${o.what} file "${shown}" is a link that cannot be resolved.`, 'NOT_FOUND', 'Check that the link target exists.');
    }
    if (!isInside(parent, target)) {
      throw fail(
        o.codes.invalid,
        `The ${o.what} file "${shown}" is a symbolic link that points outside its own directory; it was not read.`,
        'SYMLINK_REFUSED',
        'Pass the real file instead of the link.',
      );
    }
    real = target;
  }

  let handle: FileHandle;
  try {
    // O_NONBLOCK: opening a FIFO with no writer would otherwise block forever. O_NOFOLLOW: fail closed if the final
    // component turned into a symlink after the checks above.
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw fail(o.codes.missing, `The ${o.what} file "${shown}" cannot be opened.`, 'NOT_READABLE', 'Check the path and your permissions.');
  }
  try {
    const fst = await handle.stat();
    if (!fst.isFile()) {
      throw fail(o.codes.invalid, `The ${o.what} path "${shown}" is not a regular file.`, 'NOT_REGULAR_FILE', 'Pass a file, not a directory, pipe or device (use "-" to read standard input).');
    }
    if (fst.size > o.maxBytes) throw tooLarge(o);
    const buffer = Buffer.alloc(Math.min(o.maxBytes, fst.size) + 1);
    let filled = 0;
    // Read one byte past the expected size: a file that grew since fstat is detected instead of silently cut.
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > o.maxBytes) throw tooLarge(o);
    if (filled > fst.size) {
      throw fail(o.codes.invalid, `The ${o.what} file "${shown}" changed while it was being read.`, 'CHANGED_WHILE_READING', 'Do not modify the file while GCR reads it; run the command again.');
    }
    return { text: decodeUtf8(buffer.subarray(0, filled), o), label: shown };
  } finally {
    await handle.close();
  }
}
