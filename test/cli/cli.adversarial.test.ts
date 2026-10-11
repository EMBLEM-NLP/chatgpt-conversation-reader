/**
 * Adversarial review of the command-line interface. Lens: argument confusion, the output contract (stdout/stderr, exit
 * codes), file-writing safety, leaks, broken pipes and signals, bounded input, and the absence of any network path.
 *
 * Every test in the first five groups demonstrated a real defect before its fix; the last two groups pin behaviour that was
 * verified correct but is easy to break (bounded standard input, atomic interrupted imports).
 */
import '../../src/suppress-warnings.js'; // first: the SDK is imported dynamically below, after the filter is in place
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { COMMANDS } from '../../src/cli/commands/index.js';
import { Lifecycle } from '../../src/cli/context.js';
import { createBufferOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import { writeExportFile } from '../../src/cli/export-file.js';
import { checkPositionals, effectiveOptions, parseCommandArgs } from '../../src/cli/parse.js';
import { resolveRoute } from '../../src/cli/route.js';
import { EXIT_CODES, GcrError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';
import { buildZip } from '../helpers/zip-builder.js';
import { linearConversationText, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { CLI_MAIN, REPO_ROOT, assertJsonError, assertOk, assertTextError, collect, copyDb, envelope, gcr, spawnCli, tempDir, templateDb, writeFile } from './cli.helpers.test.js';
import type { RunResult } from './cli.helpers.test.js';

const SIBLINGS = ['', '-wal', '-shm', '-journal'];
const leftovers = (db: string): string[] => SIBLINGS.map((s) => db + s).filter((p) => existsSync(p));
const octal = (n: number): string => (n & 0o777).toString(8).padStart(4, '0');

async function total(dbPath: string): Promise<number> {
  const r = await gcr(['list', '--db', dbPath, '--format', 'json']);
  assertOk(r, 'list');
  return Number((envelope(r.stdout).data as { total: unknown }).total);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. A failed command must not change the world
// ---------------------------------------------------------------------------------------------------------------

describe('a failed import leaves no empty database and no ./.gcr behind', () => {
  it('default location: nothing is created (not even the note about creating it), and the next read still says "run: gcr import"', async () => {
    for (const json of [false, true]) {
      const cwd = tempDir();
      mkdirSync(join(cwd, 'no-export-here'));
      const r = await gcr(['import', 'no-export-here', ...(json ? ['--format', 'json'] : [])], { cwd });
      if (json) assertJsonError(r, 'IMPORT_UNSUPPORTED_FORMAT');
      else assertTextError(r, 'IMPORT_UNSUPPORTED_FORMAT');
      assert.equal(r.stderr.includes('note:'), false, 'no note about a directory that is not kept');
      assert.equal(existsSync(join(cwd, '.gcr')), false, 'the default directory was not left behind');
      assertTextError(await gcr(['list'], { cwd }), 'DB_NOT_FOUND', { remedy: /gcr import <export\.zip>/ });
    }
  });

  it('explicit --db: every kind of import failure, usage errors included, leaves no file (also no -wal/-shm)', async () => {
    const cwd = tempDir();
    const std = (await templateDb()).std.json;
    const good = writeFile(cwd, 'good/conversations.json', std);
    const notes = writeFile(cwd, 'notes.txt', 'just some words');
    const truncated = writeFile(cwd, 'truncated/conversations.json', std.slice(0, Math.floor(std.length / 2)));
    mkdirSync(join(cwd, 'empty-dir'));
    const evil = writeFile(cwd, 'evil.zip', buildZip([{ name: '../escape/conversations.json', data: '[]' }]));
    const badCopy = writeFile(cwd, 'bad-copy.json', '{not json');
    const badUuid = writeFile(cwd, 'bad-uuid.json', JSON.stringify({ conversationId: 'nope', messages: [{ role: 'user', text: 'x' }] }));
    const cases: Array<{ name: string; args: string[]; code: ErrorCode; stdin?: string }> = [
      { name: 'not an export', args: ['import', notes], code: 'IMPORT_UNSUPPORTED_FORMAT' },
      { name: 'a folder without conversations', args: ['import', join(cwd, 'empty-dir')], code: 'IMPORT_UNSUPPORTED_FORMAT' },
      { name: '--strict on a truncated export', args: ['import', truncated, '--strict'], code: 'IMPORT_PARSE_ERROR' },
      { name: 'a limit the input exceeds', args: ['import', good, '--max-element-bytes', '50'], code: 'IMPORT_LIMIT_EXCEEDED' },
      { name: 'an unsafe ZIP', args: ['import', evil], code: 'IMPORT_ZIP_UNSAFE' },
      { name: 'a bad --account (usage error)', args: ['import', good, '--account', '../x'], code: 'INVALID_ARGUMENT' },
      { name: 'standard input that is not JSON', args: ['import', '-'], code: 'IMPORT_UNSUPPORTED_FORMAT', stdin: 'hello, this is not JSON' },
      { name: 'a manual copy that is not JSON', args: ['import-copy', badCopy], code: 'IMPORT_PARSE_ERROR' },
      { name: 'a manual copy with a bad id', args: ['import-copy', badUuid], code: 'INVALID_UUID' },
    ];
    let n = 0;
    for (const c of cases) {
      const db = join(cwd, `case-${n++}.sqlite`);
      for (const json of [false, true]) {
        const r = await gcr([...c.args, '--db', db, ...(json ? ['--format', 'json'] : [])], { cwd, ...(c.stdin === undefined ? {} : { stdin: c.stdin }) });
        if (json) assertJsonError(r, c.code);
        else assertTextError(r, c.code);
        assert.deepEqual(leftovers(db), [], `${c.name} (${json ? 'json' : 'text'}) left files behind`);
      }
    }
  });

  it('a database that existed before is never removed: its data survives a failed import', async () => {
    const { dbPath, dir } = await copyDb();
    const before = await total(dbPath);
    assert.ok(before > 0);
    const notes = writeFile(dir, 'notes.txt', 'words');
    assertTextError(await gcr(['import', notes, '--db', dbPath]), 'IMPORT_UNSUPPORTED_FORMAT');
    assertTextError(await gcr(['import', notes, '--account', '../x', '--db', dbPath]), 'INVALID_ARGUMENT');
    assert.equal(existsSync(dbPath), true);
    assert.equal(await total(dbPath), before);
  });

  it('a successful import still creates the database and says so (the note is only dropped when nothing is kept)', async () => {
    const cwd = tempDir();
    const good = writeFile(cwd, 'conversations.json', (await templateDb()).std.json);
    const first = await gcr(['import', good, '--format', 'json'], { cwd });
    assert.equal(first.code, 0, first.stderr);
    envelope(first.stdout);
    assert.equal(first.stderr, 'note: created ./.gcr (mode 0700) for the default database\n');
    assert.equal(octal(statSync(join(cwd, '.gcr')).mode), '0700');
    assert.ok((await total(join(cwd, '.gcr', 'gcr.sqlite'))) > 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Command words and flag-looking values
// ---------------------------------------------------------------------------------------------------------------

describe('routing: words that look like flags or like the command', () => {
  it('"gcr help help" is the root help, not an unknown command that suggests itself', async () => {
    const root = await gcr(['--help']);
    assertOk(root);
    const viaHelp = await gcr(['help', 'help']);
    assertOk(viaHelp);
    assert.equal(viaHelp.stdout, root.stdout);
  });

  it('a flag after a value option is reported as a missing value, never taken for the command or for the value', async () => {
    const cwd = tempDir();
    const lines: Array<[string[], RegExp]> = [
      [['--format', '--db', 'x.sqlite', 'list'], /Option \\?"--format\\?" needs a value/],
      [['--db', '--format', 'json', 'list'], /Option \\?"--db\\?" needs a value/], // the JSON error form escapes the quotes
      [['--tz', '--quiet', 'list'], /Option \\?"--tz\\?" needs a value/],
    ];
    for (const [args, message] of lines) {
      const r = await gcr(args, { cwd });
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, message, `${args.join(' ')}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /Unknown command/);
      assert.equal(existsSync(join(cwd, '.gcr')), false);
    }
  });

  it('a value that really starts with a dash still works in the "=" form before the command', async () => {
    const { dbPath, dir } = await copyDb();
    const odd = join(dir, '-odd.sqlite');
    writeFileSync(odd, readFileSync(dbPath));
    const r = await gcr(['--db=-odd.sqlite', 'list', '--format', 'json'], { cwd: dir });
    assertOk(r);
    assert.ok(Number((envelope(r.stdout).data as { total: unknown }).total) > 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Writing the graph export: every failure is classified by what it is
// ---------------------------------------------------------------------------------------------------------------

async function builtDb(): Promise<{ dbPath: string; dir: string }> {
  const { dbPath, dir } = await copyDb();
  assertOk(await gcr(['graph', 'build', '--min-conversations', '1', '--format', 'json', '--db', dbPath]));
  return { dbPath, dir };
}

describe('graph export: file names and file-system failures', () => {
  it('a file name longer than the file system allows is a usage error (INVALID_ARGUMENT), not an internal error', async () => {
    const { dbPath, dir } = await builtDb();
    const out = join(dir, `${'a'.repeat(300)}.html`);
    const text = await gcr(['graph', 'export', '--out', out, '--db', dbPath]);
    assertTextError(text, 'INVALID_ARGUMENT');
    assert.ok(text.stderr.length < 1500, 'the over-long name is not echoed in full');
    assert.equal(text.stderr.includes(dir), false, 'no absolute path');
    assertJsonError(await gcr(['graph', 'export', '--out', out, '--db', dbPath, '--format', 'json']), 'INVALID_ARGUMENT');
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('aaaa')), []);
  });

  it('--force replaces a file whose name is near the limit (the temporary file name must not depend on the target name)', async (t) => {
    const { dbPath, dir } = await builtDb();
    const out = join(dir, `${'b'.repeat(245)}.html`);
    const first = await gcr(['graph', 'export', '--out', out, '--db', dbPath, '--format', 'json']);
    if (first.code !== 0) {
      t.skip('this file system does not allow 250-character names');
      return;
    }
    writeFileSync(out, 'OLD', { mode: 0o644 });
    const again = await gcr(['graph', 'export', '--out', out, '--force', '--db', dbPath, '--format', 'json']);
    assertOk(again);
    assert.match(readFileSync(out, 'utf8'), /^<!doctype html>/i);
    assert.equal(octal(statSync(out).mode), '0600');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  });

  // The environment may run the tests as root (permissions are then not enforced), so the operating-system errors are injected
  // at the single seam the module uses: the `node:fs/promises` functions. The live ESM bindings follow the patched exports.
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, unknown>;
  type OpenFn = (...args: unknown[]) => Promise<{ writeFile: (...a: unknown[]) => Promise<void> } & Record<string, unknown>>;
  async function withOpen<T>(replacement: (original: OpenFn) => OpenFn, fn: () => Promise<T>): Promise<T> {
    const original = fsp['open'] as OpenFn;
    fsp['open'] = replacement(original);
    syncBuiltinESMExports();
    try {
      return await fn();
    } finally {
      fsp['open'] = original;
      syncBuiltinESMExports();
    }
  }
  const failing = (code: string): ((original: OpenFn) => OpenFn) => () => () => Promise.reject(Object.assign(new Error(`${code}: synthetic`), { code }));

  it('permission and read-only failures are WRITE_FORBIDDEN (exit 6), with the file name only', async () => {
    const dir = tempDir();
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      for (const force of [false, true]) {
        const out = join(dir, `${force ? 'replace' : 'new'}-${code}.html`);
        if (force) writeFileSync(out, 'OLD');
        const err = await withOpen(failing(code), () => writeExportFile(out, '<html></html>', force).then(() => undefined, (e: unknown) => e));
        assert.ok(err instanceof GcrError, `${code}/${String(force)}: ${String(err)}`);
        assert.equal(err.code, 'WRITE_FORBIDDEN', `${code}/${String(force)}`);
        assert.equal(EXIT_CODES[err.code], 6);
        assert.ok((err.remedy ?? '').length > 0);
        assert.equal(err.message.includes(dir), false, 'no absolute path in the message');
        if (force) assert.equal(readFileSync(out, 'utf8'), 'OLD', 'the existing file is untouched');
      }
    }
  });

  it('a name the file system rejects is INVALID_ARGUMENT; anything else (a full disk) stays INTERNAL_ERROR and leaves no half-written file', async () => {
    const dir = tempDir();
    for (const code of ['ENAMETOOLONG', 'EINVAL']) {
      const err = await withOpen(failing(code), () => writeExportFile(join(dir, `n-${code}.html`), 'x', false).then(() => undefined, (e: unknown) => e));
      assert.ok(err instanceof GcrError);
      assert.equal(err.code, 'INVALID_ARGUMENT', code);
    }
    // The file is created, then the write fails halfway: the private partial file must be removed.
    const out = join(dir, 'half.html');
    const err = await withOpen(
      (original) => async (...args) => {
        const handle = await original(...args);
        handle.writeFile = (): Promise<void> => Promise.reject(Object.assign(new Error('ENOSPC: synthetic'), { code: 'ENOSPC' }));
        return handle;
      },
      () => writeExportFile(out, 'x'.repeat(100), false).then(() => undefined, (e: unknown) => e),
    );
    assert.ok(err instanceof GcrError);
    assert.equal(err.code, 'INTERNAL_ERROR');
    assert.equal(existsSync(out), false, 'no half-written file is left behind');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3b. Reading from a location that cannot be written
// ---------------------------------------------------------------------------------------------------------------

describe('reading a database that sits in a read-only location', () => {
  it('is a DB_ERROR (exit 5) with an accurate remedy, never "write forbidden" for a command that only reads', async () => {
    // A database in WAL mode needs -wal/-shm files beside it even for reading; in a read-only directory the SDK's read-only
    // open then fails with WRITE_FORBIDDEN. That is injected here at the one seam (Gcr.open) because the tests may run as root.
    const { Gcr } = await import('../../src/sdk/gcr.js');
    const { dbPath } = await templateDb();
    const original = Gcr.open.bind(Gcr);
    mock.method(Gcr, 'open', (opts: Parameters<typeof Gcr.open>[0]) => {
      if (opts.readOnly === true) {
        throw new GcrError('WRITE_FORBIDDEN', 'The database is read-only.', { remedy: 'Open the database in read-write mode to import or write local data.' });
      }
      return original(opts);
    });
    try {
      for (const json of [false, true]) {
        const out = createBufferOutput();
        const code = await runCli({ argv: ['list', '--db', dbPath, ...(json ? ['--format', 'json'] : [])], env: {}, cwd: tempDir(), out, stdin: { isTTY: false, async *[Symbol.asyncIterator]() {} }, lifecycle: new Lifecycle() });
        const err = out.err.join('');
        assert.equal(code, EXIT_CODES.DB_ERROR, err);
        assert.equal(out.out.join(''), '');
        assert.match(err, /DB_ERROR/);
        assert.doesNotMatch(err, /WRITE_FORBIDDEN|read-write mode/);
        assert.match(err, /-wal/, 'says what SQLite needs');
        assert.match(err, /copy/i, 'and what to do');
        assert.equal(err.includes(dbPath), false, 'no absolute path');
      }
      // A command that really writes keeps the honest answer.
      const out = createBufferOutput();
      const writable = await copyDb();
      mock.method(Gcr, 'open', () => {
        throw new GcrError('WRITE_FORBIDDEN', 'The database is read-only.', { remedy: 'Open the database in read-write mode to import or write local data.' });
      });
      const code = await runCli({ argv: ['graph', 'build', '--db', writable.dbPath], env: {}, cwd: tempDir(), out, stdin: { isTTY: false, async *[Symbol.asyncIterator]() {} }, lifecycle: new Lifecycle() });
      assert.equal(code, EXIT_CODES.WRITE_FORBIDDEN);
    } finally {
      mock.restoreAll();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. stdout failures
// ---------------------------------------------------------------------------------------------------------------

describe('standard output that cannot be written', () => {
  it('a full disk is named for what it is (exit 1, no "report this bug"), in text and JSON', { skip: existsSync('/dev/full') ? false : 'no /dev/full' }, async () => {
    const { dbPath } = await templateDb();
    for (const json of [false, true]) {
      const fd = openSync('/dev/full', 'w');
      try {
        const child = spawn(process.execPath, [CLI_MAIN, 'list', '--db', dbPath, ...(json ? ['--format', 'json'] : [])], { stdio: ['ignore', fd, 'pipe'], env: { PATH: process.env['PATH'] ?? '' } });
        const r: RunResult = await collect(child);
        assert.equal(r.code, EXIT_CODES.INTERNAL_ERROR);
        assert.match(r.stderr, /standard output/i, r.stderr);
        assert.doesNotMatch(r.stderr, /unexpected internal error|report the issue/i);
        if (json) assert.equal((JSON.parse(r.stderr) as { error: { code: string } }).error.code, 'INTERNAL_ERROR');
        else assert.match(r.stderr, /^error\[INTERNAL_ERROR\]: /);
        assert.equal(r.stderr.includes(dbPath), false);
      } finally {
        closeSync(fd);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Bounded input from standard input (verified correct: pinned)
// ---------------------------------------------------------------------------------------------------------------

describe('standard input is bounded wherever it is read', () => {
  it('drafts and annotations stop at 256 KiB, manual copies at 64 MiB, imports at the buffering limit', async () => {
    const { dbPath } = await copyDb();
    const id = syntheticUuid(2);
    const big = Buffer.alloc(300 * 1024, 0x61);
    assertTextError(await gcr(['draft', 'create', '--conversation', id, '--input', '-', '--db', dbPath], { stdin: big }), 'INVALID_ARGUMENT');
    assertTextError(await gcr(['annotate', 'create', '--conversation', id, '--input', '-', '--db', dbPath], { stdin: big }), 'INVALID_ARGUMENT');
    const copyDbPath = join(tempDir(), 'c.sqlite');
    assertTextError(await gcr(['import-copy', '-', '--db', copyDbPath], { stdin: Buffer.alloc(65 * 1024 * 1024, 0x20), timeoutMs: 120_000 }), 'IMPORT_LIMIT_EXCEEDED');
    assert.deepEqual(leftovers(copyDbPath), [], 'a rejected manual copy creates no database');
    const importDb = join(tempDir(), 'i.sqlite');
    assertTextError(await gcr(['import', '-', '--max-element-bytes', '1000', '--db', importDb], { stdin: Buffer.alloc(100 * 1024, 0x20) }), 'IMPORT_LIMIT_EXCEEDED');
    assert.deepEqual(leftovers(importDb), []);
  });

  it('a draft from standard input that is not valid UTF-8 is refused, never stored with replacement characters', async () => {
    const { dbPath } = await copyDb();
    const r = await gcr(['draft', 'create', '--conversation', syntheticUuid(2), '--input', '-', '--db', dbPath], { stdin: Buffer.from([0x68, 0xff, 0xfe, 0x69]) });
    assertTextError(r, 'INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. An interrupted import is all or nothing (verified correct: pinned)
// ---------------------------------------------------------------------------------------------------------------

describe('SIGINT in the middle of an import', () => {
  it('never leaves half a batch: the database holds all the conversations or none', { timeout: 120_000 }, async () => {
    const dir = tempDir();
    const n = 1500;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(linearConversationText(40, { id: syntheticUuid(0x1000 + i) }));
    const exportPath = writeFile(dir, 'conversations.json', `[${parts.join(',')}]`);
    const db = join(dir, 'interrupted.sqlite');
    const child = spawnCli(['import', exportPath, '--db', db, '--format', 'json']);
    setTimeout(() => child.kill('SIGINT'), 600);
    const r = await collect(child, { timeoutMs: 110_000 });
    assert.ok(r.code === 130 || r.code === 0, `exit ${String(r.code)}; stderr: ${r.stderr}`);
    if (r.code === 130) {
      assert.equal(r.stdout, '', 'an interrupted import prints no report');
      assert.equal(r.stderr, '', 'and no error');
    }
    const count = await total(db);
    assert.ok(count === 0 || count === n, `half a batch was committed: ${String(count)} of ${String(n)}`);
    if (r.code === 130) assert.equal(count, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7. The documentation can be followed
// ---------------------------------------------------------------------------------------------------------------

/** Split a documented command line the way a shell would for these simple cases (quotes group words). */
function words(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === ' ') {
      if (current !== '' || started) out.push(current);
      current = '';
      started = false;
    } else current += ch;
  }
  if (current !== '' || started) out.push(current);
  return out;
}

describe('the documentation can be followed', () => {
  it('every example in every --help parses against the very command it documents', () => {
    let checked = 0;
    for (const spec of COMMANDS) {
      for (const example of spec.examples) {
        const route = resolveRoute(words(example.command.split(' < ')[0] ?? ''));
        assert.equal(route.kind, 'run', example.command);
        if (route.kind !== 'run') continue;
        assert.equal(route.spec, spec, `"${example.command}" routes to another command`);
        const line = `gcr ${spec.path.join(' ')}`;
        const parsed = parseCommandArgs(route.rest, effectiveOptions(spec), line);
        checkPositionals(parsed.positionals, spec.positionals, line);
        checked++;
      }
    }
    assert.ok(checked >= 2 * COMMANDS.length, `${String(checked)} examples checked`);
  });

  const haveBashAndJq = spawnSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }).status === 0;
  it('the exit-code recipe of docs/CLI_REFERENCE.md really branches on the exit code (3 and 5)', { skip: haveBashAndJq ? false : 'needs bash and jq' }, async () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'CLI_REFERENCE.md'), 'utf8');
    const start = doc.indexOf('# React to the stable exit codes');
    assert.ok(start >= 0, 'the recipe exists');
    const end = doc.indexOf('\nfi\n', start);
    assert.ok(end > start, 'the recipe ends with fi');
    const snippet = doc.slice(start, end + 4);
    const { dbPath } = await templateDb();
    const work = tempDir();
    const follow = (db: string, ref: string): Promise<RunResult> =>
      collect(
        spawn('bash', ['-c', `gcr() { "$GCR_NODE" "$GCR_CLI" "$@"; }\nREF=${ref}\n${snippet}`], {
          cwd: work,
          env: { PATH: process.env['PATH'] ?? '', GCR_NODE: process.execPath, GCR_CLI: CLI_MAIN, GCR_DB: db },
        }),
      );
    const absent = await follow(dbPath, syntheticUuid(0xff));
    assert.equal(absent.code, 0, absent.stderr);
    assert.match(absent.stdout, /^NOT_IN_LOCAL_EXPORT: /, 'exit code 3 selects the first branch');
    const noDb = await follow(join(work, 'missing.sqlite'), syntheticUuid(1));
    assert.match(noDb.stderr, /^database problem: DB_NOT_FOUND\n/, 'exit code 5 selects the second branch');
  });
});
