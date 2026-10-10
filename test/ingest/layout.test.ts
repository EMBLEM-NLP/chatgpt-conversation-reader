/**
 * layout.ts, part 1: detection by content signature, single files, ZIP layouts (single / sharded / junk / prefix /
 * case variants / stub), auxiliary and asset accounting, stdin, and the error contract (codes, remedies, no absolute
 * paths). Real ZIPs are built in memory and written to temp files; nothing is mocked.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { AUXILIARY_FILE_NAMES, CONVERSATION_FILE_RE, classifyHead, compareConversationFiles, discoverInput } from '../../src/ingest/layout.js';
import type { Discovery, InputSource } from '../../src/ingest/layout.js';
import { DEFAULT_IMPORT_LIMITS } from '../../src/ingest/limits.js';
import { buildZip } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { chunked, errorSurface, expectCode, writeFileIn, zipOf } from './import-runner.helpers.test.js';

async function readAll(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
}

/** Write `zip` to a temp file, discover it, run `fn`, always close. */
async function withZip<T>(zip: Buffer, fn: (d: Discovery, path: string) => Promise<T>, opts: Parameters<typeof discoverInput>[2] = {}): Promise<T> {
  return withTempDir(async (dir) => {
    const path = join(dir, 'export.zip');
    await writeFile(path, zip);
    const d = await discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS, opts);
    try {
      return await fn(d, path);
    } finally {
      await d.close();
    }
  });
}

const names = (d: Discovery): string[] => d.files.map((f) => f.name);

describe('content-signature classification', () => {
  const cases: Array<[string, number[], string]> = [
    ['ZIP local header', [0x50, 0x4b, 3, 4, 0, 0], 'zip'],
    ['ZIP empty archive', [0x50, 0x4b, 5, 6], 'zip'],
    ['array', [0x5b, 0x5d], 'json'],
    ['object after whitespace', [0x20, 0x0a, 0x7b], 'json'],
    ['UTF-8 BOM then array', [0xef, 0xbb, 0xbf, 0x5b], 'json'],
    ['UTF-16 LE BOM', [0xff, 0xfe, 0x5b, 0x00], 'utf16'],
    ['UTF-16 BE BOM', [0xfe, 0xff, 0x00, 0x5b], 'utf16'],
    ['UTF-32 LE BOM', [0xff, 0xfe, 0x00, 0x00], 'utf16'],
    ['UTF-32 BE BOM', [0x00, 0x00, 0xfe, 0xff], 'utf16'],
    ['BOM-less UTF-16 LE JSON', [0x5b, 0x00, 0x7b, 0x00], 'utf16'],
    ['BOM-less UTF-16 BE JSON', [0x00, 0x5b, 0x00, 0x7b], 'utf16'],
    ['empty', [], 'json'],
    ['whitespace only', [0x20, 0x0a], 'json'],
    ['plain text', [0x68, 0x65, 0x6c, 0x6c, 0x6f], 'other'],
    ['bare number', [0x34, 0x32], 'other'],
    ['self-extractor stub', [0x4d, 0x5a, 0x90, 0x00], 'other'],
  ];
  for (const [label, bytes, kind] of cases) {
    it(`${label} -> ${kind}`, () => assert.equal(classifyHead(Buffer.from(bytes)), kind));
  }
});

describe('file-name rules', () => {
  it('matches conversations.json and numbered shards case-insensitively, nothing else', () => {
    for (const ok of ['conversations.json', 'Conversations.JSON', 'conversations-0.json', 'conversations-000.json', 'CONVERSATIONS-12.json']) {
      assert.ok(CONVERSATION_FILE_RE.test(ok), ok);
    }
    for (const bad of ['conversation.json', 'conversations.json.bak', 'conversations-.json', 'conversations-a.json', 'my-conversations.json', 'conversations_1.json', 'conversations-1.jsonl']) {
      assert.ok(!CONVERSATION_FILE_RE.test(bad), bad);
    }
  });

  it('orders plain first, then by INTEGER suffix, ties by name (2 before 10, -999 before -1000)', () => {
    const list = [
      { name: 'conversations-10.json', suffix: 10n },
      { name: 'conversations-1000.json', suffix: 1000n },
      { name: 'conversations-2.json', suffix: 2n },
      { name: 'conversations.json', suffix: null },
      { name: 'conversations-999.json', suffix: 999n },
      { name: 'conversations-002.json', suffix: 2n },
    ];
    list.sort(compareConversationFiles);
    assert.deepEqual(
      list.map((x) => x.name),
      ['conversations.json', 'conversations-002.json', 'conversations-2.json', 'conversations-10.json', 'conversations-999.json', 'conversations-1000.json'],
    );
  });

  it('lists the auxiliary files that are counted but never read', () => {
    for (const n of ['user.json', 'user_settings.json', 'message_feedback.json', 'shared_conversations.json', 'model_comparisons.json', 'group_chats.json', 'library_files.json', 'conversation_asset_file_names.json', 'chat.html']) {
      assert.ok(AUXILIARY_FILE_NAMES.has(n), n);
    }
  });
});

