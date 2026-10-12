/**
 * machineLeaks() (test/scripts/scripts.helpers.test.ts) and the generated documents. Regression for TQ-01 of the round-2 test
 * review: the leak check of the performance document searched for the bare OS user name, so it failed for every account whose
 * name is an ordinary word that the prose uses ("runner" on GitHub-hosted runners, "node" in the devcontainer, "nobody", "user",
 * "build", "sandbox"). The check is now shape-based; this file proves that it still catches real leaks and that the committed
 * generated pages do not trip it for any of those names.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, machineLeaks } from './scripts.helpers.test.js';

const COMMON_ACCOUNT_NAMES = ['runner', 'node', 'nobody', 'user', 'build', 'sandbox', 'vscode', 'codespace', 'ubuntu', 'root', 'docs', 'test', 'admin'] as const;

describe('machineLeaks', () => {
  it('flags a path wherever it occurs', () => {
    assert.deepEqual(machineLeaks('see /srv/gcr-work/x for details', ['/srv/gcr-work'], []), ['path #0']);
    assert.deepEqual(machineLeaks('nothing here', ['/srv/gcr-work'], []), []);
  });

  it('ignores very short or root paths (they would match almost any text)', () => {
    assert.deepEqual(machineLeaks('a / b /a/b', ['/', '/a'], []), []);
  });

  it('flags a name in the shapes that identify a machine', () => {
    for (const text of ['/home/alice/work', 'C:\\Users\\alice\\work', 'alice@laptop', 'ssh bob@alice', 'at /alice']) {
      assert.deepEqual(machineLeaks(text, [], ['alice']), ['name #0'], text);
    }
  });

  it('does not flag the same name used as an ordinary word', () => {
    for (const text of ['a small CI runner or a Codespace', 'so nobody has to guess', 'the user can build a node', 'current_node and node dist/cli/main.js', 'docs/ARCHITECTURE.md']) {
      for (const name of COMMON_ACCOUNT_NAMES) assert.deepEqual(machineLeaks(text, [], [name]), [], `${name} in ${text}`);
    }
  });

  it('treats regular-expression characters in a name literally', () => {
    assert.deepEqual(machineLeaks('/home/a.b/x', [], ['a.b']), ['name #0']);
    assert.deepEqual(machineLeaks('/home/aXb/x', [], ['a.b']), []);
    assert.deepEqual(machineLeaks('/home/(x/y', [], ['(x']), ['name #0']);
  });

  it('does not repeat the leaked value in its answer', () => {
    const answer = machineLeaks('/home/very-secret-name/x', ['/home/very-secret-name'], ['very-secret-name']).join(' ');
    assert.ok(!answer.includes('very-secret-name'));
  });
});

describe('generated documents do not trip the leak check for common CI account names', () => {
  for (const page of ['PERFORMANCE.md', 'AUDIT_REPORT.md', 'COVERAGE.md']) {
    it(`docs/${page}`, () => {
      const text = readFileSync(join(REPO_ROOT, 'docs', page), 'utf8');
      assert.deepEqual(machineLeaks(text, [], [...COMMON_ACCOUNT_NAMES]), []);
    });
  }
});
