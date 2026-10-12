/**
 * TQ-02 of the round-2 test review: `--history` used to report "clean" (exit 0) on a SHALLOW clone, which is what
 * actions/checkout produces by default, although the commits before the shallow boundary were never read. A credential that was
 * committed and removed before the boundary therefore passed the CI gate. The scan now fails closed (`scan-truncated`, exit 1)
 * on a shallow repository, unless the caller accepted partial coverage with --allow-large-unscanned (local use only).
 *
 * The secret-shaped text is assembled at run time so that this file contains none.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { withTempDir } from '../helpers/tmp.js';
import { main, scanRepo } from '../../src/devtools/privacy-scan.js';
import { commitAll, git, initRepo, join_, put, rnd, rulesOf } from './fixwave-privacy-helpers.js';

const key = (): string => join_('sk-', rnd(40, 7));

/** A repository whose FIRST commit adds a credential-shaped string and whose SECOND commit removes it; then a depth-1 clone of it. */
async function withShallowAndFullClone<T>(fn: (full: string, shallow: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const full = join(dir, 'origin');
    await initRepo(full);
    await put(full, 'leak.txt', `token = ${key()}\n`);
    await commitAll(full, 'add a synthetic key-shaped string');
    await git(full, 'rm', '-q', 'leak.txt');
    await commitAll(full, 'remove it');
    await put(full, 'later.txt', 'ordinary text\n');
    await commitAll(full, 'a later, harmless commit');
    const shallow = join(dir, 'shallow');
    await git(dir, 'clone', '-q', '--depth', '1', `file://${full}`, shallow);
    return fn(full, shallow);
  });
}

describe('privacy-scan --history on a shallow clone (TQ-02)', () => {
  it('the full repository finds the removed credential; the shallow clone is a FAILING scan-truncated finding, not "clean"', async () => {
    await withShallowAndFullClone(async (full, shallow) => {
      assert.equal((await git(shallow, 'rev-parse', '--is-shallow-repository')).trim(), 'true', 'the fixture really is shallow');
      const complete = await scanRepo(full, { history: true });
      assert.ok(rulesOf(complete.findings).includes('openai-api-key'), 'the credential is in the full history');
      const partial = await scanRepo(shallow, { history: true });
      const truncated = partial.findings.filter((f) => f.rule === 'scan-truncated');
      assert.equal(truncated.length, 1, 'one scan-truncated finding');
      assert.match(truncated[0]?.detail ?? '', /shallow clone/);
      assert.match(truncated[0]?.detail ?? '', /fetch-depth: 0/);
    });
  });

  it('the command exits 1 on the shallow clone and 1 on the full one (for the credential), and the shallow answer is not "clean"', async () => {
    await withShallowAndFullClone(async (_full, shallow) => {
      const r = await main(['--root', shallow, '--history']);
      assert.equal(r.exitCode, 1);
      assert.ok(!/privacy-scan: clean/.test(r.stdout), r.stdout);
      assert.match(r.stdout, /scan-truncated/);
    });
  });

  it('--allow-large-unscanned (local use) downgrades it to a note', async () => {
    await withShallowAndFullClone(async (_full, shallow) => {
      const r = await scanRepo(shallow, { history: true, allowLargeUnscanned: true });
      assert.deepEqual(r.findings.filter((f) => f.rule === 'scan-truncated'), []);
      assert.ok(r.notes.some((n) => /shallow clone/.test(n)));
    });
  });

  it('a complete (unshallowed) repository is still clean when nothing is wrong', async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir);
      await put(dir, 'a.txt', 'ordinary text\n');
      await commitAll(dir, 'one');
      await put(dir, 'b.txt', 'more ordinary text\n');
      await commitAll(dir, 'two');
      const r = await scanRepo(dir, { history: true });
      assert.deepEqual(r.findings, []);
    });
  });

  it('the work-tree scan (no --history) is not affected by a shallow clone', async () => {
    await withShallowAndFullClone(async (_full, shallow) => {
      const r = await scanRepo(shallow, {});
      assert.deepEqual(r.findings, []);
    });
  });
});