describe('single JSON file input', () => {
  it('conversations.json on disk: layout single, kind conversations_json, label is the basename', async () => {
    await withTempDir(async (dir) => {
      const path = await writeFileIn(dir, 'conversations.json', '[]');
      const d = await discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS);
      assert.equal(d.layout, 'single');
      assert.equal(d.sourceKind, 'conversations_json');
      assert.equal(d.sourceLabel, 'conversations.json');
      assert.deepEqual(names(d), ['conversations.json']);
      assert.equal(d.manifest, 'absent');
      assert.equal(d.files[0]?.sizeHint, 2);
      assert.equal((await readAll(d.files[0]?.open() as AsyncIterable<Buffer>)).toString(), '[]');
      await d.close();
    });
  });

  it('any other file name is recorded as conversations.json so renaming never changes the batch identity', async () => {
    await withTempDir(async (dir) => {
      const path = await writeFileIn(dir, 'my-chats-2026.txt', '[{"a":1}]');
      const d = await discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual(names(d), ['conversations.json']);
      assert.equal(d.sourceLabel, 'my-chats-2026.txt');
    });
  });

  it('a shard path keeps its numbered name and reports the sharded layout', async () => {
    await withTempDir(async (dir) => {
      const path = await writeFileIn(dir, 'conversations-007.json', '[]');
      const d = await discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual(names(d), ['conversations-007.json']);
      assert.equal(d.layout, 'sharded');
    });
  });

  it('open() returns an independent fresh stream every call (the runner reads every file twice)', async () => {
    await withTempDir(async (dir) => {
      const path = await writeFileIn(dir, 'conversations.json', '[1,2,3]');
      const d = await discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS);
      const f = d.files[0];
      assert.ok(f);
      assert.equal((await readAll(f.open())).toString(), '[1,2,3]');
      assert.equal((await readAll(f.open())).toString(), '[1,2,3]');
    });
  });

  it('a UTF-8 BOM file is accepted as JSON', async () => {
    await withTempDir(async (dir) => {
      const path = await writeFileIn(dir, 'conversations.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[]')]));
      const d = await discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS);
      assert.equal(d.files.length, 1);
    });
  });

  it('UTF-16 files are refused with a remedy to re-save as UTF-8', async () => {
    await withTempDir(async (dir) => {
      const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[]', 'utf16le')]);
      const path = await writeFileIn(dir, 'conversations.json', utf16);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
        assert.equal(e.details?.['reason'], 'UNSUPPORTED_ENCODING');
        assert.match(e.remedy ?? '', /UTF-8/);
        return true;
      });
    });
  });

  it('text that is neither JSON nor a ZIP is an unsupported format that names the files GCR looks for', async () => {
    await withTempDir(async (dir) => {
      const path = await writeFileIn(dir, 'notes.txt', 'hello world, this is not an export');
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
        assert.match(e.remedy ?? '', /conversations\.json/);
        return true;
      });
    });
  });
});

