/**
 * SPEC-04 at the CLI (compiled binary, child process): `gcr search --scope attachments|all` finds attachment FILE NAMES and MIME
 * types (metadata only) on the attachments-citations fixture, in every output format, honouring the filters; the refusals are
 * coded errors. Reproduction before the fix: `gcr search "synthetic-notes.txt" --scope all --format json` -> 0 items and the
 * scope list of `gcr search --help` was messages|titles|all. SYNTHETIC data only (fixtures/chatgpt/attachments-citations.json).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { FIXTURES, FORMATS, HOSTILE, arr, assertClean, assertJsonError, assertOk, assertTextError, envelope, gcr, parseJsonl, tempDir, writeFile } from './cli.helpers.test.js';
import type { Format } from './cli.helpers.test.js';

let dbPath = '';

before(async () => {
  const dir = tempDir('gcr-spec04-');
  dbPath = join(dir, 'att.sqlite');
  assertOk(await gcr(['import', join(FIXTURES, 'chatgpt', 'attachments-citations.json'), '--db', dbPath, '--format', 'json']), 'import');
});

async function search(args: string[], format: Format = 'json'): Promise<string> {
  const r = await gcr(['search', ...args, '--db', dbPath, '--format', format]);
  assertOk(r, `gcr search ${args.join(' ')} --format ${format}`);
  return r.stdout;
}

const hitNames = (stdout: string): unknown[] => arr(envelope(stdout).data['items']).map((i) => i['attachmentName']);

describe('SPEC-04: gcr search --scope attachments', () => {
  for (const [query, expected] of [
    ['synthetic-notes.txt', ['synthetic-notes.txt', 'synthetic-notes.txt']],
    ['synthetic-notes', ['synthetic-notes.txt', 'synthetic-notes.txt']],
    ['notes', ['synthetic-notes.txt', 'synthetic-notes.txt']],
    ['synthetic-diagram.png', ['synthetic-diagram.png']],
    ['diagram', ['synthetic-diagram.png']],
    ['synthetic-missing.pdf', ['synthetic-missing.pdf']],
  ] as const) {
    for (const scope of ['attachments', 'all']) {
      it(`--scope ${scope}: "${query}" finds ${expected.join(', ')}`, async () => {
        const out = await search([query, '--scope', scope]);
        assert.deepEqual(hitNames(out), [...expected]);
        const first = arr(envelope(out).data['items'])[0];
        assert.equal(first?.['kind'], 'attachment');
        assert.equal(first?.['conversationId'], '00000000-0000-4000-8000-00000000000b');
        assert.match(String(first?.['messageId']), /^00000000-0000-4000-8000-0000000000(10|12)$/);
        assert.ok(String(first?.['snippet']).includes('[[') && String(first?.['snippet']).includes(']]') || !String(first?.['snippet']).includes('\u0001'), 'highlight markers are made visible, never raw');
      });
    }
  }

  it('every output format shows the attachment name', async () => {
    for (const format of FORMATS) {
      const out = await search(['diagram', '--scope', 'attachments'], format);
      assert.ok(out.includes('synthetic-diagram.png'), `${format} output names the attachment`);
      if (format === 'jsonl') assert.ok(parseJsonl(out).some((l) => JSON.stringify(l).includes('"kind":"attachment"')));
    }
  });

  it('the default scope still finds nothing for a file name (metadata is not message text), --scope all now does', async () => {
    assert.deepEqual(arr(envelope(await search(['synthetic-notes.txt'])).data['items']), []);
    assert.equal(hitNames(await search(['synthetic-notes.txt', '--scope', 'all'])).length, 2);
  });

  it('no match: exit 0 and an empty page', async () => {
    assert.deepEqual(hitNames(await search(['nothing-like-this', '--scope', 'attachments'])), []);
  });

  it('filters: --conversation, --role, --after / --before, --limit / --offset, --include-hidden, --all-batches', async () => {
    assert.equal(hitNames(await search(['synthetic', '--scope', 'attachments', '--conversation', '00000000-0000-4000-8000-00000000000b'])).length, 4);
    assert.equal(hitNames(await search(['synthetic', '--scope', 'attachments', '--conversation', '00000000-0000-4000-8000-0000000000ff'])).length, 0);
    assert.equal(hitNames(await search(['synthetic', '--scope', 'attachments', '--role', 'assistant'])).length, 0);
    assert.equal(hitNames(await search(['synthetic', '--scope', 'attachments', '--after', '2099-01-01T00:00:00Z'])).length, 0);
    assert.equal(hitNames(await search(['synthetic', '--scope', 'attachments', '--before', '2099-01-01T00:00:00Z'])).length, 4);
    const paged = envelope(await search(['synthetic', '--scope', 'attachments', '--limit', '3']));
    assert.equal(arr(paged.data['items']).length, 3);
    assert.equal(paged.data['nextOffset'], 3);
    const rest = envelope(await search(['synthetic', '--scope', 'attachments', '--limit', '3', '--offset', '3']));
    assert.equal(arr(rest.data['items']).length, 1);
    assert.equal(rest.data['nextOffset'], null);
    assert.equal(hitNames(await search(['synthetic', '--scope', 'attachments', '--include-hidden'])).length, 4);
    const all = envelope(await search(['synthetic', '--scope', 'attachments', '--all-batches']));
    assert.equal(arr(all.data['items']).length, 4);
    assert.ok(all.warnings.some((w) => w.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED'));
  });

  it('refusals: --raw and --cursor with attachments are INVALID_ARGUMENT; a symbol-only query is too', async () => {
    assertTextError(await gcr(['search', 'notes', '--scope', 'attachments', '--raw', '--db', dbPath]), 'INVALID_ARGUMENT');
    assertTextError(await gcr(['search', 'notes', '--scope', 'attachments', '--cursor', 'abc', '--db', dbPath]), 'INVALID_ARGUMENT');
    assertJsonError(await gcr(['search', String.fromCodePoint(0x1f600), '--scope', 'attachments', '--format', 'json', '--db', dbPath]), 'INVALID_ARGUMENT');
    assertTextError(await gcr(['search', 'notes', '--scope', 'files', '--db', dbPath]), 'INVALID_ARGUMENT');
  });

  it('--scope all --raw keeps working and says that attachment names were not searched', async () => {
    const env = envelope(await search(['notes', '--scope', 'all', '--raw']));
    assert.deepEqual(arr(env.data['items']).filter((i) => i['kind'] === 'attachment'), []);
    assert.ok(env.warnings.some((w) => w.code === 'ATTACHMENTS_NOT_SEARCHED'));
  });

  it('the help names the attachments scope and says it is metadata only', async () => {
    const r = await gcr(['search', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /attachments/);
    assert.match(r.stdout, /metadata only/i);
    assert.match(r.stdout, /never read/i);
  });
});

describe('SPEC-04: hostile attachment names are data (terminal safety, NFR-04)', () => {
  it('ANSI, C1, bidi, line separator and TAG characters in a file name never reach the terminal raw, in any format', async () => {
    const dir = tempDir('gcr-spec04-hostile-');
    const b = new ConversationBuilder({ id: syntheticUuid(0xc1), title: 'GCR-SYNTHETIC-FIXTURE hostile attachments' });
    let prev = b.root();
    prev = b.user(prev, 'plain text', {
      attachments: [{ id: 'file-HOSTILE1', name: `report${HOSTILE.esc}[31m${HOSTILE.csi}0m${HOSTILE.rlo}fdp.exe${HOSTILE.lineSep}${HOSTILE.tag}.txt`, mime_type: 'text/plain' }],
    });
    b.assistant(prev, 'ok', { model: 'synthetic-model-1' });
    const db = join(dir, 'hostile.sqlite');
    assertOk(await gcr(['import', writeFile(dir, 'h.json', `[${b.text()}]`), '--db', db, '--format', 'json']), 'import');
    for (const scope of ['attachments', 'all']) {
      for (const format of FORMATS) {
        const r = await gcr(['search', 'report', '--scope', scope, '--db', db, '--format', format]);
        assertOk(r, `${scope} ${format}`);
        assertClean(r.stdout, `${scope} ${format}`);
        assert.ok(r.stdout.includes('report'), `${scope} ${format}: the hit is there`);
      }
    }
  });
});
