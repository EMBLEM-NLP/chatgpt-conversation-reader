#!/usr/bin/env node
/**
 * Performance baseline of the BUILT product on a deterministic synthetic export (SPEC NFR-05: "bounded memory for large
 * exports, documented performance baseline (50k synthetic messages)").
 *
 *   npm run perf                                   build, then measure with the defaults (50,000 messages)
 *   node scripts/perf-baseline.mjs [options]
 *
 *   --messages N        number of messages (default 50000, at least 100). 100 messages per conversation, 5 shards.
 *   --seed N            PRNG seed (default 20261011). Same seed and size => byte-identical data and identical stored counts.
 *   --json              print only the JSON summary on stdout (default: a markdown table, then the JSON summary)
 *   --keep-db           keep the temp directory with the database; its name is printed (basename only)
 *   --write-doc         rewrite docs/PERFORMANCE.md from this run (fixed template; numbers are never edited by hand)
 *   --date <text>       date label recorded in the report and the doc (default "unknown"; the script never reads the clock)
 *   --doc <file>        with --write-doc: write there instead of docs/PERFORMANCE.md (tests use it)
 *   --dist <dir>        compiled product to measure (default ./dist)
 *   --no-scaling-large  skip the import of five times the data (the 5x run takes about five times as long as the main import)
 *
 * What is measured (everything through the compiled product, nothing mocked):
 *   1. import      `gcr import` in a CHILD process: wall time, messages/s, peak RSS (process.resourceUsage().maxRSS, read by a tiny
 *                  --require hook when the child exits)
 *   2. re-import   the same archive again (idempotent: alreadyImported, nothing new), wall time and peak RSS
 *   3. database    file size, ratio to the raw message text, and the share of the FTS index (SQLite dbstat, when available)
 *   4. searches    200 varied queries through the SDK in a measurement worker process: words, prefixes, phrases, CJK, hostile
 *   5. get/thread  100 pseudo-random conversations each, with the expected active-thread length checked
 *   6. stats       every --group-by value; audit; and `gcr graph build` in a child process (wall time, peak RSS)
 *   7. scaling     the import of one fifth AND of five times the data in their own databases (peak RSS and rate), to show memory
 *                  does not grow with the export; a growth above 1.6x in peak RSS for 5x the data is a WARN (use --no-scaling-large to skip the 5x run)
 *
 * Exit status: non-zero ONLY on correctness failures (wrong stored counts, a thread of the wrong length, a query that
 * must hit but does not, a network attempt recorded by the guard ...). Speed never changes the exit status; results worse
 * than the documented budgets (import >= 10,000 messages/s, search p95 < 100 ms, peak RSS < 600 MiB, FTS index <= 3x the
 * raw text) are printed as WARN lines on stderr and recorded in the JSON.
 *
 * All data is synthetic and generated here (no Math.random, no clock, no network). Temp files live in one temp directory
 * that is removed at the end. Children run with scripts/no-network-guard.cjs preloaded.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = join(repoRoot, 'scripts', 'no-network-guard.cjs');
const SCHEMA = 'gcr-perf-baseline/1';
const MESSAGES_PER_CONVERSATION = 100;
const SHARDS = 5;
const MIB = 1024 * 1024;
/** NFR-05 shape check: peak RSS may grow by at most this factor when the data grows 5x (measured on this code base: about 1.05x). */
const SCALING_RSS_GROWTH_LIMIT = 1.6;

/** The NFR-05 baseline targets. They are justified in docs/PERFORMANCE.md (the template below). */
const BUDGETS = {
  importMessagesPerSecond: 10_000,
  searchP95Ms: 100,
  peakRssMiB: 600,
  databaseToTextRatio: 3, // the FTS5 index (docs/ARCHITECTURE.md section 3), or the whole file when dbstat is unavailable
};

// ------------------------------------------------------------------------------------------------------------------
// Arguments
// ------------------------------------------------------------------------------------------------------------------

function usage(code) {
  process.stderr.write(
    'usage: node scripts/perf-baseline.mjs [--messages N] [--seed N] [--json] [--keep-db] [--write-doc] [--date <text>] [--doc <file>] [--dist <dir>] [--no-scaling-large]\n',
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { messages: 50_000, seed: 20_261_011, json: false, keepDb: false, writeDoc: false, date: 'unknown', doc: join(repoRoot, 'docs', 'PERFORMANCE.md'), dist: join(repoRoot, 'dist'), scalingLarge: true, worker: null };
  const intArg = (name, text, min, max) => {
    if (!/^\d{1,12}$/.test(text ?? '') || Number(text) < min || Number(text) > max) {
      process.stderr.write(`perf-baseline: ${name} needs an integer from ${min} to ${max}\n`);
      process.exit(2);
    }
    return Number(text);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--messages') opts.messages = intArg(a, argv[++i], 100, 5_000_000);
    else if (a === '--seed') opts.seed = intArg(a, argv[++i], 0, 4_294_967_295);
    else if (a === '--json') opts.json = true;
    else if (a === '--keep-db') opts.keepDb = true;
    else if (a === '--write-doc') opts.writeDoc = true;
    else if (a === '--date') {
      opts.date = argv[++i] ?? '';
      if (!/^[A-Za-z0-9 :._+-]{1,40}$/.test(opts.date)) {
        process.stderr.write('perf-baseline: --date needs 1-40 characters from A-Z a-z 0-9 space : . _ + -\n');
        process.exit(2);
      }
    } else if (a === '--doc' && argv[i + 1] !== undefined) opts.doc = resolve(argv[++i]);
    else if (a === '--dist' && argv[i + 1] !== undefined) opts.dist = resolve(argv[++i]);
    else if (a === '--no-scaling-large') opts.scalingLarge = false;
    else if (a === '--worker' && argv[i + 1] !== undefined) opts.worker = argv[++i]; // internal: the measurement worker
    else if (a === '--worker-db' || a === '--worker-params') opts[a === '--worker-db' ? 'workerDb' : 'workerParams'] = resolve(argv[++i] ?? '');
    else usage(2);
  }
  return opts;
}

// ------------------------------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32): the only source of "randomness" in this script. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Nearest-rank percentile of an ascending array. */
const percentile = (sorted, q) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]);
const round = (n, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50Ms: round(percentile(sorted, 0.5), 2), p95Ms: round(percentile(sorted, 0.95), 2), maxMs: round(sorted[sorted.length - 1] ?? 0, 2) };
}
const hex = (n, width) => n.toString(16).padStart(width, '0');
/** Reasons printed by this script never contain absolute paths. */
const scrub = (text) => String(text).replace(/(?:\/[\w.@%+~-]+){2,}/g, '<path>').slice(0, 200);

// ------------------------------------------------------------------------------------------------------------------
// Deterministic synthetic export
// ------------------------------------------------------------------------------------------------------------------

