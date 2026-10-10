/**
 * layout.ts, part 2: extracted-folder input. The walk is bounded (depth 4, entry cap), never follows symlinks (loops,
 * links out of the tree, links named like conversation files), skips macOS junk and special files, and opens files
 * with O_NOFOLLOW so a symlink swapped in after discovery is refused. Real temp directories, no mocks.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { DIRECTORY_MAX_DEPTH, discoverInput } from '../../src/ingest/layout.js';
import type { Discovery } from '../../src/ingest/layout.js';
import { DEFAULT_IMPORT_LIMITS } from '../../src/ingest/limits.js';
import { withTempDir } from '../helpers/tmp.js';
import { errorSurface, expectCode, writeFileIn } from './import-runner.helpers.test.js';

async function readAll(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
}

const names = (d: Discovery): string[] => d.files.map((f) => f.name);

describe('folder layout', () => {
  it('finds conversation files, counts auxiliary files by name, lists assets, uses forward-slash relative names', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'my-export');
      await writeFileIn(root, 'conversations-2.json', '[2]');
      await writeFileIn(root, 'conversations-10.json', '[10]');
      await writeFileIn(root, 'conversations-1.json', '[1]');
      await writeFileIn(root, 'user.json', '{"email":"nobody@example.invalid"}');
      await writeFileIn(root, 'chat.html', '<html/>');
      await writeFileIn(root, 'file-0001.dat', 'x');
      await writeFileIn(root, 'media/pic.png', 'y');
      const d = await discoverInput({ kind: 'path', path: root }, DEFAULT_IMPORT_LIMITS);
      assert.equal(d.layout, 'directory');
      assert.equal(d.sourceKind, 'directory');
      assert.equal(d.sourceLabel, 'my-export');
      assert.deepEqual(names(d), ['conversations-1.json', 'conversations-2.json', 'conversations-10.json']);
      assert.equal(d.auxiliaryFilesIgnored, 2);
      assert.deepEqual([...d.assetNames].sort(), ['file-0001.dat', 'media/pic.png']);
      assert.equal(d.assetsExtensionless, true);
      assert.equal((await readAll(d.files[1]?.open() as AsyncIterable<Buffer>)).toString(), '[2]');
      await d.close();
    });
  });

  it('files in sub-folders are found; the same name in two folders is kept twice, ordered by name', async () => {
    await withTempDir(async (dir) => {
      await writeFileIn(dir, 'b/conversations.json', '[]');
      await writeFileIn(dir, 'a/conversations.json', '[]');
      const d = await discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual(names(d), ['a/conversations.json', 'b/conversations.json']);
    });
  });

  it('__MACOSX folders, ._ files and .DS_Store are skipped', async () => {
    await withTempDir(async (dir) => {
      await writeFileIn(dir, 'conversations.json', '[]');
      await writeFileIn(dir, '__MACOSX/conversations-3.json', 'junk');
      await writeFileIn(dir, '._conversations-4.json', 'junk');
      await writeFileIn(dir, '.DS_Store', 'junk');
      const d = await discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual(names(d), ['conversations.json']);
      assert.equal(d.assetNames.size, 0);
    });
  });

  it('does not follow symlinks: a loop, a link to the parent, a link out of the tree and a link named like a conversation file', async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, 'outside');
      await writeFileIn(outside, 'conversations.json', '["PLANTED-OUTSIDE"]');
      await writeFileIn(outside, 'conversations-9.json', '["PLANTED-OUTSIDE"]');
      const root = join(dir, 'export');
      await writeFileIn(root, 'conversations.json', '[]');
      await mkdir(join(root, 'sub'), { recursive: true });
      await symlink(root, join(root, 'sub', 'loop-to-root')); // loop
      await symlink('..', join(root, 'sub', 'to-parent')); // link to the parent
      await symlink(outside, join(root, 'escape')); // link out of the tree
      await symlink(join(outside, 'conversations-9.json'), join(root, 'conversations-9.json')); // file link named like a shard
      await symlink(join(root, 'does-not-exist'), join(root, 'dangling'));
      const d = await discoverInput({ kind: 'path', path: root }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual(names(d), ['conversations.json']);
      const w = d.warnings.find((x) => x.code === 'SYMLINK_SKIPPED');
      assert.ok(w, 'symlinks are reported');
      assert.match(w.message, /^5 symbolic link/);
      assert.ok(!errorSurface(new GcrError('INTERNAL_ERROR', w.message)).includes(dir));
      await d.close();
    });
  });

  it('a folder that only contains symlinked conversation files has no conversation file', async () => {
    await withTempDir(async (dir) => {
      const real = await writeFileIn(dir, 'real/conversations.json', '[]');
      const root = join(dir, 'export');
      await mkdir(root);
      await symlink(real, join(root, 'conversations.json'));
      await assert.rejects(discoverInput({ kind: 'path', path: root }, DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'NO_CONVERSATION_FILE'));
    });
  });

  it('the top-level path the user typed MAY be a symlink to a folder or a file (the walk inside never follows)', async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, 'real-export');
      await writeFileIn(real, 'conversations.json', '[7]');
      await symlink(real, join(dir, 'link-to-export'));
      const d = await discoverInput({ kind: 'path', path: join(dir, 'link-to-export') }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual(names(d), ['conversations.json']);
      assert.equal((await readAll(d.files[0]?.open() as AsyncIterable<Buffer>)).toString(), '[7]');

      await symlink(join(real, 'conversations.json'), join(dir, 'link-to-file.json'));
      const f = await discoverInput({ kind: 'path', path: join(dir, 'link-to-file.json') }, DEFAULT_IMPORT_LIMITS);
      assert.equal((await readAll(f.files[0]?.open() as AsyncIterable<Buffer>)).toString(), '[7]');
    });
  });

  it(`searches ${DIRECTORY_MAX_DEPTH} folder levels below the chosen folder and reports what it did not search`, async () => {
    await withTempDir(async (dir) => {
      const deepest = Array.from({ length: DIRECTORY_MAX_DEPTH }, (_, i) => `d${i}`).join('/');
      await writeFileIn(dir, `${deepest}/conversations.json`, '[]');
      const tooDeep = Array.from({ length: DIRECTORY_MAX_DEPTH + 1 }, (_, i) => `e${i}`).join('/');
      await writeFileIn(dir, `${tooDeep}/conversations-1.json`, '[]');
      const d = await discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual(names(d), [`${deepest}/conversations.json`]);
      assert.ok(d.warnings.some((w) => w.code === 'DIRECTORY_DEPTH_LIMIT'));
    });
  });

  it('when only a too-deep file exists the error says the depth cap was reached', async () => {
    await withTempDir(async (dir) => {
      const tooDeep = Array.from({ length: DIRECTORY_MAX_DEPTH + 2 }, (_, i) => `x${i}`).join('/');
      await writeFileIn(dir, `${tooDeep}/conversations.json`, '[]');
      await assert.rejects(discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
        assert.equal(e.details?.['depthLimitReached'], true);
        return true;
      });
    });
  });

  it('refuses a folder with more entries than maxEntries without holding them all', async () => {
    await withTempDir(async (dir) => {
      for (let i = 0; i < 12; i++) await writeFile(join(dir, `f${i}.bin`), 'x');
      await writeFile(join(dir, 'conversations.json'), '[]');
      const limits = { ...DEFAULT_IMPORT_LIMITS, maxEntries: 5 };
      await assert.rejects(discoverInput({ kind: 'path', path: dir }, limits), expectCode('IMPORT_LIMIT_EXCEEDED', 'TOO_MANY_ENTRIES'));
    });
  });

  it('an empty folder has no conversation file', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'NO_CONVERSATION_FILE'));
    });
  });

  it('a symlink swapped in AFTER discovery is refused when the file is opened (O_NOFOLLOW, no TOCTOU escape)', async () => {
    await withTempDir(async (dir) => {
      const secret = await writeFileIn(dir, 'outside/secret.json', '["PLANTED-SECRET"]');
      const root = join(dir, 'export');
      await writeFileIn(root, 'conversations.json', '[]');
      const d = await discoverInput({ kind: 'path', path: root }, DEFAULT_IMPORT_LIMITS);
      await unlink(join(root, 'conversations.json'));
      await symlink(secret, join(root, 'conversations.json'));
      const f = d.files[0];
      assert.ok(f);
      await assert.rejects(readAll(f.open()), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
        assert.equal(e.details?.['reason'], 'SYMLINK_REFUSED');
        assert.ok(!errorSurface(e).includes('PLANTED-SECRET'));
        assert.ok(!errorSurface(e).includes(dir), 'no absolute path');
        return true;
      });
    });
  });

  it('a file removed after discovery is IMPORT_INPUT_NOT_FOUND with a relative name only', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'export');
      await writeFileIn(root, 'conversations.json', '[]');
      const d = await discoverInput({ kind: 'path', path: root }, DEFAULT_IMPORT_LIMITS);
      await rename(join(root, 'conversations.json'), join(dir, 'moved.json'));
      await assert.rejects(readAll(d.files[0]?.open() as AsyncIterable<Buffer>), (e: unknown) => {
        assert.ok(e instanceof GcrError);
        assert.equal(e.code, 'IMPORT_INPUT_NOT_FOUND');
        assert.ok(!errorSurface(e).includes(dir));
        assert.ok(!errorSurface(e).includes(basename(dir)));
        return true;
      });
    });
  });

  it('FIFOs are never opened (no hang) and special files are skipped', async (t) => {
    await withTempDir(async (dir) => {
      try {
        execFileSync('mkfifo', [join(dir, 'conversations-5.json')]);
      } catch {
        t.skip('mkfifo is not available on this platform');
        return;
      }
      await writeFileIn(dir, 'conversations.json', '[]');
      const d = await discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual(names(d), ['conversations.json']);
    });
  });

  it('a FIFO given as THE input path is not a regular file or folder', async (t) => {
    await withTempDir(async (dir) => {
      const fifo = join(dir, 'pipe.json');
      try {
        execFileSync('mkfifo', [fifo]);
      } catch {
        t.skip('mkfifo is not available on this platform');
        return;
      }
      await assert.rejects(discoverInput({ kind: 'path', path: fifo }, DEFAULT_IMPORT_LIMITS), expectCode('IMPORT_UNSUPPORTED_FORMAT', 'NOT_REGULAR_FILE'));
    });
  });

  it('file names with control characters or backslashes are ignored rather than echoed', async () => {
    await withTempDir(async (dir) => {
      await writeFileIn(dir, 'conversations.json', '[]');
      await writeFileIn(dir, 'evil\nname.png', 'x');
      await writeFileIn(dir, 'back\\slash.png', 'x');
      const d = await discoverInput({ kind: 'path', path: dir }, DEFAULT_IMPORT_LIMITS);
      assert.deepEqual([...d.assetNames], []);
    });
  });
});
