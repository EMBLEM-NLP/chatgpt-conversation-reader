/**
 * SafeZipReader: every rejection class. Each case asserts the exact GcrError code AND the stable reason code, that the
 * message names the entry INDEX, and that hostile names / file-system paths never appear in messages.
 */
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { GcrError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';
import type { ImportLimits } from '../../src/ingest/limits.js';
import { SafeZipReader } from '../../src/ingest/zip.js';
import { buildZip } from '../helpers/zip-builder.js';
import type { ZipEntrySpec, ZipOptions } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';

const GOOD: ZipEntrySpec = { name: 'ok.txt', data: 'fine', method: 'store' };
const UNSAFE: ErrorCode = 'IMPORT_ZIP_UNSAFE';
const LIMIT: ErrorCode = 'IMPORT_LIMIT_EXCEEDED';

/** Messages must never contain control characters or anything that looks like an absolute file-system path. */
function assertHygienic(e: GcrError): void {
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/.test(e.message), `message has control characters: ${JSON.stringify(e.message)}`);
  assert.ok(!/(^|[\s"'(])(\/(tmp|home|root|var|etc|usr)\b|[A-Za-z]:[\\/])/.test(e.message), `message looks like it has a path: ${e.message}`);
  assert.ok(e.message.length < 300, 'messages stay short');
}

function reject(buf: Buffer, code: ErrorCode, reason: string, limits?: Partial<ImportLimits>): GcrError {
  let caught: unknown;
  try {
    SafeZipReader.fromBuffer(buf, limits);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught !== undefined, `archive was accepted but must be rejected (${reason})`);
  assert.ok(caught instanceof GcrError, `expected GcrError, got ${String(caught)}`);
  assert.equal(caught.code, code, `code (reason=${String(caught.details?.['reason'])})`);
  assert.equal(caught.details?.['reason'], reason);
  assertHygienic(caught);
  return caught;
}

/** [label, name, expected reason, expected code]. Index of the bad entry is always 1 (GOOD is entry 0). */
const BAD_NAMES: Array<[string, string | Buffer, string, ErrorCode?, boolean?]> = [
  // (4th = code, default UNSAFE; 5th = noUtf8Flag)
  ['empty', '', 'NAME_EMPTY'],
  ['NUL byte', Buffer.from('a\u0000b'), 'NAME_CONTROL_CHAR'],
  ['leading NUL', Buffer.from([0, 0x61]), 'NAME_CONTROL_CHAR'],
  ['C0 SOH', 'a\u0001b', 'NAME_CONTROL_CHAR'],
  ['C0 US', 'a\u001fb', 'NAME_CONTROL_CHAR'],
  ['DEL', 'a\u007fb', 'NAME_CONTROL_CHAR'],
  ['newline', 'line\nbreak.txt', 'NAME_CONTROL_CHAR'],
  ['tab', 'tab\there.txt', 'NAME_CONTROL_CHAR'],
  ['ANSI escape', 'esc\u001b[31mred.txt', 'NAME_CONTROL_CHAR'],
  ['absolute path', '/etc/passwd', 'NAME_ABSOLUTE'],
  ['absolute short', '/x', 'NAME_ABSOLUTE'],
  ['UNC', '//host/share/file.txt', 'NAME_UNC'],
  ['drive only', 'C:', 'NAME_DRIVE_PREFIX'],
  ['drive absolute', 'C:/x', 'NAME_DRIVE_PREFIX'],
  ['drive lowercase relative', 'c:evil.txt', 'NAME_DRIVE_PREFIX'],
  ['backslash', 'a\\b.txt', 'NAME_BACKSLASH'],
  ['backslash traversal', '..\\..\\evil.txt', 'NAME_BACKSLASH'],
  ['backslash UNC', '\\\\host\\share\\x', 'NAME_BACKSLASH'],
  ['drive with backslash', 'Z:\\x', 'NAME_BACKSLASH'],
  ['dotdot only', '..', 'NAME_DOT_DOT'],
  ['dotdot leading', '../evil.txt', 'NAME_DOT_DOT'],
  ['dotdot middle', 'a/../b.txt', 'NAME_DOT_DOT'],
  ['dotdot trailing', 'a/b/..', 'NAME_DOT_DOT'],
  ['dotdot dir', '../', 'NAME_DOT_DOT'],
  ['dot only', '.', 'NAME_DOT_SEGMENT'],
  ['dot leading', './x.txt', 'NAME_DOT_SEGMENT'],
  ['dot middle', 'a/./b.txt', 'NAME_DOT_SEGMENT'],
  ['dot trailing', 'a/.', 'NAME_DOT_SEGMENT'],
  ['empty segment', 'a//b.txt', 'NAME_EMPTY_SEGMENT'],
  ['empty trailing segment', 'a//', 'NAME_EMPTY_SEGMENT'],
  // look-alikes that become dangerous under NFKC
  ['fullwidth dots and slash', '\uff0e\uff0e\uff0fevil.txt', 'NAME_DOT_DOT'],
  ['two-dot leader', '\u2025/evil.txt', 'NAME_DOT_DOT'],
  ['fullwidth backslash', 'a\uff3cb.txt', 'NAME_BACKSLASH'],
  ['fullwidth solidus absolute', '\uff0fabs.txt', 'NAME_ABSOLUTE'],
  ['fullwidth drive', '\uff23\uff1a/x', 'NAME_DRIVE_PREFIX'],
  // invisible / spoofing characters
  ['C1 control (NEL)', 'a\u0085b.txt', 'NAME_FORMAT_CHAR'],
  ['line separator', 'a\u2028b.txt', 'NAME_FORMAT_CHAR'],
  ['paragraph separator', 'a\u2029b.txt', 'NAME_FORMAT_CHAR'],
  ['bidi override', 'evil\u202etxt.exe', 'NAME_FORMAT_CHAR'],
  ['bidi isolate', 'a\u2066b.txt', 'NAME_FORMAT_CHAR'],
  // encodings: flagged UTF-8 must be valid; raw bytes are checked even when decoding is a fallback
  ['flagged invalid UTF-8', Buffer.from([0x61, 0xff, 0x62]), 'NAME_ENCODING'],
  ['flagged encoded surrogate', Buffer.from([0xed, 0xa0, 0x80]), 'NAME_ENCODING'],
  ['flagged overlong slash', Buffer.from([0xc0, 0xaf]), 'NAME_ENCODING'],
  ['unflagged invalid UTF-8 + dotdot', Buffer.from([0xff, 0x2f, 0x2e, 0x2e, 0x2f, 0x78]), 'NAME_DOT_DOT', UNSAFE, true],
  ['unflagged invalid UTF-8 + NUL', Buffer.from([0xff, 0x00]), 'NAME_CONTROL_CHAR', UNSAFE, true],
  ['unflagged invalid UTF-8 + backslash', Buffer.from([0xff, 0x5c, 0x78]), 'NAME_BACKSLASH', UNSAFE, true],
  ['unflagged invalid UTF-8 + absolute', Buffer.from([0x2f, 0xff]), 'NAME_ABSOLUTE', UNSAFE, true],
  ['unflagged invalid UTF-8 + drive', Buffer.from([0x43, 0x3a, 0xff]), 'NAME_DRIVE_PREFIX', UNSAFE, true],
];

for (const [label, name, reason, code = UNSAFE, noUtf8Flag = false] of BAD_NAMES) {
  test(`name rejected (${label}) -> ${reason}`, () => {
    const spec: ZipEntrySpec = { name, data: 'x', method: 'store', ...(noUtf8Flag ? { noUtf8Flag: true } : {}) };
    const e = reject(buildZip([GOOD, spec]), code, reason);
    assert.equal(e.details?.['entryIndex'], 1, 'details carry the entry index');
    assert.match(e.message, /entry #1\b/, 'message names the entry index');
    assert.ok(e.message.includes(reason), 'message carries the reason code');
    // Never echo the hostile name (checked for every name long enough not to appear by accident).
    const asText = typeof name === 'string' ? name : name.toString('latin1');
    if (asText.length >= 3) assert.ok(!e.message.includes(asText), 'message must not echo the entry name');
  });
}

test('name length limit: over maxEntryNameBytes -> IMPORT_LIMIT_EXCEEDED, exactly at the limit is fine', () => {
  const e = reject(buildZip([GOOD, { name: 'n'.repeat(1025), data: 'x', method: 'store' }]), LIMIT, 'NAME_TOO_LONG');
  assert.equal(e.details?.['limit'], 'maxEntryNameBytes');
  assert.doesNotThrow(() => SafeZipReader.fromBuffer(buildZip([{ name: 'n'.repeat(1024), data: 'x', method: 'store' }])));
  // The limit counts BYTES, not characters: 6 x 2-byte characters = 12 bytes.
  reject(buildZip([{ name: '\u00e9'.repeat(6), data: 'x', method: 'store' }]), LIMIT, 'NAME_TOO_LONG', { maxEntryNameBytes: 11 });
  assert.doesNotThrow(() => SafeZipReader.fromBuffer(buildZip([{ name: '\u00e9'.repeat(6), data: 'x', method: 'store' }]), { maxEntryNameBytes: 12 }));
});

const DUPLICATES: Array<[string, string, string]> = [
  ['identical', 'a.txt', 'a.txt'],
  ['case-insensitive', 'a.txt', 'A.TXT'],
  ['case-insensitive in directories', 'Dir/File.json', 'dir/file.JSON'],
  ['NFC vs NFD', 'caf\u00e9.txt', 'cafe\u0301.txt'],
  ['NFD vs NFC + case', 'CAFE\u0301.txt', 'caf\u00e9.TXT'],
  ['file vs directory of the same name', 'name', 'name/'],
  ['full case folding (sharp s)', 'Stra\u00dfe.txt', 'STRASSE.txt'],
];
for (const [label, first, second] of DUPLICATES) {
  test(`duplicate names rejected (${label})`, () => {
    // A directory entry must carry no data (otherwise DIRECTORY_WITH_DATA would fire first and hide what we test here).
    const spec = (name: string, data: string): ZipEntrySpec => (name.endsWith('/') ? { name, method: 'store', unixMode: 0o040755 } : { name, data, method: 'store' });
    const e = reject(buildZip([spec(first, '1'), spec(second, '2')]), UNSAFE, 'NAME_DUPLICATE');
    assert.equal(e.details?.['entryIndex'], 1);
    assert.equal(e.details?.['firstIndex'], 0);
  });
}

test('names that merely look similar are NOT duplicates', () => {
  assert.doesNotThrow(() =>
    SafeZipReader.fromBuffer(
      buildZip([
        { name: 'a/b.txt', data: '1', method: 'store' },
        { name: 'a-b.txt', data: '2', method: 'store' },
        { name: 'b/a/b.txt', data: '3', method: 'store' },
        { name: 'a.txt', data: '4', method: 'store' },
        { name: 'a.txt.bak', data: '5', method: 'store' },
      ]),
    ),
  );
});

for (const id of [1, 6, 9, 12, 14, 93, 95, 98, 99]) {
  test(`unsupported compression method ${id} -> UNSUPPORTED_METHOD`, () => {
    const e = reject(buildZip([GOOD, { name: 'm.bin', data: 'x', method: 'store', methodIdOverride: id }]), UNSAFE, 'UNSUPPORTED_METHOD');
    assert.equal(e.details?.['method'], id);
  });
}

test('encrypted entries are rejected: traditional, strong, masked headers, local-only flag, AES', () => {
  reject(buildZip([GOOD, { name: 'e.bin', data: 'x', method: 'store', encrypted: true }]), UNSAFE, 'ENCRYPTED');
  reject(buildZip([GOOD, { name: 'e.bin', data: 'x', method: 'store', extraFlags: 0x0040 }]), UNSAFE, 'ENCRYPTED'); // strong encryption
  reject(buildZip([GOOD, { name: 'e.bin', data: 'x', method: 'store', extraFlags: 0x2000 }]), UNSAFE, 'ENCRYPTED'); // masked headers
  reject(buildZip([GOOD, { name: 'e.bin', data: 'x', method: 'store', localExtraFlags: 0x0001 }]), UNSAFE, 'ENCRYPTED'); // lies only locally
  reject(buildZip([GOOD, { name: 'e.bin', data: 'x', method: 'store', encrypted: true, methodIdOverride: 99 }]), UNSAFE, 'ENCRYPTED'); // WinZip AES
  reject(buildZip([GOOD, { name: 'e.bin', data: 'x', method: 'store', extraFlags: 0x0020 }]), UNSAFE, 'UNSUPPORTED_FLAGS'); // compressed patched data
});

test('symlink and special-file entries are rejected (unix mode in the high external-attribute bits)', () => {
  reject(buildZip([GOOD, { name: 'link', data: '/etc/passwd', method: 'store', unixMode: 0o120777 }]), UNSAFE, 'SYMLINK');
  reject(buildZip([GOOD, { name: 'link', data: 'x', method: 'store', unixMode: 0o120000 }]), UNSAFE, 'SYMLINK');
  reject(buildZip([GOOD, { name: 'link', data: 'x', method: 'store', unixMode: 0o120644, madeByHost: 19 }]), UNSAFE, 'SYMLINK'); // macOS host
  for (const mode of [0o010644, 0o020644, 0o060644, 0o140644]) {
    reject(buildZip([GOOD, { name: 'node', data: '', method: 'store', unixMode: mode }]), UNSAFE, 'SPECIAL_FILE'); // fifo, chr, blk, socket
  }
  // A symlink hidden behind a directory-looking or regular-looking name is still a symlink.
  reject(buildZip([GOOD, { name: 'looks-regular.txt', data: 'target', method: 'store', unixMode: 0o120777 }]), UNSAFE, 'SYMLINK');
});

test('not-a-zip inputs -> IMPORT_UNSUPPORTED_FORMAT (never a crash)', () => {
  const inputs: Array<[string, Buffer]> = [
    ['empty', Buffer.alloc(0)],
    ['3 bytes', Buffer.from('abc')],
    ['text', Buffer.from('hello world, this is not a zip file at all.')],
    ['json', Buffer.from('[{"id":1,"title":"x"}]')],
    ['22 zero bytes', Buffer.alloc(22)],
    ['png header', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)])],
    ['gzip', Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(100, 1)])],
  ];
  for (const [label, buf] of inputs) {
    let caught: unknown;
    try {
      SafeZipReader.fromBuffer(buf);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof GcrError, label);
    assert.equal(caught.code, 'IMPORT_UNSUPPORTED_FORMAT', label);
    assert.equal(caught.details?.['reason'], 'NOT_A_ZIP', label);
  }
});

