/**
 * Privacy scanner against THROWAWAY git repositories (git init in a temp dir, no network, no hooks, no global
 * config): every rule end to end, which files are listed and scanned, allow-file behaviour, history mode, size and
 * binary handling, masking of every output channel, determinism and the CLI entry point.
 *
 * All secret-shaped text is assembled at run time from fragments so this file contains none.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, copyFile, mkdir, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { GcrError } from '../../src/errors.js';
import { FIXTURE_MAX_BYTES, LARGE_FILE_HEAD_BYTES, LARGE_FILE_TAIL_BYTES, SYNTHETIC_MARKER, formatFindings, main, scanRepo } from '../../src/devtools/privacy-scan.js';
import type { Finding } from '../../src/devtools/privacy-scan.js';
import { withTempDir } from '../helpers/tmp.js';

// A hook runner or CI job may export GIT_DIR / GIT_INDEX_FILE; leaking those into the throwaway repositories would
// aim `git add` at the real checkout. Removing them (and the user's git config) makes every repository hermetic.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env['GIT_CONFIG_GLOBAL'] = devNull;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
process.env['GIT_AUTHOR_NAME'] = 'GCR Test';
process.env['GIT_AUTHOR_EMAIL'] = 'test@example.invalid';
process.env['GIT_COMMITTER_NAME'] = 'GCR Test';
process.env['GIT_COMMITTER_EMAIL'] = 'test@example.invalid';

const execFileAsync = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return stdout;
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '--template=', '-b', 'main');
  await git(dir, 'config', 'user.name', 'GCR Test');
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await git(dir, 'config', 'core.hooksPath', devNull);
}

async function put(dir: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function putAll(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--no-verify', '-m', message);
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}

/** Run a test body inside a fresh, empty, initialised repository. */
async function inRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    await initRepo(dir);
    return fn(dir);
  });
}

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
function rnd(length: number, seed: number, alphabet: string = B62): string {
  let s = (seed * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += alphabet[(s >>> 16) % alphabet.length] ?? '';
  }
  return out;
}
const join_ = (...parts: string[]): string => parts.join('');
function uuid(seed: number): string {
  const h = rnd(32, seed, HEX);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const summarize = (findings: readonly Finding[]): Array<[string, string, number | undefined]> => findings.map((f) => [f.rule, f.path, f.line]);
const SHORT_HASH = /\[in history, commit [0-9a-f]{12}\]$/;

// ---- every rule, end to end ---------------------------------------------------------------------------------------

type Mode = 'untracked' | 'staged' | 'committed';
const MODES: readonly Mode[] = ['untracked', 'staged', 'committed'];

interface Positive {
  label: string;
  files: Record<string, string | Buffer>;
  expect: Array<[rule: string, path: string, line?: number]>;
}

const CHATGPT = join_('chat', 'gpt.com');
const POSITIVES: Positive[] = [
  // path rules
  { label: 'database file', files: { 'data/chats.sqlite': 'x' }, expect: [['forbidden-extension', 'data/chats.sqlite']] },
  { label: 'archive, upper case', files: { 'Backup.ZIP': 'x' }, expect: [['forbidden-extension', 'Backup.ZIP']] },
  { label: 'key file', files: { 'deploy/server.PEM': 'x' }, expect: [['forbidden-extension', 'deploy/server.PEM']] },
  { label: 'env file', files: { 'app/.env.production': 'A=1\n' }, expect: [['forbidden-filename', 'app/.env.production']] },
  { label: 'export member name', files: { 'misc/user.json': '{}' }, expect: [['forbidden-filename', 'misc/user.json']] },
  { label: 'raw conversations file', files: { 'conversations.json': '[]' }, expect: [['export-file-outside-fixtures', 'conversations.json']] },
  { label: 'file in an export directory', files: { 'export/dump.json': '{}' }, expect: [['export-directory', 'export/dump.json']] },
  { label: 'unmarked fixture export', files: { 'fixtures/chatgpt/conversations.json': '[]' }, expect: [['synthetic-marker-missing', 'fixtures/chatgpt/conversations.json']] },
  { label: 'oversized fixture', files: { 'fixtures/big.txt': 'x'.repeat(FIXTURE_MAX_BYTES + 1) }, expect: [['fixture-too-large', 'fixtures/big.txt']] },
  // content rules
  { label: 'private key header', files: { 'src/k.txt': `a\nb\n${join_('-----', 'BEGIN RSA ', 'PRIVATE KEY', '-----')}\n` }, expect: [['pem-private-key', 'src/k.txt', 3]] },
  { label: 'api key', files: { 'src/a.ts': `const k = '${join_('sk-', rnd(48, 1))}';\n` }, expect: [['openai-api-key', 'src/a.ts', 1]] },
  { label: 'github token', files: { 'ci/t.yml': `x: 1\ntoken: ${join_('ghp_', rnd(36, 2))}\n` }, expect: [['github-token', 'ci/t.yml', 2]] },
  { label: 'aws key id', files: { 'cfg.ini': `\n\nid=${join_('AKIA', 'Q'.repeat(16))}\n` }, expect: [['aws-access-key-id', 'cfg.ini', 3]] },
  { label: 'slack token', files: { 'notes.md': join_('xox', 'b-', rnd(12, 3), '-', rnd(12, 4)) }, expect: [['slack-token', 'notes.md', 1]] },
  { label: 'jwt', files: { 'notes.md': `${join_('eyJ', rnd(20, 5))}.${join_('eyJ', rnd(20, 6))}.${rnd(30, 7)}\n` }, expect: [['jwt', 'notes.md', 1]] },
  { label: 'bearer header', files: { 'http.txt': `Authorization: Bearer ${rnd(40, 8)}\n` }, expect: [['bearer-token', 'http.txt', 1]] },
  { label: 'cookie header', files: { 'http.txt': `GET /\nCookie: sid=${rnd(24, 9)}; a=b\n` }, expect: [['cookie-header', 'http.txt', 2]] },
  { label: 'session cookie name', files: { 'notes.md': `see ${join_('__Secure-next-', 'auth.session-', 'token')}\n` }, expect: [['session-cookie-name', 'notes.md', 1]] },
  { label: 'clearance cookie', files: { 'notes.md': `${join_('cf_', 'clearance')}=${rnd(30, 10)}\n` }, expect: [['cloudflare-clearance-cookie', 'notes.md', 1]] },
  { label: 'device id', files: { 'notes.md': `${join_('oai-device', '-id')}: ${uuid(11)}\n` }, expect: [['device-id', 'notes.md', 1]] },
  { label: 'user-id cookie', files: { 'notes.md': `${join_('_pu', 'id')}=user-${rnd(20, 12)}\n` }, expect: [['user-id-cookie', 'notes.md', 1]] },
  { label: 'conversation URL', files: { 'README.md': `open https://${CHATGPT}/c/${uuid(13)} now\n` }, expect: [['chatgpt-conversation-url', 'README.md', 1]] },
  { label: 'legacy host URL', files: { 'README.md': `http://${join_('chat.open', 'ai.com')}/c/${uuid(14)}\n` }, expect: [['chatgpt-conversation-url', 'README.md', 1]] },
  { label: 'asset pointer', files: { 'src/a.ts': `'${join_('file-serv', 'ice://file-', rnd(24, 15))}'\n` }, expect: [['asset-pointer', 'src/a.ts', 1]] },
  { label: 'long base64 blob', files: { 'src/a.ts': `const b = '${rnd(120, 16, `${B62}+/`)}';\n` }, expect: [['high-entropy-blob', 'src/a.ts', 1]] },
  { label: 'long hex blob', files: { 'src/a.ts': `// ${rnd(100, 17, HEX)}\n` }, expect: [['high-entropy-blob', 'src/a.ts', 1]] },
];

interface Negative {
  label: string;
  files: Record<string, string | Buffer>;
}

const NEGATIVES: Negative[] = [
  { label: 'ordinary source', files: { 'src/dbutil.ts': 'export const x = 1;\n', 'README.md': '# hello\n' } },
  { label: 'env example', files: { '.env.example': 'API_URL=\n' } },
  { label: 'near-miss file names', files: { 'users.json': '[]', 'notes.sqlite.md': 'x', 'export/readme.md': 'x', 'src/export.json': '{}', 'my-session.json': '{}' } },
  { label: 'marked fixture export', files: { 'fixtures/chatgpt/conversations.json': `[{"title":"${SYNTHETIC_MARKER}"}]` } },
  { label: 'small fixture', files: { 'fixtures/ok.txt': 'x'.repeat(FIXTURE_MAX_BYTES) } },
  { label: 'public key material and prose', files: { 'a.txt': `${join_('-----', 'BEGIN PUBLIC KEY', '-----')}\nprivate key handling is documented elsewhere\n` } },
  { label: 'short and look-alike keys', files: { 'a.ts': `${join_('sk-', 'A'.repeat(10))} ${join_('ta', 'sk-', rnd(40, 18))} ${join_('ghp_', 'x'.repeat(5))}\n` } },
  { label: 'placeholders in docs', files: { 'a.md': 'Authorization: Bearer <token>\nCookie: <value>\ncf_clearance is a cookie name\n' } },
  { label: 'synthetic ids', files: { 'a.md': `https://${CHATGPT}/c/6ac95b6e-9fa0-83e8-bbb0-8107079a8720 https://${CHATGPT}/c/00000000-0000-4000-8000-0123456789ab\n` } },
  { label: 'asset pointers in fixtures and docs', files: { 'fixtures/a.json': join_('sedi', 'ment://file_', rnd(32, 19, HEX)), 'docs/a.md': join_('file-serv', 'ice://file-', rnd(24, 20)) } },
  { label: 'blobs in fixtures and package-lock.json', files: { 'fixtures/a.txt': rnd(120, 21), 'package-lock.json': `{"integrity":"sha512-${rnd(86, 22, `${B62}+/`)}=="}` } },
  { label: 'email addresses', files: { 'a.md': 'Write to first.last+tag@example.com or support@example.org\n' } },
];

describe('every rule, end to end', () => {
  POSITIVES.forEach((c, i) => {
    const mode = MODES[i % MODES.length] ?? 'untracked';
    it(`flags: ${c.label} (${mode})`, async () => {
      await inRepo(async (dir) => {
        await putAll(dir, c.files);
        if (mode === 'staged') await git(dir, 'add', '-A');
        if (mode === 'committed') await commitAll(dir, 'add');
        const result = await scanRepo(dir);
        assert.deepEqual(summarize(result.findings), c.expect.map(([rule, path, line]) => [rule, path, line]));
        assert.ok(result.findings.every((f) => !f.detail.includes('[staged]')), 'a file identical in index and work tree is reported once, unmarked');
      });
    });
  });

  for (const c of NEGATIVES) {
    it(`stays quiet: ${c.label}`, async () => {
      await inRepo(async (dir) => {
        await putAll(dir, c.files);
        const result = await scanRepo(dir);
        assert.deepEqual(result.findings, []);
        assert.equal(result.scannedFiles, Object.keys(c.files).length);
      });
    });
  }
});

// ---- which files are checked ------------------------------------------------------------------------------------------

describe('file selection', () => {
  const key = (seed: number): string => join_('sk-', rnd(40, seed));

  it('checks tracked, staged and untracked-but-not-ignored files, and honours .gitignore', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'tracked.txt', `${key(30)}\n`);
      await commitAll(dir, 'tracked');
      await put(dir, 'staged.txt', `${key(31)}\n`);
      await git(dir, 'add', 'staged.txt');
      await put(dir, 'untracked.txt', `${key(32)}\n`);
      await put(dir, '.gitignore', 'ignored.txt\nignored-dir/\n');
      await put(dir, 'ignored.txt', `${key(33)}\n`);
      await put(dir, 'ignored-dir/inner.txt', `${key(34)}\n`);
      const result = await scanRepo(dir);
      assert.deepEqual(result.findings.map((f) => f.path), ['staged.txt', 'tracked.txt', 'untracked.txt']);
      assert.equal(result.listedFiles, 4); // the three secrets plus .gitignore itself; ignored paths are never listed
    });
  });

  it('still scans an ignored file that was force-added (it WILL be committed)', async () => {
    await inRepo(async (dir) => {
      await put(dir, '.gitignore', 'forced.txt\n');
      await put(dir, 'forced.txt', `${key(35)}\n`);
      await git(dir, 'add', '-f', 'forced.txt');
      assert.deepEqual((await scanRepo(dir)).findings.map((f) => f.path), ['forced.txt']);
    });
  });

  it('does not look inside .git', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'clean\n');
      await commitAll(dir, 'a');
      const result = await scanRepo(dir);
      assert.equal(result.listedFiles, 1);
      assert.deepEqual(result.findings, []);
    });
  });

  it('catches a secret that is staged but no longer in the work tree, once', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'cfg.txt', `ok\n${key(36)}\n`);
      await git(dir, 'add', 'cfg.txt');
      await put(dir, 'cfg.txt', 'ok\nredacted\n'); // edited away but NOT re-staged: a commit would still contain the key
      const result = await scanRepo(dir);
      assert.deepEqual(summarize(result.findings), [['openai-api-key', 'cfg.txt', 2]]);
      assert.match(result.findings[0]?.detail ?? '', / \[staged\]$/);
    });
  });

  it('reports a secret present in both index and work tree only once, without the staged marker', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'cfg.txt', `${key(37)}\n`);
      await git(dir, 'add', 'cfg.txt');
      const { findings } = await scanRepo(dir);
      assert.equal(findings.length, 1);
      assert.ok(!findings[0]?.detail.includes('[staged]'));
    });
  });

  it('survives a tracked file deleted from the work tree (path rules still apply)', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'gone.txt': 'x\n', 'gone.sqlite': 'x' });
      await commitAll(dir, 'add');
      await unlink(join(dir, 'gone.txt'));
      await unlink(join(dir, 'gone.sqlite'));
      const result = await scanRepo(dir);
      assert.deepEqual(summarize(result.findings), [['forbidden-extension', 'gone.sqlite', undefined]]);
      assert.equal(result.skippedNonRegular, 2);
      assert.equal(result.scannedFiles, 0);
    });
  });

  it('never follows symlinks out of the repository', async () => {
    await withTempDir(async (outside) => {
      await put(outside, 'secret.txt', `${key(38)}\n`);
      await inRepo(async (dir) => {
        await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));
        await put(dir, 'real.txt', 'clean\n');
        const result = await scanRepo(dir);
        assert.deepEqual(result.findings, []);
        assert.equal(result.skippedNonRegular, 1);
        assert.equal(result.scannedFiles, 1);
      });
    });
  });

  it('counts nested repositories as skipped rather than reading them', async () => {
    await inRepo(async (dir) => {
      await initRepo(join(dir, 'nested'));
      await put(dir, 'nested/inner.txt', `${key(39)}\n`);
      await put(dir, 'top.txt', 'clean\n');
      const result = await scanRepo(dir);
      assert.deepEqual(result.findings, []);
      assert.ok(result.skippedNonRegular >= 1);
    });
  });

  it('scans many files with bounded concurrency and still reports in sorted order', async () => {
    await inRepo(async (dir) => {
      for (let i = 0; i < 120; i++) await put(dir, `d${i % 7}/f${String(i).padStart(3, '0')}.txt`, i % 10 === 0 ? `${key(100 + i)}\n` : `line ${i}\n`);
      const result = await scanRepo(dir);
      assert.equal(result.scannedFiles, 120);
      assert.equal(result.findings.length, 12);
      const paths = result.findings.map((f) => f.path);
      assert.deepEqual(paths, [...paths].sort());
    });
  });
});

