import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { activityContent } from './import-tool-events.ts'; // Share the source-faithful disclosure renderer.
import { pathToFileURL } from 'node:url';

// Import only explicitly observed public summaries; this never infers tool payloads.
export function importActivities(html: string, observations: any[]) {
  const tag = /(<script\b[^>]*\bid="chat-data"[^>]*>)([\s\S]*?)(<\/script>)/;
  const match = html.match(tag);
  if (!match || !Array.isArray(observations)) throw new Error('Expected archive data and an observation array');
  const data = JSON.parse(match[2]);
  const ids = new Set(Object.values(data.conversations).flatMap((c: any) => c.turns.flatMap((t: any) => (t.activityObservations || []).map((o: any) => o.observationId))));
  const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
  for (const o of observations) {
    if (o.kind !== 'activity-summary' || !o.observationId || ids.has(o.observationId) || typeof o.text !== 'string' || !o.text.trim() || o.toolPayloadsExposed !== false || !Number.isFinite(Date.parse(o.observedAt))) throw new Error('Invalid or duplicate public summary');
    const url = new URL(o.sourceUrl);
    if (url.origin !== 'https://chatgpt.com' || !url.pathname.includes('/c/')) throw new Error('Public source chat URL required');
    const turn = data.conversations[o.conversation]?.turns.find((t: any) => t.id === o.sourceTurnId);
    if (!turn) throw new Error('Unknown conversation or turn');
    // Native details keep evidence readable even when the file viewer disables JavaScript.
    const start = html.indexOf('data-turn-id="' + turn.id + '"');
    const end = html.indexOf('</article>', start);
    if (start < 0 || end < 0) throw new Error('Static turn is absent');
    const fragment = html.slice(start, end);
    let panelStart=fragment.indexOf('<details class="activity">'); // Find the existing outer disclosure.
    const plain=fragment.match(/<div class="static-activity">[\s\S]*?<\/div>/); // A capture gap is represented by a plain duration label.
    const plainStart=panelStart<0&&plain?plain.index!:-1; // Upgrade only a known duration label.
    if(plainStart>=0)panelStart=plainStart; // Preserve the same insertion position when content becomes available.
    if(panelStart<0)throw new Error('Static activity panel is absent'); // Refuse an uncertain insertion point.
    const tags=/<\/?details\b[^>]*>/g;tags.lastIndex=panelStart;let depth=0,panelEnd=-1; // Balance nested disclosures.
    if(plainStart>=0)panelEnd=plainStart+plain![0].length; // Replace exactly the old noninteractive label.
    else for(let m;(m=tags.exec(fragment));){depth+=m[0].startsWith('</')?-1:1;if(depth===0){panelEnd=tags.lastIndex;break;}} // Preserve content after nested branches.
    if(panelEnd<0)throw new Error('Unclosed activity panel'); // Reject malformed markup before saving.
    turn.activityObservations = [...(turn.activityObservations || []), o]; // Preserve the exact captured evidence.
    const details = '<details class="activity"><summary>' + esc(turn.durations?.[0] || 'Captured activity') + '</summary><div class="activity-captured">' + activityContent(turn) + '</div></details>'; // Use normal text and native nested summaries.
    html = html.slice(0,start)+fragment.slice(0,panelStart)+details+fragment.slice(panelEnd)+html.slice(end); // Replace exactly the balanced outer panel.
    ids.add(o.observationId);
  }
  const total = Object.values(data.conversations).reduce((sum: number, c: any) => sum + c.turns.reduce((s: number, t: any) => s + (t.activityObservations || []).length, 0), 0);
  data.contentCoverage.totals.activitySummaries = total;
  data.contentCoverage.generatedAt = new Date().toISOString();
  data.contentCoverage.status = 'INCOMPLETE_SOURCE_COVERAGE';
  data.contentCoverage.sourceInventoryVerified = false;
  data.contentCoverage.toolInventoryVerified = false;
  html = html.replace(/(<th>Recovered activity panels<\/th><td>)\d+(<\/td>)/, '$1' + total + '$2');
  // Escape closing-script characters; observed text is data, never executable code.
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  html = html.replace(tag, (_m, open, _body, close) => open + json + close);
  return html;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [archive, observations, output] = process.argv.slice(2);
    if (!archive || !observations || !output || existsSync(output)) throw new Error('Usage: node import-activity.ts ARCHIVE OBSERVATIONS NEW_OUTPUT');
    writeFileSync(output, importActivities(readFileSync(archive, 'utf8'), JSON.parse(readFileSync(observations, 'utf8'))));
    console.log(JSON.stringify({ output, status: 'INCOMPLETE_SOURCE_COVERAGE' }));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
