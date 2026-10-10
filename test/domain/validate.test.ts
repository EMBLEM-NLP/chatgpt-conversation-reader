/**
 * Tests for src/domain/validate.ts: record validation (shape + invariants), the "never echo values" error contract,
 * and the strict timestamp helpers. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import type { AttachmentRef, ConversationRecord, MessageRecord } from '../../src/domain/types.js';
import {
  MAX_ID_LENGTH,
  MAX_TEXT_BYTES,
  UNIX_SECONDS_MAX,
  UNIX_SECONDS_MIN,
  attachmentRefSchema,
  contentBlockSchema,
  conversationRecordSchema,
  isIso8601Utc,
  messageRecordSchema,
  parseIsoUtcToEpochMs,
  unixSecondsToIso,
  validateConversationRecord,
} from '../../src/domain/validate.js';
import { branchedConversation, convo, iso, link, linearConversation, msg } from '../helpers/records.js';

const SEED = 20261011;
const MARK = 'LEAKMARKER-9f3a';

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 200): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

// ---- helpers -----------------------------------------------------------------------------------------------------

/** A record exercising every optional/rare field, so that "valid" is not just the trivial case. */
function richRecord(): ConversationRecord {
  const id = 'conv-rich';
  const att: AttachmentRef = { id: 'file-abc', name: 'diagram.png', mimeType: 'image/png', sizeBytes: 1234, assetPointer: 'file-service://file-abc', presentInExportAs: 'files/file-abc-diagram.png' };
  const msgs = link([
    msg({ id: 'r', conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
    msg({
      id: 'u',
      conversationId: id,
      parentId: 'r',
      authorRole: 'user',
      authorName: 'Ünï',
      createdAt: iso(1),
      updatedAt: iso(2),
      text: 'Привет, 日本語 \u{1F600} text',
      blocks: [{ type: 'text', text: 'Привет' }, { type: 'unknown', metadata: { raw: [1, { deep: null }], n: 1.5 } }, { type: 'image_ref' }],
      attachments: [att, { id: null, name: null, mimeType: null, sizeBytes: null, assetPointer: null, presentInExportAs: null }],
      rawSource: { anything: ['goes', 1, null, { nested: true }] },
      ordinal: 1,
    }),
    msg({ id: 'a', conversationId: id, parentId: 'u', authorRole: 'assistant', modelSlug: 'synthetic-model-1', channel: 'final', recipient: 'all', contentType: 'text', status: 'finished_successfully', hidden: true, text: 'x', ordinal: 2 }),
  ]);
  return convo(id, msgs, {
    currentNodeId: 'a',
    defaultModelSlug: 'synthetic-model-1',
    sourceUri: 'https://chatgpt.com/c/6ac95b6e-9fa0-83e8-bbb0-8107079a8720',
    rawMetadata: { source: 'synthetic', list: [1, 2, 3] },
    warnings: [{ code: 'UNKNOWN_CONTENT_TYPE', message: 'm', ids: ['u'] }, { code: 'NO_IDS', message: '' }],
  });
}

function clone<T>(x: T): T {
  return structuredClone(x);
}
function poke(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value);
}
function drop(target: object, key: string): void {
  Reflect.deleteProperty(target, key);
}
function messageOf(rec: ConversationRecord, i: number): MessageRecord {
  const m = rec.messages[i];
  assert.ok(m, `fixture has no message ${i}`);
  return m;
}

interface Issue {
  path: string;
  reason: string;
}
function capture(input: unknown): GcrError {
  try {
    validateConversationRecord(input);
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    return e;
  }
  assert.fail('expected validateConversationRecord to throw');
}
function issuesOf(err: GcrError): Issue[] {
  return err.details?.['issues'] as Issue[];
}
/** Asserts the record is rejected with IMPORT_PARSE_ERROR naming `path` + `reason`, and that nothing leaked. */
function expectInvalid(input: unknown, path: string, reason: string): GcrError {
  const err = capture(input);
  assert.equal(err.code, 'IMPORT_PARSE_ERROR');
  assert.ok(issuesOf(err).some((i) => i.path === path && i.reason === reason), `wanted ${path}/${reason}, got ${JSON.stringify(issuesOf(err))}`);
  const blob = JSON.stringify(err.toEnvelope()) + err.message + String(err.remedy);
  assert.equal(blob.includes(MARK), false, `error leaked a value: ${blob.slice(0, 300)}`);
  assert.equal(err.cause, undefined, 'the original exception must not be attached');
  return err;
}

// ---- tests -------------------------------------------------------------------------------------------------------

describe('validateConversationRecord: valid records', () => {
  it('accepts the shared fixtures (linear, branched) and returns an equal value', () => {
    for (const rec of [linearConversation('c1', 3), branchedConversation('c2'), richRecord()]) {
      const out = validateConversationRecord(rec);
      assert.deepEqual(out, rec);
    }
  });

  it('accepts a record with zero messages and zero warnings', () => {
    validateConversationRecord(convo('empty', []));
  });

  it('returns a validated COPY, not the caller object (no check-then-use gap); opaque rawSource stays by reference', () => {
    const rec = richRecord();
    const out = validateConversationRecord(rec);
    assert.notEqual(out, rec);
    assert.notEqual(out.messages, rec.messages);
    assert.equal(messageOf(out, 1).rawSource, messageOf(rec, 1).rawSource);
    rec.title = 'changed after validation';
    assert.notEqual(out.title, 'changed after validation');
  });

  it('accepts every provider, provenance and completeness enum member', () => {
    for (const provider of ['chatgpt', 'claude', 'openai_api'] as const) validateConversationRecord(convo('c', [], { provider }));
    for (const provenance of ['official_chatgpt_export', 'user_supplied_copy', 'manual_browser_capture', 'openai_developer_api', 'official_claude_export'] as const) {
      validateConversationRecord(convo('c', [], { provenance }));
    }
    for (const completeness of ['exported_tree', 'rendered_active_view_only', 'partial_user_supplied', 'api_owned_conversation', 'unknown'] as const) {
      validateConversationRecord(convo('c', [], { completeness }));
    }
  });

  it('accepts nulls where the type allows them and ids of exactly 512 characters', () => {
    const id = 'x'.repeat(MAX_ID_LENGTH);
    const rec = convo(id, [msg({ id, conversationId: id, parentId: id.replace('x', 'y'), childIds: [id.replace('x', 'z')] })], {
      title: null, sourceUri: null, createdAt: null, updatedAt: null, currentNodeId: null, defaultModelSlug: null,
    });
    validateConversationRecord(rec);
  });

  it('does NOT treat tree anomalies as validation errors (self-parent, dangling parent, dangling currentNodeId)', () => {
    const rec = convo('c', [
      msg({ id: 'a', conversationId: 'c', parentId: 'a' }),
      msg({ id: 'b', conversationId: 'c', parentId: 'ghost', childIds: ['also-ghost'] }),
    ], { currentNodeId: 'nowhere' });
    validateConversationRecord(rec);
  });

  it('accepts a structural_empty node (empty role/text/blocks) and rejects none of its legitimate neighbours', () => {
    const rec = linearConversation('c', 1);
    assert.equal(messageOf(rec, 0).nodeKind, 'structural_empty');
    validateConversationRecord(rec);
  });
});

describe('validateConversationRecord: shape errors (path + reason, never values)', () => {
  it('rejects non-objects at the root', () => {
    for (const v of [null, undefined, 'a string', 42, [], true]) expectInvalid(v, '$', 'invalid_type');
  });

  it('every required top-level field is required', () => {
    for (const key of Object.keys(richRecord())) {
      if (key === 'rawMetadata') continue; // the only optional one
      const rec = clone(richRecord());
      drop(rec, key);
      const err = capture(rec);
      // A missing enum member is reported as invalid_value, a missing string/array as invalid_type.
      assert.ok(issuesOf(err).some((i) => i.path === key && (i.reason === 'invalid_type' || i.reason === 'invalid_value')), `${key}: ${JSON.stringify(issuesOf(err))}`);
    }
  });

  it('rawMetadata may be absent, null or anything', () => {
    for (const v of [undefined, null, 5, 'x', [1], { a: { b: 1 } }]) validateConversationRecord(convo('c', [], { rawMetadata: v }));
  });

  it('unknown keys are rejected (strict) without naming them', () => {
    const rec = clone(richRecord());
    poke(rec, `${MARK}-key`, 1);
    expectInvalid(rec, '$', 'unrecognized_keys'); // expectInvalid also proves the (marker) key name is not echoed
    const m = clone(richRecord());
    poke(messageOf(m, 1), `${MARK}-key`, 1);
    expectInvalid(m, 'messages[1]', 'unrecognized_keys');
    const b = clone(richRecord());
    poke((messageOf(b, 1).blocks[0] as object), `${MARK}-key`, 1);
    expectInvalid(b, 'messages[1].blocks[0]', 'unrecognized_keys');
    const a = clone(richRecord());
    poke(messageOf(a, 1).attachments[0] as object, `${MARK}-key`, 1);
    expectInvalid(a, 'messages[1].attachments[0]', 'unrecognized_keys');
    const w = clone(richRecord());
    poke(w.warnings[0] as object, `${MARK}-key`, 1);
    expectInvalid(w, 'warnings[0]', 'unrecognized_keys');
  });

  const enumCases: Array<[string, string]> = [['provider', 'provider'], ['provenance', 'provenance'], ['completeness', 'completeness']];
  for (const [field] of enumCases) {
    it(`${field}: unknown enum member is rejected without echoing it`, () => {
      const rec = clone(richRecord());
      poke(rec, field, `${MARK}-nope`);
      expectInvalid(rec, field, 'invalid_value');
    });
  }

  it('messages must be an array of objects', () => {
    const r1 = clone(richRecord());
    poke(r1, 'messages', { length: 0 });
    expectInvalid(r1, 'messages', 'invalid_type');
    const r2 = clone(richRecord());
    poke(r2, 'messages', [null]);
    expectInvalid(r2, 'messages[0]', 'invalid_type');
  });

  it('wrong primitive types are rejected at the exact path', () => {
    const cases: Array<[string, (r: ConversationRecord) => void]> = [
      ['title', (r) => poke(r, 'title', 5)],
      ['id', (r) => poke(r, 'id', 5)],
      ['accountLabel', (r) => poke(r, 'accountLabel', null)],
      ['currentNodeId', (r) => poke(r, 'currentNodeId', 7)],
      ['messages[1].hidden', (r) => poke(messageOf(r, 1), 'hidden', 'true')],
      ['messages[1].text', (r) => poke(messageOf(r, 1), 'text', 5)],
      ['messages[1].modelSlug', (r) => poke(messageOf(r, 1), 'modelSlug', 5)],
      ['messages[1].authorRole', (r) => poke(messageOf(r, 1), 'authorRole', null)],
      ['messages[1].nodeKind', (r) => poke(messageOf(r, 1), 'nodeKind', 'other')],
      ['messages[1].blocks', (r) => poke(messageOf(r, 1), 'blocks', 'x')],
      ['messages[1].attachments', (r) => poke(messageOf(r, 1), 'attachments', {})],
      ['warnings', (r) => poke(r, 'warnings', null)],
    ];
    for (const [path, apply] of cases) {
      const rec = clone(richRecord());
      apply(rec);
      const err = capture(rec);
      assert.ok(issuesOf(err).some((i) => i.path === path), `${path}: ${JSON.stringify(issuesOf(err))}`);
    }
  });
});

describe('validateConversationRecord: invariants', () => {
  it('timestamps must be strict ISO-8601 UTC (conversation and message fields)', () => {
    const bad = ['2025-01-01', '2025-01-01T00:00:00', '2025-01-01T00:00:00+00:00', '2025-01-01 00:00:00Z', '2025-02-30T00:00:00Z', 'yesterday', '', `${MARK}-2025`, '2025-01-01T00:00:00.1Z', '2025-01-01T00:00:00.123456Z'];
    for (const b of bad) {
      for (const field of ['importedAt', 'createdAt', 'updatedAt'] as const) {
        const rec = clone(richRecord());
        poke(rec, field, b);
        expectInvalid(rec, field, 'invalid_timestamp');
      }
      for (const field of ['createdAt', 'updatedAt'] as const) {
        const rec = clone(richRecord());
        poke(messageOf(rec, 1), field, b);
        expectInvalid(rec, `messages[1].${field}`, 'invalid_timestamp');
      }
    }
    const num = clone(richRecord());
    poke(messageOf(num, 1), 'createdAt', 1700000000);
    expectInvalid(num, 'messages[1].createdAt', 'invalid_type');
    const imp = clone(richRecord());
    poke(imp, 'importedAt', null);
    expectInvalid(imp, 'importedAt', 'invalid_type'); // importedAt is NOT nullable
  });

  it('duplicate message ids are rejected at the later occurrence', () => {
    const rec = clone(richRecord());
    rec.messages.push({ ...clone(messageOf(rec, 1)), ordinal: 9 });
    const err = expectInvalid(rec, 'messages[3].id', 'duplicate_message_id');
    assert.equal(err.details?.['messageCount'], 4);
  });

  it('a message of another conversation is rejected', () => {
    const rec = clone(richRecord());
    poke(messageOf(rec, 2), 'conversationId', `${MARK}-other`);
    expectInvalid(rec, 'messages[2].conversationId', 'conversation_id_mismatch');
  });

  it('structural_empty nodes must have authorRole "", text "" and no blocks (each violation reported separately)', () => {
    const roleRec = clone(richRecord());
    poke(messageOf(roleRec, 0), 'authorRole', 'user');
    expectInvalid(roleRec, 'messages[0].authorRole', 'structural_node_has_role');
    const textRec = clone(richRecord());
    poke(messageOf(textRec, 0), 'text', `${MARK} hidden payload`);
    expectInvalid(textRec, 'messages[0].text', 'structural_node_has_text');
    const blockRec = clone(richRecord());
    poke(messageOf(blockRec, 0), 'blocks', [{ type: 'text', text: `${MARK}` }]);
    expectInvalid(blockRec, 'messages[0].blocks', 'structural_node_has_blocks');
    const all = clone(richRecord());
    Object.assign(messageOf(all, 0), { authorRole: 'x', text: 'y', blocks: [{ type: 't' }] });
    const reasons = issuesOf(capture(all)).map((i) => i.reason).sort();
    assert.deepEqual(reasons, ['structural_node_has_blocks', 'structural_node_has_role', 'structural_node_has_text']);
  });

  it('the same content on a normal (non-structural) node is fine', () => {
    const rec = clone(richRecord());
    poke(messageOf(rec, 0), 'nodeKind', 'message');
    poke(messageOf(rec, 0), 'authorRole', 'system');
    poke(messageOf(rec, 0), 'text', 'sys');
    validateConversationRecord(rec);
  });

  it('NUL is rejected in text, block text and every free-form string field', () => {
    const cases: Array<[string, (r: ConversationRecord) => void]> = [
      ['messages[1].text', (r) => poke(messageOf(r, 1), 'text', `a\u0000${MARK}`)],
      ['messages[1].blocks[0].text', (r) => poke(messageOf(r, 1).blocks[0] as object, 'text', `a\u0000${MARK}`)],
      ['messages[1].blocks[0].type', (r) => poke(messageOf(r, 1).blocks[0] as object, 'type', 'te\u0000xt')],
      ['title', (r) => poke(r, 'title', `t\u0000${MARK}`)],
      ['sourceUri', (r) => poke(r, 'sourceUri', `https://x/\u0000${MARK}`)],
      ['messages[1].authorRole', (r) => poke(messageOf(r, 1), 'authorRole', 'us\u0000er')],
      ['messages[1].authorName', (r) => poke(messageOf(r, 1), 'authorName', 'a\u0000')],
      ['messages[2].modelSlug', (r) => poke(messageOf(r, 2), 'modelSlug', 'm\u0000')],
      ['messages[2].channel', (r) => poke(messageOf(r, 2), 'channel', 'c\u0000')],
      ['messages[2].status', (r) => poke(messageOf(r, 2), 'status', 's\u0000')],
      ['defaultModelSlug', (r) => poke(r, 'defaultModelSlug', 'm\u0000')],
      ['messages[1].attachments[0].name', (r) => poke(messageOf(r, 1).attachments[0] as object, 'name', 'n\u0000')],
      ['warnings[0].message', (r) => poke(r.warnings[0] as object, 'message', 'm\u0000')],
    ];
    for (const [path, apply] of cases) {
      const rec = clone(richRecord());
      apply(rec);
      expectInvalid(rec, path, 'contains_nul');
    }
  });

  it('identifiers reject control characters, emptiness and > 512 characters; 512 is fine', () => {
    for (const bad of ['', 'a\nb', 'a\u0000b', 'a\u007fb', 'x'.repeat(MAX_ID_LENGTH + 1)]) {
      const reason = bad === '' ? 'too_small' : bad.length > MAX_ID_LENGTH ? 'too_big' : bad.includes('\u0000') ? 'control_character' : 'control_character';
      const a = clone(richRecord());
      poke(a, 'id', bad);
      assert.ok(issuesOf(capture(a)).some((i) => i.path === 'id' && i.reason === reason), `id ${JSON.stringify(bad.slice(0, 8))}`);
      const l = clone(richRecord());
      poke(l, 'accountLabel', bad);
      assert.ok(issuesOf(capture(l)).some((i) => i.path === 'accountLabel' && i.reason === reason));
      const c = clone(richRecord());
      poke(c, 'currentNodeId', bad);
      assert.ok(issuesOf(capture(c)).some((i) => i.path === 'currentNodeId' && i.reason === reason));
      const m = clone(richRecord());
      poke(messageOf(m, 1), 'id', bad);
      assert.ok(issuesOf(capture(m)).some((i) => i.path === 'messages[1].id' && i.reason === reason));
      const p = clone(richRecord());
      poke(messageOf(p, 1), 'parentId', bad);
      assert.ok(issuesOf(capture(p)).some((i) => i.path === 'messages[1].parentId' && i.reason === reason));
      const k = clone(richRecord());
      poke(messageOf(k, 0), 'childIds', [bad]);
      assert.ok(issuesOf(capture(k)).some((i) => i.path === 'messages[0].childIds[0]' && i.reason === reason));
    }
  });

  it('parentId: every non-null value must be a string (numbers, objects, arrays, booleans, undefined are rejected)', () => {
    for (const bad of [5, {}, [], true, undefined, 0, `${MARK}`.length]) {
      const rec = clone(richRecord());
      poke(messageOf(rec, 1), 'parentId', bad);
      expectInvalid(rec, 'messages[1].parentId', 'invalid_type');
    }
    const missing = clone(richRecord());
    drop(messageOf(missing, 1), 'parentId');
    expectInvalid(missing, 'messages[1].parentId', 'invalid_type');
  });

  it('childIds: must be an array of strings without duplicates', () => {
    const notArray = clone(richRecord());
    poke(messageOf(notArray, 0), 'childIds', 'u');
    expectInvalid(notArray, 'messages[0].childIds', 'invalid_type');
    for (const el of [5, null, {}, undefined]) {
      const rec = clone(richRecord());
      poke(messageOf(rec, 0), 'childIds', ['u', el]);
      expectInvalid(rec, 'messages[0].childIds[1]', 'invalid_type');
    }
    const dup = clone(richRecord());
    poke(messageOf(dup, 0), 'childIds', ['u', 'x', 'u']);
    expectInvalid(dup, 'messages[0].childIds', 'duplicate_child_id');
  });

  it('ordinal must be a non-negative integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '3', null, undefined, -0.5]) {
      const rec = clone(richRecord());
      poke(messageOf(rec, 1), 'ordinal', bad);
      const err = capture(rec);
      assert.ok(issuesOf(err).some((i) => i.path === 'messages[1].ordinal'), `ordinal ${String(bad)}: ${JSON.stringify(issuesOf(err))}`);
    }
    for (const good of [0, 1, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const rec = clone(richRecord());
      poke(messageOf(rec, 1), 'ordinal', good);
      validateConversationRecord(rec);
    }
  });

  it('bounded strings: roles, slugs, titles, URIs', () => {
    const cases: Array<[string, number, (r: ConversationRecord, v: string) => void]> = [
      ['title', 8192, (r, v) => poke(r, 'title', v)],
      ['sourceUri', 2048, (r, v) => poke(r, 'sourceUri', v)],
      ['messages[1].authorRole', 512, (r, v) => poke(messageOf(r, 1), 'authorRole', v)],
      ['messages[2].modelSlug', 512, (r, v) => poke(messageOf(r, 2), 'modelSlug', v)],
      ['messages[1].blocks[0].type', 512, (r, v) => poke(messageOf(r, 1).blocks[0] as object, 'type', v)],
    ];
    for (const [path, max, apply] of cases) {
      const ok = clone(richRecord());
      apply(ok, 'x'.repeat(max));
      validateConversationRecord(ok);
      const over = clone(richRecord());
      apply(over, 'x'.repeat(max + 1));
      expectInvalid(over, path, 'too_big');
    }
  });

  it('message text is limited to 64 MiB of UTF-8 (exact boundary), measured in bytes not characters', () => {
    const withText = (text: string): ConversationRecord => convo('c', [msg({ id: 'm', conversationId: 'c', text })]);
    // ASCII: exactly at the limit passes, one more fails (cheap length pre-filter).
    validateConversationRecord(withText('a'.repeat(MAX_TEXT_BYTES)));
    expectInvalid(withText('a'.repeat(MAX_TEXT_BYTES + 1)), 'messages[0].text', 'too_big');
    // Multi-byte: fewer characters than the limit but more bytes than the limit.
    const euros = Math.floor(MAX_TEXT_BYTES / 3); // each '€' is 3 UTF-8 bytes
    const remainder = MAX_TEXT_BYTES - euros * 3;
    validateConversationRecord(withText('€'.repeat(euros) + 'a'.repeat(remainder))); // exactly MAX_TEXT_BYTES bytes
    expectInvalid(withText('€'.repeat(euros) + 'a'.repeat(remainder + 1)), 'messages[0].text', 'text_too_large');
    // Block text obeys the same limit.
    const blockRec = convo('c', [msg({ id: 'm', conversationId: 'c', blocks: [{ type: 'text', text: 'a'.repeat(MAX_TEXT_BYTES + 1) }] })]);
    expectInvalid(blockRec, 'messages[0].blocks[0].text', 'too_big');
  });

  it('attachments: sizeBytes must be a non-negative integer or null; presentInExportAs must be a safe archive-relative path', () => {
    for (const bad of [-1, 1.5, '5', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, undefined]) {
      const rec = clone(richRecord());
      poke(messageOf(rec, 1).attachments[0] as object, 'sizeBytes', bad);
      const err = capture(rec);
      assert.ok(issuesOf(err).some((i) => i.path === 'messages[1].attachments[0].sizeBytes'), `sizeBytes ${String(bad)}`);
    }
    const unsafe = ['../x', '/etc/passwd', 'C:\\Windows\\x', 'c:/x', 'a\\b', 'a/../b', '..', 'a\u0000b', 'a\nb', ''];
    for (const p of unsafe) {
      const rec = clone(richRecord());
      poke(messageOf(rec, 1).attachments[0] as object, 'presentInExportAs', p);
      const err = capture(rec);
      assert.ok(issuesOf(err).some((i) => i.path === 'messages[1].attachments[0].presentInExportAs'), `path ${JSON.stringify(p)}`);
    }
    for (const p of ['file-abc.png', 'dir/sub/file.bin', 'a..b', 'files/..hidden/x', null]) {
      const rec = clone(richRecord());
      poke(messageOf(rec, 1).attachments[0] as object, 'presentInExportAs', p);
      validateConversationRecord(rec);
    }
  });

  it('blocks: type is required and non-empty, text must be a string', () => {
    const noType = clone(richRecord());
    drop(messageOf(noType, 1).blocks[0] as object, 'type');
    expectInvalid(noType, 'messages[1].blocks[0].type', 'invalid_type');
    const emptyType = clone(richRecord());
    poke(messageOf(emptyType, 1).blocks[0] as object, 'type', '');
    expectInvalid(emptyType, 'messages[1].blocks[0].type', 'too_small');
    const numText = clone(richRecord());
    poke(messageOf(numText, 1).blocks[0] as object, 'text', 5);
    expectInvalid(numText, 'messages[1].blocks[0].text', 'invalid_type');
  });

  it('warnings: code and message are required strings, ids is an optional string array', () => {
    const noCode = clone(richRecord());
    drop(noCode.warnings[0] as object, 'code');
    expectInvalid(noCode, 'warnings[0].code', 'invalid_type');
    const emptyCode = clone(richRecord());
    poke(emptyCode.warnings[0] as object, 'code', '');
    expectInvalid(emptyCode, 'warnings[0].code', 'too_small');
    const badIds = clone(richRecord());
    poke(badIds.warnings[0] as object, 'ids', [5]);
    expectInvalid(badIds, 'warnings[0].ids[0]', 'invalid_type');
  });
});

