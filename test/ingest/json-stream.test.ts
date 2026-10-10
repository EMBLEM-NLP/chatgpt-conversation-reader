/**
 * jsonArrayElements / jsonLinesElements: structure, errors (exact reason + byte offset, never content), limits, UTF-8,
 * BOM, source handling, and chunk-boundary invariance for every example.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { JSON_PARSE_REASONS, MAX_JSON_DEPTH, jsonArrayElements, jsonLinesElements } from '../../src/ingest/json-stream.js';
import type { JsonElement, JsonParseReason, JsonStreamOptions } from '../../src/ingest/json-stream.js';

type Gen = (source: AsyncIterable<Buffer | Uint8Array>, opts?: JsonStreamOptions) => AsyncGenerator<JsonElement, void, undefined>;

/** Split bytes into chunks of `size` (the last may be shorter). */
async function* chunked(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(buf.length, i + size));
}

function bytes(input: string | Buffer): Buffer {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
}

interface Outcome {
  elements: JsonElement[];
  error: GcrError | undefined;
}

async function run(gen: Gen, input: string | Buffer, chunkSize: number, opts?: JsonStreamOptions): Promise<Outcome> {
  const elements: JsonElement[] = [];
  try {
    for await (const el of gen(chunked(bytes(input), chunkSize), opts)) elements.push(el);
  } catch (e) {
    assert.ok(e instanceof GcrError, `non-GcrError thrown: ${String(e)}`);
    return { elements, error: e };
  }
  return { elements, error: undefined };
}

const CHUNKINGS = [1, 2, 3, 5, 7, 64, 1 << 20];

/** Run with several chunk sizes and require IDENTICAL outcomes (elements and error), returning the common one. */
async function invariant(gen: Gen, input: string | Buffer, opts?: JsonStreamOptions): Promise<Outcome> {
  const reference = await run(gen, input, 1 << 20, opts);
  for (const size of CHUNKINGS) {
    const o = await run(gen, input, size, opts);
    assert.deepEqual(o.elements, reference.elements, `elements differ at chunk size ${size}`);
    assert.equal(o.error?.code, reference.error?.code, `error code differs at chunk size ${size}`);
    assert.deepEqual(o.error?.details, reference.error?.details, `error details differ at chunk size ${size}`);
    assert.equal(o.error?.message, reference.error?.message, `error message differs at chunk size ${size}`);
  }
  return reference;
}

async function texts(gen: Gen, input: string | Buffer, opts?: JsonStreamOptions): Promise<string[]> {
  const o = await invariant(gen, input, opts);
  assert.equal(o.error, undefined, `unexpected error: ${o.error?.message}`);
  return o.elements.map((e) => e.text);
}

async function fails(gen: Gen, input: string | Buffer, reason: JsonParseReason, offset: number, opts?: JsonStreamOptions): Promise<Outcome> {
  const o = await invariant(gen, input, opts);
  assert.ok(o.error !== undefined, `expected ${reason} but the input was accepted: ${JSON.stringify(String(input).slice(0, 60))}`);
  assert.equal(o.error.code, 'IMPORT_PARSE_ERROR', o.error.message);
  assert.equal(o.error.details?.['reason'], reason, o.error.message);
  assert.equal(o.error.details?.['byteOffset'], offset, `${reason}: byte offset`);
  assert.ok(o.error.message.includes(String(offset)) && o.error.message.includes(reason), 'message carries offset and reason');
  assert.deepEqual(Object.keys(o.error.details ?? {}).sort(), ['byteOffset', 'reason'], 'details hold nothing but offset and reason');
  return o;
}

const arr = jsonArrayElements as Gen;
const lines = jsonLinesElements as Gen;

// ---------------------------------------------------------------------------------------------------------------
// jsonArrayElements: valid inputs
// ---------------------------------------------------------------------------------------------------------------

test('empty arrays yield nothing (with any whitespace)', async () => {
  for (const input of ['[]', '[ ]', ' \n\t[\r\n]  \n', '\ufeff[]', '\ufeff \n[ ]\n']) {
    assert.deepEqual(await texts(arr, input), [], JSON.stringify(input));
  }
});

