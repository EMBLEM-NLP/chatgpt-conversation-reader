/**
 * scripts/perf-baseline.mjs on small sizes (500 to 2,000 messages): the JSON schema of the summary, determinism (same seed =>
 * same data and same stored counts), the exit-status rule (only correctness fails the script, speed only warns), the
 * generated document (no hostname, user name or path) and argument validation. The 50,000-message run is NOT part of the
 * test suite: it is `npm run perf`.
 *
 * LONG-ish: every run imports, searches 200 queries, builds a graph and spawns about ten processes (about 4 s idle each).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PERF, REPO_ROOT, appendToFile, baseEnv, buildProduct, cleanupBuilds, makeTempDir, removeDir, runNode, sabotagedCopy } from './scripts.helpers.test.js';
import type { ProductBuild, RunResult } from './scripts.helpers.test.js';

interface Spread {
  n: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}
interface Summary {
  schema: string;
  date: string;
  gcrVersion: string;
  parameters: { messages: number; conversations: number; shards: number; messagesPerConversation: number; seed: number; queries: number; getThreadSample: number };
  environment: { node: string; v8: string; sqlite: string; platform: string; arch: string; cpuCount: number; cpuModel: string; totalMemoryMiB: number };
  load: { loadAverage1mAtStart: number; loadAverage1mAtEnd: number; freeMemoryMiBAtEnd: number };
  data: { datasetSha256: string; rawTextBytes: number; exportJsonBytes: number; zipBytes: number; abandonedBranches: number; conversationsStored: number; messagesStored: number; structuralStored: number };
  import: { wallMs: number; messagesPerSecond: number; peakRssMiB: number };
  reimport: { wallMs: number; alreadyImported: boolean; peakRssMiB: number };
  database: { bytes: number; ratioToRawText: number; ftsBytes: number | null; ftsRatioToRawText: number | null; messagesTableBytes: number | null };
  search: Spread & { queries: number; byKind: Record<string, Spread & { withHits: number; rejected: number }>; rejected: number };
  get: Spread;
  thread: Spread;
  stats: Record<string, number>;
  audit: { ms: number };
  graphBuild: { wallMs: number; peakRssMiB: number; nodes: number; edges: number };
  measurementWorker: { peakRssMiB: number };
  scaling: unknown;
  budgets: Array<{ name: string; target: string; actual: number; unit: string; ok: boolean }>;
  warnings: string[];
  correctness: { ok: boolean; failures: string[] };
}

let build: ProductBuild;
let work = '';
let tmpForScript = '';

before(async () => {
  build = await buildProduct();
  work = makeTempDir('gcr-perf-test-');
  tmpForScript = join(work, 'tmp');
  mkdirSync(tmpForScript);
});
after(() => {
  removeDir(work);
  cleanupBuilds();
});

/** Run the script against `dist` with a private TMPDIR so leftovers can be detected. */
function perf(args: readonly string[], dist: string = build.dist): Promise<RunResult> {
  return runNode([PERF, '--dist', dist, ...args], { cwd: REPO_ROOT, env: baseEnv({ TMPDIR: tmpForScript }), timeoutMs: 280_000 });
}
const summaryOf = (r: RunResult): Summary => JSON.parse(r.stdout) as Summary;

