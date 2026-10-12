/**
 * FR-10 idempotency and snapshot semantics at the runner level: the same input twice is a cheap, report-identical
 * no-op (the adapters are not run again), re-zipping the same files yields the same batch id, container kind and
 * file name do not matter, and a NEW export of the same conversations is a new batch whose head moves per the
 * repository rules.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { closeDatabase, openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchInput, ImportBatchResult } from '../../src/db/repo.js';
import { runImport } from '../../src/ingest/import-runner.js';
import type { ImportOptions } from '../../src/ingest/import-runner.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { buildZip } from '../helpers/zip-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { arrayOf, chatConv, chunked, count, dbDump, fixedClock, freshRepo, writeFileIn, zipOf } from './import-runner.helpers.test.js';

const T0 = 1_760_000_000;
const path = (p: string): ImportOptions['source'] => ({ kind: 'path', path: p });

function sampleExport(): string {
  return arrayOf([chatConv(1, { pairs: 2, updateTime: T0 }), chatConv(2, { pairs: 1, updateTime: T0 + 5 }), chatConv(3, { pairs: 3, updateTime: T0 + 9 })]);
}

describe('idempotent re-import', () => {
  it('importing the same ZIP twice: second report is alreadyImported with identical counts and an identical database', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, 'e.zip'), zipOf({ 'conversations.json': sampleExport(), 'user.json': '{}', 'file-1.dat': 'x' }));
        const first = await runImport(t.repo, { source: path(join(dir, 'e.zip')), clock: fixedClock });
        const hashAfterFirst = dbDump(t.db);
        const second = await runImport(t.repo, { source: path(join(dir, 'e.zip')), clock: () => '2031-01-01T00:00:00.000Z' });
        assert.equal(first.alreadyImported, false);
        assert.equal(second.alreadyImported, true);
        assert.equal(second.batchId, first.batchId);
        assert.equal(second.conversations.stored, first.conversations.stored);
        assert.equal(second.conversations.read, first.conversations.read);
        assert.equal(second.conversations.newlyInserted, 0);
        assert.equal(second.messages.stored, first.messages.stored);
        assert.equal(second.messages.structural, first.messages.structural);
        assert.equal(second.messages.newlyInserted, 0);
        assert.deepEqual(second.warnings, first.warnings, 'the stored batch warnings reproduce the first import\'s summaries');
        assert.deepEqual(second.files, first.files);
        assert.equal(second.formatProfile, undefined, 'observations come from the adapters, which are not run again');
        assert.equal(dbDump(t.db), hashAfterFirst, 'byte-identical database content (rows and FTS blocks)');
        assert.equal(t.repo.getBatch(first.batchId)?.importedAt, '2026-02-03T04:05:06.007Z', 'imported_at of the first import is kept');
        assert.equal(count(t.db, 'source_batches'), 1);
      });
    } finally {
      t.close();
    }
  });

  it('the second import does not run the (expensive) second pass', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', sampleExport());
        const phases1: string[] = [];
        const phases2: string[] = [];
        await runImport(t.repo, { source: path(file), clock: fixedClock, onProgress: (p) => phases1.push(p.phase) });
        await runImport(t.repo, { source: path(file), clock: fixedClock, onProgress: (p) => phases2.push(p.phase) });
        assert.ok(phases1.includes('import'));
        assert.ok(phases2.includes('scan'));
        assert.ok(!phases2.includes('import'), 'adapters were not run again');
      });
    } finally {
      t.close();
    }
  });

  it('re-zipping the same files in a different order and with different compression yields the SAME batch id', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const s1 = arrayOf([chatConv(1, { updateTime: T0 })]);
        const s2 = arrayOf([chatConv(2, { updateTime: T0 })]);
        await writeFile(join(dir, 'a.zip'), buildZip([{ name: 'conversations-1.json', data: s1, method: 'deflate' }, { name: 'conversations-2.json', data: s2, method: 'deflate' }, { name: 'extra/readme.txt', data: 'one' }]));
        await writeFile(join(dir, 'b.zip'), buildZip([{ name: 'other.bin', data: 'completely different asset' }, { name: 'conversations-2.json', data: s2, method: 'store' }, { name: 'conversations-1.json', data: s1, method: 'store' }]));
        const a = await runImport(t.repo, { source: path(join(dir, 'a.zip')), clock: fixedClock });
        const b = await runImport(t.repo, { source: path(join(dir, 'b.zip')), clock: fixedClock });
        assert.equal(b.batchId, a.batchId);
        assert.equal(b.alreadyImported, true);
      });
    } finally {
      t.close();
    }
  });

  it('the same bytes arriving as ZIP, plain file (any name), folder or stdin are one batch', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const body = sampleExport();
        await writeFile(join(dir, 'e.zip'), zipOf({ 'conversations.json': body }));
        const viaZip = await runImport(t.repo, { source: path(join(dir, 'e.zip')), clock: fixedClock });
        const viaFile = await runImport(t.repo, { source: path(await writeFileIn(dir, 'renamed-copy.json', body)), clock: fixedClock });
        const viaDir = await runImport(t.repo, { source: path(await writeFileIn(dir, 'extracted/conversations.json', body).then(() => join(dir, 'extracted'))), clock: fixedClock });
        const viaStdin = await runImport(t.repo, { source: { kind: 'stream', stream: chunked(body, 11), label: '-' }, clock: fixedClock });
        for (const r of [viaFile, viaDir, viaStdin]) {
          assert.equal(r.batchId, viaZip.batchId);
          assert.equal(r.alreadyImported, true);
        }
        assert.equal(count(t.db, 'source_batches'), 1);
        assert.equal(viaZip.sourceKind, 'zip');
        assert.equal(viaFile.sourceKind, 'conversations_json');
      });
    } finally {
      t.close();
    }
  });

  it('a different account label is a different batch even for identical bytes', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', sampleExport());
        const a = await runImport(t.repo, { source: path(file), accountLabel: 'one', clock: fixedClock });
        const b = await runImport(t.repo, { source: path(file), accountLabel: 'two', clock: fixedClock });
        assert.notEqual(a.batchId, b.batchId);
        assert.equal(b.alreadyImported, false);
      });
    } finally {
      t.close();
    }
  });

  it('alreadyImported keeps reporting problems recorded by the first import; strict refuses them', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', `[${chatConv(1).text()},{"mapping": BROKEN}]`);
        const first = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(first.conversations.failed, 1);
        const second = await runImport(t.repo, { source: path(file), clock: fixedClock });
        assert.equal(second.alreadyImported, true);
        assert.equal(second.conversations.failed, 1, 'recovered from the stored ELEMENT_PARSE_FAILED count');
        await assert.rejects(runImport(t.repo, { source: path(file), strict: true, clock: fixedClock }), (e: unknown) => (e as { details?: Record<string, unknown> }).details?.['reason'] === 'ELEMENT_PARSE_FAILED');
      });
    } finally {
      t.close();
    }
  });
});

describe('a NEW export of the same conversations', () => {
  it('is a new batch; the head moves to the newer snapshot per the repository rules; the older one stays pinnable', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const v1 = await writeFileIn(dir, 'v1/conversations.json', arrayOf([chatConv(1, { title: 'V1', updateTime: T0 }), chatConv(2, { title: 'STAYS', updateTime: T0 })]));
        const v2 = await writeFileIn(dir, 'v2/conversations.json', arrayOf([chatConv(1, { title: 'V2', pairs: 2, updateTime: T0 + 1000 }), chatConv(2, { title: 'STAYS', updateTime: T0 })]));
        const r1 = await runImport(t.repo, { source: path(v1), clock: fixedClock });
        const r2 = await runImport(t.repo, { source: path(v2), clock: fixedClock });
        assert.notEqual(r1.batchId, r2.batchId);
        assert.equal(r2.alreadyImported, false);
        assert.equal(r2.conversations.newlyInserted, 2);
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(1) })?.title, 'V2');
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(1), batchId: r1.batchId })?.title, 'V1');
        // Equal updated_at: the tie goes to the later import (greatest seq).
        assert.equal(t.repo.resolveConversation({ conversationId: syntheticUuid(2) }).matches[0]?.batchId, r2.batchId);
        assert.equal(count(t.db, 'conversation_heads'), 2);
        assert.equal(t.repo.listBatches().length, 2);
      });
    } finally {
      t.close();
    }
  });

  it('an OLDER export imported later does not take the head from a newer one', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const newer = await writeFileIn(dir, 'new/conversations.json', arrayOf([chatConv(1, { title: 'NEWER', updateTime: T0 + 500 })]));
        const older = await writeFileIn(dir, 'old/conversations.json', arrayOf([chatConv(1, { title: 'OLDER', updateTime: T0 })]));
        await runImport(t.repo, { source: path(newer), clock: fixedClock });
        await runImport(t.repo, { source: path(older), clock: fixedClock });
        assert.equal(t.repo.getConversation({ conversationId: syntheticUuid(1) })?.title, 'NEWER');
      });
    } finally {
      t.close();
    }
  });
});

/**
 * TQ-05 (mutation U2: the "another process stored the same input between our check and the transaction" path of the import
 * runner could throw, or report a fresh import, and no test noticed). The race is made deterministic WITHOUT touching the
 * product: two real connections to one database file; the connection that loses runs its normal pre-check (the batch does not
 * exist yet), and right before its transaction begins the winner's complete import is committed through the other connection.
 * Everything else (the pre-check, the in-transaction check of the repository, the reports) is the production code.
 */