test('elements of every JSON kind are yielded as raw text with index and byteLength', async () => {
  const input = '[{"a":1},[1,[2]],"s",1.5e-3,-0,true,false,null, 12 ]';
  const o = await invariant(arr, input);
  assert.deepEqual(
    o.elements.map((e) => e.text),
    ['{"a":1}', '[1,[2]]', '"s"', '1.5e-3', '-0', 'true', 'false', 'null', '12'],
  );
  assert.deepEqual(
    o.elements.map((e) => e.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  for (const e of o.elements) assert.equal(e.byteLength, Buffer.byteLength(e.text, 'utf8'));
});

test('whitespace around elements is trimmed; whitespace inside elements is preserved byte for byte', async () => {
  const pretty = '\n[\n  {\n    "a": [ 1, 2 ],\r\n    "b": "x y"\n  } ,\n\t[ ] ,\n  "z"\n]\n';
  assert.deepEqual(await texts(arr, pretty), ['{\n    "a": [ 1, 2 ],\r\n    "b": "x y"\n  }', '[ ]', '"z"']);
});

test('structural characters, quotes and backslashes inside strings never end an element', async () => {
  const elements = [
    '{"k":"]}[{,\\"quoted\\" and a backslash at the end \\\\"}',
    '"\\\\"', // the string  \\  (escaped backslash) then closing quote
    '"\\""', // the string  \"
    '["\\\\", "]", "\\"]"]',
    '"[,]{}:"',
    '{"nested":{"deeper":["]","}",{"x":"\\\\\\""}]}}',
    '"\\u005d\\u007d and \\n newline escape"',
  ];
  const input = `[${elements.join(',')}]`;
  assert.deepEqual(await texts(arr, input), elements);
});

test('multi-byte UTF-8 (2, 3 and 4 bytes) survives any chunking, including splits inside a code point', async () => {
  const elements = ['"caf\u00e9 \u00fc\u00f1"', '"\u65e5\u672c\u8a9e\u306e\u30c6\u30b9\u30c8"', '"\ud83d\ude00\ud83c\udf0d\ud835\udd38"', '{"\u0436":"\u044f\u0439\u0446\u043e","emoji":"\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67"}'];
  const o = await invariant(arr, `[${elements.join(', ')}]`); // chunk size 1 splits every multi-byte character
  assert.deepEqual(
    o.elements.map((e) => e.text),
    elements,
  );
  assert.deepEqual(
    o.elements.map((e) => e.byteLength),
    elements.map((t) => Buffer.byteLength(t)),
  );
  assert.ok(o.elements[2]!.byteLength > o.elements[2]!.text.length, 'byteLength counts bytes, not UTF-16 units');
});

test('a UTF-8 BOM at the very start is tolerated and never appears in the output', async () => {
  const o = await invariant(arr, '\ufeff[{"a":1}, 2]');
  assert.deepEqual(
    o.elements.map((e) => e.text),
    ['{"a":1}', '2'],
  );
  for (const e of o.elements) assert.ok(!e.text.includes('\ufeff'));
  assert.deepEqual(await texts(arr, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('["x"]')])), ['"x"']);
  // A BOM-looking character INSIDE a string is data and is preserved.
  assert.deepEqual(await texts(arr, '["a\ufeffb"]'), ['"a\ufeffb"']);
});

test('invalid UTF-8 inside strings is replaced with U+FFFD (never throws); byteLength counts the raw bytes', async () => {
  const input = Buffer.concat([Buffer.from('["ok-'), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xe2, 0x82]), Buffer.from('-end", "\u00e9"]')]);
  const o = await invariant(arr, input);
  assert.equal(o.elements.length, 2);
  const first = o.elements[0]!;
  assert.ok(first.text.includes('\ufffd'));
  assert.equal(first.text, input.subarray(1, 1 + first.byteLength).toString('utf8'), 'matches the platform UTF-8 decoder with replacement');
  assert.equal(first.byteLength, 4 + 6 + 5, 'raw byte count of `"ok-` (4) + 6 bad bytes + `-end"` (5)');
  assert.equal(o.elements[1]!.text, '"\u00e9"');
});