const CONSONANTS = 'bdfgklmnprstvz'.split('');
const VOWELS = 'aeiou'.split('');
/** Real words, so stemming, prefix and phrase queries behave like they do on natural text. */
const TOPIC_WORDS = (
  'database search index python budget recipe travel meeting project schedule report summary analysis design review release server network privacy security ' +
  'export import conversation branch memory garden coffee music history science market contract invoice weather holiday fitness training deadline feature ' +
  'searching searches indexed indexing imports importing exported exporting designs designed reviewing released servers networks'
).split(' ');
const ACCENTED = ['café', 'naïve', 'résumé', 'jalapeño', 'Zürich', 'crème', 'façade', 'Ångström'];
const CJK_PHRASES = [
  '这是一个数据库搜索测试', '全文检索与索引', 'これは日本語のテストです', '会話の履歴を検索する', '대화 기록 검색 테스트', '日本語のテキストを索引に追加する',
  '数据导出和导入', '机器学习模型', 'プライバシーとセキュリティ', '本地优先的工具',
];
const MODELS = ['synthetic-model-a', 'synthetic-model-b', 'synthetic-model-c'];
const BASE_TIME = 1_700_000_000;

function makeVocabulary(rand, size) {
  const words = new Set();
  while (words.size < size) {
    let word = '';
    const syllables = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < syllables; i++) word += CONSONANTS[Math.floor(rand() * CONSONANTS.length)] + VOWELS[Math.floor(rand() * VOWELS.length)];
    if (rand() < 0.3) word += CONSONANTS[Math.floor(rand() * CONSONANTS.length)];
    words.add(word);
  }
  return [...words];
}

/**
 * The whole export, generated shard by shard. Returns the shard buffers (JSON, UTF-8) and everything the measurements
 * need to know about them: counts, the exact length of every conversation's active thread, and queries that must hit.
 */
function generateExport({ messages, seed }) {
  const rand = mulberry32(seed);
  const vocabulary = makeVocabulary(rand, 3000);
  const lexicon = [...vocabulary, ...TOPIC_WORDS]; // indexes >= vocabulary.length are topic words
  const documentFrequency = new Uint32Array(lexicon.length);
  const phrases = []; // adjacent plain word pairs that occur in some message
  const cjkUsed = new Set();
  const conversationCount = Math.ceil(messages / MESSAGES_PER_CONVERSATION);
  const shardCount = Math.min(SHARDS, conversationCount);
  const shards = Array.from({ length: shardCount }, () => []);
  const conversations = []; // { id, messages, active }
  let rawTextBytes = 0;
  let messageCounter = 0;

  const pickWord = () => (rand() < 0.16 ? vocabulary.length + Math.floor(rand() * TOPIC_WORDS.length) : Math.floor(vocabulary.length * rand() ** 3));

  /** Text of one message: pseudo-words with a skewed (Zipf-like) frequency, topic words, accents, CJK, URLs, code, emoji. */
  function makeText(assistant) {
    const count = assistant ? 30 + Math.floor(rand() * 190) : 6 + Math.floor(rand() * 64);
    const seen = new Set();
    let out = '';
    let capitalize = true;
    let untilStop = 8 + Math.floor(rand() * 9);
    let previous = null;
    for (let w = 0; w < count; w++) {
      const index = pickWord();
      seen.add(index);
      let word = lexicon[index];
      if (previous !== null && !capitalize && phrases.length < 300 && rand() < 0.02) phrases.push(`${lexicon[previous]} ${word}`);
      previous = capitalize ? null : index;
      if (capitalize) word = word[0].toUpperCase() + word.slice(1);
      capitalize = false;
      out += word;
      if (--untilStop === 0) {
        out += assistant && rand() < 0.12 ? '.\n\n' : '. ';
        capitalize = true;
        untilStop = 8 + Math.floor(rand() * 9);
      } else out += ' ';
    }
    for (const index of seen) documentFrequency[index]++;
    out = out.trimEnd();
    if (rand() < 0.04) out += ` ${ACCENTED[Math.floor(rand() * ACCENTED.length)]}`;
    if (rand() < 0.05) {
      const phrase = Math.floor(rand() * CJK_PHRASES.length);
      cjkUsed.add(phrase);
      out += ` ${CJK_PHRASES[phrase]}`;
    }
    if (rand() < 0.05) out += ` https://example.invalid/${lexicon[pickWord()]}/${lexicon[pickWord()]}`;
    if (assistant && rand() < 0.08) out += '\n\n```python\nfor i in range(10):\n    print(i)\n```';
    if (rand() < 0.02) out += rand() < 0.5 ? ' \u{1F642}' : ' \u{1F680}';
    return out;
  }

  for (let k = 0; k < conversationCount; k++) {
    const size = Math.min(MESSAGES_PER_CONVERSATION, messages - k * MESSAGES_PER_CONVERSATION);
    const conversationId = `00000000-0000-4000-8000-${hex(0xc0_0000_0000_00 + k, 12)}`;
    const model = MODELS[k % MODELS.length];
    const rootId = 'client-created-root';
    const mapping = { [rootId]: { id: rootId, message: null, parent: null, children: [] } };
    let tail = rootId;
    let tailRole = 'assistant';
    let sinceAbandoned = 0;
    let abandoned = 0;
    let time = BASE_TIME + k * 3600;
    for (let i = 0; i < size; i++) {
      const id = `00000000-0000-4000-8000-${hex(0x10_0000_0000_00 + messageCounter++, 12)}`;
      const role = tailRole === 'user' ? 'assistant' : 'user';
      // Every ~20 messages an assistant reply is abandoned (a regenerated answer): a leaf beside the active chain.
      const abandon = role === 'assistant' && sinceAbandoned >= 11 && i < size - 1;
      const text = makeText(role === 'assistant');
      rawTextBytes += Buffer.byteLength(text);
      time += 20 + Math.floor(rand() * 40);
      const metadata = { timestamp_: 'absolute' };
      if (role === 'assistant' && rand() < 0.9) metadata.model_slug = model;
      mapping[id] = {
        id,
        message: {
          id,
          author: { role, name: null, metadata: {} },
          create_time: time + Math.floor(rand() * 1000) / 1000,
          update_time: null,
          content: { content_type: 'text', parts: [text] },
          status: 'finished_successfully',
          end_turn: role === 'assistant' ? true : null,
          weight: 1,
          metadata,
          recipient: 'all',
          ...(role === 'assistant' ? { channel: 'final' } : {}),
        },
        parent: tail,
        children: [],
      };
      mapping[tail].children.push(id);
      if (abandon) {
        abandoned++;
        sinceAbandoned = 0;
      } else {
        tail = id;
        tailRole = role;
        sinceAbandoned++;
      }
    }
    const topic = [lexicon[vocabulary.length + (k % TOPIC_WORDS.length)], lexicon[vocabulary.length + ((k * 7 + 3) % TOPIC_WORDS.length)]];
    shards[Math.floor((k * shardCount) / conversationCount)].push({
      id: conversationId,
      conversation_id: conversationId,
      title: `GCR-SYNTHETIC-FIXTURE perf conversation ${k + 1} ${topic.join(' ')}`,
      create_time: BASE_TIME + k * 3600,
      update_time: time,
      mapping,
      current_node: tail,
      moderation_results: [],
      default_model_slug: model,
      is_archived: false,
    });
    conversations.push({ id: conversationId, messages: size, active: size - abandoned });
  }

  const shardBuffers = shards.map((conversationsOfShard) => Buffer.from(JSON.stringify(conversationsOfShard), 'utf8'));
  const digest = createHash('sha256');
  for (const buffer of shardBuffers) digest.update(buffer);

  // ---- queries with a known outcome --------------------------------------------------------------------------------
  const present = [...lexicon.keys()].filter((i) => documentFrequency[i] > 0).sort((a, b) => documentFrequency[a] - documentFrequency[b] || a - b);
  const spread = (list, count, offset = 0) => Array.from({ length: Math.min(count, list.length) }, (_, j) => list[Math.min(list.length - 1, Math.floor(((j + offset) * list.length) / count))]);
  const queries = [];
  for (const i of spread(present, 80)) queries.push({ kind: 'word', query: lexicon[i], mode: 'plain', expectHits: true });
  const longWords = present.filter((i) => lexicon[i].length >= 5);
  for (const i of spread(longWords, 40, 0.5)) queries.push({ kind: 'prefix', query: `${lexicon[i].slice(0, lexicon[i].length >= 7 ? 4 : 3)}*`, mode: 'plain', expectHits: true });
  for (const pair of phrases.slice(0, 30)) queries.push({ kind: 'phrase', query: `"${pair}"`, mode: 'raw', expectHits: true });
  const cjkSources = [...cjkUsed].sort((a, b) => a - b).map((i) => [...CJK_PHRASES[i]]);
  for (let j = 0; j < 25 && cjkSources.length > 0; j++) {
    const chars = cjkSources[j % cjkSources.length];
    const length = 1 + (j % 4);
    const start = (j * 3) % Math.max(1, chars.length - length + 1);
    queries.push({ kind: 'cjk', query: chars.slice(start, start + length).join(''), mode: 'plain', expectHits: true });
  }
  const hostile = [
    'AND OR NOT', '"unbalanced quote', 'NEAR(a b, 5)', '*', 'a* b* c*', "'; DROP TABLE messages; --", '" OR 1=1 --', 'nul\u0000byte', '-minus', '(((', ')))', 'col:term',
    '{brace}', '^caret', 'x'.repeat(5000), '日本語 AND', '\u{1F600}', 'ünï̈cödë', '\n\t', 'http://example.invalid/?q=a&b=c', '<script>alert(1)</script>', '%s%s%s%n',
    '../../etc/passwd', 'a OR', '"" ""',
  ];
  for (const query of hostile) queries.push({ kind: 'hostile', query, mode: 'plain', expectHits: false });

  return {
    shardBuffers,
    conversations,
    queries,
    rawTextBytes,
    exportJsonBytes: shardBuffers.reduce((n, b) => n + b.length, 0),
    datasetSha256: digest.digest('hex'),
    abandonedBranches: conversations.reduce((n, c) => n + (c.messages - c.active), 0),
  };
}

