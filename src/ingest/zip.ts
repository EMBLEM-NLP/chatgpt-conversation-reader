/**
 * Safe, bounded ZIP reader for UNTRUSTED export archives (docs/ARCHITECTURE.md section 5).
 *
 * Security model - read this before changing anything:
 *  - The archive is hostile until proven otherwise. It is NEVER extracted to disk and entry names are NEVER used as
 *    file-system paths: names are only keys for looking up an entry inside this reader.
 *  - All validation runs when the archive is opened and rejects the WHOLE archive (one bad entry poisons it). Only the
 *    central directory is trusted for sizes/offsets, and even that is cross-checked against the local headers.
 *  - Inflation is bounded three ways: the entry's declared size is a hard cap on bytes actually produced, a compression
 *    ratio guard, and a cumulative byte budget for the whole reader. CRC-32 and the final size are verified when a
 *    stream ends; until the AsyncIterable completes WITHOUT throwing, the bytes it delivered are unverified.
 *  - The archive is read with positional reads on a file handle (or from a Buffer in tests); it is never loaded whole.
 *  - Error messages carry the entry INDEX and a stable reason code only. They never echo entry names or file-system paths.
 *
 * Name decoding rule (documented because it is a policy, not a fact): if general-purpose flag bit 11 is set the name MUST
 * be valid UTF-8 (else NAME_ENCODING). If it is clear, the name is decoded as UTF-8 when that is valid and otherwise
 * as IBM code page 437 (the ZIP default), a byte-to-character bijection, so distinct raw names never collapse into the same
 * string. Independently of decoding, the RAW BYTES must pass the same path-shape checks (control bytes, backslash, `..`).
 *
 * Known limits of this reader (also reported in the module notes): multi-disk archives, encryption, Windows reparse points,
 * the PKWARE digital-signature record and bytes trailing a DEFLATE stream (ignored, but CRC/size still bind the output).
 */
import { constants as fsConstants, open as fsOpen } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable, pipeline } from 'node:stream';
import { createInflateRaw, crc32 } from 'node:zlib';
import { GcrError } from '../errors.js';
import { resolveLimits } from './limits.js';
import type { ImportLimits } from './limits.js';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

export interface ZipEntryInfo {
  /** Position in the central directory (0-based); this is the index used in error messages. */
  index: number;
  /** Decoded entry name (untrusted). Use only as a lookup key, never as a file-system path. */
  name: string;
  uncompressedSize: number;
  compressedSize: number;
  /** CRC-32 declared by the central directory (unsigned). */
  crc32: number;
  method: 'store' | 'deflate';
  isDirectory: boolean;
}

/** Stable machine-readable reasons (`error.details.reason`). */
export const ZIP_REASONS = [
  // archive level
  'NOT_A_ZIP',
  'ARCHIVE_TOO_LARGE',
  'SHORT_READ',
  'PARSE_FAILURE',
  'EOCD_NOT_FOUND',
  'EOCD_AMBIGUOUS',
  'MULTIDISK',
  'ZIP64_MISSING',
  'ZIP64_MALFORMED',
  'ZIP64_MISMATCH',
  'CD_OUT_OF_BOUNDS',
  'CD_SIZE_MISMATCH',
  'CD_TRUNCATED',
  'CD_BAD_SIGNATURE',
  'ENTRY_COUNT_MISMATCH',
  'TOO_MANY_ENTRIES',
  // entry level (structure)
  'NAME_EMPTY',
  'NAME_CONTROL_CHAR',
  'NAME_BACKSLASH',
  'NAME_ABSOLUTE',
  'NAME_UNC',
  'NAME_DRIVE_PREFIX',
  'NAME_DOT_DOT',
  'NAME_DOT_SEGMENT',
  'NAME_EMPTY_SEGMENT',
  'NAME_ENCODING',
  'NAME_FORMAT_CHAR',
  'NAME_TOO_LONG',
  'NAME_DUPLICATE',
  'ENCRYPTED',
  'UNSUPPORTED_FLAGS',
  'UNSUPPORTED_METHOD',
  'SYMLINK',
  'SPECIAL_FILE',
  'EXTRA_FIELD_TOO_LARGE',
  'ZIP64_EXTRA_MALFORMED',
  'ENTRY_TOO_LARGE',
  'SIZE_INCONSISTENT',
  'DIRECTORY_WITH_DATA',
  'LOCAL_HEADER_TRUNCATED',
  'LOCAL_HEADER_BAD_SIGNATURE',
  'LOCAL_NAME_MISMATCH',
  'LOCAL_METHOD_MISMATCH',
  'ENTRY_OUT_OF_BOUNDS',
  'ENTRY_OVERLAP',
  // streaming
  'COMPRESSION_RATIO',
  'TOTAL_BUDGET',
  'ENTRY_EXCEEDS_READ_LIMIT',
  'SIZE_EXCEEDS_DECLARED',
  'SIZE_MISMATCH',
  'CRC_MISMATCH',
  'INFLATE_ERROR',
  'DATA_TRUNCATED',
] as const;
export type ZipReason = (typeof ZIP_REASONS)[number];

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOCATOR = 0x07064b50;

const EOCD_FIXED = 22;
const Z64_LOCATOR_SIZE = 20;
const Z64_EOCD_FIXED = 56; // 12-byte prefix + 44-byte mandatory body
const CD_FIXED = 46;
const LOCAL_FIXED = 30;
const MAX_COMMENT = 0xffff;
const U16_SAT = 0xffff;
const U32_SAT = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_PATCHED = 0x0020;
const FLAG_STRONG = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADERS = 0x2000;

/** Entries at or below this size are exempt from the ratio guard: they cannot hurt, and tiny files compress oddly. */
const RATIO_GRACE_BYTES = 64 * 1024;
/** Size of one positional read while streaming entry data. */
const STREAM_READ_BYTES = 256 * 1024;
/**
 * Compressed bytes handed to zlib per write. Node's zlib ignores back-pressure inside a single write, so this bounds
 * the burst of output one write can create (deflate expands at most ~1032:1: 16 KiB in => < 17 MiB out, and far less
 * given the ratio guard).
 */
