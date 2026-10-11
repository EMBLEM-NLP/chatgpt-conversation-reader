/**
 * Adversarial review of search paging: scope "all" (titles first, then messages) must page exactly like the concatenation
 * of the two single-scope listings for every page size, with no repeat, no skip and an honest end-of-results marker; keyset
 * paging and offset paging must agree.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { SearchItem } from '../../src/sdk/gcr.js';
import { chat, emptyDb, importBuilders } from './sdk.helpers.test.js';

const key = (i: SearchItem): string => (i.kind === 'title' ? `T:${i.conversationId}:${i.batchId}` : `M:${i.conversationId}:${i.messageId}:${i.batchId}`);

async function quokkaDb(conversations: number): ReturnType<typeof emptyDb> {
  const t = await emptyDb();
  const builders = [];
  for (let i = 1; i <= conversations; i++) {
    builders.push(chat(syntheticUuid(0x100 + i), `quokka title ${i}`, [[`quokka question ${i}`, `quokka answer ${i}`], ['more quokka text', 'and quokka again']]));
  }
  await importBuilders(t.gcr, t.dir, builders);
  return t;
}

describe('search scope "all" pages exactly like titles followed by messages', () => {
  it('every page size from 1 to beyond the total walks the same sequence; nextOffset always advances and ends with null', async () => {
    const t = await quokkaDb(7);
    try {
      const titles = t.gcr.search({ query: 'quokka', scope: 'titles', limit: 200 }).data.items.map(key);
      const messages = t.gcr.search({ query: 'quokka', limit: 200 }).data.items.map(key);
      assert.equal(titles.length, 7);
      assert.equal(messages.length, 28);
      const expected = [...titles, ...messages];
      for (const limit of [1, 2, 3, 5, 7, 8, 13, 27, 28, 29, 34, 35, 36, 50, 200]) {
        const walked: string[] = [];
        let offset = 0;
        for (let guard = 0; guard < 100; guard++) {
          const page = t.gcr.search({ query: 'quokka', scope: 'all', limit, offset });
          assert.ok(page.data.items.length <= limit);
          walked.push(...page.data.items.map(key));
          if (page.data.nextOffset === null) break;
          assert.ok(page.data.nextOffset > offset, `limit ${limit}: nextOffset must advance`);
          offset = page.data.nextOffset;
        }
        assert.deepEqual(walked, expected, `limit ${limit}`);
      }
    } finally {
      await t.cleanup();
    }
  });

  it('the end marker is exact at the title/message boundary and at the very end', async () => {
    const t = await quokkaDb(3);
    try {
      const total = 3 + 12;
      assert.equal(t.gcr.search({ query: 'quokka', scope: 'all', limit: total }).data.nextOffset, null, 'a page holding everything ends the listing');
      assert.equal(t.gcr.search({ query: 'quokka', scope: 'all', limit: total - 1 }).data.nextOffset, total - 1);
      const justTitles = t.gcr.search({ query: 'quokka', scope: 'all', limit: 3 });
      assert.deepEqual(justTitles.data.items.map((i) => i.kind), ['title', 'title', 'title']);
      assert.equal(justTitles.data.nextOffset, 3, 'messages still follow the titles');
      const past = t.gcr.search({ query: 'quokka', scope: 'all', limit: 5, offset: total });
      assert.deepEqual(past.data.items, []);
      assert.equal(past.data.nextOffset, null);
    } finally {
      await t.cleanup();
    }
  });

  it('keyset paging of message hits yields the same sequence as offset paging', async () => {
    const t = await quokkaDb(6);
    try {
      const byOffset = t.gcr.search({ query: 'quokka', limit: 200 }).data.items.map(key);
      for (const limit of [1, 4, 5, 24]) {
        const walked: string[] = [];
        let cursor: string | null | undefined;
        for (let guard = 0; guard < 100; guard++) {
          const page = t.gcr.search({ query: 'quokka', limit, ...(cursor ? { cursor } : {}) });
          walked.push(...page.data.items.map(key));
          cursor = page.data.nextCursor;
          if (!cursor) break;
        }
        assert.deepEqual(walked, byOffset, `limit ${limit}`);
      }
    } finally {
      await t.cleanup();
    }
  });
});
