/**
 * Adversarial review: the interplay of a long import with the read tools (MCP lens: "concurrency", "error-envelope
 * consistency", "tools that can read what they claim").
 *
 * The SDK refuses reads while a mutator runs (otherwise a half-imported batch would be presented as data, see the header of
 * src/sdk/gcr.ts) and docs/MCP_TOOLS.md says the MCP layer reports that as `DB_ERROR` / `write_in_progress`. The builder's own
 * report says this behaviour "is documented but not exercised by a test". It is exercised here: a gated byte stream keeps one
 * import running (and the writer lock held) for exactly as long as the test wants.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { dbContentHash, ID, connectMem, createFixture, linearChat, conversationsJson } from './mcp.helpers.test.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';

const NEW_ID = syntheticUuid(0x55);

/** An async byte stream that yields its first chunk at once and the rest only when `release()` is called. */
function gatedStream(text: string): { stream: AsyncIterable<Uint8Array>; release: () => void; started: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const bytes = Buffer.from(text, 'utf8');
  const cut = Math.floor(bytes.length / 2);
  async function* gen(): AsyncGenerator<Uint8Array> {
    yield bytes.subarray(0, cut);
    signalStarted();
    await gate;
    yield bytes.subarray(cut);
  }
  return { stream: gen(), release, started };
}

describe('reads while an import holds the writer lock', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture({ graph: true });
    h = await connectMem(fx.dbPath, { writable: true });
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  it('every read tool answers a coded DB_ERROR (write_in_progress) with a remedy, none shows uncommitted rows, and all recover afterwards', async () => {
    const listBefore = await h.env('gcr_list', {});
    const total = listBefore.data?.['total'];
    assert.equal(typeof total, 'number');
    const hashBefore = dbContentHash(fx.dbPath);

    const text = conversationsJson([linearChat(NEW_ID, 'imported while reading', [['a question', 'an answer']])]);
    const gated = gatedStream(text);
    const importing = h.gcr.importExport({ source: { kind: 'stream', stream: gated.stream, label: 'gated.json' } });
    await gated.started; // the import is running and has not committed

    const reads: Array<[string, Record<string, unknown>]> = [
      ['gcr_list', {}],
      ['gcr_get', { conversation: ID.linear }],
      ['gcr_search', { query: 'quokka' }],
      ['gcr_branches', { conversation: ID.branched }],
      ['gcr_thread', { conversation: ID.linear }],
      ['gcr_stats', { groupBy: 'role' }],
      ['gcr_audit', {}],
      ['gcr_graph_query', { term: 'quokka' }],
    ];
    for (const [tool, args] of reads) {
      const env = await h.env(tool, args);
      assert.equal(env.ok, false, tool);
      assert.equal(env.error?.code, 'DB_ERROR', tool);
      assert.equal(env.error?.details?.['reason'], 'write_in_progress', tool);
      assert.ok((env.error?.remedy ?? '').length > 0, `${tool}: the remedy says to retry`);
      assert.deepEqual(env.source, [], `${tool}: no provenance is claimed for data that was not read`);
    }
    // The database file is unchanged while the import is uncommitted (readers never saw, and nothing wrote, partial data).
    assert.equal(dbContentHash(fx.dbPath), hashBefore);

    // The doctor reads no conversation and is not blocked.
    assert.equal((await h.env('gcr_doctor', {})).ok, true);

    gated.release();
    const report = await importing;
    assert.equal(report.ok, true);

    const listAfter = await h.env('gcr_list', {});
    assert.equal(listAfter.data?.['total'], (total as number) + 1, 'the imported conversation is visible once the import committed');
    const got = await h.env('gcr_get', { conversation: NEW_ID });
    assert.equal(got.ok, true);
  });

  it('a write tool called during the import waits for it and then succeeds (serialized, never interleaved)', async () => {
    const text = conversationsJson([linearChat(syntheticUuid(0x56), 'second gated import', [['q2', 'a2']])]);
    const gated = gatedStream(text);
    const importing = h.gcr.importExport({ source: { kind: 'stream', stream: gated.stream, label: 'gated2.json' } });
    await gated.started;
    const draft = h.env('gcr_create_local_draft', { conversation: ID.linear, body: 'queued behind the import' });
    const settled = await Promise.race([draft.then(() => 'answered'), new Promise<string>((r) => setTimeout(() => r('waiting'), 300))]);
    assert.equal(settled, 'waiting', 'the draft write does not overtake the running import');
    gated.release();
    await importing;
    const env = await draft;
    assert.equal(env.ok, true, JSON.stringify(env.error));
  });
});
