/**
 * SPEC-03 over MCP: gcr_graph_query carries the same TERM_SPLIT / NO_MATCHING_NODE warnings as the SDK for the SPEC example
 * term, through the real SDK client and the strict output schema. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { connectMem, conversationsJson, fixedClock, makeTempDir, removeDir, title, writeText } from './mcp.helpers.test.js';
import type { MemHarness } from './mcp.helpers.test.js';

let dir = '';
let h: MemHarness;

before(async () => {
  dir = await makeTempDir();
  const dbPath = join(dir, 'g.sqlite');
  const gcr = Gcr.open({ dbPath, clock: fixedClock });
  try {
    const builders = [1, 2].map((n) => {
      const b = new ConversationBuilder({ id: syntheticUuid(0x70 + n), title: title(`emblem ${n}`) });
      let prev = b.root();
      prev = b.user(prev, 'Tell me about EMBLEM-NLP MCP servers please');
      b.assistant(prev, 'EMBLEM-NLP MCP servers are discussed at example.invalid with details', { model: 'synthetic-model-1' });
      return b;
    });
    await gcr.importExport({ source: { kind: 'path', path: await writeText(dir, join('in', 'conversations.json'), conversationsJson(builders)) } });
    await gcr.buildGraph();
  } finally {
    gcr.close();
  }
  h = await connectMem(dbPath);
});

after(async () => {
  await h.close();
  await removeDir(dir);
});

describe('SPEC-03: gcr_graph_query', () => {
  it('"EMBLEM-NLP" depth 2 returns the neighbourhood with TERM_SPLIT, identical to the SDK', async () => {
    const env = await h.env('gcr_graph_query', { term: 'EMBLEM-NLP', depth: 2 });
    assert.equal(env.ok, true);
    const data = env.data as { seeds: string[]; nodes: Array<{ id: string }> };
    assert.deepEqual([...data.seeds].sort(), ['ent:keyword:emblem', 'ent:keyword:nlp']);
    assert.ok(data.nodes.length > 2);
    const sdk = h.gcr.graphQuery({ term: 'EMBLEM-NLP', depth: 2 });
    assert.deepEqual(env.warnings, sdk.warnings);
    assert.ok(env.warnings.some((w) => w.code === 'TERM_SPLIT'));
  });

  it('an unmatched term returns an empty graph WITH NO_MATCHING_NODE (not a silent empty result)', async () => {
    const env = await h.env('gcr_graph_query', { term: 'zzzunmatched' });
    assert.equal(env.ok, true);
    const data = env.data as { seeds: string[]; nodes: unknown[] };
    assert.deepEqual(data.seeds, []);
    assert.deepEqual(data.nodes, []);
    assert.deepEqual(env.warnings.map((w) => w.code), ['NO_MATCHING_NODE']);
  });
});
