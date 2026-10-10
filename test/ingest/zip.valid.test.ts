/**
 * SafeZipReader: archives that MUST be accepted (store/deflate, directories, empty, SFX prefix, data descriptors,
 * ZIP64, UTF-8/legacy names) plus the read API (entries/has/stream/readBuffer/close) and the file-handle path.
 */
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { mkdir, open as openFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { SafeZipReader, sanitizeEntryName } from '../../src/ingest/zip.js';
import { buildZip } from '../helpers/zip-builder.js';
import type { ZipEntrySpec } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';

/** Deterministic pseudo-random, moderately compressible bytes (no Math.random: results must be reproducible). */
function synthetic(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  let s = seed >>> 0;
  const words = ['alpha ', 'beta ', 'gamma ', '{"k":', '"v"}', '\n', 'delta ', '12345 '];
  let i = 0;
  while (i < size) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const w = Buffer.from(words[(s >>> 24) % words.length] as string);
    const n = Math.min(w.length, size - i);
    w.copy(out, i, 0, n);
    i += n;
  }
  return out;
}

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of it) out.push(c);
  return out;
}

test('entries(): store, deflate and directory metadata are reported exactly', () => {
  const zip = buildZip([
    { name: 'a.txt', data: 'hello', method: 'store' },
    { name: 'b/c.json', data: '{"x":1}', method: 'deflate' },
    { name: 'd/', method: 'store', unixMode: 0o040755 },
  ]);
  const r = SafeZipReader.fromBuffer(zip);
  const info = r.entries();
  assert.deepEqual(
    info.map((e) => [e.index, e.name, e.method, e.isDirectory]),
    [
      [0, 'a.txt', 'store', false],
      [1, 'b/c.json', 'deflate', false],
      [2, 'd/', 'store', true],
    ],
  );
  assert.equal(info[0]?.uncompressedSize, 5);
  assert.equal(info[0]?.compressedSize, 5);
  assert.equal(info[0]?.crc32, crc32(Buffer.from('hello')));
  assert.equal(info[1]?.uncompressedSize, 7);
  assert.equal(info[1]?.crc32, crc32(Buffer.from('{"x":1}')));
  assert.equal(info[2]?.uncompressedSize, 0);
  assert.equal(r.has('a.txt'), true);
  assert.equal(r.has('b/c.json'), true);
  assert.equal(r.has('d/'), true);
  assert.equal(r.has('missing.txt'), false);
  assert.equal(r.has('A.TXT'), false, 'lookup is exact; case-insensitivity is only used to REJECT duplicates');
  // entries() returns copies: mutating one must not affect the reader.
  info[0]!.name = 'tampered';
  assert.equal(r.entries()[0]?.name, 'a.txt');
});

test('readBuffer() and stream() return the exact bytes for store and deflate', async () => {
  const text = 'line one\nline two\n'.repeat(50);
  const zip = buildZip([
    { name: 's.txt', data: text, method: 'store' },
    { name: 'd.txt', data: text, method: 'deflate' },
  ]);
  const r = SafeZipReader.fromBuffer(zip);
  assert.equal((await r.readBuffer('s.txt')).toString(), text);
  assert.equal((await r.readBuffer('d.txt')).toString(), text);
  assert.equal(Buffer.concat(await collect(r.stream('d.txt'))).toString(), text);
});

test('large entries stream in bounded chunks and verify CRC at the end', async () => {
  const data = synthetic(3 * 1024 * 1024 + 123, 7);
  const zip = buildZip([
    { name: 'big-deflate.bin', data, method: 'deflate' },
    { name: 'big-store.bin', data, method: 'store' },
  ]);
  const r = SafeZipReader.fromBuffer(zip);
  for (const [name, maxChunk] of [
    ['big-deflate.bin', 64 * 1024],
    ['big-store.bin', 256 * 1024],
  ] as const) {
    const chunks = await collect(r.stream(name));
    assert.ok(chunks.length > 10, `${name}: expected many chunks, got ${chunks.length}`);
    assert.ok(Math.max(...chunks.map((c) => c.length)) <= maxChunk, `${name}: chunk exceeds ${maxChunk}`);
    assert.ok(Buffer.concat(chunks).equals(data), `${name}: content differs`);
  }
  assert.equal(r.totalInflatedBytes, 2 * data.length, 'the cumulative budget counter sees actual bytes');
});

