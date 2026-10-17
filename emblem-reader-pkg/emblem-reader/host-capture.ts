import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'; // Require a clean output directory and read the sealed conversation inventory.
import { resolve } from 'node:path'; // Normalize only explicit local paths.
import { fileURLToPath, pathToFileURL } from 'node:url'; // Convert explicit local paths safely and import the caller-selected host module.
import { capturePair } from './capture-pair.ts'; // Run the existing capture and paired-review pipeline.
import type { Conversation, ScrollOptions } from './full-scroll.ts'; // Share the capture contract without weakening it.
import { fullScrollReview } from './scroll-review.ts'; // Write a self-contained review beside both manifests.

type Config = ScrollOptions & { schema: number; conversations: Conversation[] }; // Keep configuration values typed at the boundary.
type HostPages = { referencePage: Parameters<typeof capturePair>[0]; candidatePage: Parameters<typeof capturePair>[1] }; // Require real Playwright Pages from the caller.
type HostModule = { getOpenPages: (request: { conversation: Conversation }) => Promise<HostPages> | HostPages }; // Host returns already-open pages; this runner has no browser lifecycle API.

export function parseArgs(args: string[]) { // Parse only the small explicit CLI surface.
  const values = new Map<string, string>(); // Keep duplicate flags detectable.
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--host', '--conversation', '--out', '--config'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (values.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Expected one value for ${flag}`);
    values.set(flag, args[++i]);
  }
  for (const required of ['--host', '--conversation', '--out']) if (!values.has(required)) throw new Error(`Required: ${required}`);
  return { host: resolve(values.get('--host')!), conversationId: values.get('--conversation')!, output: resolve(values.get('--out')!), configPath: resolve(values.get('--config') || fileURLToPath(new URL('./scroll-config.json', import.meta.url))) };
} // End explicit argument parsing.

export async function runHostCapture(args: string[]) { // Compose a single conversation run without launching or connecting to a browser.
  const parsed = parseArgs(args);
  const config: Config = JSON.parse(readFileSync(parsed.configPath, 'utf8'));
  if (config.schema !== 1 || !Array.isArray(config.conversations)) throw new Error('Unsupported scroll config');
  const conversation = config.conversations.find(item => item.id === parsed.conversationId);
  if (!conversation) throw new Error(`Unknown conversation: ${parsed.conversationId}`);
  if (!existsSync(parsed.host)) throw new Error('Host module does not exist');
  if (existsSync(parsed.output) && readdirSync(parsed.output).length) throw new Error('Output directory must be new or empty');
  mkdirSync(parsed.output, { recursive: true });
  const host = await import(pathToFileURL(parsed.host).href) as HostModule;
  if (typeof host.getOpenPages !== 'function') throw new Error('Host module must export getOpenPages({ conversation })');
  const { referencePage, candidatePage } = await host.getOpenPages({ conversation });
  if (!referencePage || !candidatePage) throw new Error('Host did not return both Playwright Page objects');
  const options: ScrollOptions = { overlap: config.overlap, maxFrames: config.maxFrames, maxSeekPasses: config.maxSeekPasses, stableSamples: config.stableSamples, screenshotTimeoutMs: config.screenshotTimeoutMs, screenshotRetries: config.screenshotRetries, timezone: config.timezone };
  const capture = await capturePair(referencePage, candidatePage, conversation, parsed.output, options);
  const reviewPath = resolve(parsed.output, `${conversation.id}.full-scroll.html`);
  const review = fullScrollReview(resolve(parsed.output, `${conversation.id}.reference/scroll.json`), resolve(parsed.output, `${conversation.id}.candidate/scroll.json`), reviewPath);
  return { conversation: conversation.id, reference: capture.reference.status, candidate: capture.candidate.status, review: review.status, output: reviewPath };
} // End host supplied capture orchestration.

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { // Do nothing when imported as a library.
  runHostCapture(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result)); if (result.review !== 'READY_FOR_HUMAN_REVIEW') process.exitCode = 2; }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
} // End CLI entry point.
