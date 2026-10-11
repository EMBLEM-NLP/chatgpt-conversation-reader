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
 * request + get, http2.connect, dgram.Socket#send/bind/connect, child_process spawn/exec/execFile (+ Sync) when the
 * program is curl, wget, ssh, nc and relatives, and globalThis.fetch, WebSocket, XMLHttpRequest, EventSource when present.
 * Async APIs (fetch, dns.promises) return a rejected promise instead of throwing, so `await` and `.catch` both see it.
 *
 * NOT blocked, on purpose: stdio and process IPC (they never go through net.Socket#connect), Unix-domain sockets and
 * named pipes (a `path`), listening on a `path` or an inherited handle/fd, and any child process that is not a network
 * client. Everything else, loopback TCP included, is "network".
 *
 * Optional second file: GCR_NO_NETWORK_LOADED_LOG gets one line "<pid>" when the guard loads. A runner that spawns N
 * processes can then check that N lines exist, i.e. that the guard really was active in every one of them (an empty
 * GCR_NO_NETWORK_LOG proves nothing for a process that never loaded the guard).
 *
 * This is a TEST AID that makes accidental network use loud. It is not a security boundary: native addons, internal
 * bindings, a program that edits its own module cache before this file runs, or a process started without the preload
 * are not covered.
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
  record(process.env.GCR_NO_NETWORK_LOADED_LOG, String(process.pid));

  /** The error for a blocked API; also writes the log line. The message carries the API name only. */
  const denied = (api) => {
    record(logFile, api);
    return new Error(`${PREFIX} ${api} is blocked: this process must not use the network`);
  };

  /** Replace obj[name] by a thrower (or a rejecter when `async`). `allow(this, args)` lets local-only uses through. */
  function block(obj, name, api, { async = false, allow } = {}) {
    if (obj === null || obj === undefined) return;
    const original = obj[name];
    if (typeof original !== 'function') return;
    const guarded = function (...args) {
      if (allow !== undefined && allow.call(this, args)) return Reflect.apply(original, this, args);
      const error = denied(api);
      if (async) return Promise.reject(error);
      throw error;
    };
    Object.defineProperty(guarded, 'name', { value: original.name, configurable: true });
    Object.defineProperty(obj, name, { value: guarded, writable: true, configurable: true, enumerable: Object.prototype.propertyIsEnumerable.call(obj, name) });
  }

  // ---- net: TCP is network, a `path` (Unix-domain socket / named pipe) or a file descriptor is local ----------------
  // connect(options | port, host | path) and listen(options | port, host | path | handle); node:net also passes a
  // normalized array [options, callback] to Socket#connect internally.
  const unwrap = (a) => (Array.isArray(a) ? a[0] : a);
  const isLocalConnect = (args) => {
    const first = unwrap(args[0]);
    if (first !== null && typeof first === 'object') return typeof first.path === 'string';
    return typeof first === 'string' && !/^\d+$/.test(first);
  };
  const isLocalListen = (args) => {
    const first = unwrap(args[0]);
    if (first !== null && typeof first === 'object') return typeof first.path === 'string' || typeof first.fd === 'number' || 'handle' in first || '_handle' in first;
    return typeof first === 'string' && !/^\d+$/.test(first);
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
  block(require('node:http2'), 'connect', 'http2.connect');

  // ---- dgram: creating a socket is inert; talking is not -----------------------------------------------------------------
  const dgram = require('node:dgram');
  for (const name of ['send', 'bind', 'connect']) block(dgram.Socket.prototype, name, `dgram.Socket.${name}`);

  // ---- child processes that are network clients ---------------------------------------------------------------------------
  const NETWORK_PROGRAM = /(?:^|[\s;&|`(])(?:\S*\/)?(?:curl|wget|ssh|scp|sftp|nc|ncat|netcat|telnet|ftp)(?:\.exe)?(?=$|[\s;&|)`"'])/i;
  const SHELLS = /^(?:ba|z|da|k|c|tc)?sh$|^cmd(?:\.exe)?$|^pwsh$|^powershell(?:\.exe)?$/i;
  /** exec/execSync take a SHELL command line; the others take a program (judged by its name) unless a shell is involved. */
  const isNetworkClient = (shellCommand, args) => {
    const file = typeof args[0] === 'string' ? args[0] : '';
    const rest = Array.isArray(args[1]) ? args[1].filter((a) => typeof a === 'string') : [];
    const withShell = args.some((a) => a !== null && typeof a === 'object' && !Array.isArray(a) && a.shell);
    if (shellCommand || withShell || SHELLS.test(path.basename(file))) return NETWORK_PROGRAM.test([file, ...rest].join(' '));
    return NETWORK_PROGRAM.test(path.basename(file));
  };
  const cp = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const shellCommand = name === 'exec' || name === 'execSync';
    block(cp, name, `child_process.${name}`, { allow: (args) => !isNetworkClient(shellCommand, args) });
  }

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
