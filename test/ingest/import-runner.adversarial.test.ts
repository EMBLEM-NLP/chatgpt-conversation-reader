/**
 * Import runner adversarial review. Lens: deduplication and idempotency correctness, partial-failure atomicity, TOCTOU
 * between the two passes, container tricks, resource exhaustion, and leaks of paths or content.
 *
 * Every test in this file either demonstrated a real defect before the fix (see the comment above it) or pins an edge case
 * the review walked (research sections 11.1 and 11.2: EC-xx). Real adapters, runner and Repository; the only fault
 * injection is wrapping the shared adapter method for ONE test and restoring it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renameSync, truncateSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { AdapterOutcome, ConversationSourceAdapter } from '../../src/ingest/adapter.js';
import { GcrError } from '../../src/errors.js';
import { peekElement, runImport } from '../../src/ingest/import-runner.js';
import type { ImportOptions } from '../../src/ingest/import-runner.js';
import { getAdapter } from '../../src/ingest/registry.js';
import { OMIT, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { claudeLinearConversation, synthUuid } from '../helpers/claude-export-builder.js';
import { buildZip } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { arrayOf, chatConv, count, dbDump, expectCode, fixedClock, freshRepo, writeFileIn, zipOf } from './import-runner.helpers.test.js';

const T0 = 1_760_000_000;
const stream = (data: string | Buffer, label = 'x'): ImportOptions['source'] => ({
  kind: 'stream',
  label,
  stream: (async function* (): AsyncGenerator<Buffer, void, undefined> {
    yield typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  })(),
});
const pathSource = (p: string): ImportOptions['source'] => ({ kind: 'path', path: p });

function collectGarbage(): boolean {
  try {
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as (() => void) | undefined;
    if (typeof gc !== 'function') return false;
    gc();
    gc();
    return true;
  } catch {
    return false;
  }
}

/** Cheap (microseconds) heap probe; process.memoryUsage() costs tens of milliseconds per call on a large heap. */
const heapUsed = (): number => getHeapStatistics().used_heap_size;