test('very long strings and elements spanning many chunks are assembled exactly', async () => {
  const big = '"' + 'x\\"\u00e9\u65e5'.repeat(4_000) + '"';
  const input = `[${big},${big}]`;
  const o = await invariant(arr, input);
  assert.deepEqual(
    o.elements.map((e) => e.text),
    [big, big],
  );
});

test('allowSingleObject: a top-level object is one element; arrays still work with the option on', async () => {
  const opts = { allowSingleObject: true };
  const o = await invariant(arr, '\ufeff \n{"a":[1,{"b":"}"}],"c":"d"} \n', opts);
  assert.equal(o.error, undefined);
  assert.deepEqual(
    o.elements.map((e) => [e.index, e.text]),
    [[0, '{"a":[1,{"b":"}"}],"c":"d"}']],
  );
  assert.deepEqual(await texts(arr, '[{"a":1},{"b":2}]', opts), ['{"a":1}', '{"b":2}']);
  await fails(arr, '{"a":1}', 'TOP_LEVEL_NOT_ARRAY', 0); // option off by default
  await fails(arr, '{"a":1} x', 'TRAILING_DATA', 8, opts);
  await fails(arr, '{"a":1}{"b":2}', 'TRAILING_DATA', 7, opts);
  await fails(arr, '{"a":', 'UNTERMINATED_OBJECT', 5, opts);
  await fails(arr, '42', 'TOP_LEVEL_NOT_ARRAY', 0, opts); // scalars are still refused
});

test('nesting depth: exactly MAX_JSON_DEPTH is accepted, one more is refused with its byte offset', async () => {
  assert.equal(MAX_JSON_DEPTH, 10_000);
  const ok = '['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH);
  const o = await run(arr, `[${ok}]`, 4096);
  assert.equal(o.error, undefined);
  assert.equal(o.elements.length, 1);
  assert.equal(o.elements[0]!.byteLength, 2 * MAX_JSON_DEPTH);

  const tooDeep = '['.repeat(MAX_JSON_DEPTH + 1) + ']'.repeat(MAX_JSON_DEPTH + 1);
  const bad = await run(arr, `[${tooDeep}]`, 4096);
  assert.equal(bad.error?.code, 'IMPORT_PARSE_ERROR');
  assert.equal(bad.error?.details?.['reason'], 'DEPTH_EXCEEDED');
  assert.equal(bad.error?.details?.['byteOffset'], 1 + MAX_JSON_DEPTH, 'offset of the bracket that exceeded the limit');
  // Same with objects, and an unterminated hostile prefix is refused without needing the rest.
  const hostile = await run(arr, '[' + '{"a":'.repeat(MAX_JSON_DEPTH + 1), 1000);
  assert.equal(hostile.error?.details?.['reason'], 'DEPTH_EXCEEDED');
});

test('the splitter validates framing only: malformed element INSIDES are passed through for the caller to reject', async () => {
  // Each of these is invalid JSON for JSON.parse but well-framed; the caller skips such elements individually.
  const framed = ['{"a" 1}', '{,}', '[1 2]', '"\\x"', 'nul', '01', '1.2.3', '{"a":}', '[,]'];
  // `[1 2]` / `[,]` / `{,}` contain structure errors only INSIDE a bracket pair, which is not the splitter's concern.
  assert.deepEqual(await texts(arr, `[${framed.join(',')}]`), framed);
  // ...but each really is rejected by JSON.parse, which is what the caller will do per element.
  for (const f of framed) assert.throws(() => JSON.parse(f), SyntaxError, f);
});

// ---------------------------------------------------------------------------------------------------------------
// jsonArrayElements: structural errors (exact reason + offset, chunk-invariant)
// ---------------------------------------------------------------------------------------------------------------

test('no value at all: EMPTY_INPUT', async () => {
  await fails(arr, '', 'EMPTY_INPUT', 0);
  await fails(arr, '   \n', 'EMPTY_INPUT', 4);
  await fails(arr, '\ufeff', 'EMPTY_INPUT', 3);
  await fails(arr, '\ufeff \t', 'EMPTY_INPUT', 5);
});

