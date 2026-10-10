/**
 * Streaming splitter for large JSON inputs (docs/ARCHITECTURE.md section 5, `json-stream.ts`).
 *
 * `jsonArrayElements` finds the top-level JSON array in a byte stream and yields the RAW TEXT of each element;
 * `jsonLinesElements` does the same for NDJSON. Neither calls `JSON.parse`: the caller parses each element on its
 * own, so one malformed conversation can be skipped without losing the rest of a multi-hundred-MB export.
 *
 * Design notes (why it looks like this):
 *  - It is a BYTE-level state machine. Every structural character of JSON (`[ ] { } , : "` and `\`) is ASCII, and in
 *    UTF-8 no byte of a multi-byte sequence is < 0x80, so a character split across two chunks can never be mistaken
 *    for structure. Text is decoded only once a whole element is available, so splits inside a code point are harmless.
 *  - Memory is bounded by ONE element (plus the current chunk): bytes of the element being scanned are accumulated
 *    in a single reusable buffer, and `maxElementBytes` is enforced WHILE SCANNING (the scanners never read past
 *    elementStart + maxElementBytes), so a hostile never-ending string cannot exhaust memory.
 *  - State is per byte and every error position is an ABSOLUTE stream offset, so output (including which error is
 *    reported, and where) is identical for any chunking down to 1-byte chunks. Errors carry only a byte OFFSET and a
 *    reason code - never input content (log hygiene, NFR-07).
 *  - The splitter validates framing only (strings/escapes, bracket pairing and nesting depth, separators). It does not
 *    validate the inside of an element; `JSON.parse` in the caller does.
 *  - The yielded text is untrusted DATA (AGENTS.md): it is never evaluated or interpreted here.
 */
import { GcrError } from '../errors.js';
import { resolveLimits } from './limits.js';

/** One top-level element (or NDJSON line) exactly as it appeared in the input, minus surrounding whitespace. */
export interface JsonElement {
  /** 0-based position among the yielded elements. */
  index: number;
  /** Raw JSON text decoded as UTF-8 (invalid sequences become U+FFFD). Never includes a BOM. */
  text: string;
  /** Size of the element in the SOURCE bytes (not `text.length`). */
  byteLength: number;
}

export interface JsonLinesOptions {
  /** Largest single element in bytes; defaults to DEFAULT_IMPORT_LIMITS.maxElementBytes. */
  maxElementBytes?: number;
}

export interface JsonStreamOptions extends JsonLinesOptions {
  /** Accept a top-level `{...}` and yield it as one element (some exports are a single object). */
  allowSingleObject?: boolean;
}

/** Stable machine-readable reasons for IMPORT_PARSE_ERROR (`error.details.reason`). */
export const JSON_PARSE_REASONS = [
  'EMPTY_INPUT', //          no value at all (or only BOM/whitespace) where a JSON array was required
  'BAD_BOM', //              input starts with a partial / malformed UTF-8 byte order mark
  'TOP_LEVEL_NOT_ARRAY', //  top-level scalar (or object when allowSingleObject is off)
  'UNEXPECTED_BYTE', //      stray token where none is allowed
  'MISSING_COMMA', //        two values without a separating comma
  'EMPTY_ELEMENT', //        `[1,,2]` / `[,1]`
  'TRAILING_COMMA', //       `[1,]`
  'MISMATCHED_BRACKET', //   `[}` / `{]`
  'DEPTH_EXCEEDED', //       nesting deeper than MAX_JSON_DEPTH
  'UNTERMINATED_STRING',
  'UNTERMINATED_OBJECT',
  'UNTERMINATED_ARRAY',
  'TRAILING_DATA', //        extra data after the closing bracket (or a second value on an NDJSON line)
] as const;
export type JsonParseReason = (typeof JSON_PARSE_REASONS)[number];

/** Maximum container nesting inside one element (the element's own opening bracket is depth 1). */
export const MAX_JSON_DEPTH = 10_000;

