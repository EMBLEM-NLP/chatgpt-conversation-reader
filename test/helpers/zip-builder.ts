/**
 * Test-only ZIP writer. Produces well-formed AND deliberately malformed archives in memory so the
 * import hardening (path traversal, symlinks, bombs, lying headers...) can be tested without committing
 * any binary fixtures. Never used by production code.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  /** Entry name. A Buffer allows invalid UTF-8 / NUL bytes. */
  name: string | Buffer;
  data?: Buffer | string;
  method?: 'store' | 'deflate';
  /** Unix st_mode stored in the external attributes (e.g. 0o120777 symlink, 0o100644 file, 0o040755 dir). */
  unixMode?: number;
  /** Sets general-purpose flag bit 0 (traditional encryption); data is left as-is. */
  encrypted?: boolean;
  /** Lie about the CRC in both headers. */
  crcOverride?: number;
  /** Lie about uncompressed size in both headers. */
  declaredUncompressedSize?: number;
  /** Lie about compressed size in both headers. */
  declaredCompressedSize?: number;
  /** Already-compressed bytes (used with method 'deflate' for bombs); `data` is then only used for CRC/size if given. */
  rawCompressed?: Buffer;
  /** Corrupt the central-directory local-header offset. */
  localOffsetOverride?: number;
  /** Compression method id override (e.g. 99 = AES, 12 = bzip2). */
  methodIdOverride?: number;
  extra?: Buffer;
  comment?: string;

  // ---- additive options (all default to the original behaviour) --------------------------------------------
  /** General-purpose flag bit 3: local header carries zero CRC/sizes and a data descriptor follows the data. */
  dataDescriptor?: boolean;
  /** With `dataDescriptor`: omit the optional 0x08074b50 descriptor signature. */
  descriptorWithoutSignature?: boolean;
  /** Clear general-purpose flag bit 11 (names are then in the legacy encoding). Default: bit 11 is set. */
  noUtf8Flag?: boolean;
  /** OR additional bits into the general-purpose flags of BOTH headers (e.g. 0x40 strong encryption, 0x2000). */
  extraFlags?: number;
  /** OR additional bits into the flags of the LOCAL header only. */
  localExtraFlags?: number;
  /** "Version made by" host byte (default 3 = Unix). */
  madeByHost?: number;
  /** Full 32-bit external file attributes; wins over `unixMode`. */
  externalAttrsOverride?: number;
  /** Disk-number-start field of the central directory record (default 0). */
  diskStartOverride?: number;
  /**
   * Store sizes (and optionally the local header offset) in a ZIP64 0x0001 extra field and saturate the 32-bit
   * fields. `true` = sizes only.
   */
  zip64?: boolean | { offset?: boolean };
  /** Replace the payload of the generated ZIP64 extra field (malformed-ZIP64 tests). */
  zip64ExtraPayload?: Buffer;
  /** Saturate the fields but write NO ZIP64 extra field at all. */
  zip64OmitExtra?: boolean;
  /** Name written in the LOCAL header when it should differ from the central one. */
  localName?: string | Buffer;
  /** Method id written in the LOCAL header only. */
  localMethodIdOverride?: number;
  /** Extra field of the LOCAL header only (defaults to `extra`). */
  localExtra?: Buffer;
  /** Local header signature override. */
  localSignatureOverride?: number;
}

export interface Zip64EocdOptions {
  /** Saturate the 16/32-bit EOCD count/size/offset fields so readers must consult the ZIP64 record (default true). */
  saturate?: boolean;
  /** Extensible data sector appended to the ZIP64 record (the record's size field grows to cover it). */
  extensibleData?: Buffer;
  omitLocator?: boolean;
  /** Write the locator but not the record it points at. */
  omitRecord?: boolean;
  recordSizeOverride?: number;
  recordSignatureOverride?: number;
  /** Offset written in the locator (as stored, i.e. archive-relative when `prefixRelativeOffsets`). */
  locatorOffsetOverride?: number;
  locatorDiskOverride?: number;
  totalDisksOverride?: number;
  /** Lie in the ZIP64 record. */
  entriesOverride?: number;
  cdSizeOverride?: number;
  cdOffsetOverride?: number;
  diskOverride?: number;
}

export interface ZipOptions {
  archiveComment?: string;
  /** Leave off the end-of-central-directory record (truncated archive). */
  omitEocd?: boolean;
  /** Claim this many entries in the EOCD regardless of the real count. */
  declaredEntryCount?: number;
  /** Bytes prepended before the first local header (self-extracting stub style). */
  prefix?: Buffer;

