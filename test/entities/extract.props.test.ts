/**
 * Property tests (fast-check, fixed seed) for src/entities/extract.ts: the extractor never throws on arbitrary text,
 * always returns well-formed, ordered, capped, deterministic results, and never leaks URL secrets.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { ENTITY_KINDS, extractEntities } from '../../src/entities/extract.js';
import type { ExtractedEntity } from '../../src/entities/extract.js';

const SEED = 20261010;
const RUNS = 300;

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TS_CANON = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z?)?$/;

function checkWellFormed(entities: readonly ExtractedEntity[]): void {
  const kindRank = new Map(ENTITY_KINDS.map((k, i) => [k, i] as const));
  let last: ExtractedEntity | undefined;
  const seen = new Set<string>();
  for (const e of entities) {
    assert.ok(kindRank.has(e.kind), `unknown kind ${e.kind}`);
    assert.ok(Number.isInteger(e.count) && e.count >= 1, 'count >= 1');
    assert.ok(e.normalized.length > 0 && e.value.length > 0, 'non-empty strings');
    const key = `${e.kind}\0${e.normalized}`;
    assert.ok(!seen.has(key), 'no duplicate (kind, normalized)');
    seen.add(key);
    if (last !== undefined) {
      const a = kindRank.get(last.kind) as number;
      const b = kindRank.get(e.kind) as number;
      assert.ok(a < b || (a === b && (last.count > e.count || (last.count === e.count && last.normalized < e.normalized))), 'sorted: kind, count desc, normalized asc');
    }
    last = e;
    switch (e.kind) {
      case 'url': {
        assert.match(e.value, /^https?:\/\//);
        const u = new URL(e.value);
        assert.equal(u.username, '');
        assert.equal(u.password, '');
        assert.equal(u.search, '');
        assert.equal(u.hash, '');
        assert.ok(!e.value.includes('?') && !e.value.includes('#'));
        assert.ok(!e.normalized.includes('?') && !e.normalized.includes('#'));
        assert.ok(!e.normalized.includes('://'));
        break;
      }
      case 'uuid':
        assert.match(e.normalized, UUID_LOWER);
        assert.equal(e.value, e.normalized);
        break;
      case 'timestamp':
        assert.match(e.normalized, TS_CANON);
        break;
      case 'keyword':
        assert.ok(Array.from(e.normalized).length >= 2, 'keyword has at least a bigram');
        assert.ok(!e.normalized.includes('@'));
        assert.equal(e.normalized, e.normalized.toLowerCase());
        break;
      default:
        break;
    }
  }
}

const anyText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 400 }),
  fc.string({ unit: 'grapheme', maxLength: 200 }),
  fc.stringMatching(/^[a-zA-Z0-9 .,:;!?@#/\\()\[\]<>"'`*_-]{0,300}$/),
);

// Text assembled from the shapes the extractor looks for, so every code path is exercised.
const piece = fc.oneof(
  fc.constantFrom('http://', 'https://', 'HTTPS://', 'javascript:', 'data:', '://', 'www.', '.com', '/', '?', '#', '@', ':', '.', '-', ' ', '\n', '(', ')', '```', '~~~', '日本', '语', 'ß', '’'),
  fc.stringMatching(/^[a-z]{1,8}$/),
  fc.stringMatching(/^[0-9]{1,8}$/),
  fc.constantFrom('00000000-0000-4000-8000-0000000000ab', '2025-01-15', '2025-01-15T10:30:00Z', '2025-02-30', 'example.com/path', 'user:pw@host.example', 'a@b.cc'),
);
const soup = fc.array(piece, { maxLength: 40 }).map((p) => p.join(''));

describe('extractEntities properties', () => {
  it('never throws and always returns well-formed, ordered, unique entities', () => {
    fc.assert(
      fc.property(fc.oneof(anyText, soup), (text) => {
        checkWellFormed(extractEntities({ text }));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('is deterministic and independent of earlier calls', () => {
    fc.assert(
      fc.property(fc.oneof(anyText, soup), fc.oneof(anyText, soup), (a, b) => {
        const first = JSON.stringify(extractEntities({ text: a }));
        extractEntities({ text: b });
        assert.equal(JSON.stringify(extractEntities({ text: a })), first);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('respects maxPerKind and maxKeywords', () => {
    fc.assert(
      fc.property(soup, fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), (text, perKind, kw) => {
        const out = extractEntities({ text: text.repeat(3) }, { maxPerKind: perKind, maxKeywords: kw });
        for (const kind of ENTITY_KINDS) {
          const n = out.filter((e) => e.kind === kind).length;
          assert.ok(n <= (kind === 'keyword' ? Math.min(perKind, kw) : perKind), `${kind}: ${n}`);
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('never stores userinfo, query or fragment secrets of a url, wherever the url sits in the text', () => {
    const secret = fc.string({ unit: fc.constantFrom(...'0123456789abcdef'.split('')), minLength: 8, maxLength: 16 }).map((h) => `zqx${h}`);
    fc.assert(
      fc.property(secret, secret, secret, soup, soup, (user, query, frag, before, after) => {
        const text = `${before} https://${user}:${user}@host.example/path?k=${query}&uuid=00000000-0000-4000-8000-0000000000ab#${frag} ${after}`;
        const dump = JSON.stringify(extractEntities({ text })).toLowerCase();
        for (const s of [user, query, frag]) assert.ok(!dump.includes(s.toLowerCase()), `leaked ${s}`);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('never extracts an e-mail address or any part of one', () => {
    const local = fc.stringMatching(/^[a-z]{4,8}[0-9]{0,3}$/).map((s) => `mq${s}`);
    const domain = fc.stringMatching(/^[a-z]{4,8}$/).map((s) => `dq${s}`);
    fc.assert(
      fc.property(local, domain, (l, d) => {
        const dump = JSON.stringify(extractEntities({ text: `write to ${l}@${d}.com today` })).toLowerCase();
        assert.ok(!dump.includes(l) && !dump.includes(d) && !dump.includes('@'), dump);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('a text cut at maxTextChars equals extracting the prefix', () => {
    fc.assert(
      fc.property(soup, fc.integer({ min: 1, max: 80 }), (text, cut) => {
        const full = extractEntities({ text }, { maxTextChars: cut });
        const prefix = extractEntities({ text: text.slice(0, cut) });
        // Equal unless the cut falls between a surrogate pair (then the extractor backs off by one unit).
        const last = text.charCodeAt(cut - 1);
        if (text.length > cut && last >= 0xd800 && last <= 0xdbff) return;
        assert.deepEqual(full, prefix);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});
