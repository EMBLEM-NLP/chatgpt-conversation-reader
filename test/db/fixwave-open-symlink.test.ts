/**
 * ATK-01 (high): creating a database through a dangling symbolic link must never create the link's target with the default
 * umask (the operator's whole conversation history would end up in a file somebody else chose, readable by group and other).
 * ATK-08(a): a SQLite file that is not a GCR database says so when a READ command meets it (it used to say "not initialized"
 * and suggest an import, which the import then refuses).
 *
 * Policy under test (docs/SECURITY_AND_BOUNDARIES.md, section 4.1):
 *  - a path that is a symbolic link is REFUSED (DB_ERROR, details.reason SYMLINK_DB_PATH) whenever opening it would CREATE or
 *    INITIALISE a database: the link is dangling, or it leads to an empty file;
 *  - an existing, non-empty database reached through a link keeps working (read-only and read-write);
 *  - nothing at all is created by a refused open;
 *  - EEXIST from `open(path, 'wx')` is accepted as "somebody created it concurrently" only when lstat shows a regular file.
 * SYNTHETIC data only; real files in temp directories, no mocks.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { closeDatabase, createPrivateFile, openDatabase } from '../../src/db/open.js';
import { Gcr } from '../../src/sdk/gcr.js';

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-symlink-'));
  made.push(dir);
  return dir;
}
const mode = (p: string): number => lstatSync(p).mode & 0o777;

/** Run `fn` under umask 022, the default of nearly every system: the case in which a created file would be 0644. */
function withUmask<T>(mask: number, fn: () => T): T {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

function layout(): { dir: string; shared: string; attacker: string } {
  const dir = tempDir();
  const shared = join(dir, 'shared');
  const attacker = join(dir, 'attacker');
  mkdirSync(shared);
  mkdirSync(attacker);
  return { dir, shared, attacker };
}

function listing(...dirs: string[]): string[] {
  return dirs.flatMap((d) => readdirSync(d).map((n) => `${d}/${n}`)).sort();
}

function assertSymlinkRefusal(e: unknown, dir: string): true {
  assert.ok(e instanceof GcrError, `expected a GcrError, got ${String(e)}`);
  assert.equal(e.code, 'DB_ERROR');
  assert.equal(e.details?.['reason'], 'SYMLINK_DB_PATH');
  assert.match(e.remedy ?? '', /real path/i, 'the remedy says to pass the real path');
  const everything = JSON.stringify([e.message, e.remedy, e.details]);
  assert.equal(everything.includes(dir), false, 'no absolute directory in the error');
  return true;
}

describe('ATK-01: a dangling symbolic link as the database path', () => {
  it('is refused with SYMLINK_DB_PATH and NOTHING is created: not the target, not a sidecar, not a file anywhere', () => {
    const { dir, shared, attacker } = layout();
    const target = join(attacker, 'stolen.sqlite');
    const link = join(shared, 'gcr.sqlite');
    symlinkSync(target, link);
    const before = listing(shared, attacker);
    withUmask(0o022, () => {
      assert.throws(() => openDatabase(link), (e) => assertSymlinkRefusal(e, dir));
    });
    assert.equal(existsSync(target), false, 'the target of the link was not created');
    assert.deepEqual(listing(shared, attacker), before, 'no file appeared in either directory');
    assert.ok(lstatSync(link).isSymbolicLink(), 'the link is still a link');
    assert.equal(readlinkSync(link), target, 'and still points where it pointed');
  });

  it('a relative dangling link, a chain of links ending nowhere and a link into a directory that does not exist are all refused', () => {
    const { dir, shared, attacker } = layout();
    const relative = join(shared, 'relative.sqlite');
    symlinkSync('../attacker/relative-target.sqlite', relative);
    const hop2 = join(shared, 'hop2');
    symlinkSync(join(attacker, 'chain-target.sqlite'), hop2);
    const hop1 = join(shared, 'hop1.sqlite');
    symlinkSync(hop2, hop1);
    const intoNowhere = join(shared, 'nowhere.sqlite');
    symlinkSync(join(dir, 'no-such-directory', 'db.sqlite'), intoNowhere);
    const before = listing(shared, attacker);
    withUmask(0o022, () => {
      for (const link of [relative, hop1, intoNowhere]) assert.throws(() => openDatabase(link), (e) => assertSymlinkRefusal(e, dir), link);
    });
    assert.deepEqual(listing(shared, attacker), before);
    assert.equal(existsSync(join(attacker, 'relative-target.sqlite')), false);
    assert.equal(existsSync(join(attacker, 'chain-target.sqlite')), false);
    assert.equal(existsSync(join(dir, 'no-such-directory')), false);
  });

  it('the SDK (what every CLI and MCP open goes through) refuses it the same way', () => {
    const { dir, shared, attacker } = layout();
    const target = join(attacker, 'stolen.sqlite');
    const link = join(shared, 'gcr.sqlite');
    symlinkSync(target, link);
    withUmask(0o022, () => {
      assert.throws(() => Gcr.open({ dbPath: link }), (e) => assertSymlinkRefusal(e, dir));
    });
    assert.equal(existsSync(target), false);
    assert.deepEqual(listing(attacker), []);
  });

  it('a read-only open, or create:false, of a dangling link is DB_NOT_FOUND and creates nothing', () => {
    const { shared, attacker } = layout();
    const target = join(attacker, 'stolen.sqlite');
    const link = join(shared, 'gcr.sqlite');
    symlinkSync(target, link);
    for (const opts of [{ readOnly: true }, { create: false }]) {
      assert.throws(() => openDatabase(link, opts), (e) => e instanceof GcrError && e.code === 'DB_NOT_FOUND', JSON.stringify(opts));
    }
    assert.equal(existsSync(target), false);
    assert.deepEqual(listing(attacker), []);
  });

  it('a link to an EMPTY existing file would initialise a new database through a link: refused, the target is left as it was', () => {
    const { dir, shared, attacker } = layout();
    const target = join(attacker, 'empty.sqlite');
    writeFileSync(target, '', { mode: 0o644 });
    const link = join(shared, 'gcr.sqlite');
    symlinkSync(target, link);
    withUmask(0o022, () => {
      assert.throws(() => openDatabase(link), (e) => assertSymlinkRefusal(e, dir));
    });
    assert.equal(statSync(target).size, 0, 'nothing was written into the target');
    assert.equal(mode(target), 0o644);
    assert.deepEqual(listing(attacker), [`${attacker}/empty.sqlite`]);
  });

  it('a link to a directory keeps the existing is_directory answer', () => {
    const { shared, attacker } = layout();
    const link = join(shared, 'gcr.sqlite');
    symlinkSync(attacker, link);
    assert.throws(() => openDatabase(link), (e) => e instanceof GcrError && e.code === 'DB_ERROR' && e.details?.['reason'] === 'is_directory');
  });
});

describe('ATK-01: what must keep working', () => {
  it('an existing GCR database reached through a symbolic link opens read-write and read-only, and stays 0600 at its real place', () => {
    const { shared, attacker } = layout();
    const real = join(attacker, 'real.sqlite');
    withUmask(0o022, () => closeDatabase(openDatabase(real)));
    assert.equal(mode(real), 0o600);
    const link = join(shared, 'gcr.sqlite');
    symlinkSync(real, link);

    const rw = openDatabase(link);
    try {
      assert.equal(rw.schemaVersion, 1);
      rw.db.exec("INSERT INTO gcr_meta (key, value) VALUES ('fixwave', 'written through the link')");
    } finally {
      closeDatabase(rw);
    }
    const ro = openDatabase(link, { readOnly: true });
    try {
      assert.equal(ro.db.prepare("SELECT value FROM gcr_meta WHERE key = 'fixwave'").get()?.['value'], 'written through the link');
    } finally {
      closeDatabase(ro);
    }
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(mode(real), 0o600);
  });

  it('a plain path is created with mode 0600 whatever the umask (022 and 000)', () => {
    const dir = tempDir();
    for (const [mask, name] of [
      [0o022, 'a.sqlite'],
      [0o000, 'b.sqlite'],
    ] as const) {
      const path = join(dir, name);
      withUmask(mask, () => closeDatabase(openDatabase(path)));
      assert.equal(mode(path), 0o600, `umask ${mask.toString(8)}`);
    }
  });

  it('a symbolic link in a DIRECTORY component of the path is unchanged: the database is created inside the real directory, 0600', () => {
    const { dir, shared } = layout();
    const realDir = join(dir, 'real-dir');
    mkdirSync(realDir);
    symlinkSync(realDir, join(shared, 'dirlink'));
    const path = join(shared, 'dirlink', 'gcr.sqlite');
    withUmask(0o022, () => closeDatabase(openDatabase(path)));
    assert.equal(mode(join(realDir, 'gcr.sqlite')), 0o600);
    assert.ok(lstatSync(join(shared, 'dirlink')).isSymbolicLink());
  });
});

describe('ATK-01: EEXIST from open(path, "wx") is success only for a regular file', () => {
  it('a regular file that appeared meanwhile (a concurrent creator) is accepted and left untouched', () => {
    const dir = tempDir();
    const path = join(dir, 'raced.sqlite');
    writeFileSync(path, 'x', { mode: 0o600 });
    assert.doesNotThrow(() => createPrivateFile(path, 'raced.sqlite'));
    assert.equal(readFileSync(path, 'utf8'), 'x');
  });

  it('a symbolic link that appeared meanwhile (dangling or not) is refused, and the target is not created', () => {
    const { dir, shared, attacker } = layout();
    const dangling = join(shared, 'dangling.sqlite');
    symlinkSync(join(attacker, 'stolen.sqlite'), dangling);
    assert.throws(() => createPrivateFile(dangling, 'dangling.sqlite'), (e) => assertSymlinkRefusal(e, dir));
    assert.equal(existsSync(join(attacker, 'stolen.sqlite')), false);

    const existingTarget = join(attacker, 'existing.sqlite');
    writeFileSync(existingTarget, 'not touched', { mode: 0o644 });
    const live = join(shared, 'live.sqlite');
    symlinkSync(existingTarget, live);
    assert.throws(() => createPrivateFile(live, 'live.sqlite'), (e) => assertSymlinkRefusal(e, dir));
    assert.equal(readFileSync(existingTarget, 'utf8'), 'not touched');
  });

  it('a directory that appeared meanwhile is a coded storage error, not success', () => {
    const dir = tempDir();
    const path = join(dir, 'taken');
    mkdirSync(path);
    assert.throws(
      () => createPrivateFile(path, 'taken'),
      (e) => e instanceof GcrError && e.code === 'DB_ERROR' && e.details?.['reason'] === 'cannot_create',
    );
  });

  it('a fresh path is created exclusively with mode 0600', () => {
    const dir = tempDir();
    const path = join(dir, 'fresh.sqlite');
    withUmask(0o022, () => createPrivateFile(path, 'fresh.sqlite'));
    assert.equal(mode(path), 0o600);
    assert.equal(statSync(path).size, 0);
  });
});

describe('ATK-01: concurrent creation of the same new database still works', () => {
  it('six processes opening one new path at the same instant all succeed; the file is one valid 0600 database', async () => {
    const dir = tempDir();
    const path = join(dir, 'race.sqlite');
    const openJs = fileURLToPath(new URL('../../src/db/open.js', import.meta.url));
    const startAt = Date.now() + 1500;
    const script = [
      `const { openDatabase, closeDatabase } = await import(${JSON.stringify(openJs)});`,
      `const wait = ${startAt} - Date.now();`,
      'if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);',
      `const h = openDatabase(${JSON.stringify(path)});`,
      'closeDatabase(h);',
    ].join('\n');
    const runs = Array.from({ length: 6 }, () =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env['PATH'] ?? '' } });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        child.on('close', (code) => resolve({ code, stderr }));
      }),
    );
    for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.stderr);
    assert.equal(mode(path), 0o600);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 1);
    } finally {
      db.close();
    }
  });
});