test('zip-looking but damaged inputs are IMPORT_ZIP_UNSAFE (EOCD_NOT_FOUND)', () => {
  const zip = buildZip([GOOD]);
  reject(buildZip([GOOD], { omitEocd: true }), UNSAFE, 'EOCD_NOT_FOUND');
  reject(zip.subarray(0, 30), UNSAFE, 'EOCD_NOT_FOUND');
  reject(Buffer.concat([zip, Buffer.from('trailing junk after the archive')]), UNSAFE, 'EOCD_NOT_FOUND'); // comment would not reach EOF
  reject(buildZip([GOOD], { trailingBytes: Buffer.from([0]) }), UNSAFE, 'EOCD_NOT_FOUND');
  reject(buildZip([GOOD], { commentLengthOverride: 10 }), UNSAFE, 'EOCD_NOT_FOUND'); // claims a comment that is not there
  reject(buildZip([GOOD], { archiveComment: 'abcdef', commentLengthOverride: 3 }), UNSAFE, 'EOCD_NOT_FOUND'); // claims less than present
});

test('fake EOCD planted inside the comment: ambiguous end records are rejected, never guessed', () => {
  // The fake is a complete, self-consistent EOCD at the very end of the file: it claims "0 entries, empty directory".
  // An implementation that scanned from the end and trusted the first signature would silently hide every entry.
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  const zip = buildZip([GOOD], { archiveComment: 'x'.repeat(22) });
  const attacked = Buffer.from(zip);
  fake.copy(attacked, attacked.length - 22);
  reject(attacked, UNSAFE, 'EOCD_AMBIGUOUS');
});

