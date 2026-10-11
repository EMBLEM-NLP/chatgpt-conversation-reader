/**
 * Timestamp formatting for human-readable output (SPEC FR-06, ARCHITECTURE section 7). Pure: no I/O, no clock.
 *
 * Contract
 *  - Timestamps are stored and exchanged as ISO-8601 UTC strings. Everything here is DISPLAY ONLY.
 *  - `null` renders as "unknown" (the source did not say; a time is never invented). A non-null string that is not a
 *    real calendar instant renders as "invalid" (distinguishable from "unknown" so bad data is not mistaken for missing data).
 *  - Output never depends on the host: not on the TZ environment variable, not on LANG/LC_*. The formatter is always
 *    `Intl.DateTimeFormat('en-US', { timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23' })`.
 *
 * Fixed layout of `formatInTimeZone` (always shows the UTC offset, even for UTC):
 *
 *     YYYY-MM-DD HH:mm:ss <name> (UTC+HH:MM)          e.g. "2025-03-09 01:30:00 EST (UTC-05:00)"
 *
 *  - Resolution is whole seconds (fractions are truncated, not rounded; JSON output keeps the full ISO value).
 *  - `<name>` is the ICU short name (en-US) when that is a plain 2-5 letter abbreviation (EST, EDT, PST, GMT, UTC ...).
 *    ICU has no such abbreviation for many zones (it answers "GMT+5:30" for Asia/Kolkata), which would only repeat the
 *    offset, so the zone id exactly as the caller wrote it is used instead ("Asia/Kolkata", "Europe/London" during BST).
 *  - `(UTC+HH:MM)` is the offset in effect AT THAT INSTANT. It is what makes local times unambiguous: the repeated
 *    01:xx hour of a fall-back transition shows once with (UTC-04:00) and once with (UTC-05:00). Historic local-mean-time
 *    offsets that are not whole minutes keep their seconds: "(UTC-04:56:02)".
 *  - The year is the ISO-8601 ASTRONOMICAL year (1 BC is 0000, 2 BC is -0001): four digits, with a leading "-" before year
 *    0000. That is reachable: "0001-01-01T00:00:00Z" (the zero value of Go/.NET time types) is still 1 BC in New York, and a
 *    numeric input offset can move an instant before year 0000.
 *
 * How the offset is obtained: `Intl` is asked only for the LOCAL wall-clock fields of the instant (plus the short name);
 * the offset is then `local - utc`, computed with integer calendar arithmetic. So the offset can never disagree with the
 * printed local time, and the local time minus the printed offset always equals the original instant (property-tested).
 */
import { GcrError } from '../errors.js';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// Calendar arithmetic (proleptic Gregorian). Howard Hinnant's public-domain "days from civil" algorithms, written out
// here so no `Date` (whose parsing of zone-less strings is host-dependent) is involved.
// ---------------------------------------------------------------------------------------------------------------

/** Days since 1970-01-01 for a proleptic Gregorian calendar date. Month is 1..12, day is 1..31 (not validated here). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of `daysFromCivil`. */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

// ---------------------------------------------------------------------------------------------------------------
// Strict ISO-8601 parsing
// ---------------------------------------------------------------------------------------------------------------

/** `YYYY-MM-DDTHH:MM:SS[.f{1,9}]` followed by `Z` or a numeric offset. Anything else (zone-less, date-only, ...) is rejected. */
const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Longest accepted input; stops a hostile megabyte "timestamp" from reaching the regex engine or an output. */
const MAX_ISO_LENGTH = 40;

/**
 * Epoch milliseconds for a strict ISO-8601 instant, or null when the text is not a real calendar instant.
 * Deliberately NOT `Date.parse`: that accepts zone-less strings and interprets them in the HOST time zone.
 * Leap seconds ("23:59:60") are rejected; sub-millisecond digits are truncated.
 */
export function parseIsoInstant(iso: string): number | null {
  if (iso.length > MAX_ISO_LENGTH) return null;
  const m = ISO_INSTANT_RE.exec(iso);
  if (m === null) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, zone] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mis);
  const second = Number(ss);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = frac === undefined ? 0 : Number(frac.padEnd(3, '0').slice(0, 3));
  let offsetMs = 0;
  if (zone !== undefined && zone !== 'Z') {
    const offHour = Number(zone.slice(1, 3));
    const offMinute = Number(zone.slice(4, 6));
    if (offHour > 23 || offMinute > 59) return null;
    offsetMs = (zone.startsWith('-') ? -1 : 1) * (offHour * MS_PER_HOUR + offMinute * MS_PER_MINUTE);
  }
  return daysFromCivil(year, month, day) * MS_PER_DAY + hour * MS_PER_HOUR + minute * MS_PER_MINUTE + second * MS_PER_SECOND + millis - offsetMs;
}

