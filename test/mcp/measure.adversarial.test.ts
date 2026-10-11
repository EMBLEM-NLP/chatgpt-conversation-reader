/**
 * Adversarial review, third pass (MCP lens: "unbounded memory/time", "result-size bounds").
 *
 * Defect pinned here: the size cap was enforced by serializing the WHOLE SDK result first (`JSON.stringify`) and only then
 * comparing its length with the cap. A result that is huge when serialized therefore cost seconds of blocked event loop and
 * hundreds of megabytes before it could be reduced, and above V8's string limit (about 512 MB) it threw
 * `RangeError: Invalid string length`, which the registry reported as a generic INTERNAL_ERROR: the call could not be
 * answered at all, whatever the arguments. The realistic trigger is `gcr_get` with `allBranches` on a conversation in which one
 * message has thousands of children (a long regenerate loop): every branch carries that message, and the message lists all its
 * children, so the output grows with the SQUARE of the branch count (4 600 branches: about 1 GB of JSON). The same shape appears
 * in any data in which many list items share a large member.
 *
 * A second, smaller defect lives in the same area: every call armed `AbortSignal.timeout(deadline)`, which cannot be cancelled, so the
 * signal and its timer stayed alive for the whole deadline (30 s) after the call had ended: about 2.8 KB per call, so a client that
 * floods the server holds hundreds of megabytes for half a minute. The deadline timer is now cleared when the call ends.
 *
 * The fix measures with an early exit (`jsonByteSize(value, limit)`: exact up to the limit, `limit + 1` beyond it) and scans
 * shared sub-objects once when it works out which ids belong to dropped items.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import fc from 'fast-check';
import { boundEnvelope, fixPage, jsonByteSize } from '../../src/mcp/envelope.js';
import type { McpEnvelope, Reduction } from '../../src/mcp/envelope.js';
import { existingRegistry } from '../../src/mcp/registry.js';
import type { Extra } from '../../src/mcp/registry.js';
import { createGcrMcpServer } from '../../src/mcp/server.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { connectMem, conversationsJson, createFixture, makeTempDir, removeDir, writeText } from './mcp.helpers.test.js';
import type { MemHarness } from './mcp.helpers.test.js';

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('jsonByteSize', () => {
  it('equals the byte length of JSON.stringify for any JSON-like value (strings with escapes and astral characters, undefined members, nesting)', () => {
    const json: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
      leaf: fc.oneof(fc.string({ unit: 'binary', maxLength: 30 }), fc.integer(), fc.double({ noNaN: false }), fc.boolean(), fc.constant(null), fc.constant(undefined), fc.constant(' "\\\u0000😀')),
      node: fc.oneof({ depthSize: 'small' }, tie('leaf'), fc.array(tie('node'), { maxLength: 5 }), fc.dictionary(fc.string({ maxLength: 8 }), tie('node'), { maxKeys: 5 })),
    })).node;
    fc.assert(
      fc.property(json, (value) => {
        if (value === undefined) return; // JSON.stringify(undefined) is undefined: not a value an envelope can be
        assert.equal(jsonByteSize(value, Number.MAX_SAFE_INTEGER), bytes(value));
      }),
      { seed: 20261011, numRuns: 400 },
    );
  });

  it('beyond the limit it says "more than the limit" and stops early (a value of 100 million characters is not walked)', () => {
    assert.equal(jsonByteSize({ a: 'x'.repeat(100) }, 50), 51);
    assert.equal(jsonByteSize('y'.repeat(100_000_000), 1_000), 1_001, 'a huge string is not copied to be measured');
    const started = process.hrtime.bigint();
    const shared = Array.from({ length: 300_000 }, (_, i) => `id-${i}`);
    assert.equal(jsonByteSize(Array.from({ length: 5_000 }, () => ({ shared })), 10_000), 10_001);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500, 'stopped at the first excess');
  });

  it('is exact at the boundary: the limit itself fits, one byte less does not', () => {
    const value = { a: ['x', 'yy'], b: null };
    const exact = bytes(value);
    assert.equal(jsonByteSize(value, exact), exact);
    assert.equal(jsonByteSize(value, exact - 1), exact);
  });
});

describe('boundEnvelope with a result that is enormous once serialized', () => {
  const PLAN: readonly Reduction[] = [{ kind: 'list', path: ['threads'], fix: fixPage }];

  it('200 items that share a 400 000-id member (about 1 GB of JSON) are reduced, not thrown at', () => {
    const shared = Array.from({ length: 400_000 }, (_, i) => `m${i}`);
    const threads = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, childIds: shared }));
    const env: McpEnvelope = { ok: true, data: { threads, limit: 200, offset: 0, nextOffset: null }, source: [], completeness: 'exported_tree', warnings: [], ids: { messageIds: ['m5', 'm399999', 't3'] }, untrustedContent: true, truncated: false };
    const started = Date.now();
    const out = boundEnvelope(env, PLAN, 200_000);
    assert.ok(bytes(out) <= 200_000, `${bytes(out)} bytes`);
    assert.equal(out.ok, true);
    assert.equal(out.truncated, true);
    assert.ok((out.data?.['threads'] as unknown[]).length < 200);
    assert.ok(out.warnings.some((w) => w.code === 'RESULT_TRUNCATED'));
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  });
});

describe('gcr_get with allBranches on a conversation in which one message has thousands of children', () => {
  const LEAVES = 4_600; // every thread carries the fork message, which lists all 4 600 children: about 1 GB of JSON
  let dir: string;
  let h: MemHarness;
  const id = syntheticUuid(0x32);
  before(async () => {
    dir = await makeTempDir();
    const b = new ConversationBuilder({ id, title: 'regenerate loop' });
    const fork = b.user(b.root(), 'hello');
    for (let i = 0; i < LEAVES; i++) b.assistant(fork, `leaf ${i}`);
    const path = await writeText(dir, join('e', 'conversations.json'), conversationsJson([b]));
    const dbPath = join(dir, 'g.sqlite');
    const gcr = Gcr.open({ dbPath });
    await gcr.importExport({ source: { kind: 'path', path } });
    gcr.close();
    h = await connectMem(dbPath);
  });
  after(async () => {
    await h.close();
    await removeDir(dir);
  });

  it('answers with a reduced result, not INTERNAL_ERROR', async () => {
    const env = await h.env('gcr_get', { conversation: id, allBranches: true, branchPolicy: 'last_child' });
    assert.equal(env.ok, true, `${env.error?.code} ${JSON.stringify(env.error?.details)}`);
    assert.equal(env.truncated, true);
    assert.ok(env.warnings.some((w) => w.code === 'RESULT_TRUNCATED'));
    assert.ok(Buffer.byteLength(JSON.stringify(env)) <= 200_000);
  });

  it('the same call without allBranches is untouched', async () => {
    const env = await h.env('gcr_get', { conversation: id, branchPolicy: 'last_child' });
    assert.equal(env.ok, true, env.error?.message);
  });
});

describe('a finished call releases its deadline timer', () => {
  it('30 000 calls leave no per-call memory behind (the old AbortSignal.timeout kept ~2.8 KB per call alive for 30 s)', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const fx = await createFixture({ graph: false });
    const gcr = Gcr.open({ dbPath: fx.dbPath, readOnly: true, actor: 'mcp' });
    try {
      const server = createGcrMcpServer(gcr, { toolDeadlineMs: 600_000 });
      const registry = existingRegistry(server);
      assert.ok(registry !== undefined);
      // One fresh signal per call, like the SDK's per-request signal (a signal shared by all calls would keep every derived signal).
      const run = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i++) assert.equal((await registry.execute('gcr_doctor', {}, { signal: new AbortController().signal } as unknown as Extra)).ok, true);
      };
      // WeakRefs and finalizers are only processed after the current job: let the event loop turn between collections.
      const settle = async (): Promise<number> => {
        for (let i = 0; i < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          gc();
        }
        return process.memoryUsage().heapUsed;
      };
      await run(500); // warm-up: compile, caches
      const before = await settle();
      await run(30_000);
      const grown = ((await settle()) - before) / 1e6;
      assert.ok(grown < 20, `the heap grew by ${grown.toFixed(1)} MB over 30 000 finished calls`);
    } finally {
      gcr.close();
      await fx.cleanup();
    }
  });
});