// ---- allow file ---------------------------------------------------------------------------------------------------------

describe('.privacy-scan-allow', () => {
  const sqlite = Buffer.from('SQLite format 3\0');

  it('exempts exactly the listed paths from path and content rules, and nothing else', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, {
        'fixtures/user.json': '{}',
        'fixtures/other/user.json': '{}',
        'docs/example.md': `${join_('sk-', rnd(40, 40))}\n`,
        'docs/example2.md': `${join_('sk-', rnd(40, 41))}\n`,
        'data/ok.sqlite': sqlite,
        '.privacy-scan-allow': '# synthetic export member\nfixtures/user.json\ndocs/example.md\ndata/ok.sqlite\n',
      });
      const result = await scanRepo(dir);
      assert.deepEqual(summarize(result.findings), [
        ['openai-api-key', 'docs/example2.md', 1],
        ['forbidden-filename', 'fixtures/other/user.json', undefined],
      ]);
      assert.equal(result.allowListedFiles, 3);
    });
  });

  it('does not treat entries as globs, prefixes or directories, and reports them as invalid', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, {
        'fixtures/a.sqlite': sqlite,
        'fixtures/b.sqlite': sqlite,
        'fixtures/sub/c.sqlite': sqlite,
        '.privacy-scan-allow': ['fixtures/*.sqlite', 'fixtures/', 'fixtures', '**', '../fixtures/a.sqlite', '/fixtures/a.sqlite', 'fixtures/b.sqlite  # reason'].join('\n'),
      });
      const result = await scanRepo(dir);
      assert.deepEqual(
        summarize(result.findings).filter(([rule]) => rule === 'forbidden-extension').map(([, path]) => path),
        ['fixtures/a.sqlite', 'fixtures/b.sqlite', 'fixtures/sub/c.sqlite'],
      );
      const invalid = result.findings.filter((f) => f.rule === 'allow-file-invalid');
      assert.deepEqual(invalid.map((f) => f.line), [1, 2, 4, 5, 6, 7]); // line 3 ("fixtures") is a valid-but-useless exact entry
      assert.ok(invalid.every((f) => f.path === '.privacy-scan-allow'));
      assert.equal(result.allowListedFiles, 0);
    });
  });

  it('accepts comments, blank lines and CRLF line endings', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'a.sqlite': sqlite, '.privacy-scan-allow': '# comment\r\n\r\n   \r\na.sqlite\r\n' });
      const result = await scanRepo(dir);
      assert.deepEqual(result.findings, []);
      assert.equal(result.allowListedFiles, 1);
    });
  });

  it('also exempts allow-listed paths in history mode', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'keep.sqlite': sqlite, 'drop.sqlite': sqlite });
      await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', 'keep.sqlite', 'drop.sqlite');
      await put(dir, '.privacy-scan-allow', 'keep.sqlite\n');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(result.findings.map((f) => f.path), ['drop.sqlite']);
    });
  });

  it('is a reviewable file: the allow file itself is scanned like any other', async () => {
    await inRepo(async (dir) => {
      await put(dir, '.privacy-scan-allow', `# ${join_('sk-', rnd(40, 42))}\n`);
      assert.deepEqual((await scanRepo(dir)).findings.map((f) => f.rule), ['openai-api-key']);
    });
  });
});

