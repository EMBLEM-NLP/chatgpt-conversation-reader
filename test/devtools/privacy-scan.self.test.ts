/**
 * The scanner pointed at THIS repository (work tree + index only, never history), strictly read-only.
 *
 * This is the same check as `npm run privacy-scan`, run inside the unit suite so that a committed or merely
 * untracked file containing a credential, a private conversation URL, a raw export or a database fails the build
 * even when nobody remembered to run the script. History is deliberately not scanned here: a finding in an old
 * commit cannot be fixed by editing a file, so it would make this test permanently red. Use
 * `node scripts/privacy-scan.mjs --history` for that, and treat any hit as a rewrite-or-rotate decision.
 */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { formatFindings, scanRepo } from '../../src/devtools/privacy-scan.js';

// Compiled tests live at <root>/<outDir>/test/devtools, whatever the out dir is called.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

async function isCheckout(root: string): Promise<boolean> {
  try {
    await access(join(root, '.git'));
    await access(join(root, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

describe('this repository', async () => {
  const checkout = await isCheckout(repoRoot);

  it('has no privacy findings in tracked, staged or untracked-but-not-ignored files', { skip: checkout ? false : 'not running inside a git checkout' }, async () => {
    const result = await scanRepo(repoRoot);
    assert.ok(result.scannedFiles > 0, 'the scan must actually read files');
    assert.deepEqual(result.findings, [], `privacy findings (details are masked):\n${formatFindings(result.findings)}`);
    assert.deepEqual(result.notes, []);
  });
});
