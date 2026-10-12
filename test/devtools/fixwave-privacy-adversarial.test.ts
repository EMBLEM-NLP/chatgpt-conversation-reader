/**
 * Independent adversarial review of the ATK-02 / ATK-03 / ATK-09 privacy-scanner fixes: bypasses of the NEW rules that the
 * builder's own tests do not pin. Each group below holds at least one test that failed against the code as delivered (the
 * review report lists which); the remaining tests are controls that pin what must NOT change (no false positives).
 *
 * Covered: the lead of a file hidden behind leading white space or blank lines (work tree and history); names that fool the
 * excluded-directory exemption of `unscanned-large-file`; invisible characters beyond the zero-width set; proxy authorization
 * headers; the installer copying hook scripts that were checked out with CRLF line endings; `.gitignore` parity with the names the
 * scan refuses; the renderings of local drafts and annotations, arrays of envelopes and logged JSON-RPC responses as GCR output; and
 * the shape of an export pasted into a file by a LATER commit (history).
 *
 * Deliberately NOT pinned here: UTF-16 text without a byte-order mark and text with stray NUL bytes are still binary for the
 * content rules. That is the documented decision of the older tests (`privacy-scan.repo.test.ts` "applies path rules only to
 * binary files", `privacy-scan.repo.adversarial.test.ts` "still treats NUL-bearing data without a byte-order mark as binary"),
 * so it is reported as a residual risk, not changed.
 *
 * SYNTHETIC DATA ONLY. All secret-shaped text is assembled at run time from fragments so this file contains none (the scanner
 * scans its own repository), and invisible characters are written as code point escapes.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LARGE_FILE_HEAD_BYTES, LARGE_FILE_TAIL_BYTES, SYNTHETIC_MARKER, scanContent, scanPaths, scanRepo } from '../../src/devtools/privacy-scan.js';
import { withTempDir } from '../helpers/tmp.js';
import { chatgptExportText, commitAll, git, initRepo, inRepo, join_, put, rnd } from './fixwave-privacy-helpers.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const posix = process.platform !== 'win32';
const BIG = LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES + 5000;
const key = (seed: number): string => join_('sk-', rnd(40, seed));
const rules = (path: string, content: string): string[] => scanContent(path, content).map((f) => f.rule);
const exportJson = chatgptExportText(2, 3);
const envelope = (): string =>
  JSON.stringify({ ok: true, data: { items: [{ title: 'a private title' }] }, completeness: 'exported_tree', untrustedContent: true });

describe('review: leading white space cannot hide what a file is', () => {
  it('judges the shape of an export that starts with more white space than the probe prefix holds, whatever the name', () => {
    for (const lead of [' '.repeat(5000), '\n'.repeat(5000), '\uFEFF' + '\r\n'.repeat(3000), ' \t'.repeat(4000)]) {
      for (const path of ['report.md', 'chats.csv', 'notes.yml', 'src/dump.ts', 'a/b/chats.backup1']) {
        assert.deepEqual(rules(path, lead + exportJson), ['synthetic-marker-missing'], `${path} after ${lead.length} lead characters`);
      }
    }
  });

  it('recognises GCR output after the same padding', () => {
    for (const lead of [' '.repeat(5000), '\n'.repeat(5000)]) {
      for (const path of ['out.txt', 'result', 'notes/report.md']) assert.deepEqual(rules(path, lead + envelope()), ['gcr-output-file'], path);
    }
  });

  it('does not start judging source code or prose just because white space comes first', () => {
    for (const path of ['src/a.ts', 'docs/x.md']) {
      assert.deepEqual(rules(path, `${' '.repeat(5000)}Example of the shape:\n${exportJson}\n`), [], path);
    }
  });

  it('history: a file whose first added line is blank is still judged by shape (report.md, chats.csv)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'notes/report.md', `\n${exportJson}\n`);
      await put(dir, 'notes/chats.csv', `\n\n  \n${exportJson}\n`);
      await put(dir, 'notes/result.txt', `\n${envelope()}\n`);
      await put(dir, 'notes/prose.md', '\nJust a note about nothing in particular.\n');
      await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', '-r', '--', 'notes');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(
        result.findings.map((f) => [f.rule, f.path]),
        [
          ['synthetic-marker-missing', 'notes/chats.csv'],
          ['synthetic-marker-missing', 'notes/report.md'],
          ['gcr-output-file', 'notes/result.txt'],
        ],
      );
    });
  });
});

describe('review: a backslash in a file name is a name character, not a directory separator, for the excluded-directory exemption', { skip: posix ? false : 'backslashes cannot be part of a Windows file name' }, () => {
  it('reports a large file named like a directory path with backslashes', async () => {
    await inRepo(async (dir) => {
      const names = ['dist\\big.txt', 'node_modules\\big.txt', 'a\\node_modules\\big.txt', 'coverage\\big.txt', 'dist-test-x\\big.txt'];
      for (const name of names) await put(dir, name, 'filler line of ordinary text\n'.repeat(Math.ceil(BIG / 29)));
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.equal(result.unscannedLarge, 0);
      assert.deepEqual(
        result.findings.map((f) => [f.rule, f.path]),
        [...names].sort().map((n) => ['unscanned-large-file', n]),
      );
    });
  });

  it('keeps the exemption for the real directories', async () => {
    await inRepo(async (dir) => {
      for (const name of ['dist/big.txt', 'node_modules/p/big.txt', 'a/node_modules/p/big.txt', 'coverage/big.txt', 'dist-test-x/big.txt']) {
        await put(dir, name, 'filler line of ordinary text\n'.repeat(Math.ceil(BIG / 29)));
      }
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.equal(result.unscannedLarge, 5);
      assert.deepEqual(result.findings, []);
    });
  });
});

describe('review: invisible characters beyond the zero-width set cannot split a credential', () => {
  const cp = (...points: number[]): string[] => points.map((p) => String.fromCodePoint(p));
  // Default_Ignorable_Code_Point members that a reader cannot see and a credential survives: Hangul fillers, Khmer inherent
  // vowels, Mongolian free variation selectors, the interlinear/reserved format range, variation selectors supplement, tag-block edge.
  const invisibles = cp(0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x3164, 0xffa0, 0xe0100, 0xe01ef, 0xe0fff);

  it('still finds a key with one of them in the middle (prefix, body), for several rules', () => {
    for (const ch of invisibles) {
      const point = (ch.codePointAt(0) ?? 0).toString(16);
      const openai = key(7);
      assert.deepEqual(rules('a.txt', `k = ${openai.slice(0, 10)}${ch}${openai.slice(10)}`), ['openai-api-key'], `openai U+${point}`);
      assert.deepEqual(rules('a.txt', `k = s${ch}k-${openai.slice(3)}`), ['openai-api-key'], `prefix U+${point}`);
      const google = join_('AI', 'za', rnd(35, 8));
      assert.deepEqual(rules('a.txt', `k = ${google.slice(0, 20)}${ch}${google.slice(20)}`), ['google-api-key'], `google U+${point}`);
      const hf = join_('hf', '_', rnd(34, 9));
      assert.deepEqual(rules('a.txt', `k = h${ch}${hf.slice(1)}`), ['huggingface-token'], `hf U+${point}`);
    }
  });

  it('does not report prose that contains these characters', () => {
    for (const ch of invisibles) assert.deepEqual(rules('a.txt', `an ordinary${ch} sentence with${ch} nothing in it\n`), []);
  });
});

describe('review: proxy authorization headers carry credentials like authorization headers', () => {
  const basic = (seed: number): string => Buffer.from(`user:${rnd(12, seed)}`).toString('base64');

  it('reports Proxy-Authorization: Basic and Bearer, in several spellings', () => {
    for (const header of ['Proxy-Authorization', 'proxy-authorization', 'PROXY-AUTHORIZATION', '"Proxy-Authorization"']) {
      assert.deepEqual(rules('a.txt', `${header}: Basic ${basic(1)}`), ['basic-auth-header'], header);
      assert.deepEqual(rules('a.txt', `${header}: Bearer ${rnd(30, 2)}`), ['bearer-token'], header);
    }
    assert.deepEqual(rules('a.sh', `curl -H "Proxy-Authorization: Basic ${basic(3)}" https://proxy.example.invalid`), ['basic-auth-header']);
  });

  it('still reports the plain headers once and leaves look-alikes alone', () => {
    assert.deepEqual(rules('a.txt', `Authorization: Basic ${basic(4)}`), ['basic-auth-header']);
    assert.deepEqual(rules('a.txt', `x-authorization-note: Basic ${basic(5)}`), []);
    assert.deepEqual(rules('a.txt', `unauthorization: Basic ${basic(6)}`), []);
    assert.deepEqual(rules('a.txt', 'Proxy-Authorization: Basic dXNlcg=='), []); // decodes to a user name without a password
  });
});

describe('review: the installer copies hook scripts that were checked out with CRLF line endings as LF scripts', { skip: posix ? false : 'the hooks are POSIX shell scripts' }, () => {
  it('installs hooks without carriage returns that still parse with sh -n', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir, { hooks: true });
      await mkdir(join(dir, 'scripts', 'git-hooks'), { recursive: true });
      await copyFile(join(REPO_ROOT, 'scripts', 'install-git-hooks.mjs'), join(dir, 'scripts', 'install-git-hooks.mjs'));
      await cp(join(REPO_ROOT, 'scripts', 'git-hooks'), join(dir, 'scripts', 'git-hooks'), { recursive: true });
      for (const name of ['pre-commit', 'pre-push']) {
        const file = join(dir, 'scripts', 'git-hooks', name);
        await writeFile(file, (await readFile(file, 'utf8')).replace(/\n/g, '\r\n'));
      }
      const installed = await execFileAsync(process.execPath, [join(dir, 'scripts', 'install-git-hooks.mjs')], { encoding: 'utf8' });
      assert.match(installed.stdout, /installed: \.git\/hooks\/pre-commit/);
      for (const name of ['pre-commit', 'pre-push']) {
        const text = await readFile(join(dir, '.git', 'hooks', name), 'utf8');
        assert.ok(!text.includes('\r'), `${name} contains a carriage return`);
        assert.ok(text.startsWith('#!/bin/sh\n'), name);
        await execFileAsync('sh', ['-n', join(dir, '.git', 'hooks', name)]); // throws on a syntax error
      }
      // A second run recognises its own LF copy as up to date.
      const again = await execFileAsync(process.execPath, [join(dir, 'scripts', 'install-git-hooks.mjs')], { encoding: 'utf8' });
      assert.match(again.stdout, /unchanged: \.git\/hooks\/pre-commit/);
      assert.match(again.stdout, /unchanged: \.git\/hooks\/pre-push/);
    });
  });
});

describe('review: .gitignore covers every name the scanner refuses by name, so `git add -A` does not stage it in the first place', () => {
  const EXTENSIONS = [
    '.sqlite', '.sqlite3', '.db', '.db-wal', '.db-shm', '.sqlite-wal', '.sqlite-shm', '.sqlite3-wal', '.sqlite3-shm', '.db-journal', '.sqlite-journal',
    '.sqlite3-journal', '.db3', '.db3-wal', '.db3-shm', '.db3-journal', '.zip', '.tar', '.tgz', '.gz', '.7z', '.rar', '.har', '.xz', '.bz2', '.zst',
    '.tbz', '.tbz2', '.txz', '.pem', '.key', '.p12', '.pfx', '.jks', '.kdbx', '.log',
  ];
  const BASENAMES = [
    'cookies.json', 'cookie.json', 'session.json', 'storage_state.json', 'auth.json', 'cookies.txt', 'cookie.txt', 'user.json', 'user_settings.json',
    'message_feedback.json', 'shared_conversations.json', 'model_comparisons.json', 'group_chats.json', 'conversation_asset_file_names.json',
    'library_files.json', 'export_manifest.json', 'chat.html', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.pgpass', '.git-credentials', '.htpasswd',
    '.netrc', '_netrc', 'conversations.json', 'conversations-001.json', '.env', '.env.local',
  ];
  const samples = [...EXTENSIONS.map((e) => `data/export-copy${e}`), ...BASENAMES.flatMap((b) => [b, `some/where/${b}`])];

  it('ignores each of them at the root and at depth (and the scanner really does refuse each name, so the list is not stale)', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir);
      await writeFile(join(dir, '.gitignore'), await readFile(join(REPO_ROOT, '.gitignore')));
      for (const path of samples) {
        assert.ok(scanPaths([path]).length > 0, `the scanner no longer refuses ${path}: update this list`);
        const ignored = await execFileAsync('git', ['-C', dir, 'check-ignore', '-q', '--no-index', '--', path]).then(
          () => true,
          () => false,
        );
        assert.ok(ignored, `${path} is refused by the scanner but not ignored`);
      }
    });
  });

  it('still lets a public key, the example env file, synthetic fixtures, documents, sources and the hooks be added', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir);
      await writeFile(join(dir, '.gitignore'), await readFile(join(REPO_ROOT, '.gitignore')));
      for (const path of ['.env.example', 'fixtures/chatgpt/minimal-linear.json', 'fixtures/chatgpt/conversations.json', 'docs/ARCHITECTURE.md', 'src/devtools/privacy-scan.ts', 'scripts/git-hooks/pre-commit', 'scripts/install-git-hooks.mjs', 'package.json']) {
        const ignored = await execFileAsync('git', ['-C', dir, 'check-ignore', '-q', '--no-index', '--', path]).then(
          () => true,
          () => false,
        );
        assert.ok(!ignored, `${path} must not be ignored`);
      }
    });
  });
});

describe('review: the renderings of local drafts and annotations are GCR output too', () => {
  // `draft show` and `annotate show` print the user's own text (a draft body, a note); the lists print titles. Their Markdown and compact
  // renderings have preambles of their own (src/cli/render-local.ts, src/drafts/drafts.ts), which the first version of the output rule did not know.
  const CLI_MAIN = join(here, '..', '..', 'src', 'cli', 'main.js');
  const FIXTURE = join(REPO_ROOT, 'fixtures', 'chatgpt', 'branching.json');
  const FORMATS = ['json', 'jsonl', 'compact', 'markdown'];

  async function gcr(cwd: string, ...args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GCR_') && !k.startsWith('NODE_OPTIONS')) env[k] = v;
    const { stdout } = await execFileAsync(process.execPath, [CLI_MAIN, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  it('flags every command that prints a draft or an annotation, in every format, whatever the file is called', async () => {
    await withTempDir(async (dir) => {
      const db = join(dir, 'g.sqlite');
      await gcr(dir, 'import', FIXTURE, '--db', db);
      const conversation = (JSON.parse(await gcr(dir, 'list', '--db', db, '--format', 'json')) as { data: { items: Array<{ conversationId: string }> } }).data.items[0]?.conversationId ?? '';
      assert.match(conversation, /^[0-9a-f-]{36}$/);
      await writeFile(join(dir, 'body.md'), 'invented private words for a draft and a note\n');
      const draftId = (JSON.parse(await gcr(dir, 'draft', 'create', '--conversation', conversation, '--input', 'body.md', '--title', 'an invented private title', '--db', db, '--format', 'json')) as { data: { draft: { draftId: string } } }).data.draft.draftId;
      const noteId = (JSON.parse(await gcr(dir, 'annotate', 'create', '--conversation', conversation, '--input', 'body.md', '--db', db, '--format', 'json')) as { data: { annotation: { annotationId: string } } }).data.annotation.annotationId;
      let noteVersion = 1; // every successful `annotate update` raises it (optimistic concurrency)
      const commands: Record<string, () => string[]> = {
        'draft create': () => ['draft', 'create', '--conversation', conversation, '--input', 'body.md', '--title', 'another invented title'],
        'draft show': () => ['draft', 'show', draftId],
        'draft list': () => ['draft', 'list'],
        'draft archive': () => ['draft', 'archive', draftId],
        'annotate create': () => ['annotate', 'create', '--conversation', conversation, '--input', 'body.md'],
        'annotate update': () => ['annotate', 'update', noteId, '--input', 'body.md', '--expected-version', String(noteVersion++)],
        'annotate show': () => ['annotate', 'show', noteId],
        'annotate list': () => ['annotate', 'list'],
      };
      for (const [name, makeArgs] of Object.entries(commands)) {
        for (const format of FORMATS) {
          const text = await gcr(dir, ...makeArgs(), '--db', db, '--format', format);
          assert.ok(text.length > 50, `${name} ${format} printed nothing`);
          for (const path of ['out.txt', 'result', 'notes/report.md']) assert.deepEqual(outputRules(path, text), ['gcr-output-file'], `${name} --format ${format} saved as ${path}`);
          assert.deepEqual(outputRules('fixtures/local/out.txt', text), ['gcr-output-file'], `${name} --format ${format}: the marker is not in it`);
        }
      }
    });
  });

  it('leaves ordinary Markdown with similar headings alone', () => {
    for (const text of [
      '# Local drafts\n\nMy notes about drafts of the paper.\n',
      '# Annotation shown\n\nSome words.\n',
      '# GCR local draft (not sent)\n\nA heading someone wrote by hand.\n',
      '# drafts | local only | notes\n',
      'Intro\n# Local annotations\n\n- Page: 1 item(s) at offset 0 (limit 50)\n',
    ]) {
      assert.deepEqual(outputRules('docs/notes.md', text), [], text);
    }
  });
});

const outputRules = (path: string, content: string): string[] => rules(path, content).filter((r) => r === 'gcr-output-file');

describe('review: result envelopes in arrays and in logged JSON-RPC responses are GCR output', () => {
  const env = (): string =>
    JSON.stringify({ ok: true, data: { items: [{ title: 'a private title' }] }, source: [], completeness: 'exported_tree', warnings: [], ids: {}, untrustedContent: true, truncated: false });

  it('flags an array of envelopes (`jq -s`), compact and pretty-printed', () => {
    const array = `[${env()},${env()}]`;
    const pretty = JSON.stringify([JSON.parse(env())], null, 2);
    for (const text of [array, pretty, `\n  ${array}`]) for (const path of ['all.json', 'results.txt', 'x']) assert.deepEqual(outputRules(path, text), ['gcr-output-file'], path);
  });

  it('flags a JSON-RPC response that carries the envelope only as the escaped text block', () => {
    const textOnly = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: env() }] } });
    const lines = `${textOnly}\n${textOnly}\n`;
    for (const text of [textOnly, lines]) for (const path of ['rpc.jsonl', 'trace.txt', 'x']) assert.deepEqual(outputRules(path, text), ['gcr-output-file'], path);
  });

  it('leaves arrays and JSON-RPC messages that are not GCR results alone', () => {
    const other = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"value":1,"completeness":"none"}' }] } });
    assert.deepEqual(outputRules('rpc.json', other), []);
    assert.deepEqual(outputRules('a.json', '[{"untrustedContent":{"type":"boolean"},"completeness":"x","provenance":"y"}]'), []);
    assert.deepEqual(outputRules('a.json', '[{"completeness":"yes","provenance":"none"}]'), []);
    assert.deepEqual(outputRules('a.json', '[{"untrustedContent":true}]'), []);
  });
});

describe('review: history judges the shape of an export that was pasted into a file in a LATER commit', () => {
  it('reports a stub that became an export (and was deleted before the scan), in one commit or in several', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'misc/data.json', '{}\n');
      await put(dir, 'misc/dump', '[\n');
      await put(dir, 'misc/grow.json', '[]\n');
      await commitAll(dir, 'stubs');
      await put(dir, 'misc/data.json', `${exportJson}\n`);
      await put(dir, 'misc/dump', `[\n${exportJson.slice(1)}\n`);
      await commitAll(dir, 'paste an export into the stubs');
      await put(dir, 'misc/grow.json', `${chatgptExportText(1, 3)}\n`);
      await commitAll(dir, 'second paste');
      await git(dir, 'rm', '-q', '-r', '--', 'misc');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(
        result.findings.map((f) => [f.rule, f.path]),
        [
          ['synthetic-marker-missing', 'misc/data.json'],
          ['synthetic-marker-missing', 'misc/dump'],
          ['synthetic-marker-missing', 'misc/grow.json'],
        ],
      );
      for (const f of result.findings) assert.match(f.detail, /\[in history, commit [0-9a-f]{12}\]$/);
    });
  });

  it('does not report modifications of files that carry the synthetic marker (the marker may sit in an unchanged line), of fixtures, or of prose and code', async () => {
    await inRepo(async (dir) => {
      // Pretty-printed, so the title line (with the marker) and the lines with the shape keys are different lines of the patch.
      const pretty = JSON.stringify(JSON.parse(chatgptExportText(1, 3).replace('invented chat 0', `${SYNTHETIC_MARKER} chat 0`)), null, 2);
      const touched = pretty.replace('"mapping": {', '"mapping":  {').replace(/"current_node": /g, '"current_node":  ');
      assert.notEqual(touched, pretty);
      await put(dir, 'testdata/sample.json', pretty);
      await put(dir, 'fixtures/chatgpt/x.json', pretty);
      await put(dir, 'src/readme.ts', '// notes\nexport const a = 1;\n');
      await put(dir, 'docs/shape.md', '# Shape\n\nsee below\n');
      await commitAll(dir, 'add');
      // The later commits change only lines that carry the shape keys, not the line with the marker.
      await put(dir, 'testdata/sample.json', touched);
      await put(dir, 'fixtures/chatgpt/x.json', touched);
      await put(dir, 'src/readme.ts', `// notes\nexport const a = 1;\nexport const sample = ${exportJson};\n`);
      await put(dir, 'docs/shape.md', `# Shape\n\n${exportJson}\n`);
      await commitAll(dir, 'modify');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(result.findings.map((f) => [f.rule, f.path]), []);
    });
  });
});
