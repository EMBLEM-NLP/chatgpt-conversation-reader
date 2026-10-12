/**
 * SPEC-04 regression tests, storage layer (src/db/search.ts): FR-15 "attachment-aware search" was only true for DISPLAY - `gcr get`
 * showed attachment names, but no search scope found them (`search "synthetic-notes.txt" --scope all` -> 0 items).
 *
 * `searchAttachments` matches the FILE NAMES and MIME types stored in `messages.attachments_json` (metadata only, never file
 * content; no schema change: the messages that have attachments are scanned and folded in JavaScript). These tests pin: substring
 * and AND-of-words behaviour, case / accent / width / ligature folding, one hit per attachment, no match, filters (hidden, all
 * batches, role, conversation, time, provider, account), stable offset paging, the metadata-only guarantee, hostile names,
 * damaged stored lists, and the message-hit counter used by scope "all". SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { countMessageHits, searchAttachments, searchMessages } from '../../src/db/search.js';
import type { AttachmentHit, AttachmentSearchQuery } from '../../src/db/search.js';
import type { AttachmentRef, ConversationRecord } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'export.zip',
  contentDigest: 'att-1',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

let attSeq = 0;

/** An attachment reference; the id is always a plain synthetic token (the record validator refuses control characters in ids). */
function att(name: string | null, mimeType: string | null = null, over: Partial<AttachmentRef> = {}): AttachmentRef {
  attSeq++;
  return { id: `file-${attSeq}`, name, mimeType, sizeBytes: 100, assetPointer: null, presentInExportAs: null, ...over };
}

interface Spec {
  id?: string;
  text?: string;
  role?: string;
  hidden?: boolean;
  createdAt?: string | null;
  channel?: string | null;
  model?: string | null;
  attachments?: AttachmentRef[];
}

/** Linear conversation; message i is created at minute i+1 unless given. */
function conv(id: string, specs: Spec[], over: Partial<ConversationRecord> = {}): ConversationRecord {
  let prev: string | null = null;
  const msgs = specs.map((s, i) => {
    const mid = s.id ?? `${id}-m${i}`;
    const m = msg({
      id: mid,
      conversationId: id,
      parentId: prev,
      authorRole: s.role ?? 'user',
      text: s.text ?? `message ${i}`,
      hidden: s.hidden ?? false,
      createdAt: s.createdAt === undefined ? iso(i + 1) : s.createdAt,
      channel: s.channel ?? null,
      modelSlug: s.model ?? null,
      attachments: s.attachments ?? [],
      ordinal: i,
    });
    prev = mid;
    return m;
  });
  return convo(id, link(msgs), { currentNodeId: prev, ...over });
}

async function setup(convs: ConversationRecord[], meta: Partial<ImportBatchMeta> = {}): Promise<{ db: DatabaseSync; repo: Repository }> {
  const h = openDatabase(':memory:');
  const repo = new Repository(h.db);
  await repo.importBatch({ batch: { ...META, ...meta }, conversations: convs });
  return { db: h.db, repo };
}

const search = (db: DatabaseSync, query: string, over: Partial<AttachmentSearchQuery> = {}): AttachmentHit[] => searchAttachments(db, { query, ...over }).page.items;
const names = (hits: readonly AttachmentHit[]): Array<string | null> => hits.map((h) => h.attachmentName);
const expectCode = (code: string): ((e: unknown) => boolean) => (e) => e instanceof GcrError && e.code === code;

/** The three names of fixtures/chatgpt/attachments-citations.json in one message, plus a second message with one of them. */
const NOTES = att('synthetic-notes.txt', 'text/plain');
const DIAGRAM = att('synthetic-diagram.png', 'image/png');
const MISSING = att('synthetic-missing.pdf', 'application/pdf');

async function fixtureDb(): Promise<DatabaseSync> {
  const { db } = await setup([
    conv('c1', [{ text: 'hello' }, { id: 'c1-att', role: 'user', attachments: [NOTES, DIAGRAM, MISSING] }, { id: 'c1-again', role: 'assistant', attachments: [NOTES] }]),
  ]);
  return db;
}

