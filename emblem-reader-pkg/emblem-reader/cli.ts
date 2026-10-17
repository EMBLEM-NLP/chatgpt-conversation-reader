import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'; // Keep captures, comparisons and diagnostics local.
import { resolve, join, dirname } from 'node:path'; // Resolve command-line paths without shell interpolation.
import { chromium, webkit } from 'playwright'; // Use supported Playwright engines in an independently permitted runtime.
import { capture } from './capture.ts'; // Reuse the page-based recorder for candidate scenes.
import { compare } from './compare.ts'; // Gate comparisons on compatible provenance.
import { review } from './review.ts'; // Generate the human inspection document.
import type { Config, Capture } from './types.ts'; // Type the local configuration and checkpoints.
const [command = 'help', ...args] = process.argv.slice(2); // Require an explicit browser command before launching anything.
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }; // Read explicit command flags only.
const output = resolve(option('--output') || 'rsi-results'); // Keep output separate from immutable archive source.
const configPath = resolve(option('--config') || join(import.meta.dirname, 'cases.json')); // Ship a grounded default scene list.
if (command === 'doctor') { // Inspect readiness without starting a browser or visiting a URL.
  console.log(JSON.stringify({ node: process.version, chromiumExecutablePresent: existsSync(chromium.executablePath()), webkitExecutablePresent: existsSync(webkit.executablePath()), browserLaunched: false, candidateRendered: false }, null, 2)); // Do not confuse installed binaries with successful execution.
  if (!existsSync(chromium.executablePath()) && !existsSync(webkit.executablePath())) process.exitCode = 2; // Missing engines must fail readiness in automated workflows.
} else if (command === 'capture-candidate') { // This command is for a runtime where candidate browsing is permitted.
  const candidateUrl = option('--url'); // Never invent or launch an alternate server for a blocked location.
  if (!candidateUrl) throw new Error('Provide --url for an explicitly permitted candidate location. No server or transport fallback is supplied.'); // Fail before browser startup if no destination was given.
  const parsedUrl = new URL(candidateUrl); // Validate the explicit location.
  if (!['https:', 'http:', 'file:'].includes(parsedUrl.protocol)) throw new Error('Unsupported candidate URL protocol'); // Reject executable/data schemes.
  const config: Config = JSON.parse(readFileSync(configPath, 'utf8')); // Read the pinned scenes before browser launch.
  if (config.schema !== 1 || !config.cases.length) throw new Error('Unsupported or empty scene configuration'); // Avoid vacuous success.
  const engine = option('--engine') || 'chromium'; // Keep engine identity explicit and recorded.
  if (!['chromium', 'webkit'].includes(engine)) throw new Error('Choose chromium or webkit'); // Do not silently switch browser families.
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true }); // Launch only under the caller's permitted environment.
  let failed = false; // Retain failures across all cases instead of reporting only the last result.
  try { for (const scene of config.cases) { // Capture each matching scene in an isolated context.
    const context = await browser.newContext({ viewport: scene.viewport, deviceScaleFactor: 1, colorScheme: scene.theme, reducedMotion: 'reduce' }); // Pin CSS pixel scale and preference state.
    try { // Always release contexts even when navigation is denied.
      const page = await context.newPage(); // Never borrow credentials or a browser profile.
      const url = new URL(candidateUrl); // Preserve the caller's chosen host and transport.
      for (const [key, value] of Object.entries({ rsi: '1', chat: scene.chat, turn: scene.turn, part: scene.part, theme: scene.theme })) url.searchParams.set(key, value); // Use validated archive presentation parameters.
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }); // Stop on navigation failure; no alternate routing.
      const result = await capture(page, scene, 'candidate', output, config.timezone); // Write actual or blocked scene evidence.
      failed ||= result.status !== 'CAPTURED'; // A blocked scene makes the batch unsuccessful.
      console.log(JSON.stringify({ case: scene.id, status: result.status, reason: result.reason })); // Report only concise local audit metadata.
    } finally { await context.close(); } // Avoid retaining state between cases.
  } } finally { await browser.close(); } // Close the runner-owned browser reliably.
  if (failed) process.exitCode = 2; // Preserve failure for CI and scripted callers.
} else if (command === 'compare') { // Compare already captured frames without opening a browser.
  const config: Config = JSON.parse(readFileSync(configPath, 'utf8')); // Use recorded thresholds and scenes.
  mkdirSync(output, { recursive: true }); // Store explicit missing-state results when captures are absent.
  const rows = config.cases.map(scene => { // Keep every expected state visible in the report.
    const load = (side: string): Capture | undefined => { const path = join(output, `${scene.id}.${side}.json`); if (!existsSync(path)) return undefined; const value = JSON.parse(readFileSync(path, 'utf8')); if (value.image && !value.image.startsWith('/')) value.image = resolve(dirname(path), value.image); return value; }; // Read explicit evidence files, not unrelated captures.
    const reference = load('reference'), candidate = load('candidate'); // Never create a reference from the candidate.
    return { id: scene.id, reference, candidate, result: compare(reference, candidate, join(output, `${scene.id}.difference.png`), config.threshold, config.maxDiffRatio) }; // Compute only eligible exact-size comparisons.
  }); // End the scene comparison pass.
  writeFileSync(join(output, 'comparison.json'), JSON.stringify(rows, null, 2)); // Preserve numerical and blocked outcomes.
  review(rows, join(output, 'review.html')); // Produce side-by-side frames, differences and missing-state slates.
  console.log(JSON.stringify({ scenes: rows.length, statuses: rows.map(row => row.result.status), review: join(output, 'review.html') })); // Summarize without claiming human approval.
  if (rows.some(row => row.result.status !== 'WITHIN_PIXEL_TOLERANCE')) process.exitCode = 2; // Incomplete or differing states must not pass CI.
} else { // Show a safe overview when no executable command was selected.
  console.log('Commands: doctor | capture-candidate --url <permitted-location> [--engine chromium|webkit] [--config file] [--output dir] | compare [--config file] [--output dir]. Reference capture uses capture(page, scene, "reference", directory) on an already authorized Playwright page.'); // Do not offer a browser-policy bypass.
} // End command dispatch.
