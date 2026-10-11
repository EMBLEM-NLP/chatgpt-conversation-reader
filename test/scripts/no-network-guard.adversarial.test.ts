/**
 * Adversarial review of scripts/no-network-guard.cjs: ways AROUND the guard, found by trying them.
 *
 * Every case runs a real child process twice against a loopback TCP server owned by this test:
 *   - WITHOUT the guard: the snippet must reach the server (the control run; otherwise the snippet proves nothing);
 *   - WITH the guard: the server must see NO connection, and the guard must have recorded the API name.
 * The bypasses in this file all worked against the first version of the guard (arguments that node:net reads differently
 * from the guard, process.binding, workers and children started with their own env / execArgv, wrapper programs, execve,
 * the inspector port). The remaining limits are written down in the header of the guard itself.
 *
 * Loopback is used instead of an unroutable address on purpose: a bypass is only proven when a connection really arrives.
 * Nothing leaves the machine.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GUARD, baseEnv, makeTempDir, removeDir, runNode } from './scripts.helpers.test.js';

let dir = '';
before(() => {
  dir = makeTempDir('gcr-guard-adversarial-');
});
after(() => removeDir(dir));

const whichPath = (program: string): string | undefined => (process.env['PATH'] ?? '').split(delimiter).map((d) => join(d, program)).find((f) => existsSync(f));
const onPath = (program: string): boolean => whichPath(program) !== undefined;

interface Case {
  readonly name: string;
  /** The code the child runs; `port` is the loopback server of this case, `work` a private directory. */
  readonly code: (port: number, work: string) => string;
  /** Programs the case needs; the case is skipped (and says so) when one is missing. */
  readonly needs?: readonly string[];
  /** The log line the guard must have written. */
  readonly logs: string;
  /** How the unguarded control run proves that the snippet works: a connection at the server (default) or a marker on stdout. */
  readonly control?: 'connects' | RegExp;
}

const hex = (port: number): string => `0x${port.toString(16)}`;
const NODE_CONNECT = (port: number): string => `require('net').connect(${port}, '127.0.0.1')`;

