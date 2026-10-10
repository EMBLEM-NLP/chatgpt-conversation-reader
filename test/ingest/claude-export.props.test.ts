/**
 * Property tests (fast-check, FIXED seed printed on failure) for ClaudeExportAdapter over random Claude message lists:
 * always a valid record, deterministic, never a non-GcrError throw, role/text/model/tree invariants.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { analyzeTree } from '../../src/domain/branches.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { validateConversationRecord } from '../../src/domain/validate.js';
import { GcrError } from '../../src/errors.js';
import type { AdapterOutcome } from '../../src/ingest/adapter.js';
import { CLAUDE_ROOT_SENTINEL, sanitizeString } from '../../src/ingest/claude-export.js';
import { claudeAdapter, claudeCtx } from '../helpers/claude-export-builder.js';

const SEED = 20261014;

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 250): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

type Obj = Record<string, unknown>;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---- generators --------------------------------------------------------------------------------------------------

const hostile = fc.constantFrom('', ' ', 'a', '\u0000', 'x\u0000y', '\ud800', 'a\udfffb', '\ud83d\u0000\ude00', '\u{1F600}', '<script>alert(1)</script>', '"', "'; DROP TABLE t; --", '..', '../x', '__proto__', 'constructor', 'toString', 'human', 'assistant', 'user', 'system', 'IGNORE ALL PREVIOUS INSTRUCTIONS', '\u202E', '\u2028', 'NEAR(a b)');
const anyString = fc.oneof(fc.string(), fc.string({ unit: 'binary' }), hostile);
const leaf = fc.oneof(fc.constant(null), fc.boolean(), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), anyString);
const jsonish = fc.jsonValue({ maxDepth: 3 });

const validTimestamp = fc
  .integer({ min: 1_420_070_400_000, max: 4_102_444_800_000 })
  .chain((ms) => fc.tuple(fc.constant(ms), fc.constantFrom('Z', '+00:00', '+02:00', '-05:30', '+0100')))
  .map(([ms, zone]) => {
    const iso = new Date(ms).toISOString();
    return zone === 'Z' ? iso.replace('Z', '789Z') : iso.slice(0, -1) + zone;
  });
const timestampish = fc.oneof(validTimestamp, validTimestamp, anyString, fc.integer(), fc.constant(null));

const textBlock = fc.record({ type: fc.constant('text'), text: anyString });
const blockArb: fc.Arbitrary<unknown> = fc.oneof(
  textBlock,
  fc.record({ type: fc.constant('thinking'), thinking: anyString.map((s) => `HIDDENREASONING-${s}`) }),
  fc.record({ type: fc.constant('tool_use'), id: anyString, name: anyString, input: jsonish }, { requiredKeys: ['type'] }),
  fc.record({ type: fc.constant('tool_result'), tool_use_id: anyString, name: anyString, content: fc.oneof(anyString, fc.array(fc.oneof(textBlock, jsonish), { maxLength: 4 }), jsonish), is_error: fc.oneof(fc.boolean(), leaf) }, { requiredKeys: ['type'] }),
  fc.record({ type: fc.constant('image'), source: jsonish }, { requiredKeys: ['type'] }),
  fc.record({ type: anyString, text: anyString, extra: jsonish }, { requiredKeys: [] }),
  jsonish,
);

const attachmentArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({ id: anyString, file_name: anyString, file_type: anyString, file_size: fc.oneof(fc.nat(), leaf), extracted_content: anyString }, { requiredKeys: [] }),
  jsonish,
);

const messageArb = fc.record(
  {
    uuid: fc.oneof(fc.uuid(), anyString, fc.integer(), fc.constant(null)),
    sender: fc.oneof(fc.constantFrom('human', 'assistant', 'human', 'assistant', 'system'), anyString, leaf),
    text: fc.oneof(anyString, leaf),
    content: fc.oneof(fc.array(blockArb, { maxLength: 6 }), jsonish),
    created_at: timestampish,
    updated_at: timestampish,
    attachments: fc.oneof(fc.array(attachmentArb, { maxLength: 4 }), jsonish),
    files: fc.oneof(fc.array(attachmentArb, { maxLength: 3 }), jsonish),
    model: fc.oneof(anyString, leaf),
    x_unknown: jsonish,
  },
  { requiredKeys: [] },
);

/** Messages are mostly objects, occasionally garbage (the adapter must skip those). */
const chatMessagesArb = fc.array(fc.oneof({ weight: 12, arbitrary: messageArb }, { weight: 1, arbitrary: leaf }), { maxLength: 8 });

