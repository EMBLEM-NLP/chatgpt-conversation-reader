/**
 * Property tests (fast-check, fixed seed) for the JSON splitter:
 *  - chunk-boundary invariance down to 1-byte chunks, for generated JSON containing unicode, escapes, nested structures
 *    and brackets/quotes inside strings;
 *  - a differential oracle against JSON.parse (the splitter must never reject, or mis-split, valid JSON);
 *  - mutated/garbage input yields only GcrError outcomes that are identical for every chunking;
 *  - NDJSON, invalid UTF-8.
 * On failure fast-check prints { seed, path }; rerun with that seed to replay.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import { jsonArrayElements, jsonLinesElements } from '../../src/ingest/json-stream.js';
import type { JsonElement, JsonStreamOptions } from '../../src/ingest/json-stream.js';

const SEED = 20261010;
type Gen = (source: AsyncIterable<Buffer | Uint8Array>, opts?: JsonStreamOptions) => AsyncGenerator<JsonElement, void, undefined>;

/** Cut `buf` into chunks whose sizes cycle through `sizes` (all >= 1). */
async function* cut(buf: Buffer, sizes: readonly number[]): AsyncGenerator<Buffer> {
  let i = 0;
  let k = 0;
  while (i < buf.length) {
    const n = Math.max(1, sizes[k % sizes.length] ?? 1);
    k++;
    yield buf.subarray(i, i + n);
    i += n;
  }
}

interface Outcome {
  elements: JsonElement[];
  error: { code: string; details: unknown; message: string } | undefined;
}