// ---- history ---------------------------------------------------------------------------------------------------------------

describe('history mode', () => {
  const key = (seed: number): string => join_('sk-', rnd(40, seed));

  it('catches a secret that was committed and then deleted (and only with history on)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'notes.txt', `hello\nAPI_KEY=${key(50)}\n`);
      const added = await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', 'notes.txt');
      await commitAll(dir, 'remove');
      assert.deepEqual((await scanRepo(dir)).findings, []);
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(summarize(result.findings), [['openai-api-key', 'notes.txt', 2]]);
      assert.ok(result.findings[0]?.detail.endsWith(`[in history, commit ${added.slice(0, 12)}]`), result.findings[0]?.detail);
      assert.equal(result.history?.commitsSeen, 2);
      assert.equal(result.history?.truncated, false);
    });
  });

  it('catches a forbidden file that was added and then removed', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'keep.txt': 'x\n', 'data/chats.sqlite': 'x' });
      const added = await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', 'data/chats.sqlite');
      await commitAll(dir, 'remove');
      assert.deepEqual((await scanRepo(dir)).findings, []);
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(summarize(result.findings), [['forbidden-extension', 'data/chats.sqlite', undefined]]);
      assert.ok(result.findings[0]?.detail.endsWith(`[in history, commit ${added.slice(0, 12)}]`));
    });
  });

  it('sees a forbidden name reached by renaming (rename detection must not hide it)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'plain.txt', 'some text that is identical across the rename\n');
      await commitAll(dir, 'add');
      await git(dir, 'mv', 'plain.txt', 'plain.sqlite');
      await commitAll(dir, 'rename');
      await git(dir, 'rm', '-q', 'plain.sqlite');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(summarize(result.findings), [['forbidden-extension', 'plain.sqlite', undefined]]);
    });
  });

  it('covers every ref, including a merged branch whose file was later removed', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'base.txt', 'base\n');
      await commitAll(dir, 'base');
      await git(dir, 'checkout', '-q', '-b', 'feature');
      await put(dir, 'export/dump.json', '{}');
      await commitAll(dir, 'feature');
      await git(dir, 'checkout', '-q', 'main');
      await put(dir, 'main.txt', 'main\n');
      await commitAll(dir, 'main');
      await git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature');
      await git(dir, 'rm', '-q', '-r', 'export');
      await commitAll(dir, 'cleanup');
      await git(dir, 'checkout', '-q', '-b', 'unmerged');
      await put(dir, 'only-here.pem', 'x');
      await commitAll(dir, 'unmerged');
      await git(dir, 'checkout', '-q', 'main');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(summarize(result.findings), [
        ['export-directory', 'export/dump.json', undefined],
        ['forbidden-extension', 'only-here.pem', undefined],
      ]);
    });
  });

  it('flags historical raw-export fixtures that lacked the synthetic marker, and accepts marked ones', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'fixtures/conversations.json': '[]', 'fixtures/good/conversations-001.json': `[{"t":"${SYNTHETIC_MARKER}"}]` });
      const added = await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', '-r', 'fixtures');
      await commitAll(dir, 'remove');
      assert.deepEqual((await scanRepo(dir)).findings, []);
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(summarize(result.findings), [['synthetic-marker-missing', 'fixtures/conversations.json', undefined]]);
      assert.ok(result.findings[0]?.detail.endsWith(`[in history, commit ${added.slice(0, 12)}]`));
    });
  });

  it('reports the line number in the file as it was added or edited', async () => {
    await inRepo(async (dir) => {
      const clean = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
      await put(dir, 'f.txt', `${clean.join('\n')}\n`);
      await commitAll(dir, 'clean');
      const edited = [...clean];
      edited[6] = key(51); // line 7
      await put(dir, 'f.txt', `${edited.join('\n')}\n`);
      await commitAll(dir, 'edit');
      await put(dir, 'f.txt', `${clean.join('\n')}\n`);
      await commitAll(dir, 'revert');
      assert.deepEqual(summarize((await scanRepo(dir, { history: true })).findings), [['openai-api-key', 'f.txt', 7]]);
    });
  });

  it('reports a secret once, at the commit that added it, not at later commits that leave it alone', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'f.txt', `${key(52)}\n`);
      const first = await commitAll(dir, 'one');
      await put(dir, 'f.txt', `${key(52)}\nmore\n`);
      await commitAll(dir, 'two');
      await put(dir, 'f.txt', `${key(52)}\nmore\neven more\n`);
      await commitAll(dir, 'three');
      const result = await scanRepo(dir, { history: true });
      // work tree (no suffix) + the commit that introduced it
      assert.deepEqual(result.findings.map((f) => f.detail.replace(/^.*\*\*\* \(len \d+\)/, '')), ['', ` [in history, commit ${first.slice(0, 12)}]`]);
    });
  });

  it('parses quoted names and added lines that look like diff headers', async () => {
    await inRepo(async (dir) => {
      const names = ['quote".and space\\back.txt', 'café ☃.txt', 'tab\tname.txt'];
      for (const [i, name] of names.entries()) await put(dir, name, `first\n++ ${key(60 + i)}\n-- ${key(70 + i)}\n@@ -1 +1 @@ ${key(80 + i)}\n`);
      await commitAll(dir, 'odd names');
      // '.' rather than the names: a backslash in a name would be read as a pathspec escape.
      await git(dir, 'rm', '-q', '-r', '--', '.');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(
        summarize(result.findings),
        [...names].sort().flatMap((name) => [2, 3, 4].map((line): [string, string, number] => ['openai-api-key', name, line])),
      );
    });
  });

  it('truncates at the byte cap and says so, without claiming a complete scan', async () => {
    await inRepo(async (dir) => {
      for (let i = 0; i < 4; i++) {
        await put(dir, `big${i}.txt`, `${'filler line of ordinary text\n'.repeat(1500)}`);
        await commitAll(dir, `c${i}`);
      }
      const capped = await scanRepo(dir, { history: true, maxHistoryBytes: 20_000 });
      assert.equal(capped.history?.truncated, true);
      assert.ok((capped.history?.bytesRead ?? Infinity) <= 20_000, String(capped.history?.bytesRead));
      assert.equal(capped.history?.byteCap, 20_000);
      assert.match(capped.notes.join('\n'), /history scan truncated/);
      const full = await scanRepo(dir, { history: true });
      assert.equal(full.history?.truncated, false);
      assert.deepEqual(full.notes, []);
      assert.ok((full.history?.bytesRead ?? 0) > 20_000);
    });
  });

  it('works in a repository with no commits and reports no history stats of a commit', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'x\n');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(result.findings, []);
      assert.equal(result.history?.commitsSeen, 0);
      assert.equal(result.history?.addedPathsChecked, 0);
    });
  });

  it('leaves history null when not requested', async () => {
    await inRepo(async (dir) => assert.equal((await scanRepo(dir)).history, null));
  });
});

