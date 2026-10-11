/**
 * Integration level for the second adversarial review of the Claude adapter: what the adapter reports must survive the REAL
 * registry, import runner and SQLite repository (nothing mocked). Covers the skipped-entry preservation and the duplicate-key
 * report (L1 / L2), the committed fixtures end to end, and the provider-confusion invariants of a whole import. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { runImport } from '../../src/ingest/import-runner.js';
import type { ImportOptions } from '../../src/ingest/import-runner.js';
import { CLAUDE_FIXTURE_FILES, claudeConversation, claudeMessage, elementText, readFixtureText, synthUuid } from '../helpers/claude-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';

type Obj = Record<string, unknown>;

const CLOCK = (): string => '2026-02-03T04:05:06.007Z';

async function put(dir: string, name: string, text: string): Promise<ImportOptions['source']> {
  const file = join(dir, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return { kind: 'path', path: file };
}

function withRepo<T>(fn: (repo: Repository, sql: (q: string, ...p: Array<string | number>) => Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const h = openDatabase(':memory:');
  const repo = new Repository(h.db);
  const sql = (q: string, ...p: Array<string | number>): Array<Record<string, unknown>> => h.db.prepare(q).all(...p) as Array<Record<string, unknown>>;
  return fn(repo, sql).finally(() => closeDatabase(h));
}

describe('L1 through the real pipeline: skipped chat_messages entries survive storage', () => {
  it('the raw value of a non-object entry is in the stored conversation, and the import report counts the warning', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo) => {
        const id = synthUuid(5150);
        const element = elementText(claudeConversation([claudeMessage(0), 'PIPELINE-PRECIOUS-STRING' as never, claudeMessage(2)], { uuid: id }));
        const report = await runImport(repo, { source: await put(dir, 'conversations.json', `[${element}]`), clock: CLOCK });
        assert.equal(report.provider, 'claude');
        assert.equal(report.conversations.stored, 1);
        assert.equal(report.messages.stored, 2);
        assert.equal(report.warnings.find((w) => w.code === 'NON_OBJECT_MESSAGE')?.count, 1);
        const stored = repo.getConversation({ conversationId: id, provider: 'claude' }) as ConversationRecord | undefined;
        assert.ok(stored !== undefined);
        const gcr = (stored.rawMetadata as Obj)['_gcr'] as Obj;
        assert.deepEqual(gcr['nonObjectChatMessages'], [{ ordinal: 1, value: 'PIPELINE-PRECIOUS-STRING' }]);
        assert.deepEqual(stored.messages.map((m) => m.ordinal), [0, 2]);
      });
    });
  });
});

describe('L2 through the real pipeline: duplicate keys are visible in the stored warnings', () => {
  it('a repeated chat_messages key is reported by the importer with its count, per conversation', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo, sql) => {
        const id = synthUuid(5151);
        const m = (n: number): string => JSON.stringify(claudeMessage(n));
        const text = `[{"uuid":"${id}","chat_messages":[${m(0)}],"chat_messages":[${m(1)}]},${elementText(claudeConversation([claudeMessage(2)], { uuid: synthUuid(5152) }))}]`;
        const report = await runImport(repo, { source: await put(dir, 'conversations.json', text), clock: CLOCK });
        const w = report.warnings.find((x) => x.code === 'DUPLICATE_KEY');
        assert.ok(w !== undefined, 'the report lists DUPLICATE_KEY');
        assert.equal(w.count, 1);
        assert.deepEqual(w.sampleIds, [id]);
        const rows = sql('SELECT conversation_id, warnings_json FROM conversations ORDER BY conversation_id');
        const withDup = rows.filter((r) => String(r['warnings_json']).includes('DUPLICATE_KEY'));
        assert.deepEqual(withDup.map((r) => r['conversation_id']), [id], 'only the damaged conversation carries the warning');
      });
    });
  });
});

describe('the committed Claude fixtures import end to end', () => {
  for (const file of CLAUDE_FIXTURE_FILES) {
    it(`${file}: every conversation is stored as a Claude record with the active-view completeness, none fails`, async () => {
      await withTempDir(async (dir) => {
        await withRepo(async (repo, sql) => {
          const elements = JSON.parse(readFixtureText(file)) as unknown[];
          const report = await runImport(repo, { source: await put(dir, 'conversations.json', readFixtureText(file)), clock: CLOCK });
          assert.equal(report.provider, 'claude');
          assert.equal(report.conversations.failed, 0);
          assert.equal(report.conversations.stored, elements.length);
          for (const row of sql('SELECT provider, provenance, completeness FROM conversations')) {
            assert.deepEqual([row['provider'], row['provenance'], row['completeness']], ['claude', 'official_claude_export', 'rendered_active_view_only']);
          }
          // Every Claude conversation says, in its stored warnings, that it is the active view only.
          assert.equal(sql("SELECT COUNT(*) AS n FROM conversations WHERE warnings_json NOT LIKE '%LINEAR_EXPORT_ACTIVE_BRANCH_ONLY%'")[0]?.['n'], 0);
        });
      });
    });
  }

  it('a re-import of the hostile fixture is an idempotent no-op that reproduces the first report', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo) => {
        const src = await put(dir, 'conversations.json', readFixtureText('hostile-strings.json'));
        const first = await runImport(repo, { source: src, clock: CLOCK });
        const second = await runImport(repo, { source: src, clock: CLOCK });
        assert.equal(second.alreadyImported, true);
        assert.deepEqual(second.warnings, first.warnings);
        assert.equal(second.batchId, first.batchId);
      });
    });
  });
});

describe('provider confusion across a whole import', () => {
  it('a Claude file whose FIRST element is damaged or not a conversation is still attributed to Claude, never to ChatGPT', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo) => {
        const good = elementText(claudeConversation([claudeMessage(0)], { uuid: synthUuid(6001) }));
        const text = `[{}, null, {"uuid":"a-project","name":"not a conversation"}, ${good}]`;
        const report = await runImport(repo, { source: await put(dir, 'conversations.json', text), clock: CLOCK });
        assert.equal(report.provider, 'claude');
        assert.equal(report.conversations.stored, 1);
      });
    });
  });

  it('a file that mixes a Claude and a ChatGPT element is refused as MIXED_PROVIDERS, not imported under one label', async () => {
    await withTempDir(async (dir) => {
      await withRepo(async (repo, sql) => {
        await put(dir, 'both/conversations-000.json', `[${elementText(claudeConversation([claudeMessage(0)], { uuid: synthUuid(6002) }))}]`);
        await put(dir, 'both/conversations-001.json', '[{"id":"6ac95b6e-9fa0-83e8-bbb0-8107079a8720","mapping":{},"current_node":null}]');
        await assert.rejects(runImport(repo, { source: { kind: 'path', path: join(dir, 'both') }, clock: CLOCK }), (e: unknown) => (e as { code?: string }).code === 'IMPORT_UNSUPPORTED_FORMAT');
        assert.equal(sql('SELECT COUNT(*) AS n FROM conversations')[0]?.['n'], 0, 'nothing was stored under either label');
      });
    });
  });
});
