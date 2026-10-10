/**
 * ChatGPTExportAdapter core behaviour: contract, parsing and skipping, identity, timestamps, tree and children,
 * current_node, completeness, fabrication guards, observations, raw preservation, determinism.
 * All data is synthetic (see test/helpers/chatgpt-export-builder.ts).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { analyzeTree } from '../../src/domain/branches.js';
import type { ConversationRecord, MessageRecord } from '../../src/domain/types.js';
import { validateConversationRecord } from '../../src/domain/validate.js';
import { GcrError } from '../../src/errors.js';
import type { AdapterOutcome } from '../../src/ingest/adapter.js';
import { ChatGPTExportAdapter, chatGptExportAdapter } from '../../src/ingest/chatgpt-export.js';
import { ConversationBuilder, OMIT, SYNTHETIC_MARKER, adapterContext, contents, linearConversation, ordered, stringify, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { RawObject } from '../helpers/chatgpt-export-builder.js';

const ctx = adapterContext();

function run(text: string, idx = 0, c = ctx): AdapterOutcome {
  return chatGptExportAdapter.normalizeElementText(text, c, idx);
}

/** Normalize and require a record that passes the domain validator. */
function rec(text: string, idx = 0, c = ctx): ConversationRecord {
  const out = run(text, idx, c);
  assert.equal(out.kind, 'record');
  if (out.kind !== 'record') throw new Error('unreachable');
  return validateConversationRecord(out.record);
}

/** Raw conversation text from explicit node values keyed by id (insertion order kept). */
function convText(nodes: Array<[string, unknown]>, extra: RawObject = {}): string {
  return stringify({ id: syntheticUuid(1), title: `${SYNTHETIC_MARKER} t`, create_time: 1760000000, update_time: 1760000100, mapping: ordered(nodes), current_node: null, ...extra }, 0);
}

function node(id: string, parent: string | null, children?: unknown, message?: unknown): RawObject {
  const o: RawObject = { id, message: message === undefined ? null : message, parent };
  if (children !== undefined) o['children'] = children;
  return o;
}

function msg(id: string, role: string, text: string, over: RawObject = {}): RawObject {
  return { id, author: { role, name: null, metadata: {} }, create_time: 1760000000, content: { content_type: 'text', parts: [text] }, ...over };
}

function codes(r: ConversationRecord): string[] {
  return r.warnings.map((w) => w.code);
}
function warn(r: ConversationRecord, code: string) {
  return r.warnings.find((w) => w.code === code);
}
function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('contract', () => {
  it('declares provider, provenance and a name; the exported singleton is an instance of the class', () => {
    assert.equal(chatGptExportAdapter.provider, 'chatgpt');
    assert.equal(chatGptExportAdapter.provenance, 'official_chatgpt_export');
    assert.equal(typeof chatGptExportAdapter.name, 'string');
    assert.ok(chatGptExportAdapter instanceof ChatGPTExportAdapter);
  });

  it('copies accountLabel and importedAt from the context and never reads a clock', () => {
    const text = linearConversation(1).text();
    const r = rec(text, 0, adapterContext({ accountLabel: 'acct-b', importedAt: '2031-02-03T04:05:06.000Z' }));
    assert.equal(r.accountLabel, 'acct-b');
    assert.equal(r.importedAt, '2031-02-03T04:05:06.000Z');
    assert.equal(r.provider, 'chatgpt');
    assert.equal(r.provenance, 'official_chatgpt_export');
  });

  it('is deterministic: the same input gives byte-identical output, and instances do not share state', () => {
    const text = linearConversation(3).text({ pretty: true });
    const a = JSON.stringify(run(text, 4));
    const b = JSON.stringify(run(text, 4));
    const c = JSON.stringify(new ChatGPTExportAdapter().normalizeElementText(text, ctx, 4));
    assert.equal(a, b);
    assert.equal(a, c);
  });

  it('sourceElementSha256 is the SHA-256 of the exact input text and is repeated in rawMetadata._gcr', () => {
    const text = linearConversation(1).text();
    const out = run(text);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.equal(out.sourceElementSha256, sha256(text));
    assert.equal(((out.record.rawMetadata as RawObject)['_gcr'] as RawObject)['sourceElementSha256'], sha256(text));
    // whitespace-only differences change the hash: it identifies the exact bytes, not the parsed value
    const pretty = linearConversation(1).text({ pretty: true });
    const out2 = run(pretty);
    assert.equal(out2.kind === 'record' && out2.sourceElementSha256, sha256(pretty));
    assert.notEqual(sha256(text), sha256(pretty));
  });

  it('a leading BOM is tolerated for parsing but is part of the hashed text', () => {
    const text = '﻿' + linearConversation(1).text();
    const out = run(text);
    assert.equal(out.kind, 'record');
    if (out.kind === 'record') assert.equal(out.sourceElementSha256, sha256(text));
  });
});

