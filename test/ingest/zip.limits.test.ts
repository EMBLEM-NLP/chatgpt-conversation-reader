/**
 * resolveLimits() validation, and the runtime guards of SafeZipReader: decompression bombs (lying sizes, ratio,
 * cumulative budget), CRC/size verification at stream end, corrupt/truncated data, and stream hygiene.
 */
import assert from 'node:assert/strict';
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';
import { truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { GcrError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';
import { DEFAULT_IMPORT_LIMITS, resolveLimits } from '../../src/ingest/limits.js';
import type { ImportLimits } from '../../src/ingest/limits.js';
import { SafeZipReader } from '../../src/ingest/zip.js';
import { buildZip, deflatedZeros } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';

const MIB = 1024 * 1024;

function isGcr(code: ErrorCode, reason?: string): (e: unknown) => boolean {
  return (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    assert.equal(e.code, code, `code (reason=${String(e.details?.['reason'])})`);
    if (reason !== undefined) assert.equal(e.details?.['reason'], reason);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(e.message), 'message has control characters');
    return true;
  };
}

/** Deterministic, essentially incompressible bytes (LCG), so ratio ~ 1. */
function noise(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

async function consume(it: AsyncIterable<Buffer>): Promise<{ chunks: Buffer[]; error: unknown }> {
  const chunks: Buffer[] = [];
  try {
    for await (const c of it) chunks.push(c);
  } catch (error) {
    return { chunks, error };
  }
  return { chunks, error: undefined };
}

/** A deflate stream of `size` zero bytes, produced incrementally (so the TEST never holds `size` bytes). */
async function zerosDeflateStreaming(size: number): Promise<Buffer> {
  const zeroMiB = Buffer.alloc(MIB);
  async function* source(): AsyncGenerator<Buffer> {
    for (let left = size; left > 0; left -= MIB) yield left >= MIB ? zeroMiB : zeroMiB.subarray(0, left);
  }
  const out: Buffer[] = [];
  for await (const c of Readable.from(source(), { objectMode: false }).pipe(createDeflateRaw())) out.push(c as Buffer);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------------------------------------------
// limits.ts
// ---------------------------------------------------------------------------------------------------------------

test('DEFAULT_IMPORT_LIMITS match the architecture document', () => {
  assert.equal(DEFAULT_IMPORT_LIMITS.maxEntries, 20_000);
  assert.equal(DEFAULT_IMPORT_LIMITS.maxEntryUncompressedBytes, 2 * 1024 ** 3);
  assert.equal(DEFAULT_IMPORT_LIMITS.maxTotalInflatedBytes, 8 * 1024 ** 3);
  assert.equal(DEFAULT_IMPORT_LIMITS.maxCompressionRatio, 200);
  assert.equal(DEFAULT_IMPORT_LIMITS.maxEntryNameBytes, 1024);
  assert.equal(DEFAULT_IMPORT_LIMITS.maxElementBytes, 256 * MIB);
  for (const [k, v] of Object.entries(DEFAULT_IMPORT_LIMITS)) assert.ok(Number.isFinite(v) && v > 0, `${k} must be positive and finite`);
  assert.ok(Object.isFrozen(DEFAULT_IMPORT_LIMITS), 'the shared defaults must not be mutable');
});

test('resolveLimits(): defaults, partial override, independence from the shared defaults', () => {
  const d = resolveLimits();
  assert.deepEqual(d, { ...DEFAULT_IMPORT_LIMITS });
  assert.notEqual(d, DEFAULT_IMPORT_LIMITS);
  d.maxEntries = 1; // mutating the result must not leak into later calls
  assert.equal(resolveLimits().maxEntries, 20_000);

  const o = resolveLimits({ maxEntries: 5, maxCompressionRatio: 1.5 });
  assert.equal(o.maxEntries, 5);
  assert.equal(o.maxCompressionRatio, 1.5);
  assert.equal(o.maxElementBytes, DEFAULT_IMPORT_LIMITS.maxElementBytes);

  // `undefined` means "not provided" (so optional CLI flags can be passed straight through).
  assert.equal(resolveLimits({ maxEntries: undefined }).maxEntries, 20_000);
  assert.deepEqual(resolveLimits({}), { ...DEFAULT_IMPORT_LIMITS });
});

test('resolveLimits(): every key rejects zero, negative, NaN, +/-Infinity and non-numbers with INVALID_ARGUMENT', () => {
  const keys = Object.keys(DEFAULT_IMPORT_LIMITS) as Array<keyof ImportLimits>;
  assert.equal(keys.length, 8);
  const bad: unknown[] = [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null, {}, true, 10n];
  for (const key of keys) {
    for (const value of bad) {
      assert.throws(
        () => resolveLimits({ [key]: value } as Partial<ImportLimits>),
        (e: unknown) => {
          assert.ok(e instanceof GcrError, `${key}=${String(value)}`);
          assert.equal(e.code, 'INVALID_ARGUMENT');
          assert.equal(e.details?.['limit'], key);
          return true;
        },
        `${key}=${String(value)}`,
      );
    }
  }
});

test('resolveLimits(): unknown keys (typos) and non-object arguments are rejected', () => {
  assert.throws(() => resolveLimits({ maxEntires: 5 } as unknown as Partial<ImportLimits>), isGcr('INVALID_ARGUMENT', 'UNKNOWN_LIMIT'));
  assert.throws(() => resolveLimits(5 as unknown as Partial<ImportLimits>), isGcr('INVALID_ARGUMENT', 'LIMITS_NOT_OBJECT'));
  assert.throws(() => resolveLimits(null as unknown as Partial<ImportLimits>), isGcr('INVALID_ARGUMENT', 'LIMITS_NOT_OBJECT'));
});

// ---------------------------------------------------------------------------------------------------------------
// Bombs
// ---------------------------------------------------------------------------------------------------------------

test('bomb: 1 MiB of zeros declared as 10 bytes is stopped at the declared size, delivering nothing', async () => {
  const z = deflatedZeros(MIB);
  assert.ok(z.compressed.length < 2000, 'sanity: the bomb is tiny on disk');
  const r = SafeZipReader.fromBuffer(buildZip([{ name: 'bomb.bin', rawCompressed: z.compressed, data: '', declaredUncompressedSize: 10 }]));
  const { chunks, error } = await consume(r.stream('bomb.bin'));
  assert.ok(isGcr('IMPORT_ZIP_UNSAFE', 'SIZE_EXCEEDS_DECLARED')(error));
  assert.equal(
    chunks.reduce((n, c) => n + c.length, 0),
    0,
    'not one byte beyond the declared size may reach the consumer',
  );
  await assert.rejects(r.readBuffer('bomb.bin'), isGcr('IMPORT_ZIP_UNSAFE', 'SIZE_EXCEEDS_DECLARED'));
  assert.equal(r.totalInflatedBytes, 0, 'refused bytes are not counted as delivered');
});

test('bomb: declared size larger than the first chunk but smaller than the real output delivers at most `declared` bytes', async () => {
  const data = Buffer.alloc(400_000, 0x61);
  const r = SafeZipReader.fromBuffer(buildZip([{ name: 'lie.bin', data, declaredUncompressedSize: 70_000 }]), { maxCompressionRatio: 1e9 });
  const { chunks, error } = await consume(r.stream('lie.bin'));
  assert.ok(isGcr('IMPORT_ZIP_UNSAFE', 'SIZE_EXCEEDS_DECLARED')(error));
  const delivered = chunks.reduce((n, c) => n + c.length, 0);
  assert.ok(delivered <= 70_000, `delivered ${delivered} bytes, more than declared`);
});

test('bomb: a 256 MiB deflate bomb declared as 1 KiB is refused quickly with bounded memory', async () => {
  const compressed = await zerosDeflateStreaming(256 * MIB);
  assert.ok(compressed.length < 512 * 1024, `compressed bomb should be tiny, was ${compressed.length}`);
  const zip = buildZip([{ name: 'bomb.bin', rawCompressed: compressed, data: '', declaredUncompressedSize: 1024 }]);
  const r = SafeZipReader.fromBuffer(zip, { maxCompressionRatio: 1e9 });

  let peak = 0;
  const base = process.memoryUsage().arrayBuffers;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
  }, 2);
  const t0 = Date.now();
  const { error } = await consume(r.stream('bomb.bin'));
  const ms = Date.now() - t0;
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);

  assert.ok(isGcr('IMPORT_ZIP_UNSAFE', 'SIZE_EXCEEDS_DECLARED')(error));
  assert.ok(ms < 3000, `refusal took ${ms} ms`);
  assert.ok(peak < 100 * MIB, `array-buffer growth ${(peak / MIB).toFixed(1)} MiB suggests the bomb was inflated, not capped`);
});

