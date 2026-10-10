/**
 * Adapter registry: getAdapter / listAdapters, the detection matrix (no false positives, never throws, never guesses),
 * provider/identity isolation between the ChatGPT and Claude adapters, and property tests (fast-check, fixed seed).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import type { ConversationRecord } from '../../src/domain/types.js';
import { validateConversationRecord } from '../../src/domain/validate.js';
import { GcrError } from '../../src/errors.js';
import { ChatGPTExportAdapter } from '../../src/ingest/chatgpt-export.js';
import { ClaudeExportAdapter } from '../../src/ingest/claude-export.js';
import { ADAPTER_IDS, DEFAULT_MAX_DETECT_CHARS, detectAdapterFromElementText, getAdapter, listAdapters } from '../../src/ingest/registry.js';
import type { AdapterId } from '../../src/ingest/registry.js';
import { convo, msg } from '../helpers/records.js';
import {
  IO_CAPABLE_MODULES,
  claudeConversation,
  claudeCtx,
  claudeLinearConversation,
  claudeMessage,
  codeOf,
  elementText,
  moduleSpecifiers,
  synthUuid,
} from '../helpers/claude-export-builder.js';

const SEED = 20261013;

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 300): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

function gcrError(fn: () => unknown): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    return e;
  }
  return assert.fail('expected an error, nothing was thrown');
}

/** A minimal ChatGPT-shaped conversation element (invented data). */
function chatgptElement(conversationId: string, messageIds: [string, string]): string {
  const [m1, m2] = messageIds;
  const message = (id: string, role: string, text: string, t: number) => ({
    id,
    author: { role, name: null, metadata: {} },
    create_time: t,
    update_time: null,
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata: {},
    recipient: 'all',
    channel: null,
  });
  return JSON.stringify({
    id: conversationId,
    conversation_id: conversationId,
    title: 'GCR-SYNTHETIC-FIXTURE chatgpt twin',
    create_time: 1_741_064_767.123,
    update_time: 1_741_064_900.5,
    current_node: m2,
    mapping: {
      'root-node': { id: 'root-node', message: null, parent: null, children: [m1] },
      [m1]: { id: m1, message: message(m1, 'user', 'synthetic user turn', 1_741_064_767.5), parent: 'root-node', children: [m2] },
      [m2]: { id: m2, message: message(m2, 'assistant', 'synthetic assistant turn', 1_741_064_800.5), parent: m1, children: [] },
    },
  });
}