describe('scripts/perf-baseline.mjs --json (LONG)', { timeout: 300_000 }, () => {
  let run: RunResult;
  let s: Summary;

  before(async () => {
    run = await perf(['--messages', '2000', '--json', '--date', '2026-01-31']);
    s = summaryOf(run);
  });

  it('exits 0 with a JSON document on stdout, progress and warnings on stderr only', () => {
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      run.stderr.split('\n').filter((l) => l !== '' && !l.startsWith('perf-baseline: ') && !l.startsWith('WARN ')),
      [],
      'stderr holds only progress lines and WARN lines',
    );
    assert.equal(run.stdout.trim().startsWith('{'), true);
  });

  it('has the documented schema', () => {
    assert.equal(s.schema, 'gcr-perf-baseline/1');
    assert.equal(s.date, '2026-01-31');
    assert.match(s.gcrVersion, /^\d+\.\d+\.\d+/);
    assert.deepEqual(s.parameters, { messages: 2000, conversations: 20, shards: 5, messagesPerConversation: 100, seed: 20261011, queries: 200, getThreadSample: 20 });
    for (const key of ['node', 'v8', 'sqlite', 'platform', 'arch', 'cpuModel'] as const) assert.equal(typeof s.environment[key], 'string');
    assert.equal(s.environment.node, process.version);
    assert.equal(s.environment.v8, process.versions.v8);
    assert.ok(s.environment.cpuCount >= 1 && s.environment.totalMemoryMiB > 0);
    assert.ok(s.load.loadAverage1mAtStart >= 0 && s.load.freeMemoryMiBAtEnd > 0);
    for (const x of [s.get, s.thread, s.search]) {
      assert.ok(x.n > 0 && x.p50Ms >= 0 && x.p95Ms >= x.p50Ms && x.maxMs >= x.p95Ms, 'p50 <= p95 <= max');
    }
    assert.equal(s.search.queries, 200);
    assert.deepEqual(Object.keys(s.search.byKind), ['word', 'prefix', 'phrase', 'cjk', 'hostile']);
    assert.equal(Object.values(s.search.byKind).reduce((n, k) => n + k.n, 0), 200);
    assert.deepEqual(Object.keys(s.stats), ['role', 'model', 'channel', 'day', 'conversation', 'provider', 'content_type']);
    assert.ok(s.import.peakRssMiB > 20 && s.reimport.peakRssMiB > 20 && s.graphBuild.peakRssMiB > 20 && s.measurementWorker.peakRssMiB > 20, 'peak RSS was measured in every child');
    assert.ok(s.import.messagesPerSecond > 0 && s.import.wallMs > 0);
    assert.ok(s.database.bytes > s.data.rawTextBytes && s.database.ratioToRawText > 1);
    assert.deepEqual(s.budgets.map((b) => b.name.split(' ')[0]), ['import', 'search', 'peak', 'FTS']);
    for (const b of s.budgets) assert.equal(typeof b.ok, 'boolean');
    assert.equal(s.scaling, null, 'the scaling probe starts at 10,000 messages');
  });

  it('stored counts are exactly what was generated, and the re-import is idempotent', () => {
    assert.equal(s.data.conversationsStored, 20);
    assert.equal(s.data.messagesStored, 2000);
    assert.equal(s.data.structuralStored, 20);
    assert.equal(s.reimport.alreadyImported, true);
    assert.deepEqual(s.correctness, { ok: true, failures: [] });
  });

  it('every non-hostile query hits (words, prefixes, phrases, CJK) and hostile ones are handled without a crash', () => {
    for (const kind of ['word', 'prefix', 'phrase', 'cjk'] as const) {
      const k = s.search.byKind[kind];
      assert.ok(k !== undefined && k.n > 0 && k.withHits === k.n, `${kind}: ${k?.withHits} of ${k?.n} hit`);
    }
    const hostile = s.search.byKind['hostile'];
    assert.equal(hostile?.n, 25);
    assert.ok((hostile?.rejected ?? 0) > 0, 'some hostile queries are rejected with a documented code');
  });

  it('the dataset hash is a SHA-256 and the data sizes are plausible', () => {
    assert.match(s.data.datasetSha256, /^[0-9a-f]{64}$/);
    assert.ok(s.data.exportJsonBytes > s.data.rawTextBytes && s.data.zipBytes < s.data.exportJsonBytes);
    assert.ok(s.data.abandonedBranches > 0, 'the generated trees branch');
  });

  it('leaves nothing in the temp directory', () => {
    assert.deepEqual(readdirSync(tmpForScript), []);
  });
});

