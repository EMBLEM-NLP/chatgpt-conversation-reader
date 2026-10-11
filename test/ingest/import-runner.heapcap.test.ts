/**
 * NFR-05 regression ("bounded memory for large exports"), found by the final review: the first pass kept conversation-id strings
 * that were V8 *sliced strings* of each conversation's text, which pinned every conversation seen so far in memory. A 210 MB /
 * 500k-message export then died with "heap out of memory" under a 192 MiB cap. The earlier scale test only bounded heap GROWTH at
 * a generous 900 MiB, so it could not see this.
 *
 * This test imports about 84 MB of synthetic JSON in a CHILD process whose old-space is capped at 96 MiB. With retention the
 * child needs more than 80 MB for the conversation texts alone and aborts (exit 134); with bounded memory it needs a few MiB.
 */
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { linearConversationText, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';

const CONVERSATIONS = 240;
const MESSAGES_PER = 1000;
const HEAP_CAP_MIB = 96;

/** Streams `[conv,conv,...]` to disk one conversation at a time so the TEST itself never holds the export in memory. */
async function writeExport(path: string): Promise<number> {
  const out = createWriteStream(path);
  let bytes = 0;
  const put = async (s: string): Promise<void> => {
    bytes += Buffer.byteLength(s);
    if (!out.write(s)) await once(out, 'drain');
  };
  await put('[');
  for (let c = 0; c < CONVERSATIONS; c++) {
    // lower-case UUIDs on purpose: toLowerCase() returns the SAME (sliced) string when nothing changes
    await put((c === 0 ? '' : ',') + linearConversationText(MESSAGES_PER, { id: syntheticUuid(c + 1) }));
  }
  await put(']');
  out.end();
  await once(out, 'finish');
  return bytes;
}

describe('NFR-05: importing a large export does not retain the conversation texts', () => {
  it(`imports ~84 MB (${CONVERSATIONS * MESSAGES_PER} messages) inside a child with a ${HEAP_CAP_MIB} MiB heap cap`, async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'conversations.json');
      const bytes = await writeExport(file);
      assert.ok(bytes > 75 * 1024 * 1024, `fixture is large enough to make retention fatal (got ${bytes} bytes)`);

      const runnerUrl = pathToFileURL(new URL('../../src/ingest/import-runner.js', import.meta.url).pathname).href;
      const repoUrl = pathToFileURL(new URL('../../src/db/repo.js', import.meta.url).pathname).href;
      const openUrl = pathToFileURL(new URL('../../src/db/open.js', import.meta.url).pathname).href;
      const script = `
        const { runImport } = await import(${JSON.stringify(runnerUrl)});
        const { Repository } = await import(${JSON.stringify(repoUrl)});
        const { openDatabase } = await import(${JSON.stringify(openUrl)});
        const handle = openDatabase(':memory:');
        const report = await runImport(new Repository(handle.db), { source: { kind: 'path', path: ${JSON.stringify(file)} } });
        process.stdout.write(JSON.stringify({ stored: report.messages.stored, conversations: report.conversations.stored }));
      `;
      const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_CAP_MIB}`, '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
      const heapDeath = /heap out of memory|Allocation failed/i.test(stderr);
      assert.equal(heapDeath, false, 'the importer must not exhaust a ' + HEAP_CAP_MIB + ' MiB heap on an 84 MB export (retention regression)');
      assert.equal(code, 0, `child exit code (signal ${String(signal)})`);
      const parsed = JSON.parse(stdout) as { stored: number; conversations: number };
      assert.equal(parsed.conversations, CONVERSATIONS);
      assert.ok(parsed.stored >= CONVERSATIONS * MESSAGES_PER, 'all messages stored');
    });
  });
});
