/**
 * ClaudeExportAdapter content rules: text composition, typed content blocks (thinking, tool_use, tool_result, ...),
 * attachment metadata, timestamp normalization, unknown-field preservation. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_BLOCKS_PER_MESSAGE, normalizeClaudeTimestamp } from '../../src/ingest/claude-export.js';
import {
  claudeConversation,
  claudeCtx,
  claudeMessage,
  fixtureElements,
  fixtureElementTexts,
  findWarning,
  message,
  recordOf,
  warningCodes,
} from '../helpers/claude-export-builder.js';

type Obj = Record<string, unknown>;

/** A conversation with one message built from `over`; returns the (only) message and the record. */
function single(over: Obj) {
  const r = recordOf(claudeConversation([claudeMessage(1, over)]));
  return { r, m: message(r, 0) };
}

describe('text composition', () => {
  it('uses the top-level text field when it is non-empty (research rule), keeping the block', () => {
    const { m, r } = single({ text: 'top level', content: [{ type: 'text', text: 'top level' }] });
    assert.equal(m.text, 'top level');
    assert.deepEqual(m.blocks, [{ type: 'text', text: 'top level' }]);
    assert.equal(findWarning(r, 'TEXT_FIELD_MISMATCH'), undefined);
  });

  it('falls back to the text blocks joined with a blank line when text is absent, empty or null', () => {
    for (const text of [undefined, '', null]) {
      const { m } = single({ text, content: [{ type: 'text', text: 'first' }, { type: 'tool_use', name: 't' }, { type: 'text', text: 'second' }] });
      assert.equal(m.text, 'first\n\nsecond');
    }
  });

  it('derives ONE text block from the top-level text when content has no text block', () => {
    const { m } = single({ text: 'only top', content: undefined });
    assert.deepEqual(m.blocks, [{ type: 'text', text: 'only top', metadata: { derivedFrom: 'text' } }]);
    const withTool = single({ text: 'answer', content: [{ type: 'tool_use', name: 't', id: 'i' }] });
    assert.deepEqual(withTool.m.blocks.map((b) => b.type), ['text', 'tool_use']);
    assert.equal(withTool.m.text, 'answer');
  });

  it('reports TEXT_FIELD_MISMATCH when text and text blocks genuinely differ, and still uses the text field', () => {
    const { m, r } = single({ text: 'one version', content: [{ type: 'text', text: 'another version' }] });
    assert.equal(m.text, 'one version');
    assert.deepEqual(findWarning(r, 'TEXT_FIELD_MISMATCH')?.ids, [m.id]);
  });

  it('does not report a mismatch when the text field is the plain concatenation of several blocks', () => {
    for (const sep of ['', '\n', '\n\n']) {
      const { r } = single({ text: ['a', 'b'].join(sep), content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] });
      assert.equal(findWarning(r, 'TEXT_FIELD_MISMATCH'), undefined, JSON.stringify(sep));
    }
  });

  it('ignores a non-string text field with INVALID_TEXT_FIELD and falls back to the blocks', () => {
    for (const text of [5, {}, ['x'], true]) {
      const { m, r } = single({ text, content: [{ type: 'text', text: 'from block' }] });
      assert.equal(m.text, 'from block');
      assert.deepEqual(findWarning(r, 'INVALID_TEXT_FIELD')?.ids, [m.id]);
    }
  });

  it('a message with neither text nor content has empty text and no blocks (and no warning)', () => {
    const { m, r } = single({ text: undefined, content: undefined });
    assert.equal(m.text, '');
    assert.deepEqual(m.blocks, []);
    assert.deepEqual(warningCodes(r).filter((c) => c !== 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY' && c !== 'CHILDREN_ABSENT'), []);
  });

  it('content that is not an array is INVALID_CONTENT, kept only in rawSource', () => {
    for (const content of ['plain string', {}, 7, true]) {
      const { m, r } = single({ text: 'kept', content });
      assert.deepEqual(findWarning(r, 'INVALID_CONTENT')?.ids, [m.id]);
      assert.equal(m.text, 'kept');
      assert.deepEqual((m.rawSource as Obj)['content'], content);
    }
  });

  it('missing-optional-fields fixture: bare messages, blocks-only text, null everywhere', () => {
    const [a, b, c] = fixtureElementTexts('missing-optional-fields.json').map((t) => recordOf(t));
    assert.ok(a !== undefined && b !== undefined && c !== undefined);
    // (a) only uuid + chat_messages
    assert.equal(a.title, null);
    assert.equal(a.createdAt, null);
    assert.equal(a.updatedAt, null);
    assert.equal(message(a, 0).createdAt, null);
    assert.equal(message(a, 0).text, 'GCR-SYNTHETIC-FIXTURE conversation with only a uuid and bare messages');
    assert.deepEqual(warningCodes(a), ['LINEAR_EXPORT_ACTIVE_BRANCH_ONLY', 'CHILDREN_ABSENT']);
    // (b) no uuid, a message without uuid, one without sender, one with explicit nulls
    assert.ok(b.id.startsWith('gcr-synth-'));
    assert.deepEqual(b.messages.map((m) => m.id), ['synthetic-msg-0', 'synthetic-msg-1', '00000000-0000-4000-8000-000000000063']);
    assert.deepEqual(b.messages.map((m) => m.authorRole), ['user', 'unknown', 'assistant']);
    assert.deepEqual(message(b, 2).attachments, []);
    assert.equal(message(b, 2).text, '');
    for (const code of ['CONVERSATION_ID_MISSING', 'MESSAGE_ID_MISSING', 'SENDER_MISSING']) assert.ok(findWarning(b, code) !== undefined, code);
    // (c) null name/summary/timestamps/account; message with content blocks but no top-level text
    assert.equal(c.title, null);
    assert.equal(message(c, 0).text, 'GCR-SYNTHETIC-FIXTURE message with content blocks but no top-level text');
    assert.equal(message(c, 0).createdAt, null);
  });
});

describe('typed content blocks (thinking-and-tools fixture)', () => {
  const r = recordOf(fixtureElementTexts('thinking-and-tools.json')[0]);
  const a = message(r, 1);
  const source = (fixtureElements('thinking-and-tools.json')[0]?.['chat_messages'] as Obj[])[1] as Obj;
  const sourceBlocks = source['content'] as Obj[];

  it('keeps every source block as a typed block, in order', () => {
    assert.deepEqual(a.blocks.map((b) => b.type), ['thoughts', 'text', 'tool_use', 'tool_result', 'tool_result', 'image_ref', 'voice_note', 'token_budget', 'unknown']);
  });

  it('turns thinking into a HIDDEN thoughts block that is never part of message.text', () => {
    const t = a.blocks[0];
    assert.equal(t?.type, 'thoughts');
    assert.equal(t?.text, 'SYNTHETIC-HIDDEN-REASONING the model plans an invented tool call');
    assert.deepEqual(t?.metadata, { hidden: true, sourceType: 'thinking' });
    assert.equal(a.text, 'synthetic final answer after the tool call');
    assert.ok(r.messages.every((m) => !m.text.includes('HIDDEN-REASONING')));
    assert.equal(a.hidden, false, 'the message itself is not marked hidden by the source');
  });

  it('keeps tool_use name, id and input (by value) without putting the input into message.text', () => {
    const b = a.blocks[2];
    assert.equal(b?.type, 'tool_use');
    assert.equal(b?.text, undefined);
    const meta = b?.metadata as Obj;
    assert.equal(meta['sourceType'], 'tool_use');
    assert.equal(meta['toolName'], 'synthetic_search_tool');
    assert.equal(meta['toolUseId'], 'synthetic_toolu_01');
    assert.deepEqual(meta['input'], sourceBlocks[2]?.['input']);
    assert.ok(!a.text.includes('invented query'));
  });

  it('keeps tool_result nested text as block text and non-text nested content in metadata', () => {
    const b = a.blocks[3];
    assert.equal(b?.type, 'tool_result');
    assert.equal(b?.text, 'SYNTHETIC-TOOL-RESULT first hit\nSYNTHETIC-TOOL-RESULT second hit');
    const meta = b?.metadata as Obj;
    assert.equal(meta['toolUseId'], 'synthetic_toolu_01');
    assert.equal(meta['toolName'], 'synthetic_search_tool');
    assert.equal(meta['isError'], false);
    assert.deepEqual(meta['nonTextContent'], [(sourceBlocks[3]?.['content'] as Obj[])[2]]);
    assert.ok(!a.text.includes('TOOL-RESULT'));
  });

  it('keeps a string tool_result and its error flag', () => {
    const b = a.blocks[4];
    assert.equal(b?.text, 'SYNTHETIC-TOOL-ERROR the invented tool failed');
    assert.equal((b?.metadata as Obj)['isError'], true);
    assert.equal((b?.metadata as Obj)['toolName'], null);
  });

  it('records an image as an image_ref WITHOUT copying the payload into the block', () => {
    const b = a.blocks[5];
    assert.equal(b?.type, 'image_ref');
    assert.deepEqual(b?.metadata, { sourceType: 'image', mediaType: 'image/png' });
    assert.ok(!JSON.stringify(b).includes('c3ludGhldGlj'));
  });

  it('keeps voice_note text and token_budget', () => {
    assert.equal(a.blocks[6]?.type, 'voice_note');
    assert.equal(a.blocks[6]?.text, 'synthetic voice note transcript');
    assert.deepEqual(a.blocks[7], { type: 'token_budget', metadata: { sourceType: 'token_budget' } });
  });

  it('keeps an unknown block type as type "unknown" with the raw block and UNKNOWN_CONTENT_TYPE', () => {
    const b = a.blocks[8];
    assert.equal(b?.type, 'unknown');
    assert.deepEqual(b?.metadata, { sourceType: 'synthetic_future_block_v9', raw: sourceBlocks[8] });
    assert.deepEqual(findWarning(r, 'UNKNOWN_CONTENT_TYPE')?.ids, [a.id]);
  });

  it('the human message of the fixture is plain text', () => {
    assert.deepEqual(message(r, 0).blocks, [{ type: 'text', text: 'synthetic human request that needs a tool' }]);
  });
});

describe('typed content blocks (negative / malformed)', () => {
  for (const [label, block] of [
    ['a block without a type', { text: 'x' }],
    ['a block with a non-string type', { type: 5, text: 'x' }],
    ['a string element', 'hello'],
    ['a null element', null],
    ['a number element', 42],
    ['an array element', [1, 2]],
  ] as const) {
    it(`${label} becomes an "unknown" block with the raw value and MALFORMED_CONTENT_BLOCK`, () => {
      const { m, r } = single({ text: undefined, content: [block] });
      assert.equal(m.blocks[0]?.type, 'unknown');
      assert.deepEqual((m.blocks[0]?.metadata as Obj)['raw'], block);
      assert.equal((m.blocks[0]?.metadata as Obj)['sourceType'], null);
      assert.deepEqual(findWarning(r, 'MALFORMED_CONTENT_BLOCK')?.ids, [m.id]);
    });
  }

  it('warnings about unknown block types and odd fields never echo the (untrusted) type string or values', () => {
    const { r } = single({ text: undefined, content: [{ type: 'LEAKMARKER_BLOCK_TYPE', payload: 'LEAKMARKER_PAYLOAD' }, { type: 'text', text: 5, note: 'LEAKMARKER_NOTE' }], sender: 'LEAKMARKER_SENDER'.repeat(100), model: 'LEAKMARKER_MODEL'.repeat(100) });
    assert.ok(findWarning(r, 'UNKNOWN_CONTENT_TYPE') !== undefined);
    assert.ok(findWarning(r, 'FIELD_TRUNCATED') !== undefined);
    assert.ok(!JSON.stringify(r.warnings).includes('LEAKMARKER'));
  });

  it('a text block without a text string is kept as a bare text block with a warning', () => {
    for (const bad of [{ type: 'text' }, { type: 'text', text: 5 }, { type: 'text', text: null }]) {
      const { m, r } = single({ text: undefined, content: [bad] });
      assert.deepEqual(m.blocks, [{ type: 'text' }]);
      assert.equal(m.text, '');
      assert.deepEqual(findWarning(r, 'MALFORMED_CONTENT_BLOCK')?.ids, [m.id]);
    }
  });

  it('thinking accepts a "text" fallback key and tolerates a missing body', () => {
    const { m } = single({ text: undefined, content: [{ type: 'thinking', text: 'fallback body' }, { type: 'thinking' }, { type: 'thinking', thinking: 9 }] });
    assert.deepEqual(m.blocks.map((b) => b.type), ['thoughts', 'thoughts', 'thoughts']);
    assert.deepEqual(m.blocks.map((b) => b.text), ['fallback body', undefined, undefined]);
    assert.ok(m.blocks.every((b) => (b.metadata as Obj)['hidden'] === true));
    assert.equal(m.text, '', 'reasoning never leaks into message.text');
  });

  it('tool_use without name/id/input records nulls and no input key', () => {
    const { m } = single({ text: undefined, content: [{ type: 'tool_use' }] });
    assert.deepEqual(m.blocks[0], { type: 'tool_use', metadata: { sourceType: 'tool_use', toolName: null, toolUseId: null } });
  });

  it('tool_result with odd content shapes keeps them under metadata and never throws', () => {
    const { m } = single({ text: undefined, content: [{ type: 'tool_result', content: { weird: true }, is_error: 'yes' }, { type: 'tool_result', content: [1, null, { type: 'text' }] }, { type: 'tool_result' }] });
    assert.deepEqual((m.blocks[0]?.metadata as Obj)['content'], { weird: true });
    assert.equal((m.blocks[0]?.metadata as Obj)['isError'], null, 'a non-boolean is_error is unknown');
    assert.equal(m.blocks[1]?.text, undefined);
    assert.equal(((m.blocks[1]?.metadata as Obj)['nonTextContent'] as unknown[]).length, 3);
    assert.equal(m.blocks[2]?.text, undefined);
  });

  it(`caps blocks per message at ${MAX_BLOCKS_PER_MESSAGE} and says so`, () => {
    const content = Array.from({ length: MAX_BLOCKS_PER_MESSAGE + 3 }, () => ({ type: 'token_budget' }));
    const { m, r } = single({ text: undefined, content });
    assert.equal(m.blocks.length, MAX_BLOCKS_PER_MESSAGE);
    assert.deepEqual(findWarning(r, 'BLOCKS_TRUNCATED')?.ids, [m.id]);
    assert.equal(((m.rawSource as Obj)['content'] as unknown[]).length, MAX_BLOCKS_PER_MESSAGE + 3, 'the rest stays in rawSource');
  });
});

describe('attachments and files (metadata only, FR-15)', () => {
  const r = recordOf(fixtureElementTexts('attachments-files.json')[0]);
  const human = message(r, 0);

  it('maps attachments[] and files[] to AttachmentRef metadata', () => {
    assert.deepEqual(human.attachments, [
      { id: null, name: 'synthetic-notes.txt', mimeType: 'text/plain', sizeBytes: 1234, assetPointer: null, presentInExportAs: null },
      { id: '00000000-0000-4000-8000-000000000a01', name: 'synthetic-table.csv', mimeType: 'csv', sizeBytes: 56, assetPointer: null, presentInExportAs: null },
      { id: '00000000-0000-4000-8000-000000000f01', name: 'synthetic-diagram.png', mimeType: null, sizeBytes: null, assetPointer: null, presentInExportAs: null },
    ]);
  });

  it('keeps extracted_content as an attachment_text block but does NOT merge it into message.text', () => {
    const blocks = human.blocks.filter((b) => b.type === 'attachment_text');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.text, 'SYNTHETIC-EXTRACTED-TEXT line one\nSYNTHETIC-EXTRACTED-TEXT line two');
    assert.deepEqual(blocks[0]?.metadata, { sourceType: 'attachments.extracted_content', attachmentIndex: 0, fileName: 'synthetic-notes.txt' });
    assert.equal(human.text, 'synthetic human turn with two attachments and one file');
    assert.ok(!r.messages.some((m) => m.text.includes('SYNTHETIC-EXTRACTED-TEXT')));
  });

  it('never claims a file is present in the export, even when a same-named asset exists in the container', () => {
    const rr = recordOf(fixtureElementTexts('attachments-files.json')[0], claudeCtx({ availableAssetNames: new Set(['synthetic-notes.txt', 'files/synthetic-notes.txt', 'synthetic-diagram.png']) }));
    assert.ok(rr.messages.every((m) => m.attachments.every((a) => a.presentInExportAs === null && a.assetPointer === null)));
  });

  it('a message without attachments has an empty list', () => {
    assert.deepEqual(message(r, 1).attachments, []);
  });

  it('attachments that are not an array / not objects are INVALID_ATTACHMENT and kept only in rawSource', () => {
    for (const attachments of [{ file_name: 'x' }, 'str', 5]) {
      const { m, r: rr } = single({ attachments });
      assert.deepEqual(m.attachments, []);
      assert.deepEqual(findWarning(rr, 'INVALID_ATTACHMENT')?.ids, [m.id]);
    }
    const { m, r: rr } = single({ attachments: [null, 'x', 3, [], { file_name: 'ok.txt' }] });
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0]?.name, 'ok.txt');
    assert.ok(findWarning(rr, 'INVALID_ATTACHMENT')?.message.includes('(4 occurrences)'));
  });

  it('unusable field values become null with INVALID_ATTACHMENT_FIELD (size must be a non-negative safe integer)', () => {
    for (const bad of [-1, 1.5, '12', 2 ** 60, {}]) {
      const { m, r: rr } = single({ attachments: [{ file_name: 'a', file_size: bad }] });
      assert.equal(m.attachments[0]?.sizeBytes, null, JSON.stringify(bad));
      assert.deepEqual(findWarning(rr, 'INVALID_ATTACHMENT_FIELD')?.ids, [m.id]);
    }
    const ok = single({ attachments: [{ file_name: 'a', file_size: 0 }, { file_name: 'b', file_size: 9007199254740991 }] });
    assert.deepEqual(ok.m.attachments.map((a) => a.sizeBytes), [0, 9007199254740991]);
    const odd = single({ attachments: [{ file_name: 5, file_type: [], id: 'a\nb' }] });
    assert.deepEqual(odd.m.attachments[0], { id: null, name: null, mimeType: null, sizeBytes: null, assetPointer: null, presentInExportAs: null });
    assert.ok(findWarning(odd.r, 'INVALID_ATTACHMENT_FIELD') !== undefined);
  });

  it('an absent or empty optional field is silently null', () => {
    const { m, r: rr } = single({ attachments: [{}, { file_name: '', file_type: '' }] });
    assert.equal(m.attachments.length, 2);
    assert.ok(m.attachments.every((a) => a.name === null && a.mimeType === null && a.id === null));
    assert.equal(findWarning(rr, 'INVALID_ATTACHMENT_FIELD'), undefined);
  });

  it('an empty extracted_content produces no block; a non-string one is ignored', () => {
    const { m } = single({ text: undefined, content: undefined, attachments: [{ file_name: 'a', extracted_content: '' }, { file_name: 'b', extracted_content: 5 }] });
    assert.equal(m.blocks.length, 0);
    assert.equal(m.attachments.length, 2);
  });

  it(`caps attachments per message at ${MAX_ATTACHMENTS_PER_MESSAGE}`, () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, (_, i) => ({ file_name: `f${i}` }));
    const { m, r: rr } = single({ attachments });
    assert.equal(m.attachments.length, MAX_ATTACHMENTS_PER_MESSAGE);
    assert.deepEqual(findWarning(rr, 'ATTACHMENTS_TRUNCATED')?.ids, [m.id]);
  });
});