describe('scripts/perf-baseline.mjs is deterministic (LONG)', { timeout: 300_000 }, () => {
  it('the same seed gives byte-identical data and the same counts; another seed changes the data but not the counts', async () => {
    const [a, b, c] = await Promise.all([
      perf(['--messages', '700', '--json']),
      perf(['--messages', '700', '--json']),
      perf(['--messages', '700', '--json', '--seed', '7']),
    ]);
    for (const r of [a, b, c]) assert.equal(r.code, 0, r.stderr);
    const [sa, sb, sc] = [summaryOf(a), summaryOf(b), summaryOf(c)];
    assert.deepEqual(sa.data, sb.data, 'same seed: same data, hash and counts');
    assert.deepEqual(sa.parameters, sb.parameters);
    assert.deepEqual(
      Object.values(sa.search.byKind).map((k) => [k.n, k.withHits, k.rejected]),
      Object.values(sb.search.byKind).map((k) => [k.n, k.withHits, k.rejected]),
      'same queries, same outcomes',
    );
    assert.notEqual(sc.data.datasetSha256, sa.data.datasetSha256, 'another seed: other data');
    assert.equal(sc.parameters.seed, 7);
    assert.equal(sc.data.messagesStored, sa.data.messagesStored);
    assert.equal(sc.data.conversationsStored, sa.data.conversationsStored);
  });

  it('a size that is not a multiple of 100 stores exactly that many messages', async () => {
    const r = await perf(['--messages', '1234', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const s = summaryOf(r);
    assert.equal(s.data.conversationsStored, 13);
    assert.equal(s.data.messagesStored, 1234);
    assert.equal(s.data.structuralStored, 13);
  });

  it('the script itself uses no unseeded randomness and does not read the clock', () => {
    const source = readFileSync(PERF, 'utf8');
    assert.ok(!/Math\.random\(|Date\.now\(|new Date\(|randomBytes\(|randomUUID\(/.test(source), 'no call to a random or clock API');
    assert.ok(!/hostname\(|userInfo\(|homedir\(/.test(source), 'it never asks the OS for a host or user name');
  });
});

describe('scripts/perf-baseline.mjs default output and --keep-db', { timeout: 300_000 }, () => {
  it('prints a markdown table and then the JSON summary; --keep-db prints a basename and keeps the file', async () => {
    const r = await perf(['--messages', '500', '--keep-db']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\| Metric \| Result \|/);
    assert.match(r.stdout, /\| Budget \| Target \| Measured \| Status \|/);
    assert.match(r.stdout, /\nJSON summary:\n\n```json\n\{/);
    const json = r.stdout.slice(r.stdout.indexOf('```json\n') + 8, r.stdout.lastIndexOf('\n```'));
    assert.equal((JSON.parse(json) as Summary).schema, 'gcr-perf-baseline/1');
    const kept = /kept perf\.sqlite in a temp directory named (gcr-perf-[A-Za-z0-9]+)/.exec(r.stderr);
    assert.ok(kept, 'the kept directory is named by its basename');
    assert.ok(!r.stderr.includes(tmpForScript), 'no absolute path');
    assert.ok(existsSync(join(tmpForScript, kept[1] as string, 'perf.sqlite')), 'the database is still there');
    removeDir(join(tmpForScript, kept[1] as string));
  });
});

describe('scripts/perf-baseline.mjs --write-doc', { timeout: 300_000 }, () => {
  it('writes the fixed template with the environment, method, results and the shared-sandbox caveat, and no host, user or path', async () => {
    const docFile = join(work, 'PERFORMANCE.md');
    const r = await perf(['--messages', '500', '--json', '--write-doc', '--doc', docFile, '--date', '2026-01-31']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /wrote PERFORMANCE\.md/);
    const s = summaryOf(r);
    const doc = readFileSync(docFile, 'utf8');
    assert.match(doc, /^# GCR performance baseline/);
    assert.match(doc, /\| Date \| 2026-01-31 \|/);
    assert.ok(doc.includes(`| Node.js | ${process.version} |`));
    assert.ok(doc.includes(`| V8 | ${process.versions.v8} |`));
    assert.ok(doc.includes(`| Platform | ${process.platform} ${process.arch} |`));
    assert.ok(doc.includes(`| CPUs | ${s.environment.cpuCount} x ${s.environment.cpuModel} |`));
    assert.match(doc, /\| Total memory \| [\d,]+ MiB \|/);
    assert.match(doc, /## Method/);
    assert.match(doc, /## Results/);
    assert.match(doc, /## Notes on this run\n\n\* The 1-minute load average \(/);
    assert.match(doc, /ONE shared sandbox with other processes running/);
    assert.match(doc, /SYNTHETIC text/);
    assert.match(doc, /not from a real ChatGPT export/);
    assert.match(doc, /Speed never fails the build: only correctness does/);
    for (const budget of ['Import throughput', 'Search latency p95', 'Peak RSS of any child process', 'FTS index size / raw text']) assert.ok(doc.includes(`| ${budget} |`), budget);
    assert.ok(doc.includes(`\`${s.data.datasetSha256.slice(0, 16)}...\``), 'the dataset fingerprint is recorded');
    assert.ok(doc.includes(`**${s.import.messagesPerSecond.toLocaleString('en-US')} messages/s**`) || doc.includes(`${s.import.messagesPerSecond}`), 'the measured import rate is in the document');
    for (const secret of [hostname(), userInfo().username, homedir(), tmpdir(), tmpForScript, work, REPO_ROOT, process.cwd()]) {
      if (secret.length >= 4) assert.ok(!doc.includes(secret), 'the document must not contain a host name, user name or path');
    }
    assert.ok(!/\/home\/|\/Users\/|\/tmp\//.test(doc));
  });

  it('does not touch the repository document unless asked: --doc is the only target when given', async () => {
    const before = existsSync(join(REPO_ROOT, 'docs', 'PERFORMANCE.md')) ? readFileSync(join(REPO_ROOT, 'docs', 'PERFORMANCE.md'), 'utf8') : null;
    const r = await perf(['--messages', '500', '--json', '--write-doc', '--doc', join(work, 'other.md')]);
    assert.equal(r.code, 0, r.stderr);
    const after = existsSync(join(REPO_ROOT, 'docs', 'PERFORMANCE.md')) ? readFileSync(join(REPO_ROOT, 'docs', 'PERFORMANCE.md'), 'utf8') : null;
    assert.equal(after, before);
  });
});

describe('scripts/perf-baseline.mjs: only correctness changes the exit status (LONG)', { timeout: 300_000 }, () => {
  it('a slow search prints a WARN line and misses a budget, but the exit status stays 0', async () => {
    const slow = await sabotagedCopy((dist) =>
      appendToFile(
        join(dist, 'sdk', 'gcr.js'),
        `{
  const originalSearch = Gcr.prototype.search;
  let calls = 0;
  Gcr.prototype.search = function slowSearch(...args) {
    if (++calls % 7 === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 160);
    return originalSearch.apply(this, args);
  };
}`,
      ),
    );
    const r = await perf(['--messages', '500', '--json'], slow.dist);
    assert.equal(r.code, 0, r.stderr);
    const s = summaryOf(r);
    assert.equal(s.budgets.find((b) => b.name.startsWith('search'))?.ok, false);
    assert.ok(s.search.p95Ms >= 100, `p95 ${s.search.p95Ms}`);
    assert.match(r.stderr, /^WARN search latency p95: [\d.]+ ms misses the target \(< 100 ms\)$/m);
    assert.equal(s.correctness.ok, true);
  });

  it('a thread of the wrong length is a correctness failure: exit 1 with a FAIL line (the JSON is still printed)', async () => {
    const broken = await sabotagedCopy((dist) =>
      appendToFile(
        join(dist, 'sdk', 'gcr.js'),
        `{
  const originalThread = Gcr.prototype.thread;
  Gcr.prototype.thread = function brokenThread(...args) {
    const result = originalThread.apply(this, args);
    result.data.messages = result.data.messages.slice(1);
    return result;
  };
}`,
      ),
    );
    const r = await perf(['--messages', '500', '--json'], broken.dist);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^FAIL thread: \d+ of 5 conversations returned a thread of the wrong length$/m);
    const s = summaryOf(r);
    assert.equal(s.correctness.ok, false);
    assert.ok(s.correctness.failures.some((f) => /^thread: \d+ of 5 conversations/.test(f)));
  });

  it('queries that must hit but return nothing are a correctness failure', async () => {
    const blind = await sabotagedCopy((dist) =>
      appendToFile(
        join(dist, 'sdk', 'gcr.js'),
        `{
  const originalSearch = Gcr.prototype.search;
  Gcr.prototype.search = function blindSearch(...args) {
    const result = originalSearch.apply(this, args);
    result.data.items = [];
    return result;
  };
}`,
      ),
    );
    const r = await perf(['--messages', '500', '--json'], blind.dist);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^FAIL search: \d+ queries that must hit returned nothing \(word, prefix, phrase, cjk\)$/m);
  });

  it('wrong stored counts are a correctness failure (the import drops a message)', async () => {
    const lossy = await sabotagedCopy((dist) =>
      appendToFile(
        join(dist, 'cli', 'main.js'),
        // After an import, remove one message row behind the immutability triggers' back: the counts the script checks must notice.
        `import { DatabaseSync as SabotageDb } from 'node:sqlite';
{
  const dbPath = process.env.GCR_DB;
  if (process.argv[2] === 'import' && dbPath !== undefined) {
    const db = new SabotageDb(dbPath);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages'").all();
    // Only the first import finds triggers: the idempotent re-import must not drop a second message.
    if (triggers.length > 0) {
      for (const t of triggers) db.exec('DROP TRIGGER "' + t.name + '"');
      db.exec("DELETE FROM messages WHERE rowid = (SELECT MIN(rowid) FROM messages WHERE node_kind = 'message')");
    }
    db.close();
  }
}`,
      ),
    );
    const r = await perf(['--messages', '500', '--json'], lossy.dist);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^FAIL database: 499 message rows, expected 500$/m);
  });
});

describe('scripts/perf-baseline.mjs refuses bad arguments and a missing build', { timeout: 60_000 }, () => {
  const cases: Array<[string[], RegExp]> = [
    [['--messages', '5'], /--messages needs an integer from 100 to 5000000/],
    [['--messages', 'abc'], /--messages needs an integer/],
    [['--messages', '1e3'], /--messages needs an integer/],
    [['--messages'], /--messages needs an integer/],
    [['--seed', '-1'], /--seed needs an integer/],
    [['--date', 'a;b'], /--date needs 1-40 characters/],
    [['--date', ''], /--date needs 1-40 characters/],
    [['--bogus'], /usage: node scripts\/perf-baseline\.mjs/],
  ];
  for (const [args, pattern] of cases) {
    it(`exit 2 for ${JSON.stringify(args)}`, async () => {
      const r = await runNode([PERF, ...args], { cwd: REPO_ROOT, env: baseEnv() });
      assert.equal(r.code, 2);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, pattern);
    });
  }

  it('exit 2 with a hint when there is no build', async () => {
    const empty = makeTempDir('gcr-perf-empty-');
    try {
      const r = await runNode([PERF, '--dist', empty], { cwd: REPO_ROOT, env: baseEnv() });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /dist\/cli\/main\.js not found \(run "npm run build" first/);
      assert.ok(!r.stderr.includes(empty));
    } finally {
      removeDir(empty);
    }
  });
});