// ---- size and binary ------------------------------------------------------------------------------------------------------------

describe('large and binary files', () => {
  const key = join_('sk-', rnd(40, 90));

  // Above head + tail the middle of a file is never read; below it the "large" file is simply read in full.
  const BIG = LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES + 5000;

  it('judges only the head and tail of oversized files, counts them, and FAILS CLOSED instead of skipping them', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, {
        'big.txt': `${key}\n${'x'.repeat(BIG)}`,
        'big.sqlite': 'x'.repeat(BIG),
        'small.txt': 'fine\n',
        'fixtures/huge.txt': 'y'.repeat(FIXTURE_MAX_BYTES + 10),
      });
      const result = await scanRepo(dir, { maxFileBytes: 1024 });
      assert.equal(result.skippedLarge, 3);
      assert.equal(result.scannedFiles, 1);
      assert.deepEqual(summarize(result.findings), [
        ['forbidden-extension', 'big.sqlite', undefined],
        ['unscanned-large-file', 'big.sqlite', undefined],
        ['unscanned-large-file', 'big.txt', undefined],
        ['openai-api-key', 'big.txt', 1], // the head of a large file is judged by every content rule
        ['fixture-too-large', 'fixtures/huge.txt', undefined],
        ['unscanned-large-file', 'fixtures/huge.txt', undefined],
      ]);
      assert.equal(result.unscannedLarge, 0);
    });
  });

  it('reads a file above the limit in full when it fits inside the head and tail windows (nothing is left unjudged)', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'at.txt': `${key}${'\n'.repeat(1024 - key.length)}`, 'over.txt': `${key}${'\n'.repeat(1025 - key.length)}` });
      const result = await scanRepo(dir, { maxFileBytes: 1024 });
      assert.deepEqual(summarize(result.findings), [
        ['openai-api-key', 'at.txt', 1],
        ['openai-api-key', 'over.txt', 1],
      ]);
      assert.equal(result.skippedLarge, 0);
      assert.equal(result.scannedFiles, 2);
    });
  });

  it('applies path rules only to binary files (NUL bytes) and counts them', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, {
        'blob.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key)]),
        'img.zip': Buffer.from([0, 0, 0, 0]),
        'text.txt': 'plain\n',
      });
      const result = await scanRepo(dir);
      assert.equal(result.skippedBinary, 2);
      assert.equal(result.scannedFiles, 1);
      assert.deepEqual(summarize(result.findings), [['forbidden-extension', 'img.zip', undefined]]);
    });
  });

  it('cannot verify a binary fixture export, so it needs the marker bytes', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, {
        'fixtures/a/conversations.json': Buffer.from([0, 1, 2, 3]),
        'fixtures/b/conversations.json': Buffer.concat([Buffer.from([0]), Buffer.from(SYNTHETIC_MARKER)]),
      });
      assert.deepEqual(summarize((await scanRepo(dir)).findings), [['synthetic-marker-missing', 'fixtures/a/conversations.json', undefined]]);
    });
  });

  it('rejects limits that would disable the bound', async () => {
    await inRepo(async (dir) => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await assert.rejects(scanRepo(dir, { maxFileBytes: bad }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
        await assert.rejects(scanRepo(dir, { maxHistoryBytes: bad }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
      }
    });
  });
});

