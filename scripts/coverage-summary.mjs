#!/usr/bin/env node
/**
 * A NON-SENSITIVE coverage summary of the repository's own test suite (CODEX_TASK Phase 3: "Publish a non-sensitive
 * coverage summary"). It runs the compiled tests with Node's built-in coverage, parses the LCOV that Node writes, and prints
 * (or writes to docs/COVERAGE.md) file paths under src/ and percentages. It never includes source text, test names, test
 * output, absolute paths or data from any test.
 *
 *   npm run coverage-summary                       build the tests, run them with coverage, print the summary
 *   node scripts/coverage-summary.mjs --write-doc  also write docs/COVERAGE.md (use --date to label it)
 *
 *   --write-doc         write the markdown to docs/COVERAGE.md instead of printing it (refused when a test failed)
 *   --out <file>        with --write-doc: write to this file instead
 *   --date <text>       date label for the document (default "unknown"; the script never reads the clock)
 *   --json              print the summary as JSON instead of markdown
 *   --dist-test <dir>   directory of the compiled tests (default ./dist-test; run "npm run build:test" first)
 *   --concurrency <n>   value of --test-concurrency (default 2)
 *   --lcov <file>       do NOT run the tests: summarize this LCOV file (used by the unit tests of this script)
 *   --repo <dir>        repository root (default: this repository); its src/ is listed to find files without coverage data
 *
 * How the tests are run: `node --test --test-concurrency=2 --experimental-test-coverage --test-reporter=spec
 * --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=<temp file> "<dist-test>/test/**\/*.test.js"`.
 * The same flags work on Node 22.16.0, 22.21.1 and 22.22.0 (checked); the spec reporter only supplies the test counts, the
 * LCOV file is the coverage data. Child processes started by the tests (the CLI, the MCP server) report into the same data.
 *
 * Paths: the tests run from compiled JavaScript, so the LCOV names `dist-test/src/db/open.js`; the summary shows the
 * source file it came from, `src/db/open.ts`. Everything that is not under src/ (tests, helpers, node_modules) is excluded.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------------------------------------------------------
// LCOV parsing (pure; exported for the unit tests)
// ------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {{ file: string, linesFound: number, linesHit: number, branchesFound: number, branchesHit: number, functionsFound: number, functionsHit: number }} CoverageRecord
 */

/** A non-negative integer from lcov text, or null when it is anything else ("12abc", "-", "", "1e3", a huge number). */
function count(text) {
  if (typeof text !== 'string' || !/^\d{1,12}$/.test(text.trim())) return null;
  return Number(text.trim());
}

/**
 * Parse LCOV text. Never throws: unknown lines are ignored, malformed numbers are skipped, and everything that looked wrong is
 * listed in `problems` (messages carry record numbers, never file contents). A record needs `SF:`; the totals use LF/LH,
 * BRF/BRH and FNF/FNH when present and are counted from DA, BRDA and FN/FNDA lines otherwise. A repeated source file keeps
 * its first record.
 * @param {string} text
 * @returns {{ records: CoverageRecord[], problems: string[] }}
 */
