/**
 * Second adversarial pass over src/domain/ids.ts (FR-01). Lens: untrusted input must be bounded before ANY work is done on it,
 * and acceptance must be SOUND with respect to the WHATWG URL parser (the parser a browser would use to follow the link).
 * Tests marked "DEFECT" failed against the implementation that was handed over for this pass.
 * Synthetic data only; nothing touches the network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';
import { MAX_URL_LENGTH, parseChatGptUrl, parseConversationRef } from '../../src/domain/ids.js';

const U = '6ac95b6e-9fa0-83e8-bbb0-8107079a8720';
const BASE = `https://chatgpt.com/c/${U}`;
const SEED = 20261017;

function expectCode(fn: () => unknown, code: ErrorCode, reason?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    assert.equal(e.code, code, `code (reason=${String(e.details?.['reason'])})`);
    if (reason !== undefined) assert.equal(e.details?.['reason'], reason);
    assert.equal(JSON.stringify(e.toEnvelope()).includes('ZZSECRETZZ'), false, 'error envelope echoed the input');
    return true;
  });
}

describe('DEFECT: parseConversationRef applies the same 2048-character bound as parseChatGptUrl, before any scanning', () => {
  // Taxonomy (unchanged): text that starts with a scheme is judged as a URL (INVALID_URL), everything else as a bare UUID
  // (INVALID_UUID). The new part is that BOTH report reason "too_long" for more than 2048 characters, without scanning.
  it('MAX_URL_LENGTH is the documented 2048', () => {
    assert.equal(MAX_URL_LENGTH, 2048);
  });

  it('a bare UUID padded with whitespace beyond the bound is refused (INVALID_UUID / too_long); the URL form is INVALID_URL / too_long', () => {
    for (const input of [' '.repeat(3000) + U, U + ' '.repeat(3000), '\n'.repeat(1500) + U + '\t'.repeat(1500)]) {
      expectCode(() => parseConversationRef(input), 'INVALID_UUID', 'too_long');
    }
    expectCode(() => parseConversationRef(BASE + ' '.repeat(3000)), 'INVALID_URL', 'too_long');
    expectCode(() => parseChatGptUrl(' '.repeat(3000) + BASE), 'INVALID_URL', 'too_long'); // the sibling function already behaves this way
  });

  it('any over-long text is refused with reason too_long (scheme-like text: INVALID_URL, anything else: INVALID_UUID) and the error never echoes it', () => {
    const secret = 'ZZSECRETZZ';
    for (const input of ['a'.repeat(3000), `${secret}${'a'.repeat(3000)}`, '\u0000'.repeat(3000), `{${U}}${' '.repeat(3000)}`]) {
      expectCode(() => parseConversationRef(input), 'INVALID_UUID', 'too_long');
    }
    for (const input of [`${secret}:${'a'.repeat(3000)}`, `https://${secret}.example/${'a'.repeat(3000)}`, `${BASE}?${secret}=${'x'.repeat(3000)}`, ` http://${'a'.repeat(3000)}`]) {
      expectCode(() => parseConversationRef(input), 'INVALID_URL', 'too_long');
    }
  });

  it('the boundary is inclusive: exactly 2048 characters still works, 2049 does not', () => {
    const exact = U + ' '.repeat(MAX_URL_LENGTH - U.length);
    assert.equal(exact.length, MAX_URL_LENGTH);
    assert.equal(parseConversationRef(exact).conversationId, U);
    expectCode(() => parseConversationRef(exact + ' '), 'INVALID_UUID', 'too_long');
    const exactUrl = BASE + '?' + 'x'.repeat(MAX_URL_LENGTH - BASE.length - 1);
    assert.equal(exactUrl.length, MAX_URL_LENGTH);
    assert.equal(parseConversationRef(exactUrl).viaUrl, true);
    expectCode(() => parseConversationRef(exactUrl + 'x'), 'INVALID_URL', 'too_long');
  });

  it('a 60-million-character input is refused without scanning it (best of 5 samples, strings built and flattened beforehand)', () => {
    const letters = 'a'.repeat(60_000_000);
    const padded = U.padStart(60_000_000, ' ');
    const urlish = 'https://' + letters;
    for (const s of [letters, padded, urlish]) s.charCodeAt(0); // force V8 to flatten any rope before the clock starts
    expectCode(() => parseConversationRef(letters), 'INVALID_UUID', 'too_long');
    expectCode(() => parseConversationRef(padded), 'INVALID_UUID', 'too_long');
    expectCode(() => parseConversationRef(urlish), 'INVALID_URL', 'too_long');
    let best = Number.POSITIVE_INFINITY;
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      for (const s of [letters, padded, urlish]) {
        try {
          parseConversationRef(s);
        } catch {
          /* expected */
        }
      }
      best = Math.min(best, performance.now() - t0);
    }
    // A linear scan of three 60M-character strings takes several hundred milliseconds; the bounded check takes microseconds.
    assert.ok(best < 50, `best of 5: ${best.toFixed(1)} ms: the length check must come before any linear scan`);
  });

  it('regression: ordinary inputs are unaffected (bare UUID in any case, padded with a little whitespace, URL forms, non-strings)', () => {
    assert.deepEqual(parseConversationRef(U.toUpperCase()), { conversationId: U, viaUrl: false });
    assert.deepEqual(parseConversationRef(`  \t${U}\n `), { conversationId: U, viaUrl: false });
    assert.deepEqual(parseConversationRef(BASE), { conversationId: U, viaUrl: true, canonicalUrl: BASE });
    expectCode(() => parseConversationRef(''), 'INVALID_UUID');
    expectCode(() => parseConversationRef('not-a-uuid'), 'INVALID_UUID');
    expectCode(() => parseConversationRef(5 as never), 'INVALID_ARGUMENT');
  });
});

