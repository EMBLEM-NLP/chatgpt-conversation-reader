/**
 * Robustness of SafeZipReader against damaged and hostile bytes: truncation at EVERY byte position (buffers and files)
 * and fake end-of-central-directory records. (Corruption fuzzing lives in zip.fuzz.test.ts.)
 * The invariant everywhere: the reader either works or throws a GcrError - never a raw RangeError/TypeError, never a hang,
 * and never an internal PARSE_FAILURE (which would mean a parser bug was caught by the safety net).
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { SafeZipReader } from '../../src/ingest/zip.js';
import { buildZip } from '../helpers/zip-builder.js';
import type { ZipEntrySpec, ZipOptions } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';

const ACCEPTABLE_CODES = new Set(['IMPORT_ZIP_UNSAFE', 'IMPORT_LIMIT_EXCEEDED', 'IMPORT_UNSUPPORTED_FORMAT', 'INVALID_ARGUMENT']);

function assertAcceptable(e: unknown, context: string): GcrError {
  assert.ok(e instanceof GcrError, `${context}: non-GcrError thrown: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  assert.ok(ACCEPTABLE_CODES.has(e.code), `${context}: unexpected code ${e.code}`);
  assert.notEqual(e.details?.['reason'], 'PARSE_FAILURE', `${context}: parser bug swallowed by the safety net (cause: ${String(e.cause)})`);
  return e;
}

/** Open the bytes and read every file entry; both steps may only fail with an acceptable GcrError. */
async function exercise(buf: Buffer, context: string): Promise<'opened' | 'rejected'> {
  let reader: SafeZipReader;
  try {
    reader = SafeZipReader.fromBuffer(buf);
  } catch (e) {
    assertAcceptable(e, `${context} (open)`);
    return 'rejected';
  }
  for (const info of reader.entries()) {
    if (info.isDirectory) continue;
    try {
      await reader.readBuffer(info.name, 1024 * 1024);
    } catch (e) {
      assertAcceptable(e, `${context} (read)`);
    }
  }
  return 'opened';
}

const SMALL: ZipEntrySpec[] = [
  { name: 'conversations.json', data: '[{"id":"c1","title":"hello"}]'.repeat(10), method: 'deflate' },
  { name: 'notes/readme.txt', data: 'read me', method: 'store' },
  { name: 'notes/', method: 'store', unixMode: 0o040755 },
  { name: 'caf\u00e9.txt', data: 'unicode name', method: 'deflate' },
];

function isDirectorySpec(e: ZipEntrySpec): boolean {
  return typeof e.name === 'string' && e.name.endsWith('/');
}

/** A corpus covering the structural variants the parser has code paths for. */
const CORPUS: Array<[string, Buffer]> = [
  ['plain + comment', buildZip(SMALL, { archiveComment: 'a small archive comment' })],
  ['store only', buildZip(SMALL.map((e) => ({ ...e, method: 'store' as const })))],
  ['sfx prefix (absolute offsets)', buildZip(SMALL, { prefix: Buffer.from('#!/bin/sh\nexit 0\n'.repeat(3)) })],
  ['sfx prefix (relative offsets)', buildZip(SMALL, { prefix: Buffer.from('MZ stub '.repeat(8)), prefixRelativeOffsets: true })],
  ['data descriptors', buildZip(SMALL.map((e) => ({ ...e, dataDescriptor: !isDirectorySpec(e) })))],
  [
    'zip64 everywhere',
    buildZip(
      SMALL.map((e, i) => (isDirectorySpec(e) ? e : { ...e, zip64: i % 2 === 0 ? true : { offset: true } })),
      { zip64Eocd: true },
    ),
  ],
  ['empty archive', buildZip([])],
];

test('truncation at EVERY byte position is rejected with a GcrError (and the full archive opens)', { timeout: 60_000 }, async () => {
  const t0 = Date.now();
  let cases = 0;
  for (const [label, zip] of CORPUS) {
    assert.equal(await exercise(zip, `${label} (full)`), 'opened', `${label}: the untouched archive must open`);
    for (let k = 0; k < zip.length; k++) {
      let threw: unknown;
      try {
        SafeZipReader.fromBuffer(zip.subarray(0, k));
      } catch (e) {
        threw = e;
      }
      assert.ok(threw !== undefined, `${label}: truncated to ${k}/${zip.length} bytes was accepted`);
      const err = assertAcceptable(threw, `${label} @${k}`);
      assert.ok(err.code === 'IMPORT_ZIP_UNSAFE' || err.code === 'IMPORT_UNSUPPORTED_FORMAT', `${label} @${k}: ${err.code}`);
      cases++;
    }
  }
  assert.ok(cases > 1500, `swept ${cases} truncation points`);
  assert.ok(Date.now() - t0 < 20_000, 'the sweep must not be slow (hang guard)');
});