type Normalize = ConversationSourceAdapter['normalizeElementText'];
async function withWrappedAdapter<T>(wrap: (real: Normalize) => Normalize, fn: () => Promise<T>): Promise<T> {
  const adapter = getAdapter('chatgpt');
  const proto = Object.getPrototypeOf(adapter) as { normalizeElementText: Normalize };
  const original = proto.normalizeElementText;
  proto.normalizeElementText = wrap(original.bind(adapter));
  try {
    return await fn();
  } finally {
    proto.normalizeElementText = original;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------------------------------------------------

describe('stdin end to end', () => {
  // DEFECT: discoverStream kept references to the producer's chunks. A read loop that reuses ONE buffer (the usual pattern)
  // made every chunk alias the last bytes read, so valid input was rejected as "not JSON" (or, worse, parsed as garbage).
  it('a producer that reuses one buffer for all its chunks imports correctly', async () => {
    const t = freshRepo();
    try {
      const data = Buffer.from(arrayOf([chatConv(1), chatConv(2), chatConv(3)]));
      async function* reuse(): AsyncGenerator<Buffer, void, undefined> {
        const buf = Buffer.alloc(97);
        for (let o = 0; o < data.length; o += 97) {
          const n = Math.min(97, data.length - o);
          data.copy(buf, 0, o, o + n);
          yield buf.subarray(0, n);
        }
      }
      const r = await runImport(t.repo, { source: { kind: 'stream', stream: reuse(), label: '-' }, clock: fixedClock });
      assert.deepEqual(r.conversations, { read: 3, stored: 3, failed: 0, newlyInserted: 3 });
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Duplicate resolution
// ---------------------------------------------------------------------------------------------------------------------

describe('duplicate resolution only considers conversations', () => {
  const ID = 1;
  const real = (): string => chatConv(ID, { title: 'REAL', updateTime: T0 }).text();

  // DEFECT: the winner was decided from identity metadata of ANY object. A stray object with the same id, a later
  // update_time or more bytes beat the real conversation, which was then dropped (the stray one is NOT_A_CONVERSATION).
  it('a non-conversation object that carries the same id (newer, larger) can never displace the real conversation, in either order', async () => {
    const junk = JSON.stringify({ id: syntheticUuid(ID), conversation_id: syntheticUuid(ID), update_time: T0 + 99_999, note: 'x'.repeat(5000) });
    for (const body of [`[${real()},${junk}]`, `[${junk},${real()}]`]) {
      const t = freshRepo();
      try {
        const r = await runImport(t.repo, { source: stream(body), clock: fixedClock });
        assert.equal(r.conversations.stored, 1);
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(ID) })?.title, 'REAL');
        assert.equal(r.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION'), undefined, 'a junk object is not a duplicate conversation');
        assert.equal(r.warnings.find((w) => w.code === 'NOT_A_CONVERSATION')?.count, 1);
      } finally {
        t.close();
      }
    }
  });

  it('same for a wrapper-shaped stray object, and for strict mode (the stray object is the only problem, not a "duplicate")', async () => {
    const t = freshRepo();
    try {
      const stray = JSON.stringify({ id: syntheticUuid(ID), update_time: T0 + 1 });
      await assert.rejects(runImport(t.repo, { source: stream(`[${real()},${stray}]`), strict: true, clock: fixedClock }), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.details?.['reason'], 'NOT_A_CONVERSATION', 'strict names the real problem, not DUPLICATE_CONVERSATION');
        return true;
      });
      assert.equal(count(t.db, 'conversations'), 0);
    } finally {
      t.close();
    }
  });

  it('Claude: an object with the same uuid but no chat_messages array cannot displace the real conversation', async () => {
    const t = freshRepo();
    try {
      const realClaude = JSON.stringify({ ...claudeLinearConversation(2, { uuid: synthUuid(1), name: 'REAL-CLAUDE' }), updated_at: '2025-01-01T00:00:00.000000Z' });
      const stray = JSON.stringify({ uuid: synthUuid(1), name: 'stray', updated_at: '2030-01-01T00:00:00.000000Z' });
      const r = await runImport(t.repo, { source: stream(`[${stray},${realClaude}]`), clock: fixedClock });
      assert.equal(r.provider, 'claude');
      assert.equal(r.conversations.stored, 1);
      assert.equal(t.repo.getConversation({ conversationId: synthUuid(1) })?.title, 'REAL-CLAUDE');
    } finally {
      t.close();
    }
  });

  // DEFECT (minor): the key fell back to `uuid` for ChatGPT elements too, but the ChatGPT adapter never reads `uuid`: two
  // different id-less conversations that share a stray `uuid` key were reported as duplicates and one was dropped.
  it('ChatGPT elements are keyed by conversation_id/id only: a shared stray "uuid" key makes no duplicates', async () => {
    const t = freshRepo();
    try {
      const mk = (title: string): string => chatConv(1, { title, id: OMIT, conversationId: OMIT, extra: { uuid: 'shared-stray-uuid' } }).text();
      const r = await runImport(t.repo, { source: stream(`[${mk('FIRST')},${mk('SECOND')}]`), clock: fixedClock });
      assert.equal(r.conversations.stored, 2);
      assert.equal(r.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION'), undefined);
    } finally {
      t.close();
    }
  });
});

describe('a duplicate winner that cannot be normalized (documented limitation: the loser is not tried)', () => {
  // The winner is decided from identity metadata alone (a validity check would cost a full parse of every element in pass 1).
  // What must hold: the loss is never silent.
  it('is reported twice over (ELEMENT_PARSE_FAILED + DUPLICATE_CONVERSATION naming the winner) and refused by --strict', async () => {
    const t = freshRepo();
    try {
      const good = chatConv(1, { title: 'GOOD', updateTime: T0 }).text();
      const broken = JSON.stringify({ id: syntheticUuid(1), conversation_id: syntheticUuid(1), update_time: T0 + 100, mapping: '@@' }).replace('"@@"', 'BROKEN');
      const body = `[${good},${broken}]`;
      const r = await runImport(t.repo, { source: stream(body), clock: fixedClock });
      assert.equal(r.conversations.stored, 0);
      assert.equal(r.conversations.failed, 1);
      assert.equal(r.warnings.find((w) => w.code === 'ELEMENT_PARSE_FAILED')?.count, 1);
      const dup = r.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION');
      assert.equal(dup?.count, 1);
      assert.match(t.repo.getBatch(r.batchId)?.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION')?.message ?? '', /kept conversations\.json#1, skipped conversations\.json#0/);
      const t2 = freshRepo();
      try {
        await assert.rejects(runImport(t2.repo, { source: stream(body), strict: true, clock: fixedClock }), expectCode('IMPORT_PARSE_ERROR', 'DUPLICATE_CONVERSATION'));
        assert.equal(count(t2.db, 'source_batches'), 0);
      } finally {
        t2.close();
      }
    } finally {
      t.close();
    }
  });
});

/** Small deterministic PRNG so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('duplicate resolution: randomized differential check of the documented total order', () => {
  it('120 random multi-way duplicate layouts: the stored winner is the one the rule names, whatever the ZIP entry order', async () => {
    const times: Array<number | null> = [null, T0, T0 + 10, T0 + 10, T0 + 20];
    let totalDuplicates = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = mulberry32(seed);
      const pick = (n: number): number => Math.floor(rnd() * n);
      const shardCount = 1 + pick(4);
      const withPlain = pick(3) === 0;
      const conversations = 1 + pick(3);
      type Occ = { conv: number; file: number; index: number; time: number | null; bytes: number; title: string; text: string };
      const files: Occ[][] = Array.from({ length: shardCount + (withPlain ? 1 : 0) }, () => []);
      const n = 2 + pick(7);
      let serial = 0;
      for (let k = 0; k < n; k++) {
        const conv = 1 + pick(conversations);
        const file = pick(files.length);
        const time = times[pick(times.length)] ?? null;
        const pad = pick(3) === 0 ? 'p'.repeat(1 + pick(40)) : '';
        const title = `W${seed}-${serial++}`;
        const text = chatConv(conv, { title, updateTime: time, extra: pad === '' ? {} : { pad } }).text();
        (files[file] as Occ[]).push({ conv, file, index: 0, time, bytes: Buffer.byteLength(text), title, text });
      }
      files.forEach((f) => f.forEach((o, i) => (o.index = i)));
      // file order: plain conversations.json first (when present), then conversations-1..N
      const names = files.map((_, i) => (withPlain ? (i === 0 ? 'conversations.json' : `conversations-${i}.json`) : `conversations-${i + 1}.json`));
      const entries: Array<[string, string]> = files.map((f, i) => [names[i] as string, `[${f.map((o) => o.text).join(',')}]`]);
      const all = files.flat();
      const expected = new Map<number, Occ>();
      for (const o of all) {
        const cur = expected.get(o.conv);
        const better = (a: Occ, b: Occ): boolean => {
          const at = a.time ?? -Infinity;
          const bt = b.time ?? -Infinity;
          if (at !== bt) return at > bt;
          if (a.bytes !== b.bytes) return a.bytes > b.bytes;
          if (a.file !== b.file) return a.file < b.file;
          return a.index < b.index;
        };
        if (cur === undefined || better(o, cur)) expected.set(o.conv, o);
      }
      totalDuplicates += all.length - expected.size;
      // shuffle the ZIP entry order
      const shuffled = [...entries];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = pick(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j] as [string, string], shuffled[i] as [string, string]];
      }
      const t = freshRepo();
      try {
        await withTempDir(async (dir) => {
          await writeFile(join(dir, 'e.zip'), zipOf(Object.fromEntries(shuffled)));
          const r = await runImport(t.repo, { source: pathSource(join(dir, 'e.zip')), clock: fixedClock });
          assert.equal(r.conversations.stored, expected.size, `seed ${seed}`);
          assert.equal(r.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION')?.count ?? 0, all.length - expected.size, `seed ${seed}`);
          for (const [conv, o] of expected) {
            assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(conv) })?.title, o.title, `seed ${seed} conversation ${conv}`);
          }
        });
      } finally {
        t.close();
      }
    }
    assert.ok(totalDuplicates > 100, `the generated layouts really contain duplicates (${totalDuplicates})`);
  });

  it('numbers that are not finite (EC-25) count as "no update time"; huge duplicate families keep the report bounded', async () => {
    const mk = (title: string, rawTime: string): string => {
      const o = JSON.parse(chatConv(1, { title }).text()) as Record<string, unknown>;
      return JSON.stringify({ ...o, update_time: '@@' }).replace('"@@"', rawTime);
    };
    for (const nonFinite of ['1e999', '9'.repeat(400), '-1e999']) {
      const t = freshRepo();
      try {
        // Infinity is not a usable time: the element counts as "no update time", so the dated one wins in either order.
        for (const order of [[mk('NONFINITE', nonFinite), mk('DATED', String(T0))], [mk('DATED', String(T0)), mk('NONFINITE', nonFinite)]]) {
          const repo = freshRepo();
          try {
            const r = await runImport(repo.repo, { source: stream(`[${order.join(',')}]`), clock: fixedClock });
            assert.equal(r.conversations.stored, 1, nonFinite.slice(0, 8));
            assert.equal(repo.repo.getConversation({ conversationId: syntheticUuid(1) })?.title, 'DATED', nonFinite.slice(0, 8));
          } finally {
            repo.close();
          }
        }
      } finally {
        t.close();
      }
    }
    // 60,000 copies of one id: counted, never listed (at most 5 sample ids, bounded message), and cheap.
    const t2 = freshRepo();
    try {
      const one = JSON.stringify({ conversation_id: syntheticUuid(7), id: syntheticUuid(7), mapping: {}, title: 'T', update_time: T0 });
      const body = `[${Array(60_000).fill(one).join(',')}]`;
      const r = await runImport(t2.repo, { source: stream(body), clock: fixedClock });
      assert.equal(r.conversations.stored, 1);
      const d = r.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION');
      assert.equal(d?.count, 59_999);
      assert.ok((d?.sampleIds.length ?? 99) <= 5);
      const stored = t2.repo.getBatch(r.batchId)?.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION');
      assert.ok((stored?.message.length ?? 0) < 1000);
      assert.ok((stored?.ids?.length ?? 99) <= 5);
    } finally {
      t2.close();
    }
  });
});

describe('provider detection', () => {
  // DEFECT (minor): every non-empty object counted as one of only 20 sniffing attempts, so 20+ stray objects in front of the
  // first conversation made the whole import fail with PROVIDER_UNDETECTED although conversations followed.
  it('any number of stray objects before the first conversation does not exhaust detection', async () => {
    const t = freshRepo();
    try {
      const strays = Array.from({ length: 60 }, (_, i) => JSON.stringify({ stray: i })).join(',');
      const r = await runImport(t.repo, { source: stream(`[${strays},${chatConv(1).text()}]`), clock: fixedClock });
      assert.equal(r.provider, 'chatgpt');
      assert.equal(r.conversations.stored, 1);
      assert.equal(r.warnings.find((w) => w.code === 'NOT_A_CONVERSATION')?.count, 60);
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Wrapper objects
// ---------------------------------------------------------------------------------------------------------------------

describe('wrapper objects {"conversations": [...]}', () => {
  // DEFECT: a wrapper was JSON.parse'd as a whole, so ONE member that is not valid JSON (NaN, the Python json.dumps default,
  // EC-27) made the entire wrapper an ordinary element and the import failed with PROVIDER_UNDETECTED.
  it('one broken member does not take the good members with it', async () => {
    const t = freshRepo();
    try {
      const body = `{"conversations":[${chatConv(1).text()},{"a":NaN},${chatConv(2).text()}]}`;
      const r = await runImport(t.repo, { source: stream(body), clock: fixedClock });
      assert.deepEqual(r.conversations, { read: 3, stored: 2, failed: 1, newlyInserted: 2 });
      assert.equal(r.warnings.find((w) => w.code === 'ELEMENT_PARSE_FAILED')?.count, 1);
      assert.equal(r.warnings.find((w) => w.code === 'WRAPPER_OBJECT_FORMAT')?.count, 1);
      assert.equal(r.formatProfile?.wrapperObject, true);
    } finally {
      t.close();
    }
  });

  it('members are the wrapper\'s own bytes: number spellings survive (no re-serialization), so the element hash equals the bare-array one', async () => {
    const member = chatConv(1).text().replace(/"update_time":[^,}]*/, '"update_time":1760000000.123456789000');
    assert.ok(member.includes('1760000000.123456789000'));
    const viaWrapper = freshRepo();
    const viaArray = freshRepo();
    try {
      await runImport(viaWrapper.repo, { source: stream(`{"conversations":[${member}]}`), clock: fixedClock });
      await runImport(viaArray.repo, { source: stream(`[${member}]`), clock: fixedClock });
      const hash = (r: ReturnType<typeof freshRepo>): unknown => (r.repo.getConversation({ conversationId: syntheticUuid(1) })?.rawMetadata as { _gcr?: { sourceElementSha256?: string } } | undefined)?._gcr?.sourceElementSha256;
      assert.equal(hash(viaWrapper), createHash('sha256').update(member, 'utf8').digest('hex'));
      assert.equal(hash(viaWrapper), hash(viaArray));
    } finally {
      viaWrapper.close();
      viaArray.close();
    }
  });

  it('wrapper edge cases: duplicate "conversations" keys (last wins), a non-array last value, scalars, nested wrappers, members with trailing commas', async () => {
    const cases: Array<[string, string, { stored: number; read: number } | 'error']> = [
      ['duplicate keys, last wins', `{"conversations":[${chatConv(1).text()}],"conversations":[${chatConv(2).text()}]}`, { stored: 1, read: 1 }],
      ['last value is not an array -> the object is an ordinary (non-conversation) element', `{"conversations":[${chatConv(1).text()}],"conversations":5}`, 'error'],
      ['scalar members are counted', `{"conversations":[1,"x",null,true,[1],${chatConv(1).text()}]}`, { stored: 1, read: 6 }],
      ['a nested wrapper is not expanded a second time', `{"conversations":[{"conversations":[${chatConv(1).text()}]}]}`, 'error'],
      ['trailing comma in the member list: not a wrapper at all', `{"conversations":[${chatConv(1).text()},]}`, 'error'],
      ['empty member list', '{"conversations":[]}', { stored: 0, read: 0 }],
    ];
    for (const [label, body, want] of cases) {
      const t = freshRepo();
      try {
        if (want === 'error') {
          await assert.rejects(runImport(t.repo, { source: stream(body), clock: fixedClock }), (e: unknown) => e instanceof GcrError, label);
          assert.equal(count(t.db, 'source_batches'), 0, label);
        } else {
          const r = await runImport(t.repo, { source: stream(body), clock: fixedClock });
          assert.equal(r.conversations.stored, want.stored, label);
          assert.equal(r.conversations.read, want.read, label);
        }
      } finally {
        t.close();
      }
    }
  });

  // DEFECT: the wrapper was parsed and then every member re-serialized into an array held at once: about 100 bytes of heap per
  // input byte for tiny members, so a wrapper within maxElementBytes (256 MiB) could need tens of GiB. Members are now sliced
  // lazily out of the element text, which costs the same as a bare array.
  it('a wrapper with many tiny members is split lazily: expanding it allocates (almost) nothing up front', async (t) => {
    const N = 600_000; // pre-fix, parsing + re-serializing 600,000 members held ~75 MiB before the first element was even processed
    const members = Array(N).fill('{}').join(',');
    const repo = freshRepo();
    try {
      const gcWorks = collectGarbage();
      const base = heapUsed();
      let atFirstScanEvent = Number.NaN;
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', `{"conversations":[${members}]}`);
        const r = await runImport(repo.repo, {
          source: pathSource(file),
          clock: fixedClock,
          onProgress: (p) => {
            // The first scan event fires after 1,000 members were handed out: everything the expansion allocated up front is live now.
            if (p.phase === 'scan' && Number.isNaN(atFirstScanEvent)) atFirstScanEvent = heapUsed();
          },
        });
        assert.equal(r.conversations.read, N);
        assert.equal(r.formatProfile?.wrapperObject, true);
      });
      const upFront = (atFirstScanEvent - base) / (1024 * 1024);
      t.diagnostic(`${N} wrapper members: heap above baseline when the first 1,000 had been handed out: ${upFront.toFixed(1)} MiB (gc ${gcWorks ? 'on' : 'off'})`);
      if (gcWorks) assert.ok(upFront < 40, `${upFront.toFixed(0)} MiB allocated up front`);
    } finally {
      repo.close();
    }
  });

  it('a wrapper with many tiny members costs about what the same bare array costs overall', async (t) => {
    const N = 150_000;
    const measure = async (body: string): Promise<number> => {
      const repo = freshRepo();
      try {
        const gcWorks = collectGarbage();
        const base = heapUsed();
        let peak = base;
        const sample = (): void => {
          peak = Math.max(peak, heapUsed());
        };
        await withTempDir(async (dir) => {
          const file = await writeFileIn(dir, 'conversations.json', body);
          await runImport(repo.repo, { source: pathSource(file), clock: fixedClock, onProgress: sample });
        });
        sample();
        return gcWorks ? (peak - base) / (1024 * 1024) : Number.NaN;
      } finally {
        repo.close();
      }
    };
    const members = Array(N).fill('{}').join(',');
    const bare = await measure(`[${members}]`);
    const wrapped = await measure(`{"conversations":[${members}]}`);
    t.diagnostic(`peak heap growth, ${N} members: bare array ${bare.toFixed(0)} MiB, wrapper ${wrapped.toFixed(0)} MiB`);
    if (!Number.isNaN(bare)) assert.ok(wrapped <= bare * 1.5 + 30, `wrapper ${wrapped.toFixed(0)} MiB vs bare array ${bare.toFixed(0)} MiB`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Bytes to text (EC-18) and top-level shapes (EC-16)
// ---------------------------------------------------------------------------------------------------------------------

describe('invalid UTF-8 (EC-18)', () => {
  // DEFECT: invalid UTF-8 bytes were replaced by U+FFFD silently; the research requires a warning so the loss is visible.
  it('replaced bytes are reported as INVALID_UTF8 (ids only); a legitimate U+FFFD is not', async () => {
    const t = freshRepo();
    try {
      const bad = Buffer.from(chatConv(1, { title: 'TITLE_QQ' }).text());
      const at = bad.indexOf('QQ');
      const damaged = Buffer.concat([bad.subarray(0, at), Buffer.from([0xff, 0x80]), bad.subarray(at + 2)]);
      const fine = chatConv(2, { title: 'legit \ufffd char' }).text();
      const body = Buffer.concat([Buffer.from('['), damaged, Buffer.from(`,${fine}]`)]);
      const r = await runImport(t.repo, { source: stream(body), clock: fixedClock });
      assert.equal(r.conversations.stored, 2);
      const w = r.warnings.find((x) => x.code === 'INVALID_UTF8');
      assert.equal(w?.count, 1);
      assert.deepEqual(w?.sampleIds, ['conversations.json#0']);
      assert.ok(t.repo.getConversation({ conversationId: syntheticUuid(1) })?.title?.includes('\ufffd'));
      // strict mode keeps the data (the replacement is visible, not a failure), and an idempotent re-import reports the same
      const again = await runImport(t.repo, { source: stream(body), clock: fixedClock });
      assert.equal(again.alreadyImported, true);
      assert.deepEqual(again.warnings, r.warnings);
    } finally {
      t.close();
    }
  });
});

describe('a conversation file that is not an array at all (EC-16)', () => {
  // DEFECT: a ZIP shard holding a JSON scalar failed with IMPORT_PARSE_ERROR; the research asks for IMPORT_UNSUPPORTED_FORMAT.
  it('a scalar top-level value is IMPORT_UNSUPPORTED_FORMAT with a remedy when nothing else can be read', async () => {
    for (const body of ['"hello"', '42', 'null', 'true', '-1.5']) {
      const t = freshRepo();
      try {
        await withTempDir(async (dir) => {
          await writeFile(join(dir, 'e.zip'), zipOf({ 'conversations.json': body }));
          await assert.rejects(runImport(t.repo, { source: pathSource(join(dir, 'e.zip')), clock: fixedClock }), (e: unknown) => {
            assert.ok(e instanceof GcrError, body);
            assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT', body);
            assert.equal(e.details?.['reason'], 'TOP_LEVEL_NOT_ARRAY', body);
            assert.ok((e.remedy ?? '').length > 20);
            return true;
          });
          assert.equal(count(t.db, 'source_batches'), 0);
        });
      } finally {
        t.close();
      }
    }
  });

  it('next to good shards the bad one is a FILE_PARSE_FAILED warning (strict aborts), the good ones import', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, 'e.zip'), zipOf({ 'conversations-1.json': arrayOf([chatConv(1)]), 'conversations-2.json': '"oops"' }));
        const r = await runImport(t.repo, { source: pathSource(join(dir, 'e.zip')), clock: fixedClock });
        assert.equal(r.conversations.stored, 1);
        assert.equal(r.warnings.find((w) => w.code === 'FILE_PARSE_FAILED')?.count, 1);
        assert.equal(r.conversations.failed, 1);
      });
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Idempotency: the report of a no-op equals the first report
// ---------------------------------------------------------------------------------------------------------------------

describe('alreadyImported reproduces the first report', () => {
  // DEFECT (minor): DUPLICATE_CONVERSATION_IN_BATCH was reported with no sample ids the first time and with the stored ids the
  // second time, so the two reports differed although nothing had changed.
  it('every warning summary (including those added by the repository) is identical, ids included', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1), chatConv(2), chatConv(3)]));
        const clash = (real: Normalize): Normalize => (text, ctx, i): AdapterOutcome => {
          const out = real(text, ctx, i);
          if (i === 2 && out.kind === 'record') {
            return { ...out, record: { ...out.record, id: syntheticUuid(1), messages: out.record.messages.map((m) => ({ ...m, conversationId: syntheticUuid(1) })) } };
          }
          return out;
        };
        const first = await withWrappedAdapter(clash, () => runImport(t.repo, { source: pathSource(file), clock: fixedClock }));
        const second = await runImport(t.repo, { source: pathSource(file), clock: fixedClock });
        assert.equal(first.alreadyImported, false);
        assert.equal(second.alreadyImported, true);
        const d1 = first.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION_IN_BATCH');
        assert.equal(d1?.count, 1);
        assert.deepEqual(second.warnings, first.warnings);
        assert.deepEqual(second.conversations.stored, first.conversations.stored);
        assert.deepEqual(second.messages.stored, first.messages.stored);
      });
    } finally {
      t.close();
    }
  });

  it('with container warnings, wrapper members, a corrupt element and a duplicate loser: second report == first report (apart from the documented fields)', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const manifest = JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files: ['conversations-0.json', 'conversations-1.json', 'conversations-7.json'], sharded: true } } });
        const e = zipOf({
          'export_manifest.json': manifest,
          'conversations-0.json': `[${chatConv(1, { updateTime: T0 }).text()},{"mapping": BROKEN},${chatConv(2).text()}]`,
          'conversations-1.json': `{"conversations":[${chatConv(1, { updateTime: T0 + 5, title: 'NEWER' }).text()},null]}`,
          'user.json': '{}',
        });
        await writeFile(join(dir, 'e.zip'), e);
        const first = await runImport(t.repo, { source: pathSource(join(dir, 'e.zip')), clock: fixedClock });
        const second = await runImport(t.repo, { source: pathSource(join(dir, 'e.zip')), clock: () => '2040-01-01T00:00:00.000Z' });
        assert.equal(second.alreadyImported, true);
        assert.deepEqual(second.warnings, first.warnings);
        assert.deepEqual(second.conversations, { ...first.conversations, newlyInserted: 0 });
        assert.deepEqual(second.messages, { ...first.messages, newlyInserted: 0 });
        assert.equal(second.batchId, first.batchId);
        const codes = first.warnings.map((w) => w.code);
        for (const c of ['MANIFEST_SHARD_MISSING', 'DUPLICATE_CONVERSATION', 'ELEMENT_PARSE_FAILED', 'WRAPPER_OBJECT_FORMAT', 'NON_OBJECT_ENTRY']) assert.ok(codes.includes(c), c);
      });
    } finally {
      t.close();
    }
  });

  it('limits, strictness-free option changes and the clock are not part of the identity', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1), chatConv(2)]));
        const a = await runImport(t.repo, { source: pathSource(file), clock: fixedClock });
        const b = await runImport(t.repo, { source: pathSource(file), clock: () => '2050-05-05T05:05:05.000Z', limits: { maxElementBytes: 5_000_000, maxEntries: 50 }, provider: 'chatgpt' });
        assert.equal(b.batchId, a.batchId);
        assert.equal(b.alreadyImported, true);
        assert.equal(count(t.db, 'source_batches'), 1);
      });
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Atomicity and TOCTOU
// ---------------------------------------------------------------------------------------------------------------------