describe('parse failures and skipped entries', () => {
  const bad: Array<[string, string]> = [
    ['empty text', ''],
    ['whitespace only', '   \n'],
    ['truncated object', '{"id":"x","mapping":{'],
    ['truncated string', '{"id":"x'],
    ['trailing comma', '{"id":"x","mapping":{},}'],
    ['NaN literal', '{"id":"x","mapping":{},"n":NaN}'],
    ['Infinity literal (Python json.dumps default)', '{"id":"x","mapping":{},"n":Infinity}'],
    ['-Infinity literal', '{"id":"x","mapping":{},"n":-Infinity}'],
    ['leading zeros', '{"id":"x","mapping":{},"n":007}'],
    ['unescaped control character in a string', '{"id":"x","mapping":{},"n":"a\u0001b"}'],
    ['two concatenated documents', '{"mapping":{}}{"mapping":{}}'],
    ['single quotes', "{'id':'x'}"],
    ['trailing garbage', '{"mapping":{}} x'],
  ];
  for (const [name, text] of bad) {
    it(`throws GcrError IMPORT_PARSE_ERROR for ${name}, without echoing the input`, () => {
      assert.throws(
        () => run(text.length > 0 ? text.replace('"x', '"CANARY-LEAK-8841') : text, 12),
        (e: unknown) => {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'IMPORT_PARSE_ERROR');
          assert.equal(e.details?.['elementIndex'], 12);
          const dump = JSON.stringify([e.message, e.remedy, e.details]);
          assert.ok(!dump.includes('CANARY-LEAK-8841'), 'input text must not be echoed');
          assert.ok(e.cause === undefined, 'the parser error (which quotes input) must not be attached as cause');
          return true;
        },
      );
    });
  }

  it('a non-string argument is a parse error, not a crash', () => {
    assert.throws(() => chatGptExportAdapter.normalizeElementText(Buffer.from('{}') as unknown as string, ctx, 0), (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_PARSE_ERROR');
  });

  const skips: Array<[string, string, string]> = [
    ['an empty object', '{}', 'EMPTY_CONVERSATION_ENTRY'],
    ['an empty object with whitespace', ' { } ', 'EMPTY_CONVERSATION_ENTRY'],
    ['null', 'null', 'NON_OBJECT_ENTRY'],
    ['a number', '42', 'NON_OBJECT_ENTRY'],
    ['a string', '"synthetic"', 'NON_OBJECT_ENTRY'],
    ['a boolean', 'true', 'NON_OBJECT_ENTRY'],
    ['an array', '[1,2,3]', 'NON_OBJECT_ENTRY'],
    ['an empty array', '[]', 'NON_OBJECT_ENTRY'],
    ['an object without mapping', '{"id":"x","title":"t"}', 'NOT_A_CONVERSATION'],
    ['a {"conversations": [...]} wrapper', '{"conversations":[{"mapping":{}}]}', 'NOT_A_CONVERSATION'],
    ['an empty wrapper', '{"conversations":[]}', 'NOT_A_CONVERSATION'],
    ['an object with mapping AND a conversations array (literal rule)', '{"mapping":{},"conversations":[]}', 'NOT_A_CONVERSATION'],
  ];
  for (const [name, text, reason] of skips) {
    it(`skips ${name} as ${reason}`, () => {
      const out = run(text);
      assert.equal(out.kind, 'skipped');
      if (out.kind === 'skipped') {
        assert.equal(out.reason, reason);
        assert.equal(out.warnings.length, 1);
        assert.equal(out.warnings[0]?.code, reason);
      }
    });
  }

  it('negative control: "conversations" that is NOT an array does not make an object a wrapper', () => {
    const out = run('{"mapping":{},"conversations":"not an array"}');
    assert.equal(out.kind, 'record');
  });

  it('negative control: a present-but-null mapping is a (damaged) conversation, not a skipped entry', () => {
    const r = rec('{"id":"c1","mapping":null,"current_node":null}');
    assert.equal(r.messages.length, 0);
  });
});

describe('identity', () => {
  it('prefers conversation_id over id, and falls back to id', () => {
    assert.equal(rec('{"conversation_id":"cid","id":"cid","mapping":{}}').id, 'cid');
    assert.equal(rec('{"id":"only-id","mapping":{}}').id, 'only-id');
    assert.equal(rec('{"conversation_id":"only-cid","mapping":{}}').id, 'only-cid');
    const r = rec('{"conversation_id":"A","id":"B","mapping":{}}');
    assert.equal(r.id, 'A');
  });

  it('warns ID_ALIAS_MISMATCH when the aliases differ and keeps both in rawMetadata; equal aliases do not warn', () => {
    const r = rec('{"conversation_id":"A","id":"B","mapping":{}}');
    assert.deepEqual(warn(r, 'ID_ALIAS_MISMATCH')?.ids, ['A', 'B']);
    assert.equal((r.rawMetadata as RawObject)['id'], 'B');
    assert.equal((r.rawMetadata as RawObject)['conversation_id'], 'A');
    assert.ok(!codes(rec('{"conversation_id":"A","id":"A","mapping":{}}')).includes('ID_ALIAS_MISMATCH'));
    const same = syntheticUuid(0x6a);
    assert.ok(!codes(rec(`{"conversation_id":"${same}","id":"${same.toUpperCase()}","mapping":{}}`)).includes('ID_ALIAS_MISMATCH'), 'case-only difference between UUID aliases is not a mismatch');
  });

  it('synthesizes a deterministic id from the element hash and index when both are missing', () => {
    const text = '{"title":"t","mapping":{}}';
    const r = rec(text, 7);
    assert.equal(r.id, `gcr-synth-${sha256(text).slice(0, 32)}-7`);
    assert.ok(warn(r, 'CONVERSATION_ID_MISSING'));
    assert.equal(rec(text, 7).id, r.id, 'stable');
    assert.notEqual(rec(text, 8).id, r.id, 'depends on the element index');
    assert.notEqual(rec('{"title":"u","mapping":{}}', 7).id, r.id, 'depends on the content');
  });

  it('treats unusable ids (empty, non-string, control characters, > 512 chars) as missing', () => {
    const long = 'x'.repeat(513);
    for (const bad of ['""', '5', 'null', '"a\\nb"', `"${long}"`, '"\\u0000"', '"\\ud800"']) {
      const r = rec(`{"conversation_id":${bad},"mapping":{}}`);
      assert.match(r.id, /^gcr-synth-/, bad);
      assert.ok(codes(r).includes('CONVERSATION_ID_MISSING'), bad);
    }
    // a bad conversation_id with a good id falls back to id and says so
    const r = rec('{"conversation_id":"","id":"good-id","mapping":{}}');
    assert.equal(r.id, 'good-id');
    assert.ok(codes(r).includes('UNEXPECTED_FIELD_TYPE'));
  });

  it('lower-cases a UUID-shaped id (info) but leaves any other id verbatim; the raw spelling is kept', () => {
    const up = syntheticUuid(0x6a).toUpperCase();
    const r = rec(`{"conversation_id":"${up}","mapping":{}}`);
    assert.equal(r.id, up.toLowerCase());
    assert.ok(warn(r, 'ID_CASE_NORMALIZED')?.message.startsWith('[info] '));
    assert.equal((r.rawMetadata as RawObject)['conversation_id'], up);
    assert.equal(rec('{"id":"MixedCase-Id","mapping":{}}').id, 'MixedCase-Id');
    assert.equal(rec('{"id":" padded ","mapping":{}}').id, ' padded ', 'whitespace is part of the identity, never trimmed');
  });

  it('never fabricates sourceUri', () => {
    assert.equal(rec(linearConversation(1).text()).sourceUri, null);
  });
});

describe('conversation fields', () => {
  it('title: verbatim string, absent/null stay null, wrong type -> null + warning, huge title truncated', () => {
    assert.equal(rec('{"id":"c","title":"Hello","mapping":{}}').title, 'Hello');
    assert.equal(rec('{"id":"c","mapping":{}}').title, null);
    assert.equal(rec('{"id":"c","title":null,"mapping":{}}').title, null);
    const num = rec('{"id":"c","title":5,"mapping":{}}');
    assert.equal(num.title, null);
    assert.ok(codes(num).includes('UNEXPECTED_FIELD_TYPE'));
    const big = rec(`{"id":"c","title":"${'t'.repeat(9000)}","mapping":{}}`);
    assert.equal(big.title?.length, 8192);
    assert.ok(codes(big).includes('TEXT_TRUNCATED'));
    assert.equal(rec('{"id":"c","title":"","mapping":{}}').title, '', 'an empty title is a title');
  });

  it('title and ids are never used for identity: two different titles, same id -> same id', () => {
    assert.equal(rec('{"id":"c","title":"a","mapping":{}}').id, rec('{"id":"c","title":"b","mapping":{}}').id);
  });

  it('default model: default_model_slug, then conversation-level model_slug; neither reaches any message', () => {
    const b = linearConversation(1, { defaultModel: 'synthetic-default-model' });
    const r = rec(b.text());
    assert.equal(r.defaultModelSlug, 'synthetic-default-model');
    for (const m of r.messages) if (m.authorRole === 'user') assert.equal(m.modelSlug, null);
    assert.equal(rec('{"id":"c","model_slug":"newer-conv-model","mapping":{}}').defaultModelSlug, 'newer-conv-model');
    assert.equal(rec('{"id":"c","default_model_slug":"d","model_slug":"m","mapping":{}}').defaultModelSlug, 'd');
    assert.equal(rec('{"id":"c","mapping":{}}').defaultModelSlug, null);
    assert.equal(rec('{"id":"c","default_model_slug":7,"mapping":{}}').defaultModelSlug, null);
  });
});

describe('timestamps', () => {
  const T = (v: string) => rec(`{"id":"c","create_time":${v},"update_time":null,"mapping":{}}`);

  it('converts unix seconds (float, microseconds) to ISO UTC milliseconds', () => {
    assert.equal(T('1760000000').createdAt, '2025-10-09T08:53:20.000Z');
    assert.equal(T('1760000000.123456').createdAt, '2025-10-09T08:53:20.123Z');
    assert.equal(T('1760000000.9996').createdAt, '2025-10-09T08:53:21.000Z');
  });

  it('absent and null are null without any warning (nothing is invented)', () => {
    const r = rec('{"id":"c","mapping":{}}');
    assert.equal(r.createdAt, null);
    assert.equal(r.updatedAt, null);
    assert.ok(!codes(r).includes('TIMESTAMP_OUT_OF_RANGE'));
    assert.equal(T('null').createdAt, null);
  });

  it('millisecond-scale, zero, negative, huge and non-finite values become null + TIMESTAMP_OUT_OF_RANGE, raw kept', () => {
    for (const v of ['1760000000000', '0', '-1760000000', '1e20', '1e999', '-0', '1000', '4102444801', '1420070399']) {
      const r = T(v);
      assert.equal(r.createdAt, null, v);
      assert.ok(codes(r).includes('TIMESTAMP_OUT_OF_RANGE'), v);
    }
    const r = T('1760000000000');
    assert.equal((r.rawMetadata as RawObject)['create_time'], 1760000000000, 'the raw value is kept');
  });

  it('window edges: 2015-01-01 and 2100-01-01 inclusive are accepted', () => {
    assert.equal(T('1420070400').createdAt, '2015-01-01T00:00:00.000Z');
    assert.equal(T('4102444800').createdAt, '2100-01-01T00:00:00.000Z');
  });

  it('numeric strings and zoned ISO strings convert with an info TIMESTAMP_FORMAT', () => {
    for (const v of ['"1760000000.5"', '"2025-10-09T08:53:20.500Z"', '"2025-10-09T10:53:20.5+02:00"', '"2025-10-09 08:53:20.500z"', '"2025-10-09T03:53:20.5-0500"']) {
      const r = T(v);
      assert.equal(r.createdAt, '2025-10-09T08:53:20.500Z', v);
      assert.ok(warn(r, 'TIMESTAMP_FORMAT')?.message.startsWith('[info] '), v);
    }
  });

  it('refuses what would need a guess: zone-less ISO, impossible dates, bad offsets, junk, wrong types', () => {
    for (const v of ['"2025-10-09T08:53:20"', '"2025-02-30T00:00:00Z"', '"2025-13-01T00:00:00Z"', '"2025-10-09T25:00:00Z"', '"2025-10-09T08:53:20+25:00"', '"2025-10-09T08:53:20+01:99"', '"yesterday"', '""', 'true', '{}', '[]', '"1e9"', '"0x10"']) {
      const r = T(v);
      assert.equal(r.createdAt, null, v);
      assert.ok(codes(r).some((c) => c === 'TIMESTAMP_UNPARSEABLE' || c === 'TIMESTAMP_OUT_OF_RANGE'), v);
    }
    // plausible-looking strings outside the window are out of range, not unparseable
    assert.ok(codes(T('"1999-01-01T00:00:00Z"')).includes('TIMESTAMP_OUT_OF_RANGE'));
    assert.ok(codes(T('"5"')).includes('TIMESTAMP_OUT_OF_RANGE'));
  });

  it('very long strings are rejected cheaply', () => {
    assert.equal(T(`"${'1'.repeat(100000)}"`).createdAt, null);
  });

  it('message timestamps use the same rules and are independent of conversation timestamps', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1), createTime: 1760000000, updateTime: 1760000500 });
    const u = b.user(b.root(), 'x', { id: 'u', createTime: 'garbage', updateTime: 1760000300 });
    b.assistant(u, 'y', { id: 'a', set: { create_time: OMIT } });
    const r = rec(b.text());
    assert.equal(r.createdAt, '2025-10-09T08:53:20.000Z');
    assert.equal(r.updatedAt, '2025-10-09T09:01:40.000Z');
    const um = r.messages.find((m) => m.id === 'u');
    assert.equal(um?.createdAt, null);
    assert.equal(um?.updatedAt, '2025-10-09T08:58:20.000Z');
    assert.equal(r.messages.find((m) => m.id === 'a')?.createdAt, null, 'a missing message time is not copied from anywhere');
  });
});

