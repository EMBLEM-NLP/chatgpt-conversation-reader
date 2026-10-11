/**
 * Adversarial tests from an independent review of src/entities/extract.ts (privacy and bounds lens).
 *
 * Every test in "defects found by review" failed against the reviewed code before the matching fix; they are kept as
 * regression tests. The remaining groups add negative tests for every exported function and a ReDoS family for the
 * generic "scheme://" scanner introduced by the fix.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { ENTITY_KINDS, extractEntities, isEntityKind, normalizeNfkc, sanitizeUrl } from '../../src/entities/extract.js';
import type { ExtractedEntity } from '../../src/entities/extract.js';

function ofKind(entities: readonly ExtractedEntity[], kind: ExtractedEntity['kind']): string[] {
  return entities.filter((e) => e.kind === kind).map((e) => e.normalized);
}

function dumpOf(text: string): string {
  return JSON.stringify(extractEntities({ text })).toLowerCase();
}

function expectInvalidArgument(fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
}

describe('defects found by review: secrets next to URL-shaped text that is not an http(s) URL', () => {
  it('a scheme glued to preceding word characters is not a URL, but its query, fragment and userinfo never resurface as keywords', () => {
    for (const text of [
      'linkhttps://files.example.com/a?token=zqxsecretalpha end',
      'xhttp://bob:zqxsecretbeta@host.example.com/ end',
      'ahttps://host.example.com/p#zqxsecretgamma',
      'git+https://host.example.com/r.git?sig=zqxsecretdelta',
      'see.http://host.example.com/?k=zqxsecretepsilon',
      '1http://host.example.com/?k=zqxsecretzeta',
    ]) {
      assert.deepEqual(ofKind(extractEntities({ text }), 'url'), [], `not a URL: ${text}`);
      assert.equal(dumpOf(text).includes('zqx'), false, `leaked from: ${text}`);
    }
  });

  it('credentials, queries and fragments of non-http schemes (ftp, database, object-store URLs) are not stored as keywords', () => {
    for (const text of [
      'ftp://alice:zqxpassone@ftp.example.com/pub?zqxquerytwo=1',
      'postgres://admin:zqxpassthree@db.internal:5432/prod?sslmode=zqxquerytwo',
      'redis://:zqxpassfour@cache.example.com:6379/0',
      's3://bucket/key?X-Amz-Signature=zqxsigfive',
      'mongodb+srv://user:zqxpasssix@cluster0.example.net/db?retryWrites=true#zqxfragseven',
      'ssh://git@github.example.com/zqxorgx/repo.git?zqxquerynine',
    ]) {
      const e = extractEntities({ text });
      assert.deepEqual(ofKind(e, 'url'), [], `only http(s) URLs are extracted: ${text}`);
      const secretFree = JSON.stringify(e).toLowerCase().replace(/zqxorgx/g, '');
      assert.equal(secretFree.includes('zqx'), false, `leaked from: ${text}`);
    }
  });

  it('only the secret parts of such a URL are blanked: host and path words stay ordinary text', () => {
    const kw = ofKind(extractEntities({ text: 'ftp://alice:zqxpassone@mirror.example.com/archive?zqxquerytwo=1' }), 'keyword');
    assert.ok(kw.includes('mirror') && kw.includes('archive') && kw.includes('example'), kw.join(','));
  });

  it('an over-long scheme-like run is dropped whole; ordinary "word://" text without a query is left alone', () => {
    const e = extractEntities({ text: `weird://host.example.com/${'a'.repeat(3000)}?zqxsecrettoo=1 and plain://short.example.org/path` });
    const dump = JSON.stringify(e).toLowerCase();
    assert.equal(dump.includes('zqx'), false);
    assert.ok(ofKind(e, 'keyword').includes('short'));
  });

  it('http(s) URLs keep their exact behaviour next to the generic scanner', () => {
    const text = 'a https://Example.com/p?x=zqxone#zqxtwo b HTTP://User:zqxthree@Host.Example.org:8080/q c ftp://other.example.net/f?zqxfour';
    const e = extractEntities({ text });
    assert.deepEqual(ofKind(e, 'url'), ['example.com/p', 'host.example.org:8080/q']);
    assert.equal(JSON.stringify(e).includes('zqx'), false);
  });
});

describe('defects found by review: the text cap must also bound NFKC compatibility expansion', () => {
  // U+FDFA expands to 18 UTF-16 units under NFKC. The cap used to be applied before normalisation only, so a text of
  // N such characters was processed as 18 * N units whatever maxTextChars said.
  const ALLAH = '\u0627\u0644\u0644\u0647';

  it('processes at most maxTextChars units of the NORMALISED text', () => {
    const cap = 100_000;
    const e = extractEntities({ text: '\uFDFA'.repeat(50_000) }, { maxTextChars: cap, maxKeywords: 10 });
    const word = e.find((x) => x.kind === 'keyword' && x.normalized === ALLAH);
    assert.ok(word !== undefined, 'the expanded text still yields keywords');
    assert.ok(word.count <= Math.ceil(cap / 18), `count ${word.count} exceeds what ${cap} normalised units can hold`);
    assert.ok(word.count >= Math.floor(cap / 18) - 1, 'the allowed prefix is still processed');
  });

  it('the default cap bounds the worst case: 200 000 expanding characters do not become 3.6 million', () => {
    const e = extractEntities({ text: '\uFDFA'.repeat(200_000) }, { maxKeywords: 10 });
    const word = e.find((x) => x.kind === 'keyword' && x.normalized === ALLAH);
    assert.ok(word !== undefined);
    assert.ok(word.count <= Math.ceil(200_000 / 18), `count ${word.count}`);
  });

  it('text that does not expand is unaffected (ASCII, accents, fullwidth)', () => {
    const e = extractEntities({ text: 'caf\u00e9 \uFF21\uFF22\uFF23\uFF24 plain' }, { maxTextChars: 40 });
    assert.deepEqual(ofKind(e, 'keyword'), ['abcd', 'caf\u{E9}', 'plain']);
  });
});

describe('negative tests for every exported function', () => {
  it('sanitizeUrl returns null for everything that is not exactly one acceptable http(s) URL', () => {
    for (const bad of ['', '   ', 'plain text', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'http://', 'http://-x.example/', 'http://a..b/', `http://x.example/${'a'.repeat(2100)}`]) {
      assert.equal(sanitizeUrl(bad), null, bad);
    }
    for (const notAString of [undefined, null, 5, {}, ['http://a.example/']]) {
      assert.equal(sanitizeUrl(notAString as never), null);
    }
  });

  it('sanitizeUrl never returns a secret', () => {
    const u = sanitizeUrl('  https://bob:zqxpw@HOST.example.com:443/p/q?token=zqxt#zqxf  ');
    assert.deepEqual(u, { value: 'https://host.example.com/p/q', normalized: 'host.example.com/p/q' });
  });

  it('isEntityKind rejects look-alikes, prototype names and non-strings', () => {
    for (const bad of ['', 'URL', 'Url', ' url', 'url ', 'email', 'phone', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, undefined, 0, ['url'], { kind: 'url' }]) {
      assert.equal(isEntityKind(bad), false, String(bad));
    }
    for (const k of ENTITY_KINDS) assert.equal(isEntityKind(k), true);
  });

  it('normalizeNfkc does not throw on lone surrogates, NUL or huge mark runs, and never lengthens a combining run beyond 8 marks', () => {
    assert.doesNotThrow(() => normalizeNfkc('\ud800 \udc00 \u0000'));
    assert.equal(normalizeNfkc(''), '');
    const out = normalizeNfkc(`x${'\u0301'.repeat(5000)}`);
    assert.ok(out.length <= 9, `length ${out.length}`);
  });

  it('extractEntities rejects every malformed option and input with INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => extractEntities({ text: 'x' }, { maxKeywords: Number.NaN }));
    expectInvalidArgument(() => extractEntities({ text: 'x' }, { maxKeywords: Number.POSITIVE_INFINITY }));
    expectInvalidArgument(() => extractEntities({ text: 'x' }, { maxKeywords: 1001 }));
    expectInvalidArgument(() => extractEntities({ text: 'x' }, { maxPerKind: -1 }));
    expectInvalidArgument(() => extractEntities({ text: 'x' }, { maxTextChars: 16_777_217 }));
    expectInvalidArgument(() => extractEntities({ text: 'x' }, { maxTextChars: Number.NaN }));
    expectInvalidArgument(() => extractEntities({ text: 'x' }, { maxTextChars: null as never }));
    expectInvalidArgument(() => extractEntities(undefined as never));
    expectInvalidArgument(() => extractEntities([] as never));
    expectInvalidArgument(() => extractEntities('text' as never));
    expectInvalidArgument(() => extractEntities({ text: null } as never));
    expectInvalidArgument(() => extractEntities({ text: ['x'] } as never));
  });

  it('error messages never echo the offending value', () => {
    try {
      extractEntities({ text: 'x' }, { maxTextChars: 'zqx-secret-value' as never });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof GcrError);
      assert.equal(JSON.stringify(e.toEnvelope()).includes('zqx-secret-value'), false);
    }
  });

  it('hostile text shapes never throw', () => {
    for (const text of ['\ud800', '\udc00\ud800', '\u0000'.repeat(100), '\u2028\u2029', '\u202e'.repeat(50), '\ufeff', '\u{10ffff}', 'http://\ud800/', 'http://[::1', 'http://[]/', 'http://[:::]/']) {
      assert.doesNotThrow(() => extractEntities({ text }), JSON.stringify(text));
    }
  });
});

describe('ReDoS bounds of the generic scheme scanner', () => {
  const MIB = 1 << 20;
  const LIMIT_MS = 1000;
  const rep = (unit: string, chars: number): string => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

  /** CPU time of this process, not wall-clock time: other processes competing for the machine must not fail the test. */
  function cpuMs(fn: () => void): number {
    const before = process.cpuUsage();
    fn();
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  }

  // [name, text, cap for the "full input" variant]. NFKC-expanding text is processed up to the cap AFTER normalisation,
  // so its full-input cap is the input size (1 MiB of normalised text, the same work as every other shape).
  const SHAPES: ReadonlyArray<readonly [string, string, number]> = [
    ['"a://" repeated', rep('a://', MIB), 2 * MIB],
    ['"://" repeated', rep('://', MIB), 2 * MIB],
    ['"a:// " repeated (every run ends at once)', rep('a:// ', MIB), 2 * MIB],
    ['"xhttp://" repeated', rep('xhttp://', MIB), 2 * MIB],
    ['"a+b.c-d://x@" repeated', rep('a+b.c-d://x@', MIB), 2 * MIB],
    ['one 1 MiB scheme run before "://"', `${'a'.repeat(MIB)}://x`, 2 * MIB],
    ['one 1 MiB scheme run of "+.-"', `${rep('+.-', MIB)}://x`, 2 * MIB],
    ['scheme then 1 MiB of "@"', `ftp://${'@'.repeat(MIB)}`, 2 * MIB],
    ['scheme then 1 MiB of "?"', `ftp://x/${'?'.repeat(MIB)}`, 2 * MIB],
    ['colon runs', rep(':', MIB), 2 * MIB],
    ['slash runs', rep('/', MIB), 2 * MIB],
    ['"a:/" repeated', rep('a:/', MIB), 2 * MIB],
    ['expanding NFKC characters (U+FDFA)', rep('\uFDFA', MIB), MIB],
    ['expanding NFKC ligatures (U+FB03)', rep('\uFB03', MIB), MIB],
  ];

  for (const [name, text, fullCap] of SHAPES) {
    it(`default cap: ${name}`, () => {
      const ms = cpuMs(() => extractEntities({ text }));
      assert.ok(ms < LIMIT_MS, `${ms.toFixed(0)} ms CPU`);
    });
    it(`full input, cap raised to ${fullCap / MIB} MiB: ${name}`, () => {
      const ms = cpuMs(() => extractEntities({ text }, { maxTextChars: fullCap }));
      assert.ok(ms < LIMIT_MS, `${ms.toFixed(0)} ms CPU`);
    });
  }

  it('work grows linearly with the number of scheme separators', () => {
    const time = (n: number): number => {
      const text = rep('ftp://u@h/p?q ', n);
      return cpuMs(() => extractEntities({ text }, { maxTextChars: 4 * MIB }));
    };
    time(50_000); // warm up
    const small = Math.max(time(100_000), 1);
    const large = time(800_000);
    assert.ok(large / small < 40, `8x the input took ${(large / small).toFixed(1)}x the CPU time`);
  });
});
