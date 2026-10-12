#!/usr/bin/env node
// Opt-in installer for the GCR privacy git hooks (scripts/git-hooks/pre-commit and pre-push).
//
//   node scripts/install-git-hooks.mjs              install both hooks into this repository's .git/hooks
//   node scripts/install-git-hooks.mjs --force      also replace a hook that was NOT installed by this script (kept as *.pre-gcr-backup)
//   node scripts/install-git-hooks.mjs --uninstall  remove the hooks this script installed (hooks of any other origin are left alone)
//
// What it does NOT do: it sets no git configuration (nothing global, nothing local), it installs nothing unless you run it,
// and it never overwrites a hook it did not write unless --force is given. If core.hooksPath is set, git ignores
// .git/hooks altogether, so the script stops and says so instead of reporting a success that would protect nothing.
//
// The hooks are COPIED (not linked) so they keep working on a branch that lacks scripts/git-hooks/; re-run the installer
// after the originals change. They need Node.js on PATH and a built scanner (`npm run build`), and they fail closed otherwise.
// A commit can still be made knowingly with `git commit --no-verify`; the hooks print why that is a bad idea.
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = ['pre-commit', 'pre-push'];
/** Present near the top of every hook file this script installs; how a file is recognised as "ours" later. */
const MARKER = 'gcr-privacy-hook';
const USAGE = [
  'Usage: node scripts/install-git-hooks.mjs [--force] [--uninstall]',
  '',
  '  (no flag)     install pre-commit (staged-content scan) and pre-push (work-tree scan) into this repository',
  '  --force       replace a hook that was not installed by this script; the old file is kept as <hook>.pre-gcr-backup',
  '  --uninstall   remove the hooks this script installed; other hooks are left alone',
  '',
  'Nothing is installed unless you run this script. No git configuration is changed.',
  '',
].join('\n');

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);

function parseArgs(argv) {
  const args = { force: false, uninstall: false, help: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
    else if (arg === '--uninstall') args.uninstall = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else return { error: `unknown argument: ${arg.replace(/[^\x20-\x7e]/g, '?').slice(0, 60)}` };
  }
  return args;
}

/** Environment for git children: repository-location variables are dropped so an enclosing git process cannot redirect them. */
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

async function describeTarget(target) {
  let st;
  try {
    st = await lstat(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { kind: 'missing' };
    throw e;
  }
  // A symlink is never written through (it could point anywhere) and is never "ours".
  if (st.isSymbolicLink() || !st.isFile()) return { kind: 'foreign' };
  const text = await readFile(target, 'utf8');
  return { kind: text.includes(MARKER) ? 'ours' : 'foreign', text };
}

async function uniqueBackupName(target) {
  for (let n = 0; n < 1000; n++) {
    const candidate = `${target}.pre-gcr-backup${n === 0 ? '' : `.${n}`}`;
    try {
      await lstat(candidate);
    } catch (e) {
      if (e && e.code === 'ENOENT') return candidate;
      throw e;
    }
  }
  throw new Error('too many backups');
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    err(`install-git-hooks: ${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptsDir, '..');
  let hooksDir;
  try {
    const top = git(repoRoot, ['rev-parse', '--show-toplevel']);
    if ((await realpath(top)) !== (await realpath(repoRoot))) throw new Error('not the top level');
    // `--git-path hooks` already follows core.hooksPath, which is why that setting is checked separately below.
    let hooksPath = '';
    try {
      hooksPath = git(repoRoot, ['config', '--get', 'core.hooksPath']);
    } catch {
      hooksPath = ''; // exit status 1 = not set
    }
    if (hooksPath !== '') {
      err('install-git-hooks: core.hooksPath is set for this repository, so git does not run hooks from .git/hooks and nothing was installed.');
      err('  `git config --show-origin --get core.hooksPath` says where it is set (this repository, your global configuration or a work-tool template).');
      err('  Either unset it where it is set, or copy scripts/git-hooks/pre-commit and pre-push into that directory yourself.');
      return 2;
    }
    hooksDir = resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-path', 'hooks']));
  } catch {
    err('install-git-hooks: this script must live in scripts/ of the top level of a git work tree, and git must be available.');
    return 2;
  }
  const show = (p) => relative(repoRoot, p) || p;

  if (args.uninstall) {
    for (const name of HOOKS) {
      const target = join(hooksDir, name);
      const state = await describeTarget(target);
      if (state.kind === 'missing') out(`not installed: ${name}`);
      else if (state.kind === 'ours') {
        await unlink(target);
        out(`removed: ${show(target)}`);
      } else out(`kept: ${show(target)} was not installed by this script`);
    }
    return 0;
  }

  // Read the originals first and check all targets before touching any, so a refusal leaves the repository exactly as it was.
  const plan = [];
  for (const name of HOOKS) {
    const source = join(scriptsDir, 'git-hooks', name);
    let content;
    try {
      // The copy is always an LF script: a checkout with core.autocrlf (Windows) turns the originals into CRLF files, and `#!/bin/sh\r`
      // does not run. Git hooks are executed by sh, never by the editor that wrote them, so LF is the only correct ending.
      content = (await readFile(source, 'utf8')).replace(/\r\n?/g, '\n');
    } catch {
      err(`install-git-hooks: cannot read ${show(source)}; nothing was installed.`);
      return 2;
    }
    if (!content.includes(MARKER)) {
      err(`install-git-hooks: ${show(source)} does not carry the ${MARKER} marker; nothing was installed.`);
      return 2;
    }
    const target = join(hooksDir, name);
    plan.push({ name, content, target, state: await describeTarget(target) });
  }
  const refused = plan.filter((p) => p.state.kind === 'foreign' && !args.force);
  if (refused.length > 0) {
    for (const p of refused) err(`refused: ${show(p.target)} exists and was not installed by this script; it was left untouched.`);
    err('  Re-run with --force to replace it (the old file is kept as <hook>.pre-gcr-backup), or merge the hook by hand. Nothing was installed.');
    return 1;
  }

  await mkdir(hooksDir, { recursive: true });
  for (const p of plan) {
    if (p.state.kind === 'ours' && p.state.text === p.content) {
      await chmod(p.target, 0o755);
      out(`unchanged: ${show(p.target)} is already up to date`);
      continue;
    }
    let verb = 'installed';
    if (p.state.kind === 'foreign') {
      const backup = await uniqueBackupName(p.target);
      await rename(p.target, backup);
      out(`backed up: ${show(p.target)} -> ${show(backup)}`);
    } else if (p.state.kind === 'ours') {
      await unlink(p.target);
      verb = 'updated';
    }
    // 'wx': never follow or replace anything that appeared since the check above.
    await writeFile(p.target, p.content, { mode: 0o755, flag: 'wx' });
    await chmod(p.target, 0o755);
    out(`${verb}: ${show(p.target)}`);
  }
  out('The hooks run `node scripts/privacy-scan.mjs` (build it first with `npm run build`). Bypass knowingly with `git commit --no-verify` / `git push --no-verify`; the hook messages explain why not to.');
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((e) => {
  err(`install-git-hooks: failed (${e && e.code ? e.code : 'error'})`);
  return 2;
});
