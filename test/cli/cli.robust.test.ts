/**
 * Robustness: a network tripwire around every kind of command, every committed fixture through the CLI, output larger than a
 * pipe buffer read slowly, special files as input, and the exit codes of `doctor`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { requireOption } from '../helpers/node-options.js';
import { FIXTURES, ID, arr, assertClean, assertOk, assertTextError, copyDb, envelope, gcr, obj, spawnCli, tempDir, templateDb, writeFile } from './cli.helpers.test.js';

describe('no network, ever: a tripwire around the whole process', () => {
  // Every way a Node program can start talking to another machine is replaced by a function that records the attempt and
  // throws. The preload also runs inside `gcr mcp`.
  const TRIPWIRE = `'use strict';
const fs = require('node:fs');
const log = process.env.GCR_TEST_NETLOG;
const hit = (what) => { fs.appendFileSync(log, what + '\\n'); throw new Error('network attempted: ' + what); };
const net = require('node:net'), dns = require('node:dns'), http = require('node:http'), https = require('node:https'), tls = require('node:tls'), dgram = require('node:dgram');
net.Socket.prototype.connect = function () { hit('net.Socket.connect'); };
net.connect = net.createConnection = function () { hit('net.connect'); };
tls.connect = function () { hit('tls.connect'); };
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) dns[k] = function () { hit('dns.' + k); };
for (const k of ['lookup', 'resolve']) dns.promises[k] = function () { hit('dns.promises.' + k); };
http.request = http.get = function () { hit('http.request'); };
https.request = https.get = function () { hit('https.request'); };
dgram.createSocket = function () { hit('dgram.createSocket'); };
globalThis.fetch = function () { hit('fetch'); };
globalThis.WebSocket = function () { hit('WebSocket'); };
`;

  it('the tripwire itself works (a control that would otherwise make this test vacuous)', () => {
    const dir = tempDir();
    const preload = writeFile(dir, 'tripwire.cjs', TRIPWIRE);
    const netlog = join(dir, 'net.log');
    for (const probe of ["require('node:net').connect(9, '127.0.0.1')", "fetch('http://127.0.0.1:9/')", "require('node:dns').lookup('example.invalid', () => {})"]) {
      try {
        execFileSync(process.execPath, ['-r', preload, '-e', probe], { env: { PATH: process.env['PATH'] ?? '', GCR_TEST_NETLOG: netlog }, stdio: 'pipe' });
      } catch {
        /* the tripwire throws on purpose */
      }
    }
    assert.equal(readFileSync(netlog, 'utf8').trim().split('\n').length, 3, 'all three probes were caught');
  });

  it('get-by-link, reads, imports, drafts, graph, export, doctor and mcp never attempt a connection', async () => {
    const { dbPath, dir } = await copyDb();
    const preload = writeFile(dir, 'tripwire.cjs', TRIPWIRE);
    const netlog = join(dir, 'net.log');
    const env = { NODE_OPTIONS: requireOption(preload), GCR_TEST_NETLOG: netlog, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' };
    const note = writeFile(dir, 'n.txt', 'note');
    const exportFile = writeFile(dir, 'conversations.json', (await templateDb()).std.json);
    const copy = writeFile(dir, 'copy.json', JSON.stringify({ messages: [{ role: 'user', text: 'x' }] }));
    const commands: string[][] = [
      ['get', `https://chatgpt.com/c/${ID.absent}`],
      ['get', `https://chatgpt.com/c/${ID.linear}`],
      ['get', `https://chatgpt.com/share/${ID.linear}`],
      ['list'], ['search', 'quokka'], ['branches', ID.branched], ['thread', ID.branched], ['stats'], ['audit'], ['batches'], ['doctor'],
      ['import', exportFile, '--db', join(dir, 'imp.sqlite')],
      ['import-copy', copy, '--db', join(dir, 'imp.sqlite')],
      ['graph', 'build', '--min-conversations', '1'], ['graph', 'query', 'quokka'], ['graph', 'god-nodes'], ['graph', 'export', '--out', join(dir, 'g.html')],
      ['draft', 'create', '--conversation', ID.linear, '--input', note], ['draft', 'list'],
      ['annotate', 'create', '--conversation', ID.linear, '--input', note], ['annotate', 'list'],
    ];
    for (const args of commands) {
      const r = await gcr(args.includes('--db') ? args : [...args, '--db', dbPath], { env });
      assert.ok(r.code === 0 || r.code === 2 || r.code === 3, `gcr ${args.join(' ')} exited ${String(r.code)}: ${r.stderr}`);
      assert.equal(r.stderr.includes('network attempted'), false);
    }
    const child = spawnCli(['mcp', '--db', dbPath], { stdin: '', env });
    child.stdin?.end();
    await once(child, 'close');
    assert.equal(existsSync(netlog), false, `a network call was attempted: ${existsSync(netlog) ? readFileSync(netlog, 'utf8') : ''}`);
  });
});

