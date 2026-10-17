import { readFileSync, writeFileSync } from 'node:fs'; // Read only explicit local captures.
import { createHash } from 'node:crypto'; // Detect changed screenshot bytes before comparison.
import { PNG } from 'pngjs'; // Decode lossless browser screenshots.
import pixelmatch from 'pixelmatch'; // Use the same pixel comparison family documented by Playwright.
import type { Capture } from './types.ts'; // Share the evidence contract without runtime side effects.
export const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex'); // Hash source evidence reproducibly.
export function eligibility(reference?: Capture, candidate?: Capture): string | null { // Never score missing, mismatched or unrendered states.
  if (!reference || !candidate) return 'MISSING_CAPTURE'; // A missing candidate is not a visual pass.
  if (reference.status !== 'CAPTURED' || candidate.status !== 'CAPTURED') return 'CAPTURE_BLOCKED'; // Preserve browser/auth/content errors as blockers.
  if (reference.side !== 'reference' || candidate.side !== 'candidate') return 'WRONG_CAPTURE_SIDE'; // Prevent a candidate from silently becoming its own baseline.
  if (reference.caseId !== candidate.caseId || reference.region !== candidate.region) return 'STATE_MISMATCH'; // Require the same named scene and region.
  if (reference.engine.includes('unknown') || candidate.engine.includes('unknown')) return 'UNKNOWN_RENDERER'; // Reject unverified browser provenance.
  if (JSON.stringify(reference.viewport) !== JSON.stringify(candidate.viewport)) return 'VIEWPORT_MISMATCH'; // Never stretch screenshots to hide layout errors.
  if (reference.engine !== candidate.engine || reference.platform !== candidate.platform) return 'RENDERER_MISMATCH'; // Keep font rasterization and browser versions comparable.
  if (reference.theme !== candidate.theme) return 'THEME_MISMATCH'; // Avoid comparing the live light theme to the dark archive.
  if (!reference.contentHash || reference.contentHash !== candidate.contentHash) return 'CONTENT_MISMATCH'; // Compare the same captured message, not arbitrary scroll positions.
  return null; // The pair is eligible for numerical pixel comparison.
} // End the preflight gate.
export function compare(reference: Capture | undefined, candidate: Capture | undefined, differencePath: string, threshold = .1, maxDiffRatio = .02) { // Produce a difference image only for a comparable pair.
  const blocked = eligibility(reference, candidate); // Evaluate provenance before opening image files.
  if (blocked) return { status: blocked, mismatchRatio: null, humanReview: 'pending' }; // Never invent a visual score for a blocked pair.
  if (!(threshold >= 0 && threshold <= 1 && maxDiffRatio >= 0 && maxDiffRatio <= 1)) throw new Error('Invalid pixel tolerances'); // Reject permissive malformed configuration.
  const aBytes = readFileSync(reference!.image!); // Read the immutable reference screenshot.
  const bBytes = readFileSync(candidate!.image!); // Read the corresponding candidate screenshot.
  if (digest(aBytes) !== reference!.imageSha256 || digest(bBytes) !== candidate!.imageSha256) return { status: 'HASH_MISMATCH', mismatchRatio: null, humanReview: 'pending' }; // Detect stale or replaced screenshots.
  const a = PNG.sync.read(aBytes), b = PNG.sync.read(bBytes); // Decode images without cropping or resampling.
  if (a.width !== b.width || a.height !== b.height) return { status: 'GEOMETRY_MISMATCH', mismatchRatio: null, dimensions: { reference: [a.width, a.height], candidate: [b.width, b.height] }, humanReview: 'pending' }; // Retain a layout-size failure as evidence.
  const diff = new PNG({ width: a.width, height: a.height }); // Allocate an exact-size difference frame.
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold, includeAA: false }); // Report perceptual pixel differences with the recorded tolerance.
  writeFileSync(differencePath, PNG.sync.write(diff)); // Save real comparison pixels for review.
  const ratio = changed / (a.width * a.height); // This is mismatch proportion, not a design-quality score.
  return { status: ratio <= maxDiffRatio ? 'WITHIN_PIXEL_TOLERANCE' : 'VISUAL_DIFFERENCE', changedPixels: changed, comparedPixels: a.width * a.height, mismatchRatio: ratio, threshold, maxDiffRatio, differencePath, humanReview: 'pending' }; // Human acceptance is always separate from pixel tolerance.
} // End exact-frame comparison.
