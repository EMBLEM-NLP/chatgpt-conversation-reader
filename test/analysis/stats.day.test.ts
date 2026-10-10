/**
 * Tests for the time-zone aware "day" grouping of src/analysis/stats.ts: bucket boundaries around UTC midnight, DST, zones
 * with 30/45-minute offsets, unknown timestamps, the tz argument validation, and a property test against an independent
 * fixed-offset oracle. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { computeStats } from '../../src/analysis/stats.js';
import type { StatsResult } from '../../src/analysis/stats.js';
import { GcrError } from '../../src/errors.js';
import { chat, fresh, importAll } from './support.test.js';
import type { Fresh, MsgSpec } from './support.test.js';

/** One conversation, one user message per timestamp (null = no timestamp). */
async function dbWith(times: Array<string | null>, over: Partial<MsgSpec> = {}): Promise<Fresh> {
  const f = fresh();
  await importAll(f.repo, [chat('d', times.map((at) => ({ role: 'user', at, ...over })))]);
  return f;
}

function keys(r: StatsResult): Array<string | null> {
  return r.rows.map((x) => x.key);
}

function dayOf(r: StatsResult): string | null {
  assert.equal(r.rows.length, 1, 'exactly one day bucket expected');
  return r.rows[0]?.key ?? null;
}

