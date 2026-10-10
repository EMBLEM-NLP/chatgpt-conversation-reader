/**
 * Mode B (manual copy), part 1: the strict, bounded document parser and the record it produces. SPEC section 3:
 * "explicitly supplied/pasted messages -> partial local read and indexing; completeness marker partial_user_supplied".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeTree } from '../../src/domain/branches.js';
import { validateConversationRecord } from '../../src/domain/validate.js';
import { GcrError } from '../../src/errors.js';
import {
  MANUAL_COPY_MAX_DOCUMENT_CHARS,
  MANUAL_COPY_MAX_MESSAGES,
  MANUAL_COPY_MAX_TEXT_BYTES,
  MANUAL_COPY_MAX_TOTAL_BYTES,
  manualCopyDigest,
  manualCopyToRecord,
  normalizeUserTimestamp,
  parseManualCopyJson,
} from '../../src/ingest/manual-copy.js';
import type { ManualCopyInput } from '../../src/ingest/manual-copy.js';
import { errorSurface, expectCode } from './import-runner.helpers.test.js';

const CTX = { accountLabel: 'default', importedAt: '2026-02-03T04:05:06.007Z' };
const ID = '00000000-0000-4000-8000-0000000000aa';
const doc = (o: Record<string, unknown>): string => JSON.stringify({ messages: [{ role: 'user', text: 'hello' }], ...o });

describe('parseManualCopyJson: valid documents', () => {
  it('reads a minimal document and a full one', () => {
    const a = parseManualCopyJson(doc({}));
    assert.deepEqual(a.messages, [{ role: 'user', text: 'hello', createdAt: null, modelSlug: null }]);
    assert.equal(a.title, null);
    assert.equal(a.sourceUri, null);
    assert.equal(a.conversationId, undefined);
    assert.deepEqual(a.warnings, []);

    const b = parseManualCopyJson(
      JSON.stringify({
        conversationId: ID.toUpperCase(),
        title: 'A title',
        sourceUri: 'https://CHATGPT.com/c/00000000-0000-4000-8000-0000000000AA/?x=1#y',
        messages: [
          { role: 'user', text: 'q', createdAt: '2025-03-04T05:06:07Z' },
          { role: 'assistant', text: 'a', createdAt: '2025-03-04T07:06:08.5+02:00', modelSlug: 'synthetic-model-1' },
          { role: 'some-custom-role', text: '' },
        ],
      }),
    );
    assert.equal(b.conversationId, ID, 'lower-cased');
    assert.equal(b.sourceUri, `https://chatgpt.com/c/${ID}`, 'rebuilt from the validated id');
    assert.deepEqual(b.messages.map((m) => [m.role, m.createdAt, m.modelSlug]), [
      ['user', '2025-03-04T05:06:07.000Z', null],
      ['assistant', '2025-03-04T05:06:08.500Z', 'synthetic-model-1'],
      ['some-custom-role', null, null],
    ]);
  });

  it('a UTF-8 BOM is tolerated', () => {
    assert.equal(parseManualCopyJson('﻿' + doc({})).messages.length, 1);
  });

  it('unknown keys are ignored with a warning that carries a count but never the key names', () => {
    const p = parseManualCopyJson(
      JSON.stringify({ PLANTED_KEY_ONE: 1, messages: [{ role: 'user', text: 'x', PLANTED_KEY_TWO: 2 }, { role: 'user', text: 'y', other: 3 }], __proto__: { a: 1 } }),
    );
    const w = p.warnings?.find((x) => x.code === 'UNKNOWN_KEY_IGNORED');
    assert.ok(w);
    assert.match(w.message, /\(count=\d+\)$/);
    assert.ok(!JSON.stringify(p.warnings).includes('PLANTED_KEY'));
  });

  it('NUL characters are stripped and lone surrogates replaced, each with a warning', () => {
    const p = parseManualCopyJson(JSON.stringify({ title: 'ti\u0000tle', messages: [{ role: 'user', text: 'a\u0000b\ud800c' }] }));
    assert.equal(p.title, 'title');
    assert.equal(p.messages[0]?.text, 'ab�c');
    const codes = (p.warnings ?? []).map((w) => w.code).sort();
    assert.deepEqual(codes, ['LONE_SURROGATE', 'NUL_STRIPPED']);
  });

  it('an empty modelSlug means "not stated"', () => {
    assert.equal(parseManualCopyJson(JSON.stringify({ messages: [{ role: 'assistant', text: 'x', modelSlug: '' }] })).messages[0]?.modelSlug, null);
  });

  it('a sourceUri that names another id than conversationId is kept but flagged', () => {
    const p = parseManualCopyJson(doc({ conversationId: ID, sourceUri: 'https://chatgpt.com/c/00000000-0000-4000-8000-0000000000bb' }));
    assert.ok(p.warnings?.some((w) => w.code === 'SOURCE_URI_ID_MISMATCH'));
  });
});

describe('parseManualCopyJson: invalid documents', () => {
  it('not JSON -> IMPORT_PARSE_ERROR without echoing the text', () => {
    assert.throws(() => parseManualCopyJson('PLANTED not json {'), (e: unknown) => {
      assert.ok(e instanceof GcrError);
      assert.equal(e.code, 'IMPORT_PARSE_ERROR');
      assert.equal(e.details?.['reason'], 'NOT_JSON');
      assert.ok(!errorSurface(e).includes('PLANTED'));
      return true;
    });
    assert.throws(() => parseManualCopyJson(5 as never), expectCode('INVALID_ARGUMENT'));
  });

  const wrong: Array<[string, string, string]> = [
    ['array at the top', '[]', '$'],
    ['null', 'null', '$'],
    ['messages missing', '{}', 'messages'],
    ['messages not an array', '{"messages": "x"}', 'messages'],
    ['messages empty', '{"messages": []}', 'messages'],
    ['message not an object', '{"messages": ["x"]}', 'messages[0]'],
    ['role missing', '{"messages": [{"text": "x"}]}', 'messages[0].role'],
    ['role empty', '{"messages": [{"role": "", "text": "x"}]}', 'messages[0].role'],
    ['role number', '{"messages": [{"role": 1, "text": "x"}]}', 'messages[0].role'],
    ['role too long', `{"messages": [{"role": "${'r'.repeat(65)}", "text": "x"}]}`, 'messages[0].role'],
    ['role with control character', '{"messages": [{"role": "a\\nb", "text": "x"}]}', 'messages[0].role'],
    ['text missing', '{"messages": [{"role": "user"}]}', 'messages[0].text'],
    ['text not a string', '{"messages": [{"role": "user", "text": 5}]}', 'messages[0].text'],
    ['createdAt number', '{"messages": [{"role": "user", "text": "x", "createdAt": 5}]}', 'messages[0].createdAt'],
    ['createdAt prose', '{"messages": [{"role": "user", "text": "x", "createdAt": "yesterday"}]}', 'messages[0].createdAt'],
    ['createdAt without a zone', '{"messages": [{"role": "user", "text": "x", "createdAt": "2025-03-04T05:06:07"}]}', 'messages[0].createdAt'],
    ['createdAt impossible date', '{"messages": [{"role": "user", "text": "x", "createdAt": "2025-02-30T00:00:00Z"}]}', 'messages[0].createdAt'],
    ['createdAt hour 24', '{"messages": [{"role": "user", "text": "x", "createdAt": "2025-02-28T24:00:00Z"}]}', 'messages[0].createdAt'],
    ['modelSlug number', '{"messages": [{"role": "user", "text": "x", "modelSlug": 1}]}', 'messages[0].modelSlug'],
    ['title number', '{"title": 5, "messages": [{"role": "user", "text": "x"}]}', 'title'],
    ['title too long', `{"title": "${'t'.repeat(8193)}", "messages": [{"role": "user", "text": "x"}]}`, 'title'],
    ['conversationId number', '{"conversationId": 5, "messages": [{"role": "user", "text": "x"}]}', 'conversationId'],
    ['sourceUri number', '{"sourceUri": 5, "messages": [{"role": "user", "text": "x"}]}', 'sourceUri'],
  ];
  for (const [label, text, field] of wrong) {
    it(`${label} -> IMPORT_PARSE_ERROR at ${field}`, () => {
      assert.throws(() => parseManualCopyJson(text), (e: unknown) => {
        assert.ok(e instanceof GcrError, label);
        assert.equal(e.code, 'IMPORT_PARSE_ERROR', label);
        assert.equal(e.details?.['field'], field, label);
        return true;
      });
    });
  }

  it('a conversationId that is not a UUID -> INVALID_UUID (value not echoed)', () => {
    assert.throws(() => parseManualCopyJson(doc({ conversationId: 'PLANTED-not-a-uuid' })), (e: unknown) => {
      assert.ok(e instanceof GcrError);
      assert.equal(e.code, 'INVALID_UUID');
      assert.ok(!errorSurface(e).includes('PLANTED'));
      return true;
    });
  });

  it('a sourceUri that is not an exact https://chatgpt.com/c/<uuid> link -> INVALID_URL (never fetched, never echoed)', () => {
    const bad = [
      'https://chatgpt.com/share/00000000-0000-4000-8000-0000000000aa',
      'https://chat.openai.com/c/00000000-0000-4000-8000-0000000000aa',
      'http://chatgpt.com/c/00000000-0000-4000-8000-0000000000aa',
      'https://chatgpt.com/c/not-a-uuid',
      'https://evil.example.invalid/c/00000000-0000-4000-8000-0000000000aa',
      'https://chatgpt.com@evil.example.invalid/c/00000000-0000-4000-8000-0000000000aa',
      'PLANTED-just-text',
      '',
    ];
    for (const uri of bad) {
      assert.throws(() => parseManualCopyJson(doc({ sourceUri: uri })), (e: unknown) => {
        assert.ok(e instanceof GcrError, uri);
        assert.equal(e.code, 'INVALID_URL', uri);
        assert.equal(e.details?.['field'], 'sourceUri');
        assert.ok(!errorSurface(e).includes('PLANTED') && !errorSurface(e).includes('evil.example'));
        return true;
      });
    }
  });
});

describe('parseManualCopyJson: limits', () => {
  it(`more than ${MANUAL_COPY_MAX_MESSAGES} messages -> IMPORT_LIMIT_EXCEEDED; exactly the maximum is fine`, () => {
    const msgs = (n: number) => Array.from({ length: n }, () => ({ role: 'user', text: 'x' }));
    assert.equal(parseManualCopyJson(JSON.stringify({ messages: msgs(MANUAL_COPY_MAX_MESSAGES) })).messages.length, MANUAL_COPY_MAX_MESSAGES);
    assert.throws(() => parseManualCopyJson(JSON.stringify({ messages: msgs(MANUAL_COPY_MAX_MESSAGES + 1) })), expectCode('IMPORT_LIMIT_EXCEEDED', 'MANUAL_COPY_TOO_LARGE'));
  });

  it('text over 1 MiB (UTF-8 bytes) is refused, exactly 1 MiB is accepted', () => {
    const exact = JSON.stringify({ messages: [{ role: 'user', text: 'a'.repeat(MANUAL_COPY_MAX_TEXT_BYTES) }] });
    assert.equal(parseManualCopyJson(exact).messages[0]?.text.length, MANUAL_COPY_MAX_TEXT_BYTES);
    const over = JSON.stringify({ messages: [{ role: 'user', text: 'a'.repeat(MANUAL_COPY_MAX_TEXT_BYTES + 1) }] });
    assert.throws(() => parseManualCopyJson(over), expectCode('IMPORT_LIMIT_EXCEEDED'));
    // 3-byte characters: 349,526 of them exceed 1 MiB although the character count is far below it.
    const multibyte = JSON.stringify({ messages: [{ role: 'user', text: '日'.repeat(Math.floor(MANUAL_COPY_MAX_TEXT_BYTES / 3) + 1) }] });
    assert.throws(() => parseManualCopyJson(multibyte), expectCode('IMPORT_LIMIT_EXCEEDED'));
  });

  it('more than 64 MiB of text in total is refused', () => {
    const chunk = 'b'.repeat(MANUAL_COPY_MAX_TEXT_BYTES);
    const n = MANUAL_COPY_MAX_TOTAL_BYTES / MANUAL_COPY_MAX_TEXT_BYTES;
    const exactly = JSON.stringify({ messages: Array.from({ length: n }, () => ({ role: 'user', text: chunk })) });
    assert.equal(parseManualCopyJson(exactly).messages.length, n);
    const over = JSON.stringify({ messages: Array.from({ length: n + 1 }, () => ({ role: 'user', text: chunk })) });
    assert.throws(() => parseManualCopyJson(over), expectCode('IMPORT_LIMIT_EXCEEDED'));
  });

  it('a document larger than the character cap is refused before any parsing', () => {
    assert.throws(() => parseManualCopyJson('x'.repeat(MANUAL_COPY_MAX_DOCUMENT_CHARS + 1)), expectCode('IMPORT_LIMIT_EXCEEDED'));
  });
});

describe('normalizeUserTimestamp', () => {
  it('normalizes zones and fractions, rejects everything else', () => {
    assert.equal(normalizeUserTimestamp('2025-03-04T05:06:07Z'), '2025-03-04T05:06:07.000Z');
    assert.equal(normalizeUserTimestamp('2025-03-04T05:06:07.123456789Z'), '2025-03-04T05:06:07.123Z');
    assert.equal(normalizeUserTimestamp('2025-03-04T05:06:07-05:30'), '2025-03-04T10:36:07.000Z');
    assert.equal(normalizeUserTimestamp('2025-03-04T00:30:00+01:00'), '2025-03-03T23:30:00.000Z');
    assert.equal(normalizeUserTimestamp('2024-02-29T00:00:00Z'), '2024-02-29T00:00:00.000Z', 'leap day');
    for (const bad of ['2025-02-29T00:00:00Z', '2025-13-01T00:00:00Z', '2025-03-04T05:06:07', '2025-03-04 05:06:07Z', '1969-12-31T23:59:59Z', '2025-03-04T05:06:07+25:00', '2025-03-04T05:06:07+01:99', '9999-12-31T23:59:59-01:00', '']) {
      assert.equal(normalizeUserTimestamp(bad), null, bad);
    }
  });
});

describe('manualCopyToRecord', () => {
  const input = (): ManualCopyInput =>
    parseManualCopyJson(
      JSON.stringify({
        conversationId: ID,
        title: 'Pasted',
        sourceUri: `https://chatgpt.com/c/${ID}`,
        messages: [
          { role: 'user', text: 'one', createdAt: '2025-01-01T00:00:00Z' },
          { role: 'assistant', text: 'two', modelSlug: 'synthetic-model-1' },
          { role: 'user', text: 'three' },
        ],
      }),
    );

  it('marks everything partial: provenance, completeness, warning, no inferred branch, no structural root', () => {
    const r = manualCopyToRecord(input(), CTX);
    assert.equal(r.provider, 'chatgpt');
    assert.equal(r.provenance, 'user_supplied_copy');
    assert.equal(r.completeness, 'partial_user_supplied');
    assert.equal(r.currentNodeId, null);
    assert.equal(r.defaultModelSlug, null);
    assert.equal(r.createdAt, null);
    assert.equal(r.updatedAt, null);
    assert.equal(r.sourceUri, `https://chatgpt.com/c/${ID}`);
    assert.equal(r.importedAt, CTX.importedAt);
    assert.equal(r.warnings[0]?.code, 'PARTIAL_USER_SUPPLIED');
    assert.deepEqual(r.warnings[0]?.ids, [ID]);
    assert.ok(r.messages.every((m) => m.nodeKind === 'message'), 'no structural root is invented');
    assert.ok(r.messages.every((m) => m.recipient === null && m.channel === null && m.status === null && m.hidden === false));
  });

  it('is a LINEAR chain in the given order; models and times only where supplied', () => {
    const r = manualCopyToRecord(input(), CTX);
    assert.deepEqual(r.messages.map((m) => m.id), ['manual-00001', 'manual-00002', 'manual-00003']);
    assert.deepEqual(r.messages.map((m) => m.parentId), [null, 'manual-00001', 'manual-00002']);
    assert.deepEqual(r.messages.map((m) => m.childIds), [['manual-00002'], ['manual-00003'], []]);
    assert.deepEqual(r.messages.map((m) => m.modelSlug), [null, 'synthetic-model-1', null]);
    assert.deepEqual(r.messages.map((m) => m.createdAt), ['2025-01-01T00:00:00.000Z', null, null]);
    assert.deepEqual(r.messages.map((m) => m.ordinal), [0, 1, 2]);
    assert.deepEqual(r.messages.map((m) => m.authorRole), ['user', 'assistant', 'user']);
    assert.deepEqual(r.messages.map((m) => m.text), ['one', 'two', 'three']);
    assert.deepEqual(r.messages[0]?.blocks, [{ type: 'text', text: 'one' }]);
  });

  it('passes the domain validator and the tree analysis sees ONE branch whose activeness is unknown', () => {
    const r = validateConversationRecord(manualCopyToRecord(input(), CTX));
    const a = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.equal(a.branches.length, 1);
    assert.equal(a.activeBranchId, null);
    assert.equal(a.branches[0]?.activeness, 'unknown');
    assert.equal(a.branches[0]?.messageCount, 3);
    assert.deepEqual(a.warnings.map((w) => w.code), ['NO_CURRENT_NODE'], 'the honest "unknown" is reported, nothing is guessed');
  });

  it('a single message, empty text and hostile role strings are fine', () => {
    const r = manualCopyToRecord({ messages: [{ role: '__proto__', text: '' }] }, CTX);
    assert.equal(r.messages[0]?.authorRole, '__proto__');
    assert.deepEqual(r.messages[0]?.blocks, []);
    validateConversationRecord(r);
  });

  it('without a conversationId a deterministic UUID-shaped id is derived from the content and flagged', () => {
    const a = manualCopyToRecord({ messages: [{ role: 'user', text: 'same' }] }, CTX);
    const b = manualCopyToRecord({ messages: [{ role: 'user', text: 'same' }] }, { ...CTX, importedAt: '2031-01-01T00:00:00.000Z' });
    const c = manualCopyToRecord({ messages: [{ role: 'user', text: 'different' }] }, CTX);
    assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a.id, b.id, 'independent of the import time');
    assert.notEqual(a.id, c.id);
    assert.ok(a.warnings.some((w) => w.code === 'CONVERSATION_ID_SYNTHESIZED'));
    assert.ok(a.messages.every((m) => m.conversationId === a.id));
    // The same content through the JSON route and with different whitespace/zone spelling has the same identity.
    const viaJson = manualCopyToRecord(parseManualCopyJson('{ "messages" : [ {"role":"user","text":"same"} ] }'), CTX);
    assert.equal(viaJson.id, a.id);
  });

  it('parse-time warnings are carried into the record', () => {
    const r = manualCopyToRecord(parseManualCopyJson(JSON.stringify({ extra: 1, messages: [{ role: 'user', text: 'a\u0000' }] })), CTX);
    const codes = r.warnings.map((w) => w.code);
    assert.ok(codes.includes('UNKNOWN_KEY_IGNORED') && codes.includes('NUL_STRIPPED') && codes.includes('PARTIAL_USER_SUPPLIED'));
  });

  it('programmatic misuse is INVALID_ARGUMENT / INVALID_UUID / INVALID_URL, never a crash', () => {
    assert.throws(() => manualCopyToRecord({ messages: [] }, CTX), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => manualCopyToRecord({ messages: [{ role: 'user', text: 5 as never }] }, CTX), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => manualCopyToRecord(null as never, CTX), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => manualCopyToRecord({ messages: [{ role: 'user', text: 'x' }] }, { ...CTX, accountLabel: '' }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => manualCopyToRecord({ messages: [{ role: 'user', text: 'x' }] }, { ...CTX, importedAt: 'now' }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => manualCopyToRecord({ conversationId: 'x', messages: [{ role: 'user', text: 'x' }] }, CTX), expectCode('INVALID_UUID'));
    assert.throws(() => manualCopyToRecord({ sourceUri: 'https://example.invalid/', messages: [{ role: 'user', text: 'x' }] }, CTX), expectCode('INVALID_URL'));
  });

  it('digest: equal for equivalent inputs, different when anything meaningful differs', () => {
    const base = { messages: [{ role: 'user', text: 'x', createdAt: '2025-01-01T00:00:00Z' }] };
    const spelled = { messages: [{ role: 'user', text: 'x', createdAt: '2025-01-01T01:00:00+01:00', modelSlug: null }] };
    assert.equal(manualCopyDigest(base), manualCopyDigest(spelled));
    assert.match(manualCopyDigest(base), /^[0-9a-f]{64}$/);
    assert.notEqual(manualCopyDigest(base), manualCopyDigest({ messages: [{ role: 'user', text: 'y', createdAt: '2025-01-01T00:00:00Z' }] }));
    assert.notEqual(manualCopyDigest(base), manualCopyDigest({ ...base, title: 'T' }));
    assert.notEqual(manualCopyDigest(base), manualCopyDigest({ ...base, conversationId: ID }));
  });
});
