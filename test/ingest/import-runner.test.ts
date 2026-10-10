/**
 * Import runner: end-to-end behaviour against a REAL Repository (:memory: SQLite, no mocks) for every input layout,
 * wrapper/NDJSON/empty/corrupt inputs, strict mode, provider detection and account scoping. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { peekElement, runImport } from '../../src/ingest/import-runner.js';
import type { ImportOptions } from '../../src/ingest/import-runner.js';
import { TOOL_VERSION } from '../../src/version.js';
import { ConversationBuilder, SYNTHETIC_MARKER, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { claudeLinearConversation, synthUuid } from '../helpers/claude-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { arrayOf, chatConv, chunked, claudeArray, count, expectCode, fixedClock, freshRepo, writeFileIn, zipOf } from './import-runner.helpers.test.js';

const path = (p: string): ImportOptions['source'] => ({ kind: 'path', path: p });

describe('layouts end to end', () => {
  it('single conversations.json: counts, report fields, stored provenance', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1, { pairs: 2 }), chatConv(2, { pairs: 1 })]));
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.match(r.batchId, /^b_[0-9a-f]{32}$/);
        assert.equal(r.provider, 'chatgpt');
        assert.equal(r.accountLabel, 'default');
        assert.equal(r.sourceKind, 'conversations_json');
        assert.equal(r.sourceLabel, 'conversations.json');
        assert.equal(r.alreadyImported, false);
        assert.deepEqual(r.files, [{ name: 'conversations.json', conversations: 2, failed: 0 }]);
        assert.deepEqual(r.conversations, { read: 2, stored: 2, failed: 0, newlyInserted: 2 });
        // 2 structural roots + 4 + 2 real messages
        assert.deepEqual(r.messages, { stored: 8, newlyInserted: 8, structural: 2 });
        assert.equal(r.formatProfile?.layout, 'single');
        assert.ok(r.durationMs >= 0);
        const b = t.repo.getBatch(r.batchId);
        assert.ok(b);
        assert.equal(b.provenance, 'official_chatgpt_export');
        assert.equal(b.completeness, 'exported_tree');
        assert.equal(b.sourceKind, 'conversations_json');
        assert.equal(b.sourceLabel, 'conversations.json');
        assert.equal(b.toolVersion, TOOL_VERSION);
        assert.equal(b.importedAt, '2026-02-03T04:05:06.007Z');
        assert.equal(b.conversationCount, 2);
        assert.equal(b.messageCount, 6);
        const rec = t.repo.getConversation({ conversationId: syntheticUuid(1) });
        assert.ok(rec);
        assert.equal(rec.title?.includes(SYNTHETIC_MARKER), true);
      });
    } finally {
      t.close();
    }
  });

  it('a bare ZIP with auxiliary files and assets: auxiliary content never reaches the database or the report', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const pii = 'PLANTED-PII-user@example.invalid-0000';
        const zip = zipOf({
          'conversations.json': arrayOf([chatConv(1)]),
          'user.json': JSON.stringify({ email: pii }),
          'message_feedback.json': JSON.stringify([{ text: pii }]),
          'chat.html': `<html>${pii}</html>`,
          'file-0001.dat': 'binary-ish',
        });
        await writeFile(join(dir, 'export.zip'), zip);
        const r = await runImport(t.repo, { source: path(join(dir, 'export.zip')), clock: fixedClock });
        assert.equal(r.sourceKind, 'zip');
        assert.equal(r.sourceLabel, 'export.zip');
        assert.equal(r.formatProfile?.auxiliaryFilesIgnored, 3);
        assert.equal(r.formatProfile?.assetsExtensionless, true);
        assert.ok(!JSON.stringify(r).includes(pii));
        const dump = JSON.stringify(
          ['source_batches', 'conversations', 'messages'].map((tb) => t.db.prepare(`SELECT * FROM ${tb}`).all()),
        );
        assert.ok(!dump.includes(pii), 'auxiliary files are never read');
      });
    } finally {
      t.close();
    }
  });

  it('sharded ZIP: shards are processed in numeric order and reported per file', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const zip = zipOf({
          'conversations-10.json': arrayOf([chatConv(10)]),
          'conversations-2.json': arrayOf([chatConv(2), chatConv(3)]),
          'conversations-1.json': arrayOf([chatConv(1)]),
        });
        await writeFile(join(dir, 'e.zip'), zip);
        const r = await runImport(t.repo, { source: path(join(dir, 'e.zip')), clock: fixedClock });
        assert.deepEqual(r.files.map((f) => [f.name, f.conversations]), [['conversations-1.json', 1], ['conversations-2.json', 2], ['conversations-10.json', 1]]);
        assert.equal(r.formatProfile?.layout, 'sharded');
        assert.deepEqual(r.conversations, { read: 4, stored: 4, failed: 0, newlyInserted: 4 });
        assert.ok(r.warnings.some((w) => w.code === 'MANIFEST_ABSENT'));
      });
    } finally {
      t.close();
    }
  });

  it('extracted folder: sourceKind directory, label is the folder name', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        await writeFileIn(dir, 'my-export/conversations-0.json', arrayOf([chatConv(1)]));
        await writeFileIn(dir, 'my-export/conversations-1.json', arrayOf([chatConv(2)]));
        const r = await runImport(t.repo, { source: path(join(dir, 'my-export')), clock: fixedClock });
        assert.equal(r.sourceKind, 'directory');
        assert.equal(r.sourceLabel, 'my-export');
        assert.equal(r.formatProfile?.layout, 'directory');
        assert.equal(r.conversations.stored, 2);
      });
    } finally {
      t.close();
    }
  });

  it('stdin stream: sourceKind stdin_json, chunked arbitrarily', async () => {
    const t = freshRepo();
    try {
      const r = await runImport(t.repo, { source: { kind: 'stream', stream: chunked(arrayOf([chatConv(1), chatConv(2)]), 3), label: '-' }, clock: fixedClock });
      assert.equal(r.sourceKind, 'stdin_json');
      assert.equal(r.formatProfile?.layout, 'stdin');
      assert.equal(r.conversations.stored, 2);
    } finally {
      t.close();
    }
  });

  it('nested ZIP (one level): the inner shards are imported', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const inner = zipOf({ 'conversations-000.json': arrayOf([chatConv(1)]), 'conversations-001.json': arrayOf([chatConv(2)]) });
        const { buildZip } = await import('../helpers/zip-builder.js');
        const outer = buildZip([
          { name: 'Conversations__SYNTHETIC-part-001.zip', data: inner, method: 'store' },
          { name: 'Files__SYNTHETIC-files-001.zip', data: zipOf({ 'file-1.dat': 'x' }), method: 'store' },
        ]);
        await writeFile(join(dir, 'portal.zip'), outer);
        const r = await runImport(t.repo, { source: path(join(dir, 'portal.zip')), clock: fixedClock });
        assert.equal(r.formatProfile?.layout, 'nested');
        assert.equal(r.sourceKind, 'zip');
        assert.equal(r.conversations.stored, 2);
        assert.deepEqual(r.files.map((f) => f.name), ['Conversations__SYNTHETIC-part-001.zip!/conversations-000.json', 'Conversations__SYNTHETIC-part-001.zip!/conversations-001.json']);
      });
    } finally {
      t.close();
    }
  });

  it('NDJSON (one conversation per line) and a single top-level conversation object are accepted', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const lines = [chatConv(1).text(), chatConv(2).text(), chatConv(3).text()].join('\n') + '\n';
        const nd = await writeFileIn(dir, 'lines.json', lines);
        const r = await runImport(t.repo, { source: path(nd), clock: fixedClock });
        assert.equal(r.conversations.stored, 3);
        assert.equal(r.files[0]?.conversations, 3);

        const single = await writeFileIn(dir, 'one.json', chatConv(4).text());
        const r2 = await runImport(t.repo, { source: path(single), clock: fixedClock });
        assert.equal(r2.conversations.stored, 1);
      });
    } finally {
      t.close();
    }
  });

  it('a UTF-8 BOM and CRLF/pretty-printed JSON are fine', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const body = '\ufeff' + JSON.stringify(JSON.parse(arrayOf([chatConv(1)])), null, 2).replaceAll('\n', '\r\n');
        const file = await writeFileIn(dir, 'conversations.json', body);
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(r.conversations.stored, 1);
      });
    } finally {
      t.close();
    }
  });
});

describe('degenerate inputs', () => {
  it('an empty export ([]) is a clean zero-count report and a stored (empty) batch', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', '[]');
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.deepEqual(r.conversations, { read: 0, stored: 0, failed: 0, newlyInserted: 0 });
        assert.deepEqual(r.messages, { stored: 0, newlyInserted: 0, structural: 0 });
        assert.deepEqual(r.warnings, []);
        assert.equal(t.repo.getBatch(r.batchId)?.completeness, 'unknown', 'nothing was observed, so nothing is claimed');
      });
    } finally {
      t.close();
    }
  });

  it('{} and null / scalar entries are skipped and COUNTED, other elements import', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const body = `[${chatConv(1).text()},{},null,42,"s",[1],${chatConv(2).text()},{}]`;
        const file = await writeFileIn(dir, 'conversations.json', body);
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.deepEqual(r.conversations, { read: 8, stored: 2, failed: 0, newlyInserted: 2 });
        const byCode = Object.fromEntries(r.warnings.map((w) => [w.code, w.count]));
        assert.equal(byCode['EMPTY_CONVERSATION_ENTRY'], 2);
        assert.equal(byCode['NON_OBJECT_ENTRY'], 4);
        const empty = r.warnings.find((w) => w.code === 'EMPTY_CONVERSATION_ENTRY');
        assert.deepEqual(empty?.sampleIds, ['conversations.json#1', 'conversations.json#7']);
      });
    } finally {
      t.close();
    }
  });

  it('a file with only {} entries is a clean zero-count report (EC-63)', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', '[{},{}]');
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(r.conversations.stored, 0);
        assert.equal(r.warnings.find((w) => w.code === 'EMPTY_CONVERSATION_ENTRY')?.count, 2);
      });
    } finally {
      t.close();
    }
  });

  it('a wrapper object {"conversations": [...]} is unwrapped (WRAPPER_OBJECT_FORMAT) and flagged in the profile', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const inner = JSON.parse(chatConv(1).text()) as unknown;
        const inner2 = JSON.parse(chatConv(2).text()) as unknown;
        const file = await writeFileIn(dir, 'conversations.json', JSON.stringify({ conversations: [inner, inner2, {}], exported_at: 'x' }));
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(r.conversations.stored, 2);
        assert.equal(r.formatProfile?.wrapperObject, true);
        assert.equal(r.warnings.find((w) => w.code === 'WRAPPER_OBJECT_FORMAT')?.count, 1);
        assert.equal(r.warnings.find((w) => w.code === 'EMPTY_CONVERSATION_ENTRY')?.count, 1);
        assert.deepEqual(r.files, [{ name: 'conversations.json', conversations: 3, failed: 0 }]);
      });
    } finally {
      t.close();
    }
  });

  it('an object with a "mapping" key is never UNWRAPPED by the runner (the adapter then decides; today it skips such an object)', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const conv = JSON.parse(chatConv(1).text()) as Record<string, unknown>;
        conv['conversations'] = [JSON.parse(chatConv(2).text())];
        const file = await writeFileIn(dir, 'conversations.json', JSON.stringify([conv]));
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(r.formatProfile?.wrapperObject, false, 'the wrapper rule requires "conversations" WITHOUT "mapping"');
        assert.ok(!r.warnings.some((w) => w.code === 'WRAPPER_OBJECT_FORMAT'));
        // ChatGPTExportAdapter treats any object with a "conversations" array as a non-conversation (NOT_A_CONVERSATION).
        assert.equal(r.warnings.find((w) => w.code === 'NOT_A_CONVERSATION')?.count, 1);
        assert.equal(r.conversations.stored, 0);
      });
    } finally {
      t.close();
    }
  });

  it('one corrupt element among good ones: the default run continues and reports it (ids and counts only)', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        // Well-framed (balanced braces) but not valid JSON inside: the adapter rejects it.
        const body = `[${chatConv(1).text()},{"mapping": PLANTED_BROKEN_VALUE},${chatConv(2).text()}]`;
        const file = await writeFileIn(dir, 'conversations.json', body);
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.deepEqual(r.conversations, { read: 3, stored: 2, failed: 1, newlyInserted: 2 });
        assert.deepEqual(r.files, [{ name: 'conversations.json', conversations: 3, failed: 1 }]);
        const w = r.warnings.find((x) => x.code === 'ELEMENT_PARSE_FAILED');
        assert.equal(w?.count, 1);
        assert.deepEqual(w?.sampleIds, ['conversations.json#1']);
        assert.ok(!JSON.stringify(r).includes('PLANTED_BROKEN_VALUE'));
      });
    } finally {
      t.close();
    }
  });

  it('--strict aborts on the first element failure with the precise error and stores NOTHING', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const body = `[${chatConv(1).text()},${chatConv(2).text()},{"mapping": PLANTED_BROKEN_VALUE},${chatConv(3).text()}]`;
        const file = await writeFileIn(dir, 'conversations.json', body);
        await assert.rejects(runImport(t.repo, { source: path(file), strict: true, clock: fixedClock }), (e: unknown) => {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'IMPORT_PARSE_ERROR');
          assert.equal(e.details?.['file'], 'conversations.json');
          assert.equal(e.details?.['elementIndex'], 2);
          assert.equal(e.details?.['strict'], true);
          assert.ok(!JSON.stringify([e.message, e.details, e.remedy]).includes('PLANTED_BROKEN_VALUE'));
          return true;
        });
        for (const tb of ['source_batches', 'conversations', 'messages', 'conversation_heads']) assert.equal(count(t.db, tb), 0, tb);
      });
    } finally {
      t.close();
    }
  });

  it('strict also rejects an object that is not a conversation of the provider, but not mere {} / null entries', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const tolerated = await writeFileIn(dir, 'a/conversations.json', `[${chatConv(1).text()},{},null]`);
        const ok = await runImport(t.repo, { source: path(tolerated), strict: true, clock: fixedClock });
        assert.equal(ok.conversations.stored, 1);

        const notConv = await writeFileIn(dir, 'b/conversations.json', `[${chatConv(2).text()},{"hello":"world"}]`);
        await assert.rejects(runImport(t.repo, { source: path(notConv), strict: true, clock: fixedClock }), expectCode('IMPORT_PARSE_ERROR', 'NOT_A_CONVERSATION'));
        assert.equal(count(t.db, 'source_batches'), 1);
      });
    } finally {
      t.close();
    }
  });

  it('a truncated file keeps the elements before the break (FILE_PARSE_FAILED); strict aborts; nothing readable fails loudly', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const full = arrayOf([chatConv(1), chatConv(2), chatConv(3)]);
        const cut = full.slice(0, full.lastIndexOf('{"id"') + 40); // cut inside the third conversation
        const file = await writeFileIn(dir, 'a/conversations.json', cut);
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(r.conversations.stored, 2);
        assert.equal(r.conversations.failed, 1);
        assert.deepEqual(r.warnings.find((w) => w.code === 'FILE_PARSE_FAILED')?.sampleIds, ['conversations.json']);
        assert.deepEqual(r.files, [{ name: 'conversations.json', conversations: 2, failed: 1 }]);

        const t2 = freshRepo();
        try {
          await assert.rejects(runImport(t2.repo, { source: path(file), strict: true, clock: fixedClock }), expectCode('IMPORT_PARSE_ERROR'));
          assert.equal(count(t2.db, 'source_batches'), 0);
          const nothing = await writeFileIn(dir, 'b/conversations.json', '[{"id": "x", "mapping": {');
          await assert.rejects(runImport(t2.repo, { source: path(nothing), clock: fixedClock }), expectCode('IMPORT_PARSE_ERROR'));
          assert.equal(count(t2.db, 'source_batches'), 0);
        } finally {
          t2.close();
        }
      });
    } finally {
      t.close();
    }
  });

  it('a UTF-16 conversations file inside an otherwise fine ZIP is refused with the UTF-8 remedy', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(arrayOf([chatConv(1)]), 'utf16le')]);
        await writeFile(join(dir, 'e.zip'), zipOf({ 'conversations.json': utf16 }));
        await assert.rejects(runImport(t.repo, { source: path(join(dir, 'e.zip')), clock: fixedClock }), (e: unknown) => {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
          assert.match(e.remedy ?? '', /UTF-8/);
          return true;
        });
        assert.equal(count(t.db, 'source_batches'), 0);
      });
    } finally {
      t.close();
    }
  });

  it('an element larger than maxElementBytes fails with IMPORT_LIMIT_EXCEEDED and stores nothing', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1, { pairs: 20 })]));
        await assert.rejects(runImport(t.repo, { source: path(file), limits: { maxElementBytes: 500 }, clock: fixedClock }), expectCode('IMPORT_LIMIT_EXCEEDED'));
        assert.equal(count(t.db, 'source_batches'), 0);
      });
    } finally {
      t.close();
    }
  });

  it('a missing input is IMPORT_INPUT_NOT_FOUND', async () => {
    const t = freshRepo();
    try {
      await assert.rejects(runImport(t.repo, { source: path('/nonexistent-dir-for-gcr-tests/x.zip') }), expectCode('IMPORT_INPUT_NOT_FOUND'));
    } finally {
      t.close();
    }
  });
});

describe('provider handling', () => {
  it('auto-detects Claude exports and stores provider claude with the Claude provenance', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', claudeArray(3));
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(r.provider, 'claude');
        assert.equal(r.conversations.stored, 3);
        const b = t.repo.getBatch(r.batchId);
        assert.equal(b?.provenance, 'official_claude_export');
        assert.equal(b?.completeness, 'rendered_active_view_only');
        assert.equal(r.formatProfile?.nodesWithChildrenAbsent !== undefined, true);
      });
    } finally {
      t.close();
    }
  });

  it('a corrupt FIRST element does not prevent detection from a later one', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', `[{"mapping": oops},${JSON.stringify(claudeLinearConversation(2, { uuid: synthUuid(1) }))}]`);
        const r = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(r.provider, 'claude');
        assert.equal(r.conversations.stored, 1);
        assert.equal(r.conversations.failed, 1);
      });
    } finally {
      t.close();
    }
  });

  it('files of different providers in one import are rejected with a remedy to import them separately', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        await writeFileIn(dir, 'conversations-0.json', arrayOf([chatConv(1)]));
        await writeFileIn(dir, 'conversations-1.json', claudeArray(1));
        await assert.rejects(runImport(t.repo, { source: path(dir), clock: fixedClock }), (e: unknown) => {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
          assert.equal(e.details?.['reason'], 'MIXED_PROVIDERS');
          assert.match(e.remedy ?? '', /separately/);
          return true;
        });
        assert.equal(count(t.db, 'source_batches'), 0);
      });
    } finally {
      t.close();
    }
  });

  it('a forced provider that contradicts the data adds PROVIDER_MISMATCH and the elements are skipped per element', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1), chatConv(2)]));
        const r = await runImport(t.repo, { source: path(file), provider: 'claude', clock: fixedClock });
        assert.equal(r.provider, 'claude');
        assert.deepEqual(r.warnings.find((w) => w.code === 'PROVIDER_MISMATCH')?.sampleIds, ['conversations.json']);
        assert.equal(r.warnings.find((w) => w.code === 'NOT_A_CONVERSATION')?.count, 2);
        assert.equal(r.conversations.stored, 0);
        await assert.rejects(runImport(freshRepo().repo, { source: path(file), provider: 'claude', strict: true, clock: fixedClock }), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'PROVIDER_MISMATCH'));
      });
    } finally {
      t.close();
    }
  });

  it('a forced provider that matches is silent', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1)]));
        const r = await runImport(t.repo, { source: path(file), provider: 'chatgpt', clock: fixedClock });
        assert.ok(!r.warnings.some((w) => w.code === 'PROVIDER_MISMATCH'));
      });
    } finally {
      t.close();
    }
  });

  it('objects that are neither ChatGPT nor Claude conversations: PROVIDER_UNDETECTED with a remedy', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', '[{"foo": 1}]');
        await assert.rejects(runImport(t.repo, { source: path(file), clock: fixedClock }), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'PROVIDER_UNDETECTED'));
      });
    } finally {
      t.close();
    }
  });

  it('openai_api is not an import provider (NOT_IMPLEMENTED); unknown ids are INVALID_ARGUMENT', async () => {
    const t = freshRepo();
    try {
      await assert.rejects(runImport(t.repo, { source: path('x'), provider: 'openai_api' as never }), expectCode('NOT_IMPLEMENTED'));
      await assert.rejects(runImport(t.repo, { source: path('x'), provider: 'nope' as never }), expectCode('INVALID_ARGUMENT'));
    } finally {
      t.close();
    }
  });
});

describe('options', () => {
  it('account labels: the documented pattern is enforced, the value is never echoed', async () => {
    const t = freshRepo();
    try {
      for (const bad of ['', ' lead', '-x', 'a/b', 'a\nb', 'x'.repeat(65), 'PLANTED<script>', 'ü']) {
        await assert.rejects(runImport(t.repo, { source: path('x'), accountLabel: bad }), (e: unknown) => {
          assert.ok(e instanceof GcrError);
          assert.equal(e.code, 'INVALID_ARGUMENT');
          assert.ok(!JSON.stringify(e.toEnvelope()).includes('PLANTED'));
          return true;
        });
      }
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', '[]');
        for (const ok of ['default', 'work', 'Personal Account', 'a.b_c@d-e', 'x'.repeat(64)]) {
          const r = await runImport(t.repo, { source: path(file), accountLabel: ok, clock: fixedClock });
          assert.equal(r.accountLabel, ok);
        }
      });
    } finally {
      t.close();
    }
  });

  it('accountLabel isolates exports: same file, two accounts = two batches and no id collision', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1)]));
        const a = await runImport(t.repo, { source: path(file), accountLabel: 'alice', clock: fixedClock });
        const b = await runImport(t.repo, { source: path(file), accountLabel: 'bob', clock: fixedClock });
        assert.notEqual(a.batchId, b.batchId);
        assert.equal(b.alreadyImported, false);
        assert.equal(count(t.db, 'conversations'), 2);
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(1), accountLabel: 'alice' })?.accountLabel, 'alice');
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(1), accountLabel: 'bob' })?.accountLabel, 'bob');
        assert.throws(() => t.repo.getConversation({ conversationId: syntheticUuid(1) }), expectCode('AMBIGUOUS_CONVERSATION'));
      });
    } finally {
      t.close();
    }
  });

  it('the clock is injectable, called once, and must return an ISO-8601 UTC timestamp', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1)]));
        let calls = 0;
        await runImport(t.repo, { source: path(file), clock: () => ((calls++, '2030-01-02T03:04:05.000Z')) });
        assert.equal(calls, 1);
        const rec = t.repo.getConversation({ conversationId: syntheticUuid(1) });
        assert.equal(rec?.importedAt, '2030-01-02T03:04:05.000Z');
        await assert.rejects(runImport(t.repo, { source: path(file), clock: () => 'yesterday' }), expectCode('INVALID_ARGUMENT'));
        await assert.rejects(runImport(t.repo, { source: path(file), clock: 'now' as never }), expectCode('INVALID_ARGUMENT'));
        // The default clock works and is a valid ISO instant.
        const r = await runImport(t.repo, { source: path(file), accountLabel: 'other' });
        assert.match(t.repo.getBatch(r.batchId)?.importedAt ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      });
    } finally {
      t.close();
    }
  });

  it('onProgress receives phases, file names and counts only', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1, { title: 'PLANTED-TITLE-IN-PROGRESS' }), chatConv(2)]));
        const events: Array<{ phase: string; file: string; elements: number }> = [];
        await runImport(t.repo, { source: path(file), clock: fixedClock, onProgress: (p) => events.push({ ...p }) });
        assert.ok(events.some((e) => e.phase === 'scan'));
        assert.ok(events.some((e) => e.phase === 'import'));
        for (const e of events) {
          assert.deepEqual(Object.keys(e).sort(), ['elements', 'file', 'phase']);
          assert.equal(e.file, 'conversations.json');
          assert.equal(Number.isInteger(e.elements), true);
        }
        assert.ok(!JSON.stringify(events).includes('PLANTED'));
        await assert.rejects(runImport(t.repo, { source: path(file), onProgress: 5 as never }), expectCode('INVALID_ARGUMENT'));
      });
    } finally {
      t.close();
    }
  });

  it('limits are validated by the shared resolver; a read-only database is WRITE_FORBIDDEN', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', '[]');
        await assert.rejects(runImport(t.repo, { source: path(file), limits: { maxEntries: 0 } }), expectCode('INVALID_ARGUMENT'));
        await assert.rejects(runImport(t.repo, { source: path(file), limits: { bogus: 1 } as never }), expectCode('INVALID_ARGUMENT'));
        t.db.exec('PRAGMA query_only = ON');
        await assert.rejects(runImport(t.repo, { source: path(file), clock: fixedClock }), expectCode('WRITE_FORBIDDEN'));
      });
    } finally {
      t.close();
    }
  });
});

describe('peekElement (identity scanner)', () => {
  it('reads the identity fields without parsing values, last duplicate key wins, escapes are decoded', () => {
    const p = peekElement('{"title":"a \\" } { \\\\","id":"x","conversation_id":"C-1","update_time":1760000000.5,"mapping":{"a":{"id":"NOT-THIS","children":["]"]}},"id":"y"}');
    assert.equal(p.kind, 'object');
    assert.equal(p.conversationId, 'C-1');
    assert.equal(p.id, 'y');
    assert.equal(p.updateMs, 1760000000500);
    assert.equal(p.hasMapping, true);
    assert.equal(p.malformed, false);
  });

  it('classifies empty and non-object elements and survives malformed text without throwing', () => {
    assert.equal(peekElement('{}').kind, 'empty_object');
    assert.equal(peekElement('  { \n }').kind, 'empty_object');
    assert.equal(peekElement('[1]').kind, 'non_object');
    assert.equal(peekElement('null').kind, 'non_object');
    assert.equal(peekElement('').kind, 'non_object');
    for (const bad of ['{', '{"a"', '{"a":', '{"a":1', '{"a":1,', '{"a":[1,2', '{"a":"unterminated', '{1:2}', '{"a" 1}']) {
      const p = peekElement(bad);
      assert.equal(p.malformed, true, bad);
    }
  });

  it('keys written with escapes are decoded; the wrapper markers are detected', () => {
    const p = peekElement('{"\\u0069d":"esc","conversations":[1,2]}');
    assert.equal(p.id, 'esc');
    assert.equal(p.conversationsIsArray, true);
    assert.equal(p.hasMapping, false);
    assert.equal(peekElement('{"conversations":{}}').conversationsIsArray, false);
  });

  it('non-string ids and non-numeric times are ignored; Claude updated_at needs an explicit zone', () => {
    const p = peekElement('{"id":5,"uuid":null,"update_time":"1","updated_at":"2025-03-04T05:00:00.123456Z"}');
    assert.equal(p.id, null);
    assert.equal(p.uuid, null);
    assert.equal(p.updateMs, Date.UTC(2025, 2, 4, 5, 0, 0, 123));
    assert.equal(peekElement('{"updated_at":"2025-03-04T05:00:00"}').updateMs, null, 'zone-less strings would depend on the machine time zone');
  });

  it('is linear: a 20 MB element with many escapes is scanned quickly', () => {
    const big = `{"id":"big","mapping":{"k":"${'\\"x\\\\'.repeat(2_000_000)}"},"update_time":5}`;
    const t0 = performance.now();
    const p = peekElement(big);
    assert.equal(p.id, 'big');
    assert.ok(performance.now() - t0 < 2000);
  });
});

describe('builder sanity', () => {
  it('the ChatGPT builder produces the shapes the runner expects', () => {
    const b: ConversationBuilder = chatConv(5);
    assert.equal(JSON.parse(b.text())['conversation_id'], syntheticUuid(5));
  });
});