  // ---- additive options ------------------------------------------------------------------------------------
  /**
   * With `prefix`: store offsets relative to the start of the ZIP data (excluding the stub), as unprocessed
   * self-extractors do. Default: offsets are absolute file offsets (the original behaviour).
   */
  prefixRelativeOffsets?: boolean;
  /** Write a ZIP64 end-of-central-directory record + locator in front of the EOCD. */
  zip64Eocd?: boolean | Zip64EocdOptions;
  /** Lie about the central directory offset / size in the plain EOCD. */
  cdOffsetOverride?: number;
  cdSizeOverride?: number;
  /** Lie about the EOCD comment length (the comment bytes themselves are unchanged). */
  commentLengthOverride?: number;
  /** Raw bytes appended after the EOCD + comment (junk after the archive). */
  trailingBytes?: Buffer;
  /** Raw bytes between the central directory and the first end record. */
  junkBeforeEocd?: Buffer;
  /** EOCD disk-number fields. */
  eocdDiskOverride?: number;
  eocdCdDiskOverride?: number;
  /** "Entries on this disk" field (default: same as total). */
  entriesThisDiskOverride?: number;
}

function toBuf(d: Buffer | string | undefined): Buffer {
  return d === undefined ? Buffer.alloc(0) : typeof d === 'string' ? Buffer.from(d, 'utf8') : d;
}

function u64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** A single extra-field record: id, size, payload. */
function extraField(id: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(id, 0);
  h.writeUInt16LE(payload.length, 2);
  return Buffer.concat([h, payload]);
}

