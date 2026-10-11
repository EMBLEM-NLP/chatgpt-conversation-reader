/**
 * countDuplicateKeys (src/ingest/claude-export.ts): the raw-text scan that reports what JSON.parse hides (repeated object
 * keys). Unit cases, a property test against an oracle that knows the duplicates by construction (fast-check, fixed seed),
 * and bounds (depth, keys per object, time on large inputs). Synthetic data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { DUPLICATE_KEY_TRACK_DEPTH, DUPLICATE_KEY_TRACK_KEYS, countDuplicateKeys } from '../../src/ingest/claude-export.js';

const SEED = 20261016;

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 300): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

describe('countDuplicateKeys: unit cases', () => {
  const cases: Array<[string, string, number]> = [
    ['no keys', '[]', 0],
    ['scalars', '5', 0],
    ['a string value', '"a"', 0],
    ['distinct keys', '{"a":1,"b":2,"c":3}', 0],
    ['one repeat', '{"a":1,"a":2}', 1],
    ['three repeats of one key', '{"a":1,"a":2,"a":3,"a":4}', 3],
    ['two different repeated keys', '{"a":1,"b":1,"a":2,"b":2}', 2],
    ['same key in sibling objects', '[{"a":1},{"a":2},{"a":3}]', 0],
    ['same key in parent and child', '{"a":{"a":{"a":1}}}', 0],
    ['repeat inside a nested array of objects', '{"x":[{"k":1,"k":2},{"k":1}]}', 1],
    ['key text inside a string value', '{"a":"\\"b\\":1,\\"b\\":2","c":"{\\"d\\":1,\\"d\\":2}"}', 0],
    ['string value equal to a key', '{"a":"a","b":"a"}', 0],
    ['escaped quote inside a key', '{"a\\"b":1,"a\\"b":2}', 1],
    ['a backslash right before the closing quote of a key', '{"a\\\\":1,"a\\\\":2,"b":1}', 1],
    ['an escaped quote that is NOT a key end: a\\"b vs a', '{"a\\"b":1,"a":2}', 0],
    ['\\u escapes equal to plain letters', '{"a":1,"\\u0061":2}', 1],
    ['escaped slash and solidus', '{"a/b":1,"a\\/b":2}', 1],
    ['surrogate-pair escape equals the astral character', '{"\\ud83d\\ude00":1,"\ud83d\ude00":2}', 1],
    ['different Unicode normalization forms are different keys (JSON.parse semantics)', '{"\\u00e9":1,"e\\u0301":2}', 0],
    ['empty key repeated', '{"":1,"":2}', 1],
    ['whitespace around tokens', '{ "a" : 1 ,\n"a"\t:\r\n2 }', 1],
    ['a value that is an object does not reset the parent', '{"a":{"b":1},"a":{"b":2}}', 1],
    ['numbers, literals and nesting between keys', '{"a":[1,2,{"z":null}],"b":true,"a":false}', 1],
    ['top-level array of objects with repeats in each', '[{"p":1,"p":2},{"q":1,"q":2}]', 2],
  ];
  for (const [label, text, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      JSON.parse(text); // the case itself is valid JSON
      assert.equal(countDuplicateKeys(text), expected);
    });
  }

  it('a BOM before the document is ignored', () => {
    assert.equal(countDuplicateKeys('\ufeff{"a":1,"a":2}'), 1);
  });

  it('is total: arbitrary (even invalid) text never throws and always terminates', () => {
    runProperty(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.constantFrom('"', '\\', '{', '}', '[', ']', '{"a"', '"a\\', '{"a":1,"a"', ']]]]', '}}}}')), (text) => {
        const n = countDuplicateKeys(text);
        assert.ok(Number.isInteger(n) && n >= 0);
      }),
    );
  });
});

describe('countDuplicateKeys: bounds', () => {
  it(`compares the first ${DUPLICATE_KEY_TRACK_DEPTH} levels and ignores deeper ones (without crashing)`, () => {
    const nest = (levels: number, inner: string): string => {
      let t = inner;
      for (let i = 1; i < levels; i++) t = `{"n":${t}}`;
      return t; // the object holding `inner`'s keys sits at depth `levels`
    };
    assert.equal(countDuplicateKeys(nest(DUPLICATE_KEY_TRACK_DEPTH, '{"k":1,"k":2}')), 1, 'the deepest tracked level');
    assert.equal(countDuplicateKeys(nest(DUPLICATE_KEY_TRACK_DEPTH + 1, '{"k":1,"k":2}')), 0, 'one level too deep');
    // After leaving the untracked region the scan resumes on the right frame.
    const text = `{"a":1,"deep":${nest(DUPLICATE_KEY_TRACK_DEPTH + 5, '{"k":1,"k":2}')},"a":2}`;
    assert.equal(countDuplicateKeys(text), 1);
  });

  it('handles extreme nesting with an iterative scan (no stack overflow)', () => {
    const depth = 500_000;
    const text = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    assert.equal(countDuplicateKeys(text), 0);
    assert.equal(countDuplicateKeys(`{"a":1,"x":${text},"a":2}`), 1);
  });

  it(`remembers at most ${DUPLICATE_KEY_TRACK_KEYS} distinct keys per object: repeats of remembered keys are found, later ones are not`, () => {
    const parts: string[] = [];
    for (let i = 0; i < DUPLICATE_KEY_TRACK_KEYS + 500; i++) parts.push(`"k${i}":0`);
    const base = parts.join(',');
    assert.equal(countDuplicateKeys(`{${base},"k0":1}`), 1, 'a remembered key');
    assert.equal(countDuplicateKeys(`{${base},"k${DUPLICATE_KEY_TRACK_KEYS + 100}":1}`), 0, 'a key beyond the cap is not remembered (documented limit)');
    assert.equal(countDuplicateKeys(`{${base}}`), 0);
  });

  it('is linear: a 40 MB element and 300 000 small objects are scanned in a few seconds', { timeout: 60_000 }, () => {
    const big = `{"a":"${'x'.repeat(40 * 1024 * 1024)}","a":1}`;
    let t0 = performance.now();
    assert.equal(countDuplicateKeys(big), 1);
    assert.ok(performance.now() - t0 < 10_000, 'one huge string');

    const objects: string[] = [];
    for (let i = 0; i < 300_000; i++) objects.push('{"uuid":"u","sender":"human","text":"t","content":[{"type":"text","text":"t"}],"files":[]}');
    const many = `{"chat_messages":[${objects.join(',')}]}`;
    t0 = performance.now();
    assert.equal(countDuplicateKeys(many), 0);
    assert.ok(performance.now() - t0 < 10_000, '300 000 messages');
  });

  it('string contents full of escaped quotes and backslashes are skipped in linear time', { timeout: 60_000 }, () => {
    const hostile = `{"a":"${'\\"'.repeat(1_000_000)}","b":"${'\\\\'.repeat(1_000_000)}","a2":1,"a":2}`;
    JSON.parse(hostile);
    const t0 = performance.now();
    assert.equal(countDuplicateKeys(hostile), 1);
    assert.ok(performance.now() - t0 < 10_000);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Property: an oracle that knows the duplicates by construction
// ------------------------------------------------------------------------------------------------------------------

type Tree = { kind: 'scalar'; text: string } | { kind: 'array'; items: Tree[] } | { kind: 'object'; pairs: Array<{ key: string; spelling: number; value: Tree }> };

const KEYS = ['a', 'b', 'c', 'sender', 'text', '\u00e9', 'x"y', 'p\\q', '', '\ud83d\ude00'];

function spell(key: string, variant: number): string {
  // variant 0: plain JSON string; 1: every character as a \uXXXX escape (decodes to the same key)
  if (variant === 0) return JSON.stringify(key);
  let out = '"';
  for (let i = 0; i < key.length; i++) out += `\\u${key.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return `${out}"`;
}

function serialize(t: Tree, ws = ''): string {
  if (t.kind === 'scalar') return t.text;
  if (t.kind === 'array') return `[${ws}${t.items.map((x) => serialize(x, ws)).join(`${ws},${ws}`)}${ws}]`;
  return `{${ws}${t.pairs.map((p) => `${spell(p.key, p.spelling)}${ws}:${ws}${serialize(p.value, ws)}`).join(`${ws},${ws}`)}${ws}}`;
}

/** Duplicates in objects whose depth (root = 1) is within the tracked levels. */
function expectedDuplicates(t: Tree, depth = 1): number {
  if (t.kind === 'scalar') return 0;
  if (t.kind === 'array') return depth > DUPLICATE_KEY_TRACK_DEPTH ? 0 : t.items.reduce((n, x) => n + expectedDuplicates(x, depth + 1), 0);
  if (depth > DUPLICATE_KEY_TRACK_DEPTH) return 0;
  const distinct = new Set(t.pairs.map((p) => p.key)).size;
  return t.pairs.length - distinct + t.pairs.reduce((n, p) => n + expectedDuplicates(p.value, depth + 1), 0);
}

