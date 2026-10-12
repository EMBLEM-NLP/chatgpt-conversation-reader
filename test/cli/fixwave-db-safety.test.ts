/**
 * CLI-level regression tests for the database-path findings of the security review (compiled CLI as a child process, the way a
 * user starts it; SYNTHETIC data only):
 *
 *  - ATK-01: `--db` naming a dangling symbolic link creates nothing and fails with a coded error (the link itself survives);
 *    a symlinked ./.gcr DIRECTORY keeps working;
 *  - ATK-05: a failed first import deletes only what it created. A pre-existing <db>-wal, <db>-shm or <db>-journal is the
 *    operator's file and must survive (SQLite deletes such files next to a NEW empty database, so the CLI refuses to create one
 *    there; and `removeCreated` never unlinks a path that existed before the command);
 *  - ATK-08(a): a read command on a SQLite file that is not a GCR database says exactly that;
 *  - ATK-11: a default ./.gcr database that belongs to somebody else is announced on stderr (never stdout, never suppressed by
 *    --quiet); explicit --db / GCR_DB are the operator's own choice and stay silent.
 *
 * WHICH TESTS SKIP, BY USER (the "# skipped" count of a run is the same number for both users, but not the same tests):
 *  - as root:      nothing in this file is skipped;
 *  - as non-root:  "end to end: warns on stderr for a database owned by another user (only when the test may chown) ..." (a normal
 *                  user cannot chown). The ATK-11 logic is still covered without root by the defaultDatabaseOwnershipWarning
 *                  tests, which pass a different uid to the function instead of changing a file's owner.
 *  The other root/non-root skip pairs of the suite: test/cli/db-safety.adversarial.test.ts (non-root skips its real-chown test),
 *  test/devtools/privacy-scan.repo.test.ts "reports an unreadable file ..." and test/sdk/doctor.test.ts "an unreadable file (no
 *  read permission) ..." (both skip as ROOT, because root can read everything).
 */
import assert from 'node:assert/strict';
import { chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { defaultDatabaseOwnershipWarning, removeCreated, snapshotDatabasePaths } from '../../src/cli/context.js';
import { assertClean, assertJsonError, assertOk, assertTextError, envelope, gcr, standardExport, tempDir, writeFile } from './cli.helpers.test.js';

const mode = (p: string): number => lstatSync(p).mode & 0o777;
const SUFFIXES = ['-wal', '-shm', '-journal'] as const;

describe('ATK-01: --db naming a dangling symbolic link', () => {
  it('import fails with DB_ERROR, creates NOTHING at the target, and leaves the link alone', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'shared'));
    mkdirSync(join(dir, 'attacker'));
    const target = join(dir, 'attacker', 'stolen.sqlite');
    const link = join(dir, 'shared', 'gcr.sqlite');
    symlinkSync(target, link);
    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);

    const r = await gcr(['import', exportPath, '--db', link, '--quiet']);
    assertTextError(r, 'DB_ERROR', { remedy: /real path/i });
    assert.match(r.stderr, /symbolic link/i);
    assert.equal(existsSync(target), false, 'the target was not created');
    assert.deepEqual(readdirSync(join(dir, 'attacker')), [], 'nothing in the directory the link points into');
    assert.ok(lstatSync(link).isSymbolicLink(), 'the failed command did not delete the link (it did not create it)');
    assert.equal(readlinkSync(link), target);

    const json = await gcr(['import', exportPath, '--db', link, '--quiet', '--format', 'json']);
    assert.equal(assertJsonError(json, 'DB_ERROR').error.details?.['reason'], 'SYMLINK_DB_PATH');
  });

  it('a read command on a dangling link is DB_NOT_FOUND and creates nothing', async () => {
    const dir = tempDir();
    const target = join(dir, 'nowhere.sqlite');
    const link = join(dir, 'gcr.sqlite');
    symlinkSync(target, link);
    assertTextError(await gcr(['list', '--db', link]), 'DB_NOT_FOUND');
    assert.equal(existsSync(target), false);
    assert.ok(lstatSync(link).isSymbolicLink());
  });

  it('a ./.gcr that is a symbolic link to an existing DIRECTORY keeps working: the database is created inside it, 0600', async () => {
    const dir = tempDir();
    const real = join(dir, 'real-gcr-dir');
    mkdirSync(real);
    symlinkSync(real, join(dir, '.gcr'));
    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
    const r = await gcr(['import', exportPath, '--quiet', '--format', 'json'], { cwd: dir });
    assertOk(r, 'import into the default location through a directory link');
    assert.equal(mode(join(real, 'gcr.sqlite')), 0o600);
    assert.ok(lstatSync(join(dir, '.gcr')).isSymbolicLink(), 'the directory link is still a link');
  });

  it('a ./.gcr that is a DANGLING link is still the existing coded storage error, and nothing is created behind it', async () => {
    const dir = tempDir();
    const missing = join(dir, 'missing-dir');
    symlinkSync(missing, join(dir, '.gcr'));
    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
    assertTextError(await gcr(['import', exportPath, '--quiet'], { cwd: dir }), 'DB_ERROR');
    assert.equal(existsSync(missing), false);
    assert.ok(lstatSync(join(dir, '.gcr')).isSymbolicLink());
  });
});

