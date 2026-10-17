import { fullScrollReview } from './scroll-review.ts'; // Expose review generation without opening a browser.
import { resolve } from 'node:path'; // Resolve explicit local inputs safely.
const args = process.argv.slice(2); // Keep browser capture in the authorized host SDK.
const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }; // Read explicit manifest arguments.
const reference = value('--reference'), candidate = value('--candidate'); // Missing sides produce visible slates.
const result = fullScrollReview(reference ? resolve(reference) : undefined, candidate ? resolve(candidate) : undefined, resolve(value('--out') || 'FULL_SCROLL_REVIEW.html')); // Generate the complete paired scroll document.
console.log(JSON.stringify(result)); // Report the evidence state without claiming capture execution.
if (result.status === 'INCOMPLETE') process.exitCode = 2; // Make missing renders a failing audit outcome.