describe('regression: acceptance is sound with respect to the WHATWG URL parser (150 000 mutated URLs)', () => {
  /** Characters that browsers, URL parsers or humans confuse with structure: userinfo, slashes, dots, ports, controls, IDN, case folds, encodings. */
  const CONFUSABLES = [
    '@', '\\', '/', '%2f', '%2F', '%2e', '%00', '%40', '.', '..', '#', '?', ':', '443', ' ', '\t', '\n', '\r', '\u0000', ' ', ' ', '。', '．', '／', '＠',
    'ｃ', 'ℂ', 'K', 'ſ', 'İ', 'xn--', 'evil.com', 'chatgpt.com', 'chat.openai.com', 'www.', '//', '[', ']', '%', '‮', '​', '﻿', 'c', 'C',
    'https:', 'http:', '-', '_', '0', 'g', 'é', '\u{1f600}', '\ud800',
  ];

  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  }

  it('whatever is accepted resolves, in new URL(), to https://chatgpt.com/c/<same uuid> with no userinfo and no port; nothing but a GcrError ever escapes', () => {
    const next = rng(SEED);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const seeds = [BASE, `${BASE}/`, BASE.toUpperCase(), ` ${BASE}`, `${BASE}?q=1#f`, `HTTPS://ChatGPT.com/c/${U.toUpperCase()}/`];
    let accepted = 0;
    const distinctAccepted = new Set<string>();
    for (let i = 0; i < 150_000; i++) {
      let s = pick(seeds);
      for (let edits = 1 + Math.floor(next() * 3); edits > 0; edits--) {
        const pos = Math.floor(next() * (s.length + 1));
        const op = next();
        if (op < 0.6) s = s.slice(0, pos) + pick(CONFUSABLES) + s.slice(pos);
        else if (op < 0.85) s = s.slice(0, pos) + s.slice(pos + 1 + Math.floor(next() * 3));
        else s = s.slice(0, pos) + pick(CONFUSABLES) + s.slice(pos + 1);
      }
      let parsed: ReturnType<typeof parseChatGptUrl> | null = null;
      try {
        parsed = parseChatGptUrl(s);
      } catch (e) {
        if (!(e instanceof GcrError)) assert.fail(`non-GcrError escaped for ${JSON.stringify(s)}: ${String(e)}`);
      }
      try {
        parseConversationRef(s);
      } catch (e) {
        if (!(e instanceof GcrError)) assert.fail(`non-GcrError escaped from parseConversationRef for ${JSON.stringify(s)}: ${String(e)}`);
      }
      if (parsed === null) continue;
      accepted++;
      distinctAccepted.add(s);
      const url = new URL(s.trim());
      assert.equal(url.protocol, 'https:', JSON.stringify(s));
      assert.equal(url.username + url.password, '', JSON.stringify(s));
      assert.equal(url.port, '', JSON.stringify(s));
      assert.equal(url.hostname, 'chatgpt.com', JSON.stringify(s));
      assert.match(url.pathname, /^\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i, JSON.stringify(s));
      assert.equal(url.pathname.slice(3, 39).toLowerCase(), parsed.conversationId, JSON.stringify(s));
      assert.equal(parsed.canonicalUrl, `https://chatgpt.com/c/${parsed.conversationId}`);
    }
    assert.ok(accepted > 800 && distinctAccepted.size > 200, `fuzzer only produced ${accepted} accepted / ${distinctAccepted.size} distinct inputs`);
  });
});
