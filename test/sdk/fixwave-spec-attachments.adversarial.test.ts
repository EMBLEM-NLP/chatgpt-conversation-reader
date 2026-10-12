/**
 * SPEC-04 adversarial review, SDK: the warnings about attachment lists that were not (fully) searched must be honest about being
 * exact or a lower bound, and a list longer than the scan cap (5,000) must be reported (ATTACHMENTS_PARTLY_SEARCHED) instead of cut
 * silently. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { fixedClock, importBuilders, makeTempDir, removeDir, title, warningCodes } from './sdk.helpers.test.js';

let dir = '';
let gcr: Gcr;

before(async () => {
  dir = await makeTempDir();
  gcr = Gcr.open({ dbPath: join(dir, 'a.sqlite'), clock: fixedClock });
  const b = new ConversationBuilder({ id: syntheticUuid(0x300), title: title('many attachments') });
  let prev = b.root();
  prev = b.user(prev, 'ordinary text', { attachments: Array.from({ length: 5001 }, (_, i) => ({ id: `file-${i}`, name: `bulk-${i}.txt`, mime_type: 'text/plain', size: 1 })) });
  b.assistant(prev, 'reply about bulk-text', { model: 'synthetic-model-1' });
  await importBuilders(gcr, dir, [b]);
});

after(async () => {
  gcr.close();
  await removeDir(dir);
});

describe('SPEC-04 review: ATTACHMENTS_PARTLY_SEARCHED', () => {
  it('scope attachments: an empty answer for an attachment beyond the cap says that a list was cut', () => {
    const env = gcr.search({ query: 'bulk-5000', scope: 'attachments' });
    assert.equal(env.data.items.length, 0);
    assert.ok(warningCodes(env).includes('ATTACHMENTS_PARTLY_SEARCHED'), `warnings: ${warningCodes(env).join(',')}`);
    const w = env.warnings.find((x) => x.code === 'ATTACHMENTS_PARTLY_SEARCHED');
    assert.match(w?.message ?? '', /1 message/);
    assert.match(w?.message ?? '', /5,?000/);
    assert.doesNotMatch(w?.message ?? '', /at least/i, 'the scan read everything, so the count is exact');
  });

  it('scope all reports it too; a search that does not touch the list does not', () => {
    assert.ok(warningCodes(gcr.search({ query: 'bulk', scope: 'all' })).includes('ATTACHMENTS_PARTLY_SEARCHED'));
    assert.ok(!warningCodes(gcr.search({ query: 'bulk', scope: 'messages' })).includes('ATTACHMENTS_PARTLY_SEARCHED'));
    assert.ok(!warningCodes(gcr.search({ query: 'bulk', scope: 'titles' })).includes('ATTACHMENTS_PARTLY_SEARCHED'));
  });

  it('a lower bound is worded as one when the scan stopped at a full page', () => {
    const env = gcr.search({ query: 'bulk', scope: 'attachments', limit: 1 });
    assert.equal(env.data.items.length, 1);
    assert.notEqual(env.data.nextOffset, null);
    const w = env.warnings.find((x) => x.code === 'ATTACHMENTS_PARTLY_SEARCHED');
    if (w !== undefined) assert.match(w.message, /at least/i);
  });
});

describe('SPEC-04 review: STORED_JSON_INVALID is exact only when the scan read everything', () => {
  it('says "At least N" when a full page stopped the scan early and plain "N" when it did not', async () => {
    const d2 = await makeTempDir();
    try {
      const path = join(d2, 'dmg.sqlite');
      const writer = Gcr.open({ dbPath: path, clock: fixedClock });
      const b = new ConversationBuilder({ id: syntheticUuid(0x301), title: title('damaged lists') });
      let prev = b.root();
      const ids: string[] = [];
      for (const n of ['one', 'two', 'three']) {
        prev = b.user(prev, `message ${n}`, { attachments: [{ id: `f-${n}`, name: `shared-${n}.txt`, mime_type: 'text/plain', size: 1 }] });
        ids.push(prev);
      }
      await importBuilders(writer, d2, [b]);
      writer.close();
      const raw = new DatabaseSync(path);
      raw.exec('DROP TRIGGER messages_no_update');
      raw.prepare('UPDATE messages SET attachments_json = ? WHERE message_id = ?').run('{not json', ids[1] ?? '');
      raw.close();
      const g = Gcr.open({ dbPath: path, readOnly: true, clock: fixedClock });
      try {
        const early = g.search({ query: 'shared', scope: 'attachments', limit: 1 });
        assert.notEqual(early.data.nextOffset, null, 'more hits exist, so the scan stopped early');
        const e = early.warnings.find((w) => w.code === 'STORED_JSON_INVALID');
        assert.ok(e !== undefined, `warnings: ${warningCodes(early).join(',')}`);
        assert.match(e.message, /^At least 1 message/);
        const full = g.search({ query: 'shared', scope: 'attachments', limit: 200 });
        assert.equal(full.data.nextOffset, null);
        const f = full.warnings.find((w) => w.code === 'STORED_JSON_INVALID');
        assert.match(f?.message ?? '', /^1 message/);
      } finally {
        g.close();
      }
    } finally {
      await removeDir(d2);
    }
  });
});

describe('SPEC-04 review: docs claim about text a Claude export carries inline (extracted_content)', () => {
  it('is STORED as an attachment_text block, and found by no search scope (the user guide says exactly that)', async () => {
    const d3 = await makeTempDir();
    const g = Gcr.open({ dbPath: join(d3, 'c.sqlite'), clock: fixedClock });
    try {
      await g.importExport({ source: { kind: 'path', path: fileURLToPath(new URL('../../../fixtures/claude/attachments-files.json', import.meta.url)) } });
      const conv = g.list({ limit: 5 }).data.items[0];
      assert.ok(conv !== undefined);
      const thread = g.get({ conversationId: conv.conversationId, provider: conv.provider, accountLabel: conv.accountLabel }).data.thread;
      const blocks = (thread?.messages ?? []).flatMap((m) => m.blocks.map((b) => b.type));
      assert.ok(blocks.includes('attachment_text'), `stored as a block: ${blocks.join(',')}`);
      for (const scope of ['messages', 'attachments', 'all', 'titles'] as const) {
        assert.equal(g.search({ query: 'SYNTHETIC-EXTRACTED-TEXT', scope }).data.items.length, 0, `scope ${scope} does not search attachment text`);
      }
    } finally {
      g.close();
      await removeDir(d3);
    }
  });
});