export function parseLcov(text) {
  /** @type {CoverageRecord[]} */
  const records = [];
  const problems = [];
  if (typeof text !== 'string') return { records, problems: ['input is not text'] };
  const seen = new Set();
  let current = null;
  let recordNumber = 0;
  const open = (file) => {
    recordNumber++;
    current = { file, da: new Map(), lf: null, lh: null, brda: new Map(), brf: null, brh: null, fn: new Set(), fnda: new Map(), fnf: null, fnh: null, bad: 0 };
  };
  const close = () => {
    if (current === null) return;
    const c = current;
    current = null;
    if (c.file === '') {
      problems.push(`record ${recordNumber}: empty SF, skipped`);
      return;
    }
    if (seen.has(c.file)) {
      problems.push(`record ${recordNumber}: a second record for an already seen source file was skipped`);
      return;
    }
    seen.add(c.file);
    const linesFound = c.lf ?? c.da.size;
    const linesHit = c.lh ?? [...c.da.values()].filter((n) => n > 0).length;
    const branchesFound = c.brf ?? c.brda.size;
    const branchesHit = c.brh ?? [...c.brda.values()].filter((n) => n > 0).length;
    const functionsFound = c.fnf ?? new Set([...c.fn, ...c.fnda.keys()]).size;
    const functionsHit = c.fnh ?? [...c.fnda.values()].filter((n) => n > 0).length;
    const hits = { linesHit, branchesHit, functionsHit };
    const founds = { linesHit: linesFound, branchesHit: branchesFound, functionsHit: functionsFound };
    const labels = { linesHit: 'lines', branchesHit: 'branches', functionsHit: 'functions' };
    for (const key of Object.keys(hits)) {
      if (hits[key] > founds[key]) {
        problems.push(`record ${recordNumber}: ${labels[key]} hit exceeds found, clamped`);
        hits[key] = founds[key];
      }
    }
    if (c.bad > 0) problems.push(`record ${recordNumber}: ${c.bad} malformed line(s) ignored`);
    records.push({ file: c.file, linesFound, linesHit: hits.linesHit, branchesFound, branchesHit: hits.branchesHit, functionsFound, functionsHit: hits.functionsHit });
  };

  for (const raw of text.split(/\r?\n/)) {
    const colon = raw.indexOf(':');
    const tag = colon < 0 ? raw.trim() : raw.slice(0, colon);
    const value = colon < 0 ? '' : raw.slice(colon + 1);
    if (tag === 'end_of_record') {
      close();
      continue;
    }
    if (tag === 'SF') {
      if (current !== null) {
        problems.push(`record ${recordNumber}: not terminated by end_of_record`);
        close();
      }
      open(value.trim());
      continue;
    }
    if (current === null) continue; // TN:, VER: and anything else outside a record
    const parts = value.split(',');
    switch (tag) {
      case 'DA': {
        const line = count(parts[0]);
        const hits = count(parts[1]);
        if (line === null || hits === null) current.bad++;
        else current.da.set(line, Math.max(current.da.get(line) ?? 0, hits));
        break;
      }
      case 'BRDA': {
        const line = count(parts[0]);
        const block = count(parts[1]);
        const branch = count(parts[2]);
        const taken = parts[3] === '-' ? 0 : count(parts[3]);
        if (line === null || block === null || branch === null || taken === null) current.bad++;
        else current.brda.set(`${line}:${block}:${branch}`, Math.max(current.brda.get(`${line}:${block}:${branch}`) ?? 0, taken));
        break;
      }
      case 'FN': {
        if (count(parts[0]) === null || parts.length < 2) current.bad++;
        else current.fn.add(parts.slice(1).join(','));
        break;
      }
      case 'FNDA': {
        const hits = count(parts[0]);
        if (hits === null || parts.length < 2) current.bad++;
        else {
          const name = parts.slice(1).join(',');
          current.fnda.set(name, Math.max(current.fnda.get(name) ?? 0, hits));
        }
        break;
      }
      case 'LF':
      case 'LH':
      case 'BRF':
      case 'BRH':
      case 'FNF':
      case 'FNH': {
        const n = count(value);
        if (n === null) current.bad++;
        else current[tag.toLowerCase()] = n;
        break;
      }
      default:
        break;
    }
  }
  if (current !== null) {
    problems.push(`record ${recordNumber}: the input ends inside a record (no end_of_record)`);
    close();
  }
  return { records, problems };
}

// ------------------------------------------------------------------------------------------------------------------
// Paths and summaries (pure)
// ------------------------------------------------------------------------------------------------------------------

