/**
 * SPEC-04 over MCP: gcr_search accepts scope "attachments" (enum + description), returns attachment hits with the same ids as
 * the SDK, refuses raw mode for them, and "all" includes them. Real SDK client, strict output schema. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { fileURLToPath } from 'node:url';
import { connectMem, fixedClock, makeTempDir, removeDir } from './mcp.helpers.test.js';
import type { MemHarness } from './mcp.helpers.test.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/chatgpt/attachments-citations.json', import.meta.url));

let dir = '';
let h: MemHarness;

before(async () => {
  dir = await makeTempDir();
  const dbPath = join(dir, 'att.sqlite');
  const gcr = Gcr.open({ dbPath, clock: fixedClock });
  try {
    await gcr.importExport({ source: { kind: 'path', path: FIXTURE } });
  } finally {
    gcr.close();
  }
  h = await connectMem(dbPath);
});

after(async () => {
  await h.close();
  await removeDir(dir);
});

interface Item {
  kind: string;
  messageId: string;
  conversationId: string;
  attachmentName: string | null;
  snippet: string;
}
const itemsOf = (data: unknown): Item[] => (data as { items: Item[] }).items;

describe('SPEC-04: gcr_search scope attachments', () => {
  it('the tool schema offers the scope and says metadata only', async () => {
    const tools = (await h.client.listTools()).tools;
    const search = tools.find((t) => t.name === 'gcr_search');
    assert.ok(search !== undefined);
    const props = (search.inputSchema as { properties?: Record<string, { enum?: string[]; description?: string }> }).properties ?? {};
    assert.deepEqual(props['scope']?.enum, ['messages', 'titles', 'attachments', 'all']);
    assert.match(props['scope']?.description ?? '', /metadata only/);
    assert.match(search.description ?? '', /names only, never file content/);
  });

  for (const query of ['synthetic-notes.txt', 'notes', 'diagram', 'synthetic-missing.pdf']) {
    it(`"${query}": hits equal the SDK's and carry ids and a snippet`, async () => {
      const env = await h.env('gcr_search', { query, scope: 'attachments' });
      assert.equal(env.ok, true);
      const items = itemsOf(env.data);
      const sdk = h.gcr.search({ query, scope: 'attachments' });
      assert.deepEqual(items.map((i) => `${i.messageId}:${i.attachmentName}`), sdk.data.items.map((i) => `${i.messageId}:${i.kind === 'attachment' ? i.attachmentName : ''}`));
      assert.ok(items.length >= 1);
      for (const i of items) {
        assert.equal(i.kind, 'attachment');
        assert.equal(i.conversationId, '00000000-0000-4000-8000-00000000000b');
        assert.ok(i.snippet.replace(/[\u0001\u0002]/g, '').includes(i.attachmentName ?? '\u0000'));
      }
      assert.deepEqual(env.warnings, sdk.warnings);
      assert.deepEqual(env.ids.messageIds && [...env.ids.messageIds].sort(), sdk.ids.messageIds && [...sdk.ids.messageIds].sort());
    });
  }

  it('scope all includes the attachments; the filters work; raw mode for attachments is INVALID_ARGUMENT', async () => {
    const all = await h.env('gcr_search', { query: 'notes', scope: 'all' });
    assert.equal(itemsOf(all.data).filter((i) => i.kind === 'attachment').length, 2);
    const filtered = await h.env('gcr_search', { query: 'synthetic', scope: 'attachments', conversation: '00000000-0000-4000-8000-00000000000b', limit: 2 });
    assert.equal(itemsOf(filtered.data).length, 2);
    assert.equal((filtered.data as { nextOffset: number | null }).nextOffset, 2);
    const raw = await h.env('gcr_search', { query: 'notes', scope: 'attachments', mode: 'raw' });
    assert.equal(raw.ok, false);
    assert.equal(raw.error?.code, 'INVALID_ARGUMENT');
    const bad = await h.env('gcr_search', { query: 'notes', scope: 'attachments', createdAfter: 'x' });
    assert.equal(bad.error?.details?.['field'], 'createdAfter');
  });
});