describe('validateConversationRecord: error contract', () => {
  it('is a GcrError with code IMPORT_PARSE_ERROR and details with only paths, reasons and counts', () => {
    const rec = clone(richRecord());
    poke(rec, 'title', 5);
    poke(messageOf(rec, 1), 'text', 6);
    const err = capture(rec);
    assert.equal(err.code, 'IMPORT_PARSE_ERROR');
    assert.equal(err.exitCode, 4);
    assert.deepEqual(Object.keys(err.details ?? {}).sort(), ['fieldPathCount', 'issueCount', 'issues', 'messageCount', 'truncated']);
    assert.equal(err.details?.['issueCount'], 2);
    assert.equal(err.details?.['fieldPathCount'], 2);
    assert.equal(err.details?.['truncated'], false);
    assert.equal(err.details?.['messageCount'], 3);
    assert.match(err.message, /2 issue\(s\) in 2 field path\(s\)/);
    for (const i of issuesOf(err)) assert.deepEqual(Object.keys(i).sort(), ['path', 'reason']);
    // The details survive a JSON round trip unchanged (no exotic values).
    assert.deepEqual(JSON.parse(JSON.stringify(err.details)), err.details);
  });

  it('lists at most 20 issues but reports the true total', () => {
    const msgs: MessageRecord[] = [];
    for (let i = 0; i < 100; i++) msgs.push(msg({ id: `m${i}`, conversationId: 'c', ordinal: i, createdAt: 'bad' }));
    const err = capture(convo('c', msgs));
    assert.equal(err.details?.['issueCount'], 100);
    assert.equal(issuesOf(err).length, 20);
    assert.equal(err.details?.['truncated'], true);
  });

  it('never echoes any offending value, even when every string field carries a marker', () => {
    const rec = clone(richRecord());
    for (const key of ['title', 'sourceUri', 'accountLabel', 'id', 'currentNodeId', 'defaultModelSlug']) poke(rec, key, `${MARK}\u0000${'z'.repeat(9000)}`);
    poke(rec, 'importedAt', MARK);
    poke(rec, 'provider', MARK);
    for (const m of rec.messages) {
      for (const key of ['id', 'conversationId', 'parentId', 'authorRole', 'authorName', 'modelSlug', 'channel', 'status', 'createdAt', 'text']) poke(m, key, `${MARK}\u0000`);
      poke(m, 'childIds', [MARK, MARK]);
      poke(m, 'ordinal', MARK);
    }
    const err = capture(rec);
    const blob = JSON.stringify(err.toEnvelope());
    assert.equal(blob.includes(MARK), false);
    assert.ok(Number(err.details?.['issueCount']) > 20);
  });

  it('a throwing accessor becomes a clean IMPORT_PARSE_ERROR (no exception text leaks)', () => {
    const hostile = {
      get provider(): never {
        throw new Error(`${MARK} boom`);
      },
    };
    const err = capture(hostile);
    assert.equal(err.code, 'IMPORT_PARSE_ERROR');
    assert.equal(JSON.stringify(err.toEnvelope()).includes(MARK), false);
    assert.equal(err.cause, undefined);
  });

  it('fuzz: random junk poked into a valid record is either accepted or rejected with a clean error, never leaking', () => {
    const keys = ['provider', 'accountLabel', 'id', 'title', 'importedAt', 'currentNodeId', 'messages', 'warnings'];
    const mKeys = ['id', 'conversationId', 'parentId', 'childIds', 'nodeKind', 'authorRole', 'hidden', 'createdAt', 'text', 'blocks', 'attachments', 'ordinal'];
    const junk = fc.oneof(
      fc.constant(MARK),
      fc.constant({ nested: MARK }),
      fc.constant([MARK]),
      fc.constant(`${MARK}\u0000`),
      fc.integer(),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(true),
      fc.double({ noNaN: false }),
    );
    runProperty(
      fc.property(fc.constantFrom(...keys), fc.constantFrom(...mKeys), fc.nat(2), fc.boolean(), junk, junk, (k, mk, mi, onMessage, v1, v2) => {
        const rec = clone(richRecord());
        // Poke the message first: poking `messages` itself would make it unindexable.
        if (onMessage) poke(messageOf(rec, mi), mk, v2);
        poke(rec, k, v1);
        try {
          validateConversationRecord(rec);
        } catch (e) {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'IMPORT_PARSE_ERROR');
          assert.equal(JSON.stringify(e.toEnvelope()).includes(MARK), false);
        }
      }),
      400,
    );
  });
});

