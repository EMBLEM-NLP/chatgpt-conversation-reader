/**
 * Adversarial review tests for the defensive branches of src/format/time.ts: what happens when the ICU/Intl engine returns
 * something unexpected. The real engine never does (the all-zones properties in time.adversarial.test.ts prove that for this
 * runtime), but the module claims a typed, content-free failure (INTERNAL_ERROR GcrError) instead of printing garbage, and
 * a different ICU build can spell the era differently. Intl.DateTimeFormat is replaced by a stub for the duration of this
 * file only; every test uses a zone id no earlier test in this process has used, because formatters are cached per zone id.
 * (node --test runs each file in its own process, so no other file is affected.)
 */
import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { formatInTimeZone } from '../../src/format/time.js';

type Part = { type: string; value: string };

const RealDateTimeFormat = Intl.DateTimeFormat;

/** Installs a stub whose formatToParts always returns `parts`; constructing it with a time zone still validates nothing. */
function stubIntl(parts: Part[]): void {
  class Stub {
    formatToParts(): Part[] {
      return parts;
    }
  }
  (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = Stub;
}

function parts(over: Partial<Record<string, string>> = {}): Part[] {
  const base: Record<string, string> = { month: '12', day: '31', year: '1', era: 'BC', hour: '19', minute: '03', second: '58', timeZoneName: 'GMT-4:56:02' };
  return Object.entries({ ...base, ...over }).flatMap(([type, value]) => (value === undefined ? [] : [{ type, value }]));
}

afterEach(() => {
  (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
});
after(() => {
  (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
});

describe('formatInTimeZone: an engine that misbehaves yields a typed, content-free INTERNAL_ERROR (never garbage output)', () => {
  it('non-numeric calendar fields', () => {
    stubIntl(parts({ year: 'abc' }));
    assert.throws(
      () => formatInTimeZone('2025-03-09T06:30:00Z', 'Pacific/Easter'),
      (e: unknown) => e instanceof GcrError && e.code === 'INTERNAL_ERROR' && !e.message.includes('Pacific/Easter') && !e.message.includes('2025'),
    );
  });

  it('missing calendar fields', () => {
    stubIntl(parts({ minute: '' }).filter((p) => p.type !== 'minute'));
    assert.throws(() => formatInTimeZone('2025-03-09T06:30:00Z', 'Pacific/Galapagos'), (e: unknown) => e instanceof GcrError && e.code === 'INTERNAL_ERROR');
  });

  it('an implausible offset (local time more than 26 hours from UTC)', () => {
    // 2025-03-09T06:30:00Z read back as 2025-03-10 20:30:00 would be an offset of +38 hours.
    stubIntl(parts({ year: '2025', era: 'AD', month: '3', day: '10', hour: '20', minute: '30', second: '00', timeZoneName: 'GMT+38' }));
    assert.throws(
      () => formatInTimeZone('2025-03-09T06:30:00Z', 'Pacific/Fiji'),
      (e: unknown) => e instanceof GcrError && e.code === 'INTERNAL_ERROR' && e.message === 'The runtime returned an implausible UTC offset.',
    );
  });
});

describe('formatInTimeZone: era spellings', () => {
  it('"BCE" (other ICU data) is treated like "BC"', () => {
    stubIntl(parts({ era: 'BCE' }));
    assert.equal(formatInTimeZone('0001-01-01T00:00:00Z', 'Pacific/Noumea'), '0000-12-31 19:03:58 Pacific/Noumea (UTC-04:56:02)');
  });

  it('"AD" / "CE" and an engine that returns no era keep the printed year', () => {
    stubIntl(parts({ era: 'AD', year: '2025', month: '3', day: '9', hour: '1', minute: '30', second: '0', timeZoneName: 'EST' }));
    assert.equal(formatInTimeZone('2025-03-09T06:30:00Z', 'Pacific/Apia'), '2025-03-09 01:30:00 EST (UTC-05:00)');
    stubIntl(parts({ era: 'CE', year: '2025', month: '3', day: '9', hour: '1', minute: '30', second: '0', timeZoneName: 'EST' }));
    assert.equal(formatInTimeZone('2025-03-09T06:30:00Z', 'Pacific/Tongatapu'), '2025-03-09 01:30:00 EST (UTC-05:00)');
    stubIntl(parts({ year: '2025', month: '3', day: '9', hour: '1', minute: '30', second: '0', timeZoneName: 'EST' }).filter((p) => p.type !== 'era'));
    assert.equal(formatInTimeZone('2025-03-09T06:30:00Z', 'Pacific/Fakaofo'), '2025-03-09 01:30:00 EST (UTC-05:00)');
  });

  it('2 BC is astronomical year -0001', () => {
    stubIntl(parts({ year: '2', era: 'BC' }));
    assert.equal(formatInTimeZone('0000-01-01T00:00:00Z', 'Pacific/Wallis'), '-0001-12-31 19:03:58 Pacific/Wallis (UTC-04:56:02)');
  });
});
