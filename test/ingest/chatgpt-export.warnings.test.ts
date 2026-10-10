/**
 * Every warning code the adapter can emit is triggered by a positive case and NOT emitted by its closest clean
 * negative control. The table is typed `Record<ChatGPTAdapterWarningCode, ...>`, so adding a code to the adapter without
 * adding a case here fails compilation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConversationRecord } from '../../src/domain/types.js';
import { validateConversationRecord } from '../../src/domain/validate.js';
import { CHATGPT_ADAPTER_INFO_CODES, CHATGPT_ADAPTER_WARNING_CODES, ChatGPTExportAdapter, INFO_PREFIX, chatGptExportAdapter } from '../../src/ingest/chatgpt-export.js';
import type { ChatGPTAdapterWarningCode, ElementScan } from '../../src/ingest/chatgpt-export.js';
import { ConversationBuilder, OMIT, adapterContext, contents, ordered, rawJson, stringify, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { MessageOptions, RawObject } from '../helpers/chatgpt-export-builder.js';

const ctx = adapterContext();

function norm(text: string, adapter: ChatGPTExportAdapter = chatGptExportAdapter): ConversationRecord {
  const out = adapter.normalizeElementText(text, ctx, 0);
  assert.equal(out.kind, 'record');
  if (out.kind !== 'record') throw new Error('unreachable');
  return validateConversationRecord(out.record);
}

/** Root + one message; `over` tweaks the builder before serialization. */
function single(content: unknown = contents.text('hello'), o: MessageOptions & { role?: string } = {}, init: ConstructorParameters<typeof ConversationBuilder>[0] = {}): string {
  const b = new ConversationBuilder({ id: syntheticUuid(1), ...init });
  b.message(b.root(), o.role ?? 'user', content, { id: 'm', ...o });
  return b.text();
}

function convRaw(mapping: unknown, extra: RawObject = {}): string {
  return stringify({ id: syntheticUuid(1), current_node: null, mapping, ...extra });
}

const node = (id: string, parent: string | null, children: unknown, message: unknown = null): RawObject => {
  const n: RawObject = { id, message, parent };
  if (children !== undefined) n['children'] = children;
  return n;
};
const message = (id: string, text = 'hi'): RawObject => ({ id, author: { role: 'user' }, content: { content_type: 'text', parts: [text] } });

interface Case {
  positive: () => ConversationRecord;
  negative: () => ConversationRecord;
}

const tiny = (limits: ConstructorParameters<typeof ChatGPTExportAdapter>[0]): ChatGPTExportAdapter => new ChatGPTExportAdapter(limits);

