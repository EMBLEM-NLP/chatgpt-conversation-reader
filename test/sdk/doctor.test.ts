/**
 * `gcr doctor` (src/sdk/doctor.ts): static, offline, honest about the modes, and free of secrets and absolute paths.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { GCR_APPLICATION_ID } from '../../src/db/schema.js';
import { SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from '../../src/version.js';
import { MODE_STATUS, NO_REMOTE_FALLBACK_STATEMENT, inspectDatabase, nodeSatisfies, runDoctor } from '../../src/sdk/doctor.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { ID, chat, fixedClock, importBuilders, makeTempDir, removeDir } from './sdk.helpers.test.js';

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await removeDir(dir);
  }
}

/** The Node floor declared in package.json (e.g. ">=22.16.0"); the doctor must agree with it (a drift would mislead operators). */
async function enginesFloor(): Promise<{ range: string; parts: [number, number, number] }> {
  const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { engines?: { node?: string } };
  const m = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(pkg.engines?.node ?? '');
  assert.ok(m, 'package.json engines.node is a simple ">=major.minor[.patch]" range');
  const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  return { range: `>=${parts[0]}.${parts[1]}`, parts };
}

describe('doctor: prerequisites', () => {
  it('reports the tool, Node, node:sqlite with FTS5 and the supported schema version', async () => {
    const r = runDoctor();
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.tool, { name: TOOL_NAME, version: TOOL_VERSION });
    assert.equal(r.node.version, process.versions.node);
    assert.equal(r.node.requiredRange, (await enginesFloor()).range, 'the doctor states the same Node floor as package.json engines');
    assert.equal(r.node.satisfiesEngines, true);
    assert.equal(r.sqlite.module, 'node:sqlite');
    assert.equal(r.sqlite.available, true);
    assert.equal(r.sqlite.fts5, true);
    assert.match(r.sqlite.version ?? '', /^3\.\d+\.\d+/);
    assert.deepEqual(r.schema, { supportedVersion: SCHEMA_VERSION });
    assert.equal(r.database, null, 'no database path supplied');
  });

  it('nodeSatisfies implements the package.json floor and fails closed on text it cannot read', async () => {
    const { parts } = await enginesFloor();
    const [a, b, c] = parts;
    const v = (x: number, y: number, z: number): string => `${x}.${y}.${z}`;
    const cases: Array<[string, boolean]> = [
      [v(a, b, c), true],
      [`v${v(a, b, c)}`, true],
      [v(a, b, c + 1), true],
      [v(a, b + 1, 0), true],
      [v(a + 1, 0, 0), true],
      [v(a + 2, 5, 5), true],
      [v(a - 1, 99, 99), false],
      [v(a - 2, 0, 0), false],
      ['', false],
      ['garbage', false],
      [`${a}.${b}`, false],
    ];
    if (b > 0) cases.push([v(a, b - 1, 99), false]);
    if (c > 0) cases.push([v(a, b, c - 1), false]);
    for (const [ver, want] of cases) assert.equal(nodeSatisfies(ver), want, ver);
  });

  it('is deterministic on one machine', () => {
    assert.deepEqual(runDoctor(), runDoctor());
  });
});

describe('doctor: modes A-E are stated honestly', () => {
  it('uses the exact status strings and never claims more than exists', () => {
    const r = runDoctor();
    assert.deepEqual(
      r.modes.map((m) => [m.mode, m.status]),
      [
        ['A', 'supported (synthetic-fixture tested; no live export verified)'],
        ['B', 'supported (manual copy, partial)'],
        ['C', 'supported (local drafts/annotations only)'],
        ['D', 'not implemented (interface + disabled adapter only)'],
        ['E', 'gated - no code (docs/BROWSER_GATE.md)'],
      ],
    );
    assert.deepEqual({ ...MODE_STATUS }, Object.fromEntries(r.modes.map((m) => [m.mode, m.status])));
    assert.ok(r.modes.every((m) => m.name.length > 0));
    // nothing but A-C may say "supported"; D and E must not
    assert.deepEqual(r.modes.filter((m) => /^supported/.test(m.status)).map((m) => m.mode), ['A', 'B', 'C']);
  });

  it('says that commands never fall back to remote browser access, and that the report itself used no network', () => {
    const r = runDoctor();
    assert.equal(r.statement, 'Commands never fall back to remote browser access.');
    assert.equal(NO_REMOTE_FALLBACK_STATEMENT, r.statement);
    assert.equal(r.network.used, false);
  });

  it('lists the import adapters that exist: chatgpt and claude; the developer-API adapter (Mode D) is not an export reader', () => {
    const r = runDoctor();
    assert.deepEqual(r.adapters.map((a) => a.id), ['chatgpt', 'claude']);
    assert.ok(!JSON.stringify(r.adapters).includes('openai_api'));
  });
});