test('multi-disk archives are rejected', () => {
  reject(buildZip([GOOD], { eocdDiskOverride: 1 }), UNSAFE, 'MULTIDISK');
  reject(buildZip([GOOD], { eocdCdDiskOverride: 1 }), UNSAFE, 'MULTIDISK');
  reject(buildZip([GOOD], { entriesThisDiskOverride: 0 }), UNSAFE, 'MULTIDISK');
  reject(buildZip([GOOD, { name: 'd2.bin', data: 'x', method: 'store', diskStartOverride: 1 }]), UNSAFE, 'MULTIDISK');
});

test('central directory offset/size out of bounds or implausible', () => {
  reject(buildZip([GOOD], { cdOffsetOverride: 10_000_000 }), UNSAFE, 'CD_OUT_OF_BOUNDS');
  reject(buildZip([GOOD], { cdSizeOverride: 0x7fffffff }), UNSAFE, 'CD_OUT_OF_BOUNDS');
  reject(buildZip([GOOD], { cdSizeOverride: 10 }), UNSAFE, 'CD_SIZE_MISMATCH'); // smaller than one 46-byte record
  reject(buildZip([GOOD, GOOD2()], { declaredEntryCount: 1000 }), UNSAFE, 'CD_SIZE_MISMATCH'); // count implausible for the size
  // An offset that is too SMALL looks like a prefix and shifts every local offset: caught by the local header check.
  const z = buildZip([GOOD]);
  const cdStart = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  reject(buildZip([GOOD], { cdOffsetOverride: cdStart - 3 }), UNSAFE, 'LOCAL_HEADER_BAD_SIGNATURE');
});

