/**
 * ATK-03 (parts 1 and 2): `.gitignore` for the natural export locations, the `--staged` scan mode, and the opt-in git hooks.
 *
 * Everything runs in THROWAWAY git repositories (no network, no global git configuration, hooks only where a test installs them),
 * with the real `.gitignore`, the real hook scripts and the real installer copied in. The hooks call the real launcher
 * (scripts/privacy-scan.mjs), whose `../dist` import is redirected to the freshly compiled scanner.
 *
 * All secret-shaped text is assembled at run time from fragments so this file contains none.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { LARGE_FILE_HEAD_BYTES, LARGE_FILE_TAIL_BYTES, SYNTHETIC_MARKER, main, scanRepo } from '../../src/devtools/privacy-scan.js';
import { GcrError } from '../../src/errors.js';
import { withTempDir } from '../helpers/tmp.js';
import { chatgptExportOfAtLeast, commitAll, git, initRepo, inRepo, join_, put, putAll, rnd, rulesOf, summarize } from './fixwave-privacy-helpers.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
// Compiled tests live at <root>/<outDir>/test/devtools, whatever the out dir is called.
const REPO_ROOT = join(here, '..', '..', '..');
const COMPILED_SCANNER = join(here, '..', '..', 'src', 'devtools', 'privacy-scan.js');
const BIG = LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES + 5000;
const key = (seed: number): string => join_('sk-', rnd(40, seed));
const filler = (bytes: number): string => 'filler line of ordinary text\n'.repeat(Math.ceil(bytes / 29)).slice(0, bytes);
const posix = process.platform !== 'win32';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { encoding: 'utf8', ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), env: opts.env ?? process.env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** git for the hook tests: PATH starts with the directory of the node binary running this test, so the hooks find `node`. */
const withNode = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env['PATH'] ?? ''}` });
const gitRun = (dir: string, args: string[], env: NodeJS.ProcessEnv = withNode()): Promise<Ran> => run('git', ['-C', dir, ...args], { env });

/** Copy the real launcher, installer and hook scripts into `dir` and point the launcher's ../dist import at the compiled scanner. */
async function installScripts(dir: string, opts: { scanner?: boolean } = {}): Promise<void> {
  await mkdir(join(dir, 'scripts'), { recursive: true });
  for (const f of ['privacy-scan.mjs', 'install-git-hooks.mjs']) await copyFile(join(REPO_ROOT, 'scripts', f), join(dir, 'scripts', f));
  await cp(join(REPO_ROOT, 'scripts', 'git-hooks'), join(dir, 'scripts', 'git-hooks'), { recursive: true });
  if (opts.scanner !== false) {
    await mkdir(join(dir, 'dist', 'devtools'), { recursive: true });
    await writeFile(join(dir, 'dist', 'devtools', 'privacy-scan.js'), `export * from ${JSON.stringify(pathToFileURL(COMPILED_SCANNER).href)};\n`);
  }
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(dir, '.gitignore'), 'dist/\n');
}

/** A repository with the scripts, the hooks installed, and one clean commit. */
async function withHookedRepo<T>(fn: (dir: string) => Promise<T>, opts: { install?: boolean } = {}): Promise<T> {
  return withTempDir(async (dir) => {
    await initRepo(dir, { hooks: true });
    await installScripts(dir);
    if (opts.install !== false) {
      const installed = await run(process.execPath, [join(dir, 'scripts', 'install-git-hooks.mjs')]);
      assert.equal(installed.code, 0, installed.stderr);
    }
    await put(dir, 'README.txt', 'a clean repository\n');
    await git(dir, 'add', '-A');
    const first = await gitRun(dir, ['commit', '-q', '-m', 'first']);
    assert.equal(first.code, 0, first.stderr);
    return fn(dir);
  });
}

const head = async (dir: string): Promise<string> => (await git(dir, 'rev-parse', 'HEAD')).trim();

// ---- .gitignore ---------------------------------------------------------------------------------------------------------------

describe('ATK-03: .gitignore protects the natural export and output locations', () => {
  const IGNORED = [
    'conversations.json',
    'conversations-001.json',
    'chatgpt-export/conversations.json',
    'chatgpt-export/user.json',
    'chatgpt-export/chat.html',
    'chatgpt-export/message_feedback.json',
    'chatgpt-export/shared_conversations.json',
    'chatgpt-export-2026-10-01/anything.txt',
    'claude-export/conversations.json',
    'claude-export-1/x.md',
    'a/b/conversations (1).json',
    'sub/exports/a.json',
    'docs/private/x.json',
    'deep/er/export/sub/thing.json',
    'user.json',
    'a/user.json',
    'graph.html',
    'out/graph.html',
    'out/my-graph-page.html',
    'x.db3',
    'x.db-wal',
    'x.db-shm',
    'x.db-journal',
    'x.sqlite-journal',
    'x.sqlite3-wal',
    'x.db3-journal',
    'har.har',
    'traffic/session.har',
    'id_rsa',
    'id_rsa.pub',
    'cookies.txt',
    'sub/cookies.txt',
    '.gcr/gcr.sqlite',
    'data.sqlite',
    'a.zip',
    '.env.local',
  ];
  const ADDABLE = [
    'fixtures/chatgpt/conversations.json',
    'fixtures/a/b/conversations-2.json',
    'fixtures/chatgpt/branching.json',
    'fixtures/claude/linear.json',
    'docs/README.md',
    'docs/USER_GUIDE.md',
    'docs/graph-notes.md',
    'docs/mcp-tool-schemas.json',
    'src/graph/export-html.ts',
    'src/ingest/chatgpt-export.ts',
    'test/graph/export-html.test.ts',
    'test/helpers/chatgpt-export-builder.ts',
    'scripts/install-git-hooks.mjs',
    'scripts/git-hooks/pre-commit',
    'scripts/git-hooks/pre-push',
    '.env.example',
    'src/export/notes.ts',
    'exporter/data.json',
  ];

  it('ignores every natural export / output location listed in the review, at any depth', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir);
      await copyFile(join(REPO_ROOT, '.gitignore'), join(dir, '.gitignore'));
      for (const p of IGNORED) {
        const r = await gitRun(dir, ['check-ignore', '-q', '--', p]);
        assert.equal(r.code, 0, `${p} should be ignored`);
      }
    });
  });

  it('still lets synthetic fixtures, docs, sources, hooks and the example env file be added', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir);
      await copyFile(join(REPO_ROOT, '.gitignore'), join(dir, '.gitignore'));
      for (const p of ADDABLE) {
        const r = await gitRun(dir, ['check-ignore', '-q', '--', p]);
        assert.equal(r.code, 1, `${p} must stay addable`);
      }
    });
  });

  it('ignores none of the files this repository tracks (git ls-files -ci is empty)', async () => {
    try {
      await access(join(REPO_ROOT, '.git'));
    } catch {
      return; // not running inside a checkout
    }
    const listed = await gitRun(REPO_ROOT, ['ls-files', '-ci', '--exclude-standard']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout.trim(), '', `tracked files that .gitignore now ignores:\n${listed.stdout}`);
  });

  it('keeps the rules the review asked for in the file, in their unanchored spelling', async () => {
    const text = await readFile(join(REPO_ROOT, '.gitignore'), 'utf8');
    const lines = new Set(text.split('\n').map((l) => l.trim()));
    for (const rule of ['**/conversations*.json', '**/user.json', '**/chat.html', '**/message_feedback.json', '**/shared_conversations.json', '*graph*.html', '*.db-wal', '*.db-shm', '*.db-journal', '*.sqlite-journal', '*.db3', 'chatgpt-export*/', 'claude-export*/', '*.har', 'id_rsa*', 'cookies.txt']) {
      assert.ok(lines.has(rule), `.gitignore lacks ${rule}`);
    }
  });
});

// ---- --staged ---------------------------------------------------------------------------------------------------------------------

describe('ATK-03: --staged judges the index, not the work tree', () => {
  it('reports a secret that is staged even when the work-tree copy was cleaned afterwards, with its path and line', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'clean\n');
      await commitAll(dir, 'base');
      await put(dir, 'staged-secret.txt', `line one\n${key(1)}\n`);
      await git(dir, 'add', 'staged-secret.txt');
      await put(dir, 'staged-secret.txt', 'cleaned up after staging\n');
      const result = await scanRepo(dir, { staged: true });
      assert.deepEqual(summarize(result.findings), [['openai-api-key', 'staged-secret.txt', 2]]);
      assert.equal(result.staged, true);
      assert.equal(result.scannedFiles, 1);
      assert.equal(result.listedFiles, 1);
    });
  });

  it('ignores work-tree-only content: unstaged edits and untracked files are not part of the commit', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'tracked.txt': 'clean\n', 'other.txt': 'clean\n' });
      await commitAll(dir, 'base');
      await put(dir, 'tracked.txt', `edited, not staged\n${key(2)}\n`);
      await put(dir, 'untracked.txt', `${key(3)}\n`);
      await put(dir, 'untracked.sqlite', 'x');
      const staged = await scanRepo(dir, { staged: true });
      assert.deepEqual(staged.findings, []);
      assert.equal(staged.scannedFiles, 0);
      // The default scan is the one that sees the work tree.
      const worktree = await scanRepo(dir);
      assert.deepEqual(summarize(worktree.findings), [['openai-api-key', 'tracked.txt', 2], ['forbidden-extension', 'untracked.sqlite', undefined], ['openai-api-key', 'untracked.txt', 1]]);
    });
  });

  it('judges only what changes: a bad file that is already committed is not part of this commit', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'old.txt', `${key(4)}\n`);
      await commitAll(dir, 'oops');
      await put(dir, 'new.txt', 'fine\n');
      await git(dir, 'add', 'new.txt');
      const result = await scanRepo(dir, { staged: true });
      assert.deepEqual(result.findings, []);
      assert.equal(result.scannedFiles, 1);
      assert.deepEqual(summarize((await scanRepo(dir)).findings), [['openai-api-key', 'old.txt', 1]]);
    });
  });

  it('applies the path rules to staged names (a rename to a forbidden name counts), but not to a staged deletion', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'a.txt': 'fine\n', 'secret.txt': `${key(5)}\n` });
      await commitAll(dir, 'base');
      await git(dir, 'mv', 'a.txt', 'chats.sqlite');
      await git(dir, 'rm', '-q', 'secret.txt');
      const result = await scanRepo(dir, { staged: true });
      assert.deepEqual(summarize(result.findings), [['forbidden-extension', 'chats.sqlite', undefined]]);
    });
  });

  it('works for the very first commit of a repository (no HEAD yet)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'k.txt', `${key(6)}\n`);
      await git(dir, 'add', 'k.txt');
      assert.deepEqual(summarize((await scanRepo(dir, { staged: true })).findings), [['openai-api-key', 'k.txt', 1]]);
    });
  });

  it('judges staged shape, GCR output and fixture rules like the work-tree scan does', async () => {
    await inRepo(async (dir) => {
      const text = chatgptExportOfAtLeast(1);
      await putAll(dir, {
        'my-chats.json': text,
        'fixtures/chatgpt/ok.json': text.replace('invented chat 0', `${SYNTHETIC_MARKER} chat 0`),
        'fixtures/chatgpt/bad.json': text,
        'out/get.json': `{"ok":true,"data":{},"source":[],"completeness":"unknown","warnings":[],"ids":{},"untrustedContent":true}`,
        'conversations.json': '[]',
      });
      await git(dir, 'add', '-A');
      const result = await scanRepo(dir, { staged: true });
      assert.deepEqual(summarize(result.findings), [
        ['export-file-outside-fixtures', 'conversations.json', undefined],
        ['synthetic-marker-missing', 'fixtures/chatgpt/bad.json', undefined],
        ['synthetic-marker-missing', 'my-chats.json', undefined],
        ['gcr-output-file', 'out/get.json', undefined],
      ]);
    });
  });

  it('reads a large staged blob through its head, reports it as unjudged, and still finds a secret deep inside via the staged diff', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'my-chats.json', chatgptExportOfAtLeast(BIG));
      await put(dir, 'notes/big.md', `${filler(BIG)}\n${key(7)}\n${filler(BIG)}`);
      await git(dir, 'add', '-A');
      const result = await scanRepo(dir, { staged: true, maxFileBytes: 100_000 });
      const rulesFor = (path: string): string[] => rulesOf(result.findings.filter((f) => f.path === path));
      assert.deepEqual(rulesFor('my-chats.json'), ['synthetic-marker-missing', 'unscanned-large-file']);
      // The unjudged-remainder finding has no line, so it sorts before the key found by the staged-diff pass.
      assert.deepEqual(rulesFor('notes/big.md'), ['unscanned-large-file', 'openai-api-key']);
      assert.equal(result.skippedLarge, 2);
      const local = await scanRepo(dir, { staged: true, maxFileBytes: 100_000, allowLargeUnscanned: true });
      assert.ok(!rulesOf(local.findings).includes('unscanned-large-file'));
      assert.equal(local.unscannedLarge, 2);
    });
  });

  it('records a staged symlink as a non-regular entry without following it', { skip: posix ? false : 'symlinks need privileges on Windows' }, async () => {
    await inRepo(async (dir) => {
      await put(dir, 'target.txt', 'fine\n');
      await symlink('target.txt', join(dir, 'link.txt'));
      await git(dir, 'add', '-A');
      const result = await scanRepo(dir, { staged: true });
      assert.deepEqual(result.findings, []);
      assert.equal(result.skippedNonRegular, 1);
      assert.equal(result.scannedFiles, 1);
    });
  });

  it('honours the allow-file', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { '.privacy-scan-allow': 'known/safe.sqlite\n', 'known/safe.sqlite': 'x', 'other.sqlite': 'x' });
      await git(dir, 'add', '-A');
      const result = await scanRepo(dir, { staged: true });
      assert.deepEqual(summarize(result.findings), [['forbidden-extension', 'other.sqlite', undefined]]);
      assert.equal(result.allowListedFiles, 1);
    });
  });

  it('masks what it finds and leaves the repository untouched (index bytes, no lock file, no new objects)', async () => {
    await inRepo(async (dir) => {
      const secret = key(8);
      await put(dir, 'k.txt', `${secret}\n`);
      await git(dir, 'add', 'k.txt');
      const indexBefore = await readFile(join(dir, '.git', 'index'));
      const objectsBefore = (await git(dir, 'count-objects', '-v')).split('\n').find((l) => l.startsWith('count:'));
      const result = await scanRepo(dir, { staged: true });
      assert.ok(!JSON.stringify(result).includes(secret.slice(4, 12)));
      assert.deepEqual(await readFile(join(dir, '.git', 'index')), indexBefore);
      assert.equal((await git(dir, 'count-objects', '-v')).split('\n').find((l) => l.startsWith('count:')), objectsBefore);
      await assert.rejects(access(join(dir, '.git', 'index.lock')), { code: 'ENOENT' });
    });
  });

  it('cannot be combined with --history, in the API or on the command line', async () => {
    await inRepo(async (dir) => {
      await assert.rejects(scanRepo(dir, { staged: true, history: true }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
      const out = await main(['--root', dir, '--staged', '--history']);
      assert.equal(out.exitCode, 2);
      assert.match(out.stderr, /--staged and --history cannot be combined/);
    });
  });

  it('prints a summary that says "staged" and reports the mode in JSON', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'fine\n');
      await git(dir, 'add', 'a.txt');
      const text = await main(['--root', dir, '--staged']);
      assert.equal(text.exitCode, 0);
      assert.match(text.stdout, /^privacy-scan: clean; 1 staged file\(s\) scanned/);
      const json = JSON.parse((await main(['--root', dir, '--staged', '--json'])).stdout) as { staged: boolean; ok: boolean };
      assert.deepEqual([json.staged, json.ok], [true, true]);
    });
  });

  it('judges the TEMPORARY index git hands to a hook for `commit -a` (GIT_INDEX_FILE), and only in staged mode', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.txt', 'clean\n');
      await commitAll(dir, 'base');
      await put(dir, 'a.txt', `${key(9)}\n`);
      const temporaryIndex = join(dir, '.git', 'temporary-index-for-the-test');
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      await run('git', ['-C', dir, 'read-tree', 'HEAD'], { env });
      await run('git', ['-C', dir, 'add', 'a.txt'], { env });
      const saved = process.env['GIT_INDEX_FILE'];
      process.env['GIT_INDEX_FILE'] = temporaryIndex;
      try {
        assert.deepEqual(summarize((await scanRepo(dir, { staged: true })).findings), [['openai-api-key', 'a.txt', 1]]);
        // The default scan never lets an environment variable redirect it at another index; it reads the work tree: same secret, found there.
        await put(dir, 'a.txt', 'clean again\n');
        assert.deepEqual((await scanRepo(dir)).findings, []);
      } finally {
        if (saved === undefined) delete process.env['GIT_INDEX_FILE'];
        else process.env['GIT_INDEX_FILE'] = saved;
      }
      // Without the variable the real index (clean) is what staged mode judges.
      assert.deepEqual((await scanRepo(dir, { staged: true })).findings, []);
    });
  });

  it('fails closed when the staged diff is cut short for a blob that was read only in part', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'notes/big.md', filler(BIG));
      await git(dir, 'add', 'notes/big.md');
      const result = await scanRepo(dir, { staged: true, maxFileBytes: 100_000, maxHistoryBytes: 5000 });
      assert.deepEqual(summarize(result.findings), [['scan-truncated', '(staged diff)', undefined], ['unscanned-large-file', 'notes/big.md', undefined]]);
    });
  });
});

// ---- the hooks ----------------------------------------------------------------------------------------------------------------------

describe('ATK-03: the opt-in installer', { skip: posix ? false : 'the hooks are POSIX shell scripts' }, () => {
  const installer = (dir: string): string => join(dir, 'scripts', 'install-git-hooks.mjs');
  const hookPath = (dir: string, name: string): string => join(dir, '.git', 'hooks', name);

  it('installs both hooks as executable copies (also into a repository with no hooks directory), prints what it did, and sets no git configuration', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir, { hooks: true });
      await installScripts(dir);
      const configBefore = await readFile(join(dir, '.git', 'config'), 'utf8');
      const r = await run(process.execPath, [installer(dir)]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^installed: \.git\/hooks\/pre-commit$/m);
      assert.match(r.stdout, /^installed: \.git\/hooks\/pre-push$/m);
      assert.match(r.stdout, /--no-verify/);
      for (const name of ['pre-commit', 'pre-push']) {
        const st = await lstat(hookPath(dir, name));
        assert.ok(st.isFile() && !st.isSymbolicLink());
        assert.equal(st.mode & 0o777, 0o755);
        assert.equal(await readFile(hookPath(dir, name), 'utf8'), await readFile(join(dir, 'scripts', 'git-hooks', name), 'utf8'));
      }
      assert.equal(await readFile(join(dir, '.git', 'config'), 'utf8'), configBefore); // nothing local ...
      assert.equal((await gitRun(dir, ['config', '--global', '--list'])).stdout, ''); // ... and nothing global (the global file is /dev/null here)
    });
  });

  it('is idempotent and updates its own earlier copy without --force', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir, { hooks: true });
      await installScripts(dir);
      assert.equal((await run(process.execPath, [installer(dir)])).code, 0);
      const again = await run(process.execPath, [installer(dir)]);
      assert.equal(again.code, 0);
      assert.match(again.stdout, /^unchanged: \.git\/hooks\/pre-commit is already up to date$/m);
      const old = (await readFile(hookPath(dir, 'pre-commit'), 'utf8')).replace('v1', 'v0');
      await writeFile(hookPath(dir, 'pre-commit'), old);
      const updated = await run(process.execPath, [installer(dir)]);
      assert.equal(updated.code, 0);
      assert.match(updated.stdout, /^updated: \.git\/hooks\/pre-commit$/m);
      assert.match(await readFile(hookPath(dir, 'pre-commit'), 'utf8'), /gcr-privacy-hook v1/);
    });
  });

  it('refuses to overwrite a hook it did not write, installs nothing at all, and --force keeps the old file as a backup', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir, { hooks: true });
      await installScripts(dir);
      await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
      await writeFile(hookPath(dir, 'pre-push'), '#!/bin/sh\necho "somebody else\'s hook"\n');
      await chmod(hookPath(dir, 'pre-push'), 0o755);
      const refused = await run(process.execPath, [installer(dir)]);
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /refused: \.git\/hooks\/pre-push exists and was not installed by this script/);
      assert.match(refused.stderr, /Nothing was installed/);
      assert.match(await readFile(hookPath(dir, 'pre-push'), 'utf8'), /somebody else/);
      await assert.rejects(access(hookPath(dir, 'pre-commit')), { code: 'ENOENT' }); // all or nothing

      const forced = await run(process.execPath, [installer(dir), '--force']);
      assert.equal(forced.code, 0, forced.stderr);
      assert.match(forced.stdout, /^backed up: \.git\/hooks\/pre-push -> \.git\/hooks\/pre-push\.pre-gcr-backup$/m);
      assert.match(await readFile(`${hookPath(dir, 'pre-push')}.pre-gcr-backup`, 'utf8'), /somebody else/);
      assert.match(await readFile(hookPath(dir, 'pre-push'), 'utf8'), /gcr-privacy-hook/);
    });
  });

  it('treats a symlink in the hook position as foreign and never writes through it', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir, { hooks: true });
      await installScripts(dir);
      await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
      await writeFile(join(dir, 'elsewhere.sh'), 'untouched\n');
      await symlink(join(dir, 'elsewhere.sh'), hookPath(dir, 'pre-commit'));
      const refused = await run(process.execPath, [installer(dir)]);
      assert.equal(refused.code, 1);
      assert.equal(await readFile(join(dir, 'elsewhere.sh'), 'utf8'), 'untouched\n');
      const forced = await run(process.execPath, [installer(dir), '--force']);
      assert.equal(forced.code, 0, forced.stderr);
      assert.equal(await readFile(join(dir, 'elsewhere.sh'), 'utf8'), 'untouched\n');
      assert.ok((await lstat(hookPath(dir, 'pre-commit'))).isFile());
    });
  });

  it('stops when core.hooksPath is set (git would ignore .git/hooks) instead of reporting a success that protects nothing', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir); // initRepo sets core.hooksPath=/dev/null by default
      await installScripts(dir);
      const r = await run(process.execPath, [installer(dir)]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /core\.hooksPath is set/);
      await assert.rejects(access(hookPath(dir, 'pre-commit')), { code: 'ENOENT' });
    });
  });

  it('--uninstall removes its own hooks only', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir, { hooks: true });
      await installScripts(dir);
      assert.equal((await run(process.execPath, [installer(dir)])).code, 0);
      await writeFile(hookPath(dir, 'pre-push'), '#!/bin/sh\necho "mine now"\n');
      const r = await run(process.execPath, [installer(dir), '--uninstall']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^removed: \.git\/hooks\/pre-commit$/m);
      assert.match(r.stdout, /^kept: \.git\/hooks\/pre-push was not installed by this script$/m);
      await assert.rejects(access(hookPath(dir, 'pre-commit')), { code: 'ENOENT' });
      assert.match(await readFile(hookPath(dir, 'pre-push'), 'utf8'), /mine now/);
      const none = await run(process.execPath, [installer(dir), '--uninstall']);
      assert.match(none.stdout, /^not installed: pre-commit$/m);
    });
  });

  it('rejects unknown arguments with status 2 and prints usage for --help', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir, { hooks: true });
      await installScripts(dir);
      const bad = await run(process.execPath, [installer(dir), '--bogus']);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /unknown argument: --bogus/);
      const help = await run(process.execPath, [installer(dir), '--help']);
      assert.equal(help.code, 0);
      assert.match(help.stdout, /^Usage: node scripts\/install-git-hooks\.mjs/);
      await assert.rejects(access(hookPath(dir, 'pre-commit')), { code: 'ENOENT' });
    });
  });

  it('the hook files shipped in scripts/git-hooks carry the marker, fail closed and say how to bypass knowingly (the installer sets the executable bit on the copies)', async () => {
    for (const name of ['pre-commit', 'pre-push']) {
      const file = join(REPO_ROOT, 'scripts', 'git-hooks', name);
      const text = await readFile(file, 'utf8');
      assert.match(text, /^#!\/bin\/sh\n# gcr-privacy-hook v1/);
      assert.match(text, name === 'pre-commit' ? /git commit --no-verify/ : /git push --no-verify/);
      assert.match(text, /fails closed/);
      assert.match(text, /node scripts\/install-git-hooks\.mjs/);
    }
    const commitHook = await readFile(join(REPO_ROOT, 'scripts', 'git-hooks', 'pre-commit'), 'utf8');
    const pushHook = await readFile(join(REPO_ROOT, 'scripts', 'git-hooks', 'pre-push'), 'utf8');
    assert.match(commitHook, /^scanner="\$root\/scripts\/privacy-scan\.mjs"$/m);
    assert.match(commitHook, /^node "\$scanner" --root "\$root" --staged$/m); // the pre-commit hook judges the index
    assert.match(pushHook, /^node "\$scanner" --root "\$root"$/m); // the pre-push hook runs the normal tree scan
    assert.deepEqual((await readdir(join(REPO_ROOT, 'scripts', 'git-hooks'))).sort(), ['pre-commit', 'pre-push']);
  });
});

describe('ATK-03: the hooks refuse what the scan finds, and fail closed when it cannot run', { skip: posix ? false : 'the hooks are POSIX shell scripts' }, () => {
  it('pre-commit: a clean commit goes through; a staged secret is refused with the finding, a masked value and the bypass instructions', async () => {
    await withHookedRepo(async (dir) => {
      await put(dir, 'ok.txt', 'fine\n');
      await git(dir, 'add', 'ok.txt');
      const ok = await gitRun(dir, ['commit', '-q', '-m', 'ok']);
      assert.equal(ok.code, 0, ok.stderr);

      const secret = key(10);
      const before = await head(dir);
      await put(dir, 'src-notes.txt', `first\n${secret}\n`);
      await git(dir, 'add', 'src-notes.txt');
      const blocked = await gitRun(dir, ['commit', '-q', '-m', 'oops']);
      assert.notEqual(blocked.code, 0);
      assert.equal(await head(dir), before);
      const text = `${blocked.stdout}${blocked.stderr}`;
      assert.match(text, /src-notes\.txt:2: \[openai-api-key\] OpenAI-style API key sk-\w\*\*\* \(len 43\)/);
      assert.ok(!text.includes(secret.slice(4, 12)));
      assert.match(text, /the commit was REFUSED/);
      assert.match(text, /git commit --no-verify/);
      assert.match(text, /stays in Git history after the file is deleted/);

      const bypass = await gitRun(dir, ['commit', '-q', '--no-verify', '-m', 'knowingly']);
      assert.equal(bypass.code, 0, bypass.stderr);
      assert.notEqual(await head(dir), before);
    });
  });

  it('pre-commit: judges the TEMPORARY index of `git commit -a` and `git commit <path>` (the tracked file is modified but not staged)', async () => {
    await withHookedRepo(async (dir) => {
      const before = await head(dir);
      await put(dir, 'README.txt', `a clean repository\n${key(11)}\n`);
      const viaAll = await gitRun(dir, ['commit', '-q', '-a', '-m', 'all']);
      assert.notEqual(viaAll.code, 0, 'commit -a must be refused');
      assert.match(`${viaAll.stdout}${viaAll.stderr}`, /README\.txt:2: \[openai-api-key\]/);
      const viaPath = await gitRun(dir, ['commit', '-q', '-m', 'path', '--', 'README.txt']);
      assert.notEqual(viaPath.code, 0, 'commit <path> must be refused');
      assert.equal(await head(dir), before);
      // A plain commit of nothing staged has nothing to judge: the unstaged secret is not part of it (and git says nothing to commit).
      const plain = await gitRun(dir, ['commit', '-q', '-m', 'plain']);
      assert.notEqual(plain.code, 0);
      assert.doesNotMatch(`${plain.stdout}${plain.stderr}`, /REFUSED/);
    });
  });

  it('pre-commit: refuses staged export-shaped data, GCR output and databases too', async () => {
    await withHookedRepo(async (dir) => {
      await put(dir, 'my-chats.json', chatgptExportOfAtLeast(1));
      await git(dir, 'add', 'my-chats.json');
      const r = await gitRun(dir, ['commit', '-q', '-m', 'export']);
      assert.notEqual(r.code, 0);
      assert.match(`${r.stdout}${r.stderr}`, /my-chats\.json: \[synthetic-marker-missing\]/);
    });
  });

  it('pre-commit: fails CLOSED when node is not on PATH, says so, and tells how to bypass knowingly', async () => {
    await withHookedRepo(async (dir) => {
      const emptyPath = join(dir, 'empty-path');
      await mkdir(emptyPath);
      const hook = join(dir, '.git', 'hooks', 'pre-commit');
      const direct = await run('/bin/sh', [hook], { cwd: dir, env: { PATH: emptyPath } });
      assert.equal(direct.code, 1);
      assert.match(direct.stderr, /`node` was not found on PATH, so the privacy scan cannot run/);
      assert.match(direct.stderr, /REFUSED \(the hook fails closed/);
      assert.match(direct.stderr, /git commit --no-verify/);
      assert.match(direct.stderr, /stays in Git history after the file is deleted/);

      // The same through git itself: a PATH that has git but no node.
      const bin = join(dir, 'only-git');
      await mkdir(bin);
      const gitPath = (await run('/bin/sh', ['-c', 'command -v git'])).stdout.trim();
      await symlink(gitPath, join(bin, 'git'));
      await put(dir, 'new.txt', 'fine\n');
      await git(dir, 'add', 'new.txt');
      const before = await head(dir);
      const viaGit = await run(join(bin, 'git'), ['-C', dir, 'commit', '-q', '-m', 'no node'], { env: { ...process.env, PATH: bin } });
      assert.notEqual(viaGit.code, 0);
      assert.equal(await head(dir), before);
      assert.match(viaGit.stderr, /`node` was not found on PATH/);
    });
  });

  it('pre-commit: fails closed when the scanner is missing or not built, instead of letting the commit through', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir, { hooks: true });
      await installScripts(dir, { scanner: false }); // no dist/: `npm run build` was not run
      assert.equal((await run(process.execPath, [join(dir, 'scripts', 'install-git-hooks.mjs')])).code, 0);
      await put(dir, 'a.txt', 'fine\n');
      await git(dir, 'add', 'a.txt');
      const notBuilt = await gitRun(dir, ['commit', '-q', '-m', 'x']);
      assert.notEqual(notBuilt.code, 0);
      assert.match(notBuilt.stderr, /cannot load dist\/devtools\/privacy-scan\.js; run `npm run build` first/);
      assert.match(notBuilt.stderr, /the scanner could not run \(exit status 2\)/);
      assert.match(notBuilt.stderr, /git commit --no-verify/);

      await rm(join(dir, 'scripts', 'privacy-scan.mjs'));
      const missing = await gitRun(dir, ['commit', '-q', '-m', 'x']);
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /does not exist \(a branch without the scanner\?\)/);
    });
  });

  it('pre-push: pushes a clean work tree, refuses a tree with a finding, and --no-verify pushes anyway', async () => {
    await withHookedRepo(async (dir) => {
      await withTempDir(async (remoteParent) => {
        const remote = join(remoteParent, 'remote.git');
        await mkdir(remote);
        assert.equal((await run('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: withNode() })).code, 0);
        await git(dir, 'remote', 'add', 'origin', remote);
        const ok = await gitRun(dir, ['push', '-q', 'origin', 'main']);
        assert.equal(ok.code, 0, ok.stderr);

        await put(dir, 'notes.md', `${key(12)}\n`);
        await git(dir, 'add', 'notes.md');
        assert.equal((await gitRun(dir, ['commit', '-q', '--no-verify', '-m', 'oops'])).code, 0);
        const refused = await gitRun(dir, ['push', '-q', 'origin', 'main']);
        assert.notEqual(refused.code, 0);
        assert.match(`${refused.stdout}${refused.stderr}`, /notes\.md:1: \[openai-api-key\]/);
        assert.match(refused.stderr, /the push was REFUSED/);
        assert.match(refused.stderr, /git push --no-verify/);
        assert.equal((await run('git', ['-C', remote, 'rev-parse', 'main'], { env: withNode() })).stdout.trim() !== (await head(dir)), true);

        const bypass = await gitRun(dir, ['push', '-q', '--no-verify', 'origin', 'main']);
        assert.equal(bypass.code, 0, bypass.stderr);
        assert.equal((await run('git', ['-C', remote, 'rev-parse', 'main'], { env: withNode() })).stdout.trim(), await head(dir));
      });
    });
  });

  it('pre-push: fails closed without node too', async () => {
    await withHookedRepo(async (dir) => {
      const emptyPath = join(dir, 'empty-path');
      await mkdir(emptyPath);
      const direct = await run('/bin/sh', [join(dir, '.git', 'hooks', 'pre-push')], { cwd: dir, env: { PATH: emptyPath } });
      assert.equal(direct.code, 1);
      assert.match(direct.stderr, /`node` was not found on PATH/);
      assert.match(direct.stderr, /git push --no-verify/);
    });
  });
});

// ---- documentation ------------------------------------------------------------------------------------------------------------------

describe('ATK-02/03/09: the documentation says what the code does', () => {
  it('README tells contributors how to run the scan and install the hooks; SECURITY_AND_BOUNDARIES documents the new rules and the gaps', async () => {
    const readme = await readFile(join(REPO_ROOT, 'README.md'), 'utf8');
    for (const needle of ['node scripts/privacy-scan.mjs --root .', 'unscanned-large-file', '.privacy-scan-allow', '--staged', 'node scripts/install-git-hooks.mjs', '--force', '--uninstall', '--no-verify']) {
      assert.ok(readme.includes(needle), `README.md lacks ${needle}`);
    }
    const security = await readFile(join(REPO_ROOT, 'docs', 'SECURITY_AND_BOUNDARIES.md'), 'utf8');
    for (const needle of ['unscanned-large-file', 'scan-truncated', 'gcr-output-file', '--allow-large-unscanned', '--staged', 'node scripts/install-git-hooks.mjs', '--no-verify', '4.7 Keeping private data out of Git', 'Intentional gaps', 'zero-width']) {
      assert.ok(security.includes(needle), `SECURITY_AND_BOUNDARIES.md lacks ${needle}`);
    }
    const source = await readFile(join(here, '..', '..', '..', 'src', 'devtools', 'privacy-scan.ts'), 'utf8').catch(() => '');
    if (source !== '') for (const needle of ['unscanned-large-file', 'Known limits', 'FAIL CLOSED']) assert.ok(source.includes(needle), `privacy-scan.ts header lacks ${needle}`);
  });
});
