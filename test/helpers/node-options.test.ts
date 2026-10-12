/**
 * test/helpers/node-options.ts: the NODE_OPTIONS quoting the environment-robust tests rely on (TQ-06). Real child processes: a
 * preload in a directory whose name contains a space, a quote, a backslash or non-ASCII letters must run, and a path without any
 * special character must be passed through unchanged.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { quoteNodeOptionValue, requireOption } from './node-options.js';

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function preloadIn(dirName: string): string {
  const root = mkdtempSync(join(process.env['GCR_TEST_TMPDIR'] ?? tmpdir(), 'gcr-nodeopt-'));
  made.push(root);
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'preload.cjs');
  writeFileSync(file, "process.stdout.write('PRELOAD-RAN');\n");
  return file;
}

function runWithOption(option: string): string {
  const r = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', NODE_OPTIONS: option } });
  return `${r.stdout}${r.stderr}`;
}

describe('quoteNodeOptionValue / requireOption', () => {
  it('leaves a path without special characters alone', () => {
    assert.equal(quoteNodeOptionValue('/tmp/plain-dir/preload.cjs'), '/tmp/plain-dir/preload.cjs');
    assert.equal(requireOption('/tmp/plain-dir/preload.cjs'), '--require=/tmp/plain-dir/preload.cjs');
  });

  it('quotes a path with whitespace, quotes or backslashes and escapes the characters that would end the quoting', () => {
    assert.equal(quoteNodeOptionValue('/tmp/a b/p.cjs'), '"/tmp/a b/p.cjs"');
    assert.equal(quoteNodeOptionValue('/tmp/a"b/p.cjs'), '"/tmp/a\\"b/p.cjs"');
    assert.equal(quoteNodeOptionValue('/tmp/a\\b/p.cjs'), '"/tmp/a\\\\b/p.cjs"');
  });

  for (const dirName of ['plain', 'with space', 'tab\tinside', "it's", 'quo"te', 'back\\slash', 'ü ñ 日本', 'trailing space ']) {
    it(`a preload in a directory named ${JSON.stringify(dirName)} is loaded by the child`, () => {
      const file = preloadIn(dirName);
      assert.equal(runWithOption(requireOption(file)), 'PRELOAD-RAN');
    });
  }

  it('control: the unquoted form of a path with a space is NOT loaded (this is what the helper protects against)', () => {
    const file = preloadIn('with space');
    assert.notEqual(runWithOption(`--require=${file}`), 'PRELOAD-RAN');
  });
});