test('truncated FILES (open() path, not just buffers) are rejected at many cut points', { timeout: 60_000 }, async () => {
  const [, zip] = CORPUS[5] as [string, Buffer]; // the ZIP64 variant has the most structure
  await withTempDir(async (dir) => {
    const path = join(dir, 'cut.zip');
    for (let k = 0; k < zip.length; k += 7) {
      await writeFile(path, zip.subarray(0, k));
      await assert.rejects(SafeZipReader.open(path), (e: unknown) => {
        assertAcceptable(e, `open @${k}`);
        return true;
      });
    }
    await writeFile(path, zip);
    const r = await SafeZipReader.open(path);
    assert.equal(r.entries().length, SMALL.length);
    await r.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fake end-of-central-directory records
// ---------------------------------------------------------------------------------------------------------------

/** Build an archive whose comment is exactly `rawComment` (bytes), bypassing the builder's UTF-8 encoding of comments. */
function withRawComment(entries: ZipEntrySpec[], rawComment: Buffer, opts: ZipOptions = {}): Buffer {
  const zip = Buffer.from(buildZip(entries, { ...opts, archiveComment: 'x'.repeat(rawComment.length) }));
  rawComment.copy(zip, zip.length - rawComment.length);
  return zip;
}

function fakeEocd(opts: { entries?: number; commentLength?: number; trailing?: Buffer } = {}): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(opts.entries ?? 0, 8);
  b.writeUInt16LE(opts.entries ?? 0, 10);
  b.writeUInt16LE(opts.commentLength ?? 0, 20);
  return opts.trailing === undefined ? b : Buffer.concat([b, opts.trailing]);
}

const REAL: ZipEntrySpec[] = [
  { name: 'real-1.json', data: '{"real":1}', method: 'store' },
  { name: 'real-2.json', data: '{"real":2}', method: 'deflate' },
];

test('fake EOCD inside the comment, NOT reaching end of file: ignored, the real directory is used', async () => {
  const comment = Buffer.concat([Buffer.from('prefix '), fakeEocd({ entries: 0, commentLength: 0, trailing: Buffer.from(' and some more comment text after it') })]);
  const r = SafeZipReader.fromBuffer(withRawComment(REAL, comment));
  assert.deepEqual(
    r.entries().map((e) => e.name),
    ['real-1.json', 'real-2.json'],
    'a signature planted in the comment must not replace the real directory',
  );
  assert.equal((await r.readBuffer('real-1.json')).toString(), '{"real":1}');

  // Several planted signatures, including one whose comment-length field points just past the end of the file.
  const many = Buffer.concat([fakeEocd({ commentLength: 1 }), fakeEocd({ entries: 7, commentLength: 0xffff }), Buffer.from([0x50, 0x4b, 0x05, 0x06]), fakeEocd({ entries: 9, commentLength: 3 })]);
  assert.equal(SafeZipReader.fromBuffer(withRawComment(REAL, many)).entries().length, 2);
});

test('fake EOCD at the very end of the comment (self-consistent, claims an EMPTY archive): rejected as ambiguous, never trusted', () => {
  const attacked = withRawComment(REAL, Buffer.concat([Buffer.from('padding'), fakeEocd({ entries: 0 })]));
  assert.throws(
    () => SafeZipReader.fromBuffer(attacked),
    (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_ZIP_UNSAFE' && e.details?.['reason'] === 'EOCD_AMBIGUOUS',
  );
});

test('a complete second archive hidden in the comment (polyglot) is rejected as ambiguous', () => {
  const hidden = buildZip([{ name: 'attacker.json', data: '{"evil":true}', method: 'store' }]);
  assert.throws(
    () => SafeZipReader.fromBuffer(withRawComment(REAL, hidden)),
    (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_ZIP_UNSAFE' && e.details?.['reason'] === 'EOCD_AMBIGUOUS',
  );
});

test('an archive appended to another (concatenation) is read as the LAST archive with the first as a prefix, like standard tools', async () => {
  const first = buildZip([{ name: 'first.txt', data: 'first', method: 'store' }]);
  const second = buildZip([{ name: 'second.txt', data: 'second', method: 'store' }], { prefix: first, prefixRelativeOffsets: true });
  const r = SafeZipReader.fromBuffer(second);
  assert.deepEqual(
    r.entries().map((e) => e.name),
    ['second.txt'],
  );
  assert.equal((await r.readBuffer('second.txt')).toString(), 'second');
});

test('maximum-length (65535 byte) archive comment is handled; one byte more is not an EOCD', async () => {
  const maxed = SafeZipReader.fromBuffer(buildZip(REAL, { archiveComment: 'c'.repeat(0xffff) }));
  assert.equal(maxed.entries().length, 2);
  // Hand-forge a comment-length field that is 0x10000 bytes away from the EOCD: impossible in 16 bits, so it is junk after the archive.
  const tooLong = Buffer.concat([buildZip(REAL), Buffer.alloc(0x10000, 0x41)]);
  assert.throws(() => SafeZipReader.fromBuffer(tooLong), (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_ZIP_UNSAFE');
});
