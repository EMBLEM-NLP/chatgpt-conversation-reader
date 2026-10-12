/**
 * SPEC-03 regression tests (medium): the SPEC section 6 example `gcr graph query "EMBLEM-NLP" --depth 2` returned an EMPTY
 * graph (ok, exit 0, no warning) although the data contained that exact text, because the keyword extractor stores a hyphenated
 * name as separate keywords ("emblem", "nlp") and the term was only matched as a whole.
 *
 * Reproduction (before the fix): a synthetic export with two conversations that both contain "EMBLEM-NLP MCP servers",
 * `graph build`, then `graph query "EMBLEM-NLP" --depth 2` -> seeds 0, nodes 0, warnings []; the same for "emblem-nlp",
 * "EMBLEM NLP" and "emblem nlp", while "EMBLEM" -> 1 seed.
 *
 * Fixed behaviour: (a) whole-term lookup as before; (b) no seed and a term with a hyphen / underscore / dot between letters /
 * white space: split into the keyword tokens the extractor produces, seed ALL keyword nodes matching any token, warning TERM_SPLIT
 * (names the tokens); (c) still no seed: empty graph WITH warning NO_MATCHING_NODE (GRAPH_EMPTY when the graph has no nodes).
 * Extraction and the stored graph are unchanged. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { extractEntities } from '../../src/entities/extract.js';
import { termKeywords } from '../../src/graph/query.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { fixedClock, importBuilders, makeTempDir, removeDir, title } from '../sdk/sdk.helpers.test.js';

export const SPEC03_TEXT = 'EMBLEM-NLP MCP servers';

/** Two conversations that both contain "EMBLEM-NLP MCP servers" (so the default 2-conversation minimum keeps the keywords). */
export function emblemConversations(): ConversationBuilder[] {
  return [1, 2].map((n) => {
    const b = new ConversationBuilder({ id: syntheticUuid(0x70 + n), title: title(`emblem ${n}`) });
    let prev = b.root();
    prev = b.user(prev, `Tell me about ${SPEC03_TEXT} please`);
    b.assistant(prev, `${SPEC03_TEXT} are discussed at example.invalid with details, see https://example.invalid/docs`, { model: 'synthetic-model-1' });
    return b;
  });
}

let dir = '';
let gcr: Gcr;

before(async () => {
  dir = await makeTempDir();
  gcr = Gcr.open({ dbPath: join(dir, 'g.sqlite'), clock: fixedClock });
  await importBuilders(gcr, dir, emblemConversations());
  await gcr.buildGraph();
});

after(async () => {
  gcr.close();
  await removeDir(dir);
});

const KW = (w: string): string => `ent:keyword:${w}`;
const codes = (r: { warnings: Array<{ code: string }> }): string[] => r.warnings.map((w) => w.code);

describe('SPEC-03: the premise (what the graph holds)', () => {
  it('the hyphenated name is stored as separate keyword nodes, never as one node', () => {
    const labels = gcr.graphGodNodes({ limit: 50 }).data.map((g) => g.node.id);
    for (const w of ['emblem', 'nlp', 'mcp', 'servers']) assert.ok(labels.includes(KW(w)), `${w} is a node`);
    assert.ok(!labels.includes(KW('emblem-nlp')));
  });
});

describe('SPEC-03: termKeywords mirrors the keyword extractor', () => {
  it('returns exactly the keyword tokens extractEntities produces for the same text (sorted, unique)', () => {
    for (const t of ['EMBLEM-NLP', 'emblem nlp', 'the-quokka', 'MCP_servers v2.3', 'node.js runtime', 'foo.bar baz', 'Café-au-lait']) {
      const expected = Array.from(new Set(extractEntities({ text: t.normalize('NFKC') }, { maxKeywords: 1000, maxPerKind: 1000 }).filter((e) => e.kind === 'keyword').map((e) => e.normalized))).sort();
      assert.deepEqual(termKeywords(t), expected, t);
    }
  });
  it('only terms with a hyphen, underscore, white space or a dot between letters are split', () => {
    assert.deepEqual(termKeywords('emblem'), []);
    assert.deepEqual(termKeywords('emblem/nlp'), [], 'a slash is not a trigger');
    assert.deepEqual(termKeywords('emblem.'), [], 'a trailing dot is not between letters');
    assert.deepEqual(termKeywords('emblem-nlp'), ['emblem', 'nlp']);
    assert.deepEqual(termKeywords('emblem_nlp'), ['emblem', 'nlp']);
    assert.deepEqual(termKeywords('emblem nlp'), ['emblem', 'nlp']);
    assert.deepEqual(termKeywords('emblem.nlp'), ['emblem', 'nlp']);
    assert.deepEqual(termKeywords('emblem–nlp'), ['emblem', 'nlp'], 'en dash');
    assert.deepEqual(termKeywords('a-b'), [], 'no keyword (shorter than three letters)');
  });
});