test('empty archive, empty store entry and empty deflate entry are valid', async () => {
  const empty = SafeZipReader.fromBuffer(buildZip([]));
  assert.deepEqual(empty.entries(), []);
  assert.equal(empty.has('x'), false);

  const r = SafeZipReader.fromBuffer(
    buildZip([
      { name: 'e-store', data: '', method: 'store' },
      { name: 'e-deflate', data: '', method: 'deflate' }, // deflateRaw('') is 2 bytes
      { name: 'e-deflate-zero-csize', data: '', method: 'deflate', rawCompressed: Buffer.alloc(0) }, // some writers emit 0 bytes
    ]),
  );
  for (const name of ['e-store', 'e-deflate', 'e-deflate-zero-csize']) {
    assert.equal((await r.readBuffer(name)).length, 0, name);
  }
});

test('self-extracting prefix is supported, with absolute and with archive-relative offsets', async () => {
  // A stub that itself contains zip-looking signatures: they must not confuse the parser.
  const stub = Buffer.concat([
    Buffer.from('MZ-fake-stub'),
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(40, 0x41),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.alloc(18, 0),
  ]);
  const entries = [
    { name: 'one.txt', data: 'first entry', method: 'deflate' as const },
    { name: 'two.txt', data: 'second entry', method: 'store' as const },
  ];
  for (const relative of [false, true]) {
    const r = SafeZipReader.fromBuffer(buildZip(entries, { prefix: stub, prefixRelativeOffsets: relative }));
    assert.equal((await r.readBuffer('one.txt')).toString(), 'first entry', `relative=${relative}`);
    assert.equal((await r.readBuffer('two.txt')).toString(), 'second entry', `relative=${relative}`);
  }
});

test('data-descriptor entries (flag bit 3) are read using central-directory sizes, with and without the signature', async () => {
  const body = synthetic(5000, 3);
  const zip = buildZip([
    { name: 'dd-sig.bin', data: body, method: 'deflate', dataDescriptor: true },
    { name: 'dd-nosig.bin', data: body, method: 'deflate', dataDescriptor: true, descriptorWithoutSignature: true },
    { name: 'dd-store.bin', data: body, method: 'store', dataDescriptor: true },
    { name: 'after.txt', data: 'follows the descriptors', method: 'store' },
  ]);
  const r = SafeZipReader.fromBuffer(zip);
  for (const n of ['dd-sig.bin', 'dd-nosig.bin', 'dd-store.bin']) assert.ok((await r.readBuffer(n)).equals(body), n);
  assert.equal((await r.readBuffer('after.txt')).toString(), 'follows the descriptors');
});

