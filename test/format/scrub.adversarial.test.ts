/**
 * Adversarial review of the shared scrubber (src/format/scrub.ts, ATK-04).
 *
 * Three promises are checked against an INDEPENDENT oracle (an explicit list of code point ranges, spelled out here), over EVERY
 * Unicode scalar value and every lone surrogate, not over a few representatives:
 *
 *  1. the CLI's JSON escaper (`escapeJsonHazards`) escapes exactly the old set and stays LOSSLESS (JSON.parse gives the text back);
 *     its bytes are the bytes the pre-refactoring renderer wrote;
 *  2. the MCP escaper (`visibleEscapes`) escapes exactly the CLI set plus U+061C, U+200E and U+200F, and nothing else;
 *  3. the other two copies of the CLI escaper that still live in src/cli (report-error.ts, warnings.ts) agree with the shared one,
 *     so the CLI really does write one set of bytes until they are replaced by the import (contract request).
 *
 * Every hazardous character is built from a code point: this file contains none typed in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorJson } from '../../src/cli/report-error.js';
import { withEnvelopeWarnings } from '../../src/cli/warnings.js';
import { GcrError } from '../../src/errors.js';
import { escapeJsonHazards, visibleEscapes } from '../../src/format/scrub.js';

/** [first, last] inclusive code point ranges. */
const CLI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xe0000, 0xe007f],
];
const MCP_EXTRA: ReadonlyArray<readonly [number, number]> = [
  [0x61c, 0x61c],
  [0x200e, 0x200f],
];
const inRanges = (cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean => ranges.some(([a, b]) => cp >= a && cp <= b);

/**
 * A raw (unescaped) character of the CLI set, built from code points: a regex LITERAL holding U+2028 / U+2029 escapes is re-printed by
 * TypeScript 7 with the raw character, which ends the line inside the literal (see src/format/scrub.ts).
 */
const RAW_CLI_HAZARD = new RegExp(
  `[${CLI_RANGES.filter(([a]) => a < 0xe0000)
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join('')}]`,
);

function unitEscapes(text: string): string {
  return Array.from({ length: text.length }, (_, i) => `\\u${text.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');
}

/** Every scalar value (surrogates excluded: tested separately). */
function* scalars(): Generator<number> {
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    yield cp;
  }
}

describe('escapeJsonHazards: the CLI set, lossless', () => {
  it('escapes exactly DEL, C1, U+2028/2029, the bidi embeddings/overrides/isolates and the TAG block, for every code point', () => {
    const wrong: string[] = [];
    for (const cp of scalars()) {
      const text = `a${String.fromCodePoint(cp)}b`;
      const json = JSON.stringify(text);
      const escaped = escapeJsonHazards(json);
      const expected = inRanges(cp, CLI_RANGES) ? JSON.stringify('a' + unitEscapes(String.fromCodePoint(cp)) + 'b').replace(/\\\\/g, '\\') : json;
      if (escaped !== expected) wrong.push(cp.toString(16));
      if (JSON.parse(escaped) !== text) wrong.push(`lossy ${cp.toString(16)}`);
      if (wrong.length > 10) break;
    }
    assert.deepEqual(wrong, []);
  });

  it('does not touch the three directional marks the CLI bytes never escaped (pinned output)', () => {
    for (const cp of [0x61c, 0x200e, 0x200f]) {
      const json = JSON.stringify(`x${String.fromCodePoint(cp)}y`);
      assert.equal(escapeJsonHazards(json), json);
    }
  });

  it('lone surrogates and surrogate neighbours of a TAG character behave like the old regex', () => {
    const high = String.fromCharCode(0xdb40);
    const tagLow = String.fromCharCode(0xdc41);
    const cases: ReadonlyArray<readonly [string, string]> = [
      [high, high], // a lone high surrogate: JSON.stringify already wrote it as an escape
      [`${high}${high}${tagLow}`, `${high}${unitEscapes(high + tagLow)}`],
      [String.fromCharCode(0xd83d) + high + tagLow, String.fromCharCode(0xd83d) + unitEscapes(high + tagLow)],
      [`${tagLow}${high}`, `${tagLow}${high}`],
    ];
    for (const [text] of cases) {
      const json = JSON.stringify(text);
      assert.equal(JSON.parse(escapeJsonHazards(json)), text, 'lossless');
      assert.equal(RAW_CLI_HAZARD.test(escapeJsonHazards(json)), false);
    }
  });
});

describe('visibleEscapes: the MCP set', () => {
  it('escapes exactly the CLI set plus U+061C, U+200E and U+200F, for every code point, as the literal escape text', () => {
    const wrong: string[] = [];
    for (const cp of scalars()) {
      const ch = String.fromCodePoint(cp);
      const hazardous = inRanges(cp, CLI_RANGES) || inRanges(cp, MCP_EXTRA);
      const expected = hazardous ? `a${unitEscapes(ch)}b` : `a${ch}b`;
      if (visibleEscapes(`a${ch}b`) !== expected) wrong.push(cp.toString(16));
      if (wrong.length > 10) break;
    }
    assert.deepEqual(wrong, []);
  });

  it('leaves every other character alone, including the invisible ones the lead did not list (documented non-goals)', () => {
    for (const cp of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0xa0, 0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0x206a, 0xfeff, 0xfe0f, 0xe0100, 0x1f600, 0x65e5]) {
      const ch = String.fromCodePoint(cp);
      assert.equal(visibleEscapes(`a${ch}b`), `a${ch}b`, cp.toString(16));
    }
  });

  it('the neighbours of every range edge are untouched (no off-by-one)', () => {
    for (const [a, b] of [...CLI_RANGES, ...MCP_EXTRA]) {
      for (const cp of [a - 1, b + 1]) {
        if (inRanges(cp, CLI_RANGES) || inRanges(cp, MCP_EXTRA)) continue;
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const ch = String.fromCodePoint(cp);
        assert.equal(visibleEscapes(ch), ch, `U+${cp.toString(16)}`);
      }
    }
  });

  it('is stateless: the same input gives the same output on every call, whatever was escaped before (no regex lastIndex leak)', () => {
    const dirty = `x${String.fromCodePoint(0x202e)}y${String.fromCodePoint(0xe0041)}z`;
    const clean = 'plain text';
    const first = visibleEscapes(dirty);
    for (let i = 0; i < 20; i++) {
      assert.equal(visibleEscapes(dirty), first);
      assert.equal(visibleEscapes(clean), clean);
      assert.equal(escapeJsonHazards(JSON.stringify(dirty)), escapeJsonHazards(JSON.stringify(dirty)));
    }
  });

  it('is linear: a long string of hazards is escaped quickly and completely', () => {
    const n = 200_000;
    const text = String.fromCodePoint(0xe0041).repeat(n);
    const started = Date.now();
    const out = visibleEscapes(text);
    assert.equal(out.length, n * 12);
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  });
});

describe('the two remaining CLI copies agree with the shared escaper (one set of output bytes)', () => {
  const sample: number[] = [];
  for (const [a, b] of CLI_RANGES) for (let cp = a - 1; cp <= b + 1; cp++) if (cp < 0xd800 || cp > 0xdfff) sample.push(cp);
  for (const [a, b] of MCP_EXTRA) for (let cp = a - 1; cp <= b + 1; cp++) sample.push(cp);
  sample.push(0x65e5, 0x1f600, 0x1b, 0x09);

  it('errorJson (report-error.ts)', () => {
    for (const cp of sample) {
      const ch = String.fromCodePoint(cp);
      const err = new GcrError('INVALID_ARGUMENT', `m${ch}m`, { remedy: `r${ch}r`, details: { k: `d${ch}d` } });
      const printed = errorJson(err, err, false);
      assert.equal(printed, `${escapeJsonHazards(JSON.stringify(err.toEnvelope()))}\n`, `U+${cp.toString(16)}`);
    }
  });

  it('withEnvelopeWarnings (warnings.ts), json and jsonl', () => {
    for (const cp of sample) {
      const ch = String.fromCodePoint(cp);
      const warning = { code: 'W', message: `w${ch}w`, ids: [`i${ch}i`] };
      const doc = { ok: true, data: {}, warnings: [] as unknown[] };
      const expectedDoc = { ...doc, warnings: [warning] };
      assert.equal(withEnvelopeWarnings(JSON.stringify(doc), 'json', [warning]), `${escapeJsonHazards(JSON.stringify(expectedDoc, null, 2))}\n`, `json U+${cp.toString(16)}`);
      const footer = { type: 'footer', warnings: [] as unknown[] };
      const printed = withEnvelopeWarnings(`${JSON.stringify({ type: 'header' })}\n${JSON.stringify(footer)}\n`, 'jsonl', [warning]);
      const expectedLast = escapeJsonHazards(JSON.stringify({ ...footer, warnings: [warning] }));
      assert.equal(printed, `${JSON.stringify({ type: 'header' })}\n${expectedLast}\n`, `jsonl U+${cp.toString(16)}`);
    }
  });
});