describe('SPEC-04: searchAttachments finds file names and MIME types (metadata only)', () => {
  it('the exact name, the stem, a word of the name, the extension and a substring of a word all find it', async () => {
    const db = await fixtureDb();
    for (const q of ['synthetic-notes.txt', 'synthetic-notes', 'notes', 'txt', 'ynthetic-note', 'NOTES', 'Notes.TXT']) {
      assert.deepEqual(
        names(search(db, q)),
        ['synthetic-notes.txt', 'synthetic-notes.txt'],
        `${q}: the attachment of the first and of the third message`,
      );
    }
    assert.deepEqual(names(search(db, 'synthetic-diagram.png')), ['synthetic-diagram.png']);
    assert.deepEqual(names(search(db, 'diagram')), ['synthetic-diagram.png']);
    assert.deepEqual(names(search(db, 'synthetic-missing.pdf')), ['synthetic-missing.pdf']);
  });

  it('"synthetic" matches all three names (and the second message): one hit per attachment, with its position', async () => {
    const db = await fixtureDb();
    const hits = search(db, 'synthetic');
    assert.deepEqual(
      hits.map((h) => `${h.messageId}#${h.attachmentIndex}:${h.attachmentName}`),
      ['c1-att#0:synthetic-notes.txt', 'c1-att#1:synthetic-diagram.png', 'c1-att#2:synthetic-missing.pdf', 'c1-again#0:synthetic-notes.txt'],
    );
  });

  it('MIME types are searched: "image/png", "application pdf", "text plain" and the sub-type alone', async () => {
    const db = await fixtureDb();
    assert.deepEqual(names(search(db, 'image/png')), ['synthetic-diagram.png']);
    assert.deepEqual(names(search(db, 'application pdf')), ['synthetic-missing.pdf']);
    assert.deepEqual(names(search(db, 'text/plain')), ['synthetic-notes.txt', 'synthetic-notes.txt']);
    assert.deepEqual(names(search(db, 'plain')), ['synthetic-notes.txt', 'synthetic-notes.txt']);
  });

  it('every search word must match (AND), in the name OR the type, in any order', async () => {
    const db = await fixtureDb();
    assert.deepEqual(names(search(db, 'diagram png')), ['synthetic-diagram.png']);
    assert.deepEqual(names(search(db, 'png diagram')), ['synthetic-diagram.png']);
    assert.deepEqual(names(search(db, 'diagram image')), ['synthetic-diagram.png'], 'one word in the name, one in the MIME type');
    assert.deepEqual(search(db, 'diagram pdf'), [], 'the words must belong to the SAME attachment');
    assert.deepEqual(names(search(db, '"synthetic notes"')), ['synthetic-notes.txt', 'synthetic-notes.txt'], 'a quoted phrase is words in sequence');
  });

  it('no match is an empty page, not an error', async () => {
    const db = await fixtureDb();
    const r = searchAttachments(db, { query: 'nonexistent-file' });
    assert.deepEqual(r.page.items, []);
    assert.equal(r.page.nextOffset, null);
    assert.equal(r.unreadableMessages, 0);
  });

  it('hits carry the same identifying fields as other hits and a snippet that names the attachment', async () => {
    const db = await fixtureDb();
    const h = search(db, 'diagram')[0];
    assert.ok(h !== undefined);
    assert.equal(h.provider, 'chatgpt');
    assert.equal(h.accountLabel, 'default');
    assert.equal(h.conversationId, 'c1');
    assert.equal(h.conversationTitle, 'Synthetic c1');
    assert.equal(h.messageId, 'c1-att');
    assert.equal(h.authorRole, 'user');
    assert.equal(h.hidden, false);
    assert.match(h.attachmentId ?? '', /^file-\d+$/);
    assert.equal(h.attachmentMimeType, 'image/png');
    assert.equal(h.attachmentSizeBytes, 100);
    assert.equal(typeof h.batchId, 'string');
    assert.ok(h.createdAt !== null);
    assert.equal(h.snippet.replace(/[\u0001\u0002]/g, ''), 'synthetic-diagram.png (image/png)');
    assert.ok(h.snippet.includes('\u0001diagram\u0002'), `the matched word is marked: ${JSON.stringify(h.snippet)}`);
  });
});

