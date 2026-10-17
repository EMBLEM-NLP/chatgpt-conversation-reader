import { test } from 'node:test'; // Test the evidence engine without launching a browser.
import assert from 'node:assert/strict'; // Fail loudly on invalid pass conditions.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'; // Keep invented test pixels separate from UI evidence.
import { tmpdir } from 'node:os'; // Use disposable local test storage.
import { join } from 'node:path'; // Build platform-safe test filenames.
import { PNG } from 'pngjs'; // Create explicitly synthetic pixels for algorithm verification.
import { compare, digest, eligibility } from './compare.ts'; // Exercise real comparison code, not browser substitutes.
import { review } from './review.ts'; // Verify missing-evidence report behavior.
import type { Capture } from './types.ts'; // Validate the metadata contract.
const directory = mkdtempSync(join(tmpdir(), 'rsi-web-unit-')); // Isolate unit fixtures from delivered captures.
function fixture(side: 'reference' | 'candidate', changed = false, width = 20): Capture { // Create a synthetic comparator input, never a claimed chat render.
  const png = new PNG({ width, height: 20 }); png.data.fill(255); // Start with a white opaque square.
  if (changed) for (let y = 3; y < 17; y++) for (let x = 3; x < 17; x++) { const i = (y * width + x) * 4; png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; } // Insert a visible synthetic rectangle.
  const bytes = PNG.sync.write(png), image = join(directory, `${side}-${changed}-${width}.png`); writeFileSync(image, bytes); // Persist a known input and hash it.
  return { schema: 1, caseId: 'synthetic-unit-only', side, status: 'CAPTURED', capturedAt: '2026-10-16T00:00:00Z', timezone: 'America/Toronto', viewport: { width: 390, height: 844 }, engine: 'synthetic-unit', platform: 'synthetic-unit', theme: 'dark', region: 'element', contentHash: 'same-test-text', image, imageSha256: digest(bytes) }; // Label these fixtures unmistakably.
} // End synthetic input construction.
test('missing and blocked frames never pass', () => { assert.equal(eligibility(undefined, fixture('candidate')), 'MISSING_CAPTURE'); assert.equal(eligibility({ ...fixture('reference'), status: 'BLOCKED' }, fixture('candidate')), 'CAPTURE_BLOCKED'); }); // Exercise the critical missing-render gate.
test('candidate cannot serve as its own reference', () => { assert.equal(eligibility(fixture('candidate'), fixture('candidate')), 'WRONG_CAPTURE_SIDE'); }); // Prevent accidental auto-baselining.
test('content identity and viewport are enforced', () => { assert.equal(eligibility(fixture('reference'), { ...fixture('candidate'), contentHash: 'other' }), 'CONTENT_MISMATCH'); assert.equal(eligibility(fixture('reference'), { ...fixture('candidate'), viewport: { width: 430, height: 844 } }), 'VIEWPORT_MISMATCH'); }); // Reject unrelated message and scale comparisons.
test('browser host and theme are enforced', () => { assert.equal(eligibility(fixture('reference'), { ...fixture('candidate'), engine: 'other' }), 'RENDERER_MISMATCH'); assert.equal(eligibility(fixture('reference'), { ...fixture('candidate'), theme: 'light' }), 'THEME_MISMATCH'); }); // Reject incompatible rendering environments.
test('identical synthetic pixels meet tolerance', () => { assert.equal(compare(fixture('reference'), fixture('candidate'), join(directory, 'equal.png')).status, 'WITHIN_PIXEL_TOLERANCE'); }); // Verify the exact-image branch.
test('real pixel differences produce a nonzero diff', () => { const result = compare(fixture('reference'), fixture('candidate', true), join(directory, 'changed.png')); assert.equal(result.status, 'VISUAL_DIFFERENCE'); assert.ok(result.mismatchRatio! > .02); }); // Verify the failure branch with distinct pixels.
test('different image dimensions are not stretched', () => { assert.equal(compare(fixture('reference'), fixture('candidate', false, 21), join(directory, 'size.png')).status, 'GEOMETRY_MISMATCH'); }); // Preserve geometry failures.
test('changed evidence bytes are rejected', () => { assert.equal(compare({ ...fixture('reference'), imageSha256: 'wrong' }, fixture('candidate'), join(directory, 'hash.png')).status, 'HASH_MISMATCH'); }); // Detect stale evidence.
test('report retains missing-candidate slate and escapes metadata', () => { const output = join(directory, 'review.html'); review([{ id: '<script>alert(1)</script>', result: { status: 'MISSING_CAPTURE' } }], output); const html = readFileSync(output, 'utf8'); assert.ok(html.includes('MISSING CAPTURE')); assert.ok(!html.includes('<script>')); }); // Keep evidence honest and inert.
