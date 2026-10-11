/**
 * Adversarial review of the approved-roots fence (MCP lens: "tools that read outside what they claim: approved roots,
 * symlink and .. escapes, TOCTOU").
 *
 * What is pinned here that approved-roots.test.ts does not cover:
 *  - the roots and the candidates are canonicalized by the SAME primitive. `fs.promises.realpath` is the native `realpath(3)`
 *    ("same semantics as fs.realpath.native"), while `fs.realpathSync` is a JavaScript re-implementation that keeps the spelling
 *    it was given where no symlink is involved. On a case-insensitive file system (macOS, Windows) the two disagree about the
 *    letter case of the very same directory, so a root typed in another case than the one on disk made EVERY candidate fall
 *    "outside" (the fence failed closed, but the feature was unusable for exactly the desktop platforms VS Code runs on). Linux is
 *    case-sensitive, so the defect is not reproducible here; the source-level check keeps the two calls from drifting apart again
 *    and the behavioural checks below pin the Linux semantics both flavours must agree on.
 *  - devices, FIFOs and sockets under a root (opening a FIFO blocks forever);
 *  - an extracted FOLDER inside a root whose entries are symlinks that leave the root (the importer must not follow them);
 *  - spellings of the same path: repeated and trailing separators, `.` segments, a root given through a symlink.
 */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { parseApprovedRoots, resolveApprovedImportPath } from '../../src/mcp/approved-roots.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { connectMem, conversationsJson, createFixture, dbContentHash, linearChat, makeTempDir, removeDir, tableRows } from './mcp.helpers.test.js';

async function refusedWith(promise: Promise<unknown>): Promise<GcrError> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof GcrError);
    assert.equal(e.code, 'IMPORT_PATH_NOT_ALLOWED');
    return e;
  }
  assert.fail('expected IMPORT_PATH_NOT_ALLOWED');
}

describe('roots and candidates share one canonicalization', () => {
  it('the source resolves roots with the native realpath, like fs.promises.realpath does for candidates', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const src = await readFile(`${repoRoot}src/mcp/approved-roots.ts`, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /\brealpathSync\s*\(/, 'a bare realpathSync( is the JavaScript implementation, which does not canonicalize letter case');
    assert.match(code, /realpathSync\.native\s*\(/);
    assert.match(code, /from 'node:fs\/promises'/);
    assert.match(code, /\brealpath\s*\(/);
  });

  describe('on this platform both spell every directory the same way', () => {
    let dir: string;
    before(async () => {
      dir = await realpath(await makeTempDir());
      await mkdir(join(dir, 'real', 'sub'), { recursive: true });
      await symlink(join(dir, 'real'), join(dir, 'via-link'));
      await writeFile(join(dir, 'real', 'sub', 'x.json'), '[]');
    });
    after(() => removeDir(dir));

    it('whatever way the root is spelled, its stored form equals what promises.realpath answers for a path inside it', async () => {
      const real = join(dir, 'real');
      const link = join(dir, 'via-link');
      for (const spelling of [real, `${real}/`, link, `${link}//`, `${real}/./`]) {
        const parsed = parseApprovedRoots(spelling);
        const root = parsed.roots[0];
        assert.equal(root, real, `the stored root of ${spelling}`);
        const candidate = `${spelling}${spelling.endsWith('/') ? '' : '/'}sub/x.json`;
        const probe = await realpath(candidate);
        assert.ok(probe.startsWith(`${root}/`), `${root} must be a prefix of ${probe}`);
        assert.equal(await resolveApprovedImportPath(candidate, parsed), probe);
      }
    });
  });
});

describe('special files and odd spellings under a root', () => {
  let dir: string;
  let root: string;
  before(async () => {
    dir = await realpath(await makeTempDir());
    root = join(dir, 'root');
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'ok.json'), '[]');
  });
  after(() => removeDir(dir));

  it('a FIFO inside the root is refused like anything else that is not a file or a folder (opening it would block forever)', async (t) => {
    const fifo = join(root, 'pipe');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      t.skip('mkfifo is not available');
      return;
    }
    await refusedWith(resolveApprovedImportPath(fifo, parseApprovedRoots(root)));
  });

  it('separators and "." segments in the spelling are normalized away; ".." in any position is refused', async () => {
    const approved = parseApprovedRoots(root);
    const ok = join(root, 'sub', 'ok.json');
    assert.equal(await resolveApprovedImportPath(`${root}//sub///ok.json`, approved), ok);
    assert.equal(await resolveApprovedImportPath(`${root}/./sub/./ok.json`, approved), ok);
    assert.equal(await resolveApprovedImportPath(`${root}/sub/`, approved), join(root, 'sub'));
    for (const bad of [`${root}/sub/../sub/ok.json`, `${root}/..`, `${root}/sub/..`, `${root}\\..\\x`, `../${'root'}/sub/ok.json`, '..', '.. ']) {
      await refusedWith(resolveApprovedImportPath(bad, approved));
    }
    // Look-alikes of "..": these are ordinary (missing) names, refused because they do not exist, not because of a segment test.
    for (const lookalike of [`${root}/sub/.../ok.json`, `${root}/sub/‥/ok.json`, `${root}/sub/%2e%2e/ok.json`]) {
      await refusedWith(resolveApprovedImportPath(lookalike, approved));
    }
  });

  it('a NUL byte or a line break inside a configured root only costs that entry', () => {
    const parsed = parseApprovedRoots(`${root}\0evil:${root}\n:${root}`);
    assert.deepEqual(parsed.roots, [root]);
    assert.equal(parsed.ignored, 2);
  });
});