/**
 * The repo-relative source path a coverage path stands for, or null when the file is not part of src/ (tests, helpers,
 * node_modules, scripts, anything outside the repository). `dist-test*\/src/x.js` and `src/x.js` both mean `src/x.ts`.
 * @param {string} file path as written in the LCOV file (relative to the working directory, or absolute)
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function sourcePathOf(file, repoRoot) {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return null;
  let p = file.startsWith('file://') ? decodeURIComponent(new URL(file).pathname) : file;
  p = p.replaceAll('\\', '/');
  const root = repoRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) {
    if (!p.startsWith(`${root}/`)) return null; // outside the repository
    p = p.slice(root.length + 1);
  }
  p = p.replace(/^\.\//, '');
  const compiled = /^dist-test[^/]*\/(src\/.+)$/.exec(p);
  if (compiled !== null) p = compiled[1];
  if (!p.startsWith('src/') || p.includes('/../') || p.includes('/node_modules/')) return null;
  const ts = p.replace(/\.(?:js|mjs|cjs)$/, '.ts');
  return ts.endsWith('.ts') && !ts.endsWith('.d.ts') ? ts : null;
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Percentage with two decimals, or null when there is nothing to cover. */
export function percent(hit, found) {
  return found === 0 ? null : Math.round((hit / found) * 10_000) / 100;
}

/**
 * @param {CoverageRecord[]} records parsed LCOV records
 * @param {string[]} sourceFiles every src/**\/*.ts file of the repository (repo-relative), for the "no data" list
 * @param {string} repoRoot
 */
export function summarize(records, sourceFiles, repoRoot) {
  const files = new Map();
  let excluded = 0;
  for (const r of records) {
    const path = sourcePathOf(r.file, repoRoot);
    if (path === null) {
      excluded++;
      continue;
    }
    const previous = files.get(path);
    // Two coverage paths can map to one source file (for example dist-test/src/x.js and dist-test-final/src/x.js): keep the more complete one.
    if (previous === undefined || r.linesFound > previous.linesFound) files.set(path, r);
  }
  const rows = [...files.entries()]
    .sort((a, b) => compare(a[0], b[0]))
    .map(([path, r]) => ({
      file: path,
      lines: percent(r.linesHit, r.linesFound),
      branches: percent(r.branchesHit, r.branchesFound),
      functions: percent(r.functionsHit, r.functionsFound),
      linesHit: r.linesHit,
      linesFound: r.linesFound,
      branchesHit: r.branchesHit,
      branchesFound: r.branchesFound,
      functionsHit: r.functionsHit,
      functionsFound: r.functionsFound,
    }));
  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  const totals = {
    lines: { hit: sum('linesHit'), found: sum('linesFound'), percent: percent(sum('linesHit'), sum('linesFound')) },
    branches: { hit: sum('branchesHit'), found: sum('branchesFound'), percent: percent(sum('branchesHit'), sum('branchesFound')) },
    functions: { hit: sum('functionsHit'), found: sum('functionsFound'), percent: percent(sum('functionsHit'), sum('functionsFound')) },
  };
  const covered = new Set(rows.map((r) => r.file));
  const noData = sourceFiles.filter((f) => !covered.has(f)).sort(compare);
  const noExecutableLines = rows.filter((r) => r.linesFound === 0).map((r) => r.file);
  return { files: rows, totals, noData, noExecutableLines, excludedRecords: excluded };
}

const show = (value) => (value === null ? 'n/a' : `${value.toFixed(2)}`);

/**
 * The markdown document. `meta`: { date, node, tests: {tests, pass, fail, skipped} | null, command: string }.
 */
