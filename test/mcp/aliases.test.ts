/**
 * The alias mechanism (src/mcp/aliases.ts, ADR-0002): the shipped table is EMPTY (the v0.1.1 chatgpt_* names are unknown,
 * so none may be invented); the mechanism is exercised with a TEST table: an alias resolves to the same handler, shows up in
 * tools/list with a deprecation note, behaves identically (including the write policy), and a bad table stops the server.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { GcrError } from '../../src/errors.js';
import { LEGACY_ALIASES, registerAliases } from '../../src/mcp/aliases.js';
import type { AliasTable } from '../../src/mcp/aliases.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { createGcrMcpServer } from '../../src/mcp/server.js';
import type { Fixture } from './mcp.helpers.test.js';
import { ID, connectMem, createFixture } from './mcp.helpers.test.js';

const TEST_TABLE: AliasTable = { gcr_list: ['legacy_list'], gcr_get: ['legacy_get', 'legacy.get-2'], gcr_create_local_draft: ['legacy_draft'] };

function throwsInvalid(fn: () => unknown, why: string): void {
  assert.throws(fn, (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', why);
}

describe('the shipped alias table', () => {
  it('is empty and frozen (ADR-0002: no invented chatgpt_* names)', () => {
    assert.deepEqual(Object.keys(LEGACY_ALIASES), []);
    assert.ok(Object.isFrozen(LEGACY_ALIASES));
  });

  it('adds nothing to the tool list, and registerAliases with it registers zero', async () => {
    const fx = await createFixture({ graph: false });
    const h = await connectMem(fx.dbPath);
    try {
      const names = (await h.client.listTools()).tools.map((t) => t.name);
      assert.equal(names.length, 12);
      assert.ok(names.every((n) => n.startsWith('gcr_')));
    } finally {
      await h.close();
      await fx.cleanup();
    }
    assert.equal(registerAliases(new McpServer({ name: 'bare', version: '0' })), 0, 'an empty table needs no tools');
  });
});

describe('a test alias table', () => {
  let fx: Fixture;
  before(async () => {
    fx = await createFixture();
  });
  after(async () => {
    await fx.cleanup();
  });

  it('aliases appear in tools/list after the canonical tools, with the deprecation note and identical schemas and annotations', async () => {
    const h = await connectMem(fx.dbPath, { server: { aliases: TEST_TABLE } });
    try {
      const tools = (await h.client.listTools()).tools;
      assert.deepEqual(
        tools.map((t) => t.name),
        [...tools.slice(0, 12).map((t) => t.name), 'legacy_list', 'legacy_get', 'legacy.get-2', 'legacy_draft'],
      );
      const by = new Map(tools.map((t) => [t.name, t]));
      for (const [canonical, aliases] of Object.entries(TEST_TABLE)) {
        for (const alias of aliases) {
          const a = by.get(alias);
          const c = by.get(canonical);
          assert.ok(a && c);
          assert.deepEqual(a.inputSchema, c.inputSchema);
          assert.deepEqual(a.outputSchema, c.outputSchema);
          assert.deepEqual(a.annotations, c.annotations);
          assert.equal(a.title, c.title);
          assert.equal(a.description, `${c.description} (Deprecated alias of ${canonical}: use ${canonical}.)`);
        }
      }
    } finally {
      await h.close();
    }
  });

  it('calling an alias runs the same handler: same data, plus a DEPRECATED_TOOL_ALIAS warning at the end', async () => {
    const h = await connectMem(fx.dbPath, { server: { aliases: TEST_TABLE } });
    try {
      const canonical = await h.env('gcr_list', { limit: 3 });
      const alias = await h.env('legacy_list', { limit: 3 });
      assert.deepEqual(alias.data, canonical.data);
      assert.deepEqual(alias.ids, canonical.ids);
      assert.deepEqual(alias.warnings.slice(0, canonical.warnings.length), canonical.warnings, 'the SDK warnings stay first');
      const last = alias.warnings[alias.warnings.length - 1];
      assert.equal(last?.code, 'DEPRECATED_TOOL_ALIAS');
      assert.match(last?.message ?? '', /legacy_list is a deprecated alias of gcr_list; use gcr_list/);
      assert.equal(canonical.warnings.some((w) => w.code === 'DEPRECATED_TOOL_ALIAS'), false);
      const get = await h.env('legacy.get-2', { conversation: ID.linear });
      assert.deepEqual(get.data, (await h.env('gcr_get', { conversation: ID.linear })).data);
    } finally {
      await h.close();
    }
  });

  it('an alias rejects bad input and reports errors exactly like its canonical tool (and names itself in the message)', async () => {
    const h = await connectMem(fx.dbPath, { server: { aliases: TEST_TABLE } });
    try {
      const bad = await h.env('legacy_list', { limit: 999 });
      assert.equal(bad.error?.code, 'INVALID_ARGUMENT');
      assert.match(bad.error?.message ?? '', /legacy_list/);
      assert.deepEqual(bad.error?.details, (await h.env('gcr_list', { limit: 999 })).error?.details);
      const missing = await h.env('legacy_get', { conversation: ID.absent });
      assert.equal(missing.error?.code, 'NOT_IN_LOCAL_EXPORT');
    } finally {
      await h.close();
    }
  });

  it('an alias of a write tool obeys the same write policy: forbidden read-only, working when writes are enabled', async () => {
    const ro = await connectMem(fx.dbPath, { server: { aliases: TEST_TABLE } });
    try {
      assert.equal((await ro.env('legacy_draft', { conversation: ID.linear, body: 'x' })).error?.code, 'WRITE_FORBIDDEN');
    } finally {
      await ro.close();
    }
    const rw = await connectMem(fx.dbPath, { writable: true, server: { aliases: TEST_TABLE } });
    try {
      const env = await rw.env('legacy_draft', { conversation: ID.linear, body: 'via alias' });
      assert.equal(env.ok, true, env.error?.message);
      assert.equal(env.warnings.at(-1)?.code, 'DEPRECATED_TOOL_ALIAS');
    } finally {
      await rw.close();
    }
  });

  it('can be added to a running server: the client is told the list changed and then sees and can call the alias', async () => {
    const gcr = Gcr.open({ dbPath: fx.dbPath, readOnly: true, actor: 'mcp' });
    const server = createGcrMcpServer(gcr, {});
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'late', version: '0' });
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified++;
    });
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      assert.equal((await client.listTools()).tools.length, 12);
      assert.equal(registerAliases(server, { gcr_list: ['late_list'] }), 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(notified >= 1, 'notifications/tools/list_changed was sent');
      assert.equal((await client.listTools()).tools.at(-1)?.name, 'late_list');
      const res = await client.callTool({ name: 'late_list', arguments: { limit: 1 } });
      assert.equal(res.isError, undefined);
    } finally {
      await client.close();
      await server.close();
      gcr.close();
    }
  });
});

describe('a bad table stops the server at build time instead of shadowing a tool', () => {
  let fx: Fixture;
  let gcr: Gcr;
  before(async () => {
    fx = await createFixture({ graph: false });
    gcr = Gcr.open({ dbPath: fx.dbPath, readOnly: true });
  });
  after(async () => {
    gcr.close();
    await fx.cleanup();
  });

  const build = (aliases: AliasTable) => (): unknown => createGcrMcpServer(gcr, { aliases });

  it('an alias that collides with an existing tool', () => {
    throwsInvalid(build({ gcr_list: ['gcr_get'] }), 'canonical name');
    throwsInvalid(build({ gcr_list: ['gcr_list'] }), 'itself');
  });

  it('the same alias twice, under one canonical or two', () => {
    throwsInvalid(build({ gcr_list: ['dup', 'dup'] }), 'twice under one tool');
    throwsInvalid(build({ gcr_list: ['dup'], gcr_get: ['dup'] }), 'under two tools');
  });

  it('an alias that is not a legal tool name', () => {
    for (const bad of ['', 'has space', 'bang!', 'a'.repeat(129), 'ünïcode', 'slash/name', 'line\nbreak']) throwsInvalid(build({ gcr_list: [bad] }), JSON.stringify(bad));
  });

  it('a canonical name that does not exist, or that is itself an alias', () => {
    throwsInvalid(build({ no_such_tool: ['x'] }), 'unknown canonical');
    const server = createGcrMcpServer(gcr, { aliases: { gcr_list: ['first_alias'] } });
    throwsInvalid(() => registerAliases(server, { first_alias: ['second_alias'] }), 'alias of an alias');
  });

  it('aliases cannot be registered on a server that has no GCR tools', () => {
    throwsInvalid(() => registerAliases(new McpServer({ name: 'bare', version: '0' }), { gcr_list: ['x'] }), 'no registry');
  });

  it('error details are bounded: a hostile alias name is cut, not echoed whole', () => {
    try {
      build({ gcr_list: ['x'.repeat(5000)] })();
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof GcrError);
      assert.ok(JSON.stringify(e.toEnvelope()).length < 1000);
    }
  });
});