describe('through the tool: an extracted folder whose members leave the root is not followed', () => {
  it('a conversations.json that is a symlink to a file outside the root is skipped and imports nothing', async () => {
    const fx = await createFixture({ graph: false });
    const dir = await realpath(await makeTempDir());
    try {
      const root = join(dir, 'root');
      const outside = join(dir, 'outside');
      await mkdir(join(root, 'folder'), { recursive: true });
      await mkdir(outside);
      const outsideId = syntheticUuid(0xbad);
      const secret = join(outside, 'conversations.json');
      await writeFile(secret, conversationsJson([linearChat(outsideId, 'SECRET OUTSIDE THE ROOT', [['secret question', 'secret answer']])]));
      await symlink(secret, join(root, 'folder', 'conversations.json'));
      await symlink(outside, join(root, 'folder', 'nested'));

      const h = await connectMem(fx.dbPath, { writable: true, server: { approvedImportRoots: parseApprovedRoots(root) } });
      try {
        const before = dbContentHash(fx.dbPath);
        const env = await h.env('gcr_import_export', { path: join(root, 'folder') });
        assert.equal(env.ok, false, 'there is no conversation file inside the folder that the importer may read');
        assert.equal(env.error?.code, 'IMPORT_UNSUPPORTED_FORMAT');
        assert.ok(Number(env.error?.details?.['symlinksSkipped']) >= 1, 'the importer says it skipped symbolic links');
        assert.equal(dbContentHash(fx.dbPath), before, 'nothing was stored');
        assert.doesNotMatch(JSON.stringify(env), /SECRET OUTSIDE|secret question/);
        assert.equal(tableRows(fx.dbPath, 'conversations').some((r) => r['conversation_id'] === outsideId), false);

        // The same file named directly is refused by the fence (its canonical path is outside the root).
        const direct = await h.env('gcr_import_export', { path: join(root, 'folder', 'conversations.json') });
        assert.equal(direct.error?.code, 'IMPORT_PATH_NOT_ALLOWED');
      } finally {
        await h.close();
      }
    } finally {
      await removeDir(dir);
      await fx.cleanup();
    }
  });
});