describe('SPEC-04: folding is the one of every other search', () => {
  it('case, accents (precomposed and decomposed), fullwidth letters and ligatures are ignored; CJK matches by character', async () => {
    const { db } = await setup([
      conv('f1', [
        { id: 'f1-a', attachments: [att('Café Menu.PDF', 'application/pdf')] },
        { id: 'f1-b', attachments: [att('Café Report.txt')] },
        { id: 'f1-c', attachments: [att('ＡＢＣ wide.docx')] },
        { id: 'f1-d', attachments: [att('ﬁnal draft.md')] },
        { id: 'f1-e', attachments: [att('東京と日本.xlsx')] },
        { id: 'f1-f', attachments: [att('ОТЧЁТ.pdf')] },
        { id: 'f1-g', attachments: [att('Straße.pdf')] },
      ]),
    ]);
    const ids = (q: string): string[] => search(db, q).map((h) => h.messageId).sort();
    assert.deepEqual(ids('cafe'), ['f1-a', 'f1-b']);
    assert.deepEqual(ids('CAFÉ'), ['f1-a', 'f1-b']);
    assert.deepEqual(ids('Café'), ['f1-a', 'f1-b']);
    assert.deepEqual(ids('abc'), ['f1-c']);
    assert.deepEqual(ids('ＡＢＣ'), ['f1-c']);
    assert.deepEqual(ids('final'), ['f1-d']);
    assert.deepEqual(ids('東京'), ['f1-e']);
    assert.deepEqual(ids('日本'), ['f1-e']);
    assert.deepEqual(ids('京東'), [], 'out of order is not a match');
    assert.deepEqual(ids('отчёт'), ['f1-f'], 'Cyrillic case');
    assert.deepEqual(ids('strasse'), [], 'sharp s is not folded to ss (same documented limitation as message search)');
    assert.deepEqual(ids('straße'), ['f1-g']);
  });
});

describe('SPEC-04: metadata only', () => {
  it('message TEXT never matches, asset pointers and archive paths are not searched, only the name and the type are', async () => {
    const { db } = await setup([
      conv('m1', [
        { id: 'm1-text', text: 'please open quarterly-budget.xlsx', attachments: [] },
        { id: 'm1-att', text: 'plain', attachments: [att('slides.pptx', 'application/vnd.ms-powerpoint', { assetPointer: ['file', 'service://file', 'secretpointer'].join('-'), presentInExportAs: 'files/hiddenarchivepath.bin' })] },
      ]),
    ]);
    assert.deepEqual(search(db, 'quarterly-budget'), [], 'a name that appears only in message text is not an attachment');
    assert.deepEqual(search(db, 'secretpointer'), [], 'the asset pointer is not searched');
    assert.deepEqual(search(db, 'hiddenarchivepath'), [], 'the archive path is not searched');
    assert.deepEqual(names(search(db, 'slides')), ['slides.pptx']);
    assert.deepEqual(names(search(db, 'powerpoint')), ['slides.pptx']);
  });

  it('an attachment without a name is still found by its MIME type and shown as "(no name)"', async () => {
    const { db } = await setup([conv('n1', [{ id: 'n1-a', attachments: [att(null, 'image/webp'), att('', 'image/webp')] }])]);
    const hits = search(db, 'webp');
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.attachmentName), [null, '']);
    assert.ok(hits.every((h) => h.snippet.replace(/[\u0001\u0002]/g, '') === '(no name) (image/webp)'));
  });

  it('messages without attachments cost nothing and never appear', async () => {
    const { db } = await setup([conv('p1', [{ text: 'synthetic-notes.txt' }, { text: 'other' }])]);
    assert.deepEqual(search(db, 'synthetic'), []);
  });
});

