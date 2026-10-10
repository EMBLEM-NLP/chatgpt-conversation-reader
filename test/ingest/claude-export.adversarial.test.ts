/**
 * Independent adversarial review of ClaudeExportAdapter (lens: provider confusion and fabrication, hostile fields,
 * unbounded time/memory). Every test here was written to FAIL against the first version of the module that the
 * review found defective, then the module was fixed minimally. Data is synthetic only.
 *
 * Defects pinned by this file (see the report of the review):
 *   - duplicate message uuids were disambiguated in quadratic time (CPU denial of service)
 *   - the number of content blocks / attachments per CONVERSATION was unbounded (memory amplification ~36x)
 *   - text blocks joined into message.text were not capped, so the record failed validation
 *   - ids containing unpaired surrogates were "repaired" lossily, merging distinct ids
 *   - a ChatGPT `mapping` next to `chat_messages` was silently ignored
 *   - `-0` leaked through as an attachment size
 * plus the edge cases of research section 11 (EC-24, EC-25, EC-35, EC-39, EC-48) that had no test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { analyzeTree } from '../../src/domain/branches.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { MAX_TEXT_BYTES, validateConversationRecord } from '../../src/domain/validate.js';
import { GcrError } from '../../src/errors.js';
import { CLAUDE_ROOT_SENTINEL, MAX_BLOCKS_PER_MESSAGE, MAX_ITEMS_PER_CONVERSATION } from '../../src/ingest/claude-export.js';
import {
  claudeAdapter,
  claudeConversation,
  claudeCtx,
  claudeMessage,
  claudeTimestamp,
  elementText,
  findWarning,
  message,
  recordOf,
  runElement,
  synthUuid,
  warningCodes,
} from '../helpers/claude-export-builder.js';

type Obj = Record<string, unknown>;

const SEED = 20261015;

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 200): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

function errorOf(fn: () => unknown): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    return e;
  }
  return assert.fail('expected an error, nothing was thrown');
}

/** Wall-clock bound for work that must be (near) linear. Generous: the fixed code needs well under a second. */
const LINEAR_TIME_BUDGET_MS = 10_000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

// ------------------------------------------------------------------------------------------------------------------
// D1: duplicate message uuids must not cost quadratic time
// ------------------------------------------------------------------------------------------------------------------

