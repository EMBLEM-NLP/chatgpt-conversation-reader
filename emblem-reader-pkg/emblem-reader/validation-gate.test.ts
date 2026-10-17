import { test } from 'node:test'; // Exercise false-success failure modes.
import assert from 'node:assert/strict'; // Fail on any accepted incomplete evidence.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'; // Use isolated temporary evidence.
import { tmpdir } from 'node:os'; // Avoid modifying shipped captures.
import { join } from 'node:path'; // Build local fixture paths.
import { createHash } from 'node:crypto'; // Compute exact fixture identities.
import { evaluate, required } from './validation-gate.ts'; // Test the same gate used by the CLI.
const digest = (s: string) => createHash('sha256').update(s).digest('hex'); // Fixtures are synthetic and never visual evidence.
test('missing observations keep all three validation loops incomplete', () => { // A valid build hash alone cannot release the clone.
  const dir = mkdtempSync(join(tmpdir(), 'rsi-gate-')); // Create a test-only folder.
  try { // Clean up regardless of assertion outcome.
    writeFileSync(join(dir, 'candidate'), 'fixture'); // This is not a browser render.
    const m = { schema: 1 as const, candidateSha256: digest('fixture'), observations: { layout: [], interactions: [], iphone: [] } }; // Leave observations honestly empty.
    assert.equal(evaluate(m, join(dir, 'candidate'), dir).remainingValidationLoops, 3); // All three passes remain required.
    m.candidateSha256 = digest('older'); // Simulate evidence from a previous build.
    assert.throws(() => evaluate(m, join(dir, 'candidate'), dir), /does not match/); // Reject stale promotion.
  } finally { rmSync(dir, { recursive: true }); } // Remove synthetic files.
}); // End missing/stale evidence regression.
test('emulation, changed evidence, duplicate cases and unsaved downloads are rejected', () => { // Cover the known ways a fake iPhone pass could be inferred.
  const dir = mkdtempSync(join(tmpdir(), 'rsi-gate-')); // Isolate fixtures.
  try { // Always remove synthetic artifacts.
    writeFileSync(join(dir, 'candidate'), 'fixture');writeFileSync(join(dir, 'proof'), 'synthetic-proof'); // Create known bytes, not a real screenshot.
    const make = (id: string): any => ({ id, passed: true, candidateSha256: digest('fixture'), capturedAt: '2026-10-16T15:05:07Z', host: 'test-only', deviceKind: 'emulated', observed: 'synthetic unit fixture', evidence: [{ path: 'proof', sha256: digest('synthetic-proof') }] }); // Explicitly label simulated evidence.
    const m: any = { schema: 1, candidateSha256: digest('fixture'), observations: Object.fromEntries(Object.entries(required).map(([k, ids]) => [k, ids.map(make)])) }; // Fill the expected inventory to isolate individual failures.
    let r = evaluate(m, join(dir, 'candidate'), dir); // Evaluate evidence without rendering.
    assert.equal(r.loops[2].cases[0].status, 'PHYSICAL_IPHONE_REQUIRED'); // Phone dimensions cannot substitute for a device.
    assert.equal(r.loops[1].cases.find(c => c.id === 'original-download')?.status, 'SAVED_BYTES_UNVERIFIED'); // A download interaction alone is insufficient.
    m.observations.layout.push(make('opening')); // Add an ambiguous duplicate.
    assert.equal(evaluate(m, join(dir, 'candidate'), dir).loops[0].cases[0].status, 'DUPLICATE_EVIDENCE'); // Reject duplicate cherry-picking.
    writeFileSync(join(dir, 'proof'), 'changed'); // Corrupt retained evidence.
    assert.equal(evaluate(m, join(dir, 'candidate'), dir).loops[0].cases[1].status, 'MISSING_OR_CHANGED_EVIDENCE'); // Catch modified bytes.
  } finally { rmSync(dir, { recursive: true }); } // Remove synthetic fixtures.
}); // End false-success regressions.