test('ZIP64: end record + locator, ZIP64 entry sizes and offsets, with and without a prefix', async () => {
  const body = synthetic(4000, 5);
  const entries = [
    { name: 'z1.bin', data: body, method: 'deflate' as const, zip64: true },
    { name: 'z2.bin', data: body, method: 'store' as const, zip64: { offset: true } },
    { name: 'z3.bin', data: 'plain entry', method: 'store' as const },
    { name: 'z4.bin', data: body, method: 'deflate' as const, zip64: true, dataDescriptor: true },
  ];
  const variants: Array<[string, Parameters<typeof buildZip>[1]]> = [
    ['eocd64', { zip64Eocd: true }],
    ['eocd64 non-saturated (agreeing values)', { zip64Eocd: { saturate: false } }],
    ['eocd64 + absolute prefix', { zip64Eocd: true, prefix: Buffer.alloc(77, 0x42) }],
    ['eocd64 + relative prefix', { zip64Eocd: true, prefix: Buffer.alloc(77, 0x42), prefixRelativeOffsets: true }],
    ['eocd64 + extensible data sector', { zip64Eocd: { extensibleData: Buffer.from('vendor-extension-data') } }],
    ['entry-level zip64 only (plain EOCD)', {}],
  ];
  for (const [label, opts] of variants) {
    const r = SafeZipReader.fromBuffer(buildZip(entries, opts));
    assert.equal(r.entries().length, 4, label);
    for (const n of ['z1.bin', 'z2.bin', 'z4.bin']) assert.ok((await r.readBuffer(n)).equals(body), `${label}: ${n}`);
    assert.equal((await r.readBuffer('z3.bin')).toString(), 'plain entry', label);
  }
});

test('names: UTF-8 flagged, NFD, unflagged UTF-8, and unflagged non-UTF-8 (decoded as CP437, deterministically)', async () => {
  const nfd = 'cafe\u0301.txt'; // "caf\u00e9" in decomposed form
  const r = SafeZipReader.fromBuffer(
    buildZip([
      { name: 'caf\u00e9/\u65e5\u672c\u8a9e-\ud83d\ude00.txt', data: 'a', method: 'store' },
      { name: nfd, data: 'b', method: 'store' },
      { name: 'unflagged-utf8-\u00e9.txt', data: 'c', method: 'store', noUtf8Flag: true },
      { name: Buffer.from([0x6c, 0x65, 0x67, 0x61, 0x63, 0x79, 0x82, 0x2e, 0x74, 0x78, 0x74]), data: 'd', method: 'store', noUtf8Flag: true }, // "legacy" + 0x82
      { name: Buffer.from([0x6c, 0x65, 0x67, 0x61, 0x63, 0x79, 0x83, 0x2e, 0x74, 0x78, 0x74]), data: 'e', method: 'store', noUtf8Flag: true }, // "legacy" + 0x83
    ]),
  );
  const names = r.entries().map((e) => e.name);
  assert.equal(names[0], 'caf\u00e9/\u65e5\u672c\u8a9e-\ud83d\ude00.txt');
  assert.equal(names[1], nfd, 'names are kept as stored (not normalized)');
  assert.equal(names[2], 'unflagged-utf8-\u00e9.txt');
  // CP437: 0x82 -> U+00E9 (e acute), 0x83 -> U+00E2 (a circumflex). Distinct bytes stay distinct names.
  assert.equal(names[3], 'legacy\u00e9.txt');
  assert.equal(names[4], 'legacy\u00e2.txt');
  assert.equal((await r.readBuffer(names[3] as string)).toString(), 'd');
});

test('metadata that is not needed is skipped: unknown extra fields, Unicode-path extra field, entry comments', async () => {
  // Info-ZIP "Unicode Path" (0x7075) names a DIFFERENT file; it must be ignored so an entry has exactly one name.
  const uniPath = Buffer.concat([Buffer.from([0x75, 0x70, 0x0a, 0x00, 0x01, 0, 0, 0, 0]), Buffer.from('evil.txt')]);
  const unknown = Buffer.from([0xfe, 0xca, 0x03, 0x00, 1, 2, 3]);
  const r = SafeZipReader.fromBuffer(
    buildZip([{ name: 'real.txt', data: 'ok', method: 'store', extra: Buffer.concat([unknown, uniPath]), comment: 'a comment' }]),
  );
  assert.deepEqual(
    r.entries().map((e) => e.name),
    ['real.txt'],
  );
  assert.equal(r.has('evil.txt'), false);
  assert.equal((await r.readBuffer('real.txt')).toString(), 'ok');
});