test('ratio guard: an honest but far-too-dense entry is refused before any inflation; raising the limit allows it', async () => {
  const z = deflatedZeros(MIB);
  const spec = { name: 'dense.bin', rawCompressed: z.compressed, data: Buffer.alloc(MIB) } as const; // sizes/CRC are TRUE
  const strict = SafeZipReader.fromBuffer(buildZip([spec])); // default ratio 200; this entry is ~1000:1
  assert.throws(() => strict.stream('dense.bin'), isGcr('IMPORT_LIMIT_EXCEEDED', 'COMPRESSION_RATIO'));
  await assert.rejects(strict.readBuffer('dense.bin'), isGcr('IMPORT_LIMIT_EXCEEDED', 'COMPRESSION_RATIO'));
  assert.equal(strict.totalInflatedBytes, 0, 'nothing was inflated');

  const relaxed = SafeZipReader.fromBuffer(buildZip([spec]), { maxCompressionRatio: 5000 });
  const out = await relaxed.readBuffer('dense.bin');
  assert.equal(out.length, MIB);
  assert.ok(out.every((b) => b === 0));
});

test('ratio guard: small entries are exempt, incompressible data is never flagged, store entries are not subject to it', async () => {
  const tinyDense = deflatedZeros(4096); // 4 KiB of zeros -> a dozen bytes: ratio far above 200 but harmless
  const r = SafeZipReader.fromBuffer(
    buildZip([
      { name: 'tiny.bin', rawCompressed: tinyDense.compressed, data: Buffer.alloc(4096) },
      { name: 'noise.bin', data: noise(200_000, 5), method: 'deflate' },
      { name: 'stored.bin', data: Buffer.alloc(100_000), method: 'store' },
    ]),
  );
  assert.equal((await r.readBuffer('tiny.bin')).length, 4096);
  assert.equal((await r.readBuffer('noise.bin')).length, 200_000);
  assert.equal((await r.readBuffer('stored.bin')).length, 100_000);

  // Tight ratio (2:1) on repetitive data trips, even though the entry is only 100 KB.
  const repetitive = SafeZipReader.fromBuffer(buildZip([{ name: 'rep.bin', data: Buffer.alloc(100_000, 0x61), method: 'deflate' }]), { maxCompressionRatio: 2 });
  assert.throws(() => repetitive.stream('rep.bin'), isGcr('IMPORT_LIMIT_EXCEEDED', 'COMPRESSION_RATIO'));
});

