/**
 * Adversarial review of the ATK-05 / ATK-11 fixes in src/cli/context.ts.
 *
 *  - ATK-11: the warning is about the DEFAULT database "or its directory". A foreign `./.gcr` directory with no database in it yet
 *    is the cheapest way to plant the trap (the victim's first `gcr import` creates the database in a directory somebody else
 *    owns and can swap files in), and it must be announced just like an existing foreign database. A directory the command
 *    creates itself, and an explicit --db, stay silent.
 *  - ATK-05: what a failed first import takes back is exactly what that command created: a fresh database goes, the side files
 *    that were not there before go, a stray one that was there before is never touched.
 *
 * In-process (runCli with a captured output and a stubbed process.getuid, so the tests also run without root) plus one
 * end-to-end test with a real chown that runs only as root. SYNTHETIC data only.
 *
 * WHICH TESTS SKIP, BY USER (the "# skipped" count of a run is the same number for both users, but not the same tests):
 *  - as root:      nothing in this file is skipped;
 *  - as non-root:  "end to end with a real chown (root only): the first import into somebody else's empty ./.gcr warns" (a normal
 *                  user cannot chown). The ATK-11 logic itself stays covered without root by the stubbed-uid tests above it.
 *  The other root/non-root skip pairs of the suite: test/cli/fixwave-db-safety.test.ts (non-root skips its real-chown test),
 *  test/devtools/privacy-scan.repo.test.ts "reports an unreadable file ..." and test/sdk/doctor.test.ts "an unreadable file (no
 *  read permission) ..." (both skip as ROOT, because root can read everything).
 */
import '../../src/suppress-warnings.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Lifecycle, removeCreated, snapshotDatabasePaths } from '../../src/cli/context.js';
import type { CliEnvironment, StdinLike } from '../../src/cli/context.js';
import { createBufferOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import { CLI_MAIN, gcr, standardExport, tempDir, writeFile } from './cli.helpers.test.js';

const emptyStdin: StdinLike = {
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    /* no data */
  },
};

interface Captured {
  code: number;
  out: string;
  err: string;
}

/** Run one command in-process; `asUid` makes the process believe it is somebody else (the files it creates are then "foreign"). */
async function run(argv: string[], cwd: string, opts: { asUid?: number; env?: Record<string, string> } = {}): Promise<Captured> {
  const out = createBufferOutput();
  const io: CliEnvironment = { argv, env: opts.env ?? {}, cwd, out, stdin: emptyStdin, lifecycle: new Lifecycle() };
  const realGetuid = process.getuid;
  if (opts.asUid !== undefined) {
    const uid = opts.asUid;
    process.getuid = () => uid;
  }
  try {
    const code = await runCli(io);
    return { code, out: out.out.join(''), err: out.err.join('') };
  } finally {
    process.getuid = realGetuid;
  }
}

const ME = process.getuid?.() ?? 0;
const WARNING = /not owned by the current user/;
const posix = process.platform !== 'win32' && process.getuid !== undefined;

describe('ATK-11: a foreign ./.gcr directory is announced even when no database is in it yet', { skip: posix ? false : 'POSIX ownership only' }, () => {
  it('gcr import into an existing ./.gcr that belongs to somebody else warns on stderr (once), --quiet or not, and stdout stays the result', async () => {
    for (const quiet of [false, true]) {
      const dir = tempDir();
      mkdirSync(join(dir, '.gcr'), { mode: 0o700 });
      const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
      const r = await run(['import', exportPath, ...(quiet ? ['--quiet'] : []), '--format', 'json'], dir, { asUid: ME + 1 });
      assert.equal(r.code, 0, r.err);
      assert.equal((r.err.match(/not owned by the current user/g) ?? []).length, 1, `quiet=${String(quiet)}: ${r.err}`);
      assert.equal(WARNING.test(r.out), false, 'never on stdout');
      assert.doesNotThrow(() => JSON.parse(r.out) as unknown, 'stdout is still exactly the JSON result');
    }
  });

  it('a ./.gcr that the command creates itself is its own: silent', async () => {
    const dir = tempDir();
    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
    const r = await run(['import', exportPath, '--format', 'json'], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(WARNING.test(r.err), false, r.err);
  });

  it('an explicit --db or GCR_DB inside a foreign directory is the operator\'s own choice: silent', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'data'));
    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
    const a = await run(['import', exportPath, '--db', join(dir, 'data', 'a.sqlite'), '--quiet'], dir, { asUid: ME + 1 });
    assert.equal(a.code, 0, a.err);
    assert.equal(WARNING.test(a.err), false);
    const b = await run(['import', exportPath, '--quiet'], dir, { asUid: ME + 1, env: { GCR_DB: join(dir, 'data', 'b.sqlite') } });
    assert.equal(b.code, 0, b.err);
    assert.equal(WARNING.test(b.err), false);
  });

  it('a read command on a foreign ./.gcr with no database says DB_NOT_FOUND and nothing else (there is nothing to warn about yet)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.gcr'));
    const r = await run(['list'], dir, { asUid: ME + 1 });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /DB_NOT_FOUND/);
  });

  it('a ./.gcr that is a symbolic link counts by the owner of the LINK (what the planter controls)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, '.gcr'));
    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
    const r = await run(['import', exportPath, '--quiet'], dir, { asUid: ME + 1 });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, WARNING);
  });

  it('end to end with a real chown (root only): the first import into somebody else\'s empty ./.gcr warns', async (t) => {
    if (process.getuid?.() !== 0) return t.skip('needs root to give a directory to another user');
    const dir = tempDir();
    mkdirSync(join(dir, '.gcr'));
    chownSync(join(dir, '.gcr'), 4242, 4242);
    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
    const r = await gcr(['import', exportPath, '--quiet', '--format', 'json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, WARNING);
    assert.equal(WARNING.test(r.stdout), false);
  });
});