// ---- masking ---------------------------------------------------------------------------------------------------------------------

describe('masking', () => {
  /** Each entry: the sensitive body that must never be printed in full, and the file text that carries it. */
  const bodies = {
    key: rnd(48, 120),
    ghp: rnd(36, 121),
    aws: rnd(16, 122, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
    slack: rnd(24, 123),
    jwtSig: rnd(43, 124),
    bearer: rnd(40, 125),
    cookie: rnd(32, 126),
    clearance: rnd(40, 127),
    device: rnd(36, 128),
    puid: rnd(28, 129),
    convo: rnd(32, 130, HEX),
    asset: rnd(26, 131),
    blob: rnd(120, 132, `${B62}+/`),
    hexBlob: rnd(100, 133, HEX),
  };
  const lineContext = 'LINE-CONTEXT-MUST-NOT-LEAK';

  async function seed(dir: string): Promise<void> {
    const convo = `${bodies.convo.slice(0, 8)}-${bodies.convo.slice(8, 12)}-4${bodies.convo.slice(13, 16)}-8${bodies.convo.slice(17, 20)}-${bodies.convo.slice(20, 32)}`;
    const lines = [
      join_('-----', 'BEGIN EC ', 'PRIVATE KEY', '-----'),
      join_('sk-', bodies.key),
      join_('ghp_', bodies.ghp),
      join_('AKIA', bodies.aws),
      join_('xox', 'p-', bodies.slack),
      `${join_('eyJ', rnd(20, 134))}.${join_('eyJ', rnd(20, 135))}.${bodies.jwtSig}`,
      `Authorization: Bearer ${bodies.bearer}`,
      `Cookie: sid=${bodies.cookie}`,
      `${join_('cf_', 'clearance')}=${bodies.clearance}`,
      `${join_('oai-', 'did')}=${bodies.device}`,
      `${join_('_pu', 'id')}=${bodies.puid}`,
      `https://${CHATGPT}/c/${convo}`,
      join_('sedi', 'ment://file_', bodies.asset),
      bodies.blob,
      bodies.hexBlob,
    ];
    await put(dir, 'src/leaky.txt', lines.map((l) => `${lineContext} ${l} ${lineContext}`).join('\n'));
    await put(dir, 'private.sqlite', 'x');
  }

  const sensitive = (): string[] => Object.values(bodies);

  function assertNoLeak(label: string, output: string): void {
    assert.ok(!output.includes(lineContext), `${label}: line content leaked`);
    for (const body of sensitive()) {
      assert.ok(!output.includes(body), `${label}: full secret leaked`);
      assert.ok(!output.includes(body.slice(0, 5)), `${label}: more than 4 leading characters leaked (${body.slice(0, 5)})`);
    }
  }

  it('never prints a secret, a prefix longer than 4 characters, or line content: findings, text, JSON, stderr, history', async () => {
    await inRepo(async (dir) => {
      await seed(dir);
      await commitAll(dir, 'leaky');
      await git(dir, 'rm', '-q', '-r', 'src');
      await commitAll(dir, 'remove');
      await seed(dir);

      const result = await scanRepo(dir, { history: true });
      assert.ok(result.findings.length >= 30, `expected both work-tree and history findings, got ${result.findings.length}`);
      const rules = new Set(result.findings.map((f) => f.rule));
      for (const rule of ['pem-private-key', 'openai-api-key', 'github-token', 'aws-access-key-id', 'slack-token', 'jwt', 'bearer-token', 'cookie-header', 'cloudflare-clearance-cookie', 'device-id', 'user-id-cookie', 'chatgpt-conversation-url', 'asset-pointer', 'high-entropy-blob', 'forbidden-extension']) {
        assert.ok(rules.has(rule), `missing rule ${rule}`);
      }
      assertNoLeak('findings json', JSON.stringify(result));
      assertNoLeak('formatFindings', formatFindings(result.findings));

      for (const argv of [[], ['--history'], ['--json'], ['--history', '--json'], ['--history', '--max-history-bytes', '3000']]) {
        const out = await main(['--root', dir, ...argv]);
        assert.equal(out.exitCode, 1);
        assertNoLeak(`main ${argv.join(' ')} stdout`, out.stdout);
        assertNoLeak(`main ${argv.join(' ')} stderr`, out.stderr);
      }
    });
  });

  it('keeps detail short: at most 4 secret characters plus a length, for every finding', async () => {
    await inRepo(async (dir) => {
      await seed(dir);
      for (const f of (await scanRepo(dir)).findings) assert.ok(f.detail.length < 200, `${f.rule}: ${f.detail.length}`);
    });
  });
});

// ---- determinism -------------------------------------------------------------------------------------------------------------------

describe('determinism', () => {
  const files: Record<string, string> = {
    'z/last.sqlite': 'x',
    'a/first.txt': `${join_('sk-', rnd(40, 140))}\n${join_('ghp_', rnd(36, 141))}\n`,
    'm/mid.md': `Cookie: a=${rnd(20, 142)}\n`,
    'export/x.json': '{}',
    'fixtures/conversations.json': '[]',
  };

  it('yields identical results regardless of creation order or staging state, and across repeated runs', async () => {
    const entries = Object.entries(files);
    const forward = await inRepo(async (dir) => {
      for (const [p, c] of entries) await put(dir, p, c);
      return scanRepo(dir);
    });
    const reversed = await inRepo(async (dir) => {
      for (const [p, c] of [...entries].reverse()) await put(dir, p, c);
      await git(dir, 'add', '-A');
      return scanRepo(dir);
    });
    const committedTwice = await inRepo(async (dir) => {
      for (const [p, c] of entries) await put(dir, p, c);
      await commitAll(dir, 'x');
      const a = await scanRepo(dir);
      const b = await scanRepo(dir);
      assert.deepEqual(a, b);
      return a;
    });
    assert.deepEqual(forward.findings, reversed.findings);
    assert.deepEqual(forward.findings, committedTwice.findings);
    const paths = forward.findings.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(forward.findings.length >= 6);
  });
});

// ---- robustness ----------------------------------------------------------------------------------------------------------------------

describe('robustness', () => {
  it('passes paths to git as arguments, never through a shell', async () => {
    await withTempDir(async (base) => {
      const hostile = join(base, `it's a $(touch pwned) repo; echo "x"`);
      await initRepo(hostile);
      await put(hostile, '$(touch pwned2).txt', 'x\n');
      await put(hostile, 'a;b`c`.txt', 'x\n');
      await put(hostile, '-rf.txt', 'x\n');
      const result = await scanRepo(hostile, { history: true });
      assert.deepEqual(result.findings, []);
      assert.equal(result.scannedFiles, 3);
      for (const name of ['pwned', 'pwned2']) await assert.rejects(access(join(hostile, name)));
      await assert.rejects(access(join(base, 'pwned')));
    });
  });

  it('ignores repository-location environment variables inherited from a hook or runner', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.sqlite', 'x');
      const saved = { dir: process.env['GIT_DIR'], tree: process.env['GIT_WORK_TREE'], index: process.env['GIT_INDEX_FILE'] };
      process.env['GIT_DIR'] = join(dir, 'does-not-exist.git');
      process.env['GIT_WORK_TREE'] = join(dir, 'nowhere');
      process.env['GIT_INDEX_FILE'] = join(dir, 'no-index');
      try {
        assert.deepEqual(summarize((await scanRepo(dir)).findings), [['forbidden-extension', 'a.sqlite', undefined]]);
      } finally {
        for (const [name, value] of [['GIT_DIR', saved.dir], ['GIT_WORK_TREE', saved.tree], ['GIT_INDEX_FILE', saved.index]] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  });

  it('rejects a directory that is not a repository, or not its top level, with an INVALID_ARGUMENT that names no path', async () => {
    await withTempDir(async (plain) => {
      await assert.rejects(scanRepo(plain), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && !e.message.includes(plain));
    });
    await inRepo(async (dir) => {
      await mkdir(join(dir, 'sub'), { recursive: true });
      await assert.rejects(scanRepo(join(dir, 'sub')), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && !e.message.includes(dir));
    });
  });

  it('never runs a core.fsmonitor program configured in the scanned repository', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'x\n');
      await commitAll(dir, 'one');
      const ran = join(dir, '..', `fsmonitor-ran-${process.pid}`);
      const hook = join(dir, '..', `fsmonitor-hook-${process.pid}.sh`);
      await writeFile(hook, `#!/bin/sh\ntouch '${ran}'\nprintf '\\0'\n`, { mode: 0o755 });
      try {
        await git(dir, 'config', 'core.fsmonitor', hook);
        await put(dir, 'b.txt', 'y\n');
        await git(dir, 'add', 'b.txt'); // plain git runs the hook here (and in diff/ls-files)
        // Control: plain git DOES run it, so the assertion below is not vacuous.
        await git(dir, 'diff', '--cached');
        await access(ran);
        await unlink(ran);
        await scanRepo(dir, { history: true });
        await assert.rejects(access(ran), { code: 'ENOENT' });
      } finally {
        await unlink(hook).catch(() => undefined);
        await unlink(ran).catch(() => undefined);
      }
    });
  });

  it('reports a file whose name is not valid UTF-8 instead of treating it as missing', async () => {
    await inRepo(async (dir) => {
      await writeFile(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74])]), `${join_('sk-', rnd(40, 160))}\n`);
      await put(dir, 'plain.txt', 'fine\n');
      const result = await scanRepo(dir);
      assert.deepEqual(result.findings.map((f) => f.rule), ['unreadable-file']);
      assert.match(result.findings[0]?.detail ?? '', /not valid UTF-8/);
      assert.equal(result.skippedNonRegular, 1);
      assert.equal(result.scannedFiles, 1);
    });
  });

  it('says when the staged diff was cut short by the byte cap', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'big.txt', 'filler line of ordinary text\n'.repeat(2000));
      await git(dir, 'add', 'big.txt');
      const result = await scanRepo(dir, { maxHistoryBytes: 5000 });
      assert.match(result.notes.join('\n'), /staged-diff scan truncated after \d+ bytes \(cap 5000\)/);
      assert.equal(result.history, null);
    });
  });

  it('reports an unreadable file instead of silently skipping it', { skip: process.getuid?.() === 0 ? 'running as root: file permissions are not enforced' : false }, async () => {
    await inRepo(async (dir) => {
      await put(dir, 'locked.txt', 'x\n');
      await chmod(join(dir, 'locked.txt'), 0o000);
      try {
        const result = await scanRepo(dir);
        assert.deepEqual(summarize(result.findings), [['unreadable-file', 'locked.txt', undefined]]);
      } finally {
        await chmod(join(dir, 'locked.txt'), 0o644);
      }
    });
  });

  it('does not modify the repository it scans (no index refresh, no lock files, no new objects)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'x\n');
      await commitAll(dir, 'one');
      await put(dir, 'b.txt', 'y\n');
      await git(dir, 'add', 'b.txt');
      await put(dir, 'c.txt', 'z\n');
      await git(dir, 'status', '--porcelain'); // let git do its own index refresh first
      const before = await snapshot(dir);
      await scanRepo(dir, { history: true });
      assert.equal(await snapshot(dir), before);
    });
  });
});

