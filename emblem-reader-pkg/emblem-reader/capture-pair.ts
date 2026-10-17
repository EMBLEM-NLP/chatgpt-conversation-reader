import { join } from 'node:path'; // Locate each independently recorded side.
import type { Page } from 'playwright'; // Receive already authorized source and candidate pages from the host.
import { captureFullScroll } from './full-scroll.ts'; // Walk both nested conversation scrollers from their verified starts.
import type { Conversation, ScrollOptions } from './full-scroll.ts'; // Keep the same sealed inventory and overlap rules on both sides.
import { fullScrollReview } from './scroll-review.ts'; // Generate a complete paired-scroll review after capture.
export async function capturePair(referencePage: Page, candidatePage: Page, conversation: Conversation, directory: string, options: ScrollOptions) { // Never launch browsers, create servers or change authentication in this adapter.
  if (referencePage === candidatePage) throw new Error('Provide distinct original and candidate pages'); // Prevent a false comparison of a page with itself.
  const referenceViewport = referencePage.viewportSize(), candidateViewport = candidatePage.viewportSize(); // Compare the already-configured CSS viewport before capture.
  if (!referenceViewport || !candidateViewport || referenceViewport.width !== candidateViewport.width || referenceViewport.height !== candidateViewport.height) throw new Error('Original and candidate pages must have the same fixed viewport'); // Avoid wasting a full scroll on incompatible geometry.
  if (await candidatePage.locator('html[data-reader-ready="true"]').count() !== 1 || await candidatePage.locator('html').getAttribute('data-reader-chat') !== conversation.id) throw new Error('Candidate is not the ready archive for the selected conversation'); // Refuse a blank, loading, or wrong clone before writing any frames.
  const reference = await captureFullScroll(referencePage, conversation, 'reference', directory, options); // Capture the live rendered branch first.
  const candidate = await captureFullScroll(candidatePage, conversation, 'candidate', directory, options); // Capture the actual clone independently at the same configured viewport.
  const review = fullScrollReview(join(directory, `${conversation.id}.reference/scroll.json`), join(directory, `${conversation.id}.candidate/scroll.json`), join(directory, `${conversation.id}.full-scroll.html`)); // Preserve missing and mismatched frames in the paired result.
  return { reference, candidate, review }; // Return evidence rather than a fabricated visual approval score.
} // End host-supplied Playwright integration.
