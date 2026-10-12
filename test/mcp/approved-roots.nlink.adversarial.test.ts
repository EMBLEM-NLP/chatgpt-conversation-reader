/**
 * Adversarial review of the ATK-10 rule in src/mcp/approved-roots.ts: a regular FILE with more than one hard link is refused.
 *
 * Checked from both sides:
 *  - bypass attempts: the same inode reached through a symlink inside the root, through a second name in the root, through a
 *    chain of links, with the outside name deleted again (then it is simply inside), and with a hard link that is created after
 *    one successful answer (every call looks again);
 *  - false rejections: ordinary files (a copy, a .zip, a file with spaces and non-ASCII in its name, a directory, a symlink to a
 *    single-link file inside the root) keep working, and a refusal is the SAME answer as every other refusal (no oracle).
 * Known and documented limits are pinned as such: a hard link inside an approved DIRECTORY is not looked at, and a bind mount
 * (same inode, link count 1) is invisible to a link count.
 * SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { parseApprovedRoots, resolveApprovedImportPath } from '../../src/mcp/approved-roots.js';

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function layout(): { root: string; outside: string; roots: ReturnType<typeof parseApprovedRoots> } {
  const base = realpathSync(mkdtempSync(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-nlink-')));
  made.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside, roots: parseApprovedRoots(root) };
}

async function refusal(candidate: string, roots: ReturnType<typeof parseApprovedRoots>): Promise<GcrError> {
  try {
    await resolveApprovedImportPath(candidate, roots);
  } catch (e) {
    assert.ok(e instanceof GcrError, String(e));
    return e;
  }
  assert.fail(`expected a refusal for ${candidate}`);
}

describe('bypass attempts', () => {
  it('a symbolic link inside the root to a hard-linked name inside the root is refused (the link is followed, the count is seen)', async () => {
    const { root, outside, roots } = layout();
    writeFileSync(join(outside, 'secret.json'), '[]');
    linkSync(join(outside, 'secret.json'), join(root, 'hard.json'));
    symlinkSync(join(root, 'hard.json'), join(root, 'soft.json'));
    assert.equal((await refusal(join(root, 'soft.json'), roots)).code, 'IMPORT_PATH_NOT_ALLOWED');
  });

  it('a chain of symbolic links ending at a hard-linked file is refused; a relative spelling too', async () => {
    const { root, outside, roots } = layout();
    writeFileSync(join(outside, 'secret.json'), '[]');
    linkSync(join(outside, 'secret.json'), join(root, 'hard.json'));
    symlinkSync('hard.json', join(root, 'hop2.json'));
    symlinkSync('hop2.json', join(root, 'hop1.json'));
    assert.equal((await refusal(join(root, 'hop1.json'), roots)).code, 'IMPORT_PATH_NOT_ALLOWED');
    const previous = process.cwd();
    process.chdir(root);
    try {
      assert.equal((await refusal('hop1.json', roots)).code, 'IMPORT_PATH_NOT_ALLOWED');
    } finally {
      process.chdir(previous);
    }
  });

  it('every call looks again: a link made after an earlier success refuses the next call, and removing it restores access', async () => {
    const { root, outside, roots } = layout();
    const file = join(root, 'export.json');
    writeFileSync(file, '[]');
    assert.equal(await resolveApprovedImportPath(file, roots), file);
    linkSync(file, join(outside, 'elsewhere.json'));
    await refusal(file, roots);
    unlinkSync(join(outside, 'elsewhere.json'));
    assert.equal(await resolveApprovedImportPath(file, roots), file);
  });

  it('the outside name deleted again: the file is simply inside the root and works (nothing left to bypass)', async () => {
    const { root, outside, roots } = layout();
    writeFileSync(join(outside, 'secret.json'), '[]');
    linkSync(join(outside, 'secret.json'), join(root, 'was-linked.json'));
    await refusal(join(root, 'was-linked.json'), roots);
    unlinkSync(join(outside, 'secret.json'));
    assert.equal(await resolveApprovedImportPath(join(root, 'was-linked.json'), roots), join(root, 'was-linked.json'));
  });

  it('two names for one file inside the SAME root: both are refused (documented; copy the file instead)', async () => {
    const { root, roots } = layout();
    writeFileSync(join(root, 'a.json'), '[]');
    linkSync(join(root, 'a.json'), join(root, 'b.json'));
    await refusal(join(root, 'a.json'), roots);
    await refusal(join(root, 'b.json'), roots);
  });
});

describe('no false rejections of ordinary files', () => {
  it('a copy, a .zip, an odd file name, a directory and a symlink to a single-link file all work', async () => {
    const { root, roots } = layout();
    const names = ['conversations.json', 'export.zip', 'my export (1) é日.json', '.hidden.json'];
    for (const name of names) {
      writeFileSync(join(root, name), 'x');
      assert.equal(await resolveApprovedImportPath(join(root, name), roots), join(root, name), name);
    }
    mkdirSync(join(root, 'folder', 'nested'), { recursive: true });
    assert.equal(await resolveApprovedImportPath(join(root, 'folder'), roots), join(root, 'folder'), 'a directory always has several links');
    assert.equal(await resolveApprovedImportPath(join(root, 'folder', 'nested'), roots), join(root, 'folder', 'nested'));
    symlinkSync(join(root, 'conversations.json'), join(root, 'alias.json'));
    assert.equal(await resolveApprovedImportPath(join(root, 'alias.json'), roots), join(root, 'conversations.json'), 'the canonical path is returned');
    assert.equal(await resolveApprovedImportPath(root, roots), root, 'the root itself');
  });

  it('an empty file and a file that was rewritten in place keep a link count of one', async () => {
    const { root, roots } = layout();
    const file = join(root, 'e.json');
    writeFileSync(file, '');
    assert.equal(await resolveApprovedImportPath(file, roots), file);
    writeFileSync(file, '[1]');
    assert.equal(await resolveApprovedImportPath(file, roots), file);
  });
});

describe('the refusal is one answer', () => {
  it('a hard-linked file, a missing file and an outside file give the same code, message, remedy and details', async () => {
    const { root, outside, roots } = layout();
    writeFileSync(join(outside, 'secret.json'), '[]');
    linkSync(join(outside, 'secret.json'), join(root, 'hard.json'));
    const answers = [await refusal(join(root, 'hard.json'), roots), await refusal(join(root, 'missing.json'), roots), await refusal(join(outside, 'secret.json'), roots)];
    const first = answers[0];
    assert.ok(first !== undefined);
    for (const a of answers) {
      assert.equal(a.code, first.code);
      assert.equal(a.message, first.message);
      assert.equal(a.remedy, first.remedy);
      assert.deepEqual(a.details, first.details);
    }
    assert.match(first.remedy ?? '', /hard link/i, 'the remedy tells the operator what else is refused');
    assert.equal(JSON.stringify([first.message, first.remedy, first.details]).includes(root), false, 'no path is echoed');
  });
});

describe('documented limits (pinned so the documentation and the behaviour cannot drift apart)', () => {
  it('a hard link INSIDE an approved directory is not looked at when the directory is the path', async () => {
    const { root, outside, roots } = layout();
    mkdirSync(join(root, 'export'));
    writeFileSync(join(outside, 'secret.json'), '[]');
    linkSync(join(outside, 'secret.json'), join(root, 'export', 'conversations.json'));
    assert.equal(await resolveApprovedImportPath(join(root, 'export'), roots), join(root, 'export'), 'docs/SECURITY_AND_BOUNDARIES.md section 9: the importer walks the directory itself');
  });
});