test('cumulative budget: the third entry trips maxTotalInflatedBytes across several entries', async () => {
  const entries = [1, 2, 3].map((i) => ({ name: `e${i}.bin`, data: noise(1000, i), method: 'deflate' as const }));
  const r = SafeZipReader.fromBuffer(buildZip(entries), { maxTotalInflatedBytes: 2500 });
  assert.equal((await r.readBuffer('e1.bin')).length, 1000);
  assert.equal((await r.readBuffer('e2.bin')).length, 1000);
  assert.equal(r.totalInflatedBytes, 2000);
  assert.throws(() => r.stream('e3.bin'), isGcr('IMPORT_LIMIT_EXCEEDED', 'TOTAL_BUDGET'));
  await assert.rejects(r.readBuffer('e3.bin'), isGcr('IMPORT_LIMIT_EXCEEDED', 'TOTAL_BUDGET'));
  assert.equal(r.totalInflatedBytes, 2000, 'a refused read consumes no budget');

  // The budget belongs to the reader instance: a fresh reader starts at zero.
  const fresh = SafeZipReader.fromBuffer(buildZip(entries), { maxTotalInflatedBytes: 2500 });
  assert.equal((await fresh.readBuffer('e3.bin')).length, 1000);
});

test('cumulative budget: concurrent streams that each pass the pre-check still trip mid-stream on ACTUAL bytes', async () => {
  const entries = [1, 2].map((i) => ({ name: `e${i}.bin`, data: noise(1000, i + 10), method: 'store' as const }));
  const r = SafeZipReader.fromBuffer(buildZip(entries), { maxTotalInflatedBytes: 1500 });
  const a = r.stream('e1.bin'); // both pass the declared-size pre-check because nothing has been read yet
  const b = r.stream('e2.bin');
  const first = await consume(a);
  assert.equal(first.error, undefined);
  const second = await consume(b);
  assert.ok(isGcr('IMPORT_LIMIT_EXCEEDED', 'TOTAL_BUDGET')(second.error));
  assert.equal(second.chunks.length, 0, 'the chunk that would exceed the budget is not delivered');
});

