/**
 * Log and error hygiene (NFR-07, AGENTS.md): reports, persisted batch warnings, GcrError message/remedy/details/envelope
 * and stderr never contain conversation text, titles, auxiliary-file content or absolute paths. Distinctive strings are
 * planted in titles, message text, corrupt elements, auxiliary files, asset names and the temp path, then searched for
 * in every output of success AND failure scenarios.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { runImport } from '../../src/ingest/import-runner.js';
import type { ImportOptions } from '../../src/ingest/import-runner.js';
import { runManualCopyImport } from '../../src/ingest/manual-copy.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { arrayOf, captureStderr, chatConv, chunked, errorSurface, fixedClock, freshRepo, writeFileIn, zipOf } from './import-runner.helpers.test.js';

const TITLE = 'PLANTED_TITLE_Zq81x';
const TEXT = 'PLANTED_TEXT_Zq81x';
const PII = 'PLANTED_PII_Zq81x@example.invalid';
const ASSET = 'PLANTED_ASSET_Zq81x';
const BROKEN = 'PLANTED_BROKEN_Zq81x';
const SECRETS = [TITLE, TEXT, PII, ASSET, BROKEN];

function plantedConversation(n: number): ConversationBuilder {
  const b = new ConversationBuilder({ id: syntheticUuid(n), title: `${TITLE} ${n}` });
  const root = b.root();
  const u = b.user(root, `${TEXT} user ${n}`, { attachments: [{ id: `file-${ASSET}`, name: `${ASSET}.png`, mime_type: 'image/png', size: 5 }] });
  b.assistant(u, `${TEXT} assistant ${n}`, { model: 'synthetic-model-1' });
  return b;
}

function assertClean(label: string, surface: string, extra: string[] = []): void {
  for (const s of [...SECRETS, ...extra]) assert.ok(!surface.includes(s), `${label}: leaked ${s.slice(0, 12)}...`);
}

describe('hygiene', () => {
  it('reports, persisted batch rows, errors and stderr never carry content or absolute paths', async () => {
    const previousLevel = process.env['GCR_LOG_LEVEL'];
    process.env['GCR_LOG_LEVEL'] = 'debug'; // even debug logging must stay content free
    try {
      await withTempDir(async (dir) => {
        const t = freshRepo();
        try {
          const forbidden = [dir, tmpdir() === dir ? 'never' : dir];
          const surfaces: Array<[string, string]> = [];
          const ok = async (label: string, opts: ImportOptions): Promise<void> => {
            const { result, stderr } = await captureStderr(() => runImport(t.repo, { clock: fixedClock, ...opts }));
            surfaces.push([`${label}/report`, JSON.stringify(result)], [`${label}/stderr`, stderr]);
          };
          const fails = async (label: string, opts: ImportOptions): Promise<void> => {
            const { result, stderr } = await captureStderr(async () => {
              try {
                await runImport(t.repo, { clock: fixedClock, ...opts });
                return 'no error';
              } catch (e) {
                assert.ok(e instanceof GcrError, `${label}: only GcrError may escape`);
                return errorSurface(e);
              }
            });
            assert.notEqual(result, 'no error', `${label} should fail`);
            surfaces.push([`${label}/error`, result], [`${label}/stderr`, stderr]);
          };

          // success paths
          await writeFileSync(join(dir, 'plain.zip'), zipOf({ 'conversations.json': arrayOf([plantedConversation(1)]), 'user.json': JSON.stringify({ email: PII }), [`${ASSET}.dat`]: 'x', [`${ASSET}/inner.png`]: 'y' }));
          await ok('zip', { source: { kind: 'path', path: join(dir, 'plain.zip') } });
          await writeFileIn(dir, 'folder/conversations-1.json', arrayOf([plantedConversation(2)]));
          await writeFileIn(dir, 'folder/conversations-2.json', arrayOf([plantedConversation(2)]));
          await ok('folder+duplicate', { source: { kind: 'path', path: join(dir, 'folder') } });
          await ok('stdin', { source: { kind: 'stream', stream: chunked(arrayOf([plantedConversation(3)]), 64), label: join(dir, 'stdin-label') } });
          await writeFileIn(dir, 'corrupt/conversations.json', `[${plantedConversation(4).text()},{"mapping": ${BROKEN}},${plantedConversation(5).text()}]`);
          await ok('corrupt element (default)', { source: { kind: 'path', path: join(dir, 'corrupt') }, accountLabel: 'c1' });
          await writeFileIn(dir, 'wrapper/conversations.json', JSON.stringify({ conversations: [JSON.parse(plantedConversation(6).text())] }));
          await ok('wrapper', { source: { kind: 'path', path: join(dir, 'wrapper') } });
          await ok('already imported', { source: { kind: 'path', path: join(dir, 'plain.zip') } });

          // failure paths
          await fails('strict corrupt', { source: { kind: 'path', path: join(dir, 'corrupt') }, strict: true, accountLabel: 'c2' });
          await fails('missing path', { source: { kind: 'path', path: join(dir, 'nope', 'missing.zip') } });
          writeFileSync(join(dir, 'notes.txt'), `${TEXT} this is not an export`);
          await fails('not an export', { source: { kind: 'path', path: join(dir, 'notes.txt') } });
          writeFileSync(join(dir, 'other.zip'), zipOf({ [`${TITLE}.txt`]: TEXT }));
          await fails('zip without conversations', { source: { kind: 'path', path: join(dir, 'other.zip') } });
          writeFileSync(join(dir, 'utf16.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`["${TEXT}"]`, 'utf16le')]));
          await fails('utf16', { source: { kind: 'path', path: join(dir, 'utf16.json') } });
          // Elements before the break are kept (success with FILE_PARSE_FAILED); with nothing readable the import fails.
          writeFileSync(join(dir, 'trunc-partial.json'), `["${TEXT}", {"mapping": {"${BROKEN}": `);
          await ok('truncated after an element', { source: { kind: 'path', path: join(dir, 'trunc-partial.json') }, accountLabel: 'c4' });
          writeFileSync(join(dir, 'trunc.json'), `[{"mapping": {"${BROKEN}": "${TEXT}`);
          await fails('truncated', { source: { kind: 'path', path: join(dir, 'trunc.json') } });
          writeFileSync(join(dir, 'garbage.json'), `[${TEXT}]`);
          await fails('garbage', { source: { kind: 'path', path: join(dir, 'garbage.json') } });
          await fails('element too large', { source: { kind: 'path', path: join(dir, 'plain.zip') }, accountLabel: 'big', limits: { maxElementBytes: 200 } });
          await writeFileIn(dir, 'mixed/conversations-0.json', arrayOf([plantedConversation(7)]));
          await writeFileIn(dir, 'mixed/conversations-1.json', JSON.stringify([{ uuid: syntheticUuid(8), name: TITLE, chat_messages: [] }]));
          await fails('mixed providers', { source: { kind: 'path', path: join(dir, 'mixed') } });
          await fails('bad account label', { source: { kind: 'path', path: join(dir, 'plain.zip') }, accountLabel: `${TITLE}/../x` });
          await fails('strict duplicates', { source: { kind: 'path', path: join(dir, 'folder') }, strict: true, accountLabel: 'c3' });

          for (const [label, surface] of surfaces) assertClean(label, surface, forbidden);
          // persisted batch rows
          assertClean('stored batches', JSON.stringify(t.repo.listBatches()), forbidden);
          // Mode B too
          const manual = await runManualCopyImport(t.repo, {
            text: JSON.stringify({ title: TITLE, messages: [{ role: 'user', text: TEXT }, { role: 'assistant', text: TEXT, modelSlug: 'm', createdAt: '2025-01-01T00:00:00Z' }] }),
            clock: fixedClock,
            sourceLabel: join(dir, 'pasted-notes.json'),
          });
          assertClean('manual copy report', JSON.stringify(manual), forbidden);
          assert.equal(manual.sourceLabel, 'pasted-notes.json');
          assert.ok(surfaces.length >= 25, 'the scenarios actually ran');
        } finally {
          t.close();
        }
      });
    } finally {
      if (previousLevel === undefined) delete process.env['GCR_LOG_LEVEL'];
      else process.env['GCR_LOG_LEVEL'] = previousLevel;
    }
  });

  it('the planted content really is in the database (the test would catch a leak, it is not vacuous)', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([plantedConversation(1)]));
        await runImport(t.repo, { source: { kind: 'path', path: file }, clock: fixedClock });
        const rec = t.repo.getConversation({ conversationId: syntheticUuid(1) });
        assert.ok(rec);
        assert.ok(rec.title?.includes(TITLE));
        assert.ok(rec.messages.some((m) => m.text.includes(TEXT)));
      });
    } finally {
      t.close();
    }
  });

  it('a file-system error names the BASENAME of what the user typed, never the parent directories', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const target = join(dir, 'a', 'b', 'secret-folder-name', 'export.zip');
        await assert.rejects(runImport(t.repo, { source: { kind: 'path', path: target } }), (e: unknown) => {
          const s = errorSurface(e);
          assert.ok(s.includes('export.zip'));
          assert.ok(!s.includes('secret-folder-name'));
          assert.ok(!s.includes(dir));
          return true;
        });
      });
    } finally {
      t.close();
    }
  });
});