describe('duplicate message uuids are disambiguated in linear time', () => {
  it('30 000 messages that all share ONE uuid finish quickly and keep the deterministic ~dupN scheme', { timeout: 120_000 }, () => {
    const N = 30_000;
    const messages: Obj[] = [];
    for (let n = 0; n < N; n++) messages.push({ uuid: 'same', sender: 'human', text: 't' });
    const text = elementText(claudeConversation(messages));
    const { value: out, ms } = timed(() => claudeAdapter.normalizeElementText(text, claudeCtx(), 0));
    assert.ok(ms < LINEAR_TIME_BUDGET_MS, `took ${Math.round(ms)} ms (quadratic duplicate handling)`);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const ids = out.record.messages.map((m) => m.id);
    assert.equal(new Set(ids).size, N, 'every message keeps a unique id');
    assert.equal(ids[0], 'same');
    assert.equal(ids[1], 'same~dup2');
    assert.equal(ids[2], 'same~dup3');
    assert.equal(ids[N - 1], `same~dup${N}`);
    assert.equal(findWarning(out.record, 'DUPLICATE_MESSAGE_ID')?.ids?.length, 1, 'the warning names the original id once');
    validateConversationRecord(out.record);
  });

  it('distinct 512-character ids that collide after the suffix is appended (truncation) also stay linear and unique', { timeout: 120_000 }, () => {
    // Every id is 512 units long and they differ only in their last 5 units. "<id>~dup2" must be shortened to stay within
    // 512 units, which makes the candidates of ALL these ids collide: the naive "try ~dup2, ~dup3, ..." loop is quadratic.
    const prefix = 'p'.repeat(507);
    const K = 8_000;
    const messages: Obj[] = [];
    for (let i = 0; i < K; i++) {
      const uuid = prefix + String(i).padStart(5, '0');
      messages.push({ uuid, sender: 'human', text: 'a' }, { uuid, sender: 'human', text: 'b' });
    }
    const text = elementText(claudeConversation(messages));
    const { value: out, ms } = timed(() => claudeAdapter.normalizeElementText(text, claudeCtx(), 0));
    assert.ok(ms < LINEAR_TIME_BUDGET_MS, `took ${Math.round(ms)} ms (quadratic truncation-collision handling)`);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const ids = out.record.messages.map((m) => m.id);
    assert.equal(ids.length, 2 * K);
    assert.equal(new Set(ids).size, 2 * K);
    assert.ok(ids.every((id) => id.length <= 512));
    validateConversationRecord(out.record);
  });

  it('stays deterministic: the same duplicates give the same ids on every run, and a real "x~dup2" is never overwritten', () => {
    const msgs = [{ uuid: 'x' }, { uuid: 'x~dup3' }, { uuid: 'x' }, { uuid: 'x' }, { uuid: 'x~dup2' }].map((o, i) => claudeMessage(i, o));
    const a = recordOf(claudeConversation(msgs));
    const b = recordOf(claudeConversation(msgs));
    assert.deepEqual(a.messages.map((m) => m.id), b.messages.map((m) => m.id));
    // 'x' -> x ; 'x~dup3' real -> x~dup3 ; 2nd 'x' -> x~dup2 ; 3rd 'x' skips the taken x~dup3 -> x~dup4 ; real 'x~dup2' collides -> x~dup2~dup2
    assert.deepEqual(a.messages.map((m) => m.id), ['x', 'x~dup3', 'x~dup2', 'x~dup4', 'x~dup2~dup2']);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// D2: bounded content per conversation
// ------------------------------------------------------------------------------------------------------------------

describe('content blocks and attachments are bounded per CONVERSATION, not only per message', () => {
  const BUDGET = MAX_ITEMS_PER_CONVERSATION;
  const BLOCKS_PER_MESSAGE = MAX_BLOCKS_PER_MESSAGE;

  it('the budget is documented at 2 000 000 items and is a whole number of full messages (the tests below rely on that)', () => {
    assert.equal(BUDGET, 2_000_000);
    assert.equal(BLOCKS_PER_MESSAGE, 50_000);
    assert.equal(BUDGET % BLOCKS_PER_MESSAGE, 0);
  });

  it('a conversation asking for more than the budget keeps exactly the budget, truncates the rest with BLOCKS_TRUNCATED, and still validates', { timeout: 120_000 }, () => {
    // 41 messages x 50 000 one-byte-ish blocks = 2 050 000 > 2 000 000. Without a conversation budget a 256 MiB element
    // would ask for ~9 GB of block objects (measured amplification ~36x); with it the output is bounded.
    const content = new Array<unknown>(BLOCKS_PER_MESSAGE).fill(1);
    const messages: Obj[] = [];
    for (let i = 0; i < 41; i++) messages.push({ uuid: `m${i}`, sender: 'assistant', content });
    const r = recordOf(claudeConversation(messages));
    const total = r.messages.reduce((n, m) => n + m.blocks.length, 0);
    assert.equal(total, BUDGET, 'exactly the budget is converted');
    const last = message(r, 40);
    assert.equal(last.blocks.length, 0, 'the message after the budget has no normalized blocks');
    assert.equal((last.rawSource as Obj)['content'] instanceof Array, true);
    assert.equal(((last.rawSource as Obj)['content'] as unknown[]).length, BLOCKS_PER_MESSAGE, 'the full content stays in rawSource');
    const w = findWarning(r, 'BLOCKS_TRUNCATED');
    assert.ok(w !== undefined, 'the truncation is reported');
    assert.deepEqual(w.ids, ['m40']);
  });

  it('attachments draw on the same budget (refs and extracted-content blocks), and the cut is reported', { timeout: 120_000 }, () => {
    const content = new Array<unknown>(BLOCKS_PER_MESSAGE).fill(1);
    const messages: Obj[] = [];
    for (let i = 0; i < 40; i++) messages.push({ uuid: `m${i}`, sender: 'assistant', content });
    messages.push({ uuid: 'att', sender: 'human', attachments: [{ file_name: 'a.txt', extracted_content: 'x' }, { file_name: 'b.txt' }] });
    const r = recordOf(claudeConversation(messages));
    const last = message(r, 40);
    assert.equal(last.attachments.length, 0);
    assert.equal(last.blocks.length, 0);
    assert.deepEqual(findWarning(r, 'ATTACHMENTS_TRUNCATED')?.ids, ['att']);
  });

  it('ordinary conversations are untouched by the budget', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { attachments: [{ file_name: 'a.txt', extracted_content: 'body' }] }), claudeMessage(1)]));
    assert.equal(findWarning(r, 'BLOCKS_TRUNCATED'), undefined);
    assert.equal(findWarning(r, 'ATTACHMENTS_TRUNCATED'), undefined);
    assert.equal(message(r, 0).attachments.length, 1);
    assert.equal(message(r, 0).blocks.filter((b) => b.type === 'attachment_text').length, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// D3: message.text is capped even when it is composed from several text blocks
// ------------------------------------------------------------------------------------------------------------------

describe('message.text composed from text blocks respects the domain size limit', () => {
  it('two 33 MiB text blocks (66 MiB joined) are truncated with the marker and the record validates', { timeout: 120_000 }, () => {
    const half = 'a'.repeat(33 * 1024 * 1024);
    const el = claudeConversation([{ uuid: 'big', sender: 'assistant', content: [{ type: 'text', text: half }, { type: 'text', text: half }] }]);
    const r = recordOf(el); // recordOf runs validateConversationRecord: it threw text_too_large before the fix
    const m = message(r, 0);
    assert.ok(Buffer.byteLength(m.text, 'utf8') <= MAX_TEXT_BYTES);
    assert.ok(m.text.endsWith('[GCR: text truncated at the size limit]'));
    assert.deepEqual(findWarning(r, 'TEXT_TRUNCATED')?.ids, ['big']);
    assert.equal(m.blocks.length, 2, 'the individual blocks are kept');
  });

  it('a text just under the limit is not touched', () => {
    const r = recordOf(claudeConversation([{ uuid: 'ok', sender: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }]));
    assert.equal(message(r, 0).text, 'one\n\ntwo');
    assert.equal(findWarning(r, 'TEXT_TRUNCATED'), undefined);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// D7: ids with unpaired surrogates are unusable (never merged), exactly like the ChatGPT adapter
// ------------------------------------------------------------------------------------------------------------------

describe('ids containing unpaired surrogates cannot be merged by lossy repair', () => {
  const convWithUuid = (escaped: string): string => `{"uuid":"id-${escaped}-x","chat_messages":[]}`;

  it('two conversations whose uuids differ only in a lone surrogate keep DISTINCT ids (hash-and-position fallback)', () => {
    const a = recordOf(convWithUuid('\\ud800'), claudeCtx(), 0);
    const b = recordOf(convWithUuid('\\ud801'), claudeCtx(), 0);
    assert.notEqual(a.id, b.id, 'a lossy U+FFFD repair would have made these the same conversation');
    assert.ok(a.id.startsWith('gcr-synth-'));
    assert.ok(findWarning(a, 'CONVERSATION_ID_INVALID') !== undefined);
    assert.equal((a.rawMetadata as Obj)['uuid'], 'id-\ud800-x', 'the raw value stays in rawMetadata');
  });

  it('two messages whose uuids differ only in a lone surrogate do not collapse into duplicates of each other', () => {
    const r = recordOf(`{"uuid":"${synthUuid(1)}","chat_messages":[{"uuid":"m-\\ud800","sender":"human","text":"a"},{"uuid":"m-\\ud801","sender":"human","text":"b"}]}`);
    assert.deepEqual(r.messages.map((m) => m.id), ['synthetic-msg-0', 'synthetic-msg-1']);
    assert.deepEqual(findWarning(r, 'MESSAGE_ID_INVALID')?.ids, ['synthetic-msg-0', 'synthetic-msg-1']);
    assert.equal(findWarning(r, 'DUPLICATE_MESSAGE_ID'), undefined);
  });

  it('a parent pointer with a lone surrogate is an unusable pointer (root + INVALID_PARENT_POINTER), never a lossy match', () => {
    const r = recordOf(`{"uuid":"${synthUuid(1)}","chat_messages":[{"uuid":"a","parent_message_uuid":null},{"uuid":"b","parent_message_uuid":"a\\ud800"}]}`);
    assert.equal(message(r, 1).parentId, null);
    assert.deepEqual(findWarning(r, 'INVALID_PARENT_POINTER')?.ids, ['b']);
  });

  it('an operator accountLabel with a lone surrogate is rejected up front instead of leaking into the record', () => {
    const e = errorOf(() => runElement(claudeConversation([]), claudeCtx({ accountLabel: 'acct-\ud800' })));
    assert.equal(e.code, 'INVALID_ARGUMENT');
    assert.equal(e.details?.['reason'], 'BAD_ACCOUNT_LABEL');
  });

  it('valid astral characters in ids are still fine', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { uuid: 'm-\u{1F600}' })], { uuid: 'conv-\u{1F600}' }));
    assert.equal(r.id, 'conv-\u{1F600}');
    assert.equal(message(r, 0).id, 'm-\u{1F600}');
  });
});

// ------------------------------------------------------------------------------------------------------------------
// D4: provider confusion at the adapter boundary
// ------------------------------------------------------------------------------------------------------------------

describe('an element carrying BOTH provider markers is never silently labelled as a plain Claude export', () => {
  const mapping = { 'root-node': { id: 'root-node', message: null, parent: null, children: [] } };

  it('the registry calls it ambiguous, and the Claude adapter flags that it ignored a ChatGPT-style mapping', () => {
    const el = claudeConversation([claudeMessage(0)], { mapping });
    const r = recordOf(el);
    const w = findWarning(r, 'FOREIGN_PROVIDER_MARKER');
    assert.ok(w !== undefined);
    assert.deepEqual(w.ids, [r.id]);
    assert.ok(!w.message.includes('root-node'), 'warnings carry fixed text, never element content');
    assert.equal(r.messages.length, 1, 'only chat_messages are normalized');
    assert.deepEqual((r.rawMetadata as Obj)['mapping'], mapping, 'the foreign structure is kept in rawMetadata');
    assert.equal(r.provider, 'claude');
  });

  for (const [label, value] of [['null', null], ['a string', 'x'], ['an array', []], ['a number', 5]] as const) {
    it(`a "mapping" that is ${label} is not a ChatGPT marker (same rule as the registry) and raises no flag`, () => {
      const r = recordOf(claudeConversation([claudeMessage(0)], { mapping: value }));
      assert.equal(findWarning(r, 'FOREIGN_PROVIDER_MARKER'), undefined);
    });
  }

  it('a normal Claude element never gets the flag', () => {
    assert.equal(findWarning(recordOf(claudeConversation([claudeMessage(0)])), 'FOREIGN_PROVIDER_MARKER'), undefined);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Numbers (EC-25) and timestamps (EC-35)
// ------------------------------------------------------------------------------------------------------------------

describe('EC-25: hostile numbers never reach the record as non-canonical values', () => {
  const sizeOf = (literal: string): { size: number | null; codes: string[] } => {
    const text = `{"uuid":"${synthUuid(1)}","chat_messages":[{"uuid":"a","sender":"human","attachments":[{"file_name":"f","file_size":${literal}}]}]}`;
    const r = recordOf(text);
    return { size: message(r, 0).attachments[0]?.sizeBytes ?? null, codes: warningCodes(r) };
  };

  it('-0 becomes a plain 0', () => {
    const { size } = sizeOf('-0');
    assert.ok(Object.is(size, 0), `got ${Object.is(size, -0) ? '-0' : String(size)}`);
  });

  for (const literal of ['1e999', '-1e999', '9007199254740993', '1e308', '-1', '1.5', '0.1', '1e-9', '"12"', 'true', '[1]', '{"n":1}']) {
    it(`file_size ${literal} -> null + INVALID_ATTACHMENT_FIELD, nothing invented`, () => {
      const { size, codes } = sizeOf(literal);
      assert.equal(size, null);
      assert.ok(codes.includes('INVALID_ATTACHMENT_FIELD'));
    });
  }

  it('safe integers are kept exactly (0 and 2^53-1)', () => {
    assert.equal(sizeOf('0').size, 0);
    assert.equal(sizeOf('9007199254740991').size, 9007199254740991);
  });
});

describe('EC-35: timestamps are never guessed or repaired', () => {
  const at = (literal: string, key: 'created_at' | 'updated_at' = 'created_at'): { r: ConversationRecord; codes: string[] } => {
    const r = recordOf(`{"uuid":"${synthUuid(1)}","chat_messages":[{"uuid":"a","sender":"human","${key}":${literal}}]}`);
    return { r, codes: warningCodes(r) };
  };

  for (const literal of ['1700000000', '1700000000.5', '1700000000000', '1.7e12', '0', '-5', '1e20', '1e999', 'true', '[]', '{}', '"0"', '"yesterday"', '"1700000000"', '"2025-03-04"', '"2025-03-04T05:06:07"', '""']) {
    it(`created_at ${literal} -> null + INVALID_TIMESTAMP`, () => {
      const { r, codes } = at(literal);
      assert.equal(message(r, 0).createdAt, null);
      assert.ok(codes.includes('INVALID_TIMESTAMP'));
    });
  }

  it('an update before the creation is reported as given (no reordering, no repair, no warning)', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { created_at: claudeTimestamp(10), updated_at: claudeTimestamp(0) })]));
    assert.equal(message(r, 0).createdAt! > message(r, 0).updatedAt!, true);
    assert.equal(findWarning(r, 'INVALID_TIMESTAMP'), undefined);
  });

  it('timestamps outside 2015..2100 are null, not clamped', () => {
    for (const s of ['2014-12-31T23:59:59Z', '2100-01-01T00:00:01Z', '0001-01-01T00:00:00Z', '9999-12-31T23:59:59Z']) {
      assert.equal(message(at(JSON.stringify(s)).r, 0).createdAt, null, s);
    }
  });

  it('conversation timestamps follow the same rules and are never derived from the messages', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), claudeMessage(1)], { created_at: undefined, updated_at: undefined }));
    assert.equal(r.createdAt, null);
    assert.equal(r.updatedAt, null);
    assert.ok(message(r, 0).createdAt !== null, 'the messages keep their own times');
  });
});

