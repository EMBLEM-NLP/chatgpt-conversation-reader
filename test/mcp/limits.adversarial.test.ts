/**
 * Adversarial review of the size and cost limits of the MCP layer (MCP lens: "result-size and time bounds", "unbounded
 * memory/time").
 *
 * Defects pinned here:
 *  1. The SDK's `maxToolInputElements` guard lives in the SDK's own tools/call handler, which this server replaces. A call
 *     with a million-element array then reached zod, which allocates one issue per bad element: measured 2.1 s of blocked
 *     event loop and +800 MB of resident memory for 7 MB of input. The registry must bound the element count BEFORE parsing.
 *  2. The result cap is measured on the envelope, but the envelope is sent twice (text copy + structuredContent) and the text
 *     copy is JSON-escaped again, so a quote- or backslash-heavy payload costs up to 3x the cap on the wire. The largest
 *     configurable cap (4 MiB) could therefore produce a 12 MB frame, above the 10 MiB ReadBuffer limit of the SDK transport,
 *     which closes the connection. The largest allowed cap must keep even the worst case below that limit.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { ENTITY_KINDS } from '../../src/entities/extract.js';
import { NODE_KINDS } from '../../src/graph/build.js';
import { MAX_MAX_RESULT_BYTES, MIN_MAX_RESULT_BYTES, parseMaxResultBytes } from '../../src/mcp/envelope.js';
import { createGcrMcpServer } from '../../src/mcp/server.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';
import { callTool, connectMem, createFixture, envelopeOf, fixedClock, makeTempDir, removeDir } from './mcp.helpers.test.js';

describe('argument element budget (checked before zod runs)', () => {
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

  it('a million invalid array elements are refused by the budget, not by a million validation issues', async () => {
    const res = await h.call('gcr_graph_query', { term: 'x', kinds: Array.from({ length: 1_000_000 }, () => 'URL!') });
    const env = envelopeOf(res);
    assert.equal(env.error?.code, 'INVALID_ARGUMENT');
    assert.equal(env.error?.details?.['reason'], 'too_many_elements', 'refused by the element budget');
    assert.equal(env.error?.details?.['issueCount'], undefined, 'zod never ran over the hostile array');
    assert.ok(Buffer.byteLength((res.content[0] as { text: string }).text) < 2_000, 'the answer is tiny');
  });

  it('the budget also bounds nesting and object width: a 200 000 deep array and a 100 000 key object', async () => {
    let deep: unknown[] = [];
    for (let i = 0; i < 200_000; i++) deep = [deep];
    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]));
    for (const [tool, args] of [
      ['gcr_get', { conversation: deep }],
      ['gcr_search', { query: 'x', role: deep }],
      ['gcr_list', wide],
    ] as const) {
      const env = envelopeOf(await h.call(tool, args as Record<string, unknown>));
      assert.equal(env.error?.code, 'INVALID_ARGUMENT', tool);
      assert.equal(env.error?.details?.['reason'], 'too_many_elements', tool);
    }
  });

  it('is cheap: a hostile call does not block the event loop for long (the same call took 2 s before the budget)', async () => {
    const kinds = Array.from({ length: 1_000_000 }, () => 'URL!');
    const started = process.hrtime.bigint();
    await h.call('gcr_graph_query', { term: 'x', kinds });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1_000, `took ${ms.toFixed(0)} ms`);
  });

  it('legitimate calls are untouched: the largest valid shapes of every tool still pass the budget', async () => {
    const all = (await h.client.listTools()).tools;
    assert.equal(all.length, 12);
    const audit = envelopeOf(await h.call('gcr_audit', { checks: ['empty', 'untitled', 'missing_model'], sampleSize: 50 }));
    assert.notEqual(audit.error?.details?.['reason'], 'too_many_elements');
    const tenKinds = [...NODE_KINDS, ...ENTITY_KINDS].slice(0, 10);
    assert.equal(tenKinds.length, 10);
    const kinds = envelopeOf(await h.call('gcr_graph_query', { term: 'quokka', kinds: tenKinds }));
    assert.equal(kinds.ok, true, JSON.stringify(kinds.error));
    const longText = envelopeOf(await h.call('gcr_search', { query: 'x'.repeat(1000) }));
    assert.equal(longText.ok, true, 'a long string is one element, however long');
  });
});

describe('worst-case wire size of a result', () => {
  it('the largest allowed result cap keeps the worst-case frame (3x the cap) below the transport read buffer', () => {
    assert.ok(3 * MAX_MAX_RESULT_BYTES + 4096 < STDIO_DEFAULT_MAX_BUFFER_SIZE, `${MAX_MAX_RESULT_BYTES} bytes x 3 must stay under ${STDIO_DEFAULT_MAX_BUFFER_SIZE}`);
    assert.equal(parseMaxResultBytes(String(MAX_MAX_RESULT_BYTES)), MAX_MAX_RESULT_BYTES);
    assert.throws(() => parseMaxResultBytes(String(MAX_MAX_RESULT_BYTES + 1)), /GCR_MCP_MAX_RESULT_BYTES/);
    assert.throws(() => parseMaxResultBytes(String(MIN_MAX_RESULT_BYTES - 1)), /GCR_MCP_MAX_RESULT_BYTES/);
  });

  /** A one-conversation database whose messages are made of `chunk` repeated: `messages` x `size` characters. */
  async function hostileThread(dir: string, chunk: string, messages: number, size: number): Promise<{ dbPath: string; id: string }> {
    const id = syntheticUuid(0x77);
    const b = new ConversationBuilder({ id, title: 'hostile payload' });
    let prev = b.root();
    const text = chunk.repeat(Math.ceil(size / chunk.length));
    for (let i = 0; i < messages; i++) {
      prev = b.user(prev, 'q');
      prev = b.assistant(prev, text, { model: 'synthetic-model-1' });
    }
    await mkdir(join(dir, 'e'), { recursive: true });
    const path = join(dir, 'e', 'conversations.json');
    await writeFile(path, `[${b.text()}]`);
    const dbPath = join(dir, 'gcr.sqlite');
    const gcr = Gcr.open({ dbPath, clock: fixedClock });
    try {
      await gcr.importExport({ source: { kind: 'path', path } });
    } finally {
      gcr.close();
    }
    return { dbPath, id };
  }

  async function frameBytes(dbPath: string, id: string, maxResultBytes: number): Promise<{ frame: number; envelope: number; truncated: boolean }> {
    const gcr = Gcr.open({ dbPath, readOnly: true, actor: 'mcp' });
    const server = createGcrMcpServer(gcr, { maxResultBytes });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wire-size', version: '0' });
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      await client.listTools();
      const res = await callTool(client, 'gcr_thread', { conversation: id });
      const envelope = envelopeOf(res);
      // What the stdio transport writes for this response: one JSON-RPC frame.
      const frame = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 2, result: res }), 'utf8') + 1;
      return { frame, envelope: Buffer.byteLength((res.content[0] as { text: string }).text, 'utf8'), truncated: envelope.truncated };
    } finally {
      await client.close();
      await server.close();
      gcr.close();
    }
  }

  it('whatever characters the data is made of, the frame stays within 3x the cap (quotes and backslashes are the worst)', async () => {
    const dir = await makeTempDir();
    try {
      for (const chunk of ['"', '\\', '\n', String.fromCharCode(1), '\u{1F600}', 'a']) {
        const sub = join(dir, `c${chunk.codePointAt(0)}`);
        const { dbPath, id } = await hostileThread(sub, chunk, 12, 20_000);
        const cap = 100_000;
        const { frame, envelope, truncated } = await frameBytes(dbPath, id, cap);
        assert.equal(truncated, true, `cap reached for ${JSON.stringify(chunk)}`);
        assert.ok(envelope <= cap, 'the envelope respects the cap');
        assert.ok(frame <= 3 * cap + 2_048, `${JSON.stringify(chunk)}: frame ${frame} bytes for a cap of ${cap}`);
      }
    } finally {
      await removeDir(dir);
    }
  });

  it('at the largest configurable cap, a quote-heavy thread still yields a frame the SDK transport can read (below 10 MiB)', async () => {
    const dir = await makeTempDir();
    try {
      const { dbPath, id } = await hostileThread(dir, '"', 60, 100_000); // 6 MB of quotes
      const { frame, truncated } = await frameBytes(dbPath, id, MAX_MAX_RESULT_BYTES);
      assert.equal(truncated, true);
      assert.ok(frame < STDIO_DEFAULT_MAX_BUFFER_SIZE, `the frame is ${frame} bytes; the transport closes the connection above ${STDIO_DEFAULT_MAX_BUFFER_SIZE}`);
    } finally {
      await removeDir(dir);
    }
  });
});
