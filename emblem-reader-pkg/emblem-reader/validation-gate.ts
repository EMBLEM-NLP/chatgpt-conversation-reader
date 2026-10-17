import { createHash } from 'node:crypto'; // Bind every observation to exact evidence bytes.
import { readFileSync } from 'node:fs'; // Read explicitly supplied evidence only.
import { resolve } from 'node:path'; // Resolve evidence within the caller's chosen folder.
import { pathToFileURL } from 'node:url'; // Keep the CLI separate from the imported SDK.
export const required = { // Require three distinct validation passes after the five repair loops.
  layout: ['opening', 'gallery', 'activity', 'reference-photo', 'wide-render', 'final-message'], // Include the supplied reference states and end-of-chat reachability.
  interactions: ['gallery-select', 'image-open-close', 'activity-expand-collapse', 'conversation-switch', 'search', 'copy', 'jump-bottom', 'embedded-download', 'original-download', 'unavailable-original', 'external-link'], // Check observable outcomes, not merely event handler presence.
  iphone: ['preview-open-scroll', 'preview-gallery', 'preview-inactive-controls', 'safari-open-scroll', 'safari-gallery', 'safari-embedded-save', 'safari-original-save', 'reopen-saved-file'], // Native preview and Safari are separate targets.
} as const; // Do not substitute desktop emulation for physical device evidence.
type Attachment = { path: string; sha256: string }; // Keep evidence paths and checksums paired.
type Observation = { id: string; passed: boolean; candidateSha256: string; capturedAt: string; host: string; deviceKind: 'desktop' | 'emulated' | 'physical-iphone'; device?: string; os?: string; observed: string; evidence: Attachment[]; savedFile?: Attachment; expectedFileSha256?: string }; // Physical-device metadata is an operator attestation, not hardware attestation.
type Manifest = { schema: 1; candidateSha256: string; observations: { layout: Observation[]; interactions: Observation[]; iphone: Observation[] } }; // Bind the manifest to one reader build.
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex'); // Compare byte identity without interpreting files.
export function evaluate(m: Manifest, candidate: string, directory: string) { // Validate evidence without opening a browser or promoting missing captures.
  const actual = hash(readFileSync(candidate)); // Recompute candidate identity instead of trusting metadata.
  if (m.schema !== 1 || m.candidateSha256 !== actual) throw new Error('Manifest does not match the candidate build'); // Stale evidence cannot approve a newer reader.
  const validFile = (a?: Attachment) => { try { return !!a && /^[a-f0-9]{64}$/.test(a.sha256) && hash(readFileSync(resolve(directory, a.path))) === a.sha256; } catch { return false; } }; // Reject absent, changed or malformed evidence.
  const loops = Object.entries(required).map(([kind, ids], index) => { // Keep layout, interaction and iPhone gates independent.
    const records = m.observations?.[kind as keyof typeof required] || []; // Missing evidence is an empty pending set.
    const cases = ids.map(id => { // Retain every required case in the output.
      const matches = records.filter(o => o.id === id); // Duplicate records must not conceal a failure.
      const o = matches[0]; // Inspect one uniquely identified observation.
      let reason = !o ? 'NOT_RUN' : matches.length !== 1 ? 'DUPLICATE_EVIDENCE' : ''; // Do not silently pick a passing duplicate.
      if (!reason && (!o.passed || o.candidateSha256 !== actual || !Number.isFinite(Date.parse(o.capturedAt)) || !o.host?.trim() || !o.observed?.trim())) reason = 'FAILED_OR_INVALID_OBSERVATION'; // Require a dated observed outcome for this build.
      if (!reason && kind === 'iphone' && (o.deviceKind !== 'physical-iphone' || !o.device?.trim() || !o.os?.trim())) reason = 'PHYSICAL_IPHONE_REQUIRED'; // A mobile viewport or user-agent string is insufficient.
      if (!reason && (!o.evidence?.length || !o.evidence.every(validFile))) reason = 'MISSING_OR_CHANGED_EVIDENCE'; // Accept only retained screenshot/video or observation evidence bytes.
      if (!reason && /download|save|reopen-saved-file/.test(id) && (!validFile(o.savedFile) || o.savedFile?.sha256 !== o.expectedFileSha256)) reason = 'SAVED_BYTES_UNVERIFIED'; // A click or Save prompt alone does not prove download integrity.
      return { id, status: reason || 'EVIDENCE_ACCEPTED' }; // Evidence acceptance is distinct from a fresh live execution.
    }); // Finish the case inventory.
    return { loop: index + 6, kind, status: cases.every(c => c.status === 'EVIDENCE_ACCEPTED') ? 'EVIDENCE_ACCEPTED' : 'INCOMPLETE', cases }; // No vacuous all-pass outcomes.
  }); // Finish the three validation loops.
  return { candidateSha256: actual, status: loops.every(l => l.status === 'EVIDENCE_ACCEPTED') ? 'EVIDENCE_ACCEPTED' : 'VALIDATION_INCOMPLETE', remainingValidationLoops: loops.filter(l => l.status !== 'EVIDENCE_ACCEPTED').length, physicalDeviceIdentity: 'operator-reported; not independently hardware-attested', loops }; // Do not claim browser execution from this validator.
} // End the offline evidence gate.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { // Execute only when invoked as a CLI.
  const [manifest, candidate] = process.argv.slice(2); // Require explicit source paths.
  if (!manifest || !candidate) throw new Error('Usage: node validation-gate.ts manifest.json candidate.html'); // Avoid implicit validation of another build.
  const result = evaluate(JSON.parse(readFileSync(manifest, 'utf8')), candidate, resolve(manifest, '..')); // Resolve evidence relative to the manifest.
  console.log(JSON.stringify(result, null, 2)); // Produce an auditable pending/pass report.
  if (result.status !== 'EVIDENCE_ACCEPTED') process.exitCode = 2; // CI must fail until every required observation exists.
} // End the CLI entry point.
