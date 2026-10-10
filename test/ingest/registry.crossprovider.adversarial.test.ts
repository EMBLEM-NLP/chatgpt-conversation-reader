/**
 * Independent adversarial review, integration level (lens: id collisions across providers and accounts, provider
 * confusion): the SAME conversation uuid and the SAME message uuids arrive from a Claude export (two accounts) and a
 * ChatGPT export, go through the real registry, the real import runner and a real in-memory SQLite repository, and must
 * stay three unrelated records. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import { GcrError } from '../../src/errors.js';
import { runImport } from '../../src/ingest/import-runner.js';
import type { ImportOptions } from '../../src/ingest/import-runner.js';
import { claudeConversation, claudeMessage, elementText, synthUuid } from '../helpers/claude-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';

const CLOCK = (): string => '2026-02-03T04:05:06.007Z';
const SAME = synthUuid(4242);
const SHARED_MSG = 'shared-message-id';

/** A minimal ChatGPT-shaped conversation element (invented data) that reuses the same ids as the Claude one. */
function chatgptElement(): string {
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
    id: SAME,
    conversation_id: SAME,
    title: 'GCR-SYNTHETIC-FIXTURE chatgpt side',
    create_time: 1_741_064_767.123,
    update_time: 1_741_064_900.5,
    current_node: 'gpt-2',
    mapping: {
      'root-node': { id: 'root-node', message: null, parent: null, children: [SHARED_MSG] },
      [SHARED_MSG]: { id: SHARED_MSG, message: message(SHARED_MSG, 'user', 'chatgpt user turn', 1_741_064_767.5), parent: 'root-node', children: ['gpt-2'] },
      'gpt-2': { id: 'gpt-2', message: message('gpt-2', 'assistant', 'chatgpt assistant turn', 1_741_064_800.5), parent: SHARED_MSG, children: [] },
    },
  });
}

function claudeElement(): string {
  return elementText(claudeConversation([claudeMessage(0, { uuid: SHARED_MSG, text: 'claude user turn', content: [{ type: 'text', text: 'claude user turn' }] }), claudeMessage(1)], { uuid: SAME }));
}

