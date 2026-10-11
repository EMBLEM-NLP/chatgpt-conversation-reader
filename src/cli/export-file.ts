/**
 * Writing the graph HTML export (`gcr graph export --out <file.html>`).
 *
 * The page is built from labels cut out of the operator's conversations, so the file is PRIVATE data. Rules:
 *  - NEW files are created with the flags "wx" (O_CREAT | O_EXCL) and mode 0600. O_EXCL makes the creation atomic and
 *    refuses an existing path of any kind, including a symbolic link (dangling or not): the open never follows a link,
 *    so a link planted at the destination cannot redirect the write to another file.
 *  - An existing file is NEVER overwritten silently. `--force` replaces a regular file by writing a fresh 0600 temporary
 *    file in the same directory and renaming it over the destination; rename replaces the directory entry itself, so
 *    even a destination swapped for a symlink in the meantime is replaced, not followed. A destination that is already a
 *    symlink or a directory is refused even with `--force`.
 *  - The destination must end in `.html`/`.htm`, so `--force` cannot be pointed at `~/.bashrc` by a slip.
 *  - The directory must already exist: no directory trees are created for the operator.
 *  - Failures are named for what they are: a permission or read-only error is WRITE_FORBIDDEN, a name the file system rejects
 *    is INVALID_ARGUMENT, anything else (a full disk) is INTERNAL_ERROR; a half-written private file is always removed.
 * Messages name the file by basename only.
 */
import { randomBytes } from 'node:crypto';
import { lstat, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { GcrError } from '../errors.js';
import { printable } from './text.js';

function refuse(message: string, reason: string, remedy: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', message, { remedy, details: { option: 'out', reason } });
}

async function writeNew(path: string, content: string): Promise<number> {
  // "wx" = O_CREAT | O_EXCL: atomic creation that refuses any existing path, symlinks included. When this open fails nothing
  // was created, so nothing is removed.
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } catch (e) {
    // The file is ours (we just created it) and half written: take it back rather than leave private data in pieces.
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw e;
  }
  await handle.close();
  return Buffer.byteLength(content, 'utf8');
}

/**
 * Classify a failure of the file system by what it means to the operator. The raw error is kept as the `cause` (shown only with
 * --debug); its message can hold an absolute path, so it is never forwarded.
 */
function writeFailure(e: unknown, shown: string, replacing: boolean): GcrError {
  const errno = (e as { code?: unknown } | null)?.code;
  if (errno === 'EACCES' || errno === 'EPERM' || errno === 'EROFS') {
    return new GcrError('WRITE_FORBIDDEN', `The export file "${shown}" may not be written there (permission denied or read-only location).`, {
      remedy: 'Choose a directory you are allowed to write to, or fix the permissions of this one.',
      details: { option: 'out', reason: 'PERMISSION_DENIED' },
      cause: e,
    });
  }
  if (errno === 'ENAMETOOLONG' || errno === 'EINVAL' || errno === 'ELOOP') {
    return new GcrError('INVALID_ARGUMENT', `The file name "${shown}" is not accepted by the file system.`, {
      remedy: 'Choose a shorter name without unusual characters, for example graph.html.',
      details: { option: 'out', reason: 'BAD_NAME' },
      cause: e,
    });
  }
  return new GcrError('INTERNAL_ERROR', replacing ? 'The export file could not be replaced.' : 'The export file could not be written.', {
    remedy: 'Check the free space and the health of the target directory.',
    details: { option: 'out', reason: 'WRITE_FAILED' },
    cause: e,
  });
}

/** The permission bits of the file as it exists on disk now (what the umask left of the requested 0600), e.g. "0600". */
async function modeOf(path: string): Promise<string> {
  const st = await lstat(path);
  return (st.mode & 0o777).toString(8).padStart(4, '0');
}

/** Write `content` to `out`. Returns the number of bytes written and the file's actual permission bits. */
export async function writeExportFile(out: string, content: string, force: boolean): Promise<{ bytes: number; mode: string }> {
  const absolute = resolve(out);
  const shown = printable(basename(absolute), 60);
  if (!/\.html?$/i.test(absolute)) {
    throw refuse(`The export file "${shown}" must end in .html.`, 'BAD_EXTENSION', 'Choose a name such as graph.html.');
  }
  const dirStat = await stat(dirname(absolute)).catch(() => undefined);
  if (dirStat === undefined || !dirStat.isDirectory()) {
    throw refuse(`The directory for "${shown}" does not exist.`, 'NO_DIRECTORY', 'Create the directory first; GCR does not create directory trees.');
  }

  const existing = await lstat(absolute).catch(() => undefined);
  if (existing === undefined) {
    try {
      const bytes = await writeNew(absolute, content);
      return { bytes, mode: await modeOf(absolute) };
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'EEXIST') {
        throw refuse(`The export file "${shown}" already exists (or appeared while it was being created).`, 'EXISTS', 'Choose another name, or pass --force to replace a regular file.');
      }
      throw writeFailure(e, shown, false);
    }
  }

  if (existing.isSymbolicLink()) {
    throw refuse(`The export path "${shown}" is a symbolic link; GCR does not write through links, even with --force.`, 'SYMLINK_REFUSED', 'Choose a path that is not a link.');
  }
  if (!existing.isFile()) {
    throw refuse(`The export path "${shown}" exists and is not a regular file.`, 'NOT_REGULAR_FILE', 'Choose another path.');
  }
  if (!force) {
    throw refuse(`The export file "${shown}" already exists; it was not overwritten.`, 'EXISTS', 'Choose another name, or pass --force to replace it.');
  }

  // A short name of its own: derived from the target's name it could exceed the file system's limit although the target's does not.
  const temp = resolve(dirname(absolute), `.gcr-export-${randomBytes(6).toString('hex')}.tmp`);
  try {
    const bytes = await writeNew(temp, content);
    await rename(temp, absolute);
    return { bytes, mode: await modeOf(absolute) };
  } catch (e) {
    await unlink(temp).catch(() => undefined);
    throw writeFailure(e, shown, true);
  }
}