describe('ATK-05: a failed first import deletes only what it created', () => {
  for (const suffix of SUFFIXES) {
    it(`a pre-existing unrelated <db>${suffix} survives a failed first import (and no database is left behind)`, async () => {
      const dir = tempDir();
      const sidecar = join(dir, `mydata${suffix}`);
      writeFileSync(sidecar, 'PRECIOUS\n');
      const bad = writeFile(dir, 'bad.json', 'not json');
      const r = await gcr(['import', bad, '--db', join(dir, 'mydata'), '--quiet']);
      assert.notEqual(r.code, 0, 'the import failed');
      assert.equal(r.stdout, '');
      assert.equal(readFileSync(sidecar, 'utf8'), 'PRECIOUS\n', `${suffix} was not touched`);
      assert.equal(existsSync(join(dir, 'mydata')), false, 'no empty database was left behind');
    });
  }

  it('all three at once survive; the rest of the directory is exactly as it was', async () => {
    const dir = tempDir();
    for (const suffix of SUFFIXES) writeFileSync(join(dir, `mydata${suffix}`), 'PRECIOUS\n');
    const bad = writeFile(dir, 'bad.json', 'not json');
    const before = readdirSync(dir).sort();
    const r = await gcr(['import', bad, '--db', join(dir, 'mydata'), '--quiet']);
    assert.notEqual(r.code, 0);
    assert.deepEqual(readdirSync(dir).sort(), before);
    for (const suffix of SUFFIXES) assert.equal(readFileSync(join(dir, `mydata${suffix}`), 'utf8'), 'PRECIOUS\n');
  });

  it('a failed first import with no strays still leaves nothing behind (the take-back works)', async () => {
    const dir = tempDir();
    const bad = writeFile(dir, 'bad.json', 'not json');
    const r = await gcr(['import', bad, '--db', join(dir, 'fresh.sqlite'), '--quiet']);
    assert.notEqual(r.code, 0);
    assert.deepEqual(readdirSync(dir), ['bad.json']);
  });

  it('removeCreated unlinks a path only when it did NOT exist before the command and exists now', () => {
    const dir = tempDir();
    const db = join(dir, 'x.sqlite');
    for (const suffix of ['', ...SUFFIXES]) writeFileSync(db + suffix, `after${suffix}`);
    // The snapshot says: the -wal and the -journal were already there; the database and the -shm were not.
    removeCreated(db, undefined, { '': false, '-wal': true, '-shm': false, '-journal': true });
    assert.equal(existsSync(db), false, 'created by the command: taken back');
    assert.equal(existsSync(`${db}-shm`), false, 'created by the command: taken back');
    assert.equal(readFileSync(`${db}-wal`, 'utf8'), 'after-wal', 'existed before: kept');
    assert.equal(readFileSync(`${db}-journal`, 'utf8'), 'after-journal', 'existed before: kept');
  });

  it('snapshotDatabasePaths uses lstat: a dangling symbolic link counts as existing', () => {
    const dir = tempDir();
    const db = join(dir, 'y.sqlite');
    symlinkSync(join(dir, 'nowhere'), db);
    writeFileSync(`${db}-wal`, 'w');
    assert.deepEqual(snapshotDatabasePaths(db), { '': true, '-wal': true, '-shm': false, '-journal': false });
  });

  it('removeCreated never throws, whatever is (not) there', () => {
    const dir = tempDir();
    assert.doesNotThrow(() => removeCreated(join(dir, 'absent.sqlite'), join(dir, 'also-absent'), { '': false, '-wal': false, '-shm': false, '-journal': false }));
  });
});

