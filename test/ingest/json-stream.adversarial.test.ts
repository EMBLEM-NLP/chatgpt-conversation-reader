/**
 * Independent adversarial review of src/ingest/json-stream.ts (streaming-parser correctness and API misuse).
 * Each test below demonstrates a defect that was found in review (and is now fixed), or pins a hostile-input behaviour
 * the builder's suite did not execute:
 *  - a source that is not iterable must be INVALID_ARGUMENT, not a raw TypeError;
 *  - a fractional maxElementBytes must be rounded DOWN (an element of n bytes is allowed iff n <= limit);
 *  - a raised maxElementBytes can never promise more than a JS string can hold (otherwise a legal-looking element
 *    surfaces as a raw ERR_STRING_TOO_LONG after ~512 MiB have been buffered);
 *  - a differential/chunking sweep over hostile byte soups (every outcome is a GcrError, identical for every chunking).
 */
import assert from 'node:assert/strict';
import { constants as bufferConstants } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { jsonArrayElements, jsonLinesElements } from '../../src/ingest/json-stream.js';
import type { JsonElement, JsonStreamOptions } from '../../src/ingest/json-stream.js';

type Gen = (source: AsyncIterable<Buffer | Uint8Array>, opts?: JsonStreamOptions) => AsyncGenerator<JsonElement, void, undefined>;
const arr = jsonArrayElements as Gen;
const lines = jsonLinesElements as Gen;
const GENS: Array<[string, Gen]> = [
  ['jsonArrayElements', arr],
  ['jsonLinesElements', lines],
];

async function* chunked(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(buf.length, i + size));
}

interface Outcome {
  texts: string[];
  error: GcrError | undefined;
}

async function run(gen: Gen, input: string | Buffer, chunkSize: number, opts?: JsonStreamOptions): Promise<Outcome> {
  const texts: string[] = [];
  try {
    for await (const el of gen(chunked(typeof input === 'string' ? Buffer.from(input) : input, chunkSize), opts)) texts.push(el.text);
  } catch (e) {
    assert.ok(e instanceof GcrError, `non-GcrError thrown: ${String(e)}`);
    return { texts, error: e };
  }
  return { texts, error: undefined };
}

/** Same outcome (elements, code, details, message) for every chunking; returns it. */
async function invariant(gen: Gen, input: string | Buffer, opts?: JsonStreamOptions): Promise<Outcome> {
  const reference = await run(gen, input, 1 << 20, opts);
  for (const size of [1, 2, 3, 5, 7]) {
    const o = await run(gen, input, size, opts);
    assert.deepEqual(o.texts, reference.texts, `elements differ at chunk size ${size}`);
    assert.equal(o.error?.code, reference.error?.code, `code differs at chunk size ${size}`);
    assert.deepEqual(o.error?.details, reference.error?.details, `details differ at chunk size ${size}`);
  }
  return reference;
}

// ---------------------------------------------------------------------------------------------------------------
// Defect: a source that is not iterable surfaced as a raw TypeError
// ---------------------------------------------------------------------------------------------------------------

test('a source that is not an (async) iterable is INVALID_ARGUMENT (BAD_SOURCE), never a raw TypeError', async () => {
  const bad: unknown[] = [null, undefined, 0, 5, true, {}, { next: () => ({ done: true }) }, () => undefined, Symbol('s')];
  for (const [name, gen] of GENS) {
    for (const source of bad) {
      await assert.rejects(
        (async () => {
          for await (const el of gen(source as AsyncIterable<Buffer>)) void el;
        })(),
        (e: unknown) => {
          assert.ok(e instanceof GcrError, `${name}(${String(typeof source)}): expected GcrError, got ${String(e)}`);
          assert.equal(e.code, 'INVALID_ARGUMENT');
          assert.equal(e.details?.['reason'], 'BAD_SOURCE');
          return true;
        },
      );
    }
  }
});

test('errors raised by the source itself (creating its iterator, or while iterating) propagate unchanged; elements before them are delivered', async () => {
  const boom = new RangeError('source exploded');
  const throwsOnCreate = { [Symbol.asyncIterator]: (): AsyncIterator<Buffer> => { throw boom; } } as AsyncIterable<Buffer>;
  async function* throwsMidway(): AsyncGenerator<Buffer> {
    yield Buffer.from('[1,2,');
    throw boom;
  }
  for (const [name, gen] of GENS) {
    await assert.rejects(
      (async () => {
        for await (const el of gen(throwsOnCreate)) void el;
      })(),
      (e: unknown) => e === boom,
      `${name}: iterator creation`,
    );
    const seen: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const el of gen(throwsMidway())) seen.push(el.text);
      })(),
      (e: unknown) => e === boom,
      `${name}: mid-stream`,
    );
    // `1` is complete in both modes only for the array (its delimiter `,` was seen); NDJSON scalars wait for a newline.
    assert.deepEqual(seen, name === 'jsonArrayElements' ? ['1', '2'] : [], name);
  }
});

