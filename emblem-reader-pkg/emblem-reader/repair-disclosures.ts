import { readFileSync, writeFileSync } from 'node:fs'; // Read only the explicitly selected reader.
import { pathToFileURL } from 'node:url'; // Keep SDK imports side-effect free.
export function repairDisclosures(source: string) { // Apply screenshot-grounded presentation corrections without rewriting source messages.
  let removed = 0; // Count empty panels converted to noninteractive duration labels.
  let html = source.replace(/<details class="activity"><summary>((?:(?!<\/summary>)[\s\S])*)<\/summary><div class="activity-captured">\s*<\/div><\/details>/g, (_match, label) => { removed++; return '<div class="static-activity">' + label.replace(/<svg\b[\s\S]*?<\/svg>/g, '') + '</div>'; }); // Empty capture data cannot support a working dropdown.
  const old = /const activity=\(t\.durations\.length\|\|\(t\.activityObservations\|\|\[\]\)\.length\|\|\(t\.toolEvents\|\|\[\]\)\.length\)\?[^\n]+/; // Match the established runtime panel boundary.
  const replacement = "const activityBody=activityContent(t); const activityLabel=esc([...new Set(t.durations)].join(' · ')); const activity=activityBody.trim()?'<details class=\"activity\"><summary>'+(activityLabel||'Captured activity')+'</summary><div class=\"activity-captured\">'+activityBody+'</div></details>':activityLabel?'<div class=\"static-activity\">'+activityLabel+'</div>':''; // Only captured content receives a disclosure."; // Keep static and scripted behavior consistent.
  if(old.test(html)) html=html.replace(old,()=>replacement); // Replace the old duration-only dropdown rule.
  else if(html.includes('const activity=')&&!html.includes('const activityBody=activityContent(t);')) throw Error('Unknown activity runtime'); // Reject changed runtime templates while allowing static-only fragments.
  html=html.replace(/\.activity summary:after\{content:"⌄";font-size:18px;margin-left:4px\}\.activity\[open\] summary:after\{content:"⌃"\}/g,''); // Remove inherited text glyphs that overlap the CSS chevron.
  const css = `/* Screenshot audit IMG_9494–9503: scoped presentation corrections. */
.activity>summary::after,.activity-branch>summary::after{content:"";transform:rotate(-45deg)} /* Closed state uses one drawn chevron. */
.activity[open]>summary::after,.activity .activity-branch[open]>summary::after{content:"";transform:rotate(45deg)} /* Open state rotates only its own chevron. */
.activity .activity-intro,.activity .activity-branch>summary,.activity .activity-steps p{font-size:16px;line-height:24px} /* Preserve the matching body scale and source line spacing. */
@media(max-width:800px){.assistant-body h2{font-size:18px;line-height:28px;font-weight:600;letter-spacing:0}} /* Restore the source heading hierarchy instead of scaling the whole page. */
[data-turn-id="f9a5f245-fc5e-4c24-98b3-2be4f76f4299"] .assistant-body p.component-text>span.component-text{font-weight:700} /* Restore two bold phrases visible in IMG_9501. */
[data-turn-id="f9a5f245-fc5e-4c24-98b3-2be4f76f4299"] .component-badge{display:inline-flex;align-items:center;gap:5px;font-size:14px;line-height:20px;padding:1px 8px;border-radius:999px;background:#d5f2e3;color:#378b44} /* Restore the compact green status pill. */
[data-turn-id="f9a5f245-fc5e-4c24-98b3-2be4f76f4299"] .component-badge::before{content:"✓";display:inline-flex;align-items:center;justify-content:center;width:11px;height:11px;border:1.2px solid currentColor;border-radius:50%;font-size:9px;line-height:1} /* Restore the observed status check marker. */
`; // Keep evidence-specific formatting scoped to its known turn.
  html=html.replace(/<style id="disclosure-font-repair">[\s\S]*?<\/style>/g,''); // Make repeat execution idempotent.
  html=html.replace('</head>','<style id="disclosure-font-repair">'+css+'</style></head>'); // Last stylesheet wins over legacy cascade fragments.
  return {html,emptyPanelsRemoved:removed}; // Report only actual changes, never rendered parity.
} // End repair SDK.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node repair-disclosures.ts INPUT OUTPUT');const result=repairDisclosures(readFileSync(input,'utf8'));writeFileSync(output,result.html);console.log(JSON.stringify({emptyPanelsRemoved:result.emptyPanelsRemoved,browserValidated:false}));} // Expose a deterministic CLI.
