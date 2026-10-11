/**
 * Second independent adversarial review of ClaudeExportAdapter (lens: provider confusion and fabrication, data that is
 * hidden or lost on the way in, hostile fields). Each test in the "defect" groups below was written to FAIL against the
 * module as it was handed to this review, then the module was fixed minimally. The last group walks the edge cases of
 * research section 11 (EC-xx) that apply to a Claude element and gives each one an explicit, named test, because the
 * earlier suites cover many of them without saying which. Data is synthetic only.
 *
 * Defects pinned here:
 *   L1  a non-object `chat_messages` entry vanished without a trace (its value was kept nowhere), contradicting
 *       "unknown payloads are preserved, never dropped" and the ChatGPT adapter, which keeps such nodes as structural nodes
 *   L2  duplicate JSON keys were invisible: `JSON.parse` keeps the last value, so a repeated `chat_messages` hid the first
 *       array, a repeated `sender` flipped a role, and nothing was reported (the ChatGPT adapter reports DUPLICATE_KEY)
 *   L3  a `thinking` / `voice_note` block whose body is not a string lost its text silently (a `text` block warns)
 *   L4  fixtures/claude/hostile-strings.json carried RAW bidi override, line separator, private-use and ZWJ characters
 *       although the review notes claim every invisible character was re-escaped
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { analyzeTree } from '../../src/domain/branches.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { validateConversationRecord } from '../../src/domain/validate.js';
import { GcrError } from '../../src/errors.js';
import { CLAUDE_WARNING_CODES, MAX_BLOCKS_PER_MESSAGE, MAX_JSON_DEPTH } from '../../src/ingest/claude-export.js';
import {
  CLAUDE_FIXTURE_FILES,
  claudeAdapter,
  claudeConversation,
  claudeCtx,
  claudeMessage,
  claudeTimestamp,
  elementText,
  findWarning,
  fixtureElementTexts,
  message,
  recordOf,
  runElement,
  synthUuid,
  warningCodes,
} from '../helpers/claude-export-builder.js';

type Obj = Record<string, unknown>;

const CONV = synthUuid(1);

function errorOf(fn: () => unknown): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    return e;
  }
  return assert.fail('expected an error, nothing was thrown');
}

function skippedReason(text: string): string {
  const out = claudeAdapter.normalizeElementText(text, claudeCtx(), 0);
  assert.equal(out.kind, 'skipped', text.slice(0, 60));
  return out.kind === 'skipped' ? out.reason : '';
}

/** `{"uuid":..., "chat_messages":[...]}` with a single message given as RAW JSON text (so duplicate keys can be written). */
function convWithRawMessage(rawMessageJson: string): string {
  return `{"uuid":"${CONV}","chat_messages":[${rawMessageJson}]}`;
}

function gcrExtra(r: ConversationRecord): Obj | undefined {
  const meta = r.rawMetadata as Obj;
  const v = meta['_gcr'];
  return typeof v === 'object' && v !== null ? (v as Obj) : undefined;
}

// ------------------------------------------------------------------------------------------------------------------
// L1: a skipped chat_messages entry must not take its value with it
// ------------------------------------------------------------------------------------------------------------------

