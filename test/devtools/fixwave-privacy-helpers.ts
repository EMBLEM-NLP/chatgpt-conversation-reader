/**
 * Shared helpers for the `fixwave-privacy-*.test.ts` files: throwaway git repositories (no network, no global
 * configuration, no hooks unless a test installs them), synthetic export generators and secret-shaped strings assembled
 * at run time. It declares no tests (it is not a *.test.ts file), so node:test never runs it on its own.
 *
 * SYNTHETIC DATA ONLY: ids look like 00000000-0000-4000-8000-<12 hex>, texts are invented, and no secret-shaped literal
 * exists in any of these files (the scanner scans its own repository), see `rnd` and `join_`.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Finding } from '../../src/devtools/privacy-scan.js';
import { withTempDir } from '../helpers/tmp.js';

// A hook runner or CI job may export GIT_DIR / GIT_INDEX_FILE; leaking those into the throwaway repositories would aim
// `git add` at the real checkout. Removing them (and the user's git config) makes every repository hermetic.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env['GIT_CONFIG_GLOBAL'] = devNull;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
process.env['GIT_AUTHOR_NAME'] = 'GCR Test';
process.env['GIT_AUTHOR_EMAIL'] = 'test@example.invalid';
process.env['GIT_COMMITTER_NAME'] = 'GCR Test';
process.env['GIT_COMMITTER_EMAIL'] = 'test@example.invalid';

const execFileAsync = promisify(execFile);

export async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return stdout;
}

/** `git init` in `dir`. Hooks are OFF (core.hooksPath=/dev/null) unless `hooks` is true: only the hook tests want them. */
export async function initRepo(dir: string, opts: { hooks?: boolean } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '--template=', '-b', 'main');
  await git(dir, 'config', 'user.name', 'GCR Test');
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  if (opts.hooks !== true) await git(dir, 'config', 'core.hooksPath', devNull);
}

export async function put(dir: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

export async function putAll(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--no-verify', '-m', message);
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}

/** Run a test body inside a fresh, empty, initialised repository (removed afterwards). */
export async function inRepo<T>(fn: (dir: string) => Promise<T>, opts: { hooks?: boolean } = {}): Promise<T> {
  return withTempDir(async (dir) => {
    await initRepo(dir, opts);
    return fn(dir);
  });
}

export const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const B64URL = `${B62}_-`;
export const HEX = '0123456789abcdef';

/** Deterministic pseudo-random string over `alphabet` (LCG); different seeds give unrelated strings. */
export function rnd(length: number, seed: number, alphabet: string = B62): string {
  let s = (seed * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += alphabet[(s >>> 16) % alphabet.length] ?? '';
  }
  return out;
}

export const join_ = (...parts: string[]): string => parts.join('');

export const summarize = (findings: readonly Finding[]): Array<[string, string, number | undefined]> => findings.map((f) => [f.rule, f.path, f.line]);
export const rulesOf = (findings: readonly Finding[]): string[] => findings.map((f) => f.rule);

const syntheticId = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * A synthetic ChatGPT-shaped export WITHOUT the synthetic-fixture marker: an array of conversations whose `mapping` comes
 * before `current_node` and `conversation_id`, as in the real archive layout (so the shape keys are NOT all in the first
 * bytes of a long conversation). Deterministic.
 */
export function chatgptExportText(conversations: number, messagesEach: number, wordsPerMessage = 40): string {
  const all = [];
  for (let c = 0; c < conversations; c++) {
    const mapping: Record<string, unknown> = {};
    let parent: string | null = null;
    for (let m = 0; m < messagesEach; m++) {
      const id = syntheticId(c * 1000 + m + 1);
      mapping[id] = {
        id,
        message: { id, author: { role: m % 2 === 0 ? 'user' : 'assistant' }, create_time: 1_700_000_000 + m, content: { content_type: 'text', parts: [`invented words ${rnd(wordsPerMessage, c * 31 + m, 'abcdefg ')}`] } },
        parent,
        children: [] as string[],
      };
      if (parent !== null) (mapping[parent] as { children: string[] }).children.push(id);
      parent = id;
    }
    all.push({ title: `invented chat ${c}`, create_time: 1_700_000_000, update_time: 1_700_000_100, mapping, moderation_results: [], current_node: parent, conversation_id: syntheticId(c + 1) });
  }
  return JSON.stringify(all);
}

/** Smallest export text that is at least `bytes` long (a few more conversations are generated until it is). */
export function chatgptExportOfAtLeast(bytes: number): string {
  let conversations = Math.max(1, Math.ceil(bytes / 12_000));
  for (;;) {
    const text = chatgptExportText(conversations, 20);
    if (text.length >= bytes) return text;
    conversations *= 2;
  }
}

/** A synthetic Claude-shaped export (no marker). */
export function claudeExportText(conversations: number, messagesEach: number): string {
  const all = [];
  for (let c = 0; c < conversations; c++) {
    const chat_messages = [];
    for (let m = 0; m < messagesEach; m++) {
      chat_messages.push({ uuid: syntheticId(c * 1000 + m + 1), text: `invented words ${rnd(40, c * 17 + m, 'abcdefg ')}`, sender: m % 2 === 0 ? 'human' : 'assistant', created_at: '2026-01-01T00:00:00Z' });
    }
    all.push({ uuid: syntheticId(c + 1), name: `invented chat ${c}`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', chat_messages });
  }
  return JSON.stringify(all);
}