test('unix mode: regular files and directories pass; link-looking bits on a NON-unix host are not interpreted', () => {
  assert.doesNotThrow(() =>
    SafeZipReader.fromBuffer(
      buildZip([
        { name: 'x', data: '1', method: 'store', unixMode: 0o100755 },
        { name: 'dir/', method: 'store', unixMode: 0o040755 },
        { name: 'dos-host', data: '1', method: 'store', madeByHost: 0, unixMode: 0o120777 },
      ]),
    ),
  );
});

test('a stored entry that is itself a ZIP (with its own end record) does not confuse the outer archive', async () => {
  const inner = buildZip([{ name: 'inner.txt', data: 'inner' }]);
  const outer = buildZip([{ name: 'nested.zip', data: inner, method: 'store' }]);
  const r = SafeZipReader.fromBuffer(outer);
  assert.deepEqual(
    r.entries().map((e) => e.name),
    ['nested.zip'],
  );
  const innerReader = SafeZipReader.fromBuffer(await r.readBuffer('nested.zip'));
  assert.equal((await innerReader.readBuffer('inner.txt')).toString(), 'inner');
});

test('an archive comment is allowed, and a planted EOCD-looking signature that does not reach EOF is ignored', async () => {
  const fakeShort = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(30, 0x07)]); // 34 bytes: comment length field is junk
  const zip = buildZip([{ name: 'real.txt', data: 'real', method: 'store' }], { archiveComment: 'hello ' + fakeShort.toString('latin1') });
  // Build via latin1 so the planted bytes survive the builder's utf8 encoding of the comment.
  const zipBytes = buildZip([{ name: 'real.txt', data: 'real', method: 'store' }], { archiveComment: 'x'.repeat(40) });
  const patched = Buffer.from(zipBytes);
  fakeShort.copy(patched, patched.length - 40 + 3);
  for (const candidate of [zip, patched]) {
    const r = SafeZipReader.fromBuffer(candidate);
    assert.deepEqual(
      r.entries().map((e) => e.name),
      ['real.txt'],
    );
    assert.equal((await r.readBuffer('real.txt')).toString(), 'real');
  }
});

