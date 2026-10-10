/**
 * ClaudeExportAdapter: identity, context handling, the linear fixture, sender mapping, tree rules (linear chain vs
 * explicit parent pointers), completeness / currentNodeId reasoning, model attribution. All data is synthetic.
 * Companion files: claude-export.content.test.ts (blocks, attachments, timestamps, unknown fields),
 * claude-export.hostile.test.ts (sanitization, caps, skips, errors), claude-export.fixtures.test.ts,
 * claude-export.props.test.ts, claude-export.scale.test.ts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { analyzeTree } from '../../src/domain/branches.js';
import { GcrError } from '../../src/errors.js';
import type { AdapterContext } from '../../src/ingest/adapter.js';
import { CLAUDE_ROOT_SENTINEL, ClaudeExportAdapter } from '../../src/ingest/claude-export.js';
import {
  claudeAdapter,
  claudeConversation,
  claudeCtx,
  claudeLinearConversation,
  claudeMessage,
  elementText,
  findWarning,
  fixtureElementTexts,
  fixtureElements,
  IMPORTED_AT,
  message,
  recordOf,
  runElement,
  synthUuid,
  warningCodes,
} from '../helpers/claude-export-builder.js';

function throwsGcr(fn: () => unknown, code: string): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`expected GcrError ${code}, nothing was thrown`);
}

describe('ClaudeExportAdapter identity and context', () => {
  it('declares provider "claude" and provenance "official_claude_export"', () => {
    const a = new ClaudeExportAdapter();
    assert.equal(a.provider, 'claude');
    assert.equal(a.provenance, 'official_claude_export');
    assert.equal(typeof a.name, 'string');
    assert.ok(a.name.length > 0);
  });

  it('copies accountLabel and importedAt from the context (adapters never read the clock)', () => {
    const r = recordOf(claudeLinearConversation(2), claudeCtx({ accountLabel: 'acct-2', importedAt: '2026-05-06T07:08:09.010Z' }));
    assert.equal(r.accountLabel, 'acct-2');
    assert.equal(r.importedAt, '2026-05-06T07:08:09.010Z');
  });

  for (const provider of ['chatgpt', 'openai_api'] as const) {
    it(`refuses a context for provider "${provider}" (a mismatch would mislabel provenance)`, () => {
      const e = throwsGcr(() => runElement(claudeLinearConversation(1), claudeCtx({ provider })), 'INVALID_ARGUMENT');
      assert.equal(e.details?.['reason'], 'PROVIDER_MISMATCH');
    });
  }

  for (const [label, over] of [
    ['empty accountLabel', { accountLabel: '' }],
    ['accountLabel with NUL', { accountLabel: 'a\u0000b' }],
    ['accountLabel longer than 512', { accountLabel: 'x'.repeat(513) }],
    ['non-ISO importedAt', { importedAt: 'yesterday' }],
    ['importedAt with an offset', { importedAt: '2026-01-02T03:04:05+01:00' }],
  ] as const) {
    it(`rejects ${label} up front instead of failing every element later`, () => {
      throwsGcr(() => runElement(claudeLinearConversation(1), claudeCtx(over as Partial<AdapterContext>)), 'INVALID_ARGUMENT');
    });
  }

  it('rejects a non-string element text and a non-object context', () => {
    throwsGcr(() => claudeAdapter.normalizeElementText(42 as unknown as string, claudeCtx(), 0), 'INVALID_ARGUMENT');
    throwsGcr(() => claudeAdapter.normalizeElementText('{}', null as unknown as AdapterContext, 0), 'INVALID_ARGUMENT');
  });

  it('works with a frozen context and does not mutate it', () => {
    const ctx = Object.freeze({ ...claudeCtx(), availableAssetNames: new Set(['a']) });
    recordOf(claudeLinearConversation(2), ctx);
    assert.equal(ctx.availableAssetNames.size, 1);
  });
});

describe('linear fixture (positive)', () => {
  const [text] = fixtureElementTexts('linear.json');
  assert.ok(text !== undefined);
  const source = fixtureElements('linear.json')[0] as Record<string, unknown>;
  const r = recordOf(text);

  it('has provider-neutral identity, provenance and the active-view-only completeness', () => {
    assert.equal(r.provider, 'claude');
    assert.equal(r.provenance, 'official_claude_export');
    assert.equal(r.completeness, 'rendered_active_view_only');
    assert.equal(r.id, synthUuid(1));
    assert.equal(r.title, 'GCR-SYNTHETIC-FIXTURE linear conversation');
    assert.equal(r.sourceUri, null);
    assert.equal(r.accountLabel, 'default');
    assert.equal(r.importedAt, IMPORTED_AT);
    assert.equal(r.defaultModelSlug, null);
  });

  it('normalizes timestamps to UTC milliseconds (microseconds are truncated, never rounded)', () => {
    assert.equal(r.createdAt, '2025-03-04T05:06:07.123Z');
    assert.equal(r.updatedAt, '2025-03-04T05:10:09.654Z');
    assert.equal(message(r, 1).createdAt, '2025-03-04T05:06:30.000Z');
  });

  it('maps human -> user, keeps assistant, and keeps the original sender in rawSource', () => {
    assert.deepEqual(r.messages.map((m) => m.authorRole), ['user', 'assistant', 'user', 'assistant']);
    assert.equal((message(r, 0).rawSource as Record<string, unknown>)['sender'], 'human');
  });

  it('builds the linear parent/child chain in file order with 0-based ordinals', () => {
    const ids = r.messages.map((m) => m.id);
    assert.deepEqual(ids, [11, 12, 13, 14].map((n) => `00000000-0000-4000-8000-0000000000${n}`));
    assert.deepEqual(r.messages.map((m) => m.parentId), [null, ids[0], ids[1], ids[2]]);
    assert.deepEqual(r.messages.map((m) => m.childIds), [[ids[1]], [ids[2]], [ids[3]], []]);
    assert.deepEqual(r.messages.map((m) => m.ordinal), [0, 1, 2, 3]);
  });

  it('sets currentNodeId to the last message because the export is one thread by construction', () => {
    assert.equal(r.currentNodeId, message(r, 3).id);
  });

  it('carries exactly one LINEAR_EXPORT_ACTIVE_BRANCH_ONLY warning, first, citing the conversation id', () => {
    assert.equal(r.warnings[0]?.code, 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY');
    assert.equal(warningCodes(r).filter((c) => c === 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY').length, 1);
    assert.deepEqual(findWarning(r, 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY')?.ids, [r.id]);
    assert.ok(findWarning(r, 'CHILDREN_ABSENT') !== undefined, 'child lists are derived, which is reported once');
    assert.equal(findWarning(r, 'ACTIVE_BRANCH_UNKNOWN'), undefined);
  });

  it('states no model, channel, recipient, status, content type, author name or hidden flag it was not given', () => {
    for (const m of r.messages) {
      assert.equal(m.modelSlug, null);
      assert.equal(m.channel, null);
      assert.equal(m.recipient, null);
      assert.equal(m.status, null);
      assert.equal(m.contentType, null);
      assert.equal(m.authorName, null);
      assert.equal(m.hidden, false);
      assert.equal(m.nodeKind, 'message');
    }
  });

  it('keeps the message text and a text block, the raw message, and the conversation minus its message tree', () => {
    const msgs = source['chat_messages'] as Array<Record<string, unknown>>;
    assert.equal(message(r, 0).text, 'synthetic human turn 1: please summarise the invented topic alpha');
    assert.deepEqual(message(r, 0).blocks, [{ type: 'text', text: message(r, 0).text }]);
    assert.deepEqual(message(r, 2).rawSource, msgs[2]);
    const { chat_messages: _omitted, ...expectedMeta } = source;
    assert.deepEqual(r.rawMetadata, expectedMeta);
  });

  it('forms exactly one active branch under the domain tree analysis with no tree warnings', () => {
    const a = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.equal(a.branches.length, 1);
    assert.equal(a.activeBranchId, message(r, 3).id);
    assert.deepEqual(a.warnings, []);
  });

  it('reports format observations consistent with the record', () => {
    const out = runElement(text);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.deepEqual(out.observations.roleCounts, { user: 2, assistant: 2 });
    assert.equal(out.observations.nodesWithChildrenAbsent, 4);
    assert.equal(out.observations.nodesWithChildrenDeclared, 0);
    assert.equal(out.observations.hasCurrentNode, true);
    assert.equal(out.observations.messagesWithModelSlug, 0);
    assert.equal(out.observations.hiddenMessages, 0);
    assert.equal(out.observations.rootIsLiteralClientCreatedRoot, false);
    assert.equal(out.sourceElementSha256, createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('is deterministic: the same text and context give a deeply equal outcome regardless of elementIndex', () => {
    assert.deepEqual(runElement(text, claudeCtx(), 0), runElement(text, claudeCtx(), 0));
    assert.deepEqual(runElement(text, claudeCtx(), 0), runElement(text, claudeCtx(), 7));
  });
});

describe('sender mapping', () => {
  const roleOf = (sender: unknown): string => message(recordOf(claudeConversation([claudeMessage(0, { sender })])), 0).authorRole;

  for (const [sender, role] of [
    ['human', 'user'],
    ['assistant', 'assistant'],
    ['system', 'system'],
    ['tool', 'tool'],
    ['Human', 'Human'],
    ['HUMAN', 'HUMAN'],
    [' human', ' human'],
    ['human ', 'human '],
    ['user', 'user'],
    ['ünï-ролe-日本', 'ünï-ролe-日本'],
    ['x'.repeat(512), 'x'.repeat(512)],
  ] as const) {
    it(`sender ${JSON.stringify(sender.length > 20 ? `${sender.slice(0, 20)}...` : sender)} -> ${JSON.stringify(role.length > 20 ? `${role.slice(0, 20)}...` : role)}`, () => {
      assert.equal(roleOf(sender), role);
    });
  }

  it('keeps the ORIGINAL sender in rawSource even when it is normalized', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { sender: 'human' })]));
    assert.equal((message(r, 0).rawSource as Record<string, unknown>)['sender'], 'human');
  });

  for (const [label, sender] of [['absent', undefined], ['null', null], ['empty', ''], ['a number', 7], ['an object', {}], ['an array', ['human']]] as const) {
    it(`a ${label} sender becomes role "unknown" with SENDER_MISSING (never an empty role)`, () => {
      const r = recordOf(claudeConversation([claudeMessage(0, { sender })]));
      assert.equal(message(r, 0).authorRole, 'unknown');
      assert.deepEqual(findWarning(r, 'SENDER_MISSING')?.ids, [message(r, 0).id]);
    });
  }

  it('does not warn for ordinary senders', () => {
    assert.equal(findWarning(recordOf(claudeLinearConversation(4)), 'SENDER_MISSING'), undefined);
  });
});

describe('message tree: linear chain unless explicit parent pointers exist', () => {
  it('chains file order when no message has parent_message_uuid', () => {
    const r = recordOf(claudeLinearConversation(5));
    for (let i = 1; i < 5; i++) assert.equal(message(r, i).parentId, message(r, i - 1).id);
    assert.equal(message(r, 0).parentId, null);
  });

  it('explicit pointers win over file order (chain A -> C -> B stored as A, B, C)', () => {
    const [a, b, c] = [claudeMessage(0), claudeMessage(1), claudeMessage(2)];
    const r = recordOf(
      claudeConversation([
        { ...a, parent_message_uuid: null },
        { ...b, parent_message_uuid: c['uuid'] },
        { ...c, parent_message_uuid: a['uuid'] },
      ]),
    );
    assert.equal(message(r, 1).parentId, c['uuid']);
    assert.equal(message(r, 2).parentId, a['uuid']);
    assert.equal(r.currentNodeId, b['uuid'], 'the only leaf of a single chain');
    assert.equal(analyzeTree(r.id, r.messages, r.currentNodeId).branches[0]?.path.join('>'), [a['uuid'], c['uuid'], b['uuid']].join('>'));
  });

  it('a chain stored leaf-first still yields its only leaf as currentNodeId (not "last in file")', () => {
    const [a, b] = [claudeMessage(0), claudeMessage(1)];
    const r = recordOf(claudeConversation([{ ...b, parent_message_uuid: a['uuid'] }, { ...a, parent_message_uuid: null }]));
    assert.equal(r.currentNodeId, b['uuid']);
  });

  it('treats the Claude root sentinel as "no parent" and uses real parent pointers (fixture)', () => {
    const r = recordOf(fixtureElementTexts('explicit-parents.json')[0]);
    assert.deepEqual(r.messages.map((m) => m.parentId), [null, r.messages[0]?.id, r.messages[1]?.id]);
    assert.equal(r.currentNodeId, r.messages[2]?.id);
    assert.equal(findWarning(r, 'ACTIVE_BRANCH_UNKNOWN'), undefined);
    assert.equal(CLAUDE_ROOT_SENTINEL, '00000000-0000-4000-8000-000000000000');
  });

  it('a message that really has the sentinel id is a real parent target, not "no parent"', () => {
    const real = claudeMessage(0, { uuid: CLAUDE_ROOT_SENTINEL, parent_message_uuid: null });
    const child = claudeMessage(1, { parent_message_uuid: CLAUDE_ROOT_SENTINEL });
    const r = recordOf(claudeConversation([real, child]));
    assert.equal(message(r, 1).parentId, CLAUDE_ROOT_SENTINEL);
  });

  it('a fork (two leaves) keeps both children in createdAt order, and refuses to guess the active branch', () => {
    const r = recordOf(fixtureElementTexts('explicit-parents.json')[1]);
    const [root, older, newer] = r.messages;
    assert.deepEqual(root?.childIds, [older?.id, newer?.id]);
    assert.equal(r.currentNodeId, null);
    assert.ok(findWarning(r, 'ACTIVE_BRANCH_UNKNOWN') !== undefined);
    assert.equal(r.completeness, 'rendered_active_view_only', 'completeness is never raised just because pointers exist');
    assert.ok(findWarning(r, 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY') !== undefined);
    const a = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.equal(a.branches.length, 2);
    assert.equal(a.activeBranchId, null);
  });

  it('orders derived children by (createdAt, ordinal, id) even when the file order differs', () => {
    const root = claudeMessage(0, { parent_message_uuid: null });
    const late = claudeMessage(1, { created_at: '2025-03-04T09:00:00Z', parent_message_uuid: root['uuid'] });
    const early = claudeMessage(2, { created_at: '2025-03-04T06:00:00Z', parent_message_uuid: root['uuid'] });
    const undated = claudeMessage(3, { created_at: undefined, parent_message_uuid: root['uuid'] });
    const r = recordOf(claudeConversation([root, late, early, undated]));
    assert.deepEqual(message(r, 0).childIds, [early['uuid'], late['uuid'], undated['uuid']]);
  });

  it('keeps a dangling parent pointer verbatim (branches.ts reports MISSING_PARENT) and still sees one chain', () => {
    const r = recordOf(fixtureElementTexts('explicit-parents.json')[2]);
    assert.equal(message(r, 0).parentId, '00000000-0000-4000-8000-0000000000ff');
    assert.deepEqual(message(r, 0).childIds, [message(r, 1).id]);
    assert.equal(r.currentNodeId, message(r, 1).id);
    const a = analyzeTree(r.id, r.messages, r.currentNodeId);
    assert.ok(a.warnings.some((w) => w.code === 'MISSING_PARENT'));
    assert.equal(a.branches.length, 1);
  });

  it('mixed data: a message without a pointer (while others have one) is a root, never linked by file order', () => {
    const a = claudeMessage(0, { parent_message_uuid: null });
    const b = claudeMessage(1); // no key at all
    const r = recordOf(claudeConversation([a, b]));
    assert.equal(message(r, 1).parentId, null);
    assert.deepEqual(findWarning(r, 'PARENT_POINTER_ABSENT')?.ids, [b['uuid']]);
    assert.equal(r.currentNodeId, null);
    assert.ok(findWarning(r, 'ACTIVE_BRANCH_UNKNOWN') !== undefined);
  });

  it('does not warn when only the FIRST message lacks a pointer (it is the natural root)', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), claudeMessage(1, { parent_message_uuid: synthUuid(1000) })]));
    assert.equal(findWarning(r, 'PARENT_POINTER_ABSENT'), undefined);
    assert.equal(r.currentNodeId, message(r, 1).id);
  });

  for (const [label, pointer] of [['a number', 5], ['an object', {}], ['an empty string', ''], ['a string with a control character', 'a\nb'], ['a 513-char string', 'p'.repeat(513)]] as const) {
    it(`a parent pointer that is ${label} is INVALID_PARENT_POINTER and the message becomes a root`, () => {
      const r = recordOf(claudeConversation([claudeMessage(0, { parent_message_uuid: null }), claudeMessage(1, { parent_message_uuid: pointer })]));
      assert.equal(message(r, 1).parentId, null);
      assert.deepEqual(findWarning(r, 'INVALID_PARENT_POINTER')?.ids, [message(r, 1).id]);
    });
  }

  it('a self-parent and a 2-cycle import without throwing, produce no currentNodeId, and branches.ts copes', () => {
    const self = recordOf(claudeConversation([claudeMessage(0, { parent_message_uuid: synthUuid(1000) })]));
    assert.equal(self.currentNodeId, null);
    assert.equal(message(self, 0).parentId, message(self, 0).id);
    analyzeTree(self.id, self.messages, self.currentNodeId);

    const a = claudeMessage(0, { parent_message_uuid: synthUuid(1001) });
    const b = claudeMessage(1, { parent_message_uuid: synthUuid(1000) });
    const cyc = recordOf(claudeConversation([a, b]));
    assert.equal(cyc.currentNodeId, null);
    assert.ok(analyzeTree(cyc.id, cyc.messages, null).warnings.some((w) => w.code === 'CYCLE_DETECTED'));
  });

  it('a duplicate message uuid keeps BOTH messages: the later one gets a deterministic suffix, pointers hit the first', () => {
    const dup = synthUuid(7);
    const m0 = claudeMessage(0, { uuid: dup, parent_message_uuid: null });
    const m1 = claudeMessage(1, { uuid: dup, parent_message_uuid: dup });
    const m2 = claudeMessage(2, { uuid: dup, parent_message_uuid: dup });
    const r = recordOf(claudeConversation([m0, m1, m2]));
    assert.deepEqual(r.messages.map((m) => m.id), [dup, `${dup}~dup2`, `${dup}~dup3`]);
    assert.deepEqual(r.messages.map((m) => m.parentId), [null, dup, dup], 'pointers resolve to the first occurrence');
    assert.deepEqual(findWarning(r, 'DUPLICATE_MESSAGE_ID')?.ids, [dup]);
    assert.equal((message(r, 1).rawSource as Record<string, unknown>)['uuid'], dup, 'the original uuid stays in rawSource');
  });

  it('a suffixed duplicate id skips a suffix that a real message already uses, and respects the 512 id limit', () => {
    const base = 'd'.repeat(512);
    const r1 = recordOf(claudeConversation([claudeMessage(0, { uuid: 'X' }), claudeMessage(1, { uuid: 'X~dup2' }), claudeMessage(2, { uuid: 'X' })]));
    assert.deepEqual(r1.messages.map((m) => m.id), ['X', 'X~dup2', 'X~dup3']);
    const r2 = recordOf(claudeConversation([claudeMessage(0, { uuid: base }), claudeMessage(1, { uuid: base })]));
    assert.ok(r2.messages.every((m) => m.id.length <= 512));
    assert.equal(new Set(r2.messages.map((m) => m.id)).size, 2);
  });

  for (const [label, uuid, code] of [
    ['absent', undefined, 'MESSAGE_ID_MISSING'],
    ['null', null, 'MESSAGE_ID_MISSING'],
    ['empty', '', 'MESSAGE_ID_INVALID'],
    ['a number', 12, 'MESSAGE_ID_INVALID'],
    ['containing NUL', 'a\u0000b', 'MESSAGE_ID_INVALID'],
    ['containing a newline', 'a\nb', 'MESSAGE_ID_INVALID'],
    ['513 characters long', 'u'.repeat(513), 'MESSAGE_ID_INVALID'],
  ] as const) {
    it(`a message uuid that is ${label} gets the positional id synthetic-msg-<index> and ${code}`, () => {
      const r = recordOf(claudeConversation([claudeMessage(0), claudeMessage(1, { uuid }), claudeMessage(2)]));
      assert.equal(message(r, 1).id, 'synthetic-msg-1');
      assert.deepEqual(findWarning(r, code)?.ids, ['synthetic-msg-1']);
      assert.equal(message(r, 2).parentId, 'synthetic-msg-1');
    });
  }

  it('non-object chat_messages entries are skipped with a warning; ordinals keep the source position and the chain bridges the gap', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), null as never, claudeMessage(2), 'str' as never, 5 as never, [] as never, claudeMessage(6)]));
    assert.deepEqual(r.messages.map((m) => m.ordinal), [0, 2, 6]);
    assert.equal(message(r, 1).parentId, message(r, 0).id);
    assert.equal(message(r, 2).parentId, message(r, 1).id);
    assert.equal(findWarning(r, 'NON_OBJECT_MESSAGE')?.message.includes('(4 occurrences)'), true);
    assert.equal(r.currentNodeId, message(r, 2).id);
  });

  it('ids that look like Object.prototype members are ordinary ids', () => {
    const r = recordOf(claudeConversation([claudeMessage(0, { uuid: '__proto__' }), claudeMessage(1, { uuid: 'constructor' }), claudeMessage(2, { uuid: 'toString' })]));
    assert.deepEqual(r.messages.map((m) => m.id), ['__proto__', 'constructor', 'toString']);
    assert.deepEqual(r.messages.map((m) => m.parentId), [null, '__proto__', 'constructor']);
    assert.equal(r.currentNodeId, 'toString');
  });
});

describe('completeness and currentNodeId reasoning', () => {
  it('an empty conversation keeps the completeness, has no currentNodeId and only the linear-export warning', () => {
    const [text] = fixtureElementTexts('empty-conversation.json');
    const out = runElement(text);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.equal(out.record.messages.length, 0);
    assert.equal(out.record.currentNodeId, null);
    assert.equal(out.record.completeness, 'rendered_active_view_only');
    assert.deepEqual(warningCodes(out.record), ['LINEAR_EXPORT_ACTIVE_BRANCH_ONLY']);
    assert.equal(out.observations.hasCurrentNode, false);
    assert.equal(out.observations.nodesWithChildrenAbsent, 0);
    assert.deepEqual(out.observations.roleCounts, {});
  });

  it('a single message is its own current node', () => {
    const r = recordOf(claudeConversation([claudeMessage(0)]));
    assert.equal(r.currentNodeId, message(r, 0).id);
  });

  it('every record from every fixture is rendered_active_view_only with exactly one linear-export warning', () => {
    for (const file of ['attachments-files.json', 'empty-conversation.json', 'explicit-parents.json', 'hostile-strings.json', 'linear.json', 'missing-optional-fields.json', 'thinking-and-tools.json', 'unknown-extra-fields.json']) {
      for (const text of fixtureElementTexts(file)) {
        const r = recordOf(text);
        assert.equal(r.completeness, 'rendered_active_view_only', file);
        assert.equal(r.provenance, 'official_claude_export', file);
        assert.equal(warningCodes(r).filter((c) => c === 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY').length, 1, file);
      }
    }
  });
});

describe('model attribution (FR-16: never inferred)', () => {
  it('is null on every message and on the conversation when nothing states a model', () => {
    const r = recordOf(claudeLinearConversation(4));
    assert.ok(r.messages.every((m) => m.modelSlug === null));
    assert.equal(r.defaultModelSlug, null);
  });

  it('uses a message-level "model" string for THAT message only, and counts it in the observations', () => {
    const text = fixtureElementTexts('unknown-extra-fields.json')[0];
    const out = runElement(text);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.deepEqual(out.record.messages.map((m) => m.modelSlug), [null, 'synthetic-model-x']);
    assert.equal(out.observations.messagesWithModelSlug, 1);
  });

  it('a conversation-level model fills defaultModelSlug and is NEVER copied onto messages', () => {
    const r = recordOf(claudeConversation([claudeMessage(0), claudeMessage(1)], { model: 'synthetic-default-model' }));
    assert.equal(r.defaultModelSlug, 'synthetic-default-model');
    assert.ok(r.messages.every((m) => m.modelSlug === null));
  });

  it('does not read look-alike keys (model_slug, metadata.model, settings.model)', () => {
    const r = recordOf(claudeConversation([claudeMessage(1, { model_slug: 'nope', metadata: { model: 'nope' }, settings: { model: 'nope' } })], { model_slug: 'nope' }));
    assert.equal(message(r, 0).modelSlug, null);
    assert.equal(r.defaultModelSlug, null);
  });

  for (const [label, model] of [['a number', 5], ['an object', {}], ['an array', ['m']], ['a boolean', true]] as const) {
    it(`a model that is ${label} is ignored with INVALID_MODEL_SLUG`, () => {
      const r = recordOf(claudeConversation([claudeMessage(1, { model })]));
      assert.equal(message(r, 0).modelSlug, null);
      assert.deepEqual(findWarning(r, 'INVALID_MODEL_SLUG')?.ids, [message(r, 0).id]);
    });
  }

  it('an empty or null model is silently null', () => {
    const r = recordOf(claudeConversation([claudeMessage(1, { model: '' }), claudeMessage(2, { model: null })]));
    assert.ok(r.messages.every((m) => m.modelSlug === null));
    assert.equal(findWarning(r, 'INVALID_MODEL_SLUG'), undefined);
  });
});

describe('conversation identity', () => {
  it('lower-cases a UUID-shaped conversation id (so lookups by the lower-cased uuid still find it) and says so as an info warning', () => {
    const upper = 'ABCDEF01-0000-4000-8000-0000000000AA';
    const r = recordOf(claudeConversation([claudeMessage(0)], { uuid: upper }));
    assert.equal(r.id, upper.toLowerCase());
    assert.equal(message(r, 0).conversationId, r.id);
    assert.equal((r.rawMetadata as Record<string, unknown>)['uuid'], upper, 'the raw value is kept');
    const w = findWarning(r, 'ID_CASE_NORMALIZED');
    assert.ok(w?.message.startsWith('[info] '));
    assert.deepEqual(w?.ids, [r.id]);
  });

  it('keeps every other id verbatim: lower-case uuids, non-UUID conversation ids, and ALL message ids (no case folding, no trimming)', () => {
    const lower = 'abcdef01-0000-4000-8000-0000000000aa';
    assert.equal(findWarning(recordOf(claudeConversation([], { uuid: lower })), 'ID_CASE_NORMALIZED'), undefined);
    assert.equal(recordOf(claudeConversation([], { uuid: lower })).id, lower);
    for (const id of ['ABC', ' padded ', 'Conv-UPPER-1']) assert.equal(recordOf(claudeConversation([], { uuid: id })).id, id);
    const m = recordOf(claudeConversation([claudeMessage(0, { uuid: 'ABCDEF01-0000-4000-8000-0000000000BB' })]));
    assert.equal(message(m, 0).id, 'ABCDEF01-0000-4000-8000-0000000000BB');
  });

  it('assigns a deterministic hash-and-position derived id when the uuid is absent (same form as the ChatGPT adapter)', () => {
    const text = elementText(claudeConversation([claudeMessage(0)], { uuid: undefined }));
    const sha = createHash('sha256').update(text, 'utf8').digest('hex');
    const a = recordOf(text, claudeCtx(), 4);
    assert.equal(a.id, `gcr-synth-${sha.slice(0, 32)}-4`);
    assert.equal(recordOf(text, claudeCtx(), 4).id, a.id, 're-importing reproduces the id');
    assert.equal(recordOf(text, claudeCtx(), 5).id, `gcr-synth-${sha.slice(0, 32)}-5`, 'identical id-less elements at different positions stay distinct');
    assert.deepEqual(findWarning(a, 'CONVERSATION_ID_MISSING')?.ids, [a.id]);
    assert.equal(message(a, 0).conversationId, a.id);
    const other = recordOf(elementText(claudeConversation([claudeMessage(1)], { uuid: undefined })), claudeCtx(), 4);
    assert.notEqual(other.id, a.id, 'different content, different synthetic id');
    for (const bogus of [-3, Number.NaN, 1.5, Number.POSITIVE_INFINITY, '7' as unknown as number]) {
      assert.ok(recordOf(text, claudeCtx(), bogus).id.endsWith('-0'), `a bogus index (${String(bogus)}) falls back to 0`);
    }
  });

  for (const [label, uuid] of [['a number', 5], ['empty', ''], ['containing a control character', 'a\tb'], ['513 characters long', 'c'.repeat(513)]] as const) {
    it(`a conversation uuid that is ${label} is CONVERSATION_ID_INVALID and replaced`, () => {
      const r = recordOf(claudeConversation([], { uuid }));
      assert.ok(r.id.startsWith('gcr-synth-'));
      assert.ok(findWarning(r, 'CONVERSATION_ID_INVALID') !== undefined);
      assert.equal(findWarning(r, 'CONVERSATION_ID_MISSING'), undefined);
    });
  }

  it('does not reject a conversation whose uuid has a lone surrogate, but never repairs the id lossily (distinct ids must stay distinct)', () => {
    // Review finding: repairing to U+FFFD mapped "id-\ud800-x" and "id-\ud801-x" to the same id. The ChatGPT adapter's
    // isSafeId() already treats such an id as unusable; so does this adapter (hash-and-position replacement).
    const r = recordOf(`{"uuid":"id-\\ud800-x","chat_messages":[]}`);
    assert.ok(r.id.startsWith('gcr-synth-'));
    assert.ok(findWarning(r, 'CONVERSATION_ID_INVALID') !== undefined);
    assert.equal((r.rawMetadata as Record<string, unknown>)['uuid'], 'id-\ud800-x');
  });
});