export function renderMarkdown(summary, meta) {
  const t = summary.totals;
  const tests = meta.tests === null ? 'not run by this invocation (an existing LCOV file was summarized)' : `${meta.tests.tests} run: ${meta.tests.pass} pass, ${meta.tests.fail} fail, ${meta.tests.skipped} skipped`;
  const lines = [
    '# GCR test coverage summary',
    '',
    `Generated by \`${meta.command}\` (\`scripts/coverage-summary.mjs\`). Do not edit by hand: re-run the script.`,
    '',
    '> **What this measures.** Statement/line, branch and function coverage of the code under `src/` by this repository\'s own tests, using Node\'s built-in V8 coverage. The tests use SYNTHETIC data only (`fixtures/` and data generated inside the tests). A high number says the code was executed by those tests; it does not say the importer works on a real ChatGPT export, which was never available. Test files, helpers and dependencies are excluded. This page contains file paths and percentages only: no source text, no test names, no test data.',
    '',
    '| Item | Value |',
    '| --- | --- |',
    `| Date | ${meta.date} |`,
    `| Node.js | ${meta.node} |`,
    '| Runner | `node --test --experimental-test-coverage` (built-in), LCOV reporter |',
    `| Tests | ${tests} |`,
    `| Source files with coverage data | ${summary.files.length} |`,
    '',
    '## Totals',
    '',
    '| Metric | Covered | Found | Percent |',
    '| --- | --- | --- | --- |',
    `| Lines | ${t.lines.hit} | ${t.lines.found} | ${show(t.lines.percent)} |`,
    `| Branches | ${t.branches.hit} | ${t.branches.found} | ${show(t.branches.percent)} |`,
    `| Functions | ${t.functions.hit} | ${t.functions.found} | ${show(t.functions.percent)} |`,
    '',
    'Totals are covered/found over all files (not an average of the per-file percentages).',
    '',
    '## Per file',
    '',
    '| File | Lines % | Branches % | Functions % |',
    '| --- | --- | --- | --- |',
    ...summary.files.map((f) => `| \`${f.file}\` | ${show(f.lines)} | ${show(f.branches)} | ${show(f.functions)} |`),
    '',
    '`n/a` means the file has nothing of that kind to cover.',
    '',
    '## Files without coverage data',
    '',
  ];
  if (summary.noData.length === 0) lines.push('None: every file under `src/` appears in the coverage data.');
  else {
    lines.push('Files under `src/` that no test loaded (or that compile to nothing, such as files with only types):', '');
    for (const f of summary.noData) lines.push(`* \`${f}\``);
  }
  if (summary.noExecutableLines.length > 0) {
    lines.push('', 'Files that appear in the data but have no executable lines:', '');
    for (const f of summary.noExecutableLines) lines.push(`* \`${f}\``);
  }
  lines.push('');
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------------------------
// Running the tests
// ------------------------------------------------------------------------------------------------------------------

/** Every src/**\/*.ts file below `repoRoot`, repo-relative with forward slashes (declaration files excluded). */
export function listSourceFiles(repoRoot) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(relative(repoRoot, full).split(sep).join('/'));
    }
  };
  walk(join(repoRoot, 'src'));
  return out.sort(compare);
}

/** Test counts from the tail of the spec reporter's output (the lines "ℹ tests 5771", "ℹ pass 5770", ...), or null. */
export function parseTestCounts(output) {
  const found = {};
  for (const m of output.matchAll(/^[^\w\n]*\s*(tests|pass|fail|cancelled|skipped) (\d+)\s*$/gm)) found[m[1]] = Number(m[2]);
  return typeof found.tests === 'number' && typeof found.pass === 'number' && typeof found.fail === 'number'
    ? { tests: found.tests, pass: found.pass, fail: found.fail + (found.cancelled ?? 0), skipped: found.skipped ?? 0 }
    : null;
}

function runTests({ repoRoot, distTest, concurrency, lcovFile }) {
  return new Promise((resolveRun) => {
    const args = [
      '--test',
      `--test-concurrency=${concurrency}`,
      '--experimental-test-coverage',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      `--test-reporter-destination=${lcovFile}`,
      `${distTest}/test/**/*.test.js`,
    ];
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    // Only the tail matters (the counts); the rest of the spec output is dropped, it can quote test data.
    let tail = '';
    child.stdout.on('data', (d) => {
      tail = (tail + d.toString('utf8')).slice(-512 * 1024);
    });
    child.on('error', () => resolveRun({ code: -1, tail: '' }));
    child.on('close', (code) => resolveRun({ code, tail }));
  });
}

