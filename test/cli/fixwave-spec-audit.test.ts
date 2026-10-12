/**
 * SPEC-07 at the CLI: `gcr audit --missing-model --empty --untitled` must not print real-looking zeros for branchProvenance.
 * JSON / JSONL carry `null` (plus the BRANCH_PROVENANCE_NOT_COMPUTED warning); markdown and compact say "not computed" (the
 * generic renderers would otherwise print a bare "null"). With a tree flag the value is a measured object in every format.
 * SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FORMATS, assertOk, envelope, gcr, obj, parseJsonl, templateDb } from './cli.helpers.test.js';
import type { Format } from './cli.helpers.test.js';

let dbPath = '';
before(async () => {
  ({ dbPath } = await templateDb());
});

async function audit(flags: string[], format: Format): Promise<string> {
  const r = await gcr(['audit', ...flags, '--db', dbPath, '--format', format]);
  assertOk(r, `gcr audit ${flags.join(' ')} --format ${format}`);
  return r.stdout;
}

const SPEC_FORM = ['--missing-model', '--empty', '--untitled'];

describe('SPEC-07: gcr audit with explicit non-tree flags', () => {
  it('json: branchProvenance is null and the warning is present', async () => {
    const env = envelope(await audit(SPEC_FORM, 'json'));
    assert.equal(env.data['branchProvenance'], null);
    assert.ok('branchProvenance' in env.data, 'the key is present (null), not omitted');
    assert.ok(env.warnings.some((w) => w.code === 'BRANCH_PROVENANCE_NOT_COMPUTED'));
    assert.ok(obj(env.data['modelProvenance']), 'modelProvenance is still measured');
  });

  it('jsonl: the data line carries null', async () => {
    const lines = parseJsonl(await audit(SPEC_FORM, 'jsonl'));
    const data = lines.find((l) => l['type'] === 'data');
    assert.ok(data !== undefined);
    assert.equal(obj(data['data'])['branchProvenance'], null);
  });

  for (const format of ['markdown', 'compact'] as const) {
    it(`${format}: says "not computed" instead of zeros or a bare null`, async () => {
      const out = await audit(SPEC_FORM, format);
      assert.match(out, /not computed/);
      assert.doesNotMatch(out, /conversationsWithKnownActiveBranch/, 'no measured-looking breakdown');
      assert.match(out, /BRANCH_PROVENANCE_NOT_COMPUTED/);
    });
  }

  it('a tree flag measures it in every format (control)', async () => {
    for (const format of FORMATS) {
      const out = await audit(['--no-current-node'], format);
      if (format === 'json') assert.ok(obj(envelope(out).data['branchProvenance']));
      else assert.match(out, /conversationsWithKnownActiveBranch/);
      assert.doesNotMatch(out, /BRANCH_PROVENANCE_NOT_COMPUTED/);
    }
  });
});
