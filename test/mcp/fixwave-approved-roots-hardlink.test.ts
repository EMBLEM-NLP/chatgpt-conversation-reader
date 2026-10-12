/**
 * ATK-10: a HARD link inside an approved import root to a file outside it passes the realpath containment check (a hard link is
 * a second name for the same inode, not a symbolic link, so there is nothing to resolve). `gcr_import_export` therefore imported
 * a file that lives outside every approved root. A regular file with more than one name is now refused with the same answer as
 * any other refusal of the path itself (no oracle). Directories are exempt (they always have several links), and so is a file
 * whose other names are gone (link count back to 1).
 *
 * Not covered by this check, and documented in docs/SECURITY_AND_BOUNDARIES.md: files INSIDE an approved directory that are hard
 * links (the importer walks the directory itself), and the CLI (`--input`, `import`), which is not fenced at all.
 * Real files and a real SDK client; SYNTHETIC data only. Hard links need a file system that supports them: the test skips otherwise.
 */
import assert from 'node:assert/strict';
import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { parseApprovedRoots, resolveApprovedImportPath } from '../../src/mcp/approved-roots.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { connectMem, conversationsJson, linearChat, makeTempDir, removeDir, writeText } from './mcp.helpers.test.js';
import type { MemHarness } from './mcp.helpers.test.js';

describe('ATK-10: hard links in an approved root', () => {
  let dir: string;
  let root: string;
  let outside: string;
  let dbPath: string;
  let h: MemHarness;
  let linksSupported = true;
  const OUTSIDE_ID = syntheticUuid(0x91);
  const INSIDE_ID = syntheticUuid(0x92);

  before(async () => {
    dir = await makeTempDir();
    root = join(dir, 'approved');
    outside = join(dir, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    dbPath = join(dir, 'target.sqlite');
    Gcr.open({ dbPath }).close();
    await writeText(outside, 'secret.json', conversationsJson([linearChat(OUTSIDE_ID, 'outside the root', [['outside question', 'outside answer']])]));
    await writeText(root, join('export-a', 'conversations.json'), conversationsJson([linearChat(INSIDE_ID, 'inside the root', [['inside question', 'inside answer']])]));
    try {
      await link(join(outside, 'secret.json'), join(root, 'hardlink.json'));
    } catch {
      linksSupported = false;
    }
    h = await connectMem(dbPath, { writable: true, server: { approvedImportRoots: parseApprovedRoots(root) } });
  });
  after(async () => {
    await h.close();
    await removeDir(dir);
  });

  it('a hard link to a file outside the root is refused, with exactly the answer every other refusal gives', async (t) => {
    if (!linksSupported) return t.skip('hard links are not supported here');
    const roots = parseApprovedRoots(root);
    const refusal = async (path: string): Promise<GcrError> => {
      try {
        await resolveApprovedImportPath(path, roots);
      } catch (e) {
        if (e instanceof GcrError) return e;
      }
      throw new Error(`expected a refusal for ${path}`);
    };
    const hard = await refusal(join(root, 'hardlink.json'));
    const missing = await refusal(join(root, 'does-not-exist.json'));
    assert.equal(hard.code, 'IMPORT_PATH_NOT_ALLOWED');
    assert.equal(hard.message, missing.message);
    assert.equal(hard.remedy, missing.remedy);
    assert.deepEqual(hard.details, missing.details, 'no oracle for which names are hard links');
    assert.match(hard.remedy ?? '', /hard.?link/i, 'the (shared) remedy names hard links among the refused things');
    assert.equal(JSON.stringify([hard.message, hard.remedy, hard.details]).includes(root), false, 'the path is never echoed');
  });

  it('through the tool: nothing is imported, nothing is stored, and the outside conversation does not appear', async (t) => {
    if (!linksSupported) return t.skip('hard links are not supported here');
    const before = ((await h.env('gcr_list', { allBatches: true })).data as { total: number }).total;
    const env = await h.env('gcr_import_export', { path: join(root, 'hardlink.json'), accountLabel: 'hard' });
    assert.equal(env.ok, false);
    assert.equal(env.error?.code, 'IMPORT_PATH_NOT_ALLOWED');
    assert.equal(((await h.env('gcr_list', { allBatches: true })).data as { total: number }).total, before);
    const got = await h.env('gcr_get', { conversation: OUTSIDE_ID });
    assert.equal(got.ok, false);
    assert.equal(got.error?.code, 'NOT_IN_LOCAL_EXPORT');
  });

  it('a hard link between two files that are both inside the root is refused too (one inode, several names: it cannot be told apart)', async (t) => {
    if (!linksSupported) return t.skip('hard links are not supported here');
    await link(join(root, 'export-a', 'conversations.json'), join(root, 'inside-hard.json'));
    await assert.rejects(resolveApprovedImportPath(join(root, 'inside-hard.json'), parseApprovedRoots(root)), (e) => e instanceof GcrError && e.code === 'IMPORT_PATH_NOT_ALLOWED');
    await assert.rejects(resolveApprovedImportPath(join(root, 'export-a', 'conversations.json'), parseApprovedRoots(root)), (e) => e instanceof GcrError && e.code === 'IMPORT_PATH_NOT_ALLOWED', 'the original name has two links now');
    await unlink(join(root, 'inside-hard.json'));
    const real = await resolveApprovedImportPath(join(root, 'export-a', 'conversations.json'), parseApprovedRoots(root));
    assert.ok(real.endsWith('conversations.json'), 'with the second name gone the file is an ordinary single-link file again');
  });

  it('ordinary files, directories (which always have several links) and symlinks that stay inside the root are unaffected', async () => {
    const roots = parseApprovedRoots(root);
    assert.ok((await resolveApprovedImportPath(join(root, 'export-a', 'conversations.json'), roots)).endsWith('conversations.json'));
    assert.ok((await resolveApprovedImportPath(join(root, 'export-a'), roots)).endsWith('export-a'));
    await mkdir(join(root, 'export-a', 'nested-dir'));
    assert.ok((await resolveApprovedImportPath(join(root, 'export-a', 'nested-dir'), roots)).endsWith('nested-dir'));
    const env = await h.env('gcr_import_export', { path: join(root, 'export-a', 'conversations.json'), accountLabel: 'ordinary' });
    assert.equal(env.ok, true, env.error?.message);
    await writeFile(join(root, 'single.json'), '[]');
    assert.ok((await resolveApprovedImportPath(join(root, 'single.json'), roots)).endsWith('single.json'));
  });
});