function GOOD2(): ZipEntrySpec {
  return { name: 'second-entry-with-a-reasonably-long-name-to-keep-record-sizes-plausible.txt', data: 'two', method: 'store' };
}

test('entry count in the EOCD must equal the entries actually parsed (too high and too low)', () => {
  const long = (n: string): ZipEntrySpec => ({ name: n.repeat(40), data: 'x', method: 'store' });
  const entries = [long('a'), long('b')];
  reject(buildZip(entries, { declaredEntryCount: 3 }), UNSAFE, 'ENTRY_COUNT_MISMATCH');
  reject(buildZip(entries, { declaredEntryCount: 1 }), UNSAFE, 'ENTRY_COUNT_MISMATCH');
  assert.doesNotThrow(() => SafeZipReader.fromBuffer(buildZip(entries, { declaredEntryCount: 2 })));
});

test('corrupted central-directory signature / local header signature / local name / local method', () => {
  const z = Buffer.from(buildZip([GOOD, GOOD2()]));
  const cdStart = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const second = Buffer.from(z);
  second[cdStart + 1] = 0x00; // break the LAST record's signature
  const e = reject(second, UNSAFE, 'CD_BAD_SIGNATURE');
  assert.equal(e.details?.['entryIndex'], 1);

  reject(buildZip([GOOD, { name: 'b.txt', data: 'x', method: 'store', localSignatureOverride: 0x11223344 }]), UNSAFE, 'LOCAL_HEADER_BAD_SIGNATURE');
  reject(buildZip([GOOD, { name: 'b.txt', data: 'x', method: 'store', localName: 'c.txt' }]), UNSAFE, 'LOCAL_NAME_MISMATCH'); // same length, other bytes
  reject(buildZip([GOOD, { name: 'b.txt', data: 'x', method: 'store', localName: 'b.txt.exe' }]), UNSAFE, 'LOCAL_NAME_MISMATCH'); // different length
  reject(buildZip([GOOD, { name: 'b.txt', data: 'xxxx', method: 'deflate', localMethodIdOverride: 0 }]), UNSAFE, 'LOCAL_METHOD_MISMATCH');
});