describe('tree: parent pointers, children, structural nodes', () => {
  it('structural nodes (message null) keep id/parent/children and have empty role/text/blocks; rawSource is the node', () => {
    const r = rec(convText([['r', node('r', null, ['a'])], ['a', node('a', 'r', [], msg('a', 'user', 'hi'))]], { current_node: 'a' }));
    const root = r.messages[0];
    assert.equal(root?.nodeKind, 'structural_empty');
    assert.equal(root?.authorRole, '');
    assert.equal(root?.text, '');
    assert.deepEqual(root?.blocks, []);
    assert.equal(root?.contentType, null);
    assert.equal(root?.hidden, false);
    assert.deepEqual(root?.childIds, ['a']);
    assert.deepEqual((root?.rawSource as RawObject)['message'], null);
  });

  it('roots are nodes with a null/absent parent; the literal "client-created-root" is not special', () => {
    const r = rec(convText([['uuid-root', node('uuid-root', null, ['a'])], ['a', node('a', 'uuid-root', [], msg('a', 'user', 'x'))]], { current_node: 'a' }));
    assert.deepEqual(analyzeTree(r.id, r.messages, r.currentNodeId).rootIds, ['uuid-root']);
    const noParentKey = convText([['solo', { id: 'solo', message: msg('solo', 'user', 'x') }]], { current_node: 'solo' });
    assert.equal(rec(noParentKey).messages[0]?.parentId, null, 'an absent parent key means root');
    assert.equal(rec(noParentKey).completeness, 'exported_tree');
  });

  it('children ABSENT everywhere: derived from parent pointers, ordered by createdAt asc (nulls last), ordinal, id; ONE warning', () => {
    const p = node('p', null);
    const mk = (id: string, t: number | null) => node(id, 'p', undefined, msg(id, 'user', id, { create_time: t }));
    const text = convText(
      [
        ['p', p],
        ['late', mk('late', 1760000300)],
        ['early', mk('early', 1760000100)],
        ['unknown-b', mk('unknown-b', null)],
        ['tie-2', mk('tie-2', 1760000200)],
        ['tie-1', mk('tie-1', 1760000200)],
        ['unknown-a', mk('unknown-a', null)],
      ],
      { current_node: 'late' },
    );
    const out = run(text);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const r = validateConversationRecord(out.record);
    // createdAt asc: early(100), tie-2/tie-1 (200, ordinal 4 then 3 -> tie-2 has ordinal 4, tie-1 ordinal 5? see below), late(300), nulls last by ordinal
    const ordinals = new Map(r.messages.map((m) => [m.id, m.ordinal]));
    assert.deepEqual(r.messages.find((m) => m.id === 'p')?.childIds, ['early', 'tie-2', 'tie-1', 'late', 'unknown-b', 'unknown-a']);
    assert.ok((ordinals.get('tie-2') as number) < (ordinals.get('tie-1') as number), 'tie broken by file ordinal');
    assert.equal(r.warnings.filter((w) => w.code === 'CHILDREN_ABSENT').length, 1, 'one warning per conversation, not per node');
    assert.equal(out.observations.nodesWithChildrenAbsent, 7);
    assert.equal(out.observations.nodesWithChildrenDeclared, 0);
    assert.deepEqual(analyzeTree(r.id, r.messages, r.currentNodeId).warnings, [], 'derived lists never produce CHILD_PARENT_MISMATCH');
  });

  it('ties on createdAt and ordinal cannot occur; equal times fall back to the file ordinal, then the id', () => {
    const text = convText(
      [
        ['p', node('p', null)],
        ['z', node('z', 'p', undefined, msg('z', 'user', 'z', { create_time: 1760000000 }))],
        ['a', node('a', 'p', undefined, msg('a', 'user', 'a', { create_time: 1760000000 }))],
      ],
      { current_node: 'z' },
    );
    assert.deepEqual(rec(text).messages[0]?.childIds, ['z', 'a'], 'file order, not alphabetical');
  });

  it('children PRESENT and consistent: the declared order is kept even when it disagrees with the times', () => {
    const text = convText(
      [
        ['p', node('p', null, ['b', 'a'])],
        ['a', node('a', 'p', [], msg('a', 'user', 'a', { create_time: 1760000100 }))],
        ['b', node('b', 'p', [], msg('b', 'user', 'b', { create_time: 1760000900 }))],
      ],
      { current_node: 'a' },
    );
    const r = rec(text);
    assert.deepEqual(r.messages[0]?.childIds, ['b', 'a']);
    assert.ok(!codes(r).includes('CHILDREN_ABSENT'));
    assert.deepEqual(analyzeTree(r.id, r.messages, r.currentNodeId).warnings, []);
  });

  it('children PRESENT but inconsistent: left as declared so the domain analyzer reports CHILD_PARENT_MISMATCH', () => {
    const text = convText(
      [
        ['p', node('p', null, ['ghost', 'a'])], // phantom child, and misses nothing else
        ['a', node('a', 'p', [], msg('a', 'user', 'a'))],
        ['b', node('b', 'p', [], msg('b', 'user', 'b'))], // child whose parent does not list it
      ],
      { current_node: 'a' },
    );
    const r = rec(text);
    assert.deepEqual(r.messages[0]?.childIds, ['ghost', 'a'], 'declared list untouched');
    assert.ok(!codes(r).includes('CHILDREN_ABSENT'));
    assert.ok(analyzeTree(r.id, r.messages, r.currentNodeId).warnings.some((w) => w.code === 'CHILD_PARENT_MISMATCH'));
  });

  it('some nodes without children, some with: derive only the missing ones, still ONE CHILDREN_ABSENT', () => {
    const text = convText(
      [
        ['r', node('r', null, ['a'])],
        ['a', node('a', 'r', undefined, msg('a', 'user', 'a'))],
        ['b', node('b', 'a', undefined, msg('b', 'assistant', 'b'))],
      ],
      { current_node: 'b' },
    );
    const r = rec(text);
    assert.deepEqual(r.messages.map((m) => m.childIds), [['a'], ['b'], []]);
    assert.equal(r.warnings.filter((w) => w.code === 'CHILDREN_ABSENT').length, 1);
  });

  it('children is null or a non-array: treated as absent (derived); non-array also reported', () => {
    const t1 = convText([['r', node('r', null, null)], ['a', node('a', 'r', null, msg('a', 'user', 'a'))]], { current_node: 'a' });
    const r1 = rec(t1);
    assert.deepEqual(r1.messages[0]?.childIds, ['a']);
    assert.ok(!codes(r1).includes('UNEXPECTED_FIELD_TYPE'));
    const t2 = convText([['r', node('r', null, 'a')], ['a', node('a', 'r', [], msg('a', 'user', 'a'))]], { current_node: 'a' });
    const r2 = rec(t2);
    assert.deepEqual(r2.messages[0]?.childIds, ['a']);
    assert.ok(codes(r2).includes('UNEXPECTED_FIELD_TYPE'));
  });

  it('children present but EMPTY everywhere while parent pointers define edges: derive + CHILDREN_ABSENT (EC-45)', () => {
    const text = convText([['r', node('r', null, [])], ['a', node('a', 'r', [], msg('a', 'user', 'a'))], ['b', node('b', 'a', [], msg('b', 'assistant', 'b'))]], { current_node: 'b' });
    const out = run(text);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.deepEqual(out.record.messages.map((m) => m.childIds), [['a'], ['b'], []]);
    assert.equal(out.record.warnings.filter((w) => w.code === 'CHILDREN_ABSENT').length, 1);
    assert.equal(out.observations.nodesWithChildrenDeclared, 3, 'observation reports what the source had: arrays were present');
    assert.deepEqual(analyzeTree(out.record.id, out.record.messages, 'b').warnings, []);
  });

  it('...but if ANY node declares children, an empty list on a node that has children is an inconsistency, not absence', () => {
    const text = convText([['r', node('r', null, ['a'])], ['a', node('a', 'r', [], msg('a', 'user', 'a'))], ['b', node('b', 'a', [], msg('b', 'assistant', 'b'))]], { current_node: 'b' });
    const r = rec(text);
    assert.deepEqual(r.messages[1]?.childIds, [], 'a declares [] although b names it as parent');
    assert.ok(!codes(r).includes('CHILDREN_ABSENT'));
    assert.ok(analyzeTree(r.id, r.messages, 'b').warnings.some((w) => w.code === 'CHILD_PARENT_MISMATCH'));
  });

  it('a single leaf-only conversation with empty children does not warn', () => {
    const r = rec(convText([['solo', node('solo', null, [], msg('solo', 'user', 'x'))]], { current_node: 'solo' }));
    assert.ok(!codes(r).includes('CHILDREN_ABSENT'));
  });

  it('declared children: repeats are dropped (DUPLICATE_CHILD_ENTRY), non-strings dropped (UNEXPECTED_FIELD_TYPE), phantoms reported (CHILD_NOT_FOUND)', () => {
    const text = convText(
      [
        ['p', node('p', null, ['a', 'a', 5, null, 'ghost', 'b'])],
        ['a', node('a', 'p', [], msg('a', 'user', 'a'))],
        ['b', node('b', 'p', [], msg('b', 'user', 'b'))],
      ],
      { current_node: 'a' },
    );
    const r = rec(text);
    assert.deepEqual(r.messages[0]?.childIds, ['a', 'ghost', 'b']);
    assert.ok(codes(r).includes('DUPLICATE_CHILD_ENTRY'));
    assert.ok(codes(r).includes('UNEXPECTED_FIELD_TYPE'));
    assert.deepEqual(warn(r, 'CHILD_NOT_FOUND')?.ids, ['ghost']);
  });

  it('a parent pointer that is not a string is treated as root, reported, and lowers completeness', () => {
    const r = rec(convText([['r', { id: 'r', message: null, parent: 7 }], ['a', node('a', 'r', [], msg('a', 'user', 'a'))]], { current_node: 'a' }));
    assert.equal(r.messages[0]?.parentId, null);
    assert.ok(codes(r).includes('UNEXPECTED_FIELD_TYPE'));
    assert.equal(r.completeness, 'unknown');
  });

  it('node values that are not objects, and messages that are not objects, become structural nodes', () => {
    const r = rec(convText([['r', node('r', null, ['a', 'b'])], ['a', 'not a node'], ['b', node('b', 'r', [], 'not a message')]], { current_node: null }));
    assert.deepEqual(r.messages.map((m) => m.nodeKind), ['structural_empty', 'structural_empty', 'structural_empty']);
    assert.ok(codes(r).includes('NODE_NOT_OBJECT'));
    assert.ok(codes(r).includes('MESSAGE_NOT_OBJECT'));
    assert.equal(r.messages[1]?.rawSource, 'not a node', 'the odd value is preserved, not dropped');
    assert.equal(r.messages[2]?.rawSource, 'not a message');
  });

  it('unusable node keys get deterministic stand-in ids; parent/child/current pointers to them are remapped consistently', () => {
    const weird = 'bad\u0001key';
    const text = convText([[weird, node(weird, null, ['kid'])], ['kid', node('kid', weird, [], msg('kid', 'user', 'x'))], ['', node('', null, [], msg('', 'user', 'y'))]], { current_node: weird });
    const r = rec(text);
    const standIn = r.messages[0]?.id as string;
    assert.match(standIn, /^gcr-node-[0-9a-f]{24}$/);
    assert.equal(r.messages[1]?.parentId, standIn);
    assert.equal(r.currentNodeId, standIn);
    assert.match(r.messages[2]?.id as string, /^gcr-node-[0-9a-f]{24}$/);
    assert.notEqual(r.messages[2]?.id, standIn);
    assert.equal(r.messages[0]?.childIds[0], 'kid');
    assert.equal(rec(text).messages[0]?.id, standIn, 'deterministic');
  });

  it('node.id and message.id are recorded but never trusted: the mapping key is the identity', () => {
    const text = convText([['k1', node('other', null, [], msg('mid', 'user', 'x'))]], { current_node: 'k1' });
    const r = rec(text);
    assert.equal(r.messages[0]?.id, 'k1');
    assert.ok(codes(r).includes('NODE_ID_MISMATCH'));
    assert.ok(codes(r).includes('MESSAGE_ID_MISMATCH'));
    assert.equal(r.currentNodeId, 'k1');
  });

  it('message.id repeated in several nodes: warned once, all nodes kept', () => {
    const text = convText([['n1', node('n1', null, ['n2'], msg('same', 'user', 'a'))], ['n2', node('n2', 'n1', [], msg('same', 'assistant', 'b'))]], { current_node: 'n2' });
    const r = rec(text);
    assert.equal(r.messages.length, 2);
    assert.deepEqual(warn(r, 'DUPLICATE_MESSAGE_ID')?.ids, ['n1', 'n2']);
  });
});