describe('SPEC-04: filters are the filters of message search', () => {
  it('hidden messages are skipped unless includeHidden', async () => {
    const { db } = await setup([conv('h1', [{ id: 'h1-vis', attachments: [att('visible-file.txt')] }, { id: 'h1-hid', hidden: true, attachments: [att('hidden-file.txt')] }])]);
    assert.deepEqual(names(search(db, 'file')), ['visible-file.txt']);
    assert.deepEqual(names(search(db, 'file', { includeHidden: true })), ['visible-file.txt', 'hidden-file.txt']);
    assert.equal(search(db, 'hidden', { includeHidden: true })[0]?.hidden, true);
  });

  it('only the head batch is searched unless allBatches', async () => {
    const h = openDatabase(':memory:');
    const repo = new Repository(h.db);
    const old = conv('s1', [{ id: 's1-a', attachments: [att('old-version.txt')] }], { updatedAt: iso(10) });
    const fresh = conv('s1', [{ id: 's1-a', attachments: [att('new-version.txt')] }], { updatedAt: iso(20) });
    await repo.importBatch({ batch: { ...META, contentDigest: 'b-old' }, conversations: [old] });
    await repo.importBatch({ batch: { ...META, contentDigest: 'b-new', importedAt: '2025-03-01T00:00:00.000Z' }, conversations: [fresh] });
    assert.deepEqual(names(search(h.db, 'version')), ['new-version.txt']);
    assert.deepEqual(names(search(h.db, 'version', { allBatches: true })).sort(), ['new-version.txt', 'old-version.txt']);
  });

  it('role, channel, hasModel, conversationId, createdAfter / createdBefore and provider / accountLabel narrow the hits', async () => {
    const { db } = await setup([
      conv('k1', [
        { id: 'k1-u', role: 'user', createdAt: iso(1), attachments: [att('doc-one.txt')] },
        { id: 'k1-a', role: 'assistant', createdAt: iso(5), channel: 'final', model: 'synthetic-model-1', attachments: [att('doc-two.txt')] },
        { id: 'k1-n', role: 'user', createdAt: null, attachments: [att('doc-three.txt')] },
      ]),
      conv('k2', [{ id: 'k2-u', role: 'user', createdAt: iso(3), attachments: [att('doc-four.txt')] }]),
    ]);
    assert.deepEqual(names(search(db, 'doc')), ['doc-one.txt', 'doc-four.txt', 'doc-two.txt', 'doc-three.txt'], 'chronological, undated last');
    assert.deepEqual(names(search(db, 'doc', { role: 'assistant' })), ['doc-two.txt']);
    assert.deepEqual(names(search(db, 'doc', { channel: 'final' })), ['doc-two.txt']);
    assert.deepEqual(names(search(db, 'doc', { hasModel: true })), ['doc-two.txt']);
    assert.deepEqual(names(search(db, 'doc', { hasModel: false })), ['doc-one.txt', 'doc-four.txt', 'doc-three.txt']);
    assert.deepEqual(names(search(db, 'doc', { conversationId: 'k2' })), ['doc-four.txt']);
    assert.deepEqual(names(search(db, 'doc', { createdAfter: iso(3) })), ['doc-four.txt', 'doc-two.txt'], 'inclusive lower bound; undated messages never match a bound');
    assert.deepEqual(names(search(db, 'doc', { createdBefore: iso(3) })), ['doc-one.txt'], 'exclusive upper bound');
    assert.deepEqual(names(search(db, 'doc', { provider: 'chatgpt', accountLabel: 'default' })).length, 4);
    assert.deepEqual(search(db, 'doc', { provider: 'claude' }), []);
    assert.deepEqual(search(db, 'doc', { accountLabel: 'other' }), []);
  });
});

