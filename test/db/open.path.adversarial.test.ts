/**
 * Adversarial review of the ATK-01 fix (src/db/open.ts): what else can sit at the database path?
 *
 *  - a FIFO, a device or a socket (or a symbolic link to one) is not a database. A READ-ONLY open of a FIFO used to block the
 *    process forever (SQLite's open(2) waits for a writer), which turns a planted `./.gcr/gcr.sqlite` into a way to hang `gcr list`
 *    and `gcr mcp`; every such path is now a coded DB_ERROR, answered at once, and nothing is created or written;
 *  - a symbolic link to a NON-EMPTY file that is not a database is never written to (the read-write open must not touch it);
 *  - the refusals create nothing, anywhere.
 *
 * Every open of a special file runs in a CHILD process with a hard timeout: a regression must fail the test, not hang the run.
 * SYNTHETIC data only; real files in temp directories, no mocks.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import { Gcr } from '../../src/sdk/gcr.js';

const OPEN_JS = fileURLToPath(new URL('../../src/db/open.js', import.meta.url));

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-open-adv-'));
  made.push(dir);
  return dir;
}

interface ChildOutcome {
  timedOut: boolean;
  outcome: { opened: true } | { opened: false; code: string; reason: string | null; message: string } | null;
}

/** Open `path` in a fresh process; a hang is reported as `timedOut`, never waited for. */
function openInChild(path: string, readOnly: boolean): ChildOutcome {
  const script = `
    import { openDatabase } from ${JSON.stringify(OPEN_JS)};
    try {
      const g = openDatabase(${JSON.stringify(path)}, ${readOnly ? '{ readOnly: true }' : '{}'});
      g.db.close();
      console.log(JSON.stringify({ opened: true }));
    } catch (e) {
      console.log(JSON.stringify({ opened: false, code: e.code, reason: e.details?.reason ?? null, message: String(e.message) }));
    }
  `;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL' });
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return { timedOut, outcome: line === '' ? null : (JSON.parse(line) as ChildOutcome['outcome']) };
}

function assertRefusedPromptly(result: ChildOutcome, what: string): void {
  assert.equal(result.timedOut, false, `${what}: the open BLOCKED (a FIFO waits for a writer)`);
  assert.ok(result.outcome !== null && !result.outcome.opened, `${what}: expected a refusal, got ${JSON.stringify(result.outcome)}`);
  assert.equal(result.outcome.code, 'DB_ERROR', what);
  assert.equal(result.outcome.reason, 'not_a_regular_file', what);
  assert.ok(!/[\\/]gcr-open-adv-/.test(result.outcome.message), `${what}: no absolute path in the message`);
}

