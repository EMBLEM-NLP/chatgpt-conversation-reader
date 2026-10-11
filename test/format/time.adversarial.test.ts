/**
 * Adversarial review tests for src/format/time.ts (reviewer lens: fidelity and DST/era correctness).
 *
 * Each test here was written to FAIL against the module as first delivered and to pass after the minimal fix:
 *  - `0001-01-01T00:00:00Z` (the zero value of Go's time.Time and .NET's DateTime, so a realistic "unset" timestamp)
 *    and anything in year 0000 made formatInTimeZone throw INTERNAL_ERROR in every zone whose local time falls before
 *    1 CE: Intl prints era-relative years (1 BC), which the offset arithmetic read as year 1.
 *  - an instant that lands before year 0000 (an offset-bearing input such as 0000-01-01T00:00:00+14:00) was printed as
 *    the garbage year "00-1" by formatUtc and by the UTC fast path of formatInTimeZone.
 * The oracles are independent of the implementation: literal expectations worked out from the tz database's local mean
 * times, and `Date.parse` of zone-explicit ISO strings (host independent) for the instant.
 * All data synthetic; no network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import { daysFromCivil, formatInTimeZone, formatUtc } from '../../src/format/time.js';

const SEED = 20261021;

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns: number): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** `YYYY-MM-DD HH:mm:ss <name> (UTC+HH:MM[:SS])` with a possibly signed year. */
const LAYOUT = /^(-?\d{4,6})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (\S+) \(UTC([+-])(\d{2}):(\d{2})(?::(\d{2}))?\)$/;

/** Local wall clock minus printed offset, in epoch seconds; null when the text does not follow the layout. */
function instantFromLayout(text: string): number | null {
  const m = LAYOUT.exec(text);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, , sign, oh, om, os] = m;
  const local = daysFromCivil(Number(y), Number(mo), Number(d)) * 86_400 + Number(h) * 3600 + Number(mi) * 60 + Number(s);
  const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60 + Number(os ?? 0));
  return local - offset;
}

const ZONES = Intl.supportedValuesOf('timeZone');

describe('formatInTimeZone: the first years of the calendar (era-relative years in Intl)', () => {
  it('the zero value of Go time.Time / .NET DateTime renders in a negative-offset zone instead of throwing INTERNAL_ERROR', () => {
    // New York local mean time was UTC-04:56:02, so local time is the previous day, 1 BC (= astronomical year 0000).
    assert.equal(formatInTimeZone('0001-01-01T00:00:00Z', 'America/New_York'), '0000-12-31 19:03:58 America/New_York (UTC-04:56:02)');
    assert.equal(formatInTimeZone('0001-01-01T00:00:00Z', 'Asia/Kolkata'), '0001-01-01 05:53:28 Asia/Kolkata (UTC+05:53:28)');
  });

  it('year 0000 renders with a signed astronomical year when the local date is before 1 CE, never as a thrown error', () => {
    assert.equal(formatInTimeZone('0000-01-01T00:00:00Z', 'America/New_York'), '-0001-12-31 19:03:58 America/New_York (UTC-04:56:02)');
    assert.equal(formatInTimeZone('0000-06-15T12:00:00Z', 'America/New_York'), '0000-06-15 07:03:58 America/New_York (UTC-04:56:02)');
    assert.equal(formatInTimeZone('0000-06-15T12:00:00Z', 'Asia/Kolkata'), '0000-06-15 17:53:28 Asia/Kolkata (UTC+05:53:28)');
  });

  it('the day numbering around 1 BC / 1 CE is continuous (proleptic Gregorian, year 0000 is a leap year)', () => {
    assert.equal(formatInTimeZone('0000-03-01T00:00:00Z', 'UTC'), '0000-03-01 00:00:00 UTC (UTC+00:00)');
    assert.equal(formatInTimeZone('0000-02-29T12:00:00Z', 'Etc/GMT+12'), '0000-02-29 00:00:00 Etc/GMT+12 (UTC-12:00)');
    assert.equal(formatInTimeZone('0000-03-01T11:59:59Z', 'Etc/GMT+12'), '0000-02-29 23:59:59 Etc/GMT+12 (UTC-12:00)');
    assert.equal(formatInTimeZone('0000-01-01T11:59:59Z', 'Etc/GMT+12'), '-0001-12-31 23:59:59 Etc/GMT+12 (UTC-12:00)');
  });

  it('EVERY zone this runtime knows renders the first instants of the calendar; local time minus the printed offset is the instant', () => {
    const instants = ['0000-01-01T00:00:00Z', '0000-12-31T23:59:59Z', '0001-01-01T00:00:00Z', '0001-01-01T00:00:01Z', '0000-02-29T12:00:00Z'];
    for (const tz of ZONES) {
      for (const iso of instants) {
        let out: string;
        try {
          out = formatInTimeZone(iso, tz);
        } catch (e) {
          assert.fail(`${tz} @ ${iso} threw ${e instanceof GcrError ? e.code : String(e)}`);
        }
        assert.equal(instantFromLayout(out), Date.parse(iso) / 1000, `${tz} @ ${iso}: ${out}`);
      }
    }
  });

  it('property: any instant of years 0000..9999 in any known zone renders, and the printed local time and offset reproduce the instant exactly', () => {
    const FIRST = Date.parse('0000-01-01T00:00:00Z') / 1000;
    const LAST = Date.parse('9999-12-31T23:59:59Z') / 1000;
    runProperty(
      fc.property(fc.oneof(fc.integer({ min: FIRST, max: FIRST + 4 * 366 * 86_400 }), fc.integer({ min: FIRST, max: LAST })), fc.constantFrom(...ZONES), (secs, tz) => {
        const iso = new Date(secs * 1000).toISOString().replace('.000Z', 'Z');
        const out = formatInTimeZone(iso, tz);
        assert.equal(instantFromLayout(out), secs, `${tz} @ ${iso}: ${out}`);
      }),
      3000,
    );
  });
});

describe('formatUtc / UTC fast path: instants before year 0000 (reachable through numeric offsets)', () => {
  it('prints a signed four-digit year instead of the garbage "00-1"', () => {
    // 0000-01-01T00:00:00+14:00 is 14 hours before the start of year 0000.
    assert.equal(formatUtc('0000-01-01T00:00:00+14:00'), '-0001-12-31T10:00:00Z');
    assert.equal(formatInTimeZone('0000-01-01T00:00:00+14:00', 'UTC'), '-0001-12-31 10:00:00 UTC (UTC+00:00)');
  });

  it('the first instant that is not before year 0000 is unchanged (negative control)', () => {
    assert.equal(formatUtc('0000-01-01T00:00:00Z'), '0000-01-01T00:00:00Z');
    assert.equal(formatUtc('0000-01-01T00:00:00-00:00'), '0000-01-01T00:00:00Z');
    assert.equal(formatInTimeZone('0000-01-01T00:00:00Z', 'UTC'), '0000-01-01 00:00:00 UTC (UTC+00:00)');
  });

  it('a signed year round-trips through the independent day arithmetic', () => {
    const out = formatInTimeZone('0000-01-01T00:00:00+14:00', 'UTC');
    assert.equal(instantFromLayout(out), Date.parse('0000-01-01T00:00:00+14:00') / 1000);
  });
});