describe('SPEC-04: paging is stable', () => {
  it('pages of 1, 2 and 3 concatenate to the full list, in the same order, with consistent nextOffset', async () => {
    const files = Array.from({ length: 7 }, (_, i) => att(`page-file-${i}.txt`, 'text/plain'));
    const { db } = await setup([conv('g1', files.map((a, i) => ({ id: `g1-${i}`, attachments: [a] }))), conv('g2', [{ id: 'g2-0', attachments: [att('page-file-x.txt'), att('page-file-y.txt')] }])]);
    const full = search(db, 'page-file', { limit: 200 });
    assert.equal(full.length, 9);
    for (const size of [1, 2, 3, 4, 9, 10]) {
      const seen: string[] = [];
      let offset = 0;
      for (let guard = 0; guard < 30; guard++) {
        const { page } = searchAttachments(db, { query: 'page-file', limit: size, offset });
        seen.push(...page.items.map((h) => `${h.messageId}#${h.attachmentIndex}`));
        if (page.nextOffset === null) break;
        assert.equal(page.nextOffset, offset + page.items.length);
        offset = page.nextOffset;
      }
      assert.deepEqual(seen, full.map((h) => `${h.messageId}#${h.attachmentIndex}`), `limit ${size}`);
    }
    assert.deepEqual(search(db, 'page-file', { limit: 3, offset: 100 }), [], 'an offset past the end is an empty page');
    assert.equal(searchAttachments(db, { query: 'page-file', limit: 3, offset: 100 }).page.nextOffset, null);
    const again = search(db, 'page-file', { limit: 200 });
    assert.deepEqual(again, full, 'the same call twice gives the same answer');
  });

  it('a page that ends exactly at the last hit has no nextOffset; one hit short of the end has', async () => {
    const { db } = await setup([conv('e1', [{ attachments: [att('end-a.txt'), att('end-b.txt'), att('end-c.txt')] }])]);
    assert.equal(searchAttachments(db, { query: 'end', limit: 3 }).page.nextOffset, null);
    assert.equal(searchAttachments(db, { query: 'end', limit: 2 }).page.nextOffset, 2);
  });
});