describe('ZIP layouts', () => {
  it('bare ZIP with conversations.json: single layout, auxiliary files counted by name, assets listed by name', async () => {
    const zip = zipOf({
      'conversations.json': '[]',
      'user.json': '{"email":"nobody@example.invalid"}',
      'message_feedback.json': '[]',
      'chat.html': '<html></html>',
      'file-ABC.dat': 'x',
      'dalle-generations/img.webp': 'y',
    });
    await withZip(zip, async (d) => {
      assert.equal(d.layout, 'single');
      assert.equal(d.sourceKind, 'zip');
      assert.equal(d.sourceLabel, 'export.zip');
      assert.deepEqual(names(d), ['conversations.json']);
      assert.equal(d.auxiliaryFilesIgnored, 3);
      assert.deepEqual([...d.assetNames].sort(), ['dalle-generations/img.webp', 'file-ABC.dat']);
      assert.equal(d.assetsExtensionless, true);
      assert.equal(d.manifest, 'absent');
      assert.deepEqual(d.warnings, []);
    });
  });

  it('assetsExtensionless stays false when no .dat asset exists', async () => {
    await withZip(zipOf({ 'conversations.json': '[]', 'file-1-photo.png': 'x' }), async (d) => {
      assert.equal(d.assetsExtensionless, false);
    });
  });

  it('auxiliary files are never opened: even a corrupt or oversized one cannot fail discovery', async () => {
    const zip = buildZip([
      { name: 'conversations.json', data: '[]' },
      // The CRC is wrong: reading this entry would throw. Discovery must not touch it.
      { name: 'user.json', data: '{"phone":"000"}', crcOverride: 0x12345678 },
    ]);
    await withZip(zip, async (d) => {
      assert.equal(d.auxiliaryFilesIgnored, 1);
    });
  });

  it('sharded ZIP: numeric order (conversations-2 before conversations-10), plain file first', async () => {
    const zip = zipOf({
      'conversations-10.json': '[]',
      'conversations-2.json': '[]',
      'conversations-1.json': '[]',
      'conversations.json': '[]',
      'conversations-100.json': '[]',
    });
    await withZip(zip, async (d) => {
      assert.equal(d.layout, 'sharded');
      assert.deepEqual(names(d), ['conversations.json', 'conversations-1.json', 'conversations-2.json', 'conversations-10.json', 'conversations-100.json']);
      assert.deepEqual(d.files.map((f) => f.order), [0, 1, 2, 3, 4]);
      const gap = d.warnings.find((w) => w.code === 'SHARD_GAP');
      assert.ok(gap, 'missing numbers 3..9 and 11..99 are reported');
      assert.ok(d.warnings.some((w) => w.code === 'MANIFEST_ABSENT'));
    });
  });

  it('zero-padded shard names with a width change sort by value (-999 before -1000)', async () => {
    const zip = zipOf({ 'conversations-1000.json': '[]', 'conversations-999.json': '[]', 'conversations-000.json': '[]' });
    await withZip(zip, async (d) => {
      assert.deepEqual(names(d), ['conversations-000.json', 'conversations-999.json', 'conversations-1000.json']);
    });
  });

  it('the order does not depend on the order of the entries inside the archive', async () => {
    const forward = zipOf({ 'conversations-1.json': '[1]', 'conversations-2.json': '[2]', 'conversations-3.json': '[3]' });
    const reversed = zipOf({ 'conversations-3.json': '[3]', 'conversations-2.json': '[2]', 'conversations-1.json': '[1]' });
    const a = await withZip(forward, async (d) => names(d));
    const b = await withZip(reversed, async (d) => names(d));
    assert.deepEqual(a, b);
  });

  it('__MACOSX/ folders, ._ files and .DS_Store are ignored everywhere', async () => {
    const zip = zipOf({
      'conversations.json': '[]',
      '__MACOSX/._conversations.json': 'junk',
      '__MACOSX/conversations-5.json': 'junk',
      '._conversations-9.json': 'junk',
      'sub/.DS_Store': 'junk',
      'sub/._user.json': 'junk',
    });
    await withZip(zip, async (d) => {
      assert.deepEqual(names(d), ['conversations.json']);
      assert.equal(d.auxiliaryFilesIgnored, 0);
      assert.equal(d.assetNames.size, 0);
    });
  });

  it('an export under a prefix folder is found at any depth', async () => {
    const zip = zipOf({ 'export-2026-10-01/conversations.json': '[]', 'export-2026-10-01/user.json': '{}', 'export-2026-10-01/img/a.png': 'x' });
    await withZip(zip, async (d) => {
      assert.deepEqual(names(d), ['export-2026-10-01/conversations.json']);
      assert.equal(d.auxiliaryFilesIgnored, 1);
      assert.deepEqual([...d.assetNames], ['export-2026-10-01/img/a.png']);
    });
  });

  it('case-variant file names match', async () => {
    await withZip(zipOf({ 'Conversations.JSON': '[]' }), async (d) => assert.deepEqual(names(d), ['Conversations.JSON']));
  });

  it('a ZIP whose local data is preceded by a stub is found by the EOCD scan', async () => {
    const stub = Buffer.from('MZ-self-extractor-stub-'.repeat(20));
    const zip = buildZip([{ name: 'conversations.json', data: '[]' }], { prefix: stub });
    await withZip(zip, async (d) => {
      assert.deepEqual(names(d), ['conversations.json']);
      assert.equal((await readAll(d.files[0]?.open() as AsyncIterable<Buffer>)).toString(), '[]');
    });
  });

  it('an empty archive (EOCD only) has no conversation file', async () => {
    const empty = buildZip([]);
    await withTempDir(async (dir) => {
      const path = join(dir, 'empty.zip');
      await writeFile(path, empty);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'NO_CONVERSATION_FILE'));
    });
  });

  it('a ZIP that is not an export (no conversation file) names what GCR looks for and counts entries only', async () => {
    const zip = zipOf({ 'PLANTED-secret-name.txt': 'x', 'photos/a.png': 'y' });
    await withTempDir(async (dir) => {
      const path = join(dir, 'other.zip');
      await writeFile(path, zip);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
        assert.equal(e.details?.['reason'], 'NO_CONVERSATION_FILE');
        assert.equal(e.details?.['entriesSeen'], 2);
        assert.match(e.remedy ?? '', /conversations-<N>\.json/);
        assert.ok(!errorSurface(e).includes('PLANTED-secret-name'), 'entry names are not echoed');
        return true;
      });
    });
  });

  it('hostile archives are rejected by SafeZipReader with IMPORT_ZIP_UNSAFE (path traversal)', async () => {
    const zip = buildZip([{ name: '../evil/conversations.json', data: '[]' }]);
    await withTempDir(async (dir) => {
      const path = join(dir, 'evil.zip');
      await writeFile(path, zip);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_ZIP_UNSAFE'));
    });
  });

  it('a truncated archive (no end record) is IMPORT_ZIP_UNSAFE, not a crash', async () => {
    const zip = buildZip([{ name: 'conversations.json', data: '[]' }], { omitEocd: true });
    await withTempDir(async (dir) => {
      const path = join(dir, 'cut.zip');
      await writeFile(path, zip);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_ZIP_UNSAFE'));
    });
  });

  it('the cumulative inflate budget is shared by all conversation files and both passes: too much data is refused up front', async () => {
    const body = `[${'1,'.repeat(5000)}1]`;
    const zip = zipOf({ 'conversations-1.json': body, 'conversations-2.json': body }, 'store');
    await withTempDir(async (dir) => {
      const path = join(dir, 'big.zip');
      await writeFile(path, zip);
      // Each file alone fits the per-pass budget, both together do not.
      const tight = { ...DEFAULT_IMPORT_LIMITS, maxTotalInflatedBytes: body.length + 10 };
      for (const passes of [1, 2]) {
        await assert.rejects(discoverInput({ kind: 'path', path }, tight, { passes }), expectCode('IMPORT_LIMIT_EXCEEDED', 'TOTAL_BUDGET'));
      }
      const roomy = { ...DEFAULT_IMPORT_LIMITS, maxTotalInflatedBytes: 2 * body.length + 10 };
      const ok = await discoverInput({ kind: 'path', path }, roomy, { passes: 2 });
      await ok.close();
    });
  });
});