describe('getAdapter / listAdapters', () => {
  it('returns the ChatGPT and Claude export adapters with the right identity', () => {
    const c = getAdapter('chatgpt');
    const k = getAdapter('claude');
    assert.ok(c instanceof ChatGPTExportAdapter);
    assert.ok(k instanceof ClaudeExportAdapter);
    assert.equal(c.provider, 'chatgpt');
    assert.equal(c.provenance, 'official_chatgpt_export');
    assert.equal(k.provider, 'claude');
    assert.equal(k.provenance, 'official_claude_export');
    assert.notEqual(c, k);
  });

  it('is stable: repeated calls return the same stateless instance', () => {
    assert.equal(getAdapter('claude'), getAdapter('claude'));
    assert.equal(getAdapter('chatgpt'), getAdapter('chatgpt'));
  });

  it('answers the Mode D id with NOT_IMPLEMENTED and the Mode D remedy (no developer-API adapter is selectable)', () => {
    const e = gcrError(() => getAdapter('openai_api' as AdapterId));
    assert.equal(e.code, 'NOT_IMPLEMENTED');
    assert.match(e.remedy ?? '', /not ChatGPT consumer history/);
  });

  for (const bad of ['', 'ChatGPT', 'CLAUDE', 'claude ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'gpt', 'openai', 'chatgpt.com']) {
    it(`rejects the unknown adapter id ${JSON.stringify(bad)} with INVALID_ARGUMENT (no inherited lookups)`, () => {
      const e = gcrError(() => getAdapter(bad as AdapterId));
      assert.equal(e.code, 'INVALID_ARGUMENT');
      assert.deepEqual(e.details?.['allowed'], ['chatgpt', 'claude']);
    });
  }

  it('rejects non-string ids', () => {
    for (const bad of [null, undefined, 5, {}, ['claude']]) assert.equal(gcrError(() => getAdapter(bad as never)).code, 'INVALID_ARGUMENT');
  });

  it('listAdapters reports both export adapters in a fixed order and a fresh array each time', () => {
    const list = listAdapters();
    assert.deepEqual(list, [
      { id: 'chatgpt', name: 'chatgpt-export', provider: 'chatgpt', provenance: 'official_chatgpt_export' },
      { id: 'claude', name: 'claude-export', provider: 'claude', provenance: 'official_claude_export' },
    ]);
    list.pop();
    assert.equal(listAdapters().length, 2);
    assert.deepEqual([...ADAPTER_IDS], ['chatgpt', 'claude']);
    assert.ok(Object.isFrozen(ADAPTER_IDS));
  });

  it('every listed id round-trips through getAdapter with matching provider and provenance', () => {
    for (const info of listAdapters()) {
      const a = getAdapter(info.id);
      assert.equal(a.provider, info.provider);
      assert.equal(a.provenance, info.provenance);
      assert.equal(a.name, info.name);
    }
  });
});

describe('detectAdapterFromElementText: the matrix', () => {
  const chatgptEl = chatgptElement(synthUuid(1), ['m1', 'm2']);
  const claudeEl = elementText(claudeLinearConversation(2));

  const cases: Array<[string, string, AdapterId | null, RegExp]> = [
    ['a ChatGPT element (object "mapping")', chatgptEl, 'chatgpt', /mapping/],
    ['a Claude element (array "chat_messages")', claudeEl, 'claude', /chat_messages/],
    ['a bare ChatGPT marker', '{"mapping":{}}', 'chatgpt', /mapping/],
    ['a bare Claude marker', '{"chat_messages":[]}', 'claude', /chat_messages/],
    ['pretty-printed with whitespace', '  {\n  "chat_messages" : [ ]\n}\n', 'claude', /chat_messages/],
    ['a UTF-8 BOM before the object', '\uFEFF{"mapping":{}}', 'chatgpt', /mapping/],
    ['an escaped key (JSON.parse decodes it exactly like the adapters do)', '{"\\u006dapping":{}}', 'chatgpt', /mapping/],
    ['a duplicated key (last wins, like the adapters)', '{"mapping":null,"mapping":{}}', 'chatgpt', /mapping/],
    ['BOTH keys: ambiguous, never guessed', '{"mapping":{},"chat_messages":[]}', null, /Ambiguous/],
    ['NEITHER key', '{"uuid":"x","name":"a project"}', null, /neither/],
    ['the empty object', '{}', null, /neither/],
    ['a wrapper object with a conversations array', '{"conversations":[{"mapping":{}}]}', null, /wrapper/],
    ['mapping is null', '{"mapping":null}', null, /not an object/],
    ['mapping is an array', '{"mapping":[]}', null, /not an object/],
    ['mapping is a string', '{"mapping":"x"}', null, /not an object/],
    ['mapping is a number', '{"mapping":5}', null, /not an object/],
    ['chat_messages is null', '{"chat_messages":null}', null, /not an array/],
    ['chat_messages is an object', '{"chat_messages":{}}', null, /not an array/],
    ['chat_messages is a string', '{"chat_messages":"x"}', null, /not an array/],
    ['mapping of the wrong type next to a valid chat_messages array: only the valid marker counts', '{"mapping":null,"chat_messages":[]}', 'claude', /chat_messages/],
    ['markers only nested one level down', '{"meta":{"mapping":{},"chat_messages":[]}}', null, /neither/],
    ['markers only inside an array value', '{"items":[{"mapping":{}},{"chat_messages":[]}]}', null, /neither/],
    ['marker words only inside string VALUES', '{"title":"\\"mapping\\": {}","text":"chat_messages: []"}', null, /neither/],
    ['marker key spelled differently', '{"Mapping":{},"chatMessages":[],"chat_message":[]}', null, /neither/],
    ['a prototype-looking own key does not count as an inherited marker', '{"__proto__":{"mapping":{},"chat_messages":[]}}', null, /neither/],
    ['an array containing a ChatGPT element', `[${chatgptEl}]`, null, /array/],
    ['an array containing a Claude element', `[${claudeEl}]`, null, /array/],
    ['the empty array', '[]', null, /array/],
    ['null', 'null', null, /not a JSON object/],
    ['a number', '5', null, /not a JSON object/],
    ['a string that mentions the marker', '"mapping"', null, /not a JSON object/],
    ['a boolean', 'true', null, /not a JSON object/],
    ['the empty string', '', null, /not valid JSON/],
    ['whitespace only', '   \n', null, /not valid JSON/],
    ['truncated JSON', '{"mapping":{', null, /not valid JSON/],
    ['not JSON at all', 'mapping chat_messages', null, /not valid JSON/],
    ['two concatenated documents', '{"mapping":{}}{"chat_messages":[]}', null, /not valid JSON/],
    ['NaN (not JSON)', '{"mapping":NaN}', null, /not valid JSON/],
    ['single quotes (not JSON)', "{'mapping':{}}", null, /not valid JSON/],
  ];

  for (const [label, text, expected, reason] of cases) {
    it(`${label} -> ${expected ?? 'null'}`, () => {
      const r = detectAdapterFromElementText(text);
      assert.equal(r.adapter, expected);
      assert.match(r.reason, reason);
      assert.deepEqual(Object.keys(r).sort(), ['adapter', 'reason']);
    });
  }

  it('does not mutate Object.prototype while parsing a "__proto__" key', () => {
    detectAdapterFromElementText('{"__proto__":{"mapping":{}}}');
    assert.equal(Object.hasOwn(Object.prototype, 'mapping'), false);
    assert.equal(({} as Record<string, unknown>)['mapping'], undefined);
  });

  it('never throws and never attributes for non-string input', () => {
    for (const bad of [undefined, null, 5, {}, [], Symbol('s'), () => 1, 10n]) {
      const r = detectAdapterFromElementText(bad as never);
      assert.equal(r.adapter, null);
      assert.ok(r.reason.length > 0);
    }
  });

  it('ignores a malformed options argument instead of throwing', () => {
    assert.equal(detectAdapterFromElementText('{"mapping":{}}', null as never).adapter, 'chatgpt');
    for (const maxChars of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5' as never]) {
      assert.equal(detectAdapterFromElementText('{"mapping":{}}', { maxChars }).adapter, 'chatgpt', String(maxChars));
    }
  });

  it('reasons are fixed text: the element content never appears in them', () => {
    for (const text of ['{"LEAKMARKER-1":', 'LEAKMARKER-2', '{"LEAKMARKER-3":{"mapping":null}}', '["LEAKMARKER-4"]', '{"mapping":{},"chat_messages":[],"LEAKMARKER-5":1}']) {
      assert.ok(!JSON.stringify(detectAdapterFromElementText(text)).includes('LEAKMARKER'), text);
    }
  });

  describe('huge elements', () => {
    it('an element over the explicit limit is "unknown" without being parsed (even if it would match)', () => {
      const text = '{"mapping":{}}';
      assert.equal(detectAdapterFromElementText(text, { maxChars: text.length }).adapter, 'chatgpt', 'exactly at the limit is accepted');
      const r = detectAdapterFromElementText(text, { maxChars: text.length - 1 });
      assert.equal(r.adapter, null);
      assert.match(r.reason, /sniffing limit/);
    });

    it('the default limit is 64 MiB: a 64 MiB + 1 element is not parsed, a 1 MiB conversation still is', () => {
      assert.equal(DEFAULT_MAX_DETECT_CHARS, 64 * 1024 * 1024);
      const huge = `{"mapping":{},"pad":"${'x'.repeat(DEFAULT_MAX_DETECT_CHARS)}"}`;
      const t0 = Date.now();
      assert.equal(detectAdapterFromElementText(huge).adapter, null);
      assert.ok(Date.now() - t0 < 500, 'rejected by length, not by parsing');
      const big = `{"chat_messages":[],"pad":"${'y'.repeat(1024 * 1024)}"}`;
      assert.equal(detectAdapterFromElementText(big).adapter, 'claude');
    });

    it('a deeply nested element is classified (or refused) without a stack overflow', () => {
      const deep = `{"mapping":{},"x":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;
      const r = detectAdapterFromElementText(deep);
      assert.ok(r.adapter === 'chatgpt' || r.adapter === null);
    });
  });

  describe('agreement with the adapters (no false positives in practice)', () => {
    it('the adapter a detection names accepts the element; the other adapter refuses it as NOT_A_CONVERSATION', () => {
      const chatCtx = { ...claudeCtx(), provider: 'chatgpt' as const };
      const claudeOnChatgpt = getAdapter('chatgpt').normalizeElementText(claudeEl, chatCtx, 0);
      assert.deepEqual([claudeOnChatgpt.kind, claudeOnChatgpt.kind === 'skipped' ? claudeOnChatgpt.reason : ''], ['skipped', 'NOT_A_CONVERSATION']);
      const chatgptOnClaude = getAdapter('claude').normalizeElementText(chatgptEl, claudeCtx(), 0);
      assert.deepEqual([chatgptOnClaude.kind, chatgptOnClaude.kind === 'skipped' ? chatgptOnClaude.reason : ''], ['skipped', 'NOT_A_CONVERSATION']);
      assert.equal(getAdapter('claude').normalizeElementText(claudeEl, claudeCtx(), 0).kind, 'record');
      assert.equal(getAdapter('chatgpt').normalizeElementText(chatgptEl, chatCtx, 0).kind, 'record');
    });

    it('detection result feeds getAdapter directly', () => {
      for (const [text, provider] of [
        [claudeEl, 'claude'],
        [chatgptEl, 'chatgpt'],
      ] as const) {
        const d = detectAdapterFromElementText(text);
        assert.ok(d.adapter !== null);
        assert.equal(getAdapter(d.adapter).provider, provider);
      }
    });
  });
});

describe('detectAdapterFromElementText: properties', () => {
  /** Independent oracle: parse with JSON.parse and apply the documented rule. */
  function oracle(text: string): AdapterId | null {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const gpt = Object.hasOwn(o, 'mapping') && typeof o['mapping'] === 'object' && o['mapping'] !== null && !Array.isArray(o['mapping']);
    const cl = Object.hasOwn(o, 'chat_messages') && Array.isArray(o['chat_messages']);
    return gpt === cl ? null : gpt ? 'chatgpt' : 'claude';
  }

  const markerValue = fc.oneof(fc.constant(null), fc.constant({}), fc.constant([]), fc.constant([1]), fc.string(), fc.integer(), fc.constant({ a: 1 }));
  const objectWithMaybeMarkers = fc
    .tuple(fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 4 }), fc.option(markerValue, { nil: undefined }), fc.option(markerValue, { nil: undefined }))
    .map(([base, mapping, chat]) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(base)) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
      if (mapping !== undefined) o['mapping'] = mapping;
      if (chat !== undefined) o['chat_messages'] = chat;
      return JSON.stringify(o);
    });

  it('matches an independent oracle on random objects with and without marker keys of every type', () => {
    runProperty(fc.property(objectWithMaybeMarkers, (text) => detectAdapterFromElementText(text).adapter === oracle(text)));
  });

  it('never attributes a provider to an object that lacks both top-level markers (no false positives)', () => {
    const noMarkers = fc.dictionary(fc.string({ maxLength: 10 }).filter((k) => k !== 'mapping' && k !== 'chat_messages'), fc.jsonValue({ maxDepth: 3 }), { maxKeys: 6 });
    runProperty(
      fc.property(noMarkers, (dict) => {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(dict)) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        return detectAdapterFromElementText(JSON.stringify(o)).adapter === null;
      }),
    );
  });

  it('never throws and returns a reason, for arbitrary strings (including lone surrogates and NUL)', () => {
    runProperty(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.json(), fc.constantFrom('\u0000', '\ud800', '{"mapping":{}', '[', '"')), (text) => {
        const r = detectAdapterFromElementText(text);
        return (r.adapter === null || r.adapter === 'chatgpt' || r.adapter === 'claude') && typeof r.reason === 'string' && r.reason.length > 0;
      }),
      500,
    );
  });

  it('is deterministic', () => {
    runProperty(fc.property(objectWithMaybeMarkers, (text) => JSON.stringify(detectAdapterFromElementText(text)) === JSON.stringify(detectAdapterFromElementText(text))), 100);
  });
});

describe('provider isolation (FR-14: same uuid under two providers never collides)', () => {
  const SAME = synthUuid(42);

  it('domain level: identical ids under chatgpt and claude are distinct objects with distinct identity keys', () => {
    const gpt = convo(SAME, [msg({ id: 'm1', conversationId: SAME, text: 'chatgpt side' })], { provider: 'chatgpt' });
    const claude = convo(SAME, [msg({ id: 'm1', conversationId: SAME, text: 'claude side' })], { provider: 'claude', provenance: 'official_claude_export', completeness: 'rendered_active_view_only' });
    assert.notEqual(gpt, claude);
    assert.notEqual(gpt.messages, claude.messages);
    assert.equal(gpt.id, claude.id);
    assert.notEqual(gpt.provider, claude.provider);
    const key = (r: ConversationRecord): string => [r.provider, r.accountLabel, r.id].join('\u0000');
    assert.notEqual(key(gpt), key(claude));
    claude.messages[0]!.text = 'mutated';
    assert.equal(gpt.messages[0]?.text, 'chatgpt side', 'mutating one record cannot touch the other');
  });

  it('adapter level: one uuid (conversation AND message ids) through both real adapters stays two independent valid records', () => {
    const claude = getAdapter('claude').normalizeElementText(elementText(claudeConversation([claudeMessage(0, { uuid: 'shared-msg' })], { uuid: SAME })), claudeCtx(), 0);
    const gpt = getAdapter('chatgpt').normalizeElementText(chatgptElement(SAME, ['shared-msg', 'shared-msg-2']), { ...claudeCtx(), provider: 'chatgpt' }, 0);
    assert.equal(claude.kind, 'record');
    assert.equal(gpt.kind, 'record');
    if (claude.kind !== 'record' || gpt.kind !== 'record') return;
    const [c, g] = [validateConversationRecord(claude.record), validateConversationRecord(gpt.record)];
    assert.equal(c.id, SAME);
    assert.equal(g.id, SAME);
    assert.equal(c.messages[0]?.id, 'shared-msg');
    assert.ok(g.messages.some((m) => m.id === 'shared-msg'));
    assert.equal(c.provider, 'claude');
    assert.equal(g.provider, 'chatgpt');
    assert.equal(c.provenance, 'official_claude_export');
    assert.equal(g.provenance, 'official_chatgpt_export');
    assert.notEqual(c.completeness, g.completeness, 'Claude is active-view-only; the ChatGPT tree is exported');
    assert.notEqual(c, g);
    assert.ok(c.messages.every((m) => !g.messages.includes(m)), 'no shared message objects');
    assert.notEqual(c.rawMetadata, g.rawMetadata);
  });

  it('the Claude adapter cannot be made to emit another provider (provider is fixed by the adapter, ctx must agree)', () => {
    const out = getAdapter('claude').normalizeElementText(elementText(claudeLinearConversation(1)), claudeCtx(), 0);
    assert.equal(out.kind === 'record' ? out.record.provider : null, 'claude');
    assert.equal(gcrError(() => getAdapter('claude').normalizeElementText(elementText(claudeLinearConversation(1)), { ...claudeCtx(), provider: 'chatgpt' }, 0)).code, 'INVALID_ARGUMENT');
  });
});

describe('registry.ts has no network or I/O dependency (source-level)', () => {
  const ts = codeOf('src/ingest/registry.ts');

  it('imports only the errors module, domain types, and the three adapter modules', () => {
    assert.deepEqual(moduleSpecifiers(ts), ['../domain/types.js', '../errors.js', './adapter.js', './chatgpt-export.js', './claude-export.js', './openai-api.js']);
  });

  it('names no I/O-capable built-in and uses no fetch/process/eval', () => {
    for (const forbidden of IO_CAPABLE_MODULES) assert.ok(!moduleSpecifiers(ts).map((s) => s.replace(/^node:/, '')).includes(forbidden), forbidden);
    for (const pattern of [/\bfetch\b/, /\bprocess\b/, /\beval\b/, /\bDate\b/, /Math\.random/, /\bconsole\b/]) assert.ok(!pattern.test(ts), `${pattern}`);
  });
});