test('out-of-bounds and overlapping local ranges', () => {
  reject(buildZip([GOOD, { name: 'b.txt', data: 'x', method: 'store', localOffsetOverride: 0x00ffffff }]), UNSAFE, 'ENTRY_OUT_OF_BOUNDS');
  // 0xFFFFFFFF is the ZIP64 marker, not an offset: without a ZIP64 extra field it is a malformed ZIP64 structure.
  reject(buildZip([GOOD, { name: 'b.txt', data: 'x', method: 'store', localOffsetOverride: 0xffffffff }]), UNSAFE, 'ZIP64_EXTRA_MALFORMED');
  reject(buildZip([GOOD, { name: 'b.txt', data: 'x', method: 'store', localOffsetOverride: 0xfffffffe }]), UNSAFE, 'ENTRY_OUT_OF_BOUNDS');
  // Declared compressed size runs past the central directory.
  reject(buildZip([GOOD, { name: 'b.txt', data: 'abc', method: 'store', declaredCompressedSize: 100_000, declaredUncompressedSize: 100_000 }]), UNSAFE, 'ENTRY_OUT_OF_BOUNDS');
  reject(buildZip([GOOD, { name: 'b.txt', data: 'abc', method: 'deflate', declaredCompressedSize: 100_000 }]), UNSAFE, 'ENTRY_OUT_OF_BOUNDS');
  // Offset that lands on non-header bytes.
  reject(buildZip([GOOD, { name: 'b.txt', data: 'x', method: 'store', localOffsetOverride: 7 }]), UNSAFE, 'LOCAL_HEADER_BAD_SIGNATURE');

  // Data range of entry 0 swallows entry 1's header.
  const swallow = buildZip([
    // Local header (30) + name (5) + 3 real bytes put entry 1's header at offset 38; claiming 40 data bytes ends at 75 -
    // inside the archive (the central directory starts at 77) but past entry 1's header.
    { name: 'a.txt', data: 'abc', method: 'store', declaredCompressedSize: 40, declaredUncompressedSize: 40 },
    { name: 'b.txt', data: 'bbbb', method: 'store' },
  ]);
  reject(swallow, UNSAFE, 'ENTRY_OVERLAP');

  // The "overlapping files" trick: entry 1 points INTO entry 0's data, where a complete local header + body is embedded.
  const inner = buildZip([{ name: 'b.txt', data: 'bbbb', method: 'store' }]).subarray(0, 30 + 5 + 4);
  const quine = buildZip([
    { name: 'a.txt', data: inner, method: 'store' },
    { name: 'b.txt', data: 'bbbb', method: 'store', localOffsetOverride: 30 + 5 },
  ]);
  const e = reject(quine, UNSAFE, 'ENTRY_OVERLAP');
  assert.equal(e.details?.['entryIndex'], 1);
});

test('inconsistent sizes: STORE with different sizes, directory carrying data', () => {
  reject(buildZip([GOOD, { name: 's.bin', data: 'abc', method: 'store', declaredUncompressedSize: 5 }]), UNSAFE, 'SIZE_INCONSISTENT');
  reject(buildZip([GOOD, { name: 'd/', data: 'content in a dir', method: 'store' }]), UNSAFE, 'DIRECTORY_WITH_DATA');
});