describe('current_node, completeness and the no-guessing guards', () => {
  const linear = (over: (b: ConversationBuilder) => void = () => undefined): ConversationBuilder => {
    const b = linearConversation(2);
    over(b);
    return b;
  };

  it('a valid current_node is kept; the tree is exported_tree and the active branch resolves', () => {
    const r = rec(linear().text());
    assert.equal(r.completeness, 'exported_tree');
    assert.ok(r.currentNodeId);
    assert.equal(analyzeTree(r.id, r.messages, r.currentNodeId).activeBranchId, r.currentNodeId);
    assert.ok(!codes(r).includes('COMPLETENESS_LOWERED'));
  });

  it('missing/null current_node: null + NO_CURRENT_NODE, completeness unknown with the reason, and NO active branch', () => {
    for (const over of [(b: ConversationBuilder) => b.setCurrent(OMIT), (b: ConversationBuilder) => b.setCurrent(null)]) {
      const r = rec(linear(over).text());
      assert.equal(r.currentNodeId, null);
      assert.ok(codes(r).includes('NO_CURRENT_NODE'));
      assert.equal(r.completeness, 'unknown');
      assert.match(warn(r, 'COMPLETENESS_LOWERED')?.message ?? '', /no_current_node/);
      const t = analyzeTree(r.id, r.messages, r.currentNodeId);
      assert.equal(t.activeBranchId, null, 'GCR must not pick the newest leaf');
      assert.ok(t.branches.every((br) => br.activeness === 'unknown'));
    }
  });

  it('dangling, empty-string and non-string current_node: null + INVALID_CURRENT_NODE, completeness unknown', () => {
    for (const cn of ['"ghost"', '""', '5', '["x"]', '{"a":1}', 'true']) {
      const text = linear().text().replace(/"current_node":"[^"]*"/, `"current_node":${cn}`);
      const r = rec(text);
      assert.equal(r.currentNodeId, null, cn);
      assert.ok(codes(r).includes('INVALID_CURRENT_NODE'), cn);
      assert.equal(r.completeness, 'unknown', cn);
      assert.equal(analyzeTree(r.id, r.messages, r.currentNodeId).activeBranchId, null, cn);
    }
  });

  it('current_node on the root or on a mid-tree node is kept (a real key) and noted as info CURRENT_NODE_NOT_LEAF', () => {
    const b = linearConversation(2);
    const r1 = rec(b.setCurrent('client-created-root').text());
    assert.equal(r1.currentNodeId, 'client-created-root');
    assert.ok(warn(r1, 'CURRENT_NODE_NOT_LEAF')?.message.startsWith('[info] '));
    assert.equal(r1.completeness, 'exported_tree');
    const leaf = rec(linearConversation(2).text());
    assert.ok(!codes(leaf).includes('CURRENT_NODE_NOT_LEAF'));
  });

  it('a current_node that is a key but a non-object node is still "a key of mapping"', () => {
    const r = rec(convText([['r', node('r', null, ['x'])], ['x', 5]], { current_node: 'x' }));
    assert.equal(r.currentNodeId, 'x');
  });

  const lowered: Array<[string, string, string]> = [
    ['a cycle', convText([['a', node('a', 'b', ['b'], msg('a', 'user', '1'))], ['b', node('b', 'a', ['a'], msg('b', 'assistant', '2'))]], { current_node: 'a' }), 'cycle'],
    ['a self parent', convText([['r', node('r', null, [])], ['s', node('s', 's', ['s'], msg('s', 'user', '1'))]], { current_node: 'r' }), 'cycle'],
    ['a dangling parent', convText([['r', node('r', null, [])], ['o', node('o', 'ghost', [], msg('o', 'user', '1'))]], { current_node: 'r' }), 'missing_parent'],
    ['a duplicated node id', '{"id":"c","current_node":"a","mapping":{"a":{"id":"a","message":null,"parent":null},"a":{"id":"a","message":null,"parent":null}}}', 'duplicate_node_id'],
    ['no mapping object', '{"id":"c","current_node":null,"mapping":[]}', 'mapping_invalid'],
    ['an empty mapping', '{"id":"c","current_node":null,"mapping":{}}', 'empty_mapping'],
  ];
  for (const [name, text, reason] of lowered) {
    it(`completeness is lowered to unknown for ${name} (reason "${reason}")`, () => {
      const r = rec(text);
      assert.equal(r.completeness, 'unknown');
      assert.match(warn(r, 'COMPLETENESS_LOWERED')?.message ?? '', new RegExp(reason));
    });
  }

  it('completeness stays exported_tree for multiple roots, phantom children, mismatched ids, and the children-less 2026 shape', () => {
    const multi = convText([['r1', node('r1', null, [])], ['r2', node('r2', null, ['x'])], ['x', node('x', 'r2', [], msg('x', 'user', 'x'))]], { current_node: 'x' });
    assert.equal(rec(multi).completeness, 'exported_tree');
    const phantom = convText([['r', node('r', null, ['ghost'])]], { current_node: 'r' });
    assert.equal(rec(phantom).completeness, 'exported_tree');
    assert.equal(rec(linearConversation(2, { omitChildren: true }).text()).completeness, 'exported_tree');
  });

  it('a valid forest with a valid current node but warnings of other kinds (unknown content, NUL) is still exported_tree', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    b.message(b.root(), 'assistant', contents.unknown(), { id: 'a' });
    const r = rec(b.text());
    assert.ok(codes(r).includes('UNKNOWN_CONTENT_TYPE'));
    assert.equal(r.completeness, 'exported_tree');
  });

  it('exported_tree implies the domain analyzer sees a clean forest and an active branch (soundness of the claim)', () => {
    const r = rec(linear().text());
    const t = analyzeTree(r.id, r.messages, r.currentNodeId);
    const bad = new Set(['CYCLE_DETECTED', 'SELF_PARENT', 'MISSING_PARENT', 'NO_CURRENT_NODE', 'INVALID_CURRENT_NODE']);
    assert.ok(!t.warnings.some((w) => bad.has(w.code)));
    assert.ok(t.activeBranchId);
  });
});

