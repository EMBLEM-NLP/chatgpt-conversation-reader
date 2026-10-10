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
}

export interface ZipOptions {
  archiveComment?: string;
  /** Leave off the end-of-central-directory record (truncated archive). */
  omitEocd?: boolean;
  /** Claim this many entries in the EOCD regardless of the real count. */
  declaredEntryCount?: number;
  /** Bytes prepended before the first local header (self-extracting stub style). */
  prefix?: Buffer;
}

function toBuf(d: Buffer | string | undefined): Buffer {
  return d === undefined ? Buffer.alloc(0) : typeof d === 'string' ? Buffer.from(d, 'utf8') : d;
}

export function buildZip(entries: ZipEntrySpec[], opts: ZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const prefix = opts.prefix ?? Buffer.alloc(0);
  parts.push(prefix);
  offset += prefix.length;

  for (const e of entries) {
    const name = typeof e.name === 'string' ? Buffer.from(e.name, 'utf8') : e.name;
    const raw = toBuf(e.data);
    const method = e.method ?? 'deflate';
    const compressed = e.rawCompressed ?? (method === 'deflate' ? deflateRawSync(raw) : raw);
    const methodId = e.methodIdOverride ?? (method === 'deflate' ? 8 : 0);
    const crc = e.crcOverride ?? crc32(raw);
    const usize = e.declaredUncompressedSize ?? raw.length;
    const csize = e.declaredCompressedSize ?? compressed.length;
    const flags = (e.encrypted ? 1 : 0) | 0x0800; // bit 11: names are UTF-8
    const extra = e.extra ?? Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(methodId, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(csize >>> 0, 18);
    local.writeUInt32LE(usize >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const localOffset = offset;
    parts.push(local, name, extra, compressed);
    offset += local.length + name.length + extra.length + compressed.length;

    const comment = Buffer.from(e.comment ?? '', 'utf8');
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, v2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(methodId, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(csize >>> 0, 20);
    cd.writeUInt32LE(usize >>> 0, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt16LE(comment.length, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(((e.unixMode ?? 0o100644) << 16) >>> 0, 38);
    cd.writeUInt32LE((e.localOffsetOverride ?? localOffset) >>> 0, 42);
    central.push(cd, name, extra, comment);
  }

  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  parts.push(cdBuf);
  if (!opts.omitEocd) {
    const archiveComment = Buffer.from(opts.archiveComment ?? '', 'utf8');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    const n = opts.declaredEntryCount ?? entries.length;
    eocd.writeUInt16LE(n, 8);
    eocd.writeUInt16LE(n, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(archiveComment.length, 20);
    parts.push(eocd, archiveComment);
  }
  return Buffer.concat(parts);
}

/** A deflate stream that inflates to `size` zero bytes: the classic decompression bomb shape (tiny -> huge). */
export function deflatedZeros(size: number): { compressed: Buffer; size: number } {
  return { compressed: deflateRawSync(Buffer.alloc(size)), size };
}