describe('doctor: environment knobs and secrets', () => {
  it('reports GCR_DB and GCR_APPROVED_IMPORT_ROOTS as present or absent and NEVER prints their values', () => {
    const saved = { db: process.env['GCR_DB'], roots: process.env['GCR_APPROVED_IMPORT_ROOTS'] };
    try {
      process.env['GCR_DB'] = '/home/secret-person/private/gcr-secret-name.sqlite';
      process.env['GCR_APPROVED_IMPORT_ROOTS'] = '/mnt/top-secret-exports:/other/hidden-root';
      const set = runDoctor();
      assert.deepEqual(set.env, [
        { name: 'GCR_DB', status: 'present' },
        { name: 'GCR_APPROVED_IMPORT_ROOTS', status: 'present' },
      ]);
      const wire = JSON.stringify(set);
      for (const secret of ['secret-person', 'gcr-secret-name', 'top-secret-exports', 'hidden-root', '/mnt', '/home/secret']) assert.ok(!wire.includes(secret), secret);

      delete process.env['GCR_DB'];
      process.env['GCR_APPROVED_IMPORT_ROOTS'] = '';
      assert.deepEqual(runDoctor().env, [
        { name: 'GCR_DB', status: 'absent' },
        { name: 'GCR_APPROVED_IMPORT_ROOTS', status: 'absent' },
      ]);
    } finally {
      if (saved.db === undefined) delete process.env['GCR_DB'];
      else process.env['GCR_DB'] = saved.db;
      if (saved.roots === undefined) delete process.env['GCR_APPROVED_IMPORT_ROOTS'];
      else process.env['GCR_APPROVED_IMPORT_ROOTS'] = saved.roots;
    }
  });

  it('no absolute path of the machine appears in the report, with or without a database path', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'private-folder', 'my-secret-db-name.sqlite');
      await mkdir(join(dir, 'private-folder'));
      const gcr = Gcr.open({ dbPath, clock: fixedClock });
      gcr.close();
      for (const r of [runDoctor(), runDoctor({ dbPath })]) {
        const wire = JSON.stringify(r);
        for (const leak of [dir, process.cwd(), homedir(), process.execPath, 'private-folder']) assert.ok(!wire.includes(leak), `leaked ${leak}`);
      }
      assert.equal(runDoctor({ dbPath }).database?.label, 'my-secret-db-name.sqlite', 'only the basename is shown');
    });
  });
});

