/**
 * scripts/import-summary.mjs: the content-free summary of an import report (docs/FIRST_REAL_EXPORT.md). The summary is an allow-list, so
 * the tests check what is NOT in it: the batch id, labels, conversation and message ids (`sampleIds`), titles, warning messages and any
 * text of the fixtures; and that the counters it does print agree with the report. The report comes from the built CLI importing the
 * hostile and broken-tree fixtures.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REPO_ROOT, SCRIPTS_DIR, baseEnv, buildProduct, cleanupBuilds, makeTempDir, removeDir, runNode } from './scripts.helpers.test.js';
import type { ProductBuild } from './scripts.helpers.test.js';

const SCRIPT = join(SCRIPTS_DIR, 'import-summary.mjs');
let build: ProductBuild;
let work = '';

before(async () => {
  build = await buildProduct();
  work = makeTempDir('gcr-import-summary-test-');
});
after(() => {
  removeDir(work);
  cleanupBuilds();
});

async function report(fixture: string, db: string): Promise<{ text: string; json: Record<string, unknown> }> {
  const r = await runNode([join(build.dist, 'cli', 'main.js'), 'import', join(REPO_ROOT, 'fixtures', 'chatgpt', fixture), '--db', join(work, db), '--format', 'json', '--quiet'], { env: baseEnv() });
  assert.equal(r.code, 0, r.stderr);
  return { text: r.stdout, json: JSON.parse(r.stdout) as Record<string, unknown> };
}

describe('scripts/import-summary.mjs', () => {
  it('prints counts, the format profile and warning codes, and none of the identifying or textual fields', async () => {
    for (const fixture of ['broken-trees.json', 'hostile-strings.json', 'branching.json']) {
      const { text, json } = await report(fixture, `${fixture}.sqlite`);
      const file = join(work, `${fixture}.report.json`);
      writeFileSync(file, text);
      const r = await runNode([SCRIPT, file], { env: baseEnv() });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      assert.equal(out['summarySchema'], 'gcr-import-summary/1');
      const data = json['data'] as { batchId: string; sourceLabel: string; accountLabel: string; conversations: { stored: number }; messages: { stored: number } };
      assert.equal((out['conversations'] as { stored: number }).stored, data.conversations.stored);
      assert.equal((out['messages'] as { stored: number }).stored, data.messages.stored);
      // nothing identifying or textual
      for (const forbidden of [data.batchId, data.sourceLabel, data.accountLabel, 'sampleIds', '00000000-0000-4000-8000', 'GCR-SYNTHETIC-FIXTURE']) {
        assert.ok(!r.stdout.includes(forbidden), `the summary must not contain ${forbidden === data.batchId ? 'the batch id' : forbidden}`);
      }
      // only the documented top-level keys
      assert.deepEqual(Object.keys(out), ['summarySchema', 'toolVersion', 'provider', 'sourceKind', 'files', 'conversations', 'messages', 'formatProfile', 'warningCodes', 'alreadyImported']);
    }
  });

  it('warning codes are summed over the report and sorted', async () => {
    const { text, json } = await report('broken-trees.json', 'codes.sqlite');
    const file = join(work, 'codes.report.json');
    writeFileSync(file, text);
    const out = JSON.parse((await runNode([SCRIPT, file], { env: baseEnv() })).stdout) as { warningCodes: Record<string, number> };
    const expected: Record<string, number> = {};
    for (const w of (json['data'] as { warnings: Array<{ code: string; count: number }> }).warnings) expected[w.code] = (expected[w.code] ?? 0) + w.count;
    assert.deepEqual(out.warningCodes, expected);
    assert.deepEqual(Object.keys(out.warningCodes), Object.keys(out.warningCodes).slice().sort());
    assert.ok(Object.keys(out.warningCodes).length > 0);
  });

  it('replaces an unusual file name, drops directories, and reads standard input with "-"', async () => {
    const { json } = await report('branching.json', 'names.sqlite');
    const data = json['data'] as { files: Array<{ name: string }> };
    data.files[0]!.name = 'dir/inside/<script>"x".json';
    data.files.push({ name: 'export/conversations-001.json' } as never);
    const r = await runNode([SCRIPT, '-'], { env: baseEnv(), input: JSON.stringify(json) });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { files: Array<{ name: string }> };
    assert.deepEqual(out.files.map((f) => f.name), ['<redacted>', 'conversations-001.json']);
    assert.ok(!r.stdout.includes('script'));
  });

  it('refuses input that is not an import report, and bad usage, with exit 2', async () => {
    const bad = join(work, 'bad.json');
    for (const body of ['not json', '{}', '{"ok":false}', '{"ok":true,"data":{"files":"x"}}', '[]', 'null']) {
      writeFileSync(bad, body);
      const r = await runNode([SCRIPT, bad], { env: baseEnv() });
      assert.equal(r.code, 2, body);
      assert.equal(r.stdout, '');
    }
    assert.equal((await runNode([SCRIPT, join(work, 'missing.json')], { env: baseEnv() })).code, 2);
    assert.equal((await runNode([SCRIPT], { env: baseEnv() })).code, 2);
    assert.equal((await runNode([SCRIPT, 'a', 'b'], { env: baseEnv() })).code, 2);
    assert.equal((await runNode([SCRIPT, '--help'], { env: baseEnv() })).code, 0);
  });

  it('is deterministic and does not read the report twice', async () => {
    const { text } = await report('branching.json', 'det.sqlite');
    const file = join(work, 'det.report.json');
    writeFileSync(file, text);
    const a = await runNode([SCRIPT, file], { env: baseEnv() });
    const b = await runNode([SCRIPT, file], { env: baseEnv() });
    assert.equal(a.stdout, b.stdout);
    assert.equal(readFileSync(file, 'utf8'), text);
  });
});
