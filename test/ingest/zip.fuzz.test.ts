/**
 * Fuzzing of SafeZipReader: exhaustive single-byte corruption of a structural corpus, seeded random mutation (insert,
 * delete, overwrite) and random bytes dressed up as a ZIP.
 * The invariant everywhere: the reader either works or throws a GcrError - never a raw RangeError/TypeError, never a hang,
 * and never an internal PARSE_FAILURE (which would mean a parser bug was caught by the safety net).
 * (Truncation sweeps and fake end records live in zip.truncation.test.ts.)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import { SafeZipReader } from '../../src/ingest/zip.js';
import { buildZip } from '../helpers/zip-builder.js';
import type { ZipEntrySpec } from '../helpers/zip-builder.js';

const SEED = 20261010;
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

test('exhaustive single-byte corruption (xor 0xFF, xor 0x01, zero, 0xFF at every offset): GcrError or success, never a crash', { timeout: 120_000 }, async () => {
  const t0 = Date.now();
  let opened = 0;
  let rejected = 0;
  for (const [label, zip] of CORPUS) {
    for (let i = 0; i < zip.length; i++) {
      for (const mutate of [(b: number) => b ^ 0xff, (b: number) => b ^ 0x01, () => 0x00, () => 0xff]) {
        const copy = Buffer.from(zip);
        copy[i] = mutate(copy[i] as number);
        if (copy.equals(zip)) continue;
        if ((await exercise(copy, `${label} byte ${i}`)) === 'opened') opened++;
        else rejected++;
      }
    }
  }
  // Corrupting file DATA or comment bytes legitimately still opens (the data is checked when read), so only sanity-check
  // that the sweep really exercised both outcomes; the real assertion is the no-crash invariant inside exercise().
  assert.ok(rejected > 1000 && opened > 1000, `sweep should hit both outcomes (opened=${opened}, rejected=${rejected})`);
  assert.ok(Date.now() - t0 < 60_000);
});

test(`seeded random mutation (insert/delete/overwrite runs), seed=${SEED}`, { timeout: 120_000 }, async () => {
  const edit = fc.record({
    pos: fc.nat(100_000),
    kind: fc.constantFrom('overwrite', 'insert', 'delete'),
    bytes: fc.uint8Array({ minLength: 1, maxLength: 24 }),
  });
  await fc.assert(
    fc.asyncProperty(fc.nat(CORPUS.length - 1), fc.array(edit, { minLength: 1, maxLength: 5 }), async (which, edits) => {
      const [label, base] = CORPUS[which] as [string, Buffer];
      let buf = Buffer.from(base);
      for (const e of edits) {
        const p = e.pos % (buf.length + 1);
        const bytes = Buffer.from(e.bytes);
        if (e.kind === 'overwrite') {
          bytes.copy(buf, Math.min(p, Math.max(0, buf.length - bytes.length)), 0, Math.min(bytes.length, buf.length));
        } else if (e.kind === 'insert') {
          buf = Buffer.concat([buf.subarray(0, p), bytes, buf.subarray(p)]);
        } else {
          buf = Buffer.concat([buf.subarray(0, p), buf.subarray(Math.min(buf.length, p + bytes.length))]);
        }
      }
      await exercise(buf, label);
    }),
    { seed: SEED, numRuns: 600 }, // on failure fast-check prints { seed, path } so the case can be replayed
  );
});

test(`random bytes dressed up as a ZIP never crash the parser, seed=${SEED}`, async () => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 400 }), fc.boolean(), async (bytes, withMagic) => {
      const body = Buffer.from(bytes);
      const buf = withMagic ? Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), body]) : body;
      await exercise(buf, 'random');
    }),
    { seed: SEED, numRuns: 500 },
  );
});
