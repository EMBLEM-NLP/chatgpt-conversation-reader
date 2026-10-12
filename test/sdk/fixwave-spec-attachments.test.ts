/**
 * SPEC-04 regression tests, SDK (`Gcr.search` scope "attachments" and "all"): FR-15 "attachment-aware search".
 *
 * Reproduction (before the fix): import fixtures/chatgpt/attachments-citations.json; `gcr get 00000000-0000-4000-8000-00000000000b`
 * showed the attachments (synthetic-notes.txt, synthetic-diagram.png, synthetic-missing.pdf) but `search "synthetic-notes.txt"`,
 * "synthetic-notes", "notes", "synthetic-diagram.png" and "diagram" with scope all returned 0 items, and there was no attachment scope.
 *
 * Pinned here: the three fixture names are found (substring, folded case, MIME type), "all" now includes attachment names (titles,
 * then messages, then attachments, paged consistently), the filters / hidden / all-batches behaviour, the argument rules
 * (raw mode, cursor), the warnings, and the metadata-only guarantee on the Claude fixture whose attachments carry extracted
 * file text. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import type { AttachmentSearchItem, MessageSearchItem, SearchItem, TitleSearchItem } from '../../src/sdk/gcr.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { assertCode, assertEnvelopeShape, fixedClock, importBuilders, makeTempDir, removeDir, title, warningCodes } from './sdk.helpers.test.js';

const FIXTURES = new URL('../../../fixtures/', import.meta.url).pathname;
const ATTACHMENT_CONVERSATION = '00000000-0000-4000-8000-00000000000b';

const attachments = (items: readonly SearchItem[]): AttachmentSearchItem[] => items.filter((i): i is AttachmentSearchItem => i.kind === 'attachment');
const messages = (items: readonly SearchItem[]): MessageSearchItem[] => items.filter((i): i is MessageSearchItem => i.kind === 'message');
const titles = (items: readonly SearchItem[]): TitleSearchItem[] => items.filter((i): i is TitleSearchItem => i.kind === 'title');
const nameList = (items: readonly SearchItem[]): Array<string | null> => attachments(items).map((i) => i.attachmentName);

describe('SPEC-04: the attachments-citations fixture (the reviewer reproduction)', () => {
  let dir = '';
  let gcr: Gcr;
  before(async () => {
    dir = await makeTempDir();
    gcr = Gcr.open({ dbPath: join(dir, 'att.sqlite'), clock: fixedClock });
    await gcr.importExport({ source: { kind: 'path', path: join(FIXTURES, 'chatgpt', 'attachments-citations.json') } });
  });
  after(async () => {
    gcr.close();
    await removeDir(dir);
  });

  it('the premise: get shows the three attachments of the 4-attachment message', () => {
    const env = gcr.get(ATTACHMENT_CONVERSATION);
    const withAttachments = env.data.thread?.messages.filter((m) => m.attachments.length > 0) ?? [];
    const seen = withAttachments.flatMap((m) => m.attachments.map((a) => a.name));
    for (const n of ['synthetic-notes.txt', 'synthetic-diagram.png', 'synthetic-missing.pdf']) assert.ok(seen.includes(n), `${n} is retained and displayed`);
  });

  for (const [query, expected] of [
    ['synthetic-notes.txt', ['synthetic-notes.txt', 'synthetic-notes.txt']],
    ['synthetic-notes', ['synthetic-notes.txt', 'synthetic-notes.txt']],
    ['notes', ['synthetic-notes.txt', 'synthetic-notes.txt']],
    ['SYNTHETIC-NOTES.TXT', ['synthetic-notes.txt', 'synthetic-notes.txt']],
    ['synthetic-diagram.png', ['synthetic-diagram.png']],
    ['diagram', ['synthetic-diagram.png']],
    ['synthetic-missing.pdf', ['synthetic-missing.pdf']],
    ['missing', ['synthetic-missing.pdf']],
    ['image/png', ['synthetic-diagram.png']],
    ['pdf', ['synthetic-missing.pdf']],
  ] as const) {
    it(`scope attachments: "${query}" finds ${expected.join(', ')}`, () => {
      const env = gcr.search({ query, scope: 'attachments' });
      assertEnvelopeShape(env);
      assert.deepEqual(nameList(env.data.items), [...expected]);
      assert.equal(env.completeness, 'exported_tree');
      assert.equal(env.untrustedContent, true);
      for (const hit of attachments(env.data.items)) {
        assert.equal(hit.kind, 'attachment');
        assert.equal(hit.conversationId, ATTACHMENT_CONVERSATION);
        assert.match(hit.messageId, /^00000000-0000-4000-8000-0000000000(10|12)$/);
        assert.equal(hit.provider, 'chatgpt');
        assert.ok(hit.snippet.includes(hit.attachmentName ?? 'x'.repeat(99)) || hit.snippet.replace(/[\u0001\u0002]/g, '').includes(hit.attachmentName ?? 'x'.repeat(99)), 'the snippet names the attachment');
      }
      assert.deepEqual([...(env.ids.messageIds ?? [])].sort(), [...new Set(attachments(env.data.items).map((i) => i.messageId))].sort());
      assert.deepEqual(env.ids.conversationIds, [ATTACHMENT_CONVERSATION]);
    });

    it(`scope all: "${query}" now includes the attachment names (and the default message scope still finds none)`, () => {
      const all = gcr.search({ query, scope: 'all' });
      assert.deepEqual(nameList(all.data.items), [...expected]);
      assert.equal(gcr.search({ query }).data.items.length, 0, 'message text does not contain attachment names');
    });
  }

  it('no match: an empty page, ok, no warning', () => {
    const env = gcr.search({ query: 'no-such-attachment', scope: 'attachments' });
    assert.deepEqual(env.data.items, []);
    assert.equal(env.data.nextOffset, null);
    assert.deepEqual(warningCodes(env), ['SOURCE_NOT_FULL_HISTORY'].filter(() => env.completeness !== 'exported_tree'));
  });

  it('metadata only: words of message text, attachment ids and asset pointers are not attachment hits', () => {
    // "citations" and "follow-up" are only in message text; "SYN0002" is an attachment id / asset pointer, never a name.
    for (const query of ['citations', 'follow-up', 'SYN0002', 'file-SYN0001', 'service']) {
      assert.equal(gcr.search({ query, scope: 'attachments' }).data.items.length, 0, query);
    }
    assert.ok(gcr.search({ query: 'citations' }).data.items.length > 0, 'control: message search does find the text');
  });

  it('the message filters apply: conversation, role, a time bound that excludes everything', () => {
    assert.equal(gcr.search({ query: 'synthetic', scope: 'attachments', conversationId: ATTACHMENT_CONVERSATION }).data.items.length, 4);
    assert.equal(gcr.search({ query: 'synthetic', scope: 'attachments', conversationId: `https://chatgpt.com/c/${ATTACHMENT_CONVERSATION}` }).data.items.length, 4, 'a link is a lookup key');
    assert.equal(gcr.search({ query: 'synthetic', scope: 'attachments', conversationId: syntheticUuid(0x99) }).data.items.length, 0);
    assert.equal(gcr.search({ query: 'synthetic', scope: 'attachments', role: 'assistant' }).data.items.length, 0);
    assert.equal(gcr.search({ query: 'synthetic', scope: 'attachments', createdAfter: '2099-01-01T00:00:00Z' }).data.items.length, 0);
    assert.equal(gcr.search({ query: 'synthetic', scope: 'attachments', provider: 'claude' }).data.items.length, 0);
  });

  it('paging is stable: limit 1 walks the 4 hits in the order of the full list', () => {
    const full = gcr.search({ query: 'synthetic', scope: 'attachments', limit: 200 }).data.items;
    assert.equal(full.length, 4);
    const walked: AttachmentSearchItem[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard++) {
      const env = gcr.search({ query: 'synthetic', scope: 'attachments', limit: 1, offset });
      walked.push(...attachments(env.data.items));
      if (env.data.nextOffset === null) break;
      offset = env.data.nextOffset;
    }
    assert.deepEqual(walked, full);
  });

  it('argument rules: raw mode and cursor are refused for attachments, with codes and fields', () => {
    const raw = assertCode(() => gcr.search({ query: 'notes', scope: 'attachments', mode: 'raw' }), 'INVALID_ARGUMENT');
    assert.equal(raw.details?.['field'], 'mode');
    const cursor = assertCode(() => gcr.search({ query: 'notes', scope: 'attachments', cursor: 'abc' }), 'INVALID_ARGUMENT');
    assert.equal(cursor.details?.['field'], 'cursor');
    assertCode(() => gcr.search({ query: '\u{1F600}', scope: 'attachments' }), 'INVALID_ARGUMENT');
    assertCode(() => gcr.search({ query: 'notes', scope: 'files' as 'attachments' }), 'INVALID_ARGUMENT');
  });

  it('scope titles and scope all still refuse the message filters', () => {
    assertCode(() => gcr.search({ query: 'notes', scope: 'titles', role: 'user' }), 'INVALID_ARGUMENT');
    assertCode(() => gcr.search({ query: 'notes', scope: 'all', role: 'user' }), 'INVALID_ARGUMENT');
    assertCode(() => gcr.search({ query: 'notes', scope: 'all', includeHidden: true }), 'INVALID_ARGUMENT');
  });

  it('scope all with raw mode skips the attachment part and says so (ATTACHMENTS_NOT_SEARCHED)', () => {
    const env = gcr.search({ query: 'notes', scope: 'all', mode: 'raw' });
    assert.deepEqual(attachments(env.data.items), []);
    assert.ok(warningCodes(env).includes('ATTACHMENTS_NOT_SEARCHED'));
    const plain = gcr.search({ query: 'notes', scope: 'all' });
    assert.ok(!warningCodes(plain).includes('ATTACHMENTS_NOT_SEARCHED'));
    assert.equal(attachments(plain.data.items).length, 2);
  });
});

describe('SPEC-04: scope "all" lists titles, then messages, then attachments, and pages consistently', () => {
  let dir = '';
  let gcr: Gcr;

  function reportConversation(n: number, titleWords: string, messageWords: string, files: ReadonlyArray<[string, string]>): ConversationBuilder {
    const b = new ConversationBuilder({ id: syntheticUuid(0x90 + n), title: title(titleWords) });
    let prev = b.root();
    prev = b.user(prev, messageWords, { attachments: files.map(([name, mime], i) => ({ id: `file-SYN${n}${i}`, name, mime_type: mime, size: 10 })) });
    b.assistant(prev, `an answer without the keyword ${n}`, { model: 'synthetic-model-1' });
    return b;
  }

  before(async () => {
    dir = await makeTempDir();
    gcr = Gcr.open({ dbPath: join(dir, 'all.sqlite'), clock: fixedClock });
    await importBuilders(gcr, dir, [
      reportConversation(1, 'quarterly report overview', 'please summarise the report', [['report-final.pdf', 'application/pdf'], ['chart.png', 'image/png']]),
      reportConversation(2, 'report archive', 'older report text', [['REPORT-draft.docx', 'application/msword']]),
      reportConversation(3, 'unrelated title', 'nothing to see', [['report-notes.txt', 'text/plain']]),
    ]);
  });
  after(async () => {
    gcr.close();
    await removeDir(dir);
  });

  const key = (i: SearchItem): string => (i.kind === 'title' ? `T:${i.conversationId}` : i.kind === 'message' ? `M:${i.messageId}` : `A:${i.messageId}#${i.attachmentIndex}`);

  it('the full list is titles first, then messages, then attachments', () => {
    const env = gcr.search({ query: 'report', scope: 'all', limit: 200 });
    const kinds = env.data.items.map((i) => i.kind);
    const firstMessage = kinds.indexOf('message');
    const firstAttachment = kinds.indexOf('attachment');
    assert.equal(titles(env.data.items).length, 2, 'two titles contain "report"');
    assert.equal(messages(env.data.items).length, 2, 'two messages contain "report"');
    assert.deepEqual(nameList(env.data.items).sort(), ['REPORT-draft.docx', 'report-final.pdf', 'report-notes.txt']);
    assert.ok(firstMessage >= 2 && firstAttachment >= firstMessage + 2, `order of kinds: ${kinds.join(',')}`);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => ['title', 'message', 'attachment'].indexOf(a) - ['title', 'message', 'attachment'].indexOf(b)));
    assert.equal(env.data.nextOffset, null);
    assert.deepEqual(env.ids.conversationIds && [...env.ids.conversationIds].sort(), [syntheticUuid(0x91), syntheticUuid(0x92), syntheticUuid(0x93)]);
  });

  it('every page size and offset cuts the same concatenation (no repeat, no gap) with a consistent nextOffset', () => {
    const full = gcr.search({ query: 'report', scope: 'all', limit: 200 }).data.items.map(key);
    assert.equal(full.length, 7);
    for (const size of [1, 2, 3, 4, 5, 7, 8]) {
      const walked: string[] = [];
      let offset = 0;
      for (let guard = 0; guard < 20; guard++) {
        const env = gcr.search({ query: 'report', scope: 'all', limit: size, offset });
        walked.push(...env.data.items.map(key));
        if (env.data.nextOffset === null) break;
        assert.equal(env.data.nextOffset, offset + env.data.items.length);
        offset = env.data.nextOffset;
      }
      assert.deepEqual(walked, full, `limit ${size}`);
    }
    // Any window straight out of the middle, including ones that start inside the attachment stream.
    for (let offset = 0; offset <= 8; offset++) {
      for (const limit of [1, 2, 3]) {
        const env = gcr.search({ query: 'report', scope: 'all', limit, offset });
        assert.deepEqual(env.data.items.map(key), full.slice(offset, offset + limit), `offset ${offset} limit ${limit}`);
        assert.equal(env.data.nextOffset === null, offset + limit >= full.length, `nextOffset at offset ${offset} limit ${limit}`);
      }
    }
  });

  it('a word that exists only as an attachment name is on the page after the (empty) title and message streams', () => {
    const env = gcr.search({ query: 'chart', scope: 'all' });
    assert.deepEqual(env.data.items.map((i) => i.kind), ['attachment']);
    assert.equal(nameList(env.data.items)[0], 'chart.png');
    const deep = gcr.search({ query: 'chart', scope: 'all', offset: 1 });
    assert.deepEqual(deep.data.items, []);
    assert.equal(deep.data.nextOffset, null);
  });

  it('raw mode keeps the old behaviour (titles then messages) and warns that attachments were not searched', () => {
    const env = gcr.search({ query: 'report', scope: 'all', mode: 'raw', limit: 200 });
    assert.deepEqual(env.data.items.map((i) => i.kind), ['title', 'title', 'message', 'message']);
    assert.ok(warningCodes(env).includes('ATTACHMENTS_NOT_SEARCHED'));
  });

  it('scope attachments honours allBatches: the warning appears and superseded snapshots are searched', async () => {
    const env = gcr.search({ query: 'report', scope: 'attachments', allBatches: true });
    assert.ok(warningCodes(env).includes('SUPERSEDED_SNAPSHOTS_INCLUDED'));
    assert.equal(env.data.items.length, 3);
  });
});

describe('SPEC-04: hidden messages and superseded snapshots', () => {
  it('attachments of hidden messages need includeHidden; an older snapshot needs allBatches', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: join(dir, 'h.sqlite'), clock: fixedClock });
    try {
      const id = syntheticUuid(0xa1);
      const make = (updateTime: number, file: string, hiddenFile: string): ConversationBuilder => {
        const b = new ConversationBuilder({ id, title: title('hidden attachments'), updateTime });
        let prev = b.root();
        prev = b.system(prev, 'scaffolding', { attachments: [{ id: 'file-HID', name: hiddenFile, mime_type: 'text/plain' }] });
        prev = b.user(prev, 'visible', { attachments: [{ id: 'file-VIS', name: file, mime_type: 'text/plain' }] });
        b.assistant(prev, 'ok', { model: 'synthetic-model-1' });
        return b;
      };
      await importBuilders(gcr, dir, [make(1_760_000_100, 'first-visible.txt', 'first-hidden.txt')], { sub: 'one' });
      await importBuilders(gcr, dir, [make(1_760_000_900, 'second-visible.txt', 'second-hidden.txt')], { sub: 'two' });
      assert.deepEqual(nameList(gcr.search({ query: 'txt', scope: 'attachments' }).data.items), ['second-visible.txt']);
      assert.deepEqual(nameList(gcr.search({ query: 'txt', scope: 'attachments', includeHidden: true }).data.items).sort(), ['second-hidden.txt', 'second-visible.txt']);
      assert.deepEqual(nameList(gcr.search({ query: 'txt', scope: 'attachments', allBatches: true }).data.items).sort(), ['first-visible.txt', 'second-visible.txt']);
      const everything = gcr.search({ query: 'txt', scope: 'attachments', allBatches: true, includeHidden: true, limit: 200 });
      assert.equal(everything.data.items.length, 4);
      assert.equal(attachments(everything.data.items).filter((i) => i.hidden).length, 2);
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });
});

describe('SPEC-04: Claude attachments (file text is NOT searched)', () => {
  it('names and types of the Claude fixture are found, the extracted file text is not', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: join(dir, 'c.sqlite'), clock: fixedClock });
    try {
      await gcr.importExport({ source: { kind: 'path', path: join(FIXTURES, 'claude', 'attachments-files.json') }, provider: 'claude' });
      const names = nameList(gcr.search({ query: 'synthetic', scope: 'attachments' }).data.items).sort();
      assert.ok(names.includes('synthetic-notes.txt'), names.join(','));
      assert.ok(names.includes('synthetic-table.csv'), names.join(','));
      assert.equal(gcr.search({ query: 'EXTRACTED-TEXT', scope: 'attachments' }).data.items.length, 0, 'extracted file content is never searched');
      const hit = gcr.search({ query: 'notes', scope: 'attachments' }).data.items[0];
      assert.equal(hit?.kind, 'attachment');
      assert.equal(hit?.provider, 'claude');
      assert.equal(gcr.search({ query: 'notes', scope: 'attachments' }).completeness, 'rendered_active_view_only');
      assert.equal(warningCodes(gcr.search({ query: 'notes', scope: 'attachments' }))[0], 'SOURCE_NOT_FULL_HISTORY');
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });
});
