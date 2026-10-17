import {validateTranscript} from './transcript.ts'; // Validate transcript snapshots before accepting them as generation inputs.
import {validateDomEvidence} from './dom-evidence.ts'; // Validate recognized DOM captures at the evidence import boundary.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'; // Persist explicit capture jobs and original evidence bytes.
import {resolve,join} from 'node:path'; // Resolve local destinations without shell interpolation.
import {createHash} from 'node:crypto'; // Bind observations to exact file content.
import {pathToFileURL} from 'node:url'; // Keep the SDK import free of CLI side effects.
export const upstream={repository:'https://github.com/morluto/rea',commit:'313a86a3695224b0c2d50ad2de2112e5b251b4ec',version:'6.5.0'}; // Pin the audited upstream rather than following an unreviewed latest release.
export function normalizeChatUrl(input:string){ // Accept only explicit ChatGPT conversation URLs.
 const url=new URL(input); // Parse with URL semantics rather than substring matching.
 if(url.protocol!=='https:'||url.hostname!=='chatgpt.com'||url.port||url.username||url.password)throw Error('Expected an HTTPS chatgpt.com conversation URL'); // Reject unrelated hosts and embedded credentials.
 const match=url.pathname.match(/^(?:\/g\/[^/]+)?\/c\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i); // Preserve the actual conversation ID, including project URLs.
 if(!match)throw Error('Expected /c/UUID or /g/PROJECT/c/UUID'); // Do not treat a new-chat landing page as captured history.
 return {id:match[1].toLowerCase(),url:'https://chatgpt.com/c/'+match[1].toLowerCase(),suppliedUrl:input}; // Retain the caller input alongside the canonical identity.
} // End URL boundary validation.
export function newChat(input:string,directory:string){ // Create a new job without opening a browser or submitting a prompt.
 const source=normalizeChatUrl(input),folder=resolve(directory); // Validate before writing anything.
 if(existsSync(folder))throw Error('Output directory already exists; choose a new job directory'); // Never overwrite an earlier capture job.
 const job={schema:'emblem.rsi.session/1',source,upstream,createdAt:new Date().toISOString(),status:'SOURCE_CAPTURE_REQUIRED',evidence:[] as any[],steps:['initial','activity-collapsed','activity-expanded','nested-branch-expanded','image-open','image-close','attachment-download','conversation-switch','scroll-header','composer-viewport'].map(id=>({id,reference:'missing',candidate:'missing',result:'unknown'})),limitations:['No browser launched','No conversation captured','No prompt submitted','Raw historical tool payloads are not implied by UI activity labels']}; // Represent all ten unexecuted checkpoints explicitly.
 mkdirSync(join(folder,'evidence'),{recursive:true}); // Allocate a dedicated namespace for this conversation.
 writeFileSync(join(folder,'session.json'),JSON.stringify(job,null,2)); // Persist source identity and incomplete state.
 writeFileSync(join(folder,'NEXT_STEPS.md'),'# New conversation capture\n\nSource: '+source.url+'\n\nOpen this exact URL in an authorized signed-in browser. Inspect selectors before using content-capture.ts. Capture the public content and every required expansion state. Save reference and candidate evidence with identical step IDs. Use existing compare and validation-gate commands for rendered acceptance. This initialization neither sends a query nor captures history.\n'); // Give an actionable handoff without pretending to own the authenticated session.
 return job; // Expose the same job through SDK and CLI.
} // End job initialization.
export function importEvidence(directory:string,side:string,step:string,path:string){ // Retain an external capture without asserting it passed verification.
 if(!['reference','candidate'].includes(side))throw Error('Side must be reference or candidate'); // Keep source and reconstructed artifacts separate.
 const folder=resolve(directory),file=join(folder,'session.json'),job=JSON.parse(readFileSync(file,'utf8')); // Load only the selected job.
 if(job.schema!=='emblem.rsi.session/1')throw Error('Unsupported session schema'); // Reject unrelated JSON.
 const checkpoint=job.steps.find((x:any)=>x.id===step);if(!checkpoint)throw Error('Unknown step ID'); // Prevent accidental cross-state comparisons.
 const bytes=readFileSync(path),sha256=createHash('sha256').update(bytes).digest('hex'),name=sha256+'.json'; // Use content-addressed evidence storage.
 const payload=JSON.parse(bytes.toString('utf8'));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Expected a JSON evidence object'); // Validate basic container shape without inventing a REA schema.
 if(payload.schema==='emblem.dom-evidence/1'){validateDomEvidence(payload);if(payload.identity.conversationId!==job.source.id||payload.identity.side!==side||payload.identity.stepId!==step)throw Error('DOM evidence does not match the selected session, side and step');} // Prevent accidental cross-conversation import while preserving unknown external formats.
 if(payload.schema==='emblem.transcript/1'){validateTranscript(payload);if(side!=='reference'||payload.conversationId!==job.source.id||normalizeChatUrl(payload.sourceUrl).id!==job.source.id)throw Error('Transcript source does not match session');} // Reader generation only consumes the selected conversation reference snapshots.
 if(job.evidence.some((e:any)=>e.side===side&&e.step===step&&e.sha256===sha256))throw Error('Duplicate evidence'); // Do not inflate evidence coverage by repeated import.
 writeFileSync(join(folder,'evidence',name),bytes); // Preserve exact upstream payload and whitespace.
 job.evidence.push({side,step,sha256,file:'evidence/'+name,importedAt:new Date().toISOString(),provenanceStatus:'CALLER_ASSOCIATED_UNVERIFIED'}); // Association is not proof of source identity or equivalent rendered state.
 checkpoint[side]='imported-unverified';checkpoint.result='unknown';job.status='EVIDENCE_IMPORTED_REVIEW_REQUIRED'; // Never promote an import to visual equivalence.
 writeFileSync(file,JSON.stringify(job,null,2));return job; // Save and return the updated job atomically at the logical operation boundary.
} // End evidence retention.
export function sessionStatus(directory:string){ // Inspect readiness without executing a target.
 const folder=resolve(directory),job=JSON.parse(readFileSync(join(folder,'session.json'),'utf8')); // Read the explicit job only.
 for(const e of job.evidence){if(!/^[a-f0-9]{64}$/.test(e.sha256)||e.file!=='evidence/'+e.sha256+'.json')throw Error('Invalid evidence path');if(createHash('sha256').update(readFileSync(join(folder,e.file))).digest('hex')!==e.sha256)throw Error('Evidence integrity mismatch');} // Detect tampering and refuse traversal paths.
 return {source:job.source.url,status:job.status,evidenceFiles:job.evidence.length,steps:job.steps,cloneVerified:false}; // Report retained coverage without confusing it with acceptance.
} // End status check.
export function reaScenario(url:string,executable:string,outer:string,inner:string){ // Export a REA scenario without starting REA or a browser.
 const target=new URL(url);if(!['https:','http:','file:'].includes(target.protocol)||!executable||!outer||!inner)throw Error('Explicit target, installed browser executable and inspected selectors required'); // Refuse guessed transport and selectors.
 return {browser:{mode:'launch',executable_path:resolve(executable)},start_url:{url:target.href},actions:[{step_id:'initial',action:'wait_for',locator:{kind:'css',selector:outer},state:'visible',timeout_ms:10000},{step_id:'activity-expanded',action:'click',locator:{kind:'css',selector:outer},timeout_ms:10000},{step_id:'nested-branch-expanded',action:'click',locator:{kind:'css',selector:inner},timeout_ms:10000}],capture:{after_each_step:['dom','accessibility','url','screenshot']}}; // Use upstream's documented step and capture contract, preserving state identities.
} // End scenario adapter; execution requires an independently permitted runtime.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){ // Dispatch only direct CLI invocation.
 const [command,...args]=process.argv.slice(2); // Keep command semantics independent from browser providers.
 try{const result=command==='new-chat'?newChat(args[0],args[1]):command==='import-evidence'?importEvidence(args[0],args[1],args[2],args[3]):command==='status'?sessionStatus(args[0]):command==='rea-scenario'?reaScenario(args[0],args[1],args[2],args[3]):{usage:'node session.ts new-chat CHAT_URL NEW_DIRECTORY | import-evidence DIRECTORY reference|candidate STEP JSON_FILE | status DIRECTORY | rea-scenario URL EXECUTABLE OUTER_SELECTOR INNER_SELECTOR'};console.log(JSON.stringify(result,null,2));}catch(error){console.error(String(error));process.exitCode=1;} // Return machine-readable output and honest nonzero failures.
} // End CLI adapter.