test('per-entry cap is also enforced on the declared size when reading into memory (readBuffer default = maxElementBytes)', async () => {
  const r = SafeZipReader.fromBuffer(buildZip([{ name: 'a.bin', data: noise(2000, 1), method: 'store' }]), { maxElementBytes: 1000 });
  await assert.rejects(r.readBuffer('a.bin'), isGcr('IMPORT_LIMIT_EXCEEDED', 'ENTRY_EXCEEDS_READ_LIMIT'));
  assert.equal((await r.readBuffer('a.bin', 2000)).length, 2000);
  assert.equal((await consume(r.stream('a.bin'))).error, undefined, 'stream() is not subject to the readBuffer cap');
});

// ---------------------------------------------------------------------------------------------------------------
// Integrity: CRC / size verified at the END of the stream
// ---------------------------------------------------------------------------------------------------------------

for (const method of ['deflate', 'store'] as const) {
  test(`CRC mismatch (${method}) is detected only at stream end: all data is delivered first, then the iterator throws`, async () => {
    const data = noise(300_000, 21);
    const r = SafeZipReader.fromBuffer(buildZip([{ name: 'c.bin', data, method, crcOverride: (crc32(data) ^ 0xdeadbeef) >>> 0 }]));
    const { chunks, error } = await consume(r.stream('c.bin'));
    assert.ok(isGcr('IMPORT_ZIP_UNSAFE', 'CRC_MISMATCH')(error));
    assert.ok(Buffer.concat(chunks).equals(data), 'the (unverified) data was delivered before the error');
    assert.ok(chunks.length > 1, 'delivered incrementally, not buffered until the end');
    // The convenience API never hands back unverified data.
    await assert.rejects(r.readBuffer('c.bin'), isGcr('IMPORT_ZIP_UNSAFE', 'CRC_MISMATCH'));
  });
}

test('size mismatch: declared larger than actual is detected at the end (deflate); errors carry the entry index', async () => {
  const data = Buffer.alloc(5000, 0x62);
  const r = SafeZipReader.fromBuffer(buildZip([{ name: 'ok.txt', data: 'ok', method: 'store' }, { name: 's.bin', data, declaredUncompressedSize: 6000 }]));
  const { chunks, error } = await consume(r.stream('s.bin'));
  assert.ok(isGcr('IMPORT_ZIP_UNSAFE', 'SIZE_MISMATCH')(error));
  assert.match((error as GcrError).message, /entry #1\b/);
  assert.equal(Buffer.concat(chunks).length, 5000);
});

test('corrupt deflate data -> INFLATE_ERROR (GcrError, not a raw zlib error)', async () => {
  const good = deflateRawSync(Buffer.alloc(5000, 0x63));
  const cases: Array<[string, Buffer]> = [
    ['garbage', Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])],
    ['truncated stream', good.subarray(0, Math.max(1, good.length - 4))],
    ['flipped bits', Buffer.concat([Buffer.from([good[0]! ^ 0xff]), good.subarray(1)])],
  ];
  for (const [label, rawCompressed] of cases) {
    const r = SafeZipReader.fromBuffer(buildZip([{ name: 'x.bin', rawCompressed, data: Buffer.alloc(5000, 0x63) }]));
    const { error } = await consume(r.stream('x.bin'));
    assert.ok(isGcr('IMPORT_ZIP_UNSAFE')(error), label);
    assert.ok(['INFLATE_ERROR', 'SIZE_MISMATCH', 'CRC_MISMATCH'].includes(String((error as GcrError).details?.['reason'])), `${label}: ${String((error as GcrError).details?.['reason'])}`);
  }
  // The strictly-truncated stream is specifically an inflate error.
  const r = SafeZipReader.fromBuffer(buildZip([{ name: 'x.bin', rawCompressed: good.subarray(0, good.length - 4), data: Buffer.alloc(5000, 0x63) }]));
  assert.ok(isGcr('IMPORT_ZIP_UNSAFE', 'INFLATE_ERROR')((await consume(r.stream('x.bin'))).error));
});

