/**
 * layout.ts, part 4: nested archives (the Privacy Portal "ZIP-in-ZIP" layout). ONE level is opened, the inflated inner
 * archive is bounded by maxNestedZipBytes, every byte is charged to one shared budget, and deeper nesting is refused
 * with a remedy.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { MAX_NESTED_ZIP_BYTES, NESTED_AGGREGATE_FACTOR, discoverInput } from '../../src/ingest/layout.js';
import type { Discovery } from '../../src/ingest/layout.js';
import { DEFAULT_IMPORT_LIMITS } from '../../src/ingest/limits.js';
import type { ImportLimits } from '../../src/ingest/limits.js';
import { buildZip } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { errorSurface, expectCode, zipOf } from './import-runner.helpers.test.js';

async function readAll(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
}

async function discover<T>(outer: Buffer, fn: (d: Discovery) => Promise<T>, limits: ImportLimits = DEFAULT_IMPORT_LIMITS, opts: Parameters<typeof discoverInput>[2] = {}): Promise<T> {
  return withTempDir(async (dir) => {
    const path = join(dir, 'outer.zip');
    await writeFile(path, outer);
    const d = await discoverInput({ kind: 'path', path }, limits, opts);
    try {
      return await fn(d);
    } finally {
      await d.close();
    }
  });
}

const PART1 = 'Conversations__SYNTHETIC-part-001.zip';
const PART2 = 'Conversations__SYNTHETIC-part-002.zip';
const FILES1 = 'Files__SYNTHETIC-files-001.zip';

/** Outer ZIP holding inner ZIPs stored without compression (as the portal does). */
function outerOf(parts: Record<string, Buffer>, extra: Record<string, string> = {}): Buffer {
  return buildZip([
    ...Object.entries(parts).map(([name, data]) => ({ name, data, method: 'store' as const })),
    ...Object.entries(extra).map(([name, data]) => ({ name, data })),
  ]);
}

