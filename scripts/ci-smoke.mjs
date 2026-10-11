#!/usr/bin/env node
/**
 * End-to-end smoke test of the BUILT product (dist/) on synthetic data: SPEC NFR-02/NFR-03, CODEX_TASK Phase 3
 * ("fixture-import smoke tests", "CI MUST require no ChatGPT login and no secrets", "real MCP-client smoke").
 *
 *   npm run smoke                       builds, then runs this script
 *   node scripts/ci-smoke.mjs           run against ./dist (npm run build first)
 *   node scripts/ci-smoke.mjs --dist <dir> [--fixtures <dir>] [--keep-temp]
 *
 * What it does, in a fresh temp directory that is removed in `finally`:
 *  1. zips the 13 fixtures/chatgpt/*.json files (every one must carry GCR-SYNTHETIC-FIXTURE) plus two auxiliary decoy files
 *     that hold a random CANARY string, using an inline STORE-method ZIP writer (nothing from test/ is imported);
 *  2. drives the built CLI (`dist/cli/main.js`) through import, idempotent re-import, every read command in all four
 *     formats, the error contracts, drafts and annotations, graph build and export;
 *  3. drives the built MCP server (`dist/mcp/entry.js`) over REAL stdio with the SDK client (read-only default, then
 *     writes enabled on a COPY of the database) and with a raw pipe that validates every byte of stdout;
 *  4. proves that the canary appears nowhere (outputs, database, exported HTML) and that the network guard fired never
 *     and was active in every process that was started.
 *
 * Every product process runs with NODE_OPTIONS=--require=<scripts/no-network-guard.cjs>, GCR_NO_NETWORK_LOG set and
 * HTTP_PROXY/HTTPS_PROXY/ALL_PROXY pointing at an unroutable address, so any attempt to use the network throws and is
 * recorded. Nothing here talks to a network; the only sockets are the stdio pipes of the child processes.
 *
 * Output: one line per check, "PASS <name>" or "FAIL <name>: <reason>". Reasons carry numbers, codes and names, never
 * message text, titles, absolute paths or the canary. Last line: "SMOKE OK (<n> checks)" and exit 0, otherwise exit 1.
 * Exit 2 means the smoke could not start (no build, no fixtures).
 *
 * Pinned expectations (EXPECTED below) describe the 13 fixtures as the importer understands them today. They are
 * deliberately concrete so a broken importer cannot pass vacuously; when a fixture or an importer rule changes on purpose,
 * review the difference and update EXPECTED in the same commit.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = join(repoRoot, 'scripts', 'no-network-guard.cjs');

// ------------------------------------------------------------------------------------------------------------------
// Expectations about the synthetic fixtures (see the header comment before changing a number)
// ------------------------------------------------------------------------------------------------------------------

/** The fixtures that make up the smoke export, in the order of their shard numbers. Extra files in the folder are ignored. */
const FIXTURE_FILES = [
  'attachments-citations.json',
  'branching.json',
  'broken-trees.json',
  'content-types.json',
  'duplicate-keys.json',
  'hostile-strings.json',
  'identity-collisions.json',
  'minimal-linear.json',
  'multimodal-parts.json',
  'nulls-and-wrappers.json',
  'numbers-and-time.json',
  'trimmed-2026.json',
  'wrapper-object.json',
];
const MARKER = 'GCR-SYNTHETIC-FIXTURE';

const EXPECTED = {
  conversationsRead: 35, // array elements over all shards (wrapper-object.json counts as one)
  conversationsStored: 28, // distinct conversations kept after validation and identity rules
  messagesStored: 142, // message nodes in the database, structural placeholders included
  messagesStructural: 26,
  visibleMessages: 109, // non-hidden, non-structural messages (what stats counts)
  auditedMessages: 116, // non-structural messages (what audit scans), hidden ones included
  graphMessagesScanned: 109,
};
const IDS = {
  linear: '00000000-0000-4000-8000-000000000001', // F01: two messages, a valid current node
  branching: '00000000-0000-4000-8000-000000000002', // F02: three branches, active one named by the export
  hostile: '00000000-0000-4000-8000-000000000009', // F09: control characters, bidi, lone surrogates in titles and text
  absent: '00000000-0000-4000-8000-0000000000ff', // in no fixture
};
const F01_MESSAGES = ['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000011'];
const F02_ACTIVE_BRANCH = '00000000-0000-4000-8000-000000000013';

const READ_TOOLS = ['gcr_list', 'gcr_get', 'gcr_search', 'gcr_branches', 'gcr_thread', 'gcr_stats', 'gcr_audit', 'gcr_graph_query', 'gcr_doctor'];
const WRITE_TOOLS = ['gcr_create_local_draft', 'gcr_update_local_annotation', 'gcr_import_export'];
const DOCUMENTED_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS].sort();
const COMPLETENESS = ['exported_tree', 'rendered_active_view_only', 'partial_user_supplied', 'api_owned_conversation', 'unknown', 'mixed'];

