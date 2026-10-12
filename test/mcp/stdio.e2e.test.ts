/**
 * The COMPILED entry file as an MCP server process (NFR-03 "real MCP-client smoke"): a child process speaking MCP over stdio
 * to the real SDK Client (StdioClientTransport), and to a raw reader that checks EVERY byte on stdout. Also: clean shutdown on
 * stdin end, SIGTERM and SIGINT, a vanished reader (EPIPE), startup failures and exit codes, the write switch and the
 * environment variables, and the stdout guard itself.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { MCP_USAGE } from '../../src/mcp/entry.js';
import { escapeLineSeparators } from '../../src/mcp/stdout-guard.js';
import { TOOL_VERSION } from '../../src/version.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { Fixture, RawChild } from './mcp.helpers.test.js';
import {
  ENTRY_JS,
  ID,
  INITIALIZED,
  INJECTION,
  LINE_SEPARATOR,
  NEXT_LINE,
  PARAGRAPH_SEPARATOR,
  assertOnlyJsonRpcFrames,
  callTool,
  conversationsJson,
  createFixture,
  dbContentHash,
  envelopeOf,
  initializeMessage,
  linearChat,
  makeTempDir,
  removeDir,
  spawnRaw,
  tableRows,
  writeText,
} from './mcp.helpers.test.js';

async function finished(child: RawChild): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const timer = setTimeout(() => child.child.kill('SIGKILL'), 15_000);
  try {
    return await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

/** initialize + initialized, wait for the initialize response. */
async function handshake(c: RawChild, version: string = SUPPORTED_PROTOCOL_VERSIONS[0] as string): Promise<void> {
  c.send(initializeMessage(version, 1));
  await c.response(1);
  c.send(INITIALIZED);
}

describe('smoke: the real SDK client over the real child process', () => {
  let fx: Fixture;
  before(async () => {
    fx = await createFixture({ big: { turns: 25, kb: 16 } });
  });
  after(async () => {
    await fx.cleanup();
  });

  it('initializes, lists the tools, calls every read tool, reports errors with codes, and shuts down cleanly with a quiet stderr', async () => {
    const before = dbContentHash(fx.dbPath);
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY_JS, '--db', fx.dbPath], stderr: 'pipe', env: { GCR_LOG_LEVEL: 'info' } });
    let stderr = '';
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const client = new Client({ name: 'stdio-smoke', version: '0.0.1' });
    const clientErrors: Error[] = [];
    client.onerror = (e) => clientErrors.push(e);
    await client.connect(transport);
    try {
      assert.deepEqual(client.getServerVersion(), { name: 'gcr', version: TOOL_VERSION });
      assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: true } });
      assert.match(client.getInstructions() ?? '', /UNTRUSTED DATA/);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 12);
      assert.equal(typeof transport.pid, 'number');

      const ok = envelopeOf(await callTool(client, 'gcr_list', { limit: 5 }));
      assert.equal(ok.ok, true);
      assert.equal(ok.untrustedContent, true);
      assert.equal(envelopeOf(await callTool(client, 'gcr_get', { conversation: `https://chatgpt.com/c/${ID.linear}` })).ok, true);
      assert.equal(envelopeOf(await callTool(client, 'gcr_search', { query: 'quokka' })).ok, true);
      assert.equal(envelopeOf(await callTool(client, 'gcr_branches', { conversation: ID.branched })).ok, true);
      assert.equal(envelopeOf(await callTool(client, 'gcr_thread', { conversation: ID.branched })).ok, true);
      assert.equal(envelopeOf(await callTool(client, 'gcr_stats', { groupBy: 'role' })).ok, true);
      assert.equal(envelopeOf(await callTool(client, 'gcr_audit', {})).ok, true);
      assert.equal(envelopeOf(await callTool(client, 'gcr_graph_query', { term: 'quokka' })).ok, true);
      const doctor = envelopeOf(await callTool(client, 'gcr_doctor', {}));
      assert.equal((doctor.data as { database: { label: string } }).database.label, 'gcr.sqlite');

      const absent = await callTool(client, 'gcr_get', { conversation: ID.absent });
      assert.equal(absent.isError, true);
      assert.equal(envelopeOf(absent).error?.code, 'NOT_IN_LOCAL_EXPORT');
      assert.equal(envelopeOf(await callTool(client, 'gcr_create_local_draft', { conversation: ID.linear, body: 'x' })).error?.code, 'WRITE_FORBIDDEN');
      assert.equal(envelopeOf(await callTool(client, 'gcr_list', { limit: 9999 })).error?.code, 'INVALID_ARGUMENT');

      const big = envelopeOf(await callTool(client, 'gcr_thread', { conversation: ID.big }));
      assert.equal(big.truncated, true, 'the 400 KB thread is cut under the default cap, and the frame still arrives');
    } finally {
      await client.close();
    }
    assert.deepEqual(clientErrors.map((e) => e.message), [], 'no byte that is not a JSON-RPC frame reached the client');
    assert.match(stderr, /"msg":"mcp_ready","writes":false,"importRoots":0/);
    assert.match(stderr, /"msg":"mcp_shutdown","reason":"stdin_end"/);
    for (const forbidden of ['quokka', 'Café', INJECTION.user, fx.dir, 'GCR-SYNTHETIC-FIXTURE']) assert.ok(!stderr.includes(forbidden), `stderr must not contain ${JSON.stringify(forbidden)}`);
    assert.ok(!/ExperimentalWarning/.test(stderr), 'the node:sqlite ExperimentalWarning is filtered');
    for (const line of stderr.split('\n').filter((l) => l !== '')) {
      const entry = JSON.parse(line) as { level: string; msg: string };
      assert.ok(typeof entry.level === 'string' && typeof entry.msg === 'string', 'every stderr line of a clean session is a structured log line');
    }
    assert.equal(dbContentHash(fx.dbPath), before, 'a read-only server leaves the database unchanged');
  });
});

