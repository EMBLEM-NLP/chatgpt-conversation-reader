/**
 * Independent adversarial review of src/ingest/zip.ts, round 2: reasons that no test asserted (CD_TRUNCATED, SHORT_READ,
 * LOCAL_HEADER_TRUNCATED), I/O failures while validating and while streaming (fault injection on the real file-handle
 * path), exact boundaries of every limit, and the bounded-output guarantee of sanitizeEntryName for odd arguments.
 */
import assert from 'node:assert/strict';
import { open as fsOpen, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { GcrError } from '../../src/errors.js';
import { SafeZipReader, sanitizeEntryName } from '../../src/ingest/zip.js';
import { buildZip } from '../helpers/zip-builder.js';
import type { ZipEntrySpec } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';

const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function isGcr(code: string, reason: string): (e: unknown) => boolean {
  return (e: unknown): boolean => {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    assert.equal(e.code, code, `code (reason ${String(e.details?.['reason'])})`);
    assert.equal(e.details?.['reason'], reason);
    return true;
  };
}

/** Byte offset of the central-directory record with the given index (records are walked, not guessed). */
function cdRecordOffset(zip: Buffer, index: number): number {
  let eocd = -1;
  for (let p = zip.length - 22; p >= 0; p--) {
    if (zip.readUInt32LE(p) === EOCD_SIG) {
      eocd = p;
      break;
    }
  }
  assert.ok(eocd >= 0, 'test archive has an end record');
  let pos = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < index; i++) {
    assert.equal(zip.readUInt32LE(pos), CD_SIG);
    pos += 46 + zip.readUInt16LE(pos + 28) + zip.readUInt16LE(pos + 30) + zip.readUInt16LE(pos + 32);
  }
  assert.equal(zip.readUInt32LE(pos), CD_SIG);
  return pos;
}

const FILES: ZipEntrySpec[] = [
  { name: 'a.txt', data: 'alpha', method: 'store' },
  { name: 'b.txt', data: 'bravo', method: 'store' },
  { name: 'c.txt', data: 'charlie', method: 'store' },
];

// ---------------------------------------------------------------------------------------------------------------
// CD_TRUNCATED: a record whose variable part runs past the end of the central directory
// ---------------------------------------------------------------------------------------------------------------