// ---- byte constants -----------------------------------------------------------------------------------------
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const COMMA = 0x2c;
const BACKSLASH = 0x5c;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const BOM_BYTES = [0xef, 0xbb, 0xbf] as const;

// ---- scanner phases / value kinds (plain numbers: `enum` is not allowed by erasableSyntaxOnly) -------------
const PH_START = 0; //        array mode: before `[` (BOM + whitespace allowed)
const PH_ARRAY_OPEN = 1; //   just after `[`
const PH_VALUE = 2; //        inside an element
const PH_AFTER_VALUE = 3; //  after an element, expecting `,` or `]`
const PH_AFTER_COMMA = 4; //  after `,`, expecting an element
const PH_DONE = 5; //         after the closing `]` (or after the single object)
const PH_LINE_START = 6; //   NDJSON: between lines
const PH_LINE_AFTER = 7; //   NDJSON: after a value, only blanks until the newline

const VK_CONTAINER = 0; //    `{...}` or `[...]`
const VK_STRING = 1; //       top-level string element
const VK_SCALAR = 2; //       number / true / false / null

/** 1 for bytes that may appear inside a bare scalar token (loose on purpose; JSON.parse validates exactly). */
const SCALAR_BYTE = ((): Uint8Array => {
  const t = new Uint8Array(256);
  for (let c = 0x30; c <= 0x39; c++) t[c] = 1; // 0-9
  for (let c = 0x41; c <= 0x5a; c++) t[c] = 1; // A-Z (E, exponent)
  for (let c = 0x61; c <= 0x7a; c++) t[c] = 1; // a-z (true/false/null, e)
  t[0x2b] = 1; // +
  t[0x2d] = 1; // -
  t[0x2e] = 1; // .
  return t;
})();

/** Bytes that may START a JSON value. Letters other than t/f/n cannot (so `[x]` fails at the first byte). */
function isValueStart(b: number): boolean {
  return (
    b === LBRACE ||
    b === LBRACKET ||
    b === QUOTE ||
    b === 0x2d /* - */ ||
    (b >= 0x30 && b <= 0x39) ||
    b === 0x74 /* t */ ||
    b === 0x66 /* f */ ||
    b === 0x6e /* n */
  );
}

function isBlank(b: number): boolean {
  return b === SPACE || b === TAB || b === LF || b === CR;
}

function parseError(reason: JsonParseReason, byteOffset: number): GcrError {
  return new GcrError('IMPORT_PARSE_ERROR', `Invalid JSON input at byte offset ${byteOffset} (${reason}).`, {
    remedy: 'The file is not a well-formed JSON export (array expected). It may be truncated or corrupted: obtain a fresh export.',
    details: { reason, byteOffset },
  });
}

/**
 * `byteOffset` is ALWAYS elementStart + max: the position of the first byte that does not fit. Defining it by absolute
 * position (not by "where this chunk happened to end") keeps the error identical for every chunking.
 */
function elementTooLarge(index: number, max: number, byteOffset: number): GcrError {
  return new GcrError('IMPORT_LIMIT_EXCEEDED', `JSON element #${index} exceeds the maximum element size of ${max} bytes.`, {
    remedy: 'The export contains a single record larger than the configured element limit; raise maxElementBytes only if the file is trusted.',
    details: { reason: 'ELEMENT_TOO_LARGE', limit: 'maxElementBytes', max, elementIndex: index, byteOffset },
  });
}

/** Accept the Buffer/Uint8Array the type promises, fail loudly (and generically) for anything else (e.g. string chunks). */
function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new GcrError('INVALID_ARGUMENT', 'JSON source chunks must be Buffer or Uint8Array.', { details: { reason: 'BAD_CHUNK_TYPE' } });
}

/** Retain at most this much accumulation buffer between elements so one giant element does not pin memory forever. */
const MAX_RETAINED_ACC_BYTES = 4 * 1024 * 1024;
const INITIAL_ACC_BYTES = 64 * 1024;

type Mode = 'array' | 'lines';

/**
 * Incremental element finder. `feed` and `finish` are SYNC generators so each element can be handed to the consumer
 * as soon as it is complete, without first materializing every element of a (possibly huge) chunk.
 */