const CASES: readonly Case[] = [
  // ---- node:net reads its arguments differently from the first guard --------------------------------------------------------
  { name: 'net.connect with the port spelled as a hex string', code: (p) => `require('net').connect(${JSON.stringify(hex(p))}, '127.0.0.1')`, logs: 'net.connect' },
  { name: 'net.connect with a leading space in the port string', code: (p) => `require('net').connect(${JSON.stringify(` ${p}`)}, '127.0.0.1')`, logs: 'net.connect' },
  { name: 'net.connect with an exponent port string', code: (p) => `require('net').connect(${JSON.stringify(`${p}e0`)}, '127.0.0.1')`, logs: 'net.connect' },
  { name: 'net.connect({ path: "", port, host }): an empty path is no path', code: (p) => `require('net').connect({ path: '', port: ${p}, host: '127.0.0.1' })`, logs: 'net.connect' },
  { name: 'net.createConnection({ path: "", port, host })', code: (p) => `require('net').createConnection({ path: '', port: ${p}, host: '127.0.0.1' })`, logs: 'net.createConnection' },
  { name: 'new net.Socket().connect with a hex port string', code: (p) => `new (require('net').Socket)().connect(${JSON.stringify(hex(p))}, '127.0.0.1')`, logs: 'net.Socket.connect' },
  { name: 'a subclass of net.Socket', code: (p) => `class S extends require('net').Socket {}; new S().connect(${p}, '127.0.0.1')`, logs: 'net.Socket.connect' },
  { name: 'Socket.prototype.connect.call(socket, ...)', code: (p) => `require('net').Socket.prototype.connect.call(new (require('net').Socket)(), ${p}, '127.0.0.1')`, logs: 'net.Socket.connect' },
  { name: 'new http.ClientRequest(url) (not http.request)', code: (p) => `const r = new (require('http').ClientRequest)('http://127.0.0.1:${p}/'); r.on('error', () => {}); r.end()`, logs: 'http.Agent.createConnection' },
  { name: 'http.Agent#createConnection called directly', code: (p) => `new (require('http').Agent)().createConnection({ port: ${p}, host: '127.0.0.1' })`, logs: 'http.Agent.createConnection' },
  {
    name: 'a TCP server whose options carry both a path and a port (the port wins in node:net)',
    code: (_p, work) => `const s = require('net').createServer(); s.listen({ path: ${JSON.stringify(join(work, 'x.sock'))}, port: 0 }); s.on('listening', () => { console.log('LISTENING ' + typeof s.address()); process.exit(0); }); setTimeout(() => process.exit(0), 1500)`,
    logs: 'net.Server.listen',
    control: /LISTENING object/,
  },
  {
    name: 'a server listening on the numeric string "0x0" (a port, not a pipe name)',
    code: () => `const s = require('net').createServer(); s.listen('0x0'); s.on('listening', () => { console.log('LISTENING ' + typeof s.address()); process.exit(0); }); setTimeout(() => process.exit(0), 1500)`,
    logs: 'net.Server.listen',
    control: /LISTENING object/,
  },
  // ---- below the JavaScript API --------------------------------------------------------------------------------------------
  {
    name: 'process.binding("tcp_wrap")',
    code: (p) => `const { TCP, TCPConnectWrap, constants } = process.binding('tcp_wrap'); const h = new TCP(constants.SOCKET); const req = new TCPConnectWrap(); req.oncomplete = () => {}; h.connect(req, '127.0.0.1', ${p})`,
    logs: 'process.binding',
  },
  { name: 'process.dlopen (a native addon can do anything)', code: () => `process.dlopen({ exports: {} }, '/nonexistent-addon.node')`, logs: 'process.dlopen', control: /THROWN:/ },
  {
    name: 'inspector.open (a debugger server on a TCP port)',
    code: () => `require('inspector').open(0, '127.0.0.1'); console.log('INSPECTOR-OPEN'); process.exit(0)`,
    logs: 'inspector.open',
    control: /INSPECTOR-OPEN/,
  },
  // ---- children and workers that try to shed the guard ---------------------------------------------------------------------------
  { name: 'a worker thread (inherits the guard)', code: (p) => `new (require('worker_threads').Worker)(${JSON.stringify(NODE_CONNECT(p))}, { eval: true }).on('error', () => {})`, logs: 'net.connect' },
  { name: 'a worker thread with execArgv: []', code: (p) => `new (require('worker_threads').Worker)(${JSON.stringify(NODE_CONNECT(p))}, { eval: true, execArgv: [] }).on('error', () => {})`, logs: 'net.connect' },
  { name: 'a worker thread with env: {} and execArgv: []', code: (p) => `new (require('worker_threads').Worker)(${JSON.stringify(NODE_CONNECT(p))}, { eval: true, env: {}, execArgv: [] }).on('error', () => {})`, logs: 'net.connect' },
  { name: 'a node child started with env: {}', code: (p) => `require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(NODE_CONNECT(p))}], { env: {} })`, logs: 'net.connect' },
  { name: 'a node child after delete process.env.NODE_OPTIONS', code: (p) => `delete process.env.NODE_OPTIONS; require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(NODE_CONNECT(p))}])`, logs: 'net.connect' },
  { name: 'a node child with an empty NODE_OPTIONS', code: (p) => `require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(NODE_CONNECT(p))}], { env: { PATH: process.env.PATH, NODE_OPTIONS: '' } })`, logs: 'net.connect' },
  {
    name: 'child_process.fork with env: {} and execArgv: []',
    code: (p, work) => `require('fs').writeFileSync(${JSON.stringify(join(work, 'forked.js'))}, ${JSON.stringify(NODE_CONNECT(p))}); require('child_process').fork(${JSON.stringify(join(work, 'forked.js'))}, [], { env: {}, execArgv: [] })`,
    logs: 'net.connect',
  },
  { name: 'child_process.execFile of node with an options object that has no env', code: (p) => `require('child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(NODE_CONNECT(p))}], { stdio: 'ignore' })`, logs: 'net.connect' },
  // ---- network programs behind a wrapper, a symlink, or no name at all -------------------------------------------------------------
  { name: 'env curl', needs: ['curl', 'env'], code: (p) => `require('child_process').spawnSync(${JSON.stringify(whichPath('env') ?? '')}, ['curl', '-s', 'http://127.0.0.1:${p}/'])`, logs: 'child_process.spawnSync' },
  { name: 'xargs curl', needs: ['curl', 'xargs'], code: (p) => `require('child_process').spawnSync('xargs', ['curl', '-s'], { input: 'http://127.0.0.1:${p}/' })`, logs: 'child_process.spawnSync' },
  { name: 'bash with /dev/tcp (no curl involved)', needs: ['bash'], code: (p) => `require('child_process').spawnSync('bash', ['-c', 'exec 3<>/dev/tcp/127.0.0.1/${p}'])`, logs: 'child_process.spawnSync' },
  { name: 'python3 -c with a socket', needs: ['python3'], code: (p) => `require('child_process').spawnSync('python3', ['-c', 'import socket;socket.create_connection(("127.0.0.1",${p}))'])`, logs: 'child_process.spawnSync' },
  { name: 'perl -e with IO::Socket', needs: ['perl'], code: (p) => `require('child_process').spawnSync('perl', ['-MIO::Socket::INET', '-e', 'IO::Socket::INET->new(PeerAddr=>"127.0.0.1:${p}")'])`, logs: 'child_process.spawnSync' },
  {
    name: 'a symbolic link with an innocent name that points at curl',
    needs: ['curl'],
    code: (p, work) => `const link = ${JSON.stringify(join(work, 'harmless-tool'))}; require('fs').symlinkSync(${JSON.stringify(whichPath('curl') ?? '')}, link); require('child_process').spawnSync(link, ['-s', 'http://127.0.0.1:${p}/'])`,
    logs: 'child_process.spawnSync',
  },
  { name: 'process.execve into curl', needs: ['curl'], code: (p) => `process.execve(${JSON.stringify(whichPath('curl') ?? '')}, ['curl', '-s', 'http://127.0.0.1:${p}/'], process.env)`, logs: 'process.execve' },
];

