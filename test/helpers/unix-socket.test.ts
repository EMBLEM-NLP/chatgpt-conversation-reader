/**
 * test/helpers/unix-socket.ts: socketDirFor picks a directory in which a Unix-domain socket really can be bound (TQ-06). A socket
 * is created and connected to at the path the helper returned, so a path that Node would silently truncate cannot pass.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MAX_SOCKET_PATH_BYTES, socketDirFor, socketPathFits } from './unix-socket.js';

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** Listen at `path`, connect back, return what the server sent: proof that the socket exists at exactly that path. */
async function roundTrip(path: string): Promise<string> {
  const server = createServer((c) => c.end('pong'));
  server.listen(path);
  await once(server, 'listening');
  try {
    assert.equal(lstatSync(path).isSocket(), true, 'a socket sits at the requested path');
    const client = connect({ path });
    const [data] = (await once(client, 'data')) as [Buffer];
    return data.toString('utf8');
  } finally {
    server.close();
  }
}

describe('socketPathFits / socketDirFor', () => {
  it('socketPathFits is a byte count below the limit (multi-byte letters count as their UTF-8 bytes)', () => {
    assert.equal(socketPathFits('/tmp/a.sock'), true);
    assert.equal(socketPathFits(`/${'a'.repeat(MAX_SOCKET_PATH_BYTES - 2)}`), true);
    assert.equal(socketPathFits(`/${'a'.repeat(MAX_SOCKET_PATH_BYTES - 1)}`), false);
    assert.equal(socketPathFits(`/${'ü'.repeat(MAX_SOCKET_PATH_BYTES / 2)}`), false, 'two bytes each: 51 characters, 101 bytes');
  });

  it('a directory whose sockets fit is returned as it is, and a socket there works', async () => {
    const base = mkdtempSync(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-sk-'));
    made.push(base);
    if (!socketPathFits(join(base, 'a.sock'))) return; // the temp directory of this machine is long: the next test covers this
    assert.equal(socketDirFor(base, 'a.sock'), base);
    assert.equal(await roundTrip(join(base, 'a.sock')), 'pong');
  });

  it('a directory that is too long is replaced by a short one in which a socket can really be created and reached', async (t) => {
    const base = mkdtempSync(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-sk-'));
    made.push(base);
    const long = join(base, 'x'.repeat(120));
    mkdirSync(long);
    assert.equal(socketPathFits(join(long, 'a.sock')), false, 'premise: the preferred directory is too long');
    const chosen = socketDirFor(long, 'a.sock', 'b.sock');
    if (chosen === null) return t.skip('no short writable directory on this machine');
    assert.notEqual(chosen, long);
    assert.equal(socketPathFits(join(chosen, 'a.sock')) && socketPathFits(join(chosen, 'b.sock')), true);
    assert.equal(await roundTrip(join(chosen, 'a.sock')), 'pong');
  });
});