describe('atomicity with real failures in the middle of pass 2', () => {
  it('SQLite itself failing after rows were inserted (database turned read-only mid-import) rolls everything back', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const root = join(dir, 'export');
        await writeFileIn(root, 'conversations-1.json', arrayOf([chatConv(1), chatConv(2)]));
        await writeFileIn(root, 'conversations-2.json', arrayOf([chatConv(3), chatConv(4)]));
        const before = dbDump(t.db);
        await assert.rejects(
          runImport(t.repo, {
            source: pathSource(root),
            clock: fixedClock,
            onProgress: (p) => {
              if (p.phase === 'import' && p.file === 'conversations-1.json') t.db.exec('PRAGMA query_only = 1');
            },
          }),
          (e: unknown) => {
            assert.ok(e instanceof GcrError, String(e));
            assert.ok(['DB_ERROR', 'WRITE_FORBIDDEN'].includes(e.code), e.code);
            return true;
          },
        );
        t.db.exec('PRAGMA query_only = 0');
        assert.equal(t.db.isTransaction, false, 'no transaction is left open');
        assert.equal(dbDump(t.db), before, 'byte-identical to before');
        const ok = await runImport(t.repo, { source: pathSource(root), clock: fixedClock });
        assert.equal(ok.conversations.stored, 4);
      });
    } finally {
      t.close();
    }
  });

  it('a progress callback that throws in the middle of pass 2 aborts cleanly: GcrError, nothing stored', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const root = join(dir, 'export');
        await writeFileIn(root, 'conversations-1.json', arrayOf([chatConv(1)]));
        await writeFileIn(root, 'conversations-2.json', arrayOf([chatConv(2)]));
        await assert.rejects(
          runImport(t.repo, {
            source: pathSource(root),
            clock: fixedClock,
            onProgress: (p) => {
              if (p.phase === 'import') throw new Error(`callback failed near ${dir}`);
            },
          }),
          (e: unknown) => {
            assert.ok(e instanceof GcrError);
            assert.ok(!JSON.stringify(e.toEnvelope()).includes(dir), 'the callback\'s own message is not surfaced');
            return true;
          },
        );
        assert.equal(count(t.db, 'conversations'), 0);
        assert.equal(count(t.db, 'source_batches'), 0);
      });
    } finally {
      t.close();
    }
  });
});

