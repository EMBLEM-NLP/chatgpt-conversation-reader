/**
 * Annotation truthfulness. Every tool annotated readOnlyHint:true must provably leave the database unchanged: a full content
 * hash of every table (virtual and shadow tables included) is compared before and after, call by call and for whole passes
 * over the read-only tool set in random order, on a server where writes are ENABLED (so a read tool that wrote would be able
 * to). A mutation check proves the hash notices a change; a read-only handle proves the tools do not even need the ability.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';
import { ID, connectMem, createFixture, dbContentHash } from './mcp.helpers.test.js';

type Call = [tool: string, args: Record<string, unknown>];

function readCalls(fx: Fixture): Call[] {
  return [
    ['gcr_list', {}],
    ['gcr_list', { limit: 3, sort: 'title_asc', offset: 1 }],
    ['gcr_list', { titleQuery: 'alpha', allBatches: true }],
    ['gcr_get', { conversation: ID.linear }],
    ['gcr_get', { conversation: `https://chatgpt.com/c/${ID.branched}`, allBranches: true, includeHidden: true }],
    ['gcr_get', { conversation: ID.noCurrent }],
    ['gcr_get', { conversation: ID.noCurrent, branchPolicy: 'latest_leaf' }],
    ['gcr_get', { conversation: ID.absent }],
    ['gcr_get', { conversation: ID.injection }],
    ['gcr_search', { query: 'quokka' }],
    ['gcr_search', { query: 'quokka', scope: 'titles' }],
    ['gcr_search', { query: 'quokka', scope: 'all', limit: 5, offset: 2 }],
    ['gcr_search', { query: '"unterminated', mode: 'raw' }],
    ['gcr_branches', { conversation: ID.branched }],
    ['gcr_branches', { conversation: ID.absent }],
    ['gcr_thread', { conversation: ID.branched }],
    ['gcr_thread', { conversation: ID.branched, branch: fx.branched.a1e }],
    ['gcr_thread', { conversation: ID.noCurrent }],
    ['gcr_stats', { groupBy: 'role' }],
    ['gcr_stats', { groupBy: 'day', tz: 'Europe/Berlin' }],
    ['gcr_stats', { groupBy: 'conversation', limit: 2 }],
    ['gcr_audit', {}],
    ['gcr_audit', { checks: ['no_current_node', 'timestamps'], sampleSize: 3 }],
    ['gcr_graph_query', { term: 'quokka' }],
    ['gcr_graph_query', { term: 'nothing-matches-this-xyz' }],
    ['gcr_doctor', {}],
    ['gcr_list', { limit: 0 }], // rejected by the schema layer
  ];
}

/** mulberry32: a tiny seeded PRNG, so "random order" is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rand = prng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('read-only tools do not change the database', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture();
    // give the local tables rows too, so "unchanged" covers drafts, annotations and the audit log
    const seed = Gcr.open({ dbPath: fx.dbPath, actor: 'sdk' });
    try {
      await seed.createDraft({ conversationRef: ID.linear, body: 'seed draft' });
      await seed.createAnnotation({ conversationRef: ID.linear, body: 'seed annotation' });
    } finally {
      seed.close();
    }
    h = await connectMem(fx.dbPath, { writable: true }); // writes ENABLED: the strongest setting for this claim
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  it('the hash sees changes (mutation check): a write tool changes it, and so does a different database', async () => {
    const before = dbContentHash(fx.dbPath);
    assert.equal(dbContentHash(fx.dbPath), before, 'stable when nothing happens');
    const env = await h.env('gcr_create_local_draft', { conversation: ID.linear, body: 'this is a write' });
    assert.equal(env.ok, true);
    assert.notEqual(dbContentHash(fx.dbPath), before, 'a draft changes the hash');
    const afterDraft = dbContentHash(fx.dbPath);
    const note = await h.env('gcr_update_local_annotation', { conversation: ID.linear, body: 'another write' });
    assert.equal(note.ok, true);
    assert.notEqual(dbContentHash(fx.dbPath), afterDraft, 'an annotation changes the hash (and the audit log)');
  });

  it('every single read call, successful or rejected, leaves the hash unchanged', async () => {
    const start = dbContentHash(fx.dbPath);
    for (const [tool, args] of readCalls(fx)) {
      await h.call(tool, args);
      assert.equal(dbContentHash(fx.dbPath), start, `${tool} ${JSON.stringify(args).slice(0, 80)} changed the database`);
    }
  });

  for (const seed of [1, 2, 3, 5, 8, 13]) {
    it(`a full pass over the read-only tool set in random order (seed ${seed}), twice over, leaves the hash unchanged`, async () => {
      const start = dbContentHash(fx.dbPath);
      const calls = [...readCalls(fx), ...readCalls(fx)];
      for (const [tool, args] of shuffled(calls, seed)) await h.call(tool, args);
      assert.equal(dbContentHash(fx.dbPath), start);
    });
  }

  it('the same pass fired concurrently also leaves it unchanged', async () => {
    const start = dbContentHash(fx.dbPath);
    await Promise.all(shuffled(readCalls(fx), 99).map(([tool, args]) => h.call(tool, args)));
    assert.equal(dbContentHash(fx.dbPath), start);
  });
});

describe('read-only tools need no write capability at all', () => {
  it('on a read-only database handle every read-only tool still works and none is answered with WRITE_FORBIDDEN or DB_ERROR', async () => {
    const fx = await createFixture();
    const h = await connectMem(fx.dbPath, { writable: false });
    try {
      const start = dbContentHash(fx.dbPath);
      for (const [tool, args] of readCalls(fx)) {
        const env = await h.env(tool, args);
        assert.ok(env.ok || !['WRITE_FORBIDDEN', 'DB_ERROR', 'INTERNAL_ERROR'].includes(env.error?.code ?? ''), `${tool}: ${env.error?.code}`);
      }
      assert.equal(dbContentHash(fx.dbPath), start);
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });
});