// ------------------------------------------------------------------------------------------------------------------
// Arguments
// ------------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dist: join(repoRoot, 'dist'), fixtures: join(repoRoot, 'fixtures', 'chatgpt'), keepTemp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist' && argv[i + 1] !== undefined) opts.dist = resolve(argv[++i]);
    else if (a === '--fixtures' && argv[i + 1] !== undefined) opts.fixtures = resolve(argv[++i]);
    else if (a === '--keep-temp') opts.keepTemp = true;
    else {
      process.stderr.write('ci-smoke: unknown argument. usage: node scripts/ci-smoke.mjs [--dist <dir>] [--fixtures <dir>] [--keep-temp]\n');
      process.exit(2);
    }
  }
  return opts;
}
const opts = parseArgs(process.argv.slice(2));
const CLI_JS = join(opts.dist, 'cli', 'main.js');
const MCP_JS = join(opts.dist, 'mcp', 'entry.js');
for (const file of [CLI_JS, MCP_JS, guardPath]) {
  if (!existsSync(file)) {
    process.stderr.write(`ci-smoke: ${basename(file)} not found (run "npm run build" first, or pass --dist <dir>).\n`);
    process.exit(2);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Assertions: reasons never contain content
// ------------------------------------------------------------------------------------------------------------------

class SmokeFailure extends Error {}
const fail = (reason) => {
  throw new SmokeFailure(reason);
};
const must = (condition, reason) => {
  if (!condition) fail(reason);
};
/** Values that are safe to print: numbers, booleans, null, and short code-like tokens. Anything else is described by its size. */
function show(v) {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return /^[A-Za-z0-9_.:-]{1,48}$/.test(v) ? v : `<string of ${v.length} chars>`;
  if (Array.isArray(v)) return `<array of ${v.length}>`;
  return '<object>';
}
const same = (actual, expected, what) => {
  if (!Object.is(actual, expected)) fail(`${what}: got ${show(actual)}, expected ${show(expected)}`);
};
const deepSame = (actual, expected, what) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${what}: values differ`);
};

const results = [];
/** MCP sessions that are still open; the final `finally` closes whatever a failed check left behind. */
const openSessions = [];
async function check(name, fn) {
  // Convention (the tests parse FAIL lines with it): "<area>: <what>", exactly one ": " in a name; reasons may contain more.
  if ((name.match(/: /g) ?? []).length !== 1) throw new Error('check names contain exactly one ": "');
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    // Only our own reasons are printed; an unexpected error is described by its class and system code, never its message.
    const reason = e instanceof SmokeFailure ? e.message : `unexpected ${e?.name ?? 'error'}${typeof e?.code === 'string' ? ` (${e.code})` : ''}`;
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${reason}`);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// A minimal STORE-method ZIP writer (no compression, no ZIP64, UTF-8 names). Local to this script on purpose.
// ------------------------------------------------------------------------------------------------------------------

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method 0 = STORE
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x0021, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

// ------------------------------------------------------------------------------------------------------------------
// State, process helpers
// ------------------------------------------------------------------------------------------------------------------

/** 16 random hex digits: a value no product has any reason to emit. Assembled at run time, never written down literally. */
const CANARY_HEX = randomBytes(8).toString('hex');
const CANARY = ['GCR', 'CANARY', CANARY_HEX].join('-');
const PROXY = 'http://192.0.2.1:9'; // TEST-NET-1: unroutable by definition

const st = {
  work: '',
  home: '',
  tmp: '',
  db: '',
  zip: '',
  guardLog: '',
  loadedLog: '',
  zipBytes: null,
  fixtureElementCounts: [],
  ledger: [], // every byte any product process wrote to stdout or stderr
  spawned: 0, // product processes started (each must have loaded the guard)
  version: '',
};

/** The only environment a product process gets: nothing from the caller's environment leaks in or out. */
function childEnv(extra = {}) {
  const guard = /\s/.test(guardPath) ? `"${guardPath}"` : guardPath;
  return {
    PATH: process.env.PATH ?? '',
    HOME: st.home,
    TMPDIR: st.tmp,
    TZ: 'UTC',
    NO_COLOR: '1',
    NODE_OPTIONS: `--require=${guard}`,
    GCR_NO_NETWORK_LOG: st.guardLog,
    GCR_NO_NETWORK_LOADED_LOG: st.loadedLog,
    HTTP_PROXY: PROXY,
    HTTPS_PROXY: PROXY,
    ALL_PROXY: PROXY,
    http_proxy: PROXY,
    https_proxy: PROXY,
    all_proxy: PROXY,
    GCR_DB: st.db,
    ...extra,
  };
}

/** Run `node <script> ...args` with the guarded environment. Resolves with the exit code and both streams; never rejects. */
function runNode(script, args, { stdin = '', env = {}, timeoutMs = 45_000 } = {}) {
  st.spawned++;
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: st.work, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      st.ledger.push(stdout, stderr);
      resolveRun({ code, signal, timedOut, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutBytes: stdout });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {});
    child.on('error', () => {
      st.spawned--; // never started, so it never loaded the guard
      finish(-1, null);
    });
    child.on('close', finish);
    child.stdin.end(stdin);
  });
}
const cli = (args, o) => runNode(CLI_JS, args, o);

