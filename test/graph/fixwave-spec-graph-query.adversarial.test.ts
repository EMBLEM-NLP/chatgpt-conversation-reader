/**
 * SPEC-03 adversarial review (regressions of the fix): the split fallback must tell the truth about WHY a token was not used.
 *
 * Found by review: with a seed limit smaller than the number of matching keyword nodes (`maxNodes: 1`), TERM_SPLIT claimed
 * "No node exists for: nlp" although the node exists and was only cut by the limit. The message is a factual statement about the
 * graph: it must separate "no node exists" from "a node exists but the seed limit left it out". Pathological terms (only
 * separators, very long, FTS-looking, other scripts) must never produce a seed explosion, an error or a silent empty answer.
 * SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { fixedClock, importBuilders, makeTempDir, removeDir, title } from '../sdk/sdk.helpers.test.js';

let dir = '';
let gcr: Gcr;

before(async () => {
  dir = await makeTempDir();
  gcr = Gcr.open({ dbPath: join(dir, 'g.sqlite'), clock: fixedClock });
  const builders = [1, 2].map((n) => {
    const b = new ConversationBuilder({ id: syntheticUuid(0x70 + n), title: title(`emblem ${n}`) });
    let prev = b.root();
    prev = b.user(prev, 'Tell me about EMBLEM-NLP MCP servers please');
    b.assistant(prev, 'EMBLEM-NLP MCP servers are discussed with details', { model: 'synthetic-model-1' });
    return b;
  });
  await importBuilders(gcr, dir, builders);
  await gcr.buildGraph();
});

after(async () => {
  gcr.close();
  await removeDir(dir);
});

const KW = (w: string): string => `ent:keyword:${w}`;
const codes = (r: { warnings: Array<{ code: string }> }): string[] => r.warnings.map((w) => w.code);
const splitMessage = (r: { warnings: Array<{ code: string; message: string }> }): string => r.warnings.find((w) => w.code === 'TERM_SPLIT')?.message ?? '';

describe('SPEC-03 review: TERM_SPLIT does not claim a node is missing when the seed limit cut it', () => {
  it('maxNodes 1: the second token EXISTS, so it is not listed under "No node exists for"', () => {
    const r = gcr.graphQuery({ term: 'EMBLEM-NLP', maxNodes: 1 }).data;
    assert.equal(r.seeds.length, 1);
    assert.deepEqual(codes(r).slice(0, 2), ['TERM_SPLIT', 'SEEDS_TRUNCATED']);
    const msg = splitMessage(r);
    assert.doesNotMatch(msg, /No node exists for:[^.]*\b(emblem|nlp)\b/, `the message must not call an existing node missing: ${msg}`);
    // The token that was cut is still named, with the real reason.
    const used = r.seeds[0]?.slice('ent:keyword:'.length) ?? '';
    const cut = used === 'emblem' ? 'nlp' : 'emblem';
    assert.ok(msg.includes(cut), `the cut token ${cut} is named: ${msg}`);
    assert.match(msg, /limit/i);
  });

  it('a really missing token is still reported as missing, next to a cut one', () => {
    const r = gcr.graphQuery({ term: 'emblem-nlp-zzzunknown', maxNodes: 1 }).data;
    const msg = splitMessage(r);
    assert.match(msg, /No node exists for: zzzunknown/);
    assert.doesNotMatch(msg, /No node exists for:[^.]*\b(emblem|nlp)\b/);
  });

  it('without a cut the message is unchanged: used tokens, then the missing ones', () => {
    const r = gcr.graphQuery({ term: 'emblem-nlp-zzzunknown' }).data;
    assert.deepEqual([...r.seeds].sort(), [KW('emblem'), KW('nlp')]);
    const msg = splitMessage(r);
    assert.match(msg, /Keyword nodes used as seeds: emblem, nlp\./);
    assert.match(msg, /No node exists for: zzzunknown\./);
    assert.doesNotMatch(msg, /limit/i);
  });
});

describe('SPEC-03 review: pathological terms never explode, throw or answer silently', () => {
  const MAX = 512;
  const terms: Array<[string, string]> = [
    ['only hyphens', '-'.repeat(MAX)],
    ['only underscores', '_'.repeat(MAX)],
    ['only spaces and dots', '. '.repeat(MAX / 2)],
    ['only dashes of every kind', '‐‑‒–—―−'.repeat(40)],
    ['emoji separated by hyphens', '\u{1F600}-'.repeat(100)],
    ['FTS syntax', '"emblem" NEAR/3 (nlp OR mcp) NOT * ^ AND'],
    ['SQL / LIKE metacharacters', "emblem-%_\\nlp'; DROP TABLE graph_nodes; --"],
    ['fullwidth', 'ＥＭＢＬＥＭ－ＮＬＰ'],
    ['combining marks run', `emblem-${'́'.repeat(200)}nlp`],
    ['lone surrogate', 'emblem-\ud800-nlp'],
    ['CJK', '東京-日本-語'],
    ['RTL and bidi controls', '‮emblem‬-‭nlp'],
    ['many short tokens (below the keyword minimum)', 'ab-'.repeat(170)],
  ];
  for (const [label, term] of terms) {
    it(label, () => {
      assert.ok(term.length <= MAX);
      const env = gcr.graphQuery({ term });
      assert.equal(env.ok, true);
      assert.ok(env.data.seeds.length <= 100, 'seeds are bounded by maxNodes');
      // Never silent: either something matched, or the empty answer says so.
      if (env.data.seeds.length === 0) assert.ok(codes(env.data).includes('NO_MATCHING_NODE'), `empty answer must be explained: ${codes(env.data).join(',')}`);
    });
  }

  it('a 500-character term of 60 distinct keyword-shaped tokens seeds only the nodes that exist, bounded by maxNodes', () => {
    const term = ['emblem', 'nlp', ...Array.from({ length: 60 }, (_, i) => `word${String(i).padStart(3, '0')}`)].join('-');
    assert.ok(term.length <= 512);
    const r = gcr.graphQuery({ term }).data;
    assert.deepEqual([...r.seeds].sort(), [KW('emblem'), KW('nlp')]);
    const msg = splitMessage(r);
    assert.ok(msg.length < 2000, `the warning stays short (${msg.length} chars)`);
  });
});

describe('SPEC-03 review: NO_MATCHING_NODE names the usual reasons a real term is missing', () => {
  it('a name that occurs in only ONE conversation is pruned by the default graph build, and the warning says how to keep it', async () => {
    const d = await makeTempDir();
    const g = Gcr.open({ dbPath: join(d, 'one.sqlite'), clock: fixedClock });
    try {
      const b = new ConversationBuilder({ id: syntheticUuid(0x90), title: title('single conversation') });
      let prev = b.root();
      prev = b.user(prev, 'Tell me about EMBLEM-NLP MCP servers please');
      b.assistant(prev, 'EMBLEM-NLP MCP servers are discussed with details', { model: 'synthetic-model-1' });
      await importBuilders(g, d, [b]);
      await g.buildGraph(); // default: entities seen in fewer than 2 conversations are dropped
      const r = g.graphQuery({ term: 'EMBLEM-NLP', depth: 2 }).data;
      // The graph may hold other nodes (tools, the conversation), but the keywords of the term are not among them.
      assert.deepEqual(r.seeds, []);
      assert.ok(codes(r).includes('NO_MATCHING_NODE'), codes(r).join(','));
      const msg = r.warnings.find((w) => w.code === 'NO_MATCHING_NODE')?.message ?? '';
      assert.match(msg, /--min-conversations 1/, `the pruning remedy is named: ${msg}`);
      assert.match(msg, /only one conversation/);
      assert.match(msg, /three letters/);
      assert.match(msg, /gcr graph god-nodes/, 'the older pointers stay');
    } finally {
      g.close();
      await removeDir(d);
    }
  });
});
