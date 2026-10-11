/**
 * The commands that write: import and import-copy, the default database location and its permissions, drafts,
 * annotations and the knowledge graph (including the HTML export's overwrite and symlink protections).
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildZip } from '../helpers/zip-builder.js';
import { FIXTURES, HOSTILE, ID, arr, assertClean, assertJsonError, assertOk, assertTextError, copyDb, envelope, gcr, obj, parseJsonl, standardExport, tempDir, templateDb, writeFile } from './cli.helpers.test.js';
import type { Envelope } from './cli.helpers.test.js';

const COPY_ID = '00000000-0000-4000-8000-0000000000c1';
const mode = (path: string): number => statSync(path).mode & 0o777;
const octal = (n: number): string => n.toString(8).padStart(4, '0');

async function importJson(args: string[], opts: Parameters<typeof gcr>[1] = {}): Promise<Envelope> {
  const r = await gcr([...args, '--format', 'json'], opts);
  assertOk(r, `gcr ${args.join(' ')}`);
  return envelope(r.stdout);
}

describe('import', () => {
  it('imports a ZIP, a folder, a conversations.json file and standard input into equivalent databases', async () => {
    const dir = tempDir();
    const std = standardExport();
    const zip = writeFile(dir, 'export.zip', buildZip([{ name: 'conversations.json', data: std.json }, { name: 'user.json', data: '{"email":"synthetic-person@example.invalid"}' }]));
    mkdirSync(join(dir, 'folder'));
    writeFile(dir, 'folder/conversations.json', std.json);
    const file = writeFile(dir, 'plain/conversations.json', std.json);
    const kinds: Array<[string, string[], Parameters<typeof gcr>[1]]> = [
      ['zip', [zip], {}],
      ['folder', [join(dir, 'folder')], {}],
      ['file', [file], {}],
      ['stdin', ['-'], { stdin: std.json }],
    ];
    const ids: string[] = [];
    for (const [name, input, opts] of kinds) {
      const db = join(dir, `${name}.sqlite`);
      const env = await importJson(['import', ...input, '--db', db], opts);
      const report = env.data;
      assert.equal(obj(report['conversations'])['stored'], 5, `${name}: conversations stored`);
      assert.equal(report['alreadyImported'], false);
      ids.push(String(report['batchId']));
      const list = envelope((await gcr(['list', '--db', db, '--format', 'json'])).stdout);
      assert.equal(arr(list.data['items']).length, 5);
    }
    assert.equal(new Set(ids).size, 1, 'the same conversations.json bytes give the same batch whatever the container');
    const stdinReport = await importJson(['import', '-', '--db', join(dir, 'stdin2.sqlite')], { stdin: std.json });
    assert.equal(stdinReport.data['sourceKind'], 'stdin_json');
    assert.equal(stdinReport.data['sourceLabel'], 'stdin');
  });

  it('is idempotent: importing the same input again changes nothing', async () => {
    const dir = tempDir();
    const file = writeFile(dir, 'conversations.json', standardExport().json);
    const db = join(dir, 'idem.sqlite');
    const first = await importJson(['import', file, '--db', db]);
    const listBefore = (await gcr(['list', '--db', db, '--format', 'json'])).stdout;
    const second = await importJson(['import', file, '--db', db]);
    assert.equal(first.data['alreadyImported'], false);
    assert.equal(second.data['alreadyImported'], true);
    assert.equal(second.data['batchId'], first.data['batchId']);
    assert.equal(obj(second.data['conversations'])['newlyInserted'], 0);
    assert.equal((await gcr(['list', '--db', db, '--format', 'json'])).stdout, listBefore);
    const batches = await importJson(['batches', '--db', db]);
    assert.equal(arr(batches.data).length, 1);
  });

  it('never prints message text, titles or file contents, in any format', async () => {
    const dir = tempDir();
    const std = standardExport();
    const zip = writeFile(dir, 'export.zip', buildZip([{ name: 'conversations.json', data: std.json }, { name: 'user.json', data: '{"email":"synthetic-person@example.invalid"}' }]));
    for (const format of ['json', 'markdown', 'compact', 'jsonl']) {
      const r = await gcr(['import', zip, '--db', join(dir, `p-${format}.sqlite`), '--format', format]);
      assertOk(r);
      for (const secret of ['quokka', 'marsupial', 'zebra', 'follow up question', 'alpha linear plan', 'synthetic-person', '@example.invalid']) {
        assert.equal(r.stdout.includes(secret), false, `${format} import report contains "${secret}"`);
      }
      assert.equal(r.stdout.includes(dir), false, 'no absolute path');
    }
  });

  it('--account keeps exports apart; --provider forces the provider; Claude exports are detected and marked as rendered views', async () => {
    const dir = tempDir();
    const db = join(dir, 'multi.sqlite');
    const chat = writeFile(dir, 'chat/conversations.json', standardExport().json);
    const work = await importJson(['import', chat, '--db', db, '--account', 'work']);
    assert.equal(work.data['accountLabel'], 'work');
    const forced = await importJson(['import', chat, '--db', db, '--account', 'forced', '--provider', 'chatgpt']);
    assert.equal(forced.data['accountLabel'], 'forced');
    const claude = readFileSync(join(FIXTURES, 'claude', 'linear.json'));
    const claudeFile = writeFile(dir, 'claude/conversations.json', claude);
    const imported = await importJson(['import', claudeFile, '--db', db, '--account', 'claude-acct']);
    assert.equal(imported.data['provider'], 'claude');
    assert.equal(imported.completeness, 'rendered_active_view_only');
    assert.equal(imported.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
    const onlyClaude = envelope((await gcr(['list', '--provider', 'claude', '--db', db, '--format', 'json'])).stdout);
    assert.ok(arr(onlyClaude.data['items']).length >= 1);
    assert.equal(onlyClaude.completeness, 'rendered_active_view_only');
    const onlyWork = envelope((await gcr(['list', '--account', 'work', '--db', db, '--format', 'json'])).stdout);
    assert.equal(arr(onlyWork.data['items']).length, 5);
    assertTextError(await gcr(['import', chat, '--db', db, '--account', 'bad/label']), 'INVALID_ARGUMENT');
    assertTextError(await gcr(['import', chat, '--db', db, '--provider', 'openai_api']), 'INVALID_ARGUMENT');
  });

  it('--strict succeeds on a clean export', async () => {
    const dir = tempDir();
    const file = writeFile(dir, 'conversations.json', standardExport().json);
    const env = await importJson(['import', file, '--strict', '--db', join(dir, 's.sqlite')]);
    assert.equal(obj(env.data['conversations'])['failed'], 0);
  });

  it('a file or folder whose name looks like an option is reachable with "--" or "./"', async () => {
    const dir = tempDir();
    const weird = writeFile(dir, '-weird.json', standardExport().json);
    assert.ok(existsSync(weird));
    const db = join(dir, 'weird.sqlite');
    const viaTerminator = await gcr(['import', '--db', db, '--format', 'json', '--', '-weird.json'], { cwd: dir });
    assertOk(viaTerminator);
    assert.equal(obj(envelope(viaTerminator.stdout).data['conversations'])['stored'], 5);
    const viaDotSlash = await importJson(['import', './-weird.json', '--db', join(dir, 'weird2.sqlite')], { cwd: dir });
    assert.equal(obj(viaDotSlash.data['conversations'])['stored'], 5);
    const bare = await gcr(['import', '-weird.json', '--db', join(dir, 'weird3.sqlite')], { cwd: dir });
    assertTextError(bare, 'INVALID_ARGUMENT');
    const eq = await importJson([`--db=${join(dir, 'weird4.sqlite')}`, 'import', './-weird.json'], { cwd: dir });
    assert.equal(obj(eq.data['conversations'])['stored'], 5);
  });
});

describe('default database location and permissions', () => {
  it('creates ./.gcr with mode 0700 on the first write, and the database with mode 0600; says so on stderr', async () => {
    const cwd = tempDir();
    const file = writeFile(cwd, 'conversations.json', standardExport().json);
    const first = await gcr(['import', file, '--format', 'json'], { cwd });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stderr, 'note: created ./.gcr (mode 0700) for the default database\n');
    envelope(first.stdout);
    assert.equal(octal(mode(join(cwd, '.gcr'))), '0700');
    assert.equal(octal(mode(join(cwd, '.gcr', 'gcr.sqlite'))), '0600');
    const second = await gcr(['import', file, '--format', 'json'], { cwd });
    assertOk(second, 'second import: the directory exists, so there is nothing to report');
    const list = await gcr(['list', '--format', 'json'], { cwd });
    assertOk(list);
    assert.equal(arr(envelope(list.stdout).data['items']).length, 5);
  });

  it('--quiet suppresses the note; it is never part of stdout', async () => {
    const cwd = tempDir();
    const file = writeFile(cwd, 'conversations.json', standardExport().json);
    const r = await gcr(['import', file, '--quiet', '--format', 'json'], { cwd });
    assertOk(r);
    assert.equal(existsSync(join(cwd, '.gcr', 'gcr.sqlite')), true);
  });

  it('leaves the permissions of an existing ./.gcr alone', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, '.gcr'), { mode: 0o755 });
    const file = writeFile(cwd, 'conversations.json', standardExport().json);
    const r = await gcr(['import', file, '--format', 'json'], { cwd });
    assertOk(r);
    assert.equal(octal(mode(join(cwd, '.gcr'))), '0755');
  });

  it('$GCR_DB selects the database; its directory is never created for the operator', async () => {
    const cwd = tempDir();
    const file = writeFile(cwd, 'conversations.json', standardExport().json);
    const db = join(cwd, 'via-env.sqlite');
    assertOk(await gcr(['import', file, '--format', 'json'], { cwd, env: { GCR_DB: db } }));
    assert.equal(existsSync(db), true);
    assert.equal(existsSync(join(cwd, '.gcr')), false);
    assert.equal(octal(mode(db)), '0600');
    const missingDir = await gcr(['import', file], { cwd, env: { GCR_DB: join(cwd, 'nope', 'x.sqlite') } });
    assertTextError(missingDir, 'DB_NOT_FOUND');
  });
});

describe('import-copy (Mode B)', () => {
  const copy = JSON.stringify({
    conversationId: COPY_ID,
    title: 'GCR-SYNTHETIC-FIXTURE copied by hand',
    sourceUri: `https://chatgpt.com/c/${COPY_ID}`,
    messages: [
      { role: 'user', text: 'a copied question about okapi', createdAt: '2025-03-04T05:06:07Z' },
      { role: 'assistant', text: 'a copied answer about okapi', modelSlug: 'synthetic-model-9' },
    ],
  });

  it('indexes a manual copy and labels it partial everywhere', async () => {
    const dir = tempDir();
    const db = join(dir, 'copy.sqlite');
    const file = writeFile(dir, 'copied-messages.json', copy);
    const env = await importJson(['import-copy', file, '--db', db]);
    assert.equal(env.completeness, 'partial_user_supplied');
    assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
    assert.ok(env.warnings.some((w) => w.code === 'PARTIAL_USER_SUPPLIED'));
    assert.equal(env.data['sourceKind'], 'manual_copy');
    assert.equal(env.data['sourceLabel'], 'copied-messages.json');
    for (const format of ['markdown', 'compact']) {
      const r = await gcr(['import-copy', file, '--db', db, '--format', format]);
      assertOk(r);
      assert.match(r.stdout, /NOTICE: completeness is "partial_user_supplied"/);
      assert.equal(r.stdout.includes('okapi'), false, 'no message text in the report');
    }
    const list = envelope((await gcr(['list', '--db', db, '--format', 'json'])).stdout);
    assert.equal(arr(list.data['items'])[0]?.['completeness'], 'partial_user_supplied');
    const got = await gcr(['get', COPY_ID, '--db', db, '--format', 'json']);
    assertOk(got);
    const thread = envelope(got.stdout);
    assert.equal(thread.completeness, 'partial_user_supplied');
    assert.equal(thread.data['activeness'], 'unknown', 'a manual copy never claims to know the active branch');
    assert.equal(arr(thread.data['messages']).length, 2);
  });

  it('reads standard input, is idempotent, and rejects unusable input', async () => {
    const dir = tempDir();
    const db = join(dir, 'copy2.sqlite');
    const first = await importJson(['import-copy', '-', '--db', db], { stdin: copy });
    assert.equal(first.data['sourceLabel'], 'stdin');
    const second = await importJson(['import-copy', '-', '--db', db], { stdin: copy });
    assert.equal(second.data['alreadyImported'], true);
    assertTextError(await gcr(['import-copy', '-', '--db', db], { stdin: '' }), 'IMPORT_PARSE_ERROR');
    assertTextError(await gcr(['import-copy', '-', '--db', db], { stdin: Buffer.from([0xff, 0xfe, 0x00, 0x41]) }), 'IMPORT_UNSUPPORTED_FORMAT');
  });

  it('the input is bounded (64 MiB) and must be a regular file', async () => {
    const dir = tempDir();
    const big = join(dir, 'big.json');
    writeFileSync(big, '');
    truncateSync(big, 65 * 1024 * 1024);
    assertTextError(await gcr(['import-copy', big, '--db', join(dir, 'big.sqlite')]), 'IMPORT_LIMIT_EXCEEDED');
    assertTextError(await gcr(['import-copy', dir, '--db', join(dir, 'dir.sqlite')]), 'IMPORT_UNSUPPORTED_FORMAT');
  });
});

describe('drafts (local, never sent)', () => {
  it('create prints the id, the manual-continuation link and the sentence that GCR never sends messages', async () => {
    const { dbPath, dir } = await copyDb();
    const body = writeFile(dir, 'reply.md', 'Thanks, that answers it.\n');
    const md = await gcr(['draft', 'create', '--conversation', ID.linear, '--input', body, '--title', 'Reply idea', '--db', dbPath]);
    assertOk(md);
    assert.match(md.stdout, /Draft id: `[0-9a-f-]{36}`/);
    assert.ok(md.stdout.includes(`https://chatgpt.com/c/${ID.linear}`));
    assert.ok(md.stdout.includes('GCR never sends messages'));
    assert.equal(md.stdout.includes('Thanks, that answers it.'), false, 'the summary does not echo the draft text');
    const compact = await gcr(['draft', 'create', '--conversation', `https://chatgpt.com/c/${ID.linear}`, '--input', body, '--format', 'compact', '--db', dbPath]);
    assertOk(compact);
    assert.ok(compact.stdout.includes('GCR never sends messages'));
    assert.ok(compact.stdout.includes(`https://chatgpt.com/c/${ID.linear}`));
    const j = envelope((await gcr(['draft', 'create', '--conversation', ID.linear, '--input', '-', '--format', 'json', '--db', dbPath], { stdin: 'from stdin' })).stdout);
    const draft = obj(j.data['draft']);
    assert.equal(j.data['localOnly'], true);
    assert.equal(draft['status'], 'draft');
    assert.equal(draft['body'], 'from stdin');
    assert.equal(obj(draft['manualContinuation'])['url'], `https://chatgpt.com/c/${ID.linear}`);
    assert.match(String(obj(draft['manualContinuation'])['note']), /GCR never sends messages/);
    assert.equal(draft['createdVia'], 'cli');
    const jsonl = await gcr(['draft', 'create', '--conversation', ID.linear, '--input', body, '--format', 'jsonl', '--db', dbPath]);
    assertOk(jsonl);
    assert.equal(parseJsonl(jsonl.stdout)[0]?.['type'], 'header');
  });

  it('list filters by conversation, namespace and status; show quotes the text as data; archive is idempotent', async () => {
    const { dbPath, dir, std: s } = await copyDb();
    const body = writeFile(dir, 'd.md', 'first draft');
    const create = async (args: string[]): Promise<string> => {
      const r = await gcr(['draft', 'create', '--input', body, '--format', 'json', '--db', dbPath, ...args]);
      assertOk(r);
      return String(obj(envelope(r.stdout).data['draft'])['draftId']);
    };
    const a = await create(['--conversation', ID.linear]);
    const b = await create(['--conversation', ID.branched, '--namespace', 'ideas', '--message-id', s.branched.a1]);
    const all = envelope((await gcr(['draft', 'list', '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(arr(all.data['items']).length, 2);
    const byConv = envelope((await gcr(['draft', 'list', '--conversation', ID.branched, '--format', 'json', '--db', dbPath])).stdout);
    assert.deepEqual(arr(byConv.data['items']).map((d) => d['draftId']), [b]);
    const byNs = envelope((await gcr(['draft', 'list', '--namespace', 'ideas', '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(arr(byNs.data['items']).length, 1);
    for (const format of ['markdown', 'compact']) assertOk(await gcr(['draft', 'list', '--format', format, '--db', dbPath]));

    const shown = await gcr(['draft', 'show', a, '--db', dbPath]);
    assertOk(shown);
    assert.ok(shown.stdout.includes('first draft'));
    assert.match(shown.stdout, /not sent/i);
    assertOk(await gcr(['draft', 'show', a, '--format', 'json', '--db', dbPath]));
    assertOk(await gcr(['draft', 'show', a, '--format', 'compact', '--db', dbPath]));

    const archived = envelope((await gcr(['draft', 'archive', a, '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(obj(archived.data['draft'])['status'], 'archived');
    const again = await gcr(['draft', 'archive', a, '--format', 'json', '--db', dbPath]);
    assertOk(again, 'archiving twice');
    const open = envelope((await gcr(['draft', 'list', '--status', 'draft', '--format', 'json', '--db', dbPath])).stdout);
    assert.deepEqual(arr(open.data['items']).map((d) => d['draftId']), [b]);
    assertOk(await gcr(['draft', 'archive', b, '--db', dbPath]));
    assertOk(await gcr(['draft', 'archive', b, '--format', 'compact', '--db', dbPath]));
  });

  it('a hostile draft body is shown as quoted data: no terminal control characters reach the output', async () => {
    const { dbPath, dir } = await copyDb();
    const body = writeFile(dir, 'hostile.md', HOSTILE.text);
    const created = await gcr(['draft', 'create', '--conversation', ID.linear, '--input', body, '--format', 'json', '--db', dbPath]);
    assertOk(created);
    const id = String(obj(envelope(created.stdout).data['draft'])['draftId']);
    for (const format of ['markdown', 'compact', 'json', 'jsonl']) {
      const r = await gcr(['draft', 'show', id, '--format', format, '--db', dbPath]);
      assertOk(r, `draft show --format ${format}`);
      assertClean(r.stdout, `draft show --format ${format}`);
    }
  });

  it('the draft namespace and size are validated', async () => {
    const { dbPath, dir } = await copyDb();
    const body = writeFile(dir, 'd.md', 'x');
    assertTextError(await gcr(['draft', 'create', '--conversation', ID.linear, '--input', body, '--namespace', 'Bad Name', '--db', dbPath]), 'INVALID_ARGUMENT');
    const big = writeFile(dir, 'big.md', 'a'.repeat(256 * 1024 + 1));
    assertTextError(await gcr(['draft', 'create', '--conversation', ID.linear, '--input', big, '--db', dbPath]), 'INVALID_ARGUMENT', { remedy: /256 KiB/ });
    const exact = writeFile(dir, 'exact.md', 'a'.repeat(256 * 1024));
    assertOk(await gcr(['draft', 'create', '--conversation', ID.linear, '--input', exact, '--format', 'compact', '--db', dbPath]));
    assertTextError(await gcr(['draft', 'create', '--conversation', ID.linear, '--input', '-', '--db', dbPath], { stdin: 'a'.repeat(256 * 1024 + 1) }), 'INVALID_ARGUMENT');
  });
});

describe('input files are read defensively', () => {
  it('refuses a directory, a non-UTF-8 file and a symlink that points outside its own directory', async () => {
    const { dbPath, dir } = await copyDb();
    const args = (input: string): string[] => ['draft', 'create', '--conversation', ID.linear, '--input', input, '--db', dbPath];
    assertTextError(await gcr(args(dir)), 'INVALID_ARGUMENT', { remedy: /not a directory|regular file|standard input/i });
    const binary = join(dir, 'binary.bin');
    writeFileSync(binary, Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x00]));
    const notUtf8 = await gcr(args(binary));
    assertTextError(notUtf8, 'INVALID_ARGUMENT');
    assert.match(notUtf8.stderr, /not valid UTF-8/);

    const outsideDir = tempDir('gcr-outside-');
    const secret = join(outsideDir, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET-CONTENT');
    const link = join(dir, 'link.txt');
    symlinkSync(secret, link);
    const refused = await gcr(args(link));
    assertTextError(refused, 'INVALID_ARGUMENT');
    assert.match(refused.stderr, /points outside its own directory/);
    assert.equal(refused.stderr.includes('TOP-SECRET'), false);

    const relative = join(dir, 'relative-link.txt');
    symlinkSync('../' + outsideDir.split('/').at(-1) + '/secret.txt', relative);
    assertTextError(await gcr(args(relative)), 'INVALID_ARGUMENT');

    const target = join(dir, 'real.txt');
    writeFileSync(target, 'inside');
    const inside = join(dir, 'inside-link.txt');
    symlinkSync('real.txt', inside);
    assertOk(await gcr([...args(inside), '--format', 'compact']));
    assertTextError(await gcr(args(join(dir, 'dangling-link.txt'))), 'INVALID_ARGUMENT');
    symlinkSync('nowhere.txt', join(dir, 'dangling-link.txt'));
    assertTextError(await gcr(args(join(dir, 'dangling-link.txt'))), 'INVALID_ARGUMENT');
  });

  it('a file whose name starts with a dash is reachable with --input=', async () => {
    const { dbPath, dir } = await copyDb();
    const file = writeFile(dir, '-notes.txt', 'dash file');
    assertOk(await gcr(['draft', 'create', '--conversation', ID.linear, `--input=${file}`, '--db', dbPath, '--format', 'compact']));
    const relative = await gcr(['draft', 'create', '--conversation', ID.linear, '--input=-notes.txt', '--db', dbPath, '--format', 'compact'], { cwd: dir });
    assertOk(relative);
  });
});

describe('annotations (local)', () => {
  it('create, show, update with the right version, list with filters', async () => {
    const { dbPath, dir, std: s } = await copyDb();
    const one = writeFile(dir, 'one.txt', 'first note');
    const created = await gcr(['annotate', 'create', '--conversation', ID.branched, '--message-id', s.branched.a1, '--kind', 'todo', '--input', one, '--format', 'json', '--db', dbPath]);
    assertOk(created);
    const ann = obj(envelope(created.stdout).data['annotation']);
    const id = String(ann['annotationId']);
    assert.equal(ann['version'], 1);
    assert.equal(ann['messageId'], s.branched.a1);
    assert.equal(ann['kind'], 'todo');
    for (const format of ['markdown', 'compact', 'jsonl']) assertOk(await gcr(['annotate', 'show', id, '--format', format, '--db', dbPath]));
    const shown = await gcr(['annotate', 'show', id, '--db', dbPath]);
    assert.ok(shown.stdout.includes('first note'), 'show prints the text (fenced)');

    const two = writeFile(dir, 'two.txt', 'second note');
    const updated = await gcr(['annotate', 'update', id, '--input', two, '--expected-version', '1', '--format', 'json', '--db', dbPath]);
    assertOk(updated);
    assert.equal(obj(envelope(updated.stdout).data['annotation'])['version'], 2);
    let version = 2;
    for (const format of ['markdown', 'compact']) {
      const r = await gcr(['annotate', 'update', id, '--input', two, '--expected-version', String(version++), '--format', format, '--db', dbPath]);
      assertOk(r);
    }

    await gcr(['annotate', 'create', '--conversation', ID.linear, '--input', one, '--db', dbPath]);
    const all = envelope((await gcr(['annotate', 'list', '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(arr(all.data['items']).length, 2);
    const byMessage = envelope((await gcr(['annotate', 'list', '--conversation', ID.branched, '--message-id', s.branched.a1, '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(arr(byMessage.data['items']).length, 1);
    const byKind = envelope((await gcr(['annotate', 'list', '--kind', 'note', '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(arr(byKind.data['items']).length, 1);
    for (const format of ['markdown', 'compact']) assertOk(await gcr(['annotate', 'list', '--format', format, '--db', dbPath]));
  });

  it('imported originals are untouched by local writes', async () => {
    const { dbPath, dir } = await copyDb();
    const before = (await gcr(['get', ID.linear, '--format', 'json', '--db', dbPath])).stdout;
    const note = writeFile(dir, 'n.txt', 'note');
    assertOk(await gcr(['annotate', 'create', '--conversation', ID.linear, '--input', note, '--db', dbPath, '--format', 'compact']));
    assertOk(await gcr(['draft', 'create', '--conversation', ID.linear, '--input', note, '--db', dbPath, '--format', 'compact']));
    assert.equal((await gcr(['get', ID.linear, '--format', 'json', '--db', dbPath])).stdout, before);
  });
});

describe('graph', () => {
  it('build, query, neighbors, path, god-nodes and explain work together, in every format', async () => {
    const { dbPath } = await copyDb();
    const built = await gcr(['graph', 'build', '--min-conversations', '1', '--format', 'json', '--db', dbPath]);
    assertOk(built);
    const stats = envelope(built.stdout).data;
    assert.ok(Number(stats['nodes']) > 5 && Number(stats['edges']) > 5);
    for (const format of ['markdown', 'compact', 'jsonl']) assertOk(await gcr(['graph', 'build', '--min-conversations', '1', '--kinds', 'keyword,tool', '--format', format, '--db', dbPath]));

    const q = envelope((await gcr(['graph', 'query', 'quokka', '--format', 'json', '--db', dbPath])).stdout);
    const nodes = arr(q.data['nodes']);
    assert.ok(nodes.some((n) => n['label'] === 'quokka'), 'the keyword node is found');
    assert.ok(nodes.some((n) => n['kind'] === 'conversation'));
    for (const format of ['markdown', 'compact', 'jsonl']) assertOk(await gcr(['graph', 'query', 'quokka', '--depth', '1', '--max-nodes', '5', '--kinds', 'keyword,conversation', '--format', format, '--db', dbPath]));

    const conv = nodes.find((n) => n['kind'] === 'conversation');
    const keyword = nodes.find((n) => n['label'] === 'quokka');
    const convId = String(conv?.['id']);
    const keywordId = String(keyword?.['id']);
    const nb = envelope((await gcr(['graph', 'neighbors', keywordId, '--limit', '3', '--format', 'json', '--db', dbPath])).stdout);
    assert.ok(arr(nb.data['neighbors']).length >= 1);
    assertOk(await gcr(['graph', 'neighbors', convId, '--edge-kinds', 'mentioned_in', '--kinds', 'keyword', '--format', 'compact', '--db', dbPath]));

    const path = envelope((await gcr(['graph', 'path', convId, keywordId, '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(path.data['found'], true);
    assertOk(await gcr(['graph', 'path', convId, keywordId, '--max-depth', '2', '--format', 'markdown', '--db', dbPath]));

    const gods = envelope((await gcr(['graph', 'god-nodes', '--limit', '3', '--format', 'json', '--db', dbPath])).stdout);
    assert.equal((gods.data as unknown as unknown[]).length, 3);
    assertOk(await gcr(['graph', 'god-nodes', '--kinds', 'keyword', '--format', 'compact', '--db', dbPath]));

    const edge = arr(q.data['edges'])[0];
    const byId = envelope((await gcr(['graph', 'explain', String(edge?.['id']), '--format', 'json', '--db', dbPath])).stdout);
    assert.ok(arr(byId.data['evidence']).length >= 1);
    assert.ok(arr(byId.data['evidence']).every((e) => typeof e['conversationId'] === 'string' && Array.isArray(e['branchIds'])), 'every fact cites conversation, message and branch ids');
    const byTriple = envelope((await gcr(['graph', 'explain', String(edge?.['src']), String(edge?.['dst']), String(edge?.['kind']), '--limit', '1', '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(arr(byTriple.data['evidence']).length, 1);
    for (const format of ['markdown', 'compact', 'jsonl']) assertOk(await gcr(['graph', 'explain', String(edge?.['id']), '--format', format, '--db', dbPath]));
  });

  it('an unbuilt graph is reported, not invented', async () => {
    const { dbPath } = await copyDb();
    const env = envelope((await gcr(['graph', 'query', 'quokka', '--format', 'json', '--db', dbPath])).stdout);
    assert.equal(arr(env.data['nodes']).length, 0);
    assert.ok(env.warnings.some((w) => w.code === 'GRAPH_EMPTY'));
  });
});

describe('graph export: a private file written with care', () => {
  async function exportDb(): Promise<{ dbPath: string; dir: string }> {
    const { dbPath, dir } = await copyDb();
    assertOk(await gcr(['graph', 'build', '--min-conversations', '1', '--format', 'json', '--db', dbPath]));
    return { dbPath, dir };
  }

  it('creates the file with mode 0600 and prints the path written (basename only in JSON)', async () => {
    const { dbPath, dir } = await exportDb();
    const out = join(dir, 'graph.html');
    const md = await gcr(['graph', 'export', '--out', out, '--db', dbPath]);
    assertOk(md);
    assert.ok(md.stdout.includes(out), 'the human format prints the path as given');
    assert.equal(octal(mode(out)), '0600');
    const html = readFileSync(out, 'utf8');
    assert.match(html, /^<!doctype html>/i);
    assert.equal(/<script[^>]+\ssrc=|<link[^>]+\shref=|<img[^>]+\ssrc=|url\(\s*["']?https?:|@import|<iframe/i.test(html), false, 'the page loads nothing from the network');

    const out2 = join(dir, 'sub-term.html');
    const json = await gcr(['graph', 'export', '--out', out2, '--term', 'quokka', '--depth', '1', '--max-nodes', '10', '--title', 'Quokka graph', '--kinds', 'keyword,conversation', '--format', 'json', '--db', dbPath]);
    assertOk(json);
    const data = envelope(json.stdout).data;
    assert.equal(data['file'], 'sub-term.html', 'JSON carries the file name only');
    assert.equal(json.stdout.includes(dir), false);
    assert.equal(data['mode'], '0600');
    assert.equal(data['bytes'], statSync(out2).size);
    assert.equal(readFileSync(out2, 'utf8').includes('Quokka graph'), true);
    const relative = await gcr(['graph', 'export', '--out', 'rel.html', '--format', 'compact', '--db', dbPath], { cwd: dir });
    assertOk(relative);
    assert.ok(relative.stdout.includes('rel.html'));
  });

  it('never overwrites silently; --force replaces a regular file (and tightens it to 0600)', async () => {
    const { dbPath, dir } = await exportDb();
    const out = join(dir, 'graph.html');
    writeFileSync(out, 'PRECIOUS', { mode: 0o644 });
    const refused = await gcr(['graph', 'export', '--out', out, '--db', dbPath]);
    assertTextError(refused, 'INVALID_ARGUMENT', { remedy: /--force/ });
    assert.equal(readFileSync(out, 'utf8'), 'PRECIOUS');
    assertJsonError(await gcr(['graph', 'export', '--out', out, '--db', dbPath, '--format', 'json']), 'INVALID_ARGUMENT');
    assertOk(await gcr(['graph', 'export', '--out', out, '--force', '--format', 'json', '--db', dbPath]));
    assert.match(readFileSync(out, 'utf8'), /^<!doctype html>/i);
    assert.equal(octal(mode(out)), '0600');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left behind');
  });

  it('refuses symlinks (even with --force), directories, bad extensions and missing directories', async () => {
    const { dbPath, dir } = await exportDb();
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'VICTIM');
    const link = join(dir, 'link.html');
    symlinkSync(victim, link);
    for (const extra of [[], ['--force']]) {
      const r = await gcr(['graph', 'export', '--out', link, ...extra, '--db', dbPath]);
      assertTextError(r, 'INVALID_ARGUMENT');
      assert.match(r.stderr, /symbolic link/);
      assert.equal(readFileSync(victim, 'utf8'), 'VICTIM', 'the link target is untouched');
      assert.equal(lstatSync(link).isSymbolicLink(), true);
    }
    const dangling = join(dir, 'dangling.html');
    symlinkSync(join(dir, 'does-not-exist.txt'), dangling);
    assertTextError(await gcr(['graph', 'export', '--out', dangling, '--db', dbPath]), 'INVALID_ARGUMENT');
    assert.equal(existsSync(join(dir, 'does-not-exist.txt')), false, 'a dangling link is not followed to create its target');

    mkdirSync(join(dir, 'a-dir.html'));
    assertTextError(await gcr(['graph', 'export', '--out', join(dir, 'a-dir.html'), '--force', '--db', dbPath]), 'INVALID_ARGUMENT');
    const bad = await gcr(['graph', 'export', '--out', join(dir, 'graph.txt'), '--db', dbPath]);
    assertTextError(bad, 'INVALID_ARGUMENT');
    assert.match(bad.stderr, /must end in \.html/);
    assert.equal(existsSync(join(dir, 'graph.txt')), false);
    const noDir = await gcr(['graph', 'export', '--out', join(dir, 'missing', 'graph.html'), '--db', dbPath]);
    assertTextError(noDir, 'INVALID_ARGUMENT');
    assert.equal(existsSync(join(dir, 'missing')), false);
  });
});
