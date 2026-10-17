import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'; // Keep all output local until the host chooses to save it.
import { resolve, join } from 'node:path'; // Accept explicit filesystem destinations.
import { fileURLToPath, pathToFileURL } from 'node:url'; // Resolve the bundled standard-library parser.
import { spawnSync } from 'node:child_process'; // Parse HTML without launching a browser or executing document scripts.
import { auditContent, validateToolEvents, type Inspection, type ToolEvent } from './content-audit.ts'; // Reuse the SDK's evidence rules.
export function runContentAudit(args: string[]) { // Expose one auditable command for captured-content coverage.
  const values = new Map<string, string>(); // Detect duplicate or unsupported flags.
  for (let i = 0; i < args.length; i++) { const key = args[i]; if (!['--archive', '--out', '--tool-events'].includes(key) || values.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${key}`); values.set(key, args[++i]); } // Never interpret shell fragments as arguments.
  if (!values.has('--archive') || !values.has('--out')) throw new Error('Required: --archive FILE.html --out NEW_DIRECTORY'); // Refuse ambiguous input and output.
  const archive = resolve(values.get('--archive')!); const output = resolve(values.get('--out')!); // Pin exact local paths.
  if (existsSync(output)) throw new Error('Output exists; choose a new directory to preserve earlier audit evidence'); // Keep audits immutable.
  const parsed = spawnSync('python3', [fileURLToPath(new URL('./archive-inspect.py', import.meta.url)), archive], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }); // Use Python only for HTML parsing; no third-party Python dependency is needed.
  if (parsed.status !== 0 || parsed.error) throw new Error(parsed.error?.message || parsed.stderr || 'Archive parser failed'); // Never replace a failed read with an empty passing transcript.
  const input: Inspection = JSON.parse(parsed.stdout); // Consume the complete structured inspection.
  if (values.has('--tool-events')) { // Accept only an explicitly supplied public event log.
    const events: ToolEvent[] = readFileSync(resolve(values.get('--tool-events')!), 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); validateToolEvents([...input.turns.flatMap(t => t.toolEvents), ...events], input.turns); // Preserve exact payload strings and reject duplicate evidence.
    for (const event of events) input.turns.find(t => t.chat === event.conversation && t.id === event.turnId)!.toolEvents.push(event); // Add evidence without claiming that its inventory is exhaustive.
  } // End explicit tool-log ingestion.
  const report = auditContent(input); mkdirSync(output, { recursive: true }); // Create output only after successful parsing and validation.
  writeFileSync(join(output, 'content-audit.json'), JSON.stringify(report, null, 2)); // Retain per-turn hashes, status, and gaps.
  const lines = ['# Chat archive content audit', '', `Status: **${report.status}**`, '', '| Content | Captured |', '|---|---:|', ...Object.entries(report.totals).map(([key, value]) => `| ${key} | ${value} |`), '', '## Coverage limits', '', ...report.limitations.map(value => `- ${value}`), '', '## Preservation failures', '', ...(report.failures.length ? report.failures.map(value => `- ${value}`) : ['No changes to captured code were detected. This does not prove source completeness.']), '', '## Per-turn inventory', '', '| Chat / turn | Reply | Multiline code | Activity summaries | Complete tool payloads |', '|---|---|---:|---:|---:|', ...report.turns.map(t => `| ${t.chat} / ${t.index + 1} | ${t.replyCaptured ? 'Captured' : 'Not captured'} | ${Number((t.roles.user as {codeBlocks:number}).codeBlocks) + Number((t.roles.assistant as {codeBlocks:number}).codeBlocks)} | ${t.activitySummaries} | ${t.toolPayloads} |`)]; // Keep the human report concise and source-linked.
  writeFileSync(join(output, 'content-audit.md'), lines.join('\n') + '\n'); // Produce a readable counterpart to the JSON evidence.
  writeFileSync(join(output, 'tool-events.jsonl'), report.toolEvents.map(e => JSON.stringify(e)).join('\n') + (report.toolEvents.length ? '\n' : '')); // Empty means none captured, not no calls occurred.
  return { status: report.status, preservationStatus: report.preservationStatus, totals: report.totals, output }; // Let callers enforce the incomplete-content gate.
} // End offline CLI orchestration.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { // Keep imports free of side effects.
  try { const result = runContentAudit(process.argv.slice(2)); console.log(JSON.stringify(result)); if (result.status !== 'COMPLETE_VERIFIED_SOURCE') process.exitCode = 2; } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } // Exit 2 reports a successful audit with incomplete source coverage.
} // End command entry point.