const parseJson = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what}: not valid JSON (${text.length} chars)`);
  }
};
/** The error code of a failed CLI run, whichever format it was printed in. */
function errorCodeOf(r) {
  const text = r.stderr.trim();
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text)?.error?.code ?? 'none';
    } catch {
      return 'unparseable';
    }
  }
  return /^error\[([A-Z_]+)\]/.exec(text)?.[1] ?? 'none';
}
const expectOk = (r, what) => {
  if (r.timedOut) fail(`${what}: timed out`);
  if (r.code !== 0) fail(`${what}: exit ${r.code}, error code ${errorCodeOf(r)}`);
  if (r.stderr !== '') fail(`${what}: stderr is not empty (${r.stderr.length} chars)`);
};
const expectError = (r, what, exit, code) => {
  if (r.timedOut) fail(`${what}: timed out`);
  same(r.code, exit, `${what} exit code`);
  same(errorCodeOf(r), code, `${what} error code`);
  same(r.stdout, '', `${what} stdout`);
};

// ------------------------------------------------------------------------------------------------------------------
// Database inspection through node:sqlite (read-only, in this process; never through the product)
// ------------------------------------------------------------------------------------------------------------------

let DatabaseSync;
async function loadSqlite() {
  if (DatabaseSync) return;
  // node:sqlite prints an ExperimentalWarning when it loads; keep this runner's own stderr clean.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
  ({ DatabaseSync } = await import('node:sqlite'));
  process.emitWarning = emit;
}

/** Calls fn(db) with a read-only connection and closes it. */
function withDb(path, fn) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const countRows = (path, table) => withDb(path, (db) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get().n));

/** SHA-256 over every row of every table (virtual and shadow tables included): equal hash = equal content. */
function dbContentHash(path) {
  return withDb(path, (db) => {
    const h = createHash('sha256');
    for (const name of tableNames(db)) {
      h.update(`\u0001${name}\u0001`);
      for (const row of db.prepare(`SELECT * FROM ${quote(name)}`).iterate()) {
        for (const v of Object.values(row)) {
          if (v instanceof Uint8Array) h.update(Buffer.concat([Buffer.from('b:'), Buffer.from(v)]));
          else h.update(`${typeof v}:${String(v)}`);
          h.update('\u0000');
        }
        h.update('\n');
      }
    }
    return h.digest('hex');
  });
}

/** true when any text or blob value in any table contains one of the needle strings (all tables, all columns). */
function dbContains(path, needleStrings) {
  const needleBuffers = needleStrings.map((n) => Buffer.from(n));
  return withDb(path, (db) => {
    for (const name of tableNames(db)) {
      for (const row of db.prepare(`SELECT * FROM ${quote(name)}`).iterate()) {
        for (const v of Object.values(row)) {
          if (typeof v === 'string' && needleStrings.some((n) => v.includes(n))) return true;
          if (v instanceof Uint8Array) {
            const b = Buffer.from(v);
            if (needleBuffers.some((n) => b.includes(n))) return true;
          }
        }
      }
    }
    return false;
  });
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const fileHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const lines = (text) => text.split('\n').filter((l) => l !== '');
const readLines = (path) => (existsSync(path) ? lines(readFileSync(path, 'utf8')) : []);

// ------------------------------------------------------------------------------------------------------------------
// Output validators shared by the read checks
// ------------------------------------------------------------------------------------------------------------------

// Characters a terminal or a line-splitting reader must never receive raw: C0/C1 controls (tab and newline aside), the
// Unicode line/paragraph separators, bidirectional controls and TAG characters. Every format escapes them.
const HAZARD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u;
const noHazards = (text, what) => must(!HAZARD.test(text), `${what}: raw control, bidi or separator character on the wire`);

const FORMATS = ['json', 'markdown', 'compact', 'jsonl'];

/** Parse and validate one run in the given format; returns what the format-specific assertions need. */
function validate(format, r, what) {
  expectOk(r, what);
  must(r.stdout.length > 0, `${what}: stdout is empty`);
  noHazards(r.stdout, what);
  if (format === 'json') {
    const doc = parseJson(r.stdout, what);
    same(doc.ok, true, `${what} ok`);
    must(Array.isArray(doc.source) && doc.source.length >= 1, `${what}: source is missing`);
    same(doc.source[0].provenance, 'official_chatgpt_export', `${what} provenance`);
    must(COMPLETENESS.includes(doc.completeness), `${what}: completeness is not a known value`);
    must(Array.isArray(doc.warnings), `${what}: warnings is not an array`);
    same(doc.tool?.name, 'gcr', `${what} tool name`);
    return { doc };
  }
  if (format === 'jsonl') {
    const rows = lines(r.stdout).map((l, i) => parseJson(l, `${what} line ${i + 1}`));
    must(rows.length >= 2, `${what}: fewer than two lines`);
    const header = rows[0];
    const footer = rows[rows.length - 1];
    same(header.type, 'header', `${what} first line type`);
    same(footer.type, 'footer', `${what} last line type`);
    must(Array.isArray(header.source) && header.source.length >= 1, `${what}: header has no source`);
    same(header.source[0].provenance, 'official_chatgpt_export', `${what} header provenance`);
    must(COMPLETENESS.includes(header.source[0].completeness), `${what}: header completeness is not a known value`);
    must(Array.isArray(footer.warnings), `${what}: footer has no warnings array`);
    return { header, footer, rows };
  }
  if (format === 'markdown') {
    must(r.stdout.startsWith('# '), `${what}: no title`);
    must(r.stdout.includes('official_chatgpt_export'), `${what}: provenance missing`);
    must(/completeness/i.test(r.stdout), `${what}: completeness missing`);
    return {};
  }
  // compact: first line is "# <what> | <provider> | <completeness> | ...", second line carries the provenance
  const [first = '', second = ''] = r.stdout.split('\n');
  must(first.startsWith('# '), `${what}: no header line`);
  must(COMPLETENESS.some((c) => first.includes(` | ${c} |`) || first.endsWith(` | ${c}`)), `${what}: completeness missing from the header line`);
  must(second.includes('provenance=official_chatgpt_export'), `${what}: provenance missing from the source line`);
  return {};
}

/** Run one command in all four formats (two at a time) and hand the parsed results to `assertions`. */
async function readCheck(label, args, assertions) {
  const runs = {};
  await Promise.all(
    FORMATS.map(async (f) => {
      runs[f] = await cli([...args, '--format', f]);
    }),
  );
  const parsed = {};
  for (const f of FORMATS) parsed[f] = validate(f, runs[f], `${label} (${f})`);
  assertions(parsed, runs);
  return parsed;
}

// ------------------------------------------------------------------------------------------------------------------
// The checks
// ------------------------------------------------------------------------------------------------------------------

async function main() {
  await loadSqlite();
  st.work = mkdtempSync(join(tmpdir(), 'gcr-smoke-'));
  st.home = join(st.work, 'home');
  st.tmp = join(st.work, 'tmp');
  mkdirSync(st.home);
  mkdirSync(st.tmp);
  st.db = join(st.work, 'smoke.sqlite');
  st.zip = join(st.work, 'export.zip');
  st.guardLog = join(st.work, 'guard.log');
  st.loadedLog = join(st.work, 'guard-loaded.log');
  writeFileSync(st.guardLog, '');
  writeFileSync(st.loadedLog, '');

  // ---- 1. the guard works, and is the thing every later process runs under ---------------------------------------
  await check('guard: blocks network APIs, logs them, and the preload works through NODE_OPTIONS', async () => {
    const controlLog = join(st.work, 'control.log');
    const controlLoaded = join(st.work, 'control-loaded.log');
    const probe = `
      const out = [];
      const ours = (e) => String(e && e.message).startsWith('GCR_NO_NETWORK_GUARD:');
      const attempt = async (api, f) => { try { await f(); out.push(api + ':none'); } catch (e) { out.push(api + ':' + ours(e)); } };
      (async () => {
        await attempt('fetch', () => fetch('http://192.0.2.1:9/'));
        await attempt('net', () => require('net').connect(9, '192.0.2.1'));
        await attempt('dns', () => require('dns').lookup('example.invalid', () => {}));
        await attempt('http', () => require('http').get('http://192.0.2.1:9/'));
        console.log(out.join(','));
      })();`;
    const r = await new Promise((done) => {
      const child = spawn(process.execPath, ['-e', probe], {
        env: { ...childEnv(), GCR_NO_NETWORK_LOG: controlLog, GCR_NO_NETWORK_LOADED_LOG: controlLoaded },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.resume();
      child.on('close', (code) => done({ code, stdout: Buffer.concat(out).toString('utf8').trim() }));
    });
    same(r.code, 0, 'control process exit code');
    same(r.stdout, 'fetch:true,net:true,dns:true,http:true', 'control process results');
    deepSame(readLines(controlLog), ['fetch', 'net.connect', 'dns.lookup', 'http.get'], 'control log');
    same(readLines(controlLoaded).length, 1, 'control process loaded-log lines');
  });

  // ---- 2. fixtures and archive --------------------------------------------------------------------------------------
  await check('fixtures: 13 synthetic files carry the marker; archive built with two canary decoys', async () => {
    const entries = [];
    st.fixtureElementCounts = [];
    for (const [i, file] of FIXTURE_FILES.entries()) {
      const path = join(opts.fixtures, file);
      must(existsSync(path), `fixture ${i + 1} of ${FIXTURE_FILES.length} is missing`);
      const bytes = readFileSync(path);
      must(bytes.includes(MARKER), `fixture ${i + 1} lacks the synthetic marker`);
      must(!bytes.includes(CANARY_HEX), `fixture ${i + 1} contains the canary`);
      const parsed = JSON.parse(bytes.toString('utf8'));
      st.fixtureElementCounts.push(Array.isArray(parsed) ? parsed.length : 1);
      entries.push({ name: `conversations-${String(i + 1).padStart(3, '0')}.json`, data: bytes });
    }
    // Auxiliary files of a real export hold personal data; the importer must count them by name and never read them.
    entries.push({ name: 'user.json', data: Buffer.from(JSON.stringify({ id: `user-${CANARY_HEX}`, email: `${CANARY}@example.invalid`, phone_number: CANARY })) });
    entries.push({ name: 'message_feedback.json', data: Buffer.from(JSON.stringify([{ id: CANARY, rating: 'thumbs_up', text: CANARY }])) });
    st.zipBytes = buildZip(entries);
    writeFileSync(st.zip, st.zipBytes);
    must(st.zipBytes.includes(CANARY), 'the canary decoy is not in the archive');
    same(st.fixtureElementCounts.reduce((a, b) => a + b, 0), EXPECTED.conversationsRead, 'conversation elements in the fixtures');
  });

  // ---- 3. doctor ------------------------------------------------------------------------------------------------------
  await check('cli: doctor --format json is ok, lists modes A-E and the minimum Node, uses no network', async () => {
    const r = await cli(['doctor', '--format', 'json']);
    expectOk(r, 'doctor');
    const doc = parseJson(r.stdout, 'doctor');
    same(doc.ok, true, 'envelope ok');
    same(doc.data.ok, true, 'doctor ok');
    deepSame(doc.data.modes.map((m) => m.mode), ['A', 'B', 'C', 'D', 'E'], 'capability modes');
    same(doc.data.sqlite.fts5, true, 'FTS5 available');
    const engines = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).engines.node; // ">=22.16.0"
    const minimum = /(\d+\.\d+)/.exec(engines)?.[1];
    must(minimum !== undefined && String(doc.data.node.requiredRange).includes(minimum), 'doctor does not state the minimum Node of package.json');
    same(doc.data.network.used, false, 'doctor network.used');
    const md = await cli(['doctor']);
    expectOk(md, 'doctor markdown');
    must(md.stdout.includes('Capability modes') && md.stdout.includes(minimum), 'doctor markdown lacks the modes or the minimum Node');
    const v = await cli(['--version']);
    expectOk(v, 'version');
    st.version = v.stdout.trim().replace(/^gcr /, '');
    same(doc.data.tool.version, st.version, 'doctor version equals --version');
  });

  // ---- 4. import ------------------------------------------------------------------------------------------------------
  let firstBatch = '';
  await check('cli: import stores the export (13 shards, pinned counts, database mode 0600, quiet stderr)', async () => {
    const r = await cli(['import', st.zip, '--db', st.db, '--format', 'json']);
    expectOk(r, 'import');
    const d = parseJson(r.stdout, 'import').data;
    same(d.alreadyImported, false, 'alreadyImported');
    same(d.provider, 'chatgpt', 'provider');
    same(d.sourceKind, 'zip', 'source kind');
    firstBatch = d.batchId;
    same(d.files.length, FIXTURE_FILES.length, 'shards read');
    for (const [i, f] of d.files.entries()) same(f.conversations + f.failed, st.fixtureElementCounts[i], `elements of shard ${i + 1}`);
    same(d.conversations.read, EXPECTED.conversationsRead, 'conversations read');
    same(d.conversations.stored, EXPECTED.conversationsStored, 'conversations stored');
    same(d.conversations.failed, 0, 'conversations failed');
    same(d.conversations.newlyInserted, EXPECTED.conversationsStored, 'conversations newly inserted');
    same(d.messages.stored, EXPECTED.messagesStored, 'messages stored');
    same(d.messages.newlyInserted, EXPECTED.messagesStored, 'messages newly inserted');
    same(d.messages.structural, EXPECTED.messagesStructural, 'structural messages');
    must(Array.isArray(d.warnings) && d.warnings.length > 0, 'the broken fixtures produced no warnings');
    same(statSync(st.db).mode & 0o777, 0o600, 'database file mode');
    // The same numbers, counted independently in the database file.
    same(countRows(st.db, 'messages'), EXPECTED.messagesStored, 'rows in messages');
    same(countRows(st.db, 'conversations'), EXPECTED.conversationsStored, 'rows in conversations');
    same(countRows(st.db, 'source_batches'), 1, 'rows in source_batches');
  });

  await check('cli: importing the same archive again is alreadyImported with equal counts', async () => {
    const r = await cli(['import', st.zip, '--db', st.db, '--format', 'json']);
    expectOk(r, 'second import');
    const d = parseJson(r.stdout, 'second import').data;
    same(d.alreadyImported, true, 'alreadyImported');
    same(d.batchId, firstBatch, 'batch id');
    same(d.conversations.stored, EXPECTED.conversationsStored, 'conversations stored');
    same(d.messages.stored, EXPECTED.messagesStored, 'messages stored');
    same(d.conversations.newlyInserted, 0, 'conversations newly inserted');
    same(d.messages.newlyInserted, 0, 'messages newly inserted');
    same(countRows(st.db, 'messages'), EXPECTED.messagesStored, 'rows in messages');
    same(countRows(st.db, 'source_batches'), 1, 'rows in source_batches');
  });

  // ---- 5. reads in every format ---------------------------------------------------------------------------------------
  const importedHash = dbContentHash(st.db);
  const sumRows = (rows, key = 'messages') => rows.reduce((a, r) => a + r[key], 0);

  await check('cli read: list (json, markdown, compact, jsonl)', () =>
    readCheck('list', ['list'], (p) => {
      const d = p.json.doc.data;
      same(d.total, EXPECTED.conversationsStored, 'total conversations');
      same(d.items.length, EXPECTED.conversationsStored, 'items on the page');
      same(new Set(d.items.map((i) => i.conversationId)).size, EXPECTED.conversationsStored, 'distinct ids');
      same(p.jsonl.rows.filter((r) => r.type === 'item').length, EXPECTED.conversationsStored, 'jsonl items');
    }));

  await check('cli read: get <uuid> (json, markdown, compact, jsonl)', () =>
    readCheck('get uuid', ['get', IDS.linear], (p) => {
      const d = p.json.doc.data;
      same(p.json.doc.completeness, 'exported_tree', 'completeness');
      deepSame(d.messages.map((m) => m.id), F01_MESSAGES, 'message ids');
      deepSame(d.messages.map((m) => m.authorRole), ['user', 'assistant'], 'roles');
      same(d.branchId, F01_MESSAGES[1], 'branch id');
      same(d.activeness, 'active', 'activeness');
      same(p.jsonl.rows.filter((r) => r.type === 'message').length, 2, 'jsonl messages');
    }));

  await check('cli read: get https://chatgpt.com/c/<uuid> returns the same thread as the bare uuid', async () => {
    const byUrl = await readCheck('get url', ['get', `https://chatgpt.com/c/${IDS.linear}`], (p) => {
      deepSame(p.json.doc.data.messages.map((m) => m.id), F01_MESSAGES, 'message ids');
    });
    const byId = await cli(['get', IDS.linear, '--format', 'json']);
    expectOk(byId, 'get uuid');
    deepSame(byUrl.json.doc.data.messages, parseJson(byId.stdout, 'get uuid').data.messages, 'thread by link versus by id');
  });

  await check('cli read: get on the hostile fixture is safe in every format (no raw control or bidi characters)', () =>
    readCheck('get hostile', ['get', IDS.hostile], (p) => {
      must(p.json.doc.data.messages.length >= 1, 'no messages');
    }));

  await check('cli read: search (json, markdown, compact, jsonl)', () =>
    readCheck('search', ['search', 'answer', '--conversation', IDS.linear], (p) => {
      const d = p.json.doc.data;
      same(d.items.length, 1, 'hits');
      same(d.items[0].messageId, F01_MESSAGES[1], 'hit message id');
      same(d.items[0].authorRole, 'assistant', 'hit role');
      same(p.jsonl.rows.filter((r) => r.type === 'hit').length, 1, 'jsonl hits');
    }));

  await check('cli read: branches (json, markdown, compact, jsonl)', () =>
    readCheck('branches', ['branches', IDS.branching], (p) => {
      const d = p.json.doc.data;
      same(d.branches.length, 3, 'branches');
      same(d.activeBranchId, F02_ACTIVE_BRANCH, 'active branch');
      same(d.branches.filter((b) => b.activeness === 'active').length, 1, 'active branches');
      same(p.jsonl.rows.filter((r) => r.type === 'branch').length, 3, 'jsonl branches');
    }));

  await check('cli read: thread (json, markdown, compact, jsonl)', () =>
    readCheck('thread', ['thread', IDS.branching], (p) => {
      const d = p.json.doc.data;
      same(d.branchId, F02_ACTIVE_BRANCH, 'branch id');
      same(d.messages.length, 4, 'messages');
      same(p.jsonl.rows.filter((r) => r.type === 'message').length, 4, 'jsonl messages');
    }));

  await check('cli read: stats --group-by model', () =>
    readCheck('stats model', ['stats', '--group-by', 'model'], (p) => {
      const d = p.json.doc.data;
      same(d.groupBy, 'model', 'groupBy');
      same(d.totals.messages, EXPECTED.visibleMessages, 'total messages');
      same(sumRows(d.rows), EXPECTED.visibleMessages, 'sum of rows');
      must(d.rows.some((r) => r.key === null && r.label === 'unknown (not supplied by source)'), 'no explicit "unknown" model group');
      must(d.rows.some((r) => r.key === 'synthetic-model-1'), 'the model the export states is missing');
    }));

  await check('cli read: stats --group-by role', () =>
    readCheck('stats role', ['stats', '--group-by', 'role'], (p) => {
      const d = p.json.doc.data;
      same(d.totals.messages, EXPECTED.visibleMessages, 'total messages');
      same(sumRows(d.rows), EXPECTED.visibleMessages, 'sum of rows');
      for (const role of ['user', 'assistant']) must(d.rows.some((r) => r.key === role), `role group ${role} is missing`);
    }));

  await check('cli read: stats --group-by day', () =>
    readCheck('stats day', ['stats', '--group-by', 'day'], (p) => {
      const d = p.json.doc.data;
      same(d.totals.messages, EXPECTED.visibleMessages, 'total messages');
      same(sumRows(d.rows), EXPECTED.visibleMessages, 'sum of rows');
      must(d.rows.some((r) => r.key === '2025-10-09'), 'the fixture day is missing');
      must(d.rows.some((r) => r.key === null), 'messages without a time are not reported as a separate group');
    }));

  await check('cli read: audit', () =>
    readCheck('audit', ['audit'], (p) => {
      const d = p.json.doc.data;
      same(d.scanned.conversations, EXPECTED.conversationsStored, 'conversations scanned');
      same(d.scanned.messages, EXPECTED.auditedMessages, 'messages scanned');
      same(d.findings.length, 9, 'checks run');
      for (const check of ['missing_model', 'empty', 'untitled', 'tree_integrity', 'no_current_node']) must(d.findings.some((f) => f.check === check), `check ${check} is missing`);
      must(d.findings.find((f) => f.check === 'tree_integrity').count > 0, 'the broken-tree fixtures were not found');
    }));

  await check('cli read: read commands leave the database content unchanged', async () => {
    same(dbContentHash(st.db), importedHash, 'database content hash');
  });

  // ---- 6. error contracts ---------------------------------------------------------------------------------------------
  await check('cli errors: NOT_IN_LOCAL_EXPORT exits 3 for an absent uuid and an absent link; stdout stays empty', async () => {
    expectError(await cli(['get', IDS.absent, '--format', 'json']), 'absent uuid', 3, 'NOT_IN_LOCAL_EXPORT');
    expectError(await cli(['get', `https://chatgpt.com/c/${IDS.absent}`, '--format', 'json']), 'absent link', 3, 'NOT_IN_LOCAL_EXPORT');
    const text = await cli(['get', IDS.absent]);
    same(text.code, 3, 'markdown exit code');
    same(errorCodeOf(text), 'NOT_IN_LOCAL_EXPORT', 'markdown error code');
    must(/gcr import/.test(text.stderr), 'the error does not name the remedy');
  });

  await check('cli errors: UNSUPPORTED_URL exits 2 for a /share/ link and a foreign host; nothing is fetched', async () => {
    expectError(await cli(['get', `https://chatgpt.com/share/${IDS.linear}`, '--format', 'json']), 'share link', 2, 'UNSUPPORTED_URL');
    expectError(await cli(['get', `https://example.invalid/c/${IDS.linear}`, '--format', 'json']), 'foreign host', 2, 'UNSUPPORTED_URL');
    expectError(await cli(['get', 'not-a-uuid', '--format', 'json']), 'malformed id', 2, 'INVALID_UUID');
  });

  // ---- 7. drafts and annotations ----------------------------------------------------------------------------------------
  const draftBody = `smoke draft body ${randomBytes(6).toString('hex')}`;
  const noteBody = `smoke note body ${randomBytes(6).toString('hex')}`;
  await check('cli: draft create and draft list are local only ("GCR never sends"); annotate create stores a note', async () => {
    const draftFile = join(st.work, 'draft.md');
    const noteFile = join(st.work, 'note.txt');
    writeFileSync(draftFile, draftBody);
    writeFileSync(noteFile, noteBody);
    const created = await cli(['draft', 'create', '--conversation', IDS.linear, '--input', draftFile, '--title', 'smoke']);
    expectOk(created, 'draft create');
    must(created.stdout.includes('GCR never sends'), 'draft create output lacks "GCR never sends"');
    const listed = await cli(['draft', 'list', '--conversation', IDS.linear]);
    expectOk(listed, 'draft list');
    must(listed.stdout.includes('GCR never sends'), 'draft list output lacks "GCR never sends"');
    const json = await cli(['draft', 'list', '--conversation', IDS.linear, '--format', 'json']);
    expectOk(json, 'draft list json');
    const d = parseJson(json.stdout, 'draft list').data;
    same(d.localOnly, true, 'localOnly');
    same(d.items.length, 1, 'drafts');
    same(d.items[0].status, 'draft', 'draft status');
    same(d.items[0].createdVia, 'cli', 'createdVia');
    same(d.items[0].bodySha256, sha256(draftBody), 'body sha256 (independent)');
    same(d.items[0].manualContinuation.url, `https://chatgpt.com/c/${IDS.linear}`, 'manual continuation link');
    const note = await cli(['annotate', 'create', '--conversation', IDS.linear, '--input', noteFile, '--format', 'json']);
    expectOk(note, 'annotate create');
    const a = parseJson(note.stdout, 'annotate create').data;
    same(a.localOnly, true, 'annotation localOnly');
    same(a.annotation.version, 1, 'annotation version');
    same(a.annotation.kind, 'note', 'annotation kind');
    // The database: local rows exist, imported rows are untouched, the audit trail holds no body text, nothing is "sent".
    same(countRows(st.db, 'local_drafts'), 1, 'rows in local_drafts');
    same(countRows(st.db, 'local_annotations'), 1, 'rows in local_annotations');
    same(countRows(st.db, 'messages'), EXPECTED.messagesStored, 'rows in messages after local writes');
    same(countRows(st.db, 'source_batches'), 1, 'rows in source_batches after local writes');
    withDb(st.db, (db) => {
      deepSame(db.prepare('SELECT DISTINCT status FROM local_drafts').all().map((r) => r.status), ['draft'], 'draft statuses');
      const audit = db.prepare('SELECT details_json FROM local_audit_log').all();
      must(audit.length >= 2, 'the audit log has fewer than two rows');
      must(!audit.some((r) => r.details_json.includes(draftBody) || r.details_json.includes(noteBody)), 'the audit log holds body text');
    });
  });

  // ---- 8. graph ---------------------------------------------------------------------------------------------------------
  const htmlPath = join(st.work, 'graph.html');
  await check('cli: graph build derives a graph from the messages', async () => {
    const r = await cli(['graph', 'build', '--format', 'json']);
    expectOk(r, 'graph build');
    const d = parseJson(r.stdout, 'graph build').data;
    must(d.nodes > 0 && d.edges > 0 && d.entities > 0, 'the graph is empty');
    same(d.messagesScanned, EXPECTED.graphMessagesScanned, 'messages scanned');
  });

  await check('cli: graph export writes an offline HTML file (mode 0600, one CSP meta, two inline scripts, no external loads)', async () => {
    const r = await cli(['graph', 'export', '--out', htmlPath, '--format', 'json']);
    expectOk(r, 'graph export');
    same(statSync(htmlPath).mode & 0o777, 0o600, 'html file mode');
    const html = readFileSync(htmlPath, 'utf8');
    same((html.match(/http-equiv="Content-Security-Policy"/gi) ?? []).length, 1, 'CSP meta elements');
    must(html.includes("default-src 'none'"), "CSP lacks default-src 'none'");
    must(!/unsafe-inline|unsafe-eval/.test(html.match(/http-equiv="Content-Security-Policy"[^>]*>/i)?.[0] ?? ''), 'CSP allows unsafe script or style');
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    same(scripts.length, 2, 'script elements');
    must(scripts.some((s) => /type="application\/json"/.test(s) && /id="graph-data"/.test(s)), 'the graph-data JSON element is missing');
    must(scripts.some((s) => s === '<script>'), 'the inline script element is missing');
    must(!scripts.some((s) => /\ssrc\s*=/.test(s)), 'a script loads an external source');
    must(!/<(?:link|iframe|object|embed|img|form)\b/i.test(html), 'the page embeds an external or interactive element');
    const data = html.match(/<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/)?.[1];
    must(data !== undefined, 'the graph data cannot be extracted');
    const graph = parseJson(data, 'graph data');
    must(Array.isArray(graph.nodes) && graph.nodes.length > 0, 'the graph data has no nodes');
  });

  await check('cli: graph export refuses to overwrite (exit 2) and leaves the file unchanged; --force replaces it', async () => {
    const before = fileHash(htmlPath);
    expectError(await cli(['graph', 'export', '--out', htmlPath, '--format', 'json']), 'second export', 2, 'INVALID_ARGUMENT');
    same(fileHash(htmlPath), before, 'html file hash after the refusal');
    const forced = await cli(['graph', 'export', '--out', htmlPath, '--force', '--format', 'json']);
    expectOk(forced, 'forced export');
    same(statSync(htmlPath).mode & 0o777, 0o600, 'html file mode after --force');
  });

  // ---- 9. MCP over real stdio ---------------------------------------------------------------------------------------------
  const approvedDir = join(st.work, 'approved');
  mkdirSync(approvedDir);
  const readOnlyDb = join(st.work, 'readonly-session.sqlite'); // a COPY: the session must not be able to touch the original
  const writableDb = join(st.work, 'writable-session.sqlite');
  let sessionBaseline = ''; // content hash of the database as the MCP sessions start (imported data, drafts, graph)
  await check('mcp: databases for the sessions are copies of the CLI-built one', async () => {
    sessionBaseline = dbContentHash(st.db);
    copyFileSync(st.db, readOnlyDb);
    copyFileSync(st.db, writableDb);
    same(dbContentHash(readOnlyDb), sessionBaseline, 'copy 1 content');
    same(dbContentHash(writableDb), sessionBaseline, 'copy 2 content');
  });

  const openSession = async (dbPath, args = [], env = {}) => {
    st.spawned++;
    const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_JS, '--db', dbPath, ...args], env: childEnv(env), stderr: 'pipe', cwd: st.work });
    const stderr = [];
    transport.stderr?.on('data', (d) => stderr.push(d));
    const client = new Client({ name: 'gcr-ci-smoke', version: '0.0.0' });
    const transportErrors = [];
    client.onerror = (e) => transportErrors.push(e?.name ?? 'Error');
    const session = {
      client,
      stderr,
      transportErrors,
      closed: false,
      close: async () => {
        if (session.closed) return;
        session.closed = true;
        await client.close();
        st.ledger.push(Buffer.concat(stderr));
      },
    };
    openSessions.push(session);
    await client.connect(transport, { timeout: 20_000 });
    return session;
  };
  const envelope = (res) => {
    must(Array.isArray(res.content) && res.content[0]?.type === 'text', 'tool result has no text block');
    const fromText = parseJson(res.content[0].text, 'tool result text');
    deepSame(fromText, res.structuredContent, 'text block versus structuredContent');
    same(Boolean(res.isError), fromText.ok === false, 'isError versus envelope ok');
    return fromText;
  };
  const call = async (session, name, args = {}) => envelope(await session.client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 }));

  let ro; // the read-only session
  await check('mcp: initialize over stdio (server name, version equals the CLI, instructions say UNTRUSTED DATA)', async () => {
    ro = await openSession(readOnlyDb);
    same(ro.client.getServerVersion()?.name, 'gcr', 'server name');
    same(ro.client.getServerVersion()?.version, st.version, 'server version equals the CLI version');
    must(ro.client.getServerCapabilities()?.tools !== undefined, 'the server does not advertise tools');
    must((ro.client.getInstructions() ?? '').includes('UNTRUSTED DATA'), 'the server instructions do not mark conversation text as untrusted');
  });

  await check('mcp: tools/list is exactly the 12 documented tools with truthful readOnlyHint', async () => {
    must(ro, 'no session');
    const { tools } = await ro.client.listTools();
    deepSame(tools.map((t) => t.name).sort(), DOCUMENTED_TOOLS, 'tool names');
    for (const t of tools) {
      const expectReadOnly = READ_TOOLS.includes(t.name);
      same(t.annotations?.readOnlyHint, expectReadOnly, `${t.name} readOnlyHint`);
      same(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
      same(t.annotations?.openWorldHint, false, `${t.name} openWorldHint`);
      must(typeof t.inputSchema === 'object' && t.inputSchema.type === 'object', `${t.name} has no object input schema`);
    }
  });

  await check('mcp: gcr_get and gcr_search succeed with provenance, completeness and the untrusted flag', async () => {
    must(ro, 'no session');
    const got = await call(ro, 'gcr_get', { conversation: `https://chatgpt.com/c/${IDS.linear}` });
    same(got.ok, true, 'gcr_get ok');
    same(got.completeness, 'exported_tree', 'gcr_get completeness');
    same(got.source[0].provenance, 'official_chatgpt_export', 'gcr_get provenance');
    same(got.untrustedContent, true, 'gcr_get untrustedContent');
    deepSame(got.data.thread.messages.map((m) => m.id), F01_MESSAGES, 'gcr_get message ids');
    const found = await call(ro, 'gcr_search', { query: 'answer', conversation: IDS.linear });
    same(found.ok, true, 'gcr_search ok');
    same(found.data.items.length, 1, 'gcr_search hits');
    same(found.data.items[0].messageId, F01_MESSAGES[1], 'gcr_search message id');
    const missing = await ro.client.callTool({ name: 'gcr_get', arguments: { conversation: IDS.absent } });
    const missingEnvelope = envelope(missing);
    same(missing.isError, true, 'absent conversation isError');
    same(missingEnvelope.error.code, 'NOT_IN_LOCAL_EXPORT', 'absent conversation error code');
  });

  await check('mcp: every read tool answers ok with concrete values', async () => {
    must(ro, 'no session');
    same((await call(ro, 'gcr_list', { limit: 5 })).data.total, EXPECTED.conversationsStored, 'gcr_list total');
    same((await call(ro, 'gcr_branches', { conversation: IDS.branching })).data.branches.length, 3, 'gcr_branches branches');
    same((await call(ro, 'gcr_thread', { conversation: IDS.branching })).data.messages.length, 4, 'gcr_thread messages');
    same((await call(ro, 'gcr_stats', { groupBy: 'role' })).data.totals.messages, EXPECTED.visibleMessages, 'gcr_stats total');
    same((await call(ro, 'gcr_audit', {})).data.scanned.messages, EXPECTED.auditedMessages, 'gcr_audit messages scanned');
    must((await call(ro, 'gcr_graph_query', { term: 'synthetic' })).data.nodes.length > 0, 'gcr_graph_query found nothing');
    same((await call(ro, 'gcr_doctor', {})).data.ok, true, 'gcr_doctor ok');
  });

  await check('mcp: in the default read-only mode every write tool is refused (WRITE_FORBIDDEN / IMPORT_PATH_NOT_ALLOWED) and nothing changes', async () => {
    must(ro, 'no session');
    const before = dbContentHash(readOnlyDb);
    const draft = await call(ro, 'gcr_create_local_draft', { conversation: IDS.linear, body: 'refused' });
    same(draft.ok, false, 'draft ok');
    same(draft.error.code, 'WRITE_FORBIDDEN', 'draft error code');
    const note = await call(ro, 'gcr_update_local_annotation', { conversation: IDS.linear, body: 'refused' });
    same(note.error?.code, 'WRITE_FORBIDDEN', 'annotation error code');
    const imported = await call(ro, 'gcr_import_export', { path: st.zip });
    same(imported.ok, false, 'import ok');
    must(['IMPORT_PATH_NOT_ALLOWED', 'WRITE_FORBIDDEN'].includes(imported.error.code), 'import was not refused with a path or write error');
    same(dbContentHash(readOnlyDb), before, 'database content hash');
  });

  await check('mcp: the read-only session ends cleanly and its stderr is empty (no warnings, no content)', async () => {
    must(ro, 'no session');
    await ro.close();
    same(ro.transportErrors.length, 0, `transport errors seen by the SDK client (${[...new Set(ro.transportErrors)].join(', ')})`);
    const text = Buffer.concat(ro.stderr).toString('utf8');
    if (text !== '') {
      must(!/ExperimentalWarning|\(node:\d+\)/.test(text), 'a Node warning reached stderr');
      for (const line of lines(text)) {
        const entry = (() => {
          try { return JSON.parse(line); } catch { return null; }
        })();
        must(entry !== null && typeof entry.level === 'string' && typeof entry.msg === 'string', 'stderr holds a line that is not a structured log entry');
      }
    }
  });

  // Writes enabled, on the second COPY, with one approved import root.
  let rw;
  const writableBefore = dbContentHash(writableDb);
  await check('mcp: --allow-local-writes session starts on the copy with one approved import root', async () => {
    rw = await openSession(writableDb, ['--allow-local-writes'], { GCR_APPROVED_IMPORT_ROOTS: approvedDir });
    same((await rw.client.listTools()).tools.length, 12, 'tools with writes enabled');
  });

  await check('mcp: with writes enabled the nine read tools still do not change the database (readOnlyHint is truthful)', async () => {
    must(rw, 'no session');
    const calls = [
      ['gcr_list', { limit: 5 }],
      ['gcr_get', { conversation: IDS.linear }],
      ['gcr_search', { query: 'answer' }],
      ['gcr_branches', { conversation: IDS.branching }],
      ['gcr_thread', { conversation: IDS.branching }],
      ['gcr_stats', { groupBy: 'model' }],
      ['gcr_audit', {}],
      ['gcr_graph_query', { term: 'synthetic' }],
      ['gcr_doctor', {}],
    ];
    same(calls.length, READ_TOOLS.length, 'read tools exercised');
    for (const [name, args] of calls) {
      const res = await call(rw, name, args);
      same(res.ok, true, `${name} ok`);
      if (dbContentHash(writableDb) !== writableBefore) fail(`${name} changed the database although it is annotated read-only`);
    }
  });

  await check('mcp: with writes enabled gcr_create_local_draft and gcr_update_local_annotation succeed locally; the original database is untouched', async () => {
    must(rw, 'no session');
    const drafts = countRows(writableDb, 'local_drafts');
    const audit = countRows(writableDb, 'local_audit_log');
    const d = await call(rw, 'gcr_create_local_draft', { conversation: IDS.linear, body: draftBody, title: 'smoke' });
    same(d.ok, true, 'draft ok');
    same(d.data.localOnly, true, 'draft localOnly');
    same(d.data.draft.createdVia, 'mcp', 'draft createdVia');
    same(d.data.draft.status, 'draft', 'draft status');
    same(d.data.draft.bodySha256, sha256(draftBody), 'draft body sha256 (independent)');
    same(countRows(writableDb, 'local_drafts'), drafts + 1, 'rows in local_drafts');
    const created = await call(rw, 'gcr_update_local_annotation', { conversation: IDS.linear, body: noteBody });
    same(created.ok, true, 'annotation create ok');
    same(created.data.annotation.version, 1, 'annotation version after create');
    const updated = await call(rw, 'gcr_update_local_annotation', { annotationId: created.data.annotation.annotationId, expectedVersion: 1, body: `${noteBody} (edited)` });
    same(updated.ok, true, 'annotation update ok');
    same(updated.data.annotation.version, 2, 'annotation version after update');
    const stale = await call(rw, 'gcr_update_local_annotation', { annotationId: created.data.annotation.annotationId, expectedVersion: 1, body: 'stale' });
    same(stale.error?.code, 'ANNOTATION_CONFLICT', 'stale update error code');
    must(countRows(writableDb, 'local_audit_log') > audit, 'the writes left no audit rows');
    same(countRows(writableDb, 'messages'), EXPECTED.messagesStored, 'imported messages after MCP writes');
    withDb(writableDb, (db) => {
      const details = db.prepare('SELECT details_json FROM local_audit_log').all();
      must(!details.some((r) => r.details_json.includes(draftBody) || r.details_json.includes(noteBody)), 'the audit log holds body text');
    });
    same(dbContentHash(st.db), sessionBaseline, 'the original database content hash');
  });

  await check('mcp: gcr_import_export refuses paths outside GCR_APPROVED_IMPORT_ROOTS and accepts one inside', async () => {
    must(rw, 'no session');
    const outside = await call(rw, 'gcr_import_export', { path: st.zip });
    same(outside.ok, false, 'outside path ok');
    same(outside.error.code, 'IMPORT_PATH_NOT_ALLOWED', 'outside path error code');
    const traversal = await call(rw, 'gcr_import_export', { path: `${approvedDir}/../export.zip` });
    same(traversal.error?.code, 'IMPORT_PATH_NOT_ALLOWED', 'traversal error code');
    // Positive control: the denial above is not the tool being broken. The same bytes inside the root are accepted
    // (and are recognised as already imported, because the copy of the database holds that batch).
    copyFileSync(st.zip, join(approvedDir, 'inside.zip'));
    const inside = await call(rw, 'gcr_import_export', { path: join(approvedDir, 'inside.zip') });
    same(inside.ok, true, 'inside path ok');
    same(inside.data.alreadyImported, true, 'inside path alreadyImported');
    same(inside.data.conversations.stored, EXPECTED.conversationsStored, 'inside path conversations stored');
  });

  await check('mcp: the writes-enabled session ends cleanly and its stderr is empty', async () => {
    must(rw, 'no session');
    await rw.close();
    same(rw.transportErrors.length, 0, `transport errors seen by the SDK client (${[...new Set(rw.transportErrors)].join(', ')})`);
    same(Buffer.concat(rw.stderr).toString('utf8'), '', 'stderr of the writes-enabled session');
  });

  await check('mcp: raw stdio, every stdout line is a JSON-RPC message, ids match, stderr is clean, exit code 0', async () => {
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'gcr-ci-smoke-raw', version: '0.0.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gcr_get', arguments: { conversation: IDS.hostile } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gcr_search', arguments: { query: 'synthetic', limit: 50 } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gcr_create_local_draft', arguments: { conversation: IDS.linear, body: 'refused' } } },
      { jsonrpc: '2.0', id: 6, method: 'no/such/method' },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'gcr_get', arguments: { conversation: IDS.absent } } },
    ];
    const r = await runNode(MCP_JS, ['--db', readOnlyDb], { stdin: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n` });
    same(r.timedOut, false, 'timed out');
    same(r.code, 0, 'server exit code after stdin ended');
    must(r.stdoutBytes.length > 0, 'stdout is empty');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(r.stdoutBytes);
    } catch {
      return fail('stdout is not valid UTF-8');
    }
    must(text.endsWith('\n'), 'stdout does not end with a newline');
    const rows = text.slice(0, -1).split('\n');
    const ids = [];
    for (const [i, line] of rows.entries()) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return fail(`stdout line ${i + 1} is not JSON (${line.length} chars)`);
      }
      must(msg !== null && typeof msg === 'object' && msg.jsonrpc === '2.0', `stdout line ${i + 1} is not a JSON-RPC 2.0 message`);
      must('id' in msg ? 'result' in msg || 'error' in msg : typeof msg.method === 'string', `stdout line ${i + 1} is neither a response nor a notification`);
      if ('id' in msg) ids.push(msg.id);
    }
    deepSame([...ids].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7], 'response ids');
    const byId = new Map(rows.map((l) => JSON.parse(l)).filter((m) => 'id' in m).map((m) => [m.id, m]));
    same(byId.get(6).error.code, -32601, 'unknown method error code');
    same(byId.get(5).result.isError, true, 'refused draft isError');
    same(byId.get(7).result.structuredContent.error.code, 'NOT_IN_LOCAL_EXPORT', 'absent conversation error code');
    same(byId.get(3).result.structuredContent.ok, true, 'hostile conversation ok');
    must(!/[\u2028\u2029\u0085]/.test(text), 'a raw line separator (U+2028, U+2029 or U+0085) is on the wire');
    if (r.stderr !== '') {
      must(!/ExperimentalWarning|\(node:\d+\)/.test(r.stderr), 'a Node warning reached stderr');
      for (const line of lines(r.stderr)) must(/^\{.*"level":/.test(line), 'stderr holds a line that is not a structured log entry');
    }
    same(dbContentHash(readOnlyDb), sessionBaseline, 'database content hash after the raw session');
  });

  // ---- 10. the canary, the guard ---------------------------------------------------------------------------------------------
  const needles = [Buffer.from(CANARY), Buffer.from(CANARY_HEX)];
  const anyIn = (buffer) => needles.some((n) => buffer.includes(n));
  await check('canary: absent from every captured stdout and stderr', async () => {
    must(st.ledger.length > 20, 'fewer than 10 product processes were captured');
    must(!anyIn(Buffer.concat(st.ledger)), 'the canary reached an output stream');
  });
  await check('canary: absent from every database table and from the database files', async () => {
    for (const path of [st.db, readOnlyDb, writableDb]) {
      must(!dbContains(path, [CANARY, CANARY_HEX]), `the canary is in the content of ${basename(path)}`);
      for (const suffix of ['', '-wal']) if (existsSync(path + suffix)) must(!anyIn(readFileSync(path + suffix)), `the canary is in the bytes of ${basename(path)}${suffix}`);
    }
  });
  await check('canary: absent from the exported HTML', async () => {
    must(!anyIn(readFileSync(htmlPath)), 'the canary is in the exported HTML');
  });
  await check('guard: no product process attempted to use the network (guard log is empty)', async () => {
    const attempts = readLines(st.guardLog);
    if (attempts.length > 0) {
      const byApi = new Map();
      for (const api of attempts) byApi.set(api, (byApi.get(api) ?? 0) + 1);
      fail(`the guard recorded ${attempts.length} network attempt(s): ${[...byApi].map(([api, n]) => `${show(api)} x${n}`).join(', ')}`);
    }
  });
  await check('guard: the guard was loaded in every product process that was started (so the empty log means something)', async () => {
    must(st.spawned >= 40, `only ${st.spawned} product processes were started`);
    same(readLines(st.loadedLog).length, st.spawned, 'processes that loaded the guard versus processes started');
  });
}

const started = Date.now();
try {
  await main();
} catch (e) {
  results.push({ name: 'smoke: runner', ok: false });
  console.log(`FAIL smoke: runner: unexpected ${e?.name ?? 'error'}${typeof e?.code === 'string' ? ` (${e.code})` : ''}`);
} finally {
  await Promise.allSettled(openSessions.map((s) => s.close()));
  if (opts.keepTemp && st.work) console.log(`kept temp directory ${basename(st.work)}`);
  else if (st.work) rmSync(st.work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed === 0 && results.length > 0) {
  console.log(`SMOKE OK (${results.length} checks)`);
  process.stderr.write(`ci-smoke: ${seconds} s\n`);
  process.exitCode = 0;
} else {
  console.log(`SMOKE FAILED (${failed} of ${results.length} checks failed)`);
  process.stderr.write(`ci-smoke: ${seconds} s\n`);
  process.exitCode = 1;
}