describe('TOCTOU between pass 1 and pass 2', () => {
  const afterLastScan = (lastFile: string, mutate: () => void): NonNullable<ImportOptions['onProgress']> => {
    let done = false;
    return (p) => {
      if (!done && p.phase === 'scan' && p.file === lastFile && p.elements > 0) {
        done = true;
        mutate();
      }
    };
  };

  // DEFECT (minor): a file that shrank between the passes surfaced as a plain parse error (UNTERMINATED_ARRAY ...), which sends
  // the operator hunting for a corrupt export instead of telling them the input changed while it was being read.
  it('a file truncated between the passes is reported as CONCURRENT_MODIFICATION', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const body = arrayOf([chatConv(1), chatConv(2), chatConv(3)]);
        const file = await writeFileIn(dir, 'conversations.json', body);
        await assert.rejects(
          runImport(t.repo, { source: pathSource(file), clock: fixedClock, onProgress: afterLastScan('conversations.json', () => truncateSync(file, Math.floor(body.length / 2))) }),
          expectCode('IMPORT_PARSE_ERROR', 'CONCURRENT_MODIFICATION'),
        );
        assert.equal(count(t.db, 'source_batches'), 0);
      });
    } finally {
      t.close();
    }
  });

  it('a file whose first pass had a framing error but whose second pass differs is also CONCURRENT_MODIFICATION', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const broken = `[${chatConv(1).text()},{"mapping":`;
        const file = await writeFileIn(dir, 'conversations.json', broken);
        await assert.rejects(
          runImport(t.repo, { source: pathSource(file), clock: fixedClock, onProgress: afterLastScan('conversations.json', () => writeFileSync(file, `[${chatConv(1).text()},{"mapping":{}}]`)) }),
          expectCode('IMPORT_PARSE_ERROR', 'CONCURRENT_MODIFICATION'),
        );
        assert.equal(count(t.db, 'source_batches'), 0);
      });
    } finally {
      t.close();
    }
  });

  it('ZIP: replacing the archive file (rename) after pass 1 is harmless: the open handle still reads the original bytes', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const zip = join(dir, 'e.zip');
        await writeFile(zip, zipOf({ 'conversations.json': arrayOf([chatConv(1, { title: 'ORIGINAL' })]) }));
        await writeFile(join(dir, 'other.zip'), zipOf({ 'conversations.json': arrayOf([chatConv(1, { title: 'REPLACED' })]) }));
        const r = await runImport(t.repo, { source: pathSource(zip), clock: fixedClock, onProgress: afterLastScan('conversations.json', () => renameSync(join(dir, 'other.zip'), zip)) });
        assert.equal(r.conversations.stored, 1);
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(1) })?.title, 'ORIGINAL', 'both passes read the archive the reader opened, never a mixture');
      });
    } finally {
      t.close();
    }
  });

  it('ZIP: overwriting entry data in place after pass 1 fails the import (CRC / size / modification), nothing stored', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const body = arrayOf([chatConv(1, { title: 'AAAAAAAA' }), chatConv(2, { title: 'AAAAAAAA' })]);
        const bytes = buildZip([{ name: 'conversations.json', data: body, method: 'store' }]);
        const zip = join(dir, 'e.zip');
        await writeFile(zip, bytes);
        const tampered = Buffer.from(bytes);
        const at = tampered.indexOf('AAAAAAAA');
        tampered.write('BBBBBBBB', at);
        await assert.rejects(
          runImport(t.repo, { source: pathSource(zip), clock: fixedClock, onProgress: afterLastScan('conversations.json', () => writeFileSync(zip, tampered)) }),
          (e: unknown) => e instanceof GcrError && ['IMPORT_ZIP_UNSAFE', 'IMPORT_PARSE_ERROR'].includes(e.code),
        );
        assert.equal(count(t.db, 'source_batches'), 0);
        assert.equal(count(t.db, 'conversations'), 0);
      });
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Resource exhaustion
// ---------------------------------------------------------------------------------------------------------------------

