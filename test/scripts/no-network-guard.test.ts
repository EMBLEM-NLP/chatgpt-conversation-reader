/**
 * scripts/no-network-guard.cjs: the preload that makes every known way of using the network throw
 * "GCR_NO_NETWORK_GUARD: ..." and records the API name (never an argument) in GCR_NO_NETWORK_LOG.
 *
 * Every test runs a REAL child process with `--require <guard>` (or NODE_OPTIONS) and looks at what the child saw and at
 * the log file: nothing is mocked. Targets are 192.0.2.1 (TEST-NET-1, unroutable) and example.invalid, and the guard throws
 * before anything would leave the machine, so none of these tests can reach a network even if the guard were broken
 * (a broken guard would show up as a "none" result, not as traffic to a real host: the addresses are unroutable).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GUARD, baseEnv, makeTempDir, removeDir, runNode } from './scripts.helpers.test.js';

const PREFIX = 'GCR_NO_NETWORK_GUARD:';
let dir = '';
let counter = 0;

before(() => {
  dir = makeTempDir('gcr-guard-test-');
});
after(() => {
  removeDir(dir);
});

interface Probe {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly log: string[];
  readonly loaded: string[];
}

const linesOf = (path: string): string[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l !== '') : []);

/** Run `node --require guard <nodeArgs>` with a fresh log file. */
async function probe(nodeArgs: readonly string[], extraEnv: Record<string, string> = {}, requireTwice = false): Promise<Probe> {
  const id = ++counter;
  const logFile = join(dir, `guard-${id}.log`);
  const loadedFile = join(dir, `loaded-${id}.log`);
  const requires = requireTwice ? ['--require', GUARD, '--require', GUARD] : ['--require', GUARD];
  const r = await runNode([...requires, ...nodeArgs], {
    cwd: dir,
    env: baseEnv({ GCR_NO_NETWORK_LOG: logFile, GCR_NO_NETWORK_LOADED_LOG: loadedFile, ...extraEnv }),
    timeoutMs: 60_000,
  });
  assert.equal(r.timedOut, false, 'the probe timed out');
  return { stdout: r.stdout, stderr: r.stderr, code: r.code, log: linesOf(logFile), loaded: linesOf(loadedFile) };
}

/** One child that tries every guarded API once and reports `blocked` / `none` / `other:<ErrorName>` per attempt. */
const MATRIX = `
const results = {};
const attempt = async (name, f) => {
  try { const v = f(); if (v && typeof v.then === 'function') await v; results[name] = 'none'; }
  catch (e) { results[name] = String(e && e.message).startsWith(${JSON.stringify(PREFIX)}) ? 'blocked' : 'other:' + (e && e.name); }
};
(async () => {
  const net = require('net'), tls = require('tls'), dns = require('dns'), http = require('http'), https = require('https');
  const http2 = require('http2'), dgram = require('dgram'), cp = require('child_process');
  const A = '192.0.2.1';
  await attempt('net.connect', () => net.connect(9, A));
  await attempt('net.createConnection', () => net.createConnection({ port: 9, host: A }));
  await attempt('net.Socket.connect', () => new net.Socket().connect(9, A));
  await attempt('net.Server.listen', () => net.createServer().listen(0));
  await attempt('http.Server.listen', () => http.createServer().listen(0, '127.0.0.1'));
  await attempt('tls.connect', () => tls.connect({ host: A, port: 443 }));
  await attempt('dns.lookup', () => dns.lookup('example.invalid', () => {}));
  await attempt('dns.resolve4', () => dns.resolve4('example.invalid', () => {}));
  await attempt('dns.resolve', () => dns.resolve('example.invalid', () => {}));
  await attempt('dns.reverse', () => dns.reverse(A, () => {}));
  await attempt('dns.lookupService', () => dns.lookupService(A, 80, () => {}));
  await attempt('dns.Resolver.resolve4', () => new dns.Resolver().resolve4('example.invalid', () => {}));
  await attempt('dns.promises.lookup', () => dns.promises.lookup('example.invalid'));
  await attempt('dns.promises.resolve4', () => dns.promises.resolve4('example.invalid'));
  await attempt('dns.promises.Resolver.resolveTxt', () => new dns.promises.Resolver().resolveTxt('example.invalid'));
  await attempt('http.request', () => http.request('http://192.0.2.1:9/'));
  await attempt('http.get', () => http.get('http://192.0.2.1:9/'));
  await attempt('https.request', () => https.request('https://192.0.2.1:9/'));
  await attempt('https.get', () => https.get('https://192.0.2.1:9/'));
  await attempt('http2.connect', () => http2.connect('http://192.0.2.1:9'));
  const udp = dgram.createSocket('udp4');
  await attempt('dgram.Socket.send', () => udp.send(Buffer.from('x'), 9, A));
  await attempt('dgram.Socket.bind', () => udp.bind(0));
  await attempt('dgram.Socket.connect', () => udp.connect(9, A));
  try { udp.close(); } catch (e) {}
  await attempt('child_process.spawn', () => cp.spawn('curl', ['--version']));
  await attempt('child_process.spawnSync', () => cp.spawnSync('wget', ['--version']));
  await attempt('child_process.exec', () => cp.exec('curl --version', () => {}));
  await attempt('child_process.execSync', () => cp.execSync('echo hi | ssh -V'));
  await attempt('child_process.execFile', () => cp.execFile('/usr/bin/nc', ['-h'], () => {}));
  await attempt('child_process.execFileSync', () => cp.execFileSync('curl', ['--version']));
  await attempt('fetch', () => fetch('http://192.0.2.1:9/'));
  await attempt('WebSocket', () => new WebSocket('ws://192.0.2.1:9/'));
  // controls that must keep working
  await attempt('allowed.spawnSync', () => { const r = cp.spawnSync(process.execPath, ['-e', '1']); if (r.status !== 0) throw new Error('child failed'); });
  await attempt('allowed.execSync', () => { if (String(cp.execSync('echo hello')).trim() !== 'hello') throw new Error('wrong output'); });
  await attempt('allowed.exec-shell-word-in-argument', () => cp.execFileSync('echo', ['curl is only a word here']));
  console.log(JSON.stringify(results));
})();`;

