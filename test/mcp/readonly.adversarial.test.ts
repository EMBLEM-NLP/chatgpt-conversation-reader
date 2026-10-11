/**
 * Adversarial review (MCP lens: "schema/annotation accuracy (readOnlyHint truthfulness)").
 *
 * readonly.truthfulness.test.ts hashes the database around the read-only tools of a database that HAS a knowledge graph. A
 * read tool that built missing derived tables on demand (the graph, a search index) would only show up on a database that lacks
 * them, on a server that is allowed to write. This pins that case: every tool the server advertises as read-only, called on a
 * writable server over a database without a graph, leaves the content hash of every table (schema included) unchanged.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ID, connectMem, createFixture, dbContentHash } from './mcp.helpers.test.js';

const ARGS: Record<string, Record<string, unknown>> = {
  gcr_list: {},
  gcr_get: { conversation: ID.linear, allBranches: true, branchPolicy: 'last_child' },
  gcr_search: { query: 'quokka', scope: 'all' },
  gcr_branches: { conversation: ID.branched },
  gcr_thread: { conversation: ID.noCurrent, branchPolicy: 'last_child' },
  gcr_stats: { groupBy: 'conversation' },
  gcr_audit: {},
  gcr_graph_query: { term: 'quokka' },
  gcr_doctor: {},
};

describe('read-only tools on a writable server', () => {
  for (const graph of [false, true]) {
    it(`leave a database ${graph ? 'with' : 'WITHOUT'} a knowledge graph exactly as it was`, async () => {
      const fx = await createFixture({ graph });
      const h = await connectMem(fx.dbPath, { writable: true });
      try {
        const readOnly = (await h.client.listTools()).tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
        assert.deepEqual([...readOnly].sort(), Object.keys(ARGS).sort(), 'the test covers exactly the tools advertised as read-only');
        for (const tool of readOnly) {
          const before = dbContentHash(fx.dbPath);
          const env = await h.env(tool, ARGS[tool] ?? {});
          assert.ok(env.ok || env.error?.code !== 'INTERNAL_ERROR', `${tool}: ${env.error?.code}`);
          assert.equal(dbContentHash(fx.dbPath), before, `${tool} changed the database`);
        }
      } finally {
        await h.close();
        await fx.cleanup();
      }
    });
  }
});