class ElementScanner {
  private readonly lines: boolean;
  private readonly allowSingleObject: boolean;
  private readonly maxElementBytes: number;

  private phase: number;
  /** Absolute stream offset of the first byte of the chunk currently being scanned. */
  private base = 0;
  /** 0 = at stream start, 1..2 = inside a BOM, 3 = BOM decision made (present or absent). */
  private bomState = 0;
  private singleObject = false;

  // state of the element currently being scanned
  private valueKind = VK_CONTAINER;
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** Absolute stream offset of the first byte of the current element. */
  private elementStart = 0;
  /** Index (within the current chunk) where the unflushed part of the current element begins. */
  private pieceStart = 0;
  /** Exclusive end index (in the current chunk) of a just-completed element, or -1. */
  private endAt = -1;
  /** Bracket type per depth level: 1 = array, 0 = object. Used to reject `[}` style mismatches. */
  private readonly stack = new Uint8Array(MAX_JSON_DEPTH);

  /** Bytes of the current element carried over from earlier chunks (copied: a source may reuse its buffers). */
  private acc: Buffer = Buffer.alloc(0);
  private accLen = 0;
  private count = 0;

  constructor(mode: Mode, opts: JsonStreamOptions) {
    if (typeof opts !== 'object' || opts === null) {
      throw new GcrError('INVALID_ARGUMENT', 'JSON stream options must be an object.', { details: { reason: 'BAD_OPTIONS' } });
    }
    this.lines = mode === 'lines';
    this.allowSingleObject = mode === 'array' && opts.allowSingleObject === true;
    // Reuse the central validation so a bad option (0, NaN, Infinity, negative) is rejected exactly like ImportLimits.
    this.maxElementBytes = resolveLimits(opts.maxElementBytes === undefined ? {} : { maxElementBytes: opts.maxElementBytes }).maxElementBytes;
    this.phase = this.lines ? PH_LINE_START : PH_START;
  }

  *feed(chunk: Buffer): Generator<JsonElement, void, undefined> {
    const n = chunk.length;
    let i = 0;
    while (i < n) {
      if (this.phase === PH_VALUE) {
        i = this.valueKind === VK_SCALAR ? this.scanScalar(chunk, i) : this.scanCompound(chunk, i);
        if (this.endAt >= 0) {
          const end = this.endAt;
          this.endAt = -1;
          yield this.completeElement(chunk, end);
        }
      } else {
        i = this.scanStructure(chunk, i);
      }
    }
    if (this.phase === PH_VALUE) this.carryOver(chunk, n);
    this.base += n;
  }

  /** Called once at end of input: validates that nothing is left open and flushes an NDJSON scalar at EOF. */
  *finish(): Generator<JsonElement, void, undefined> {
    const at = this.base;
    if (this.bomState === 1 || this.bomState === 2) throw parseError('BAD_BOM', at);
    switch (this.phase) {
      case PH_START:
        throw parseError('EMPTY_INPUT', at);
      case PH_ARRAY_OPEN:
      case PH_AFTER_VALUE:
      case PH_AFTER_COMMA:
        throw parseError('UNTERMINATED_ARRAY', at);
      case PH_VALUE: {
        if (this.lines && this.valueKind === VK_SCALAR) {
          // A bare scalar at the very end of an NDJSON file has no delimiter after it: it is complete.
          yield this.completeElement(null, 0);
          return;
        }
        throw parseError(this.unterminatedReason(), at);
      }
      default:
        return; // PH_DONE, PH_LINE_START, PH_LINE_AFTER: complete
    }
  }

  // ---- structural bytes (between elements) ----------------------------------------------------------------

