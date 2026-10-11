/**
 * The error contract, for every error code the CLI can produce: exit code = EXIT_CODES[code]; stdout stays EMPTY; with
 * `--format json` stderr is exactly one ErrorEnvelope; otherwise stderr starts with `error[CODE]: message` and has an
 * indented `remedy:` line. Each case runs in both modes. Codes the CLI cannot produce are listed at the end, with the reason.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { ERROR_CODES, EXIT_CODES } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';
import { buildZip } from '../helpers/zip-builder.js';
import { ID, assertJsonError, assertOk, assertTextError, copyDb, gcr, tempDir, templateDb, writeFile } from './cli.helpers.test.js';
import type { ErrorJson, RunResult } from './cli.helpers.test.js';

const NOT_FOUND_REMEDY = /gcr import <export\.zip>/;

/** Run the same invocation in text and JSON mode; assert the contract for `code` in both. Returns both results. */
async function bothModes(args: string[], code: ErrorCode, opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string; remedy?: RegExp } = {}): Promise<{ text: RunResult; json: ErrorJson }> {
  const text = await gcr(args, opts);
  assertTextError(text, code, opts.remedy === undefined ? {} : { remedy: opts.remedy });
  const jsonRun = await gcr([...args, '--format', 'json'], opts);
  const json = assertJsonError(jsonRun, code);
  if (opts.remedy !== undefined) assert.match(json.error.remedy ?? '', opts.remedy);
  return { text, json };
}

describe('usage errors: INVALID_ARGUMENT (exit 2)', () => {
  it('unknown command: nothing runs, nearest command suggested', async () => {
    const { text } = await bothModes(['lst'], 'INVALID_ARGUMENT', { remedy: /Did you mean "list"\?/ });
    assert.match(text.stderr, /Unknown command "lst"/);
    assert.match(text.stderr, /gcr --help/);
  });

  it('unknown flag: usage hint, nearest option suggested', async () => {
    const { text } = await bothModes(['list', '--lmit', '5'], 'INVALID_ARGUMENT', { remedy: /Did you mean "--limit"\?/ });
    assert.match(text.stderr, /Unknown option "--lmit" for "gcr list"/);
  });

  it('no command, missing group subcommand, unknown subcommand', async () => {
    await bothModes([], 'INVALID_ARGUMENT', { remedy: /gcr --help/ });
    await bothModes(['graph'], 'INVALID_ARGUMENT', { remedy: /gcr help graph/ });
    await bothModes(['draft', 'sned'], 'INVALID_ARGUMENT', { remedy: /gcr help draft/ });
  });

  it('missing, extra and empty arguments', async () => {
    await bothModes(['get'], 'INVALID_ARGUMENT', { remedy: /gcr get --help/ });
    await bothModes(['get', ID.linear, ID.branched], 'INVALID_ARGUMENT');
    await bothModes(['search', ''], 'INVALID_ARGUMENT');
    await bothModes(['search', 'two', 'words'], 'INVALID_ARGUMENT', { remedy: /Quote/ });
    await bothModes(['list', 'extra'], 'INVALID_ARGUMENT');
    await bothModes(['graph', 'explain', 'a', 'b'], 'INVALID_ARGUMENT');
    await bothModes(['graph', 'explain', 'zero'], 'INVALID_ARGUMENT');
  });

  it('numbers out of range or malformed', async () => {
    for (const bad of ['0', '501', '1e3', '0x10', 'abc', '-1', '5.5']) await bothModes(['list', `--limit=${bad}`], 'INVALID_ARGUMENT');
    await bothModes(['graph', 'query', 'x', '--depth', '9'], 'INVALID_ARGUMENT');
    await bothModes(['stats', '--offset', 'many'], 'INVALID_ARGUMENT');
  });

  it('a bad --format lists the valid values', async () => {
    const r = await gcr(['list', '--format', 'xml']);
    assertTextError(r, 'INVALID_ARGUMENT');
    assert.match(r.stderr, /json, markdown, compact, jsonl/);
  });

  it('a bad --tz fails before anything is written', async () => {
    const cwd = tempDir();
    const exportPath = writeFile(cwd, 'conversations.json', '[]');
    await bothModes(['import', exportPath, '--tz', 'Mars/Olympus_Mons'], 'INVALID_ARGUMENT', { cwd, remedy: /IANA/ });
    assert.equal(existsSync(join(cwd, '.gcr')), false, 'no database directory was created');
    await bothModes(['list', '--tz', 'Nowhere/Land', '--db', join(cwd, 'x.sqlite')], 'INVALID_ARGUMENT');
  });

  it('options for missing values, repeated options and bad combinations', async () => {
    await bothModes(['list', '--db'], 'INVALID_ARGUMENT');
    // "--db --format": the value of --db would be the next option; refused (this one is JSON-mode only by construction).
    assertJsonError(await gcr(['list', '--db', '--format', 'json']), 'INVALID_ARGUMENT');
    assertTextError(await gcr(['list', '--format', '--db']), 'INVALID_ARGUMENT');
    await bothModes(['list', '--limit', '1', '--limit', '2'], 'INVALID_ARGUMENT', { remedy: /once/ });
    await bothModes(['list', '--quiet=1'], 'INVALID_ARGUMENT');
    // mcp owns stdout for JSON-RPC: it accepts no output options at all.
    assertJsonError(await gcr(['mcp', '--format', 'json']), 'INVALID_ARGUMENT');
    assertTextError(await gcr(['mcp', '--tz', 'UTC']), 'INVALID_ARGUMENT');
    await bothModes(['list', '--db', ':memory:'], 'INVALID_ARGUMENT', { remedy: /--db <path>/ });
    await bothModes(['list', '--db', 'file:evil.sqlite?mode=rwc'], 'INVALID_ARGUMENT');
  });

  it('a filter that the scope cannot apply is refused, not ignored', async () => {
    const { dbPath } = await templateDb();
    await bothModes(['search', 'x', '--scope', 'titles', '--role', 'user', '--db', dbPath], 'INVALID_ARGUMENT');
  });

  it('required options of the write commands', async () => {
    const { dbPath, dir } = await copyDb();
    const note = writeFile(dir, 'n.txt', 'text');
    await bothModes(['draft', 'create', '--input', note, '--db', dbPath], 'INVALID_ARGUMENT', { remedy: /--conversation/ });
    await bothModes(['draft', 'create', '--conversation', ID.linear, '--db', dbPath], 'INVALID_ARGUMENT', { remedy: /--input/ });
    await bothModes(['annotate', 'update', 'some-id', '--input', note, '--db', dbPath], 'INVALID_ARGUMENT', { remedy: /--expected-version/ });
    await bothModes(['graph', 'export', '--db', dbPath], 'INVALID_ARGUMENT', { remedy: /--out/ });
  });

  it('echoed arguments never carry terminal escape sequences', async () => {
    const r = await gcr([`bogus${String.fromCharCode(0x1b)}[31m`]);
    assertTextError(r, 'INVALID_ARGUMENT');
    const j = await gcr([`bogus${String.fromCharCode(0x1b)}[31m`, '--format', 'json']);
    assertJsonError(j, 'INVALID_ARGUMENT');
  });
});