class LosesTheRace extends Repository {
  readonly results: ImportBatchResult[] = [];
  private winner: (() => Promise<unknown>) | null;

  constructor(db: ConstructorParameters<typeof Repository>[0], winner: () => Promise<unknown>) {
    super(db);
    this.winner = winner;
  }

  override async importBatch(input: ImportBatchInput): Promise<ImportBatchResult> {
    const winner = this.winner;
    this.winner = null; // the winner commits exactly once, before the first transaction of this runner
    if (winner !== null) await winner();
    const result = await super.importBatch(input);
    this.results.push(result);
    return result;
  }
}

describe('two processes import the same input at once (the loser finds the batch inside its transaction)', () => {
  it('the loser reports the stored batch as the no-op it is: alreadyImported, the winner\'s counts and warnings, no second import pass, no second batch', async () => {
    await withTempDir(async (dir) => {
      // One broken element, so the stored batch carries a warning the loser has to reproduce from the batch row.
      const file = await writeFileIn(dir, 'conversations.json', `[${chatConv(1, { pairs: 2, updateTime: T0 }).text()},${chatConv(2, { updateTime: T0 + 5 }).text()},{"mapping": BROKEN}]`);
      const dbPath = join(dir, 'race.sqlite');
      const winnerHandle = openDatabase(dbPath);
      const loserHandle = openDatabase(dbPath);
      try {
        const winnerRepo = new Repository(winnerHandle.db);
        let winnerReport: Awaited<ReturnType<typeof runImport>> | undefined;
        const loserRepo = new LosesTheRace(loserHandle.db, async () => {
          assert.equal(count(loserHandle.db, 'source_batches'), 0, 'premise: at the loser\'s pre-check nothing is stored yet');
          winnerReport = await runImport(winnerRepo, { source: path(file), clock: fixedClock });
        });
        const phases: string[] = [];
        const loser = await runImport(loserRepo, { source: path(file), clock: () => '2031-01-01T00:00:00.000Z', onProgress: (p) => phases.push(p.phase) });

        assert.ok(winnerReport !== undefined, 'the winner ran between the loser\'s pre-check and its transaction');
        assert.equal(winnerReport.alreadyImported, false);
        assert.equal(winnerReport.conversations.stored, 2);
        assert.equal(winnerReport.conversations.failed, 1);

        // The repository was asked twice: the transaction found the batch (the race), then the report asked for the counts.
        // A plain re-import is answered by the pre-check with ONE call, so two calls prove the race path ran.
        assert.equal(loserRepo.results.length, 2);
        assert.deepEqual(loserRepo.results.map((r) => r.alreadyImported), [true, true]);

        assert.equal(loser.alreadyImported, true);
        assert.equal(loser.batchId, winnerReport.batchId);
        assert.deepEqual(loser.conversations, { read: 3, stored: 2, failed: 1, newlyInserted: 0 }, 'the stored counts of the winner; failed is recovered from the stored warning');
        assert.equal(loser.messages.newlyInserted, 0);
        assert.equal(loser.messages.stored, winnerReport.messages.stored);
        assert.deepEqual(loser.warnings, winnerReport.warnings, 'the winner\'s warning summaries come back from the stored batch row');
        assert.ok(loser.warnings.some((w) => w.code === 'ELEMENT_PARSE_FAILED'));
        assert.equal(loser.formatProfile, undefined, 'the adapters did not run for the loser');
        assert.ok(phases.includes('scan'));
        assert.ok(!phases.includes('import'), 'the loser never started the second (import) pass');
        assert.equal(winnerRepo.getBatch(winnerReport.batchId)?.importedAt, '2026-02-03T04:05:06.007Z', 'imported_at of the winner is kept');
        assert.equal(count(loserHandle.db, 'source_batches'), 1);
        assert.equal(count(loserHandle.db, 'conversations'), 2);
      } finally {
        closeDatabase(loserHandle);
        closeDatabase(winnerHandle);
      }
    });
  });
});
