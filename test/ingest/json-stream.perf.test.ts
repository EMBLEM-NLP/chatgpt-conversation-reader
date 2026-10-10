/**
 * Throughput and memory sanity for the JSON splitter. Not a micro-benchmark: the thresholds are generous (they are the
 * contract from the task: ~64 MiB in well under 10 s with heap growth well under 100 MiB) and exist to catch accidental
 * O(n^2) behaviour or whole-input buffering.
 */
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { test } from 'node:test';
import { jsonArrayElements, jsonLinesElements } from '../../src/ingest/json-stream.js';

const MIB = 1024 * 1024;

/** Force-GC without needing `node --expose-gc` on the command line. */
function getGc(): (() => void) | undefined {
  try {
    v8.setFlagsFromString('--expose-gc');
    const g: unknown = vm.runInNewContext('gc');
    return typeof g === 'function' ? (g as () => void) : undefined;
  } catch {
    return undefined;
  }
}
const gc = getGc();
function settle(): void {
  gc?.();
  gc?.();
}

/** 128 distinct conversation-shaped records (~5 KiB each) with unicode, escapes and brackets inside strings. */
function makeVariants(): Buffer[] {
  const variants: Buffer[] = [];
  for (let v = 0; v < 128; v++) {
    const mapping: Record<string, unknown> = {};
    for (let n = 0; n < 8; n++) {
      mapping[`node-${v}-${n}`] = {
        id: `node-${v}-${n}`,
        parent: n === 0 ? null : `node-${v}-${n - 1}`,
        message: {
          author: { role: n % 2 === 0 ? 'user' : 'assistant' },
          content: {
            content_type: 'text',
            parts: [`Message ${v}/${n}: caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00 "quoted" \\ back\\slash ]}[{ , : ${'lorem ipsum dolor sit amet '.repeat(12)}\n\ttab`],
          },
          metadata: { model_slug: null, tags: ['a', 'b', [1, 2, { deep: '}]' }]] },
        },
      };
    }
    variants.push(Buffer.from(JSON.stringify({ id: `conv-${v}`, title: `Conversation #${v} \u2014 \u00fcnicode`, create_time: 1700000000 + v, mapping })));
  }
  return variants;
}

interface Generated {
  chunks: AsyncGenerator<Buffer>;
  stats: { elements: number; elementBytes: number; totalBytes: number };
  variants: Buffer[];
}

/** Stream `[e0,e1,...]` (or NDJSON when `ndjson`) of ~targetBytes, in chunks of `chunkSize`, WITHOUT materializing it. */
function generate(targetBytes: number, chunkSize: number, ndjson = false): Generated {
  const variants = makeVariants();
  const stats = { elements: 0, elementBytes: 0, totalBytes: 0 };
  function* pieces(): Generator<Buffer> {
    if (!ndjson) {
      stats.totalBytes += 1;
      yield Buffer.from('[');
    }
    for (let i = 0; stats.totalBytes < targetBytes; i++) {
      const el = variants[(i * 7) % variants.length] as Buffer;
      const sep = ndjson ? '\n' : i === 0 ? '' : ',';
      stats.elements++;
      stats.elementBytes += el.length;
      stats.totalBytes += el.length + sep.length;
      if (sep) yield Buffer.from(sep);
      yield el;
    }
    stats.totalBytes += 1;
    yield Buffer.from(ndjson ? '\n' : ']');
  }
  async function* chunks(): AsyncGenerator<Buffer> {
    let buf = Buffer.allocUnsafe(chunkSize);
    let n = 0;
    for (const p of pieces()) {
      for (let off = 0; off < p.length; ) {
        const take = Math.min(chunkSize - n, p.length - off);
        p.copy(buf, n, off, off + take);
        n += take;
        off += take;
        if (n === chunkSize) {
          yield buf;
          buf = Buffer.allocUnsafe(chunkSize);
          n = 0;
        }
      }
    }
    if (n > 0) yield buf.subarray(0, n);
  }
  return { chunks: chunks(), stats, variants };
}

async function measure(
  label: string,
  fn: (sample: () => void) => Promise<void>,
): Promise<{ ms: number; peakHeap: number; peakBuffers: number; retained: number }> {
  settle();
  const base = process.memoryUsage();
  let peakHeap = 0;
  let peakBuffers = 0;
  const sample = (): void => {
    const m = process.memoryUsage();
    peakHeap = Math.max(peakHeap, m.heapUsed - base.heapUsed);
    peakBuffers = Math.max(peakBuffers, m.arrayBuffers - base.arrayBuffers);
  };
  const t0 = process.hrtime.bigint();
  await fn(sample);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  sample();
  settle();
  const retained = process.memoryUsage().heapUsed - base.heapUsed;
  process.stdout.write(`# perf ${label}: ${ms.toFixed(0)} ms, peak heap +${(peakHeap / MIB).toFixed(1)} MiB, peak buffers +${(peakBuffers / MIB).toFixed(1)} MiB, retained ${(retained / MIB).toFixed(1)} MiB\n`);
  return { ms, peakHeap, peakBuffers, retained };
}

