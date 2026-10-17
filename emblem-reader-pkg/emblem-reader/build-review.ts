import { readFileSync } from 'node:fs'; // Read the actual comparison results, including missing captures.
import { join, resolve } from 'node:path'; // Resolve the extracted archive consistently.
import { review } from './review.ts'; // Generate an offline review with truthful missing-frame slates.
const archive = resolve(process.argv[2] || join(import.meta.dirname, '../..')); // Accept an explicit archive root when rebuilding.
const rows = JSON.parse(readFileSync(join(archive, 'evidence/rsi-results/comparison.json'), 'utf8')); // Preserve all expected scene outcomes.
const references = [ // Include user-supplied observations separately from numerical comparisons.
  { path: join(archive, 'evidence/user-ui-references/source-code-panel.png'), label: 'Reference: prose, expanded activity and Python panel', note: 'User-supplied IMG_9377.png. The expanded tool activity is missing from the captured transcript. Phone and browser chrome are outside the cloned web interface.' }, // Explain the known content gap.
  { path: join(archive, 'evidence/user-ui-references/source-artifact-image.jpeg'), label: 'Reference: artifact links and contact-sheet image', note: 'User-supplied IMG_9376(1).jpeg. Used for spacing, link treatment, image layout and mobile composer inspection. Its screenshot scale is not a numerical baseline.' }, // Preserve reference provenance and scale limits.
  { path: join(archive, 'evidence/user-ui-references/previous-failed-preview.png'), label: 'Before: failed archive in native file preview', note: 'User-supplied IMG_9381.png. This is the previous broken file, not the corrected candidate. Source fixes address the collapsed grid and script-dependent content; actual device verification remains pending.' }, // Never label an old failed frame as the latest render.
]; // End supplied reference inventory.
console.log(JSON.stringify(review(rows, join(archive, 'RSI_Chat_UI_Review.html'), references))); // Write a portable review and compact build receipt.