describe('stream (stdin) input', () => {
  const src = (data: Buffer | string, label = 'stdin'): InputSource => ({ kind: 'stream', stream: chunked(data, 5), label });

  it('buffers JSON text from a stream: layout stdin, kind stdin_json, name conversations.json', async () => {
    const d = await discoverInput(src('[{"a":1}]', '-'), DEFAULT_IMPORT_LIMITS);
    assert.equal(d.layout, 'stdin');
    assert.equal(d.sourceKind, 'stdin_json');
    assert.deepEqual(names(d), ['conversations.json']);
    assert.equal((await readAll(d.files[0]?.open() as AsyncIterable<Buffer>)).toString(), '[{"a":1}]');
    assert.equal((await readAll(d.files[0]?.open() as AsyncIterable<Buffer>)).toString(), '[{"a":1}]', 'readable twice');
    assert.equal(d.manifest, 'absent');
    assert.equal(d.assetNames.size, 0);
  });

  it('the label becomes a basename only', async () => {
    const d = await discoverInput(src('[]', '/home/someone/private/stdin-label'), DEFAULT_IMPORT_LIMITS);
    assert.equal(d.sourceLabel, 'stdin-label');
  });

  it('is bounded by maxElementBytes x 4 and stops reading once the bound is exceeded', async () => {
    let pulled = 0;
    async function* endless(): AsyncGenerator<Buffer, void, undefined> {
      for (;;) {
        pulled++;
        yield Buffer.alloc(1000, 0x20);
      }
    }
    const limits = { ...DEFAULT_IMPORT_LIMITS, maxElementBytes: 1000 };
    await assert.rejects(discoverInput({ kind: 'stream', stream: endless(), label: 'x' }, limits), expectCode('IMPORT_LIMIT_EXCEEDED', 'STDIN_TOO_LARGE'));
    assert.ok(pulled <= 6, `stopped after ${pulled} chunks`);
  });

  it('refuses a ZIP on stdin (random access needed) and UTF-16 text, with remedies', async () => {
    await assert.rejects(discoverInput(src(zipOf({ 'conversations.json': '[]' })), DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'ZIP_ON_STDIN'));
    await assert.rejects(discoverInput(src(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[]', 'utf16le')])), DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'UNSUPPORTED_ENCODING'));
    await assert.rejects(discoverInput(src('definitely not json'), DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'STDIN_NOT_JSON'));
  });

  it('rejects a stream that yields strings', async () => {
    async function* strings(): AsyncGenerator<string, void, undefined> {
      yield '[]';
    }
    await assert.rejects(
      discoverInput({ kind: 'stream', stream: strings() as unknown as AsyncIterable<Buffer>, label: 'x' }, DEFAULT_IMPORT_LIMITS),
      expectCode('INVALID_ARGUMENT', 'BAD_CHUNK_TYPE'),
    );
  });
});

describe('argument and file-system errors', () => {
  it('a missing path is IMPORT_INPUT_NOT_FOUND and names the BASENAME only', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'nested', 'does-not-exist.zip');
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_INPUT_NOT_FOUND');
        const surface = errorSurface(e);
        assert.ok(surface.includes('does-not-exist.zip'));
        assert.ok(!surface.includes(dir), 'no absolute path');
        assert.ok(!surface.includes(basename(dir)), 'no parent folder name either');
        assert.equal((e as { cause?: unknown }).cause, undefined, 'the raw fs error (with the full path) is not attached');
        return true;
      });
    });
  });

  it('bad arguments are INVALID_ARGUMENT', async () => {
    await assert.rejects(discoverInput({ kind: 'path', path: '' }, DEFAULT_IMPORT_LIMITS), expectCode('INVALID_ARGUMENT'));
    await assert.rejects(discoverInput({ kind: 'path', path: 'a\0b' }, DEFAULT_IMPORT_LIMITS), expectCode('INVALID_ARGUMENT'));
    await assert.rejects(discoverInput({ kind: 'path', path: 'x' }, DEFAULT_IMPORT_LIMITS, { passes: 0 }), expectCode('INVALID_ARGUMENT'));
    await assert.rejects(discoverInput({ kind: 'nope' } as unknown as InputSource, DEFAULT_IMPORT_LIMITS), expectCode('INVALID_ARGUMENT'));
    await assert.rejects(discoverInput(null as unknown as InputSource, DEFAULT_IMPORT_LIMITS), expectCode('INVALID_ARGUMENT'));
  });

  it('limits are validated like everywhere else (a zero limit cannot disable a guard)', async () => {
    await assert.rejects(discoverInput({ kind: 'path', path: 'x' }, { ...DEFAULT_IMPORT_LIMITS, maxEntries: 0 }), expectCode('INVALID_ARGUMENT'));
  });
});
