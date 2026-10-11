// Phase 4 / FR-17 is GATED (docs/BROWSER_GATE.md, ADR-0010): this build contains no browser, extension,
// DOM-reading, cookie or chatgpt.com code, so there is nothing to test. The script reports that plainly
// instead of printing a pass, and exits 0 so CI treats the absence as the documented state, not a failure.
process.stdout.write(
  'NOT_RUN: no browser code exists in this build (FR-17 is GATED; see docs/BROWSER_GATE.md). ' +
    'This is not a pass; it means the capability is not implemented.\n',
);
