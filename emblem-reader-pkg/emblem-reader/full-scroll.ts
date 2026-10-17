import { mkdirSync, writeFileSync, existsSync } from 'node:fs'; // Save independent checkpoints without overwriting an earlier run.
import { join, resolve } from 'node:path'; // Keep each run in a dedicated directory.
import { platform, release } from 'node:os'; // Record renderer host identity for comparison.
import type { Page } from 'playwright'; // Accept an already authorized page; never launch a replacement browser.
import { digest } from './compare.ts'; // Bind every screenshot to its original bytes.
import { captureVisibleContent, type ContentSelectors } from './content-capture.ts'; // Checkpoint visible code and activity evidence alongside each real frame.
export type Surface = { scroller: string; messages: string; idAttribute: string; alternateIdAttribute?: string; loadingText: string; content?: ContentSelectors }; // Keep source and clone selectors explicit.
export type Conversation = { id: string; sourceUrl: string; expectedFirstId: string; expectedUserIds: string[]; reference: Surface; candidate: Surface }; // Seal the known first prompt and captured prompt inventory.
export type ScrollOptions = { overlap: number; maxFrames: number; maxSeekPasses: number; stableSamples: number; screenshotTimeoutMs: number; screenshotRetries: number; timezone: string }; // Bound every load, capture and timeout recovery loop.
export type View = { top: number; height: number; viewport: number; ids: string[]; visibleIds: string[]; loading: boolean; firstId: string | null; anchor: string | null; anchorOffset: number; signature: string }; // Track visible DOM and scroll geometry rather than hidden application state.
export type Frame = { index: number; top: number; anchor: string | null; anchorOffset: number; visibleIds: string[]; image: string; sha256: string; capturedAt: string; screenshotAttempts: number }; // Preserve original, overlapping viewport frames and retry history.
export type ScrollRun = { schema: 1; captureSpecSha256: string; conversation: string; side: 'reference' | 'candidate'; status: string; reason?: string; startedAt: string; timezone: string; engine: string; platform: string; theme: string; viewport: unknown; firstVerified: boolean; bottomVerified: boolean; expectedUserIds: string[]; missingUserIds: string[]; frames: Frame[]; failedScreenshot?: { frameIndex: number; attempts: number; lastTimeoutMs: number; reason: string }; captureMethod: string; coverage: string }; // Make incomplete evidence explicit.
export function nextOffset(view: Pick<View, 'top' | 'height' | 'viewport'>, overlap: number): number { // Advance by an overlapping viewport, not document-length percentages.
  if (!(overlap >= .1 && overlap <= .75) || view.viewport <= 0) throw new Error('Invalid viewport or overlap'); // Reject a configuration that could leave unrecorded gaps.
  return Math.min(Math.max(0, view.height - view.viewport), view.top + Math.max(1, Math.floor(view.viewport * (1 - overlap)))); // Cover the final partial viewport exactly.
} // End deterministic scroll stepping.
export const sharesMessage = (a: string[], b: string[]) => a.some(id => b.includes(id)); // Verify continuity across virtualized message windows.
export const stableSample = (loading: boolean, signature: string, prior: string, seekingStart: boolean) => (seekingStart || !loading) && signature === prior; // Permit another top-seek pass while a persistent history marker is present.
export function retryableScreenshotError(error: unknown): boolean { // Retry only failures that can plausibly clear on a later screenshot request.
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error); // Preserve the browser adapter's error wording for classification.
  if (/protocolTimeout|Page\.captureScreenshot timed out/i.test(value)) return false; // This exact CDP message is host-level Puppeteer protocol timeout, not a Playwright action timeout.
  return /timeout|timed out/i.test(value); // Retry generic Playwright screenshot-operation timeouts only.
} // End screenshot retry classification.
export class ScreenshotRetryFailure extends Error { // Attach bounded retry history to a terminal screenshot failure.
  readonly attempts: number; // Store the number of browser screenshot attempts.
  readonly lastTimeoutMs: number; // Store the timeout used by the final attempt.
  constructor(message: string, attempts: number, lastTimeoutMs: number, cause: unknown) { super(message, { cause }); this.name = 'ScreenshotRetryFailure'; this.attempts = attempts; this.lastTimeoutMs = lastTimeoutMs; } // Preserve the native cause for debugging without replacing the user-facing reason.
} // End screenshot failure type.
export async function screenshotWithRetries<T>(capture: (timeoutMs: number) => Promise<T>, baseTimeoutMs: number, retries: number, wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))): Promise<{ image: T; attempts: number }> { // Bound transient screenshot recovery and expose the attempt count.
  if (!Number.isInteger(baseTimeoutMs) || baseTimeoutMs < 1000 || !Number.isInteger(retries) || retries < 0 || retries > 4) throw new Error('Invalid screenshot timeout/retry settings'); // Prevent infinite retry loops and unusable timeouts.
  let last: unknown; // Retain the final failure without replacing its message.
  for (let attempt = 0; attempt <= retries; attempt++) { // Use exponential timeout growth for the same exact frame.
    try { return { image: await capture(baseTimeoutMs * (2 ** attempt)), attempts: attempt + 1 }; } // Return the real screenshot bytes and their successful attempt number.
    catch (error) { last = error; const timeoutMs = baseTimeoutMs * (2 ** attempt); if (attempt === retries || !retryableScreenshotError(error)) throw new ScreenshotRetryFailure(error instanceof Error ? error.message : String(error), attempt + 1, timeoutMs, error); await wait(Math.min(500 * (2 ** attempt), 4000)); } // Back off only after a timeout-like failure.
  } // End the finite retry loop.
  throw last instanceof Error ? last : new Error(String(last)); // Preserve the final error if the loop is exhausted.
} // End screenshot timeout recovery.
export async function inspect(page: Page, surface: Surface): Promise<View> { // Inspect only the configured rendered conversation container.
  return page.locator(surface.scroller).evaluate((scroller, spec) => { // Read visible messages and their exposed IDs.
    const rootBox = scroller.getBoundingClientRect(); // Define the scroll viewport in CSS coordinates.
    const rows = [...scroller.querySelectorAll(spec.messages)].map(element => { const box = element.getBoundingClientRect(); return { ids: (element.getAttribute(spec.idAttribute) || (spec.alternateIdAttribute ? element.getAttribute(spec.alternateIdAttribute) : '') || '').split(/\s+/).filter(Boolean), top: box.top, bottom: box.bottom, width: box.width, height: box.height }; }); // Resolve only DOM-exposed message identifiers.
    const ids = [...new Set(rows.flatMap(row => row.ids))]; // Deduplicate repeated render wrappers without collapsing distinct messages.
    const visible = rows.filter(row => row.width > 0 && row.height > 0 && row.bottom > rootBox.top && row.top < rootBox.bottom); // Keep messages intersecting the viewport.
    const visibleIds = [...new Set(visible.flatMap(row => row.ids))]; // Associate each frame with the messages it actually shows.
    const firstId = ids[0] || null, anchor = visibleIds[0] || null; // Distinguish loaded-first from visible-first message.
    const loading = Boolean(spec.loadingText && [...scroller.querySelectorAll('*')].some(element => element.childElementCount === 0 && element.textContent?.includes(spec.loadingText) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && element.getBoundingClientRect().bottom > rootBox.top && element.getBoundingClientRect().top < rootBox.bottom)); // Respect the site's visible older-message loading indicator.
    const state = { top: scroller.scrollTop, height: scroller.scrollHeight, viewport: scroller.clientHeight, ids, visibleIds, loading, firstId, anchor, anchorOffset: visible[0] ? rootBox.top - visible[0].top : 0 }; // Record exact geometry, including position within a long message.
    return { ...state, signature: JSON.stringify([state.top, state.height, ids, visibleIds, loading]) }; // Detect lazy loading and virtualized DOM replacement.
  }, surface); // Pass selector data as a structured argument.
} // End visible-state sampling.
async function settle(page: Page, surface: Surface, required: number, seekingStart = false): Promise<View> { // Wait for stable rendered state with a finite upper bound.
  let prior = '', stable = 0; // Count consecutive identical observations.
  for (let attempt = 0; attempt < 40; attempt++) { // Bound waiting to about ten seconds per checkpoint.
    const view = await inspect(page, surface); // Refresh geometry after every lazy-load opportunity.
    stable = stableSample(view.loading, view.signature, prior, seekingStart) ? stable + 1 : 0; prior = view.signature; // Changed content always resets stability; loading blocks screenshot capture.
    if (stable >= required) return view; // During seeking only, return stable geometry so the caller can request older history again.
    await page.waitForTimeout(250); // Allow visible lazy loading to progress between independent samples.
  } // End bounded polling.
  throw new Error('Visible conversation did not settle; loading or virtualization remains active'); // Do not interpret timeout as completeness.
} // End stability gate.
export async function captureFullScroll(page: Page, conversation: Conversation, side: 'reference' | 'candidate', directory: string, options: ScrollOptions): Promise<ScrollRun> { // Record a complete visible scroll only in an already permitted browser host.
  if (!/^[a-z0-9_-]+$/.test(conversation.id)) throw new Error('Unsafe conversation ID'); // Avoid path traversal from configuration.
  if (!Number.isInteger(options.maxFrames) || options.maxFrames < 1 || options.stableSamples < 2 || options.maxSeekPasses < 1 || !Number.isInteger(options.screenshotTimeoutMs) || options.screenshotTimeoutMs < 1000 || !Number.isInteger(options.screenshotRetries) || options.screenshotRetries < 0 || options.screenshotRetries > 4) throw new Error('Invalid bounded-loop settings'); // Fail invalid limits before touching the page.
  nextOffset({ top: 0, height: 1000, viewport: 500 }, options.overlap); // Validate overlap before starting capture.
  const folder = resolve(directory, `${conversation.id}.${side}`); // Separate conversations and original/candidate sides.
  if (existsSync(folder)) throw new Error('Output already exists; choose a new run directory to preserve earlier evidence'); // Prevent silent overwrites or mixing old frames with a new attempt.
  mkdirSync(folder, { recursive: true }); // Create this run's immutable evidence folder.
  const run: ScrollRun = { schema: 1, captureSpecSha256: digest(JSON.stringify({ conversation, options })), conversation: conversation.id, side, status: 'CAPTURING', startedAt: new Date().toISOString(), timezone: options.timezone, engine: `${page.context().browser()?.browserType().name() || 'unknown'}:${page.context().browser()?.version() || 'unknown'}`, platform: `${platform()} ${release()}`, theme: 'unknown', viewport: page.viewportSize(), firstVerified: false, bottomVerified: false, expectedUserIds: conversation.expectedUserIds, missingUserIds: [...conversation.expectedUserIds], frames: [], captureMethod: 'Three stable DOM samples, animations disabled, one Playwright screenshot per frame; generic Playwright operation timeouts retry. Host-level CDP protocol timeouts are not retried.', coverage: 'Rendered selected branch only; hidden/collapsed tool activity and alternate branches are not claimed.' }; // Initialize truthful provenance before any screenshot.
  writeFileSync(join(folder, 'capture-spec.json'), JSON.stringify({ conversation, options }, null, 2)); // Seal the exact selectors, expected IDs and scroll limits before measuring.
  const checkpoint = () => writeFileSync(join(folder, 'scroll.json'), JSON.stringify(run, null, 2)); // Keep failures and partial progress reviewable.
  const surface = conversation[side], seen = new Set<string>(); // Track actual frame coverage, not all loaded-but-unseen DOM nodes.
  try { // Preserve every failure without retrying through an alternate browser or URL.
    if (side === 'reference' && page.url() !== conversation.sourceUrl) throw new Error('Wrong source URL or authentication redirect'); // Stop at another chat or sign-in page.
    if (side === 'candidate' && (await page.locator('html[data-reader-ready="true"]').count() !== 1 || await page.locator('html').getAttribute('data-reader-chat') !== conversation.id)) throw new Error('Candidate is not the ready archive for the selected conversation'); // Verify candidate identity even when the lower-level SDK is called directly.
    if (await page.locator(surface.scroller).count() !== 1) throw new Error('Expected exactly one conversation scroller'); // Never scroll the page body by accident.
    run.theme = await page.locator('main').evaluate(element => { let node: Element | null = element; while (node) { const bg = getComputedStyle(node).backgroundColor; if (bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') { const rgb = bg.match(/[\d.]+/g)?.slice(0,3).map(Number); return rgb?.length === 3 ? (rgb.reduce((a,b)=>a+b,0)/3 < 128 ? 'dark' : 'light') : 'unknown'; } node = node.parentElement; } return 'unknown'; }); // Record the actual painted theme rather than only an emulation preference.
    await page.evaluate(() => document.fonts.ready); // Settle fonts before capturing the opening state.
    for (let seek = 0; seek < options.maxSeekPasses; seek++) { // Revisit the top as older messages prepend into a virtualized container.
      await page.locator(surface.scroller).evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' })); // Use the actual scroll container rather than a fullPage screenshot shortcut.
      const view = await settle(page, surface, options.stableSamples, true); // Allow a persistent older-history marker while seeking; identity still gates the verified start.
      if (view.top <= 1 && view.firstId === conversation.expectedFirstId) { run.firstVerified = true; break; } // Require the known earliest prompt, not merely scrollTop zero.
    } // End bounded first-message seeking.
    if (!run.firstVerified) throw new Error('Could not verify the first prompt; opening capture is incomplete'); // Never silently start in the middle of the chat.
    let previous: View | undefined; // Retain continuity with the last captured viewport.
    for (let index = 0; index < options.maxFrames; index++) { // Walk from verified start to stable bottom.
      const view = await settle(page, surface, options.stableSamples); // Refresh the actual viewport after each step.
      if (!view.visibleIds.length) throw new Error('Blank viewport or missing message-ID selectors'); // Refuse empty renders masquerading as valid scroll evidence.
      if (previous && !sharesMessage(previous.visibleIds, view.visibleIds)) throw new Error('No message overlap between consecutive frames; possible capture gap'); // Detect discontinuity during virtualization.
      const clip = await page.locator('main').boundingBox(); // Capture the chat UI while excluding unrelated sidebar histories.
      if (!clip || clip.width < 100 || clip.height < 100) throw new Error('Chat UI capture region collapsed or unavailable'); // Detect the previous zero-width rendering failure.
      const image = `${String(index).padStart(5, '0')}.png`; // Keep frame order obvious on disk.
      const screenshotOptions = { clip, scale: 'css' as const, animations: 'disabled' as const, caret: 'hide' as const }; // Normalize motion without rescaling or hiding content.
      await page.mouse.move(0, 0); // Avoid incidental hover menus over the transcript.
      let shot: { image: Buffer; attempts: number }; // Keep screenshot bytes and bounded attempts together.
      try { shot = await screenshotWithRetries(timeoutMs => page.screenshot({ ...screenshotOptions, timeout: timeoutMs }), options.screenshotTimeoutMs, options.screenshotRetries); } // Capture once after stable DOM sampling and retry only transient screenshot timeouts.
      catch (error) { if (error instanceof ScreenshotRetryFailure) run.failedScreenshot = { frameIndex: index, attempts: error.attempts, lastTimeoutMs: error.lastTimeoutMs, reason: error.message }; checkpoint(); throw error; } // Persist the timeout failure before stopping on this frame.
      writeFileSync(join(folder, image), shot.image); // Save the actual rendered browser viewport.
      run.frames.push({ index, top: view.top, anchor: view.anchor, anchorOffset: view.anchorOffset, visibleIds: view.visibleIds, image, sha256: digest(shot.image), capturedAt: new Date().toISOString(), screenshotAttempts: shot.attempts }); // Bind each frame to its scroll/message state and retry evidence.
      const contentPath = join(folder, `${String(index).padStart(5, '0')}.content.json`); // Keep structured content beside its matching frame number.
      const content = surface.content ? await captureVisibleContent(page, surface.content) : { schema: 'emblem.chat.visible-content/1', coverage: 'NOT_CONFIGURED', reason: 'No inspected content selectors supplied; message-count coverage does not prove HTML, code or tool completeness.' }; // Never silently mark missing content capture as complete.
      writeFileSync(contentPath, JSON.stringify({ ...content, frameIndex: index, screenshotSha256: digest(shot.image), sourceScope: 'Rendered selected branch; tool inventory remains unverified.' }, null, 2)); // Bind source text and code observations to their actual screenshot.
      view.visibleIds.forEach(id => seen.add(id)); run.missingUserIds = conversation.expectedUserIds.filter(id => !seen.has(id)); checkpoint(); // Persist coverage after each completed frame.
      if (view.top + view.viewport >= view.height - 1) { run.bottomVerified = true; break; } // Bottom is accepted only after the preceding stability gate.
      const next = nextOffset(view, options.overlap); // Retain the configured overlap on each downward step.
      if (next <= view.top) throw new Error('Scroll stopped advancing before the bottom'); // Detect stuck UI rather than repeating the same frame indefinitely.
      previous = view; await page.locator(surface.scroller).evaluate((element, top) => element.scrollTo({ top, behavior: 'instant' }), next); // Move the actual nested conversation viewport.
    } // End bounded overlapping capture.
    run.status = run.bottomVerified && run.missingUserIds.length === 0 ? 'CAPTURED_VISIBLE_SCROLL' : 'INCOMPLETE'; // A frame limit or missing expected prompt cannot pass coverage.
    if (run.status === 'INCOMPLETE') run.reason = 'Frame limit reached or expected prompts were not observed in captured viewports'; // Explain the remaining coverage gap.
  } catch (error) { run.status = 'BLOCKED'; run.reason = error instanceof Error ? error.message : String(error); } // Preserve the concrete blocker and partial capture.
  finally { checkpoint(); } // Always write the terminal result.
  return run; // Return evidence to the host without publishing private conversations.
} // End full-scroll recorder.