describe('SPEC-04: arguments and hostile data', () => {
  it('raw mode is INVALID_ARGUMENT (FTS5 syntax cannot be applied to names)', async () => {
    const db = await fixtureDb();
    assert.throws(() => searchAttachments(db, { query: 'notes', mode: 'raw' }), expectCode('INVALID_ARGUMENT'));
  });

  it('empty, blank and symbol-only queries are INVALID_ARGUMENT with the SPEC-08 messages', async () => {
    const db = await fixtureDb();
    for (const q of ['', '   ']) assert.throws(() => searchAttachments(db, { query: q }), (e) => e instanceof GcrError && /the query is empty/.test(e.message), JSON.stringify(q));
    for (const q of ['!!!', '\u{1F600}', '""']) {
      assert.throws(() => searchAttachments(db, { query: q }), (e) => e instanceof GcrError && /only symbols or punctuation, which are not indexed/.test(e.message), JSON.stringify(q));
    }
  });

  it('bad limit / offset / filters are INVALID_ARGUMENT and never echo the value', async () => {
    const db = await fixtureDb();
    for (const over of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { createdAfter: 'yesterday' }, { hasModel: 'yes' as unknown as boolean }, { conversationId: 'a\0b' }]) {
      assert.throws(() => searchAttachments(db, { query: 'notes', ...over }), expectCode('INVALID_ARGUMENT'), JSON.stringify(over));
    }
    assert.throws(() => searchAttachments(db, null as unknown as AttachmentSearchQuery), expectCode('INVALID_ARGUMENT'));
  });

  it('control characters, bidi marks and the highlight markers in a file name cannot forge a highlight or escape into the snippet', async () => {
    const evil = `evil\u0001FAKE\u0002\u001b[31m‮gpj.exe`;
    const { db } = await setup([conv('x1', [{ id: 'x1-a', attachments: [att(evil, 'text/plain')] }])]);
    const hit = search(db, 'evil')[0];
    assert.ok(hit !== undefined);
    assert.equal(hit.attachmentName, evil, 'the name itself is returned as data (renderers escape it)');
    // eslint-disable-next-line no-control-regex
    const stripped = hit.snippet.replace(/\u0001evil\u0002/, 'evil');
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(stripped, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/, 'no raw control or bidi character survives in the snippet');
  });

  it('a very long name and a very large attachment list stay bounded', async () => {
    const longOk = `${'a'.repeat(4000)}-tail.txt`; // the record validator allows names up to 4,096 units
    const many = Array.from({ length: 6000 }, (_, i) => att(`bulk-${i}.txt`));
    const { db } = await setup([conv('y1', [{ id: 'y1-long', attachments: [att(longOk)] }, { id: 'y1-many', attachments: many }])]);
    assert.equal(search(db, 'tail').length, 1, 'a name at the validator limit is searched whole');
    assert.equal(search(db, 'bulk', { limit: 200 }).length, 200);
    assert.equal(search(db, 'bulk-4999', { limit: 5 }).length, 1);
    assert.equal(search(db, 'bulk-5999').length, 0, 'at most 5000 attachments of one message are looked at');
    // Defence in depth: a row edited after validation (a database is a file anyone can change) with a name beyond 4,096 units.
    db.exec('DROP TRIGGER messages_no_update');
    db.exec(`UPDATE messages SET attachments_json = '[{"name": "${'b'.repeat(5000)}-beyond.txt"}]' WHERE message_id = 'y1-long'`);
    assert.equal(search(db, 'beyond').length, 0, 'a name is cut at 4096 units before it is tokenized');
    assert.equal(search(db, 'bbbbbbbb').length, 1);
  });

  it('a damaged stored list is skipped and counted, never an exception', async () => {
    const { db } = await setup([conv('d1', [{ id: 'd1-ok', attachments: [att('good-file.txt')] }, { id: 'd1-bad', attachments: [att('placeholder.txt')] }, { id: 'd1-scalar', attachments: [att('placeholder2.txt')] }])]);
    db.exec('DROP TRIGGER messages_no_update');
    db.exec("UPDATE messages SET attachments_json = '{not json' WHERE message_id = 'd1-bad'");
    db.exec("UPDATE messages SET attachments_json = '5' WHERE message_id = 'd1-scalar'");
    const r = searchAttachments(db, { query: 'file' });
    assert.deepEqual(names(r.page.items), ['good-file.txt']);
    assert.equal(r.unreadableMessages, 2);
  });

  it('non-object entries of a stored list keep their positions', async () => {
    const { db } = await setup([conv('z1', [{ id: 'z1-a', attachments: [att('first.txt')] }])]);
    db.exec('DROP TRIGGER messages_no_update');
    db.exec(`UPDATE messages SET attachments_json = '["junk", null, {"name": "third.txt", "mimeType": "text/plain"}]' WHERE message_id = 'z1-a'`);
    const hits = search(db, 'third');
    assert.deepEqual(hits.map((h) => h.attachmentIndex), [2]);
  });
});

describe('SPEC-04: countMessageHits (used to place attachments after messages in scope "all")', () => {
  it('equals the number of message hits below the cap and equals the cap at or above it', async () => {
    const { db } = await setup([conv('q1', Array.from({ length: 6 }, (_, i) => ({ text: `needle number ${i}`, hidden: i === 5 })))]);
    assert.equal(searchMessages(db, { query: 'needle', limit: 200 }).items.length, 5);
    assert.equal(countMessageHits(db, { query: 'needle' }, 100), 5);
    assert.equal(countMessageHits(db, { query: 'needle', includeHidden: true }, 100), 6);
    assert.equal(countMessageHits(db, { query: 'needle' }, 5), 5);
    assert.equal(countMessageHits(db, { query: 'needle' }, 3), 3);
    assert.equal(countMessageHits(db, { query: 'absent' }, 3), 0);
    assert.equal(countMessageHits(db, { query: 'needle', role: 'assistant' }, 3), 0);
    assert.throws(() => countMessageHits(db, { query: 'needle' }, 0), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => countMessageHits(db, { query: '\u{1F600}' }, 5), expectCode('INVALID_ARGUMENT'));
  });
});