describe('ATK-08(a): a SQLite file that is not a GCR database', () => {
  it('list says it is not a GCR database and does not suggest an import', async () => {
    const dir = tempDir();
    const foreign = join(dir, 'foreign.sqlite');
    const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE t (a)');
    db.close();
    const bytes = readFileSync(foreign);

    const r = await gcr(['list', '--db', foreign]);
    assertTextError(r, 'DB_ERROR');
    assert.match(r.stderr, /not a GCR database/i);
    assert.doesNotMatch(r.stderr, /not been initialized/i);
    const remedy = r.stderr.split('\n').find((l) => l.startsWith('  remedy: ')) ?? '';
    assert.doesNotMatch(remedy, /import/i, 'the import refuses this file, so it must not be suggested');
    assert.ok(readFileSync(foreign).equals(bytes), 'the file is unchanged');

    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
    const imp = await gcr(['import', exportPath, '--db', foreign, '--quiet']);
    assertTextError(imp, 'DB_ERROR');
    assert.match(imp.stderr, /not a GCR database/i, 'the import says the same thing');
  });
});

describe('ATK-11: a default ./.gcr database that belongs to somebody else', () => {
  const ME = process.getuid?.() ?? 0;

  it('defaultDatabaseOwnershipWarning: silent for your own files and for a missing database; names neither paths nor owners', () => {
    const dir = tempDir();
    const dbDir = join(dir, '.gcr');
    mkdirSync(dbDir);
    const db = join(dbDir, 'gcr.sqlite');
    assert.equal(defaultDatabaseOwnershipWarning(db, ME), undefined, 'no database yet');
    writeFileSync(db, '');
    assert.equal(defaultDatabaseOwnershipWarning(db, ME), undefined, 'owned by the current user');
    assert.equal(defaultDatabaseOwnershipWarning(db, undefined), undefined, 'no notion of an owner (Windows): nothing to compare');
    const warning = defaultDatabaseOwnershipWarning(db, ME + 1);
    assert.ok(warning !== undefined && /not owned by the current user/.test(warning), String(warning));
    assert.ok(warning.includes('--db') && warning.includes('GCR_DB'), 'it says what to do');
    assert.equal(warning.includes(dir), false, 'no absolute path');
    assert.equal(new RegExp(`\\b${ME + 1}\\b`).test(warning), false, 'no user id');
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(warning));
  });

  it('a foreign DIRECTORY is enough (the database file inside may be new)', () => {
    const dir = tempDir();
    const dbDir = join(dir, '.gcr');
    mkdirSync(dbDir);
    const db = join(dbDir, 'gcr.sqlite');
    writeFileSync(db, '');
    assert.ok(defaultDatabaseOwnershipWarning(db, ME + 1) !== undefined);
  });

  it('end to end: warns on stderr for a database owned by another user (only when the test may chown), never on stdout, not suppressed by --quiet', async (t) => {
    if (process.getuid?.() !== 0) {
      t.skip('needs root to give a file to another user');
      return;
    }
    const dir = tempDir();
    const exportPath = writeFile(dir, 'conversations.json', standardExport().json);
    assertOk(await gcr(['import', exportPath, '--quiet'], { cwd: dir }), 'import into the default location');
    const own = await gcr(['list', '--format', 'json'], { cwd: dir });
    assertOk(own, 'your own default database is silent');

    chownSync(join(dir, '.gcr', 'gcr.sqlite'), 4242, 4242);
    for (const extra of [[], ['--quiet']]) {
      const r = await gcr(['list', '--format', 'json', ...extra], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      envelope(r.stdout); // stdout is still exactly the result
      assert.match(r.stderr, /not owned by the current user/, `with ${extra.join(' ') || 'no extra flags'}`);
      assertClean(r.stderr, 'stderr');
      assert.equal(r.stdout.includes('not owned'), false, 'never on stdout');
    }

    // `gcr mcp` opens the database through the MCP entry point; it is announced all the same, and stdout stays pure protocol
    const mcp = await gcr(['mcp'], { cwd: dir, stdin: '' });
    assert.equal(mcp.code, 0, mcp.stderr);
    assert.equal(mcp.stdout, '', 'no JSON-RPC traffic was requested, and the warning is not on stdout');
    assert.equal((mcp.stderr.match(/not owned by the current user/g) ?? []).length, 1, `exactly once: ${mcp.stderr}`);

    // an explicit choice of database is the operator's own and is not second-guessed
    const explicit = await gcr(['list', '--format', 'json', '--db', join(dir, '.gcr', 'gcr.sqlite')], { cwd: dir });
    assertOk(explicit, '--db');
    const viaEnv = await gcr(['list', '--format', 'json'], { cwd: dir, env: { GCR_DB: join(dir, '.gcr', 'gcr.sqlite') } });
    assertOk(viaEnv, 'GCR_DB');
    assert.equal(statSync(join(dir, '.gcr', 'gcr.sqlite')).uid, 4242);
  });
});
