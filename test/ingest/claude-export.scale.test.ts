/**
 * Scale and size-cap tests for ClaudeExportAdapter (NFR-05): a 50 000-message conversation converts in bounded time
 * and memory, and a text beyond the 64 MiB domain limit is truncated on a character boundary with an explicit marker.
 * Synthetic data only; the large inputs are generated here, never committed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeTree } from '../../src/domain/branches.js';
import { MAX_TEXT_BYTES, validateConversationRecord } from '../../src/domain/validate.js';
import { TEXT_TRUNCATION_MARKER } from '../../src/ingest/claude-export.js';
import { claudeAdapter, claudeConversation, claudeCtx, claudeMessage, findWarning, message, recordOf, synthUuid } from '../helpers/claude-export-builder.js';

describe('scale', () => {
  it('converts, validates and analyses a 50 000-message conversation in well under 30 s', () => {
    const N = 50_000;
    const messages = [];
    for (let n = 0; n < N; n++) {
      messages.push({
        uuid: synthUuid(100_000 + n),
        text: `synthetic ${n % 2 === 0 ? 'human' : 'assistant'} message ${n} about topic${n % 97}`,
        content: [{ type: 'text', text: `synthetic ${n % 2 === 0 ? 'human' : 'assistant'} message ${n} about topic${n % 97}` }],
        sender: n % 2 === 0 ? 'human' : 'assistant',
        created_at: '2025-03-04T05:06:07.123456Z',
        updated_at: '2025-03-04T05:06:07.123456Z',
        attachments: [],
        files: [],
      });
    }
    const text = JSON.stringify(claudeConversation(messages));
    const t0 = Date.now();
    const out = claudeAdapter.normalizeElementText(text, claudeCtx(), 0);
    const tAdapter = Date.now() - t0;
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const r = validateConversationRecord(out.record);
    const tValidate = Date.now() - t0 - tAdapter;
    assert.equal(r.messages.length, N);
    assert.equal(r.currentNodeId, synthUuid(100_000 + N - 1));
    assert.equal(r.messages[N - 1]?.parentId, synthUuid(100_000 + N - 2));
    assert.equal(out.observations.roleCounts['user'], N / 2);
    assert.equal(out.observations.nodesWithChildrenAbsent, N);
    // Warnings stay aggregated: one per code, however many messages there are.
    assert.ok(r.warnings.length <= 3, JSON.stringify(r.warnings.map((w) => w.code)));
    const a = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.equal(a.branches.length, 1);
    assert.equal(a.branches[0]?.messageCount, N);
    const total = Date.now() - t0;
    assert.ok(total < 30_000, `took ${total} ms (adapter ${tAdapter} ms, validate ${tValidate} ms)`);
  });

  it('a 50 000-message conversation whose every message is damaged still yields bounded warnings', () => {
    const N = 50_000;
    const text = `{"uuid":"${synthUuid(2)}","chat_messages":[${'{"text":"x","created_at":"bad"},'.repeat(N - 1)}{"text":"x"}]}`;
    const r = recordOf(text);
    assert.equal(r.messages.length, N);
    assert.ok(r.warnings.length <= 8, `${r.warnings.length} warnings`);
    for (const w of r.warnings) assert.ok((w.ids ?? []).length <= 50);
    assert.ok(findWarning(r, 'MESSAGE_ID_MISSING')?.message.includes(`(${N} occurrences)`));
    assert.ok(r.messages.every((m) => m.id === `synthetic-msg-${m.ordinal}`));
    assert.equal(r.currentNodeId, `synthetic-msg-${N - 1}`);
  });
});

describe('text size cap (MAX_TEXT_BYTES = 64 MiB)', () => {
  it('truncates an over-long text at a character boundary, within the limit including the marker, and keeps the raw text', () => {
    // 3-byte characters; one more than fits, so the cut must land inside the character sequence, not between bytes.
    const chars = Math.floor(MAX_TEXT_BYTES / 3) + 1;
    const text = '日'.repeat(chars);
    assert.ok(Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES);
    const r = recordOf(claudeConversation([claudeMessage(1, { text, content: undefined })]));
    const m = message(r, 0);
    assert.ok(Buffer.byteLength(m.text, 'utf8') <= MAX_TEXT_BYTES);
    assert.ok(m.text.endsWith(TEXT_TRUNCATION_MARKER));
    assert.ok(!m.text.includes('\uFFFD'), 'no character was cut in half');
    assert.ok(m.text.startsWith('日'));
    assert.deepEqual(findWarning(r, 'TEXT_TRUNCATED')?.ids, [m.id]);
    assert.equal(((m.rawSource as Record<string, unknown>)['text'] as string).length, chars, 'the raw text is untouched');
    assert.equal(m.blocks[0]?.text, m.text, 'the derived block carries the same truncated text');
  });

  it('a text of exactly the limit is kept whole', () => {
    const text = 'a'.repeat(MAX_TEXT_BYTES);
    const r = recordOf(claudeConversation([claudeMessage(1, { text, content: undefined })]));
    assert.equal(message(r, 0).text.length, MAX_TEXT_BYTES);
    assert.equal(findWarning(r, 'TEXT_TRUNCATED'), undefined);
  });

  it('a block text beyond the limit is truncated too (thinking blocks, tool results, attachment text)', () => {
    const big = 'b'.repeat(MAX_TEXT_BYTES + 10);
    const r = recordOf(claudeConversation([claudeMessage(1, { text: 'short', content: [{ type: 'thinking', thinking: big }] })]));
    const t = message(r, 0).blocks.find((b) => b.type === 'thoughts');
    assert.ok(t?.text !== undefined && Buffer.byteLength(t.text, 'utf8') <= MAX_TEXT_BYTES);
    assert.ok(t?.text?.endsWith(TEXT_TRUNCATION_MARKER));
    assert.equal(message(r, 0).text, 'short');
  });
});