describe('a special file at the database path is refused at once, read-only and read-write', () => {
  const mkfifo = (path: string): boolean => spawnSync('mkfifo', [path]).status === 0;

  for (const readOnly of [true, false]) {
    const mode = readOnly ? 'read-only' : 'read-write';

    it(`a FIFO (${mode})`, (t) => {
      const dir = tempDir();
      const fifo = join(dir, 'gcr.sqlite');
      if (!mkfifo(fifo)) return t.skip('mkfifo is not available');
      assertRefusedPromptly(openInChild(fifo, readOnly), `FIFO ${mode}`);
      assert.ok(lstatSync(fifo).isFIFO(), 'the FIFO is still a FIFO');
      assert.deepEqual(readdirSync(dir), ['gcr.sqlite'], 'nothing was created next to it');
    });

    it(`a symbolic link to a FIFO (${mode})`, (t) => {
      const dir = tempDir();
      const fifo = join(dir, 'real-fifo');
      if (!mkfifo(fifo)) return t.skip('mkfifo is not available');
      const link = join(dir, 'gcr.sqlite');
      symlinkSync(fifo, link);
      assertRefusedPromptly(openInChild(link, readOnly), `link to FIFO ${mode}`);
      assert.deepEqual(readdirSync(dir).sort(), ['gcr.sqlite', 'real-fifo']);
    });

    it(`a symbolic link to a character device (${mode})`, (t) => {
      if (!existsSync('/dev/null')) return t.skip('no /dev/null');
      const dir = tempDir();
      const link = join(dir, 'gcr.sqlite');
      symlinkSync('/dev/null', link);
      assertRefusedPromptly(openInChild(link, readOnly), `link to /dev/null ${mode}`);
      assert.deepEqual(readdirSync(dir), ['gcr.sqlite']);
    });

    it(`a Unix domain socket (${mode})`, async (t) => {
      const dir = tempDir();
      const sock = join(dir, 'gcr.sqlite');
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(sock, () => resolve());
        });
      } catch {
        return t.skip('cannot create a Unix socket here');
      }
      try {
        assertRefusedPromptly(openInChild(sock, readOnly), `socket ${mode}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});

describe('a symbolic link to a NON-EMPTY file that is not a database is never written to', () => {
  it('read-write: the bytes (and the mode, and the directory) are exactly as they were', () => {
    const dir = tempDir();
    const precious = join(dir, 'precious.txt');
    const content = 'A PRECIOUS FILE THAT IS NOT A DATABASE, long enough to look like text, not like a SQLite header.\n';
    writeFileSync(precious, content, { mode: 0o640 });
    const link = join(dir, 'gcr.sqlite');
    symlinkSync(precious, link);
    for (const readOnly of [false, true]) {
      assert.throws(
        () => openDatabase(link, readOnly ? { readOnly: true } : {}),
        (e) => e instanceof GcrError && e.code === 'DB_ERROR',
        readOnly ? 'read-only' : 'read-write',
      );
    }
    assert.equal(readFileSync(precious, 'utf8'), content);
    assert.equal(lstatSync(precious).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(dir).sort(), ['gcr.sqlite', 'precious.txt'], 'no -wal, -shm or -journal appeared');
  });

  it('a 2-byte and a 99-byte file (shorter than a SQLite header) are not touched either', () => {
    const dir = tempDir();
    for (const size of [2, 99]) {
      const target = join(dir, `t${size}.bin`);
      writeFileSync(target, 'x'.repeat(size));
      const link = join(dir, `l${size}.sqlite`);
      symlinkSync(target, link);
      assert.throws(() => openDatabase(link), (e) => e instanceof GcrError, `size ${size}`);
      assert.equal(readFileSync(target, 'utf8'), 'x'.repeat(size), `size ${size}`);
    }
    assert.equal(readdirSync(dir).some((n) => /-(wal|shm|journal)$/.test(n)), false);
  });
});

/**
 * The ATK-01 fix refused a link to an EMPTY file, but the attack only needs a file SQLite is willing to INITIALISE in place, and
 * that is more than a zero-byte file: SQLite also treats a ONE-byte file as a database that does not exist yet (measured), and a
 * valid SQLite file without a single table (`sqlite3 f vacuum`) is initialised by migration 1. Both, planted by the attacker in
 * his own directory and reached through a link in the shared one, received the whole conversation database, mode 0644, owned by him.
 */
describe('ATK-01 bypass attempts: a link to a file that SQLite would initialise in place', () => {
  function assertSymlinkRefusal(e: unknown): true {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${String(e)}`);
    assert.equal(e.code, 'DB_ERROR');
    assert.equal(e.details?.['reason'], 'SYMLINK_DB_PATH');
    assert.match(e.remedy ?? '', /real path/i);
    return true;
  }

  /** A SQLite file with a valid header, user_version 0 and no tables: created through the library itself. */
  function uninitialisedSqliteFile(path: string): void {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE scratch(a)');
    db.exec('DROP TABLE scratch');
    db.exec('VACUUM');
    db.close();
  }

  it('a ONE-byte target is refused and left byte for byte as it was (read-write); read-only reads nothing into it', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'attacker'));
    mkdirSync(join(dir, 'shared'));
    const target = join(dir, 'attacker', 'stolen.sqlite');
    writeFileSync(target, 'x', { mode: 0o644 });
    const link = join(dir, 'shared', 'gcr.sqlite');
    symlinkSync(target, link);
    const before = readdirSync(join(dir, 'attacker'));
    assert.throws(() => openDatabase(link), assertSymlinkRefusal);
    assert.equal(readFileSync(target, 'utf8'), 'x', 'still exactly one byte');
    assert.deepEqual(readdirSync(join(dir, 'attacker')), before);
    assert.deepEqual(readdirSync(join(dir, 'shared')), ['gcr.sqlite']);
    assert.throws(() => openDatabase(link, { readOnly: true }), (e) => e instanceof GcrError && e.code === 'DB_ERROR');
    assert.equal(readFileSync(target, 'utf8'), 'x');
  });

  it('a valid but uninitialised SQLite file as the target is refused, read-write, and not modified by the attempt', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'attacker'));
    mkdirSync(join(dir, 'shared'));
    const target = join(dir, 'attacker', 'stolen.sqlite');
    uninitialisedSqliteFile(target);
    const bytes = readFileSync(target);
    assert.ok(bytes.length >= 512, 'not an "empty file" by any size test');
    const link = join(dir, 'shared', 'gcr.sqlite');
    symlinkSync(target, link);
    assert.throws(() => openDatabase(link), assertSymlinkRefusal);
    assert.deepEqual(readFileSync(target), bytes, 'not one byte of the attacker file changed (no WAL switch, no schema)');
    assert.deepEqual(readdirSync(join(dir, 'attacker')), ['stolen.sqlite'], 'no -wal or -shm next to it');
  });

  it('the SDK (every CLI and MCP open) refuses both the same way', () => {
    const dir = tempDir();
    const one = join(dir, 'one.bin');
    writeFileSync(one, 'x');
    const empty = join(dir, 'empty-db.bin');
    uninitialisedSqliteFile(empty);
    for (const target of [one, empty]) {
      const link = join(dir, `${target.endsWith('one.bin') ? 'a' : 'b'}.sqlite`);
      symlinkSync(target, link);
      assert.throws(() => Gcr.open({ dbPath: link }), assertSymlinkRefusal, target);
    }
    assert.equal(readFileSync(one, 'utf8'), 'x');
  });

  it('a link to a database that is already initialised keeps working, read-write and read-only (the documented policy)', () => {
    const dir = tempDir();
    const real = join(dir, 'real.sqlite');
    closeDatabase(openDatabase(real));
    const link = join(dir, 'link.sqlite');
    symlinkSync(real, link);
    const rw = openDatabase(link);
    assert.equal(rw.schemaVersion >= 1, true);
    closeDatabase(rw);
    const ro = openDatabase(link, { readOnly: true });
    closeDatabase(ro);
    const chain = join(dir, 'chain.sqlite');
    symlinkSync(link, chain);
    closeDatabase(openDatabase(chain));
  });

  it('a link to another application\'s SQLite file is still "not a GCR database" (not hidden behind the link refusal)', () => {
    const dir = tempDir();
    const foreign = join(dir, 'foreign.sqlite');
    const f = new DatabaseSync(foreign);
    f.exec('CREATE TABLE somebody_elses(a)');
    f.close();
    const link = join(dir, 'link.sqlite');
    symlinkSync(foreign, link);
    assert.throws(
      () => Gcr.open({ dbPath: link }),
      (e) => e instanceof GcrError && e.code === 'DB_ERROR' && e.details?.['reason'] === 'not_gcr_database',
    );
  });
});