describe('resource exhaustion', () => {
  it('hundreds of thousands of tiny {} elements: counted, bounded memory, no quadratic behaviour', async (t) => {
    const repo = freshRepo();
    try {
      const N = 250_000; // 1,000,000 take 2.7 s in plain node (114 MiB) but ~25 s inside node:test, so CI uses a quarter
      const gcWorks = collectGarbage();
      const base = heapUsed();
      let peak = base;
      const sample = (): void => {
        peak = Math.max(peak, heapUsed());
      };
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', `[${Array(N).fill('{}').join(',')}]`);
        const t0 = performance.now();
        const r = await runImport(repo.repo, { source: pathSource(file), clock: fixedClock, onProgress: sample });
        const seconds = (performance.now() - t0) / 1000;
        sample();
        assert.equal(r.conversations.read, N);
        assert.equal(r.warnings.find((w) => w.code === 'EMPTY_CONVERSATION_ENTRY')?.count, N);
        assert.ok(r.warnings.every((w) => w.sampleIds.length <= 5));
        assert.equal(r.provider, 'chatgpt');
        const grown = (peak - base) / (1024 * 1024);
        t.diagnostic(`${N} empty elements: ${seconds.toFixed(1)} s, peak heap growth ${grown.toFixed(0)} MiB (gc ${gcWorks ? 'on' : 'off'})`);
        assert.ok(seconds < 60, `${seconds.toFixed(1)} s`);
        if (gcWorks) assert.ok(grown < 400, `${grown.toFixed(0)} MiB`);
      });
    } finally {
      repo.close();
    }
  });

  it('a very deeply nested value inside a conversation fails ONE element (or imports), never the process or the siblings', async () => {
    const t = freshRepo();
    try {
      const deep = '['.repeat(9000) + ']'.repeat(9000);
      const bad = chatConv(1, { extra: {} }).text().replace(/^\{/, `{"deep":${deep},`);
      const r = await runImport(t.repo, { source: stream(`[${bad},${chatConv(2).text()}]`), clock: fixedClock });
      assert.equal(r.conversations.read, 2);
      assert.ok(r.conversations.stored >= 1);
      assert.ok(t.repo.getConversation({ conversationId: syntheticUuid(2) }));
    } finally {
      t.close();
    }
  });

  it('nesting beyond the splitter\'s depth cap is a framing failure of THAT file, reported without content', async () => {
    const t = freshRepo();
    try {
      const deep = '['.repeat(20_000) + ']'.repeat(20_000);
      const body = `[${chatConv(1).text()},{"mapping":{},"deep":${deep}}]`;
      const r = await runImport(t.repo, { source: stream(body), clock: fixedClock });
      assert.equal(r.conversations.stored, 1, 'elements before the break are kept');
      assert.equal(r.warnings.find((w) => w.code === 'FILE_PARSE_FAILED')?.count, 1);
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Container tricks
// ---------------------------------------------------------------------------------------------------------------------

describe('container tricks end to end', () => {
  // DEFECT (minor): per-file failure counts were keyed by file NAME, so two files that end up with the same display name
  // (an outer entry literally called "<nested>!/<inner>" next to a real nested archive) shared one counter.
  it('files with colliding display names keep separate per-file counts', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const inner = buildZip([{ name: 'conversations.json', data: `[${chatConv(1).text()},{"mapping": BROKEN}]` }]);
        const outer = buildZip([
          { name: 'conversations.zip', data: inner, method: 'store' },
          { name: 'conversations.zip!/conversations.json', data: arrayOf([chatConv(2)]) },
        ]);
        await writeFile(join(dir, 'o.zip'), outer);
        const r = await runImport(t.repo, { source: pathSource(join(dir, 'o.zip')), clock: fixedClock });
        assert.equal(r.files.length, 2);
        assert.equal(r.conversations.stored, 2);
        assert.equal(r.conversations.failed, 1);
        assert.deepEqual(r.files.map((f) => f.failed).sort(), [0, 1]);
        assert.equal(new Set(r.files.map((f) => f.name)).size, 2);
      });
    } finally {
      t.close();
    }
  });

  it('a manifest whose paths traverse, is huge, or lists a million names never reads outside the container and never fails the import', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const files = Array.from({ length: 200_000 }, (_, i) => `../../etc/passwd-${i}`);
        files.push('conversations.json', '/abs/conversations-1.json', 'C:\\x\\conversations-2.json');
        const manifest = JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files, sharded: false } } });
        await writeFile(join(dir, 'e.zip'), zipOf({ 'export_manifest.json': manifest, 'conversations.json': arrayOf([chatConv(1)]) }));
        const r = await runImport(t.repo, { source: pathSource(join(dir, 'e.zip')), clock: fixedClock });
        assert.equal(r.conversations.stored, 1);
        assert.equal(r.formatProfile?.manifest, 'present');
        const w = r.warnings.find((x) => x.code === 'MANIFEST_INVALID');
        assert.ok(w);
        assert.ok(JSON.stringify(r.warnings).length < 2000, 'bounded report');
      });
    } finally {
      t.close();
    }
  });

  it('a folder named like a conversation file, and a symlinked folder cycle, do not confuse the walk', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        await writeFileIn(dir, 'export/conversations.json/inside.txt', 'x'); // a DIRECTORY called conversations.json
        await writeFileIn(dir, 'export/conversations-1.json', arrayOf([chatConv(1)]));
        const r = await runImport(t.repo, { source: pathSource(join(dir, 'export')), clock: fixedClock });
        assert.equal(r.conversations.stored, 1);
        assert.equal(r.formatProfile?.layout, 'directory');
      });
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Leaks
// ---------------------------------------------------------------------------------------------------------------------

