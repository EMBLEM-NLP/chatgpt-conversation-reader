/**
 * layout.ts, part 3: export_manifest.json. The manifest is parsed leniently and only ever produces WARNINGS
 * (MANIFEST_INVALID, MANIFEST_SHARD_MISSING, SHARD_NOT_IN_MANIFEST, MANIFEST_COUNT_MISMATCH); it can never fail a
 * discovery and its paths can never leave the container.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Warning } from '../../src/errors.js';
import { MANIFEST_MAX_BYTES, discoverInput } from '../../src/ingest/layout.js';
import type { Discovery } from '../../src/ingest/layout.js';
import { DEFAULT_IMPORT_LIMITS } from '../../src/ingest/limits.js';
import { buildZip } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { writeFileIn, zipOf } from './import-runner.helpers.test.js';

async function discoverZipEntries(entries: Record<string, string>, fn: (d: Discovery) => void | Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const path = join(dir, 'export.zip');
    await writeFile(path, zipOf(entries));
    const d = await discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS);
    try {
      await fn(d);
    } finally {
      await d.close();
    }
  });
}

const manifest = (files: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    export_files_count: 4,
    logical_files_count: 1,
    export_files: [{ path: 'x', size_bytes: 1 }, { path: 'y', size_bytes: 1 }, { path: 'z', size_bytes: 1 }, { path: 'w', size_bytes: 1 }],
    logical_files: { 'conversations.json': { files, sharded: true } },
    ...extra,
  });

const codes = (ws: Warning[]): string[] => ws.map((w) => w.code);
const SHARDS = { 'conversations-000.json': '[]', 'conversations-001.json': '[]', 'conversations-002.json': '[]' };

describe('manifest reconciliation', () => {
  it('a consistent manifest: present, no warnings', async () => {
    await discoverZipEntries({ ...SHARDS, 'export_manifest.json': manifest(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']) }, (d) => {
      assert.equal(d.manifest, 'present');
      assert.deepEqual(codes(d.warnings), []);
    });
  });

  it('a manifest in the middle of a prefix folder resolves its paths relative to its own folder', async () => {
    const prefixed = Object.fromEntries(Object.entries(SHARDS).map(([k, v]) => [`exp/${k}`, v]));
    await discoverZipEntries({ ...prefixed, 'exp/export_manifest.json': manifest(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']) }, (d) => {
      assert.equal(d.manifest, 'present');
      assert.deepEqual(codes(d.warnings), []);
    });
  });

  it('a shard listed but absent -> MANIFEST_SHARD_MISSING (names are sanitized ids, import still works)', async () => {
    await discoverZipEntries({ 'conversations-000.json': '[]', 'conversations-001.json': '[]', 'export_manifest.json': manifest(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']) }, (d) => {
      assert.equal(d.files.length, 2);
      const w = d.warnings.find((x) => x.code === 'MANIFEST_SHARD_MISSING');
      assert.ok(w);
      assert.deepEqual(w.ids, ['conversations-002.json']);
      assert.match(w.message, /^1 conversation file/);
    });
  });

  it('a shard present but unlisted -> SHARD_NOT_IN_MANIFEST', async () => {
    await discoverZipEntries({ ...SHARDS, 'export_manifest.json': manifest(['conversations-000.json', 'conversations-001.json']) }, (d) => {
      const w = d.warnings.find((x) => x.code === 'SHARD_NOT_IN_MANIFEST');
      assert.ok(w);
      assert.deepEqual(w.ids, ['conversations-002.json']);
      assert.ok(!codes(d.warnings).includes('MANIFEST_SHARD_MISSING'));
    });
  });

  it('matching is case-insensitive and tolerates backslashes and ./ in listed paths', async () => {
    await discoverZipEntries({ 'Conversations-000.JSON': '[]', 'export_manifest.json': manifest(['.\\conversations-000.json']) }, (d) => {
      assert.deepEqual(codes(d.warnings), []);
    });
  });

  it('manifest paths that leave the container are ignored with a warning, never followed or reported as missing', async () => {
    await discoverZipEntries(
      {
        'conversations-000.json': '[]',
        'export_manifest.json': manifest(['conversations-000.json', '../../etc/passwd', '/abs/conversations-1.json', 'C:\\x\\conversations-2.json', 'a/../../b.json', 'bad\u0000name.json', '']),
      },
      (d) => {
        assert.equal(d.manifest, 'present');
        const w = d.warnings.find((x) => x.code === 'MANIFEST_INVALID');
        assert.ok(w);
        assert.match(w.message, /^6 manifest path/);
        assert.deepEqual(w.ids, ['unsafe_paths_ignored']);
        assert.ok(!codes(d.warnings).includes('MANIFEST_SHARD_MISSING'));
        assert.ok(!JSON.stringify(d.warnings).includes('passwd'));
      },
    );
  });

  it('count mismatches inside the manifest -> MANIFEST_COUNT_MISMATCH', async () => {
    await discoverZipEntries({ ...SHARDS, 'export_manifest.json': manifest(['conversations-000.json', 'conversations-001.json', 'conversations-002.json'], { export_files_count: 99, logical_files_count: 7 }) }, (d) => {
      assert.equal(codes(d.warnings).filter((c) => c === 'MANIFEST_COUNT_MISMATCH').length, 2);
      assert.equal(d.manifest, 'present');
    });
  });

  it('malformed JSON, wrong types and unknown versions are warnings (MANIFEST_INVALID, manifest "invalid"), never failures', async () => {
    const bad: Array<[string, string, string]> = [
      ['not json', '{"version": 1,', 'not_json'],
      ['array', '[1]', 'not_object'],
      ['no version', JSON.stringify({ logical_files: {} }), 'unknown_version'],
      ['version 2', JSON.stringify({ version: 2, logical_files: {} }), 'unknown_version'],
      ['logical_files wrong type', JSON.stringify({ version: 1, logical_files: [] }), 'logical_files_not_object'],
      ['conversations entry wrong type', JSON.stringify({ version: 1, logical_files: { 'conversations.json': 5 } }), 'conversations_entry_not_object'],
      ['files wrong type', JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files: 'conversations-000.json' } } }), 'files_not_string_array'],
      ['files with numbers', JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files: [1, 2] } } }), 'files_not_string_array'],
    ];
    for (const [label, text, reason] of bad) {
      await discoverZipEntries({ ...SHARDS, 'export_manifest.json': text }, (d) => {
        assert.equal(d.manifest, 'invalid', label);
        const w = d.warnings.find((x) => x.code === 'MANIFEST_INVALID');
        assert.ok(w, label);
        assert.deepEqual(w.ids, [reason], label);
        assert.equal(d.files.length, 3, `${label}: all shards still found`);
      });
    }
  });

  it('an empty or absent shard list means nothing to reconcile', async () => {
    await discoverZipEntries({ ...SHARDS, 'export_manifest.json': manifest([]) }, (d) => {
      assert.equal(d.manifest, 'present');
      assert.deepEqual(codes(d.warnings), []);
    });
    await discoverZipEntries({ ...SHARDS, 'export_manifest.json': JSON.stringify({ version: 1 }) }, (d) => {
      assert.equal(d.manifest, 'present');
      assert.deepEqual(codes(d.warnings), []);
    });
  });

  it('a manifest larger than 16 MiB is not read: invalid, with a warning', async () => {
    const zip = buildZip([
      { name: 'conversations.json', data: '[]' },
      { name: 'export_manifest.json', data: Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20) },
    ]);
    await withTempDir(async (dir) => {
      const path = join(dir, 'x.zip');
      await writeFile(path, zip);
      const d = await discoverInput({ kind: 'path', path }, DEFAULT_IMPORT_LIMITS);
      assert.equal(d.manifest, 'invalid');
      assert.deepEqual(d.warnings.find((w) => w.code === 'MANIFEST_INVALID')?.ids, ['too_large']);
      await d.close();
    });
  });

  it('several manifests: the outermost is used and the ambiguity is reported', async () => {
    await discoverZipEntries(
      { ...SHARDS, 'export_manifest.json': manifest(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']), 'old/export_manifest.json': '{"version": 9}' },
      (d) => {
        assert.equal(d.manifest, 'present');
        assert.ok(codes(d.warnings).includes('MANIFEST_AMBIGUOUS'));
      },
    );
  });

  it('no manifest: silent for a single file, an informational MANIFEST_ABSENT for shards', async () => {
    await discoverZipEntries({ 'conversations.json': '[]' }, (d) => {
      assert.equal(d.manifest, 'absent');
      assert.deepEqual(codes(d.warnings), []);
    });
    await discoverZipEntries(SHARDS, (d) => {
      assert.equal(d.manifest, 'absent');
      const w = d.warnings.find((x) => x.code === 'MANIFEST_ABSENT');
      assert.ok(w?.message.startsWith('[info] '));
    });
  });

  it('manifests work the same in an extracted folder', async () => {
    await withTempDir(async (dir) => {
      for (const [k, v] of Object.entries(SHARDS)) await writeFileIn(dir, k, v);
      await writeFileIn(dir, 'export_manifest.json', manifest(['conversations-000.json', 'conversations-009.json']));
      const d = await discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS);
      assert.equal(d.manifest, 'present');
      assert.ok(codes(d.warnings).includes('MANIFEST_SHARD_MISSING'));
      assert.ok(codes(d.warnings).includes('SHARD_NOT_IN_MANIFEST'));
    });
  });

  it('the manifest itself is never counted as an asset or an auxiliary file', async () => {
    await discoverZipEntries({ ...SHARDS, 'export_manifest.json': manifest(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']) }, (d) => {
      assert.equal(d.assetNames.size, 0);
      assert.equal(d.auxiliaryFilesIgnored, 0);
    });
  });
});
