/**
 * ReDoS / algorithmic-complexity bounds for src/entities/extract.ts (NFR-05, security).
 *
 * Two layers are tested:
 *  1. With the DEFAULT cap (200 000 characters) every adversarial 1 MB input must finish far below one second.
 *  2. With the cap raised above the input size, the SAME inputs must still finish below one second at the full
 *     1 MiB. This is the real linearity check: the default cap alone would hide a quadratic scanner behind a small n.
 *
 * Inputs are the classic catastrophic-backtracking shapes ("a" * n + "!", runs of "http://", "-" and "." heavy strings,
 * repeated partial tokens) plus shapes aimed at this module's own scanners (e-mail '@' runs, hex runs for the UUID
 * pattern, repeated date prefixes, endless markdown fences, Zalgo text for NFKC).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractEntities, normalizeNfkc } from '../../src/entities/extract.js';

const MIB = 1 << 20;
const LIMIT_MS = 1000;

function rep(unit: string, chars: number): string {
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

const ADVERSARIAL: ReadonlyArray<readonly [string, string]> = [
  ['"a" * n + "!"', `${'a'.repeat(MIB)}!`],
  ['runs of "http://"', rep('http://', MIB)],
  ['runs of "https://a/"', rep('https://a/', MIB)],
  ['nested urls in queries', rep('http://a.b/x?y=http://', MIB)],
  ['all hyphens', rep('-', MIB)],
  ['all dots', rep('.', MIB)],
  ['"a-" repeated', rep('a-', MIB)],
  ['"a." repeated', rep('a.', MIB)],
  ['url with a dotted 1 MiB host', `http://${rep('a.', MIB)}`],
  ['url with a 1 MiB host and no slash', `http://${'a'.repeat(MIB)}`],
  ['url with a 1 MiB path', `http://a.com/${'a'.repeat(MIB)}`],
  ['url with a 1 MiB query', `http://a.com/?${'a=b&'.repeat(MIB / 4)}`],
  ['only "@"', rep('@', MIB)],
  ['"a@" repeated', rep('a@', MIB)],
  ['"a@a." repeated', rep('a@a.', MIB)],
  ['1 MiB local part then @', `${'a'.repeat(MIB)}@b.co`],
  ['one 1 MiB hex run', rep('abcdef01', MIB)],
  ['uuid prefixes', rep('12345678-1234-1234-1234-', MIB)],
  ['date prefixes', rep('2025-01-15T', MIB)],
  ['timestamp prefixes', rep('2025-01-15 10:30:00.', MIB)],
  ['digits', '1'.repeat(MIB)],
  ['backticks', '`'.repeat(MIB)],
  ['endless fences', rep('```a\n', MIB)],
  ['spaces then a fence', `${' '.repeat(MIB)}\`\`\``],
  ['newlines', '\n'.repeat(MIB)],
  ['spaces', ' '.repeat(MIB)],
  ['apostrophes inside words', rep("a'", MIB)],
  ['unbalanced closing brackets', `http://a.com/${')'.repeat(2000)}`],
  ['balanced brackets', `http://a.com/${'('.repeat(1000)}${')'.repeat(1000)}`],
  ['CJK', rep('日本語', MIB)],
  ['CJK mixed with latin', rep('日a', MIB)],
  ['combining marks (Zalgo)', `a${rep('\u{301}\u{316}', MIB)}`],
  ['150k distinct words', Array.from({ length: 150_000 }, (_, i) => `w${i.toString(36)}xx`).join(' ').slice(0, MIB)],
  ['mixed entity soup', rep('http://a.com/?q=1#x a@b.cc 2025-01-15 00000000-0000-4000-8000-0000000000ab ```js\n', MIB)],
];

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('extractEntities: adversarial inputs stay fast', () => {
  for (const [name, text] of ADVERSARIAL) {
    it(`default cap: ${name}`, () => {
      assert.ok(text.length >= 1000);
      const ms = timed(() => extractEntities({ text }));
      assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
    });
  }

  for (const [name, text] of ADVERSARIAL) {
    it(`full input, cap raised to 2 MiB: ${name}`, () => {
      const ms = timed(() => extractEntities({ text }, { maxTextChars: 2 * MIB }));
      assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
    });
  }
});

describe('growth is linear, not quadratic', () => {
  // Doubling the input must not (much more than) double the time. Generous factor to stay robust on noisy CI machines;
  // a quadratic scanner would show a factor of about 4 or more at these sizes.
  const shapes: ReadonlyArray<readonly [string, (n: number) => string]> = [
    ['"http://" runs', (n) => rep('http://', n)],
    ['"a@" runs', (n) => rep('a@', n)],
    ['"a-" runs', (n) => rep('a-', n)],
    ['date prefixes', (n) => rep('2025-01-15T', n)],
    ['one long hex run', (n) => rep('abcdef01', n)],
  ];
  for (const [name, make] of shapes) {
    it(name, () => {
      const small = make(MIB / 4);
      const large = make(MIB);
      extractEntities({ text: small }, { maxTextChars: 2 * MIB }); // warm-up
      const t1 = Math.max(1, timed(() => extractEntities({ text: small }, { maxTextChars: 2 * MIB })));
      const t4 = timed(() => extractEntities({ text: large }, { maxTextChars: 2 * MIB }));
      assert.ok(t4 < t1 * 12 + 50, `4x input took ${t4.toFixed(0)} ms vs ${t1.toFixed(0)} ms`);
    });
  }
});

describe('normalizeNfkc guards ICU quadratic reordering', () => {
  it('a 1 MiB run of combining marks is normalised quickly', () => {
    const ms = timed(() => normalizeNfkc(`a${rep('\u{301}\u{316}', MIB)}`));
    assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
  });

  it('many short runs of marks are untouched', () => {
    const text = rep('e\u{301}\u{316} ', 100_000);
    const ms = timed(() => normalizeNfkc(text));
    assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
  });
});
