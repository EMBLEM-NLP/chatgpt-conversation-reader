import {test} from 'node:test'; // Validate the public SDK used by the new URL CLI.
import assert from 'node:assert/strict'; // Reject identity and evidence integrity regressions.
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'; // Use isolated synthetic jobs.
import {tmpdir} from 'node:os'; // Avoid touching real captured conversations.
import {join} from 'node:path'; // Compose platform-safe fixture paths.
import {newChat,normalizeChatUrl,importEvidence,sessionStatus,reaScenario} from './session.ts'; // Exercise the same production boundaries as the CLI.
const url='https://chatgpt.com/c/6acbab4b-1894-83ea-8647-4a0eab6f7769'; // Existing URL used only as an inert fixture string.
test('conversation URLs preserve identity and reject wrong destinations',()=>{ // Prevent authentication data or unrelated URLs from becoming jobs.
 assert.equal(normalizeChatUrl(url).url,url);assert.equal(normalizeChatUrl(url.replace('/c/','/g/project/c/')).url,url); // Support ordinary and project conversation forms.
 for(const bad of ['https://evil.test/c/123','javascript:alert(1)','https://chatgpt.com/','https://user:pass@chatgpt.com/c/6acbab4b-1894-83ea-8647-4a0eab6f7769'])assert.throws(()=>normalizeChatUrl(bad)); // Refuse invalid or credential-bearing inputs.
}); // End URL contract.
test('new jobs cannot overwrite, imports cannot imply completion, hashes detect tampering',()=>{ // Verify persistence and incomplete-state semantics.
 const folder=mkdtempSync(join(tmpdir(),'rsi-session-')),job=join(folder,'job'),input=join(folder,'capture.json'); // Allocate an isolated fixture.
 try{newChat(url,job);assert.throws(()=>newChat(url,job));writeFileSync(input,'{"fixture":true}\n');importEvidence(job,'reference','initial',input);assert.throws(()=>importEvidence(job,'reference','initial',input));assert.equal(sessionStatus(job).cloneVerified,false);assert.equal(sessionStatus(job).evidenceFiles,1);const d=JSON.parse(readFileSync(join(job,'session.json'),'utf8'));writeFileSync(join(job,d.evidence[0].file),'changed');assert.throws(()=>sessionStatus(job),/integrity/);}finally{rmSync(folder,{recursive:true,force:true});} // Keep import and hash checks scoped to fixtures.
}); // End persistence regression.

test('REA scenario requests actual visual and structural artifacts at matching steps',()=>{ // Prevent URL-only evidence from being sold as visual parity.
 const plan=reaScenario('https://example.test/reader','/fixture/chromium','#outer','#inner'); // Build only; never execute the fixture browser.
 assert.deepEqual(plan.capture.after_each_step,['dom','accessibility','url','screenshot']);assert.equal(plan.actions[2].step_id,'nested-branch-expanded');assert.equal(plan.actions[2].locator.selector,'#inner'); // Preserve caller selectors and requested evidence.
 assert.throws(()=>reaScenario('javascript:alert(1)','/fixture/chromium','#outer','#inner')); // Reject executable navigation schemes.
}); // End scenario contract regression.
import {artifact} from './dom-evidence.ts'; // Build a typed synthetic envelope for the session import boundary.
test('DOM import enforces conversation, side and step before retention',()=>{ // Prevent a valid capture from being filed under an unrelated job.
 const folder=mkdtempSync(join(tmpdir(),'rsi-dom-import-')),job=join(folder,'job'),input=join(folder,'capture.json'); // Isolate the integration fixture.
 try{newChat(url,job);const evidence={schema:'emblem.dom-evidence/1',identity:{conversationId:normalizeChatUrl(url).id,side:'reference',stepId:'initial'},viewport:{width:390,height:844},artifacts:{dom:artifact([{tag:'div'}]),links:artifact([]),images:artifact([]),accessibility:artifact('fixture')}};writeFileSync(input,JSON.stringify(evidence));assert.throws(()=>importEvidence(job,'candidate','initial',input),/does not match/);importEvidence(job,'reference','initial',input);assert.equal(sessionStatus(job).evidenceFiles,1);}finally{rmSync(folder,{recursive:true,force:true});} // Accept only the matching ownership association without claiming source authentication.
}); // End session integration regression.
