'use strict';
/**
 * Network tripwire for tests and CI smoke runs: `node --require ./scripts/no-network-guard.cjs ...` (or via NODE_OPTIONS).
 *
 * GCR contains no network code (ADR-0010, test/security/no-network.test.js scans src/). This preload proves the same
 * thing at RUN time: every way a Node program can reach a network that this file knows about is replaced by a function
 * that throws an Error whose message starts with "GCR_NO_NETWORK_GUARD:" and appends one line to the file named by
 * GCR_NO_NETWORK_LOG (when set). The line is the API name only ("net.Socket.connect", "fetch"): never an argument, host,
 * URL or payload.
 *
 * Patched: net.Socket#connect, net.connect, net.createConnection, net.Server#listen (so http servers too), tls.connect,
 * dns (callback API, dns.promises and both Resolver classes: lookup, lookupService, reverse, resolve*), http/https
 * request + get, http2.connect, dgram.Socket#send/bind/connect, inspector.open (a listening debugger port),
 * process.binding of the socket/DNS bindings, process.dlopen (a native addon can do anything and cannot be audited),
 * child_process spawn/exec/execFile (+ Sync) and process.execve when the program is a network client (curl, wget, ssh, nc,
 * ... also behind a launcher such as env/xargs/busybox or inside a shell command line, and a symlink to one) or an
 * interpreter script that opens a socket or a URL, and globalThis.fetch, WebSocket, XMLHttpRequest, EventSource when
 * present. Async APIs (fetch, dns.promises) return a rejected promise instead of throwing, so `await` and `.catch` both
 * see it.
 *
 * Children keep the guard: every child_process call and every worker thread is rewritten so that its environment carries
 * `NODE_OPTIONS=--require=<this file>` (and the two log variables), whatever `env` or `execArgv` the caller passed or
 * deleted. A Node child or worker therefore runs under the same guard.
 *
 * NOT blocked, on purpose: stdio and process IPC (they never go through net.Socket#connect), Unix-domain sockets and
 * named pipes (a non-empty `path` that is not a number), listening on a file descriptor or a non-TCP handle, and any
 * child process that is not a network client. Everything else, loopback TCP included, is "network".
 *
 * Optional second file: GCR_NO_NETWORK_LOADED_LOG gets one line "<pid>" when the guard loads in a process (not in its
 * worker threads). A runner that spawns N processes can then check that N lines exist, i.e. that the guard really was
 * active in every one of them (an empty GCR_NO_NETWORK_LOG proves nothing for a process that never loaded the guard).
 *
 * This is a TEST AID that makes accidental network use loud. It is not a security boundary. Known limits: a process that
 * was started without the preload; flags such as --expose-internals in the caller's own command line; a non-Node program
 * that opens a socket without being recognised as a network client (a COPY of curl under another name, a compiled
 * helper, docker, a script in a language the interpreter rule does not know); and anything that happens before this file
 * runs. Windows behaviour is untested.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const MARK = Symbol.for('gcr.noNetworkGuard.installed');
if (!globalThis[MARK]) {
  Object.defineProperty(globalThis, MARK, { value: true });
  install();
}

function install() {
  const PREFIX = 'GCR_NO_NETWORK_GUARD:';
  const GUARD_FILE = __filename;
  // Captured before anything is patched; a failing log write must never hide the error that is about to be thrown.
  const appendFileSync = fs.appendFileSync.bind(fs);
  const record = (file, line) => {
    if (typeof file !== 'string' || file === '') return;
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      /* the guard's own bookkeeping is best effort */
    }
  };
  const logFile = process.env.GCR_NO_NETWORK_LOG;
  if (require('node:worker_threads').isMainThread) record(process.env.GCR_NO_NETWORK_LOADED_LOG, String(process.pid));

  /** The error for a blocked API; also writes the log line. The message carries the API name only. */
  const denied = (api) => {
    record(logFile, api);
    return new Error(`${PREFIX} ${api} is blocked: this process must not use the network`);
  };

  /**
   * Replace obj[name] by a thrower (or a rejecter when `async`). `allow(args)` lets local-only uses through (it is called
   * with `this` bound to the receiver); `rewrite(args)` changes the arguments of a call that is let through.
   */
  function block(obj, name, api, { async = false, allow, rewrite } = {}) {
    if (obj === null || obj === undefined) return;
    const original = obj[name];
    if (typeof original !== 'function') return;
    const guarded = function (...args) {
      if (allow !== undefined && allow.call(this, args)) return Reflect.apply(original, this, rewrite === undefined ? args : rewrite(args));
      const error = denied(api);
      if (async) return Promise.reject(error);
      throw error;
    };
    Object.defineProperty(guarded, 'name', { value: original.name, configurable: true });
    Object.defineProperty(obj, name, { value: guarded, writable: true, configurable: true, enumerable: Object.prototype.propertyIsEnumerable.call(obj, name) });
  }

  // ---- net: TCP is network, a `path` (Unix-domain socket / named pipe) or a file descriptor is local ----------------
  // This mirrors how node:net itself reads its arguments (normalizeArgs, Server#listen), because a guard that reads them
  // differently is bypassed by the difference: a string that is a NUMBER ('0x1f90', ' 80', '8e1') is a port, not a pipe
  // name; an empty `path` is no path; and in listen() a `port` wins over a `path`. node:net also passes a normalized
  // array [options, callback] to Socket#connect internally.
  const unwrap = (a) => (Array.isArray(a) ? a[0] : a);
  const isPipeName = (s) => typeof s === 'string' && !(Number(s) >= 0);
  const isLocalConnect = (args) => {
    const first = unwrap(args[0]);
    if (first !== null && typeof first === 'object') return typeof first.path === 'string' && first.path !== '';
    return isPipeName(first);
  };
  const isLocalListen = (args) => {
    const first = unwrap(args[0]);
    if (first !== null && typeof first === 'object') {
      const target = first._handle || first.handle || first;
      if (target !== first) return target.constructor !== undefined && target.constructor.name !== 'TCP'; // a handle: local unless it is a TCP handle
      if (typeof first.fd === 'number' && first.fd >= 0) return true; // an already open descriptor
      if (typeof first.port === 'number' || typeof first.port === 'string' || ('port' in first && (first.port === undefined || first.port === null))) return false; // TCP wins over path
      return typeof first.path === 'string' && isPipeName(first.path);
    }
    return isPipeName(first);
  };
  const net = require('node:net');
  block(net.Socket.prototype, 'connect', 'net.Socket.connect', { allow: isLocalConnect });
  block(net, 'connect', 'net.connect', { allow: isLocalConnect });
  block(net, 'createConnection', 'net.createConnection', { allow: isLocalConnect });
  block(net.Server.prototype, 'listen', 'net.Server.listen', { allow: isLocalListen });

  block(require('node:tls'), 'connect', 'tls.connect');

  // ---- dns ------------------------------------------------------------------------------------------------------------
  const dns = require('node:dns');
  const DNS_NAME = /^(lookup|lookupService|reverse|resolve[A-Za-z0-9]*)$/;
  const blockDns = (obj, label, async) => {
    if (obj === null || obj === undefined) return;
    for (const name of Object.getOwnPropertyNames(obj)) if (DNS_NAME.test(name)) block(obj, name, `${label}.${name}`, { async });
  };
  blockDns(dns, 'dns', false);
  blockDns(dns.Resolver && dns.Resolver.prototype, 'dns.Resolver', false);
  blockDns(dns.promises, 'dns.promises', true);
  blockDns(dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype, 'dns.promises.Resolver', true);

  // ---- http, https, http2 -----------------------------------------------------------------------------------------------
  const http = require('node:http');
  const https = require('node:https');
  for (const name of ['request', 'get']) {
    block(http, name, `http.${name}`);
    block(https, name, `https.${name}`);
  }
  // http.Agent keeps the net.createConnection it saw when node:http loaded; patch the copy as well so load order cannot matter.
  block(http.Agent && http.Agent.prototype, 'createConnection', 'http.Agent.createConnection', { allow: isLocalConnect });
  block(require('node:http2'), 'connect', 'http2.connect');

  // ---- dgram: creating a socket is inert; talking is not -----------------------------------------------------------------
  const dgram = require('node:dgram');
  for (const name of ['send', 'bind', 'connect']) block(dgram.Socket.prototype, name, `dgram.Socket.${name}`);

  // ---- the debugger port, raw bindings, native addons ---------------------------------------------------------------------
  for (const id of ['node:inspector', 'node:inspector/promises']) {
    try {
      // node:inspector/promises keeps its own reference to open(), so both modules are patched.
      const inspector = require(id);
      block(inspector, 'open', 'inspector.open');
      block(inspector, 'waitForDebugger', 'inspector.waitForDebugger');
    } catch {
      /* a Node built without the inspector has nothing to open */
    }
  }
  // process.binding is the way to reach the same C++ wrappers node:net uses, below every JavaScript patch above.
  const NETWORK_BINDINGS = new Set(['tcp_wrap', 'udp_wrap', 'cares_wrap', 'tls_wrap', 'js_udp_wrap']);
  block(process, 'binding', 'process.binding', { allow: (args) => !NETWORK_BINDINGS.has(String(args[0])) });
  block(process, 'dlopen', 'process.dlopen');

  // ---- child processes -------------------------------------------------------------------------------------------------------
  const NETWORK_NAMES = 'curl|wget|ssh|scp|sftp|nc|ncat|netcat|telnet|ftp|tftp|socat|nmap|ping6?|dig|nslookup|getent|traceroute|mtr|rsync|aria2c|lynx';
  const NETWORK_PROGRAM = new RegExp(`(?:^|[\\s;&|\`(/])(?:${NETWORK_NAMES})(?:\\.exe)?(?=$|[\\s;&|)\`"'])`, 'i');
  const IS_SHELL = /^(?:ba|z|da|k|c|tc)?sh$|^cmd(?:\.exe)?$|^pwsh$|^powershell(?:\.exe)?$/i;
  // Programs whose arguments contain the program that really runs (or a command line): their whole argv is read.
  const IS_LAUNCHER = /^(?:env|xargs|nice|nohup|timeout|stdbuf|setsid|ionice|taskset|sudo|doas|su|runuser|chroot|flock|unshare|nsenter|strace|ltrace|watch|parallel|find|busybox|command|exec|time|script|expect)$/i;
  // Interpreters: only judged when the script on their command line opens a socket or a URL (a plain `python script.py` is not).
  const IS_INTERPRETER = /^(?:python[0-9.]*|perl|ruby|php|lua|tclsh|wish|pwsh|powershell)(?:\.exe)?$/i;
  const SOCKET_CODE = /\b(?:socket|urllib|http\.client|httplib|requests|IO::Socket|LWP|Net::|net\/http|open-uri|curl_init|fsockopen|stream_socket_client)\b|\b(?:https?|ftps?|wss?|sftp|tcp|udp|rsync):\/\//i;
  const DEV_SOCKET = /\/dev\/(?:tcp|udp)\//;
  const cp = require('node:child_process');

  /** Where `file` really is (PATH lookup, then symlinks resolved), so that `foo -> /usr/bin/curl` is still curl. */
  const realBase = (file) => {
    try {
      let found = file;
      if (!file.includes('/')) {
        found = '';
        for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
          if (dir !== '' && fs.existsSync(path.join(dir, file))) {
            found = path.join(dir, file);
            break;
          }
        }
      }
      return found === '' ? '' : path.basename(fs.realpathSync(found));
    } catch {
      return '';
    }
  };
  /** true when running `file args` would use the network: judged by the program's name, never by a word in a plain argument. */
  const isNetworkClient = (shellCommand, args) => {
    const file = typeof args[0] === 'string' ? args[0] : '';
    const rest = Array.isArray(args[1]) ? args[1].filter((a) => typeof a === 'string') : [];
    const options = args.find((a) => a !== null && typeof a === 'object' && !Array.isArray(a));
    const text = [file, ...rest].join(' ');
    const base = path.basename(file);
    if (shellCommand || (options !== undefined && options.shell) || IS_SHELL.test(base)) return NETWORK_PROGRAM.test(text) || DEV_SOCKET.test(text);
    if (NETWORK_PROGRAM.test(base) || NETWORK_PROGRAM.test(` ${realBase(file)} `)) return true;
    if (IS_LAUNCHER.test(base)) return NETWORK_PROGRAM.test(text) || DEV_SOCKET.test(text) || SOCKET_CODE.test(text);
    if (IS_INTERPRETER.test(base)) return SOCKET_CODE.test(text);
    return false; // a Node child is guarded from the inside (see below); any other program is judged by its name only
  };

  /** NODE_OPTIONS (and the two log variables) of an environment, so that a Node child or worker loads this guard. */
  const guardEnv = (env) => {
    const out = { ...(env !== null && typeof env === 'object' ? env : process.env) };
    const options = String(out.NODE_OPTIONS || '');
    if (!options.includes(GUARD_FILE)) out.NODE_OPTIONS = `${options} --require=${/\s/.test(GUARD_FILE) ? `"${GUARD_FILE}"` : GUARD_FILE}`.trim();
    for (const key of ['GCR_NO_NETWORK_LOG', 'GCR_NO_NETWORK_LOADED_LOG']) if (out[key] === undefined && process.env[key] !== undefined) out[key] = process.env[key];
    return out;
  };
  /** The arguments of a child_process call with the options object (inserted if missing) carrying a guarded `env`. */
  const withGuardEnv = (args, takesArgsArray) => {
    const out = [...args];
    let i = 1;
    if (takesArgsArray && (Array.isArray(out[i]) || ((out[i] === undefined || out[i] === null) && out.length > 2))) i++;
    const isOptions = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (isOptions(out[i])) out[i] = { ...out[i], env: guardEnv(out[i].env) };
    else out.splice(i, 0, { env: guardEnv(undefined) }); // before a callback or at the end
    return out;
  };
  const CHILD_CALLS = [
    ['spawn', false, true],
    ['spawnSync', false, true],
    ['exec', true, false],
    ['execSync', true, false],
    ['execFile', false, true],
    ['execFileSync', false, true],
  ];
  for (const [name, shellCommand, takesArgsArray] of CHILD_CALLS) {
    block(cp, name, `child_process.${name}`, { allow: (args) => !isNetworkClient(shellCommand, args), rewrite: (args) => withGuardEnv(args, takesArgsArray) });
  }
  block(cp, 'fork', 'child_process.fork', { allow: () => true, rewrite: (args) => withGuardEnv(args, true) });
  // process.execve replaces this process by another program: judged like spawn, and the new image gets the guard too.
  if (typeof process.execve === 'function') {
    block(process, 'execve', 'process.execve', {
      allow: (args) => !isNetworkClient(false, [args[0], Array.isArray(args[1]) ? args[1].slice(1) : []]),
      rewrite: (args) => [args[0], args[1], guardEnv(args[2])],
    });
  }

  // ---- worker threads: a worker has its own copy of every module, so it must load the guard itself ------------------------------
  const workerThreads = require('node:worker_threads');
  const OriginalWorker = workerThreads.Worker;
  class Worker extends OriginalWorker {
    constructor(filename, options) {
      const o = { ...(options !== null && typeof options === 'object' ? options : {}) };
      const execArgv = Array.isArray(o.execArgv) ? [...o.execArgv] : [...process.execArgv];
      if (!execArgv.some((a) => String(a).includes(GUARD_FILE))) execArgv.push('--require', GUARD_FILE);
      o.execArgv = execArgv;
      if (o.env !== null && typeof o.env === 'object' && o.env !== process.env) o.env = guardEnv(o.env);
      super(filename, o);
    }
  }
  Object.defineProperty(Worker, 'name', { value: 'Worker', configurable: true });
  Object.defineProperty(workerThreads, 'Worker', { value: Worker, writable: true, configurable: true, enumerable: true });

  // ---- web-style globals, when this Node has them -------------------------------------------------------------------------
  const replaceGlobal = (name, replacement) => {
    if (typeof globalThis[name] !== 'function') return;
    Object.defineProperty(globalThis, name, { value: replacement, writable: true, configurable: true, enumerable: false });
  };
  replaceGlobal('fetch', Object.defineProperty(async function fetch() { throw denied('fetch'); }, 'name', { value: 'fetch' }));
  for (const name of ['WebSocket', 'XMLHttpRequest', 'EventSource']) {
    replaceGlobal(name, Object.defineProperty(function guarded() { throw denied(name); }, 'name', { value: name }));
  }

  // `import { connect } from 'node:net'` reads live bindings that only follow the CommonJS object after this call.
  Module.syncBuiltinESMExports();
}
