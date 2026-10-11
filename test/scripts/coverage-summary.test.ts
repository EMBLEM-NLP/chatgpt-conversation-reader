/**
 * scripts/coverage-summary.mjs: the LCOV parser and the summary on canned input (including malformed input), and the real
 * runner (`node --test --experimental-test-coverage` with the LCOV reporter) on a tiny throw-away project. The full suite is
 * NOT run here: the script's own job is exercised on a project of one test.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { COVERAGE, REPO_ROOT, baseEnv, makeTempDir, removeDir, runNode } from './scripts.helpers.test.js';

interface CoverageRecord {
  file: string;
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
  functionsFound: number;
  functionsHit: number;
}
interface FileRow {
  file: string;
  lines: number | null;
  branches: number | null;
  functions: number | null;
}
interface Totals {
  lines: { hit: number; found: number; percent: number | null };
  branches: { hit: number; found: number; percent: number | null };
  functions: { hit: number; found: number; percent: number | null };
}
interface Summary {
  files: FileRow[];
  totals: Totals;
  noData: string[];
  noExecutableLines: string[];
  excludedRecords: number;
}
interface TestCounts {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
}
interface CoverageModule {
  parseLcov(text: unknown): { records: CoverageRecord[]; problems: string[] };
  sourcePathOf(file: unknown, repoRoot: string): string | null;
  percent(hit: number, found: number): number | null;
  summarize(records: CoverageRecord[], sourceFiles: string[], repoRoot: string): Summary;
  renderMarkdown(summary: Summary, meta: { date: string; node: string; tests: TestCounts | null; command: string }): string;
  parseTestCounts(output: string): TestCounts | null;
  listSourceFiles(repoRoot: string): string[];
}

let mod: CoverageModule;
let dir = '';

before(async () => {
  const loaded: unknown = await import(pathToFileURL(COVERAGE).href);
  mod = loaded as CoverageModule;
  dir = makeTempDir('gcr-coverage-test-');
});
after(() => {
  removeDir(dir);
});

const record = (file: string, over: Partial<CoverageRecord> = {}): CoverageRecord => ({
  file,
  linesFound: 10,
  linesHit: 5,
  branchesFound: 4,
  branchesHit: 2,
  functionsFound: 2,
  functionsHit: 1,
  ...over,
});

const CANNED = [
  'TN:',
  'SF:dist-test/src/errors.js',
  'FN:1,a',
  'FN:5,b',
  'FNDA:3,a',
  'FNDA:0,b',
  'FNF:2',
  'FNH:1',
  'BRDA:1,0,0,1',
  'BRDA:1,1,0,0',
  'BRF:2',
  'BRH:1',
  'DA:1,1',
  'DA:2,0',
  'DA:3,4',
  'LH:2',
  'LF:3',
  'end_of_record',
  'SF:dist-test/test/errors.test.js',
  'DA:1,1',
  'LF:1',
  'LH:1',
  'end_of_record',
  '',
].join('\n');

describe('parseLcov', () => {
  it('reads the totals of a record (LF/LH, BRF/BRH, FNF/FNH) and ignores TN', () => {
    const { records, problems } = mod.parseLcov(CANNED);
    assert.deepEqual(problems, []);
    assert.deepEqual(records[0], {
      file: 'dist-test/src/errors.js',
      linesFound: 3,
      linesHit: 2,
      branchesFound: 2,
      branchesHit: 1,
      functionsFound: 2,
      functionsHit: 1,
    });
    assert.equal(records.length, 2);
  });

  it('counts from DA, BRDA, FN and FNDA when the summary lines are missing (a "-" branch counts as not taken)', () => {
    const { records, problems } = mod.parseLcov(['SF:src/a.js', 'DA:1,3', 'DA:2,0', 'DA:2,5', 'BRDA:1,0,0,2', 'BRDA:1,0,1,-', 'BRDA:2,0,0,0', 'FN:1,f', 'FN:9,g', 'FNDA:4,f', 'end_of_record'].join('\n'));
    assert.deepEqual(problems, []);
    // the repeated DA line takes the larger count (a line can be reported by several sources)
    assert.deepEqual(records[0], { file: 'src/a.js', linesFound: 2, linesHit: 2, branchesFound: 3, branchesHit: 1, functionsFound: 2, functionsHit: 1 });
  });

  it('accepts CRLF line endings, surrounding spaces and a name with commas in FN/FNDA', () => {
    const { records, problems } = mod.parseLcov('SF: src/a.js \r\nFN:1,a,b\r\nFNDA:2,a,b\r\nDA:1,1\r\nend_of_record\r\n');
    assert.deepEqual(problems, []);
    assert.equal(records[0]?.file, 'src/a.js');
    assert.equal(records[0]?.functionsFound, 1);
    assert.equal(records[0]?.functionsHit, 1);
  });

  it('is total: empty text, non-text, binary garbage and text without records give no records and no exception', () => {
    assert.deepEqual(mod.parseLcov(''), { records: [], problems: [] });
    assert.deepEqual(mod.parseLcov('\n\n\n'), { records: [], problems: [] });
    assert.equal(mod.parseLcov(undefined).records.length, 0);
    assert.equal(mod.parseLcov(42).records.length, 0);
    assert.equal(mod.parseLcov(null).problems.length, 1);
    assert.equal(mod.parseLcov('\u0000\u0001� garbage: with colons: here\nDA:1,1\nend_of_record').records.length, 0);
    assert.equal(mod.parseLcov('lorem ipsum '.repeat(100_000)).records.length, 0);
  });

  it('reports a record without end_of_record (at the end and before the next SF) and still keeps it', () => {
    const atEnd = mod.parseLcov('SF:src/a.js\nDA:1,1\nLF:1\nLH:1');
    assert.equal(atEnd.records.length, 1);
    assert.match(atEnd.problems.join('|'), /ends inside a record/);
    const between = mod.parseLcov('SF:src/a.js\nDA:1,1\nSF:src/b.js\nDA:1,0\nend_of_record');
    assert.deepEqual(between.records.map((r) => r.file), ['src/a.js', 'src/b.js']);
    assert.match(between.problems.join('|'), /not terminated by end_of_record/);
  });

  it('skips an empty SF and a repeated source file (the first wins) and says so', () => {
    const { records, problems } = mod.parseLcov(['SF:', 'DA:1,1', 'end_of_record', 'SF:src/a.js', 'DA:1,1', 'end_of_record', 'SF:src/a.js', 'DA:1,0', 'DA:2,0', 'end_of_record'].join('\n'));
    assert.deepEqual(records.map((r) => [r.file, r.linesFound]), [['src/a.js', 1]]);
    assert.equal(problems.length, 2);
    assert.match(problems[0] ?? '', /empty SF/);
    assert.match(problems[1] ?? '', /second record/);
  });

  it('ignores malformed numbers (letters, negatives, floats, exponents, empty, huge) and counts them, without NaN anywhere', () => {
    const { records, problems } = mod.parseLcov(
      ['SF:src/a.js', 'DA:1,1', 'DA:x,1', 'DA:2,-1', 'DA:3,1.5', 'DA:4,1e3', 'DA:5,', 'DA:6', 'DA:7,99999999999999999999', 'LF:abc', 'BRDA:1,2,3,four', 'FNDA:oops,f', 'FN:zz,f', 'end_of_record'].join('\n'),
    );
    assert.equal(records.length, 1);
    const r = records[0] as CoverageRecord;
    for (const value of [r.linesFound, r.linesHit, r.branchesFound, r.branchesHit, r.functionsFound, r.functionsHit]) assert.ok(Number.isInteger(value) && value >= 0, 'finite counts only');
    assert.equal(r.linesFound, 1, 'only the well-formed DA line counts (LF:abc was ignored)');
    assert.match(problems.join('|'), /11 malformed line\(s\) ignored/);
  });

  it('clamps a hit count above the found count and reports it', () => {
    const { records, problems } = mod.parseLcov('SF:src/a.js\nLF:2\nLH:5\nBRF:1\nBRH:1\nFNF:1\nFNH:1\nend_of_record');
    assert.equal(records[0]?.linesHit, 2);
    assert.match(problems.join('|'), /lines hit exceeds found, clamped/);
  });

  it('survives hostile file names such as __proto__ and constructor', () => {
    const { records } = mod.parseLcov('SF:__proto__\nDA:1,1\nend_of_record\nSF:constructor\nDA:1,1\nend_of_record\nSF:src/toString.js\nDA:1,1\nend_of_record');
    assert.deepEqual(records.map((r) => r.file), ['__proto__', 'constructor', 'src/toString.js']);
    assert.equal(({} as Record<string, unknown>)['linesFound'], undefined, 'Object.prototype is untouched');
  });
});

describe('sourcePathOf: which coverage paths are source files', () => {
  const root = '/work/repo';
  const cases: Array<[string, string | null]> = [
    ['dist-test/src/db/open.js', 'src/db/open.ts'],
    ['dist-test-final/src/db/open.js', 'src/db/open.ts'],
    ['dist-test-n2216/src/cli/main.js', 'src/cli/main.ts'],
    ['./dist-test/src/a.js', 'src/a.ts'],
    ['src/a.js', 'src/a.ts'],
    ['src/a.ts', 'src/a.ts'],
    ['/work/repo/dist-test/src/a.js', 'src/a.ts'],
    ['file:///work/repo/dist-test/src/a.js', 'src/a.ts'],
    ['dist-test\\src\\a.js', 'src/a.ts'],
    ['dist-test/test/a.test.js', null],
    ['dist-test/test/helpers/zip-builder.js', null],
    ['test/a.test.ts', null],
    ['dist/cli/main.js', null],
    ['scripts/ci-smoke.mjs', null],
    ['node_modules/zod/index.js', null],
    ['src/node_modules/x/index.js', null],
    ['/elsewhere/dist-test/src/a.js', null],
    ['/tmp/gcr-scripts-build-abc/dist/cli/main.js', null],
    ['dist-test/src/types.d.ts', null],
    ['dist-test/src/../test/a.js', null],
    ['dist-test/src/data.json', null],
    ['', null],
    ['dist-test/src/a\u0000.js', null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected === null ? 'excluded' : expected}`, () => {
      assert.equal(mod.sourcePathOf(input, root), expected);
    });
  }
  it('non-string input is excluded', () => {
    assert.equal(mod.sourcePathOf(undefined, root), null);
    assert.equal(mod.sourcePathOf(7, root), null);
  });
});

describe('summarize and renderMarkdown', () => {
  const sources = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/z/types.ts'];
  const summary = (): Summary =>
    mod.summarize(
      [
        record('dist-test/src/b.js', { linesFound: 10, linesHit: 10, branchesFound: 0, branchesHit: 0 }),
        record('dist-test/src/a.js', { linesFound: 30, linesHit: 15 }),
        record('dist-test/test/a.test.js'),
        record('dist-test/test/helpers/x.js'),
        record('/somewhere/else.js'),
        record('dist-test/src/z/types.js', { linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0, functionsFound: 0, functionsHit: 0 }),
      ],
      sources,
      '/work/repo',
    );

  it('lists only src files, sorted, with percentages (n/a where there is nothing to cover)', () => {
    const s = summary();
    assert.deepEqual(s.files.map((f) => f.file), ['src/a.ts', 'src/b.ts', 'src/z/types.ts']);
    assert.deepEqual([s.files[0]?.lines, s.files[0]?.branches, s.files[0]?.functions], [50, 50, 50]);
    assert.deepEqual([s.files[1]?.lines, s.files[1]?.functions], [100, 50]);
    assert.equal(s.files[1]?.branches, null);
    assert.equal(s.excludedRecords, 3);
  });

  it('totals are covered/found over all files, not an average of percentages', () => {
    const t = summary().totals;
    assert.deepEqual(t.lines, { hit: 25, found: 40, percent: 62.5 });
    assert.deepEqual(t.branches, { hit: 2, found: 4, percent: 50 });
    assert.deepEqual(t.functions, { hit: 2, found: 4, percent: 50 });
  });

  it('lists the source files that have no coverage data, and files with no executable lines', () => {
    const s = summary();
    assert.deepEqual(s.noData, ['src/c.ts']);
    assert.deepEqual(s.noExecutableLines, ['src/z/types.ts']);
  });

  it('keeps the more complete record when two coverage paths map to one source file', () => {
    const s = mod.summarize([record('dist-test/src/a.js', { linesFound: 3, linesHit: 3 }), record('dist-test-final/src/a.js', { linesFound: 9, linesHit: 1 })], [], '/work/repo');
    assert.equal(s.files.length, 1);
    assert.equal(s.files[0]?.lines, 11.11);
  });

  it('an empty record set gives empty, well-formed totals', () => {
    const s = mod.summarize([], ['src/a.ts'], '/work/repo');
    assert.deepEqual(s.files, []);
    assert.equal(s.totals.lines.percent, null);
    assert.deepEqual(s.noData, ['src/a.ts']);
  });

  it('percent(): two decimals, null when nothing is found, never NaN or above 100', () => {
    assert.equal(mod.percent(1, 3), 33.33);
    assert.equal(mod.percent(2, 3), 66.67);
    assert.equal(mod.percent(0, 0), null);
    assert.equal(mod.percent(5, 5), 100);
  });

  it('the markdown states the Node version, the date, SYNTHETIC data only, and holds paths and percentages only', () => {
    const md = mod.renderMarkdown(summary(), { date: '2026-01-31', node: 'v22.16.0', tests: { tests: 10, pass: 9, fail: 0, skipped: 1 }, command: 'npm run coverage-summary' });
    assert.match(md, /^# GCR test coverage summary/);
    assert.match(md, /\| Node\.js \| v22\.16\.0 \|/);
    assert.match(md, /\| Date \| 2026-01-31 \|/);
    assert.match(md, /SYNTHETIC data only/);
    assert.match(md, /\| Tests \| 10 run: 9 pass, 0 fail, 1 skipped \|/);
    assert.match(md, /\| `src\/a\.ts` \| 50\.00 \| 50\.00 \| 50\.00 \|/);
    assert.match(md, /\| `src\/b\.ts` \| 100\.00 \| n\/a \| 50\.00 \|/);
    assert.match(md, /\* `src\/c\.ts`/);
    assert.ok(!md.includes('/work/repo'), 'no repository path');
    assert.ok(!md.includes('dist-test'), 'no compiled-test path');
    assert.ok(!/\.test\.js|helpers\//.test(md), 'no test file');
  });

  it('is deterministic: the same input renders the same text', () => {
    const meta = { date: 'unknown', node: 'v22.22.0', tests: null, command: 'npm run coverage-summary' };
    assert.equal(mod.renderMarkdown(summary(), meta), mod.renderMarkdown(summary(), meta));
    assert.match(mod.renderMarkdown(summary(), meta), /not run by this invocation/);
  });
});

describe('parseTestCounts', () => {
  const tail = ['ℹ tests 5771', 'ℹ suites 812', 'ℹ pass 5770', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0', 'ℹ duration_ms 123456.7', 'ℹ start of coverage report'].join('\n');
  it('reads the counts from the spec reporter summary', () => {
    assert.deepEqual(mod.parseTestCounts(tail), { tests: 5771, pass: 5770, fail: 0, skipped: 1 });
  });
  it('counts cancelled tests as failures', () => {
    assert.deepEqual(mod.parseTestCounts(tail.replace('cancelled 0', 'cancelled 2').replace('fail 0', 'fail 1')), { tests: 5771, pass: 5770, fail: 3, skipped: 1 });
  });
  it('returns null when the summary is missing or garbled', () => {
    assert.equal(mod.parseTestCounts(''), null);
    assert.equal(mod.parseTestCounts('ℹ tests many'), null);
    assert.equal(mod.parseTestCounts('hello world'), null);
  });
});

describe('the script on the command line', () => {
  const run = (args: string[]): ReturnType<typeof runNode> => runNode([COVERAGE, ...args], { cwd: dir, env: baseEnv(), timeoutMs: 120_000 });

  it('--lcov: markdown on stdout, a JSON form, and a document written with --write-doc --out', async () => {
    const lcov = join(dir, 'canned.lcov');
    writeFileSync(lcov, CANNED);
    const md = await run(['--lcov', lcov, '--date', '2026-01-31']);
    assert.equal(md.code, 0);
    assert.match(md.stdout, /\| `src\/errors\.ts` \| 66\.67 \| 50\.00 \| 50\.00 \|/);
    assert.match(md.stdout, /\| Date \| 2026-01-31 \|/);
    assert.match(md.stdout, /Generated by `npm run coverage-summary -- --date 2026-01-31`/);
    assert.equal(md.stderr, '');

    const json = await run(['--lcov', lcov, '--json', '--repo', REPO_ROOT]);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.stdout) as { files: FileRow[]; noData: string[]; node: string };
    assert.deepEqual(parsed.files.map((f) => f.file), ['src/errors.ts']);
    assert.ok(parsed.noData.includes('src/cli/main.ts'), 'files without data are found by listing the real src/');
    assert.equal(parsed.node, process.version);

    const out = join(dir, 'COVERAGE.md');
    const written = await run(['--lcov', lcov, '--write-doc', '--out', out, '--date', 'x']);
    assert.equal(written.code, 0);
    assert.equal(written.stdout, '');
    assert.match(readFileSync(out, 'utf8'), /^# GCR test coverage summary/);
    assert.match(readFileSync(out, 'utf8'), /Generated by `npm run coverage-summary -- --write-doc --date x`/);
    assert.match(written.stderr, /wrote COVERAGE\.md/);
    assert.ok(!written.stderr.includes(dir), 'the directory is not echoed');
  });

  it('exit 1 for an LCOV file without any src file, exit 2 for a missing file or bad arguments', async () => {
    const empty = join(dir, 'empty.lcov');
    writeFileSync(empty, '');
    const none = await run(['--lcov', empty]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no coverage data for any file under src\//);
    const onlyTests = join(dir, 'tests-only.lcov');
    writeFileSync(onlyTests, 'SF:dist-test/test/a.test.js\nDA:1,1\nend_of_record\n');
    assert.equal((await run(['--lcov', onlyTests])).code, 1);
    assert.equal((await run(['--lcov', join(dir, 'nope.lcov')])).code, 2);
    assert.equal((await run(['--bogus'])).code, 2);
    assert.equal((await run(['--date', 'a;b'])).code, 2);
    assert.equal((await run(['--concurrency', '0'])).code, 2);
    assert.equal((await run(['--out'])).code, 2);
  });

  it('prints parser problems on stderr but still summarizes what it could read', async () => {
    const lcov = join(dir, 'damaged.lcov');
    writeFileSync(lcov, 'SF:dist-test/src/errors.js\nDA:1,1\nDA:oops,2\nLF:1\nLH:1\n');
    const r = await run(['--lcov', lcov]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /ends inside a record/);
    assert.match(r.stderr, /malformed line\(s\) ignored/);
    assert.match(r.stdout, /src\/errors\.ts/);
  });

  it('runs a real test with coverage in a throw-away project: counts, path mapping, exclusions, files without data', { timeout: 120_000 }, async () => {
    const repo = join(dir, 'project');
    for (const sub of ['src', 'dist-test/src', 'dist-test/test']) mkdirSync(join(repo, sub), { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export {};\n');
    writeFileSync(join(repo, 'src', 'never-loaded.ts'), 'export {};\n');
    writeFileSync(join(repo, 'dist-test', 'src', 'a.js'), 'export function f(x) {\n  if (x > 1) return "big";\n  return "small";\n}\nexport function unused() {\n  return 1;\n}\n');
    writeFileSync(
      join(repo, 'dist-test', 'test', 'a.test.js'),
      'import { test } from "node:test";\nimport { f } from "../src/a.js";\ntest("one", () => { f(2); });\ntest("two", () => { f(3); });\n',
    );
    const r = await run(['--repo', repo, '--json', '--concurrency', '1']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { files: FileRow[]; noData: string[]; tests: TestCounts | null; excludedRecords: number; totals: Totals };
    assert.deepEqual(out.tests, { tests: 2, pass: 2, fail: 0, skipped: 0 });
    assert.deepEqual(out.files.map((f) => f.file), ['src/a.ts']);
    assert.deepEqual(out.noData, ['src/never-loaded.ts']);
    assert.ok(out.excludedRecords >= 1, 'the test file itself is excluded');
    const a = out.files[0] as FileRow;
    assert.ok((a.functions ?? 100) < 100, 'the unused function is not covered');
    assert.ok((a.branches ?? 100) < 100, 'the untaken branch is not covered');
    assert.ok((a.lines ?? 0) > 50 && (a.lines ?? 0) < 100);
    assert.ok(!r.stdout.includes(repo), 'no absolute path in the output');
  });

  it('refuses to write the document when a test fails, and exits non-zero', { timeout: 120_000 }, async () => {
    const repo = join(dir, 'failing-project');
    for (const sub of ['src', 'dist-test/src', 'dist-test/test']) mkdirSync(join(repo, sub), { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export {};\n');
    writeFileSync(join(repo, 'dist-test', 'src', 'a.js'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'dist-test', 'test', 'a.test.js'), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { x } from "../src/a.js";\ntest("fails", () => { assert.equal(x, 2); });\n');
    const out = join(dir, 'should-not-exist.md');
    const r = await run(['--repo', repo, '--write-doc', '--out', out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not writing the document because the test run failed/);
    assert.throws(() => readFileSync(out), /ENOENT/);
  });

  it('says what to do when the compiled tests are missing', async () => {
    const repo = join(dir, 'no-build');
    mkdirSync(repo);
    const r = await run(['--repo', repo]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /dist-test\/test not found \(run "npm run build:test" first/);
  });
});

describe('listSourceFiles', () => {
  it('lists the real src/ tree: .ts files only, no declarations, sorted, repo-relative', () => {
    const files = mod.listSourceFiles(REPO_ROOT);
    assert.ok(files.length > 30);
    assert.ok(files.includes('src/cli/main.ts'));
    assert.ok(files.every((f) => f.startsWith('src/') && f.endsWith('.ts') && !f.endsWith('.d.ts')));
    assert.deepEqual(files, [...files].sort());
  });
});
