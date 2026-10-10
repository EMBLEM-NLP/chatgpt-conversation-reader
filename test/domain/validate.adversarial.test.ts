/**
 * Adversarial-review tests for src/domain/validate.ts: hostile records must end in a clean GcrError that carries only
 * paths, reasons and counts; the timestamp helpers must agree with independent oracles on every boundary.
 * All tests here pin behaviour the review confirmed (they pass against the builder's implementation unless noted).
 * Synthetic data only; fast-check runs use a fixed seed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import { UNIX_SECONDS_MAX, UNIX_SECONDS_MIN, isIso8601Utc, parseIsoUtcToEpochMs, unixSecondsToIso, validateConversationRecord } from '../../src/domain/validate.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { convo, iso, msg } from '../helpers/records.js';

const SEED = 20261015;
const MARK = 'ZZSECRETMARKERZZ';

function good(): ConversationRecord {
  return convo('c1', [msg({ id: 'a', conversationId: 'c1', createdAt: iso(1), text: 'hello' }), msg({ id: 'b', conversationId: 'c1', parentId: 'a', createdAt: iso(2), text: 'world' })]);
}

function expectClean(fn: () => unknown): GcrError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof GcrError, `expected a GcrError, got ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`);
  assert.equal(caught.code, 'IMPORT_PARSE_ERROR');
  assert.equal(JSON.stringify(caught.toEnvelope()).includes(MARK), false, 'error envelope leaked a value');
  assert.equal(caught.cause, undefined, 'the original exception must not be chained (its text could carry content)');
  return caught;
}

describe('hostile objects cannot make validateConversationRecord throw anything but a clean IMPORT_PARSE_ERROR', () => {
  it('a throwing getter on a nested message field', () => {
    const rec = good();
    Object.defineProperty(rec.messages[0], 'text', {
      enumerable: true,
      get() {
        throw new Error(MARK);
      },
    });
    const e = expectClean(() => validateConversationRecord(rec));
    assert.equal((e.details?.['issues'] as Array<{ reason: string }>)[0]?.reason, 'unreadable');
  });

  it('a throwing getter on messages itself, on the record, and on the top-level message count', () => {
    for (const key of ['messages', 'title', 'id', 'provider']) {
      const rec = good();
      Object.defineProperty(rec, key, {
        enumerable: true,
        get() {
          throw new Error(MARK);
        },
      });
      expectClean(() => validateConversationRecord(rec));
    }
  });

  it('Proxies (throwing traps, revoked) used as the record, as the messages array and as a message', () => {
    const trap = (): never => {
      throw new Error(MARK);
    };
    const hostileProxy = (): object => new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    expectClean(() => validateConversationRecord(hostileProxy()));
    const rec1 = good();
    rec1.messages = new Proxy([], { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }) as never;
    expectClean(() => validateConversationRecord(rec1));
    const rec2 = good();
    rec2.messages[1] = hostileProxy() as never;
    expectClean(() => validateConversationRecord(rec2));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectClean(() => validateConversationRecord(revoked.proxy));
  });

  it('a getter on messages that starts throwing after k reads is a clean error for every k; the count is then reported as null, never a crash', () => {
    const outcomes = new Set<string>();
    for (let throwAt = 1; throwAt <= 8; throwAt++) {
      const rec = good();
      rec.title = 123 as never; // make validation fail so the error path (which reads messages once more) runs
      const real = rec.messages;
      let reads = 0;
      Object.defineProperty(rec, 'messages', {
        enumerable: true,
        get() {
          if (++reads >= throwAt) throw new Error(MARK);
          return real;
        },
      });
      const e = expectClean(() => validateConversationRecord(rec));
      outcomes.add(`${(e.details?.['issues'] as Array<{ reason: string }>)[0]?.reason}/${String(e.details?.['messageCount'])}`);
    }
    // k small: the accessor throws inside zod ("unreadable"); k large enough: validation fails normally and only the count lookup hits the throwing getter.
    assert.ok(outcomes.has('unreadable/null'), [...outcomes].join(','));
    assert.ok([...outcomes].some((o) => o.endsWith('/null') && !o.startsWith('unreadable')), `count-lookup path not exercised: ${[...outcomes].join(',')}`);
  });

  it('a getter that returns a different value on every read cannot smuggle an invalid value past the copy', () => {
    const rec = good();
    let reads = 0;
    Object.defineProperty(rec.messages[0], 'text', { enumerable: true, get: () => (reads++ === 0 ? 'fine' : '\u0000bad') });
    const out = validateConversationRecord(rec);
    assert.equal(out.messages[0]?.text.includes('\u0000'), false);
  });

  it('values zod does not know how to describe (bigint, symbol, function, Date, Map, boxed primitives, null prototype) are plain type errors', () => {
    const values: unknown[] = [10n, Symbol(MARK), () => MARK, new Date(0), new Map([[MARK, MARK]]), new Set([MARK]), Object.assign(Object.create(null), { [MARK]: MARK }), new String(MARK), Number.NaN, Infinity];
    for (const v of values) {
      expectClean(() => validateConversationRecord(v));
      for (const key of ['title', 'currentNodeId', 'importedAt', 'messages', 'warnings']) {
        const rec = good() as unknown as Record<string, unknown>;
        rec[key] = v;
        expectClean(() => validateConversationRecord(rec));
      }
      const rec = good();
      (rec.messages[0] as unknown as Record<string, unknown>)['ordinal'] = v;
      (rec.messages[1] as unknown as Record<string, unknown>)['blocks'] = [v];
      expectClean(() => validateConversationRecord(rec));
    }
  });

  it('property: fc.anything() (every exotic kind) at the root and in a record slot is accepted or cleanly rejected, never leaking', () => {
    const exotic = fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true, withTypedArray: true, withSparseArray: true, withObjectString: true });
    try {
      fc.assert(
        fc.property(exotic, fc.constantFrom('root', 'title', 'messages', 'message0', 'blocks', 'attachments', 'warnings', 'childIds', 'rawSource'), (value, where) => {
          let input: unknown = value;
          if (where !== 'root') {
            const rec = good();
            const m0 = rec.messages[0] as unknown as Record<string, unknown>;
            switch (where) {
              case 'title': rec.title = value as never; break;
              case 'messages': rec.messages = value as never; break;
              case 'message0': rec.messages[0] = value as never; break;
              case 'blocks': m0['blocks'] = value; break;
              case 'attachments': m0['attachments'] = value; break;
              case 'warnings': rec.warnings = value as never; break;
              case 'childIds': m0['childIds'] = value; break;
              default: m0['rawSource'] = value; // opaque: must be accepted
            }
            input = rec;
          }
          try {
            validateConversationRecord(input);
          } catch (e) {
            assert.ok(e instanceof GcrError, `non-GcrError escaped: ${String(e)}`);
            assert.equal(e.code, 'IMPORT_PARSE_ERROR');
          }
        }),
        { seed: SEED, numRuns: 1500 },
      );
    } catch (e) {
      throw new Error(`property failed (seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  });

  it('opaque fields accept hostile-but-serializable content by reference without touching Object.prototype', () => {
    const rec = good();
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "nested": [[[[[[[[[[1]]]]]]]]]]}');
    rec.rawMetadata = raw;
    rec.messages[0]!.rawSource = raw;
    rec.messages[0]!.blocks = [{ type: 'unknown', metadata: raw }];
    const out = validateConversationRecord(rec);
    assert.equal(out.rawMetadata, raw);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});

describe('timestamp helpers against independent oracles', () => {
  it('unixSecondsToIso equals Date#toISOString at every UTC day boundary of the accepted window (and a few offsets inside the day)', () => {
    let checked = 0;
    for (let s = UNIX_SECONDS_MIN; s <= UNIX_SECONDS_MAX; s += 86_400) {
      for (const off of [0, 0.0004, 0.0005, 43_200.5, 86_399, 86_399.999]) {
        const v = s + off;
        if (v > UNIX_SECONDS_MAX) continue;
        const r = unixSecondsToIso(v);
        assert.equal(r.iso, new Date(Math.round(v * 1000)).toISOString(), `value ${v}`);
        assert.equal('reason' in r, false);
        checked++;
      }
    }
    assert.ok(checked > 150_000, `only ${checked} values checked`);
  });

  it('window edges: inclusive ends convert, anything beyond by one tick does not', () => {
    assert.equal(unixSecondsToIso(UNIX_SECONDS_MIN).iso, '2015-01-01T00:00:00.000Z');
    assert.equal(unixSecondsToIso(UNIX_SECONDS_MAX).iso, '2100-01-01T00:00:00.000Z');
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MIN - 0.001), { iso: null, reason: 'out_of_range' });
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MAX + 0.001), { iso: null, reason: 'out_of_range' });
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MIN * 1000), { iso: null, reason: 'looks_like_milliseconds' });
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MAX * 1000 + 1000), { iso: null, reason: 'out_of_range' });
    assert.deepEqual(unixSecondsToIso(-0), { iso: null, reason: 'out_of_range' });
  });

  it('calendar table: leap years and month lengths (including the 1900/2100 century rule) in isIso8601Utc and parseIsoUtcToEpochMs', () => {
    const t = (y: string, mo: string, d: string): string => `${y}-${mo}-${d}T00:00:00Z`;
    const valid = [t('2000', '02', '29'), t('2024', '02', '29'), t('0000', '02', '29'), t('2400', '02', '29'), t('2025', '04', '30'), t('2025', '12', '31'), t('9999', '12', '31'), t('1900', '02', '28')];
    const invalid = [t('1900', '02', '29'), t('2100', '02', '29'), t('2023', '02', '29'), t('2025', '02', '30'), t('2025', '04', '31'), t('2025', '06', '31'), t('2025', '09', '31'), t('2025', '11', '31'), t('2025', '00', '10'), t('2025', '13', '10'), t('2025', '01', '00'), t('2025', '01', '32'), t('2025', '1', '10'), t('25', '01', '10')];
    for (const v of valid) {
      assert.equal(isIso8601Utc(v), true, v);
      assert.equal(parseIsoUtcToEpochMs(v), Date.parse(v), v);
    }
    for (const v of invalid) {
      assert.equal(isIso8601Utc(v), false, v);
      assert.equal(parseIsoUtcToEpochMs(v), null, v);
    }
    for (const v of ['2025-01-01T24:00:00Z', '2025-01-01T23:60:00Z', '2025-01-01T23:59:60Z', '2025-01-01T23:59:59.9999Z', '2025-01-01T23:59:59.Z', '2025-01-01T23:59:59,123Z']) assert.equal(isIso8601Utc(v), false, v);
  });

  it('look-alike digits and separators are not timestamps (no locale digits, no Unicode minus, no trailing newline)', () => {
    for (const v of ['２０２５-01-01T00:00:00Z', '2025−01-01T00:00:00Z', '2025-01-01T00:00:00Z\n', ' 2025-01-01T00:00:00Z', '2025-01-01 00:00:00Z', '2025-01-01T00:00:00z', '2025-01-01t00:00:00Z', '2025-01-01T00:00:00+00:00', '2025-01-01T00:00:00', '+002025-01-01T00:00:00Z', '2025-01-01T00:00:00\u0000Z']) {
      assert.equal(isIso8601Utc(v), false, JSON.stringify(v));
    }
  });

  it('property: anything that is not a string is rejected by both parsers; any string either parses to a finite integer or is null', () => {
    try {
      fc.assert(
        fc.property(fc.anything(), fc.string({ unit: 'binary', maxLength: 40 }), (v, s) => {
          if (typeof v !== 'string') {
            assert.equal(isIso8601Utc(v), false);
            assert.equal(parseIsoUtcToEpochMs(v), null);
          }
          const p = parseIsoUtcToEpochMs(s);
          assert.ok(p === null || Number.isSafeInteger(p));
          assert.equal(isIso8601Utc(s), p !== null);
        }),
        { seed: SEED, numRuns: 2000 },
      );
    } catch (e) {
      throw new Error(`property failed (seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  });
});