test('top-level scalar (or object without the option): TOP_LEVEL_NOT_ARRAY at the first significant byte', async () => {
  for (const input of ['42', '"x"', 'true', 'false', 'null', '-1', '3.5']) await fails(arr, input, 'TOP_LEVEL_NOT_ARRAY', 0);
  await fails(arr, '  \n"x"', 'TOP_LEVEL_NOT_ARRAY', 3);
  await fails(arr, '\ufeff7', 'TOP_LEVEL_NOT_ARRAY', 3);
  await fails(arr, '{}', 'TOP_LEVEL_NOT_ARRAY', 0);
});

test('stray tokens where a value or structure is required: UNEXPECTED_BYTE', async () => {
  await fails(arr, '}', 'UNEXPECTED_BYTE', 0);
  await fails(arr, ']', 'UNEXPECTED_BYTE', 0);
  await fails(arr, ',', 'UNEXPECTED_BYTE', 0);
  await fails(arr, 'x[1]', 'UNEXPECTED_BYTE', 0);
  await fails(arr, ' :[1]', 'UNEXPECTED_BYTE', 1);
  await fails(arr, '[}]', 'UNEXPECTED_BYTE', 1);
  await fails(arr, '[x]', 'UNEXPECTED_BYTE', 1);
  await fails(arr, '[+1]', 'UNEXPECTED_BYTE', 1);
  await fails(arr, '[1,}]', 'UNEXPECTED_BYTE', 3);
  await fails(arr, '[1}]', 'UNEXPECTED_BYTE', 2); // a scalar may only be followed by whitespace, `,` or `]`
  await fails(arr, '[1"a"]', 'UNEXPECTED_BYTE', 2);
  await fails(arr, '[1:2]', 'UNEXPECTED_BYTE', 2);
  await fails(arr, '[tr{ue]', 'UNEXPECTED_BYTE', 3);
});

test('empty elements, trailing commas and missing commas', async () => {
  await fails(arr, '[1,,2]', 'EMPTY_ELEMENT', 3);
  await fails(arr, '[,1]', 'EMPTY_ELEMENT', 1);
  await fails(arr, '[,]', 'EMPTY_ELEMENT', 1);
  await fails(arr, '[1, ,2]', 'EMPTY_ELEMENT', 4);
  await fails(arr, '[1,]', 'TRAILING_COMMA', 3);
  await fails(arr, '[1, \n ]', 'TRAILING_COMMA', 6);
  await fails(arr, '[{"a":1},]', 'TRAILING_COMMA', 9);
  await fails(arr, '[1 2]', 'MISSING_COMMA', 3);
  await fails(arr, '[{} {}]', 'MISSING_COMMA', 4);
  await fails(arr, '["a" "b"]', 'MISSING_COMMA', 5);
  await fails(arr, '[[] 1]', 'MISSING_COMMA', 4);
});

test('mismatched brackets inside an element', async () => {
  await fails(arr, '[{]', 'MISMATCHED_BRACKET', 2);
  await fails(arr, '[[}]', 'MISMATCHED_BRACKET', 2);
  await fails(arr, '[{"a":1]', 'MISMATCHED_BRACKET', 7);
  await fails(arr, '[{"a":[1}]', 'MISMATCHED_BRACKET', 8);
});

test('unterminated string / object / array report where the input ended', async () => {
  await fails(arr, '[', 'UNTERMINATED_ARRAY', 1);
  await fails(arr, '[1', 'UNTERMINATED_ARRAY', 2);
  await fails(arr, '[1,', 'UNTERMINATED_ARRAY', 3);
  await fails(arr, '[1, ', 'UNTERMINATED_ARRAY', 4);
  await fails(arr, '[{"a":1}', 'UNTERMINATED_ARRAY', 8);
  await fails(arr, '["abc', 'UNTERMINATED_STRING', 5);
  await fails(arr, '["abc\\', 'UNTERMINATED_STRING', 6); // input ends right after a backslash
  await fails(arr, '["abc\\"', 'UNTERMINATED_STRING', 7); // the escaped quote does not close the string
  await fails(arr, '[{"a":"b', 'UNTERMINATED_STRING', 8);
  await fails(arr, '[{"a":1', 'UNTERMINATED_OBJECT', 7);
  await fails(arr, '[{"a":[1', 'UNTERMINATED_ARRAY', 8); // innermost open container decides
  await fails(arr, '[{"a":[1]', 'UNTERMINATED_OBJECT', 9);
  await fails(arr, '[[1,2', 'UNTERMINATED_ARRAY', 5);
});