const INFLATE_FEED_BYTES = 16 * 1024;
const INFLATE_OUT_CHUNK = 64 * 1024;
/** Window used when streaming the central directory (it is never read in one piece). */
const CD_WINDOW_BYTES = 256 * 1024;

const REMEDY = 'Obtain a fresh export directly from the provider; do not import archives from untrusted sources.';

// ---------------------------------------------------------------------------------------------------------------
// Errors (messages: entry index + reason code only; never entry names, never file-system paths)
// ---------------------------------------------------------------------------------------------------------------

function unsafe(reason: ZipReason, entryIndex?: number, extra?: Record<string, unknown>, cause?: unknown): GcrError {
  const where = entryIndex === undefined ? 'archive' : `entry #${entryIndex}`;
  return new GcrError('IMPORT_ZIP_UNSAFE', `ZIP ${where} rejected (${reason}).`, {
    remedy: REMEDY,
    details: { reason, ...(entryIndex === undefined ? {} : { entryIndex }), ...extra },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** `maxBytes` names the per-call cap of readBuffer(), which is not one of the ImportLimits. */
function limitExceeded(reason: ZipReason, limit: keyof ImportLimits | 'maxBytes', max: number, entryIndex?: number, observed?: number): GcrError {
  const where = entryIndex === undefined ? 'archive' : `entry #${entryIndex}`;
  return new GcrError('IMPORT_LIMIT_EXCEEDED', `ZIP ${where} exceeds a safety limit (${reason}, ${limit}).`, {
    remedy: 'The archive is larger or denser than the configured import limits. Raise the limit only if you trust the file.',
    details: {
      reason,
      limit,
      max,
      ...(observed === undefined ? {} : { observed }),
      ...(entryIndex === undefined ? {} : { entryIndex }),
    },
  });
}

function notAZip(): GcrError {
  return new GcrError('IMPORT_UNSUPPORTED_FORMAT', 'The input is not a ZIP archive.', {
    remedy: 'Provide the official export .zip or the extracted conversations.json.',
    details: { reason: 'NOT_A_ZIP' satisfies ZipReason },
  });
}

function invalidArgument(message: string, reason: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', message, { details: { reason } });
}

function errnoCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code: unknown = (e as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Turn anything thrown while validating into a GcrError (a parser bug must never surface as a bare RangeError). */
function normalizeValidationError(e: unknown): GcrError {
  if (e instanceof GcrError) return e;
  return unsafe('PARSE_FAILURE', undefined, undefined, e);
}

/**
 * Make an untrusted/caller-supplied name safe to put in a message: escape everything that is not an ASCII-printable
 * character, letter or digit as \u{hex} and cut it to at most 80 characters. Exported for tests.
 */
export function sanitizeEntryName(name: string, maxChars = 80): string {
  // The limit is what keeps hostile text out of messages, so it must always bite: NaN/Infinity (which compare false against
  // every length and would switch truncation off) fall back to the default; fractions round down; below 0 means nothing fits.
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 80;
  // The text is assembled from whole "pieces" (one code point, or one \u{hex} escape). Truncation keeps only whole
  // pieces, so it can neither leave half of a surrogate pair (an ill-formed string) nor half an escape sequence.
  const keep = Math.max(0, limit - 3); // room for the "..." marker
  let out = '';
  let cut = ''; // longest prefix of whole pieces that still leaves room for the marker
  let cutClosed = false;
  for (const ch of name) {
    const cp = ch.codePointAt(0) as number;
    const plain = (cp >= 0x20 && cp < 0x7f) || (cp > 0x9f && /^[\p{L}\p{N}]$/u.test(ch));
    const piece = plain ? ch : `\\u{${cp.toString(16)}}`;
    // With room for fewer than three characters the marker itself is cut so the result never exceeds the limit.
    if (out.length + piece.length > limit) return limit >= 3 ? cut + '...' : '...'.slice(0, limit);
    out += piece;
    if (!cutClosed) {
      if (out.length <= keep) cut = out;
      else cutClosed = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Byte sources and the read-request coroutine protocol
// ---------------------------------------------------------------------------------------------------------------

interface ByteSource {
  readonly size: number;
  /** Read up to `length` bytes at `offset`; fewer only at end of file. */
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

class BufferSource implements ByteSource {
  readonly size: number;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
    this.size = buf.length;
  }
  readSync(offset: number, length: number): Buffer {
    return this.buf.subarray(offset, offset + length); // subarray clamps to the buffer
  }
  read(offset: number, length: number): Promise<Buffer> {
    return Promise.resolve(this.readSync(offset, length));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FileSource implements ByteSource {
  readonly size: number;
  private readonly handle: FileHandle;
  private closed = false;
  constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }
  async read(offset: number, length: number): Promise<Buffer> {
    if (this.closed) throw invalidArgument('The ZIP reader is closed.', 'READER_CLOSED');
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    try {
      while (got < length) {
        // Positional read: never moves a shared file cursor, so concurrent streams cannot interfere.
        const { bytesRead } = await this.handle.read(buf, got, length - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
    } catch (e) {
      if (this.closed) throw invalidArgument('The ZIP reader is closed.', 'READER_CLOSED');
      throw new GcrError('INTERNAL_ERROR', 'Failed to read the archive file.', {
        remedy: 'Check that the file is readable and still present, then retry.',
        details: { reason: 'READ_FAILED', ...(errnoCode(e) === undefined ? {} : { errno: errnoCode(e) }) },
        cause: e,
      });
    }
    return got === length ? buf : buf.subarray(0, got);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

interface ReadRequest {
  offset: number;
  length: number;
}
/** A validation step that asks its driver for bytes with `yield {offset, length}` and gets the Buffer back. */
type Co<T> = Generator<ReadRequest, T, Buffer>;

/** Drive a coroutine with synchronous reads (Buffer input). */
function runSync<T>(co: Co<T>, src: BufferSource): T {
  let step = co.next();
  while (!step.done) step = co.next(src.readSync(step.value.offset, step.value.length));
  return step.value;
}

/** Drive the SAME coroutine with asynchronous positional file reads. */
async function runAsync<T>(co: Co<T>, src: ByteSource): Promise<T> {
  let step = co.next();
  while (!step.done) step = co.next(await src.read(step.value.offset, step.value.length));
  return step.value;
}

// ---------------------------------------------------------------------------------------------------------------
// Parsed structures
// ---------------------------------------------------------------------------------------------------------------

interface RawEntry {
  index: number;
  /** Copy of the raw name bytes (compared byte-for-byte with the local header's name). */
  nameBytes: Buffer;
  name: string;
  isDirectory: boolean;
  method: 'store' | 'deflate';
  methodId: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** ABSOLUTE offset of the local header (declared offset + prefix delta). */
  localOffset: number;
}

interface ParsedEntry extends RawEntry {
  /** Absolute offset of the first compressed byte. */
  dataStart: number;
}

interface Eocd {
  pos: number;
  disk: number;
  cdDisk: number;
  entriesDisk: number;
  entriesTotal: number;
  cdSize: number;
  cdOffset: number;
  /** The 20 bytes immediately before the EOCD when they are a ZIP64 locator, else null. */
  locator: Buffer | null;
}

interface CdLocation {
  entryCount: number;
  /** Absolute offset of the first central-directory record. */
  cdStart: number;
  cdSize: number;
  /** cdStart - declared offset: bytes in front of the archive (self-extracting stub). */
  delta: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Little helpers
// ---------------------------------------------------------------------------------------------------------------

/** A u64 as a JS number; anything beyond 2^53-1 becomes Infinity so every bounds/limit comparison rejects it. */
function readU64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 1: find and cross-check the end-of-central-directory record
// ---------------------------------------------------------------------------------------------------------------

function* locateEocd(size: number): Co<Eocd> {
  // Look at the last 64 KiB + EOCD (+ room for the ZIP64 locator in front of it).
  const tailLen = Math.min(size, EOCD_FIXED + MAX_COMMENT + Z64_LOCATOR_SIZE);
  const tailStart = size - tailLen;
  const tail: Buffer = tailLen === 0 ? Buffer.alloc(0) : yield { offset: tailStart, length: tailLen };
  if (tail.length !== tailLen) throw unsafe('SHORT_READ');

  // Scan from the end. A candidate is accepted only if its comment length reaches EXACTLY the end of the file: bytes
  // after a real EOCD can only be its own comment, so a signature planted inside a comment (or trailing junk after
  // the archive) is not the end record. If TWO candidates are self-consistent (a crafted fake that also reaches EOF)
  // the file is ambiguous and is rejected rather than guessed at - an attacker must never get to choose the directory.
  let found = -1;
  let candidates = 0;
  for (let p = tailLen - EOCD_FIXED; p >= 0; p--) {
    if (tail[p] !== 0x50 || tail.readUInt32LE(p) !== SIG_EOCD) continue;
    if (p + EOCD_FIXED + tail.readUInt16LE(p + 20) !== tailLen) continue;
    candidates++;
    if (candidates === 1) found = p;
    else break;
  }
  if (candidates > 1) throw unsafe('EOCD_AMBIGUOUS');
  if (candidates === 0) {
    // "Clearly not a zip" (no PK header at all) is a format error; something that starts like a zip but has no valid
    // end record is a damaged/truncated/hostile archive.
    const head: Buffer = size === 0 ? Buffer.alloc(0) : yield { offset: 0, length: Math.min(4, size) };
    const looksZip =
      head.length >= 4 &&
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6) || (head[2] === 7 && head[3] === 8));
    throw looksZip ? unsafe('EOCD_NOT_FOUND') : notAZip();
  }

  const locatorAt = found - Z64_LOCATOR_SIZE;
  const locator = locatorAt >= 0 && tail.readUInt32LE(locatorAt) === SIG_Z64_LOCATOR ? Buffer.from(tail.subarray(locatorAt, found)) : null;
  return {
    pos: tailStart + found,
    disk: tail.readUInt16LE(found + 4),
    cdDisk: tail.readUInt16LE(found + 6),
    entriesDisk: tail.readUInt16LE(found + 8),
    entriesTotal: tail.readUInt16LE(found + 10),
    cdSize: tail.readUInt32LE(found + 12),
    cdOffset: tail.readUInt32LE(found + 16),
    locator,
  };
}

interface Zip64Eocd {
  pos: number;
  /** Bytes in front of the archive according to the locator: actual record position minus the offset it declares. */
  prefix: number;
  disk: number;
  cdDisk: number;
  entriesDisk: number;
  entriesTotal: number;
  cdSize: number;
  cdOffset: number;
}

/** Locate and parse the ZIP64 end record that the locator points at, tolerating a self-extractor prefix. */
function* readZip64Eocd(eocd: Eocd, locator: Buffer): Co<Zip64Eocd> {
  const locatorPos = eocd.pos - Z64_LOCATOR_SIZE;
  const declared = readU64(locator, 8);
  // Only archives that live on one disk are supported.
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) > 1) throw unsafe('MULTIDISK');

  // The record must end exactly where the locator begins (ignoring an optional extensible-data sector that the record
  // itself declares). With a prefix the declared offset is relative to the archive start, so the actual position is
  // derived from the locator; without extensible data that is `locatorPos - 56`. Try that, then the declared offset.
  const guesses = [locatorPos - Z64_EOCD_FIXED, declared];
  for (const pos of guesses) {
    if (!Number.isFinite(pos) || pos < 0 || pos + Z64_EOCD_FIXED > locatorPos) continue;
    if (pos < declared) continue; // a prefix can only push the actual position UP, never below the declared one
    const rec: Buffer = yield { offset: pos, length: Z64_EOCD_FIXED };
    if (rec.length !== Z64_EOCD_FIXED || rec.readUInt32LE(0) !== SIG_Z64_EOCD) continue;
    const recSize = readU64(rec, 4);
    if (!Number.isFinite(recSize) || recSize < Z64_EOCD_FIXED - 12) continue;
    if (pos + 12 + recSize !== locatorPos) continue; // the record + its extensible data must abut the locator
    return {
      pos,
      prefix: pos - declared,
      disk: rec.readUInt32LE(16),
      cdDisk: rec.readUInt32LE(20),
      entriesDisk: readU64(rec, 24),
      entriesTotal: readU64(rec, 32),
      cdSize: readU64(rec, 40),
      cdOffset: readU64(rec, 48),
    };
  }
  throw unsafe('ZIP64_MALFORMED');
}

/** Take the ZIP64 value for a saturated EOCD field; a non-saturated field must agree with the ZIP64 record. */
function mergeField(eocdValue: number, saturated: number, z64Value: number): number {
  if (eocdValue === saturated) return z64Value;
  if (eocdValue !== z64Value) throw unsafe('ZIP64_MISMATCH');
  return eocdValue;
}

function* resolveCentralDirectory(size: number, eocd: Eocd, limits: ImportLimits): Co<CdLocation> {
  const saturated =
    eocd.disk === U16_SAT ||
    eocd.cdDisk === U16_SAT ||
    eocd.entriesDisk === U16_SAT ||
    eocd.entriesTotal === U16_SAT ||
    eocd.cdSize === U32_SAT ||
    eocd.cdOffset === U32_SAT;

  let { disk, cdDisk, entriesDisk, entriesTotal, cdSize, cdOffset } = eocd;
  let endPos = eocd.pos; // actual position where the central directory must end
  let zip64Prefix: number | undefined;
  if (eocd.locator !== null || saturated) {
    // Saturated fields without a ZIP64 record are a malformed ZIP64 structure, not a literal 65535/4 GiB-1.
    if (eocd.locator === null) throw unsafe('ZIP64_MISSING');
    const z = yield* readZip64Eocd(eocd, eocd.locator);
    disk = mergeField(disk, U16_SAT, z.disk);
    cdDisk = mergeField(cdDisk, U16_SAT, z.cdDisk);
    entriesDisk = mergeField(entriesDisk, U16_SAT, z.entriesDisk);
    entriesTotal = mergeField(entriesTotal, U16_SAT, z.entriesTotal);
    cdSize = mergeField(cdSize, U32_SAT, z.cdSize);
    cdOffset = mergeField(cdOffset, U32_SAT, z.cdOffset);
    endPos = z.pos;
    zip64Prefix = z.prefix;
  }

  if (disk !== 0 || cdDisk !== 0 || entriesDisk !== entriesTotal) throw unsafe('MULTIDISK');
  // Count limit is checked BEFORE any entry is parsed.
  if (entriesTotal > limits.maxEntries) throw limitExceeded('TOO_MANY_ENTRIES', 'maxEntries', limits.maxEntries, undefined, entriesTotal);
  if (size < endPos) throw unsafe('CD_OUT_OF_BOUNDS');
  // Declared offset + size must lie inside the archive, in front of the end record(s). `!(a <= b)` also rejects NaN/Infinity.
  if (!(cdOffset + cdSize <= endPos)) throw unsafe('CD_OUT_OF_BOUNDS');
  // Every record is >= 46 bytes and at most 46 + name + extra + comment (all limited): the size must be plausible for
  // the declared count. This also stops a huge cdSize from being used as a read length.
  const maxRecord = CD_FIXED + limits.maxEntryNameBytes + 2 * limits.maxExtraFieldBytes;
  if (cdSize < entriesTotal * CD_FIXED || cdSize > entriesTotal * maxRecord) throw unsafe('CD_SIZE_MISMATCH');

  const cdStart = endPos - cdSize;
  const delta = cdStart - cdOffset;
  // Two independent measurements of the prefix length (ZIP64 locator vs central directory) must agree; if they do not,
  // one of the offsets lies and nothing derived from either can be trusted.
  if (zip64Prefix !== undefined && zip64Prefix !== delta) throw unsafe('ZIP64_MISMATCH');
  return { entryCount: entriesTotal, cdStart, cdSize, delta };
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2: entry names
// ---------------------------------------------------------------------------------------------------------------

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** IBM code page 437, bytes 0x80..0xFF (the ZIP default name encoding). A bijection: no two bytes share a character. */
const CP437_HIGH =
  '\u00C7\u00FC\u00E9\u00E2\u00E4\u00E0\u00E5\u00E7\u00EA\u00EB\u00E8\u00EF\u00EE\u00EC\u00C4\u00C5' +
  '\u00C9\u00E6\u00C6\u00F4\u00F6\u00F2\u00FB\u00F9\u00FF\u00D6\u00DC\u00A2\u00A3\u00A5\u20A7\u0192' +
  '\u00E1\u00ED\u00F3\u00FA\u00F1\u00D1\u00AA\u00BA\u00BF\u2310\u00AC\u00BD\u00BC\u00A1\u00AB\u00BB' +
  '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255D\u255C\u255B\u2510' +
  '\u2514\u2534\u252C\u251C\u2500\u253C\u255E\u255F\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u2567' +
  '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256B\u256A\u2518\u250C\u2588\u2584\u258C\u2590\u2580' +
  '\u03B1\u00DF\u0393\u03C0\u03A3\u03C3\u00B5\u03C4\u03A6\u0398\u03A9\u03B4\u221E\u03C6\u03B5\u2229' +
  '\u2261\u00B1\u2265\u2264\u2320\u2321\u00F7\u2248\u00B0\u2219\u00B7\u221A\u207F\u00B2\u25A0\u00A0';

function decodeCp437(raw: Buffer): string {
  let out = '';
  for (const b of raw) out += b < 0x80 ? String.fromCharCode(b) : (CP437_HIGH[b - 0x80] as string);
  return out;
}

function decodeName(raw: Buffer, utf8Flag: boolean, index: number): string {
  try {
    return UTF8_STRICT.decode(raw);
  } catch {
    // Invalid UTF-8. The spec says flagged names must be UTF-8; unflagged ones fall back to code page 437.
    if (utf8Flag) throw unsafe('NAME_ENCODING', index);
    return decodeCp437(raw);
  }
}

/**
 * Path-shape rules, applied to a string. The same function runs on the raw bytes (as Latin-1, a 1:1 byte view) and on
 * the NFKC form of the decoded name, so look-alike spellings such as a fullwidth dot/solidus pair cannot slip through.
 */
function checkPathShape(s: string, index: number): void {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw unsafe('NAME_CONTROL_CHAR', index); // NUL and every other C0 control + DEL
  if (s.includes('\\')) throw unsafe('NAME_BACKSLASH', index); // Windows separators are never legitimate in a ZIP name
  if (s.startsWith('//')) throw unsafe('NAME_UNC', index);
  if (s.startsWith('/')) throw unsafe('NAME_ABSOLUTE', index);
  if (/^[A-Za-z]:/.test(s)) throw unsafe('NAME_DRIVE_PREFIX', index); // "C:", "C:/x", "C:x"
  // One trailing slash marks a directory; every other segment must be a real, non-special name.
  const body = s.endsWith('/') ? s.slice(0, -1) : s;
  for (const seg of body.split('/')) {
    if (seg === '') throw unsafe('NAME_EMPTY_SEGMENT', index); // "a//b", "a//"
    if (seg === '..') throw unsafe('NAME_DOT_DOT', index);
    if (seg === '.') throw unsafe('NAME_DOT_SEGMENT', index);
  }
}

/** C1 controls, line/paragraph separators and bidi overrides/isolates: invisible or spoofable in logs and UIs. */
const FORBIDDEN_NAME_CHARS = /[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function validateName(raw: Buffer, utf8Flag: boolean, index: number, maxBytes: number): { name: string; dedupeKey: string } {
  if (raw.length > maxBytes) throw limitExceeded('NAME_TOO_LONG', 'maxEntryNameBytes', maxBytes, index, raw.length);
  if (raw.length === 0) throw unsafe('NAME_EMPTY', index);
  // 1) Raw-byte checks first: they do not depend on any decoding choice.
  checkPathShape(raw.toString('latin1'), index);
  // 2) Decode, then check the decoded text.
  const name = decodeName(raw, utf8Flag, index);
  if (FORBIDDEN_NAME_CHARS.test(name)) throw unsafe('NAME_FORMAT_CHAR', index);
  checkPathShape(name.normalize('NFKC'), index);
  // Duplicate detection key: NFC-normalized, case-folded, directory slash ignored. Collisions are rejected, so a
  // case-insensitive or normalizing consumer can never see two different files under one name.
  const folded = (name.endsWith('/') ? name.slice(0, -1) : name).normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
  return { name, dedupeKey: folded };
}

// ---------------------------------------------------------------------------------------------------------------
// Step 3: central directory records
// ---------------------------------------------------------------------------------------------------------------

interface Cursor {
  buf: Buffer;
  bufStart: number;
  pos: number;
  end: number;
}

/** Take exactly `n` bytes at the cursor, refilling the window with a positional read when needed. */
function* take(cur: Cursor, n: number, index: number): Co<Buffer> {
  if (cur.pos + n > cur.end) throw unsafe('CD_TRUNCATED', index);
  let rel = cur.pos - cur.bufStart;
  if (rel < 0 || rel + n > cur.buf.length) {
    const want = Math.min(Math.max(n, CD_WINDOW_BYTES), cur.end - cur.pos);
    const b: Buffer = yield { offset: cur.pos, length: want };
    if (b.length < n) throw unsafe('SHORT_READ', index);
    cur.buf = b;
    cur.bufStart = cur.pos;
    rel = 0;
  }
  const out = cur.buf.subarray(rel, rel + n);
  cur.pos += n;
  return out;
}

interface Zip64Values {
  uncompressedSize: number;
  compressedSize: number;
  localOffset: number;
  diskStart: number;
}

/**
 * Read the 0x0001 extra field for exactly those central-directory fields that are saturated, in the order the format
 * defines. Extra fields are parsed only when ZIP64 values are required: anything else in the block is never interpreted
 * (in particular the Info-ZIP "Unicode path" field is IGNORED, so there is only ever one name for an entry).
 */
function readZip64Extra(extra: Buffer, need: { usize: boolean; csize: boolean; offset: boolean; disk: boolean }, index: number): Partial<Zip64Values> {
  let zip64: Buffer | null = null;
  let pos = 0;
  while (pos < extra.length) {
    if (pos + 4 > extra.length) throw unsafe('ZIP64_EXTRA_MALFORMED', index);
    const id = extra.readUInt16LE(pos);
    const len = extra.readUInt16LE(pos + 2);
    if (pos + 4 + len > extra.length) throw unsafe('ZIP64_EXTRA_MALFORMED', index);
    if (id === 0x0001) {
      if (zip64 !== null) throw unsafe('ZIP64_EXTRA_MALFORMED', index); // two ZIP64 fields: parsers would disagree
      zip64 = extra.subarray(pos + 4, pos + 4 + len);
    }
    pos += 4 + len;
  }
  const wanted = (need.usize ? 8 : 0) + (need.csize ? 8 : 0) + (need.offset ? 8 : 0) + (need.disk ? 4 : 0);
  if (zip64 === null || zip64.length < wanted) throw unsafe('ZIP64_EXTRA_MALFORMED', index);
  const out: Partial<Zip64Values> = {};
  let p = 0;
  if (need.usize) {
    out.uncompressedSize = readU64(zip64, p);
    p += 8;
  }
  if (need.csize) {
    out.compressedSize = readU64(zip64, p);
    p += 8;
  }
  if (need.offset) {
    out.localOffset = readU64(zip64, p);
    p += 8;
  }
  if (need.disk) out.diskStart = zip64.readUInt32LE(p);
  return out;
}

/** Validate one central-directory record (pure function: no I/O). */
function buildEntry(
  fixed: Buffer,
  nameBytes: Buffer,
  extra: Buffer,
  index: number,
  limits: ImportLimits,
  delta: number,
): { entry: RawEntry; dedupeKey: string } {
  const madeByHost = fixed.readUInt16LE(4) >>> 8;
  const flags = fixed.readUInt16LE(8);
  const methodId = fixed.readUInt16LE(10);
  const crc = fixed.readUInt32LE(16);
  const csize32 = fixed.readUInt32LE(20);
  const usize32 = fixed.readUInt32LE(24);
  const disk16 = fixed.readUInt16LE(34);
  const externalAttrs = fixed.readUInt32LE(38);
  const offset32 = fixed.readUInt32LE(42);

  // Encryption of any kind is refused outright: we could not read the data and it is never legitimate in an export.
  if (flags & (FLAG_ENCRYPTED | FLAG_STRONG | FLAG_MASKED_HEADERS)) throw unsafe('ENCRYPTED', index);
  if (flags & FLAG_PATCHED) throw unsafe('UNSUPPORTED_FLAGS', index);
  // Only STORE and DEFLATE. Everything else (bzip2 12, LZMA 14, zstd 93, AES 99, ...) needs code we do not ship.
  if (methodId !== 0 && methodId !== 8) throw unsafe('UNSUPPORTED_METHOD', index, { method: methodId });
  // Unix file type lives in the high 16 bits of the external attributes when the entry was made on a Unix-like host
  // (3 = Unix, 19 = macOS). Links and device nodes are refused even though nothing is ever extracted.
  if (madeByHost === 3 || madeByHost === 19) {
    const type = (externalAttrs >>> 16) & 0o170000;
    if (type === 0o120000) throw unsafe('SYMLINK', index);
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw unsafe('SPECIAL_FILE', index);
  }

  const { name, dedupeKey } = validateName(nameBytes, (flags & FLAG_UTF8) !== 0, index, limits.maxEntryNameBytes);

  const need = { usize: usize32 === U32_SAT, csize: csize32 === U32_SAT, offset: offset32 === U32_SAT, disk: disk16 === U16_SAT };
  const z = need.usize || need.csize || need.offset || need.disk ? readZip64Extra(extra, need, index) : {};
  const uncompressedSize = z.uncompressedSize ?? usize32;
  const compressedSize = z.compressedSize ?? csize32;
  const declaredOffset = z.localOffset ?? offset32;
  const diskStart = z.diskStart ?? disk16;

  if (diskStart !== 0) throw unsafe('MULTIDISK', index);
  if (uncompressedSize > limits.maxEntryUncompressedBytes) {
    throw limitExceeded('ENTRY_TOO_LARGE', 'maxEntryUncompressedBytes', limits.maxEntryUncompressedBytes, index, uncompressedSize);
  }
  const method = methodId === 0 ? 'store' : 'deflate';
  if (method === 'store' && compressedSize !== uncompressedSize) throw unsafe('SIZE_INCONSISTENT', index);
  const isDirectory = name.endsWith('/');
  if (isDirectory && uncompressedSize !== 0) throw unsafe('DIRECTORY_WITH_DATA', index);

  return {
    dedupeKey,
    entry: { index, nameBytes, name, isDirectory, method, methodId, crc32: crc, compressedSize, uncompressedSize, localOffset: declaredOffset + delta },
  };
}

function* parseCentralDirectory(loc: CdLocation, limits: ImportLimits): Co<RawEntry[]> {
  const cur: Cursor = { buf: Buffer.alloc(0), bufStart: 0, pos: loc.cdStart, end: loc.cdStart + loc.cdSize };
  const entries: RawEntry[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < loc.entryCount; index++) {
    // The directory ran out before the EOCD's count was reached.
    if (cur.pos >= cur.end) throw unsafe('ENTRY_COUNT_MISMATCH', index);
    const fixed = yield* take(cur, CD_FIXED, index);
    if (fixed.readUInt32LE(0) !== SIG_CD) throw unsafe('CD_BAD_SIGNATURE', index);
    const nameLen = fixed.readUInt16LE(28);
    const extraLen = fixed.readUInt16LE(30);
    const commentLen = fixed.readUInt16LE(32);
    if (nameLen > limits.maxEntryNameBytes) throw limitExceeded('NAME_TOO_LONG', 'maxEntryNameBytes', limits.maxEntryNameBytes, index, nameLen);
    if (extraLen > limits.maxExtraFieldBytes || commentLen > limits.maxExtraFieldBytes) {
      throw limitExceeded('EXTRA_FIELD_TOO_LARGE', 'maxExtraFieldBytes', limits.maxExtraFieldBytes, index, Math.max(extraLen, commentLen));
    }
    const nameBytes = Buffer.from(yield* take(cur, nameLen, index)); // copy: the window buffer is replaced on refill
    const extra = yield* take(cur, extraLen, index);
    yield* take(cur, commentLen, index); // entry comments are skipped and never interpreted
    const { entry, dedupeKey } = buildEntry(fixed, nameBytes, extra, index, limits, loc.delta);
    const first = seen.get(dedupeKey);
    if (first !== undefined) throw unsafe('NAME_DUPLICATE', index, { firstIndex: first });
    seen.set(dedupeKey, index);
    entries.push(entry);
  }
  // The directory must be consumed exactly: leftover bytes mean the EOCD count understates the real entry count.
  if (cur.pos !== cur.end) throw unsafe('ENTRY_COUNT_MISMATCH');
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 4: cross-check every entry against its local header, then check ranges for overlap
// ---------------------------------------------------------------------------------------------------------------

function* verifyLocalHeaders(entries: RawEntry[], cdStart: number): Co<ParsedEntry[]> {
  // Cheap, I/O-free bounds pass first so absurd (or Infinity) offsets never reach the sort or a read.
  for (const e of entries) {
    if (!(e.localOffset + LOCAL_FIXED + e.nameBytes.length <= cdStart)) throw unsafe('ENTRY_OUT_OF_BOUNDS', e.index);
  }
  const order = [...entries].sort((a, b) => (a.localOffset < b.localOffset ? -1 : a.localOffset > b.localOffset ? 1 : a.index - b.index));

  const parsed = new Map<number, ParsedEntry>();
  let previousEnd = 0; // end of the previous entry's [local header .. compressed data] range
  for (const e of order) {
    const want = LOCAL_FIXED + e.nameBytes.length;
    const lh: Buffer = yield { offset: e.localOffset, length: want };
    if (lh.length < want) throw unsafe('LOCAL_HEADER_TRUNCATED', e.index);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw unsafe('LOCAL_HEADER_BAD_SIGNATURE', e.index);
    const localFlags = lh.readUInt16LE(6);
    if (localFlags & (FLAG_ENCRYPTED | FLAG_STRONG | FLAG_MASKED_HEADERS)) throw unsafe('ENCRYPTED', e.index);
    if (lh.readUInt16LE(8) !== e.methodId) throw unsafe('LOCAL_METHOD_MISMATCH', e.index);
    const localNameLen = lh.readUInt16LE(26);
    // The local name must be byte-identical to the central one, otherwise two parsers could disagree about which
    // file this data belongs to (a classic archive-confusion trick).
    if (localNameLen !== e.nameBytes.length || !lh.subarray(LOCAL_FIXED, want).equals(e.nameBytes)) throw unsafe('LOCAL_NAME_MISMATCH', e.index);

    // Sizes come ONLY from the central directory; the local header's sizes are unreliable with the data-descriptor flag
    // (bit 3), which is supported precisely because we never consult them. The descriptor itself is never read.
    const dataStart = e.localOffset + want + lh.readUInt16LE(28);
    const dataEnd = dataStart + e.compressedSize;
    if (!(dataEnd <= cdStart)) throw unsafe('ENTRY_OUT_OF_BOUNDS', e.index);
    // Sorted by offset, so overlapping ranges (the "overlapping files" bomb: many entries sharing one deflate body) are
    // exactly those whose start precedes the previous end.
    if (e.localOffset < previousEnd) throw unsafe('ENTRY_OVERLAP', e.index);
    previousEnd = dataEnd;
    parsed.set(e.index, { ...e, dataStart });
  }
  return entries.map((e) => parsed.get(e.index) as ParsedEntry); // restore central-directory order
}

function* validateArchive(size: number, limits: ImportLimits): Co<ParsedEntry[]> {
  if (size > limits.maxZipFileBytes) throw limitExceeded('ARCHIVE_TOO_LARGE', 'maxZipFileBytes', limits.maxZipFileBytes, undefined, size);
  const eocd = yield* locateEocd(size);
  const loc = yield* resolveCentralDirectory(size, eocd, limits);
  const raw = yield* parseCentralDirectory(loc, limits);
  return yield* verifyLocalHeaders(raw, loc.cdStart);
}

// ---------------------------------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------------------------------

export class SafeZipReader {
  private readonly source: ByteSource;
  private readonly parsed: ParsedEntry[];
  private readonly byName: Map<string, ParsedEntry>;
  private readonly limits: ImportLimits;
  private closed = false;
  private inflatedTotal = 0;

  private constructor(source: ByteSource, parsed: ParsedEntry[], limits: ImportLimits) {
    this.source = source;
    this.parsed = parsed;
    this.limits = limits;
    this.byName = new Map(parsed.map((e) => [e.name, e]));
  }

  /**
   * Open and fully validate a ZIP file using positional reads (the archive is never read whole).
   * Rejects the whole archive on any structural problem; see ZIP_REASONS.
   */
  static async open(path: string, limits?: Partial<ImportLimits>): Promise<SafeZipReader> {
    const resolved = resolveLimits(limits);
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw invalidArgument('A file path is required.', 'BAD_PATH');
    let handle: FileHandle;
    try {
      // O_NONBLOCK: opening a FIFO/device path read-only would otherwise BLOCK until a writer appears, hanging a worker
      // thread on a hostile path. For regular files the flag has no effect; non-regular files are refused right below.
      handle = await fsOpen(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch (e) {
      const code = errnoCode(e);
      // Never put the path in the message (it can be an absolute private path).
      // Every errno that means "this path, as given by the user, cannot be opened" is an input problem, not an internal
      // one: missing / not a directory / name too long => NOT_FOUND; permission, symlink loop, device without a backend
      // => NOT_READABLE. Only resource exhaustion and genuinely unexpected failures stay INTERNAL_ERROR below.
      const notFound = code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG';
      if (notFound || code === 'EACCES' || code === 'EPERM' || code === 'ELOOP' || code === 'ENXIO' || code === 'ENODEV') {
        throw new GcrError('IMPORT_INPUT_NOT_FOUND', 'The import file does not exist or is not readable.', {
          remedy: 'Check the path and permissions.',
          details: { reason: notFound ? 'NOT_FOUND' : 'NOT_READABLE' },
        });
      }
      if (code === 'EISDIR') throw notAZip();
      throw new GcrError('INTERNAL_ERROR', 'Failed to open the import file.', { details: { reason: 'OPEN_FAILED', ...(code === undefined ? {} : { errno: code }) }, cause: e });
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw notAZip();
      const source = new FileSource(handle, st.size);
      const parsed = await runAsync(validateArchive(st.size, resolved), source);
      return new SafeZipReader(source, parsed, resolved);
    } catch (e) {
      await handle.close().catch(() => undefined);
      throw normalizeValidationError(e);
    }
  }

  /**
   * Open an in-memory archive (tests). The buffer must not be modified while the reader is in use, and STORE entries are
   * delivered as zero-copy views of it (so consumers must not modify the chunks either).
   */
  static fromBuffer(buf: Buffer, limits?: Partial<ImportLimits>): SafeZipReader {
    const resolved = resolveLimits(limits);
    if (!Buffer.isBuffer(buf)) throw invalidArgument('A Buffer is required.', 'BAD_BUFFER');
    const source = new BufferSource(buf);
    try {
      return new SafeZipReader(source, runSync(validateArchive(buf.length, resolved), source), resolved);
    } catch (e) {
      throw normalizeValidationError(e);
    }
  }

  /** All entries in central-directory order (including directories). */
  entries(): ZipEntryInfo[] {
    return this.parsed.map((e) => ({
      index: e.index,
      name: e.name,
      uncompressedSize: e.uncompressedSize,
      compressedSize: e.compressedSize,
      crc32: e.crc32,
      method: e.method,
      isDirectory: e.isDirectory,
    }));
  }

  has(name: string): boolean {
    return typeof name === 'string' && this.byName.has(name);
  }

  /** Total bytes inflated/read through this reader so far (what maxTotalInflatedBytes is measured against). */
  get totalInflatedBytes(): number {
    return this.inflatedTotal;
  }

  /**
   * Stream the uncompressed bytes of one file entry in chunks of bounded size.
   *
   * The iterator throws IMPORT_ZIP_UNSAFE (CRC_MISMATCH / SIZE_MISMATCH / SIZE_EXCEEDS_DECLARED / INFLATE_ERROR) or
   * IMPORT_LIMIT_EXCEEDED (COMPRESSION_RATIO / TOTAL_BUDGET). CRC-32 and the final size can only be known at the end:
   * data already delivered is UNVERIFIED until the iterator finishes without throwing. Consumers must therefore not
   * commit anything derived from it before then (readBuffer() does this for you).
   * Lookup problems (closed reader, unknown name, directory, ratio/budget pre-checks) throw synchronously.
   */
  stream(name: string): AsyncIterable<Buffer> {
    const entry = this.lookupFile(name);
    // Fail fast on honest-but-excessive entries. The real enforcement is on ACTUAL bytes in `run`, which cannot be fooled
    // by a lying header: the declared sizes only ever act as upper bounds.
    if (entry.method === 'deflate' && entry.uncompressedSize > RATIO_GRACE_BYTES && entry.uncompressedSize > entry.compressedSize * this.limits.maxCompressionRatio) {
      throw limitExceeded('COMPRESSION_RATIO', 'maxCompressionRatio', this.limits.maxCompressionRatio, entry.index);
    }
    if (this.inflatedTotal + entry.uncompressedSize > this.limits.maxTotalInflatedBytes) {
      throw limitExceeded('TOTAL_BUDGET', 'maxTotalInflatedBytes', this.limits.maxTotalInflatedBytes, entry.index);
    }
    return this.run(entry);
  }

  /**
   * Read a whole entry into memory, verified (CRC + size) before returning. For small entries only: `maxBytes`
   * defaults to limits.maxElementBytes. Use stream() for conversations files.
   */
  async readBuffer(name: string, maxBytes?: number): Promise<Buffer> {
    const entry = this.lookupFile(name);
    const cap = maxBytes ?? this.limits.maxElementBytes;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) throw invalidArgument('maxBytes must be a positive, finite number.', 'BAD_MAX_BYTES');
    if (entry.uncompressedSize > cap) {
      // Name the limit that actually tripped: the configured default (maxElementBytes) or the caller's explicit cap.
      throw limitExceeded('ENTRY_EXCEEDS_READ_LIMIT', maxBytes === undefined ? 'maxElementBytes' : 'maxBytes', cap, entry.index, entry.uncompressedSize);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of this.stream(name)) {
      chunks.push(chunk);
      total += chunk.length;
    }
    return Buffer.concat(chunks, total);
  }

  /** Release the file handle. Idempotent; streams still running fail with INVALID_ARGUMENT on their next read. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.source.close();
  }

  // ---- internals ------------------------------------------------------------------------------------------

  private lookupFile(name: string): ParsedEntry {
    if (this.closed) throw invalidArgument('The ZIP reader is closed.', 'READER_CLOSED');
    if (typeof name !== 'string') throw invalidArgument('An entry name is required.', 'BAD_ENTRY_NAME');
    const entry = this.byName.get(name);
    if (entry === undefined) throw invalidArgument(`No such entry in the archive: "${sanitizeEntryName(name)}".`, 'ENTRY_NOT_FOUND');
    if (entry.isDirectory) throw invalidArgument('The entry is a directory and has no data.', 'ENTRY_IS_DIRECTORY');
    return entry;
  }

  private charge(bytes: number, entryIndex: number): void {
    this.inflatedTotal += bytes;
    if (this.inflatedTotal > this.limits.maxTotalInflatedBytes) {
      throw limitExceeded('TOTAL_BUDGET', 'maxTotalInflatedBytes', this.limits.maxTotalInflatedBytes, entryIndex);
    }
  }

  private async *run(entry: ParsedEntry): AsyncGenerator<Buffer, void, undefined> {
    const declared = entry.uncompressedSize;
    let produced = 0;
    let crc = 0;
    const output = entry.method === 'store' ? this.slices(entry, STREAM_READ_BYTES) : this.inflated(entry);
    for await (const chunk of output) {
      produced += chunk.length;
      // Hard cap on ACTUAL bytes: the offending chunk is dropped, never delivered, so the consumer can never receive
      // more than the header declared even if the deflate stream is a bomb.
      if (produced > declared) throw unsafe('SIZE_EXCEEDS_DECLARED', entry.index, { declared });
      this.charge(chunk.length, entry.index);
      crc = crc32(chunk, crc);
      yield chunk;
    }
    if (produced !== declared) throw unsafe('SIZE_MISMATCH', entry.index, { declared, produced });
    if (crc >>> 0 !== entry.crc32) throw unsafe('CRC_MISMATCH', entry.index);
  }

  /** The entry's raw (compressed) bytes in slices of at most `sliceBytes`, read lazily with positional reads. */
  private async *slices(entry: ParsedEntry, sliceBytes: number): AsyncGenerator<Buffer, void, undefined> {
    let pos = entry.dataStart;
    let remaining = entry.compressedSize;
    while (remaining > 0) {
      const want = Math.min(remaining, STREAM_READ_BYTES);
      const block = await this.source.read(pos, want);
      if (block.length !== want) throw unsafe('DATA_TRUNCATED', entry.index);
      pos += want;
      remaining -= want;
      for (let o = 0; o < block.length; o += sliceBytes) yield block.subarray(o, Math.min(o + sliceBytes, block.length));
    }
  }

  private async *inflated(entry: ParsedEntry): AsyncGenerator<Buffer, void, undefined> {
    if (entry.compressedSize === 0) return; // an empty entry; a non-zero declared size is caught by SIZE_MISMATCH
    const inflate = createInflateRaw({ chunkSize: INFLATE_OUT_CHUNK });
    const input = Readable.from(this.slices(entry, INFLATE_FEED_BYTES), { objectMode: false });
    // pipeline() forwards a failure of the input (e.g. a read error) to `inflate`, which then throws from the iterator
    // below; its own callback is intentionally empty.
    pipeline(input, inflate, () => undefined);
    try {
      for await (const out of inflate) yield out as Buffer;
    } catch (e) {
      if (e instanceof GcrError) throw e;
      // zlib reports corrupt/truncated deflate data with codes like Z_DATA_ERROR / Z_BUF_ERROR.
      throw unsafe('INFLATE_ERROR', entry.index, errnoCodeOnly(e), e);
    } finally {
      inflate.destroy();
      input.destroy();
    }
  }
}

function errnoCodeOnly(e: unknown): Record<string, unknown> | undefined {
  const code = errnoCode(e);
  return code === undefined ? undefined : { zlibCode: code };
}
