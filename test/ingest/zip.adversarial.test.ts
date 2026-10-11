/**
 * Independent adversarial review of src/ingest/zip.ts + limits.ts (archive-parsing attacks and stream hygiene).
 * Every test here either demonstrates a defect that was found in review (and is now fixed) or pins a branch that the
 * builder's suite left unexecuted (close/shrink while a deflate stream is running, ZIP64 disk field, spanned marker,
 * lying compressed sizes, structure-aware field fuzzing).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { GcrError } from '../../src/errors.js';
import type { ImportLimits } from '../../src/ingest/limits.js';
import { SafeZipReader, ZIP_REASONS, sanitizeEntryName } from '../../src/ingest/zip.js';
import { buildZip } from '../helpers/zip-builder.js';
import type { ZipEntrySpec } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';

const MIB = 1024 * 1024;

/** Deterministic, incompressible-ish bytes (LCG), so tests are reproducible and the ratio guard stays quiet. */
function noise(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

/** `String.prototype.isWellFormed` needs lib ES2024; this is the same check: no lone UTF-16 surrogate. */
function isWellFormed(s: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

function u64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** Collects `unhandledRejection`/`uncaughtException` while `fn` runs plus a settle period (stream teardown is async). */
async function withoutStrayErrors<T>(fn: () => Promise<T>): Promise<{ value: T; stray: unknown[] }> {
  const stray: unknown[] = [];
  const onRejection = (e: unknown): void => void stray.push(e);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onRejection);
  try {
    const value = await fn();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { value, stray };
  } finally {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onRejection);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// sanitizeEntryName: truncation must cut between code points / escapes, never inside them
// ---------------------------------------------------------------------------------------------------------------

test('sanitizeEntryName(): truncation never splits a surrogate pair or an escape sequence, at any alignment', () => {
  const pieces: Array<[string, string]> = [
    ['astral letter', '\u{1d49c}'], // MATHEMATICAL SCRIPT CAPITAL A: a letter outside the BMP (2 UTF-16 units)
    ['astral emoji (escaped)', '\u{1f600}'],
    ['bidi override (escaped)', '‮'],
    ['control (escaped)', '\u0001'],
  ];
  for (const [label, piece] of pieces) {
    for (let prefix = 0; prefix <= 90; prefix++) {
      const input = 'a'.repeat(prefix) + piece.repeat(8);
      const out = sanitizeEntryName(input);
      assert.ok(isWellFormed(out), `${label}, prefix ${prefix}: result contains a lone surrogate: ${JSON.stringify(out)}`);
      assert.ok(out.length <= 80, `${label}, prefix ${prefix}: length ${out.length}`);
      if (out.endsWith('...')) {
        const kept = out.slice(0, -3);
        assert.ok(!/\\u\{[0-9a-f]*$/.test(kept), `${label}, prefix ${prefix}: cut inside an escape sequence: ${JSON.stringify(out)}`);
      }
    }
  }
  // Names that fit exactly are returned whole (no ellipsis), including astral letters.
  const exact = 'b'.repeat(76) + '\u{1d49c}\u{1d49c}'.slice(0, 2);
  assert.equal(sanitizeEntryName(exact).length, 78);
  assert.ok(!sanitizeEntryName(exact).endsWith('...'));
  assert.equal(sanitizeEntryName('x'.repeat(80)), 'x'.repeat(80));
  assert.equal(sanitizeEntryName('x'.repeat(81)), 'x'.repeat(77) + '...');
});

// ---------------------------------------------------------------------------------------------------------------
// open(): user-input errors are never "internal" errors
// ---------------------------------------------------------------------------------------------------------------

test('open(): a symlink loop and an over-long path are IMPORT_INPUT_NOT_FOUND (user input), not INTERNAL_ERROR', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX errno semantics');
    return;
  }
  await withTempDir(async (dir) => {
    await symlink('loop-b.zip', join(dir, 'loop-a.zip'));
    await symlink('loop-a.zip', join(dir, 'loop-b.zip'));
    const cases: Array<[string, string]> = [
      ['symlink loop (ELOOP)', join(dir, 'loop-a.zip')],
      ['name longer than NAME_MAX (ENAMETOOLONG)', join(dir, 'n'.repeat(5000) + '.zip')],
      ['path through a symlink loop', join(dir, 'loop-a.zip', 'inner.zip')],
    ];
    for (const [label, path] of cases) {
      await assert.rejects(SafeZipReader.open(path), (e: unknown) => {
        assert.ok(e instanceof GcrError, label);
        assert.equal(e.code, 'IMPORT_INPUT_NOT_FOUND', `${label}: ${e.code} ${JSON.stringify(e.details)}`);
        assert.ok(e.details?.['reason'] === 'NOT_FOUND' || e.details?.['reason'] === 'NOT_READABLE', label);
        assert.ok(!e.message.includes(dir), `${label}: message leaks the directory`);
        assert.ok(!JSON.stringify(e.details ?? {}).includes(dir), `${label}: details leak the directory`);
        return true;
      });
    }
    // A file used as a directory is "not found", as before.
    await writeFile(join(dir, 'plain.zip'), 'x');
    await assert.rejects(SafeZipReader.open(join(dir, 'plain.zip', 'child')), (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_INPUT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// readBuffer(): the limit that tripped must be named correctly
// ---------------------------------------------------------------------------------------------------------------

test('readBuffer(): the default cap is reported as maxElementBytes, an explicit cap as maxBytes (never as an unrelated limit)', async () => {
  const zip = buildZip([{ name: 'a.bin', data: noise(2000, 3), method: 'store' }]);
  const r = SafeZipReader.fromBuffer(zip, { maxElementBytes: 1000 });
  await assert.rejects(r.readBuffer('a.bin'), (e: unknown) => {
    assert.ok(e instanceof GcrError);
    assert.equal(e.code, 'IMPORT_LIMIT_EXCEEDED');
    assert.equal(e.details?.['reason'], 'ENTRY_EXCEEDS_READ_LIMIT');
    assert.equal(e.details?.['limit'], 'maxElementBytes', 'raising maxEntryUncompressedBytes would NOT help here');
    assert.equal(e.details?.['max'], 1000);
    assert.equal(e.details?.['observed'], 2000);
    return true;
  });
  await assert.rejects(r.readBuffer('a.bin', 1500), (e: unknown) => {
    assert.ok(e instanceof GcrError);
    assert.equal(e.details?.['reason'], 'ENTRY_EXCEEDS_READ_LIMIT');
    assert.equal(e.details?.['limit'], 'maxBytes');
    assert.equal(e.details?.['max'], 1500);
    return true;
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Streams that are torn down or starved while running
// ---------------------------------------------------------------------------------------------------------------

for (const method of ['deflate', 'store'] as const) {
  test(`close() while a ${method} stream is running: the next read fails with a GcrError (READER_CLOSED), nothing is left unhandled`, async () => {
    const data = noise(2 * MIB, 5);
    await withTempDir(async (dir) => {
      const path = join(dir, 'closing.zip');
      await writeFile(path, buildZip([{ name: 'a.bin', data, method }]));
      const { value, stray } = await withoutStrayErrors(async () => {
        const r = await SafeZipReader.open(path);
        let received = 0;
        let error: unknown;
        try {
          for await (const chunk of r.stream('a.bin')) {
            received += chunk.length;
            if (received === chunk.length) await r.close(); // close right after the first chunk
          }
        } catch (e) {
          error = e;
        }
        return { received, error };
      });
      assert.ok(value.error instanceof GcrError, `expected GcrError, got ${String(value.error)}`);
      assert.equal(value.error.code, 'INVALID_ARGUMENT');
      assert.equal(value.error.details?.['reason'], 'READER_CLOSED');
      assert.ok(value.received < data.length, 'the stream must not complete after close()');
      assert.deepEqual(stray, [], 'no unhandled rejection / uncaught exception');
    });
  });

  test(`a file that shrinks while a ${method} stream is running ends in DATA_TRUNCATED, not a hang or a raw error`, async () => {
    const data = noise(2 * MIB, 6);
    await withTempDir(async (dir) => {
      const path = join(dir, 'shrinking.zip');
      await writeFile(path, buildZip([{ name: 'a.bin', data, method }]));
      const { value, stray } = await withoutStrayErrors(async () => {
        const r = await SafeZipReader.open(path);
        let error: unknown;
        let first = true;
        try {
          for await (const _chunk of r.stream('a.bin')) {
            if (first) {
              first = false;
              await truncate(path, 100_000);
            }
          }
        } catch (e) {
          error = e;
        }
        await r.close();
        return error;
      });
      assert.ok(value instanceof GcrError, `expected GcrError, got ${String(value)}`);
      assert.equal(value.code, 'IMPORT_ZIP_UNSAFE');
      assert.equal(value.details?.['reason'], 'DATA_TRUNCATED');
      assert.deepEqual(stray, []);
    });
  });
}

test('abandoning streams and closing the reader at the same time never leaks an error to the process (stress)', async () => {
  const data = noise(MIB, 8);
  await withTempDir(async (dir) => {
    const path = join(dir, 'abandon.zip');
    await writeFile(path, buildZip([{ name: 'd.bin', data, method: 'deflate' }, { name: 's.bin', data, method: 'store' }]));
    const { stray } = await withoutStrayErrors(async () => {
      for (let i = 0; i < 120; i++) {
        for (const name of ['d.bin', 's.bin']) {
          const r = await SafeZipReader.open(path);
          const it = r.stream(name)[Symbol.asyncIterator]();
          await it.next();
          if (i % 3 === 0) {
            const pending = it.next();
            await r.close();
            await pending.catch(() => undefined);
          } else if (i % 3 === 1) {
            await it.return?.();
            await r.close();
          } else {
            const pending = it.next();
            await it.return?.();
            await r.close();
            await pending.catch(() => undefined);
          }
        }
      }
    });
    assert.deepEqual(stray, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Lying compressed sizes
// ---------------------------------------------------------------------------------------------------------------

test('a deflate entry whose declared compressed range is padded far beyond the real stream still yields exactly the verified bytes', async () => {
  const data = Buffer.from('hello world '.repeat(500));
  for (const [label, padding] of [
    ['zeros', Buffer.alloc(3 * MIB)],
    ['noise', noise(3 * MIB, 9)],
  ] as const) {
    const rawCompressed = Buffer.concat([deflateRawSync(data), padding]);
    const r = SafeZipReader.fromBuffer(buildZip([{ name: 'padded.bin', rawCompressed, data }]));
    const t0 = Date.now();
    const out = await r.readBuffer('padded.bin');
    assert.ok(out.equals(data), `${label}: output differs`);
    assert.ok(Date.now() - t0 < 3000, `${label}: padded entry took too long`);
    assert.equal(r.totalInflatedBytes, data.length, `${label}: only real output is charged to the budget`);
  }
});

test('the compressed-size lie cannot raise total output above ratio x the bytes the archive really spends on the entry', async () => {
  // 1 MiB of zeros deflates to ~1 KiB: an honest header says ~1000:1, far above the default 200:1 -> refused before inflating.
  const zeros = Buffer.alloc(MIB);
  const full = deflateRawSync(zeros);
  const strict = SafeZipReader.fromBuffer(buildZip([{ name: 'z.bin', rawCompressed: full, data: zeros }]));
  assert.throws(() => strict.stream('z.bin'), (e: unknown) => e instanceof GcrError && e.details?.['reason'] === 'COMPRESSION_RATIO');
  // Padding the entry with junk until the DECLARED ratio is acceptable also grows the archive by the same amount: the
  // archive-wide amplification stays bounded by the ratio.
  const padded = Buffer.concat([full, Buffer.alloc(MIB / 100)]);
  const lenient = SafeZipReader.fromBuffer(buildZip([{ name: 'z.bin', rawCompressed: padded, data: zeros }]));
  const archiveBytes = buildZip([{ name: 'z.bin', rawCompressed: padded, data: zeros }]).length;
  const out = await lenient.readBuffer('z.bin');
  assert.ok(out.length <= 200 * archiveBytes, `amplification ${(out.length / archiveBytes).toFixed(0)}:1 exceeds the ratio limit`);
});

// ---------------------------------------------------------------------------------------------------------------
// Structure branches that had no test
// ---------------------------------------------------------------------------------------------------------------

test('a spanned-archive marker (PK 07 08) without an end record is a damaged ZIP (EOCD_NOT_FOUND), not "not a zip"', () => {
  const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x07, 0x08]), noise(200, 1)]);
  assert.throws(
    () => SafeZipReader.fromBuffer(buf),
    (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_ZIP_UNSAFE' && e.details?.['reason'] === 'EOCD_NOT_FOUND',
  );
});

test('ZIP64 disk-number field in the central directory: zero is accepted, anything else is MULTIDISK, a short field is malformed', () => {
  // The disk field (0xFFFF) and both sizes are saturated, so the ZIP64 extra must hold usize, csize and the 4-byte disk number.
  const withDisk = (payloadTail: Buffer): Buffer =>
    buildZip([{ name: 'd.bin', data: 'disk', method: 'store', diskStartOverride: 0xffff, zip64: true, zip64ExtraPayload: Buffer.concat([u64(4), u64(4), payloadTail]) }]);
  const reader = SafeZipReader.fromBuffer(withDisk(Buffer.from([0, 0, 0, 0])));
  assert.equal(reader.entries()[0]?.name, 'd.bin');
  assert.throws(
    () => SafeZipReader.fromBuffer(withDisk(Buffer.from([1, 0, 0, 0]))),
    (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_ZIP_UNSAFE' && e.details?.['reason'] === 'MULTIDISK',
  );
  assert.throws(
    () => SafeZipReader.fromBuffer(withDisk(Buffer.from([0, 0]))), // 2 of the 4 disk bytes
    (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_ZIP_UNSAFE' && e.details?.['reason'] === 'ZIP64_EXTRA_MALFORMED',
  );
});

test('ZIP_REASONS: no duplicates, and every declared reason is used by the implementation (the list cannot go stale)', () => {
  assert.equal(new Set(ZIP_REASONS).size, ZIP_REASONS.length, 'duplicate reasons');
  const src = readFileSync(new URL('../../../src/ingest/zip.ts', import.meta.url), 'utf8');
  const listStart = src.indexOf('export const ZIP_REASONS');
  const listEnd = src.indexOf('] as const;', listStart);
  const rest = src.slice(0, listStart) + src.slice(listEnd);
  for (const reason of ZIP_REASONS) {
    assert.ok(rest.includes(`'${reason}'`), `reason ${reason} is declared but never thrown`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Structure-aware field fuzzing: overwrite every 16/32-bit position with boundary values
// ---------------------------------------------------------------------------------------------------------------

test('field fuzz: boundary values written over EVERY 16/32-bit position -> a GcrError, or the original bytes; never a raw error or a stall', { timeout: 120_000 }, async () => {
  const body = Buffer.from('[{"id":1,"t":"hello"},{"id":2}]'.repeat(20));
  const bases: Array<[string, Buffer]> = [
    [
      'mixed',
      buildZip(
        [
          { name: 'a.json', data: body },
          { name: 'dir/', data: '', method: 'store' },
          { name: 'dir/b.json', data: body, method: 'store' },
          { name: 'dd.json', data: body, dataDescriptor: true },
          { name: 'c.txt', data: 'xyz', method: 'store' },
        ],
        { archiveComment: 'cmt', prefix: Buffer.from('STUBSTUB') },
      ),
    ],
    [
      'zip64',
      buildZip(
        [
          { name: 'a.json', data: body, zip64: { offset: true } },
          { name: 'b.json', data: body, method: 'store', zip64: true },
        ],
        { zip64Eocd: true },
      ),
    ],
  ];
  const limits: Partial<ImportLimits> = { maxTotalInflatedBytes: MIB, maxEntryUncompressedBytes: MIB, maxElementBytes: MIB, maxEntries: 100 };
  const special32 = [0, 0x7fffffff, 0xffffffff];
  const special16 = [0, 0x8000, 0xffff];
  let cases = 0;
  let accepted = 0;
  let slowest = 0;
  for (const [label, base] of bases) {
    const reference = new Map<string, Buffer>();
    const baseline = SafeZipReader.fromBuffer(base, limits);
    for (const e of baseline.entries()) if (!e.isDirectory) reference.set(e.name, await baseline.readBuffer(e.name));
    for (const width of [4, 2] as const) {
      for (let off = 0; off + width <= base.length; off++) {
        for (const v of width === 4 ? special32 : special16) {
          const b = Buffer.from(base);
          if (width === 4) b.writeUInt32LE(v, off);
          else b.writeUInt16LE(v, off);
          if (b.equals(base)) continue;
          cases++;
          const t0 = process.hrtime.bigint();
          const where = `${label} width ${width} offset ${off} value ${v}`;
          try {
            const r = SafeZipReader.fromBuffer(b, limits);
            accepted++;
            for (const e of r.entries()) {
              if (e.isDirectory) continue;
              try {
                const got = await r.readBuffer(e.name);
                const want = reference.get(e.name);
                assert.ok(want !== undefined && got.equals(want), `${where}: verified bytes differ from the original for ${JSON.stringify(sanitizeEntryName(e.name))}`);
              } catch (err) {
                if (!(err instanceof GcrError)) throw err;
              }
            }
          } catch (err) {
            assert.ok(err instanceof GcrError, `${where}: raw error ${String(err)}`);
          }
          slowest = Math.max(slowest, Number(process.hrtime.bigint() - t0) / 1e6);
        }
      }
    }
  }
  assert.ok(cases > 10_000, `only ${cases} cases ran`);
  assert.ok(accepted > 0, 'sanity: some mutations are benign');
  assert.ok(slowest < 500, `slowest single case took ${slowest.toFixed(0)} ms`);
});
