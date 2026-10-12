/**
 * FR-01 tests: UUID parsing and the exact-link contract for https://chatgpt.com/c/<uuid>.
 * Every rejection class asserts the exact GcrError code (and, where useful, the machine-readable reason).
 * All data is synthetic; nothing here touches the network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';
import { MAX_URL_LENGTH, isUuid, normalizeUuid, parseChatGptUrl, parseConversationRef } from '../../src/domain/ids.js';

const U = '6ac95b6e-9fa0-83e8-bbb0-8107079a8720'; // the SPEC reference id (identifier only)
const U_UP = U.toUpperCase();
const BASE = `https://chatgpt.com/c/${U}`;
const SEED = 20261010;

function expectCode(fn: () => unknown, code: ErrorCode, reason?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${String(e)}`);
    assert.equal(e.code, code, `code (reason=${String(e.details?.['reason'])})`);
    if (reason !== undefined) assert.equal(e.details?.['reason'], reason);
    return true;
  });
}

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 300): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

describe('isUuid / normalizeUuid', () => {
  it('accepts canonical UUIDs of any case and the nil UUID (shape only, not RFC version)', () => {
    assert.equal(isUuid(U), true);
    assert.equal(isUuid(U_UP), true);
    assert.equal(isUuid('00000000-0000-0000-0000-000000000000'), true);
    assert.equal(isUuid('AbCdEf01-2345-6789-aBcD-eF0123456789'), true);
  });

  it('rejects wrong length, separators, non-hex, whitespace, wrappers and non-strings', () => {
    const bad: unknown[] = [
      '',
      U.slice(1),
      `${U}0`,
      U.replaceAll('-', ''),
      `{${U}}`,
      `urn:uuid:${U}`,
      ` ${U}`,
      `${U}\n`,
      U.replace('6', 'g'),
      U.replace('-', '_'),
      '6ac95b6e9-fa0-83e8-bbb0-8107079a8720',
      '٦ac95b6e-9fa0-83e8-bbb0-8107079a8720', // Arabic-Indic digit
      'ſac95b6e-9fa0-83e8-bbb0-8107079a8720', // U+017F must not case-fold onto "s"/hex
      undefined,
      null,
      123,
      {},
      [U],
      Symbol('x'),
    ];
    for (const b of bad) assert.equal(isUuid(b), false, `isUuid(${String(typeof b === 'symbol' ? 'symbol' : b)})`);
  });

  it('normalizeUuid lower-cases and returns exactly the input otherwise', () => {
    assert.equal(normalizeUuid(U_UP), U);
    assert.equal(normalizeUuid(U), U);
  });

  it('normalizeUuid throws INVALID_UUID for everything that is not exactly a UUID (no trimming, any type)', () => {
    for (const b of ['', ' ' + U, U + ' ', 'not-a-uuid', `${U}x`, 42 as unknown as string, undefined as unknown as string, null as unknown as string]) {
      expectCode(() => normalizeUuid(b), 'INVALID_UUID');
    }
  });
});

describe('parseChatGptUrl: accepted forms', () => {
  const longQuery = (n: number): string => '?q=' + 'a'.repeat(n - 3);
  const accepted: Array<[string, string]> = [
    ['plain link', BASE],
    ['upper-case uuid', `https://chatgpt.com/c/${U_UP}`],
    ['mixed-case uuid', `https://chatgpt.com/c/6AC95b6e-9FA0-83e8-BBB0-8107079a8720`],
    ['upper-case host', `https://CHATGPT.COM/c/${U}`],
    ['mixed-case host', `https://ChatGPT.Com/c/${U}`],
    ['upper-case scheme', `HTTPS://chatgpt.com/c/${U}`],
    ['one trailing slash', `${BASE}/`],
    ['query string', `${BASE}?model=gpt-x`],
    ['fragment', `${BASE}#top`],
    ['trailing slash + query + fragment', `${BASE}/?a=1#b`],
    ['empty query', `${BASE}?`],
    ['empty fragment', `${BASE}#`],
    ['surrounding spaces', `   ${BASE}  `],
    ['surrounding tab/newline/CR/FF', `\t\n${BASE}\r\f`],
    ['non-ASCII in the ignored query', `${BASE}?q=café`],
    ['spaces in the ignored query', `${BASE}?q=a b`],
    ['backslash in the ignored query', `${BASE}?q=a\\b`],
    ['userinfo-looking text in the ignored query', `${BASE}?next=@evil.com/c/${U}`],
    ['another host in the ignored fragment', `${BASE}#//evil.com/c/${U}`],
    ['percent-escapes in the ignored query', `${BASE}?x=%2e%2e%2f`],
    ['nil uuid (shape only)', 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000000'],
    ['exactly 2048 characters', BASE + longQuery(MAX_URL_LENGTH - BASE.length)],
  ];
  for (const [label, input] of accepted) {
    it(`accepts: ${label}`, () => {
      const r = parseChatGptUrl(input);
      assert.equal(r.conversationId, input.includes('00000000-0000') ? '00000000-0000-0000-0000-000000000000' : U);
      assert.equal(r.canonicalUrl, `https://chatgpt.com/c/${r.conversationId}`);
      assert.deepEqual(Object.keys(r).sort(), ['canonicalUrl', 'conversationId']);
    });
  }
  it('the 2048-character boundary case really has 2048 characters, and 2049 is rejected', () => {
    const at = BASE + longQuery(MAX_URL_LENGTH - BASE.length);
    assert.equal(at.length, 2048);
    parseChatGptUrl(at);
    expectCode(() => parseChatGptUrl(at + 'a'), 'INVALID_URL', 'too_long');
  });
});

describe('parseChatGptUrl: rejection classes with exact codes', () => {
  const rejected: Array<[string, string, ErrorCode, string?]> = [
    // --- UNSUPPORTED_URL: share links and every other path ---------------------------------------------------
    ['share link', `https://chatgpt.com/share/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['share link, odd case', `https://chatgpt.com/Share/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['project-scoped /g/.../c/', `https://chatgpt.com/g/g-p-abc123/c/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['upper-case /C/', `https://chatgpt.com/C/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['/c without the slash', 'https://chatgpt.com/c', 'UNSUPPORTED_URL', 'path'],
    ['host only', 'https://chatgpt.com', 'UNSUPPORTED_URL', 'path'],
    ['host + root path', 'https://chatgpt.com/', 'UNSUPPORTED_URL', 'path'],
    ['double leading slash', `https://chatgpt.com//c/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['extra leading segment', `https://chatgpt.com/x/c/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['query makes the path empty', `https://chatgpt.com?next=/c/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['fragment makes the path empty', `https://chatgpt.com#/c/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['other well-known page', 'https://chatgpt.com/auth/login', 'UNSUPPORTED_URL', 'path'],
    // --- UNSUPPORTED_URL: extra segments / dot segments (never normalized away) -------------------------------
    ['extra segment after uuid', `${BASE}/extra`, 'UNSUPPORTED_URL', 'extra_path_segments'],
    ['/share after uuid', `${BASE}/share`, 'UNSUPPORTED_URL', 'extra_path_segments'],
    ['two trailing slashes', `${BASE}//`, 'UNSUPPORTED_URL', 'extra_path_segments'],
    ['dot segment before uuid', `https://chatgpt.com/c/./${U}`, 'UNSUPPORTED_URL', 'extra_path_segments'],
    ['dot-dot segment that WHATWG would resolve into a valid link', `https://chatgpt.com/c/../c/${U}`, 'UNSUPPORTED_URL', 'extra_path_segments'],
    ['dot-dot that WHATWG would resolve from a share path', `https://chatgpt.com/share/../c/${U}`, 'UNSUPPORTED_URL', 'path'],
    ['dot-dot after the uuid', `${BASE}/../${U}`, 'UNSUPPORTED_URL', 'extra_path_segments'],
    // --- INVALID_URL: percent-encoding (module spec: "percent-encoded or backslash path tricks" are INVALID_URL) ---------
    ['encoded "c"', `https://chatgpt.com/%63/${U}`, 'INVALID_URL', 'percent_encoding'],
    ['encoded hex digit inside the uuid', `https://chatgpt.com/c/%36ac95b6e-9fa0-83e8-bbb0-8107079a8720`, 'INVALID_URL', 'percent_encoding'],
    ['encoded slash after uuid', `${BASE}%2Fextra`, 'INVALID_URL', 'percent_encoding'],
    ['encoded space after uuid', `${BASE}%20`, 'INVALID_URL', 'percent_encoding'],
    ['encoded dot-dot', `https://chatgpt.com/c/%2e%2e/${U}`, 'INVALID_URL', 'percent_encoding'],
    ['encoded slash between c and uuid', `https://chatgpt.com/c%2F${U}`, 'INVALID_URL', 'percent_encoding'],
    // --- UNSUPPORTED_URL: other hosts ---------------------------------------------------------------------------
    ['legacy chat.openai.com', `https://chat.openai.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['www subdomain', `https://www.chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['other subdomain', `https://foo.chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['suffix attack chatgpt.com.evil.com', `https://chatgpt.com.evil.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['prefix attack evilchatgpt.com', `https://evilchatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['other TLD', `https://chatgpt.co/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['other domain, chatgpt.com in the path', `https://evil.com/chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['trailing-dot host', `https://chatgpt.com./c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['space inside the authority', `https://chatgpt.com /c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['percent-encoded dot in host', `https://chatgpt%2ecom/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['full-width "c" (IDNA would map it to chatgpt.com)', `https://ｃhatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['Cyrillic "a" homoglyph', `https://chаtgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['soft hyphen in host (IDNA would drop it)', `https://chat­gpt.com/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['IPv4 literal', `https://127.0.0.1/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['decimal IPv4 literal', `https://2130706433/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    ['bracketed host', `https://[chatgpt.com]/c/${U}`, 'UNSUPPORTED_URL', 'host'],
    // --- UNSUPPORTED_URL: userinfo ------------------------------------------------------------------------------
    ['userinfo trick: chatgpt.com@evil.com', `https://chatgpt.com@evil.com/c/${U}`, 'UNSUPPORTED_URL', 'userinfo'],
    ['userinfo with the real host after @', `https://evil.com@chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'userinfo'],
    ['empty userinfo', `https://@chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'userinfo'],
    ['user:password@', `https://user:pw@chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'userinfo'],
    // --- UNSUPPORTED_URL: explicit ports ------------------------------------------------------------------------
    ['default port 443 spelled out', `https://chatgpt.com:443/c/${U}`, 'UNSUPPORTED_URL', 'port'],
    ['port 8080', `https://chatgpt.com:8080/c/${U}`, 'UNSUPPORTED_URL', 'port'],
    ['port 0', `https://chatgpt.com:0/c/${U}`, 'UNSUPPORTED_URL', 'port'],
    ['out-of-range port', `https://chatgpt.com:99999/c/${U}`, 'UNSUPPORTED_URL', 'port'],
    ['empty port', `https://chatgpt.com:/c/${U}`, 'UNSUPPORTED_URL', 'port'],
    ['IPv6 literal', `https://[::1]/c/${U}`, 'UNSUPPORTED_URL', 'port'],
    // --- UNSUPPORTED_URL: schemes -------------------------------------------------------------------------------
    ['http', `http://chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'scheme'],
    ['http, upper-case', `HTTP://chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'scheme'],
    ['ftp', `ftp://chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'scheme'],
    ['javascript:', 'javascript:alert(1)', 'UNSUPPORTED_URL', 'scheme'],
    ['data:', 'data:text/html,<script>1</script>', 'UNSUPPORTED_URL', 'scheme'],
    ['file:', 'file:///etc/passwd', 'UNSUPPORTED_URL', 'scheme'],
    ['wss', `wss://chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'scheme'],
    ['look-alike scheme httpss', `httpss://chatgpt.com/c/${U}`, 'UNSUPPORTED_URL', 'scheme'],
    ['host:port without a scheme parses as a scheme', `chatgpt.com:443/c/${U}`, 'UNSUPPORTED_URL', 'scheme'],
    // --- INVALID_UUID: the shape is right, the segment is not a uuid --------------------------------------------
    ['35-character id', `https://chatgpt.com/c/${U.slice(1)}`, 'INVALID_UUID', 'uuid'],
    ['37-character id', `https://chatgpt.com/c/${U}0`, 'INVALID_UUID', 'uuid'],
    ['id with a non-hex digit', `https://chatgpt.com/c/${U.replace('6', 'g')}`, 'INVALID_UUID', 'uuid'],
    ['id without dashes', `https://chatgpt.com/c/${U.replaceAll('-', '')}`, 'INVALID_UUID', 'uuid'],
    ['id with misplaced dash', 'https://chatgpt.com/c/6ac95b6e9-fa0-83e8-bbb0-8107079a8720', 'INVALID_UUID', 'uuid'],
    ['braced id', `https://chatgpt.com/c/{${U}}`, 'INVALID_UUID', 'uuid'],
    ['urn:uuid: prefix', `https://chatgpt.com/c/urn:uuid:${U}`, 'INVALID_UUID', 'uuid'],
    ['empty segment', 'https://chatgpt.com/c/', 'INVALID_UUID', 'uuid'],
    ['empty segment + trailing slash', 'https://chatgpt.com/c//', 'INVALID_UUID', 'uuid'],
    ['uuid followed by junk in the same segment', `${BASE}x`, 'INVALID_UUID', 'uuid'],
    ['uuid followed by a colon', `${BASE}:80`, 'INVALID_UUID', 'uuid'],
    ['literal "new"', 'https://chatgpt.com/c/new', 'INVALID_UUID', 'uuid'],
    ['dot-dot as the segment', 'https://chatgpt.com/c/..', 'INVALID_UUID', 'uuid'],
    ['non-ASCII digit', 'https://chatgpt.com/c/٦ac95b6e-9fa0-83e8-bbb0-8107079a8720', 'INVALID_UUID', 'uuid'],
    ['space inside the segment', `https://chatgpt.com/c/${U.slice(0, 8)} ${U.slice(9)}`, 'INVALID_UUID', 'uuid'],
    // --- INVALID_URL: not a well-formed absolute https URL --------------------------------------------------------
    ['empty string', '', 'INVALID_URL', 'empty'],
    ['whitespace only', ' \t\n ', 'INVALID_URL', 'empty'],
    ['no scheme', `chatgpt.com/c/${U}`, 'INVALID_URL', 'no_scheme'],
    ['scheme-relative', `//chatgpt.com/c/${U}`, 'INVALID_URL', 'no_scheme'],
    ['path only', `/c/${U}`, 'INVALID_URL', 'no_scheme'],
    ['bare uuid is not a URL', U, 'INVALID_URL', 'no_scheme'],
    ['leading NBSP is not trimmed', ` ${BASE}`, 'INVALID_URL', 'no_scheme'],
    ['leading BOM is not trimmed', `﻿${BASE}`, 'INVALID_URL', 'no_scheme'],
    ['https: without slashes (WHATWG would repair it)', `https:chatgpt.com/c/${U}`, 'INVALID_URL', 'missing_authority_slashes'],
    ['https:/ with one slash (WHATWG would repair it)', `https:/chatgpt.com/c/${U}`, 'INVALID_URL', 'missing_authority_slashes'],
    ['https:/// (WHATWG would repair it)', `https:///chatgpt.com/c/${U}`, 'INVALID_URL', 'empty_host'],
    ['no host', 'https://', 'INVALID_URL', 'empty_host'],
    ['scheme only', 'https:', 'INVALID_URL', 'missing_authority_slashes'],
    ['no host, query only', 'https://?x', 'INVALID_URL', 'empty_host'],
    // --- INVALID_URL: backslashes ---------------------------------------------------------------------------------
    ['backslash separators (WHATWG treats \\ as /)', `https://chatgpt.com\\c\\${U}`, 'INVALID_URL', 'backslash'],
    ['backslash after scheme', `https:\\\\chatgpt.com/c/${U}`, 'INVALID_URL', 'backslash'],
    ['backslash between c and uuid', `https://chatgpt.com/c\\${U}`, 'INVALID_URL', 'backslash'],
    ['trailing backslash', `${BASE}\\`, 'INVALID_URL', 'backslash'],
    ['backslash in host', `https://evil.com\\@chatgpt.com/c/${U}`, 'INVALID_URL', 'backslash'],
    // --- INVALID_URL: control characters (WHATWG strips TAB/LF/CR anywhere!) ---------------------------------------
    ['NUL at the end', `${BASE}\u0000`, 'INVALID_URL', 'control_character'],
    ['NUL inside the uuid', `https://chatgpt.com/c/${U.slice(0, 10)}\u0000${U.slice(10)}`, 'INVALID_URL', 'control_character'],
    ['NUL in the ignored query', `${BASE}?x=\u0000`, 'INVALID_URL', 'control_character'],
    ['TAB inside the uuid', `https://chatgpt.com/c/${U.slice(0, 10)}\t${U.slice(10)}`, 'INVALID_URL', 'control_character'],
    ['LF inside the uuid', `https://chatgpt.com/c/${U.slice(0, 10)}\n${U.slice(10)}`, 'INVALID_URL', 'control_character'],
    ['CR LF header-injection style', `${BASE}\r\nX-Evil: 1`, 'INVALID_URL', 'control_character'],
    ['LF inside the host', 'https://chatgpt\n.com/c/' + U, 'INVALID_URL', 'control_character'],
    ['vertical tab (not ASCII whitespace for trimming)', `${BASE}\u000b`, 'INVALID_URL', 'control_character'],
    ['form feed inside', `https://chatgpt.com/c/${U.slice(0, 10)}\f${U.slice(10)}`, 'INVALID_URL', 'control_character'],
    ['DEL', `${BASE}\u007f`, 'INVALID_URL', 'control_character'],
    ['C1 control NEL', `${BASE}?x=\u0085`, 'INVALID_URL', 'control_character'],
    ['ESC', `\u001b[31m${BASE}`, 'INVALID_URL', 'control_character'],
    // --- INVALID_URL: length -------------------------------------------------------------------------------------
    ['2049 characters', BASE + '?q=' + 'a'.repeat(MAX_URL_LENGTH - BASE.length - 3 + 1), 'INVALID_URL', 'too_long'],
    ['huge input', 'https://chatgpt.com/c/' + 'a'.repeat(1_000_000), 'INVALID_URL', 'too_long'],
    ['padding that exceeds the limit even though trimming would shrink it', ' '.repeat(MAX_URL_LENGTH) + BASE, 'INVALID_URL', 'too_long'],
  ];

  for (const [label, input, code, reason] of rejected) {
    it(`rejects ${code}${reason === undefined ? '' : `/${reason}`}: ${label}`, () => {
      expectCode(() => parseChatGptUrl(input), code, reason);
    });
  }

  it('has at least 40 distinct rejection cases (plus the accepted cases above)', () => {
    assert.ok(rejected.length >= 40, `only ${rejected.length}`);
    assert.equal(new Set(rejected.map((r) => r[1])).size, rejected.length, 'rejection inputs must be distinct');
  });

  it('non-string input is INVALID_ARGUMENT (caller bug), never a crash', () => {
    const values: unknown[] = [undefined, null, 0, 123, true, {}, [], [BASE], () => BASE, Symbol('u'), 10n, new String(BASE), new URL(BASE)];
    for (const v of values) expectCode(() => parseChatGptUrl(v as string), 'INVALID_ARGUMENT', 'not_a_string');
  });
});

describe('parseChatGptUrl: hygiene and safety', () => {
  const MARK = 'ZZSECRETMARKERZZ';

  it('errors never echo any part of the input (message, remedy, details, envelope)', () => {
    const hostile = [
      `https://${MARK}.com/c/${U}`,
      `https://${MARK}@chatgpt.com/c/${U}`,
      `https://chatgpt.com/${MARK}/${U}`,
      `https://chatgpt.com/c/${MARK}`,
      `https://chatgpt.com/c/${U}/${MARK}`,
      `https://chatgpt.com/c/${U}\u0000${MARK}`,
      `ftp://${MARK}`,
      `${MARK}`,
      `https://chatgpt.com:${MARK}/c/${U}`,
      `https://chatgpt.com\\${MARK}`,
    ];
    for (const h of hostile) {
      let caught: unknown;
      try {
        parseChatGptUrl(h);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof GcrError, `must reject ${h.length}-char input`);
      assert.equal(JSON.stringify(caught.toEnvelope()).includes(MARK), false, 'envelope leaked input');
      assert.equal(caught.message.includes(MARK), false);
      assert.equal(String(caught.remedy).includes(MARK), false);
    }
  });

  it('is pure: never consults the network (no fetch/http imports in the module under test)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../src/domain/ids.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from ['"](node:)?(http|https|net|tls|dns|dgram|http2)['"]/);
    assert.doesNotMatch(src, /\bfetch\s*\(/);
  });

  it('only the strict raw checks decide acceptance: WHATWG-repairable spellings of a valid link are all refused', () => {
    const repairable = [
      `https:chatgpt.com/c/${U}`,
      `https:/chatgpt.com/c/${U}`,
      `https:///chatgpt.com/c/${U}`,
      `https:\\\\chatgpt.com\\c\\${U}`,
      `https://chatgpt.com/c/\n${U}`,
      `https://chat\tgpt.com/c/${U}`,
      `https://chatgpt.com:443/c/${U}`,
      `https://ｃhatgpt.com/c/${U}`,
      `https://chatgpt.com/c/../c/${U}`,
      `https://chatgpt.com/share/../c/${U}`,
    ];
    for (const r of repairable) {
      // Prove the premise: the WHATWG parser really would turn each of these into the valid link ...
      const w = new URL(r);
      assert.equal(`${w.protocol}//${w.host}${w.pathname}`, BASE, `premise: WHATWG repairs ${JSON.stringify(r)}`);
      // ... and that parseChatGptUrl refuses all of them.
      assert.throws(() => parseChatGptUrl(r), GcrError);
    }
  });

  it('trailing slash, query and fragment never change the result', () => {
    const variants = [BASE, `${BASE}/`, `${BASE}?a=b`, `${BASE}#x`, `${BASE}/?a=b#x`, ` ${BASE} `];
    const results = variants.map((v) => parseChatGptUrl(v));
    for (const r of results) assert.deepEqual(r, results[0]);
  });
});

describe('parseConversationRef', () => {
  it('bare UUID: lower-cased, viaUrl=false, no canonicalUrl key', () => {
    const r = parseConversationRef(U_UP);
    assert.deepEqual(r, { conversationId: U, viaUrl: false });
    assert.equal('canonicalUrl' in r, false);
  });

  it('bare UUID with surrounding ASCII whitespace is trimmed', () => {
    assert.deepEqual(parseConversationRef(` \t${U}\n`), { conversationId: U, viaUrl: false });
  });

  it('a bare UUID is trimmed of exactly TAB, LF, FF, CR and SPACE (the WHATWG set), each side on its own', () => {
    for (const ws of [' ', '\t', '\n', '\f', '\r', '  ', ' \t\n\f\r']) {
      const label = JSON.stringify(ws);
      assert.deepEqual(parseConversationRef(`${ws}${U}`), { conversationId: U, viaUrl: false }, `leading ${label}`);
      assert.deepEqual(parseConversationRef(`${U}${ws}`), { conversationId: U, viaUrl: false }, `trailing ${label}`);
      assert.deepEqual(parseConversationRef(`${ws}${U_UP}${ws}`), { conversationId: U, viaUrl: false }, `both sides ${label}`);
    }
  });

  // TQ-03 (mutation survivor `normalizeUuid(input.trim())`): String.prototype.trim() removes every one of these, GCR's own
  // trim ("Nothing else is trimmed", src/domain/ids.ts) none of them. A padded bare id is not an id: INVALID_UUID / not_a_uuid.
  const NOT_ASCII_WHITESPACE: ReadonlyArray<readonly [string, string]> = [
    ['no-break space U+00A0', ' '],
    ['byte order mark U+FEFF', '﻿'],
    ['em space U+2003', ' '],
    ['ideographic space U+3000', '　'],
    ['vertical tab U+000B', '\u000b'],
    ['ogham space mark U+1680', ' '],
    ['en quad U+2000', ' '],
    ['hair space U+200A', ' '],
    ['narrow no-break space U+202F', ' '],
    ['medium mathematical space U+205F', ' '],
    ['line separator U+2028', ' '],
    ['paragraph separator U+2029', ' '],
  ];
  for (const [label, ch] of NOT_ASCII_WHITESPACE) {
    it(`a bare UUID padded with ${label} is refused, whichever side carries it (INVALID_UUID not_a_uuid)`, () => {
      // Premise: this really is a character that String.prototype.trim() would have removed.
      assert.equal(`${ch}${U}${ch}`.trim(), U, 'premise: trim() strips this character');
      for (const padded of [`${ch}${U}`, `${U}${ch}`, `${ch}${U}${ch}`, ` ${ch}${U}`, `${U}${ch} `, `\t${ch}${U_UP}\n`]) {
        expectCode(() => parseConversationRef(padded), 'INVALID_UUID', 'not_a_uuid');
      }
      // The same text with ASCII whitespace instead is accepted: the difference is exactly the padding character.
      assert.deepEqual(parseConversationRef(` ${U} `), { conversationId: U, viaUrl: false });
    });
  }

  it('the refusal of a padded bare UUID is the same through normalizeUuid and does not echo the padding', () => {
    for (const ch of [' ', '﻿', ' ']) {
      expectCode(() => normalizeUuid(`${ch}${U}`), 'INVALID_UUID', 'not_a_uuid');
      let caught: unknown;
      try {
        parseConversationRef(`${ch}${U}${ch}`);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof GcrError);
      assert.equal(JSON.stringify(caught.toEnvelope()).includes(U), false, 'the rejected text must not be echoed');
    }
  });

  it('chatgpt.com link: viaUrl=true with the canonical URL', () => {
    assert.deepEqual(parseConversationRef(`HTTPS://ChatGPT.com/c/${U_UP}/?x=1#y`), { conversationId: U, viaUrl: true, canonicalUrl: BASE });
  });

  it('anything starting with http:// or https:// must pass parseChatGptUrl (same codes)', () => {
    expectCode(() => parseConversationRef(`https://chatgpt.com/share/${U}`), 'UNSUPPORTED_URL');
    expectCode(() => parseConversationRef(`https://chat.openai.com/c/${U}`), 'UNSUPPORTED_URL');
    expectCode(() => parseConversationRef(`https://chatgpt.com@evil.com/c/${U}`), 'UNSUPPORTED_URL');
    expectCode(() => parseConversationRef(`http://chatgpt.com/c/${U}`), 'UNSUPPORTED_URL');
    expectCode(() => parseConversationRef('https://chatgpt.com/c/not-a-uuid'), 'INVALID_UUID');
    expectCode(() => parseConversationRef(`https://chatgpt.com/c/${U}\u0000`), 'INVALID_URL');
  });

  it('other URL schemes are also routed to the URL parser and refused as unsupported', () => {
    expectCode(() => parseConversationRef('ftp://chatgpt.com/c/' + U), 'UNSUPPORTED_URL');
    expectCode(() => parseConversationRef('javascript:alert(1)'), 'UNSUPPORTED_URL');
  });

  it('non-URL junk is INVALID_UUID, including scheme-less links', () => {
    for (const junk of ['', ' ', 'hello', `chatgpt.com/c/${U}`, `/c/${U}`, `${U}x`, `{${U}}`, `${U}\nextra`, `${U.slice(0, 20)}\u0000${U.slice(21)}`, 'a'.repeat(1_000_000)]) {
      expectCode(() => parseConversationRef(junk), 'INVALID_UUID');
    }
  });

  it('a huge URL-looking input is INVALID_URL (bounded work)', () => {
    expectCode(() => parseConversationRef('https://' + 'a'.repeat(1_000_000)), 'INVALID_URL', 'too_long');
  });

  it('non-strings are INVALID_ARGUMENT', () => {
    for (const v of [undefined, null, 5, {}, [U]]) expectCode(() => parseConversationRef(v as unknown as string), 'INVALID_ARGUMENT');
  });
});

describe('properties (fast-check, fixed seed)', () => {
  const hexChar = fc.constantFrom(...'0123456789abcdefABCDEF'.split(''));
  const uuidArb = fc
    .tuple(fc.array(hexChar, { minLength: 8, maxLength: 8 }), fc.array(hexChar, { minLength: 4, maxLength: 4 }), fc.array(hexChar, { minLength: 4, maxLength: 4 }), fc.array(hexChar, { minLength: 4, maxLength: 4 }), fc.array(hexChar, { minLength: 12, maxLength: 12 }))
    .map((parts) => parts.map((p) => p.join('')).join('-'));
  const wsArb = fc.stringMatching(/^[ \t\n\f\r]{0,4}$/);
  const tailArb = fc.oneof(
    fc.constant(''),
    fc.constant('/'),
    fc.string({ maxLength: 40 }).filter((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s)).map((s) => `?${s}`),
    fc.string({ maxLength: 40 }).filter((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s)).map((s) => `#${s}`),
    fc.string({ maxLength: 40 }).filter((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s)).map((s) => `/?${s}`),
  );
  const caseFlip = fc.array(fc.boolean(), { minLength: 11, maxLength: 11 });

  it('every generated valid link round-trips to its lower-cased uuid and canonical URL', () => {
    runProperty(
      fc.property(uuidArb, wsArb, wsArb, tailArb, caseFlip, (uuid, lead, trail, tail, flips) => {
        const host = 'chatgpt.com'.split('').map((c, i) => (flips[i] ? c.toUpperCase() : c)).join('');
        const input = `${lead}https://${host}/c/${uuid}${tail}${trail}`;
        const r = parseChatGptUrl(input);
        assert.equal(r.conversationId, uuid.toLowerCase());
        assert.equal(r.canonicalUrl, `https://chatgpt.com/c/${uuid.toLowerCase()}`);
        assert.deepEqual(parseConversationRef(input), { conversationId: uuid.toLowerCase(), viaUrl: true, canonicalUrl: r.canonicalUrl });
      }),
    );
  });

  // Independent oracle: ONE regular expression, structured completely differently from the staged parser.
  // Scheme and host are spelled out case-insensitively by hand: the path segment "c" must stay case-sensitive.
  const OK_URL =
    /^[hH][tT][tT][pP][sS]:\/\/[cC][hH][aA][tT][gG][pP][tT]\.[cC][oO][mM]\/c\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/?(?:[?#][\s\S]*)?$/;
  function oracle(s: string): string | null {
    if (s.length > MAX_URL_LENGTH) return null;
    const t = s.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '');
    if (/[\u0000-\u001f\u007f-\u009f]/.test(t)) return null;
    const m = OK_URL.exec(t);
    return m === null ? null : (m[1] as string).toLowerCase();
  }

  const MUTATION_CHARS = ['/', '\\', '.', '@', ':', '%', '?', '#', '\t', '\n', '\u0000', ' ', 'a', 'Z', '0', '-', 'g', 'é', 'ｃ', '­', 'x', 's'];
  const SEEDS = [BASE, `${BASE}/`, `${BASE}?x=1#y`, ` ${BASE} `, `HTTPS://CHATGPT.COM/c/${U_UP}`, `https://chatgpt.com/share/${U}`, `https://chatgpt.com@evil.com/c/${U}`];
  const opArb = fc.record({
    kind: fc.constantFrom('insert', 'delete', 'replace'),
    pos: fc.nat(400),
    ch: fc.constantFrom(...MUTATION_CHARS),
  });

  it('differential: accepts exactly the strings an independent single-regex oracle accepts (mutated near-valid inputs)', () => {
    let accepted = 0;
    let rejected = 0;
    runProperty(
      fc.property(fc.constantFrom(...SEEDS), fc.array(opArb, { maxLength: 4 }), (seedUrl, ops) => {
        let s = seedUrl;
        for (const op of ops) {
          const p = op.pos % (s.length + 1);
          if (op.kind === 'insert') s = s.slice(0, p) + op.ch + s.slice(p);
          else if (op.kind === 'delete') s = s.slice(0, p) + s.slice(p + 1);
          else s = s.slice(0, p) + op.ch + s.slice(p + 1);
        }
        const expected = oracle(s);
        let got: string | null = null;
        try {
          got = parseChatGptUrl(s).conversationId;
        } catch (e) {
          assert.ok(e instanceof GcrError, 'only GcrError may escape');
        }
        assert.equal(got, expected, `input ${JSON.stringify(s)}`);
        if (got === null) rejected++;
        else {
          accepted++;
          // Independent confirmation by the WHATWG parser for everything that was accepted.
          const w = new URL(s.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, ''));
          assert.equal(w.hostname, 'chatgpt.com');
          assert.equal(w.protocol, 'https:');
          assert.equal(w.port, '');
          assert.equal(w.username + w.password, '');
          assert.equal(w.pathname.toLowerCase().replace(/\/$/, ''), `/c/${got}`);
        }
      }),
      1500,
    );
    assert.ok(accepted > 50 && rejected > 50, `property must exercise both outcomes (accepted=${accepted}, rejected=${rejected})`);
  });

  it('never throws anything but GcrError, for arbitrary values of any type', () => {
    runProperty(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 300 }), fc.anything()), (v) => {
        for (const fn of [parseChatGptUrl, parseConversationRef, normalizeUuid]) {
          try {
            fn(v as string);
          } catch (e) {
            assert.ok(e instanceof GcrError);
          }
        }
        assert.equal(typeof isUuid(v), 'boolean');
      }),
      1000,
    );
  });

  it('normalizeUuid agrees with isUuid and is idempotent', () => {
    runProperty(
      fc.property(fc.oneof(uuidArb, fc.string({ maxLength: 40 })), (s) => {
        if (isUuid(s)) {
          assert.equal(normalizeUuid(s), s.toLowerCase());
          assert.equal(normalizeUuid(normalizeUuid(s)), normalizeUuid(s));
        } else {
          expectCode(() => normalizeUuid(s), 'INVALID_UUID');
        }
      }),
    );
  });
});