describe('doctor: inspecting a database path (read-only)', () => {
  it('a missing file is "missing" (normal before the first import), writable when its directory is, and is NOT created', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'new.sqlite');
      const r = runDoctor({ dbPath });
      assert.deepEqual(r.database, { label: 'new.sqlite', exists: false, writable: true, schemaVersion: null, schemaStatus: 'missing' });
      assert.equal(r.ok, true);
      await assert.rejects(stat(dbPath), { code: 'ENOENT' });
    });
  });

  it('a missing file in a missing directory is "missing" and not writable', async () => {
    await withDir(async (dir) => {
      const r = runDoctor({ dbPath: join(dir, 'no', 'such', 'dir', 'x.sqlite') });
      assert.equal(r.database?.schemaStatus, 'missing');
      assert.equal(r.database?.writable, false);
    });
  });

  it('a healthy GCR database is "ok" with its schema version; the file is not modified', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'gcr.sqlite');
      const gcr = Gcr.open({ dbPath, clock: fixedClock });
      await importBuilders(gcr, dir, [chat(ID.linear, 'doctor', [['q', 'a']])]);
      gcr.close();
      const before = await readFile(dbPath);
      const r = runDoctor({ dbPath });
      assert.deepEqual(r.database, { label: 'gcr.sqlite', exists: true, writable: true, schemaVersion: SCHEMA_VERSION, schemaStatus: 'ok' });
      assert.equal(r.ok, true);
      assert.ok(before.equals(await readFile(dbPath)), 'doctor never writes');
    });
  });

  it('an uninitialized empty file is fine (an import initializes it) and stays empty', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'empty.sqlite');
      await writeFile(dbPath, '');
      const r = runDoctor({ dbPath });
      assert.equal(r.database?.schemaStatus, 'empty_uninitialized');
      assert.equal(r.ok, true);
      assert.equal((await stat(dbPath)).size, 0);
    });
  });

  it('a database from a newer GCR is a problem and is not touched', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'future.sqlite');
      const raw = new DatabaseSync(dbPath);
      raw.exec(`PRAGMA application_id = ${GCR_APPLICATION_ID}`);
      raw.exec('PRAGMA user_version = 99');
      raw.close();
      const before = await readFile(dbPath);
      const r = runDoctor({ dbPath });
      assert.equal(r.database?.schemaStatus, 'newer_than_tool');
      assert.equal(r.database?.schemaVersion, 99);
      assert.equal(r.ok, false);
      assert.ok(r.problems.some((p) => /newer GCR/.test(p)));
      assert.ok(before.equals(await readFile(dbPath)));
    });
  });

  it('an older schema needs migration (not a problem: a read-write open migrates)', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'older.sqlite');
      const raw = new DatabaseSync(dbPath);
      raw.exec(`PRAGMA application_id = ${GCR_APPLICATION_ID}`);
      raw.close();
      // user_version 0 with our application id and no tables is "empty_uninitialized"; a table makes it a foreign file
      assert.equal(runDoctor({ dbPath }).database?.schemaStatus, 'not_a_gcr_database');
    });
  });

  it('a foreign SQLite database, a text file, a directory and invalid paths are reported by status, never thrown', async () => {
    await withDir(async (dir) => {
      const foreign = join(dir, 'foreign.sqlite');
      const raw = new DatabaseSync(foreign);
      raw.exec('CREATE TABLE theirs (x TEXT)');
      raw.close();
      const f = runDoctor({ dbPath: foreign });
      assert.equal(f.database?.schemaStatus, 'not_a_gcr_database');
      assert.equal(f.ok, false);

      const junk = join(dir, 'junk.sqlite');
      await writeFile(junk, 'definitely not a database, just words '.repeat(50));
      const j = runDoctor({ dbPath: junk });
      assert.equal(j.database?.schemaStatus, 'not_a_gcr_database');
      assert.ok(!JSON.stringify(j).includes('definitely'), 'file content is never echoed');

      await mkdir(join(dir, 'adir'));
      assert.equal(runDoctor({ dbPath: join(dir, 'adir') }).database?.schemaStatus, 'not_a_file');

      for (const bad of ['', 'file:evil.sqlite?mode=rwc', 'a\u0000b', 5, null, {}, []]) {
        const r = runDoctor({ dbPath: bad as never });
        assert.equal(r.database?.schemaStatus, 'invalid_path');
        assert.equal(r.database?.label, '(invalid path)');
        assert.equal(r.ok, false);
      }
      assert.equal(runDoctor(null as never).database, null, 'a non-object options value is treated as "no options"');
    });
  });

  it('":memory:" is reported as in-memory', () => {
    const r = runDoctor({ dbPath: ':memory:' });
    assert.equal(r.database?.schemaStatus, 'in_memory');
    assert.equal(r.ok, true);
  });

  it('an unreadable file (no read permission) is "unreadable" (skipped when running as root)', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root can read everything');
      return;
    }
    await withDir(async (dir) => {
      const dbPath = join(dir, 'locked.sqlite');
      const gcr = Gcr.open({ dbPath });
      gcr.close();
      await chmod(dbPath, 0o000);
      assert.equal(runDoctor({ dbPath }).database?.schemaStatus, 'unreadable');
      await chmod(dbPath, 0o600);
    });
  });
});

describe('doctor: a runtime without FTS5', () => {
  it('is reported instead of a schema verdict for databases that would otherwise be usable, and never hides a real database problem', async () => {
    await withDir(async (dir) => {
      const dbPath = join(dir, 'gcr.sqlite');
      Gcr.open({ dbPath }).close();
      assert.equal(inspectDatabase(dbPath, true).schemaStatus, 'ok');
      assert.equal(inspectDatabase(dbPath, false).schemaStatus, 'unsupported_runtime');
      assert.equal(inspectDatabase(join(dir, 'missing.sqlite'), false).schemaStatus, 'unsupported_runtime');
      assert.equal(inspectDatabase(':memory:', false).schemaStatus, 'unsupported_runtime');
      // findings that are about the file itself stay visible
      const junk = join(dir, 'junk.sqlite');
      await writeFile(junk, 'not a database '.repeat(100));
      assert.equal(inspectDatabase(junk, false).schemaStatus, 'not_a_gcr_database');
      assert.equal(inspectDatabase('', false).schemaStatus, 'invalid_path');
    });
  });
});

describe('doctor through the facade', () => {
  it('Gcr.doctor() needs no handle and equals runDoctor()', () => {
    assert.deepEqual(Gcr.doctor(), runDoctor());
    assert.equal(Gcr.doctor({ dbPath: ':memory:' }).database?.schemaStatus, 'in_memory');
  });

  it('gcr.doctor() inspects the open handle\'s database and prints only its basename', async () => {
    await withDir(async (dir) => {
      const gcr = Gcr.open({ dbPath: join(dir, 'handle.sqlite') });
      try {
        const r = gcr.doctor();
        assert.equal(r.database?.label, 'handle.sqlite');
        assert.equal(r.database?.schemaStatus, 'ok');
        assert.ok(!JSON.stringify(r).includes(dir));
      } finally {
        gcr.close();
      }
    });
  });

  it('performs no network access', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = (): never => {
      calls++;
      throw new Error('network is forbidden');
    };
    try {
      runDoctor();
      Gcr.doctor({ dbPath: ':memory:' });
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
    assert.equal(calls, 0);
  });
});
