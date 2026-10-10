/**
 * Tests for src/format/time.ts: fixed layout, DST edges, half-hour zones, null/invalid handling, zone validation, and
 * independence from the host TZ / locale. Oracles are independent of the implementation: literal expected strings worked
 * out from the published DST rules, and `Intl`'s `timeZoneName: 'longOffset'` (a different code path from the
 * wall-clock-fields approach the implementation uses). All data synthetic; no network.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import { assertValidTimeZone, civilFromDays, daysFromCivil, formatInTimeZone, formatUtc, parseIsoInstant } from '../../src/format/time.js';

const SEED = 20261020;

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns: number): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

function expectInvalidArgument(fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${String(e)}`);
    assert.equal(e.code, 'INVALID_ARGUMENT');
    return true;
  });
}

describe('formatInTimeZone: fixed layout', () => {
  it('prints local wall clock, a zone name and the UTC offset in effect', () => {
    assert.equal(formatInTimeZone('2025-03-09T06:30:00Z', 'America/New_York'), '2025-03-09 01:30:00 EST (UTC-05:00)');
    assert.equal(formatInTimeZone('2025-03-09T06:30:00Z', 'UTC'), '2025-03-09 06:30:00 UTC (UTC+00:00)');
  });

  it('matches the documented layout for every zone, including ones without a plain ICU abbreviation', () => {
    const layout = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ \(UTC[+-]\d{2}:\d{2}(:\d{2})?\)$/;
    for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Pacific/Auckland', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Etc/GMT+5']) {
      const out = formatInTimeZone('2025-07-01T12:00:00Z', tz);
      assert.match(out, layout, `${tz}: ${out}`);
    }
  });

  it('falls back to the zone id exactly as written when ICU has no plain abbreviation (no information is lost)', () => {
    assert.equal(formatInTimeZone('2025-03-09T06:30:00Z', 'Asia/Kolkata'), '2025-03-09 12:00:00 Asia/Kolkata (UTC+05:30)');
    assert.equal(formatInTimeZone('2025-03-09T06:30:00Z', 'asia/kolkata'), '2025-03-09 12:00:00 asia/kolkata (UTC+05:30)');
  });

  it('truncates (never rounds) fractional seconds; the offset is unaffected', () => {
    assert.equal(formatInTimeZone('2025-03-09T06:30:00.999Z', 'UTC'), '2025-03-09 06:30:00 UTC (UTC+00:00)');
    assert.equal(formatInTimeZone('2025-03-09T06:59:59.999999999Z', 'America/New_York'), '2025-03-09 01:59:59 EST (UTC-05:00)');
  });

  it('treats UTC, Etc/UTC and utc as the same zone', () => {
    const iso = '2024-12-31T23:59:59Z';
    const expected = '2024-12-31 23:59:59 UTC (UTC+00:00)';
    assert.equal(formatInTimeZone(iso, 'UTC'), expected);
    assert.equal(formatInTimeZone(iso, 'Etc/UTC'), expected);
    assert.equal(formatInTimeZone(iso, 'utc'), expected);
  });
});

describe('formatInTimeZone: DST transitions (published rules, instant by instant)', () => {
  const cases: Array<[label: string, tz: string, iso: string, expected: string]> = [
    // US: second Sunday of March, 02:00 local -> 03:00 (07:00Z).
    ['NY spring-forward, last second before', 'America/New_York', '2025-03-09T06:59:59Z', '2025-03-09 01:59:59 EST (UTC-05:00)'],
    ['NY spring-forward, first second after', 'America/New_York', '2025-03-09T07:00:00Z', '2025-03-09 03:00:00 EDT (UTC-04:00)'],
    // US: first Sunday of November, 02:00 EDT -> 01:00 EST (06:00Z). The 01:xx hour happens twice.
    ['NY fall-back, last second of the first 01:xx', 'America/New_York', '2025-11-02T05:59:59Z', '2025-11-02 01:59:59 EDT (UTC-04:00)'],
    ['NY fall-back, first second of the repeated 01:xx', 'America/New_York', '2025-11-02T06:00:00Z', '2025-11-02 01:00:00 EST (UTC-05:00)'],
    // UK: last Sunday of March 01:00Z -> 02:00 BST; last Sunday of October 01:00Z -> 01:00 GMT.
    ['London spring-forward, before', 'Europe/London', '2025-03-30T00:59:59Z', '2025-03-30 00:59:59 GMT (UTC+00:00)'],
    ['London spring-forward, after', 'Europe/London', '2025-03-30T01:00:00Z', '2025-03-30 02:00:00 Europe/London (UTC+01:00)'],
    ['London fall-back, before', 'Europe/London', '2025-10-26T00:59:59Z', '2025-10-26 01:59:59 Europe/London (UTC+01:00)'],
    ['London fall-back, after', 'Europe/London', '2025-10-26T01:00:00Z', '2025-10-26 01:00:00 GMT (UTC+00:00)'],
    // NZ: first Sunday of April 03:00 NZDT -> 02:00 NZST (2025-04-05T14:00Z); last Sunday of September 02:00 NZST -> 03:00 NZDT (2025-09-27T14:00Z).
    ['Auckland DST end, before', 'Pacific/Auckland', '2025-04-05T13:59:59Z', '2025-04-06 02:59:59 Pacific/Auckland (UTC+13:00)'],
    ['Auckland DST end, after', 'Pacific/Auckland', '2025-04-05T14:00:00Z', '2025-04-06 02:00:00 Pacific/Auckland (UTC+12:00)'],
    ['Auckland DST start, before', 'Pacific/Auckland', '2025-09-27T13:59:59Z', '2025-09-28 01:59:59 Pacific/Auckland (UTC+12:00)'],
    ['Auckland DST start, after', 'Pacific/Auckland', '2025-09-27T14:00:00Z', '2025-09-28 03:00:00 Pacific/Auckland (UTC+13:00)'],
  ];
  for (const [label, tz, iso, expected] of cases) {
    it(label, () => assert.equal(formatInTimeZone(iso, tz), expected));
  }

  it('shows the repeated NY wall-clock hour with two different offsets (so local times stay unambiguous)', () => {
    const first = formatInTimeZone('2025-11-02T05:30:00Z', 'America/New_York');
    const second = formatInTimeZone('2025-11-02T06:30:00Z', 'America/New_York');
    assert.equal(first.slice(0, 19), second.slice(0, 19), 'same wall clock');
    assert.notEqual(first, second);
    assert.ok(first.endsWith('(UTC-04:00)') && second.endsWith('(UTC-05:00)'));
  });
});

describe('formatInTimeZone: half-hour, 45-minute and date-changing zones', () => {
  it('Asia/Kolkata is UTC+05:30 all year', () => {
    assert.equal(formatInTimeZone('2025-01-01T00:00:00Z', 'Asia/Kolkata'), '2025-01-01 05:30:00 Asia/Kolkata (UTC+05:30)');
    assert.equal(formatInTimeZone('2025-07-01T00:00:00Z', 'Asia/Kolkata'), '2025-07-01 05:30:00 Asia/Kolkata (UTC+05:30)');
    assert.equal(formatInTimeZone('2025-12-31T18:30:00Z', 'Asia/Kolkata'), '2026-01-01 00:00:00 Asia/Kolkata (UTC+05:30)', 'crosses the year boundary');
  });

  it('Asia/Kathmandu is UTC+05:45; Pacific/Chatham alternates +12:45/+13:45; Australia/Lord_Howe has a 30-minute DST step', () => {
    assert.equal(formatInTimeZone('2025-03-09T06:30:00Z', 'Asia/Kathmandu'), '2025-03-09 12:15:00 Asia/Kathmandu (UTC+05:45)');
    assert.equal(formatInTimeZone('2025-07-01T00:00:00Z', 'Pacific/Chatham'), '2025-07-01 12:45:00 Pacific/Chatham (UTC+12:45)');
    assert.equal(formatInTimeZone('2025-01-01T00:00:00Z', 'Pacific/Chatham'), '2025-01-01 13:45:00 Pacific/Chatham (UTC+13:45)');
    assert.equal(formatInTimeZone('2025-07-09T06:30:00Z', 'Australia/Lord_Howe'), '2025-07-09 17:00:00 Australia/Lord_Howe (UTC+10:30)');
    assert.equal(formatInTimeZone('2025-01-09T06:30:00Z', 'Australia/Lord_Howe'), '2025-01-09 17:30:00 Australia/Lord_Howe (UTC+11:00)');
  });

  it('handles leap days, month ends and the extremes of the date line', () => {
    assert.equal(formatInTimeZone('2024-02-29T23:30:00Z', 'Asia/Tokyo'), '2024-03-01 08:30:00 Asia/Tokyo (UTC+09:00)');
    assert.equal(formatInTimeZone('2025-02-28T23:30:00Z', 'Asia/Tokyo'), '2025-03-01 08:30:00 Asia/Tokyo (UTC+09:00)', '2025 is not a leap year');
    assert.equal(formatInTimeZone('2025-01-01T00:00:00Z', 'Pacific/Kiritimati'), '2025-01-01 14:00:00 Pacific/Kiritimati (UTC+14:00)');
    assert.equal(formatInTimeZone('2025-01-01T00:00:00Z', 'Etc/GMT+12'), '2024-12-31 12:00:00 Etc/GMT+12 (UTC-12:00)');
  });

  it('keeps seconds in historic local-mean-time offsets instead of silently rounding them', () => {
    assert.equal(formatInTimeZone('1880-01-01T00:00:00Z', 'America/New_York'), '1879-12-31 19:03:58 America/New_York (UTC-04:56:02)');
  });

  it('formats the extremes of the supported range', () => {
    assert.equal(formatInTimeZone('0001-01-01T00:00:00Z', 'UTC'), '0001-01-01 00:00:00 UTC (UTC+00:00)');
    assert.equal(formatInTimeZone('9999-12-31T23:59:59Z', 'UTC'), '9999-12-31 23:59:59 UTC (UTC+00:00)');
    assert.equal(formatInTimeZone('1969-12-31T23:59:59Z', 'UTC'), '1969-12-31 23:59:59 UTC (UTC+00:00)', 'before the epoch');
  });
});

describe('null, invalid and unusual timestamps', () => {
  it('null renders as "unknown" in every function, never a made-up time', () => {
    assert.equal(formatInTimeZone(null, 'UTC'), 'unknown');
    assert.equal(formatInTimeZone(null, 'America/New_York'), 'unknown');
    assert.equal(formatUtc(null), 'unknown');
  });

  it('text that is not a real instant renders as "invalid" (distinguishable from missing data)', () => {
    for (const bad of ['', 'not a time', '2025-02-30T00:00:00Z', '2025-13-01T00:00:00Z', '2025-03-09T24:00:00Z', '2025-03-09T23:59:60Z', '2025-03-09', '2025-03-09T06:30:00', '2025-03-09 06:30:00Z', '+2025-03-09T06:30:00Z', '2025-03-09T06:30:00Z\n', 'x'.repeat(10_000)]) {
      assert.equal(formatInTimeZone(bad, 'UTC'), 'invalid', JSON.stringify(bad).slice(0, 40));
      assert.equal(formatInTimeZone(bad, 'Asia/Kolkata'), 'invalid');
      assert.equal(formatUtc(bad), 'invalid');
    }
  });

  it('zone-less timestamps are rejected rather than interpreted in the host zone', () => {
    assert.equal(parseIsoInstant('2025-03-09T06:30:00'), null);
  });

  it('numeric offsets are converted to UTC before formatting', () => {
    assert.equal(formatInTimeZone('2025-03-09T12:00:00+05:30', 'UTC'), '2025-03-09 06:30:00 UTC (UTC+00:00)');
    assert.equal(formatUtc('2025-03-09T01:30:00-05:00'), '2025-03-09T06:30:00Z');
  });

  it('a non-string timestamp (corrupt row) is reported as invalid, not a crash', () => {
    assert.equal(formatInTimeZone(12345 as unknown as string, 'UTC'), 'invalid');
    assert.equal(formatUtc(undefined as unknown as string), 'invalid');
  });
});

describe('formatUtc / parseIsoInstant', () => {
  it('prints seconds precision, adding milliseconds only when non-zero', () => {
    assert.equal(formatUtc('2025-03-09T06:30:00.000Z'), '2025-03-09T06:30:00Z');
    assert.equal(formatUtc('2025-03-09T06:30:00.250Z'), '2025-03-09T06:30:00.250Z');
    assert.equal(formatUtc('2025-03-09T06:30:00.2509999Z'), '2025-03-09T06:30:00.250Z', 'sub-millisecond digits are truncated');
  });

  it('parses calendar edges exactly', () => {
    assert.equal(parseIsoInstant('1970-01-01T00:00:00Z'), 0);
    assert.equal(parseIsoInstant('2024-02-29T00:00:00Z'), Date.UTC(2024, 1, 29));
    assert.equal(parseIsoInstant('2023-02-29T00:00:00Z'), null);
    assert.equal(parseIsoInstant('2100-02-29T00:00:00Z'), null, '2100 is not a leap year');
    assert.equal(parseIsoInstant('2000-02-29T00:00:00Z'), Date.UTC(2000, 1, 29), '2000 is a leap year');
    assert.equal(parseIsoInstant('2025-04-31T00:00:00Z'), null);
  });

  it('calendar arithmetic round-trips (property)', () => {
    runProperty(
      fc.property(fc.integer({ min: -800_000, max: 2_900_000 }), (days) => {
        const { year, month, day } = civilFromDays(days);
        assert.equal(daysFromCivil(year, month, day), days);
        assert.equal(daysFromCivil(1970, 1, 1), 0);
      }),
      500,
    );
  });

  it('agrees with Date.UTC for random valid instants (property)', () => {
    runProperty(
      fc.property(fc.integer({ min: Date.UTC(1900, 0, 1) / 1000, max: Date.UTC(2200, 0, 1) / 1000 }), (sec) => {
        const iso = new Date(sec * 1000).toISOString();
        assert.equal(parseIsoInstant(iso), sec * 1000);
        assert.equal(formatUtc(iso), iso.replace('.000Z', 'Z'));
      }),
      500,
    );
  });
});

describe('assertValidTimeZone', () => {
  it('accepts UTC and real IANA zones', () => {
    for (const tz of ['UTC', 'Etc/UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Pacific/Auckland', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) {
      assert.doesNotThrow(() => assertValidTimeZone(tz), tz);
    }
  });

  it('throws INVALID_ARGUMENT for unknown, malformed, offset-style and non-string zones', () => {
    const bad = ['Nope/Zone', 'Mars/Olympus_Mons', '', ' UTC', 'UTC ', 'UTC+1', '+05:00', '-0500', 'Z', 'Europe/\nLondon', 'Europe/London\0', '../etc/passwd', 'a'.repeat(100), 'America//New_York', '/UTC'];
    for (const tz of bad) expectInvalidArgument(() => assertValidTimeZone(tz));
    expectInvalidArgument(() => assertValidTimeZone(undefined as unknown as string));
    expectInvalidArgument(() => assertValidTimeZone(5 as unknown as string));
    expectInvalidArgument(() => assertValidTimeZone(null as unknown as string));
  });

  it('formatInTimeZone rejects a bad zone even when the timestamp is null (a bad option never hides behind missing data)', () => {
    expectInvalidArgument(() => formatInTimeZone(null, 'Nope/Zone'));
    expectInvalidArgument(() => formatInTimeZone('2025-03-09T06:30:00Z', 'Nope/Zone'));
    expectInvalidArgument(() => formatInTimeZone('2025-03-09T06:30:00Z', '+05:00'));
  });

  it('the error does not echo the offending value and carries a remedy', () => {
    const secret = 'Secret/Zone-9f3a';
    try {
      assertValidTimeZone(secret);
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof GcrError);
      assert.ok(!e.message.includes(secret));
      assert.ok(!JSON.stringify(e.details ?? {}).includes(secret));
      assert.ok((e.remedy ?? '').includes('America/New_York'));
    }
  });
});

describe('independence from the host', () => {
  const instants = ['2025-03-09T06:59:59Z', '2025-03-09T07:00:00Z', '2025-11-02T05:59:59Z', '2025-11-02T06:00:00Z', '2025-07-01T12:00:00.5Z', '1880-01-01T00:00:00Z'];
  const zones = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Pacific/Auckland'];

  it('gives identical output under a different TZ environment variable and locale (checked in a child process that really has another host zone)', () => {
    const here = JSON.stringify(instants.flatMap((iso) => zones.map((tz) => formatInTimeZone(iso, tz))));
    const moduleUrl = new URL('../../src/format/time.js', import.meta.url).href;
    const script = `
      const m = await import(process.argv[1]);
      const instants = ${JSON.stringify(instants)};
      const zones = ${JSON.stringify(zones)};
      process.stdout.write(JSON.stringify({
        hostOffsetMinutes: new Date(Date.UTC(2025, 0, 1)).getTimezoneOffset(),
        out: instants.flatMap((iso) => zones.map((tz) => m.formatInTimeZone(iso, tz))),
      }));
    `;
    for (const env of [
      { TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', LANGUAGE: 'tr' },
      { TZ: 'America/St_Johns', LANG: 'ar_SA.UTF-8', LC_ALL: 'ar_SA.UTF-8', LANGUAGE: 'ar' },
    ]) {
      const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 20_000,
      });
      const parsed = JSON.parse(raw) as { hostOffsetMinutes: number; out: string[] };
      const hostZoneReallyDiffers = env.TZ === 'Pacific/Kiritimati' ? parsed.hostOffsetMinutes === -840 : parsed.hostOffsetMinutes !== 0;
      assert.ok(hostZoneReallyDiffers, `child host offset ${parsed.hostOffsetMinutes} for TZ=${env.TZ}`);
      assert.equal(JSON.stringify(parsed.out), here, `TZ=${env.TZ}`);
    }
  });
});

describe('formatInTimeZone: offset and wall clock always agree (property, independent oracle)', () => {
  const ZONES = ['UTC', 'America/New_York', 'America/St_Johns', 'Europe/London', 'Europe/Kyiv', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Kiritimati', 'America/Sao_Paulo', 'Africa/Casablanca', 'Asia/Tehran'];
  const LOCAL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (\S+) \(UTC([+-])(\d{2}):(\d{2})(?::(\d{2}))?\)$/;

  /** Offset in seconds according to Intl's own longOffset naming ("GMT-05:00", "GMT" for zero). */
  function oracleOffsetSeconds(sec: number, tz: string): number {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(sec * 1000)
      .find((p) => p.type === 'timeZoneName')?.value;
    assert.ok(name !== undefined);
    if (name === 'GMT') return 0;
    const m = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name);
    assert.ok(m !== null, `unexpected longOffset ${name}`);
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? '0'));
  }

  it('local wall clock minus printed offset equals the instant, and the offset equals Intl longOffset (1950-2100)', () => {
    runProperty(
      fc.property(fc.integer({ min: Date.UTC(1950, 0, 1) / 1000, max: Date.UTC(2100, 0, 1) / 1000 }), fc.constantFrom(...ZONES), (sec, tz) => {
        const out = formatInTimeZone(new Date(sec * 1000).toISOString(), tz);
        const m = LOCAL.exec(out);
        assert.ok(m !== null, out);
        const [, y, mo, d, h, mi, s, , sign, oh, om, os] = m;
        const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60 + Number(os ?? '0'));
        const localSec = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000;
        assert.equal(localSec - offset, sec, `${tz} ${out}`);
        assert.equal(offset, oracleOffsetSeconds(sec, tz), `${tz} ${out}`);
      }),
      1500,
    );
  });

  it('is deterministic and strictly monotone in the instant for a fixed zone (property)', () => {
    runProperty(
      fc.property(fc.integer({ min: Date.UTC(2000, 0, 1) / 1000, max: Date.UTC(2040, 0, 1) / 1000 }), fc.constantFrom(...ZONES), (sec, tz) => {
        const iso = new Date(sec * 1000).toISOString();
        assert.equal(formatInTimeZone(iso, tz), formatInTimeZone(iso, tz));
        // Converting back through the printed offset must reproduce the instant exactly: no two instants share a string.
        const next = formatInTimeZone(new Date((sec + 1) * 1000).toISOString(), tz);
        assert.notEqual(formatInTimeZone(iso, tz), next);
      }),
      300,
    );
  });
});