async function put(dir: string, name: string, text: string): Promise<ImportOptions['source']> {
  const file = join(dir, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return { kind: 'path', path: file };
}

function withRepo<T>(fn: (repo: Repository, rows: () => Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const h = openDatabase(':memory:');
  const repo = new Repository(h.db);
  const rows = (): Array<Record<string, unknown>> =>
    h.db.prepare('SELECT provider, account_label, conversation_id, provenance, completeness, message_count FROM conversations ORDER BY provider, account_label').all();
  return fn(repo, rows).finally(() => closeDatabase(h));
}

describe('one uuid, three sources: claude/default, claude/work, chatgpt/default', () => {
  it('stay three distinct stored records with their own provider, provenance, completeness and messages', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo, rows) => {
        const claudeSrc = await put(dir, 'claude/conversations.json', `[${claudeElement()}]`);
        const gptSrc = await put(dir, 'chatgpt/conversations.json', `[${chatgptElement()}]`);
        const a = await runImport(repo, { source: claudeSrc, clock: CLOCK });
        const b = await runImport(repo, { source: claudeSrc, clock: CLOCK, accountLabel: 'work' });
        const c = await runImport(repo, { source: gptSrc, clock: CLOCK });
        assert.deepEqual([a.provider, b.provider, c.provider], ['claude', 'claude', 'chatgpt']);
        assert.equal(new Set([a.batchId, b.batchId, c.batchId]).size, 3, 'three batches');

        assert.deepEqual(
          rows().map((r) => [r['provider'], r['account_label'], r['conversation_id'], r['provenance'], r['completeness']]),
          [
            ['chatgpt', 'default', SAME, 'official_chatgpt_export', 'exported_tree'],
            ['claude', 'default', SAME, 'official_claude_export', 'rendered_active_view_only'],
            ['claude', 'work', SAME, 'official_claude_export', 'rendered_active_view_only'],
          ],
        );

        const claude = repo.getConversation({ conversationId: SAME, provider: 'claude', accountLabel: 'default' });
        const work = repo.getConversation({ conversationId: SAME, provider: 'claude', accountLabel: 'work' });
        const gpt = repo.getConversation({ conversationId: SAME, provider: 'chatgpt' });
        assert.ok(claude && work && gpt);
        for (const rec of [claude, work]) {
          assert.equal(rec.provider, 'claude');
          assert.equal(rec.messages.length, 2);
          assert.ok(rec.messages.some((m) => m.id === SHARED_MSG && m.text === 'claude user turn'));
          assert.ok(rec.messages.every((m) => m.conversationId === SAME));
        }
        assert.equal(gpt.provider, 'chatgpt');
        assert.ok(gpt.messages.some((m) => m.id === SHARED_MSG && m.text === 'chatgpt user turn'), 'the ChatGPT message with the shared id kept ITS text');
        assert.ok(!gpt.messages.some((m) => m.text.includes('claude')), 'no Claude text leaked into the ChatGPT record');
        assert.ok(!claude.messages.some((m) => m.text.includes('chatgpt')), 'no ChatGPT text leaked into the Claude record');
      });
    });
  });

  it('an unqualified lookup of the shared uuid is AMBIGUOUS_CONVERSATION (never silently one of them); qualifying by provider alone is not enough when two accounts exist', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo) => {
        const claudeSrc = await put(dir, 'claude/conversations.json', `[${claudeElement()}]`);
        const gptSrc = await put(dir, 'chatgpt/conversations.json', `[${chatgptElement()}]`);
        await runImport(repo, { source: claudeSrc, clock: CLOCK });
        await runImport(repo, { source: claudeSrc, clock: CLOCK, accountLabel: 'work' });
        await runImport(repo, { source: gptSrc, clock: CLOCK });
        for (const ref of [{ conversationId: SAME }, { conversationId: SAME, provider: 'claude' as const }]) {
          assert.throws(() => repo.getConversation(ref), (e: unknown) => e instanceof GcrError && e.code === 'AMBIGUOUS_CONVERSATION', JSON.stringify(ref));
        }
      });
    });
  });

  it('re-importing the same Claude file is an idempotent no-op; the same bytes under another account label are a separate batch', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo, rows) => {
        const src = await put(dir, 'conversations.json', `[${claudeElement()}]`);
        const first = await runImport(repo, { source: src, clock: CLOCK });
        const again = await runImport(repo, { source: src, clock: CLOCK });
        assert.equal(first.alreadyImported, false);
        assert.equal(again.alreadyImported, true);
        assert.equal(again.batchId, first.batchId);
        assert.equal(rows().length, 1);
        const other = await runImport(repo, { source: src, clock: CLOCK, accountLabel: 'other' });
        assert.notEqual(other.batchId, first.batchId);
        assert.equal(rows().length, 2);
      });
    });
  });
});

describe('forcing the wrong provider never relabels data', () => {
  it('a Claude export forced to "chatgpt" stores no conversation at all (and says why); the Claude adapter on a ChatGPT export likewise', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo, rows) => {
        const claudeSrc = await put(dir, 'claude/conversations.json', `[${claudeElement()}]`);
        const gptSrc = await put(dir, 'chatgpt/conversations.json', `[${chatgptElement()}]`);
        const wrong1 = await runImport(repo, { source: claudeSrc, clock: CLOCK, provider: 'chatgpt' });
        assert.equal(wrong1.conversations.stored, 0);
        assert.ok(wrong1.warnings.some((w) => w.code === 'PROVIDER_MISMATCH'));
        const wrong2 = await runImport(repo, { source: gptSrc, clock: CLOCK, provider: 'claude' });
        assert.equal(wrong2.conversations.stored, 0);
        assert.ok(wrong2.warnings.some((w) => w.code === 'PROVIDER_MISMATCH'));
        assert.deepEqual(rows(), [], 'no conversation row exists: nothing was stored under either provider');
      });
    });
  });

  it('strict mode turns the mismatch into an error instead of an empty import', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo, rows) => {
        const claudeSrc = await put(dir, 'conversations.json', `[${claudeElement()}]`);
        await assert.rejects(runImport(repo, { source: claudeSrc, clock: CLOCK, provider: 'chatgpt', strict: true }), (e: unknown) => e instanceof GcrError && e.code === 'IMPORT_UNSUPPORTED_FORMAT');
        assert.deepEqual(rows(), []);
      });
    });
  });
});
