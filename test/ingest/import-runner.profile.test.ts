/**
 * FormatProfile (research Layer 4): the report states OBSERVED facts about the export so that, for example, a role
 * count of a trimmed export is not over-interpreted. Three export generations are built synthetically: richer
 * (children present), parent-only (children absent) and trimmed (no system/tool nodes, no recipient/status/channel,
 * ordinary UUID root, no children).
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runImport } from '../../src/ingest/import-runner.js';
import { ConversationBuilder, OMIT, linearConversation, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { claudeLinearConversation, synthUuid } from '../helpers/claude-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { freshRepo, fixedClock, writeFileIn, zipOf } from './import-runner.helpers.test.js';

/** root(literal) -> user -> assistant(model) -> user -> assistant(model), plus a hidden system node and a tool node. */
function richConversation(n: number, init: ConstructorParameters<typeof ConversationBuilder>[0] = {}): ConversationBuilder {
  const b = new ConversationBuilder({ id: syntheticUuid(n), ...init });
  const root = b.root();
  const sys = b.system(root, 'synthetic system scaffolding');
  const u1 = b.user(sys, 'synthetic question one');
  const a1 = b.assistant(u1, 'synthetic answer one', { model: 'synthetic-model-1' });
  const call = b.code(a1, 'print(1)');
  const tool = b.tool(call, '1');
  const u2 = b.user(tool, 'synthetic question two');
  b.assistant(u2, 'synthetic answer two', { model: 'synthetic-model-1' });
  return b;
}

function trimmedConversation(n: number): ConversationBuilder {
  const b = new ConversationBuilder({ id: syntheticUuid(n), minimal: true, rootStyle: 'uuid', omitChildren: true });
  const root = b.root();
  const u = b.user(root, 'trimmed question', { recipient: OMIT, status: OMIT, weight: OMIT });
  b.assistant(u, 'trimmed answer', { recipient: OMIT, status: OMIT, weight: OMIT, channel: OMIT, model: 'synthetic-model-1' });
  return b;
}

async function profileOf(bodies: string[], layoutFiles: Record<string, string> = {}) {
  const t = freshRepo();
  try {
    return await withTempDir(async (dir) => {
      const file = await writeFileIn(dir, 'conversations.json', `[${bodies.join(',')}]`);
      for (const [k, v] of Object.entries(layoutFiles)) await writeFileIn(dir, k, v);
      const r = await runImport(t.repo, { source: { kind: 'path', path: file }, clock: fixedClock });
      assert.ok(r.formatProfile);
      return r.formatProfile;
    });
  } finally {
    t.close();
  }
}