/** Name, size and mtime of every file under the work tree and .git: any write by the scanner changes it. */
async function snapshot(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    const st = await stat(abs);
    lines.push(`${abs.slice(dir.length)} ${st.size} ${st.mtimeMs}`);
  }
  return lines.sort().join('\n');
}

// ---- CLI entry point -------------------------------------------------------------------------------------------------------------------

describe('main()', () => {
  it('exits 0 and says "clean" for a clean repository', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'x\n');
      const out = await main(['--root', dir]);
      assert.equal(out.exitCode, 0);
      assert.match(out.stdout, /^privacy-scan: clean; 1 file\(s\) scanned/);
      assert.equal(out.stderr, '');
    });
  });

  it('exits 1 and lists path:line: [rule] detail for findings', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'a.sqlite': 'x', 'src/k.ts': `\n${join_('sk-', rnd(40, 150))}\n` });
      const out = await main([`--root=${dir}`]);
      assert.equal(out.exitCode, 1);
      const lines = out.stdout.split('\n');
      assert.equal(lines[0], 'a.sqlite: [forbidden-extension] files with extension .sqlite (database, archive, capture or key material) must not be committed');
      assert.match(lines[1] ?? '', /^src\/k\.ts:2: \[openai-api-key\] OpenAI-style API key sk-\w\*\*\* \(len 43\)$/);
      assert.match(lines[2] ?? '', /^privacy-scan: 2 finding\(s\);/);
    });
  });

  it('emits a stable JSON document with --json', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'a.sqlite': 'x', 'ok.txt': 'fine\n' });
      const out = await main(['--root', dir, '--json']);
      assert.equal(out.exitCode, 1);
      const doc = JSON.parse(out.stdout) as Record<string, unknown>;
      assert.deepEqual(Object.keys(doc), ['ok', 'findings', 'scannedFiles', 'skippedLarge', 'skippedBinary', 'skippedNonRegular', 'listedFiles', 'allowListedFiles', 'unscannedLarge', 'staged', 'history', 'notes']);
      assert.equal(doc['ok'], false);
      assert.equal(doc['history'], null);
      assert.equal(doc['scannedFiles'], 2); // both are text: a forbidden extension does not make a file binary
      assert.equal(out.stdout, `${JSON.stringify(doc, null, 2)}\n`);
    });
  });

  it('supports --history, --max-file-bytes and --max-history-bytes; a cut history is a finding unless --allow-large-unscanned is given', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'big.txt', 'x'.repeat(4000));
      await commitAll(dir, 'one');
      const limited = JSON.parse((await main(['--root', dir, '--json', '--max-file-bytes', '100'])).stdout) as { skippedLarge: number };
      assert.equal(limited.skippedLarge, 0); // 4000 bytes fit inside the head and tail windows, so the file is read in full
      const capped = await main(['--root', dir, '--history', '--max-history-bytes', '300']);
      assert.equal(capped.exitCode, 1); // history the scanner could not read is history it could not judge: fail closed
      assert.match(capped.stdout, /^\(git history\): \[scan-truncated\] history scan truncated/m);
      assert.match(capped.stderr, /^privacy-scan: note: history scan truncated/);
      assert.match(capped.stdout, /; history: /);
      const accepted = await main(['--root', dir, '--history', '--max-history-bytes', '300', '--allow-large-unscanned']);
      assert.equal(accepted.exitCode, 0); // local use: the same truncation is only a note
      assert.match(accepted.stderr, /^privacy-scan: note: history scan truncated/);
    });
  });

  it('counts a file above --max-file-bytes that is larger than the windows, and fails unless --allow-large-unscanned', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'big.txt', 'x'.repeat(LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES + 100));
      const failing = await main(['--root', dir, '--json', '--max-file-bytes', '100']);
      assert.equal(failing.exitCode, 1);
      assert.equal((JSON.parse(failing.stdout) as { skippedLarge: number }).skippedLarge, 1);
      const local = await main(['--root', dir, '--json', '--max-file-bytes', '100', '--allow-large-unscanned']);
      assert.equal(local.exitCode, 0);
      const doc = JSON.parse(local.stdout) as { skippedLarge: number; unscannedLarge: number; notes: string[] };
      assert.deepEqual([doc.skippedLarge, doc.unscannedLarge], [1, 1]);
      assert.match(doc.notes.join('\n'), /1 large file\(s\) were judged only in part and not reported .*: big\.txt/);
    });
  });

  it('exits 2 on usage errors without scanning', async () => {
    for (const argv of [['--nope'], ['stray'], ['--root'], ['--root='], ['--max-file-bytes', 'abc'], ['--max-file-bytes', '0'], ['--max-history-bytes', '-5'], ['--staged', '--history']]) {
      const out = await main(argv);
      assert.equal(out.exitCode, 2, argv.join(' '));
      assert.equal(out.stdout, '');
      assert.match(out.stderr, /^privacy-scan: .*\n\nUsage: /s);
    }
  });

  it('prints usage and exits 0 for --help', async () => {
    const out = await main(['--help']);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /^Usage: privacy-scan /);
  });

  it('exits 2 with a path-free message when the root is not a repository', async () => {
    await withTempDir(async (plain) => {
      const out = await main(['--root', plain]);
      assert.equal(out.exitCode, 2);
      assert.equal(out.stdout, '');
      assert.equal(out.stderr, 'privacy-scan: error: root is not inside a git work tree, or git could not open it\n');
    });
  });

  it('shows control characters in paths inertly', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'bad\u001b[31mname.sqlite', 'x');
      const out = await main(['--root', dir]);
      assert.ok(!out.stdout.includes('\u001b'));
      assert.match(out.stdout, /bad\\u001b\[31mname\.sqlite: \[forbidden-extension\]/);
    });
  });
});

