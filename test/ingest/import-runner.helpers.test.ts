/**
 * Shared helpers for the import runner / layout / manual-copy tests. This file is named *.test.ts only because the
 * ownership of the import runner module is limited to test/ingest/import-runner*.test.ts; it declares NO tests of its
 * own (node:test treats a file without tests as an empty, passing file). All data is synthetic.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import type { GcrDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import { GcrError } from '../../src/errors.js';
import { ConversationBuilder, linearConversation, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { ConversationInit } from '../helpers/chatgpt-export-builder.js';
import { claudeLinearConversation, synthUuid } from '../helpers/claude-export-builder.js';
import { buildZip } from '../helpers/zip-builder.js';
import type { ZipEntrySpec } from '../helpers/zip-builder.js';

export const FIXED_NOW = '2026-02-03T04:05:06.007Z';
export const fixedClock = (): string => FIXED_NOW;

export interface TestRepo {
  h: GcrDatabase;
  db: DatabaseSync;
  repo: Repository;
  close: () => void;
}

/** A real Repository over an in-memory database (production code path, no mocks). */
export function freshRepo(): TestRepo {
  const h = openDatabase(':memory:');
  return { h, db: h.db, repo: new Repository(h.db), close: () => closeDatabase(h) };
}

export function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

const DUMPED = ['source_batches', 'source_batch_stats', 'conversations', 'messages', 'conversation_heads', 'messages_fts_docsize', 'conversations_fts_docsize'];

/** sha256 over every imported row AND the raw FTS blocks: equal hashes mean a byte-identical database content. */
export function dbDump(db: DatabaseSync): string {
  const h = createHash('sha256');
  for (const t of DUMPED) {
    h.update(`\n#${t}\n`);
    h.update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  }
  for (const t of ['messages_fts_data', 'conversations_fts_data']) {
    h.update(`\n#${t}\n`);
    for (const r of db.prepare(`SELECT id, block FROM ${t} ORDER BY id`).all()) {
      h.update(String(r['id']));
      const block = r['block'];
      if (block instanceof Uint8Array) h.update(block);
    }
  }
  return h.digest('hex');
}

/** One ChatGPT conversation (root + `pairs` user/assistant turns) with a distinct synthetic id. */
export function chatConv(n: number, over: ConversationInit & { pairs?: number } = {}): ConversationBuilder {
  const { pairs = 1, ...init } = over;
  return linearConversation(pairs, { id: syntheticUuid(n), ...init });
}

/** JSON text of a top-level array of ChatGPT conversations (exact builder text, insertion ordered). */
export function arrayOf(builders: ConversationBuilder[]): string {
  return `[${builders.map((b) => b.text()).join(',')}]`;
}

export function claudeArray(count: number, first = 1): string {
  return JSON.stringify(Array.from({ length: count }, (_, i) => claudeLinearConversation(2, { uuid: synthUuid(first + i) })));
}

/** An in-memory ZIP with the given text entries (deflated unless told otherwise). */
export function zipOf(entries: Record<string, string | Buffer>, method: 'store' | 'deflate' = 'deflate'): Buffer {
  const specs: ZipEntrySpec[] = Object.entries(entries).map(([name, data]) => ({ name, data, method }));
  return buildZip(specs);
}

export async function writeFileIn(dir: string, rel: string, data: string | Buffer): Promise<string> {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return abs;
}

export async function* chunked(data: Buffer | string, size = 7): AsyncGenerator<Buffer, void, undefined> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  for (let o = 0; o < buf.length; o += size) yield buf.subarray(o, Math.min(o + size, buf.length));
}

export function expectCode(code: string, reason?: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code && (reason === undefined || e.details?.['reason'] === reason);
}

/** Everything a GcrError can show a user, as one string (message, remedy, details, envelope). */
export function errorSurface(e: unknown): string {
  if (!(e instanceof GcrError)) return String(e);
  return JSON.stringify({ message: e.message, remedy: e.remedy, details: e.details, envelope: e.toEnvelope() });
}

/** Run `fn` while capturing everything written to stderr (the logger's only sink). */
export async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = '';
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    return { result: await fn(), stderr: buf };
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
}
