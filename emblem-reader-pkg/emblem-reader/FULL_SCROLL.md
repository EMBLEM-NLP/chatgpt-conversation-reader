# Content completeness extension — 0.3.0

This release audits retained HTML, multiline and inline code, visible activity summaries, and explicit public tool input/output logs separately. See `CONTENT_COVERAGE.md`. Earlier workflow notes are retained below.

# Full-conversation Playwright RSI

This extension belongs to the attached **emblem-rsi** package. The original audio signature and sealed-rubric lettering audit are preserved. Their Puppeteer probe is specialized for `window.__vl`; it is not used to render or audit the conversation archive.

## What changes

The new TypeScript SDK records the actual nested conversation scroller. A normal `fullPage` screenshot cannot by itself prove that a virtualized chat has loaded its first message or all messages between its endpoints.

1. Verify the configured source URL and a unique scroller.
2. Revisit the top while older messages prepend. Require the known first prompt ID and stable, nonloading DOM state.
3. Capture two consecutive stable viewport images, saving the original pixels and their hashes.
4. Scroll by 75% of the visible conversation height, preserving 25% overlap.
5. Require shared visible message IDs between adjacent views. Retain positions within long messages.
6. Require three stable DOM samples, then save one screenshot per view. Generic Playwright screenshot-operation timeouts retry the unchanged viewport with a bounded increasing timeout (15, 30, 60 and 120 seconds by default); the successful attempt number is recorded. Hard policy/permission errors are not retried. The error `Page.captureScreenshot timed out … protocolTimeout` is a host-level Puppeteer/CDP timeout and is not retried by this Playwright module.
7. Checkpoint after every frame. Stop with a recorded failure on unstable content, gaps, collapsed regions, or configured limits.
8. Verify the bottom and that all expected prompt IDs appeared in captured viewports.
9. Pair source/candidate frames by message ID and nearest within-message offset. Keep unmatched frames. Build one HTML document containing two columns and a shared full-document scroll.

The HTML review includes frame numbers, capture times, scroll offsets, screenshot retry counts, missing-frame slates and provenance. Its Previous/Next controls step through paired rows. It works as a normal scrollable document without JavaScript. Repeated header/composer chrome and overlapping pixels remain visible; this is a full-scroll capture sequence, not a misleading seamless stitch.

## Run from an authorized Playwright host

Use Node 24+ and the dependencies pinned in `package.json`. The SDK expects full public Playwright `Page` objects, supplied by an independently authorized browser host. It does not discover sessions, copy cookies, invoke private ChatGPT APIs, start a server, use CDP, or launch an alternate browser.

```sh
npm run capture-full-scroll -- --host /absolute/path/to/open-pages.mjs --conversation mountain --out /absolute/path/to/runs/mountain
```

The local host module must export `getOpenPages({conversation})` and return `{referencePage, candidatePage}` as real Playwright `Page` objects. Both tabs must already be open, authorized, and set to the same viewport; the candidate must be the ready archive for the selected conversation. Example host contract:

```js
export async function getOpenPages({ conversation }) {
  // Return the two Playwright Page objects already owned by your authorized host.
  return { referencePage, candidatePage };
}
```

The runner does not launch or connect to browsers, navigate or authenticate, start a server, resize tabs, or close pages. It writes an immutable source folder, candidate folder, and paired HTML review in a new/empty output directory. Run Mountain and Street separately with distinct output directories. The source theme should match the archive theme through ordinary UI controls; theme and renderer differences remain flagged in the review.

Open the clone with `?chat=mountain&rsi=1&theme=dark` or `?chat=street&rsi=1&theme=dark`. Do not supply a turn parameter: this run begins at the first prompt. The shipped selectors and expected IDs come from the existing archive capture; if the live UI changes, inspect and update the selectors rather than guessing. Both sides must use the same viewport, theme, operating system and browser version.

To rebuild a review from completed captures:

```sh
node scroll-cli.ts --reference runs/new-run/mountain.reference/scroll.json --candidate runs/new-run/mountain.candidate/scroll.json --out mountain-full-scroll.html
```

`npm test` runs the pure comparison, scroll-logic and screenshot-retry tests. Synthetic screenshot bytes exercise only timeout classification and bounded retry behavior; they do not establish that a browser screenshot succeeded. Original Python rule tests remain available via `python3 -m unittest discover -s tests -t .` from the package root.

## Exact limits of this delivery

No full-scroll source/candidate browser capture was executed here. The previously observed local-candidate browser restriction remains active and cannot be bypassed using the attached package's older Puppeteer probe, an alternate browser, a local server, or request interception. The evidence folder records this as blocked, and the generated no-input review correctly has missing-frame slates.

The initial inventory covers 21 Mountain and 18 Street View prompts. Passing that inventory proves coverage of those expected prompts, not every current server-side message. Newer messages, alternate branches, and collapsed/hidden tool details are separate completeness questions. The expanded Python activity in the user's screenshot was not retained in the archive. It must be recovered from the actual visible source UI before that panel can match.

Rendered frames are checkpointed; interrupted attempts are preserved and require a new output directory. Automatic cross-session resume is intentionally not claimed because virtualized page state can change. No browser binaries, authentication profile or neural narration runtime is bundled.

Before visual approval, actually run both sides in a permitted environment and inspect the paired full-scroll output. Message alignment and coverage do not establish pixel-identical styling or human approval.

The retry uses Playwright's documented `page.screenshot({ timeout })` option; it does not change browser transport, launch flags, authentication or security policy. This option does not configure Puppeteer's separate CDP `protocolTimeout`. See https://playwright.dev/docs/api/class-page#page-screenshot and https://pptr.dev/api/puppeteer.connectoptions.
