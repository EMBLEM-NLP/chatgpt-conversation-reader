/**
 * Where a test can create a Unix-domain socket.
 *
 * `sockaddr_un.sun_path` holds 108 bytes on Linux and 104 on macOS (terminating NUL included). Node does NOT fail when a longer
 * path is given to `listen()`: it binds a TRUNCATED name, so nothing exists at the path the test believes it created (or, when the
 * truncated name is the temp directory itself, `listen()` fails with EADDRINUSE). A long TMPDIR (a CI workspace, a macOS
 * `/var/folders/...`, a deep checkout) therefore breaks every test that puts a socket into its temp directory.
 *
 * `socketDirFor(preferred, names)` returns `preferred` when every socket path in it fits, otherwise a fresh short directory under
 * /tmp (removed when the process exits), otherwise `null`, and the caller skips with `t.skip(...)` instead of failing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Below both limits (108 on Linux, 104 on macOS) with a margin. */
export const MAX_SOCKET_PATH_BYTES = 100;

const created: string[] = [];
process.on('exit', () => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

/** true when a socket at `path` can really be bound at that path. */
export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path) < MAX_SOCKET_PATH_BYTES;
}

/** A directory in which sockets with these file names fit, or null when none can be found. */
export function socketDirFor(preferred: string, ...names: string[]): string | null {
  const fits = (dir: string): boolean => names.every((n) => socketPathFits(join(dir, n)));
  if (fits(preferred)) return preferred;
  for (const root of ['/tmp', '/var/tmp', '/dev/shm']) {
    try {
      const dir = mkdtempSync(join(root, 'gcr-s-'));
      created.push(dir);
      if (fits(dir)) return dir;
    } catch {
      /* this root is not writable here: try the next one */
    }
  }
  return null;
}