describe('creating a database next to stray sidecar files', () => {
  it('refuses to create over a pre-existing <db>-wal, <db>-shm or <db>-journal (SQLite would delete them), and creates nothing', () => {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const dir = tempDir();
      const path = join(dir, 'mydata');
      writeFileSync(path + suffix, 'PRECIOUS');
      assert.throws(
        () => openDatabase(path),
        (e) => e instanceof GcrError && e.code === 'DB_ERROR' && e.details?.['reason'] === 'STRAY_SIDECAR_FILES' && !JSON.stringify([e.message, e.remedy, e.details]).includes(dir),
        suffix,
      );
      assert.equal(existsSync(path), false, `${suffix}: the database was not created`);
      assert.equal(readFileSync(path + suffix, 'utf8'), 'PRECIOUS', `${suffix}: the file survived`);
    }
  });
});

describe('ATK-08(a): a SQLite file that is not a GCR database', () => {
  function foreignDatabase(dir: string): string {
    const path = join(dir, 'foreign.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE t (a)');
    db.close();
    return path;
  }

  it('a READ open says "not a GCR database" (not "not initialized"), suggests no import, and does not touch the file', () => {
    const dir = tempDir();
    const path = foreignDatabase(dir);
    const bytes = readFileSync(path);
    assert.throws(
      () => openDatabase(path, { readOnly: true }),
      (e) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'DB_ERROR');
        assert.equal(e.details?.['reason'], 'not_gcr_database');
        assert.match(e.message, /not a GCR database/i);
        assert.doesNotMatch(e.message, /initiali[sz]ed/i);
        assert.doesNotMatch(e.remedy ?? '', /import|initiali[sz]e|read-write/i, 'an import would refuse this file, so the remedy must not suggest one');
        return true;
      },
    );
    assert.ok(readFileSync(path).equals(bytes), 'the file is byte-for-byte unchanged');
    assert.deepEqual(readdirSync(dir), ['foreign.sqlite'], 'no side file appeared');
  });

  it('the read and the write refusal are the same answer (code, message and reason)', () => {
    const dir = tempDir();
    const path = foreignDatabase(dir);
    const grab = (fn: () => unknown): GcrError => {
      try {
        fn();
      } catch (e) {
        if (e instanceof GcrError) return e;
      }
      throw new Error('expected a GcrError');
    };
    const read = grab(() => Gcr.open({ dbPath: path, readOnly: true }));
    const write = grab(() => Gcr.open({ dbPath: path }));
    assert.equal(read.code, write.code);
    assert.equal(read.message, write.message);
    assert.deepEqual(read.details, write.details);
  });

  it('an EMPTY file and an uninitialised GCR-less new file still say "not initialized" for a read (that message is true for them)', () => {
    const dir = tempDir();
    const path = join(dir, 'empty.sqlite');
    writeFileSync(path, '');
    assert.throws(
      () => openDatabase(path, { readOnly: true }),
      (e) => e instanceof GcrError && e.code === 'DB_ERROR' && /not been initialized/i.test(e.message) && e.details?.['reason'] === 'needs_migration',
    );
  });
});