describe('scripts/no-network-guard.cjs: every known way to use the network throws and is recorded', () => {
  let matrix: Record<string, string> = {};
  let log: string[] = [];
  let stderr = '';
  let code: number | null = null;

  before(async () => {
    const p = await probe(['-e', MATRIX]);
    matrix = JSON.parse(p.stdout) as Record<string, string>;
    log = p.log;
    stderr = p.stderr;
    code = p.code;
  });

  const BLOCKED = [
    'net.connect', 'net.createConnection', 'net.Socket.connect', 'net.Server.listen', 'http.Server.listen', 'tls.connect',
    'dns.lookup', 'dns.resolve4', 'dns.resolve', 'dns.reverse', 'dns.lookupService', 'dns.Resolver.resolve4',
    'dns.promises.lookup', 'dns.promises.resolve4', 'dns.promises.Resolver.resolveTxt',
    'http.request', 'http.get', 'https.request', 'https.get', 'http2.connect',
    'dgram.Socket.send', 'dgram.Socket.bind', 'dgram.Socket.connect',
    'child_process.spawn', 'child_process.spawnSync', 'child_process.exec', 'child_process.execSync', 'child_process.execFile', 'child_process.execFileSync',
    'fetch', 'WebSocket',
  ];
  for (const name of BLOCKED) {
    it(`${name} throws a GCR_NO_NETWORK_GUARD error`, () => {
      assert.equal(matrix[name], 'blocked');
    });
  }

  it('the log holds one line per blocked call, in call order, and each line is only the API name', () => {
    const labels: Record<string, string> = { 'http.Server.listen': 'net.Server.listen' };
    assert.deepEqual(log, BLOCKED.map((n) => labels[n] ?? n));
    for (const line of log) assert.match(line, /^[A-Za-z0-9_.]+$/);
  });

  it('harmless child processes keep working (a program name is judged, a word in an argument is not)', () => {
    assert.equal(matrix['allowed.spawnSync'], 'none');
    assert.equal(matrix['allowed.execSync'], 'none');
    assert.equal(matrix['allowed.exec-shell-word-in-argument'], 'none');
  });

  it('the probe itself ran to completion without noise on stderr', () => {
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.equal(Object.keys(matrix).length, BLOCKED.length + 3, 'every attempt was reported');
  });
});