describe('ATK-05: removeCreated and the snapshot', () => {
  const NONE = { '': false, '-wal': false, '-shm': false, '-journal': false } as const;

  it('never deletes a pre-existing sidecar that is a SYMBOLIC LINK, nor what it points to', () => {
    const dir = tempDir();
    const db = join(dir, 'x.sqlite');
    const precious = join(dir, 'precious.txt');
    writeFileSync(precious, 'PRECIOUS');
    symlinkSync(precious, `${db}-wal`);
    const before = snapshotDatabasePaths(db);
    assert.equal(before['-wal'], true);
    removeCreated(db, undefined, before);
    assert.equal(readFileSync(precious, 'utf8'), 'PRECIOUS');
    assert.ok(existsSync(`${db}-wal`), 'the link itself is the operator\'s too');
  });

  it('a name that is a DIRECTORY now is left alone (rmSync without recursive cannot remove it) and nothing throws', () => {
    const dir = tempDir();
    const db = join(dir, 'x.sqlite');
    mkdirSync(`${db}-shm`);
    writeFileSync(join(`${db}-shm`, 'inner'), 'keep');
    assert.doesNotThrow(() => removeCreated(db, undefined, NONE));
    assert.equal(readFileSync(join(`${db}-shm`, 'inner'), 'utf8'), 'keep');
  });

  it('removes the default directory it created only while the directory is empty', () => {
    const dir = tempDir();
    const created = join(dir, '.gcr');
    mkdirSync(created);
    writeFileSync(join(created, 'gcr.sqlite'), '');
    writeFileSync(join(created, 'somebody-elses-file'), 'keep');
    removeCreated(join(created, 'gcr.sqlite'), created, NONE);
    assert.equal(existsSync(join(created, 'gcr.sqlite')), false);
    assert.equal(readFileSync(join(created, 'somebody-elses-file'), 'utf8'), 'keep', 'the directory still holds a foreign file: kept');
    assert.deepEqual(readdirSync(created), ['somebody-elses-file']);
  });

  it('a failed first import into the DEFAULT location with a stray ./.gcr/gcr.sqlite-wal keeps the stray and creates nothing', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.gcr'));
    writeFileSync(join(dir, '.gcr', 'gcr.sqlite-wal'), 'PRECIOUS\n');
    const bad = writeFile(dir, 'bad.json', 'not json');
    const r = await run(['import', bad, '--quiet'], dir);
    assert.notEqual(r.code, 0);
    assert.equal(readFileSync(join(dir, '.gcr', 'gcr.sqlite-wal'), 'utf8'), 'PRECIOUS\n');
    assert.deepEqual(readdirSync(join(dir, '.gcr')), ['gcr.sqlite-wal']);
  });
});

describe('read commands never create anything, whatever sits at the database path (and never hang)', () => {
  /** A stable picture of a directory tree: type, mode, size and link target of every entry. */
  function picture(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d).sort()) {
        const full = join(d, name);
        const st = lstatSync(full);
        out.push(`${full.slice(dir.length)} ${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFIFO() ? 'fifo' : 'file'} ${(st.mode & 0o777).toString(8)} ${st.size}`);
        if (st.isDirectory()) walk(full);
      }
    };
    walk(dir);
    return out;
  }

  const READS: ReadonlyArray<readonly string[]> = [['list'], ['stats'], ['audit'], ['search', 'hello'], ['get', 'abc'], ['thread', 'abc'], ['branches', 'abc']];

  it('a dangling link, a link to an empty or one-byte file, strays next to a missing database, a directory and a FIFO', (t) => {
    const dir = tempDir();
    mkdirSync(join(dir, 'attacker'));
    symlinkSync(join(dir, 'attacker', 'never'), join(dir, 'dangling.sqlite'));
    writeFileSync(join(dir, 'empty.bin'), '');
    symlinkSync(join(dir, 'empty.bin'), join(dir, 'linkempty.sqlite'));
    writeFileSync(join(dir, 'one.sqlite'), 'x');
    writeFileSync(join(dir, 'stray.sqlite-wal'), 'W');
    mkdirSync(join(dir, 'adir.sqlite'));
    const hasFifo = spawnSync('mkfifo', [join(dir, 'fifo.sqlite')]).status === 0;
    if (!hasFifo) t.diagnostic('mkfifo is not available: the FIFO case is not exercised');
    const states = ['dangling.sqlite', 'linkempty.sqlite', 'one.sqlite', 'stray.sqlite', 'adir.sqlite', 'attacker/never', ...(hasFifo ? ['fifo.sqlite'] : [])];
    const before = picture(dir);
    for (const state of states) {
      for (const read of READS) {
        const r = spawnSync(process.execPath, [CLI_MAIN, ...read, '--db', join(dir, state)], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', cwd: dir });
        assert.equal(r.error, undefined, `gcr ${read.join(' ')} --db ${state}: did not finish (a FIFO blocks a naive open)`);
        assert.notEqual(r.status, null, `${state} ${read[0] ?? ''}`);
      }
      assert.deepEqual(picture(dir), before, `${state}: a read command changed the directory`);
    }
  });
});
