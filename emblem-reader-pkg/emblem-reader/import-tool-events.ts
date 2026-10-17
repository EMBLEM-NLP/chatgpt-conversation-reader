import { readFileSync, writeFileSync, existsSync } from 'node:fs'; // Read only explicitly supplied archive and public logs.
import { createHash } from 'node:crypto'; // Bind imported records to the retained source log.
import { resolve } from 'node:path'; // Normalize CLI paths without shell execution.
import { pathToFileURL } from 'node:url'; // Separate SDK imports from the CLI.
import { validateToolEvents, completeToolEvidence, type ToolEvent } from './content-audit.ts'; // Reuse exact payload validation rules.
import { repairDisclosures } from './repair-disclosures.ts'; // Keep newly imported panels consistent with the screenshot repair.
export function activityContent(t: any) { // This same function renders static and interactive activity panels.
  const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!)); // Treat all captured tool output as inert text.
  const presentation = t.activityPresentation; // Render screenshot-grounded public disclosure text without capture diagnostics.
  const terminal = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 8 4 4-4 4m6 0h4"/></svg>'; // Match the visible terminal-outline activity marker.
  const summaries = presentation ? `<p class="activity-intro">${esc(presentation.intro)}</p><details class="activity-branch"><summary>${terminal}<span>${esc(presentation.label)}</span></summary><div class="activity-steps">${presentation.steps.map((line:string)=>`<p>${esc(line)}</p>`).join('')}</div></details>` : (t.activityObservations || []).map((o:any)=>o.text.split(/\n\s*\n/).filter((line:string)=>!(t.durations||[]).includes(line.trim())).map((line:string)=>`<p class="activity-intro">${esc(line)}</p>`).join('')).join(''); // Keep observed words in normal typography and preserve their order.
  const events = (t.toolEvents || []).slice().sort((a: any,b: any) => a.ordinal-b.ordinal); // Preserve the recorded order without inventing missing events.
  const tools = events.map((e: any) => `<details class="tool-event"><summary>${esc(e.toolName)} · ${esc(e.status)}</summary><p>Call ID: ${esc(e.callId ?? 'Not exposed')} · Source position: ${e.ordinal}</p><h4>Input${e.inputComplete?'':' · incomplete'}</h4><pre style="white-space:pre-wrap"><code>${esc(e.input === null ? 'Not captured' : e.input)}</code></pre><h4>Output${e.outputComplete?'':' · incomplete'}</h4><pre style="white-space:pre-wrap"><code>${esc(e.output === null ? 'Not captured' : e.output)}</code></pre>${e.error === null?'':`<h4>Error</h4><pre style="white-space:pre-wrap">${esc(e.error)}</pre>`}<p>Source: ${esc(e.source.reference)} · observed ${esc(e.source.observedAt)}</p></details>`).join(''); // Preserve exact code whitespace, outputs, errors and provenance.
  return summaries+tools; // Keep missing-capture counts in the separate inventory, never substitute them for source conversation UI.
} // End shared panel renderer.
function removeActivity(fragment: string) { // Remove one existing activity details element, including nested disclosures.
  const start=fragment.indexOf('<details class="activity">'); // Match only the reader-owned activity panel.
  if(start<0)return fragment.replace(/<div class="static-activity">[\s\S]*?<\/div>/,''); // Replace a duration label when new captured content becomes available.
  const tokens=/<\/?details\b[^>]*>/g;tokens.lastIndex=start;let depth=0; // Balance nested tool panels rather than stopping at the first closing tag.
  for(let m;(m=tokens.exec(fragment));){depth+=m[0].startsWith('</')?-1:1;if(depth===0)return fragment.slice(0,start)+fragment.slice(tokens.lastIndex);} // Retain all surrounding reply markup unchanged.
  throw new Error('Unclosed activity details'); // Refuse destructive partial rewrites.
} // End balanced static panel removal.
export function importToolEvents(source: string, events: ToolEvent[], logReference: string, logSha256: string) { // Merge records atomically into both reader modes.
  const tag=/(<script\b[^>]*\bid="chat-data"[^>]*>)([\s\S]*?)(<\/script>)/;const match=source.match(tag); // Locate the one retained archive payload.
  if(!match||!Array.isArray(events))throw new Error('Expected archive data and tool event array'); // Never create an empty archive on parse failure.
  const d=JSON.parse(match[2]);const turns=Object.entries(d.conversations).flatMap(([chat,c]:any)=>c.turns.map((t:any)=>({chat,t}))); // Resolve ownership from actual conversation IDs.
  validateToolEvents([...turns.flatMap(({t}:any)=>t.toolEvents||[]),...events],turns.map(({chat,t}:any)=>({chat,id:t.id}))); // Reject duplicates, unknown turns and incomplete calls mislabelled complete before mutation.
  for(const e of events)turns.find(({chat,t}:any)=>chat===e.conversation&&t.id===e.turnId)!.t.toolEvents.push(e); // Retain exact input/output strings without truncation.
  if(events.length){if(!logReference||!/^([a-f0-9]{64})$/.test(logSha256))throw new Error('Source log reference and SHA-256 required');d.toolImports=[...(d.toolImports||[]),{reference:logReference,sha256:logSha256,importedAt:new Date().toISOString(),events:events.length}];} // Keep source-log lineage independent of execution timestamps.
  const all=turns.flatMap(({t}:any)=>t.toolEvents||[]); // Count only retained explicit calls.
  d.contentCoverage.totals.toolEvents=all.length;d.contentCoverage.totals.completeToolPayloads=all.filter(completeToolEvidence).length;d.contentCoverage.toolInventoryVerified=false;d.contentCoverage.status='INCOMPLETE_SOURCE_COVERAGE'; // Importing some events cannot prove exhaustive coverage.
  d.activityCaptureInventory=turns.map(({chat,t}:any)=>({conversation:chat,turnId:t.id,prompt:t.prompt,replyCaptured:t.hasAssistant,sourceUrl:d.conversations[chat].url,activityRecords:(t.activityObservations||[]).length,toolRecords:(t.toolEvents||[]).length,completePayloads:(t.toolEvents||[]).filter(completeToolEvidence).length,inventoryVerified:false})); // Maintain an actionable gap list for every captured turn in both conversations.
  const staticEnd=source.indexOf('<script'); // Keep embedded JSON and JavaScript templates outside DOM rewriting.
  let count=0;let output=source.slice(0,staticEnd).replace(/(<article\b[^>]*data-turn-id="([^"]+)"[^>]*>)([\s\S]*?)(<\/article>)/g,(_m,open,id,body,close)=>{ // Update only known reader-owned turn containers.
    const item=turns.find(({t}:any)=>t.id===id);if(!item)throw new Error('Unknown static turn'); // Prevent detached activity from appearing on a different reply.
    const clean=removeActivity(body);const user=clean.match(/<section class="user-message"[\s\S]*?<\/section>/);if(!user)throw new Error('Static user section missing'); // Anchor the panel immediately after the user message.
    count++;const visible=(item.t.durations||[]).length||(item.t.activityObservations||[]).length||(item.t.toolEvents||[]).length;const label=(item.t.durations||[]).join(' · ')||'Captured activity';const panel=visible?'<details class="activity"><summary>'+label.replace(/[&<>]/g,(c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))+'</summary><div class="activity-captured">'+activityContent(item.t)+'</div></details>':''; // Native details work when scripts are disabled.
    const end=user.index!+user[0].length;return open+clean.slice(0,end)+panel+clean.slice(end)+close; // Keep all original message markup.
  })+source.slice(staticEnd); // End all-turn static rendering and retain embedded scripts.
  if(count!==turns.length)throw new Error('Static turn coverage mismatch'); // All 39 current turns must be represented.
  const start=output.indexOf('function activityContent('),end=output.indexOf('function capturedHtml(',start); // Replace only the established runtime renderer boundary.
  if(start<0||end<0)throw new Error('Runtime activity renderer missing'); // Refuse uncertain code replacement.
  output=output.slice(0,start)+activityContent.toString()+'\n'+output.slice(end); // Share exact rendering behavior across static and interactive modes.
  output=output.replace('const activity=true?', 'const activity=(t.durations.length||(t.activityObservations||[]).length||(t.toolEvents||[]).length)?'); // Provide an activity panel for every turn, including turns without duration labels.
  const json=JSON.stringify(d).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029'); // Prevent payload text from terminating the JSON script element.
  output=output.replace(tag,(_m,a,_b,c)=>a+json+c); // Preserve captured user/assistant source fields unchanged.
  return {html:repairDisclosures(output).html,inventory:d.activityCaptureInventory,toolEvents:all.length}; // Preserve noninteractive empty labels during every future rebuild.
} // End SDK import.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){ // Execute only as a CLI.
  const [archive,log,out]=process.argv.slice(2);if(!archive||!log||!out||existsSync(out))throw new Error('Usage: node import-tool-events.ts ARCHIVE PUBLIC_EVENTS.jsonl NEW_OUTPUT.html'); // Do not overwrite earlier capture evidence.
  const raw=readFileSync(log);const events=raw.toString('utf8').split(/\r?\n/).filter(s=>s.trim()).map(s=>JSON.parse(s)); // Decode JSONL without normalizing payload strings.
  const result=importToolEvents(readFileSync(archive,'utf8'),events,log,createHash('sha256').update(raw).digest('hex')); // Bind every import batch to exact source bytes.
  writeFileSync(out,result.html);writeFileSync(out+'.activity-inventory.json',JSON.stringify(result.inventory,null,2)); // Save the all-turn coverage inventory alongside the reader.
  console.log(JSON.stringify({output:out,turns:result.inventory.length,toolEvents:result.toolEvents,status:'INCOMPLETE_SOURCE_COVERAGE'})); // Never claim complete capture merely because import succeeded.
} // End CLI.