describe('raw bytes on stdout', () => {
  let fx: Fixture;
  before(async () => {
    fx = await createFixture({ big: { turns: 25, kb: 16 } });
  });
  after(async () => {
    await fx.cleanup();
  });

  it('EVERY byte the child writes is part of a well-formed JSON-RPC frame, whatever is in the data and whatever garbage arrives', async () => {
    const c = spawnRaw(['--db', fx.dbPath]);
    await handshake(c);
    c.send('this line is not JSON at all');
    c.send('{"not":"json-rpc","but":"valid json"}');
    c.send('[1,2,3]');
    c.send('');
    const calls: Array<[number, string, Record<string, unknown>]> = [
      [3, 'gcr_list', {}],
      [4, 'gcr_get', { conversation: ID.injection }],
      [5, 'gcr_get', { conversation: ID.absent }],
      [6, 'gcr_search', { query: 'instructions', scope: 'all' }],
      [7, 'gcr_create_local_draft', { conversation: ID.linear, body: 'x' }],
      [8, 'gcr_import_export', { path: '/etc/passwd' }],
      [9, 'gcr_no_such_tool', {}],
      [10, 'gcr_list', { limit: 'many' }],
      [11, 'gcr_doctor', {}],
      [12, 'gcr_graph_query', { term: 'quokka' }],
      [13, 'gcr_stats', { groupBy: 'conversation' }],
      [14, 'gcr_audit', {}],
      [15, 'gcr_thread', { conversation: ID.big }],
    ];
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    for (const [id, name, args] of calls) c.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    for (let id = 2; id <= 15; id++) await c.response(id);
    c.child.stdin.end();
    const exit = await finished(c);
    assert.deepEqual(exit, { code: 0, signal: null });

    const bytes = c.stdout();
    const frames = assertOnlyJsonRpcFrames(bytes);
    assert.deepEqual(
      frames.map((f) => f['id']).sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: 15 }, (_, i) => i + 1),
      'exactly one frame per request that had an id: the fake frame inside the injected message produced no frame of its own',
    );
    assert.ok(!frames.some((f) => f['id'] === 99), 'the injected {"id":99,...} frame did not become a frame');
    assert.ok(frames.every((f) => f['method'] === undefined), 'the server sent no requests or notifications');

    const injection = frames.find((f) => f['id'] === 4) as { result: { structuredContent: { data: { thread: { messages: Array<{ text: string }> } } } } };
    const text = injection.result.structuredContent.data.thread.messages[1]?.text ?? '';
    assert.ok(!text.includes(LINE_SEPARATOR) && !text.includes(PARAGRAPH_SEPARATOR) && !text.includes(NEXT_LINE), 'the separators are no longer raw characters in the data (ATK-04)');
    assert.ok(text.includes('\\u2028') && text.includes('\\u2029') && text.includes('\\u0085'), 'they arrive as visible escapes');
    for (const escape of ['\\u2028', '\\u2029', '\\u0085']) assert.ok(bytes.toString('utf8').includes(escape), `${escape} crosses the wire as an escape, never raw`);
    assert.ok(bytes.toString('utf8').includes(INJECTION.fakeFrame.replaceAll('"', '\\"')), 'the fake frame travels only as an escaped string inside a result');

    const big = frames.find((f) => f['id'] === 15) as { result: { structuredContent: { truncated: boolean } } };
    assert.equal(big.result.structuredContent.truncated, true);
    const bigLine = bytes.toString('utf8').split('\n').find((l) => l.includes('"id":15')) ?? '';
    assert.ok(Buffer.byteLength(bigLine) < 2.6 * 200_000, `the largest frame is ${Buffer.byteLength(bigLine)} bytes: far below the 10 MiB transport limit`);

    const unknown = frames.find((f) => f['id'] === 9) as { error: { code: number } };
    assert.equal(unknown.error.code, -32602, 'an unknown tool is a JSON-RPC error');

    const stderr = c.stderr();
    assert.match(stderr, /"msg":"mcp_transport_error"/, 'garbage input is reported on stderr, by error name');
    assert.ok(!stderr.includes('this line is not JSON'), 'the offending input is never logged');
    assert.ok(!stderr.includes('instructions') && !stderr.includes('quokka'), 'no conversation text on stderr');
  });

  it('negotiates every supported protocol version over the real stdio framing', async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const c = spawnRaw(['--db', fx.dbPath]);
      c.send(initializeMessage(version, 1));
      const res = await c.response(1);
      assert.equal((res['result'] as { protocolVersion: string }).protocolVersion, version);
      c.child.stdin.end();
      assert.equal((await finished(c)).code, 0);
      assertOnlyJsonRpcFrames(c.stdout());
    }
  });

  it('the purity check really detects noise: a process that prints to stdout fails it', async () => {
    const noisy = spawn(process.execPath, ['-e', "console.log('NOISE'); process.stdout.write('{\"jsonrpc\":\"2.0\",\"method\":\"x\"}\\n')"], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    noisy.stdout.on('data', (d: Buffer) => chunks.push(d));
    await new Promise((resolve) => noisy.on('exit', resolve));
    assert.throws(() => assertOnlyJsonRpcFrames(Buffer.concat(chunks)));
  });
});