  /** Consume bytes until an element starts (phase becomes PH_VALUE) or the chunk ends. Returns the next index. */
  private scanStructure(chunk: Buffer, start: number): number {
    const n = chunk.length;
    let i = start;
    while (i < n && this.phase !== PH_VALUE) {
      const b = chunk[i] as number; // i < n, so defined (cast avoids noUncheckedIndexedAccess noise in the hot path)
      const at = this.base + i;

      if (this.bomState < 3) {
        // A UTF-8 BOM is tolerated ONLY as the first three bytes of the stream.
        if (this.bomState === 0 && b !== BOM_BYTES[0]) {
          this.bomState = 3; // no BOM: fall through and treat `b` normally
        } else {
          if (b !== BOM_BYTES[this.bomState]) throw parseError('BAD_BOM', at);
          this.bomState++;
          i++;
          continue;
        }
      }

      switch (this.phase) {
        case PH_START:
          if (isBlank(b)) break;
          if (b === LBRACKET) {
            this.phase = PH_ARRAY_OPEN;
          } else if (b === LBRACE && this.allowSingleObject) {
            this.singleObject = true;
            this.beginValue(b, i);
          } else if (isValueStart(b)) {
            throw parseError('TOP_LEVEL_NOT_ARRAY', at);
          } else {
            throw parseError('UNEXPECTED_BYTE', at);
          }
          break;
        case PH_ARRAY_OPEN:
          if (isBlank(b)) break;
          if (b === RBRACKET) this.phase = PH_DONE;
          else if (b === COMMA) throw parseError('EMPTY_ELEMENT', at);
          else if (isValueStart(b)) this.beginValue(b, i);
          else throw parseError('UNEXPECTED_BYTE', at);
          break;
        case PH_AFTER_VALUE:
          if (isBlank(b)) break;
          if (b === COMMA) this.phase = PH_AFTER_COMMA;
          else if (b === RBRACKET) this.phase = PH_DONE;
          else if (isValueStart(b)) throw parseError('MISSING_COMMA', at);
          else throw parseError('UNEXPECTED_BYTE', at);
          break;
        case PH_AFTER_COMMA:
          if (isBlank(b)) break;
          if (b === RBRACKET) throw parseError('TRAILING_COMMA', at);
          else if (b === COMMA) throw parseError('EMPTY_ELEMENT', at);
          else if (isValueStart(b)) this.beginValue(b, i);
          else throw parseError('UNEXPECTED_BYTE', at);
          break;
        case PH_DONE:
          if (!isBlank(b)) throw parseError('TRAILING_DATA', at);
          break;
        case PH_LINE_START:
          if (isBlank(b)) break; // blank lines are skipped
          if (isValueStart(b)) this.beginValue(b, i);
          else throw parseError('UNEXPECTED_BYTE', at);
          break;
        case PH_LINE_AFTER:
          if (b === LF) this.phase = PH_LINE_START;
          else if (b !== SPACE && b !== TAB && b !== CR) throw parseError('TRAILING_DATA', at); // 2nd value on one line
          break;
        default:
          throw parseError('UNEXPECTED_BYTE', at); // unreachable: PH_VALUE exits the loop
      }
      i++;
    }
    return i;
  }

  /** `b` (at chunk index `i`) is the first byte of an element; the caller advances past it. */
  private beginValue(b: number, i: number): void {
    this.phase = PH_VALUE;
    this.pieceStart = i;
    this.elementStart = this.base + i;
    this.accLen = 0;
    this.endAt = -1;
    this.escaped = false;
    if (b === LBRACE || b === LBRACKET) {
      this.valueKind = VK_CONTAINER;
      this.depth = 1;
      this.stack[0] = b === LBRACKET ? 1 : 0;
      this.inString = false;
    } else if (b === QUOTE) {
      this.valueKind = VK_STRING;
      this.depth = 0;
      this.inString = true;
    } else {
      this.valueKind = VK_SCALAR;
      this.depth = 0;
      this.inString = false;
    }
  }

  // ---- inside an element ------------------------------------------------------------------------------------

