/**
 * SPEC-07 over MCP: gcr_audit with explicit non-tree checks returns branchProvenance as null (not zeros) next to the
 * BRANCH_PROVENANCE_NOT_COMPUTED warning, through the real SDK client and the strict output schema. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connectMem, createFixture } from './mcp.helpers.test.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';

describe('SPEC-07: gcr_audit branchProvenance', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture({ graph: false });
    h = await connectMem(fx.dbPath);
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  it('missing_model / empty / untitled only: null plus the warning, modelProvenance still measured', async () => {
    const env = await h.env('gcr_audit', { checks: ['missing_model', 'empty', 'untitled'] });
    assert.equal(env.ok, true);
    const data = env.data as { branchProvenance: unknown; modelProvenance: Record<string, number> };
    assert.equal(data.branchProvenance, null);
    assert.equal(typeof data.modelProvenance['assistantMessagesWithModel'], 'number');
    assert.ok(env.warnings.some((w) => w.code === 'BRANCH_PROVENANCE_NOT_COMPUTED'));
  });

  it('a tree check measures it (control), and the MCP result equals the SDK result', async () => {
    const env = await h.env('gcr_audit', { checks: ['no_current_node'] });
    const data = env.data as { branchProvenance: Record<string, number> | null };
    assert.ok(data.branchProvenance !== null);
    const sdk = h.gcr.audit({ checks: ['no_current_node'] });
    assert.deepEqual(data.branchProvenance, sdk.data.branchProvenance);
    assert.ok(!env.warnings.some((w) => w.code === 'BRANCH_PROVENANCE_NOT_COMPUTED'));
  });
});
