/**
 * SafeZipReader -> jsonArrayElements: the exact pipeline the import runner will use. Verifies that streaming errors
 * (CRC, size, bomb) and parse errors surface correctly, that earlier elements stay usable, and that per-element
 * isolation works (one malformed conversation does not poison the rest).
 */
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { jsonArrayElements } from '../../src/ingest/json-stream.js';
import type { JsonElement } from '../../src/ingest/json-stream.js';
import { SafeZipReader } from '../../src/ingest/zip.js';
import { buildZip, deflatedZeros } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';

function conversation(i: number): Record<string, unknown> {
  return {
    id: `conv-${i}`,
    title: `Synthetic conversation ${i} caf\u00e9 \u65e5\u672c`,
    mapping: { root: { id: 'root', parent: null, message: null }, [`m${i}`]: { id: `m${i}`, parent: 'root', message: { text: `body ${i} ]}"\\` } } },
  };
}

async function drain(it: AsyncIterable<JsonElement>): Promise<{ elements: JsonElement[]; error: unknown }> {
  const elements: JsonElement[] = [];
  try {
    for await (const el of it) elements.push(el);
  } catch (error) {
    return { elements, error };
  }
  return { elements, error: undefined };
}

const N = 3000;
const conversationsJson = JSON.stringify(Array.from({ length: N }, (_, i) => conversation(i)));

test('a deflated conversations.json streams through the splitter; every element parses to the original record', async () => {
  const zip = buildZip([
    { name: 'export/', method: 'store', unixMode: 0o040755 },
    { name: 'export/conversations.json', data: '\ufeff' + conversationsJson, method: 'deflate' }, // exporters sometimes emit a BOM
    { name: 'export/media/image-1.png', data: Buffer.alloc(1000, 7), method: 'store' },
  ]);
  await withTempDir(async (dir) => {
    const path = join(dir, 'export.zip');
    await writeFile(path, zip);
    const reader = await SafeZipReader.open(path);
    const { elements, error } = await drain(jsonArrayElements(reader.stream('export/conversations.json')));
    assert.equal(error, undefined);
    assert.equal(elements.length, N);
    elements.forEach((el, i) => assert.deepEqual(JSON.parse(el.text), conversation(i)));
    assert.equal(reader.totalInflatedBytes, Buffer.byteLength('\ufeff' + conversationsJson), 'only the needed entry was inflated');
    await reader.close();
  });
});

test('a bad CRC is reported AFTER all elements were produced: the pipeline fails, so a caller must not commit early results', async () => {
  const data = Buffer.from(conversationsJson);
  const zip = buildZip([{ name: 'conversations.json', data, method: 'deflate', crcOverride: (crc32(data) ^ 1) >>> 0 }]);
  const reader = SafeZipReader.fromBuffer(zip);
  const { elements, error } = await drain(jsonArrayElements(reader.stream('conversations.json')));
  assert.equal(elements.length, N, 'the splitter had already produced every element when the end-of-entry check failed');
  assert.ok(error instanceof GcrError);
  assert.equal(error.code, 'IMPORT_ZIP_UNSAFE');
  assert.equal(error.details?.['reason'], 'CRC_MISMATCH');
});

test('a bomb stops the pipeline at the declared size with the ZIP error, not a JSON error', async () => {
  const z = deflatedZeros(2 * 1024 * 1024);
  const zip = buildZip([{ name: 'conversations.json', rawCompressed: z.compressed, data: '', declaredUncompressedSize: 100 }]);
  const reader = SafeZipReader.fromBuffer(zip);
  const { elements, error } = await drain(jsonArrayElements(reader.stream('conversations.json')));
  assert.equal(elements.length, 0);
  assert.ok(error instanceof GcrError);
  assert.equal(error.code, 'IMPORT_ZIP_UNSAFE');
  assert.equal(error.details?.['reason'], 'SIZE_EXCEEDS_DECLARED');
});

test('a truncated JSON file inside a perfectly valid archive: elements before the cut are delivered, then IMPORT_PARSE_ERROR', async () => {
  const cut = conversationsJson.slice(0, Math.floor(conversationsJson.length / 2));
  const reader = SafeZipReader.fromBuffer(buildZip([{ name: 'conversations.json', data: cut, method: 'deflate' }]));
  const { elements, error } = await drain(jsonArrayElements(reader.stream('conversations.json')));
  assert.ok(elements.length > 100 && elements.length < N);
  assert.ok(error instanceof GcrError);
  assert.equal(error.code, 'IMPORT_PARSE_ERROR');
  assert.ok(['UNTERMINATED_ARRAY', 'UNTERMINATED_OBJECT', 'UNTERMINATED_STRING'].includes(String(error.details?.['reason'])));
  assert.equal(error.details?.['byteOffset'], Buffer.byteLength(cut), 'the offset is where the file ended');
});

test('per-element isolation: a malformed conversation is skipped by the caller while the rest are processed', async () => {
  const records = [JSON.stringify(conversation(1)), '{"id": broken}', JSON.stringify(conversation(3)), '{"id":"x",}', JSON.stringify(conversation(5))];
  const reader = SafeZipReader.fromBuffer(buildZip([{ name: 'conversations.json', data: `[${records.join(',')}]`, method: 'deflate' }]));
  const good: unknown[] = [];
  const skipped: number[] = [];
  for await (const el of jsonArrayElements(reader.stream('conversations.json'))) {
    try {
      good.push(JSON.parse(el.text));
    } catch {
      skipped.push(el.index); // the splitter framed it correctly; only this record is bad
    }
  }
  assert.deepEqual(skipped, [1, 3]);
  assert.deepEqual(good, [conversation(1), conversation(3), conversation(5)]);
});

test('a single-object conversations file inside a ZIP is accepted only when the caller opts in', async () => {
  const reader = SafeZipReader.fromBuffer(buildZip([{ name: 'conversation.json', data: JSON.stringify(conversation(9)), method: 'store' }]));
  const strict = await drain(jsonArrayElements(reader.stream('conversation.json')));
  assert.ok(strict.error instanceof GcrError && strict.error.details?.['reason'] === 'TOP_LEVEL_NOT_ARRAY');
  const lenient = await drain(jsonArrayElements(reader.stream('conversation.json'), { allowSingleObject: true }));
  assert.equal(lenient.error, undefined);
  assert.deepEqual(JSON.parse(lenient.elements[0]!.text), conversation(9));
});

test('errors from both layers are content-free: no entry names, element text or file paths in messages or details', async () => {
  const secret = 'TOP-SECRET-CONVERSATION-TEXT';
  await withTempDir(async (dir) => {
    const path = join(dir, 'private-export-name.zip');
    await writeFile(path, buildZip([{ name: 'conversations.json', data: `[{"t":"${secret}"} ??]`, method: 'deflate' }]));
    const reader = await SafeZipReader.open(path);
    const { error } = await drain(jsonArrayElements(reader.stream('conversations.json')));
    assert.ok(error instanceof GcrError);
    const everything = JSON.stringify(error.toEnvelope());
    assert.ok(!everything.includes(secret), 'element content leaked into the error envelope');
    assert.ok(!everything.includes(dir) && !everything.includes('private-export-name'), 'path leaked into the error envelope');
    await reader.close();
  });
});