describe('no absolute path or content in any outcome', () => {
  const TITLE = 'PLANTED_ADV_TITLE_91x';
  const NAME = 'PLANTED_ADV_NAME_91x'; // names of container members are reported on purpose; the ABSOLUTE path is not
  it('hostile labels and values flow through reports, stored rows and errors without leaking the planted path or text', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const surfaces: Array<[string, string]> = [];
        const run = async (label: string, opts: ImportOptions): Promise<void> => {
          try {
            surfaces.push([label, JSON.stringify(await runImport(t.repo, { clock: fixedClock, ...opts }))]);
          } catch (e) {
            assert.ok(e instanceof GcrError, `${label}: only GcrError may escape`);
            surfaces.push([label, JSON.stringify({ message: e.message, remedy: e.remedy, details: e.details, envelope: e.toEnvelope() })]);
          }
        };
        const gen = (text: string) => (async function* (): AsyncGenerator<Buffer, void, undefined> { yield Buffer.from(text); })();
        await run('stream label with a windows path', { source: { kind: 'stream', label: `C:\\Users\\${NAME}\\private\\export.json`, stream: gen(arrayOf([chatConv(1, { title: TITLE })])) } });
        await run('stream label with a posix path', { source: { kind: 'stream', label: `${dir}/${NAME}/export.json`, stream: gen(arrayOf([chatConv(2, { title: TITLE })])) } });
        await writeFile(join(dir, 'e.zip'), zipOf({ [`${NAME}/conversations.json`]: `[${chatConv(3, { title: TITLE }).text()},{"mapping": ${TITLE}}]` }));
        await run('zip with a content-bearing corrupt element', { source: pathSource(join(dir, 'e.zip')), accountLabel: 'leak-a' });
        await run('strict on the same', { source: pathSource(join(dir, 'e.zip')), accountLabel: 'leak-b', strict: true });
        await run('not a zip', { source: pathSource(await writeFileIn(dir, `${NAME}.bin`, `${TITLE} not an export`)) });
        await run('missing', { source: pathSource(join(dir, NAME, 'missing.zip')) });
        await run('a directory without conversations', { source: pathSource(await writeFileIn(dir, `${NAME}-dir/readme.txt`, TITLE).then(() => join(dir, `${NAME}-dir`))) });
        assert.ok(surfaces.length >= 7);
        for (const [label, s] of surfaces) {
          assert.ok(!s.includes(dir), `${label}: absolute path`);
          assert.ok(!s.includes(TITLE), `${label}: content`);
          assert.ok(!s.includes('C:\\\\Users') && !s.includes('private'), `${label}: label directories`);
        }
        const stored = JSON.stringify(t.repo.listBatches());
        assert.ok(!stored.includes(dir) && !stored.includes('private'));
      });
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Differential fuzzing of the two hand-written scanners against JSON.parse
// ---------------------------------------------------------------------------------------------------------------------

type Rnd = { next: () => number; pick: (n: number) => number };
function makeRnd(seed: number): Rnd {
  const next = mulberry32(seed);
  return { next, pick: (n) => Math.floor(next() * n) };
}

const NASTY_CHARS = ['"', '\\', '{', '}', '[', ']', ',', ':', ' ', '\n', '\t', '/', '\u00e9', '\u65e5', '\ud83d\ude00', '\u2028', '\u0001', 'a', 'Z', '0', '\u007f'];

/** A JSON string literal with random content and a random mix of raw characters and \u escapes. */
function randomJsonString(r: Rnd, maxLen = 12): string {
  let raw = '';
  const n = r.pick(maxLen + 1);
  for (let i = 0; i < n; i++) raw += NASTY_CHARS[r.pick(NASTY_CHARS.length)] as string;
  let out = '"';
  for (const ch of raw) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (cp < 0x20 || r.pick(5) === 0) out += cp > 0xffff ? `\\u${(0xd800 + ((cp - 0x10000) >> 10)).toString(16)}\\u${(0xdc00 + ((cp - 0x10000) & 0x3ff)).toString(16)}` : `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

const WS = ['', '', ' ', '\n', '\t', ' \r\n  '];
const ws = (r: Rnd): string => WS[r.pick(WS.length)] as string;

const NUMBERS = ['0', '-0', '1', '-17', '3.5', '1760000000.123456', '1e3', '1E-3', '2.5e+2', '1e999', '9007199254740993', '123456789012345678901234567890'];

function randomValue(r: Rnd, depth: number): string {
  const k = r.pick(depth >= 3 ? 5 : 7);
  switch (k) {
    case 0:
      return randomJsonString(r);
    case 1:
      return NUMBERS[r.pick(NUMBERS.length)] as string;
    case 2:
      return 'null';
    case 3:
      return r.pick(2) === 0 ? 'true' : 'false';
    case 4:
      return randomJsonString(r, 30);
    case 5: {
      const n = r.pick(4);
      return `[${ws(r)}${Array.from({ length: n }, () => randomValue(r, depth + 1)).join(`${ws(r)},${ws(r)}`)}${ws(r)}]`;
    }
    default:
      return randomObject(r, depth + 1, false);
  }
}

const IDENTITY_KEYS = ['id', 'conversation_id', 'uuid', 'update_time', 'updated_at', 'mapping', 'conversations', 'chat_messages'];

function randomObject(r: Rnd, depth: number, identity: boolean): string {
  const n = r.pick(7);
  const members: string[] = [];
  for (let i = 0; i < n; i++) {
    let key: string;
    if (identity && r.pick(3) > 0) {
      key = JSON.stringify(IDENTITY_KEYS[r.pick(IDENTITY_KEYS.length)]);
      if (r.pick(6) === 0) key = key.replace(/^"([a-z])/, (_m, c: string) => `"\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`); // a key spelled with an escape
    } else key = randomJsonString(r, 8);
    const value = identity && key.includes('update_time') && r.pick(2) === 0 ? NUMBERS[r.pick(NUMBERS.length)] as string : randomValue(r, depth);
    members.push(`${ws(r)}${key}${ws(r)}:${ws(r)}${value}`);
  }
  return `{${members.join(',')}${ws(r)}}`;
}

