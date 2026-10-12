/**
 * SPEC-03 at the CLI (compiled binary): the SPEC section 6 example `gcr graph query "EMBLEM-NLP" --depth 2` must not return an
 * empty graph silently. Every output format shows TERM_SPLIT for a hyphenated term and NO_MATCHING_NODE for an unmatched one.
 * SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { FORMATS, arr, assertOk, envelope, gcr, tempDir, writeFile } from './cli.helpers.test.js';

let dbPath = '';

before(async () => {
  const dir = tempDir('gcr-spec03-');
  const builders = [1, 2].map((n) => {
    const b = new ConversationBuilder({ id: syntheticUuid(0x70 + n), title: `GCR-SYNTHETIC-FIXTURE emblem ${n}` });
    let prev = b.root();
    prev = b.user(prev, 'Tell me about EMBLEM-NLP MCP servers please');
    b.assistant(prev, 'EMBLEM-NLP MCP servers are discussed at example.invalid with details', { model: 'synthetic-model-1' });
    return b;
  });
  dbPath = join(dir, 'ent.sqlite');
  assertOk(await gcr(['import', writeFile(dir, 'ent.json', `[${builders.map((b) => b.text()).join(',')}]`), '--db', dbPath, '--format', 'json']), 'import');
  assertOk(await gcr(['graph', 'build', '--db', dbPath, '--format', 'json']), 'graph build');
});

describe('SPEC-03: gcr graph query "EMBLEM-NLP" --depth 2', () => {
  it('json: seeds and nodes are returned, TERM_SPLIT names the tokens', async () => {
    const r = await gcr(['graph', 'query', 'EMBLEM-NLP', '--depth', '2', '--db', dbPath, '--format', 'json']);
    assertOk(r);
    const env = envelope(r.stdout);
    assert.deepEqual((env.data['seeds'] as string[]).slice().sort(), ['ent:keyword:emblem', 'ent:keyword:nlp']);
    assert.ok(arr(env.data['nodes']).length > 2);
    const w = env.warnings.find((x) => x.code === 'TERM_SPLIT');
    assert.ok(w !== undefined);
    assert.match(w.message, /emblem/);
    assert.match(w.message, /nlp/);
  });

  for (const format of FORMATS) {
    it(`${format}: the warning is visible`, async () => {
      const r = await gcr(['graph', 'query', 'emblem nlp', '--depth', '2', '--db', dbPath, '--format', format]);
      assertOk(r);
      assert.ok(r.stdout.includes('TERM_SPLIT'), `${format} output shows TERM_SPLIT`);
    });
  }

  it('an unmatched term: exit 0, empty graph, NO_MATCHING_NODE in every format', async () => {
    for (const format of FORMATS) {
      const r = await gcr(['graph', 'query', 'zzzunmatched', '--db', dbPath, '--format', format]);
      assertOk(r);
      assert.ok(r.stdout.includes('NO_MATCHING_NODE'), `${format} output shows NO_MATCHING_NODE`);
    }
    const env = envelope((await gcr(['graph', 'query', 'zzzunmatched', '--db', dbPath, '--format', 'json'])).stdout);
    assert.deepEqual(env.data['seeds'], []);
    assert.deepEqual(env.data['nodes'], []);
    assert.deepEqual(env.warnings.map((w) => w.code), ['NO_MATCHING_NODE']);
  });

  it('the help says hyphenated names are split into keywords', async () => {
    const r = await gcr(['graph', 'query', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /hyphen/i);
    assert.match(r.stdout, /keyword/i);
  });
});