describe('L1: non-object chat_messages entries are preserved, not lost', () => {
  const entries: unknown[] = ['PRECIOUS-STRING-0', 42, null, ['nested', { k: 1 }], true];

  it('keeps every skipped value (with its source position) in rawMetadata._gcr, and still bridges the chain', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), ...entries.slice(0, 3) as never[], claudeMessage(4), ...entries.slice(3) as never[], claudeMessage(7)]));
    assert.deepEqual(r.messages.map((m) => m.ordinal), [0, 4, 7]);
    const extra = gcrExtra(r);
    assert.ok(extra !== undefined, 'rawMetadata._gcr exists when something was skipped');
    assert.deepEqual(extra['nonObjectChatMessages'], [
      { ordinal: 1, value: 'PRECIOUS-STRING-0' },
      { ordinal: 2, value: 42 },
      { ordinal: 3, value: null },
      { ordinal: 5, value: ['nested', { k: 1 }] },
      { ordinal: 6, value: true },
    ]);
    assert.equal(extra['nonObjectChatMessagesOmitted'], undefined, 'nothing was left out');
    assert.ok(JSON.stringify(r.rawMetadata).includes('PRECIOUS-STRING-0'), 'the string survives somewhere in the record');
    assert.equal(findWarning(r, 'NON_OBJECT_MESSAGE')?.message.includes('(5 occurrences)'), true);
    assert.equal(message(r, 1).parentId, message(r, 0).id);
    assert.equal(r.currentNodeId, message(r, 2).id);
  });

  it('says where the values went (the warning is the only thing a reader sees)', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), 'x' as never]));
    assert.match(findWarning(r, 'NON_OBJECT_MESSAGE')?.message ?? '', /rawMetadata/);
  });

  it('is bounded: 5 000 skipped entries keep the first 1 000 and report how many were left out', () => {
    const many: unknown[] = [claudeMessage(0)];
    for (let i = 0; i < 5000; i++) many.push(i);
    const r = recordOf(claudeConversation(many as Obj[]));
    const extra = gcrExtra(r);
    assert.ok(extra !== undefined);
    const kept = extra['nonObjectChatMessages'] as Obj[];
    assert.equal(kept.length, 1000);
    assert.equal(kept[0]?.['ordinal'], 1);
    assert.equal(extra['nonObjectChatMessagesOmitted'], 4000);
  });

  it('adds nothing when nothing was skipped: rawMetadata stays exactly the conversation minus its message tree', () => {
    const element = claudeConversation([claudeMessage(0), claudeMessage(1)], { extra_field: { a: 1 } });
    const r = recordOf(element);
    const { chat_messages: _tree, ...expected } = element;
    assert.deepEqual(r.rawMetadata, expected);
    assert.equal(Object.hasOwn(r.rawMetadata as Obj, '_gcr'), false);
  });

  it('a source key named _gcr can neither spoof nor be lost: it is kept as _gcr_original when the adapter adds its own', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), 7 as never], { _gcr: { sourceElementSha256: 'forged' } }));
    const meta = r.rawMetadata as Obj;
    assert.deepEqual(meta['_gcr_original'], { sourceElementSha256: 'forged' });
    assert.deepEqual((meta['_gcr'] as Obj)['nonObjectChatMessages'], [{ ordinal: 1, value: 7 }]);
  });

  it('a source _gcr is left alone when the adapter has nothing to add', () => {
    const r = recordOf(claudeConversation([claudeMessage(0)], { _gcr: { note: 'mine' } }));
    assert.deepEqual((r.rawMetadata as Obj)['_gcr'], { note: 'mine' });
  });

  it('a skipped entry named like a prototype member cannot pollute the record', () => {
    const text = `{"uuid":"${CONV}","chat_messages":[{"__proto__":{"polluted":1}},"__proto__",${JSON.stringify(claudeMessage(0))}]}`;
    const r = recordOf(text);
    assert.equal(({} as Obj)['polluted'], undefined);
    assert.equal(r.messages.length, 2, 'the object entry with a __proto__ key is an ordinary (sender-less) message');
    assert.deepEqual(gcrExtra(r)?.['nonObjectChatMessages'], [{ ordinal: 1, value: '__proto__' }]);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// L2: duplicate keys are invisible to JSON.parse and must be reported
// ------------------------------------------------------------------------------------------------------------------

describe('L2: duplicate JSON keys are reported (EC-21 / EC-22)', () => {
  const m = (n: number): string => JSON.stringify(claudeMessage(n));

  it('a repeated chat_messages hides the first array from JSON.parse; the loss is reported against the conversation', () => {
    const r = recordOf(`{"uuid":"${CONV}","chat_messages":[${m(0)}],"chat_messages":[${m(1)},${m(2)}]}`);
    assert.deepEqual(r.messages.map((x) => x.id), [synthUuid(1001), synthUuid(1002)], 'like JSON.parse, the LAST array wins');
    const w = findWarning(r, 'DUPLICATE_KEY');
    assert.ok(w !== undefined, 'DUPLICATE_KEY must be raised');
    assert.deepEqual(w.ids, [r.id]);
    assert.match(w.message, /LAST value was kept/);
  });

  it('a repeated sender flips the role (last wins) and says so', () => {
    const r = recordOf(convWithRawMessage(`{"uuid":"${synthUuid(2000)}","sender":"human","sender":"assistant","text":"x"}`));
    assert.equal(message(r, 0).authorRole, 'assistant');
    assert.ok(findWarning(r, 'DUPLICATE_KEY') !== undefined);
    assert.deepEqual(message(r, 0).rawSource, { uuid: synthUuid(2000), sender: 'assistant', text: 'x' }, 'rawSource is the parsed object, as documented');
  });

  it('a repeated key inside a content block and inside an attachment is found too', () => {
    const block = convWithRawMessage(`{"uuid":"${synthUuid(2001)}","sender":"human","content":[{"type":"text","text":"a","text":"b"}]}`);
    assert.equal(message(recordOf(block), 0).text, 'b');
    assert.ok(findWarning(recordOf(block), 'DUPLICATE_KEY') !== undefined);
    const att = convWithRawMessage(`{"uuid":"${synthUuid(2002)}","sender":"human","attachments":[{"file_name":"a.txt","file_name":"b.txt"}]}`);
    assert.equal(message(recordOf(att), 0).attachments[0]?.name, 'b.txt');
    assert.ok(findWarning(recordOf(att), 'DUPLICATE_KEY') !== undefined);
  });

  it('keys that are spelled differently but mean the same (JSON escapes) are duplicates', () => {
    const r = recordOf(`{"uuid":"${CONV}","na\\u006de":"first","name":"second","chat_messages":[]}`);
    assert.equal(r.title, 'second');
    assert.ok(findWarning(r, 'DUPLICATE_KEY') !== undefined);
  });

  it('counts every duplicate: three repeated keys are "(3 occurrences)"', () => {
    const r = recordOf(`{"uuid":"${CONV}","a":1,"a":2,"a":3,"a":4,"chat_messages":[]}`);
    assert.match(findWarning(r, 'DUPLICATE_KEY')?.message ?? '', /\(3 occurrences\)/);
  });

  it('there is NO warning for look-alikes: the same keys in sibling objects, keys inside string values, an unrelated array of equal objects', () => {
    const lookalike = JSON.stringify({ text: 'x "a":1,"a":2 and {"b":1,"b":2}', note: '\\"k\\":1,\\"k\\":2' });
    const siblings = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
    const r = recordOf(`{"uuid":"${CONV}","summary":${JSON.stringify(lookalike)},"chat_messages":[${JSON.stringify(claudeMessage(0, { content: siblings }))},${m(1)}]}`);
    assert.equal(findWarning(r, 'DUPLICATE_KEY'), undefined);
  });

  it('a clean element, and every committed fixture, produces no DUPLICATE_KEY', () => {
    assert.equal(findWarning(recordOf(claudeConversation([claudeMessage(0), claudeMessage(1)])), 'DUPLICATE_KEY'), undefined);
    for (const file of CLAUDE_FIXTURE_FILES) {
      for (const text of fixtureElementTexts(file)) {
        const out = runElement(text);
        if (out.kind === 'record') assert.equal(findWarning(out.record, 'DUPLICATE_KEY'), undefined, file);
      }
    }
  });

  it('a duplicate key buried deeper than the tracked levels (a tool input) neither crashes nor blocks the conversion', () => {
    let deep = '{"k":1,"k":2}';
    for (let i = 0; i < 100; i++) deep = `{"n":${deep}}`;
    const r = recordOf(convWithRawMessage(`{"uuid":"${synthUuid(2003)}","sender":"assistant","content":[{"type":"tool_use","name":"t","input":${deep}}]}`));
    assert.equal(r.messages.length, 1);
  });

  it('an object with a million distinct keys is scanned in bounded time and memory', { timeout: 60_000 }, () => {
    const keys: string[] = [];
    for (let i = 0; i < 1_000_000; i++) keys.push(`"k${i}":0`);
    const t0 = performance.now();
    const r = recordOf(`{"uuid":"${CONV}","wide":{${keys.join(',')}},"chat_messages":[]}`);
    assert.equal(findWarning(r, 'DUPLICATE_KEY'), undefined);
    assert.ok(performance.now() - t0 < 30_000);
  });

  it('DUPLICATE_KEY is a documented, exported warning code', () => {
    assert.equal((CLAUDE_WARNING_CODES as Record<string, string>)['DUPLICATE_KEY'], 'DUPLICATE_KEY');
  });
});

// ------------------------------------------------------------------------------------------------------------------
// L3: a reasoning / voice block with an unusable body is reported like a text block
// ------------------------------------------------------------------------------------------------------------------

describe('L3: thinking and voice_note blocks without a text body are reported', () => {
  const cases: Array<[string, Obj]> = [
    ['thinking with an array body', { type: 'thinking', thinking: ['chunk one', 'chunk two'] }],
    ['thinking with an object body', { type: 'thinking', thinking: { summary: 's' } }],
    ['thinking with a number body', { type: 'thinking', thinking: 9 }],
    ['thinking without any body', { type: 'thinking' }],
    ['voice_note with a number', { type: 'voice_note', text: 5 }],
    ['voice_note without text', { type: 'voice_note' }],
  ];
  for (const [label, block] of cases) {
    it(`${label}: block kept without text, MALFORMED_CONTENT_BLOCK names the message, reasoning stays hidden`, () => {
      const r = recordOf(claudeConversation([claudeMessage(1, { text: undefined, content: [block] })]));
      const m = message(r, 0);
      assert.equal(m.blocks.length, 1);
      assert.equal(m.blocks[0]?.text, undefined);
      assert.equal(m.text, '');
      assert.deepEqual(findWarning(r, 'MALFORMED_CONTENT_BLOCK')?.ids, [m.id]);
      if (block['type'] === 'thinking') assert.equal((m.blocks[0]?.metadata as Obj)['hidden'], true);
    });
  }

  it('the aggregated warning text does not depend on which malformed shape came first (it is kept from the first occurrence)', () => {
    const shapes: Obj[] = [{ type: 'text' }, { type: 'thinking' }, { type: 'voice_note' }, { notAType: 1 }];
    const messages = new Set<string>();
    for (const first of shapes) {
      for (const second of shapes) {
        const r = recordOf(claudeConversation([claudeMessage(1, { text: undefined, content: [first, second] })]));
        messages.add(findWarning(r, 'MALFORMED_CONTENT_BLOCK')?.message ?? 'MISSING');
      }
    }
    assert.equal(messages.size, 1, [...messages].join(' | '));
  });

  it('well-formed thinking / voice_note blocks (including an EMPTY string body) raise no warning', () => {
    const r = recordOf(claudeConversation([claudeMessage(1, { text: undefined, content: [{ type: 'thinking', thinking: 'ok' }, { type: 'thinking', thinking: '' }, { type: 'thinking', text: 'fallback' }, { type: 'voice_note', text: 'hello' }, { type: 'voice_note', text: '' }] })]));
    assert.equal(findWarning(r, 'MALFORMED_CONTENT_BLOCK'), undefined);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// L4: committed files carry no raw invisible / bidi / private-use characters
// ------------------------------------------------------------------------------------------------------------------

describe('L4: committed fixtures and owned sources contain no raw invisible characters', () => {
  // Cf = format (ZWJ, bidi controls, BOM, soft hyphen), Co = private use, Zl/Zp = line/paragraph separators,
  // Cs = surrogates, Cc = controls other than the three whitespace controls. All must be written as escapes.
  const INVISIBLE = /[\p{Cf}\p{Co}\p{Zl}\p{Zp}\p{Cs}\p{Cc}]/u;
  const root = (rel: string): URL => new URL(`../../../${rel}`, import.meta.url);

  function ownedFiles(): string[] {
    const files: string[] = [];
    for (const f of readdirSync(root('fixtures/claude/'))) files.push(`fixtures/claude/${f}`);
    for (const f of readdirSync(root('test/ingest/'))) {
      if (/^(claude-export|openai-api|registry)\..*\.test\.ts$/.test(f) || /^(claude-export|openai-api|registry)\.test\.ts$/.test(f)) files.push(`test/ingest/${f}`);
    }
    files.push('src/ingest/claude-export.ts', 'src/ingest/openai-api.ts', 'src/ingest/registry.ts', 'test/helpers/claude-export-builder.ts', 'docs/ADAPTERS.md');
    return files;
  }

  it('the file list is not empty and includes every Claude fixture', () => {
    const files = ownedFiles();
    for (const f of CLAUDE_FIXTURE_FILES) assert.ok(files.includes(`fixtures/claude/${f}`), f);
    assert.ok(files.length > 15);
  });

  it('no owned file contains a raw format, private-use, separator, surrogate or control character', () => {
    const offenders: string[] = [];
    for (const rel of ownedFiles()) {
      const text = readFileSync(root(rel), 'utf8');
      let line = 1;
      for (const ch of text) {
        if (ch === '\n') line++;
        else if (ch !== '\t' && ch !== '\r' && INVISIBLE.test(ch)) offenders.push(`${rel}:${line} U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('re-escaping did not change what the hostile fixture means: the parsed strings still contain the hostile characters', () => {
    const [el] = JSON.parse(readFileSync(root('fixtures/claude/hostile-strings.json'), 'utf8')) as Obj[];
    const messages = (el as Obj)['chat_messages'] as Obj[];
    const text = (messages[1] as Obj)['text'] as string;
    for (const needle of ['\u202e', '\u2028', '\ue200', '\u200d', '👩']) assert.ok(text.includes(needle) || String((el as Obj)['name']).includes(needle), `U+${needle.codePointAt(0)?.toString(16)}`);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Documentation and code agree on the warning vocabulary
// ------------------------------------------------------------------------------------------------------------------

describe('docs/ADAPTERS.md section 3.5 lists exactly the warning codes the adapter can emit', () => {
  const doc = readFileSync(new URL('../../../docs/ADAPTERS.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('### 3.5'), doc.indexOf('### 3.6'));
  const documented = new Set([...section.matchAll(/`([A-Z][A-Z_]+)`/g)].map((x) => x[1] as string));
  const TREE_CODES = ['MISSING_PARENT', 'CYCLE_DETECTED', 'CHILD_PARENT_MISMATCH', 'CLAUDE_WARNING_CODES'];

  it('every exported code is documented and every documented code is exported (tree codes belong to branches.ts)', () => {
    const exported = Object.keys(CLAUDE_WARNING_CODES);
    assert.deepEqual(exported.filter((c) => !documented.has(c)), []);
    assert.deepEqual([...documented].filter((c) => !exported.includes(c) && !TREE_CODES.includes(c)), []);
  });

  it('every key equals its value (the constant is a vocabulary, not a rename table)', () => {
    for (const [k, v] of Object.entries(CLAUDE_WARNING_CODES)) assert.equal(k, v);
  });

  it('every code that the committed fixtures and the hostile corpus produce is in the vocabulary', () => {
    const known = new Set<string>(Object.values(CLAUDE_WARNING_CODES));
    const seen = new Set<string>();
    const texts: string[] = CLAUDE_FIXTURE_FILES.flatMap((f) => fixtureElementTexts(f));
    texts.push(
      elementText(claudeConversation([claudeMessage(0, { sender: undefined, uuid: 5, created_at: 'x', model: 3, text: 4, content: 'z', attachments: 'q' }), 9 as never])),
      `{"uuid":"${CONV}","a":1,"a":2,"chat_messages":[]}`,
    );
    for (const t of texts) {
      const out = runElement(t);
      if (out.kind === 'record') for (const w of out.record.warnings) seen.add(w.code);
    }
    assert.deepEqual([...seen].filter((c) => !known.has(c)), []);
    assert.ok(seen.size > 8, 'the corpus really exercises the vocabulary');
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Fabrication and provider confusion that the adapter must refuse (explicit, named checks)
// ------------------------------------------------------------------------------------------------------------------

describe('a Claude element never borrows ChatGPT semantics', () => {
  it('a ChatGPT-style current_node / default_model_slug / model_slug in a Claude element is data, not an active branch or a model', () => {
    const msgs = [claudeMessage(0), claudeMessage(1), claudeMessage(2)];
    const r = recordOf(claudeConversation(msgs, { current_node: msgs[0]?.['uuid'], default_model_slug: 'gpt-LEAK', model_slug: 'gpt-LEAK2' }));
    assert.equal(r.currentNodeId, msgs[2]?.['uuid'], 'only the structure of the single chain decides, never a foreign pointer');
    assert.equal(r.defaultModelSlug, null);
    assert.ok(r.messages.every((x) => x.modelSlug === null));
    assert.equal((r.rawMetadata as Obj)['current_node'], msgs[0]?.['uuid'], 'but the foreign key is preserved');
  });

  it('a message-level ChatGPT shape (author.role, metadata.model_slug, parent, children) is not read: no role, model, parent or edge appears', () => {
    const a = claudeMessage(0);
    const b = claudeMessage(1, { author: { role: 'user' }, metadata: { model_slug: 'gpt-LEAK' }, parent: a['uuid'], children: [synthUuid(77)], channel: 'final', recipient: 'web', status: 'finished_successfully' });
    const r = recordOf(claudeConversation([a, b]));
    const m = message(r, 1);
    assert.equal(m.authorRole, 'assistant');
    assert.equal(m.modelSlug, null);
    assert.equal(m.channel, null);
    assert.equal(m.recipient, null);
    assert.equal(m.status, null);
    assert.equal(m.authorName, null);
    assert.deepEqual(m.childIds, []);
    assert.equal(m.parentId, message(r, 0).id, 'the linear chain, not the foreign `parent` key');
  });

  it('children arrays written into messages create no phantom, mismatching or one-sided edges (EC-42 / EC-43 / EC-45)', () => {
    const ids = [synthUuid(1000), synthUuid(1001), synthUuid(1002)];
    const msgs = [claudeMessage(0, { children: [ids[2], 'ghost-id'] }), claudeMessage(1, { children: [] }), claudeMessage(2, { children: [ids[0]] })];
    const r = recordOf(claudeConversation(msgs));
    assert.deepEqual(r.messages.map((x) => x.childIds), [[ids[1]], [ids[2]], []]);
    const tree = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.deepEqual(tree.warnings, []);
    assert.equal(tree.branches.length, 1);
  });

  it('an element with both provider markers is never silently a plain Claude record', () => {
    const r = recordOf(claudeConversation([claudeMessage(0)], { mapping: { a: { id: 'a', message: null, parent: null, children: [] } } }));
    assert.ok(findWarning(r, 'FOREIGN_PROVIDER_MARKER') !== undefined);
    assert.equal(r.provider, 'claude');
    assert.equal(r.provenance, 'official_claude_export');
  });

  it('sender "human" and "user" collapse to one normalized role but the original is recoverable per message', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { sender: 'human' }), claudeMessage(1, { sender: 'user' }), claudeMessage(2, { sender: 'Human' }), claudeMessage(3, { sender: 'assistant' })]));
    assert.deepEqual(r.messages.map((x) => x.authorRole), ['user', 'user', 'Human', 'assistant']);
    assert.deepEqual(r.messages.map((x) => (x.rawSource as Obj)['sender']), ['human', 'user', 'Human', 'assistant']);
  });

  it('context for another provider is refused for EVERY foreign provider value, and nothing is converted', () => {
    for (const provider of ['chatgpt', 'openai_api', 'CLAUDE', 'claude ', '', undefined, null, 5] as unknown[]) {
      const e = errorOf(() => claudeAdapter.normalizeElementText(elementText(claudeConversation([claudeMessage(0)])), { ...claudeCtx(), provider } as never, 0));
      assert.equal(e.code, 'INVALID_ARGUMENT');
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Research section 11: the edge cases that apply to ONE Claude conversation element, each named and tested.
// (EC-01..16, 19, 20 belong to zip/layout/json-stream/import-runner; EC-33 and EC-56 are import-runner / reporting concerns.)
// ------------------------------------------------------------------------------------------------------------------

describe('research section 11 edge cases for a Claude element', () => {
  const one = (over: Obj = {}, msgOver: Obj = {}): ConversationRecord => recordOf(claudeConversation([claudeMessage(1, msgOver)], over));

  it('EC-17: {}, null, numbers, strings and nested arrays as an element are skipped with their own reasons, never imported or thrown', () => {
    assert.equal(skippedReason('{}'), 'EMPTY_CONVERSATION_ENTRY');
    for (const t of ['null', '7', '"s"', '[[]]', '[]', 'true']) assert.equal(skippedReason(t), 'NON_OBJECT_ENTRY', t);
  });

  it('EC-18: a UTF-8 BOM is stripped; invalid UTF-8 never reaches the adapter (it receives decoded text with U+FFFD, which is kept)', () => {
    assert.equal(recordOf(`\ufeff${elementText(claudeConversation([claudeMessage(0)]))}`).messages.length, 1);
    const r = recordOf(claudeConversation([claudeMessage(0, { text: 'bad \ufffd byte', content: [] })]));
    assert.equal(message(r, 0).text, 'bad \ufffd byte');
  });

  it('EC-21/22: duplicate keys anywhere are reported (see L2)', () => {
    assert.ok(findWarning(recordOf(`{"uuid":"${CONV}","name":"a","name":"b","chat_messages":[]}`), 'DUPLICATE_KEY') !== undefined);
  });

  it('EC-23: prototype-member ids are ordinary ids as message uuids, parent pointers and the conversation uuid', () => {
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'];
    const msgs = names.map((uuid, i) => claudeMessage(i, { uuid, parent_message_uuid: i === 0 ? null : names[i - 1] }));
    const r = recordOf(claudeConversation(msgs, { uuid: '__proto__' }));
    assert.equal(r.id, '__proto__');
    assert.deepEqual(r.messages.map((x) => x.id), names);
    assert.deepEqual(r.messages.map((x) => x.parentId), [null, ...names.slice(0, -1)]);
    assert.equal(r.currentNodeId, 'prototype');
    assert.equal(({} as Obj)['polluted'], undefined);
  });

  it('EC-24: integer-like ids keep the FILE order in both modes (object-key order would put "10" before "9")', () => {
    const ids = ['10', '9', '1', '100', '2'];
    const linear = recordOf(claudeConversation(ids.map((uuid, i) => claudeMessage(i, { uuid }))));
    assert.deepEqual(linear.messages.map((x) => x.id), ids);
    assert.deepEqual(linear.messages.map((x) => x.parentId), [null, ...ids.slice(0, -1)]);
    const same = claudeTimestamp(0);
    const fan = recordOf(claudeConversation([claudeMessage(0, { uuid: 'root', parent_message_uuid: null }), ...ids.map((uuid, i) => claudeMessage(i + 1, { uuid, parent_message_uuid: 'root', created_at: same }))]));
    assert.deepEqual(fan.messages[0]?.childIds, ids, 'equal timestamps: ties are broken by file position, not by key order');
  });

  it('EC-25: huge number spellings never leak into the record as non-canonical values', () => {
    for (const literal of ['1e999', '-1e999', '9007199254740993', '12345678901234567890', '0.5', '-1']) {
      const r = recordOf(convWithRawMessage(`{"uuid":"${synthUuid(3000)}","sender":"human","attachments":[{"file_name":"a","file_size":${literal}}]}`));
      assert.equal(message(r, 0).attachments[0]?.sizeBytes, null, literal);
      assert.ok(findWarning(r, 'INVALID_ATTACHMENT_FIELD') !== undefined, literal);
    }
    const ok = recordOf(convWithRawMessage(`{"uuid":"${synthUuid(3001)}","sender":"human","attachments":[{"file_name":"a","file_size":-0}]}`));
    assert.ok(Object.is(message(ok, 0).attachments[0]?.sizeBytes, 0));
    const hugeLiteral = '9'.repeat(400);
    assert.equal(message(recordOf(convWithRawMessage(`{"uuid":"${synthUuid(3002)}","sender":"human","attachments":[{"file_size":${hugeLiteral}}]}`)), 0).attachments[0]?.sizeBytes, null);
  });

  it(`EC-26: nesting beyond ${MAX_JSON_DEPTH} is IMPORT_LIMIT_EXCEEDED for that element (100 000 levels too), not a stack overflow`, () => {
    for (const depth of [MAX_JSON_DEPTH + 1, 100_000]) {
      const text = `{"uuid":"${CONV}","x":${'['.repeat(depth)}${']'.repeat(depth)},"chat_messages":[]}`;
      assert.equal(errorOf(() => claudeAdapter.normalizeElementText(text, claudeCtx(), 0)).code, 'IMPORT_LIMIT_EXCEEDED');
    }
  });

  it('EC-27: NaN / Infinity literals (a Python-written file) are an IMPORT_PARSE_ERROR for that element with no echo of the text', () => {
    for (const lit of ['NaN', 'Infinity', '-Infinity']) {
      const e = errorOf(() => claudeAdapter.normalizeElementText(`{"uuid":"${CONV}","x":${lit},"chat_messages":[]}`, claudeCtx(), 0));
      assert.equal(e.code, 'IMPORT_PARSE_ERROR');
      assert.ok(!JSON.stringify(e.toEnvelope()).includes(lit));
    }
  });

  it('EC-28: lone surrogates are repaired in text, title and role, never in ids; the raw value stays', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { text: 'a\ud800b\udfffc', content: [], uuid: 'id\ud800', sender: 's\udc00' })], { name: 'T\ud800' }));
    assert.equal(r.title, 'T\ufffd');
    assert.equal(message(r, 0).text, 'a\ufffdb\ufffdc');
    assert.equal(message(r, 0).authorRole, 's\ufffd');
    assert.equal(message(r, 0).id, 'synthetic-msg-0');
    assert.equal(((message(r, 0).rawSource as Obj)['text']), 'a\ud800b\udfffc');
    assert.ok(findWarning(r, 'LONE_SURROGATE') !== undefined);
  });

  it('EC-29: NUL is stripped from text, title and attachment names (with a warning); an id containing NUL is unusable, not "escaped"', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { text: 'a\u0000b', content: [], uuid: 'id\u0000x', attachments: [{ file_name: 'n\u0000m', file_size: 1 }] })], { name: 'T\u0000U' }));
    assert.equal(r.title, 'TU');
    assert.equal(message(r, 0).text, 'ab');
    assert.equal(message(r, 0).attachments[0]?.name, 'nm');
    assert.equal(message(r, 0).id, 'synthetic-msg-0');
    assert.ok(findWarning(r, 'NUL_STRIPPED') !== undefined);
    assert.ok(findWarning(r, 'MESSAGE_ID_INVALID') !== undefined);
  });

  it('EC-30: U+2028/2029, bidi controls, ZWJ sequences, astral emoji and private-use characters are stored verbatim', () => {
    const text = 'ls\u2028ps\u2029 bidi\u202e zwj👩\u200d💻 pua\ue200\ue203 astral😀';
    assert.equal(message(one({}, { text, content: [] }), 0).text, text);
  });

  it('EC-31: one 8 MiB message is accepted whole; 60 000 tiny blocks are capped with a marker warning and the rest stays in rawSource', { timeout: 60_000 }, () => {
    const big = 'x'.repeat(8 * 1024 * 1024);
    assert.equal(message(one({}, { text: big, content: [] }), 0).text.length, big.length);
    const blocks = Array.from({ length: MAX_BLOCKS_PER_MESSAGE + 10_000 }, () => ({ type: 'text', text: 'abcdefghij' }));
    const r = one({}, { text: undefined, content: blocks });
    assert.equal(message(r, 0).blocks.length, MAX_BLOCKS_PER_MESSAGE);
    assert.ok(findWarning(r, 'BLOCKS_TRUNCATED') !== undefined);
  });

  it('EC-32: a missing, non-string, empty, over-long or whitespace-padded conversation id never aborts and never collides; upper-case UUIDs are lower-cased', () => {
    const ids = new Set<string>();
    for (const uuid of [undefined, null, 5, '', 'x'.repeat(600), ['a'], { a: 1 }] as unknown[]) {
      const r = recordOf(claudeConversation([claudeMessage(0)], { uuid }), claudeCtx(), 0);
      assert.match(r.id, /^gcr-synth-[0-9a-f]{32}-0$/);
      ids.add(r.id);
    }
    assert.ok(ids.size >= 5, 'different elements get different synthetic ids');
    const spaced = recordOf(claudeConversation([], { uuid: ` ${CONV} ` }));
    assert.equal(spaced.id, ` ${CONV} `, 'not trimmed, not guessed');
    const upper = recordOf(claudeConversation([], { uuid: 'ABCDEF01-2345-4678-89AB-CDEF01234567' }));
    assert.equal(upper.id, 'abcdef01-2345-4678-89ab-cdef01234567');
  });

  it('EC-33: the same conversation id with different content gives two independent records, and re-running an element reproduces its record exactly', () => {
    const a = claudeConversation([claudeMessage(0)]);
    const b = claudeConversation([claudeMessage(0), claudeMessage(1)]);
    const ra = recordOf(a);
    const rb = recordOf(b);
    assert.equal(ra.id, rb.id);
    assert.notEqual(ra.messages.length, rb.messages.length);
    assert.deepEqual(recordOf(a), ra);
  });

  it('EC-34: the title is null when absent, null, empty or not a string; never used as identity; markup and 100 000 characters are handled', () => {
    for (const name of [undefined, null, '', 5, { a: 1 }, ['t']] as unknown[]) assert.equal(recordOf(claudeConversation([], { name })).title, null);
    assert.equal(recordOf(claudeConversation([], { name: '<script>alert(1)</script>' })).title, '<script>alert(1)</script>');
    assert.equal(recordOf(claudeConversation([], { name: 't'.repeat(100_000) })).title?.length, 8192);
    const same = recordOf(claudeConversation([], { name: 'same title', uuid: synthUuid(8) }));
    const other = recordOf(claudeConversation([], { name: 'same title', uuid: synthUuid(9) }));
    assert.notEqual(same.id, other.id);
  });

  it('EC-35: absent / null / wrong-type / zone-less / millisecond / zero / negative / 1e20 / update-before-create timestamps', () => {
    for (const bad of ['', 'yesterday', '2025-03-04T05:06:07', 1741064767, 1741064767000, 0, -5, 1e20, '0', true, {}, []] as unknown[]) {
      const r = recordOf(claudeConversation([claudeMessage(0, { created_at: bad })], { created_at: bad }));
      assert.equal(r.createdAt, null, JSON.stringify(bad));
      assert.equal(message(r, 0).createdAt, null, JSON.stringify(bad));
    }
    const r = recordOf(claudeConversation([claudeMessage(0)], { created_at: '2025-03-04T05:06:07Z', updated_at: '2025-03-03T05:06:07Z' }));
    assert.equal(r.createdAt, '2025-03-04T05:06:07.000Z');
    assert.equal(r.updatedAt, '2025-03-03T05:06:07.000Z', 'reported as given');
  });

  it('EC-36: chat_messages that is null, {}, a string or absent is NOT_A_CONVERSATION (no abort, no bogus empty conversation); [] is an empty conversation', () => {
    for (const body of ['"chat_messages":null', '"chat_messages":{}', '"chat_messages":"x"', '"chat_messages":5', '"other":1']) {
      assert.equal(skippedReason(`{"uuid":"${CONV}",${body}}`), 'NOT_A_CONVERSATION', body);
    }
    const empty = recordOf(`{"uuid":"${CONV}","chat_messages":[]}`);
    assert.equal(empty.messages.length, 0);
    assert.equal(empty.currentNodeId, null);
  });

  it('EC-37: with no supported active-branch marker the pointer is derived only from a single chain, otherwise null with ACTIVE_BRANCH_UNKNOWN', () => {
    const a = claudeMessage(0, { parent_message_uuid: null });
    const fork = recordOf(claudeConversation([a, claudeMessage(1, { parent_message_uuid: a['uuid'] }), claudeMessage(2, { parent_message_uuid: a['uuid'] })]));
    assert.equal(fork.currentNodeId, null);
    assert.ok(findWarning(fork, 'ACTIVE_BRANCH_UNKNOWN') !== undefined);
    assert.equal(fork.completeness, 'rendered_active_view_only');
  });

  it('EC-38: unknown conversation-level keys are retained and missing known keys never error', () => {
    const r = recordOf({ uuid: CONV, chat_messages: [], atlas_mode_enabled: true, brand_new_key: { a: [1] } });
    assert.equal((r.rawMetadata as Obj)['atlas_mode_enabled'], true);
    assert.deepEqual((r.rawMetadata as Obj)['brand_new_key'], { a: [1] });
    assert.equal(r.title, null);
    assert.equal(r.createdAt, null);
  });

  it('EC-39: a conversation that copies another conversation\'s message ids is independent of it (ids are scoped by conversation)', () => {
    const msgs = [claudeMessage(0), claudeMessage(1)];
    const a = recordOf(claudeConversation(msgs, { uuid: synthUuid(10) }));
    const b = recordOf(claudeConversation(msgs, { uuid: synthUuid(11), name: 'branch in new chat' }));
    assert.deepEqual(a.messages.map((x) => x.id), b.messages.map((x) => x.id));
    assert.ok(a.messages.every((x) => x.conversationId === a.id) && b.messages.every((x) => x.conversationId === b.id));
  });

  it('EC-40: a cycle reachable from a root, a cycle with no root and a self-parent import without hanging; no active branch is claimed', () => {
    const mk = (id: string, parent: string | null): Obj => claudeMessage(0, { uuid: id, parent_message_uuid: parent });
    for (const msgs of [
      [mk('a', null), mk('b', 'a'), mk('c', 'b'), mk('d', 'c'), mk('b2', 'd')],
      [mk('a', 'b'), mk('b', 'a')],
      [mk('a', 'a')],
      [mk('r', null), mk('x', 'y'), mk('y', 'x')],
    ]) {
      const r = recordOf(claudeConversation(msgs));
      analyzeTree(r.id, r.messages, r.currentNodeId);
    }
    assert.equal(recordOf(claudeConversation([mk('a', 'b'), mk('b', 'a')])).currentNodeId, null);
    assert.equal(recordOf(claudeConversation([mk('a', 'a')])).currentNodeId, null);
    assert.equal(recordOf(claudeConversation([mk('r', null), mk('x', 'y'), mk('y', 'x')])).currentNodeId, null);
  });

  it('EC-41: a dangling parent keeps the pointer verbatim; the tree analysis reports MISSING_PARENT and still sees one chain', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { parent_message_uuid: 'not-in-this-export' }), claudeMessage(1, { parent_message_uuid: synthUuid(1000) })]));
    assert.equal(message(r, 0).parentId, 'not-in-this-export');
    assert.ok(analyzeTree(r.id, r.messages, r.currentNodeId).warnings.some((w) => w.code === 'MISSING_PARENT'));
  });

  it('EC-44: CHILDREN_ABSENT is raised once per non-empty conversation, never once per message', () => {
    const r = recordOf(claudeConversation(Array.from({ length: 40 }, (_, i) => claudeMessage(i))));
    assert.equal(warningCodes(r).filter((c) => c === 'CHILDREN_ABSENT').length, 1);
  });

  it('EC-46: several roots, a root that carries a message and no root at all (a cycle) are all handled', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { parent_message_uuid: null }), claudeMessage(1, { parent_message_uuid: null }), claudeMessage(2, { parent_message_uuid: synthUuid(1001) })]));
    assert.deepEqual(r.messages.map((x) => x.parentId), [null, null, synthUuid(1001)]);
    assert.equal(r.currentNodeId, null);
  });

  it('EC-47: duplicate message uuids keep both messages (suffix + warning); the later pointer target is the first occurrence', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { uuid: 'dup' }), claudeMessage(1, { uuid: 'dup' }), claudeMessage(2, { uuid: 'dup' })]));
    assert.deepEqual(r.messages.map((x) => x.id), ['dup', 'dup~dup2', 'dup~dup3']);
    assert.deepEqual(findWarning(r, 'DUPLICATE_MESSAGE_ID')?.ids, ['dup']);
  });

  it('EC-48: a 3 000-message chain and a 3 000-child fan-out convert and analyse in linear time', { timeout: 60_000 }, () => {
    const chain = recordOf(claudeConversation(Array.from({ length: 3000 }, (_, i) => claudeMessage(i))));
    assert.equal(analyzeTree(chain.id, chain.messages, chain.currentNodeId).branches.length, 1);
    const root = claudeMessage(0, { uuid: 'root', parent_message_uuid: null });
    const kids = Array.from({ length: 3000 }, (_, i) => claudeMessage(i + 1, { uuid: `k${i}`, parent_message_uuid: 'root' }));
    const fan = recordOf(claudeConversation([root, ...kids]));
    assert.equal(fan.messages[0]?.childIds.length, 3000);
    assert.equal(fan.currentNodeId, null);
  });

  it('EC-49: the stored order is not the active branch: a regenerated answer stored later does not become the active branch', () => {
    const a = claudeMessage(0, { parent_message_uuid: null });
    const r = recordOf(claudeConversation([a, claudeMessage(1, { parent_message_uuid: a['uuid'] }), claudeMessage(2, { parent_message_uuid: a['uuid'], created_at: claudeTimestamp(99) })]));
    assert.equal(r.currentNodeId, null);
    const tree = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.equal(tree.activeBranchId, null);
    assert.equal(tree.branches.length, 2);
  });

  it('EC-50: a null / scalar entry in the middle of the chain does not break it', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), null as never, claudeMessage(2)]));
    assert.equal(message(r, 1).parentId, message(r, 0).id);
    assert.equal(r.currentNodeId, message(r, 1).id);
  });

  it('EC-51: content absent / null / a string / an object, and blocks without a type, leave the message with zero text blocks and a warning', () => {
    for (const content of [undefined, null, 'text', { type: 'text', text: 'x' }, 5, true]) {
      const r = recordOf(claudeConversation([claudeMessage(1, { text: undefined, content })]));
      assert.equal(message(r, 0).blocks.length, 0, JSON.stringify(content));
      assert.equal(message(r, 0).text, '');
      if (content !== undefined && content !== null) assert.ok(findWarning(r, 'INVALID_CONTENT') !== undefined);
    }
  });

  it('EC-52: objects, numbers, booleans, null and nested arrays as content blocks become typed blocks; no "[object Object]" reaches the text', () => {
    const r = recordOf(claudeConversation([claudeMessage(1, { text: undefined, content: [{ a: 1 }, 5, false, null, [1, [2]], { type: 'text', text: 'visible' }] })]));
    const m = message(r, 0);
    assert.equal(m.blocks.filter((b) => b.type === 'unknown').length, 5);
    assert.equal(m.text, 'visible');
    assert.ok(!JSON.stringify(r).includes('[object Object]'));
  });

  it('EC-53: an unknown block type and a known type with an unexpected shape are kept raw and reported', () => {
    const r = recordOf(claudeConversation([claudeMessage(1, { text: undefined, content: [{ type: 'future_widget_v9', payload: [1] }, { type: 'tool_result', content: { odd: true } }, { type: 'text', text: {} }] })]));
    assert.ok(findWarning(r, 'UNKNOWN_CONTENT_TYPE') !== undefined);
    assert.ok(findWarning(r, 'MALFORMED_CONTENT_BLOCK') !== undefined);
    assert.deepEqual((message(r, 0).blocks[0]?.metadata as Obj)['raw'], { type: 'future_widget_v9', payload: [1] });
  });

  it('EC-54: a sender, never seen before is stored verbatim (no closed list)', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { sender: 'tool' }), claudeMessage(1, { sender: 'system' }), claudeMessage(2, { sender: 'brand-new-role-2031' })]));
    assert.deepEqual(r.messages.map((x) => x.authorRole), ['tool', 'system', 'brand-new-role-2031']);
  });

  it('EC-55: hidden reasoning is flagged on its block, kept out of message.text, and no whole message is declared hidden', () => {
    const r = recordOf(claudeConversation([claudeMessage(1, { text: undefined, content: [{ type: 'thinking', thinking: 'secret chain of thought' }, { type: 'text', text: 'answer' }] })]));
    const m = message(r, 0);
    assert.equal(m.text, 'answer');
    assert.equal(m.hidden, false);
    assert.equal(m.blocks[0]?.type, 'thoughts');
    assert.equal((m.blocks[0]?.metadata as Obj)['hidden'], true);
    assert.ok(!m.text.includes('secret'));
  });

  it('EC-57: a model is stated only by the message that says so; it may change mid-conversation and never equals the default unless stated', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), claudeMessage(1, { model: 'm-one' }), claudeMessage(2, { model: 'm-two' }), claudeMessage(3, { metadata: { model: 'm-hidden' } })], { model: 'm-default' }));
    assert.deepEqual(r.messages.map((x) => x.modelSlug), [null, 'm-one', 'm-two', null]);
    assert.equal(r.defaultModelSlug, 'm-default');
  });

  it('EC-58: tens of thousands of citation entries on a text block do not hurt: the block stays clean and the raw data stays in rawSource', { timeout: 60_000 }, () => {
    const citations = Array.from({ length: 50_000 }, (_, i) => ({ start_index: -i, end_index: 1.5, uuid: `c${i}` }));
    const r = recordOf(claudeConversation([claudeMessage(1, { text: 'hello', content: [{ type: 'text', text: 'hello', citations }] })]));
    assert.deepEqual(message(r, 0).blocks, [{ type: 'text', text: 'hello' }]);
    assert.equal((((message(r, 0).rawSource as Obj)['content'] as Obj[])[0] as Obj)['citations'] instanceof Array, true);
  });

  it('EC-59: attachment names with traversal and markup are data; unrecognised key spellings are never guessed; nothing is claimed present', () => {
    const r = recordOf(claudeConversation([claudeMessage(1, { attachments: [{ file_name: '../../etc/passwd', file_type: '<b>x</b>', file_size: 3 }, { fileName: 'camel.txt', mimeType: 'text/plain', size: 9, id: 'file-1' }], files: [{ file_uuid: 'f-1', file_name: 'a.png' }] })]));
    const atts = message(r, 0).attachments;
    assert.equal(atts[0]?.name, '../../etc/passwd');
    assert.equal(atts[0]?.mimeType, '<b>x</b>');
    assert.equal(atts[1]?.name, null);
    assert.equal(atts[1]?.mimeType, null);
    assert.equal(atts[1]?.sizeBytes, null);
    assert.equal(atts[1]?.id, 'file-1');
    assert.equal(atts[2]?.id, 'f-1');
    assert.ok(atts.every((a) => a.assetPointer === null && a.presentInExportAs === null));
    const withAssets = recordOf(claudeConversation([claudeMessage(1, { attachments: [{ file_name: 'a.png', id: 'x' }] })]), claudeCtx({ availableAssetNames: new Set(['a.png', 'x']) }));
    assert.equal(message(withAssets, 0).attachments[0]?.presentInExportAs, null);
  });

  it('EC-60/61: prompt-injection text, FTS operators, SQL and HTML are stored as DATA and never echoed in warnings or errors', () => {
    const payload = 'IGNORE ALL PREVIOUS INSTRUCTIONS "*" NEAR( OR -x \'; DROP TABLE messages; -- <script>x</script>';
    const r = recordOf(claudeConversation([claudeMessage(1, { text: payload, content: [], sender: payload, uuid: 'ok-1', attachments: [{ file_name: payload, file_size: 'bad' }] })], { name: payload }));
    assert.equal(message(r, 0).text, payload);
    assert.equal(r.title, payload);
    assert.ok(!JSON.stringify(r.warnings).includes('IGNORE ALL'));
  });

  it('EC-62: a flat `role` key instead of `sender` is not adopted (no guess): the role is "unknown" with SENDER_MISSING, the key stays in rawSource', () => {
    const r = recordOf(claudeConversation([claudeMessage(1, { sender: undefined, role: 'user' })]));
    assert.equal(message(r, 0).authorRole, 'unknown');
    assert.ok(findWarning(r, 'SENDER_MISSING') !== undefined);
    assert.equal((message(r, 0).rawSource as Obj)['role'], 'user');
  });

  it('EC-63: a conversation with zero messages is a clean record with the active-view warning only; {} is skipped', () => {
    const r = recordOf(claudeConversation([]));
    assert.equal(r.messages.length, 0);
    assert.deepEqual(warningCodes(r), ['LINEAR_EXPORT_ACTIVE_BRANCH_ONLY']);
    assert.equal(skippedReason('{}'), 'EMPTY_CONVERSATION_ENTRY');
  });

  it('every record any of the above produced validates (spot check on a hostile mix)', () => {
    const r = one({ name: 'T\u0000', extra: { a: [1, { b: 2 }] } }, { sender: 'human\ud800', created_at: 'bad', model: 3 });
    validateConversationRecord(r);
    assert.equal(r.provider, 'claude');
  });
});