test('limits that reject the whole archive at open time', () => {
  const three = buildZip([GOOD, GOOD2(), { name: 'third.txt', data: 'x', method: 'store' }]);
  assert.equal(reject(three, LIMIT, 'TOO_MANY_ENTRIES', { maxEntries: 2 }).details?.['limit'], 'maxEntries');
  assert.doesNotThrow(() => SafeZipReader.fromBuffer(three, { maxEntries: 3 }));
  assert.equal(reject(three, LIMIT, 'ARCHIVE_TOO_LARGE', { maxZipFileBytes: three.length - 1 }).details?.['limit'], 'maxZipFileBytes');
  assert.doesNotThrow(() => SafeZipReader.fromBuffer(three, { maxZipFileBytes: three.length }));
  reject(buildZip([GOOD, { name: 'x.bin', data: 'x', method: 'store', extra: Buffer.alloc(100) }]), LIMIT, 'EXTRA_FIELD_TOO_LARGE', { maxExtraFieldBytes: 50 });
  reject(buildZip([GOOD, { name: 'x.bin', data: 'x', method: 'store', comment: 'c'.repeat(100) }]), LIMIT, 'EXTRA_FIELD_TOO_LARGE', { maxExtraFieldBytes: 50 });
  // Declared uncompressed size above the per-entry cap is refused up front, even though nothing is inflated yet.
  const big = buildZip([GOOD, { name: 'big.bin', data: 'abc', method: 'deflate', declaredUncompressedSize: 5000 }]);
  assert.equal(reject(big, LIMIT, 'ENTRY_TOO_LARGE', { maxEntryUncompressedBytes: 1000 }).details?.['limit'], 'maxEntryUncompressedBytes');
});

test('ONE bad entry among many rejects the WHOLE archive', () => {
  const entries: ZipEntrySpec[] = Array.from({ length: 100 }, (_, i) => ({ name: `part-${i}.json`, data: `{"i":${i}}`, method: 'store' as const }));
  entries.push({ name: 'sub/../../escape.txt', data: 'x', method: 'store' });
  const e = reject(buildZip(entries), UNSAFE, 'NAME_DOT_DOT');
  assert.equal(e.details?.['entryIndex'], 100);
});

// ---------------------------------------------------------------------------------------------------------------
// ZIP64
// ---------------------------------------------------------------------------------------------------------------

function field(id: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(id, 0);
  h.writeUInt16LE(payload.length, 2);
  return Buffer.concat([h, payload]);
}
function u64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
const LONG = (c: string): ZipEntrySpec => ({ name: c.repeat(40), data: 'x', method: 'store' });

test('malformed ZIP64 end structures are rejected', () => {
  const entries = [LONG('a'), LONG('b')];
  reject(buildZip(entries, { zip64Eocd: { omitLocator: true } }), UNSAFE, 'ZIP64_MISSING'); // saturated fields, no locator
  reject(buildZip(entries, { zip64Eocd: { omitRecord: true } }), UNSAFE, 'ZIP64_MALFORMED'); // locator points at nothing
  reject(buildZip(entries, { zip64Eocd: { recordSizeOverride: 10 } }), UNSAFE, 'ZIP64_MALFORMED'); // below the 44-byte minimum
  reject(buildZip(entries, { zip64Eocd: { recordSizeOverride: 1000 } }), UNSAFE, 'ZIP64_MALFORMED'); // does not abut the locator
  reject(buildZip(entries, { zip64Eocd: { recordSignatureOverride: 0x12345678 } }), UNSAFE, 'ZIP64_MALFORMED');
  reject(buildZip(entries, { zip64Eocd: { locatorOffsetOverride: 5 } }), UNSAFE, 'ZIP64_MISMATCH'); // locator prefix != directory prefix
  reject(buildZip(entries, { zip64Eocd: { locatorDiskOverride: 1 } }), UNSAFE, 'MULTIDISK');
  reject(buildZip(entries, { zip64Eocd: { totalDisksOverride: 2 } }), UNSAFE, 'MULTIDISK');
  reject(buildZip(entries, { zip64Eocd: { diskOverride: 1 } }), UNSAFE, 'ZIP64_MISMATCH'); // EOCD says disk 0, the ZIP64 record says 1
  // Non-saturated EOCD values must AGREE with the ZIP64 record.
  reject(buildZip(entries, { zip64Eocd: { saturate: false, entriesOverride: 99 } }), UNSAFE, 'ZIP64_MISMATCH');
  reject(buildZip(entries, { zip64Eocd: { saturate: false, cdSizeOverride: 12345 } }), UNSAFE, 'ZIP64_MISMATCH');
  reject(buildZip(entries, { zip64Eocd: { saturate: false, cdOffsetOverride: 7 } }), UNSAFE, 'ZIP64_MISMATCH');
  // A saturated EOCD whose ZIP64 record lies about the directory.
  reject(buildZip(entries, { zip64Eocd: { entriesOverride: 3 } }), UNSAFE, 'ENTRY_COUNT_MISMATCH');
  reject(buildZip(entries, { zip64Eocd: { cdOffsetOverride: 10_000_000 } }), UNSAFE, 'CD_OUT_OF_BOUNDS');
  reject(buildZip(entries, { zip64Eocd: { cdSizeOverride: 2 ** 60 } }), UNSAFE, 'CD_OUT_OF_BOUNDS'); // u64 beyond 2^53 must not wrap
  reject(buildZip(entries, { zip64Eocd: { cdOffsetOverride: 2 ** 62 } }), UNSAFE, 'CD_OUT_OF_BOUNDS');
});