describe('format profile', () => {
  it('children present: declared children are counted, none absent, literal root, system/tool roles and recipients observed', async () => {
    const p = await profileOf([richConversation(1).text(), richConversation(2).text()]);
    assert.equal(p.conversations, 2);
    assert.equal(p.conversationsWithCurrentNode, 2);
    assert.ok(p.nodesWithChildrenDeclared > 0);
    assert.equal(p.nodesWithChildrenAbsent, 0);
    assert.equal(p.rootIsLiteralClientCreatedRoot, true);
    assert.deepEqual(p.roleCounts, { assistant: 6, system: 2, tool: 2, user: 4 });
    assert.ok(p.messagesWithRecipient > 0);
    assert.ok(p.messagesWithStatus > 0);
    assert.equal(p.messagesWithModelSlug, 4, 'only messages that state a model_slug');
    assert.equal(p.hiddenMessages, 2, 'the system scaffolding is marked hidden by the export');
    assert.equal(p.wrapperObject, false);
    assert.equal(p.layout, 'single');
    assert.equal(p.manifest, 'absent');
    assert.equal(p.auxiliaryFilesIgnored, 0);
    assert.equal(p.assetsExtensionless, false);
  });

  it('children absent (parent-only export): derived edges are counted as absent, not declared', async () => {
    const p = await profileOf([richConversation(1, { omitChildren: true }).text()]);
    assert.equal(p.nodesWithChildrenDeclared, 0);
    assert.ok(p.nodesWithChildrenAbsent > 0);
    assert.equal(p.rootIsLiteralClientCreatedRoot, true);
    assert.equal(p.conversationsWithCurrentNode, 1);
  });

  it('trimmed export: only user/assistant roles, no recipient/status, ordinary-UUID root, children absent', async () => {
    const p = await profileOf([trimmedConversation(1).text(), trimmedConversation(2).text()]);
    assert.deepEqual(p.roleCounts, { assistant: 2, user: 2 });
    assert.equal(p.messagesWithRecipient, 0);
    assert.equal(p.messagesWithStatus, 0);
    assert.equal(p.hiddenMessages, 0);
    assert.equal(p.messagesWithModelSlug, 2);
    assert.equal(p.rootIsLiteralClientCreatedRoot, false);
    assert.equal(p.nodesWithChildrenDeclared, 0);
    assert.ok(p.nodesWithChildrenAbsent > 0);
  });

  it('a mixed batch is not claimed to have a literal root (all conversations must agree)', async () => {
    const p = await profileOf([richConversation(1).text(), trimmedConversation(2).text()]);
    assert.equal(p.rootIsLiteralClientCreatedRoot, false);
    assert.ok(p.nodesWithChildrenDeclared > 0 && p.nodesWithChildrenAbsent > 0);
  });

  it('a conversation without current_node is not counted in conversationsWithCurrentNode', async () => {
    const b = linearConversation(1, { id: syntheticUuid(3) });
    b.setCurrent(OMIT);
    const p = await profileOf([b.text(), richConversation(4).text()]);
    assert.equal(p.conversations, 2);
    assert.equal(p.conversationsWithCurrentNode, 1);
  });

  it('role names are preserved verbatim, including hostile ones (no prototype pollution)', async () => {
    const b = new ConversationBuilder({ id: syntheticUuid(5) });
    const root = b.root();
    let prev = root;
    for (const role of ['__proto__', 'constructor', 'Function', 'hasOwnProperty']) prev = b.message(prev, role, { content_type: 'text', parts: ['x'] });
    const p = await profileOf([b.text()]);
    assert.deepEqual(Object.keys(p.roleCounts).sort(), ['Function', '__proto__', 'constructor', 'hasOwnProperty']);
    assert.equal(Object.getPrototypeOf(p.roleCounts), Object.prototype, 'the prototype was not replaced');
    assert.equal(Object.hasOwn(p.roleCounts, '__proto__'), true);
  });

  it('layout, manifest, auxiliary and extension-less asset facts come from the container', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const manifest = JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files: ['conversations-000.json', 'conversations-001.json'], sharded: true } } });
        await writeFile(
          join(dir, 'e.zip'),
          zipOf({
            'conversations-000.json': `[${richConversation(1).text()}]`,
            'conversations-001.json': `[${richConversation(2).text()}]`,
            'export_manifest.json': manifest,
            'user.json': '{}',
            'user_settings.json': '{}',
            'file-0000000000000001.dat': 'x',
          }),
        );
        const r = await runImport(t.repo, { source: { kind: 'path', path: join(dir, 'e.zip') }, clock: fixedClock });
        assert.equal(r.formatProfile?.layout, 'sharded');
        assert.equal(r.formatProfile?.manifest, 'present');
        assert.equal(r.formatProfile?.auxiliaryFilesIgnored, 2);
        assert.equal(r.formatProfile?.assetsExtensionless, true);
        assert.ok(!r.warnings.some((w) => w.code.startsWith('MANIFEST')));
        // A malformed manifest is reported as invalid, and the import still works.
        await writeFile(join(dir, 'f.zip'), zipOf({ 'conversations-000.json': `[${richConversation(3).text()}]`, 'conversations-001.json': '[]', 'export_manifest.json': '{nope' }));
        const bad = await runImport(t.repo, { source: { kind: 'path', path: join(dir, 'f.zip') }, clock: fixedClock });
        assert.equal(bad.formatProfile?.manifest, 'invalid');
        assert.equal(bad.warnings.find((w) => w.code === 'MANIFEST_INVALID')?.count, 1);
        assert.equal(bad.conversations.stored, 1);
      });
    } finally {
      t.close();
    }
  });

  it('manifest problems are warnings by default and abort under --strict', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const manifest = JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files: ['conversations-000.json', 'conversations-009.json'] } } });
        await writeFile(join(dir, 'e.zip'), zipOf({ 'conversations-000.json': `[${richConversation(1).text()}]`, 'conversations-001.json': '[]', 'export_manifest.json': manifest }));
        const r = await runImport(t.repo, { source: { kind: 'path', path: join(dir, 'e.zip') }, clock: fixedClock });
        assert.equal(r.warnings.find((w) => w.code === 'MANIFEST_SHARD_MISSING')?.count, 1);
        assert.equal(r.warnings.find((w) => w.code === 'SHARD_NOT_IN_MANIFEST')?.count, 1);
        await assert.rejects(
          runImport(freshRepo().repo, { source: { kind: 'path', path: join(dir, 'e.zip') }, strict: true, clock: fixedClock }),
          (e: unknown) => (e as { code?: string }).code === 'IMPORT_UNSUPPORTED_FORMAT' && (e as { details?: Record<string, unknown> }).details?.['reason'] === 'MANIFEST_SHARD_MISSING',
        );
      });
    } finally {
      t.close();
    }
  });

  it('Claude exports: user/assistant roles, no children anywhere, no literal root', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', JSON.stringify([claudeLinearConversation(4, { uuid: synthUuid(1) })]));
        const r = await runImport(t.repo, { source: { kind: 'path', path: file }, clock: fixedClock });
        const p = r.formatProfile;
        assert.ok(p);
        assert.deepEqual(Object.keys(p.roleCounts).sort(), ['assistant', 'user']);
        assert.equal(p.rootIsLiteralClientCreatedRoot, false);
        assert.equal(p.nodesWithChildrenDeclared, 0);
        assert.ok(r.warnings.some((w) => w.code === 'LINEAR_EXPORT_ACTIVE_BRANCH_ONLY'));
        assert.equal(t.repo.getBatch(r.batchId)?.completeness, 'rendered_active_view_only');
      });
    } finally {
      t.close();
    }
  });

  it('the batch row says "nominal" and a warning reports conversations that turned out weaker', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        // mapping = [] is invalid: the adapter keeps the conversation but lowers its completeness.
        const weak = JSON.parse(richConversation(2).text()) as Record<string, unknown>;
        weak['mapping'] = {};
        const body = `[${richConversation(1).text()},${JSON.stringify(weak)}]`;
        const file = await writeFileIn(dir, 'conversations.json', body);
        const r = await runImport(t.repo, { source: { kind: 'path', path: file }, clock: fixedClock });
        assert.equal(t.repo.getBatch(r.batchId)?.completeness, 'exported_tree', 'nominal level, fixed before any adapter ran');
        const w = r.warnings.find((x) => x.code === 'COMPLETENESS_BELOW_BATCH_LEVEL');
        assert.ok(w, 'weaker conversations are reported');
        assert.equal(w.count, 1);
        assert.deepEqual(w.sampleIds, [syntheticUuid(2)]);
        assert.notEqual(t.repo.getConversation({ conversationId: syntheticUuid(2) })?.completeness, 'exported_tree');
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(1) })?.completeness, 'exported_tree');
      });
    } finally {
      t.close();
    }
  });
});
