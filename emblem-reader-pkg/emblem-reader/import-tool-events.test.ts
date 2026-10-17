import { test } from 'node:test'; // Verify source preservation and unsafe payload handling.
import assert from 'node:assert/strict'; // Fail incomplete or altered imports.
import { importToolEvents } from './import-tool-events.ts'; // Exercise the shipped SDK.
const data={conversations:{mountain:{url:'https://chatgpt.com/c/test',turns:[{id:'a',prompt:'p',hasAssistant:true,sourceAssistantHtml:'<p>original</p>',toolEvents:[],activityObservations:[]}]},street:{url:'https://chatgpt.com/c/test2',turns:[{id:'b',prompt:'q',hasAssistant:true,toolEvents:[],activityObservations:[]}]}},contentCoverage:{totals:{}}}; // Synthetic fixtures are not actual chat evidence.
const fixture='<html><body>'+['a','b'].map(id=>`<article class="turn" data-turn-id="${id}"><section class="user-message">prompt</section><section class="assistant-message">reply</section></article>`).join('')+'<script id="chat-data" type="application/json">'+JSON.stringify(data)+'</script><script>function activityContent(t){return "old";}\nfunction capturedHtml(t){return "source";}</script></body></html>'; // Include both static turns and runtime renderer boundaries.
const event:any={observationId:'fixture-1',turnId:'a',conversation:'mountain',ordinal:0,callId:null,toolName:'fixture-tool',input:'line 1\n  line 2 </script><script>alert(1)</script>',output:'  exact output\n',error:null,status:'complete',source:{kind:'provided-log',reference:'unit-fixture.jsonl',observedAt:'2026-10-16T15:33:41Z'},visibility:'public',inputComplete:true,outputComplete:true}; // Malicious-looking strings remain inert captured text.
test('exact payloads survive JSON and static rendering across both conversations',()=>{ // Verify import without claiming a real tool execution.
 const r=importToolEvents(fixture,[event],'unit-fixture.jsonl','a'.repeat(64)); // Supply fixture provenance.
 const j=JSON.parse(r.html.match(/<script id="chat-data" type="application\/json">([\s\S]*?)<\/script>/)![1]); // Decode the resulting source data.
 assert.equal(j.conversations.mountain.turns[0].toolEvents[0].input,event.input);assert.equal(j.conversations.mountain.turns[0].toolEvents[0].output,event.output); // Preserve whitespace and payload bytes.
 assert.equal(j.conversations.mountain.turns[0].sourceAssistantHtml,'<p>original</p>');assert.equal(r.inventory.length,2); // Preserve reply source and all-turn coverage.
 assert.ok(r.html.includes('&lt;/script&gt;'));assert.equal((r.html.match(/<details class="activity">/g)||[]).length,1); // Escape executable-looking text in native panels.
 assert.equal(j.contentCoverage.toolInventoryVerified,false);assert.equal(j.contentCoverage.totals.completeToolPayloads,1); // One complete call is not a complete source inventory.
 assert.throws(()=>importToolEvents(r.html,[event],'fixture','a'.repeat(64)),/duplicate/); // Duplicate observations cannot inflate completeness.
}); // End round-trip and duplicate regression.
test('unknown ownership, missing output and nonpublic records cannot be promoted',()=>{ // Guard completeness against fabricated associations.
 assert.throws(()=>importToolEvents(fixture,[{...event,turnId:'unknown'}],'fixture','a'.repeat(64)),/unknown/); // Reject guessed turn IDs.
 assert.throws(()=>importToolEvents(fixture,[{...event,output:null}],'fixture','a'.repeat(64)),/complete/); // A complete title without output is invalid.
 assert.throws(()=>importToolEvents(fixture,[{...event,visibility:'private'}],'fixture','a'.repeat(64)),/user-visible/); // Accept only provided or public records.
 const r=importToolEvents(fixture,[{...event,status:'partial',output:null,outputComplete:false}],'fixture','a'.repeat(64)); // Partial source data may be retained honestly.
 assert.equal(r.inventory[0].completePayloads,0); // Partial evidence must not count as complete.
}); // End malformed and partial-source regressions.
