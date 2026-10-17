# Content completeness extension — 0.3.0

This release audits retained HTML, multiline and inline code, visible activity summaries, and explicit public tool input/output logs separately. See `CONTENT_COVERAGE.md`. Earlier workflow notes are retained below.

# EMBLEM-NLP Chat UI RSI — 0.2.3

This module replaces visual guesswork with **capture → compare → human review → CSS correction → recapture**. It operates on the same conversation, message, viewport, theme and browser environment. It never invents a reference screenshot or auto-approves a candidate.

RSI 0.4.1 adds the evidence gate documented in `../DEVICE_VALIDATION.md`. Three validation loops remain after the five repair loops. `npm run validate-evidence -- <manifest.json> <candidate.html>` checks retained evidence without launching a browser. Physical iPhone cases reject emulation; download cases require saved bytes. `doctor` now exits 2 if both browser runtimes are absent.

## Current evidence boundary

The live source chat was inspected through the permitted browser interface on 16 October 2026. The candidate HTML could not be opened because the session's local-file browser policy blocks it and prohibits alternate routes. This module does not remove that restriction. Do not use a server, another browser, a data URL or a transport change to work around an active block. Candidate browser execution remains **NOT RUN** in the delivery environment.

The comparison-engine unit tests use invented pixels only. They validate rejection gates and difference generation; they do not establish a visual match. The reference photos supplied by the user are shown in the review as observation evidence, with missing-candidate slates. Their iOS browser/status bars are outside the cloned web UI.

## Runtime

Node 24 or later. Dependencies are pinned in `package.json`: Playwright 1.62.1, pngjs 7.0.0 and pixelmatch 7.2.0. These versions were present in the build runtime. They and browser binaries are not bundled. In a separately authorized development environment, install the dependencies and the required Playwright browser using its normal installation instructions. No authentication state or browser profile is included in this release.

`npm test` runs the pure comparison/scroll logic and bounded screenshot-retry tests. Synthetic test payloads are not browser captures. The Puppeteer CDP error `Page.captureScreenshot timed out … protocolTimeout` is explicitly treated as a host-level failure and is not retried by the Playwright SDK. `npm run doctor` checks executable availability without launching a browser. Availability is not permission and does not mean browser validation passed.

## Capture the original UI

Use the exported SDK on an **already authorized Playwright Page**:

```ts
import { capture } from './capture.ts'; // Use a permitted existing page supplied by the host.
const result = await capture(page, scene, 'reference', outputDirectory); // Record exactly the selected configured scene.
```

The host must set the scene's viewport, open its exact conversation URL, select the matching theme and load the target message through the regular UI. The recorder stops on wrong URLs, missing/ambiguous content or an unsettled frame. It samples the DOM three times, then takes one screenshot per viewport. Generic Playwright screenshot-operation timeouts may retry with bounded, increasing limits; the attempt count is retained. Host-level protocol errors and hard policy errors are not retried. It does not log in, export cookies, call private ChatGPT endpoints, enumerate other chats or read hidden application state. Host plugins with restricted Playwright interfaces need their own adapter; this SDK targets the full public Playwright Page API.

`cases.json` contains both observed conversation URLs and unique text anchors from the captured snapshot. Older messages may require loading through the visible UI before capture. Update a selector only after inspecting the actual page. A missing/expired artifact or unavailable tool trace stays a failed scene.

## Capture and compare the candidate

In a runtime that independently permits opening your chosen archive location:

```sh
node cli.ts capture-candidate --url '<explicitly permitted archive URL>' --output rsi-results
node cli.ts compare --output rsi-results
```

The runner does not start a server or choose alternate destinations. Use `--engine webkit` for a separate WebKit run and separate output directory. Reference and candidate must use the same browser version and operating system. WebKit automation does not prove iOS native file-preview compatibility.

The default scenes compare prose in both chats, a heading, and an entire matched viewport. The expanded Python activity panel is explicitly blocked because it was not retained in the original capture. `referenceTarget` and `candidateTarget` must each resolve exactly one element containing the same text. Element captures expose size differences as failures; images are never rescaled to obtain a better result.

`review.html` displays original, candidate, optional pixel differences and provenance. `comparison.json` retains all failures. Pixel mismatch ratio is a pixel measurement, not an aesthetic score. The default 2% mismatch tolerance is provisional and requires human calibration. Human approval stays pending even when pixel tolerance passes.

## Clone review links

The HTML accepts `chat`, `turn`, `part`, `theme`, `sidebar` and `rsi=1` parameters. Turn IDs must exist in the saved snapshot. `rsi=1` disables animation and isolates display preferences/annotations in memory for repeatability. It does not delete stored notes, hide defects, fabricate content, or send anything to ChatGPT.

## Release acceptance

1. Capture reference and candidate on the same renderer and viewport.
2. Reject missing, ambiguous, changed-content, wrong-theme or unstable states.
3. Inspect typography, header, prompts, paragraphs, code/tables, images, links, composer and drawers.
4. Correct CSS, keep the old reference unchanged, recapture, compare again.
5. Open the actual saved file on the target iPhone and inspect script-enabled and script-disabled behavior.

The generic reader resilience suite is also retained at `../preview-regression.spec.ts`; it requires `@playwright/test` and was not executed in this environment. Do not treat either suite's existence as a pass.

## Primary documentation

- https://playwright.dev/docs/screenshots
- https://playwright.dev/docs/test-snapshots
- https://playwright.dev/docs/emulation

Playwright notes that visual baselines vary with the browser and operating environment. This recorder follows that constraint and preserves missing-evidence states.
