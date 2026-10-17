import { mkdirSync, writeFileSync } from 'node:fs'; // Persist each completed checkpoint immediately.
import { join, resolve } from 'node:path'; // Keep capture paths deterministic.
import { platform, release } from 'node:os'; // Record the actual renderer host.
import type { Page, Locator } from 'playwright'; // Accept an already authorized Playwright page from the caller.
import type { Capture, Case, Target } from './types.ts'; // Use the versioned state and evidence contracts.
import { digest } from './compare.ts'; // Bind text identity and image bytes to their evidence.
export const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim(); // Ignore whitespace wrapping but preserve wording.
export function target(page: Page, spec: Target): Locator { // Use one deterministic locator rather than selecting the first match.
  if (spec.role && spec.name) return page.getByRole(spec.role as Parameters<Page['getByRole']>[0], { name: spec.name, exact: true }); // Prefer accessible names when stable.
  if (spec.text) return page.getByText(spec.text, { exact: true }); // Match full known text rather than unrelated page content.
  if (spec.selector) return page.locator(spec.selector); // Permit archive-owned or explicitly observed selectors.
  throw new Error('No target locator supplied'); // Refuse a broad accidental page capture.
} // End selector resolution.
export async function capture(page: Page, scene: Case, side: 'reference' | 'candidate', directory: string, timezone = 'America/Toronto'): Promise<Capture> { // Capture only the already selected and authorized page.
  if (!/^[a-z0-9_-]+$/.test(scene.id)) throw new Error('Unsafe case ID'); // Avoid using arbitrary scene names as file paths.
  mkdirSync(directory, { recursive: true }); // Create a local checkpoint folder without publishing anything.
  const base = join(resolve(directory), `${scene.id}.${side}`); // Keep independent reference/candidate evidence files.
  const evidence: Capture = { schema: 1, caseId: scene.id, side, status: 'PENDING', capturedAt: new Date().toISOString(), timezone, viewport: scene.viewport, engine: `${page.context().browser()?.browserType().name() || 'unknown'}:${page.context().browser()?.version() || 'unknown'}`, platform: `${platform()} ${release()}`, theme: scene.theme, region: scene.region, errors: [] }; // Retain exact environment and capture time.
  const onError = (error: Error) => evidence.errors!.push(error.message); // Collect only page exceptions, not private network logs or credentials.
  page.on('pageerror', onError); // Observe failures during this capture checkpoint.
  try { // Convert every runtime failure to explicit evidence.
    if (scene.missingReason) throw new Error(scene.missingReason); // Never substitute a fabricated tool panel for missing captured content.
    const actualUrl = new URL(page.url()); // Verify destination before reading the selected message.
    if (side === 'reference' && actualUrl.href !== new URL(scene.referenceUrl).href) throw new Error('Reference URL differs from the configured conversation; authenticate/navigate outside this recorder.'); // Stop at sign-in redirects or wrong chats.
    const viewport = page.viewportSize(); // Record the actual configured CSS viewport.
    if (viewport?.width !== scene.viewport.width || viewport?.height !== scene.viewport.height) throw new Error('Viewport differs from configured scene'); // Do not silently resize an existing reference tab.
    if (side === 'candidate') { // Check deterministic archive startup before taking a screenshot.
      await page.locator('html[data-reader-ready="true"]').waitFor({ timeout: 15000 }); // Wait for embedded images and the requested turn anchor.
      if (await page.locator('html').getAttribute('data-reader-chat') !== scene.chat) throw new Error('Candidate selected the wrong conversation'); // Detect invalid deep links.
    } // End candidate identity checks.
    await page.evaluate(() => document.fonts.ready); // Wait for the current page's fonts without fetching extra resources.
    const subject = target(page, side === 'reference' ? scene.referenceTarget : scene.candidateTarget); // Resolve exactly the same message region on both sides.
    if (await subject.count() !== 1) throw new Error('Expected exactly one target; load the correct message or update the observed locator'); // Refuse ambiguous repeated prompts.
    await subject.scrollIntoViewIfNeeded({ timeout: 12000 }); // Use the visible UI to reach the chosen reference content.
    if (scene.region === 'viewport') await subject.evaluate((element, y) => { let parent = element.parentElement; while (parent && !(parent.scrollHeight > parent.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(parent).overflowY))) parent = parent.parentElement; const delta = element.getBoundingClientRect().top - y; if (parent) parent.scrollTop += delta; else window.scrollBy(0, delta); }, scene.viewport.width <= 800 ? 64 : 76); // In an authorized full-Playwright host, align the same message to a fixed viewport position without editing content or styles.
    const bounds = await subject.boundingBox(); // Measure target geometry for audit and overflow checks.
    if (!bounds || bounds.width < 20 || bounds.height < 10) throw new Error('Target is blank, hidden or collapsed'); // Detect the original zero-width regression.
    evidence.bounds = bounds; // Preserve measured layout independently of screenshot matching.
    evidence.contentHash = digest(normalize(await subject.innerText())); // Record content identity without copying the full private transcript into the report.
    evidence.metrics = await subject.evaluate(element => { const css = getComputedStyle(element); let node: Element | null = element; let bg = 'rgba(0, 0, 0, 0)'; while (node) { const value = getComputedStyle(node).backgroundColor; if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') { bg = value; break; } node = node.parentElement; } return { font: css.font, lineHeight: css.lineHeight, padding: css.padding, margin: css.margin, background: bg, color: css.color, readerRevision: document.documentElement.dataset.readerRevision || null, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1, brokenImages: [...element.querySelectorAll('img')].filter(img => !img.complete || img.naturalWidth === 0).length }; }); // Record actual DOM-visible styling and unresolved image state.
    const rgb = String(evidence.metrics.background).match(/[\d.]+/g)?.slice(0, 3).map(Number); // Interpret opaque computed background for theme verification.
    if (rgb?.length === 3) { const observed = rgb.reduce((a, b) => a + b, 0) / 3 < 128 ? 'dark' : 'light'; if (observed !== scene.theme) throw new Error(`Theme mismatch: observed ${observed}`); } // Never relabel a light reference as dark.
    if (evidence.metrics.documentOverflow || evidence.metrics.brokenImages || evidence.errors!.length) throw new Error('Layout overflow, unresolved images, or a page exception requires correction'); // Preserve defects rather than masking them in a screenshot.
    const options = { animations: 'disabled' as const, caret: 'hide' as const, scale: 'css' as const, timeout: 15000 }; // Normalize motion and pixel scale without altering content.
    await page.mouse.move(0, 0); // Avoid incidental message hover controls.
    const first = scene.region === 'element' ? await subject.screenshot(options) : await page.screenshot({ ...options, fullPage: false }); // Capture one exact region.
    const second = scene.region === 'element' ? await subject.screenshot(options) : await page.screenshot({ ...options, fullPage: false }); // Require consecutive frames to be stable.
    if (digest(first) !== digest(second)) throw new Error('Screenshot changed between consecutive frames'); // Do not accept unsettled content or auto-scrolling.
    evidence.image = `${base}.png`; evidence.imageSha256 = digest(second); // Bind the screenshot to its capture metadata.
    writeFileSync(evidence.image, second); evidence.status = 'CAPTURED'; // Save only a real stable browser render.
  } catch (error) { evidence.status = 'BLOCKED'; evidence.reason = error instanceof Error ? error.message : String(error); } // Keep failed scenes visible to the reviewer.
  finally { page.off('pageerror', onError); writeFileSync(`${base}.json`, JSON.stringify(evidence, null, 2)); } // Persist every result even when a later scene fails.
  return evidence; // Let host adapters report the exact outcome.
} // End Playwright capture SDK.