describe('SPEC-03: a hyphenated or spaced term is split, never a silent empty result', () => {
  for (const term of ['EMBLEM-NLP', 'emblem-nlp', 'EMBLEM NLP', 'emblem nlp', 'emblem_nlp', 'Emblem–NLP']) {
    it(`"${term}" --depth 2: seeds are the keyword nodes of both tokens, with TERM_SPLIT naming them`, () => {
      const env = gcr.graphQuery({ term, depth: 2 });
      const r = env.data;
      assert.deepEqual([...r.seeds].sort(), [KW('emblem'), KW('nlp')]);
      assert.ok(r.nodes.length > 2, 'the neighbourhood is returned');
      assert.ok(r.nodes.some((n) => n.id === KW('mcp')), 'depth 2 reaches the co-occurring keyword');
      const w = r.warnings.find((x) => x.code === 'TERM_SPLIT');
      assert.ok(w !== undefined, `TERM_SPLIT is reported: ${codes(r).join(',')}`);
      assert.match(w.message, /emblem/);
      assert.match(w.message, /nlp/);
      assert.deepEqual(codes(env), codes(r), 'the SDK envelope carries exactly the module warnings (no SOURCE_NOT_FULL_HISTORY: exported_tree)');
    });
  }

  it('a token without a node is named as missing, the others still seed', () => {
    const r = gcr.graphQuery({ term: 'emblem-zzzunknown' }).data;
    assert.deepEqual(r.seeds, [KW('emblem')]);
    const w = r.warnings.find((x) => x.code === 'TERM_SPLIT');
    assert.ok(w !== undefined);
    assert.match(w.message, /No node exists for: zzzunknown/);
  });

  it('the whole-term lookup comes first: when it matches there is no split and no warning', () => {
    for (const term of ['EMBLEM', 'emblem', 'MCP', 'example.invalid']) {
      const r = gcr.graphQuery({ term, depth: 2 }).data;
      assert.ok(r.seeds.length >= 1, term);
      assert.ok(!codes(r).includes('TERM_SPLIT'), `${term}: no TERM_SPLIT`);
      assert.ok(!codes(r).includes('NO_MATCHING_NODE'), `${term}: no NO_MATCHING_NODE`);
    }
  });

  it('is deterministic: the same call twice gives the identical answer', () => {
    const a = JSON.stringify(gcr.graphQuery({ term: 'MCP-servers-EMBLEM', depth: 2 }).data);
    const b = JSON.stringify(gcr.graphQuery({ term: 'MCP-servers-EMBLEM', depth: 2 }).data);
    assert.equal(a, b);
  });

  it('the kinds filter still applies to split seeds', () => {
    const r = gcr.graphQuery({ term: 'EMBLEM-NLP', kinds: ['url'] }).data;
    assert.deepEqual(r.seeds, []);
    assert.deepEqual(codes(r), ['NO_MATCHING_NODE']);
    assert.match(r.warnings[0]?.message ?? '', /among the requested kinds/);
  });

  it('maxNodes bounds the seeds of a split exactly like whole-term seeds', () => {
    const r = gcr.graphQuery({ term: 'emblem-nlp-mcp-servers', maxNodes: 2 }).data;
    assert.equal(r.nodes.length, 2);
    assert.ok(codes(r).includes('TERM_SPLIT'));
    assert.ok(codes(r).includes('SEEDS_TRUNCATED'));
  });
});

describe('SPEC-03: no matching node is reported, not silent', () => {
  for (const term of ['zzzunmatched', 'zzz-qqq', 'a-b', 'no such term at all']) {
    it(`"${term}": empty graph WITH NO_MATCHING_NODE (and no TERM_SPLIT)`, () => {
      const env = gcr.graphQuery({ term });
      assert.deepEqual(env.data.seeds, []);
      assert.deepEqual(env.data.nodes, []);
      assert.deepEqual(env.data.edges, []);
      assert.deepEqual(codes(env.data), ['NO_MATCHING_NODE']);
      const msg = env.data.warnings[0]?.message ?? '';
      assert.match(msg, /No node matched the term/);
      assert.match(msg, /gcr graph god-nodes/);
      assert.match(msg, /different term/);
      assert.equal(env.ok, true, 'still a successful (empty) answer, not an error');
    });
  }

  it('a database without any graph says GRAPH_EMPTY (the more specific warning), not NO_MATCHING_NODE', async () => {
    const empty = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      const r = empty.graphQuery({ term: 'EMBLEM-NLP' }).data;
      assert.deepEqual(codes(r), ['GRAPH_EMPTY']);
    } finally {
      empty.close();
    }
  });
});
