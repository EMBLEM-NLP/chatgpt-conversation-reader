/**
 * Limits and timeouts: result-size truncation through the real server (correctness, determinism, coherent paging), input
 * bounds against hostile sizes, per-call deadline and cancellation (cooperative, as documented in
 * mcp-sdk-cookbook section 6), and many concurrent calls.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import type { ResultEnvelope } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { defineTool, registerToolEntry } from '../../src/mcp/registry.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { createGcrMcpServer } from '../../src/mcp/server.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';
import { ID, callTool, connectMem, createFixture, envelopeOf } from './mcp.helpers.test.js';

const BIG_CAP = 4_194_304;

describe('result truncation through the real server', () => {
  let fx: Fixture;
  let small: MemHarness;
  let full: MemHarness;
  before(async () => {
    fx = await createFixture({ many: 60, big: { turns: 12, kb: 6 } });
    small = await connectMem(fx.dbPath, { server: { maxResultBytes: 8192 } });
    full = await connectMem(fx.dbPath, { server: { maxResultBytes: BIG_CAP } });
  });
  after(async () => {
    await small.close();
    await full.close();
    await fx.cleanup();
  });

  it('a list page larger than the cap is cut to a prefix that fits, valid JSON, with a warning and a coherent continuation', async () => {
    const res = await small.call('gcr_list', { limit: 200 });
    const text = (res.content[0] as { text: string }).text;
    assert.ok(Buffer.byteLength(text) <= 8192);
    const env = envelopeOf(res);
    assert.equal(env.ok, true);
    assert.equal(env.truncated, true);
    const kept = (env.data?.['items'] as Array<{ conversationId: string }>).length;
    const whole = (await full.env('gcr_list', { limit: 200 })).data?.['items'] as Array<{ conversationId: string }>;
    assert.equal(whole.length, 66);
    assert.ok(kept > 0 && kept < whole.length);
    assert.deepEqual(env.data?.['items'], whole.slice(0, kept), 'a prefix of the untruncated answer');
    assert.equal(env.data?.['nextOffset'], kept);
    assert.equal(env.data?.['total'], 66, 'the total still says how many exist');
    assert.deepEqual(env.warnings.filter((w) => w.code === 'RESULT_TRUNCATED').length, 1);
    assert.equal(env.ids.conversationIds?.length, kept, 'ids cite only what is shown');
  });

  it('following nextOffset collects every item exactly once, in order, however small the pages are forced to be', async () => {
    const whole = ((await full.env('gcr_list', { limit: 200 })).data?.['items'] as Array<{ conversationId: string; accountLabel: string }>).map((i) => i.conversationId);
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const env: Awaited<ReturnType<typeof small.env>> = await small.env('gcr_list', { limit: 200, offset });
      seen.push(...(env.data?.['items'] as Array<{ conversationId: string }>).map((i) => i.conversationId));
      offset = env.data?.['nextOffset'] as number | null;
      pages++;
      assert.ok(pages < 100, 'terminates');
    }
    assert.ok(pages > 1);
    assert.deepEqual(seen, whole);
  });

  it('search is cut the same way and its continuation (offset, never a stale cursor) reaches every hit', async () => {
    const whole = ((await full.env('gcr_search', { query: 'many', limit: 200 })).data?.['items'] as Array<{ conversationId: string; messageId: string }>).map((i) => `${i.conversationId}/${i.messageId}`);
    assert.ok(whole.length >= 100, 'a lot of hits (questions and answers of the 60 extra conversations)');
    const seen: string[] = [];
    let offset: number | null = 0;
    let truncatedPages = 0;
    while (offset !== null) {
      const env: Awaited<ReturnType<typeof small.env>> = await small.env('gcr_search', { query: 'many', limit: 200, offset });
      seen.push(...(env.data?.['items'] as Array<{ conversationId: string; messageId: string }>).map((i) => `${i.conversationId}/${i.messageId}`));
      assert.equal('nextCursor' in (env.data ?? {}) && env.truncated, false, 'a cursor is never left on a cut page');
      if (env.truncated) truncatedPages++;
      offset = env.data?.['nextOffset'] as number | null;
    }
    assert.ok(truncatedPages > 0);
    assert.deepEqual(seen, whole);
  });

  it('truncation is deterministic: the same call twice gives byte-identical text', async () => {
    const a = (await small.call('gcr_list', { limit: 200 })).content[0];
    const b = (await small.call('gcr_list', { limit: 200 })).content[0];
    assert.deepEqual(a, b);
  });

  it('a thread larger than the cap keeps its first messages, says how many it dropped, and cites only the ids it shows', async () => {
    const whole = await full.env('gcr_thread', { conversation: ID.big });
    const wholeMessages = (whole.data?.['messages'] as Array<{ id: string }>).length;
    assert.equal(wholeMessages, 24);
    const env = await small.env('gcr_thread', { conversation: ID.big });
    assert.equal(env.truncated, true);
    const messages = env.data?.['messages'] as Array<{ id: string }>;
    assert.ok(messages.length < wholeMessages);
    assert.deepEqual(messages, (whole.data?.['messages'] as unknown[]).slice(0, messages.length));
    const shown = JSON.stringify(env.data);
    for (const m of messages) assert.ok(env.ids.messageIds?.includes(m.id), 'every shown message is cited');
    for (const id of env.ids.messageIds ?? []) assert.ok(shown.includes(id), `${id} is cited, so it must still occur in the data (shown message or currentNodeId/branchId)`);
    const dropped = (whole.data?.['messages'] as Array<{ id: string }>).slice(messages.length).map((m) => m.id).filter((id) => !shown.includes(id));
    assert.ok(dropped.length > 0);
    for (const id of dropped) assert.ok(!env.ids.messageIds?.includes(id), `${id} was dropped and is not cited`);
    assert.equal((env.data?.['conversation'] as { conversationId: string }).conversationId, ID.big, 'the rest of the result is intact');
    const warning = env.warnings.find((w) => w.code === 'RESULT_TRUNCATED');
    assert.match(warning?.message ?? '', new RegExp(`data\\.messages: kept ${messages.length} of ${wholeMessages} items`));
  });

  it('gcr_get cuts the primary thread the same way (and drops whole branches first with allBranches)', async () => {
    const env = await small.env('gcr_get', { conversation: ID.big });
    assert.equal(env.truncated, true);
    const thread = env.data?.['thread'] as { messages: unknown[]; branchId: string };
    assert.ok(thread.messages.length < 24);
    const all = await small.env('gcr_get', { conversation: ID.big, allBranches: true });
    assert.equal(all.ok, true);
    assert.equal(all.truncated, true);
  });

  it('a graph answer drops edges before nodes and never leaves an edge pointing at a dropped node', async () => {
    const env = await small.env('gcr_graph_query', { term: 'many', depth: 3, maxNodes: 200 });
    assert.equal(env.ok, true);
    const nodes = new Set((env.data?.['nodes'] as Array<{ id: string }>).map((n) => n.id));
    for (const e of env.data?.['edges'] as Array<{ src: string; dst: string }>) assert.ok(nodes.has(e.src) && nodes.has(e.dst));
  });

  it('what fits is returned untouched: no flag, no warning', async () => {
    const env = await small.env('gcr_list', { limit: 2 });
    assert.equal(env.truncated, false);
    assert.deepEqual(env.warnings.filter((w) => w.code === 'RESULT_TRUNCATED'), []);
  });
});

describe('the default cap is 200 000 bytes', () => {
  it('a 400 KB thread is cut under the default cap, and the whole JSON-RPC frame stays small', async () => {
    const fx = await createFixture({ big: { turns: 25, kb: 16 }, graph: false });
    const h = await connectMem(fx.dbPath);
    try {
      const res = await h.call('gcr_thread', { conversation: ID.big });
      const text = (res.content[0] as { text: string }).text;
      assert.ok(Buffer.byteLength(text) <= 200_000, `text is ${Buffer.byteLength(text)} bytes`);
      assert.ok(Buffer.byteLength(text) > 150_000, 'but it is not cut more than needed');
      const env = envelopeOf(res);
      assert.equal(env.truncated, true);
      // the frame carries the envelope twice (text + structuredContent)
      const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, result: res });
      assert.ok(Buffer.byteLength(frame) < 2.6 * 200_000, `frame ${Buffer.byteLength(frame)}`);
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });
});

describe('GCR_MCP_MAX_RESULT_BYTES', () => {
  it('configures the cap of a server built without an explicit option, and a bad value stops the build', async () => {
    const fx = await createFixture({ many: 40, graph: false });
    const saved = process.env['GCR_MCP_MAX_RESULT_BYTES'];
    try {
      process.env['GCR_MCP_MAX_RESULT_BYTES'] = '9000';
      const h = await connectMem(fx.dbPath);
      try {
        const env = await h.env('gcr_list', { limit: 200 });
        assert.equal(env.truncated, true);
        const text = JSON.stringify(env);
        assert.ok(Buffer.byteLength(text) <= 9000);
      } finally {
        await h.close();
      }
      process.env['GCR_MCP_MAX_RESULT_BYTES'] = 'lots';
      const gcr = Gcr.open({ dbPath: fx.dbPath, readOnly: true });
      try {
        assert.throws(() => createGcrMcpServer(gcr, {}), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
      } finally {
        gcr.close();
      }
    } finally {
      if (saved === undefined) delete process.env['GCR_MCP_MAX_RESULT_BYTES'];
      else process.env['GCR_MCP_MAX_RESULT_BYTES'] = saved;
      await fx.cleanup();
    }
  });

  it('an explicit option wins over the environment and is range-checked', async () => {
    const fx = await createFixture({ graph: false });
    const gcr = Gcr.open({ dbPath: fx.dbPath, readOnly: true });
    try {
      for (const bad of [0, 8191, 4_194_305, 1.5, Number.NaN]) assert.throws(() => createGcrMcpServer(gcr, { maxResultBytes: bad }), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', String(bad));
      assert.throws(() => createGcrMcpServer(gcr, { toolDeadlineMs: 0 }), GcrError);
      assert.throws(() => createGcrMcpServer(gcr, { importDeadlineMs: 5 }), GcrError);
    } finally {
      gcr.close();
      await fx.cleanup();
    }
  });
});

describe('hostile input sizes are stopped by the schema layer, cheaply', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture({ graph: false });
    h = await connectMem(fx.dbPath);
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  it('a 2 MB query, a 100 000 element array and a 50 000 key object are rejected with a small, bounded answer', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['gcr_search', { query: 'q'.repeat(2_000_000) }],
      ['gcr_graph_query', { term: 'x', kinds: Array.from({ length: 100_000 }, () => 'url') }],
      ['gcr_list', Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i]))],
      ['gcr_get', { conversation: { nested: { deeper: { deepest: [1, 2, 3] } } } }],
      ['gcr_audit', { checks: Array.from({ length: 10_000 }, () => 'empty') }],
    ];
    for (const [tool, args] of cases) {
      const res = await h.call(tool, args);
      const env = envelopeOf(res);
      assert.equal(env.error?.code, 'INVALID_ARGUMENT', tool);
      assert.ok(Buffer.byteLength((res.content[0] as { text: string }).text) < 6_000, `${tool}: the answer is small`);
      assert.ok(((env.error?.details?.['issues'] as unknown[]) ?? []).length <= 10, 'at most ten issues are listed');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Deadline and cancellation (a purpose-built tool on the same registry/dispatch that every real tool uses)
// ---------------------------------------------------------------------------------------------------------------

function okResult(data: Record<string, unknown>): ResultEnvelope<unknown> {
  return { ok: true, data, source: [], completeness: 'unknown', warnings: [], ids: {}, untrustedContent: false };
}

interface SlowRig {
  client: Client;
  server: McpServer;
  signals: AbortSignal[];
  clientErrors: Error[];
  close: () => Promise<void>;
}

async function slowRig(deadlineMs?: number): Promise<SlowRig> {
  const server = new McpServer({ name: 'slow-rig', version: '0' });
  const signals: AbortSignal[] = [];
  registerToolEntry(
    server,
    defineTool({
      name: 'rig_wait',
      title: 'Wait',
      description: 'A test tool that waits cooperatively. UNTRUSTED DATA none.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.strictObject({ ms: z.number().int().min(0).max(10_000), steps: z.number().int().min(0).max(10).optional() }),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      run: async (a, ctx) => {
        signals.push(ctx.signal);
        for (let i = 1; i <= (a.steps ?? 0); i++) ctx.reportProgress(i, a.steps, `step ${i}`);
        await ctx.abortable(new Promise<void>((resolve) => setTimeout(resolve, a.ms).unref()));
        return okResult({ waited: a.ms });
      },
    }),
    { maxResultBytes: 200_000, defaultDeadlineMs: 30_000 },
  );
  registerToolEntry(
    server,
    defineTool({
      name: 'rig_busy',
      title: 'Busy',
      description: 'A test tool that blocks the thread (synchronous work). UNTRUSTED DATA none.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.strictObject({ ms: z.number().int().min(0).max(2000) }),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      run: (a, ctx) => {
        signals.push(ctx.signal);
        const until = Date.now() + a.ms;
        while (Date.now() < until) {
          /* synchronous work cannot observe cancellation: that is the documented limit */
        }
        return okResult({ busy: a.ms });
      },
    }),
    { maxResultBytes: 200_000, defaultDeadlineMs: 30_000 },
  );
  registerToolEntry(
    server,
    defineTool({
      name: 'rig_throw',
      title: 'Throw',
      description: 'A test tool that throws something that is not a GcrError. UNTRUSTED DATA none.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.strictObject({}),
      run: () => {
        throw new Error('ENOENT: no such file /home/alice/secret-conversation.json while reading "my password is hunter2"');
      },
    }),
    { maxResultBytes: 200_000, defaultDeadlineMs: 30_000 },
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rig-client', version: '0' });
  const clientErrors: Error[] = [];
  client.onerror = (e) => clientErrors.push(e);
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.listTools();
  return { client, server, signals, clientErrors, close: async () => { await client.close(); await server.close(); } };
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('deadline and cancellation', () => {
  it('the server-side deadline ends a waiting call with an INTERNAL_ERROR envelope that says so, long before the client would give up', async () => {
    const rig = await slowRig(150);
    try {
      const started = Date.now();
      const env = envelopeOf(await callTool(rig.client, 'rig_wait', { ms: 8000 }));
      assert.ok(Date.now() - started < 2500, 'returned at the deadline, not after the wait');
      assert.equal(env.ok, false);
      assert.equal(env.error?.code, 'INTERNAL_ERROR');
      assert.equal(env.error?.details?.['reason'], 'deadline_exceeded');
      assert.equal(env.error?.details?.['deadlineMs'], 150);
      assert.match(env.error?.remedy ?? '', /may still complete in the background/);
      assert.equal(rig.signals[0]?.aborted, true, 'the handler saw its signal fire');
    } finally {
      await rig.close();
    }
  });

  it('a call that finishes within the deadline is untouched by it', async () => {
    const rig = await slowRig(2000);
    try {
      const env = envelopeOf(await callTool(rig.client, 'rig_wait', { ms: 30 }));
      assert.equal(env.ok, true);
      assert.deepEqual(env.data, { waited: 30 });
    } finally {
      await rig.close();
    }
  });

  it('a client timeout rejects the client call with RequestTimeout and flips the handler signal (cooperative cancellation)', async () => {
    const rig = await slowRig();
    try {
      await assert.rejects(
        () => callTool(rig.client, 'rig_wait', { ms: 8000 }, { timeout: 120 }),
        (e: unknown) => e instanceof McpError && e.code === ErrorCode.RequestTimeout,
      );
      await until(() => rig.signals[0]?.aborted === true);
    } finally {
      await rig.close();
    }
  });

  it('a client AbortSignal does the same', async () => {
    const rig = await slowRig();
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('user cancelled')), 80);
      await assert.rejects(() => callTool(rig.client, 'rig_wait', { ms: 8000 }, { signal: controller.signal }), McpError);
      await until(() => rig.signals[0]?.aborted === true);
    } finally {
      await rig.close();
    }
  });

  it('synchronous work is not cut short by the deadline: it completes and its result is returned (the deadline only stops WAITING)', async () => {
    const rig = await slowRig(50);
    try {
      const env = envelopeOf(await callTool(rig.client, 'rig_busy', { ms: 200 }));
      assert.equal(env.ok, true, 'a node:sqlite read is synchronous too: bound it by its input limits, not by a timer');
      assert.deepEqual(env.data, { busy: 200 });
      assert.equal(envelopeOf(await callTool(rig.client, 'rig_wait', { ms: 5 })).ok, true, 'the next call works');
    } finally {
      await rig.close();
    }
  });

  it('an unexpected exception is the generic INTERNAL_ERROR: no message, path or text of the failure reaches the client', async () => {
    const rig = await slowRig();
    try {
      const res = await callTool(rig.client, 'rig_throw', {});
      const env = envelopeOf(res);
      assert.equal(env.error?.code, 'INTERNAL_ERROR');
      assert.equal(env.error?.message, 'An unexpected internal error occurred.');
      const everything = JSON.stringify(res);
      for (const leaked of ['ENOENT', 'alice', 'secret-conversation', 'hunter2', 'password']) assert.ok(!everything.includes(leaked), leaked);
    } finally {
      await rig.close();
    }
  });

  it('progress is advisory: delivered updates arrive in order, and every update is either delivered or reported as late', async () => {
    const rig = await slowRig();
    try {
      const delivered: number[] = [];
      const errorsBefore = rig.clientErrors.length;
      const env = envelopeOf(await callTool(rig.client, 'rig_wait', { ms: 40, steps: 3 }, { onprogress: (p) => delivered.push(p.progress) }));
      assert.equal(env.ok, true);
      await new Promise((r) => setTimeout(r, 30));
      const unknownToken = rig.clientErrors.slice(errorsBefore).filter((e) => /unknown token/.test(e.message)).length;
      assert.deepEqual(delivered, [1, 2, 3].slice(0, delivered.length), 'in order, from the first');
      assert.equal(delivered.length + unknownToken, 3, 'nothing vanishes silently');
    } finally {
      await rig.close();
    }
  });

  it('without a progress token no progress is sent at all', async () => {
    const rig = await slowRig();
    try {
      await callTool(rig.client, 'rig_wait', { ms: 10, steps: 3 });
      assert.deepEqual(rig.clientErrors, []);
    } finally {
      await rig.close();
    }
  });
});