describe('model attribution and other fabrication guards', () => {
  it('modelSlug comes ONLY from message.metadata.model_slug', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1), defaultModel: 'conv-default' });
    const root = b.root();
    const u = b.user(root, 'q', { id: 'u', defaultModel: 'msg-default-trap' });
    const a = b.assistant(u, 'a', { id: 'a', model: 'stated-model', defaultModel: 'msg-default-trap' });
    b.assistant(a, 'b', { id: 'b', defaultModel: 'msg-default-trap' });
    const r = rec(b.text());
    const by = (id: string): MessageRecord => r.messages.find((m) => m.id === id) as MessageRecord;
    assert.equal(by('u').modelSlug, null, 'default_model_slug on the message is ignored');
    assert.equal(by('a').modelSlug, 'stated-model');
    assert.equal(by('b').modelSlug, null);
    assert.equal(r.defaultModelSlug, 'conv-default');
    assert.ok(r.messages.every((m) => m.modelSlug !== 'conv-default' && m.modelSlug !== 'msg-default-trap'));
  });

  it('model_slug is verbatim (case, punctuation); empty string -> null; non-string -> null + warning; neighbours are unaffected', () => {
    const mk = (modelJson: string): ConversationRecord => {
      const b = new ConversationBuilder({ id: syntheticUuid(1) });
      b.assistant(b.root(), 'x', { id: 'a', metadata: {} });
      const text = b.text().replace('"metadata":{"timestamp_":"absolute"}', `"metadata":{"model_slug":${modelJson}}`);
      return rec(text);
    };
    assert.equal(mk('"GPT-Synthetic_5.1-Mini"').messages[1]?.modelSlug, 'GPT-Synthetic_5.1-Mini');
    assert.equal(mk('""').messages[1]?.modelSlug, null);
    const bad = mk('5');
    assert.equal(bad.messages[1]?.modelSlug, null);
    assert.ok(codes(bad).includes('UNEXPECTED_FIELD_TYPE'));
    assert.equal(mk('null').messages[1]?.modelSlug, null);
  });

  it('a conversation with only default_model_slug has no model on any message', () => {
    const r = rec('{"id":"c","default_model_slug":"d","current_node":"a","mapping":{"a":{"id":"a","parent":null,"message":{"id":"a","author":{"role":"assistant"},"content":{"content_type":"text","parts":["x"]},"metadata":{"default_model_slug":"d2"}}}}}');
    assert.equal(r.messages[0]?.modelSlug, null);
    assert.equal(r.defaultModelSlug, 'd');
  });

  it('metadata.timestamp_ ("absolute") is a marker, not a time', () => {
    const r = rec('{"id":"c","current_node":"a","mapping":{"a":{"id":"a","parent":null,"message":{"id":"a","author":{"role":"user"},"content":{"content_type":"text","parts":["x"]},"metadata":{"timestamp_":"absolute"}}}}}');
    assert.equal(r.messages[0]?.createdAt, null);
  });
});

