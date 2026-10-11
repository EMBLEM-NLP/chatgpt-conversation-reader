/**
 * Process-level behaviour of the real executable: broken pipes, signals, the warning filter, debug output, unexpected
 * exceptions, terminal safety, the stdio server smoke test, and a source-level scan of src/cli.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLI_MAIN, FORMATS, HOSTILE, ID, REPO_ROOT, assertClean, assertJsonError, assertOk, assertTextError, collect, copyDb, envelope, gcr, parseJson, spawnCli, tempDir, templateDb, writeFile } from './cli.helpers.test.js';
import type { RunResult } from './cli.helpers.test.js';

let dbPath = '';
before(async () => {
  ({ dbPath } = await templateDb());
});

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const bareEnv = { PATH: process.env['PATH'] ?? '' };

describe('broken pipes', () => {
  it('a reader that goes away is not an error: exit 0, nothing on stderr', async () => {
    const child = spawnCli(['list', '--db', dbPath, '--format', 'json']);
    child.stdout?.destroy(); // `gcr list | head -0`: the reader is gone before the first byte
    const r = await collect(child);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  it('also in a real shell pipeline (gcr ... | head -c 1)', { skip: existsSync('/bin/bash') || existsSync('/usr/bin/bash') ? false : 'no bash' }, () => {
    const out = execFileSync('bash', ['-c', `"${process.execPath}" "${CLI_MAIN}" list --db "${dbPath}" --format jsonl | head -c 1 >/dev/null; echo "status=\${PIPESTATUS[0]}"`], { encoding: 'utf8', env: bareEnv });
    assert.equal(out.trim(), 'status=0');
  });
});

describe('signals', () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    it(`${signal} while a command is waiting: the database is closed and the exit code is ${code}`, async () => {
      const dir = tempDir();
      const db = join(dir, 'signal.sqlite');
      const child = spawnCli(['import', '-', '--db', db], { stdin: '' }); // stdin stays open: the import waits for it
      const done = collect(child);
      await waitFor(() => existsSync(db), 'the database to be created');
      await new Promise((r) => setTimeout(r, 300)); // the handlers are installed long before the database exists; this is slack
      child.kill(signal);
      const r = await done;
      assert.equal(r.code, code, `stderr: ${r.stderr}`);
      assert.equal(r.signal, null, 'the CLI exits by itself; the default signal action did not kill it');
      assert.equal(r.stdout, '');
      // The database is intact and usable afterwards: nothing half-written, no stale lock.
      const doctor = await gcr(['doctor', '--db', db, '--format', 'json']);
      assertOk(doctor);
      assert.equal((envelope(doctor.stdout).data as { ok: boolean }).ok, true);
      assertOk(await gcr(['list', '--db', db, '--format', 'json']));
    });
  }
});

describe('the node:sqlite ExperimentalWarning', () => {
  it('control: Node itself prints it when the filter is not installed', async () => {
    const dir = tempDir();
    const script = writeFile(dir, 'plain.mjs', "import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(':memory:').close();\n");
    const r = await collect(spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: bareEnv }));
    assert.match(r.stderr, /ExperimentalWarning: SQLite is an experimental feature/);
  });

  it('the CLI filters it: a command that loads SQLite prints nothing on stderr', async () => {
    for (const args of [['doctor', '--db', dbPath], ['list', '--db', dbPath], ['stats', '--db', dbPath]]) {
      const r = await gcr(args);
      assertOk(r);
      assert.equal(r.stderr.includes('ExperimentalWarning'), false);
    }
  });

  it('only that warning is dropped: other warnings, including other ExperimentalWarnings, still reach stderr', async () => {
    const dir = tempDir();
    const preload = writeFile(
      dir,
      'preload.cjs',
      [
        'setTimeout(() => {',
        "  process.emitWarning('custom thing happened', 'CustomWarning');",
        "  process.emitWarning('Other feature is an experimental feature and might change at any time', 'ExperimentalWarning');",
        "  process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');",
        "  process.emitWarning('SQLite is an experimental feature and might change at any time', { type: 'ExperimentalWarning' });",
        "  process.emitWarning('old api', 'DeprecationWarning', 'DEP0999');",
        '}, 600);',
      ].join('\n'),
    );
    const child = spawnCli(['import', '-', '--db', join(dir, 'w.sqlite')], { stdin: '', env: { NODE_OPTIONS: `--require ${preload}` } });
    const done = collect(child);
    await new Promise((r) => setTimeout(r, 1500)); // after the preload's timer fired
    child.stdin?.end();
    const r = await done;
    assert.match(r.stderr, /CustomWarning: custom thing happened/);
    assert.match(r.stderr, /ExperimentalWarning: Other feature is an experimental feature/);
    assert.match(r.stderr, /DeprecationWarning: old api/);
    assert.equal(/SQLite is an experimental feature/.test(r.stderr), false, 'the sqlite notice is filtered in every call shape');
  });

  it('src/suppress-warnings installs on import, idempotently, and leaves other warnings alone', async () => {
    const dir = tempDir();
    const modulePath = fileURLToPath(new URL('../../src/suppress-warnings.js', import.meta.url));
    const script = writeFile(
      dir,
      'check.mjs',
      [
        `import { installSqliteWarningFilter } from ${JSON.stringify(modulePath)};`,
        'const installed = process.emitWarning;',
        'process.stdout.write(JSON.stringify({ again: installSqliteWarningFilter(), same: process.emitWarning === installed }));',
        "process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');",
        "process.emitWarning('kept warning', 'CustomWarning');",
      ].join('\n'),
    );
    const r = await collect(spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: bareEnv }));
    assert.deepEqual(JSON.parse(r.stdout), { again: false, same: true });
    assert.match(r.stderr, /CustomWarning: kept warning/);
    assert.equal(r.stderr.includes('SQLite'), false);
  });
});

describe('--debug and unexpected failures', () => {
  it('stack traces appear only with --debug (or GCR_DEBUG=1)', async () => {
    const dir = tempDir();
    const missing = join(dir, 'missing.sqlite');
    const plain = await gcr(['list', '--db', missing]);
    assertTextError(plain, 'DB_NOT_FOUND');
    assert.equal(/\n\s+at /.test(plain.stderr), false, 'no stack without --debug');
    assert.equal(plain.stderr.includes('debug:'), false);

    for (const run of [await gcr(['list', '--db', missing, '--debug']), await gcr(['list', '--db', missing], { env: { GCR_DEBUG: '1' } })]) {
      assert.equal(run.code, 5);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^error\[DB_NOT_FOUND\]: /);
      assert.match(run.stderr, /\n  debug:\n/);
      assert.match(run.stderr, /\n    .*GcrError/);
      assert.match(run.stderr, /\n\s+at /);
    }

    const jsonPlain = assertJsonError(await gcr(['list', '--db', missing, '--format', 'json']), 'DB_NOT_FOUND');
    assert.equal(jsonPlain.error.details?.['stack'], undefined);
    const jsonDebug = assertJsonError(await gcr(['list', '--db', missing, '--format', 'json', '--debug']), 'DB_NOT_FOUND');
    assert.equal(typeof jsonDebug.error.details?.['stack'], 'string', 'in JSON mode the stack travels inside the one document');
  });

  const SECRET = 'SECRET-PATH /home/someone/private.txt exploded';
  const thrower = (kind: 'throw' | 'reject'): string =>
    ['setTimeout(() => {', kind === 'throw' ? `  throw new Error(${JSON.stringify(SECRET)});` : `  Promise.reject(new Error(${JSON.stringify(SECRET)}));`, '}, 700);'].join('\n');

  for (const kind of ['throw', 'reject'] as const) {
    it(`an unexpected exception (${kind}) is INTERNAL_ERROR, exit 1, with a generic message that leaks nothing`, async () => {
      const dir = tempDir();
      const env = { NODE_OPTIONS: `--require ${writeFile(dir, 'preload.cjs', thrower(kind))}` };
      // stdin stays open, so the import is still waiting when the preload's timer fires.
      const failing = async (extra: string[]): Promise<RunResult> =>
        collect(spawnCli(['import', '-', '--db', join(dir, `${kind}-${extra.join('')}.sqlite`), ...extra], { stdin: '', env }), { timeoutMs: 30_000 });

      const text = await failing([]);
      assertTextError(text, 'INTERNAL_ERROR', { remedy: /GCR_DEBUG=1/ });
      assert.match(text.stderr, /^error\[INTERNAL_ERROR\]: An unexpected internal error occurred\.\n/);
      assert.equal(text.stderr.includes('SECRET-PATH'), false);
      assert.equal(text.stderr.includes('/home/someone'), false);
      assert.equal(/\n\s+at /.test(text.stderr), false);

      const json = assertJsonError(await failing(['--format', 'json']), 'INTERNAL_ERROR');
      assert.equal(JSON.stringify(json).includes('SECRET-PATH'), false);

      const debug = await failing(['--debug']);
      assert.equal(debug.code, 1);
      assert.equal(debug.stdout, '');
      assert.match(debug.stderr, /SECRET-PATH/, 'with --debug the stack (which names the error) is printed');
      assert.match(debug.stderr, /\n\s+at /);
    });
  }
});

describe('--quiet and terminal safety', () => {
  it('--quiet silences notes, never errors', async () => {
    const dir = tempDir();
    const r = await gcr(['list', '--db', join(dir, 'missing.sqlite'), '--quiet']);
    assertTextError(r, 'DB_NOT_FOUND');
  });

  it('colour switches in the environment change nothing: there is no ANSI anywhere', async () => {
    const env = { FORCE_COLOR: '3', CLICOLOR_FORCE: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const args of [['--help'], ['list', '--help'], ['list', '--db', dbPath], ['get', ID.linear, '--db', dbPath], ['get', ID.absent, '--db', dbPath], ['bogus']]) {
      const r = await gcr(args, { env });
      assertClean(r.stdout, `stdout of ${args.join(' ')}`);
      assertClean(r.stderr, `stderr of ${args.join(' ')}`);
    }
  });

  it('hostile conversation text (ANSI, C1, bidi, TAG characters, fake headings) never reaches a terminal raw, in any command or format', async () => {
    const commands: string[][] = [
      ['list'], ['get', ID.hostile], ['thread', ID.hostile], ['branches', ID.hostile], ['search', 'cleared'], ['search', 'ALERT', '--scope', 'titles'],
      ['search', 'cleared', '--scope', 'all'], ['stats', '--group-by', 'conversation'], ['audit'], ['batches'], ['get', ID.hostile, '--all-branches'],
    ];
    for (const args of commands) {
      for (const format of FORMATS) {
        const r = await gcr([...args, '--db', dbPath, '--format', format], { env: { FORCE_COLOR: '1' } });
        assertOk(r, `gcr ${args.join(' ')} --format ${format}`);
      }
    }
    // The text is still there, as visible escapes (not silently dropped).
    const md = await gcr(['get', ID.hostile, '--db', dbPath]);
    assert.ok(md.stdout.includes('cleared screen'));
    assert.match(md.stdout, /\\u001B/i, 'ESC is shown as a visible escape');
    const json = await gcr(['get', ID.hostile, '--db', dbPath, '--format', 'json']);
    const messages = (envelope(json.stdout).data['messages'] as Array<{ text: string }>).map((m) => m.text);
    assert.ok(messages[0]?.includes(HOSTILE.esc), 'JSON is lossless: parsing it gives the original characters back');
    assert.equal(json.stdout.includes(HOSTILE.esc), false, 'but its bytes contain only escapes');
  });

  it('graph commands over hostile labels are clean too', async () => {
    const { dbPath: db, dir } = await copyDb();
    assertOk(await gcr(['graph', 'build', '--min-conversations', '1', '--format', 'compact', '--db', db]));
    for (const format of FORMATS) {
      assertOk(await gcr(['graph', 'god-nodes', '--limit', '50', '--format', format, '--db', db]));
      assertOk(await gcr(['graph', 'query', 'cleared', '--format', format, '--db', db]));
    }
    const out = join(dir, 'hostile.html');
    assertOk(await gcr(['graph', 'export', '--out', out, '--format', 'compact', '--db', db]));
    const html = readFileSync(out, 'utf8');
    assert.equal(html.includes(HOSTILE.esc), false);
    assert.equal(html.includes('<script>alert(1)</script>'), false, 'imported markup is escaped in the page');
  });
});

describe('gcr mcp (smoke; the protocol itself is tested by the MCP module)', () => {
  const entry = fileURLToPath(new URL('../../src/mcp/entry.js', import.meta.url));
  const skip = existsSync(entry) ? false : 'src/mcp/entry.js is not part of this build';

  it('starts and exits cleanly when stdin closes; stdout stays empty and stderr quiet', { skip }, async () => {
    const r = await gcr(['mcp', '--db', dbPath], { stdin: '' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  it('writes nothing but JSON-RPC to stdout while it runs', { skip }, async () => {
    for (const flags of [[], ['--allow-local-writes']]) {
      const child = spawnCli(['mcp', '--db', dbPath, ...flags], { stdin: '' });
      const done = collect(child);
      let seen = '';
      child.stdout?.on('data', (b: Buffer) => {
        seen += b.toString('utf8');
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli-smoke', version: '0' } } })}\n`);
      await waitFor(() => seen.includes('\n'), 'the initialize response');
      child.stdin?.end();
      const r = await done;
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.trimEnd().split('\n');
      assert.ok(lines.length >= 1);
      for (const line of lines) {
        const frame = parseJson(line);
        assert.equal(frame['jsonrpc'], '2.0', `every stdout line is a JSON-RPC frame, got: ${line.slice(0, 80)}`);
      }
      const first = parseJson(lines[0] ?? '{}') as { result?: { serverInfo?: { name?: string } } };
      assert.equal(first.result?.serverInfo?.name, 'gcr');
      assertClean(r.stdout, 'mcp stdout');
    }
  });

  it('accepts no output options (stdout belongs to the protocol) and refuses a missing database like every command', { skip }, async () => {
    assertTextError(await gcr(['mcp', '--db', dbPath, '--format', 'markdown']), 'INVALID_ARGUMENT');
    assertTextError(await gcr(['mcp', '--db', join(tempDir(), 'missing.sqlite')]), 'DB_NOT_FOUND');
  });
});

describe('source scan of src/cli and src/suppress-warnings.ts', () => {
  const srcRoot = join(REPO_ROOT, 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const cliFiles = [...files(join(srcRoot, 'cli')), join(srcRoot, 'suppress-warnings.ts')];

  it('finds the sources (the scan is not vacuous)', () => {
    assert.ok(cliFiles.length >= 20, `found ${cliFiles.length} files`);
    for (const f of cliFiles) assert.ok(statSync(f).size > 0);
  });

  it('imports only an allow-list of Node built-ins, the two declared dependencies (none are needed) and relative modules: no network, no child_process', () => {
    const builtins = new Set(['node:fs', 'node:fs/promises', 'node:path', 'node:util', 'node:crypto', 'node:process']);
    const forbidden = /^(node:)?(https?|http2|net|tls|dns|dgram|quic|child_process|cluster|worker_threads|vm|inspector|repl|module|test|zlib|readline|os)(\/.*)?$/;
    for (const file of cliFiles) {
      const text = readFileSync(file, 'utf8');
      const specs = [...text.matchAll(/(?:\bfrom|\bimport\s*\(|\bimport)\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
      for (const spec of specs) {
        const where = `${relative(REPO_ROOT, file)} imports "${spec}"`;
        assert.equal(forbidden.test(spec), false, `${where}: forbidden module`);
        if (spec.startsWith('.')) continue;
        assert.ok(builtins.has(spec), `${where}: not on the allow-list ${[...builtins].join(', ')}`);
      }
      assert.equal(/\brequire\s*\(/.test(text), false, `${relative(REPO_ROOT, file)} uses require()`);
      assert.equal(/\b(fetch|WebSocket|XMLHttpRequest|EventSource|sendBeacon)\b\s*[(.]/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false, `${relative(REPO_ROOT, file)} uses a network global`);
    }
  });

  it('no console.*, and process.stdout/stderr only in the one output module', () => {
    for (const file of cliFiles) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      const name = relative(srcRoot, file);
      assert.equal(/\bconsole\s*\./.test(code), false, `${name} uses console`);
      if (name !== join('cli', 'output.ts')) assert.equal(/process\.(stdout|stderr)\b/.test(code), false, `${name} writes to a standard stream directly`);
    }
  });

  it('process.exit appears only in main.ts', () => {
    for (const file of cliFiles) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      if (relative(srcRoot, file) !== join('cli', 'main.ts')) assert.equal(/process\.exit\b/.test(code), false, `${relative(srcRoot, file)} calls process.exit`);
    }
  });

  it('contains no `any`, no eval, no raw invisible or bidi characters (Trojan Source hygiene), and no secrets-looking strings', () => {
    const invisible = new RegExp(`[${[0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0xfeff].map((c) => String.fromCharCode(c)).join('')}\\u0080-\\u009f]|[\\u{E0000}-\\u{E007F}]`, 'u');
    // The pattern for the keyword is assembled so that this file does not match itself.
    const anyType = new RegExp([':\\s*a' + 'ny\\b', '<a' + 'ny>', '\\bas a' + 'ny\\b'].join('|'));
    const testDir = join(REPO_ROOT, 'test', 'cli');
    const testFiles = readdirSync(testDir).filter((n) => n.endsWith('.ts')).map((n) => join(testDir, n));
    for (const file of [...cliFiles, ...testFiles]) {
      const text = readFileSync(file, 'utf8');
      const name = relative(REPO_ROOT, file);
      assert.equal(invisible.test(text), false, `${name} contains a raw invisible/bidi character`);
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.equal(anyType.test(code), false, `${name} uses the any type`);
      assert.equal(/\beval\s*\(|new Function\s*\(/.test(code), false, `${name} evaluates code`);
      assert.equal(/\bsk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9._-]{20,}/.test(text), false, `${name} looks like it holds a secret`);
    }
  });
});