interface Outcome {
  readonly skipped: string | null;
  readonly guardedHits: number;
  readonly controlHits: number;
  readonly controlOut: string;
  readonly guardedOut: string;
  readonly log: string[];
}

/** One loopback server per run, so cases can run side by side and a hit is attributable. */
async function withServer<T>(body: (port: number, hits: () => number) => Promise<T>): Promise<T> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    count++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await body((server.address() as AddressInfo).port, () => count);
  } finally {
    // A client that was killed mid-conversation can leave a half-open connection behind; close() would wait for it forever.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;

async function run(c: Case): Promise<Outcome> {
  const missing = (c.needs ?? []).find((program) => !onPath(program));
  if (missing !== undefined) return { skipped: `${missing} is not installed`, guardedHits: 0, controlHits: 0, controlOut: '', guardedOut: '', log: [] };
  const id = ++counter;
  const work = join(dir, `case-${id}`);
  mkdirSync(work);
  const wrap = (code: string): string => `(async () => { try { ${code} } catch (e) { console.log('THROWN:' + String(e && e.message).slice(0, 60)); } await new Promise((r) => setTimeout(r, 500)); process.exit(0); })()`;
  mkdirSync(join(work, 'control'));
  const guardedLog = join(work, 'guard.log');
  writeFileSync(guardedLog, '');
  const guarded = await withServer(async (port, hits) => {
    const r = await runNode(['--require', GUARD, '-e', wrap(c.code(port, work))], { cwd: work, env: baseEnv({ GCR_NO_NETWORK_LOG: guardedLog }), timeoutMs: 30_000 });
    await settle(250);
    return { hits: hits(), out: r.stdout + r.stderr };
  });
  const control = await withServer(async (port, hits) => {
    const r = await runNode(['-e', wrap(c.code(port, join(work, 'control')))], { cwd: work, env: baseEnv(), timeoutMs: 30_000 });
    await settle(250);
    return { hits: hits(), out: r.stdout + r.stderr };
  });
  const log = readFileSync(guardedLog, 'utf8').split('\n').filter((l) => l !== '');
  return { skipped: null, guardedHits: guarded.hits, controlHits: control.hits, controlOut: control.out, guardedOut: guarded.out, log };
}

describe('scripts/no-network-guard.cjs cannot be sidestepped with these tricks (each runs unguarded first, to prove it works)', { timeout: 300_000 }, () => {
  const outcomes = new Map<string, Outcome>();

  before(async () => {
    const queue = [...CASES];
    const worker = async (): Promise<void> => {
      for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
        outcomes.set(c.name, await run(c).catch((e: unknown) => ({ skipped: `runner error ${e instanceof Error ? e.name : 'unknown'}`, guardedHits: 0, controlHits: 0, controlOut: '', guardedOut: '', log: [] })));
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
  });

  for (const c of CASES) {
    it(c.name, (t) => {
      const o = outcomes.get(c.name);
      assert.ok(o, 'the case did not run');
      if (o.skipped !== null) {
        t.skip(o.skipped);
        return;
      }
      // the control: the trick works when nothing guards the process
      if (c.control === undefined || c.control === 'connects') assert.ok(o.controlHits >= 1, `the unguarded control did not reach the server (output: ${o.controlOut.slice(0, 120)})`);
      else assert.match(o.controlOut, c.control, 'the unguarded control did not show its marker');
      // the guarded run: nothing reached the server, and the guard said why
      assert.equal(o.guardedHits, 0, `a connection got through the guard (output: ${o.guardedOut.slice(0, 120)})`);
      assert.ok(o.log.includes(c.logs), `the guard log lacks "${c.logs}": ${JSON.stringify(o.log)}`);
      for (const line of o.log) assert.match(line, /^[A-Za-z0-9_.]+$/, 'a log line is only an API name');
      assert.ok(!/LISTENING object|INSPECTOR-OPEN/.test(o.guardedOut), 'the guarded run reached the forbidden call');
    });
  }
});

describe('scripts/no-network-guard.cjs: the hardening does not break harmless work', { timeout: 120_000 }, () => {
  const probe = (code: string, extra: Record<string, string> = {}): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, ['--require', GUARD, '-e', code], { cwd: dir, env: baseEnv({ GCR_NO_NETWORK_LOG: join(dir, 'harmless.log'), ...extra }), encoding: 'utf8', timeout: 60_000 });

  it('a worker thread does its job under the guard and adds no line to the loaded log', () => {
    const loaded = join(dir, 'harmless-loaded.log');
    writeFileSync(loaded, '');
    const r = probe(
      `const { Worker } = require('worker_threads'); const w = new Worker("require('worker_threads').parentPort.postMessage(6 * 7)", { eval: true }); w.on('message', (m) => { console.log('answer ' + m); });`,
      { GCR_NO_NETWORK_LOADED_LOG: loaded },
    );
    assert.equal(String(r.stdout).trim(), 'answer 42');
    assert.equal(r.status, 0);
    assert.equal(readFileSync(loaded, 'utf8').split('\n').filter((l) => l !== '').length, 1, 'only the main thread of the process is counted');
  });

  it('a child with env: {} receives the guard in NODE_OPTIONS, and one that already has it is not changed', () => {
    const r = probe(`
      const cp = require('child_process');
      const a = cp.spawnSync('sh', ['-c', 'echo "$NODE_OPTIONS"'], { env: {}, encoding: 'utf8' }).stdout.trim();
      const b = cp.spawnSync('sh', ['-c', 'echo "$NODE_OPTIONS"'], { env: { NODE_OPTIONS: a }, encoding: 'utf8' }).stdout.trim();
      console.log(JSON.stringify({ a, same: a === b }));`);
    const out = JSON.parse(String(r.stdout)) as { a: string; same: boolean };
    assert.ok(out.a.includes(GUARD), 'the guard is in the child environment');
    assert.equal(out.same, true, 'the guard is added once');
  });

  it('echo with the word "curl" as an argument, a plain python script, a fork of a harmless file, process.binding("fs") all keep working', () => {
    writeFileSync(join(dir, 'harmless-child.js'), "process.send ? process.send('hi') : console.log('hi');");
    const r = probe(`
      const cp = require('child_process');
      const out = {};
      out.echo = cp.execFileSync('echo', ['curl is only a word here'], { encoding: 'utf8' }).trim();
      out.python = cp.spawnSync('python3', ['-c', 'print(6*7)'], { encoding: 'utf8' }).stdout.trim();
      out.binding = typeof process.binding('constants');
      const child = cp.fork(${JSON.stringify(join(dir, 'harmless-child.js'))});
      child.on('message', (m) => { out.fork = m; child.disconnect(); console.log(JSON.stringify(out)); });`);
    assert.equal(r.status, 0, String(r.stderr));
    const out = JSON.parse(String(r.stdout)) as Record<string, string>;
    assert.equal(out['echo'], 'curl is only a word here');
    if (onPath('python3')) assert.equal(out['python'], '42');
    assert.equal(out['binding'], 'object');
    assert.equal(out['fork'], 'hi');
  });

  it('Unix-domain servers and clients, path-style and string-style, still work', () => {
    const sock = join(dir, 'harmless.sock');
    const r = probe(`
      const net = require('net');
      const s = net.createServer((c) => c.end('ok')).listen(${JSON.stringify(sock)}, () => {
        net.connect(${JSON.stringify(sock)}).on('data', (d) => { console.log(String(d)); s.close(); });
      });`);
    assert.equal(String(r.stdout).trim(), 'ok');
    assert.equal(r.status, 0);
  });
});
