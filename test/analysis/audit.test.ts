/**
 * Tests for src/analysis/audit.ts: each check has positive and negative cases, plus branch / model provenance.
 * Databases are built through the real Repository.importBatch with synthetic records (linear, branched, cyclic, orphaned,
 * self-parented, no current node, untitled, empty, hidden, multi-provider, multi-account). Synthetic data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIT_CHECKS, KNOWN_CHATGPT_CONTENT_TYPES, KNOWN_ROLES, runAudit } from '../../src/analysis/audit.js';
import type { AuditCheck, AuditFinding, AuditResult } from '../../src/analysis/audit.js';
import { NAMED_CONTENT_TYPES } from '../../src/ingest/chatgpt-export.js';
import { branchedConversation, convo, linearConversation } from '../helpers/records.js';
import { chat, claudeChat, cyclic, fresh, importAll, iso, link, mismatched, msg, orphaned, selfParent, star } from './support.test.js';

function finding(r: AuditResult, check: AuditCheck): AuditFinding {
  const f = r.findings.find((x) => x.check === check);
  assert.ok(f, `finding for ${check}`);
  return f;
}

describe('audit: result shape and a clean database', () => {
  it('a clean database reports every check with count 0 and severity info, empty samples, and well-formed provenance', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('ok1', [{ role: 'user' }, { role: 'assistant', model: 'm1' }]),
      chat('ok2', [{ role: 'user' }, { role: 'assistant', model: 'm2' }, { role: 'user' }, { role: 'assistant', model: 'm2' }]),
    ]);
    const r = runAudit(db);
    assert.deepEqual(r.scanned, { conversations: 2, messages: 6 });
    assert.deepEqual(r.findings.map((f) => f.check), [...AUDIT_CHECKS]);
    for (const f of r.findings) {
      assert.equal(f.count, 0, f.check);
      assert.equal(f.severity, 'info', f.check);
      assert.deepEqual(f.sampleConversationIds, [], f.check);
      assert.deepEqual(f.sampleMessageIds, [], f.check);
      assert.equal(typeof f.description, 'string');
      assert.ok(f.total >= 0);
    }
    assert.deepEqual(r.branchProvenance, { conversationsWithMultipleBranches: 0, maxBranchesInOneConversation: 1, conversationsWithKnownActiveBranch: 2, conversationsWithUnknownActiveBranch: 0 });
    assert.deepEqual(r.modelProvenance, { assistantMessagesWithModel: 3, assistantMessagesWithoutModel: 0, conversationsWithAnyModel: 2 });
    assert.deepEqual(r.warnings, []);
  });

  it('an empty database scans nothing and says so (a clean result is not evidence)', () => {
    const { db } = fresh();
    const r = runAudit(db);
    assert.deepEqual(r.scanned, { conversations: 0, messages: 0 });
    assert.ok(r.warnings.some((w) => w.code === 'NO_CONVERSATIONS_IN_SCOPE'));
    assert.deepEqual(r.branchProvenance, { conversationsWithMultipleBranches: 0, maxBranchesInOneConversation: 0, conversationsWithKnownActiveBranch: 0, conversationsWithUnknownActiveBranch: 0 });
  });

  it('accepts the Repository and an omitted options object', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('r', [{ role: 'user' }])]);
    assert.deepEqual(runAudit(repo), runAudit(db, {}));
  });
});

describe('audit: missing_model', () => {
  async function modelDb(): Promise<ReturnType<typeof fresh>> {
    const f = fresh();
    await importAll(f.repo, [
      chat('m1', [
        { role: 'user' },
        { role: 'assistant', model: 'a' },
        { role: 'assistant', model: null },
        { role: 'assistant', model: '  ' },
        { role: 'assistant', model: null, hidden: true },
        { role: 'system', model: null },
      ]),
      chat('m2', [{ role: 'assistant', model: 'b' }]),
      chat('m3', [{ role: 'user', model: 'weird-user-model' }], { defaultModelSlug: 'conv-default' }),
    ]);
    return f;
  }

  it('counts visible assistant messages without an explicit model (NULL or blank) and reports the share', async () => {
    const { db } = await modelDb();
    const f = finding(runAudit(db), 'missing_model');
    assert.equal(f.count, 2);
    assert.equal(f.total, 4, 'a, null, blank, b - hidden assistant, user and system messages are not in the population');
    assert.equal(f.severity, 'info', 'the export often omits the model: informational');
    assert.match(f.description, /2 of 4 visible assistant messages \(50\.0%\)/);
    assert.match(f.description, /never infers/);
    assert.deepEqual(f.sampleMessageIds, ['m1-m2', 'm1-m3']);
    assert.deepEqual(f.sampleConversationIds, ['m1']);
  });

  it('model provenance: assistant with / without a model, and conversations with a model on ANY real message', async () => {
    const { db } = await modelDb();
    assert.deepEqual(runAudit(db).modelProvenance, { assistantMessagesWithModel: 2, assistantMessagesWithoutModel: 2, conversationsWithAnyModel: 3 });
  });

  it('negative: every visible assistant message has a model -> count 0', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('n', [{ role: 'assistant', model: 'x' }, { role: 'assistant', model: 'y' }])]);
    const f = finding(runAudit(db), 'missing_model');
    assert.equal(f.count, 0);
    assert.equal(f.total, 2);
    assert.match(f.description, /0 of 2 visible assistant messages \(0\.0%\)/);
  });

  it('the conversation default_model_slug is never used to fill a missing model', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('d', [{ role: 'assistant', model: null }], { defaultModelSlug: 'the-default' })]);
    const r = runAudit(db);
    assert.equal(finding(r, 'missing_model').count, 1);
    assert.equal(r.modelProvenance.assistantMessagesWithModel, 0);
    assert.equal(r.modelProvenance.conversationsWithAnyModel, 0);
  });

  it('no assistant messages at all: total 0, share 0.0%, no division by zero', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('u', [{ role: 'user' }])]);
    const f = finding(runAudit(db), 'missing_model');
    assert.deepEqual([f.count, f.total], [0, 0]);
    assert.match(f.description, /0 of 0 visible assistant messages \(0\.0%\)/);
  });
});

describe('audit: empty', () => {
  it('flags conversations with no non-structural message, or only blank text (ASCII and Unicode whitespace, zero-width)', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('e-none', []),
      chat('e-ws', [{ text: ' ' }, { text: '\n\t' }, { text: ' ' }, { text: '　' }, { text: '​' }]),
      chat('e-blank-string', [{ text: '' }]),
      chat('e-mixed', [{ text: '' }, { text: 'real content' }]),
      chat('e-hidden-only', [{ text: 'scaffolding', hidden: true }]),
      chat('e-ok', [{ text: 'hello' }, { text: 'world' }]),
    ]);
    const f = finding(runAudit(db), 'empty');
    assert.equal(f.count, 3);
    assert.equal(f.total, 6);
    assert.equal(f.severity, 'warn');
    assert.deepEqual(f.sampleConversationIds, ['e-blank-string', 'e-none', 'e-ws']);
    assert.deepEqual(f.sampleMessageIds, [], 'a conversation-level check has no message samples');
  });

  it('negative: all conversations have content', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('a', [{ text: 'x' }]), chat('b', [{ text: ' padded ' }])]);
    const f = finding(runAudit(db), 'empty');
    assert.equal(f.count, 0);
    assert.equal(f.severity, 'info');
  });
});

describe('audit: untitled', () => {
  it('flags NULL, empty and whitespace-only titles; real titles (even padded) are fine', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('t-null', [{}], { title: null }),
      chat('t-empty', [{}], { title: '' }),
      chat('t-ws', [{}], { title: '   \n' }),
      chat('t-ideographic', [{}], { title: '　　' }),
      chat('t-real', [{}], { title: 'Real title' }),
      chat('t-padded', [{}], { title: ' padded ' }),
    ]);
    const f = finding(runAudit(db), 'untitled');
    assert.equal(f.count, 4);
    assert.equal(f.total, 6);
    assert.equal(f.severity, 'info');
    assert.deepEqual(f.sampleConversationIds, ['t-empty', 't-ideographic', 't-null', 't-ws']);
  });

  it('negative: every conversation has a title', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('a', [{}]), chat('b', [{}])]);
    assert.equal(finding(runAudit(db), 'untitled').count, 0);
  });
});

describe('audit: tree_integrity', () => {
  it('negative: linear and branched but consistent trees raise nothing', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [linearConversation('lin', 4), branchedConversation('br')]);
    const f = finding(runAudit(db), 'tree_integrity');
    assert.equal(f.count, 0);
    assert.equal(f.total, 2);
    assert.deepEqual(f.byCode, {});
    assert.deepEqual(f.sampleMessageIds, []);
  });

  it('an orphan whose parent is missing -> MISSING_PARENT (warn), with the orphan id as sample', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [orphaned('o')]);
    const f = finding(runAudit(db), 'tree_integrity');
    assert.equal(f.count, 1);
    assert.deepEqual(f.byCode, { MISSING_PARENT: 1 });
    assert.equal(f.severity, 'warn');
    assert.deepEqual(f.sampleMessageIds, ['o-o1']);
    assert.deepEqual(f.sampleConversationIds, ['o']);
  });

  it('a parent cycle -> CYCLE_DETECTED and severity error; the cycle members are sampled', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [cyclic('c')]);
    const f = finding(runAudit(db), 'tree_integrity');
    assert.equal(f.count, 1);
    assert.deepEqual(f.byCode, { CYCLE_DETECTED: 1 });
    assert.equal(f.severity, 'error');
    assert.deepEqual(f.sampleMessageIds, ['c-x', 'c-y']);
  });

  it('a self-parent -> SELF_PARENT and severity error', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [selfParent('s')]);
    const f = finding(runAudit(db), 'tree_integrity');
    assert.deepEqual(f.byCode, { SELF_PARENT: 1 });
    assert.equal(f.severity, 'error');
    assert.deepEqual(f.sampleMessageIds, ['s-s']);
  });

  it('a declared child list that disagrees with the parent pointers -> CHILD_PARENT_MISMATCH (warn)', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [mismatched('m')]);
    const f = finding(runAudit(db), 'tree_integrity');
    assert.deepEqual(f.byCode, { CHILD_PARENT_MISMATCH: 1 });
    assert.equal(f.severity, 'warn');
    assert.ok(f.sampleMessageIds.includes('ghost-child'));
  });

  it('byCode counts CONVERSATIONS per code, count is the number of affected conversations, total is all scanned', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      orphaned('o1'),
      orphaned('o2'),
      cyclic('c1'),
      orphaned('o3'),
      linearConversation('fine', 2),
    ]);
    const f = finding(runAudit(db), 'tree_integrity');
    assert.equal(f.count, 4);
    assert.equal(f.total, 5);
    assert.deepEqual(f.byCode, { MISSING_PARENT: 3, CYCLE_DETECTED: 1 });
    assert.equal(f.severity, 'error', 'any cycle raises the whole finding to error');
    assert.deepEqual(f.sampleConversationIds, ['c1', 'o1', 'o2', 'o3']);
  });

  it('a conversation with several problems counts once for the finding but once per code in byCode', async () => {
    const { db, repo } = fresh();
    const c = (s: string): string => `multi-${s}`;
    const msgs = link([
      msg({ id: c('root'), conversationId: 'multi', nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
      msg({ id: c('a'), conversationId: 'multi', parentId: c('root'), authorRole: 'user', createdAt: iso(1), text: 'a', ordinal: 1 }),
      msg({ id: c('o'), conversationId: 'multi', parentId: 'ghost', authorRole: 'user', createdAt: iso(2), text: 'o', ordinal: 2 }),
      msg({ id: c('s'), conversationId: 'multi', parentId: c('s'), authorRole: 'user', createdAt: iso(3), text: 's', ordinal: 3 }),
    ]);
    await importAll(repo, [convo('multi', msgs, { currentNodeId: c('a') })]);
    const f = finding(runAudit(db), 'tree_integrity');
    assert.equal(f.count, 1);
    assert.deepEqual(f.byCode, { MISSING_PARENT: 1, SELF_PARENT: 1 });
  });

  it('more leaves than the analyzer limit -> BRANCH_LIMIT_EXCEEDED (warn)', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [star('big', 10_001)]);
    const r = runAudit(db, { checks: ['tree_integrity'] });
    const f = finding(r, 'tree_integrity');
    assert.deepEqual(f.byCode, { BRANCH_LIMIT_EXCEEDED: 1 });
    assert.equal(f.severity, 'warn');
    assert.deepEqual(f.sampleMessageIds, ['big-l10000'], 'the one leaf the analyzer could not enumerate');
    assert.equal(r.branchProvenance?.maxBranchesInOneConversation, 10_001, 'leaf count is exact even when enumeration was truncated');
    assert.equal(r.branchProvenance?.conversationsWithMultipleBranches, 1);
  });

  it('current-node problems are NOT tree integrity (they belong to no_current_node)', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('nc', [{}, {}], { currentNodeId: null })]);
    const r = runAudit(db);
    assert.equal(finding(r, 'tree_integrity').count, 0);
    assert.equal(finding(r, 'no_current_node').count, 1);
  });
});

describe('audit: no_current_node', () => {
  it('flags NULL, dangling and unreachable (on a cycle) current nodes; a valid pointer is fine', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('cn-null', [{}, {}], { currentNodeId: null }),
      chat('cn-dangling', [{}, {}], { currentNodeId: 'no-such-node' }),
      cyclic('cn-cycle', { currentNodeId: 'cn-cycle-x' }),
      chat('cn-ok', [{}, {}]),
      linearConversation('cn-lin', 2),
    ]);
    const f = finding(runAudit(db), 'no_current_node');
    assert.equal(f.count, 3);
    assert.equal(f.total, 5);
    assert.deepEqual(f.byCode, { INVALID_CURRENT_NODE: 2, NO_CURRENT_NODE: 1 });
    assert.equal(f.severity, 'warn');
    assert.deepEqual(f.sampleConversationIds, ['cn-cycle', 'cn-dangling', 'cn-null']);
    assert.deepEqual(f.sampleMessageIds, []);
  });

  it('negative: every conversation has a valid pointer', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('a', [{}, {}]), branchedConversation('b')]);
    const f = finding(runAudit(db), 'no_current_node');
    assert.equal(f.count, 0);
    assert.deepEqual(f.byCode, {});
  });

  it('a conversation without messages and without a pointer is flagged (nothing to point at)', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('nothing', [])]);
    assert.equal(finding(runAudit(db), 'no_current_node').count, 1);
  });
});

describe('audit: unknown_roles', () => {
  it('flags roles outside user/assistant/system/tool (case-sensitive), keeps them verbatim in byCode, ignores structural nodes', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('r1', [{ role: 'user' }, { role: 'assistant' }, { role: 'system' }, { role: 'tool' }, { role: 'function' }, { role: 'Assistant' }, { role: '' }, { role: '__proto__' }, { role: 'function' }]),
    ]);
    const f = finding(runAudit(db), 'unknown_roles');
    assert.equal(f.count, 5);
    assert.equal(f.total, 9, 'the structural root is not counted');
    assert.equal(f.severity, 'warn');
    assert.deepEqual(Object.keys(f.byCode ?? {}).sort(), ['', 'Assistant', '__proto__', 'function']);
    assert.equal(f.byCode?.['function'], 2);
    assert.equal(Object.hasOwn(f.byCode ?? {}, '__proto__'), true, '"__proto__" is a real key, not a prototype assignment');
    assert.deepEqual(f.sampleMessageIds, ['r1-m4', 'r1-m5', 'r1-m6', 'r1-m7', 'r1-m8']);
    assert.deepEqual(KNOWN_ROLES, ['user', 'assistant', 'system', 'tool']);
  });

  it('negative: only the four known roles', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('r2', [{ role: 'user' }, { role: 'assistant' }, { role: 'system' }, { role: 'tool' }])]);
    const f = finding(runAudit(db), 'unknown_roles');
    assert.equal(f.count, 0);
    assert.deepEqual(f.byCode, {});
  });
});

describe('audit: unknown_content_types', () => {
  it('is the ChatGPT adapter\'s own list, imported (no drift)', () => {
    assert.deepEqual([...KNOWN_CHATGPT_CONTENT_TYPES], [...NAMED_CONTENT_TYPES]);
    assert.ok(KNOWN_CHATGPT_CONTENT_TYPES.includes('text') && KNOWN_CHATGPT_CONTENT_TYPES.includes('multimodal_text'));
  });

  it('flags content types the ChatGPT adapter has no handler for; known types, NULL and other providers are not flagged', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('ct-known', NAMED_CONTENT_TYPES.map((t) => ({ contentType: t }))),
      chat('ct-null', [{ contentType: null }]),
      chat('ct-new', [{ contentType: 'brand_new_type' }, { contentType: 'brand_new_type' }, { contentType: 'Text' }, { contentType: 'other_new' }]),
      claudeChat('ct-claude', [{ contentType: 'claude_specific' }]),
    ]);
    const f = finding(runAudit(db), 'unknown_content_types');
    assert.equal(f.count, 4);
    assert.equal(f.total, NAMED_CONTENT_TYPES.length + 4, 'ChatGPT messages that carry a content_type');
    assert.deepEqual(f.byCode, { brand_new_type: 2, Text: 1, other_new: 1 });
    assert.equal(f.severity, 'warn');
    assert.deepEqual(f.sampleConversationIds, ['ct-new']);
    assert.deepEqual(f.sampleMessageIds, ['ct-new-m0', 'ct-new-m1', 'ct-new-m2', 'ct-new-m3']);
  });

  it('negative: only known types', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('ok', [{ contentType: 'text' }, { contentType: 'code' }])]);
    assert.equal(finding(runAudit(db), 'unknown_content_types').count, 0);
  });
});

describe('audit: timestamps', () => {
  it('flags a missing created_at and a message earlier than its parent; equal times, spelling differences and structural parents are fine', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('ts-null', [{ at: iso(1) }, { at: null }, { at: iso(3) }]),
      chat('ts-back', [{ at: iso(10) }, { at: iso(5) }, { at: iso(20) }]),
      chat('ts-equal', [{ at: iso(7) }, { at: iso(7) }]),
      chat('ts-spelling', [{ at: '2025-01-01T00:00:05Z' }, { at: '2025-01-01T00:00:05.000Z' }, { at: '2025-01-01T00:00:05Z' }]),
      chat('ts-ok', [{ at: iso(1) }, { at: iso(2) }]),
    ]);
    const f = finding(runAudit(db), 'timestamps');
    assert.deepEqual(f.byCode, { MESSAGE_BEFORE_PARENT: 1, MESSAGE_CREATED_AT_NULL: 1 });
    assert.equal(f.count, 2, 'two flagged items (messages)');
    assert.equal(f.total, 5 + (3 + 3 + 2 + 3 + 2), 'five conversations plus all thirteen real messages');
    assert.equal(f.severity, 'warn', 'time running backwards is a real anomaly');
    assert.deepEqual(f.sampleConversationIds, ['ts-back', 'ts-null']);
    assert.deepEqual(f.sampleMessageIds, ['ts-back-m1', 'ts-null-m1']);
  });

  it('only missing timestamps -> info (common in exports); a structural root without time never flags its children', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('only-null', [{ at: null }, { at: null }])]);
    const f = finding(runAudit(db), 'timestamps');
    assert.deepEqual(f.byCode, { MESSAGE_CREATED_AT_NULL: 2 });
    assert.equal(f.severity, 'info');
    assert.equal(f.count, 2);
  });

  it('conversation-level: created_at missing, updated_at before created_at', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('c-null', [{ at: iso(1) }], { createdAt: null }),
      chat('c-back', [{ at: iso(1) }], { createdAt: iso(100), updatedAt: iso(50) }),
      chat('c-ok', [{ at: iso(1) }], { createdAt: iso(1), updatedAt: iso(1) }),
      chat('c-no-update', [{ at: iso(1) }], { createdAt: iso(1), updatedAt: null }),
    ]);
    const f = finding(runAudit(db), 'timestamps');
    assert.deepEqual(f.byCode, { CONVERSATION_CREATED_AT_NULL: 1, CONVERSATION_UPDATED_BEFORE_CREATED: 1 });
    assert.equal(f.count, 2);
    assert.equal(f.severity, 'warn');
    assert.deepEqual(f.sampleConversationIds, ['c-back', 'c-null']);
    assert.deepEqual(f.sampleMessageIds, []);
  });

  it('negative: every timestamp present and in order', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [linearConversation('lin', 3), branchedConversation('br')]);
    const f = finding(runAudit(db), 'timestamps');
    assert.equal(f.count, 0);
    assert.deepEqual(f.byCode, {});
    assert.equal(f.severity, 'info');
  });
});

describe('audit: hidden', () => {
  it('counts hidden messages (structural nodes excluded) and breaks them down by author role', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('h1', [{ role: 'system', hidden: true }, { role: 'user' }, { role: 'assistant', hidden: true }, { role: 'system', hidden: true }]),
      chat('h2', [{ role: 'user', hidden: true }, { role: 'user' }]),
    ]);
    const f = finding(runAudit(db), 'hidden');
    assert.equal(f.count, 4);
    assert.equal(f.total, 6);
    assert.equal(f.severity, 'info');
    assert.deepEqual(f.byCode, { system: 2, assistant: 1, user: 1 });
    assert.deepEqual(f.sampleMessageIds, ['h1-m0', 'h1-m2', 'h1-m3', 'h2-m0']);
    assert.deepEqual(f.sampleConversationIds, ['h1', 'h2']);
  });

  it('negative: nothing hidden', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chat('v', [{}, {}])]);
    const f = finding(runAudit(db), 'hidden');
    assert.equal(f.count, 0);
    assert.deepEqual(f.byCode, {});
  });
});

describe('audit: branch provenance', () => {
  it('counts conversations with several branches, the maximum, and known vs unknown active branch', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [
      chat('lin', [{}, {}, {}]), //                            1 leaf, current valid
      branchedConversation('br'), //                           3 leaves, current valid
      chat('nocur', [{}, {}], { currentNodeId: null }), //     1 leaf, active branch unknown
      star('star', 5), //                                      5 leaves, current valid
    ]);
    const r = runAudit(db);
    assert.deepEqual(r.branchProvenance, {
      conversationsWithMultipleBranches: 2,
      maxBranchesInOneConversation: 5,
      conversationsWithKnownActiveBranch: 3,
      conversationsWithUnknownActiveBranch: 1,
    });
    assert.equal(r.branchProvenance.conversationsWithKnownActiveBranch + r.branchProvenance.conversationsWithUnknownActiveBranch, r.scanned.conversations);
  });

  it('known + unknown always add up to the scanned conversations, including damaged trees', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [cyclic('c'), orphaned('o'), selfParent('s'), mismatched('m'), chat('e', [])]);
    const r = runAudit(db);
    const b = r.branchProvenance;
    assert.ok(b !== null, 'the tree pass ran (default checks), so branchProvenance is measured');
    assert.equal(b.conversationsWithKnownActiveBranch + b.conversationsWithUnknownActiveBranch, 5);
    assert.ok(b.conversationsWithMultipleBranches >= 1, 'the orphan chain is a second root, hence a second branch');
  });

  it('skipping every tree-based check skips the pass and reports branchProvenance as null (SPEC-07), not as measured-looking zeros', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [star('s', 3)]);
    const r = runAudit(db, { checks: ['untitled', 'hidden'] });
    assert.equal(r.branchProvenance, null);
    assert.ok(r.warnings.some((w) => w.code === 'BRANCH_PROVENANCE_NOT_COMPUTED'));
    const full = runAudit(db, { checks: ['untitled', 'timestamps'] });
    assert.ok(!full.warnings.some((w) => w.code === 'BRANCH_PROVENANCE_NOT_COMPUTED'));
    assert.equal(full.branchProvenance?.maxBranchesInOneConversation, 3);
  });
});
