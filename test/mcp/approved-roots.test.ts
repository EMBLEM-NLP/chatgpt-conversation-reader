/**
 * Approved import roots (src/mcp/approved-roots.ts): the fence that keeps a language-model-driven client from pointing the
 * importer at arbitrary files. Real directories and real symlinks in a temp dir; no mocks.
 */
import assert from 'node:assert/strict';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import { NO_APPROVED_ROOTS, importDisabledError, isInsideRoot, parseApprovedRoots, resolveApprovedImportPath } from '../../src/mcp/approved-roots.js';
import { makeTempDir, removeDir } from './mcp.helpers.test.js';

async function refused(p: Promise<unknown>): Promise<GcrError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${String(e)}`);
    assert.equal(e.code, 'IMPORT_PATH_NOT_ALLOWED');
    return e;
  }
  assert.fail('expected the path to be refused');
}

describe('parseApprovedRoots', () => {
  let dir: string;
  let a: string;
  let b: string;
  let file: string;
  before(async () => {
    dir = await realpath(await makeTempDir());
    a = join(dir, 'a');
    b = join(dir, 'b');
    file = join(dir, 'plain-file.txt');
    await mkdir(a);
    await mkdir(b);
    await writeFile(file, 'x');
    await symlink(a, join(dir, 'link-to-a'));
  });
  after(() => removeDir(dir));

  it('unset or empty means no roots: import is disabled', () => {
    assert.deepEqual(parseApprovedRoots(undefined), NO_APPROVED_ROOTS);
    assert.deepEqual(parseApprovedRoots(''), NO_APPROVED_ROOTS);
    assert.deepEqual(NO_APPROVED_ROOTS.roots, []);
    assert.ok(Object.isFrozen(NO_APPROVED_ROOTS), 'the shared empty default cannot be mutated');
  });

  it('splits on the platform delimiter, keeps order, and ignores empty segments', () => {
    const parsed = parseApprovedRoots(`${a}${delimiter}${delimiter}${b}${delimiter}`);
    assert.deepEqual(parsed.roots, [a, b]);
    assert.equal(parsed.ignored, 0);
  });

  it('honours an explicit delimiter (so the Windows ";" form is testable everywhere)', () => {
    assert.deepEqual(parseApprovedRoots(`${a};${b}`, ';').roots, [a, b]);
  });

  it('stores the canonical (realpath) form and removes duplicates', () => {
    const parsed = parseApprovedRoots(`${join(dir, 'link-to-a')}${delimiter}${a}${delimiter}${a}`);
    assert.deepEqual(parsed.roots, [a]);
  });

  it('counts, and never keeps, entries that cannot be roots: relative, missing, a file, the filesystem root, NUL', () => {
    const parsed = parseApprovedRoots([a, 'relative/dir', join(dir, 'nope'), file, '/', `${a}\u0000x`].join(delimiter));
    assert.deepEqual(parsed.roots, [a]);
    assert.equal(parsed.ignored, 5);
  });
});

describe('isInsideRoot (pure containment on canonical paths)', () => {
  it('equal and descendants are inside', () => {
    assert.equal(isInsideRoot('/a/root', '/a/root'), true);
    assert.equal(isInsideRoot('/a/root', '/a/root/x'), true);
    assert.equal(isInsideRoot('/a/root', '/a/root/x/y/z.zip'), true);
    assert.equal(isInsideRoot('/a/root/', '/a/root/x'), true);
  });

  it('the sibling-prefix trick is outside: /a/root-evil is not under /a/root', () => {
    assert.equal(isInsideRoot('/a/root', '/a/root-evil'), false);
    assert.equal(isInsideRoot('/a/root', '/a/root-evil/x'), false);
    assert.equal(isInsideRoot('/a/root', '/a/rootx'), false);
  });

  it('parents, siblings and unrelated paths are outside', () => {
    assert.equal(isInsideRoot('/a/root', '/a'), false);
    assert.equal(isInsideRoot('/a/root', '/'), false);
    assert.equal(isInsideRoot('/a/root', '/b/root'), false);
    assert.equal(isInsideRoot('/a/root', '/a/other/root'), false);
  });

  it('a directory literally named "..foo" is inside (it is not an escape)', () => {
    assert.equal(isInsideRoot('/a/root', '/a/root/..foo'), true);
    assert.equal(isInsideRoot('/a/root', '/a/root/..foo/bar'), true);
  });

  it('property: a path built by appending segments is inside; one that climbs out is not', () => {
    const segment = fc.stringMatching(/^[a-z0-9_-]{1,8}$/);
    fc.assert(
      fc.property(fc.array(segment, { minLength: 0, maxLength: 5 }), (segments) => {
        assert.equal(isInsideRoot('/srv/exports', ['/srv/exports', ...segments].join('/')), true);
      }),
      { seed: 20261010, numRuns: 100 },
    );
    fc.assert(
      fc.property(segment, fc.array(segment, { minLength: 0, maxLength: 4 }), (sibling, segments) => {
        fc.pre(sibling !== 'exports');
        assert.equal(isInsideRoot('/srv/exports', ['/srv', sibling, ...segments].join('/')), false);
      }),
      { seed: 20261010, numRuns: 100 },
    );
  });
});

describe('resolveApprovedImportPath', () => {
  let dir: string;
  let root: string;
  let rootEvil: string;
  let outside: string;
  let other: string;
  before(async () => {
    dir = await realpath(await makeTempDir());
    root = join(dir, 'root');
    rootEvil = join(dir, 'root-evil');
    outside = join(dir, 'outside');
    other = join(dir, 'other-root');
    for (const d of [root, join(root, 'sub'), rootEvil, outside, other]) await mkdir(d, { recursive: true });
    await writeFile(join(root, 'export.zip'), 'zip');
    await writeFile(join(root, 'sub', 'data.json'), '[]');
    await writeFile(join(rootEvil, 'export.zip'), 'evil');
    await writeFile(join(outside, 'secret.json'), '[]');
    await writeFile(join(other, 'second.json'), '[]');
    await symlink(join(outside, 'secret.json'), join(root, 'escape-file'));
    await symlink(outside, join(root, 'escape-dir'));
    await symlink(join(root, 'sub', 'data.json'), join(root, 'inside-link'));
    await symlink(join(root, 'sub'), join(root, 'inside-dir-link'));
    await symlink(join(root, 'nowhere'), join(root, 'dangling'));
  });
  after(() => removeDir(dir));

  const approved = (): ReturnType<typeof parseApprovedRoots> => parseApprovedRoots(root);

  it('with no root configured the tool is disabled and the error says how to enable it', async () => {
    const err = await refused(resolveApprovedImportPath(join(root, 'export.zip'), NO_APPROVED_ROOTS));
    assert.equal(err.details?.['reason'], 'no_approved_roots');
    assert.match(err.remedy ?? '', /GCR_APPROVED_IMPORT_ROOTS/);
    assert.match(err.remedy ?? '', /--allow-local-writes/);
    assert.deepEqual(err.toEnvelope(), importDisabledError().toEnvelope());
  });

  it('a file inside the root is allowed and the canonical path is returned', async () => {
    assert.equal(await resolveApprovedImportPath(join(root, 'export.zip'), approved()), join(root, 'export.zip'));
    assert.equal(await resolveApprovedImportPath(join(root, 'sub', 'data.json'), approved()), join(root, 'sub', 'data.json'));
  });

  it('the root itself, a sub-directory and a path with a trailing slash are allowed', async () => {
    assert.equal(await resolveApprovedImportPath(root, approved()), root);
    assert.equal(await resolveApprovedImportPath(`${root}/`, approved()), root);
    assert.equal(await resolveApprovedImportPath(join(root, 'sub'), approved()), join(root, 'sub'));
  });

  it('a symlink that stays inside the root is allowed, and the returned path is the target, not the link', async () => {
    assert.equal(await resolveApprovedImportPath(join(root, 'inside-link'), approved()), join(root, 'sub', 'data.json'));
    assert.equal(await resolveApprovedImportPath(join(root, 'inside-dir-link', 'data.json'), approved()), join(root, 'sub', 'data.json'));
  });

  it('a symlink that leaves the root is refused (file link, directory link, and a path through the directory link)', async () => {
    await refused(resolveApprovedImportPath(join(root, 'escape-file'), approved()));
    await refused(resolveApprovedImportPath(join(root, 'escape-dir'), approved()));
    await refused(resolveApprovedImportPath(join(root, 'escape-dir', 'secret.json'), approved()));
  });

  it('".." is refused, even when it would resolve inside the root', async () => {
    await refused(resolveApprovedImportPath(join(root, '..', 'outside', 'secret.json'), approved()));
    await refused(resolveApprovedImportPath(`${root}/sub/../export.zip`, approved()));
    await refused(resolveApprovedImportPath(`${root}\\..\\outside`, approved()));
    await refused(resolveApprovedImportPath('..', approved()));
  });

  it('an absolute path outside the root is refused', async () => {
    await refused(resolveApprovedImportPath(join(outside, 'secret.json'), approved()));
    await refused(resolveApprovedImportPath('/etc/passwd', approved()));
    await refused(resolveApprovedImportPath('/', approved()));
    await refused(resolveApprovedImportPath(dir, approved())); // the parent of the root
  });

  it('the sibling-prefix trick is refused: root-evil is not root', async () => {
    await refused(resolveApprovedImportPath(join(rootEvil, 'export.zip'), approved()));
    await refused(resolveApprovedImportPath(rootEvil, approved()));
  });

  it('a missing file, a dangling symlink and an empty string are refused', async () => {
    await refused(resolveApprovedImportPath(join(root, 'missing.zip'), approved()));
    await refused(resolveApprovedImportPath(join(root, 'dangling'), approved()));
    await refused(resolveApprovedImportPath('', approved()));
  });

  it('NUL bytes, non-strings and oversized paths are refused before the file system is asked', async () => {
    await refused(resolveApprovedImportPath(`${join(root, 'export.zip')}\u0000.png`, approved()));
    await refused(resolveApprovedImportPath('\u0000', approved()));
    await refused(resolveApprovedImportPath(undefined, approved()));
    await refused(resolveApprovedImportPath(42, approved()));
    await refused(resolveApprovedImportPath({ toString: () => root }, approved()));
    await refused(resolveApprovedImportPath(`${root}/${'a'.repeat(5000)}`, approved()));
  });

  it('every refusal of the path itself is the SAME error: no oracle for what exists outside the root', async () => {
    const answers = new Set<string>();
    for (const p of [join(outside, 'secret.json'), join(root, 'missing'), join(root, 'escape-file'), '/etc/passwd', `${root}-evil`, join(root, '..', 'x')]) {
      answers.add(JSON.stringify((await refused(resolveApprovedImportPath(p, approved()))).toEnvelope()));
    }
    assert.equal(answers.size, 1);
  });

  it('the refusal never echoes the candidate or the configured roots', async () => {
    const err = await refused(resolveApprovedImportPath(join(outside, 'secret.json'), approved()));
    const text = JSON.stringify(err.toEnvelope());
    assert.ok(!text.includes('secret.json') && !text.includes(outside) && !text.includes(root));
  });

  it('several roots: a path under any of them is allowed, the rest are not', async () => {
    const two = parseApprovedRoots([root, other].join(delimiter));
    assert.equal(await resolveApprovedImportPath(join(other, 'second.json'), two), join(other, 'second.json'));
    assert.equal(await resolveApprovedImportPath(join(root, 'export.zip'), two), join(root, 'export.zip'));
    await refused(resolveApprovedImportPath(join(outside, 'secret.json'), two));
  });

  it('the approval is frozen at startup: replacing the root by a symlink later does not widen it', async () => {
    const swapDir = join(dir, 'swap');
    await mkdir(join(swapDir, 'real'), { recursive: true });
    await writeFile(join(swapDir, 'real', 'in.json'), '[]');
    const frozen = parseApprovedRoots(join(swapDir, 'real'));
    // the operator's directory is moved away and a symlink to somewhere else takes its place
    const { rename, rm } = await import('node:fs/promises');
    await rename(join(swapDir, 'real'), join(swapDir, 'moved'));
    await symlink(outside, join(swapDir, 'real'));
    try {
      await refused(resolveApprovedImportPath(join(swapDir, 'real', 'secret.json'), frozen));
    } finally {
      await rm(join(swapDir, 'real'), { force: true });
    }
  });

  it('a relative path resolves against the working directory and is checked like any other', async () => {
    const original = process.cwd();
    process.chdir(root);
    try {
      assert.equal(await resolveApprovedImportPath('export.zip', approved()), join(root, 'export.zip'));
      assert.equal(await resolveApprovedImportPath(join('sub', 'data.json'), approved()), join(root, 'sub', 'data.json'));
      await refused(resolveApprovedImportPath('missing.zip', approved()));
    } finally {
      process.chdir(original);
    }
  });

  it('resolve() of the root is what a caller would pass: the checks use the canonical form on both sides', async () => {
    assert.equal(await resolveApprovedImportPath(resolve(root, 'export.zip'), approved()), join(root, 'export.zip'));
  });
});