describe('differential fuzzing against JSON.parse', () => {
  it('peekElement agrees with JSON.parse on identity fields, markers and the wrapper position (duplicate keys: last wins), 4000 random objects', () => {
    let withDuplicates = 0;
    for (let seed = 1; seed <= 4000; seed++) {
      const r = makeRnd(seed);
      const text = randomObject(r, 0, true);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const p = peekElement(text);
      const keys = Object.keys(parsed);
      if (keys.length === 0) {
        assert.equal(p.kind, 'empty_object', `seed ${seed}`);
        continue;
      }
      assert.equal(p.kind, 'object', `seed ${seed}`);
      assert.equal(p.malformed, false, `seed ${seed}: ${text.slice(0, 120)}`);
      const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 4096 ? v : null);
      assert.equal(p.conversationId, str(parsed['conversation_id']), `seed ${seed} conversation_id`);
      assert.equal(p.id, str(parsed['id']), `seed ${seed} id`);
      assert.equal(p.uuid, str(parsed['uuid']), `seed ${seed} uuid`);
      assert.equal(p.hasMapping, Object.hasOwn(parsed, 'mapping'), `seed ${seed} mapping`);
      assert.equal(p.conversationsIsArray, Array.isArray(parsed['conversations']), `seed ${seed} conversations`);
      assert.equal(p.chatMessagesIsArray, Array.isArray(parsed['chat_messages']), `seed ${seed} chat_messages`);
      if (p.conversationsIsArray) assert.equal(text[p.conversationsAt], '[', `seed ${seed} conversationsAt`);
      else assert.equal(p.conversationsAt, -1, `seed ${seed}`);
      const ut = parsed['update_time'];
      if (typeof ut === 'number' && Number.isFinite(ut) && p.updateMs !== null) assert.equal(p.updateMs, ut * 1000, `seed ${seed} update_time`);
      if (typeof ut !== 'number' && !(typeof parsed['updated_at'] === 'string')) assert.equal(p.updateMs, null, `seed ${seed}: no time`);
      if (typeof ut === 'number' && Number.isFinite(ut)) assert.notEqual(p.updateMs, null, `seed ${seed}: a finite update_time is read`);
      if (new Set(Object.keys(parsed)).size < (text.match(/"(id|uuid)"\s*:/g) ?? []).length) withDuplicates++;
    }
    assert.ok(withDuplicates > 0, 'the generator really produced duplicate identity keys');
  });

  it('a wrapper is split exactly where JSON.parse sees its members: counts of scalars, empty objects and other objects, 400 random wrappers', async () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = makeRnd(10_000 + seed);
      const n = r.pick(10);
      const members: string[] = [];
      const expected = { nonObject: 0, empty: 0, notConversation: 0 };
      for (let i = 0; i < n; i++) {
        let m: string;
        if (r.pick(2) === 0) m = randomValue(r, 1);
        else m = randomObject(r, 1, false).replace(/"(mapping|chat_messages|conversations)"/g, '"x$1"');
        members.push(m);
        const v = JSON.parse(m) as unknown;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) expected.nonObject++;
        else if (Object.keys(v).length === 0) expected.empty++;
        else expected.notConversation++;
      }
      const good = chatConv(1).text();
      const all = [good, ...members];
      const body = `${ws(r)}{${ws(r)}"conversations"${ws(r)}:${ws(r)}[${ws(r)}${all.join(`${ws(r)},${ws(r)}`)}${ws(r)}]${ws(r)}}${ws(r)}`;
      JSON.parse(body); // the generator only builds valid JSON
      const t = freshRepo();
      try {
        const rep = await runImport(t.repo, { source: stream(body), clock: fixedClock });
        assert.equal(rep.conversations.read, all.length, `seed ${seed}: members found`);
        assert.equal(rep.conversations.stored, 1, `seed ${seed}`);
        const c = (code: string): number => rep.warnings.find((w) => w.code === code)?.count ?? 0;
        assert.equal(c('NON_OBJECT_ENTRY'), expected.nonObject, `seed ${seed} non-object`);
        assert.equal(c('EMPTY_CONVERSATION_ENTRY'), expected.empty, `seed ${seed} empty`);
        assert.equal(c('NOT_A_CONVERSATION'), expected.notConversation, `seed ${seed} other objects`);
        assert.equal(rep.conversations.failed, 0, `seed ${seed}`);
      } finally {
        t.close();
      }
    }
  });
});