/** A ZIP with DEFLATE-compressed entries (like a real export), built in memory. */
function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 6 });
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const zipOf = (data) => buildZip(data.shardBuffers.map((buffer, i) => ({ name: `conversations-${String(i + 1).padStart(3, '0')}.json`, data: buffer })));

// ------------------------------------------------------------------------------------------------------------------
// Measurement worker: runs in its own process, reads the database through the SDK (read-only)
// ------------------------------------------------------------------------------------------------------------------

async function runWorker(opts) {
  const params = JSON.parse(readFileSync(opts.workerParams, 'utf8'));
  await import(pathToFileURL(join(opts.dist, 'suppress-warnings.js')).href);
  const { Gcr } = await import(pathToFileURL(join(opts.dist, 'sdk', 'gcr.js')).href);
  const { GcrError } = await import(pathToFileURL(join(opts.dist, 'errors.js')).href);
  const gcr = Gcr.open({ dbPath: opts.workerDb, readOnly: true });
  const out = { search: [], get: [], thread: [], getWrong: 0, threadWrong: 0, stats: {}, statsTotals: {}, audit: null, errors: [] };
  const time = (f) => {
    const t0 = performance.now();
    const value = f();
    return [performance.now() - t0, value];
  };
  try {
    // Warm-up: a few untimed queries so the first timed one does not pay for opening the file's pages.
    for (const q of params.queries.filter((x) => x.kind === 'word').slice(0, 5)) gcr.search({ query: q.query, limit: 20 });

    for (const q of params.queries) {
      const t0 = performance.now();
      let hits = -1;
      let rejected = false;
      try {
        hits = gcr.search({ query: q.query, mode: q.mode, limit: 20 }).data.items.length;
      } catch (e) {
        if (e instanceof GcrError) rejected = true;
        else out.errors.push(`search ${q.kind}: unexpected ${e?.name ?? 'error'}`);
      }
      out.search.push({ kind: q.kind, ms: performance.now() - t0, hits, rejected, expectHits: q.expectHits });
    }

    for (const c of params.gets) {
      const [getMs, got] = time(() => gcr.get(c.id));
      out.get.push(getMs);
      if (got.data.thread?.messages.length !== c.active) out.getWrong++;
      const [threadMs, thread] = time(() => gcr.thread(c.id));
      out.thread.push(threadMs);
      if (thread.data.messages.length !== c.active) out.threadWrong++;
    }

    for (const groupBy of ['role', 'model', 'channel', 'day', 'conversation', 'provider', 'content_type']) {
      const [ms, stats] = time(() => gcr.stats({ groupBy, limit: 1000 }));
      out.stats[groupBy] = ms;
      out.statsTotals[groupBy] = stats.data.totals.messages;
    }
    const [auditMs, audit] = time(() => gcr.audit({}));
    out.audit = { ms: auditMs, scannedMessages: audit.data.scanned.messages, scannedConversations: audit.data.scanned.conversations };
  } finally {
    gcr.close();
  }
  out.peakRssKiB = process.resourceUsage().maxRSS;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// ------------------------------------------------------------------------------------------------------------------
// The run
// ------------------------------------------------------------------------------------------------------------------

function runChild(env, args, { timeoutMs = 900_000 } = {}) {
  return new Promise((resolveRun) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', () => {
      clearTimeout(timer);
      resolveRun({ code: -1, wallMs: 0, stdout: '', stderr: 'spawn failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, wallMs: performance.now() - t0, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

async function main(opts) {
  const progress = (text) => process.stderr.write(`perf-baseline: ${text}\n`);
  const cliJs = join(opts.dist, 'cli', 'main.js');
  if (!existsSync(cliJs)) {
    process.stderr.write('perf-baseline: dist/cli/main.js not found (run "npm run build" first, or pass --dist <dir>).\n');
    process.exit(2);
  }
  const failures = []; // correctness failures: the only thing that changes the exit status
  const expect = (condition, what) => {
    if (!condition) failures.push(what);
  };

  const work = mkdtempSync(join(tmpdir(), 'gcr-perf-'));
  const hook = join(work, 'rss-hook.cjs');
  const guardLog = join(work, 'guard.log');
  mkdirSync(join(work, 'home'));
  writeFileSync(guardLog, '');
  writeFileSync(hook, "process.on('exit', () => { try { require('node:fs').writeFileSync(process.env.GCR_PERF_RSS_FILE, String(process.resourceUsage().maxRSS)); } catch {} });\n");
  const quoted = (p) => (/\s/.test(p) ? `"${p}"` : p);
  const childEnv = (extra) => ({
    PATH: process.env.PATH ?? '',
    HOME: join(work, 'home'),
    TMPDIR: work,
    TZ: 'UTC',
    NODE_OPTIONS: `--require=${quoted(guardPath)} --require=${quoted(hook)}`,
    GCR_NO_NETWORK_LOG: guardLog,
    ...extra,
  });
  /** Run the CLI in a child process; returns wall time, parsed JSON report and the child's peak RSS in MiB. */
  async function cli(args, dbPath, tag) {
    const rssFile = join(work, `rss-${tag}.txt`);
    const r = await runChild(childEnv({ GCR_DB: dbPath, GCR_PERF_RSS_FILE: rssFile }), [cliJs, ...args, '--format', 'json']);
    let report = null;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      /* reported below */
    }
    expect(r.code === 0 && report !== null && report.ok === true, `${tag}: the command failed (exit ${r.code}${r.code === 0 ? ', unparseable output' : `, ${scrub(r.stderr.split('\n')[0] ?? '')}`})`);
    const rssKiB = existsSync(rssFile) ? Number(readFileSync(rssFile, 'utf8')) : 0;
    return { wallMs: r.wallMs, data: report?.data ?? {}, peakRssMiB: round(rssKiB / 1024, 1), exitCode: r.code };
  }

  try {
    const loadStart = loadavg()[0];
    progress(`generating ${opts.messages} synthetic messages (seed ${opts.seed})`);
    const data = generateExport({ messages: opts.messages, seed: opts.seed });
    const conversationCount = data.conversations.length;
    const zipBytes = zipOf(data);
    const zipPath = join(work, 'export.zip');
    writeFileSync(zipPath, zipBytes);
    progress(`dataset: ${conversationCount} conversations, ${data.shardBuffers.length} shards, ${round(data.exportJsonBytes / MIB)} MiB JSON, ${round(zipBytes.length / MIB)} MiB zip`);

    // ---- import, re-import ---------------------------------------------------------------------------------------------
    const dbPath = join(work, 'perf.sqlite');
    progress('import');
    const imported = await cli(['import', zipPath], dbPath, 'import');
    const d = imported.data;
    expect(d.alreadyImported === false, 'import: alreadyImported is not false on a fresh database');
    expect(d.conversations?.stored === conversationCount, `import: ${d.conversations?.stored} conversations stored, expected ${conversationCount}`);
    expect(d.conversations?.failed === 0, `import: ${d.conversations?.failed} conversations failed`);
    expect(d.messages?.structural === conversationCount, `import: ${d.messages?.structural} structural messages, expected ${conversationCount}`);
    expect(d.messages?.stored - d.messages?.structural === opts.messages, `import: ${d.messages?.stored - d.messages?.structural} messages stored, expected ${opts.messages}`);
    expect(d.messages?.newlyInserted === d.messages?.stored, 'import: not every message was newly inserted');

    progress('idempotent re-import');
    const again = await cli(['import', zipPath], dbPath, 'reimport');
    expect(again.data.alreadyImported === true, 're-import: alreadyImported is not true');
    expect(again.data.messages?.newlyInserted === 0 && again.data.conversations?.newlyInserted === 0, 're-import: new rows were inserted');
    expect(again.data.messages?.stored === d.messages?.stored, 're-import: the stored message count differs from the first import');
    expect(again.data.batchId === d.batchId, 're-import: the batch id differs');

    // ---- database size ------------------------------------------------------------------------------------------------------
    const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);
    const dbBytes = sizeOf(dbPath) + sizeOf(`${dbPath}-wal`);
    let sqliteVersion = 'unknown';
    let breakdown = null;
    let rowCounts = null;
    {
      const emit = process.emitWarning;
      process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
      const { DatabaseSync } = await import('node:sqlite');
      process.emitWarning = emit;
      sqliteVersion = new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS v').get().v;
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        rowCounts = {
          messages: Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE node_kind = 'message'").get().n),
          conversations: Number(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n),
          batches: Number(db.prepare('SELECT COUNT(*) AS n FROM source_batches').get().n),
        };
        try {
          const sizes = db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all();
          const sum = (pred) => sizes.filter((s) => pred(s.name)).reduce((n, s) => n + Number(s.bytes), 0);
          breakdown = {
            ftsBytes: sum((n) => n.includes('_fts')),
            messagesTableBytes: sum((n) => !n.includes('_fts') && /messages/.test(n)),
            otherBytes: sum((n) => !n.includes('_fts') && !/messages/.test(n)),
          };
        } catch {
          breakdown = null; // dbstat is not compiled into every SQLite build
        }
      } finally {
        db.close();
      }
    }
    expect(rowCounts.messages === opts.messages, `database: ${rowCounts.messages} message rows, expected ${opts.messages}`);
    expect(rowCounts.conversations === conversationCount, `database: ${rowCounts.conversations} conversation rows, expected ${conversationCount}`);
    expect(rowCounts.batches === 1, `database: ${rowCounts.batches} batches after an idempotent re-import, expected 1`);

    // ---- searches, get, thread, stats, audit (measurement worker) ------------------------------------------------------------
    progress(`searches (${data.queries.length}), get and thread, stats, audit`);
    const rand = mulberry32((opts.seed >>> 0) ^ 0x9e3779b9);
    const gets = [];
    const chosen = new Set();
    while (chosen.size < Math.min(100, conversationCount)) chosen.add(Math.floor(rand() * conversationCount));
    for (const i of [...chosen].sort((a, b) => a - b)) gets.push({ id: data.conversations[i].id, active: data.conversations[i].active });
    const paramsFile = join(work, 'worker-params.json');
    writeFileSync(paramsFile, JSON.stringify({ queries: data.queries, gets }));
    const measured = await runChild(childEnv({ GCR_PERF_RSS_FILE: join(work, 'rss-worker.txt') }), [fileURLToPath(import.meta.url), '--worker', 'measure', '--dist', opts.dist, '--worker-db', dbPath, '--worker-params', paramsFile]);
    let worker = null;
    try {
      worker = JSON.parse(measured.stdout);
    } catch {
      /* reported below */
    }
    expect(measured.code === 0 && worker !== null, `measurement worker failed (exit ${measured.code}, ${scrub(measured.stderr.split('\n')[0] ?? '')})`);
    worker ??= { search: [], get: [], thread: [], getWrong: 0, threadWrong: 0, stats: {}, statsTotals: {}, audit: { ms: 0, scannedMessages: 0 }, errors: [], peakRssKiB: 0 };
    for (const e of worker.errors) expect(false, `worker: ${e}`);
    expect(worker.search.length === data.queries.length, `search: ${worker.search.length} of ${data.queries.length} queries ran`);
    expect(worker.getWrong === 0, `get: ${worker.getWrong} of ${gets.length} conversations returned an active thread of the wrong length`);
    expect(worker.threadWrong === 0, `thread: ${worker.threadWrong} of ${gets.length} conversations returned a thread of the wrong length`);
    expect(worker.statsTotals.role === opts.messages, `stats: group-by role counted ${worker.statsTotals.role} messages, expected ${opts.messages}`);
    for (const g of Object.keys(worker.statsTotals)) expect(worker.statsTotals[g] === opts.messages, `stats: group-by ${g} counted ${worker.statsTotals[g]} messages, expected ${opts.messages}`);
    expect(worker.audit.scannedMessages === opts.messages, `audit: scanned ${worker.audit.scannedMessages} messages, expected ${opts.messages}`);
    const missed = worker.search.filter((s) => s.expectHits && s.hits < 1);
    expect(missed.length === 0, `search: ${missed.length} queries that must hit returned nothing (${[...new Set(missed.map((s) => s.kind))].join(', ')})`);

    const byKind = {};
    for (const kind of ['word', 'prefix', 'phrase', 'cjk', 'hostile']) {
      const rows = worker.search.filter((s) => s.kind === kind);
      byKind[kind] = { ...summarize(rows.map((s) => s.ms)), withHits: rows.filter((s) => s.hits > 0).length, rejected: rows.filter((s) => s.rejected).length };
    }
    const searchAll = summarize(worker.search.map((s) => s.ms));

    // ---- graph build ----------------------------------------------------------------------------------------------------------
    progress('graph build');
    const graph = await cli(['graph', 'build'], dbPath, 'graph');
    expect(graph.data.nodes > 0 && graph.data.edges > 0, 'graph build: the graph is empty');
    expect(graph.data.messagesScanned === opts.messages, `graph build: scanned ${graph.data.messagesScanned} messages, expected ${opts.messages}`);

    // ---- scaling probe: one fifth and five times the data, each in its own database ----------------------------------------------
    // Why two extra points: a probe from 10,000 to 50,000 messages showed 1.15x RSS and hid a real defect (the importer retained the
    // text of every conversation through sliced key strings, SPEC-01 of the final review). That retention only costs tens of MiB at
    // 50,000 messages and hundreds at 500,000; the 5x run makes such a leak visible as a ratio.
    let scaling = null;
    if (opts.messages >= 10_000) {
      const probeImport = async (messages, tag) => {
        progress(`scaling probe: ${fmt(messages)} messages`);
        const exp = generateExport({ messages, seed: opts.seed });
        const zip = join(work, `${tag}.zip`);
        writeFileSync(zip, zipOf(exp));
        const run = await cli(['import', zip], join(work, `${tag}.sqlite`), tag);
        const stored = run.data.messages?.stored - run.data.messages?.structural;
        expect(stored === messages, `scaling probe (${tag}): ${stored} messages stored, expected ${messages}`);
        rmSync(zip, { force: true });
        rmSync(join(work, `${tag}.sqlite`), { force: true });
        return { messages, peakRssMiB: run.peakRssMiB, messagesPerSecond: Math.round(messages / (run.wallMs / 1000)) };
      };
      const smallMessages = Math.floor(opts.messages / 5 / MESSAGES_PER_CONVERSATION) * MESSAGES_PER_CONVERSATION;
      const small = await probeImport(smallMessages, 'small');
      const xl = opts.scalingLarge ? await probeImport(opts.messages * 5, 'xl') : null;
      scaling = {
        smallMessages,
        smallPeakRssMiB: small.peakRssMiB,
        smallMessagesPerSecond: small.messagesPerSecond,
        largeMessages: opts.messages,
        largePeakRssMiB: imported.peakRssMiB,
        rssGrowth: small.peakRssMiB > 0 ? round(imported.peakRssMiB / small.peakRssMiB, 2) : null,
        dataGrowth: round(opts.messages / smallMessages, 2),
        xlMessages: xl === null ? null : xl.messages,
        xlPeakRssMiB: xl === null ? null : xl.peakRssMiB,
        xlMessagesPerSecond: xl === null ? null : xl.messagesPerSecond,
        xlRssGrowth: xl === null || imported.peakRssMiB <= 0 ? null : round(xl.peakRssMiB / imported.peakRssMiB, 2),
        xlDataGrowth: xl === null ? null : round(xl.messages / opts.messages, 2),
      };
    }

    const guardLines = readFileSync(guardLog, 'utf8').split('\n').filter((l) => l !== '');
    expect(guardLines.length === 0, `the network guard recorded ${guardLines.length} attempt(s): ${[...new Set(guardLines)].join(', ')}`);

    // ---- assemble ----------------------------------------------------------------------------------------------------------------
    const { TOOL_VERSION } = await import(pathToFileURL(join(opts.dist, 'version.js')).href);
    const cpuList = cpus();
    const messagesPerSecond = Math.round(opts.messages / (imported.wallMs / 1000));
    const workerRssMiB = round(worker.peakRssKiB / 1024, 1);
    const maxRssMiB = Math.max(imported.peakRssMiB, again.peakRssMiB, graph.peakRssMiB, workerRssMiB);
    const summary = {
      schema: SCHEMA,
      date: opts.date,
      gcrVersion: TOOL_VERSION,
      parameters: { messages: opts.messages, conversations: conversationCount, shards: data.shardBuffers.length, messagesPerConversation: MESSAGES_PER_CONVERSATION, seed: opts.seed, queries: data.queries.length, getThreadSample: gets.length },
      environment: {
        node: process.version,
        v8: process.versions.v8,
        sqlite: sqliteVersion,
        platform: process.platform,
        arch: process.arch,
        cpuCount: cpuList.length,
        cpuModel: (cpuList[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(),
        totalMemoryMiB: Math.round(totalmem() / MIB),
      },
      load: { loadAverage1mAtStart: round(loadStart, 2), loadAverage1mAtEnd: round(loadavg()[0], 2), freeMemoryMiBAtEnd: Math.round(freemem() / MIB) },
      data: {
        datasetSha256: data.datasetSha256,
        rawTextBytes: data.rawTextBytes,
        exportJsonBytes: data.exportJsonBytes,
        zipBytes: zipBytes.length,
        abandonedBranches: data.abandonedBranches,
        conversationsStored: d.conversations?.stored ?? 0,
        messagesStored: (d.messages?.stored ?? 0) - (d.messages?.structural ?? 0),
        structuralStored: d.messages?.structural ?? 0,
      },
      import: { wallMs: Math.round(imported.wallMs), messagesPerSecond, peakRssMiB: imported.peakRssMiB },
      reimport: { wallMs: Math.round(again.wallMs), alreadyImported: again.data.alreadyImported === true, peakRssMiB: again.peakRssMiB },
      database: {
        bytes: dbBytes,
        ratioToRawText: round(dbBytes / data.rawTextBytes, 2),
        ftsBytes: breakdown?.ftsBytes ?? null,
        ftsRatioToRawText: breakdown === null ? null : round(breakdown.ftsBytes / data.rawTextBytes, 2),
        messagesTableBytes: breakdown?.messagesTableBytes ?? null,
        otherBytes: breakdown?.otherBytes ?? null,
      },
      search: { ...searchAll, queries: worker.search.length, byKind, rejected: worker.search.filter((s) => s.rejected).length },
      get: summarize(worker.get),
      thread: summarize(worker.thread),
      stats: Object.fromEntries(Object.entries(worker.stats).map(([k, v]) => [k, round(v, 2)])),
      audit: { ms: round(worker.audit.ms, 2) },
      graphBuild: { wallMs: Math.round(graph.wallMs), peakRssMiB: graph.peakRssMiB, nodes: graph.data.nodes ?? 0, edges: graph.data.edges ?? 0 },
      measurementWorker: { peakRssMiB: workerRssMiB },
      scaling,
      budgets: [],
      warnings: [],
      correctness: { ok: failures.length === 0, failures: [...failures] },
    };

    const budget = (name, target, actual, ok, unit) => summary.budgets.push({ name, target, actual, unit, ok });
    budget('import throughput', `>= ${BUDGETS.importMessagesPerSecond}`, messagesPerSecond, messagesPerSecond >= BUDGETS.importMessagesPerSecond, 'messages/s');
    budget('search latency p95', `< ${BUDGETS.searchP95Ms}`, searchAll.p95Ms, searchAll.p95Ms < BUDGETS.searchP95Ms, 'ms');
    budget('peak RSS of any child process', `< ${BUDGETS.peakRssMiB}`, maxRssMiB, maxRssMiB < BUDGETS.peakRssMiB, 'MiB');
    // docs/ARCHITECTURE.md: "Index size must stay within ~3x the raw text size". The index is the FTS5 share of the file;
    // without SQLite's dbstat the whole file is judged instead (stricter). The whole-file ratio is reported either way.
    const indexRatio = summary.database.ftsRatioToRawText ?? summary.database.ratioToRawText;
    budget(summary.database.ftsRatioToRawText === null ? 'database size / raw text' : 'FTS index size / raw text', `<= ${BUDGETS.databaseToTextRatio}`, indexRatio, indexRatio <= BUDGETS.databaseToTextRatio, 'x');
    // Memory shape (NFR-05): five times the data must not cost anywhere near five times the memory.
    if (scaling !== null && scaling.xlRssGrowth !== null && scaling.xlRssGrowth > SCALING_RSS_GROWTH_LIMIT) {
      summary.warnings.push(`memory grows with the export: ${scaling.xlDataGrowth}x the data cost ${scaling.xlRssGrowth}x the peak RSS (limit ${SCALING_RSS_GROWTH_LIMIT}x)`);
    }
    for (const b of summary.budgets) if (!b.ok) summary.warnings.push(`${b.name}: ${b.actual} ${b.unit} misses the target (${b.target} ${b.unit})`);
    return { summary, workDir: work };
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Output: markdown table and the fixed doc template
// ------------------------------------------------------------------------------------------------------------------

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(n));
const mib = (bytes) => round(bytes / MIB, 1);

function markdownTable(s) {
  const rows = [
    ['Messages / conversations / shards', `${fmt(s.parameters.messages)} / ${fmt(s.parameters.conversations)} / ${s.parameters.shards}`],
    ['Raw text / export JSON / zip', `${mib(s.data.rawTextBytes)} MiB / ${mib(s.data.exportJsonBytes)} MiB / ${mib(s.data.zipBytes)} MiB`],
    ['Import (child process)', `${fmt(s.import.wallMs)} ms, ${fmt(s.import.messagesPerSecond)} messages/s, peak RSS ${s.import.peakRssMiB} MiB`],
    ['Idempotent re-import', `${fmt(s.reimport.wallMs)} ms, peak RSS ${s.reimport.peakRssMiB} MiB`],
    ['Database', `${mib(s.database.bytes)} MiB, ${s.database.ratioToRawText}x raw text${s.database.ftsRatioToRawText === null ? '' : `, FTS index ${s.database.ftsRatioToRawText}x`}`],
    [`Search, all ${s.search.queries} queries`, `p50 ${s.search.p50Ms} ms, p95 ${s.search.p95Ms} ms, max ${s.search.maxMs} ms`],
    ...Object.entries(s.search.byKind).map(([k, v]) => [`  search: ${k} (${v.n})`, `p50 ${v.p50Ms} ms, p95 ${v.p95Ms} ms, max ${v.maxMs} ms; ${v.withHits} with hits, ${v.rejected} rejected`]),
    [`get, ${s.get.n} conversations`, `p50 ${s.get.p50Ms} ms, p95 ${s.get.p95Ms} ms, max ${s.get.maxMs} ms`],
    [`thread, ${s.thread.n} conversations`, `p50 ${s.thread.p50Ms} ms, p95 ${s.thread.p95Ms} ms, max ${s.thread.maxMs} ms`],
    ['stats (ms per group-by)', Object.entries(s.stats).map(([k, v]) => `${k} ${v}`).join(', ')],
    ['audit', `${s.audit.ms} ms`],
    ['Graph build (child process)', `${fmt(s.graphBuild.wallMs)} ms, peak RSS ${s.graphBuild.peakRssMiB} MiB, ${fmt(s.graphBuild.nodes)} nodes, ${fmt(s.graphBuild.edges)} edges`],
  ];
  if (s.scaling !== null) {
    const sc = s.scaling;
    const xl = sc.xlMessages === null ? '' : `; ${fmt(sc.xlMessages)}: ${sc.xlPeakRssMiB} MiB (data x${sc.xlDataGrowth}, RSS x${sc.xlRssGrowth})`;
    rows.push(['Scaling probe', `${fmt(sc.smallMessages)} messages: peak RSS ${sc.smallPeakRssMiB} MiB; ${fmt(sc.largeMessages)}: ${sc.largePeakRssMiB} MiB (data x${sc.dataGrowth}, RSS x${sc.rssGrowth})${xl}`]);
  }
  const lines = ['| Metric | Result |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '', '| Budget | Target | Measured | Status |', '| --- | --- | --- | --- |'];
  for (const b of s.budgets) lines.push(`| ${b.name} | ${b.target} ${b.unit} | ${fmt(b.actual)} ${b.unit} | ${b.ok ? 'ok' : 'WARN'} |`);
  lines.push('', `Environment: Node ${s.environment.node}, ${s.environment.platform} ${s.environment.arch}, ${s.environment.cpuCount} CPUs, load average (1 min) ${s.load.loadAverage1mAtStart} at start and ${s.load.loadAverage1mAtEnd} at end.`);
  return `${lines.join('\n')}\n`;
}

/** The fixed template of docs/PERFORMANCE.md. Everything variable comes from `s`; there is no hostname, user name or path. */
function renderDoc(s) {
  const b = s.budgets;
  const status = (i) => (b[i].ok ? 'met' : 'NOT met');
  const kinds = Object.entries(s.search.byKind).map(([k, v]) => `| ${k} | ${v.n} | ${v.p50Ms} | ${v.p95Ms} | ${v.maxMs} | ${v.withHits} | ${v.rejected} |`);
  const slowestStats = Object.entries(s.stats).sort((a, b) => b[1] - a[1])[0] ?? ['none', 0];
  const loaded = Math.max(s.load.loadAverage1mAtStart, s.load.loadAverage1mAtEnd) >= s.environment.cpuCount;
  const notes = [
    loaded
      ? `The 1-minute load average (${s.load.loadAverage1mAtStart} at the start, ${s.load.loadAverage1mAtEnd} at the end) was at or above the number of CPUs (${s.environment.cpuCount}): other processes were competing for the CPU, so every wall-clock number in this document includes contention. A budget that is not met under such a load is not yet a finding; repeat the run on a quiet machine before acting on it.`
      : `The 1-minute load average (${s.load.loadAverage1mAtStart} at the start, ${s.load.loadAverage1mAtEnd} at the end) stayed below the number of CPUs (${s.environment.cpuCount}), but the script cannot see everything else that ran on the machine.`,
    `The graph build took ${fmt(Math.round(s.graphBuild.wallMs / 100) / 10)} s for ${fmt(s.parameters.messages)} messages (${fmt(s.graphBuild.edges)} edges). The import of the same data took ${fmt(Math.round(s.import.wallMs / 100) / 10)} s. The graph build has no NFR-05 budget because it runs on request (\`gcr graph build\`); \`audit\` (${s.audit.ms} ms) and the slowest \`stats\` group-by (${slowestStats[0]}, ${slowestStats[1]} ms) scan every message.`,
    `The synthetic export has no attachments, no tool messages, no hidden messages and no oversized single message. The numbers say nothing about those paths.`,
  ];
  const scalingSection = (() => {
    const sc = s.scaling;
    if (sc === null) return 'The scaling probe is skipped below 10,000 messages.\n';
    const rows = [[sc.smallMessages, sc.smallPeakRssMiB, sc.smallMessagesPerSecond], [sc.largeMessages, sc.largePeakRssMiB, s.import.messagesPerSecond]];
    if (sc.xlMessages !== null) rows.push([sc.xlMessages, sc.xlPeakRssMiB, sc.xlMessagesPerSecond]);
    const table = `| Messages | Peak RSS of \`gcr import\` (MiB) | Messages per second |\n| --- | --- | --- |\n${rows.map((r) => `| ${fmt(r[0])} | ${r[1]} | ${fmt(r[2])} |`).join('\n')}\n`;
    const growth =
      sc.xlMessages === null
        ? `The data grew ${sc.dataGrowth}x and the peak RSS ${sc.rssGrowth}x. The 5x run was skipped (\`--no-scaling-large\`), so this page shows no evidence about much larger exports.`
        : `From the middle row to the last the data grew ${sc.xlDataGrowth}x and the peak RSS ${sc.xlRssGrowth}x (the run warns above ${SCALING_RSS_GROWTH_LIMIT}x). From the first to the middle row they grew ${sc.dataGrowth}x and ${sc.rssGrowth}x.`;
    return `${table}\n${growth} The importer streams the archive and parses one conversation at a time (docs/ARCHITECTURE.md section 5); what it keeps for the whole run is a small record per conversation (its id and a few fields), so memory is bounded by the number of conversations plus the largest single conversation plus SQLite's cache, not by the size of the export (NFR-05). It is not flat: part of the remaining growth is per-conversation bookkeeping and allocator behaviour that this probe cannot separate. These runs are the evidence, for these sizes only, on synthetic conversations of 100 messages; a conversation far larger than that raises the bound.\n`;
  })();
  return `# GCR performance baseline

Generated by \`npm run perf -- --write-doc --date <date>\` (\`scripts/perf-baseline.mjs\`). **Do not edit the numbers by hand**: re-run the script. The structure of this page is a fixed template in that script.

> **Read this caveat first.** These numbers come from ONE run in ONE shared sandbox with other processes running at the same time, on SYNTHETIC text generated by a seeded PRNG. They are not from a real ChatGPT export, not from a dedicated benchmark machine, and not repeated runs: expect a different machine, a quieter machine or a real export (longer messages, attachments, more branches, much longer words) to give different results. They document the order of magnitude and catch regressions; they are not a guarantee. Speed never fails the build: only correctness does.

## Environment of this run

| Item | Value |
| --- | --- |
| Date | ${s.date} |
| GCR version | ${s.gcrVersion} |
| Node.js | ${s.environment.node} |
| V8 | ${s.environment.v8} |
| SQLite (node:sqlite) | ${s.environment.sqlite} |
| Platform | ${s.environment.platform} ${s.environment.arch} |
| CPUs | ${s.environment.cpuCount} x ${s.environment.cpuModel} |
| Total memory | ${fmt(s.environment.totalMemoryMiB)} MiB |
| Load average (1 min), start / end of the run | ${s.load.loadAverage1mAtStart} / ${s.load.loadAverage1mAtEnd} |
| Free memory at the end | ${fmt(s.load.freeMemoryMiBAtEnd)} MiB |

The load average is the only sign of other activity on the machine that the script records; a load near or above the CPU count means the timings below include contention.

## Method

* **Data.** \`scripts/perf-baseline.mjs\` generates ${fmt(s.parameters.messages)} messages in ${fmt(s.parameters.conversations)} conversations (${s.parameters.messagesPerConversation} messages each) in ${s.parameters.shards} shards (\`conversations-00N.json\`) with a seeded PRNG (seed ${s.parameters.seed}; no \`Math.random\`, no clock): the same seed and size always give byte-identical data (SHA-256 \`${s.data.datasetSha256.slice(0, 16)}...\`) and the same stored counts. Text is pseudo-words with a Zipf-like frequency plus real topic words (for stemming and prefixes), accented words, CJK sentences, URLs, code blocks and emoji; user messages are about 6-70 words, assistant messages 30-220. About every 20th assistant reply is an abandoned regeneration, so the trees branch (${fmt(s.data.abandonedBranches)} abandoned leaves in total) and the length of every active thread is known exactly. Raw message text: ${mib(s.data.rawTextBytes)} MiB; export JSON ${mib(s.data.exportJsonBytes)} MiB; ZIP (DEFLATE, in memory) ${mib(s.data.zipBytes)} MiB.
* **Import, re-import, graph build** run the built CLI (\`dist/cli/main.js\`) as a child process. Wall time includes about 0.1 s of process start. Peak RSS is \`process.resourceUsage().maxRSS\`, written by a tiny \`--require\` hook when the child exits. The children run with \`scripts/no-network-guard.cjs\` preloaded and the run fails if the guard recorded any network attempt.
* **Searches, get, thread, stats, audit** run through the SDK (\`dist/sdk/gcr.js\`, read-only handle) in one measurement worker process, each timed with \`performance.now()\` after five untimed warm-up queries. ${s.search.queries} queries: ${s.search.byKind.word.n} words from the whole frequency range (rare to ubiquitous), ${s.search.byKind.prefix.n} prefixes (\`abc*\`), ${s.search.byKind.phrase.n} phrases (raw FTS5 \`"w1 w2"\`), ${s.search.byKind.cjk.n} CJK substrings of 1-4 characters, ${s.search.byKind.hostile.n} hostile strings (operators, quotes, SQL, NUL, a 5,000-character token, control characters). Page size 20. \`get\` and \`thread\` are timed for the same ${s.parameters.getThreadSample} pseudo-random conversations, and the length of each returned active thread is checked against the generator's.
* **Correctness gates** (the only way the script fails): stored conversation and message counts (import, idempotent re-import, direct row counts), active-thread lengths, stats totals for every group-by, audit counts, queries that must hit, and an empty guard log.

## Results

| Metric | Result |
| --- | --- |
| Import (child process) | ${fmt(s.import.wallMs)} ms = **${fmt(s.import.messagesPerSecond)} messages/s**, peak RSS ${s.import.peakRssMiB} MiB |
| Idempotent re-import | ${fmt(s.reimport.wallMs)} ms, peak RSS ${s.reimport.peakRssMiB} MiB, \`alreadyImported: ${s.reimport.alreadyImported}\` |
| Database file | ${mib(s.database.bytes)} MiB = **${s.database.ratioToRawText}x** the raw message text |
| Of which FTS5 index | ${s.database.ftsBytes === null ? 'not available (SQLite built without dbstat)' : `${mib(s.database.ftsBytes)} MiB = ${s.database.ftsRatioToRawText}x the raw text`} |
| Of which messages table and its indexes | ${s.database.messagesTableBytes === null ? 'not available' : `${mib(s.database.messagesTableBytes)} MiB`} |
| get (${s.get.n} conversations) | p50 ${s.get.p50Ms} ms, p95 ${s.get.p95Ms} ms, max ${s.get.maxMs} ms |
| thread (${s.thread.n} conversations) | p50 ${s.thread.p50Ms} ms, p95 ${s.thread.p95Ms} ms, max ${s.thread.maxMs} ms |
| stats (ms) | ${Object.entries(s.stats).map(([k, v]) => `${k} ${v}`).join(', ')} |
| audit | ${s.audit.ms} ms |
| Graph build (child process) | ${fmt(s.graphBuild.wallMs)} ms, peak RSS ${s.graphBuild.peakRssMiB} MiB, ${fmt(s.graphBuild.nodes)} nodes, ${fmt(s.graphBuild.edges)} edges |
| Peak RSS, measurement worker | ${s.measurementWorker.peakRssMiB} MiB |

### Search latency (${s.search.queries} queries, page size 20)

| Query kind | Queries | p50 (ms) | p95 (ms) | max (ms) | With hits | Rejected |
| --- | --- | --- | --- | --- | --- | --- |
| **all** | ${s.search.queries} | ${s.search.p50Ms} | **${s.search.p95Ms}** | ${s.search.maxMs} | | ${s.search.rejected} |
${kinds.join('\n')}

"Rejected" means the product answered with a documented error code (for example an empty or punctuation-only query is \`INVALID_ARGUMENT\`); it is not a failure. Every non-hostile query must hit, and the run fails otherwise.

### Memory against export size

${scalingSection}
## Budgets (the NFR-05 baseline targets) and why these numbers

| Budget | Target | Measured | Verdict |
| --- | --- | --- | --- |
| Import throughput | >= ${fmt(BUDGETS.importMessagesPerSecond)} messages/s | ${fmt(b[0].actual)} messages/s | ${status(0)} |
| Search latency p95 | < ${BUDGETS.searchP95Ms} ms | ${b[1].actual} ms | ${status(1)} |
| Peak RSS of any child process | < ${BUDGETS.peakRssMiB} MiB | ${b[2].actual} MiB | ${status(2)} |
| ${b[3].name} | <= ${BUDGETS.databaseToTextRatio}x | ${b[3].actual}x | ${status(3)} |

* **Import >= 10,000 messages/s.** A heavy personal export has tens of thousands of messages; at this rate 50,000 messages import in about five seconds, so \`gcr import\` stays an interactive command and a very large export (500,000 messages) finishes in under a minute. Below this rate the import becomes the slowest step of a workflow and people stop re-importing to keep the database current.
* **Search p95 < 100 ms.** About 100 ms is the commonly used limit under which an interactive answer feels immediate. The CLI and the MCP server answer a model or a person one query at a time, so the tail (p95) matters more than the mean; the budget is on all ${s.search.queries} varied queries, not only the easy ones.
* **Peak RSS < ${BUDGETS.peakRssMiB} MiB.** GCR runs on a developer laptop, a small CI runner or a Codespace next to an editor and a model client; 600 MiB leaves room on a machine with 2 GiB of free memory. NFR-05 asks for bounded memory: the scaling probe above is the evidence for the shape (memory bounded by the number of conversations and the largest conversation, not by the size of the export), the budget is the absolute ceiling for one process at 50,000 messages.
* **FTS index <= 3x the raw text.** \`docs/ARCHITECTURE.md\` fixes "about 3x the raw text size" for the INDEX so that search does not multiply the size of a large export. The whole database file is larger because it also keeps the original message JSON (\`raw_source_json\`) and the block list next to the normalized text (provenance is never discarded); that whole-file ratio is reported in the results table so nobody has to guess what the file costs.

The four targets are engineering judgment, not measured user requirements; changing one needs an ADR, not a quiet edit of this script.

A budget that is "NOT met" is a WARN line on stderr and a row in this table, not a failing build: it is a prompt to look at the change that caused it, or to revisit the budget in an ADR.

## Notes on this run

${notes.map((n) => `* ${n}`).join('\n')}

## Reproduce

\`\`\`bash
npm run perf                                    # the table and the JSON summary
node scripts/perf-baseline.mjs --json           # the JSON summary only
node scripts/perf-baseline.mjs --messages 2000  # a quick run (seconds)
npm run perf -- --write-doc --date 2026-01-31   # rewrite this page (pass the date: the script never reads the clock)
\`\`\`
`;
}

// ------------------------------------------------------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (opts.worker !== null) {
  await runWorker(opts);
} else {
  let result;
  try {
    result = await main(opts);
  } catch (e) {
    process.stderr.write(`perf-baseline: failed unexpectedly (${e?.name ?? 'error'}${typeof e?.code === 'string' ? `, ${e.code}` : ''}).\n`);
    process.exit(2);
  }
  const { summary, workDir } = result;
  if (opts.keepDb) process.stderr.write(`perf-baseline: kept perf.sqlite in a temp directory named ${basename(workDir)}\n`);
  else rmSync(workDir, { recursive: true, force: true });

  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else process.stdout.write(`${markdownTable(summary)}\nJSON summary:\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`);
  if (opts.writeDoc) {
    writeFileSync(opts.doc, renderDoc(summary));
    process.stderr.write(`perf-baseline: wrote ${basename(opts.doc)}\n`);
  }
  for (const w of summary.warnings) process.stderr.write(`WARN ${w}\n`);
  for (const f of summary.correctness.failures) process.stderr.write(`FAIL ${f}\n`);
  process.exitCode = summary.correctness.ok ? 0 : 1;
}