test('a central-directory record whose name / extra / comment length runs past the directory is CD_TRUNCATED (entry index named)', () => {
  const base = buildZip(FILES);
  const last = cdRecordOffset(base, 2);
  for (const [label, fieldOffset, value] of [
    ['name length', 28, 400],
    ['extra length', 30, 600],
    ['comment length', 32, 900],
  ] as const) {
    const zip = Buffer.from(base);
    zip.writeUInt16LE(value, last + fieldOffset);
    assert.throws(
      () => SafeZipReader.fromBuffer(zip),
      (e: unknown) => {
        assert.ok(e instanceof GcrError, label);
        assert.equal(e.code, 'IMPORT_ZIP_UNSAFE', label);
        assert.equal(e.details?.['reason'], 'CD_TRUNCATED', label);
        assert.equal(e.details?.['entryIndex'], 2, label);
        assert.match(e.message, /entry #2\b/);
        return true;
      },
      label,
    );
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Fault injection on the real file-handle path: the file "shrinks" (reads hit end of file early) while validating
// ---------------------------------------------------------------------------------------------------------------

type ReadFn = (this: unknown, ...args: unknown[]) => Promise<unknown>;

/**
 * Run `fn` while every FileHandle#read for which `fails(callNumber, position)` is true reports end-of-file (0 bytes), which
 * is exactly what a file that was truncated behind our back looks like. Restored afterwards, also when `fn` throws.
 */
async function withEarlyEof<T>(path: string, fails: (call: number, position: number) => boolean, fn: () => Promise<T>): Promise<T> {
  const probe = await fsOpen(path, 'r');
  const proto = Object.getPrototypeOf(probe) as { read: ReadFn };
  await probe.close();
  const original = proto.read;
  let call = 0;
  proto.read = async function patched(this: unknown, ...args: unknown[]): Promise<unknown> {
    call++;
    const position = args[3];
    if (typeof position === 'number' && fails(call, position)) return { bytesRead: 0, buffer: args[0] };
    return original.apply(this, args);
  };
  try {
    return await fn();
  } finally {
    proto.read = original;
  }
}

test('open(): end of file during validation is a GcrError (SHORT_READ / LOCAL_HEADER_TRUNCATED), never a hang or a raw error', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'shrinks.zip');
    await writeFile(path, buildZip(FILES));

    // 1st read is the tail that holds the end record.
    await withEarlyEof(path, (call) => call === 1, async () => {
      await assert.rejects(SafeZipReader.open(path), isGcr('IMPORT_ZIP_UNSAFE', 'SHORT_READ'));
    });
    // 2nd read is the central-directory window.
    await withEarlyEof(path, (call) => call === 2, async () => {
      await assert.rejects(SafeZipReader.open(path), (e: unknown) => {
        isGcr('IMPORT_ZIP_UNSAFE', 'SHORT_READ')(e);
        assert.equal((e as GcrError).details?.['entryIndex'], 0);
        return true;
      });
    });
    // 3rd read is the first local header (entries are verified in offset order).
    await withEarlyEof(path, (call) => call === 3, async () => {
      await assert.rejects(SafeZipReader.open(path), (e: unknown) => {
        isGcr('IMPORT_ZIP_UNSAFE', 'LOCAL_HEADER_TRUNCATED')(e);
        assert.equal((e as GcrError).details?.['entryIndex'], 0);
        return true;
      });
    });
    // ... and the last one.
    await withEarlyEof(path, (call) => call === 5, async () => {
      await assert.rejects(SafeZipReader.open(path), (e: unknown) => {
        isGcr('IMPORT_ZIP_UNSAFE', 'LOCAL_HEADER_TRUNCATED')(e);
        assert.equal((e as GcrError).details?.['entryIndex'], 2);
        return true;
      });
    });
    // Control: with no fault the same file opens (the patch really is transparent).
    await withEarlyEof(path, () => false, async () => {
      const r = await SafeZipReader.open(path);
      assert.deepEqual(
        r.entries().map((e) => e.name),
        ['a.txt', 'b.txt', 'c.txt'],
      );
      await r.close();
    });
  });
});