describe('path spellings', () => {
  it('a trailing slash after a regular file is a coded error and creates nothing', () => {
    const dir = tempDir();
    const file = join(dir, 'plain.sqlite');
    writeFileSync(file, '');
    try {
      assert.throws(() => openDatabase(`${file}/`), (e) => e instanceof GcrError && e.code === 'DB_ERROR');
    } finally {
      assert.deepEqual(readdirSync(dir), ['plain.sqlite']);
    }
  });

  it('a path through a symbolic link to a missing directory is DB_NOT_FOUND (directory) and creates nothing', () => {
    const dir = tempDir();
    symlinkSync(join(dir, 'missing'), join(dir, 'via'));
    assert.throws(
      () => openDatabase(join(dir, 'via', 'gcr.sqlite')),
      (e) => e instanceof GcrError && e.code === 'DB_NOT_FOUND',
    );
    assert.equal(existsSync(join(dir, 'missing')), false);
  });

  it('":memory:" and "file:" URIs behave as documented and touch no file', () => {
    const dir = tempDir();
    const before = readdirSync(dir);
    const g = openDatabase(':memory:');
    g.db.close();
    for (const uri of ['file:x.sqlite', 'FILE:x.sqlite', `file:${join(dir, 'u.sqlite')}?mode=rwc`, 'file::memory:?cache=shared']) {
      assert.throws(
        () => openDatabase(uri),
        (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT',
        uri,
      );
    }
    assert.deepEqual(readdirSync(dir), before);
    mkdirSync(join(dir, 'sub'));
  });
});