describe('shutdown', () => {
  let fx: Fixture;
  before(async () => {
    fx = await createFixture();
  });
  after(async () => {
    await fx.cleanup();
  });

  it('stdin end: exit code 0, "mcp_shutdown" on stderr, and the database is closed cleanly (no WAL left behind)', async () => {
    const c = spawnRaw(['--db', fx.dbPath, '--allow-local-writes']);
    await handshake(c);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gcr_create_local_draft', arguments: { conversation: ID.linear, body: 'persisted' } } });
    await c.response(2);
    c.child.stdin.end();
    assert.deepEqual(await finished(c), { code: 0, signal: null });
    assert.match(c.stderr(), /"reason":"stdin_end"/);
    assert.equal(existsSync(`${fx.dbPath}-wal`), false, 'the last connection closed, so SQLite removed the WAL');
    assert.equal(tableRows(fx.dbPath, 'local_drafts').length, 1);
    assertOnlyJsonRpcFrames(c.stdout());
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal}: exit code 0 (not death by signal), clean stdout, "mcp_shutdown" on stderr`, async () => {
      const c = spawnRaw(['--db', fx.dbPath]);
      await handshake(c);
      c.child.kill(signal);
      assert.deepEqual(await finished(c), { code: 0, signal: null });
      assert.match(c.stderr(), new RegExp(`"reason":"${signal}"`));
      assertOnlyJsonRpcFrames(c.stdout());
    });
  }

  it('a signal that arrives before any request is handled the same way', async () => {
    const c = spawnRaw(['--db', fx.dbPath]);
    // Wait until the server says it is ready (its signal handlers are installed by then): a fixed sleep is a race on a loaded
    // machine, and a signal that arrives while the process is still starting is simply Node's default (terminate).
    const deadline = Date.now() + 20_000;
    while (!c.stderr().includes('"msg":"mcp_ready"')) {
      assert.ok(Date.now() < deadline, 'the server became ready');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    c.child.kill('SIGTERM');
    assert.deepEqual(await finished(c), { code: 0, signal: null });
    assert.equal(c.stdout().length, 0, 'an idle server writes nothing to stdout');
  });

  it('the reader of stdout vanishing (EPIPE) is a normal shutdown: exit 0, no stack trace', async () => {
    const c = spawnRaw(['--db', fx.dbPath]);
    await handshake(c);
    c.child.stdout.destroy();
    for (let i = 2; i < 40; i++) c.send({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'gcr_list', arguments: {} } });
    // some environments report EPIPE only on a later write; closing stdin ends the process in either case
    setTimeout(() => c.child.stdin.end(), 500);
    const exit = await finished(c);
    assert.equal(exit.code, 0, c.stderr());
    assert.ok(!/\bat \w+.*\(.*:\d+:\d+\)/.test(c.stderr()), 'no stack trace on stderr');
  });
});

describe('startup failures and exit codes', () => {
  let dir: string;
  before(async () => {
    dir = await makeTempDir();
  });
  after(async () => {
    await removeDir(dir);
  });

  async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const c = spawnRaw(args, { GCR_LOG_LEVEL: 'warn', ...env });
    c.child.stdin.end();
    const exit = await finished(c);
    return { code: exit.code, stdout: c.stdout().toString('utf8'), stderr: c.stderr() };
  }

  it('no database: exit 2, usage on stderr, nothing on stdout', async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no database given/);
    assert.equal(r.stdout, '');
  });

  it('GCR_DB is the fallback for --db', async () => {
    const fx = await createFixture({ graph: false });
    try {
      const c = spawnRaw([], { GCR_DB: fx.dbPath });
      await handshake(c);
      c.child.stdin.end();
      assert.equal((await finished(c)).code, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it('an unknown argument: exit 2, not echoed, nothing on stdout', async () => {
    const r = await run(['--bogus-secret-flag']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Unknown argument/);
    assert.ok(!r.stderr.includes('bogus-secret-flag'));
    assert.equal(r.stdout, '');
  });

  it('a read-only server cannot create a database: exit 5 (DB_NOT_FOUND) with the remedy', async () => {
    const r = await run(['--db', join(dir, 'missing.sqlite')]);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /DB_NOT_FOUND/);
    assert.match(r.stderr, /gcr import/);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(join(dir, 'missing.sqlite')), false, 'nothing was created');
  });

  it('a file that is not a database: exit 5 and the file is untouched', async () => {
    const path = join(dir, 'not-a-db.sqlite');
    writeFileSync(path, 'this is not a sqlite database, just some text '.repeat(40));
    const before = statSync(path).size;
    const r = await run(['--db', path]);
    assert.equal(r.code, 5);
    assert.equal(statSync(path).size, before);
    assert.equal(r.stdout, '');
  });

  it('a bad result-size setting: exit 2 and it says which', async () => {
    const r = await run(['--db', join(dir, 'x.sqlite')], { GCR_MCP_MAX_RESULT_BYTES: 'lots' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /GCR_MCP_MAX_RESULT_BYTES/);
  });

  it('--help prints the usage on stdout and exits 0; --version prints the version', async () => {
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.equal(help.stdout, MCP_USAGE);
    assert.equal(help.stderr, '');
    const version = await run(['--version']);
    assert.equal(version.code, 0);
    assert.equal(version.stdout, `gcr-mcp ${TOOL_VERSION}\n`);
  });
});

describe('the write switch and the environment', () => {
  let fx: Fixture;
  before(async () => {
    fx = await createFixture({ many: 40, graph: false });
  });
  after(async () => {
    await fx.cleanup();
  });

  async function session(args: string[], env: Record<string, string>, calls: Array<[string, Record<string, unknown>]>): Promise<{ results: Array<Record<string, unknown>>; stderr: string; code: number | null }> {
    const c = spawnRaw(args, env);
    await handshake(c);
    const results: Array<Record<string, unknown>> = [];
    let id = 2;
    for (const [name, a] of calls) {
      c.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: a } });
      results.push(((await c.response(id)) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent);
      id++;
    }
    c.child.stdin.end();
    const exit = await finished(c);
    assertOnlyJsonRpcFrames(c.stdout());
    return { results, stderr: c.stderr(), code: exit.code };
  }

  const draft: [string, Record<string, unknown>] = ['gcr_create_local_draft', { conversation: ID.linear, body: 'from a child process' }];

  it('without the switch every write is WRITE_FORBIDDEN and the database file is not modified', async () => {
    const before = dbContentHash(fx.dbPath);
    const r = await session(['--db', fx.dbPath], {}, [draft]);
    assert.equal((r.results[0]?.['error'] as { code: string }).code, 'WRITE_FORBIDDEN');
    assert.equal(dbContentHash(fx.dbPath), before);
  });

  it('--allow-local-writes enables the draft, which is stored and audited with the mcp actor', async () => {
    const r = await session(['--db', fx.dbPath, '--allow-local-writes'], {}, [draft]);
    assert.equal(r.results[0]?.['ok'], true);
    assert.equal(r.code, 0);
    const rows = tableRows(fx.dbPath, 'local_drafts');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['created_via'], 'mcp');
    assert.ok(tableRows(fx.dbPath, 'local_audit_log').every((a) => a['actor'] === 'mcp'));
    assert.match(r.stderr, /"msg":"mcp_ready","writes":true/);
  });

  it('GCR_MCP_ALLOW_WRITES=1 enables it as well', async () => {
    const r = await session(['--db', fx.dbPath], { GCR_MCP_ALLOW_WRITES: '1' }, [draft]);
    assert.equal(r.results[0]?.['ok'], true);
    assert.equal(tableRows(fx.dbPath, 'local_drafts').length, 2);
  });

  it('any other value (true, yes, 2) does NOT enable writes: fail closed, with a warning', async () => {
    for (const value of ['true', 'yes', '2', 'on']) {
      const r = await session(['--db', fx.dbPath], { GCR_MCP_ALLOW_WRITES: value }, [draft]);
      assert.equal((r.results[0]?.['error'] as { code: string }).code, 'WRITE_FORBIDDEN', value);
      assert.match(r.stderr, /mcp_allow_writes_value_ignored/);
    }
    assert.equal(tableRows(fx.dbPath, 'local_drafts').length, 2);
  });

  it('GCR_MCP_MAX_RESULT_BYTES is honoured by the process', async () => {
    const r = await session(['--db', fx.dbPath], { GCR_MCP_MAX_RESULT_BYTES: '8192' }, [['gcr_list', { limit: 200 }]]);
    assert.equal(r.results[0]?.['truncated'], true);
  });

  it('with writes enabled a new database file is created, private to its owner', async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, 'fresh.sqlite');
      const r = await session(['--db', path, '--allow-local-writes'], {}, [['gcr_list', {}]]);
      assert.equal((r.results[0]?.['data'] as { total: number }).total, 0);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      await removeDir(dir);
    }
  });

  it('GCR_APPROVED_IMPORT_ROOTS: import works inside a root, is refused outside, and bad roots are only counted', async () => {
    const dir = await makeTempDir();
    try {
      const root = join(dir, 'approved');
      await mkdir(root);
      const target = join(dir, 'target.sqlite');
      const imported = syntheticUuid(0x55);
      await writeText(root, 'conversations.json', conversationsJson([linearChat(imported, 'imported by child', [['hello', 'hi']])]));
      const outside = await writeText(dir, join('elsewhere', 'conversations.json'), conversationsJson([linearChat(syntheticUuid(0x56), 'outside', [['x', 'y']])]));
      const roots = [root, join(dir, 'missing-root'), 'relative-root'].join(':');
      const r = await session(
        ['--db', target, '--allow-local-writes'],
        { GCR_APPROVED_IMPORT_ROOTS: roots },
        [
          ['gcr_import_export', { path: join(root, 'conversations.json') }],
          ['gcr_import_export', { path: outside }],
          ['gcr_get', { conversation: imported }],
        ],
      );
      assert.equal(r.results[0]?.['ok'], true);
      assert.equal((r.results[1]?.['error'] as { code: string }).code, 'IMPORT_PATH_NOT_ALLOWED');
      assert.equal(r.results[2]?.['ok'], true);
      assert.match(r.stderr, /"msg":"mcp_approved_roots_ignored","count":2/);
      assert.match(r.stderr, /"importRoots":1/);
      assert.ok(!r.stderr.includes(root) && !r.stderr.includes('relative-root'), 'roots are counted, never printed');
    } finally {
      await removeDir(dir);
    }
  });
});

describe('the stdout guard', () => {
  const guardHref = new URL('../../src/mcp/stdout-guard.js', import.meta.url).href;

  function runInline(script: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('exit', (code) => resolve({ stdout, stderr, code }));
    });
  }

  it('redirects console.* and process.stdout.write to stderr, and lets only rpcOut reach stdout', async () => {
    const script = [
      `import { installStdoutGuard } from ${JSON.stringify(guardHref)};`,
      'const guard = installStdoutGuard();',
      'const again = installStdoutGuard();',
      "console.log('NOISE console.log');",
      "console.info('NOISE console.info');",
      "console.debug('NOISE console.debug');",
      "console.table([{ NOISE: 'table' }]);",
      "console.dir({ NOISE: 'dir' });",
      "process.stdout.write('NOISE process.stdout.write\\n');",
      "process.stdout.write(Buffer.from('NOISE buffer\\n'));",
      "guard.rpcOut.write('{\"jsonrpc\":\"2.0\",\"method\":\"first\"}\\n');",
      'const sep = String.fromCharCode(0x2028);',
      "guard.rpcOut.write('{\"jsonrpc\":\"2.0\",\"method\":\"second\",\"params\":{\"t\":\"a' + sep + 'b\"}}\\n', () => { process.stderr.write('same=' + (again === guard) + '\\n'); process.exit(0); });",
    ].join('\n');
    const r = await runInline(script);
    assert.equal(r.code, 0, r.stderr);
    const frames = assertOnlyJsonRpcFrames(Buffer.from(r.stdout, 'utf8'));
    assert.deepEqual(frames.map((f) => f['method']), ['first', 'second']);
    assert.ok(r.stdout.includes('a\\u2028b'), 'the line separator crosses as an escape');
    for (const noise of ['NOISE console.log', 'NOISE console.info', 'NOISE console.debug', 'NOISE process.stdout.write', 'NOISE buffer', 'table', 'dir']) assert.ok(r.stderr.includes(noise), `${noise} went to stderr`);
    assert.ok(r.stderr.includes('same=true'), 'installing twice returns the same guard');
  });

  it('without the guard the same prints land on stdout (the control for the test above)', async () => {
    const r = await runInline("console.log('NOISE'); process.exit(0);");
    assert.equal(r.stdout, 'NOISE\n');
  });

  it('escapeLineSeparators rewrites exactly the three line-breaking characters and nothing else', () => {
    const backslash = String.fromCharCode(0x5c);
    const text = `{"a":"x${LINE_SEPARATOR}y${PARAGRAPH_SEPARATOR}z${NEXT_LINE}w","b":"${backslash}n plain caf${String.fromCharCode(0xe9)} ${String.fromCodePoint(0x1f600)}"}`;
    const escaped = escapeLineSeparators(text);
    assert.equal(escaped, `{"a":"x${backslash}u2028y${backslash}u2029z${backslash}u0085w","b":"${backslash}n plain caf${String.fromCharCode(0xe9)} ${String.fromCodePoint(0x1f600)}"}`);
    assert.deepEqual(JSON.parse(escaped), JSON.parse(text), 'identical after parsing');
    assert.equal(escapeLineSeparators('no separators here'), 'no separators here');
  });
});

describe('importing the entry module has no side effects', () => {
  it('neither the bootstrap nor the entry installs the guard or starts a server when imported by another program', async () => {
    const writeBefore = process.stdout.write;
    const emitBefore = process.emitWarning;
    const bootstrap = await import('../../src/mcp/stdio-bootstrap.js');
    await import('../../src/mcp/entry.js');
    assert.equal(bootstrap.runningAsEntry, false);
    assert.equal(process.stdout.write, writeBefore);
    assert.equal(process.emitWarning, emitBefore);
  });
});