test('ZIP64 entry count above maxEntries is a limit trip, before any entry is parsed', () => {
  reject(buildZip([LONG('a')], { zip64Eocd: { entriesOverride: 1_000_000_000 } }), LIMIT, 'TOO_MANY_ENTRIES');
});

test('malformed ZIP64 entry fields are rejected', () => {
  const base = { name: 'z.bin', data: 'x'.repeat(100), method: 'deflate' as const };
  // Saturated sizes without any ZIP64 extra field.
  reject(buildZip([GOOD, { ...base, zip64: true, zip64OmitExtra: true }]), UNSAFE, 'ZIP64_EXTRA_MALFORMED');
  // Too short: needs usize + csize (16 bytes).
  reject(buildZip([GOOD, { ...base, zip64: true, zip64ExtraPayload: u64(100) }]), UNSAFE, 'ZIP64_EXTRA_MALFORMED');
  reject(buildZip([GOOD, { ...base, zip64: { offset: true }, zip64ExtraPayload: Buffer.concat([u64(100), u64(10)]) }]), UNSAFE, 'ZIP64_EXTRA_MALFORMED'); // offset missing
  // Broken framing after the ZIP64 field (3 stray bytes cannot be a field header) - only enforced when ZIP64 is needed.
  reject(buildZip([GOOD, { ...base, zip64: true, extra: Buffer.from([1, 2, 3]) }]), UNSAFE, 'ZIP64_EXTRA_MALFORMED');
  // A field that claims more bytes than the block holds.
  reject(buildZip([GOOD, { ...base, zip64: true, extra: Buffer.from([0x34, 0x12, 0xff, 0x00, 1]) }]), UNSAFE, 'ZIP64_EXTRA_MALFORMED');
  // Two ZIP64 fields: different parsers would pick different ones.
  reject(buildZip([GOOD, { ...base, zip64: true, extra: field(1, Buffer.concat([u64(1), u64(1)])) }]), UNSAFE, 'ZIP64_EXTRA_MALFORMED');
  // The same garbage framing is simply ignored when ZIP64 is not in play.
  assert.doesNotThrow(() => SafeZipReader.fromBuffer(buildZip([GOOD, { name: 'plain.bin', data: 'x', method: 'store', extra: Buffer.from([1, 2, 3]) }])));
});

test('ZIP64 values are bounded by the same limits; u64 beyond 2^53 never wraps into a small number', () => {
  const small = { name: 'z.bin', data: 'abc', method: 'deflate' as const };
  // 5 GiB declared: legal ZIP64, but above the 2 GiB per-entry default.
  reject(buildZip([GOOD, { ...small, zip64: true, declaredUncompressedSize: 5 * 2 ** 30 }]), LIMIT, 'ENTRY_TOO_LARGE');
  // 2^60 uncompressed: more than Number can represent exactly -> treated as infinite -> limit.
  reject(buildZip([GOOD, { ...small, zip64: true, zip64ExtraPayload: Buffer.concat([u64(2n ** 60n), u64(10)]) }]), LIMIT, 'ENTRY_TOO_LARGE');
  // 2^64 - 1 compressed size: data range cannot fit in the archive.
  reject(buildZip([GOOD, { ...small, zip64: true, zip64ExtraPayload: Buffer.concat([u64(3), u64(2n ** 64n - 1n)]) }]), UNSAFE, 'ENTRY_OUT_OF_BOUNDS');
  // Offsets: beyond the archive, and beyond 2^53.
  reject(buildZip([GOOD, { ...small, zip64: { offset: true }, localOffsetOverride: 5_000_000_000 }]), UNSAFE, 'ENTRY_OUT_OF_BOUNDS');
  reject(buildZip([GOOD, { ...small, zip64: { offset: true }, zip64ExtraPayload: Buffer.concat([u64(3), u64(10), u64(2n ** 63n)]) }]), UNSAFE, 'ENTRY_OUT_OF_BOUNDS');
});