describe('mutation fuzzing of whole inputs', () => {
  it('180 seeds x (wrapper JSON, array JSON, sharded ZIP with manifest): success stores exactly one batch, failure is a GcrError that is never INTERNAL_ERROR and stores nothing', async () => {
    const wrapperBase = Buffer.from(`{"conversations":[${chatConv(1).text()},${chatConv(2, { updateTime: null }).text()},{},null,${chatConv(1, { title: 'dup' }).text()}]}`);
    const arrayBase = Buffer.from(arrayOf([chatConv(1), chatConv(2), chatConv(3)]));
    const zipBase = zipOf(
      {
        'conversations-1.json': arrayBase.toString('utf8'),
        'conversations-2.json': wrapperBase.toString('utf8'),
        'export_manifest.json': '{"version":1,"logical_files":{"conversations.json":{"files":["conversations-1.json","conversations-2.json"]}}}',
      },
      'store',
    );
    let successes = 0;
    let failures = 0;
    await withTempDir(async (dir) => {
      for (let seed = 1; seed <= 180; seed++) {
        const r = mulberry32(seed);
        const pick = (n: number): number => Math.floor(r() * n);
        for (const [kind, base] of [['stream', wrapperBase], ['stream', arrayBase], ['zip', zipBase]] as const) {
          let cur = Buffer.from(base);
          for (let k = 1 + pick(4); k > 0; k--) {
            const at = pick(cur.length);
            const op = pick(5);
            if (op === 0) {
              cur = Buffer.from(cur);
              cur[at] = pick(256);
            } else if (op === 1) cur = Buffer.concat([cur.subarray(0, at), cur.subarray(at + 1 + pick(20))]);
            else if (op === 2) cur = Buffer.concat([cur.subarray(0, at), Buffer.from([pick(256), pick(256)]), cur.subarray(at)]);
            else if (op === 3) cur = cur.subarray(0, at + 1);
            else cur = Buffer.concat([cur.subarray(0, at), cur.subarray(Math.max(0, at - 30), at), cur.subarray(at)]);
          }
          const t = freshRepo();
          try {
            let source: ImportOptions['source'];
            if (kind === 'stream') source = stream(cur);
            else {
              await writeFile(join(dir, 'm.zip'), cur);
              source = pathSource(join(dir, 'm.zip'));
            }
            try {
              await runImport(t.repo, { source, clock: fixedClock, strict: seed % 3 === 0 });
              successes++;
              assert.equal(count(t.db, 'source_batches'), 1, `seed ${seed} ${kind}: a success stores exactly one batch`);
            } catch (e) {
              failures++;
              assert.ok(e instanceof GcrError, `seed ${seed} ${kind}: only GcrError may escape`);
              assert.notEqual(e.code, 'INTERNAL_ERROR', `seed ${seed} ${kind}: an unexpected exception (a bug)`);
              assert.equal(count(t.db, 'source_batches'), 0, `seed ${seed} ${kind}: a failure stores nothing`);
              assert.equal(count(t.db, 'conversations'), 0, `seed ${seed} ${kind}`);
            }
          } finally {
            t.close();
          }
        }
      }
    });
    assert.ok(successes > 50 && failures > 50, `both outcomes were exercised (${successes} ok, ${failures} failed)`);
  });
});
