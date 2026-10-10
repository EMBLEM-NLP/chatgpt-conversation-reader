/**
 * Adversarial-review tests for src/domain/ids.ts (FR-01): URL-parsing confusion attacks and error-code conformance.
 * Tests marked "SPEC" encode a requirement of the module specification that the first implementation violated;
 * the rest pin behaviour the review confirmed as correct. Synthetic data only; nothing touches the network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';
import { isUuid, normalizeUuid, parseChatGptUrl, parseConversationRef } from '../../src/domain/ids.js';
import { isIso8601Utc } from '../../src/domain/validate.js';

const U = '6ac95b6e-9fa0-83e8-bbb0-8107079a8720';
const BASE = `https://chatgpt.com/c/${U}`;
const SEED = 20261014;

function expectCode(fn: () => unknown, code: ErrorCode, reason?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    assert.equal(e.code, code, `code (reason=${String(e.details?.['reason'])})`);
    if (reason !== undefined) assert.equal(e.details?.['reason'], reason);
    return true;
  });
}

describe('SPEC: percent-encoded path tricks are INVALID_URL (module spec groups them with backslash/control/NUL/over-length)', () => {
  const cases: Array<[string, string]> = [
    ['encoded "c"', `https://chatgpt.com/%63/${U}`],
    ['encoded "C" (upper-case hex)', `https://chatgpt.com/%43/${U}`],
    ['encoded hex digit inside the uuid', `https://chatgpt.com/c/%36ac95b6e-9fa0-83e8-bbb0-8107079a8720`],
    ['encoded slash after the uuid', `${BASE}%2Fextra`],
    ['encoded lower-case slash after the uuid', `${BASE}%2fextra`],
    ['encoded space after the uuid', `${BASE}%20`],
    ['encoded newline after the uuid', `${BASE}%0a`],
    ['encoded NUL after the uuid', `${BASE}%00`],
    ['encoded dot-dot', `https://chatgpt.com/c/%2e%2e/${U}`],
    ['upper-case encoded dot-dot', `https://chatgpt.com/c/%2E%2E/${U}`],
    ['encoded slash between c and uuid', `https://chatgpt.com/c%2F${U}`],
    ['double-encoded percent', `https://chatgpt.com/c/%2536ac95b6e-9fa0-83e8-bbb0-8107079a8720`],
    ['lone percent sign', `${BASE}%`],
    ['encoded backslash', `${BASE}%5Cx`],
  ];
  for (const [label, input] of cases) {
    it(`parseChatGptUrl: ${label}`, () => {
      expectCode(() => parseChatGptUrl(input), 'INVALID_URL', 'percent_encoding');
    });
    it(`parseConversationRef: ${label}`, () => {
      expectCode(() => parseConversationRef(input), 'INVALID_URL', 'percent_encoding');
    });
  }

  it('a percent sign in the IGNORED query or fragment is still fine', () => {
    for (const ok of [`${BASE}?x=%2e%2e%2f`, `${BASE}#%63`, `${BASE}/?%`]) assert.equal(parseChatGptUrl(ok).conversationId, U);
  });

  it('percent-encoding in the HOST is a host problem (UNSUPPORTED_URL), reported before the path is looked at', () => {
    expectCode(() => parseChatGptUrl(`https://chatgpt%2ecom/c/${U}`), 'UNSUPPORTED_URL', 'host');
    expectCode(() => parseChatGptUrl(`https://evil.com/c/%36${U.slice(1)}`), 'UNSUPPORTED_URL', 'host');
  });
});

describe('type predicates do not corrupt the false branch for string arguments (compile-time + runtime)', () => {
  it('isUuid(string) leaves the argument a string in the else branch', () => {
    const inputs: string[] = ['not-a-uuid', U, `${U}x`];
    let rejected = 0;
    for (const s of inputs) {
      if (isUuid(s)) {
        assert.equal(s.length, 36);
      } else {
        // With `s is string` as the only signature TypeScript narrows `s` to `never` here and this line stops compiling.
        const n: number = s.length;
        assert.ok(n >= 0);
        rejected++;
      }
    }
    assert.equal(rejected, 2);
  });

  it('isIso8601Utc(string) leaves the argument a string in the else branch', () => {
    const inputs: string[] = ['nope', '2025-01-01T00:00:00Z'];
    let rejected = 0;
    for (const s of inputs) {
      if (isIso8601Utc(s)) {
        assert.equal(s.endsWith('Z'), true);
      } else {
        const n: number = s.length;
        assert.ok(n >= 0);
        rejected++;
      }
    }
    assert.equal(rejected, 1);
  });

  it('still narrows unknown input to string on success', () => {
    const v: unknown = U;
    if (isUuid(v)) assert.equal(v.toLowerCase(), U);
    else assert.fail('should be a uuid');
    const t: unknown = '2025-01-01T00:00:00Z';
    if (isIso8601Utc(t)) assert.equal(t.length, 20);
    else assert.fail('should be an ISO timestamp');
  });
});

describe('regression: parser-differential and look-alike attacks the review tried', () => {
  const rejected: Array<[string, string, ErrorCode]> = [
    ['punycode look-alike host', `https://xn--chatgpt-9ya.com/c/${U}`, 'UNSUPPORTED_URL'],
    ['IDNA ideographic full stop in host', `https://chatgpt。com/c/${U}`, 'UNSUPPORTED_URL'],
    ['IDNA full-width full stop in host', `https://chatgpt．com/c/${U}`, 'UNSUPPORTED_URL'],
    ['fullwidth solidus as path separator', `https://chatgpt.com／c／${U}`, 'UNSUPPORTED_URL'],
    ['host followed by a question mark then an at-sign host', `https://evil.com?@chatgpt.com/c/${U}`, 'UNSUPPORTED_URL'],
    ['host followed by a fragment then an at-sign host', `https://evil.com#@chatgpt.com/c/${U}`, 'UNSUPPORTED_URL'],
    ['credentials with colon only', `https://:@chatgpt.com/c/${U}`, 'UNSUPPORTED_URL'],
    ['trailing dot and port', `https://chatgpt.com.:443/c/${U}`, 'UNSUPPORTED_URL'],
    ['uuid followed by a semicolon parameter', `${BASE};jsessionid=1`, 'INVALID_UUID'],
    ['uuid followed by a dot', `${BASE}.`, 'INVALID_UUID'],
    ['uuid followed by a dot segment', `${BASE}/.`, 'UNSUPPORTED_URL'],
    ['uuid followed by slash dot slash', `${BASE}/./`, 'UNSUPPORTED_URL'],
    ['uuid with trailing U+00A0', `${BASE} `, 'INVALID_UUID'],
    ['uuid with trailing U+3000', `${BASE}　`, 'INVALID_UUID'],
    ['uuid with trailing U+2028', `${BASE} `, 'INVALID_UUID'],
    ['uuid with trailing zero-width space', `${BASE}​`, 'INVALID_UUID'],
    ['uuid with a bidi override', `${BASE}‮`, 'INVALID_UUID'],
    ['two schemes', `https://https://chatgpt.com/c/${U}`, 'UNSUPPORTED_URL'],
    ['scheme with leading garbage', `x https://chatgpt.com/c/${U}`, 'INVALID_URL'],
    ['uppercase path prefix', `https://chatgpt.com/C/${U}`, 'UNSUPPORTED_URL'],
    ['blob: wrapper', `blob:https://chatgpt.com/${U}`, 'UNSUPPORTED_URL'],
    ['view-source wrapper', `view-source:https://chatgpt.com/c/${U}`, 'UNSUPPORTED_URL'],
    ['surrogate-pair junk instead of uuid', 'https://chatgpt.com/c/\u{1F600}', 'INVALID_UUID'],
    ['lone high surrogate in the path', 'https://chatgpt.com/c/\ud800', 'INVALID_UUID'],
  ];
  for (const [label, input, code] of rejected) {
    it(`parseChatGptUrl rejects ${code}: ${label}`, () => {
      expectCode(() => parseChatGptUrl(input), code);
    });
  }

  it('exactly one trailing slash is the only accepted suffix (with or without query/fragment/whitespace)', () => {
    for (const ok of [BASE, `${BASE}/`, `${BASE}/?`, `${BASE}/#`, `\t${BASE}/ `]) assert.equal(parseChatGptUrl(ok).canonicalUrl, BASE);
    for (const bad of [`${BASE}//`, `${BASE}///`, `${BASE}/ /`]) assert.throws(() => parseChatGptUrl(bad), GcrError);
  });

  it('parseConversationRef: control-character-prefixed URLs and scheme-ish junk never escape as non-GcrError', () => {
    for (const s of [`\u0000${BASE}`, `\u001b${BASE}`, ` ${BASE}`, `${U}:`, `a:`, ':', '::', `${U}\u0000`, '\ud800', `http://${'a'.repeat(5000)}`]) {
      assert.throws(() => parseConversationRef(s), GcrError);
    }
  });

  it('property: for ANY string the accepted set is exactly {optional ASCII whitespace} + canonical link (+ ignored suffix); everything else is a GcrError', () => {
    const alphabet = ['h', 't', 'p', 's', ':', '/', '/', 'c', 'chatgpt.com', '6ac95b6e-9fa0-83e8-bbb0-8107079a8720', '?', '#', '.', '@', '%', '\\', ' ', '\t', '\n', 'x', '0', 'é', '\u0000'];
    const piecesArb = fc.array(fc.constantFrom(...alphabet), { minLength: 0, maxLength: 14 }).map((a) => a.join(''));
    const strict = /^[ \t\n\f\r]*[hH][tT][tT][pP][sS]:\/\/[cC][hH][aA][tT][gG][pP][tT]\.[cC][oO][mM]\/c\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/?(?:[?#][^\u0000-\u001f\u007f-\u009f]*)?[ \t\n\f\r]*$/;
    let accepted = 0;
    try {
      fc.assert(
        fc.property(fc.oneof(piecesArb, piecesArb.map((s) => `https://chatgpt.com/c/${U}${s}`), piecesArb.map((s) => `https://${s}`)), (s) => {
          const expected = strict.exec(s);
          let got: string | null = null;
          try {
            got = parseChatGptUrl(s).conversationId;
          } catch (e) {
            assert.ok(e instanceof GcrError);
          }
          assert.equal(got, expected === null ? null : (expected[1] as string).toLowerCase(), JSON.stringify(s));
          if (got !== null) accepted++;
        }),
        { seed: SEED, numRuns: 4000 },
      );
    } catch (e) {
      throw new Error(`property failed (seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    assert.ok(accepted > 100, `property accepted only ${accepted} inputs`);
  });

  it('normalizeUuid never trims or unwraps', () => {
    for (const s of [` ${U}`, `${U} `, `{${U}}`, `urn:uuid:${U}`, `${U}\n`]) assert.throws(() => normalizeUuid(s), GcrError);
  });
});