test('64 MiB array of ~5 KiB elements streams in well under 10 s with bounded memory, and the output is exact', { timeout: 60_000 }, async () => {
  const gen = generate(64 * MIB, 64 * 1024);
  let count = 0;
  let bytes = 0;
  let checked = 0;
  const r = await measure('64 MiB array', async (sample) => {
    for await (const el of jsonArrayElements(gen.chunks)) {
      assert.equal(el.index, count);
      count++;
      bytes += el.byteLength;
      if (count % 512 === 0) {
        sample();
        // Spot-check integrity: the text must parse and be the exact variant that was written.
        const idx = (el.index * 7) % gen.variants.length;
        assert.equal(el.text, gen.variants[idx]!.toString('utf8'));
        checked++;
      }
    }
  });
  assert.equal(count, gen.stats.elements, 'every element was delivered exactly once');
  assert.equal(bytes, gen.stats.elementBytes, 'sum of byteLength equals the bytes of the elements written');
  assert.ok(gen.stats.totalBytes >= 64 * MIB, `generated only ${gen.stats.totalBytes} bytes`);
  assert.ok(checked > 10);
  assert.ok(r.ms < 10_000, `took ${r.ms.toFixed(0)} ms for ${(gen.stats.totalBytes / MIB).toFixed(0)} MiB`);
  assert.ok(r.peakHeap < 100 * MIB, `heap grew by ${(r.peakHeap / MIB).toFixed(1)} MiB`);
  assert.ok(r.peakBuffers < 100 * MIB, `array buffers grew by ${(r.peakBuffers / MIB).toFixed(1)} MiB`);
  if (gc) assert.ok(r.retained < 30 * MIB, `retained ${(r.retained / MIB).toFixed(1)} MiB after the run: elements must not be accumulated`);
});

test('the same holds with awkward chunk sizes (4099 bytes, so most elements straddle chunk boundaries)', { timeout: 60_000 }, async () => {
  const gen = generate(24 * MIB, 4099);
  let count = 0;
  const r = await measure('24 MiB array, 4099-byte chunks', async (sample) => {
    for await (const el of jsonArrayElements(gen.chunks)) {
      count++;
      if (count % 256 === 0) sample();
      assert.ok(el.byteLength > 1000);
    }
  });
  assert.equal(count, gen.stats.elements);
  assert.ok(r.ms < 10_000, `took ${r.ms.toFixed(0)} ms`);
  assert.ok(r.peakHeap < 100 * MIB && r.peakBuffers < 100 * MIB);
});

test('NDJSON throughput: 32 MiB of lines', { timeout: 60_000 }, async () => {
  const gen = generate(32 * MIB, 64 * 1024, true);
  let count = 0;
  let bytes = 0;
  const r = await measure('32 MiB NDJSON', async (sample) => {
    for await (const el of jsonLinesElements(gen.chunks)) {
      count++;
      bytes += el.byteLength;
      if (count % 256 === 0) sample();
    }
  });
  assert.equal(count, gen.stats.elements);
  assert.equal(bytes, gen.stats.elementBytes);
  assert.ok(r.ms < 10_000, `took ${r.ms.toFixed(0)} ms`);
  assert.ok(r.peakHeap < 100 * MIB && r.peakBuffers < 100 * MIB);
});

test('one huge element (24 MiB string) is assembled from small chunks with memory proportional to that element', { timeout: 60_000 }, async () => {
  const body = 'abcdefghij\\"\u00e9'.repeat(Math.ceil((24 * MIB) / 15));
  const doc = Buffer.from(`["${body}"]`);
  async function* chunks(): AsyncGenerator<Buffer> {
    for (let i = 0; i < doc.length; i += 64 * 1024) yield doc.subarray(i, Math.min(doc.length, i + 64 * 1024));
  }
  let seen = 0;
  const r = await measure('24 MiB single element', async (sample) => {
    for await (const el of jsonArrayElements(chunks(), { maxElementBytes: 64 * MIB })) {
      seen++;
      sample();
      assert.equal(el.byteLength, doc.length - 2);
      assert.equal(el.text.length, body.length + 2); // text.length counts UTF-16 units: the string plus its two quotes
    }
  });
  assert.equal(seen, 1);
  // acc buffer (<= element) + decoded string (<= 2 bytes/char) + slack; far below "whole input several times over".
  assert.ok(r.peakHeap + r.peakBuffers < 200 * MIB, `heap+buffers grew by ${((r.peakHeap + r.peakBuffers) / MIB).toFixed(1)} MiB`);
});

test('1-byte chunks: the worst case for per-chunk overhead still finishes promptly', { timeout: 60_000 }, async () => {
  const gen = generate(128 * 1024, 1 << 20);
  const all: Buffer[] = [];
  for await (const c of gen.chunks) all.push(c);
  const doc = Buffer.concat(all);
  async function* oneByte(): AsyncGenerator<Buffer> {
    for (let i = 0; i < doc.length; i++) yield doc.subarray(i, i + 1);
  }
  let count = 0;
  const r = await measure('128 KiB in 1-byte chunks', async () => {
    for await (const el of jsonArrayElements(oneByte())) {
      void el;
      count++;
    }
  });
  assert.equal(count, gen.stats.elements);
  assert.ok(r.ms < 10_000, `took ${r.ms.toFixed(0)} ms`);
});