const conversationArb = fc.record(
  {
    uuid: fc.oneof(fc.uuid(), anyString, fc.integer(), fc.constant(null)),
    name: fc.oneof(anyString, leaf),
    summary: anyString,
    created_at: timestampish,
    updated_at: timestampish,
    model: fc.oneof(anyString, leaf),
    account: jsonish,
    x_unknown: jsonish,
    chat_messages: chatMessagesArb,
  },
  { requiredKeys: ['chat_messages'] },
);

// ---- helpers ----------------------------------------------------------------------------------------------------

function recordFor(text: string): ConversationRecord {
  const out = claudeAdapter.normalizeElementText(text, claudeCtx(), 0);
  assert.equal(out.kind, 'record');
  if (out.kind !== 'record') throw new Error('unreachable');
  return validateConversationRecord(out.record);
}

function isRecord(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validatedStrings(r: ConversationRecord): string[] {
  const out: string[] = [r.id, ...(r.title === null ? [] : [r.title]), ...(r.defaultModelSlug === null ? [] : [r.defaultModelSlug])];
  for (const w of r.warnings) out.push(w.code, w.message, ...(w.ids ?? []));
  for (const m of r.messages) {
    out.push(m.id, m.authorRole, m.text, ...m.childIds, ...(m.parentId === null ? [] : [m.parentId]), ...(m.modelSlug === null ? [] : [m.modelSlug]));
    for (const b of m.blocks) out.push(b.type, ...(b.text === undefined ? [] : [b.text]));
    for (const a of m.attachments) out.push(...[a.id, a.name, a.mimeType].filter((x): x is string => x !== null));
  }
  return out;
}

/** Attach explicit parent pointers chosen by `picks` (kind, index): null / another message / sentinel / garbage / absent. */
function withPointers(conv: Obj, picks: ReadonlyArray<readonly [number, number]>): Obj {
  const messages = (conv['chat_messages'] as unknown[]).map((m) => (isRecord(m) ? { ...m } : m));
  const objects = messages.filter(isRecord);
  objects.forEach((m, i) => {
    const [kind, index] = picks[i % Math.max(1, picks.length)] ?? [4, 0];
    const target = objects[index % Math.max(1, objects.length)];
    if (kind === 0) m['parent_message_uuid'] = null;
    else if (kind === 1) m['parent_message_uuid'] = target?.['uuid'] ?? null;
    else if (kind === 2) m['parent_message_uuid'] = CLAUDE_ROOT_SENTINEL;
    else if (kind === 3) m['parent_message_uuid'] = ['garbage', 7, {}, '', 'x\u0000y'][index % 5];
    // kind 4: leave the key absent
  });
  return { ...conv, chat_messages: messages };
}

// ---- properties -------------------------------------------------------------------------------------------------

describe('ClaudeExportAdapter properties (random Claude message lists)', () => {
  it('always yields a record that passes validateConversationRecord, with no adapter-bug fallback and no non-GcrError throw', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        const text = JSON.stringify(conv);
        let out: AdapterOutcome;
        try {
          out = claudeAdapter.normalizeElementText(text, claudeCtx(), 0);
        } catch (e) {
          // Allowed only as a GcrError, and for a well-formed conversation object not even that should happen.
          assert.ok(e instanceof GcrError, `non-GcrError thrown: ${String(e)}`);
          return assert.fail(`unexpected GcrError ${e.code} ${JSON.stringify(e.details)}`);
        }
        assert.equal(out.kind, 'record');
        if (out.kind === 'record') {
          validateConversationRecord(out.record);
          assert.equal(out.record.provider, 'claude');
          assert.equal(out.record.completeness, 'rendered_active_view_only');
          assert.equal(out.record.provenance, 'official_claude_export');
        }
      }),
    );
  });

  it('is deterministic: two runs give deeply equal outcomes', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        const text = JSON.stringify(conv);
        assert.deepStrictEqual(claudeAdapter.normalizeElementText(text, claudeCtx(), 3), claudeAdapter.normalizeElementText(text, claudeCtx(), 3));
      }),
    );
  });

  it('every string the schema validates is NUL-free and well-formed UTF-16', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        for (const s of validatedStrings(recordFor(JSON.stringify(conv)))) {
          assert.ok(!s.includes('\u0000'));
          assert.ok(!LONE_SURROGATE.test(s));
        }
      }),
    );
  });

  it('keeps exactly the object entries of chat_messages, in order, with their source position as ordinal', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        const source = (JSON.parse(JSON.stringify(conv)) as Obj)['chat_messages'] as unknown[];
        const expectedOrdinals = source.flatMap((m, i) => (isRecord(m) ? [i] : []));
        const r = recordFor(JSON.stringify(conv));
        assert.deepEqual(r.messages.map((m) => m.ordinal), expectedOrdinals);
        // rawSource is the source message as parsed, untouched.
        const reparsed = JSON.parse(JSON.stringify(conv)) as Obj;
        r.messages.forEach((m) => assert.deepEqual(m.rawSource, (reparsed['chat_messages'] as unknown[])[m.ordinal]));
      }),
    );
  });

  it('only the exact sender "human" is renamed (to "user"); other usable senders are kept after sanitizing; unusable ones are "unknown"', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        const source = (JSON.parse(JSON.stringify(conv)) as Obj)['chat_messages'] as unknown[];
        for (const m of recordFor(JSON.stringify(conv)).messages) {
          const sender = (source[m.ordinal] as Obj)['sender'];
          if (sender === 'human') assert.equal(m.authorRole, 'user');
          else if (typeof sender === 'string' && sanitizeString(sender).value !== '') {
            const cleaned = sanitizeString(sender).value;
            if (cleaned.length <= 512) assert.equal(m.authorRole, cleaned);
            else assert.equal(m.authorRole.length, 512);
          } else assert.equal(m.authorRole, 'unknown');
        }
      }),
    );
  });

  it('a model is attributed only when THAT message states a non-empty string model', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        const source = (JSON.parse(JSON.stringify(conv)) as Obj)['chat_messages'] as unknown[];
        for (const m of recordFor(JSON.stringify(conv)).messages) {
          const stated = (source[m.ordinal] as Obj)['model'];
          if (typeof stated !== 'string' || sanitizeString(stated).value === '') assert.equal(m.modelSlug, null);
          else assert.notEqual(m.modelSlug, null);
        }
      }),
    );
  });

  it('the top-level text, when usable, is message.text; thinking never reaches message.text', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        const source = (JSON.parse(JSON.stringify(conv)) as Obj)['chat_messages'] as unknown[];
        for (const m of recordFor(JSON.stringify(conv)).messages) {
          const src = source[m.ordinal] as Obj;
          const top = typeof src['text'] === 'string' ? sanitizeString(src['text']).value : '';
          if (top !== '' && top.length < 100_000) assert.equal(m.text, top);
          assert.ok(!m.text.includes('HIDDENREASONING-'), 'reasoning leaked into message.text');
          for (const b of m.blocks) if (b.type === 'thoughts') assert.equal((b.metadata as Obj)['hidden'], true);
        }
      }),
    );
  });

  it('linear input (no parent pointers): a perfect chain, childIds consistent, currentNodeId = last message, one clean branch', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        const r = recordFor(JSON.stringify(conv));
        const n = r.messages.length;
        r.messages.forEach((m, i) => {
          assert.equal(m.parentId, i === 0 ? null : r.messages[i - 1]?.id ?? null);
          assert.deepEqual(m.childIds, i === n - 1 ? [] : [r.messages[i + 1]?.id]);
        });
        assert.equal(r.currentNodeId, n === 0 ? null : r.messages[n - 1]?.id);
        assert.equal(new Set(r.messages.map((m) => m.id)).size, n, 'ids are unique');
        assert.ok(r.messages.every((m) => m.conversationId === r.id));
        if (n > 0) {
          const a = analyzeTree(r.id, r.messages, r.currentNodeId);
          assert.equal(a.branches.length, 1);
          assert.deepEqual(a.warnings, []);
        }
      }),
    );
  });

  it('explicit pointers (valid, dangling, cyclic, sentinel, garbage, absent): still valid; child lists agree with parents; currentNodeId is null or the only leaf', () => {
    runProperty(
      fc.property(conversationArb, fc.array(fc.tuple(fc.nat(4), fc.nat(50)), { minLength: 1, maxLength: 8 }), (conv, picks) => {
        const r = recordFor(JSON.stringify(withPointers(conv as Obj, picks)));
        const byId = new Map(r.messages.map((m) => [m.id, m] as const));
        for (const m of r.messages) {
          for (const c of m.childIds) assert.equal(byId.get(c)?.parentId, m.id, 'declared child names this parent');
          if (m.parentId !== null && byId.has(m.parentId)) assert.equal(byId.get(m.parentId)?.childIds.filter((x) => x === m.id).length, 1, 'listed once under its parent');
        }
        const a = analyzeTree(r.id, r.messages, r.currentNodeId); // must not throw
        assert.ok(!a.warnings.some((w) => w.code === 'CHILD_PARENT_MISMATCH'), 'derived child lists never contradict the parent pointers');
        if (r.currentNodeId !== null) {
          assert.equal(byId.get(r.currentNodeId)?.childIds.length, 0, 'the current node is a leaf');
          assert.equal(r.messages.filter((m) => m.childIds.length === 0).length, 1, 'and the only leaf');
          assert.equal(a.activeBranchId, r.currentNodeId);
        } else if (r.messages.length > 0) {
          assert.ok(r.warnings.some((w) => w.code === 'ACTIVE_BRANCH_UNKNOWN'));
        }
        assert.equal(r.warnings.filter((w) => w.code === 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY').length, 1);
      }),
    );
  });

  it('warnings: one per code, linear-export warning first, ids bounded, no warning embeds a message text of 8+ characters', () => {
    runProperty(
      fc.property(conversationArb, (conv) => {
        const r = recordFor(JSON.stringify(conv));
        assert.equal(r.warnings[0]?.code, 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY');
        assert.equal(r.warnings.length, new Set(r.warnings.map((w) => w.code)).size);
        const json = JSON.stringify(r.warnings);
        const ids = r.warnings.flatMap((w) => w.ids ?? []);
        for (const w of r.warnings) assert.ok((w.ids ?? []).length <= 50);
        for (const m of r.messages) {
          // A text may legitimately equal (part of) an id that a warning cites; anything else would be a content leak.
          if (m.text.length >= 8 && !ids.some((id) => id.includes(m.text))) assert.ok(!json.includes(JSON.stringify(m.text).slice(1, -1)), 'message text leaked into a warning');
        }
      }),
    );
  });

  it('never throws anything but GcrError for ARBITRARY JSON or garbage text (not just conversation-shaped input)', () => {
    runProperty(
      fc.property(fc.oneof(fc.json(), fc.string(), fc.string({ unit: 'binary' }), conversationArb.map((c) => JSON.stringify(c)), fc.jsonValue().map((v) => JSON.stringify({ chat_messages: v })), hostile), (text) => {
        try {
          const out = claudeAdapter.normalizeElementText(text, claudeCtx(), 0);
          if (out.kind === 'record') validateConversationRecord(out.record);
          else assert.ok(['EMPTY_CONVERSATION_ENTRY', 'NON_OBJECT_ENTRY', 'NOT_A_CONVERSATION'].includes(out.reason));
        } catch (e) {
          assert.ok(e instanceof GcrError, `non-GcrError: ${String(e)}`);
          assert.notEqual(e.details?.['reason'], 'UNEXPECTED_ADAPTER_FAILURE', 'the catch-all is for adapter bugs');
        }
      }),
      500,
    );
  });
});