const CASES: Record<ChatGPTAdapterWarningCode, Case> = {
  DUPLICATE_NODE_ID: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, [])], ['a', node('a', null, [])]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])], ['b', node('b', null, [])]]))),
  },
  DUPLICATE_KEY: {
    positive: () => norm(single(ordered([['content_type', 'text'], ['content_type', 'text'], ['parts', ['x']]]))),
    negative: () => norm(single(ordered([['content_type', 'text'], ['parts', ['x']]]))),
  },
  CONVERSATION_ID_MISSING: {
    positive: () => norm('{"mapping":{}}'),
    negative: () => norm('{"id":"c","mapping":{}}'),
  },
  ID_ALIAS_MISMATCH: {
    positive: () => norm('{"id":"a","conversation_id":"b","mapping":{}}'),
    negative: () => norm('{"id":"a","conversation_id":"a","mapping":{}}'),
  },
  ID_CASE_NORMALIZED: {
    positive: () => norm(`{"id":"${syntheticUuid(0x6a).toUpperCase()}","mapping":{}}`),
    negative: () => norm(`{"id":"${syntheticUuid(0x6a)}","mapping":{}}`),
  },
  INVALID_NODE_ID: {
    positive: () => norm(convRaw(ordered([['', node('', null, [])]]))),
    negative: () => norm(convRaw(ordered([['ok', node('ok', null, [])]]))),
  },
  NODE_ID_MISMATCH: {
    positive: () => norm(convRaw(ordered([['a', node('other', null, [])]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])]]))),
  },
  MESSAGE_ID_MISMATCH: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, [], message('other'))]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [], message('a'))]]))),
  },
  DUPLICATE_MESSAGE_ID: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, [], message('same'))], ['b', node('b', null, [], message('same'))]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [], message('a'))], ['b', node('b', null, [], message('b'))]]))),
  },
  MAPPING_INVALID: {
    positive: () => norm('{"id":"c","mapping":[]}'),
    negative: () => norm('{"id":"c","mapping":{}}'),
  },
  NODE_NOT_OBJECT: {
    positive: () => norm(convRaw(ordered([['a', 5]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])]]))),
  },
  MESSAGE_NOT_OBJECT: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, [], 'str')]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [], null)]]))),
  },
  TOO_MANY_NODES: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, [])], ['b', node('b', null, [])]])), tiny({ limits: { maxNodesPerConversation: 1 } })),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])], ['b', node('b', null, [])]])), tiny({ limits: { maxNodesPerConversation: 2 } })),
  },
  KEY_ORDER_FALLBACK: {
    positive: () => {
      const wrong: ElementScan = { mappingKeys: [], duplicateMappingKeys: [], duplicateBodySha256: new Map(), nodeKeyDuplicates: new Map(), conversationKeyDuplicates: 0, maxDepth: 1 };
      return norm(convRaw(ordered([['a', node('a', null, [])]])), tiny({ scanner: () => wrong }));
    },
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])]]))),
  },
  CHILDREN_ABSENT: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, undefined)]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])]]))),
  },
  CHILD_NOT_FOUND: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, ['ghost'])]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, ['b'])], ['b', node('b', 'a', [])]]))),
  },
  DUPLICATE_CHILD_ENTRY: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, ['b', 'b'])], ['b', node('b', 'a', [])]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, ['b'])], ['b', node('b', 'a', [])]]))),
  },
  NO_CURRENT_NODE: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, [])]]))),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])]]), { current_node: 'a' })),
  },
  INVALID_CURRENT_NODE: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, [])]]), { current_node: 'ghost' })),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])]]), { current_node: 'a' })),
  },
  CURRENT_NODE_NOT_LEAF: {
    positive: () => norm(convRaw(ordered([['a', node('a', null, ['b'])], ['b', node('b', 'a', [])]]), { current_node: 'a' })),
    negative: () => norm(convRaw(ordered([['a', node('a', null, ['b'])], ['b', node('b', 'a', [])]]), { current_node: 'b' })),
  },
  COMPLETENESS_LOWERED: {
    positive: () => norm(convRaw(ordered([['a', node('a', 'ghost', [])]]), { current_node: 'a' })),
    negative: () => norm(convRaw(ordered([['a', node('a', null, [])]]), { current_node: 'a' })),
  },
  TIMESTAMP_FORMAT: {
    positive: () => norm(single(contents.text('x'), { createTime: '1760000000.5' })),
    negative: () => norm(single(contents.text('x'), { createTime: 1760000000.5 })),
  },
  TIMESTAMP_OUT_OF_RANGE: {
    positive: () => norm(single(contents.text('x'), { createTime: 0 })),
    negative: () => norm(single(contents.text('x'), { createTime: 1760000000 })),
  },
  TIMESTAMP_UNPARSEABLE: {
    positive: () => norm(single(contents.text('x'), { createTime: true })),
    negative: () => norm(single(contents.text('x'), { createTime: 1760000000 })),
  },
  UNKNOWN_CONTENT_TYPE: {
    positive: () => norm(single(contents.unknown('future_widget_v9'))),
    negative: () => norm(single(contents.text('x'))),
  },
  UNKNOWN_PART_TYPE: {
    positive: () => norm(single(contents.multimodal([5]))),
    negative: () => norm(single(contents.multimodal(['x']))),
  },
  CONTENT_MALFORMED: {
    positive: () => norm(single(null)),
    negative: () => norm(single(contents.text('x'))),
  },
  CONTENT_SHAPE_UNEXPECTED: {
    positive: () => norm(single({ content_type: 'code' })),
    negative: () => norm(single({ content_type: 'code', text: 'x = 1' })),
  },
  PARTS_TRUNCATED: {
    positive: () => norm(single(contents.text('1', '2')), tiny({ limits: { maxPartsPerMessage: 1 } })),
    negative: () => norm(single(contents.text('1')), tiny({ limits: { maxPartsPerMessage: 1 } })),
  },
  NESTING_TOO_DEEP: {
    positive: () => norm(single(contents.text('x'), { metadata: { deep: rawJson('['.repeat(300) + ']'.repeat(300)) as unknown } })),
    negative: () => norm(single(contents.text('x'), { metadata: { deep: rawJson('['.repeat(100) + ']'.repeat(100)) as unknown } })),
  },
  NUL_STRIPPED: {
    positive: () => norm(single(contents.text('a\u0000b'))),
    negative: () => norm(single(contents.text('ab'))),
  },
  LONE_SURROGATE: {
    positive: () => norm(single(contents.text('a\ud800b'))),
    negative: () => norm(single(contents.text('a😀b'))),
  },
  TEXT_TRUNCATED: {
    positive: () => norm(single(contents.text('abcdefghij')), tiny({ limits: { maxTextBytesPerMessage: 4 } })),
    negative: () => norm(single(contents.text('abcd')), tiny({ limits: { maxTextBytesPerMessage: 4 } })),
  },
  LEGACY_ROLE_FIELD: {
    positive: () => norm(single(contents.text('x'), { set: { author: OMIT, role: 'user' } })),
    negative: () => norm(single(contents.text('x'), { role: 'user' })),
  },
  UNEXPECTED_FIELD_TYPE: {
    positive: () => norm(single(contents.text('x'), { channel: 5 as unknown as string })),
    negative: () => norm(single(contents.text('x'), { channel: 'final' })),
  },
};