test('many entries (3000) open quickly and resolve by name', async () => {
  const entries = Array.from({ length: 3000 }, (_, i) => ({ name: `export/part-${String(i).padStart(5, '0')}.json`, data: `{"i":${i}}`, method: 'store' as const }));
  const t0 = process.hrtime.bigint();
  const r = SafeZipReader.fromBuffer(buildZip(entries), { maxEntries: 3000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.entries().length, 3000);
  assert.equal((await r.readBuffer('export/part-02999.json')).toString(), '{"i":2999}');
  assert.ok(ms < 2000, `opening 3000 entries took ${ms} ms`);
});

test('open(): file-handle based reader with positional reads, interleaved streams, close()', async () => {
  const a = synthetic(900_000, 11);
  const b = synthetic(700_000, 13);
  const zip = buildZip([
    { name: 'a.bin', data: a, method: 'deflate' },
    { name: 'dir/', method: 'store', unixMode: 0o040755 },
    { name: 'b.bin', data: b, method: 'store' },
  ]);
  await withTempDir(async (dir) => {
    const path = join(dir, 'export.zip');
    await writeFile(path, zip);
    const r = await SafeZipReader.open(path);
    assert.deepEqual(
      r.entries().map((e) => e.name),
      ['a.bin', 'dir/', 'b.bin'],
    );

    // Two streams consumed alternately must not interfere (positional reads share no cursor).
    const itA = r.stream('a.bin')[Symbol.asyncIterator]();
    const itB = r.stream('b.bin')[Symbol.asyncIterator]();
    const gotA: Buffer[] = [];
    const gotB: Buffer[] = [];
    for (let doneA = false, doneB = false; !doneA || !doneB; ) {
      if (!doneA) {
        const s = await itA.next();
        if (s.done) doneA = true;
        else gotA.push(s.value);
      }
      if (!doneB) {
        const s = await itB.next();
        if (s.done) doneB = true;
        else gotB.push(s.value);
      }
    }
    assert.ok(Buffer.concat(gotA).equals(a));
    assert.ok(Buffer.concat(gotB).equals(b));

    await r.close();
    await r.close(); // idempotent
    assert.throws(
      () => r.stream('a.bin'),
      (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && e.details?.['reason'] === 'READER_CLOSED',
    );
    await assert.rejects(
      () => r.readBuffer('b.bin'),
      (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT',
    );
  });
});

test('open(): an archive in a nested temp directory with a prefix and ZIP64 opens identically to fromBuffer', async () => {
  const zip = buildZip([{ name: 'x/y.txt', data: 'zip64 + prefix', method: 'deflate', zip64: { offset: true } }], {
    prefix: Buffer.alloc(300, 0x20),
    prefixRelativeOffsets: true,
    zip64Eocd: true,
  });
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    const path = join(dir, 'a', 'b', 'e.zip');
    await writeFile(path, zip);
    const r = await SafeZipReader.open(path);
    assert.equal((await r.readBuffer('x/y.txt')).toString(), 'zip64 + prefix');
    await r.close();
  });
});

test('stream()/readBuffer() lookup errors are GcrError INVALID_ARGUMENT; readBuffer honours maxBytes', async () => {
  const r = SafeZipReader.fromBuffer(buildZip([{ name: 'a.txt', data: 'x'.repeat(100), method: 'store' }, { name: 'd/', method: 'store', unixMode: 0o040755 }]));
  const bad = (reason: string) => (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && e.details?.['reason'] === reason;
  assert.throws(() => r.stream('nope.txt'), bad('ENTRY_NOT_FOUND'));
  assert.throws(() => r.stream('d/'), bad('ENTRY_IS_DIRECTORY'));
  assert.throws(() => r.stream(undefined as unknown as string), bad('BAD_ENTRY_NAME'));
  await assert.rejects(() => r.readBuffer('a.txt', 0), bad('BAD_MAX_BYTES'));
  await assert.rejects(
    () => r.readBuffer('a.txt', 99),
    (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_LIMIT_EXCEEDED' && e.details?.['reason'] === 'ENTRY_EXCEEDS_READ_LIMIT',
  );
  assert.equal((await r.readBuffer('a.txt', 100)).length, 100, 'exactly at the cap is allowed');
  // The not-found message may quote the requested name, but only in sanitized form.
  try {
    r.stream('bad\u001b[31m\nname');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof GcrError);
    assert.ok(!e.message.includes('\u001b') && !e.message.includes('\n'), 'control characters must be escaped in messages');
  }
});

test('sanitizeEntryName(): escapes non-printables, keeps letters, truncates to 80 characters', () => {
  assert.equal(sanitizeEntryName('plain/name.txt'), 'plain/name.txt');
  assert.equal(sanitizeEntryName('a\u0000b\u001b[31m\nc'), 'a\\u{0}b\\u{1b}[31m\\u{a}c');
  assert.equal(sanitizeEntryName('\u202eevil'), '\\u{202e}evil', 'bidi override must not survive');
  assert.equal(sanitizeEntryName('caf\u00e9-\u65e5\u672c'), 'caf\u00e9-\u65e5\u672c');
  const long = sanitizeEntryName('x'.repeat(500));
  assert.ok(long.length <= 80, `length ${long.length}`);
  assert.ok(long.endsWith('...'));
  const escapedLong = sanitizeEntryName('\u0001'.repeat(100));
  assert.ok(escapedLong.length <= 80, `length ${escapedLong.length}`);
});

test('static policy: ingest modules import only allowed built-ins, no network, console, any, clock or randomness', () => {
  const files = ['limits.ts', 'zip.ts', 'json-stream.ts'];
  const allowedImports = new Set(['node:fs/promises', 'node:stream', 'node:zlib', '../errors.js', './limits.js']);
  for (const f of files) {
    const src = readFileSync(new URL(`../../../src/ingest/${f}`, import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of src.matchAll(/^import (?:type )?[^;]*? from '([^']+)';$/gm)) {
      assert.ok(allowedImports.has(m[1] as string), `${f}: unexpected import ${String(m[1])}`);
    }
    assert.ok(!/node:(?:http|https|http2|net|tls|dns|dgram|child_process|worker_threads|cluster)/.test(code), `${f}: network/process module referenced`);
    assert.ok(!/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(code), `${f}: network API referenced`);
    assert.ok(!/\bconsole\s*\./.test(code), `${f}: console.* is forbidden outside cli/`);
    assert.ok(!/:\s*any\b|\bas any\b|<any>/.test(code), `${f}: \`any\` is forbidden`);
    assert.ok(!/Date\.now\s*\(|new Date\s*\(|Math\.random\s*\(/.test(code), `${f}: results must not depend on the clock or randomness`);
    assert.ok(!/\bexec(?:Sync)?\s*\(|\beval\s*\(|new Function\s*\(/.test(code), `${f}: dynamic code execution`);
    assert.ok(!/\bwriteFile|\bmkdir|\bcreateWriteStream|\bunlink|\brename\s*\(/.test(code), `${f}: the ingest layer must never write to disk`);
  }
});

test('ZIP64 with REAL offsets beyond 4 GiB (sparse file): a local header, the central directory and the end records all sit above 2^32', { timeout: 30_000 }, async (t) => {
  const GAP = 5 * 1024 ** 3; // a 5 GiB hole between the two entries; the file is sparse so it costs no disk space
  const first: ZipEntrySpec = { name: 'first.bin', data: 'first entry data', method: 'store' };
  const second: ZipEntrySpec = { name: 'second.txt', data: 'second entry lives above four gibibytes', method: 'deflate' };
  const layout = (gap: number, secondLocal: number, cdStart: number, recordPos: number): Buffer =>
    buildZip([first, { ...second, zip64: { offset: true }, localOffsetOverride: secondLocal + gap }], {
      zip64Eocd: { cdOffsetOverride: cdStart + gap, locatorOffsetOverride: recordPos + gap },
    });
  // Pass 1 learns where things are (offset values do not change any field width); pass 2 writes the real values.
  const pass1 = layout(0, 0, 0, 0);
  const secondLocal = pass1.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 1);
  const cdStart = pass1.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const recordPos = pass1.length - 22 - 20 - 56;
  assert.ok(secondLocal > 0 && cdStart > secondLocal && recordPos > cdStart, 'sanity: layout probe');
  const archive = layout(GAP, secondLocal, cdStart, recordPos);
  assert.equal(archive.length, pass1.length);

  await withTempDir(async (dir) => {
    const path = join(dir, 'sparse.zip');
    const fh = await openFile(path, 'w');
    try {
      await fh.write(archive, 0, secondLocal, 0);
      await fh.write(archive, secondLocal, archive.length - secondLocal, secondLocal + GAP);
    } catch (e) {
      await fh.close();
      t.skip(`file system cannot create a sparse 5 GiB file: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await fh.close();
    const r = await SafeZipReader.open(path);
    assert.deepEqual(
      r.entries().map((e) => e.name),
      ['first.bin', 'second.txt'],
    );
    assert.equal((await r.readBuffer('first.bin')).toString(), 'first entry data');
    assert.equal((await r.readBuffer('second.txt')).toString(), 'second entry lives above four gibibytes');
    await r.close();
    // The same file with a smaller maxZipFileBytes is refused as a limit trip before anything else is parsed.
    await assert.rejects(
      SafeZipReader.open(path, { maxZipFileBytes: 4 * 1024 ** 3 }),
      (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_LIMIT_EXCEEDED' && e.details?.['reason'] === 'ARCHIVE_TOO_LARGE',
    );
  });
});