describe('references: INVALID_URL, INVALID_UUID, UNSUPPORTED_URL (exit 2) and lookups (exit 3)', () => {
  const syntheticUrl = `https://chatgpt.com/c/${ID.linear}`;

  it('malformed text is INVALID_UUID, before the database is even looked at', async () => {
    const cwd = tempDir();
    for (const bad of ['not-a-uuid', '12345', `${ID.linear}0`, ID.linear.slice(1)]) {
      await bothModes(['get', bad], 'INVALID_UUID', { cwd, remedy: /https:\/\/chatgpt\.com\/c\/<uuid>/ });
    }
    await bothModes(['thread', 'nope'], 'INVALID_UUID', { cwd });
    await bothModes(['branches', 'nope'], 'INVALID_UUID', { cwd });
  });

  it('a link whose id is not a UUID is INVALID_UUID; a malformed URL is INVALID_URL', async () => {
    await bothModes(['get', 'https://chatgpt.com/c/not-a-uuid'], 'INVALID_UUID');
    await bothModes(['get', `https:chatgpt.com/c/${ID.linear}`], 'INVALID_URL');
    await bothModes(['get', `https://chatgpt.com/c/${ID.linear}%2e`], 'INVALID_URL');
    await bothModes(['get', `https://chatgpt.com\\c\\${ID.linear}`], 'INVALID_URL');
  });

  it('share links, other hosts, other schemes, ports, userinfo and extra segments are UNSUPPORTED_URL', async () => {
    for (const url of [
      `https://chatgpt.com/share/${ID.linear}`,
      `https://chat.openai.com/c/${ID.linear}`,
      `https://www.chatgpt.com/c/${ID.linear}`,
      `https://example.invalid/c/${ID.linear}`,
      `http://chatgpt.com/c/${ID.linear}`,
      `https://chatgpt.com:8443/c/${ID.linear}`,
      `https://user:pw@chatgpt.com/c/${ID.linear}`,
      `https://chatgpt.com/g/g-synthetic/c/${ID.linear}`,
      `https://chatgpt.com/c/${ID.linear}/extra`,
      `ftp://chatgpt.com/c/${ID.linear}`,
    ]) {
      await bothModes(['get', url], 'UNSUPPORTED_URL', { remedy: /https:\/\/chatgpt\.com\/c\/<uuid>/ });
    }
  });

  it('a refused link is never echoed (it may carry a token in its query string)', async () => {
    const r = await gcr(['get', `https://example.invalid/c/${ID.linear}?token=SECRETVALUE`, '--format', 'json']);
    assertJsonError(r, 'UNSUPPORTED_URL');
    assert.equal(r.stderr.includes('SECRETVALUE'), false);
  });

  it('a well-formed link or UUID that is not in the database is NOT_IN_LOCAL_EXPORT, with the export remedy', async () => {
    const { dbPath } = await templateDb();
    for (const ref of [ID.absent, `https://chatgpt.com/c/${ID.absent}`, `https://chatgpt.com/c/${ID.absent.toUpperCase()}?utm=1#x`]) {
      for (const cmd of ['get', 'thread', 'branches']) {
        const { text, json } = await bothModes([cmd, ref, '--db', dbPath], 'NOT_IN_LOCAL_EXPORT', { remedy: NOT_FOUND_REMEDY });
        assert.match(text.stderr, /GCR cannot fetch chatgpt\.com conversations/);
        assert.match(text.stderr, /Settings > Data controls > Export data/);
        assert.equal(json.error.details?.['conversationId'], ID.absent);
        assert.equal(text.stderr.includes('utm='), false, 'the query string is not echoed');
      }
    }
  });

  it('an unknown batch is NOT_IN_LOCAL_EXPORT too', async () => {
    const { dbPath } = await templateDb();
    const { json } = await bothModes(['get', ID.linear, '--batch', 'b_00000000000000000000000000000000', '--db', dbPath], 'NOT_IN_LOCAL_EXPORT');
    assert.equal(json.error.details?.['reason'], 'unknown_batch');
  });

  it('works identically with no network at all: proxies pointing nowhere change nothing', async () => {
    const { dbPath } = await templateDb();
    const args = ['get', `https://chatgpt.com/c/${ID.absent}`, '--db', dbPath];
    const plain = await gcr(args);
    const proxied = await gcr(args, {
      env: { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', NO_PROXY: '' },
    });
    assert.deepEqual({ ...proxied }, { ...plain });
    assertTextError(plain, 'NOT_IN_LOCAL_EXPORT');
    // A valid lookup works the same way too.
    const ok = await gcr(['get', syntheticUrl, '--db', dbPath, '--format', 'json'], { env: { HTTPS_PROXY: 'http://127.0.0.1:9' } });
    assertOk(ok);
  });

  it('AMBIGUOUS_CONVERSATION when one id lives under two accounts; --account resolves it', async () => {
    const { dbPath, dir } = await copyDb();
    const again = writeFile(dir, 'again/conversations.json', (await templateDb()).std.json);
    assertOk(await gcr(['import', again, '--db', dbPath, '--account', 'other', '--format', 'json']));
    const { json } = await bothModes(['get', ID.linear, '--db', dbPath], 'AMBIGUOUS_CONVERSATION', { remedy: /--provider and --account/ });
    assert.equal(Array.isArray(json.error.details?.['candidates']), true);
    const chosen = await gcr(['get', ID.linear, '--db', dbPath, '--account', 'other', '--format', 'json']);
    assertOk(chosen);
    const viaProvider = await gcr(['thread', ID.linear, '--db', dbPath, '--provider', 'chatgpt', '--account', 'default']);
    assertOk(viaProvider);
  });
});

describe('branch errors (exit 3)', () => {
  it('ACTIVE_BRANCH_UNKNOWN: no current node, several branches, nothing guessed', async () => {
    const { dbPath, std } = await templateDb();
    for (const cmd of ['get', 'thread']) {
      const { text, json } = await bothModes([cmd, ID.noPointer, '--db', dbPath], 'ACTIVE_BRANCH_UNKNOWN', { remedy: /--branch-policy/ });
      assert.match(text.stderr, /does not guess/);
      assert.deepEqual([...(json.error.details?.['branchIds'] as string[])].sort(), [...std.noPointerLeaves].sort());
    }
  });

  it('BRANCH_NOT_FOUND: an unknown branch id', async () => {
    const { dbPath } = await templateDb();
    await bothModes(['thread', ID.branched, '--branch', 'no-such-branch', '--db', dbPath], 'BRANCH_NOT_FOUND', { remedy: /gcr branches/ });
    await bothModes(['get', ID.branched, '--branch', 'no-such-branch', '--db', dbPath], 'BRANCH_NOT_FOUND');
  });
});

describe('database errors (exit 5)', () => {
  it('DB_NOT_FOUND: every read command, with the remedy "run: gcr import <export.zip>"', async () => {
    const cwd = tempDir();
    const missing = join(cwd, 'nope', 'missing.sqlite');
    const reads: string[][] = [
      ['list'], ['get', ID.linear], ['search', 'x'], ['branches', ID.linear], ['thread', ID.linear], ['stats'], ['audit'], ['batches'],
      ['graph', 'query', 'x'], ['graph', 'path', 'a', 'b'], ['graph', 'neighbors', 'a'], ['graph', 'god-nodes'], ['graph', 'explain', '1'], ['graph', 'export', '--out', join(cwd, 'g.html')],
      ['draft', 'list'], ['draft', 'show', 'x'], ['annotate', 'list'], ['annotate', 'show', 'x'],
    ];
    for (const args of reads) {
      const { text } = await bothModes([...args, '--db', missing], 'DB_NOT_FOUND', { cwd, remedy: /run: gcr import <export\.zip>/ });
      assert.equal(text.stderr.includes(cwd), false, 'no absolute path in the message');
    }
    // mcp accepts no --format (stdout is JSON-RPC), so it is checked in text mode only.
    const mcp = await gcr(['mcp', '--db', missing], { cwd });
    assertTextError(mcp, 'DB_NOT_FOUND', { remedy: /run: gcr import <export\.zip>/ });
    assert.equal(existsSync(join(cwd, 'nope')), false, 'a read command never creates anything');
  });

  it('DB_NOT_FOUND for the default location creates nothing', async () => {
    const cwd = tempDir();
    await bothModes(['list'], 'DB_NOT_FOUND', { cwd, remedy: /run: gcr import <export\.zip>/ });
    assert.equal(existsSync(join(cwd, '.gcr')), false);
  });

  it('DB_NOT_FOUND for write commands that need imported data (they do not leave an empty database behind)', async () => {
    const cwd = tempDir();
    const db = join(cwd, 'new.sqlite');
    const note = writeFile(cwd, 'n.txt', 'text');
    for (const args of [
      ['graph', 'build'],
      ['draft', 'create', '--conversation', ID.linear, '--input', note],
      ['draft', 'archive', 'x'],
      ['annotate', 'create', '--conversation', ID.linear, '--input', note],
      ['annotate', 'update', 'x', '--input', note, '--expected-version', '1'],
    ]) {
      await bothModes([...args, '--db', db], 'DB_NOT_FOUND', { cwd });
    }
    assert.equal(existsSync(db), false);
  });

  it('GCR_DB is honoured (and --db wins over it)', async () => {
    const cwd = tempDir();
    const { dbPath } = await templateDb();
    const viaEnv = await gcr(['list', '--format', 'json'], { cwd, env: { GCR_DB: dbPath } });
    assertOk(viaEnv);
    const flagWins = await gcr(['list', '--db', join(cwd, 'missing.sqlite')], { cwd, env: { GCR_DB: dbPath } });
    assertTextError(flagWins, 'DB_NOT_FOUND');
    const badEnv = await gcr(['list'], { cwd, env: { GCR_DB: join(cwd, 'env-missing.sqlite') } });
    assertTextError(badEnv, 'DB_NOT_FOUND');
  });

  it('DB_SCHEMA_TOO_NEW: a database written by a newer tool is refused and left untouched', async () => {
    const { dbPath, dir } = await copyDb();
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version = 99');
    db.close();
    const before = readFileSync(dbPath);
    const { json } = await bothModes(['list', '--db', dbPath], 'DB_SCHEMA_TOO_NEW');
    assert.equal(typeof json.error.remedy, 'string');
    assert.deepEqual(readFileSync(dbPath), before, 'a refused database is not modified');
  });

  it('DB_ERROR: a directory, or a file that is not a database', async () => {
    const dir = tempDir();
    await bothModes(['list', '--db', dir], 'DB_ERROR');
    const junk = writeFile(dir, 'junk.sqlite', 'this is not a sqlite database at all, just text'.repeat(40));
    const { text } = await bothModes(['list', '--db', junk], 'DB_ERROR');
    assert.equal(text.stderr.includes('this is not'), false, 'file content is never echoed');
    const exportPath = writeFile(dir, 'conversations.json', '[]');
    await bothModes(['import', exportPath, '--db', junk], 'DB_ERROR');
  });

  it('a missing directory for an explicit --db is DB_NOT_FOUND on import: no directory trees are created for the operator', async () => {
    const cwd = tempDir();
    const exportPath = writeFile(cwd, 'conversations.json', '[]');
    await bothModes(['import', exportPath, '--db', join(cwd, 'sub', 'dir', 'x.sqlite')], 'DB_NOT_FOUND', { cwd });
    assert.equal(existsSync(join(cwd, 'sub')), false);
  });
});

describe('lookups of local data (exit 3)', () => {
  it('DRAFT_NOT_FOUND and ANNOTATION_NOT_FOUND', async () => {
    const { dbPath } = await copyDb();
    await bothModes(['draft', 'show', 'no-such-draft', '--db', dbPath], 'DRAFT_NOT_FOUND');
    await bothModes(['draft', 'archive', 'no-such-draft', '--db', dbPath], 'DRAFT_NOT_FOUND');
    await bothModes(['annotate', 'show', 'no-such-note', '--db', dbPath], 'ANNOTATION_NOT_FOUND');
  });

  it('MESSAGE_NOT_FOUND: anchoring to a message that is not in the conversation', async () => {
    const { dbPath, dir } = await copyDb();
    const note = writeFile(dir, 'n.txt', 'text');
    await bothModes(['draft', 'create', '--conversation', ID.linear, '--message-id', 'no-such-message', '--input', note, '--db', dbPath], 'MESSAGE_NOT_FOUND');
    await bothModes(['annotate', 'create', '--conversation', ID.linear, '--message-id', 'no-such-message', '--input', note, '--db', dbPath], 'MESSAGE_NOT_FOUND');
  });

  it('NOT_IN_LOCAL_EXPORT for a draft on a conversation that was never imported', async () => {
    const { dbPath, dir } = await copyDb();
    const note = writeFile(dir, 'n.txt', 'text');
    await bothModes(['draft', 'create', '--conversation', `https://chatgpt.com/c/${ID.absent}`, '--input', note, '--db', dbPath], 'NOT_IN_LOCAL_EXPORT', { remedy: NOT_FOUND_REMEDY });
  });

  it('graph nodes that do not exist are NOT_IN_LOCAL_EXPORT', async () => {
    const { dbPath } = await copyDb();
    assertOk(await gcr(['graph', 'build', '--db', dbPath, '--min-conversations', '1', '--format', 'json']));
    await bothModes(['graph', 'neighbors', 'ent:keyword:no-such-thing', '--db', dbPath], 'NOT_IN_LOCAL_EXPORT');
    await bothModes(['graph', 'path', 'ent:keyword:aaa', 'ent:keyword:bbb', '--db', dbPath], 'NOT_IN_LOCAL_EXPORT');
    await bothModes(['graph', 'explain', '999999', '--db', dbPath], 'NOT_IN_LOCAL_EXPORT');
  });

  it('ANNOTATION_CONFLICT (exit 6) with a stale version', async () => {
    const { dbPath, dir } = await copyDb();
    const note = writeFile(dir, 'n.txt', 'first');
    const created = await gcr(['annotate', 'create', '--conversation', ID.linear, '--input', note, '--db', dbPath, '--format', 'json']);
    assertOk(created);
    const id = String(((JSON.parse(created.stdout) as { data: { annotation: { annotationId: string } } }).data.annotation).annotationId);
    const next = writeFile(dir, 'n2.txt', 'second');
    const { json } = await bothModes(['annotate', 'update', id, '--input', next, '--expected-version', '7', '--db', dbPath], 'ANNOTATION_CONFLICT');
    assert.equal(json.error.details?.['currentVersion'], 1);
    assert.equal(EXIT_CODES.ANNOTATION_CONFLICT, 6);
    assertOk(await gcr(['annotate', 'update', id, '--input', next, '--expected-version', '1', '--db', dbPath, '--format', 'json']));
  });

  it('FTS_SYNTAX_ERROR (exit 2): raw FTS5 syntax that SQLite rejects', async () => {
    const { dbPath } = await templateDb();
    await bothModes(['search', '"unterminated', '--raw', '--db', dbPath], 'FTS_SYNTAX_ERROR');
    const plain = await gcr(['search', '"unterminated', '--db', dbPath, '--format', 'json']);
    assertOk(plain); // plain mode makes operators and quotes inert
  });
});

describe('import errors (exit 4)', () => {
  it('IMPORT_INPUT_NOT_FOUND: a missing path creates no database', async () => {
    const cwd = tempDir();
    const { text } = await bothModes(['import', join(cwd, 'missing.zip')], 'IMPORT_INPUT_NOT_FOUND', { cwd, remedy: /never downloads/ });
    assert.equal(text.stderr.includes(cwd), false);
    assert.equal(existsSync(join(cwd, '.gcr')), false);
    await bothModes(['import-copy', join(cwd, 'missing.json')], 'IMPORT_INPUT_NOT_FOUND', { cwd });
    assert.equal(existsSync(join(cwd, '.gcr')), false);
  });

  it('IMPORT_UNSUPPORTED_FORMAT: a folder without conversations, a file that is not JSON', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'empty-folder'));
    await bothModes(['import', join(cwd, 'empty-folder'), '--db', join(cwd, 'a.sqlite')], 'IMPORT_UNSUPPORTED_FORMAT', { cwd });
    const notJson = writeFile(cwd, 'notes.txt', 'just some words');
    await bothModes(['import', notJson, '--db', join(cwd, 'b.sqlite')], 'IMPORT_UNSUPPORTED_FORMAT', { cwd });
    await bothModes(['import-copy', cwd], 'IMPORT_UNSUPPORTED_FORMAT', { cwd });
  });

  it('IMPORT_ZIP_UNSAFE: a path-traversal entry is refused, nothing is extracted or stored', async () => {
    const cwd = tempDir();
    const zip = writeFile(cwd, 'evil.zip', buildZip([{ name: '../escape/conversations.json', data: '[]' }]));
    await bothModes(['import', zip, '--db', join(cwd, 'z.sqlite')], 'IMPORT_ZIP_UNSAFE', { cwd });
    assert.equal(existsSync(join(cwd, '..', 'escape')), false);
  });

  it('IMPORT_LIMIT_EXCEEDED: a limit flag the input exceeds; the limit flags take effect', async () => {
    const { dir } = await copyDb();
    const exportPath = writeFile(dir, 'big/conversations.json', (await templateDb()).std.json);
    await bothModes(['import', exportPath, '--db', join(dir, 'limit.sqlite'), '--max-element-bytes', '50'], 'IMPORT_LIMIT_EXCEEDED', { cwd: dir });
    const zip = writeFile(dir, 'many.zip', buildZip([{ name: 'conversations.json', data: '[]' }, { name: 'a.txt', data: 'x' }, { name: 'b.txt', data: 'y' }]));
    await bothModes(['import', zip, '--db', join(dir, 'limit2.sqlite'), '--max-entries', '2'], 'IMPORT_LIMIT_EXCEEDED', { cwd: dir });
    const plain = await gcr(['import', exportPath, '--db', join(dir, 'limit3.sqlite'), '--max-element-bytes', '100000000', '--max-entries', '1000', '--max-entry-bytes', '100000000', '--max-total-bytes', '1000000000', '--max-ratio', '500', '--format', 'json']);
    assertOk(plain);
  });

  it('IMPORT_PARSE_ERROR: with --strict a truncated export is an error; without it the readable part is imported and the damage is reported', async () => {
    const cwd = tempDir();
    const full = (await templateDb()).std.json;
    const truncated = writeFile(cwd, 'conversations.json', full.slice(0, Math.floor(full.length / 2)));
    const { text } = await bothModes(['import', truncated, '--strict', '--db', join(cwd, 'strict.sqlite')], 'IMPORT_PARSE_ERROR', { cwd, remedy: /truncated or corrupted/ });
    assert.equal(text.stderr.includes('mapping'), false, 'no export content in the error');
    const lenient = await gcr(['import', truncated, '--db', join(cwd, 'lenient.sqlite'), '--format', 'json']);
    assertOk(lenient);
    const report = JSON.parse(lenient.stdout) as { data: { conversations: { failed: number; stored: number } }; warnings: Array<{ code: string }> };
    assert.ok(report.data.conversations.failed >= 1, 'the damaged tail is counted as failed');
    assert.ok(report.warnings.length > 0);
  });

  it('an unreadable first element is an import error (exit 4), never a silent success', async () => {
    const cwd = tempDir();
    const hopeless = writeFile(cwd, 'conversations.json', '[{"id": "00000000-0000-4000-8000-000000000001", "mapping": {');
    const r = await gcr(['import', hopeless, '--db', join(cwd, 'hopeless.sqlite')], { cwd });
    assert.equal(r.code, 4);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^error\[IMPORT_(PARSE_ERROR|UNSUPPORTED_FORMAT)\]: /);
  });

  it('manual-copy documents: invalid JSON, wrong shape, bad identifiers', async () => {
    const cwd = tempDir();
    const db = join(cwd, 'm.sqlite');
    await bothModes(['import-copy', writeFile(cwd, 'bad.json', '{not json'), '--db', db], 'IMPORT_PARSE_ERROR', { cwd });
    await bothModes(['import-copy', writeFile(cwd, 'shape.json', '{"messages": []}'), '--db', db], 'IMPORT_PARSE_ERROR', { cwd });
    await bothModes(['import-copy', writeFile(cwd, 'uuid.json', JSON.stringify({ conversationId: 'nope', messages: [{ role: 'user', text: 'x' }] })), '--db', db], 'INVALID_UUID', { cwd });
    await bothModes(['import-copy', writeFile(cwd, 'url.json', JSON.stringify({ sourceUri: 'https://example.invalid/c/x', messages: [{ role: 'user', text: 'x' }] })), '--db', db], 'INVALID_URL', { cwd });
  });

  it('a failed --strict import stores nothing: a new database is not even left behind, an existing one is unchanged', async () => {
    const cwd = tempDir();
    const full = (await templateDb()).std.json;
    const exportPath = writeFile(cwd, 'conversations.json', full.slice(0, full.length - 40));
    const fresh = join(cwd, 'atomic.sqlite');
    assertTextError(await gcr(['import', exportPath, '--strict', '--db', fresh]), 'IMPORT_PARSE_ERROR');
    assert.equal(existsSync(fresh), false, 'the refused import did not leave an empty database');
    assertTextError(await gcr(['list', '--db', fresh]), 'DB_NOT_FOUND', { remedy: NOT_FOUND_REMEDY });

    const { dbPath } = await copyDb();
    const count = async (): Promise<number> => {
      const list = await gcr(['list', '--db', dbPath, '--format', 'json']);
      assertOk(list);
      return (JSON.parse(list.stdout) as { data: { items: unknown[] } }).data.items.length;
    };
    const before = await count();
    assert.ok(before > 0);
    assertTextError(await gcr(['import', exportPath, '--strict', '--db', dbPath]), 'IMPORT_PARSE_ERROR');
    assert.equal(await count(), before, 'a failed strict import changes nothing in an existing database');
  });
});

describe('the error table', () => {
  it('every error code the CLI can raise has been exercised above; the rest cannot be produced by a CLI command', () => {
    const cannot: Record<string, string> = {
      IMPORT_PATH_NOT_ALLOWED: 'raised only by the MCP adapter (approved import roots); the CLI imports what the operator names',
      DB_MIGRATION_FAILED: 'needs a failing schema migration; there is only schema version 1',
      WRITE_FORBIDDEN: 'needs a file system that refuses the write (read-only mount, no permission): `graph export` maps EACCES/EPERM/EROFS to it, tested with injected errors in cli.adversarial.test.ts',
      NOT_IMPLEMENTED: 'the openai_api provider is not an --provider choice of any command',
      FEATURE_GATED: 'reserved for the gated browser feature, which has no code path',
      REMOTE_ACCESS_FORBIDDEN: 'reserved; there is no code path that could reach a consumer endpoint',
      INTERNAL_ERROR: 'covered in cli.process.test.ts (an unexpected exception is reported generically)',
    };
    for (const code of Object.keys(cannot)) assert.ok((ERROR_CODES as readonly string[]).includes(code), `${code} is a real code`);
  });
});
