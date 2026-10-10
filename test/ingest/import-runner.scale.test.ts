/**
 * NFR-05 baseline: a generated 50,000-message export (500 conversations x 100 messages in 5 shards, deflated in a ZIP)
 * is imported in well under a minute with bounded heap growth. The measured throughput is printed as a test
 * diagnostic. Memory is sampled at every progress event and on a timer; the data (about 30 MB of JSON) and the
 * in-memory SQLite database are part of what is measured, so the bound is generous but far below "whole export times N".
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { runImport } from '../../src/ingest/import-runner.js';
import { linearConversationText, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { count, fixedClock, freshRepo, zipOf } from './import-runner.helpers.test.js';

const CONVERSATIONS = 500;
const MESSAGES_PER = 100;
const SHARDS = 5;
const MAX_SECONDS = 60;
const MAX_HEAP_GROWTH_MIB = 900;

/** Forces a full garbage collection when the runtime allows it (the flag is switched on at run time), so baselines are real. */
function collectGarbage(): boolean {
  try {
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as (() => void) | undefined;
    if (typeof gc !== 'function') return false;
    gc();
    gc();
    return true;
  } catch {
    return false;
  }
}

function buildShards(): Record<string, string> {
  const shards: Record<string, string> = {};
  const per = CONVERSATIONS / SHARDS;
  for (let s = 0; s < SHARDS; s++) {
    const texts: string[] = [];
    for (let c = 0; c < per; c++) texts.push(linearConversationText(MESSAGES_PER, { id: syntheticUuid(s * per + c + 1000), omitChildren: s % 2 === 1 }));
    shards[`conversations-${String(s).padStart(3, '0')}.json`] = `[${texts.join(',')}]`;
  }
  return shards;
}

describe('scale', () => {
  it(`imports ${CONVERSATIONS * MESSAGES_PER} synthetic messages in under ${MAX_SECONDS} s with bounded heap growth`, async (t) => {
    const repo = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const path = join(dir, 'big.zip');
        // The fixture strings go out of scope inside this block, so the baseline below does not include them.
        const { jsonBytes, zipBytes, buildMs } = await (async () => {
          const t0Build = performance.now();
          const shards = buildShards();
          const zip = zipOf(shards);
          await writeFile(path, zip);
          return { jsonBytes: Object.values(shards).reduce((n, s) => n + s.length, 0), zipBytes: zip.length, buildMs: performance.now() - t0Build };
        })();
        const gcWorks = collectGarbage();
        const baseline = process.memoryUsage().heapUsed;
        let peak = baseline;
        const sample = (): void => {
          const h = process.memoryUsage().heapUsed;
          if (h > peak) peak = h;
        };
        const timer = setInterval(sample, 25);
        const start = performance.now();
        const report = await runImport(repo.repo, {
          source: { kind: 'path', path },
          clock: fixedClock,
          onProgress: () => sample(),
        });
        const seconds = (performance.now() - start) / 1000;
        clearInterval(timer);
        sample();

        const realMessages = CONVERSATIONS * MESSAGES_PER;
        assert.equal(report.conversations.stored, CONVERSATIONS);
        assert.equal(report.conversations.failed, 0);
        assert.equal(report.messages.stored, realMessages + CONVERSATIONS, 'every message plus one structural root per conversation');
        assert.equal(report.messages.structural, CONVERSATIONS);
        assert.equal(count(repo.db, 'messages'), realMessages + CONVERSATIONS);
        assert.equal(report.formatProfile?.layout, 'sharded');
        assert.equal(report.formatProfile?.nodesWithChildrenDeclared > 0, true);
        assert.equal(report.formatProfile?.nodesWithChildrenAbsent > 0, true, 'odd shards were built without children');
        assert.ok(seconds < MAX_SECONDS, `took ${seconds.toFixed(1)} s`);
        const growthMiB = (peak - baseline) / (1024 * 1024);
        const rate = realMessages / seconds;
        const line = `50k-message import: ${seconds.toFixed(2)} s, ${Math.round(rate)} messages/s, ${(jsonBytes / 1e6).toFixed(1)} MB JSON in ${(zipBytes / 1e6).toFixed(1)} MB ZIP, peak heap growth ${growthMiB.toFixed(0)} MiB over a ${gcWorks ? 'collected' : 'UNCOLLECTED'} baseline (fixture build ${(buildMs / 1000).toFixed(1)} s)`;
        t.diagnostic(line);
        process.stderr.write(`[scale] ${line}\n`);
        assert.ok(growthMiB < MAX_HEAP_GROWTH_MIB, `heap grew by ${growthMiB.toFixed(0)} MiB`);

        // Idempotent re-import of the big input is cheap: pass 1 only.
        const s2 = performance.now();
        const again = await runImport(repo.repo, { source: { kind: 'path', path }, clock: fixedClock });
        const secondSeconds = (performance.now() - s2) / 1000;
        assert.equal(again.alreadyImported, true);
        assert.equal(again.messages.stored, report.messages.stored);
        t.diagnostic(`idempotent re-import of the same ZIP: ${secondSeconds.toFixed(2)} s (first import ${seconds.toFixed(2)} s)`);
        assert.ok(secondSeconds < seconds, 'the no-op re-import is faster than the real import');
      });
    } finally {
      repo.close();
    }
  });

  it('a single 20 MB conversation does not multiply memory (the element is held once per pass, not copied per message)', async (t) => {
    const repo = freshRepo();
    try {
      await withTempDir(async (dir) => {
        // One conversation of 60,000 messages (about 20 MB of JSON): the element is held once as text, never twice per pass.
        const bodyBytes = await (async () => {
          const body = `[${linearConversationText(60_000, { id: syntheticUuid(1) })}]`;
          await writeFile(join(dir, 'conversations.json'), body);
          return body.length;
        })();
        collectGarbage();
        const baseline = process.memoryUsage().heapUsed;
        let peak = baseline;
        const report = await runImport(repo.repo, {
          source: { kind: 'path', path: join(dir, 'conversations.json') },
          clock: fixedClock,
          onProgress: () => {
            const h = process.memoryUsage().heapUsed;
            if (h > peak) peak = h;
          },
        });
        assert.equal(report.conversations.stored, 1);
        assert.equal(report.messages.stored, 60_001);
        const growth = (peak - baseline) / 1048576;
        t.diagnostic(`single ${(bodyBytes / 1e6).toFixed(1)} MB conversation: peak heap growth at progress points ${growth.toFixed(0)} MiB`);
        assert.ok(growth < 600, `heap grew by ${growth.toFixed(0)} MiB`);
      });
    } finally {
      repo.close();
    }
  });
});