// ------------------------------------------------------------------------------------------------------------------
// EC-24, EC-39, EC-48: ordering, identity scope, shape extremes
// ------------------------------------------------------------------------------------------------------------------

describe('EC-24: integer-like and prototype-like ids keep the file order', () => {
  it('message uuids "10", "9", "1", "__proto__", "constructor" stay in file order in a linear chain', () => {
    const ids = ['10', '9', '1', '__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const r = recordOf(claudeConversation(ids.map((uuid, i) => claudeMessage(i, { uuid }))));
    assert.deepEqual(r.messages.map((m) => m.id), ids);
    assert.deepEqual(r.messages.map((m) => m.parentId), [null, ...ids.slice(0, -1)]);
    assert.equal(r.currentNodeId, 'hasOwnProperty');
    assert.equal(({} as Obj)['polluted'], undefined);
  });

  it('with explicit pointers and identical timestamps the children order follows file order, not key order', () => {
    const ts = claudeTimestamp(1);
    const msgs = [
      { uuid: 'root', parent_message_uuid: CLAUDE_ROOT_SENTINEL, created_at: ts },
      { uuid: '10', parent_message_uuid: 'root', created_at: ts },
      { uuid: '9', parent_message_uuid: 'root', created_at: ts },
      { uuid: '1', parent_message_uuid: 'root', created_at: ts },
    ].map((o, i) => claudeMessage(i, o));
    const r = recordOf(claudeConversation(msgs));
    assert.deepEqual(message(r, 0).childIds, ['10', '9', '1']);
    assert.equal(r.currentNodeId, null, 'three leaves: nothing is guessed');
  });
});

describe('EC-39: message ids are scoped to their conversation', () => {
  it('two conversations may reuse every message uuid without sharing or corrupting anything', () => {
    const shared = [claudeMessage(0, { uuid: 'same-1' }), claudeMessage(1, { uuid: 'same-2' })];
    const a = recordOf(claudeConversation(shared, { uuid: synthUuid(10) }));
    const b = recordOf(claudeConversation(shared, { uuid: synthUuid(11) }));
    assert.notEqual(a.id, b.id);
    assert.deepEqual(a.messages.map((m) => m.id), b.messages.map((m) => m.id));
    assert.ok(a.messages.every((m) => m.conversationId === a.id));
    assert.ok(b.messages.every((m) => m.conversationId === b.id));
    assert.notStrictEqual(a.messages[0], b.messages[0]);
    assert.equal(analyzeTree(a.id, a.messages, a.currentNodeId).branches.length, 1);
  });

  it('the same conversation and message uuids under two ACCOUNT labels stay two independent records', () => {
    const el = claudeConversation([claudeMessage(0), claudeMessage(1)]);
    const a = recordOf(el, claudeCtx({ accountLabel: 'work' }));
    const b = recordOf(el, claudeCtx({ accountLabel: 'home' }));
    assert.equal(a.id, b.id);
    assert.notEqual(a.accountLabel, b.accountLabel);
    assert.notStrictEqual(a.messages, b.messages);
  });
});

describe('EC-48: very long chains and very wide fan-outs', () => {
  it('a 20 000-message linear chain is converted and analysed quickly with one branch and the last message as current node', { timeout: 120_000 }, () => {
    const N = 20_000;
    const messages: Obj[] = [];
    for (let n = 0; n < N; n++) messages.push(claudeMessage(n));
    const { value: r, ms } = timed(() => recordOf(claudeConversation(messages)));
    assert.ok(ms < LINEAR_TIME_BUDGET_MS, `took ${Math.round(ms)} ms`);
    const an = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.equal(an.branches.length, 1);
    assert.equal(an.branches[0]?.path.length, N);
    assert.equal(r.currentNodeId, message(r, N - 1).id);
  });

  it('10 000 children of one parent (explicit pointers): all kept in (createdAt, ordinal, id) order, no active branch invented', { timeout: 120_000 }, () => {
    const N = 10_000;
    const messages: Obj[] = [{ uuid: 'root', sender: 'human', text: 'r', created_at: claudeTimestamp(0), parent_message_uuid: CLAUDE_ROOT_SENTINEL }];
    for (let n = 1; n <= N; n++) {
      messages.push({ uuid: `c${String(n).padStart(5, '0')}`, sender: 'assistant', text: 'c', created_at: claudeTimestamp(1), parent_message_uuid: 'root' });
    }
    const { value: r, ms } = timed(() => recordOf(claudeConversation(messages)));
    assert.ok(ms < LINEAR_TIME_BUDGET_MS, `took ${Math.round(ms)} ms`);
    assert.equal(message(r, 0).childIds.length, N);
    assert.equal(message(r, 0).childIds[0], 'c00001');
    assert.equal(message(r, 0).childIds[N - 1], `c${String(N).padStart(5, '0')}`);
    assert.equal(r.currentNodeId, null);
    assert.ok(findWarning(r, 'ACTIVE_BRANCH_UNKNOWN') !== undefined);
    assert.equal(analyzeTree(r.id, r.messages, r.currentNodeId).branches.length, N);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Fabrication: nothing is stated that the source did not say
// ------------------------------------------------------------------------------------------------------------------

describe('nothing is fabricated', () => {
  it('a bare message states no role-independent metadata at all', () => {
    const r = recordOf(claudeConversation([{ uuid: 'only' }], { name: undefined, created_at: undefined, updated_at: undefined }));
    const m = message(r, 0);
    assert.equal(m.authorRole, 'unknown');
    assert.equal(m.modelSlug, null);
    assert.equal(m.createdAt, null);
    assert.equal(m.updatedAt, null);
    assert.equal(m.channel, null);
    assert.equal(m.recipient, null);
    assert.equal(m.status, null);
    assert.equal(m.contentType, null);
    assert.equal(m.authorName, null);
    assert.equal(m.hidden, false);
    assert.equal(m.text, '');
    assert.deepEqual(m.blocks, []);
    assert.deepEqual(m.attachments, []);
    assert.equal(r.title, null);
    assert.equal(r.sourceUri, null);
    assert.equal(r.defaultModelSlug, null);
  });

  it('sender "human" and sender "user" both become role "user" but the distinction survives in rawSource', () => {
    const r = recordOf(claudeConversation([{ uuid: 'h', sender: 'human' }, { uuid: 'u', sender: 'user' }, { uuid: 'a', sender: 'assistant' }]));
    assert.deepEqual(r.messages.map((m) => m.authorRole), ['user', 'user', 'assistant']);
    assert.deepEqual(r.messages.map((m) => (m.rawSource as Obj)['sender']), ['human', 'user', 'assistant']);
  });

  it('only a model stated by THAT message is used, never a neighbour, the conversation default, or the author', () => {
    const r = recordOf(claudeConversation([{ uuid: 'a', sender: 'assistant', model: 'm-a' }, { uuid: 'b', sender: 'assistant' }, { uuid: 'c', sender: 'human', model: 'm-c' }], { model: 'conv-default' }));
    assert.deepEqual(r.messages.map((m) => m.modelSlug), ['m-a', null, 'm-c']);
    assert.equal(r.defaultModelSlug, 'conv-default');
  });

  it('the active thread is claimed only for a single chain; any other shape yields null plus a warning', () => {
    const cases: Array<[string, Obj[], string | null]> = [
      ['single message', [{ uuid: 'a' }], 'a'],
      ['two roots', [{ uuid: 'a', parent_message_uuid: null }, { uuid: 'b', parent_message_uuid: null }], null],
      ['fork', [{ uuid: 'a', parent_message_uuid: null }, { uuid: 'b', parent_message_uuid: 'a' }, { uuid: 'c', parent_message_uuid: 'a' }], null],
      ['self parent', [{ uuid: 'a', parent_message_uuid: 'a' }], null],
      ['2-cycle', [{ uuid: 'a', parent_message_uuid: 'b' }, { uuid: 'b', parent_message_uuid: 'a' }], null],
      ['cycle with a tail', [{ uuid: 'a', parent_message_uuid: 'b' }, { uuid: 'b', parent_message_uuid: 'a' }, { uuid: 'c', parent_message_uuid: 'b' }], null],
      ['chain leaf-first', [{ uuid: 'c', parent_message_uuid: 'b' }, { uuid: 'b', parent_message_uuid: 'a' }, { uuid: 'a', parent_message_uuid: null }], 'c'],
      ['all roots via sentinel', [{ uuid: 'a', parent_message_uuid: CLAUDE_ROOT_SENTINEL }, { uuid: 'b', parent_message_uuid: CLAUDE_ROOT_SENTINEL }], null],
    ];
    for (const [label, msgs, expected] of cases) {
      const r = recordOf(claudeConversation(msgs));
      assert.equal(r.currentNodeId, expected, label);
      assert.equal(findWarning(r, 'ACTIVE_BRANCH_UNKNOWN') !== undefined, expected === null, label);
      assert.equal(r.completeness, 'rendered_active_view_only', label);
    }
  });

  it('property: any random pointer graph yields either null or the unique leaf of ONE chain that covers every message', () => {
    const pointer = fc.oneof(fc.constant(null), fc.constant(CLAUDE_ROOT_SENTINEL), fc.constantFrom('m0', 'm1', 'm2', 'm3', 'm4', 'm5'), fc.constant('missing'), fc.constant(undefined));
    runProperty(
      fc.property(fc.array(pointer, { minLength: 1, maxLength: 6 }), (pointers) => {
        const msgs = pointers.map((p, i) => (p === undefined ? { uuid: `m${i}` } : { uuid: `m${i}`, parent_message_uuid: p }));
        const r = recordOf(claudeConversation(msgs));
        if (r.currentNodeId === null) return;
        const byId = new Map(r.messages.map((m) => [m.id, m] as const));
        const cur = byId.get(r.currentNodeId);
        assert.ok(cur !== undefined);
        assert.deepEqual(cur.childIds, []);
        const seen = new Set<string>();
        for (let c: typeof cur | undefined = cur; c !== undefined && !seen.has(c.id); c = c.parentId === null ? undefined : byId.get(c.parentId)) seen.add(c.id);
        assert.equal(seen.size, r.messages.length, 'every message is on the path from the current node to the root');
      }),
    );
  });

  it('property: a permuted chain always resolves to its true leaf; the same chain plus one extra child never does', () => {
    runProperty(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7], { minLength: 2, maxLength: 8 }), fc.boolean(), (order, addSibling) => {
        // `order` is the file order of messages whose TRUE chain is m0 <- m1 <- ... (ids by rank)
        const ids = [...order].sort((a, b) => a - b);
        const msgs: Obj[] = order.map((rank) => {
          const pos = ids.indexOf(rank);
          return { uuid: `n${rank}`, parent_message_uuid: pos === 0 ? null : `n${ids[pos - 1]}` };
        });
        if (addSibling) msgs.push({ uuid: 'extra', parent_message_uuid: ids.length > 1 ? `n${ids[0]}` : null });
        const r = recordOf(claudeConversation(msgs));
        const leaf = `n${ids[ids.length - 1]}`;
        if (addSibling && ids.length > 1) assert.equal(r.currentNodeId, null);
        else if (!addSibling) assert.equal(r.currentNodeId, leaf);
      }),
    );
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Differential test: an independent re-implementation of the documented tree rules
// ------------------------------------------------------------------------------------------------------------------

describe('differential oracle for ids, parents and children', () => {
  interface Spec {
    uuid: string | undefined;
    parent: 'absent' | null | string | number;
    minute: number | null;
  }

  /** The documented rules of docs/ADAPTERS.md section 3.2 written from scratch (short ids only, so no truncation). */
  function oracle(specs: Spec[]): { ids: string[]; parents: Array<string | null>; children: string[][] } {
    const used = new Set<string>();
    const first = new Map<string, string>();
    const ids: string[] = [];
    specs.forEach((sp, i) => {
      const base = sp.uuid ?? `synthetic-msg-${i}`;
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}~dup${n}`;
      used.add(id);
      if (sp.uuid !== undefined && !first.has(sp.uuid)) first.set(sp.uuid, id);
      ids.push(id);
    });
    const explicit = specs.some((sp) => sp.parent !== 'absent');
    const parents = specs.map((sp, i) => {
      if (!explicit) return i === 0 ? null : (ids[i - 1] as string);
      if (sp.parent === 'absent' || sp.parent === null || typeof sp.parent === 'number' || sp.parent === '') return null;
      const resolved = first.get(sp.parent);
      if (resolved === undefined && sp.parent === CLAUDE_ROOT_SENTINEL) return null;
      return resolved ?? sp.parent;
    });
    const order = ids.map((_, i) => i);
    if (explicit) {
      order.sort((a, b) => {
        const ta = specs[a]!.minute;
        const tb = specs[b]!.minute;
        if (ta !== tb) return ta === null ? 1 : tb === null ? -1 : ta - tb;
        return a - b; // equal times: ordinal decides (ids are unique, so the id tie-break is never reached)
      });
    }
    const children = new Map<string, string[]>();
    const known = new Set(ids);
    for (const i of order) {
      const p = parents[i];
      if (p === null || p === undefined || !known.has(p)) continue;
      children.set(p, [...(children.get(p) ?? []), ids[i] as string]);
    }
    return { ids, parents, children: ids.map((id) => children.get(id) ?? []) };
  }

  const idPool = fc.constantFrom('a', 'b', 'c', 'd', 'a~dup2', 'b~dup2', 'e');
  const spec = fc.record({
    uuid: fc.option(idPool, { nil: undefined }),
    parent: fc.oneof(fc.constant('absent' as const), fc.constant(null), idPool, fc.constant(CLAUDE_ROOT_SENTINEL), fc.constant('ghost'), fc.constant(''), fc.constant(7)),
    minute: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  });

  it('ids, parentIds and childIds equal the oracle on random (duplicated, dangling, sentinel, invalid, mixed) pointer sets', () => {
    runProperty(
      fc.property(fc.array(spec, { minLength: 1, maxLength: 8 }), (specs) => {
        const msgs: Obj[] = specs.map((sp) => {
          const m: Obj = { sender: 'human' };
          if (sp.uuid !== undefined) m['uuid'] = sp.uuid;
          if (sp.parent !== 'absent') m['parent_message_uuid'] = sp.parent;
          if (sp.minute !== null) m['created_at'] = claudeTimestamp(sp.minute);
          return m;
        });
        const r = recordOf(claudeConversation(msgs));
        const expected = oracle(specs);
        assert.deepEqual(r.messages.map((m) => m.id), expected.ids);
        assert.deepEqual(r.messages.map((m) => m.parentId), expected.parents);
        assert.deepEqual(r.messages.map((m) => m.childIds), expected.children);
      }),
      500,
    );
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Hostile keys and shapes
// ------------------------------------------------------------------------------------------------------------------

describe('hostile keys and shapes do not pollute anything and never escape as a non-GcrError', () => {
  it('"__proto__", "constructor" and "prototype" keys at every level leave Object.prototype untouched', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const text =
      '{"uuid":"' + synthUuid(1) + '","__proto__":{"chat_messages":[],"polluted":1},"constructor":{"prototype":{"polluted":2}},' +
      '"chat_messages":[{"uuid":"a","sender":"human","text":"x","__proto__":{"polluted":3},"constructor":"c",' +
      '"content":[{"type":"text","text":"x","__proto__":{"polluted":4}},{"type":"tool_use","name":"n","id":"i","input":{"__proto__":{"polluted":5}}}],' +
      '"attachments":[{"file_name":"f","__proto__":{"polluted":6}}]}]}';
    const r = recordOf(text);
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
    for (let i = 1; i <= 6; i++) assert.equal(({} as Obj)['polluted'], undefined);
    assert.equal(r.messages.length, 1);
    assert.equal(Object.hasOwn(r.rawMetadata as Obj, '__proto__'), true, 'kept as an ordinary own key');
  });

  it('a huge number of tiny non-object attachment entries is cheap and warns once per kind', () => {
    const entries = new Array<unknown>(300_000).fill(null);
    const { value: r, ms } = timed(() => recordOf(claudeConversation([{ uuid: 'a', sender: 'human', attachments: entries, files: entries }])));
    assert.ok(ms < LINEAR_TIME_BUDGET_MS);
    assert.equal(message(r, 0).attachments.length, 0);
    assert.equal(r.warnings.filter((w) => w.code === 'INVALID_ATTACHMENT').length, 1);
  });

  it('deeply nested attachments and extracted_content objects are data: not recursed into, not echoed', () => {
    let nested: unknown = { leaf: 'LEAKMARKER' };
    for (let i = 0; i < 100; i++) nested = { n: nested };
    const r = recordOf(claudeConversation([{ uuid: 'a', sender: 'human', attachments: [{ file_name: 'f', id: nested, extracted_content: nested, file_size: nested }] }]));
    assert.equal(message(r, 0).attachments[0]?.id, null);
    assert.equal(message(r, 0).blocks.some((b) => b.type === 'attachment_text'), false);
    assert.ok(!JSON.stringify(r.warnings).includes('LEAKMARKER'));
  });

  it('property: arbitrary JSON in every optional field yields a valid record or a GcrError, deterministically', () => {
    const anyJson = fc.jsonValue({ maxDepth: 3 });
    runProperty(
      fc.property(
        fc.array(fc.record({ uuid: anyJson, sender: anyJson, text: anyJson, content: anyJson, attachments: anyJson, files: anyJson, created_at: anyJson, updated_at: anyJson, parent_message_uuid: anyJson, model: anyJson }, { requiredKeys: [] }), { maxLength: 6 }),
        fc.record({ uuid: anyJson, name: anyJson, created_at: anyJson, updated_at: anyJson, model: anyJson, mapping: anyJson }, { requiredKeys: [] }),
        (messages, head) => {
          const text = JSON.stringify({ ...head, chat_messages: messages });
          let first: ReturnType<typeof claudeAdapter.normalizeElementText>;
          try {
            first = claudeAdapter.normalizeElementText(text, claudeCtx(), 1);
          } catch (e) {
            assert.ok(e instanceof GcrError, `non-GcrError escaped: ${String(e)}`);
            assert.notEqual(e.details?.['reason'], 'UNEXPECTED_ADAPTER_FAILURE', 'the catch-all (adapter bug) must never be reached');
            return;
          }
          assert.deepEqual(claudeAdapter.normalizeElementText(text, claudeCtx(), 1), first, 'deterministic');
          if (first.kind === 'record') validateConversationRecord(first.record);
        },
      ),
      400,
    );
  });
});

describe('the adapter output never contradicts its own element', () => {
  it('every id in every warning exists in the record (no invented ids), for a hostile mixed element', () => {
    const msgs: Obj[] = [
      { uuid: 'a', sender: 5, created_at: 'x', model: 7, text: 5, content: 'no', attachments: 'no', files: [1] },
      { uuid: 'a', sender: 'human', parent_message_uuid: 'zzz' },
      { sender: 'assistant', parent_message_uuid: 7 },
    ];
    const r = recordOf(claudeConversation(msgs));
    const known = new Set<string>([r.id, ...r.messages.map((m) => m.id)]);
    for (const w of r.warnings) for (const id of w.ids ?? []) assert.ok(known.has(id), `${w.code} cites unknown id ${id}`);
  });

  it('a skipped element returns only fixed-text warnings', () => {
    for (const text of ['[]', '5', 'null', '{}', '{"uuid":"LEAKMARKER","mapping":{}}']) {
      const out = runElement(text);
      assert.equal(out.kind, 'skipped');
      if (out.kind === 'skipped') assert.ok(!JSON.stringify(out.warnings).includes('LEAKMARKER'));
    }
  });
});
