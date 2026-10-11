/**
 * MCP protocol conformance of the GCR server, driven with raw JSON-RPC over a linked in-memory transport (no SDK client in
 * the way) and with the real SDK Client: initialize and protocol-version negotiation, capabilities, server info and
 * instructions, unknown methods, unknown tools, malformed calls.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, LATEST_PROTOCOL_VERSION, McpError, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { createGcrMcpServer } from '../../src/mcp/server.js';
import { TOOL_NAME, TOOL_VERSION } from '../../src/version.js';
import type { Fixture } from './mcp.helpers.test.js';
import { ID, connectMem, createFixture } from './mcp.helpers.test.js';

interface RawPeer {
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  notify: (method: string, params?: Record<string, unknown>) => Promise<void>;
  received: JSONRPCMessage[];
  close: () => Promise<void>;
}

async function rawPeer(dbPath: string): Promise<RawPeer> {
  const gcr = Gcr.open({ dbPath, readOnly: true, actor: 'mcp' });
  const server = createGcrMcpServer(gcr, {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const received: JSONRPCMessage[] = [];
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  clientSide.onmessage = (m) => {
    received.push(m);
    const id = (m as { id?: unknown }).id;
    if (typeof id === 'number') waiters.get(id)?.(m as unknown as Record<string, unknown>);
  };
  await server.connect(serverSide);
  await clientSide.start();
  let next = 1;
  return {
    received,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 10_000);
        waiters.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        void clientSide.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      }),
    notify: (method, params) => clientSide.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
    close: async () => {
      await clientSide.close();
      await server.close();
      gcr.close();
    },
  };
}

const initParams = (protocolVersion: string): Record<string, unknown> => ({ protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '0' } });

describe('protocol', () => {
  let fx: Fixture;
  before(async () => {
    fx = await createFixture();
  });
  after(async () => {
    await fx.cleanup();
  });

  describe('initialize and version negotiation', () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      it(`echoes the supported version ${version}`, async () => {
        const peer = await rawPeer(fx.dbPath);
        try {
          const res = await peer.request('initialize', initParams(version));
          assert.equal((res['result'] as { protocolVersion: string }).protocolVersion, version);
        } finally {
          await peer.close();
        }
      });
    }

    for (const version of ['2023-01-01', '2026-07-28', 'not-a-version', '']) {
      it(`answers an unsupported version (${JSON.stringify(version)}) with the latest this server speaks`, async () => {
        const peer = await rawPeer(fx.dbPath);
        try {
          const res = await peer.request('initialize', initParams(version));
          assert.equal((res['result'] as { protocolVersion: string }).protocolVersion, LATEST_PROTOCOL_VERSION);
        } finally {
          await peer.close();
        }
      });
    }

    it('reports server info, capabilities and static instructions', async () => {
      const peer = await rawPeer(fx.dbPath);
      try {
        const res = (await peer.request('initialize', initParams(LATEST_PROTOCOL_VERSION)))['result'] as {
          serverInfo: { name: string; version: string };
          capabilities: Record<string, unknown>;
          instructions: string;
        };
        assert.equal(res.serverInfo.name, TOOL_NAME);
        assert.equal(res.serverInfo.version, TOOL_VERSION);
        assert.deepEqual(res.capabilities, { tools: { listChanged: true } }, 'tools only: no resources, prompts, logging, completions');
        assert.match(res.instructions, /UNTRUSTED DATA/);
        assert.match(res.instructions, /No tool can send, post or fetch anything from chatgpt\.com/);
        assert.match(res.instructions, /read-only unless the operator enabled local writes/);
      } finally {
        await peer.close();
      }
    });

    it('the real SDK client connects, sees the same facts and treats the version as supported', async () => {
      const h = await connectMem(fx.dbPath);
      try {
        assert.deepEqual(h.client.getServerVersion(), { name: TOOL_NAME, version: TOOL_VERSION });
        assert.deepEqual(h.client.getServerCapabilities(), { tools: { listChanged: true } });
        assert.match(h.client.getInstructions() ?? '', /UNTRUSTED DATA/);
        assert.deepEqual(h.clientErrors, []);
      } finally {
        await h.close();
      }
    });
  });

  describe('methods and errors', () => {
    let peer: RawPeer;
    before(async () => {
      peer = await rawPeer(fx.dbPath);
      await peer.request('initialize', initParams(LATEST_PROTOCOL_VERSION));
      await peer.notify('notifications/initialized');
    });
    after(async () => {
      await peer.close();
    });

    it('ping is answered with an empty result', async () => {
      assert.deepEqual((await peer.request('ping'))['result'], {});
    });

    it('methods of capabilities the server does not have are -32601 Method not found', async () => {
      for (const method of ['resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get', 'logging/setLevel', 'completion/complete', 'nonsense/method', 'tools']) {
        const res = await peer.request(method, {});
        assert.equal((res['error'] as { code: number }).code, ErrorCode.MethodNotFound, method);
        assert.equal((res['error'] as { message: string }).message, 'Method not found', method);
        assert.equal(res['result'], undefined);
      }
    });

    it('tools/list is complete in one response (no pagination) and every entry has name, inputSchema and outputSchema', async () => {
      const res = (await peer.request('tools/list'))['result'] as { tools: Array<Record<string, unknown>>; nextCursor?: string };
      assert.equal(res.tools.length, 12);
      assert.equal(res.nextCursor, undefined);
      for (const t of res.tools) {
        assert.equal(typeof t['name'], 'string');
        assert.equal((t['inputSchema'] as { type: string }).type, 'object');
        assert.equal((t['outputSchema'] as { type: string }).type, 'object');
      }
    });

    it('an unknown tool is a JSON-RPC error -32602 (a protocol error, as the protocol prescribes), not a tool result', async () => {
      const res = await peer.request('tools/call', { name: 'chatgpt_send_message', arguments: { text: 'hello' } });
      assert.equal(res['result'], undefined);
      assert.equal((res['error'] as { code: number }).code, ErrorCode.InvalidParams);
      assert.match((res['error'] as { message: string }).message, /Unknown tool: chatgpt_send_message/);
    });

    it('a hostile tool name is not echoed unbounded or with control characters', async () => {
      const res = await peer.request('tools/call', { name: `x\u0007\n${'Z'.repeat(5000)}`, arguments: {} });
      const message = (res['error'] as { message: string }).message;
      assert.ok(message.length < 200);
      assert.ok(!/[\u0000-\u001f]/.test(message.replace('MCP error', '')));
    });

    it('a task-augmented call is refused by the protocol layer (this server has no task capability)', async () => {
      const res = await peer.request('tools/call', { name: 'gcr_list', arguments: {}, task: { ttl: 1000 } });
      assert.equal(res['result'], undefined);
      assert.ok((res['error'] as { code: number }).code < 0);
      assert.match((res['error'] as { message: string }).message, /task/i);
    });

    it('malformed tools/call params are protocol errors', async () => {
      for (const params of [{}, { name: 5 }, { name: 'gcr_list', arguments: 'not-an-object' }, { name: 'gcr_list', arguments: [] }]) {
        const res = await peer.request('tools/call', params);
        assert.ok(res['error'], JSON.stringify(params));
        assert.ok((res['error'] as { code: number }).code < 0);
      }
    });

    it('a valid call after all those errors still works (the server is not wedged)', async () => {
      const res = (await peer.request('tools/call', { name: 'gcr_get', arguments: { conversation: ID.linear } }))['result'] as { isError?: boolean; structuredContent: { ok: boolean } };
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.ok, true);
    });

    it('a notification for an unknown request id is ignored', async () => {
      await peer.notify('notifications/cancelled', { requestId: 987654, reason: 'whatever' });
      assert.deepEqual((await peer.request('ping'))['result'], {});
    });
  });

  describe('with the real SDK client', () => {
    it('methods of missing capabilities reject with MethodNotFound', async () => {
      const h = await connectMem(fx.dbPath);
      try {
        await assert.rejects(() => h.client.listResources(), (e: unknown) => e instanceof McpError && e.code === ErrorCode.MethodNotFound);
        await assert.rejects(() => h.client.listPrompts(), (e: unknown) => e instanceof McpError && e.code === ErrorCode.MethodNotFound);
      } finally {
        await h.close();
      }
    });

    it('an unknown tool rejects with McpError -32602', async () => {
      const h = await connectMem(fx.dbPath);
      try {
        await assert.rejects(() => h.call('gcr_delete_everything', {}), (e: unknown) => e instanceof McpError && e.code === ErrorCode.InvalidParams);
      } finally {
        await h.close();
      }
    });

    it('a fresh client can reconnect to the same server object after close (no hidden per-connection state)', async () => {
      const gcr = Gcr.open({ dbPath: fx.dbPath, readOnly: true, actor: 'mcp' });
      const server = createGcrMcpServer(gcr, {});
      try {
        for (let round = 0; round < 2; round++) {
          const [ct, st] = InMemoryTransport.createLinkedPair();
          const client = new Client({ name: `round-${round}`, version: '0' });
          await Promise.all([server.connect(st), client.connect(ct)]);
          assert.equal((await client.listTools()).tools.length, 12);
          await client.close();
          await server.close();
        }
      } finally {
        gcr.close();
      }
    });
  });
});