describe('day grouping: time-zone boundaries', () => {
  it('2025-03-09T04:30Z is Mar 8 in America/New_York but Mar 9 in UTC (default tz is UTC)', async () => {
    const { db } = await dbWith(['2025-03-09T04:30:00Z']);
    const utc = computeStats(db, { groupBy: 'day' });
    assert.equal(dayOf(utc), '2025-03-09');
    assert.equal(utc.tz, 'UTC');
    assert.equal(utc.rows[0]?.label, '2025-03-09');
    const ny = computeStats(db, { groupBy: 'day', tz: 'America/New_York' });
    assert.equal(dayOf(ny), '2025-03-08');
    assert.equal(ny.tz, 'America/New_York');
  });

  it('New York spring DST: the offset changes at 2025-03-09T07:00Z (EST -5h before, EDT -4h after)', async () => {
    const { db } = await dbWith([
      '2025-03-09T04:59:59Z', // 23:59:59 EST, Mar 8
      '2025-03-09T05:00:00Z', // 00:00:00 EST, Mar 9
      '2025-03-10T03:59:59Z', // 23:59:59 EDT, Mar 9 (a stale -5h offset would say 22:59:59, same day)
      '2025-03-10T04:00:00Z', // 00:00:00 EDT, Mar 10 (a stale -5h offset would say 23:00 Mar 9: wrong day)
    ]);
    const r = computeStats(db, { groupBy: 'day', tz: 'America/New_York' });
    // messages DESC, then key ASC: Mar 9 has two, Mar 8 and Mar 10 one each.
    assert.deepEqual(r.rows.map((x) => [x.key, x.messages]), [
      ['2025-03-09', 2],
      ['2025-03-08', 1],
      ['2025-03-10', 1],
    ]);
  });

  it('New York autumn DST end (2025-11-02T06:00Z): 04:59:59Z on Nov 3 is still Nov 2 in EST, 05:00Z is Nov 3', async () => {
    const { db } = await dbWith([
      '2025-11-02T03:59:59Z', // 23:59:59 EDT, Nov 1
      '2025-11-02T05:59:59Z', // 01:59:59 EDT, Nov 2
      '2025-11-02T06:00:00Z', // 01:00:00 EST, Nov 2 (the repeated hour)
      '2025-11-03T04:59:59Z', // 23:59:59 EST, Nov 2 (a stale -4h offset would say Nov 3)
      '2025-11-03T05:00:00Z', // 00:00:00 EST, Nov 3
    ]);
    const r = computeStats(db, { groupBy: 'day', tz: 'America/New_York' });
    assert.deepEqual(r.rows.map((x) => [x.key, x.messages]), [
      ['2025-11-02', 3],
      ['2025-11-01', 1],
      ['2025-11-03', 1],
    ]);
  });

  it('Asia/Kolkata (UTC+5:30): the day changes at 18:30Z, not at 18:00Z or 19:00Z', async () => {
    const { db } = await dbWith(['2025-03-09T18:00:00Z', '2025-03-09T18:29:59Z', '2025-03-09T18:30:00Z', '2025-03-09T19:00:00Z']);
    const r = computeStats(db, { groupBy: 'day', tz: 'Asia/Kolkata' });
    assert.deepEqual(r.rows.map((x) => [x.key, x.messages]), [
      ['2025-03-09', 2],
      ['2025-03-10', 2],
    ]);
  });

  it('Asia/Kathmandu (UTC+5:45): the day changes at 18:15Z', async () => {
    const { db } = await dbWith(['2025-03-09T18:14:59Z', '2025-03-09T18:15:00Z']);
    const r = computeStats(db, { groupBy: 'day', tz: 'Asia/Kathmandu' });
    assert.deepEqual(r.rows.map((x) => [x.key, x.messages]), [
      ['2025-03-09', 1],
      ['2025-03-10', 1],
    ]);
  });

  it('Pacific/Kiritimati (UTC+14) and Etc/GMT+12 (UTC-12) put one instant on days 26 hours apart', async () => {
    const { db } = await dbWith(['2025-06-15T09:59:59Z', '2025-06-15T10:00:00Z']);
    assert.deepEqual(keys(computeStats(db, { groupBy: 'day', tz: 'Pacific/Kiritimati' })), ['2025-06-15', '2025-06-16']);
    assert.deepEqual(keys(computeStats(db, { groupBy: 'day', tz: 'Etc/GMT+12' })), ['2025-06-14']);
  });

  it('New Year and leap day: 2024-12-31T23:30Z is 2025-01-01 in Tokyo; 2024-02-29T23:59:59Z is Feb 29 UTC and Mar 1 in Tokyo', async () => {
    const a = await dbWith(['2024-12-31T23:30:00Z']);
    assert.equal(dayOf(computeStats(a.db, { groupBy: 'day', tz: 'Asia/Tokyo' })), '2025-01-01');
    assert.equal(dayOf(computeStats(a.db, { groupBy: 'day' })), '2024-12-31');
    const b = await dbWith(['2024-02-29T23:59:59Z']);
    assert.equal(dayOf(computeStats(b.db, { groupBy: 'day' })), '2024-02-29');
    assert.equal(dayOf(computeStats(b.db, { groupBy: 'day', tz: 'Asia/Tokyo' })), '2024-03-01');
  });

  it('timestamps stored with and without milliseconds fall on the same day bucket', async () => {
    const { db } = await dbWith(['2025-05-05T12:00:00Z', '2025-05-05T12:00:00.000Z', '2025-05-05T23:59:59.999Z']);
    const r = computeStats(db, { groupBy: 'day' });
    assert.deepEqual(r.rows.map((x) => [x.key, x.messages]), [['2025-05-05', 3]]);
    assert.equal(r.rows[0]?.firstAt, '2025-05-05T12:00:00.000Z');
    assert.equal(r.rows[0]?.lastAt, '2025-05-05T23:59:59.999Z');
  });

  it('extreme years do not break the key: year 0000 (1 BC) and a +14h zone pushing 9999-12-31 into year 10000', async () => {
    const { db } = await dbWith(['0000-06-15T12:00:00Z', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59Z']);
    const utc = computeStats(db, { groupBy: 'day' });
    assert.deepEqual(keys(utc).sort(), ['0000-01-01', '0000-06-15', '9999-12-31']);
    const west = computeStats(db, { groupBy: 'day', tz: 'Etc/GMT+12' });
    assert.ok(keys(west).includes('-0001-12-31'), `keys: ${keys(west).join(',')}`);
    const east = computeStats(db, { groupBy: 'day', tz: 'Pacific/Kiritimati' });
    assert.ok(keys(east).includes('10000-01-01'), `keys: ${keys(east).join(',')}`);
  });

  it('"Etc/UTC" (the generic path) and "UTC" give identical buckets', async () => {
    const { db } = await dbWith(['2025-01-01T00:00:00Z', '2025-01-01T23:59:59Z', '2025-01-02T00:00:00Z', null]);
    const a = computeStats(db, { groupBy: 'day', tz: 'UTC' });
    const b = computeStats(db, { groupBy: 'day', tz: 'Etc/UTC' });
    assert.deepEqual(a.rows, b.rows);
  });
});

describe('day grouping: unknown timestamps, ordering, other columns', () => {
  it('messages without a timestamp form ONE bucket with key null and label "unknown"', async () => {
    const { db } = await dbWith([null, null, '2025-01-01T00:00:00Z']);
    const r = computeStats(db, { groupBy: 'day' });
    assert.deepEqual(r.rows.map((x) => [x.key, x.label, x.messages, x.firstAt, x.lastAt]), [
      [null, 'unknown', 2, null, null],
      ['2025-01-01', '2025-01-01', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'],
    ]);
  });

  it('ordering is messages DESC, then key ASC with NULL last (also when counts tie)', async () => {
    const { db } = await dbWith(['2025-01-03T00:00:00Z', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', null]);
    assert.deepEqual(keys(computeStats(db, { groupBy: 'day' })), ['2025-01-01', '2025-01-02', '2025-01-03', null]);
    const busy = await dbWith(['2025-01-03T00:00:00Z', '2025-01-03T01:00:00Z', '2025-01-01T00:00:00Z']);
    assert.deepEqual(keys(computeStats(busy.db, { groupBy: 'day' })), ['2025-01-03', '2025-01-01']);
  });

  it('counts conversations, characters and respects the same filters as the other groupings', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('a', [{ role: 'user', text: 'abc', at: '2025-02-01T10:00:00Z' }, { role: 'assistant', text: 'de', at: '2025-02-01T11:00:00Z', model: 'm' }]),
      chat('b', [{ role: 'user', text: 'f', at: '2025-02-01T12:00:00Z' }, { role: 'user', text: 'g', at: '2025-02-02T12:00:00Z', hidden: true }]),
    ]);
    const all = computeStats(db, { groupBy: 'day' });
    assert.deepEqual(all.rows.map((x) => [x.key, x.messages, x.conversations, x.characters]), [['2025-02-01', 3, 2, 6]]);
    const withHidden = computeStats(db, { groupBy: 'day', includeHidden: true });
    assert.deepEqual(withHidden.rows.map((x) => [x.key, x.messages]), [
      ['2025-02-01', 3],
      ['2025-02-02', 1],
    ]);
    const onlyAssistant = computeStats(db, { groupBy: 'day', role: 'assistant' });
    assert.deepEqual(onlyAssistant.rows.map((x) => [x.key, x.messages, x.conversations]), [['2025-02-01', 1, 1]]);
    assert.equal(onlyAssistant.totals.messages, 1);
  });

  it('date bounds are UTC instants and do not depend on tz; the buckets inside the window are still in the requested tz', async () => {
    const { db } = await dbWith(['2025-03-09T04:30:00Z', '2025-03-09T05:30:00Z', '2025-03-08T20:00:00Z']);
    const base = { groupBy: 'day' as const, createdAfter: '2025-03-09T00:00:00Z' };
    const utc = computeStats(db, base);
    const ny = computeStats(db, { ...base, tz: 'America/New_York' });
    assert.equal(utc.totals.messages, 2);
    assert.equal(ny.totals.messages, 2);
    assert.deepEqual(ny.rows.map((x) => [x.key, x.messages]), [
      ['2025-03-08', 1],
      ['2025-03-09', 1],
    ]);
  });

  it('pages over days with limit/offset; nextOffset is null on the last page', async () => {
    const { db } = await dbWith(['2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-03T00:00:00Z', '2025-01-04T00:00:00Z', '2025-01-05T00:00:00Z']);
    const p1 = computeStats(db, { groupBy: 'day', limit: 2 });
    const p2 = computeStats(db, { groupBy: 'day', limit: 2, offset: 2 });
    const p3 = computeStats(db, { groupBy: 'day', limit: 2, offset: 4 });
    assert.deepEqual([keys(p1), p1.nextOffset], [['2025-01-01', '2025-01-02'], 2]);
    assert.deepEqual([keys(p2), p2.nextOffset], [['2025-01-03', '2025-01-04'], 4]);
    assert.deepEqual([keys(p3), p3.nextOffset], [['2025-01-05'], null]);
    assert.equal(p1.totals.messages, 5, 'totals cover every day, not the page');
    assert.equal(computeStats(db, { groupBy: 'day', limit: 5 }).nextOffset, null, 'a page that ends exactly at the last row has no next page');
  });

  it('the tz echo appears only for the day grouping', async () => {
    const { db } = await dbWith(['2025-01-01T00:00:00Z']);
    assert.equal(computeStats(db, { groupBy: 'role', tz: 'Asia/Tokyo' }).tz, undefined);
    assert.equal(computeStats(db, { groupBy: 'day', tz: 'Asia/Tokyo' }).tz, 'Asia/Tokyo');
  });
});

describe('day grouping: tz validation', () => {
  const bad: unknown[] = ['Nope/Zone', 'America/New York', '', 'A'.repeat(100), 'UTC\0', 'Mars/Olympus_Mons', 123, null, {}, ['UTC']];

  it('an invalid or non-string tz is INVALID_ARGUMENT (no zone is guessed)', async () => {
    const { db } = await dbWith(['2025-01-01T00:00:00Z']);
    for (const tz of bad) {
      assert.throws(
        () => computeStats(db, { groupBy: 'day', tz: tz as string }),
        (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && e.details?.['field'] === 'tz',
        `tz = ${JSON.stringify(tz)}`,
      );
    }
  });

  it('an invalid tz is rejected for every groupBy (arguments are validated, not silently ignored)', async () => {
    const { db } = await dbWith(['2025-01-01T00:00:00Z']);
    assert.throws(() => computeStats(db, { groupBy: 'role', tz: 'Nope/Zone' }), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
  });

  it('the error message does not echo the offending value', async () => {
    const { db } = await dbWith(['2025-01-01T00:00:00Z']);
    try {
      computeStats(db, { groupBy: 'day', tz: 'Secret/Zone-Name-123' });
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof GcrError);
      assert.ok(!e.message.includes('Secret'));
    }
  });

  it('valid zones of several shapes are accepted', async () => {
    const { db } = await dbWith(['2025-01-01T00:00:00Z']);
    for (const tz of ['UTC', 'Etc/UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'Etc/GMT-14', 'EST', 'america/new_york']) {
      assert.doesNotThrow(() => computeStats(db, { groupBy: 'day', tz }), tz);
    }
  });
});

describe('day grouping: historical offsets', () => {
  it('uses the offset in force at the instant: Kathmandu was UTC+5:30 in 1985 and UTC+5:45 in 2025', async () => {
    const { db } = await dbWith(['1985-06-01T18:20:00Z', '2025-06-01T18:20:00Z']);
    const r = computeStats(db, { groupBy: 'day', tz: 'Asia/Kathmandu' });
    // 1985: 18:20Z + 5:30 = 23:50 on Jun 1.  2025: 18:20Z + 5:45 = 00:05 on Jun 2.
    assert.deepEqual(r.rows.map((x) => x.key), ['1985-06-01', '2025-06-02']);
  });
});

describe('day grouping: property test against an independent fixed-offset oracle', () => {
  // Zones without DST, so the oracle is plain arithmetic: local date = UTC date of (instant + offset). The instants start in
  // 1996 because these zones changed their standard offset earlier (Kiritimati was UTC-10:40 until 1979 and skipped a day in
  // 1994, Kathmandu was +5:30 until 1986): the next test shows that GCR follows the tz database for such dates.
  const ZONES: ReadonlyArray<[string, number]> = [
    ['UTC', 0],
    ['Asia/Kolkata', 330],
    ['Asia/Kathmandu', 345],
    ['Pacific/Kiritimati', 840],
    ['Etc/GMT+5', -300],
    ['Etc/GMT+12', -720],
  ];

  it('for random instants, every zone buckets exactly like (instant + offset) read as a UTC date', async () => {
    const lo = Date.UTC(1996, 0, 1);
    const hi = Date.UTC(2099, 11, 31);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: lo, max: hi }), { minLength: 1, maxLength: 60 }), async (instants) => {
        const { db, repo } = fresh();
        try {
          await importAll(repo, [chat('p', instants.map((ms) => ({ role: 'user', at: new Date(ms).toISOString() })))]);
          for (const [tz, offsetMin] of ZONES) {
            const expected = new Map<string, number>();
            for (const ms of instants) {
              const day = new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10);
              expected.set(day, (expected.get(day) ?? 0) + 1);
            }
            const r = computeStats(db, { groupBy: 'day', tz, limit: 1000 });
            const got = new Map(r.rows.map((x) => [x.key as string, x.messages] as const));
            assert.deepEqual([...got.entries()].sort(), [...expected.entries()].sort(), `tz ${tz}`);
            assert.equal(r.totals.messages, instants.length);
          }
        } finally {
          db.close();
        }
      }),
      { seed: 20251010, numRuns: 30 },
    );
  });
});