describe('observations (FormatObservations)', () => {
  it('counts roles, recipients, statuses, models, hidden messages, children shape and the literal root', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    const root = b.root();
    const s = b.system(root, 'sys', { id: 's' });
    const u = b.user(s, 'q', { id: 'u', status: OMIT, recipient: OMIT });
    const a = b.assistant(u, 'a', { id: 'a', model: 'm1' });
    b.tool(a, 't', { id: 't', name: 'python', model: 'm2' });
    const out = run(b.text());
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const o = out.observations;
    assert.deepEqual(o.roleCounts, { system: 1, user: 1, assistant: 1, tool: 1 });
    assert.equal(o.messagesWithRecipient, 3);
    assert.equal(o.messagesWithStatus, 3);
    assert.equal(o.messagesWithModelSlug, 2);
    assert.equal(o.hiddenMessages, 1);
    assert.equal(o.nodesWithChildrenDeclared, 5);
    assert.equal(o.nodesWithChildrenAbsent, 0);
    assert.equal(o.hasCurrentNode, true);
    assert.equal(o.rootIsLiteralClientCreatedRoot, true);
  });

  it('negative: uuid root, no current node, no children keys', () => {
    const out = run(linearConversation(1, { rootStyle: 'uuid', omitChildren: true }).setCurrent(OMIT).text());
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.equal(out.observations.rootIsLiteralClientCreatedRoot, false);
    assert.equal(out.observations.hasCurrentNode, false);
    assert.equal(out.observations.nodesWithChildrenDeclared, 0);
    assert.equal(out.observations.nodesWithChildrenAbsent, 3);
  });

  it('a role named like an Object.prototype member is counted as an ordinary key', () => {
    const out = run(convText([['a', node('a', null, [], msg('a', '__proto__', 'x'))], ['b', node('b', null, [], msg('b', 'constructor', 'y'))]], { current_node: 'a' }));
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.deepEqual(Object.keys(out.observations.roleCounts).sort(), ['__proto__', 'constructor']);
    assert.equal(Object.getPrototypeOf(out.observations.roleCounts), Object.prototype);
    assert.equal(({} as RawObject)['__proto__'] === Object.prototype, true);
  });
});

