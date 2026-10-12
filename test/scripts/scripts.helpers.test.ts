/**
 * Shared helpers for the tests of scripts/ (the network guard, the CI smoke, the performance baseline, the coverage
 * summary). Named *.test.ts only because test ownership is limited to test/scripts/*.test.ts; it declares NO tests of its
 * own (node:test treats a file without tests as an empty, passing file).
 *
 * The scripts run against the BUILT product, so these tests never depend on a pre-existing dist/: `buildProduct()`
 * compiles src/ with tsconfig.build.json into a temp directory (once per test process) and lays it out so that the bare
 * imports of the compiled files (zod, the MCP SDK) resolve: `<root>/package.json` {"type":"module"},
 * `<root>/node_modules` -> the repository's node_modules, `<root>/dist` = the compiled product. Sabotaged copies of that
 * layout are what the "the smoke goes red" tests run against.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compiled tests live at <root>/<outDir>/test/scripts, whatever the out dir is called. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
export const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');
export const GUARD = join(SCRIPTS_DIR, 'no-network-guard.cjs');
export const SMOKE = join(SCRIPTS_DIR, 'ci-smoke.mjs');
export const PERF = join(SCRIPTS_DIR, 'perf-baseline.mjs');
export const COVERAGE = join(SCRIPTS_DIR, 'coverage-summary.mjs');

/**
 * What a generated document must not tell a reader about the machine that produced it. Paths (home, temp, the checkout, the
 * working directory) are leaks wherever they occur. A USER or HOST name is only a leak in the shapes in which it identifies a
 * machine (a path component such as `/home/<name>/`, or `<name>@host` / `user@<name>`): on CI images the account is called
 * `runner`, `node`, `nobody`, `user`, `build` and the like, and those are ordinary words that the prose of a document may use
 * (a test that searched for the bare name failed on the first GitHub-hosted run it would have had). Returns labels, never the
 * leaked values themselves, so a failure message does not repeat them.
 */
export function machineLeaks(text: string, paths: readonly string[], names: readonly string[]): string[] {
  const found: string[] = [];
  paths.forEach((p, i) => {
    if (p.length >= 4 && p !== '/' && text.includes(p)) found.push(`path #${i}`);
  });
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  names.forEach((n, i) => {
    if (n.length < 2) return;
    const e = escape(n);
    const shaped = new RegExp(`[/\\\\]${e}(?![A-Za-z0-9_.-])|(?<![A-Za-z0-9_.-])${e}@[A-Za-z0-9]|[A-Za-z0-9]@${e}(?![A-Za-z0-9_-])`);
    if (shaped.test(text)) found.push(`name #${i}`);
  });
  return found;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  /** The COMPLETE environment of the child (nothing is inherited unless it is listed here). */
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly timeoutMs?: number;
  /** Node binary to use. Default: the one running the tests. */
  readonly node?: string;
}

/** The smallest environment a Node child needs. Tests add what they exercise. */
export function baseEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', ...extra };
}