describe('validateConversationRecord: scale', () => {
  it('validates 20,000 messages quickly (time bound) and 20,000 invalid ones without unbounded error output', () => {
    const n = 20_000;
    const msgs: MessageRecord[] = [];
    for (let i = 0; i < n; i++) {
      msgs.push(msg({ id: `m${i}`, conversationId: 'big', parentId: i === 0 ? null : `m${i - 1}`, childIds: i + 1 < n ? [`m${i + 1}`] : [], createdAt: iso(i), text: `message ${i} ünï`, ordinal: i, authorRole: i % 2 ? 'assistant' : 'user' }));
    }
    const rec = convo('big', msgs);
    const t0 = performance.now();
    const out = validateConversationRecord(rec);
    const ms = performance.now() - t0;
    assert.equal(out.messages.length, n);
    assert.ok(ms < 3000, `validation took ${ms.toFixed(0)} ms`);
    const bad = clone(rec);
    for (const m of bad.messages) poke(m, 'createdAt', 'bad');
    const err = capture(bad);
    assert.equal(err.details?.['issueCount'], n);
    assert.equal(issuesOf(err).length, 20);
  });
});

describe('exported schemas', () => {
  it('can be used directly and agree with validateConversationRecord', () => {
    const rec = richRecord();
    assert.equal(conversationRecordSchema.safeParse(rec).success, true);
    assert.equal(messageRecordSchema.safeParse(messageOf(rec, 1)).success, true);
    assert.equal(contentBlockSchema.safeParse({ type: 'text', text: 'x' }).success, true);
    assert.equal(attachmentRefSchema.safeParse({ id: null, name: null, mimeType: null, sizeBytes: null, assetPointer: null, presentInExportAs: null }).success, true);
    assert.equal(conversationRecordSchema.safeParse({ ...rec, extra: 1 }).success, false);
    assert.equal(messageRecordSchema.safeParse({ ...messageOf(rec, 1), nodeKind: 'structural_empty' }).success, false);
    assert.equal(contentBlockSchema.safeParse({ text: 'no type' }).success, false);
    assert.equal(attachmentRefSchema.safeParse({}).success, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe('isIso8601Utc / parseIsoUtcToEpochMs', () => {
  const valid = [
    '2025-01-01T00:00:00Z',
    '2025-01-01T00:00:00.000Z',
    '2024-02-29T23:59:59.999Z', // leap day
    '2000-02-29T00:00:00Z', // divisible by 400
    '1970-01-01T00:00:00Z',
    '9999-12-31T23:59:59.999Z',
    '0000-01-01T00:00:00Z',
    '2025-12-31T23:59:59Z',
  ];
  const invalid = [
    '2025-01-01',
    '2025-01-01T00:00:00',
    '2025-01-01T00:00:00+00:00',
    '2025-01-01T00:00:00-05:00',
    '2025-01-01T00:00:00z',
    '2025-01-01t00:00:00Z',
    '2025-01-01 00:00:00Z',
    '2025-01-01T00:00Z',
    '2025-01-01T00:00:00.Z',
    '2025-01-01T00:00:00.1Z',
    '2025-01-01T00:00:00.12Z',
    '2025-01-01T00:00:00.1234Z',
    '2025-01-01T00:00:00.123456Z',
    '2025-02-29T00:00:00Z', // not a leap year
    '1900-02-29T00:00:00Z', // divisible by 100 but not 400
    '2025-13-01T00:00:00Z',
    '2025-00-10T00:00:00Z',
    '2025-04-31T00:00:00Z',
    '2025-01-32T00:00:00Z',
    '2025-01-00T00:00:00Z',
    '2025-01-01T24:00:00Z',
    '2025-01-01T23:60:00Z',
    '2025-01-01T23:59:60Z', // leap second: not representable
    ' 2025-01-01T00:00:00Z',
    '2025-01-01T00:00:00Z ',
    '2025-01-01T00:00:00Z\n',
    '２０２５-01-01T00:00:00Z', // full-width digits
    '2025-1-1T0:0:0Z',
    '+002025-01-01T00:00:00Z',
    'Z',
    '',
    `2025-01-01T00:00:00Z${'0'.repeat(100)}`,
  ];
  for (const s of valid) it(`accepts ${JSON.stringify(s)}`, () => assert.equal(isIso8601Utc(s), true));
  for (const s of invalid) it(`rejects ${JSON.stringify(s.slice(0, 40))}`, () => assert.equal(isIso8601Utc(s), false));

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 0, 1700000000, new Date(0), {}, [], true, 10n]) assert.equal(isIso8601Utc(v), false);
  });

  it('epoch ms equals Date.parse for every valid instant 0000..9999 (property), with and without the fraction', () => {
    runProperty(
      fc.property(fc.date({ min: new Date('0000-01-01T00:00:00.000Z'), max: new Date('9999-12-31T23:59:59.999Z'), noInvalidDate: true }), (d) => {
        const full = d.toISOString();
        assert.equal(parseIsoUtcToEpochMs(full), d.getTime());
        assert.equal(isIso8601Utc(full), true);
        if (d.getUTCMilliseconds() === 0) assert.equal(parseIsoUtcToEpochMs(full.replace('.000Z', 'Z')), d.getTime());
      }),
      2000,
    );
  });

  it('is independent of the process time zone (never falls back to local-time parsing)', () => {
    assert.equal(parseIsoUtcToEpochMs('2025-06-01T12:00:00Z'), Date.UTC(2025, 5, 1, 12, 0, 0));
    assert.equal(parseIsoUtcToEpochMs('2025-06-01T12:00:00'), null);
  });
});

describe('unixSecondsToIso', () => {
  it('converts unix seconds (ints and floats) to ISO UTC with millisecond precision', () => {
    assert.deepEqual(unixSecondsToIso(1700000000), { iso: '2023-11-14T22:13:20.000Z' });
    assert.deepEqual(unixSecondsToIso(1700000000.123456), { iso: '2023-11-14T22:13:20.123Z' });
    assert.deepEqual(unixSecondsToIso(1700000000.9996), { iso: '2023-11-14T22:13:21.000Z' }); // rounds to nearest ms
    assert.deepEqual(unixSecondsToIso(1735689600.5), { iso: '2025-01-01T00:00:00.500Z' });
  });

  it('success results have no "reason" key and are valid strict ISO strings', () => {
    const r = unixSecondsToIso(1700000000.5);
    assert.equal('reason' in r, false);
    assert.equal(isIso8601Utc(r.iso), true);
  });

  it('window boundaries are inclusive: 2015-01-01 and 2100-01-01', () => {
    assert.equal(UNIX_SECONDS_MIN, Date.UTC(2015, 0, 1) / 1000);
    assert.equal(UNIX_SECONDS_MAX, Date.UTC(2100, 0, 1) / 1000);
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MIN), { iso: '2015-01-01T00:00:00.000Z' });
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MAX), { iso: '2100-01-01T00:00:00.000Z' });
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MIN - 0.001), { iso: null, reason: 'out_of_range' });
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MAX + 0.001), { iso: null, reason: 'out_of_range' });
  });

  it('values that look like milliseconds are refused, not converted', () => {
    assert.deepEqual(unixSecondsToIso(1700000000000), { iso: null, reason: 'looks_like_milliseconds' });
    assert.deepEqual(unixSecondsToIso(1700000000123.5), { iso: null, reason: 'looks_like_milliseconds' });
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MIN * 1000), { iso: null, reason: 'looks_like_milliseconds' });
    assert.deepEqual(unixSecondsToIso(UNIX_SECONDS_MAX * 1000), { iso: null, reason: 'looks_like_milliseconds' });
  });

  it('everything else outside the window is out_of_range (zero, negatives, pre-2015, microseconds, huge)', () => {
    for (const v of [0, -0, 1, -1, 1000000000, 1388534400, -1700000000, 1.7e15, 1.7e18, 1e300, Number.MAX_VALUE, Number.MIN_VALUE]) {
      assert.deepEqual(unixSecondsToIso(v), { iso: null, reason: 'out_of_range' }, String(v));
    }
  });

  it('NaN and the infinities are non_finite', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.deepEqual(unixSecondsToIso(v), { iso: null, reason: 'non_finite' });
  });

  it('non-numbers (including numeric strings and bigint) are not_number: no guessing', () => {
    for (const v of ['1700000000', '', null, undefined, true, 1700000000n, {}, [], new Date(1700000000000), Symbol('x')]) {
      assert.deepEqual(unixSecondsToIso(v), { iso: null, reason: 'not_number' });
    }
  });

  it('property: every in-window finite number converts to a strict ISO string within 0.5 ms of the input', () => {
    runProperty(
      fc.property(fc.double({ min: UNIX_SECONDS_MIN, max: UNIX_SECONDS_MAX, noNaN: true }), (x) => {
        const r = unixSecondsToIso(x);
        assert.ok(r.iso !== null && isIso8601Utc(r.iso), `x=${x}`);
        const back = (parseIsoUtcToEpochMs(r.iso) as number) / 1000;
        assert.ok(Math.abs(back - x) <= 0.0005 + 1e-6, `x=${x} back=${back}`);
      }),
      1000,
    );
  });

  it('property: formatting is identical to Date#toISOString for every integer millisecond in the window (and round-trips)', () => {
    runProperty(
      fc.property(fc.integer({ min: UNIX_SECONDS_MIN * 1000, max: UNIX_SECONDS_MAX * 1000 }), (ms) => {
        const r = unixSecondsToIso(ms / 1000);
        assert.equal(r.iso, new Date(ms).toISOString());
        assert.equal(parseIsoUtcToEpochMs(r.iso), ms);
      }),
      3000,
    );
    // month/day/leap boundaries around the interesting dates
    for (const iso of ['2016-02-29T23:59:59.999Z', '2020-02-29T00:00:00.000Z', '2024-12-31T23:59:59.999Z', '2025-03-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z', '2100-01-01T00:00:00.000Z', '2015-01-01T00:00:00.000Z']) {
      const ms = Date.parse(iso);
      assert.equal(unixSecondsToIso(ms / 1000).iso, iso);
    }
  });

  it('property: out-of-window numbers never produce a timestamp', () => {
    runProperty(
      fc.property(fc.double({ noNaN: true }).filter((x) => Number.isFinite(x) && (x < UNIX_SECONDS_MIN || x > UNIX_SECONDS_MAX)), (x) => {
        const r = unixSecondsToIso(x);
        assert.equal(r.iso, null);
        assert.ok(r.reason === 'out_of_range' || r.reason === 'looks_like_milliseconds');
      }),
      1000,
    );
  });
});