describe('rawMetadata and rawSource preservation', () => {
  it('rawMetadata has every conversation key except mapping, unknown keys included, plus _gcr', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1), extra: { future_flag_2027: { nested: [1, 2, { deep: true }] }, is_study_mode: true } });
    b.user(b.root(), 'x');
    const r = rec(b.text());
    const meta = r.rawMetadata as RawObject;
    assert.ok(!Object.hasOwn(meta, 'mapping'));
    assert.deepEqual(meta['future_flag_2027'], { nested: [1, 2, { deep: true }] });
    assert.equal(meta['is_study_mode'], true);
    assert.equal(meta['title'], `${SYNTHETIC_MARKER} synthetic conversation`);
    assert.ok(Object.hasOwn(meta, 'current_node'));
    assert.deepEqual(Object.keys(meta['_gcr'] as RawObject), ['sourceElementSha256']);
  });

  it('a source key named _gcr is preserved as _gcr_original and cannot spoof the provenance hash', () => {
    const text = '{"id":"c","_gcr":{"sourceElementSha256":"forged"},"mapping":{}}';
    const meta = rec(text).rawMetadata as RawObject;
    assert.equal((meta['_gcr'] as RawObject)['sourceElementSha256'], sha256(text));
    assert.deepEqual(meta['_gcr_original'], { sourceElementSha256: 'forged' });
  });

  it('a conversation-level "__proto__" key is copied as an own key and pollutes nothing', () => {
    const text = '{"id":"c","__proto__":{"polluted":"yes"},"mapping":{}}';
    const meta = rec(text).rawMetadata as RawObject;
    assert.ok(Object.hasOwn(meta, '__proto__'));
    assert.equal(Object.getPrototypeOf(meta), Object.prototype);
    assert.equal(({} as RawObject)['polluted'], undefined);
    assert.equal((meta as { polluted?: string }).polluted, undefined);
  });

  it('rawSource is the parsed message object; the conversation rawMetadata does not alias the mapping', () => {
    const r = rec(linearConversation(1).text());
    const m = r.messages[1];
    assert.equal((m?.rawSource as RawObject)['id'], m?.id);
    assert.equal(((m?.rawSource as RawObject)['content'] as RawObject)['content_type'], 'text');
  });
});

describe('roles, channels, recipients, statuses are open strings', () => {
  it('unseen values are stored verbatim; legacy flat role is a fallback with a warning', () => {
    const r = rec(
      convText([
        ['a', node('a', null, ['b', 'c', 'd'], msg('a', 'function', 'x', { channel: 'novel-channel', recipient: 'q7dr546', status: 'brand_new_status' }))],
        ['b', node('b', 'a', [], { id: 'b', role: 'legacy-user', content: { content_type: 'text', parts: ['y'] } })],
        ['c', node('c', 'a', [], { id: 'c', author: { name: 'n' }, content: { content_type: 'text', parts: ['z'] } })],
        ['d', node('d', 'a', [], msg('d', '__proto__', 'w'))],
      ]),
    );
    const [a, b, c, d] = r.messages;
    assert.equal(a?.authorRole, 'function');
    assert.equal(a?.channel, 'novel-channel');
    assert.equal(a?.recipient, 'q7dr546');
    assert.equal(a?.status, 'brand_new_status');
    assert.equal(b?.authorRole, 'legacy-user');
    assert.ok(codes(r).includes('LEGACY_ROLE_FIELD'));
    assert.equal(c?.authorRole, '');
    assert.equal(c?.authorName, 'n');
    assert.equal(d?.authorRole, '__proto__');
  });

  it('wrong types are null/empty with a warning and never coerced', () => {
    const r = rec(convText([['a', node('a', null, [], msg('a', 'user', 'x', { channel: 5, recipient: ['all'], status: {}, author: 'user' }))]], { current_node: 'a' }));
    const m = r.messages[0];
    assert.equal(m?.channel, null);
    assert.equal(m?.recipient, null);
    assert.equal(m?.status, null);
    assert.equal(m?.authorRole, '');
    assert.ok(r.warnings.filter((w) => w.code === 'UNEXPECTED_FIELD_TYPE').length >= 4);
  });

  it('an over-long role is truncated to the domain limit and reported', () => {
    const r = rec(convText([['a', node('a', null, [], msg('a', 'r'.repeat(600), 'x'))]], { current_node: 'a' }));
    assert.equal(r.messages[0]?.authorRole.length, 512);
    assert.ok(codes(r).includes('TEXT_TRUNCATED'));
  });
});