test('extra data after the closing bracket: TRAILING_DATA at its first byte; trailing whitespace is fine', async () => {
  await fails(arr, '[1] x', 'TRAILING_DATA', 4);
  await fails(arr, '[1][2]', 'TRAILING_DATA', 3);
  await fails(arr, '[1],', 'TRAILING_DATA', 3);
  await fails(arr, '[]]', 'TRAILING_DATA', 2);
  await fails(arr, '[1]\n\n[2]', 'TRAILING_DATA', 5);
  await fails(arr, '[1]\u00e9', 'TRAILING_DATA', 3);
  assert.deepEqual(await texts(arr, '[1] \n\t\r\n'), ['1']);
});

test('partial or misplaced byte order marks: BAD_BOM / UNEXPECTED_BYTE', async () => {
  await fails(arr, Buffer.from([0xef]), 'BAD_BOM', 1);
  await fails(arr, Buffer.from([0xef, 0xbb]), 'BAD_BOM', 2);
  await fails(arr, Buffer.from([0xef, 0xbb, 0x5b]), 'BAD_BOM', 2);
  await fails(arr, Buffer.from([0xef, 0x5b, 0x5d]), 'BAD_BOM', 1);
  await fails(arr, Buffer.concat([Buffer.from(' '), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[]')]), 'UNEXPECTED_BYTE', 1);
  await fails(arr, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('[]')]), 'UNEXPECTED_BYTE', 3); // two BOMs
});

test('elements completed before a structural error are still delivered; errors never contain input content', async () => {
  const o = await invariant(arr, '["SECRET-ONE", {"token":"SECRET-TWO"}, "SECRET-THREE" ?]');
  assert.deepEqual(
    o.elements.map((e) => e.text),
    ['"SECRET-ONE"', '{"token":"SECRET-TWO"}', '"SECRET-THREE"'],
  );
  assert.equal(o.error?.details?.['reason'], 'UNEXPECTED_BYTE');
  assert.ok(!/SECRET/.test(o.error!.message), 'message must not echo content');
  assert.ok(!/SECRET/.test(JSON.stringify(o.error!.details)), 'details must not echo content');
  assert.ok(!/SECRET/.test(JSON.stringify(o.error!.toEnvelope())), 'envelope must not echo content');
});

test('every declared parse reason is reachable (the reason list is not stale)', async () => {
  const seen = new Set<string>();
  const samples: Array<[Gen, string | Buffer, JsonStreamOptions?]> = [
    [arr, ''],
    [arr, Buffer.from([0xef])],
    [arr, '1'],
    [arr, '}'],
    [arr, '[1 2]'],
    [arr, '[,]'],
    [arr, '[1,]'],
    [arr, '[{]'],
    [arr, '[' + '['.repeat(MAX_JSON_DEPTH + 1)],
    [arr, '["a'],
    [arr, '[{"a":1'],
    [arr, '[1'],
    [arr, '[] x'],
  ];
  for (const [gen, input, opts] of samples) {
    const o = await run(gen, input, 1 << 16, opts);
    if (o.error) seen.add(String(o.error.details?.['reason']));
  }
  assert.deepEqual([...seen].sort(), [...JSON_PARSE_REASONS].sort());
});

// ---------------------------------------------------------------------------------------------------------------
// Limits and options
// ---------------------------------------------------------------------------------------------------------------

function limitCase(label: string, element: string): void {
  test(`maxElementBytes (${label}): exactly at the limit is accepted, one byte more is IMPORT_LIMIT_EXCEEDED`, async () => {
    const size = Buffer.byteLength(element);
    const good = await invariant(arr, `[1, ${element}, 2]`, { maxElementBytes: size });
    assert.equal(good.error, undefined);
    assert.equal(good.elements[1]!.text, element);
    const bad = await invariant(arr, `[1, ${element}, 2]`, { maxElementBytes: size - 1 });
    assert.equal(bad.error?.code, 'IMPORT_LIMIT_EXCEEDED');
    assert.equal(bad.error?.details?.['reason'], 'ELEMENT_TOO_LARGE');
    assert.equal(bad.error?.details?.['elementIndex'], 1);
    assert.equal(bad.error?.details?.['max'], size - 1);
    assert.deepEqual(
      bad.elements.map((e) => e.text),
      ['1'],
      'earlier elements were delivered',
    );
    assert.ok(!bad.error!.message.includes(element.slice(0, 8)) || element.length < 10, 'message carries no content');
  });
}
limitCase('object', '{"key":"a value that is long enough to matter"}');
limitCase('string', '"' + 'y'.repeat(300) + '"');
limitCase('array', '[' + '1,'.repeat(100) + '2]');
limitCase('scalar', '123456789012345678901234567890');
limitCase('multi-byte', '"' + '\ud83d\ude00'.repeat(40) + '"'); // the limit is in BYTES (4 per emoji), not characters

test('limit trips are defined by ABSOLUTE byte position: same error and offset for every chunking, ordered against structural errors', async () => {
  // Regression for a chunk-dependent bug found by the property tests: the offset used to be "where the chunk ended" and a
  // later structural error could win over an earlier size violation depending on how the bytes were cut.
  const limitAt = async (gen: Gen, input: string, max: number, offset: number, index = 0): Promise<void> => {
    const o = await invariant(gen, input, { maxElementBytes: max });
    assert.equal(o.error?.code, 'IMPORT_LIMIT_EXCEEDED', input);
    assert.equal(o.error?.details?.['byteOffset'], offset, `${input}: offset of the first byte that does not fit`);
    assert.equal(o.error?.details?.['elementIndex'], index);
  };
  await limitAt(arr, '[[[[[[', 4, 5); // element starts at 1; its 5th byte (offset 5) is the first that does not fit
  await limitAt(arr, '[[[[[[}', 4, 5); // the mismatched `}` at offset 6 comes LATER, so the size violation is reported
  await limitAt(arr, '[1234567]', 4, 5); // scalar
  await limitAt(arr, '["abcdef"]', 4, 5); // string
  await limitAt(arr, '[1,{"k":"vvvv"}]', 5, 8, 1); // second element, starts at offset 3
  await limitAt(lines, '[[[[[[', 4, 4);
  await limitAt(lines, '{"a":1}\n[[[[[[[[\n', 7, 15, 1); // line 2 starts at offset 8; its 8th byte is offset 15
  // Exactly at the limit is fine, so a structural error right AFTER the element is the one reported.
  await fails(arr, '[{"a":1}x]', 'UNEXPECTED_BYTE', 8, { maxElementBytes: 7 });
  await fails(arr, '[1234 5]', 'MISSING_COMMA', 6, { maxElementBytes: 4 });
  // An open element that simply ends the input at the limit is UNTERMINATED, not "too large".
  await fails(arr, '[[[[', 'UNTERMINATED_ARRAY', 4, { maxElementBytes: 3 });
});

test('maxElementBytes bounds memory: a never-ending string is cut off after ~limit bytes of input, not consumed to the end', async () => {
  let pulled = 0;
  async function* endless(): AsyncGenerator<Buffer> {
    yield Buffer.from('["');
    for (;;) {
      pulled++;
      if (pulled > 10_000) return; // safety net so a regression fails the assertion instead of looping forever
      yield Buffer.alloc(1 << 20, 0x61);
    }
  }
  await assert.rejects(
    (async () => {
      for await (const el of jsonArrayElements(endless(), { maxElementBytes: 4 * 1024 * 1024 })) void el;
    })(),
    (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_LIMIT_EXCEEDED',
  );
  assert.ok(pulled <= 6, `pulled ${pulled} MiB chunks before stopping`);
});

test('invalid maxElementBytes is INVALID_ARGUMENT; defaults apply when omitted', async () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number]) {
    await assert.rejects(
      (async () => {
        for await (const el of jsonArrayElements(chunked(Buffer.from('[1]'), 3), { maxElementBytes: bad })) void el;
      })(),
      (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT',
      String(bad),
    );
  }
  for (const gen of [arr, lines]) {
    await assert.rejects(
      (async () => {
        for await (const el of gen(chunked(Buffer.from('[1]'), 3), null as unknown as JsonStreamOptions)) void el;
      })(),
      (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && e.details?.['reason'] === 'BAD_OPTIONS',
    );
  }
  assert.deepEqual(await texts(arr, '[1]', {}), ['1']);
  assert.deepEqual(await texts(arr, '[1]', { maxElementBytes: undefined }), ['1']);
});

// ---------------------------------------------------------------------------------------------------------------
// Source handling
// ---------------------------------------------------------------------------------------------------------------

test('sources: Uint8Array chunks, sync iterables and empty chunks are accepted', async () => {
  const text = '[{"a":1},"b"]';
  const u8 = new Uint8Array(Buffer.from(text));
  async function* asU8(): AsyncGenerator<Uint8Array> {
    yield u8.subarray(0, 4);
    yield new Uint8Array(0);
    yield u8.subarray(4);
  }
  const fromU8: string[] = [];
  for await (const e of jsonArrayElements(asU8())) fromU8.push(e.text);
  assert.deepEqual(fromU8, ['{"a":1}', '"b"']);

  const fromSync: string[] = [];
  for await (const e of jsonArrayElements([Buffer.from('[1,'), Buffer.alloc(0), Buffer.from('2]')])) fromSync.push(e.text);
  assert.deepEqual(fromSync, ['1', '2']);
});

test('sources: non-binary chunks (e.g. strings) are INVALID_ARGUMENT', async () => {
  await assert.rejects(
    (async () => {
      for await (const e of jsonArrayElements(['[1]'] as unknown as AsyncIterable<Buffer>)) void e;
    })(),
    (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT',
  );
});

test('sources: an error thrown by the source (e.g. a ZIP CRC failure at stream end) propagates unchanged, after earlier elements', async () => {
  const boom = new GcrError('IMPORT_ZIP_UNSAFE', 'ZIP entry #0 rejected (CRC_MISMATCH).', { details: { reason: 'CRC_MISMATCH' } });
  async function* failing(): AsyncGenerator<Buffer> {
    yield Buffer.from('[1,2,');
    yield Buffer.from('3]');
    throw boom;
  }
  const got: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const e of jsonArrayElements(failing())) got.push(e.text);
    })(),
    (e: unknown) => e === boom,
  );
  assert.deepEqual(got, ['1', '2', '3']);
});