export function buildZip(entries: ZipEntrySpec[], opts: ZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const prefix = opts.prefix ?? Buffer.alloc(0);
  parts.push(prefix);
  offset += prefix.length;
  // Offsets written into headers: absolute by default, archive-relative for SFX-style tests.
  const relBase = opts.prefixRelativeOffsets === true ? prefix.length : 0;

  for (const e of entries) {
    const name = typeof e.name === 'string' ? Buffer.from(e.name, 'utf8') : e.name;
    const raw = toBuf(e.data);
    const method = e.method ?? 'deflate';
    const compressed = e.rawCompressed ?? (method === 'deflate' ? deflateRawSync(raw) : raw);
    const methodId = e.methodIdOverride ?? (method === 'deflate' ? 8 : 0);
    const crc = e.crcOverride ?? crc32(raw);
    const usize = e.declaredUncompressedSize ?? raw.length;
    const csize = e.declaredCompressedSize ?? compressed.length;
    const flags = (e.encrypted ? 1 : 0) | (e.noUtf8Flag ? 0 : 0x0800) | (e.dataDescriptor ? 0x0008 : 0) | (e.extraFlags ?? 0); // bit 11: names are UTF-8
    const localFlags = flags | (e.localExtraFlags ?? 0);
    const extra = e.extra ?? Buffer.alloc(0);

    const z64 = e.zip64 !== undefined && e.zip64 !== false;
    const z64Offset = typeof e.zip64 === 'object' && e.zip64.offset === true;
    const localName = e.localName === undefined ? name : typeof e.localName === 'string' ? Buffer.from(e.localName, 'utf8') : e.localName;
    const localOffset = offset;

    // Local header. With ZIP64 real writers saturate the sizes and add a 16-byte 0x0001 field; with a data descriptor the
    // CRC and sizes are zero here and appear after the data instead.
    const localZ64 = z64 && e.zip64OmitExtra !== true ? extraField(1, Buffer.concat([u64(e.dataDescriptor ? 0 : usize), u64(e.dataDescriptor ? 0 : csize)])) : Buffer.alloc(0);
    const localExtra = Buffer.concat([localZ64, e.localExtra ?? extra]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE((e.localSignatureOverride ?? 0x04034b50) >>> 0, 0);
    local.writeUInt16LE(z64 ? 45 : 20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(e.localMethodIdOverride ?? methodId, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(e.dataDescriptor ? 0 : crc >>> 0, 14);
    local.writeUInt32LE(e.dataDescriptor ? 0 : z64 ? 0xffffffff : csize >>> 0, 18);
    local.writeUInt32LE(e.dataDescriptor ? 0 : z64 ? 0xffffffff : usize >>> 0, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, localName, localExtra, compressed);
    offset += local.length + localName.length + localExtra.length + compressed.length;

    if (e.dataDescriptor) {
      // Descriptor: optional signature, CRC, then 4-byte sizes (8-byte for ZIP64 entries).
      const sizeBytes = z64 ? 8 : 4;
      const dd = Buffer.alloc((e.descriptorWithoutSignature ? 0 : 4) + 4 + 2 * sizeBytes);
      let p = 0;
      if (!e.descriptorWithoutSignature) {
        dd.writeUInt32LE(0x08074b50, p);
        p += 4;
      }
      dd.writeUInt32LE(crc >>> 0, p);
      p += 4;
      if (z64) {
        dd.writeBigUInt64LE(BigInt(csize), p);
        dd.writeBigUInt64LE(BigInt(usize), p + 8);
      } else {
        dd.writeUInt32LE(csize >>> 0, p);
        dd.writeUInt32LE(usize >>> 0, p + 4);
      }
      parts.push(dd);
      offset += dd.length;
    }

    // Central directory record.
    const cdZ64Payload = e.zip64ExtraPayload ?? Buffer.concat([u64(usize), u64(csize), ...(z64Offset ? [u64(e.localOffsetOverride ?? localOffset - relBase)] : [])]);
    const cdZ64 = z64 && e.zip64OmitExtra !== true ? extraField(1, cdZ64Payload) : Buffer.alloc(0);
    const cdExtra = Buffer.concat([cdZ64, extra]);
    const comment = Buffer.from(e.comment ?? '', 'utf8');
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(((e.madeByHost ?? 3) << 8) | 20, 4); // made by: unix (default), v2.0
    cd.writeUInt16LE(z64 ? 45 : 20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(methodId, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(z64 ? 0xffffffff : csize >>> 0, 20);
    cd.writeUInt32LE(z64 ? 0xffffffff : usize >>> 0, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(cdExtra.length, 30);
    cd.writeUInt16LE(comment.length, 32);
    cd.writeUInt16LE(e.diskStartOverride ?? 0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(e.externalAttrsOverride ?? (((e.unixMode ?? 0o100644) << 16) >>> 0), 38);
    cd.writeUInt32LE(z64Offset ? 0xffffffff : (e.localOffsetOverride ?? localOffset - relBase) >>> 0, 42);
    central.push(cd, name, cdExtra, comment);
  }

  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  parts.push(cdBuf);
  offset += cdBuf.length;
  if (!opts.omitEocd) {
    if (opts.junkBeforeEocd !== undefined) {
      parts.push(opts.junkBeforeEocd);
      offset += opts.junkBeforeEocd.length;
    }
    const n = opts.declaredEntryCount ?? entries.length;
    const z64opts: Zip64EocdOptions | undefined = opts.zip64Eocd === undefined || opts.zip64Eocd === false ? undefined : opts.zip64Eocd === true ? {} : opts.zip64Eocd;
    const saturate = z64opts !== undefined && z64opts.saturate !== false;

    if (z64opts !== undefined) {
      const recordPos = offset;
      const ext = z64opts.extensibleData ?? Buffer.alloc(0);
      if (z64opts.omitRecord !== true) {
        const rec = Buffer.alloc(56);
        rec.writeUInt32LE((z64opts.recordSignatureOverride ?? 0x06064b50) >>> 0, 0);
        rec.writeBigUInt64LE(BigInt(z64opts.recordSizeOverride ?? 44 + ext.length), 4);
        rec.writeUInt16LE(45, 12);
        rec.writeUInt16LE(45, 14);
        rec.writeUInt32LE(z64opts.diskOverride ?? 0, 16);
        rec.writeUInt32LE(0, 20);
        rec.writeBigUInt64LE(BigInt(z64opts.entriesOverride ?? n), 24);
        rec.writeBigUInt64LE(BigInt(z64opts.entriesOverride ?? n), 32);
        rec.writeBigUInt64LE(BigInt(z64opts.cdSizeOverride ?? cdBuf.length), 40);
        rec.writeBigUInt64LE(BigInt(z64opts.cdOffsetOverride ?? cdOffset - relBase), 48);
        parts.push(rec, ext);
        offset += rec.length + ext.length;
      }
      if (z64opts.omitLocator !== true) {
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0);
        loc.writeUInt32LE(z64opts.locatorDiskOverride ?? 0, 4);
        loc.writeBigUInt64LE(BigInt(z64opts.locatorOffsetOverride ?? recordPos - relBase), 8);
        loc.writeUInt32LE(z64opts.totalDisksOverride ?? 1, 16);
        parts.push(loc);
        offset += loc.length;
      }
    }

    const archiveComment = Buffer.from(opts.archiveComment ?? '', 'utf8');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(opts.eocdDiskOverride ?? 0, 4);
    eocd.writeUInt16LE(opts.eocdCdDiskOverride ?? 0, 6);
    eocd.writeUInt16LE(saturate ? 0xffff : opts.entriesThisDiskOverride ?? n, 8);
    eocd.writeUInt16LE(saturate ? 0xffff : n, 10);
    eocd.writeUInt32LE(saturate ? 0xffffffff : (opts.cdSizeOverride ?? cdBuf.length) >>> 0, 12);
    eocd.writeUInt32LE(saturate ? 0xffffffff : (opts.cdOffsetOverride ?? cdOffset - relBase) >>> 0, 16);
    eocd.writeUInt16LE(opts.commentLengthOverride ?? archiveComment.length, 20);
    parts.push(eocd, archiveComment);
    if (opts.trailingBytes !== undefined) parts.push(opts.trailingBytes);
  }
  return Buffer.concat(parts);
}

/** A deflate stream that inflates to `size` zero bytes: the classic decompression bomb shape (tiny -> huge). */
export function deflatedZeros(size: number): { compressed: Buffer; size: number } {
  return { compressed: deflateRawSync(Buffer.alloc(size)), size };
}
