/**
 * Atomicity (one transaction per batch) and concurrent-modification detection. Failures are forced in the MIDDLE of
 * pass 2, after the repository already inserted rows, and the database must be byte-identical to before.
 */
import assert from 'node:assert/strict';
import { appendFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { runImport } from '../../src/ingest/import-runner.js';
import type { ImportOptions } from '../../src/ingest/import-runner.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { arrayOf, chatConv, count, dbDump, expectCode, fixedClock, freshRepo, writeFileIn, zipOf } from './import-runner.helpers.test.js';

const dirSource = (p: string): ImportOptions['source'] => ({ kind: 'path', path: p });

/** Hook that runs `mutate` right after pass 1 finished scanning `lastFile` (i.e. before pass 2 starts). */
function afterScan(lastFile: string, mutate: () => void): NonNullable<ImportOptions['onProgress']> {
  let done = false;
  return (p) => {
    if (!done && p.phase === 'scan' && p.file === lastFile && p.elements > 0) {
      // the per-file completion event is the last 'scan' event of the last file
      done = true;
      mutate();
    }
  };
}

describe('atomicity', () => {
  it('a file modified between the passes is detected AFTER earlier rows were inserted: nothing stored, database unchanged', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const root = join(dir, 'export');
        await writeFileIn(root, 'conversations-1.json', arrayOf([chatConv(1), chatConv(2)]));
        const second = await writeFileIn(root, 'conversations-2.json', arrayOf([chatConv(3), chatConv(4)]));
        const before = dbDump(t.db);
        let inserted = -1;
        await assert.rejects(
          runImport(t.repo, {
            source: dirSource(root),
            clock: fixedClock,
            onProgress: afterScan('conversations-2.json', () => appendFileSync(second, '\n  ')),
          }),
          (e: unknown) => {
            assert.ok(e instanceof GcrError);
            assert.equal(e.code, 'IMPORT_PARSE_ERROR');
            assert.equal(e.details?.['reason'], 'CONCURRENT_MODIFICATION');
            assert.equal(e.details?.['file'], 'conversations-2.json');
            assert.match(e.remedy ?? '', /Do not modify/);
            return true;
          },
        );
        inserted = count(t.db, 'conversations');
        assert.equal(inserted, 0, 'rolled back, including rows inserted from conversations-1.json');
        assert.equal(dbDump(t.db), before);
        // The repository is still usable and a clean import works.
        const ok = await runImport(t.repo, { source: dirSource(root), clock: fixedClock });
        assert.equal(ok.conversations.stored, 4);
      });
    } finally {
      t.close();
    }
  });

  it('a single file that GROWS or is REPLACED with other content between the passes is detected', async () => {
    for (const mutateKind of ['append', 'replace-same-size', 'replace-different']) {
      const t = freshRepo();
      try {
        await withTempDir(async (dir) => {
          const body = arrayOf([chatConv(1, { title: 'AAAA' }), chatConv(2, { title: 'AAAA' })]);
          const file = await writeFileIn(dir, 'conversations.json', body);
          const mutate = (): void => {
            if (mutateKind === 'append') appendFileSync(file, ' ');
            else if (mutateKind === 'replace-same-size') writeFileSync(file, body.replaceAll('AAAA', 'BBBB'));
            else writeFileSync(file, arrayOf([chatConv(9)]));
          };
          await assert.rejects(runImport(t.repo, { source: dirSource(file), clock: fixedClock, onProgress: afterScan('conversations.json', mutate) }), expectCode('IMPORT_PARSE_ERROR', 'CONCURRENT_MODIFICATION'), mutateKind);
          for (const tb of ['source_batches', 'conversations', 'messages', 'conversation_heads', 'source_batch_stats']) assert.equal(count(t.db, tb), 0, `${mutateKind}: ${tb}`);
        });
      } finally {
        t.close();
      }
    }
  });

  it('a file replaced by a symlink, or deleted, between the passes fails cleanly (no read through the link, nothing stored)', async () => {
    for (const kind of ['symlink', 'delete']) {
      const t = freshRepo();
      try {
        await withTempDir(async (dir) => {
          const root = join(dir, 'export');
          const file = await writeFileIn(root, 'conversations.json', arrayOf([chatConv(1)]));
          const secret = await writeFileIn(dir, 'secret/other.json', arrayOf([chatConv(2, { title: 'PLANTED-LINK-TARGET' })]));
          const mutate = (): void => {
            rmSync(file);
            if (kind === 'symlink') symlinkSync(secret, file);
          };
          await assert.rejects(runImport(t.repo, { source: dirSource(root), clock: fixedClock, onProgress: afterScan('conversations.json', mutate) }), (e: unknown) => {
            assert.ok(e instanceof GcrError);
            assert.ok(['IMPORT_UNSUPPORTED_FORMAT', 'IMPORT_INPUT_NOT_FOUND'].includes(e.code), e.code);
            assert.ok(!JSON.stringify(e.toEnvelope()).includes(dir));
            return true;
          });
          assert.equal(count(t.db, 'conversations'), 0);
          assert.equal(count(t.db, 'source_batches'), 0);
        });
      } finally {
        t.close();
      }
    }
  });

  it('--strict failing on the THIRD conversation (two already inserted) leaves the database unchanged', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        // A first, unrelated import so "unchanged" is not just "empty".
        const other = await writeFileIn(dir, 'other/conversations.json', arrayOf([chatConv(50)]));
        await runImport(t.repo, { source: dirSource(other), clock: fixedClock });
        const before = dbDump(t.db);
        const file = await writeFileIn(dir, 'bad/conversations.json', `[${chatConv(1).text()},${chatConv(2).text()},{"mapping": nope},${chatConv(3).text()}]`);
        await assert.rejects(runImport(t.repo, { source: dirSource(file), strict: true, clock: fixedClock }), expectCode('IMPORT_PARSE_ERROR'));
        assert.equal(dbDump(t.db), before);
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(1) }), null);
      });
    } finally {
      t.close();
    }
  });

  it('a corrupt ZIP (CRC mismatch) is caught in pass 1: nothing is stored and the error is IMPORT_ZIP_UNSAFE', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const { buildZip } = await import('../helpers/zip-builder.js');
        const data = Buffer.from(arrayOf([chatConv(1)]));
        writeFileSync(join(dir, 'bad.zip'), buildZip([{ name: 'conversations.json', data, crcOverride: 0xdeadbeef }]));
        await assert.rejects(runImport(t.repo, { source: dirSource(join(dir, 'bad.zip')), clock: fixedClock }), expectCode('IMPORT_ZIP_UNSAFE'));
        assert.equal(count(t.db, 'source_batches'), 0);
      });
    } finally {
      t.close();
    }
  });

  it('a decompression bomb entry is refused by the shared limits with nothing stored', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const big = `[${'0,'.repeat(200_000)}0]`; // ~400 KB of highly compressible data
        writeFileSync(join(dir, 'bomb.zip'), zipOf({ 'conversations.json': big }));
        await assert.rejects(
          runImport(t.repo, { source: dirSource(join(dir, 'bomb.zip')), limits: { maxCompressionRatio: 2 }, clock: fixedClock }),
          expectCode('IMPORT_LIMIT_EXCEEDED'),
        );
        assert.equal(count(t.db, 'source_batches'), 0);
      });
    } finally {
      t.close();
    }
  });

  it('two sequential failures and then a success leave exactly the successful batch (no leaked in-flight state)', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const good = await writeFileIn(dir, 'good/conversations.json', arrayOf([chatConv(1)]));
        const bad = await writeFileIn(dir, 'bad/conversations.json', `[${chatConv(2).text()},{"mapping": nope}]`);
        for (let i = 0; i < 2; i++) await assert.rejects(runImport(t.repo, { source: dirSource(bad), strict: true, clock: fixedClock }), expectCode('IMPORT_PARSE_ERROR'));
        const r = await runImport(t.repo, { source: dirSource(good), clock: fixedClock });
        assert.equal(r.conversations.stored, 1);
        assert.equal(count(t.db, 'source_batches'), 1);
        assert.equal(count(t.db, 'conversations'), 1);
      });
    } finally {
      t.close();
    }
  });
});