test('sources: stopping early closes the source (cleanup propagates)', async () => {
  let closed = false;
  async function* src(): AsyncGenerator<Buffer> {
    try {
      yield Buffer.from('[1,2,3,');
      yield Buffer.from('4,5,6]');
    } finally {
      closed = true;
    }
  }
  for await (const e of jsonArrayElements(src())) {
    if (e.text === '2') break;
  }
  assert.equal(closed, true);
});

test('sources: a source that REUSES one mutable buffer for every chunk cannot corrupt carried-over bytes', async () => {
  const text = '[{"alpha":"aaaaaaaaaaaaaaaa"},"bbbbbbbbbbbbbbbbbbbb",{"c":[1,2,3,"cccccccccc"]}]';
  const data = Buffer.from(text);
  const shared = Buffer.alloc(5);
  async function* reuse(): AsyncGenerator<Buffer> {
    for (let i = 0; i < data.length; i += shared.length) {
      shared.fill(0x7a); // poison
      const n = data.copy(shared, 0, i, Math.min(data.length, i + shared.length));
      yield shared.subarray(0, n);
    }
  }
  const got: string[] = [];
  for await (const e of jsonArrayElements(reuse())) got.push(e.text);
  assert.deepEqual(got, ['{"alpha":"aaaaaaaaaaaaaaaa"}', '"bbbbbbbbbbbbbbbbbbbb"', '{"c":[1,2,3,"cccccccccc"]}']);
});