describe('scripts/no-network-guard.cjs: what it must NOT block', () => {
  it('stdio pipes, child processes with piped stdio, Unix-domain sockets (server and client) and plain file I/O', async () => {
    const socketPath = join(dir, 'local.sock');
    const code = `
      const net = require('net'), cp = require('child_process'), fs = require('fs');
      const out = {};
      (async () => {
        // a child with piped stdio, talking both ways
        const child = cp.spawn(process.execPath, ['-e', 'process.stdin.on("data", (d) => process.stdout.write("echo:" + d)); process.stdin.on("end", () => process.exit(0));'], { stdio: ['pipe', 'pipe', 'inherit'] });
        const reply = new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d))));
        child.stdin.write('ping');
        out.pipe = await reply;
        child.stdin.end();
        // a Unix-domain socket in both directions
        out.unix = await new Promise((resolve, reject) => {
          const server = net.createServer((c) => c.end('pong')).listen(${JSON.stringify(socketPath)}, () => {
            const client = net.connect({ path: ${JSON.stringify(socketPath)} });
            client.on('data', (d) => { out.unixData = String(d); client.destroy(); server.close(() => resolve('ok')); });
            client.on('error', reject);
          });
          server.on('error', reject);
        });
        out.unixString = await new Promise((resolve, reject) => {
          const server = net.createServer((c) => c.end('pong2')).listen(${JSON.stringify(`${socketPath}2`)}, () => {
            const client = net.connect(${JSON.stringify(`${socketPath}2`)});
            client.on('data', (d) => { client.destroy(); server.close(() => resolve(String(d))); });
            client.on('error', reject);
          });
        });
        out.fileio = fs.readFileSync(${JSON.stringify(GUARD)}).length > 0;
        out.idleSocket = typeof new net.Socket() === 'object';
        console.log(JSON.stringify(out));
      })().catch((e) => { console.log('FAILED ' + e.name); process.exitCode = 1; });`;
    const p = await probe(['-e', code]);
    assert.equal(p.stderr, '');
    assert.equal(p.code, 0);
    assert.deepEqual(JSON.parse(p.stdout), { pipe: 'echo:ping', unix: 'ok', unixData: 'pong', unixString: 'pong2', fileio: true, idleSocket: true });
    assert.deepEqual(p.log, [], 'nothing was recorded');
  });

  it('reading standard input of the process works', async () => {
    const r = await runNode(['--require', GUARD, '-e', 'let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => console.log(s.toUpperCase()));'], {
      cwd: dir,
      env: baseEnv({ GCR_NO_NETWORK_LOG: join(dir, 'stdin.log') }),
      input: 'hello',
    });
    assert.equal(r.stdout.trim(), 'HELLO');
    assert.equal(existsSync(join(dir, 'stdin.log')), false);
  });
});

describe('scripts/no-network-guard.cjs: the error and the log', () => {
  it('the error message starts with the prefix and names only the API: no host, port or URL ever appears in it or in the log', async () => {
    const code = `
      const secret = ['secret', 'host', 'invalid'].join('-') + '.example.invalid';
      const messages = [];
      const tryIt = async (f) => { try { await f(); } catch (e) { messages.push(e.message); } };
      (async () => {
        await tryIt(() => require('net').connect(4431, secret));
        await tryIt(() => require('http').get('http://' + secret + ':4432/path?token=abc'));
        await tryIt(() => fetch('https://' + secret + ':4433/'));
        await tryIt(() => require('dns').lookup(secret, () => {}));
        console.log(JSON.stringify(messages));
      })();`;
    const p = await probe(['-e', code]);
    const messages = JSON.parse(p.stdout) as string[];
    assert.equal(messages.length, 4);
    for (const m of messages) {
      assert.ok(m.startsWith(PREFIX), 'prefix');
      assert.ok(!/secret|example\.invalid|443\d|token|path/.test(m), 'no argument in the message');
    }
    assert.deepEqual(p.log, ['net.connect', 'http.get', 'fetch', 'dns.lookup']);
    assert.ok(!/secret|example\.invalid|443\d|token/.test(p.log.join('\n')), 'no argument in the log');
  });

  it('is a plain Error (not an AbortError or a system error), so callers treat it as a failure', async () => {
    const p = await probe(['-e', 'try { require("net").connect(9, "192.0.2.1"); } catch (e) { console.log(e instanceof Error, e.name, e.code === undefined); }']);
    assert.equal(p.stdout.trim(), 'true Error true');
  });

  it('works without GCR_NO_NETWORK_LOG: it throws and writes no file anywhere', async () => {
    const empty = join(dir, 'no-log-cwd');
    mkdirSync(empty);
    const r = await runNode(['--require', GUARD, '-e', 'try { require("net").connect(9, "192.0.2.1"); } catch (e) { console.log(e.message.startsWith("GCR_NO_NETWORK_GUARD:")); }'], { cwd: empty, env: baseEnv() });
    assert.equal(r.stdout.trim(), 'true');
    assert.deepEqual(readdirSync(empty), []);
  });

  it('an unwritable log location never hides the error', async () => {
    const r = await runNode(['--require', GUARD, '-e', 'try { fetch("http://192.0.2.1:9/").catch((e) => console.log("rejected", e.message.startsWith("GCR_NO_NETWORK_GUARD:"))); } catch (e) { console.log("thrown"); }'], {
      cwd: dir,
      env: baseEnv({ GCR_NO_NETWORK_LOG: join(dir, 'missing-directory', 'x.log') }),
    });
    assert.equal(r.stdout.trim(), 'rejected true');
    assert.equal(r.stderr, '');
  });

  it('fetch and dns.promises reject (they do not throw synchronously), the callback APIs throw synchronously', async () => {
    const code = `
      const kinds = [];
      let p;
      try { p = fetch('http://192.0.2.1:9/'); kinds.push('fetch:promise'); } catch (e) { kinds.push('fetch:throws'); }
      p.catch(() => {});
      try { p = require('dns').promises.resolve4('example.invalid'); kinds.push('dns.promises:promise'); } catch (e) { kinds.push('dns.promises:throws'); }
      p.catch(() => {});
      try { require('dns').lookup('example.invalid', () => {}); kinds.push('dns.lookup:returns'); } catch (e) { kinds.push('dns.lookup:throws'); }
      console.log(kinds.join(','));`;
    const p = await probe(['-e', code]);
    assert.equal(p.stdout.trim(), 'fetch:promise,dns.promises:promise,dns.lookup:throws');
  });

  it('appends to an existing log (earlier lines are kept) and every process adds its own lines', async () => {
    const logFile = join(dir, 'append.log');
    writeFileSync(logFile, 'earlier\n');
    for (let i = 0; i < 2; i++) {
      const r = await runNode(['--require', GUARD, '-e', 'try { require("net").connect(9, "192.0.2.1"); } catch (e) {}'], { cwd: dir, env: baseEnv({ GCR_NO_NETWORK_LOG: logFile }) });
      assert.equal(r.code, 0);
    }
    assert.deepEqual(linesOf(logFile), ['earlier', 'net.connect', 'net.connect']);
  });
});