test('a bare Buffer or string passed instead of a chunk iterable is rejected as a bad chunk, not parsed silently', async () => {
  // Both are iterable (of numbers / of characters), so the failure must come from the per-chunk type check.
  for (const [, gen] of GENS) {
    for (const source of [Buffer.from('[1]'), '[1]', new Uint8Array([0x5b, 0x5d])]) {
      await assert.rejects(
        (async () => {
          for await (const el of gen(source as unknown as AsyncIterable<Buffer>)) void el;
        })(),
        (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && e.details?.['reason'] === 'BAD_CHUNK_TYPE',
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Defect: fractional maxElementBytes let ceil(limit) bytes through
// ---------------------------------------------------------------------------------------------------------------

test('a fractional maxElementBytes is rounded DOWN: an element of n bytes is accepted iff n <= limit', async () => {
  const cases: Array<[Gen, string, number, string[] | 'too-large']> = [
    [arr, '[12]', 1.5, 'too-large'], // 2 bytes > 1.5 (used to be accepted: only 2 > ceil(1.5)=2 was compared)
    [arr, '[1]', 1.5, ['1']],
    [arr, '["ab"]', 3.9, 'too-large'], // 4 bytes > 3.9
    [arr, '["a"]', 3.9, ['"a"']], // 3 bytes
    [arr, '[[1,2]]', 4.999, 'too-large'], // 5 bytes
    [arr, '[[1,2]]', 5.001, ['[1,2]']],
    [lines, '12\n', 1.5, 'too-large'],
    [lines, '1\n', 1.5, ['1']],
    [lines, '{"a":1}\n', 6.5, 'too-large'], // 7 bytes
    [lines, '{"a":1}\n', 7.5, ['{"a":1}']],
  ];
  for (const [gen, input, limit, expected] of cases) {
    const o = await invariant(gen, input, { maxElementBytes: limit });
    const label = `${gen === arr ? 'array' : 'lines'} ${JSON.stringify(input)} limit ${limit}`;
    if (expected === 'too-large') {
      assert.ok(o.error !== undefined, `${label}: accepted but the element is larger than the limit`);
      assert.equal(o.error.code, 'IMPORT_LIMIT_EXCEEDED', label);
      assert.equal(o.error.details?.['reason'], 'ELEMENT_TOO_LARGE', label);
      assert.equal(o.error.details?.['max'], Math.floor(limit), `${label}: the reported limit is the effective whole-byte limit`);
    } else {
      assert.equal(o.error, undefined, `${label}: ${o.error?.message}`);
      assert.deepEqual(o.texts, expected, label);
    }
  }
});

test('a maxElementBytes below one whole byte is INVALID_ARGUMENT (no element could ever fit)', async () => {
  for (const [, gen] of GENS) {
    for (const bad of [0.5, 0.999, Number.MIN_VALUE]) {
      await assert.rejects(
        (async () => {
          for await (const el of gen(chunked(Buffer.from('[1]'), 3), { maxElementBytes: bad })) void el;
        })(),
        (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT',
        String(bad),
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Defect: a raised limit above the maximum JS string length ended in a raw ERR_STRING_TOO_LONG
// ---------------------------------------------------------------------------------------------------------------

// TQ-07: this scenario buffers ~512 MiB (the element grows by doubling up to the clamp, in Buffers outside the JS heap). It used
// to be skipped whenever os.freemem() was below 4 GiB, so on a busy or small CI machine the assertion about the clamp silently
// disappeared. It now always runs, in a CHILD process with an explicit V8 heap cap: the outcome does not depend on the free
// memory of the moment (a machine that really cannot spare ~1 GiB gets a clear failure, never a silent skip), the parent test
// process never holds the buffers, and the cap proves that the importer needs no big JS heap for an oversized element.
const CHILD_HEAP_CAP_MIB = 96;

test('maxElementBytes can never exceed what a JS string can hold: an element at that size is IMPORT_LIMIT_EXCEEDED, not a raw Error (child process, explicit heap cap)', { timeout: 180_000 }, async () => {
  const maxString = bufferConstants.MAX_STRING_LENGTH;
  const moduleUrl = new URL('../../src/ingest/json-stream.js', import.meta.url).href;
  const script = `
    import { jsonArrayElements } from ${JSON.stringify(moduleUrl)};
    import { getHeapStatistics } from 'node:v8';
    import { constants } from 'node:buffer';
    const slab = Buffer.alloc(8 * 1024 * 1024, 0x61);
    async function* oversized() {
      yield Buffer.from('["');
      let remaining = constants.MAX_STRING_LENGTH + 16; // comfortably more than a string can hold
      while (remaining > 0) {
        const n = Math.min(remaining, slab.length);
        yield slab.subarray(0, n);
        remaining -= n;
      }
      yield Buffer.from('"]');
    }
    let outcome;
    try {
      for await (const el of jsonArrayElements(oversized(), { maxElementBytes: 2 ** 40 })) void el;
      outcome = { threw: false };
    } catch (e) {
      outcome = { threw: true, isGcrError: e?.constructor?.name === 'GcrError', name: String(e?.name), code: e?.code, reason: e?.details?.reason, max: e?.details?.max, message: String(e?.message).slice(0, 200) };
    }
    process.stdout.write(JSON.stringify({ ...outcome, maxString: constants.MAX_STRING_LENGTH, heapLimit: getHeapStatistics().heap_size_limit }));
  `;
  const child = spawn(process.execPath, [`--max-old-space-size=${CHILD_HEAP_CAP_MIB}`, '--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null, `the child was killed by ${String(signal)} (it needs about 1 GiB of memory outside the JS heap); stderr: ${stderr.slice(0, 300)}`);
  assert.equal(code, 0, `child exit code; stderr: ${stderr.slice(0, 300)}`);
  const r = JSON.parse(stdout) as { threw: boolean; isGcrError: boolean; name: string; code?: string; reason?: string; max?: number; message?: string; maxString: number; heapLimit: number };
  assert.ok(r.heapLimit < 512 * 1024 ** 2, `the explicit --max-old-space-size=${CHILD_HEAP_CAP_MIB} applied (heap limit ${r.heapLimit})`);
  assert.equal(r.maxString, maxString, 'the child runs on the same runtime');
  assert.equal(r.threw, true, 'an element larger than a JS string must be refused');
  assert.equal(r.isGcrError, true, `expected a GcrError, got ${r.name}: ${r.message ?? ''}`);
  assert.equal(r.code, 'IMPORT_LIMIT_EXCEEDED');
  assert.equal(r.reason, 'ELEMENT_TOO_LARGE');
  // Equality (not <=) also pins the hard-coded constant in json-stream.ts to the runtime's real value.
  assert.equal(r.max, maxString, 'the effective limit is exactly the maximum string length');
});

// ---------------------------------------------------------------------------------------------------------------
// Hostile byte soups: only GcrError outcomes, identical for every chunking, no raw errors
// ---------------------------------------------------------------------------------------------------------------

test('hostile byte soups (structural bytes, BOM fragments, NULs, high bytes): GcrError or elements, identical for every chunking', async () => {
  // Deterministic LCG so a failure reproduces.
  let seed = 0x5eed;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * n);
  };
  const alphabet = [0x5b, 0x5d, 0x7b, 0x7d, 0x22, 0x5c, 0x2c, 0x3a, 0x0a, 0x0d, 0x20, 0x09, 0x00, 0xef, 0xbb, 0xbf, 0xff, 0xc3, 0xa9, 0x31, 0x74, 0x6e, 0x2d];
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 1500; i++) {
    const len = next(24);
    const buf = Buffer.from(Array.from({ length: len }, () => alphabet[next(alphabet.length)] as number));
    for (const [, gen] of GENS) {
      for (const opts of [undefined, { maxElementBytes: 1 + next(8) }] as const) {
        const o = await invariant(gen, buf, opts);
        if (o.error === undefined) accepted++;
        else rejected++;
      }
    }
  }
  assert.ok(accepted > 0 && rejected > 0, `sanity: ${accepted} accepted, ${rejected} rejected`);
});

test('every yielded element of a hostile soup is exactly the input slice it claims (byteLength and text agree with the source bytes)', async () => {
  const input = Buffer.from(' \n[ "a\\"]" , {"k":[1,{"x":"\\\\"}]} , 12 , -0.5e+3 ,\ttrue, [[],[[]]] ]\r\n');
  for (const size of [1, 2, 3, 4, 1000]) {
    const got: JsonElement[] = [];
    for await (const el of jsonArrayElements(chunked(input, size))) got.push(el);
    assert.deepEqual(
      got.map((e) => e.text),
      ['"a\\"]"', '{"k":[1,{"x":"\\\\"}]}', '12', '-0.5e+3', 'true', '[[],[[]]]'],
      `chunk size ${size}`,
    );
    assert.deepEqual(
      got.map((e) => e.byteLength),
      got.map((e) => Buffer.byteLength(e.text)),
    );
    assert.deepEqual(
      got.map((e) => e.index),
      [0, 1, 2, 3, 4, 5],
    );
  }
});