describe('many concurrent calls', () => {
  it('two hundred mixed reads in flight at once all succeed and equal their sequential answers', async () => {
    const fx = await createFixture({ many: 10 });
    const h = await connectMem(fx.dbPath);
    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['gcr_list', { limit: 5 }],
        ['gcr_get', { conversation: ID.linear }],
        ['gcr_search', { query: 'quokka' }],
        ['gcr_branches', { conversation: ID.branched }],
        ['gcr_thread', { conversation: ID.branched }],
        ['gcr_stats', { groupBy: 'role' }],
        ['gcr_audit', {}],
        ['gcr_graph_query', { term: 'quokka' }],
        ['gcr_doctor', {}],
        ['gcr_get', { conversation: ID.absent }],
      ];
      const sequential = new Map<string, string>();
      for (const [tool, args] of calls) sequential.set(`${tool}${JSON.stringify(args)}`, JSON.stringify((await h.call(tool, args)).structuredContent));
      const jobs = Array.from({ length: 200 }, (_, i) => calls[i % calls.length] as [string, Record<string, unknown>]);
      const results = await Promise.all(jobs.map(async ([tool, args]) => ({ key: `${tool}${JSON.stringify(args)}`, res: await h.call(tool, args) })));
      for (const { key, res } of results) assert.equal(JSON.stringify(res.structuredContent), sequential.get(key), key);
      assert.deepEqual(h.clientErrors, []);
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });

  it('reads and writes interleaved on a writable server: every call is answered with a coded envelope, none is lost', async () => {
    const fx = await createFixture();
    const h = await connectMem(fx.dbPath, { writable: true });
    try {
      const jobs: Array<Promise<ReturnType<typeof envelopeOf>>> = [];
      for (let i = 0; i < 60; i++) {
        jobs.push(h.env('gcr_list'));
        jobs.push(h.env('gcr_create_local_draft', { conversation: ID.linear, body: `draft ${i}` }));
        jobs.push(h.env('gcr_search', { query: 'quokka', limit: 5 }));
      }
      const results = await Promise.all(jobs);
      assert.equal(results.length, 180);
      assert.ok(results.every((r) => r.ok), JSON.stringify(results.find((r) => !r.ok)?.error));
      const drafts = results.filter((r) => r.ids.draftIds !== undefined);
      assert.equal(new Set(drafts.map((r) => r.ids.draftIds?.[0])).size, 60);
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });
});