describe('timestamp normalization', () => {
  const ok: Array<[string, string]> = [
    ['2025-03-04T05:06:07.123456Z', '2025-03-04T05:06:07.123Z'],
    ['2025-03-04T05:06:07Z', '2025-03-04T05:06:07.000Z'],
    ['2025-03-04T05:06:07.1Z', '2025-03-04T05:06:07.100Z'],
    ['2025-03-04T05:06:07.123999999Z', '2025-03-04T05:06:07.123Z'], // truncation, not rounding
    ['2025-03-04T05:06:07,5Z', '2025-03-04T05:06:07.500Z'],
    ['2025-03-04T05:06:07.123+00:00', '2025-03-04T05:06:07.123Z'],
    ['2025-03-04T07:06:07+02:00', '2025-03-04T05:06:07.000Z'],
    ['2025-03-03T23:06:07-06:00', '2025-03-04T05:06:07.000Z'], // offset moves the date
    ['2025-03-04T05:06:07+0530', '2025-03-03T23:36:07.000Z'],
    ['2025-03-04T05:06:07+05', '2025-03-04T00:06:07.000Z'],
    ['2025-03-04t05:06:07z', '2025-03-04T05:06:07.000Z'],
    ['2025-03-04 05:06:07Z', '2025-03-04T05:06:07.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2015-01-01T00:00:00Z', '2015-01-01T00:00:00.000Z'], // window start is inclusive
    ['2100-01-01T00:00:00Z', '2100-01-01T00:00:00.000Z'], // window end is inclusive
  ];
  for (const [input, expected] of ok) {
    it(`${input} -> ${expected}`, () => {
      assert.deepEqual(normalizeClaudeTimestamp(input), { iso: expected });
    });
  }

  const bad: Array<[unknown, string]> = [
    ['2025-03-04T05:06:07', 'bad_format'], // zone-less = local time of an unknown zone: never guessed as UTC
    ['2025-03-04', 'bad_format'],
    ['', 'bad_format'],
    ['yesterday', 'bad_format'],
    ['2025-03-04T05:06:07.Z', 'bad_format'],
    ['2025-03-04T05:06:07.1234567890Z', 'bad_format'], // > 9 fraction digits
    ['x'.repeat(1_000_000), 'bad_format'],
    ['2025-02-29T00:00:00Z', 'impossible_date'],
    ['2025-13-01T00:00:00Z', 'impossible_date'],
    ['2025-00-10T00:00:00Z', 'impossible_date'],
    ['2025-04-31T00:00:00Z', 'impossible_date'],
    ['2025-03-04T24:00:00Z', 'impossible_date'],
    ['2025-03-04T05:60:00Z', 'impossible_date'],
    ['2025-03-04T05:06:60Z', 'impossible_date'], // no leap seconds
    ['2025-03-04T05:06:07+24:00', 'bad_offset'],
    ['2025-03-04T05:06:07+05:60', 'bad_offset'],
    ['2014-12-31T23:59:59Z', 'out_of_range'],
    ['2100-01-01T00:00:01Z', 'out_of_range'],
    ['1970-01-01T00:00:00Z', 'out_of_range'],
    ['0000-01-01T00:00:00Z', 'out_of_range'],
    ['9999-12-31T23:59:59Z', 'out_of_range'],
    [1_700_000_000, 'not_string'], // numbers are not accepted: the unit would be a guess
    [null, 'not_string'],
    [undefined, 'not_string'],
    [{}, 'not_string'],
  ];
  for (const [input, reason] of bad) {
    it(`${typeof input === 'string' && input.length > 40 ? 'a 1 MB string' : JSON.stringify(input)} -> null (${reason})`, () => {
      assert.deepEqual(normalizeClaudeTimestamp(input), { iso: null, reason });
    });
  }

  it('absent timestamps are null WITHOUT a warning; present-but-invalid ones are null WITH INVALID_TIMESTAMP', () => {
    const absent = single({ created_at: undefined, updated_at: null });
    assert.equal(absent.m.createdAt, null);
    assert.equal(absent.m.updatedAt, null);
    assert.equal(findWarning(absent.r, 'INVALID_TIMESTAMP'), undefined);
    for (const created_at of ['2025-03-04T05:06:07', 1_700_000_000, '2025-02-30T00:00:00Z', {}, '']) {
      const bad1 = single({ created_at });
      assert.equal(bad1.m.createdAt, null);
      assert.deepEqual(findWarning(bad1.r, 'INVALID_TIMESTAMP')?.ids, [bad1.m.id]);
    }
    const conv = recordOf(claudeConversation([], { created_at: 'nope', updated_at: 5 }));
    assert.equal(conv.createdAt, null);
    assert.equal(conv.updatedAt, null);
    assert.deepEqual(findWarning(conv, 'INVALID_TIMESTAMP')?.ids, [conv.id]);
  });

  it('createdAt and updatedAt are independent', () => {
    const { m } = single({ created_at: '2025-03-04T05:06:07Z', updated_at: 'garbage' });
    assert.equal(m.createdAt, '2025-03-04T05:06:07.000Z');
    assert.equal(m.updatedAt, null);
  });
});

