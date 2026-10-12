/**
 * SPEC-08 at the CLI (compiled binary, child process): an emoji-only query exits 2 with INVALID_ARGUMENT and the clearer message,
 * on stderr only, in text and JSON mode; the help of `search` documents that symbols are not indexed. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { assertJsonError, assertTextError, gcr, templateDb } from './cli.helpers.test.js';

let dbPath = '';
before(async () => {
  ({ dbPath } = await templateDb());
});

const GRIN = String.fromCodePoint(0x1f600);

describe('SPEC-08: gcr search with a symbol-only query', () => {
  it('text mode: error[INVALID_ARGUMENT] with the new message, exit 2, empty stdout', async () => {
    const r = await gcr(['search', GRIN, '--db', dbPath]);
    assertTextError(r, 'INVALID_ARGUMENT');
    assert.match(r.stderr, /the query contains only symbols or punctuation, which are not indexed; search for words/);
  });

  it('json mode: the error document carries the same message and details.field', async () => {
    const env = assertJsonError(await gcr(['search', GRIN, '--format', 'json', '--db', dbPath]), 'INVALID_ARGUMENT');
    assert.match(env.error.message, /only symbols or punctuation, which are not indexed/);
    assert.equal(env.error.details?.['field'], 'query');
  });

  it('every scope refuses it the same way', async () => {
    for (const scope of ['messages', 'titles', 'all']) {
      assertTextError(await gcr(['search', GRIN, '--scope', scope, '--db', dbPath]), 'INVALID_ARGUMENT');
    }
  });

  it('the search help says that emoji and other symbols are not indexed', async () => {
    const r = await gcr(['search', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /emoji/i);
    assert.match(r.stdout, /not indexed/i);
  });
});