// ---------------------------------------------------------------------------------------------------------------
// open(): path handling and resource hygiene
// ---------------------------------------------------------------------------------------------------------------

test('open(): missing file, directory, and non-zip file; messages never contain the path', async () => {
  await withTempDir(async (dir) => {
    const missing = join(dir, 'does-not-exist-12345.zip');
    await assert.rejects(SafeZipReader.open(missing), (e: unknown) => {
      assert.ok(e instanceof GcrError);
      assert.equal(e.code, 'IMPORT_INPUT_NOT_FOUND');
      assert.ok(!e.message.includes(dir) && !e.message.includes('does-not-exist'), `message leaks the path: ${e.message}`);
      assert.ok(!JSON.stringify(e.details ?? {}).includes(dir));
      return true;
    });
    await mkdir(join(dir, 'a-directory'));
    await assert.rejects(SafeZipReader.open(join(dir, 'a-directory')), (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_UNSUPPORTED_FORMAT');
    const notZip = join(dir, 'notes.zip');
    await writeFile(notZip, 'definitely not a zip');
    await assert.rejects(SafeZipReader.open(notZip), (e: unknown) => {
      assert.ok(e instanceof GcrError);
      assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
      assert.ok(!e.message.includes(dir));
      return true;
    });
    for (const bad of ['', '\u0000x', undefined as unknown as string]) {
      await assert.rejects(SafeZipReader.open(bad), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
    }
  });
});

test('open(): a rejected archive closes its file handle (no descriptor leak)', async (t) => {
  if (!existsSync('/proc/self/fd')) {
    t.skip('/proc/self/fd not available on this platform');
    return;
  }
  await withTempDir(async (dir) => {
    const bad = join(dir, 'bad.zip');
    await writeFile(bad, buildZip([GOOD, { name: '../evil.txt', data: 'x', method: 'store' }]));
    const before = readdirSync('/proc/self/fd').length;
    for (let i = 0; i < 200; i++) {
      await assert.rejects(SafeZipReader.open(bad), (e: unknown) => e instanceof GcrError && e.code === UNSAFE);
    }
    const after = readdirSync('/proc/self/fd').length;
    assert.ok(after <= before + 2, `file descriptors leaked: before=${before} after=${after}`);
  });
});

test('open(): the same rejections apply to the file-handle path as to fromBuffer', async () => {
  await withTempDir(async (dir) => {
    const cases: Array<[Buffer, ErrorCode, string]> = [
      [buildZip([GOOD, { name: '/abs', data: 'x', method: 'store' }]), UNSAFE, 'NAME_ABSOLUTE'],
      [buildZip([GOOD, { name: 'l', data: 'x', method: 'store', unixMode: 0o120777 }]), UNSAFE, 'SYMLINK'],
      [buildZip([GOOD], { omitEocd: true }), UNSAFE, 'EOCD_NOT_FOUND'],
      [buildZip([LONG('a'), LONG('b')], { zip64Eocd: { omitRecord: true } }), UNSAFE, 'ZIP64_MALFORMED'],
    ];
    let i = 0;
    for (const [buf, code, reason] of cases) {
      const path = join(dir, `case-${i++}.zip`);
      await writeFile(path, buf);
      await assert.rejects(SafeZipReader.open(path), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, code);
        assert.equal(e.details?.['reason'], reason);
        return true;
      });
    }
    // And limits are applied by open() too.
    const path = join(dir, 'limit.zip');
    await writeFile(path, buildZip([GOOD, GOOD2()]));
    await assert.rejects(SafeZipReader.open(path, { maxEntries: 1 }), (e: unknown) => e instanceof GcrError && e.code === LIMIT);
    await assert.rejects(SafeZipReader.open(path, { maxEntries: 0 }), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
  });
});

test('fromBuffer(): invalid arguments are INVALID_ARGUMENT', () => {
  assert.throws(() => SafeZipReader.fromBuffer('not a buffer' as unknown as Buffer), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
  assert.throws(() => SafeZipReader.fromBuffer(buildZip([GOOD]), { maxEntries: -1 }), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
});

// A silent-regression guard: the table of ZipOptions used above must keep compiling against the builder.
const _typecheck: ZipOptions = { zip64Eocd: { saturate: true } };
void _typecheck;