// ---- launcher ---------------------------------------------------------------------------------------------------------------------------------

describe('scripts/privacy-scan.mjs launcher', () => {
  // Compiled tests live at <root>/<outDir>/test/devtools; the launcher is exercised through a copy whose ../dist
  // import is redirected to the freshly compiled module, so the real launcher text is what runs.
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const launcher = join(repoRoot, 'scripts', 'privacy-scan.mjs');
  const compiled = fileURLToPath(new URL('../../src/devtools/privacy-scan.js', import.meta.url));

  async function runLauncher(args: string[], withDist: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
    return withTempDir(async (home) => {
      await mkdir(join(home, 'scripts'), { recursive: true });
      await copyFile(launcher, join(home, 'scripts', 'privacy-scan.mjs'));
      if (withDist) {
        await mkdir(join(home, 'dist', 'devtools'), { recursive: true });
        await writeFile(join(home, 'dist', 'devtools', 'privacy-scan.js'), `export * from ${JSON.stringify(new URL(`file://${compiled}`).href)};\n`);
      }
      await writeFile(join(home, 'package.json'), '{"type":"module"}\n');
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [join(home, 'scripts', 'privacy-scan.mjs'), ...args], { encoding: 'utf8' });
        return { code: 0, stdout, stderr };
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      }
    });
  }

  it('exits 0 when clean, 1 with findings, 2 on errors, and 2 with advice when dist is missing', async () => {
    await access(launcher);
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'x\n');
      const clean = await runLauncher(['--root', dir], true);
      assert.deepEqual([clean.code, clean.stderr], [0, '']);
      assert.match(clean.stdout, /^privacy-scan: clean/);

      await put(dir, 'b.sqlite', 'x');
      const dirty = await runLauncher(['--root', dir], true);
      assert.equal(dirty.code, 1);
      assert.match(dirty.stdout, /b\.sqlite: \[forbidden-extension\]/);

      const bad = await runLauncher(['--bogus'], true);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /unknown argument/);

      const noDist = await runLauncher(['--root', dir], false);
      assert.equal(noDist.code, 2);
      assert.equal(noDist.stderr, 'privacy-scan: cannot load dist/devtools/privacy-scan.js; run `npm run build` first.\n');
    });
  });
});