const scalar: fc.Arbitrary<Tree> = fc
  .oneof(
    fc.constantFrom('1', '-0.5e3', 'true', 'false', 'null', '""', '"a"', '"\\"a\\":1,\\"a\\":2"', '"{\\"k\\":1,\\"k\\":2}"', '"\\\\"', '"\\\\\\\\"'),
    fc.string().map((s) => JSON.stringify(s)),
  )
  .map((text) => ({ kind: 'scalar', text }) as Tree);

const tree: fc.Arbitrary<Tree> = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small', maxDepth: 15 },
    scalar,
    fc.array(tie('tree'), { maxLength: 4 }).map((items) => ({ kind: 'array', items }) as Tree),
    fc
      .array(fc.record({ key: fc.constantFrom(...KEYS), spelling: fc.constantFrom(0, 1), value: tie('tree') }), { maxLength: 6 })
      .map((pairs) => ({ kind: 'object', pairs }) as Tree),
  ),
})).tree;

describe('countDuplicateKeys: property against a construction oracle', () => {
  it('equals the number of repeated keys in the tracked levels, for random documents with repeated and re-spelled keys', () => {
    runProperty(
      fc.property(tree, (t) => {
        const text = serialize(t);
        JSON.parse(text);
        assert.equal(countDuplicateKeys(text), expectedDuplicates(t));
      }),
      1500,
    );
  });

  it('is deterministic and unaffected by whitespace between tokens', () => {
    runProperty(
      fc.property(tree, fc.constantFrom(' ', '\n', '\t\r ', '  \n  '), (t, ws) => {
        const compact = serialize(t);
        const spaced = serialize(t, ws);
        assert.deepEqual(JSON.parse(spaced), JSON.parse(compact));
        assert.equal(countDuplicateKeys(spaced), countDuplicateKeys(compact));
        assert.equal(countDuplicateKeys(compact), countDuplicateKeys(compact));
      }),
      300,
    );
  });
});