test('bytes after the end of a deflate stream (inside the declared compressed size) are ignored but cannot alter the output', async () => {
  const data = Buffer.from('payload payload payload');
  const rawCompressed = Buffer.concat([deflateRawSync(data), Buffer.from('TRAILING-GARBAGE')]);
  const r = SafeZipReader.fromBuffer(buildZip([{ name: 't.bin', rawCompressed, data }]));
  assert.ok((await r.readBuffer('t.bin')).equals(data));
});

test('a file that shrinks after open() fails with a GcrError (DATA_TRUNCATED), not a crash or a hang', async () => {
  const data = noise(500_000, 31);
  const zip = buildZip([{ name: 'a.bin', data, method: 'store' }]);
  await withTempDir(async (dir) => {
    const path = join(dir, 'shrink.zip');
    await writeFile(path, zip);
    const r = await SafeZipReader.open(path);
    await truncate(path, 200_000);
    const { error } = await consume(r.stream('a.bin'));
    assert.ok(isGcr('IMPORT_ZIP_UNSAFE', 'DATA_TRUNCATED')(error));
    await r.close();
  });
});

test('abandoning streams early is cheap and leaves the reader fully usable', async () => {
  const data = noise(2 * MIB, 41);
  const r = SafeZipReader.fromBuffer(buildZip([{ name: 'big.bin', data, method: 'deflate' }]), { maxTotalInflatedBytes: 10 * 1024 ** 3 });
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) {
    for await (const chunk of r.stream('big.bin')) {
      assert.ok(chunk.length > 0);
      break; // abandon after the first chunk
    }
  }
  assert.ok(Date.now() - t0 < 5000, 'abandoned streams must be torn down promptly');
  assert.ok(r.totalInflatedBytes < 150 * 20 * MIB, 'only bytes actually observed are charged');
  assert.ok((await r.readBuffer('big.bin')).equals(data), 'a complete read after many abandoned ones still verifies');
});

test('streaming a large entry through a file handle keeps memory bounded and is fast enough', async () => {
  // 32 MiB of moderately compressible data, written to disk, streamed with the file-handle reader.
  const block = noise(4096, 51);
  const data = Buffer.concat(Array.from({ length: 8192 }, (_, i) => (i % 3 === 0 ? block : block.subarray(i % 2048))));
  const zip = buildZip([{ name: 'big.bin', data, method: 'deflate' }]);
  await withTempDir(async (dir) => {
    const path = join(dir, 'big.zip');
    await writeFile(path, zip);
    const r = await SafeZipReader.open(path, { maxCompressionRatio: 5000 });
    const before = process.memoryUsage();
    let total = 0;
    let maxChunk = 0;
    let crc = 0;
    const t0 = Date.now();
    for await (const c of r.stream('big.bin')) {
      total += c.length;
      maxChunk = Math.max(maxChunk, c.length);
      crc = crc32(c, crc);
    }
    const ms = Date.now() - t0;
    const grew = process.memoryUsage().arrayBuffers - before.arrayBuffers;
    assert.equal(total, data.length);
    assert.equal(crc >>> 0, crc32(data) >>> 0);
    assert.ok(maxChunk <= 64 * 1024, `chunk of ${maxChunk} bytes exceeds the bound`);
    assert.ok(ms < 8000, `streaming ${(data.length / MIB).toFixed(0)} MiB took ${ms} ms`);
    assert.ok(grew < 64 * MIB, `array-buffer growth ${(grew / MIB).toFixed(1)} MiB`);
    await r.close();
  });
});