describe('unknown extra fields are preserved (fixture)', () => {
  const [text] = fixtureElementTexts('unknown-extra-fields.json');
  const source = fixtureElements('unknown-extra-fields.json')[0] as Obj;
  const r = recordOf(text);

  it('keeps unknown message-level fields in rawSource, untouched', () => {
    const msgs = source['chat_messages'] as Obj[];
    assert.deepEqual(message(r, 0).rawSource, msgs[0]);
    assert.deepEqual((message(r, 0).rawSource as Obj)['x_unknown_message_field'], { deep: { er: [null, true, 1.5, 'synthetic'] } });
    assert.deepEqual((message(r, 1).rawSource as Obj)['stop_reason'], 'synthetic_end_turn');
  });

  it('keeps unknown conversation-level fields in rawMetadata and excludes only the message tree', () => {
    const meta = r.rawMetadata as Obj;
    assert.ok(!Object.hasOwn(meta, 'chat_messages'));
    assert.deepEqual(meta['x_future_flag'], { enabled: true, levels: [1, 2, 3] });
    assert.equal(meta['project_uuid'], '00000000-0000-4000-8000-000000000a99');
    assert.deepEqual(meta['account'], { uuid: '00000000-0000-4000-8000-000000000900', x_future_account_field: 'synthetic' });
    assert.equal(r.defaultModelSlug, 'synthetic-default-model');
  });

  it('unknown fields on a known block are reachable through rawSource while the block stays typed', () => {
    assert.deepEqual(message(r, 0).blocks, [{ type: 'text', text: 'synthetic human turn' }]);
    assert.equal((((message(r, 0).rawSource as Obj)['content'] as Obj[])[0] as Obj)['x_unknown_block_field'], 7);
  });

  it('does not copy unknown keys onto the record (the strict schema would reject them)', () => {
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, ['accountLabel', 'completeness', 'createdAt', 'currentNodeId', 'defaultModelSlug', 'id', 'importedAt', 'messages', 'provenance', 'provider', 'rawMetadata', 'sourceUri', 'title', 'updatedAt', 'warnings']);
  });
});