  /**
   * Scan a `{...}` / `[...]` / `"..."` element. Tracks string + escape state (so brackets and quotes inside strings are
   * inert) and a bracket stack (so `[}` is rejected and the element ends at exactly the matching close).
   * Sets `endAt` to the exclusive end index when the element completes in this chunk.
   */
  private scanCompound(chunk: Buffer, start: number): number {
    const n = chunk.length;
    const lines = this.lines;
    const stack = this.stack;
    // `start` is always the next UNREAD byte: scanStructure already consumed the element's opening byte.
    let i = start;
    let inString = this.inString;
    let escaped = this.escaped;
    let depth = this.depth;
    // Element size limit, defined by ABSOLUTE position so the outcome cannot depend on chunking: `limitIdx` is the chunk
    // index of the first byte that would be the (max+1)-th byte of this element. We never scan at or beyond it, and if the
    // element is still open when a byte exists there, that byte is the violation (it wins over any structural error
    // that would only show up later in the stream).
    const limitIdx = this.elementStart + this.maxElementBytes - this.base;
    const end = Math.min(n, limitIdx);
    while (i < end) {
      const b = chunk[i] as number;
      if (inString) {
        // NDJSON: a raw LF can never be part of a valid string, even right after a backslash, so check it first.
        if (lines && b === LF) throw parseError('UNTERMINATED_STRING', this.base + i);
        if (escaped) {
          escaped = false; // the byte after a backslash is inert, whatever it is (including `"` and `\`)
        } else if (b === BACKSLASH) {
          escaped = true;
        } else if (b === QUOTE) {
          inString = false;
          if (depth === 0) {
            i++;
            this.endAt = i; // top-level string element is complete
            break;
          }
        }
        i++;
        continue;
      }
      if (b === QUOTE) {
        inString = true;
      } else if (b === LBRACE || b === LBRACKET) {
        // Bound the stack: a hostile `[[[[...` must not grow state without limit.
        if (depth >= MAX_JSON_DEPTH) throw parseError('DEPTH_EXCEEDED', this.base + i);
        stack[depth++] = b === LBRACKET ? 1 : 0;
      } else if (b === RBRACE || b === RBRACKET) {
        if (depth === 0 || stack[depth - 1] !== (b === RBRACKET ? 1 : 0)) throw parseError('MISMATCHED_BRACKET', this.base + i);
        depth--;
        if (depth === 0) {
          i++;
          this.endAt = i; // matching close of the element's opening bracket
          break;
        }
      } else if (lines && b === LF) {
        this.depth = depth;
        this.inString = false;
        throw parseError(this.unterminatedReason(), this.base + i); // NDJSON values cannot span lines
      }
      i++;
    }
    this.inString = inString;
    this.escaped = escaped;
    this.depth = depth;
    if (this.endAt < 0 && limitIdx < n && i >= limitIdx) throw elementTooLarge(this.count, this.maxElementBytes, this.elementStart + this.maxElementBytes);
    return i;
  }

  /** Scan a bare scalar (number/true/false/null). It ends at, but does not consume, the delimiter that follows. */
  private scanScalar(chunk: Buffer, start: number): number {
    const n = chunk.length;
    let i = start; // the first byte was already classified (and consumed) by beginValue
    const limitIdx = this.elementStart + this.maxElementBytes - this.base; // see scanCompound
    while (i < n) {
      const b = chunk[i] as number;
      if (SCALAR_BYTE[b] === 1) {
        if (i >= limitIdx) throw elementTooLarge(this.count, this.maxElementBytes, this.elementStart + this.maxElementBytes);
        i++;
        continue;
      }
      if (isBlank(b) || (!this.lines && (b === COMMA || b === RBRACKET))) {
        this.endAt = i; // exclusive end; delimiter is re-read by scanStructure
        return i;
      }
      throw parseError('UNEXPECTED_BYTE', this.base + i);
    }
    return i;
  }

  /** Why the value currently open cannot be closed (used for EOF and for NDJSON newline-in-value). */
  private unterminatedReason(): JsonParseReason {
    if (this.inString) return 'UNTERMINATED_STRING';
    if (this.valueKind === VK_CONTAINER && this.depth > 0) {
      return this.stack[this.depth - 1] === 0 ? 'UNTERMINATED_OBJECT' : 'UNTERMINATED_ARRAY';
    }
    return 'UNTERMINATED_ARRAY';
  }