describe('every committed fixture goes through the CLI without an unexpected failure', () => {
  const names = [
    ...readdirSync(join(FIXTURES, 'chatgpt')).filter((n) => n.endsWith('.json')).map((n) => join('chatgpt', n)),
    ...readdirSync(join(FIXTURES, 'claude')).filter((n) => n.endsWith('.json')).map((n) => join('claude', n)),
  ];

  for (const name of names) {
    it(name, async () => {
      const dir = tempDir();
      const db = join(dir, 'f.sqlite');
      const imported = await gcr(['import', join(FIXTURES, name), '--db', db, '--format', 'json']);
      // Some fixtures are meant to be refused or to produce warnings; what must never happen is an internal error or a hang.
      assert.ok([0, 4].includes(imported.code ?? -1), `import exited ${String(imported.code)}: ${imported.stderr}`);
      assertClean(imported.stdout, 'import stdout');
      if (imported.code !== 0) {
        assert.match(imported.stderr, /^\{"ok":false,"error":\{"code":"IMPORT_/);
        return;
      }
      for (const args of [['stats'], ['audit'], ['batches'], ['search', 'synthetic'], ['graph', 'build']]) {
        const r = await gcr([...args, '--db', db, '--format', 'json']);
        assertOk(r, `${name}: gcr ${args.join(' ')}`);
      }
      const list = await gcr(['list', '--limit', '500', '--db', db, '--format', 'json']);
      assertOk(list, `${name}: list`);
      const ids = arr(envelope(list.stdout).data['items']).map((i) => `${String(i['conversationId'])}`);
      for (const id of ids.slice(0, 12)) {
        const stored = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? [] : ['--stored-id']; // ids GCR synthesized are not UUIDs
        for (const args of [['get', id, '--all-branches', '--format', 'json', ...stored], ['branches', id, '--format', 'markdown', ...stored], ['thread', id, '--branch-policy', 'latest_leaf', '--format', 'compact', ...stored]]) {
          const r = await gcr([...args, '--db', db]);
          assert.ok([0, 3].includes(r.code ?? -1), `${name}: gcr ${args.join(' ')} exited ${String(r.code)}: ${r.stderr}`);
          assertClean(r.stdout, `${name}: stdout`);
          assertClean(r.stderr, `${name}: stderr`);
          if (r.code === 3) assert.match(r.stderr, /^error\[(ACTIVE_BRANCH_UNKNOWN|BRANCH_NOT_FOUND|NOT_IN_LOCAL_EXPORT|AMBIGUOUS_CONVERSATION)\]: /);
        }
      }
    });
  }
});

describe('conversation ids that are not UUIDs (--stored-id)', () => {
  it('an id GCR synthesized for an export element without one can be addressed with --stored-id, and only with it', async () => {
    const dir = tempDir();
    const db = join(dir, 'stored.sqlite');
    assertOk(await gcr(['import', join(FIXTURES, 'claude', 'missing-optional-fields.json'), '--db', db, '--format', 'json']));
    const items = arr(envelope((await gcr(['list', '--db', db, '--format', 'json'])).stdout).data['items']);
    const odd = items.map((i) => String(i['conversationId'])).find((id) => !/^[0-9a-f]{8}-/.test(id));
    assert.ok(odd !== undefined, 'the fixture produces an id that is not a UUID');

    assertTextError(await gcr(['get', odd, '--db', db]), 'INVALID_UUID');
    const got = await gcr(['get', odd, '--stored-id', '--db', db, '--format', 'json']);
    assertOk(got);
    assert.equal(obj(envelope(got.stdout).data['conversation'])['conversationId'], odd);
    assertOk(await gcr(['thread', odd, '--stored-id', '--provider', 'claude', '--db', db, '--format', 'compact']));
    assertOk(await gcr(['branches', odd, '--stored-id', '--db', db, '--format', 'compact']));
    const note = writeFile(dir, 'n.txt', 'note on a stored id');
    assertOk(await gcr(['annotate', 'create', '--conversation', odd, '--stored-id', '--input', note, '--db', db, '--format', 'compact']));
    assertOk(await gcr(['draft', 'create', '--conversation', odd, '--stored-id', '--input', note, '--db', db, '--format', 'compact']));
    assertTextError(await gcr(['get', 'no-such-id', '--stored-id', '--db', db]), 'NOT_IN_LOCAL_EXPORT');
    assertTextError(await gcr(['get', `https://chatgpt.com/c/${ID.linear}`, '--stored-id', '--db', db]), 'INVALID_ARGUMENT');
    assertTextError(await gcr(['get', `bad${String.fromCharCode(0x1b)}id`, '--stored-id', '--db', db]), 'INVALID_ARGUMENT');
    // search --conversation takes stored ids as they are
    assertOk(await gcr(['search', 'synthetic', '--conversation', odd, '--db', db, '--format', 'json']));
  });
});

describe('large output', () => {
  it('is delivered completely even when the reader is slow and the process is ready to exit', async () => {
    const dir = tempDir();
    const size = 6_000_000;
    const b = new ConversationBuilder({ id: syntheticUuid(0x77), title: 'GCR-SYNTHETIC-FIXTURE large message' });
    b.assistant(b.user(b.root(), 'q'), 'x'.repeat(size));
    const exportFile = writeFile(dir, 'conversations.json', `[${b.text()}]`);
    const db = join(dir, 'big.sqlite');
    assertOk(await gcr(['import', exportFile, '--db', db, '--format', 'compact']));

    for (const format of ['json', 'markdown']) {
      const child = spawnCli(['get', syntheticUuid(0x77), '--db', db, '--format', format]);
      const chunks: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stderr?.on('data', (c: Buffer) => stderr.push(c));
      setTimeout(() => child.stdout?.on('data', (c: Buffer) => chunks.push(c)), 800); // nobody reads for 800 ms: the pipe fills up
      const [code] = (await once(child, 'close')) as [number | null];
      assert.equal(code, 0, Buffer.concat(stderr).toString());
      const text = Buffer.concat(chunks).toString('utf8');
      assert.ok(text.length > size, `${format}: ${text.length} characters arrived`);
      if (format === 'json') {
        const env = envelope(text);
        const messages = arr(env.data['messages']);
        assert.equal(String(messages.at(-1)?.['text']).length, size, 'the JSON document is complete and parses');
      } else {
        assert.ok(text.endsWith('\n'));
      }
      assert.equal(Buffer.concat(stderr).length, 0);
    }
  });
});

describe('special files as input', () => {
  it('a named pipe does not hang the command: it is refused as not a regular file', async () => {
    const { dbPath, dir } = await copyDb();
    const fifo = join(dir, 'pipe.txt');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this machine: nothing to test
    }
    const r = await gcr(['draft', 'create', '--conversation', ID.linear, '--input', fifo, '--db', dbPath], { timeoutMs: 20_000 });
    assertTextError(r, 'INVALID_ARGUMENT');
    assert.match(r.stderr, /not a regular file/);
    const copy = await gcr(['import-copy', fifo, '--db', dbPath], { timeoutMs: 20_000 });
    assertTextError(copy, 'IMPORT_UNSUPPORTED_FORMAT');
  });

  it('a device is refused too', async () => {
    const { dbPath } = await copyDb();
    if (!existsSync('/dev/zero')) return;
    const r = await gcr(['draft', 'create', '--conversation', ID.linear, '--input', '/dev/zero', '--db', dbPath], { timeoutMs: 20_000 });
    assertTextError(r, 'INVALID_ARGUMENT');
  });
});

describe('doctor exit codes', () => {
  it('0 when every check passes (and the database may simply not exist yet)', async () => {
    const { dbPath } = await copyDb();
    assertOk(await gcr(['doctor', '--db', dbPath]));
    assertOk(await gcr(['doctor', '--db', join(tempDir(), 'not-yet.sqlite')]));
  });

  it('5 when the inspected database is unusable; the report is still printed on stdout and stderr stays empty', async () => {
    const { dbPath, dir } = await copyDb();
    const newer = new DatabaseSync(dbPath);
    newer.exec('PRAGMA user_version = 99');
    newer.close();
    const junk = writeFile(dir, 'junk.sqlite', 'not a database '.repeat(100));
    for (const target of [dbPath, junk]) {
      for (const format of ['markdown', 'json'] as const) {
        const r = await gcr(['doctor', '--db', target, '--format', format]);
        assert.equal(r.code, 5, `doctor ${format}: ${r.stderr}`);
        assert.equal(r.stderr, '');
        assertClean(r.stdout, 'doctor stdout');
        if (format === 'json') {
          const report = envelope(r.stdout).data;
          assert.equal(report['ok'], false);
          assert.ok((report['problems'] as unknown[]).length >= 1);
          assert.equal(obj(report['database'])['exists'], true);
        } else {
          assert.match(r.stdout, /PROBLEMS FOUND/);
        }
      }
    }
  });

  it('never prints environment values or absolute paths', async () => {
    const { dbPath } = await copyDb();
    const secret = '/very/secret/location/of/db.sqlite';
    const r = await gcr(['doctor', '--db', dbPath, '--format', 'json'], { env: { GCR_DB: secret, GCR_APPROVED_IMPORT_ROOTS: '/very/secret/roots' } });
    assertOk(r);
    assert.equal(r.stdout.includes('/very/secret'), false);
    assert.equal(r.stdout.includes(dbPath), false);
    const env = obj(envelope(r.stdout).data);
    assert.deepEqual(arr(env['env']).map((e) => [e['name'], e['status']]), [['GCR_DB', 'present'], ['GCR_APPROVED_IMPORT_ROOTS', 'present']]);
  });
});