test('the module never calls JSON.parse and imports nothing but errors/limits', () => {
  const src = readFileSync(new URL('../../../src/ingest/json-stream.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/JSON\s*\.\s*parse/.test(code), 'json-stream.ts must not call JSON.parse');
  assert.deepEqual(
    [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]),
    ['../errors.js', './limits.js'],
  );
});

// ---------------------------------------------------------------------------------------------------------------
// jsonLinesElements (NDJSON)
// ---------------------------------------------------------------------------------------------------------------

test('NDJSON: one value per line; blank lines, CRLF, indentation and a missing final newline are fine', async () => {
  const input = '{"a":1}\n\n  [1,2]  \r\n"str"\r\n\t\n42\ntrue\nnull\n{"last":"no newline"}';
  const o = await invariant(lines, input);
  assert.equal(o.error, undefined);
  assert.deepEqual(
    o.elements.map((e) => [e.index, e.text]),
    [
      [0, '{"a":1}'],
      [1, '[1,2]'],
      [2, '"str"'],
      [3, '42'],
      [4, 'true'],
      [5, 'null'],
      [6, '{"last":"no newline"}'],
    ],
  );
});

test('NDJSON: empty input and blank-only input yield nothing; a bare scalar at EOF is complete; BOM tolerated', async () => {
  for (const input of ['', '\n', ' \n\r\n\t\n', '\ufeff', '\ufeff\n\n']) assert.deepEqual(await texts(lines, input), [], JSON.stringify(input));
  assert.deepEqual(await texts(lines, '1\n2'), ['1', '2']);
  assert.deepEqual(await texts(lines, '\ufeff{"a":"\u65e5\u672c"}\n"\ud83d\ude00"\n'), ['{"a":"\u65e5\u672c"}', '"\ud83d\ude00"']);
  assert.deepEqual(await texts(lines, '{"s":"brackets ]} inside"}\n{"s":"\\"\\\\"}\n'), ['{"s":"brackets ]} inside"}', '{"s":"\\"\\\\"}']);
});

test('NDJSON: a value must end on its own line; structural errors carry exact reasons and offsets', async () => {
  await fails(lines, '{"a":1} {"b":2}\n', 'TRAILING_DATA', 8);
  await fails(lines, '1 2\n', 'TRAILING_DATA', 2);
  await fails(lines, '{"a":\n{"b":1}\n', 'UNTERMINATED_OBJECT', 5); // newline inside an open object
  await fails(lines, '[1,\n2]\n', 'UNTERMINATED_ARRAY', 3);
  await fails(lines, '"abc\n"', 'UNTERMINATED_STRING', 4);
  await fails(lines, '"abc\\\n"', 'UNTERMINATED_STRING', 5); // an escaped raw LF still ends the line
  await fails(lines, '{"a":', 'UNTERMINATED_OBJECT', 5); // EOF inside a value
  await fails(lines, '"abc', 'UNTERMINATED_STRING', 4);
  await fails(lines, '}\n', 'UNEXPECTED_BYTE', 0);
  await fails(lines, '1\n,\n', 'UNEXPECTED_BYTE', 2);
  await fails(lines, '[1}\n', 'MISMATCHED_BRACKET', 2);
  await fails(lines, '1,\n', 'UNEXPECTED_BYTE', 1); // `,` is not a delimiter in NDJSON
  await fails(lines, Buffer.from([0xef, 0xbb]), 'BAD_BOM', 2);
  await fails(lines, '['.repeat(MAX_JSON_DEPTH + 1), 'DEPTH_EXCEEDED', MAX_JSON_DEPTH); // the line starts at offset 0
  const o = await invariant(lines, '{"ok":1}\n{"bad":\n');
  assert.deepEqual(
    o.elements.map((e) => e.text),
    ['{"ok":1}'],
    'lines before the broken one are delivered',
  );
});

test('NDJSON: maxElementBytes applies per line', async () => {
  const line = '{"k":"' + 'v'.repeat(100) + '"}';
  const size = Buffer.byteLength(line);
  assert.deepEqual(await texts(lines, `${line}\n${line}\n`, { maxElementBytes: size }), [line, line]);
  const tooBig = line.replace('v'.repeat(100), 'v'.repeat(101));
  const bad = await invariant(lines, `${line}\n${tooBig}\n${line}\n`, { maxElementBytes: size });
  assert.equal(bad.error?.code, 'IMPORT_LIMIT_EXCEEDED');
  assert.equal(bad.error?.details?.['elementIndex'], 1);
  assert.equal(bad.elements.length, 1);
});