// ---------------------------------------------------------------------------------------------------------------
// Time zone validation and Intl access
// ---------------------------------------------------------------------------------------------------------------

/**
 * Shape of an IANA zone id as written by humans ("America/New_York", "Etc/GMT+5", "UTC"). This is checked BEFORE Intl is
 * asked, for two reasons: (1) it keeps the input small and free of control characters, so it can be echoed safely;
 * (2) modern V8 also accepts fixed-offset zones such as "+05:00" and "-0500", which are not IANA zones and are not
 * available in every Node version GCR supports; rejecting them keeps the behaviour identical everywhere.
 */
const TZ_NAME_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const MAX_TZ_LENGTH = 64;
/** The ICU zone cache never grows past this many entries (callers pass a handful of zones; this is only a safety bound). */
const MAX_CACHED_ZONES = 128;

const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function invalidZone(why: string): GcrError {
  // The offending value is intentionally NOT echoed (log hygiene); the remedy tells the operator what is accepted.
  return new GcrError('INVALID_ARGUMENT', `Invalid time zone: ${why}.`, {
    remedy: 'Pass an IANA time zone id such as "UTC", "America/New_York" or "Asia/Kolkata".',
    details: { option: 'tz' },
  });
}

function zoneFormatter(tz: unknown): Intl.DateTimeFormat {
  if (typeof tz !== 'string') throw invalidZone('expected a string');
  const cached = ZONE_FORMATTERS.get(tz);
  if (cached !== undefined) return cached;
  if (tz.length === 0 || tz.length > MAX_TZ_LENGTH || !TZ_NAME_RE.test(tz)) throw invalidZone('not an IANA zone id');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      calendar: 'gregory',
      numberingSystem: 'latn',
      // h23, not hour12:false: some engines print midnight as "24" with the latter.
      hourCycle: 'h23',
      // Without the era, Intl prints 1 BC as "1" and 2 BC as "2": the year the arithmetic below needs is not recoverable.
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      timeZoneName: 'short',
    });
  } catch (cause) {
    throw new GcrError('INVALID_ARGUMENT', 'Invalid time zone: unknown IANA zone.', {
      remedy: 'Pass an IANA time zone id such as "UTC", "America/New_York" or "Asia/Kolkata".',
      details: { option: 'tz' },
      cause,
    });
  }
  if (ZONE_FORMATTERS.size >= MAX_CACHED_ZONES) ZONE_FORMATTERS.clear();
  ZONE_FORMATTERS.set(tz, formatter);
  return formatter;
}

/** Throws GcrError INVALID_ARGUMENT unless `tz` is a time zone id this runtime knows. "UTC" is always accepted. */
export function assertValidTimeZone(tz: string): void {
  if (tz === 'UTC') return;
  zoneFormatter(tz);
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------------

export const UNKNOWN_TIME = 'unknown';
export const INVALID_TIME = 'invalid';

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `+05:30` / `-04:56:02`. Seconds are printed only when non-zero (historic local mean time). */
function formatOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const abs = Math.abs(offsetSeconds);
  const hh = Math.floor(abs / 3600);
  const mm = Math.floor((abs % 3600) / 60);
  const ss = abs % 60;
  return `UTC${sign}${pad(hh, 2)}:${pad(mm, 2)}${ss === 0 ? '' : `:${pad(ss, 2)}`}`;
}

/** `0005`, `2025`, `-0001` (astronomical numbering); years beyond 9999 keep all their digits. */
function formatYear(year: number): string {
  return year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
}

function layout(year: number, month: number, day: number, hour: number, minute: number, second: number, name: string, offsetSeconds: number): string {
  return `${formatYear(year)}-${pad(month, 2)}-${pad(day, 2)} ${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)} ${name} (${formatOffset(offsetSeconds)})`;
}

/** Plain ICU abbreviations only; "GMT+5:30"-style names carry no information beyond the offset. */
const PLAIN_ABBREVIATION_RE = /^[A-Z]{2,5}$/;