test('a failing read (EBADF behind the reader) is INTERNAL_ERROR/READ_FAILED for stream() and readBuffer(), without paths in the message', async () => {
  const data = Buffer.alloc(300_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
  await withTempDir(async (dir) => {
    const path = join(dir, 'broken.zip');
    await writeFile(path, buildZip([{ name: 'd.bin', data, method: 'deflate' }, { name: 's.bin', data, method: 'store' }]));
    const stray: unknown[] = [];
    const onStray = (e: unknown): void => void stray.push(e);
    process.on('unhandledRejection', onStray);
    process.on('uncaughtException', onStray);
    try {
      for (const name of ['d.bin', 's.bin']) {
        const reader = await SafeZipReader.open(path);
        // Sabotage: close the descriptor behind the reader's back (the reader itself is NOT closed).
        const internals = reader as unknown as { source: { handle: { close(): Promise<void> } } };
        await internals.source.handle.close();
        for (const attempt of [() => reader.readBuffer(name), async () => {
          for await (const chunk of reader.stream(name)) void chunk;
        }]) {
          await assert.rejects(attempt(), (e: unknown) => {
            assert.ok(e instanceof GcrError, `${name}: expected GcrError, got ${String(e)}`);
            assert.equal(e.code, 'INTERNAL_ERROR');
            assert.equal(e.details?.['reason'], 'READ_FAILED');
            assert.ok(!e.message.includes(dir) && !JSON.stringify(e.details).includes(dir), 'no file-system path in the error');
            return true;
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('unhandledRejection', onStray);
      process.off('uncaughtException', onStray);
    }
    assert.deepEqual(stray, [], 'no unhandled rejection / uncaught exception');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Exact boundaries: the limit itself is allowed, one more is not
// ---------------------------------------------------------------------------------------------------------------

test('every size limit is inclusive: a value exactly at the limit is accepted, one more is IMPORT_LIMIT_EXCEEDED', async () => {
  // maxEntries
  const three = buildZip(FILES);
  assert.equal(SafeZipReader.fromBuffer(three, { maxEntries: 3 }).entries().length, 3);
  assert.throws(() => SafeZipReader.fromBuffer(three, { maxEntries: 2 }), isGcr('IMPORT_LIMIT_EXCEEDED', 'TOO_MANY_ENTRIES'));
  // maxZipFileBytes
  assert.equal(SafeZipReader.fromBuffer(three, { maxZipFileBytes: three.length }).entries().length, 3);
  assert.throws(() => SafeZipReader.fromBuffer(three, { maxZipFileBytes: three.length - 1 }), isGcr('IMPORT_LIMIT_EXCEEDED', 'ARCHIVE_TOO_LARGE'));
  // maxExtraFieldBytes (applies to the extra block AND to the entry comment)
  for (const spec of [{ extra: Buffer.alloc(50) }, { comment: 'c'.repeat(50) }]) {
    const zip = buildZip([{ name: 'x', data: 'x', method: 'store', ...spec }]);
    assert.equal(SafeZipReader.fromBuffer(zip, { maxExtraFieldBytes: 50 }).entries().length, 1);
    assert.throws(() => SafeZipReader.fromBuffer(zip, { maxExtraFieldBytes: 49 }), isGcr('IMPORT_LIMIT_EXCEEDED', 'EXTRA_FIELD_TOO_LARGE'));
  }
  // maxEntryUncompressedBytes
  const big = buildZip([{ name: 'b', data: Buffer.alloc(1000, 7), method: 'store' }]);
  assert.equal(SafeZipReader.fromBuffer(big, { maxEntryUncompressedBytes: 1000 }).entries().length, 1);
  assert.throws(() => SafeZipReader.fromBuffer(big, { maxEntryUncompressedBytes: 999 }), isGcr('IMPORT_LIMIT_EXCEEDED', 'ENTRY_TOO_LARGE'));
  // maxTotalInflatedBytes: exactly the budget is fine once, the next byte is not (pre-check and mid-stream)
  const exact = SafeZipReader.fromBuffer(big, { maxTotalInflatedBytes: 1000 });
  assert.equal((await exact.readBuffer('b')).length, 1000);
  assert.equal(exact.totalInflatedBytes, 1000);
  await assert.rejects(exact.readBuffer('b'), isGcr('IMPORT_LIMIT_EXCEEDED', 'TOTAL_BUDGET'));
  await assert.rejects(SafeZipReader.fromBuffer(big, { maxTotalInflatedBytes: 999 }).readBuffer('b'), isGcr('IMPORT_LIMIT_EXCEEDED', 'TOTAL_BUDGET'));
  // readBuffer cap
  await assert.rejects(exact.readBuffer('b', 999), isGcr('IMPORT_LIMIT_EXCEEDED', 'ENTRY_EXCEEDS_READ_LIMIT'));
});

test('ratio guard boundary: declared ratio exactly at the limit passes, one byte denser fails; 64 KiB is the largest exempt size', () => {
  // The guard compares DECLARED sizes, so the lie below only matters for the pre-check that stream() performs.
  const body = Buffer.alloc(200 * 1024, 1);
  const compressed = deflateRawSync(body);
  const csize = 1024;
  const padded = Buffer.concat([compressed, Buffer.alloc(csize - compressed.length)]);
  const entry = (declared: number): Buffer => buildZip([{ name: 'z', rawCompressed: padded, data: body, declaredUncompressedSize: declared }]);
  assert.doesNotThrow(() => SafeZipReader.fromBuffer(entry(csize * 200), { maxCompressionRatio: 200 }).stream('z'), 'usize == csize * ratio');
  assert.throws(() => SafeZipReader.fromBuffer(entry(csize * 200 + 1), { maxCompressionRatio: 200 }).stream('z'), isGcr('IMPORT_LIMIT_EXCEEDED', 'COMPRESSION_RATIO'));

  const exempt = Buffer.alloc(64 * 1024, 1);
  const exemptZip = buildZip([{ name: 'e', rawCompressed: deflateRawSync(exempt), data: exempt }]);
  assert.doesNotThrow(() => SafeZipReader.fromBuffer(exemptZip, { maxCompressionRatio: 1.001 }).stream('e'), '64 KiB is exempt');
  const dense = Buffer.alloc(64 * 1024 + 1, 1);
  const denseZip = buildZip([{ name: 'e', rawCompressed: deflateRawSync(dense), data: dense }]);
  assert.throws(() => SafeZipReader.fromBuffer(denseZip, { maxCompressionRatio: 1.001 }).stream('e'), isGcr('IMPORT_LIMIT_EXCEEDED', 'COMPRESSION_RATIO'));
});

// ---------------------------------------------------------------------------------------------------------------
// Lookup is by exact key only: object-prototype names are ordinary names, and non-string keys never match
// ---------------------------------------------------------------------------------------------------------------

test('entries named like Object.prototype members are ordinary entries; absent ones and non-string keys never resolve', async () => {
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype', '__defineGetter__'];
  const present = SafeZipReader.fromBuffer(buildZip(names.map((name, i) => ({ name, data: `v${i}`, method: i % 2 === 0 ? 'deflate' : 'store' }) satisfies ZipEntrySpec)));
  for (const [i, name] of names.entries()) {
    assert.equal(present.has(name), true, name);
    assert.equal((await present.readBuffer(name)).toString(), `v${i}`, name);
  }
  const absent = SafeZipReader.fromBuffer(buildZip([{ name: 'a', data: 'x', method: 'store' }]));
  for (const name of names) {
    assert.equal(absent.has(name), false, `${name} must not resolve through the prototype chain`);
    assert.throws(() => absent.stream(name), isGcr('INVALID_ARGUMENT', 'ENTRY_NOT_FOUND'));
  }
  for (const key of [undefined, null, 5, {}, ['a'], Symbol('a')] as unknown[]) {
    assert.equal(absent.has(key as string), false);
    assert.throws(() => absent.stream(key as string), isGcr('INVALID_ARGUMENT', 'BAD_ENTRY_NAME'));
    await assert.rejects(absent.readBuffer(key as string), isGcr('INVALID_ARGUMENT', 'BAD_ENTRY_NAME'));
  }
  // A hostile lookup key is echoed only in sanitized, truncated form.
  assert.throws(
    () => absent.stream('x'.repeat(5000) + '‮\u0000'),
    (e: unknown) => e instanceof GcrError && e.message.length < 200 && !/[\u0000-\u001f‮]/.test(e.message),
  );
});

// ---------------------------------------------------------------------------------------------------------------
// sanitizeEntryName: the output is ALWAYS bounded, whatever limit the caller passes
// ---------------------------------------------------------------------------------------------------------------

test('sanitizeEntryName(): the result never exceeds the limit, and a non-finite or fractional limit cannot switch truncation off', () => {
  const hostile = 'x'.repeat(5000) + '\u0001'.repeat(5000);
  for (const limit of [0, 1, 2, 3, 4, 5, 10, 80]) {
    const out = sanitizeEntryName(hostile, limit);
    assert.ok(out.length <= limit, `limit ${limit}: got ${out.length} characters`);
  }
  assert.equal(sanitizeEntryName('abc', 0), '');
  assert.equal(sanitizeEntryName('abc', 2), '..');
  assert.equal(sanitizeEntryName('abc', 3), 'abc');
  assert.equal(sanitizeEntryName('abcd', 3), '...');
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const out = sanitizeEntryName(hostile, limit);
    assert.ok(out.length <= 80, `limit ${String(limit)}: got ${out.length} characters (falls back to the default of 80)`);
  }
  assert.ok(sanitizeEntryName(hostile, 10.9).length <= 10, 'a fractional limit is rounded down');
  assert.ok(sanitizeEntryName(hostile, -7).length === 0, 'a negative limit yields nothing');
});
