import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'; // Keep all inputs and outputs explicit.
import {resolve,join} from 'node:path'; // Resolve user-supplied workspace locations.
import {pathToFileURL} from 'node:url'; // Separate CLI and SDK use.
import {newChat,importEvidence,normalizeChatUrl} from './session.ts'; // Reuse session ownership and evidence hashing.
import {generateSession} from './generate-session.ts'; // Reuse verified asset embedding and native reader rendering.
import {validateConversation,selectBranch,queryConversation,graphProjection,type Conversation} from './conversation.ts'; // Use the new shared source model.
export function run(url:string,out:string,input?:string,assets?:string,branch?:string){ // One URL-driven import-to-reader entry point.
 const identity=normalizeChatUrl(url);out=resolve(out);if(existsSync(out))throw Error('Output must not already exist'); // Refuse accidental overwrites or ambiguous resumes.
 if(!input){newChat(url,out);return {status:'CAPTURE_REQUIRED',directory:out,reason:'Provide an authorized captured emblem.conversation/2 JSON; this command does not authenticate or capture a live chat.'};} // Fail visibly at the unimplemented live capture boundary.
 if(!assets||!branch)throw Error('Captured input requires asset root and branch ID');const bytes=readFileSync(input),c=JSON.parse(bytes.toString()) as Conversation;validateConversation(c);if(c.conversationId!==identity.id)throw Error('Source URL mismatch'); // Reject cross-chat inputs before writing a job.
 const transcript=selectBranch(c,branch);mkdirSync(out,{recursive:true});writeFileSync(join(out,'conversation.json'),bytes);writeFileSync(join(out,'graph.json'),JSON.stringify(graphProjection(c),null,2));writeFileSync(join(out,'branch.json'),JSON.stringify(transcript,null,2)); // Preserve exact imported source bytes and separate derived data.
 const job=join(out,'session');newChat(url,job);importEvidence(job,'reference','initial',join(out,'branch.json'));const report=generateSession(job,join(out,'reader'),assets); // Execute the existing generation path after evidence import.
 return {status:'READER_GENERATED_REVIEW_REQUIRED',directory:out,report,liveCapture:false,visualVerified:false}; // Generation never implies clone acceptance.
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){ // Run only when invoked directly.
 const [command,...args]=process.argv.slice(2);try{if(command==='run'){const r=run(args[0],args[1],args[2],args[3],args[4]);console.log(JSON.stringify(r,null,2));if(r.status==='CAPTURE_REQUIRED')process.exitCode=2;}else if(command==='query'){const c=JSON.parse(readFileSync(args[0],'utf8'));console.log(JSON.stringify(queryConversation(c,args[1],args[2] as any||'all'),null,2));}else throw Error('Usage: node reader.ts run CHAT_URL NEW_DIR [CONVERSATION_JSON ASSET_ROOT BRANCH_ID] | query CONVERSATION_JSON LITERAL [all|text|code|tool]');}catch(e){console.error(String(e));process.exitCode=1;} // Return reliable exit status to calling tools.
}
