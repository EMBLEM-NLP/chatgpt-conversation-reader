/**
 * Resource limits for ingesting untrusted export files (ZIP archives and JSON streams).
 *
 * Every limit is explicit and finite: there is deliberately no way to disable one (`Infinity`, `0`,
 * negative and `NaN` values are rejected), so a caller who needs more headroom must choose a concrete,
 * larger number. Limits are enforced by `zip.ts` (archive structure + inflation) and `json-stream.ts`
 * (element size). See docs/ARCHITECTURE.md section 5.
 */
import { GcrError } from '../errors.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export interface ImportLimits {
  /** Largest ZIP file (bytes on disk) that will be opened at all. */
  maxZipFileBytes: number;
  /** Largest number of central-directory entries. Checked before any entry is parsed. */
  maxEntries: number;
  /** Largest entry name, in raw bytes (not characters). */
  maxEntryNameBytes: number;
  /** Largest declared AND actual uncompressed size of one entry. */
  maxEntryUncompressedBytes: number;
  /** Cumulative budget of bytes actually inflated/read through ONE reader instance (all entries together). */
  maxTotalInflatedBytes: number;
  /** Largest uncompressed:compressed ratio accepted for one DEFLATE entry (entries up to 64 KiB are exempt). */
  maxCompressionRatio: number;
  /** Largest single top-level JSON element (or NDJSON line) in bytes. */
  maxElementBytes: number;
  /** Largest `extra field` block AND largest entry comment, per central-directory entry, in bytes. */
  maxExtraFieldBytes: number;
}

/**
 * Defaults. The four values below that the architecture document does not pin down were chosen as follows:
 *  - maxZipFileBytes 64 GiB: official exports with media can be many GiB, but a bound keeps all offsets far below 2^53.
 *  - maxExtraFieldBytes 16 KiB: real extra fields (timestamps, ZIP64, Unicode path) are < 1.1 KiB; 16 KiB is generous.
 */
export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxZipFileBytes: 64 * GIB,
  maxEntries: 20_000,
  maxEntryNameBytes: 1024,
  maxEntryUncompressedBytes: 2 * GIB,
  maxTotalInflatedBytes: 8 * GIB,
  maxCompressionRatio: 200,
  maxElementBytes: 256 * MIB,
  maxExtraFieldBytes: 16 * KIB,
});

const LIMIT_KEYS: ReadonlyArray<keyof ImportLimits> = Object.keys(DEFAULT_IMPORT_LIMITS) as Array<keyof ImportLimits>;

/**
 * Merge `partial` over the defaults and validate the result.
 *
 * Why strict: a limit that is silently NaN/0/negative/Infinity compares false (or true) against every size and
 * would disable the guard it is meant to provide, and a misspelled key would leave the default in force while the
 * caller believes a tighter value applies. `undefined` values are treated as "not provided" so callers can pass
 * optional CLI flags straight through.
 */
export function resolveLimits(partial?: Partial<ImportLimits>): ImportLimits {
  const out: ImportLimits = { ...DEFAULT_IMPORT_LIMITS };
  if (partial === undefined) return out;
  if (typeof partial !== 'object' || partial === null) {
    throw new GcrError('INVALID_ARGUMENT', 'Import limits must be an object.', { details: { reason: 'LIMITS_NOT_OBJECT' } });
  }
  for (const key of Object.keys(partial)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      throw new GcrError('INVALID_ARGUMENT', `Unknown import limit "${sanitizeKey(key)}".`, {
        details: { reason: 'UNKNOWN_LIMIT', allowed: [...LIMIT_KEYS] },
      });
    }
  }
  for (const key of LIMIT_KEYS) {
    const value: unknown = partial[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new GcrError('INVALID_ARGUMENT', `Import limit ${key} must be a positive, finite number.`, {
        details: { reason: 'LIMIT_NOT_POSITIVE_FINITE', limit: key },
      });
    }
    out[key] = value;
  }
  return out;
}

/** Keys come from the caller, not from untrusted data, but keep messages single-line and bounded anyway. */
function sanitizeKey(key: string): string {
  return key.slice(0, 40).replace(/[^\x20-\x7e]/g, '?');
}
