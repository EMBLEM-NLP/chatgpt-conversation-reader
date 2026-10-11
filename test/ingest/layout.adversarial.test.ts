/**
 * layout.ts adversarial review (lens: container tricks, resource exhaustion, leaks). Every test here demonstrated a real
 * defect before it was fixed, or pins an edge case the review walked (research sections 11.1/11.2).
 *  - stdin: the buffering must COPY the caller's bytes (a producer that reuses one buffer is normal) and must not keep one
 *    object per chunk (1-byte chunks cost ~100 bytes of heap per input byte, defeating the "maxElementBytes x 4" bound);
 *  - folders: names that ZIP validation refuses (C1 controls, bidi overrides, line separators) are refused here too;
 *  - names that collide after prefixing ("<nested>!/<inner>" versus a literal outer entry) must not merge per-file counts.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { discoverInput } from '../../src/ingest/layout.js';
import { DEFAULT_IMPORT_LIMITS } from '../../src/ingest/limits.js';
import { withTempDir } from '../helpers/tmp.js';
import { writeFileIn } from './import-runner.helpers.test.js';

async function readAll(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
}

function collectGarbage(): boolean {
  try {
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as (() => void) | undefined;
    if (typeof gc !== 'function') return false;
    gc();
    gc();
    return true;
  } catch {
    return false;
  }
}

describe('stdin buffering owns its bytes', () => {
  it('a producer that REUSES one buffer for every chunk (the common read-loop pattern) still yields the right text', async () => {
    const text = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ i, pad: 'x'.repeat(30) })));
    const data = Buffer.from(text);
    async function* reuse(): AsyncGenerator<Buffer, void, undefined> {
      const buf = Buffer.alloc(64);
      for (let o = 0; o < data.length; o += 64) {
        const n = Math.min(64, data.length - o);
        data.copy(buf, 0, o, o + n);
        yield buf.subarray(0, n);
      }
    }
    const d = await discoverInput({ kind: 'stream', stream: reuse(), label: 'x' }, DEFAULT_IMPORT_LIMITS);
    assert.equal((await readAll(d.files[0]?.open() as AsyncIterable<Buffer>)).toString('utf8'), text);
  });

  it('later changes to the caller\'s memory cannot change what was buffered (no references are kept), also for Uint8Array chunks with an offset', async () => {
    const text = '[{"keep":"me"}]';
    const backing = new Uint8Array(text.length + 20);
    backing.set(Buffer.from(text), 10);
    async function* views(): AsyncGenerator<Uint8Array, void, undefined> {
      for (let i = 0; i < text.length; i += 4) yield backing.subarray(10 + i, 10 + Math.min(i + 4, text.length));
    }
    const d = await discoverInput({ kind: 'stream', stream: views(), label: 'x' }, DEFAULT_IMPORT_LIMITS);
    backing.fill(0x58); // the producer scribbles over its buffer afterwards
    assert.equal((await readAll(d.files[0]?.open() as AsyncIterable<Buffer>)).toString('utf8'), text);
  });

  it('a hostile stream of 1-byte chunks costs about its own size, not ~100 bytes of heap per input byte', async (t) => {
    const N = 300_000;
    const big = Buffer.alloc(N, 0x20);
    big[0] = 0x5b; // "[" then blanks: classifies as JSON, parsing is not the subject here
    big[N - 1] = 0x5d;
    const gcWorks = collectGarbage();
    const baseline = process.memoryUsage().heapUsed;
    let atEnd = baseline;
    async function* tiny(): AsyncGenerator<Buffer, void, undefined> {
      for (let i = 0; i < N; i++) {
        if (i === N - 1) {
          collectGarbage();
          atEnd = process.memoryUsage().heapUsed;
        }
        yield big.subarray(i, i + 1);
      }
    }
    await discoverInput({ kind: 'stream', stream: tiny(), label: 'x' }, DEFAULT_IMPORT_LIMITS);
    const heldMiB = (atEnd - baseline) / (1024 * 1024);
    t.diagnostic(`heap held while ${N} one-byte chunks were buffered: ${heldMiB.toFixed(1)} MiB (gc ${gcWorks ? 'on' : 'off'})`);
    if (gcWorks) assert.ok(heldMiB < 12, `${heldMiB.toFixed(0)} MiB held for a ${(N / 1e6).toFixed(1)} MB input`);
  });
});

describe('folder names are held to the ZIP name rules', () => {
  it('C1 controls, bidi overrides and line/paragraph separators in a folder or file name are ignored, never echoed', async () => {
    await withTempDir(async (dir) => {
      await writeFileIn(dir, 'conversations.json', '[]');
      const hostile = ['evil\u009bname.png', 'spoof\u202eexe.png', 'line\u2028sep.png', 'para\u2029sep.png', 'iso\u2066late.png'];
      for (const n of hostile) await writeFileIn(dir, n, 'x');
      // A conversation file hidden inside a folder whose NAME is spoofable is not discovered either.
      await writeFileIn(dir, 'folder\u202egnp/conversations-1.json', '[]');
      await writeFileIn(dir, 'ok-folder/asset.png', 'x');
      const d = await discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual([...d.assetNames], ['ok-folder/asset.png']);
      assert.deepEqual(d.files.map((f) => f.name), ['conversations.json']);
      for (const f of d.files) assert.ok(!/[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(f.name));
    });
  });

  it('ordinary non-ASCII names (accents, CJK, emoji) are still fine', async () => {
    await withTempDir(async (dir) => {
      await writeFileIn(dir, 'conversations.json', '[]');
      await writeFileIn(dir, 'café/日本語-😀.png', 'x');
      const d = await discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS);
      assert.equal(d.assetNames.size, 1);
    });
  });
});

describe('name collisions after prefixing', () => {
  it('an outer entry literally named like "<nested>!/<inner>" is a different file with its own digest line and its own counts', async () => {
    const { buildZip } = await import('../helpers/zip-builder.js');
    const inner = buildZip([{ name: 'conversations.json', data: '[]' }]);
    const outer = buildZip([
      { name: 'conversations.zip', data: inner, method: 'store' },
      { name: 'conversations.zip!/conversations.json', data: '[{}]' },
    ]);
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'o.zip'), outer);
      const d = await discoverInput({ kind: 'path', path: join(dir, 'o.zip') }, DEFAULT_IMPORT_LIMITS);
      try {
        // Both files exist and are readable with their own content, whatever they are called.
        assert.equal(d.files.length, 2);
        const bodies = await Promise.all(d.files.map(async (f) => (await readAll(f.open())).toString('utf8')));
        assert.deepEqual([...bodies].sort(), ['[]', '[{}]']);
        assert.equal(new Set(d.files.map((f) => f.name)).size, 2, 'file names inside one discovery are unique');
      } finally {
        await d.close();
      }
    });
  });
});