/** Maximum plausible offset magnitude in seconds (UTC+14 / UTC-12 exist; 26h leaves slack for historic LMT). Anything beyond means Intl misbehaved. */
const MAX_ABS_OFFSET_SECONDS = 26 * 3600;

function wholeSecondsFloor(epochMs: number): number {
  return Math.floor(epochMs / MS_PER_SECOND);
}

/**
 * Canonical UTC rendering: `YYYY-MM-DDTHH:mm:ssZ` (milliseconds appended only when non-zero, e.g. `...:05.250Z`).
 * `null` -> "unknown"; a string that is not a real instant -> "invalid".
 */
export function formatUtc(iso: string | null): string {
  if (iso === null) return UNKNOWN_TIME;
  const ms = typeof iso === 'string' ? parseIsoInstant(iso) : null;
  if (ms === null) return INVALID_TIME;
  const secs = wholeSecondsFloor(ms);
  const millis = ms - secs * MS_PER_SECOND;
  const dayCount = Math.floor(secs / 86_400);
  const rem = secs - dayCount * 86_400;
  const { year, month, day } = civilFromDays(dayCount);
  const hms = `${pad(Math.floor(rem / 3600), 2)}:${pad(Math.floor((rem % 3600) / 60), 2)}:${pad(rem % 60, 2)}`;
  return `${formatYear(year)}-${pad(month, 2)}-${pad(day, 2)}T${hms}${millis === 0 ? '' : `.${pad(millis, 3)}`}Z`;
}

/**
 * Wall-clock time of `isoUtc` in the IANA zone `tz`, in the fixed layout documented at the top of this file.
 * Throws GcrError INVALID_ARGUMENT for an unknown zone (checked even when `isoUtc` is null, so a bad option never
 * hides behind missing data). `null` -> "unknown"; non-instant text -> "invalid".
 */
export function formatInTimeZone(isoUtc: string | null, tz: string): string {
  // Validate first (cheap, cached) so the error does not depend on the timestamp.
  const formatter = tz === 'UTC' ? null : zoneFormatter(tz);
  if (isoUtc === null) return UNKNOWN_TIME;
  const ms = typeof isoUtc === 'string' ? parseIsoInstant(isoUtc) : null;
  if (ms === null) return INVALID_TIME;

  const secs = wholeSecondsFloor(ms);
  if (formatter === null) {
    // UTC fast path: pure arithmetic, no Intl needed.
    const dayCount = Math.floor(secs / 86_400);
    const rem = secs - dayCount * 86_400;
    const { year, month, day } = civilFromDays(dayCount);
    return layout(year, month, day, Math.floor(rem / 3600), Math.floor((rem % 3600) / 60), rem % 60, 'UTC', 0);
  }

  const fields = new Map<string, string>();
  for (const part of formatter.formatToParts(secs * MS_PER_SECOND)) fields.set(part.type, part.value);
  // Intl numbers years within their era ("1 BC", "2 BC"); the arithmetic needs astronomical years (1 BC = 0, 2 BC = -1).
  const eraYear = Number(fields.get('year'));
  const year = /^B/i.test(fields.get('era') ?? '') ? 1 - eraYear : eraYear;
  const month = Number(fields.get('month'));
  const day = Number(fields.get('day'));
  const hour = Number(fields.get('hour'));
  const minute = Number(fields.get('minute'));
  const second = Number(fields.get('second'));
  const shortName = fields.get('timeZoneName') ?? '';
  if (![year, month, day, hour, minute, second].every((n) => Number.isInteger(n))) {
    throw new GcrError('INTERNAL_ERROR', 'The runtime could not format a time in the requested time zone.', { details: { option: 'tz' } });
  }

  // offset = (local wall clock read as if it were UTC) - (the real UTC instant), in whole seconds.
  const localAsUtcSeconds = daysFromCivil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
  const offsetSeconds = localAsUtcSeconds - secs;
  if (Math.abs(offsetSeconds) > MAX_ABS_OFFSET_SECONDS) {
    throw new GcrError('INTERNAL_ERROR', 'The runtime returned an implausible UTC offset.', { details: { option: 'tz' } });
  }
  const name = PLAIN_ABBREVIATION_RE.test(shortName) ? shortName : tz;
  return layout(year, month, day, hour, minute, second, name, offsetSeconds);
}