function parseArgs(argv) {
  const opts = { writeDoc: false, out: null, date: 'unknown', json: false, distTest: 'dist-test', concurrency: 2, lcov: null, repo: defaultRepoRoot };
  const need = (i) => {
    if (argv[i + 1] === undefined) {
      process.stderr.write(`coverage-summary: ${argv[i]} needs a value\n`);
      process.exit(2);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write-doc') opts.writeDoc = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = resolve(need(i++));
    else if (a === '--date') {
      opts.date = need(i++);
      if (!/^[A-Za-z0-9 :._+-]{1,40}$/.test(opts.date)) {
        process.stderr.write('coverage-summary: --date needs 1-40 characters from A-Z a-z 0-9 space : . _ + -\n');
        process.exit(2);
      }
    } else if (a === '--dist-test') opts.distTest = need(i++);
    else if (a === '--concurrency') {
      const n = need(i++);
      if (!/^[1-9]\d{0,2}$/.test(n)) {
        process.stderr.write('coverage-summary: --concurrency needs a positive integer\n');
        process.exit(2);
      }
      opts.concurrency = Number(n);
    } else if (a === '--lcov') opts.lcov = resolve(need(i++));
    else if (a === '--repo') opts.repo = resolve(need(i++));
    else {
      process.stderr.write('usage: node scripts/coverage-summary.mjs [--write-doc] [--out <file>] [--date <text>] [--json] [--dist-test <dir>] [--concurrency <n>] [--lcov <file>] [--repo <dir>]\n');
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let lcovText;
  let tests = null;
  let failedTests = false;
  if (opts.lcov !== null) {
    if (!existsSync(opts.lcov)) {
      process.stderr.write('coverage-summary: the --lcov file does not exist\n');
      process.exit(2);
    }
    lcovText = readFileSync(opts.lcov, 'utf8');
  } else {
    if (!existsSync(join(opts.repo, opts.distTest, 'test'))) {
      process.stderr.write(`coverage-summary: ${opts.distTest}/test not found (run "npm run build:test" first, or use "npm run coverage-summary").\n`);
      process.exit(2);
    }
    const work = mkdtempSync(join(tmpdir(), 'gcr-coverage-'));
    const lcovFile = join(work, 'coverage.lcov');
    try {
      process.stderr.write(`coverage-summary: running the compiled tests with coverage on Node ${process.version} (this takes a while)\n`);
      const run = await runTests({ repoRoot: opts.repo, distTest: opts.distTest, concurrency: opts.concurrency, lcovFile });
      tests = parseTestCounts(run.tail);
      failedTests = run.code !== 0 || (tests !== null && tests.fail > 0);
      if (!existsSync(lcovFile)) {
        process.stderr.write(`coverage-summary: the test run produced no coverage file (exit ${run.code}).\n`);
        process.exit(1);
      }
      lcovText = readFileSync(lcovFile, 'utf8');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const { records, problems } = parseLcov(lcovText);
  const summary = summarize(records, listSourceFiles(opts.repo), opts.repo);
  for (const p of problems) process.stderr.write(`coverage-summary: ${p}\n`);
  if (summary.files.length === 0) {
    process.stderr.write('coverage-summary: no coverage data for any file under src/ (is the LCOV file empty, or were the tests compiled elsewhere?).\n');
    process.exit(1);
  }
  const meta = { date: opts.date, node: process.version, tests, command: `npm run coverage-summary${opts.writeDoc ? ' -- --write-doc' : ''}${opts.date === 'unknown' ? '' : ` --date ${opts.date}`}` };
  if (opts.json) process.stdout.write(`${JSON.stringify({ node: process.version, date: opts.date, tests, problems, ...summary }, null, 2)}\n`);
  else if (opts.writeDoc) {
    if (failedTests) {
      process.stderr.write('coverage-summary: not writing the document because the test run failed (coverage of a failing run would be misleading).\n');
      process.exit(1);
    }
    const target = opts.out ?? join(opts.repo, 'docs', 'COVERAGE.md');
    writeFileSync(target, renderMarkdown(summary, meta));
    process.stderr.write(`coverage-summary: wrote ${target.split(/[\\/]/).pop()}\n`);
  } else process.stdout.write(renderMarkdown(summary, meta));
  if (failedTests) {
    process.stderr.write('coverage-summary: the test run FAILED; the numbers above come from a failing run.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