describe('nested ZIP, one level', () => {
  it('opens Conversations*.zip parts: layout nested, files named <part>!/<inner name>, bytes readable', async () => {
    const outer = outerOf(
      {
        [PART1]: zipOf({ 'conversations-000.json': '[1]', 'conversations-001.json': '[2]' }),
        [PART2]: zipOf({ 'conversations-002.json': '[3]' }),
        [FILES1]: zipOf({ 'file-1.dat': 'x' }),
      },
      { 'Financial/orders.json': '{}', 'User Profile/user.json': '{}' },
    );
    await discover(outer, async (d) => {
      assert.equal(d.layout, 'nested');
      assert.deepEqual(
        d.files.map((f) => f.name),
        [`${PART1}!/conversations-000.json`, `${PART1}!/conversations-001.json`, `${PART2}!/conversations-002.json`].sort((a, b) => {
          const na = Number(/-(\d+)\.json$/.exec(a)?.[1]);
          const nb = Number(/-(\d+)\.json$/.exec(b)?.[1]);
          return na - nb;
        }),
      );
      assert.equal((await readAll(d.files[2]?.open() as AsyncIterable<Buffer>)).toString(), '[3]');
      assert.equal((await readAll(d.files[0]?.open() as AsyncIterable<Buffer>)).toString(), '[1]');
      // The Files part is NOT opened (no "conversations" in its name); it and the other outer files are asset names.
      assert.ok(d.assetNames.has(FILES1));
      assert.ok(d.assetNames.has('Financial/orders.json'));
      assert.ok(d.auxiliaryFilesIgnored >= 1, 'User Profile/user.json is auxiliary');
    });
  });

  it('two parts that both hold conversations.json are both kept (distinct names), ordered by name', async () => {
    const outer = outerOf({ [PART2]: zipOf({ 'conversations.json': '[2]' }), [PART1]: zipOf({ 'conversations.json': '[1]' }) });
    await discover(outer, async (d) => {
      assert.deepEqual(
        d.files.map((f) => f.name),
        [`${PART1}!/conversations.json`, `${PART2}!/conversations.json`],
      );
    });
  });

  it('a conversation file next to a nested part is imported too', async () => {
    const outer = outerOf({ [PART1]: zipOf({ 'conversations-000.json': '[1]' }) }, { 'conversations.json': '[0]' });
    await discover(outer, async (d) => {
      assert.deepEqual(d.files.map((f) => f.name), ['conversations.json', `${PART1}!/conversations-000.json`]);
    });
  });

  it('a manifest inside the inner archive is used for reconciliation', async () => {
    const inner = zipOf({
      'conversations-000.json': '[]',
      'export_manifest.json': JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files: ['conversations-000.json', 'conversations-001.json'] } } }),
    });
    await discover(outerOf({ [PART1]: inner }), async (d) => {
      assert.equal(d.manifest, 'present');
      assert.ok(d.warnings.some((w) => w.code === 'MANIFEST_SHARD_MISSING'));
    });
  });

  it('ZIP-in-ZIP-in-ZIP is refused with IMPORT_UNSUPPORTED_FORMAT and a remedy', async () => {
    const level2 = zipOf({ 'conversations.json': '[]' });
    const level1 = buildZip([{ name: 'Conversations__inner-part-001.zip', data: level2, method: 'store' }]);
    const outer = outerOf({ [PART1]: level1 });
    await withTempDir(async (dir) => {
      const path = join(dir, 'deep.zip');
      await writeFile(path, outer);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
        assert.equal(e.details?.['reason'], 'NESTING_TOO_DEEP');
        assert.match(e.remedy ?? '', /Extract the inner "Conversations" part archive/);
        return true;
      });
    });
  });

  it('a second-level archive WITHOUT "conversations" in its name is just an asset', async () => {
    const level1 = buildZip([
      { name: 'conversations.json', data: '[]' },
      { name: 'Files__x.zip', data: zipOf({ 'a.png': 'x' }), method: 'store' },
    ]);
    await discover(outerOf({ [PART1]: level1 }), async (d) => {
      assert.equal(d.files.length, 1);
      assert.ok(d.assetNames.has('Files__x.zip'));
    });
  });

  it('an over-limit nested archive is IMPORT_LIMIT_EXCEEDED with the extract-and-import remedy', async () => {
    const inner = zipOf({ 'conversations.json': `[${'0,'.repeat(5000)}0]` }, 'store');
    const outer = outerOf({ [PART1]: inner });
    await withTempDir(async (dir) => {
      const path = join(dir, 'big.zip');
      await writeFile(path, outer);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS, { maxNestedZipBytes: 1000 }), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_LIMIT_EXCEEDED');
        assert.equal(e.details?.['reason'], 'NESTED_ZIP_TOO_LARGE');
        assert.match(e.remedy ?? '', /import the extracted folder/);
        return true;
      });
    });
  });

  it('the default nested limit is 256 MiB and all nested archives together are bounded to a small multiple', () => {
    assert.equal(MAX_NESTED_ZIP_BYTES, 256 * 1024 * 1024);
    assert.equal(NESTED_AGGREGATE_FACTOR, 4);
  });

  it('many nested archives that are each under the limit but together over the aggregate bound are refused', async () => {
    const inner = zipOf({ 'conversations.json': `[${'0,'.repeat(300)}0]` }, 'store');
    const parts = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`Conversations__part-00${i}.zip`, inner]));
    const outer = outerOf(parts);
    const each = inner.length;
    await withTempDir(async (dir) => {
      const path = join(dir, 'many.zip');
      await writeFile(path, outer);
      // limit just above one archive: 8 archives exceed 4 x limit.
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS, { maxNestedZipBytes: each + 1 }), expectCode('IMPORT_LIMIT_EXCEEDED', 'NESTED_ZIP_TOO_LARGE'));
    });
  });

  it('inflating nested archives is charged to the SAME budget as everything else (tiny total budget trips)', async () => {
    const inner = zipOf({ 'conversations.json': '[]' }, 'store');
    const outer = outerOf({ [PART1]: inner });
    const limits = { ...DEFAULT_IMPORT_LIMITS, maxTotalInflatedBytes: Math.max(1, inner.length - 1) };
    await withTempDir(async (dir) => {
      const path = join(dir, 'budget.zip');
      await writeFile(path, outer);
      await assert.rejects(discoverInput({ kind: 'path', path }, limits, { passes: 1 }), expectCode('IMPORT_LIMIT_EXCEEDED'));
    });
  });

  it('a corrupt nested archive is IMPORT_ZIP_UNSAFE or unsupported, never a crash, and names nothing from the archive', async () => {
    const outer = outerOf({ [PART1]: Buffer.from('PK\u0003\u0004 definitely not a real archive'.repeat(3)) });
    await withTempDir(async (dir) => {
      const path = join(dir, 'corrupt.zip');
      await writeFile(path, outer);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.ok(['IMPORT_ZIP_UNSAFE', 'IMPORT_UNSUPPORTED_FORMAT'].includes(e.code), e.code);
        assert.ok(!errorSurface(e).includes(dir));
        return true;
      });
    });
  });

  it('a nested archive with a traversal name poisons the whole import (IMPORT_ZIP_UNSAFE)', async () => {
    const inner = buildZip([{ name: '../outside/conversations.json', data: '[]' }]);
    const outer = outerOf({ [PART1]: inner });
    await withTempDir(async (dir) => {
      const path = join(dir, 'evil.zip');
      await writeFile(path, outer);
      await assert.rejects(discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_ZIP_UNSAFE'));
    });
  });
});