describe('scripts/no-network-guard.cjs: how it is installed', () => {
  it('works through NODE_OPTIONS and is inherited by grandchildren', async () => {
    const logFile = join(dir, 'options.log');
    const loadedFile = join(dir, 'options-loaded.log');
    const inner = 'try { fetch("http://192.0.2.1:9/").catch(() => {}); } catch (e) {}';
    const outer = `const r = require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'inherit' }); process.exitCode = r.status;`;
    const r = await runNode(['-e', outer], { cwd: dir, env: baseEnv({ NODE_OPTIONS: `--require=${GUARD}`, GCR_NO_NETWORK_LOG: logFile, GCR_NO_NETWORK_LOADED_LOG: loadedFile }) });
    assert.equal(r.code, 0);
    assert.deepEqual(linesOf(logFile), ['fetch'], 'the grandchild was guarded too');
    assert.equal(linesOf(loadedFile).length, 2, 'the guard loaded in the child and in the grandchild');
  });

  it('GCR_NO_NETWORK_LOADED_LOG gets one line (the pid) per process, and loading the guard twice does not add a second one', async () => {
    const once = await probe(['-e', '1']);
    assert.equal(once.loaded.length, 1);
    assert.match(once.loaded[0] ?? '', /^\d+$/);
    const twice = await probe(['-e', '1'], {}, true);
    assert.equal(twice.loaded.length, 1);
    assert.deepEqual(once.log, [], 'loading is not a network attempt');
  });

  it('named ESM imports see the patched functions too (import { connect } from "node:net")', async () => {
    const p = await probe([
      '--input-type=module',
      '-e',
      `import { connect } from 'node:net'; import { lookup } from 'node:dns'; import { get } from 'node:http';
       const seen = [];
       for (const f of [() => connect(9, '192.0.2.1'), () => lookup('example.invalid', () => {}), () => get('http://192.0.2.1:9/')]) {
         try { f(); seen.push('none'); } catch (e) { seen.push(e.message.startsWith('GCR_NO_NETWORK_GUARD:') ? 'blocked' : 'other'); }
       }
       console.log(seen.join(','));`,
    ]);
    assert.equal(p.stdout.trim(), 'blocked,blocked,blocked');
    assert.deepEqual(p.log, ['net.connect', 'dns.lookup', 'http.get']);
  });

  it('the guard file itself holds no address, URL or host: it only wraps functions', () => {
    const source = readFileSync(GUARD, 'utf8');
    assert.ok(!/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(source), 'no IP address literal');
    assert.ok(!/https?:\/\/|wss?:\/\//.test(source), 'no URL literal');
    assert.ok(source.startsWith("'use strict';"), 'strict mode');
  });
});