describe('global prototype pollution cannot leak into parsed data', () => {
  it('inherited Object.prototype properties are never read as conversation, node, message, content or attachment fields', () => {
    // Every field is ABSENT in the input, so a naive `obj.field` read would pick up the polluted inherited value.
    const text = '{"mapping":{"a":{"message":{"author":{"role":"user"},"content":{"content_type":"text"},"metadata":{"attachments":[{"id":"file-A"}]}}},"b":{"message":{"author":{"role":"assistant"},"content":{"content_type":"code"}}}}}';
    const clean = JSON.stringify(run(text, 5));
    const polluted: Record<string, unknown> = {
      id: 'evil-id',
      conversation_id: 'evil-cid',
      title: 'evil title',
      create_time: 1760000000,
      update_time: 1760000000,
      current_node: 'a',
      default_model_slug: 'evil-default',
      model_slug: 'evil-model',
      parent: 'ghost-parent',
      children: ['ghost-child'],
      message: { id: 'evil-msg' },
      author: { role: 'evil-role' },
      role: 'evil-flat-role',
      name: 'evil-name',
      channel: 'evil-channel',
      recipient: 'evil-recipient',
      status: 'evil-status',
      content: { content_type: 'text', parts: ['evil text'] },
      parts: ['evil part'],
      text: 'evil code text',
      language: 'evil-lang',
      metadata: { model_slug: 'evil-model', is_visually_hidden_from_conversation: true },
      is_visually_hidden_from_conversation: true,
      attachments: [{ id: 'evil-attachment' }],
      mime_type: 'evil/type',
      size: 99,
      asset_pointer: 'sediment://evil',
      conversations: [],
    };
    const keys = Object.keys(polluted);
    try {
      for (const k of keys) Object.defineProperty(Object.prototype, k, { value: polluted[k], configurable: true, enumerable: false, writable: true });
      assert.equal(JSON.stringify(run(text, 5)), clean, 'output must not change when Object.prototype is polluted');
    } finally {
      for (const k of keys) Reflect.deleteProperty(Object.prototype, k);
    }
    for (const k of keys) assert.ok(!(k in ({} as RawObject)), `cleanup of ${k}`);
    assert.equal(JSON.stringify(run(text, 5)), clean);
  });
});

describe('edge cases from the format notes that are decided at adapter level', () => {
  it('EC-25: a 400-digit integer literal (Infinity once parsed) and -0 never become timestamps', () => {
    const huge = `{"id":"c","create_time":1${'0'.repeat(400)},"update_time":-0,"mapping":{}}`;
    const r = rec(huge);
    assert.equal(r.createdAt, null);
    assert.equal(r.updatedAt, null);
    assert.ok(codes(r).includes('TIMESTAMP_OUT_OF_RANGE'));
  });

  it('EC-36: a mapping that is a string, number, boolean or array is a damaged conversation with zero messages (raw kept), never an abort', () => {
    for (const m of ['"text"', '5', 'true', '[1,2]', '[{"id":"a"}]', 'null']) {
      const r = rec(`{"id":"c","mapping":${m},"current_node":"a"}`);
      assert.equal(r.messages.length, 0, m);
      assert.ok(codes(r).includes('MAPPING_INVALID'), m);
      assert.equal(r.completeness, 'unknown', m);
      assert.deepEqual(((r.rawMetadata as RawObject)['_gcr'] as RawObject)['unsupportedMapping'], JSON.parse(m), m);
    }
  });

  it('EC-50: a node with message null in the MIDDLE of a chain stays a structural node and the chain continues through it', () => {
    const text = convText([['r', node('r', null, ['x'])], ['x', node('x', 'r', ['y'], null)], ['y', node('y', 'x', [], msg('y', 'user', 'hi'))]], { current_node: 'y' });
    const r = rec(text);
    assert.deepEqual(r.messages.map((m) => m.nodeKind), ['structural_empty', 'structural_empty', 'message']);
    const t = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.equal(t.branches.length, 1);
    assert.deepEqual(t.branches[0]?.path, ['r', 'x', 'y']);
    assert.equal(t.branches[0]?.messageCount, 1, 'structural nodes are not messages');
  });

  it('EC-46: a root that carries a message imports like any other message', () => {
    const r = rec(convText([['r', node('r', null, ['a'], msg('r', 'system', 'root with message'))], ['a', node('a', 'r', [], msg('a', 'user', 'hi'))]], { current_node: 'a' }));
    assert.equal(r.messages[0]?.nodeKind, 'message');
    assert.equal(r.messages[0]?.text, 'root with message');
    assert.equal(r.completeness, 'exported_tree');
  });

  it('EC-57: metadata that is an array, string, number or boolean is treated as absent (reported); null is silent', () => {
    for (const md of ['[]', '"str"', '5', 'true']) {
      const r = rec(`{"id":"c","current_node":"a","mapping":{"a":{"id":"a","parent":null,"children":[],"message":{"id":"a","author":{"role":"assistant"},"content":{"content_type":"text","parts":["x"]},"metadata":${md}}}}}`);
      assert.equal(r.messages[0]?.modelSlug, null, md);
      assert.equal(r.messages[0]?.hidden, false, md);
      assert.ok(r.warnings.some((w) => w.code === 'UNEXPECTED_FIELD_TYPE' && w.message.includes('message.metadata')), md);
    }
    const r = rec('{"id":"c","current_node":"a","mapping":{"a":{"id":"a","parent":null,"children":[],"message":{"id":"a","author":{"role":"assistant"},"content":{"content_type":"text","parts":["x"]},"metadata":null}}}}');
    assert.deepEqual(r.warnings, []);
  });

  it('EC-30: bidi controls, U+2028/2029 and private-use citation delimiters in a TITLE are stored verbatim', () => {
    const title = 'a\u202eb\u2028c\u2029d\ue200e\u200df';
    const r = rec(`{"id":"c","title":"${title}","mapping":{}}`);
    assert.equal(r.title, JSON.parse(`"${title}"`));
  });

  it('EC-63: a conversation with zero messages is a valid (if empty) record', () => {
    const r = rec('{"id":"c","title":"empty","mapping":{},"current_node":null}');
    assert.deepEqual(r.messages, []);
    assert.equal(r.title, 'empty');
  });
});