async function run(gen: Gen, buf: Buffer, sizes: readonly number[], opts?: JsonStreamOptions): Promise<Outcome> {
  const elements: JsonElement[] = [];
  try {
    for await (const el of gen(cut(buf, sizes), opts)) elements.push(el);
  } catch (e) {
    assert.ok(e instanceof GcrError, `only GcrError may escape the splitter, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    assert.ok(e.code === 'IMPORT_PARSE_ERROR' || e.code === 'IMPORT_LIMIT_EXCEEDED', `unexpected code ${e.code}`);
    return { elements, error: { code: e.code, details: e.details, message: e.message } };
  }
  return { elements, error: undefined };
}

/** Outcome with a single huge chunk, compared against 1-byte chunks and a random chunking. */
async function assertInvariant(gen: Gen, buf: Buffer, sizes: readonly number[], opts?: JsonStreamOptions): Promise<Outcome> {
  const whole = await run(gen, buf, [Math.max(1, buf.length)], opts);
  const bytewise = await run(gen, buf, [1], opts);
  const random = await run(gen, buf, sizes, opts);
  assert.deepEqual(bytewise, whole, '1-byte chunks differ from a single chunk');
  assert.deepEqual(random, whole, `chunking ${JSON.stringify(sizes)} differs from a single chunk`);
  return whole;
}

// ---------------------------------------------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------------------------------------------

const AWKWARD = ['', '"', '\\', '\\"', ']', '[', '{', '}', ',', ':', '\n', '\r\n', '\t', 'caf\u00e9', '\u65e5\u672c\u8a9e', '\ud83d\ude00', '\u2028', '\u0000', '\ufeff', '\u00ff', '\\u005d', '"]},{"'] as const;

const awkwardString: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc.string({ unit: 'grapheme', maxLength: 8 }),
  fc.array(fc.constantFrom(...AWKWARD), { maxLength: 6 }).map((a) => a.join('')),
);

const jsonValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((d) => !Object.is(d, -0)),
    awkwardString,
    tie('array'),
    tie('object'),
  ),
  array: fc.array(tie('value'), { maxLength: 4 }),
  object: fc.array(fc.tuple(awkwardString, tie('value')), { maxLength: 4 }).map((entries) => Object.fromEntries(entries)),
})).value;

const ws = fc.constantFrom('', ' ', '\n', '\t', '\r\n', '  \n  ');
const indent = fc.constantFrom<string | number | undefined>(undefined, 0, 1, 2, '\t');
const chunkSizes = fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 });

interface ArrayCase {
  values: unknown[];
  space: string | number | undefined;
  bom: boolean;
  lead: string;
  trail: string;
  around: Array<[string, string]>;
  sizes: number[];
}
const arrayCase: fc.Arbitrary<ArrayCase> = fc.record({
  values: fc.array(jsonValue, { maxLength: 6 }),
  space: indent,
  bom: fc.boolean(),
  lead: ws,
  trail: ws,
  around: fc.array(fc.tuple(ws, ws), { minLength: 6, maxLength: 6 }),
  sizes: chunkSizes,
});

function render(c: ArrayCase): { input: Buffer; expected: string[] } {
  const expected = c.values.map((v) => JSON.stringify(v, null, c.space));
  const body = expected.map((t, i) => `${c.around[i]?.[0] ?? ''}${t}${c.around[i]?.[1] ?? ''}`).join(',');
  const text = `${c.bom ? '\ufeff' : ''}${c.lead}[${body}${expected.length === 0 ? c.trail : ''}]${c.trail}`;
  return { input: Buffer.from(text, 'utf8'), expected };
}

// ---------------------------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------------------------

test(`valid arrays: exact element text, indexes and byte lengths for ANY chunking, down to 1 byte (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(arrayCase, async (c) => {
      const { input, expected } = render(c);
      const out = await assertInvariant(jsonArrayElements as Gen, input, c.sizes);
      assert.equal(out.error, undefined, out.error?.message);
      assert.deepEqual(
        out.elements.map((e) => e.text),
        expected,
      );
      assert.deepEqual(
        out.elements.map((e) => e.index),
        expected.map((_, i) => i),
      );
      assert.deepEqual(
        out.elements.map((e) => e.byteLength),
        expected.map((t) => Buffer.byteLength(t, 'utf8')),
      );
      // The elements are what JSON.parse would have produced for the original values.
      out.elements.forEach((e, i) => assert.deepEqual(JSON.parse(e.text), JSON.parse(JSON.stringify(c.values[i]))));
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test(`differential oracle: whenever JSON.parse accepts an array, the splitter accepts it and yields the same elements (seed ${SEED})`, async () => {
  const alphabet = ['[', ']', '{', '}', ',', ':', '"', '\\', ' ', '\n', '1', '-', 'n', 'u', 'l', 't', 'e', '.', '\u00e9'];
  const mutated = fc.record({
    base: arrayCase,
    edits: fc.array(fc.record({ pos: fc.nat(500), kind: fc.constantFrom('replace', 'insert', 'delete'), ch: fc.constantFrom(...alphabet) }), { maxLength: 3 }),
    sizes: chunkSizes,
  });
  let accepted = 0;
  let rejected = 0;
  await fc.assert(
    fc.asyncProperty(mutated, async ({ base, edits, sizes }) => {
      let text = render({ ...base, bom: false }).input.toString('utf8');
      for (const e of edits) {
        const p = e.pos % (text.length + 1);
        text = e.kind === 'insert' ? text.slice(0, p) + e.ch + text.slice(p) : e.kind === 'delete' ? text.slice(0, p) + text.slice(p + 1) : text.slice(0, p) + e.ch + text.slice(p + 1);
      }
      // Mutations can split a surrogate pair, leaving a lone surrogate that UTF-8 cannot carry (it becomes U+FFFD in the
      // bytes). Judge JSON.parse on exactly what the splitter sees: the text after a UTF-8 round trip.
      text = Buffer.from(text, 'utf8').toString('utf8');
      const out = await assertInvariant(jsonArrayElements as Gen, Buffer.from(text, 'utf8'), sizes);
      let parsed: unknown;
      let valid = true;
      try {
        parsed = JSON.parse(text);
      } catch {
        valid = false;
      }
      if (valid && Array.isArray(parsed)) {
        assert.equal(out.error, undefined, `JSON.parse accepts this array but the splitter rejected it: ${out.error?.message}`);
        assert.equal(out.elements.length, parsed.length);
        out.elements.forEach((el, i) => assert.deepEqual(JSON.parse(el.text), parsed[i], `element ${i}`));
        accepted++;
      } else if (valid) {
        assert.equal(out.error?.details && (out.error.details as { reason: string }).reason, 'TOP_LEVEL_NOT_ARRAY', 'a valid non-array document must be refused as such');
      } else {
        rejected++;
        // Invalid as a whole: the splitter may still frame it (it validates framing, not element insides), but if it
        // reports an error that error must carry an offset inside the input.
        const off = (out.error?.details as { byteOffset?: number } | undefined)?.byteOffset;
        if (off !== undefined) assert.ok(off >= 0 && off <= Buffer.byteLength(text), `offset ${off} outside the input`);
      }
    }),
    { seed: SEED, numRuns: 500 },
  );
  assert.ok(accepted > 20 && rejected > 20, `the generator should produce both valid and invalid cases (valid=${accepted}, invalid=${rejected})`);
});

test(`arbitrary garbage from a structural alphabet: only GcrError outcomes, identical for every chunking (seed ${SEED})`, async () => {
  const bytes = fc.array(fc.constantFrom(...Array.from('[]{},:"\\ \n\t1-ntrue.xe').map((c) => c.charCodeAt(0)), 0xc3, 0xa9, 0xff, 0x00, 0xef, 0xbb, 0xbf), { maxLength: 60 });
  await fc.assert(
    fc.asyncProperty(bytes, chunkSizes, fc.boolean(), fc.constantFrom<number | undefined>(undefined, 4, 16), async (arr, sizes, single, max) => {
      const opts: JsonStreamOptions = { allowSingleObject: single, ...(max === undefined ? {} : { maxElementBytes: max }) };
      await assertInvariant(jsonArrayElements as Gen, Buffer.from(arr), sizes, opts);
      await assertInvariant(jsonLinesElements as Gen, Buffer.from(arr), sizes, opts);
    }),
    { seed: SEED, numRuns: 600 },
  );
});

test(`element size limit is chunking-invariant and exact at the boundary (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(awkwardString, { minLength: 1, maxLength: 5 }), chunkSizes, fc.integer({ min: 0, max: 3 }), async (strings, sizes, slack) => {
      const texts = strings.map((s) => JSON.stringify(s));
      const longest = Math.max(...texts.map((t) => Buffer.byteLength(t)));
      const input = Buffer.from(`[${texts.join(',')}]`);
      const exact = await assertInvariant(jsonArrayElements as Gen, input, sizes, { maxElementBytes: longest + slack });
      assert.equal(exact.error, undefined);
      assert.equal(exact.elements.length, texts.length);
      const tight = await assertInvariant(jsonArrayElements as Gen, input, sizes, { maxElementBytes: longest - 1 || 1 });
      if (longest - 1 >= 1) {
        assert.equal(tight.error?.code, 'IMPORT_LIMIT_EXCEEDED');
        const firstTooBig = texts.findIndex((t) => Buffer.byteLength(t) > longest - 1);
        assert.equal((tight.error?.details as { elementIndex: number }).elementIndex, firstTooBig);
        assert.equal(tight.elements.length, firstTooBig, 'elements before the oversized one are delivered');
      }
    }),
    { seed: SEED, numRuns: 200 },
  );
});

test(`invalid UTF-8 inside strings decodes with U+FFFD exactly like the platform decoder, for any chunking (seed ${SEED})`, async () => {
  const noQuoteOrBackslash = fc.uint8Array({ maxLength: 12 }).map((a) => Uint8Array.from(a, (b) => (b === 0x22 || b === 0x5c ? 0x80 | (b & 0x7f) : b)));
  await fc.assert(
    fc.asyncProperty(fc.array(noQuoteOrBackslash, { minLength: 1, maxLength: 4 }), chunkSizes, async (payloads, sizes) => {
      const elementBytes = payloads.map((p) => Buffer.concat([Buffer.from('"'), Buffer.from(p), Buffer.from('"')]));
      const input = Buffer.concat([Buffer.from('['), ...elementBytes.flatMap((b, i) => (i === 0 ? [b] : [Buffer.from(','), b])), Buffer.from(']')]);
      const out = await assertInvariant(jsonArrayElements as Gen, input, sizes);
      assert.equal(out.error, undefined, out.error?.message);
      const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
      assert.deepEqual(
        out.elements.map((e) => e.text),
        elementBytes.map((b) => decoder.decode(b)),
      );
      assert.deepEqual(
        out.elements.map((e) => e.byteLength),
        elementBytes.map((b) => b.length),
      );
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test(`NDJSON: valid lines with blank lines, CRLF and indentation split identically for every chunking (seed ${SEED})`, async () => {
  const lineCase = fc.record({
    values: fc.array(jsonValue, { maxLength: 6 }),
    pad: fc.array(fc.tuple(fc.constantFrom('', ' ', '\t'), fc.constantFrom('', ' ', '\t'), fc.constantFrom('\n', '\r\n'), fc.constantFrom('', '\n', '\r\n\r\n', ' \n')), { minLength: 6, maxLength: 6 }),
    bom: fc.boolean(),
    finalNewline: fc.boolean(),
    sizes: chunkSizes,
  });
  await fc.assert(
    fc.asyncProperty(lineCase, async (c) => {
      const expected = c.values.map((v) => JSON.stringify(v)); // compact: JSON.stringify never emits a raw LF
      let text = c.bom ? '\ufeff' : '';
      expected.forEach((t, i) => {
        const [l, r, nl, blank] = c.pad[i] as [string, string, string, string];
        text += `${l}${t}${r}`;
        if (i < expected.length - 1 || c.finalNewline) text += nl + blank;
      });
      const out = await assertInvariant(jsonLinesElements as Gen, Buffer.from(text, 'utf8'), c.sizes);
      assert.equal(out.error, undefined, out.error?.message);
      assert.deepEqual(
        out.elements.map((e) => e.text),
        expected,
      );
      assert.deepEqual(
        out.elements.map((e) => e.index),
        expected.map((_, i) => i),
      );
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test('property sanity: a deliberately broken oracle WOULD be caught (the differential test can fail)', async () => {
  // Guard against a vacuous property: feed it a document the splitter must reject and check the harness notices.
  const out = await run(jsonArrayElements as Gen, Buffer.from('[1,,2]'), [1]);
  assert.equal(out.error?.code, 'IMPORT_PARSE_ERROR');
  assert.throws(() => JSON.parse('[1,,2]'));
});