describe('warning codes: each is triggered by a positive case and absent from its negative control', () => {
  const declared = new Set<string>(CHATGPT_ADAPTER_WARNING_CODES);

  it('the table covers exactly the declared codes (no stale entries, no gaps)', () => {
    assert.deepEqual(new Set(Object.keys(CASES)), declared);
    assert.equal(declared.size, CHATGPT_ADAPTER_WARNING_CODES.length, 'no duplicate declarations');
  });

  for (const code of CHATGPT_ADAPTER_WARNING_CODES) {
    it(`${code}`, () => {
      const c = CASES[code];
      const pos = c.positive();
      assert.ok(pos.warnings.some((w) => w.code === code), `positive case did not emit ${code}; got ${pos.warnings.map((w) => w.code).join(',')}`);
      const neg = c.negative();
      assert.ok(!neg.warnings.some((w) => w.code === code), `negative control emitted ${code}`);
    });
  }

  it('only declared codes are ever emitted (checked over every positive and negative case)', () => {
    for (const code of CHATGPT_ADAPTER_WARNING_CODES) {
      for (const rec of [CASES[code].positive(), CASES[code].negative()]) {
        for (const w of rec.warnings) assert.ok(declared.has(w.code), `undeclared warning code ${w.code}`);
      }
    }
  });

  it('informational codes are marked in the message; no other code is', () => {
    for (const code of CHATGPT_ADAPTER_WARNING_CODES) {
      for (const w of CASES[code].positive().warnings) {
        assert.equal(w.message.startsWith(INFO_PREFIX), CHATGPT_ADAPTER_INFO_CODES.has(w.code), `${w.code}`);
      }
    }
    assert.deepEqual([...CHATGPT_ADAPTER_INFO_CODES].sort(), ['CURRENT_NODE_NOT_LEAF', 'ID_CASE_NORMALIZED', 'TIMESTAMP_FORMAT']);
  });

  it('every warning is well-formed: fixed vocabulary, bounded message, ids bounded, no NUL, unique (code, message) per conversation', () => {
    for (const code of CHATGPT_ADAPTER_WARNING_CODES) {
      const rec = CASES[code].positive();
      const seen = new Set<string>();
      for (const w of rec.warnings) {
        assert.match(w.code, /^[A-Z][A-Z0-9_]{2,63}$/);
        assert.ok(w.message.length > 0 && w.message.length <= 2048);
        assert.ok(!w.message.includes('\u0000'));
        assert.ok(w.ids === undefined || (w.ids.length > 0 && w.ids.length <= 1000 && w.ids.every((i) => i.length > 0 && i.length <= 512 && !i.includes('\u0000'))));
        const key = `${w.code}\u0001${w.message}`;
        assert.ok(!seen.has(key), `duplicate warning ${w.code}`);
        seen.add(key);
      }
    }
  });

  it('a clean conversation emits no warnings at all (so the cases above cannot be passing vacuously)', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    b.assistant(b.user(b.root(), 'q'), 'a', { model: 'm' });
    assert.deepEqual(norm(b.text()).warnings, []);
  });

  it('occurrences are aggregated: 200 identical anomalies give ONE warning with a count and a bounded id list', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    let p = b.root();
    for (let i = 0; i < 200; i++) p = b.user(p, `t${i}`, { id: `n${i}`, createTime: 0 });
    const rec = norm(b.text());
    const w = rec.warnings.filter((x) => x.code === 'TIMESTAMP_OUT_OF_RANGE');
    assert.equal(w.length, 1);
    assert.match(w[0]?.message ?? '', /\(200 occurrences\)$/);
    assert.equal(w[0]?.ids?.length, 200);
  });

  it('the id list of an aggregated warning is capped at 1000 (the count still says how many)', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    let p = b.root();
    for (let i = 0; i < 1200; i++) p = b.user(p, `t${i}`, { id: `n${i}`, createTime: 0 });
    const w = norm(b.text()).warnings.find((x) => x.code === 'TIMESTAMP_OUT_OF_RANGE');
    assert.equal(w?.ids?.length, 1000);
    assert.match(w?.message ?? '', /\(1200 occurrences\)$/);
  });
});