/** Run `node ...args`; never rejects. The default timeout is generous: the sandbox is shared with other processes. */
export function runNode(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.node ?? process.execPath, [...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...(opts.env ?? baseEnv()) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, timedOut, stdout: '', stderr: 'spawn failed' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(opts.input ?? '');
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The built product in a temp directory
// ---------------------------------------------------------------------------------------------------------------

export interface ProductBuild {
  /** Directory that holds package.json, node_modules (link) and dist/. */
  readonly root: string;
  /** The compiled product: cli/main.js, mcp/entry.js, sdk/gcr.js ... */
  readonly dist: string;
}

/** Lay out `<root>/{package.json,node_modules,dist}` around an existing compiled directory. */
function layout(root: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gcr-scripts-test-build', private: true, type: 'module' }));
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
}

let building: Promise<ProductBuild> | undefined;
const created: string[] = [];

/** Compile src/ once per process with the production tsconfig. tsc may report errors of concurrent edits; the output is still emitted. */
export function buildProduct(): Promise<ProductBuild> {
  building ??= (async () => {
    const root = makeTempDir('gcr-scripts-build-');
    created.push(root);
    layout(root);
    const dist = join(root, 'dist');
    const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');
    const r = await runNode([tsc, '-p', 'tsconfig.build.json', '--outDir', dist], { cwd: REPO_ROOT, timeoutMs: 240_000 });
    assert.ok(existsSync(join(dist, 'cli', 'main.js')) && existsSync(join(dist, 'mcp', 'entry.js')), `tsc did not emit the CLI and the MCP entry (exit ${r.code})`);
    return { root, dist };
  })();
  return building;
}

/** A private copy of the build (own node_modules link) for a test that mutates files. `mutate` gets the copy's dist directory. */
export async function sabotagedCopy(mutate: (dist: string) => void): Promise<ProductBuild> {
  const base = await buildProduct();
  const root = makeTempDir('gcr-scripts-sabotage-');
  created.push(root);
  layout(root);
  const dist = join(root, 'dist');
  cpSync(base.dist, dist, { recursive: true });
  mutate(dist);
  return { root, dist };
}

/** Replace `from` by `to` in a file of the copy; fails loudly when the anchor is gone, so a refactor cannot turn a sabotage test into a no-op. */
export function replaceInFile(file: string, from: string, to: string): void {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `sabotage anchor not found in ${file.split('/').slice(-2).join('/')}`);
  writeFileSync(file, text.replace(from, () => to));
}

export function appendToFile(file: string, code: string): void {
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n${code}\n`);
}

/** Remove every temp directory this process created. Call from `after()`. */
export function cleanupBuilds(): void {
  for (const dir of created.splice(0)) removeDir(dir);
  building = undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the smoke output
// ---------------------------------------------------------------------------------------------------------------

export interface SmokeReport {
  readonly passes: string[];
  readonly failures: Array<{ name: string; reason: string }>;
  readonly lastLine: string;
  readonly otherLines: string[];
}

/** Split the smoke's stdout into PASS lines, FAIL lines (name: reason) and anything else. */
export function parseSmoke(stdout: string): SmokeReport {
  const lines = stdout.split('\n').filter((l) => l !== '');
  const passes: string[] = [];
  const failures: Array<{ name: string; reason: string }> = [];
  const otherLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('PASS ')) passes.push(line.slice(5));
    else if (line.startsWith('FAIL ')) {
      // "FAIL <name>: <reason>". Check names contain exactly one ": " (the smoke enforces it); a reason may contain more.
      const body = line.slice(5);
      const first = body.indexOf(': ');
      const second = first < 0 ? -1 : body.indexOf(': ', first + 2);
      failures.push(second < 0 ? { name: body, reason: '' } : { name: body.slice(0, second), reason: body.slice(second + 2) });
    } else otherLines.push(line);
  }
  return { passes, failures, lastLine: lines[lines.length - 1] ?? '', otherLines };
}

// ---------------------------------------------------------------------------------------------------------------
// Running the smoke on a sabotaged copy of the product
// ---------------------------------------------------------------------------------------------------------------

export interface SmokeOutcome {
  readonly code: number | null;
  /** stdout and stderr of the smoke, for "does not leak" assertions. */
  readonly everything: string;
  readonly report: SmokeReport;
}

/** Sabotage a copy of the product with `mutate`, run the WHOLE smoke on it (about 15 s idle), return what it printed. */
export async function smokeOnSabotaged(mutate: (dist: string) => void): Promise<SmokeOutcome> {
  const build = await sabotagedCopy(mutate);
  const tmpRoot = makeTempDir('gcr-smoke-sabotage-');
  created.push(tmpRoot);
  const smokeTmp = join(tmpRoot, 'tmp');
  mkdirSync(smokeTmp);
  const r = await runNode([SMOKE, '--dist', build.dist], { cwd: REPO_ROOT, env: baseEnv({ TMPDIR: smokeTmp }), timeoutMs: 290_000 });
  assert.equal(r.timedOut, false, 'the smoke timed out');
  return { code: r.code, everything: r.stdout + r.stderr, report: parseSmoke(r.stdout) };
}

/** The common shape of a red smoke: exit 1, the closing line says FAILED, no canary text, no absolute paths. */
export function assertRed(o: SmokeOutcome): void {
  assert.equal(o.code, 1);
  assert.match(o.report.lastLine, /^SMOKE FAILED \(\d+ of \d+ checks failed\)$/);
  assert.ok(!o.everything.includes('SMOKE OK'));
  assert.ok(!/GCR-CANARY-[0-9a-f]{16}/.test(o.everything), 'the FAIL lines must not repeat the canary');
  assert.ok(!/\/tmp\b|\/home\/|gcr-smoke-/.test(o.everything), 'the FAIL lines must not contain paths');
}

/** The FAIL line whose check name starts with `namePrefix` (the assertion fails with the list of failures when there is none). */
export function failureOf(o: SmokeOutcome, namePrefix: string): { name: string; reason: string } {
  const found = o.report.failures.find((f) => f.name.startsWith(namePrefix));
  assert.ok(found, `no FAIL line starts with "${namePrefix}". Failures: ${o.report.failures.map((f) => f.name.slice(0, 40)).join(' | ')}`);
  return found;
}

export const hasPassed = (o: SmokeOutcome, namePrefix: string): boolean => o.report.passes.some((p) => p.startsWith(namePrefix));
