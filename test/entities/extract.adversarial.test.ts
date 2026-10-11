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
import { ENTITY_KINDS, exceedsTextCap, extractEntities, isEntityKind, normalizeNfkc, sanitizeUrl } from '../../src/entities/extract.js';
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

describe('defects found by review: an e-mail address inside a URL path is PII too', () => {
  // E-mail addresses are blanked from the text before keyword extraction, but a path such as
  // /unsubscribe/jane.doe@example.org was stored verbatim as part of the URL entity (value, normalized and node label).
  const urls = (text: string): string[] => ofKind(extractEntities({ text }), 'url');

  it('the path is cut before the segment that holds the address, and nothing after it is kept', () => {
    assert.deepEqual(urls('https://x.example.com/unsubscribe/jane.doe@example.org'), ['x.example.com/unsubscribe/']);
    assert.deepEqual(urls('https://x.example.com/u/a@b.org/zqxtoken/more?k=1'), ['x.example.com/u/']);
    assert.deepEqual(urls('https://x.example.com/jane@example.org'), ['x.example.com/']);
    assert.deepEqual(urls('https://mastodon.example/@jane@mastodon.example/12345'), ['mastodon.example/']);
    const dump = dumpOf('see https://x.example.com/u/jane.doe@example.org/zqxtoken now');
    for (const part of ['jane', 'doe', 'example.org', 'zqxtoken', '@']) assert.equal(dump.includes(part), false, part);
  });

  it('the sanitised value (what graph nodes show) has the same cut', () => {
    const e = extractEntities({ text: 'https://x.example.com/unsubscribe/jane.doe@example.org' }).find((x) => x.kind === 'url');
    assert.equal(e?.value, 'https://x.example.com/unsubscribe/');
    assert.deepEqual(sanitizeUrl('https://x.example.com/unsubscribe/jane.doe@example.org'), { value: 'https://x.example.com/unsubscribe/', normalized: 'x.example.com/unsubscribe/' });
  });

  it('look-alikes that are not addresses keep their path: version pins, scoped packages, handles, bare @', () => {
    for (const url of [
      'https://cdn.example.net/npm/lodash@4.17.21/lodash.min.js',
      'https://unpkg.example/react@18.3.1/umd/react.js',
      'https://cdn.example.net/npm/pkg@latest/x.js',
      'https://registry.example/@scope/pkg/-/pkg-1.0.0.tgz',
      'https://medium.example/@writer/post-123',
      'https://git.example/org/repo/blob/main/a@b',
    ]) {
      assert.deepEqual(urls(url), [url.replace(/^https:\/\//, '')], url);
    }
  });
});

describe('http(s) URLs nested in URL-shaped text of another scheme', () => {
  it('are still extracted (sanitised), while the outer secrets and the nested secrets stay out of every entity', () => {
    const text = 'ftp://mirror.example/p?u=http://nested.example/q?sig=zqxnested#zqxfrag end';
    const e = extractEntities({ text });
    assert.deepEqual(ofKind(e, 'url'), ['nested.example/q']);
    assert.equal(JSON.stringify(e).includes('zqx'), false);
  });

  it('a glued scheme followed by a comma-joined http URL still yields that URL', () => {
    const e = extractEntities({ text: 'xhttp://first.example/a,http://second.example/b?t=zqxone' });
    assert.deepEqual(ofKind(e, 'url'), ['second.example/b']);
    assert.equal(JSON.stringify(e).includes('zqx'), false);
  });

  it('many nested separators inside one run stay linear', () => {
    const text = 'a://' + 'b://'.repeat(250_000);
    const t0 = process.cpuUsage();
    extractEntities({ text }, { maxTextChars: 2 << 20 });
    const used = process.cpuUsage(t0);
    assert.ok((used.user + used.system) / 1000 < 1000);
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

describe('defects found by review: every extracted string is well-formed UTF-16', () => {
  // attachments_json stores names as JSON, where a lone surrogate survives as the escape "\ud800" and comes back as a
  // lone surrogate when the graph is built. SQLite stores such a string as U+FFFD, so two names that differ only in their
  // lone surrogates were distinct entities in memory but ONE row in the database: the build died with a UNIQUE violation.
  const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const attachment = (name: string) => ({ id: null, name, mimeType: null, sizeBytes: null, assetPointer: null, presentInExportAs: null });

  it('file names with lone surrogates are repaired, and names that differ only in them are ONE entity', () => {
    const e = extractEntities({ text: '', attachments: [attachment('f\ud800'), attachment('f\ud801'), attachment('a\udc00b'), attachment('\ud800')] });
    for (const x of e) assert.equal(LONE.test(x.value + x.normalized), false, JSON.stringify(x));
    const names = e.filter((x) => x.kind === 'file_name');
    assert.deepEqual(names.map((x) => [x.normalized, x.count]), [['f\u{FFFD}', 2], ['\u{FFFD}', 1], ['a\u{FFFD}b', 1]].sort((a, b) => (b[1] as number) - (a[1] as number) || ((a[0] as string) < (b[0] as string) ? -1 : 1)));
  });

  it('cutting an over-long file name never splits a surrogate pair', () => {
    for (const prefix of ['', 'x']) {
      const e = extractEntities({ text: '', attachments: [attachment(prefix + '\u{1F600}'.repeat(400))] });
      const name = e.find((x) => x.kind === 'file_name');
      assert.ok(name !== undefined);
      assert.ok(name.value.length <= 255);
      assert.equal(LONE.test(name.value), false, `prefix ${JSON.stringify(prefix)}`);
    }
  });

  it('URL paths and text with lone surrogates never produce a malformed entity', () => {
    const e = extractEntities({ text: 'see http://a.example/p\ud800 and http://a.example/p\ud801 and \udc00 words\ud800here' });
    for (const x of e) assert.equal(LONE.test(x.value + x.normalized), false, JSON.stringify(x));
    assert.deepEqual(e.filter((x) => x.kind === 'url').map((x) => [x.normalized, x.count]), [['a.example/p\u{FFFD}', 2]]);
  });

  it('normalizeNfkc replaces lone surrogates with U+FFFD and leaves valid pairs alone', () => {
    assert.equal(normalizeNfkc('a\ud800b'), 'a\u{FFFD}b');
    assert.equal(normalizeNfkc('\udc00'), '\u{FFFD}');
    assert.equal(normalizeNfkc('\ud800\ud800'), '\u{FFFD}\u{FFFD}');
    assert.equal(normalizeNfkc('\u{1F600}\ud800'), '\u{1F600}\u{FFFD}');
    assert.equal(normalizeNfkc('x\u{1F600}y'), 'x\u{1F600}y');
  });
});

describe('negative tests for every exported function', () => {
  it('exceedsTextCap is true exactly when the extractor would not look at the whole text', () => {
    assert.equal(exceedsTextCap('', 10), false);
    assert.equal(exceedsTextCap('a'.repeat(10), 10), false);
    assert.equal(exceedsTextCap('a'.repeat(11), 10), true);
    assert.equal(exceedsTextCap('\u{E9}'.repeat(10), 10), false, 'accents do not expand');
    assert.equal(exceedsTextCap('\u{E9}'.repeat(11), 10), true);
    assert.equal(exceedsTextCap('\u{FDFA}', 17), true, 'one U+FDFA becomes 18 units');
    assert.equal(exceedsTextCap('\u{FDFA}', 18), false);
    assert.equal(exceedsTextCap('\u{FDFA}'.repeat(3), 53), true);
    assert.equal(exceedsTextCap('\u{FDFA}'.repeat(3), 54), false);
    assert.equal(exceedsTextCap('x'.repeat(1000) + '\u{FDFA}', 1000), true);
  });

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
