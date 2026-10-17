import {readFileSync,writeFileSync} from 'node:fs'; // Load the current candidate and retain the revised result.
import {createHash} from 'node:crypto'; // Bind transcription provenance to the supplied screenshot bytes.
import {importToolEvents} from './import-tool-events.ts'; // Use one renderer for native and scripted disclosures.
const path='../review/EMBLEM_Chat_Archive.html'; // Work only on the existing reader.
let source=readFileSync(path,'utf8'); // Preserve all embedded original image bytes.
const pattern=/(<script\b[^>]*\bid="chat-data"[^>]*>)([\s\S]*?)(<\/script>)/; // Locate the retained conversation payload.
const match=source.match(pattern)!;const data=JSON.parse(match[2]); // Decode without modifying source HTML fields.
const turn=data.conversations.mountain.turns.find((t:any)=>t.id==='f9a5f245-fc5e-4c24-98b3-2be4f76f4299'); // Associate the supplied disclosure with its actual prompt.
if(!turn||turn.prompt!=='We need plates with side by side the original')throw Error('Screenshot turn mismatch'); // Refuse approximate ownership.
turn.activityPresentation={intro:'I’ll match each of the 10 illustrated renders to its exact source photograph, create labeled side-by-side comparison plates without cropping either image, and package them with an overview sheet.',label:'Prepared and validated image comparison plates and archive bundle',steps:['Preparing side-by-side original and rendered image plates','Creating property comparison plates and archive bundle','Analyzed image','Validating Zip Archive and Image Pairs'],source:{kind:'user-supplied-screenshot',file:'IMG_9479.png',sha256:createHash('sha256').update(readFileSync('../../upload/IMG_9479.png')).digest('hex')},toolPayloadsExposed:false}; // Transcribe only visible public text; never synthesize raw tool calls.
source=source.replace(pattern,(_m,a,_b,c)=>a+JSON.stringify(data).replaceAll('<','\\u003c')+c); // Keep new provenance out of the visible conversation.
source=importToolEvents(source,[],'', '').html; // Rebuild the native and runtime activity panels consistently.
const css=`<style id="activity-branch-parity">
.activity>summary{display:flex;align-items:center;gap:10px;list-style:none;color:#969696;font-weight:400;cursor:pointer}
.activity>summary::-webkit-details-marker,.activity-branch>summary::-webkit-details-marker{display:none}
.activity>summary>svg{display:none}
.activity>summary::after,.activity-branch>summary::after{content:'';display:inline-block;width:9px;height:9px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);flex-shrink:0;margin-left:3px}
.activity[open]>summary::after,.activity-branch[open]>summary::after{content:"";transform:rotate(45deg)}
.activity .activity-captured{padding:0;border:0;background:transparent;font:inherit}
.activity .activity-intro{border:0;padding:0;color:#111;font:inherit;line-height:1.55;white-space:normal;margin:20px 0 24px}
.activity-branch{border:0;background:transparent;padding:0;margin:0 0 22px;color:#969696}
.activity-branch>summary{display:flex;align-items:flex-start;gap:12px;list-style:none;font:inherit;line-height:1.55;cursor:pointer}
.activity .activity-branch>summary>svg{display:block;width:20px;height:20px;transform:none;flex-shrink:0;margin-top:6px}
.activity .activity-branch>summary::after{content:"";margin-top:10px;margin-left:auto}
.activity .activity-steps p{border:0;padding:0;font:inherit;line-height:1.55;margin:0;color:#969696}
</style>`; // Define both native disclosure states without requiring JavaScript.
source=source.replace(/<style id="activity-branch-parity">[\s\S]*?<\/style>/g,'').replace('</head>',css+'</head>'); // Keep native disclosures usable in file previews.
writeFileSync(path,source); // Persist the revised candidate only after all source checks succeed.
console.log('Screenshot-grounded nested branch rendered into both modes'); // Report implementation without asserting device parity.