  // ---- assembling elements ----------------------------------------------------------------------------------

  /** End of chunk while an element is open: copy its unflushed bytes into `acc` (bounded by maxElementBytes). */
  private carryOver(chunk: Buffer, n: number): void {
    const len = n - this.pieceStart;
    if (len > 0) {
      // The scanners never advance past elementStart + maxElementBytes, so `need` is already bounded by the limit here:
      // buffered data never exceeds maxElementBytes (+ the current chunk) and nothing is copied for an oversized element.
      const need = this.accLen + len;
      this.ensureAcc(need);
      chunk.copy(this.acc, this.accLen, this.pieceStart, n);
      this.accLen = need;
    }
    this.pieceStart = 0;
  }

  private ensureAcc(need: number): void {
    if (this.acc.length >= need) return;
    const cap = Math.max(need, Math.min(Math.max(this.acc.length * 2, INITIAL_ACC_BYTES), this.maxElementBytes));
    const grown = Buffer.allocUnsafe(cap);
    if (this.accLen > 0) this.acc.copy(grown, 0, 0, this.accLen);
    this.acc = grown;
  }

  /** Finish the current element. `chunk` holds its tail (indices pieceStart..end); null at EOF when everything is in `acc`. */
  private completeElement(chunk: Buffer | null, end: number): JsonElement {
    const tail = chunk === null ? 0 : end - this.pieceStart;
    const total = this.accLen + tail; // <= maxElementBytes by construction (see scanCompound / scanScalar)
    let text: string;
    if (this.accLen === 0 && chunk !== null) {
      // Common fast path: the element lies entirely in this chunk; decode straight from it (no copy).
      text = chunk.toString('utf8', this.pieceStart, end);
    } else {
      if (chunk !== null && tail > 0) {
        this.ensureAcc(total);
        chunk.copy(this.acc, this.accLen, this.pieceStart, end);
      }
      text = this.acc.toString('utf8', 0, total);
    }
    this.accLen = 0;
    if (this.acc.length > MAX_RETAINED_ACC_BYTES) this.acc = Buffer.alloc(0);
    this.pieceStart = 0;
    this.phase = this.singleObject ? PH_DONE : this.lines ? PH_LINE_AFTER : PH_AFTER_VALUE;
    return { index: this.count++, text, byteLength: total };
  }
}

/**
 * Yield each top-level element of a JSON array as raw text, without ever holding more than one element.
 *
 * Throws `GcrError`:
 *  - IMPORT_PARSE_ERROR  structurally invalid input (details: `reason`, `byteOffset`; never content)
 *  - IMPORT_LIMIT_EXCEEDED  an element is larger than `maxElementBytes`
 *  - INVALID_ARGUMENT  bad option or a non-binary chunk from `source`
 * Errors thrown by `source` itself (e.g. a ZIP CRC failure surfacing at the end of the entry) propagate unchanged;
 * elements yielded before such an error must be treated as unverified by the caller.
 */
export async function* jsonArrayElements(
  source: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>,
  opts: JsonStreamOptions = {},
): AsyncGenerator<JsonElement, void, undefined> {
  const scanner = new ElementScanner('array', opts);
  for await (const raw of source) {
    const chunk = toBuffer(raw);
    if (chunk.length === 0) continue;
    yield* scanner.feed(chunk);
  }
  yield* scanner.finish();
}

/**
 * NDJSON / JSON Lines: yield each non-blank line (one JSON value per line) as raw text. Blank lines are skipped, CRLF is
 * accepted, and a value that does not end on its own line (unterminated, or a second value on the same line) is an
 * IMPORT_PARSE_ERROR. Same limits and guarantees as `jsonArrayElements`.
 */
export async function* jsonLinesElements(
  source: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>,
  opts: JsonLinesOptions = {},
): AsyncGenerator<JsonElement, void, undefined> {
  const scanner = new ElementScanner('lines', opts);
  for await (const raw of source) {
    const chunk = toBuffer(raw);
    if (chunk.length === 0) continue;
    yield* scanner.feed(chunk);
  }
  yield* scanner.finish();
}
