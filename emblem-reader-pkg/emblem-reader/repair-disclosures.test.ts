import {test} from 'node:test'; // Exercise empty dropdown handling rather than claiming browser validation.
import assert from 'node:assert/strict'; // Fail any loss of real activity content.
import {repairDisclosures} from './repair-disclosures.ts'; // Use the shipped repair.
import {importActivities} from './import-activity.ts'; // Check subsequent source recovery remains possible.
test('an empty later panel cannot consume an earlier populated panel',()=>{ // Reproduce the cross-panel regex corruption reported on iPhone.
 const populated='<details class="activity"><summary>Worked for 11m 17s</summary><div class="activity-captured"><p>Keep inside dropdown</p></div></details>'; // Earlier real content must remain collapsible.
 const empty='<details class="activity"><summary>Worked for 38s</summary><div class="activity-captured"></div></details>'; // Only this later empty panel may change.
 const result=repairDisclosures('<html><head></head><body>'+populated+empty+'</body></html>');assert.ok(result.html.includes(populated));assert.equal(result.emptyPanelsRemoved,1); // Prevent a match spanning multiple summary elements.
}); // End cross-panel regression.
test('empty duration becomes plain text while a populated nested branch survives',()=>{ // Guard the false dropdown defect.
 const input='<html><head></head><body><details class="activity"><summary>Worked for 38s</summary><div class="activity-captured"></div></details><details class="activity"><summary>Worked for 4m 16s</summary><div class="activity-captured"><details class="activity-branch"><summary>Real branch</summary><p>Retained step</p></details></div></details></body></html>'; // Synthetic UI fixture, not captured source evidence.
 const result=repairDisclosures(input);assert.equal(result.emptyPanelsRemoved,1);assert.match(result.html,/<div class="static-activity">Worked for 38s<\/div>/);assert.match(result.html,/<summary>Real branch<\/summary><p>Retained step<\/p>/);assert.equal(repairDisclosures(result.html).html,result.html); // Verify content preservation and repeatability.
}); // End empty disclosure regression.
test('later activity import upgrades a plain duration in place',()=>{ // Prevent the repair from blocking future recovery.
 const data={conversations:{mountain:{turns:[{id:'x',durations:['Worked for 38s'],activityObservations:[]}]}},contentCoverage:{totals:{}}}; // Define explicit ownership.
 const input='<article data-turn-id="x"><div class="static-activity">Worked for 38s</div><p>Reply unchanged</p></article><script id="chat-data" type="application/json">'+JSON.stringify(data)+'</script>'; // Include a saved response after the gap.
 const o={kind:'activity-summary',observationId:'synthetic',conversation:'mountain',sourceTurnId:'x',sourceUrl:'https://chatgpt.com/c/test',observedAt:'2026-10-16T17:00:00Z',text:'Captured update',toolPayloadsExposed:false}; // This fixture is never inserted into the production readers.
 const result=importActivities(input,[o]);assert.match(result,/<details class="activity">/);assert.match(result,/<p>Reply unchanged<\/p>/);assert.doesNotMatch(result,/<div class="static-activity">/); // Verify a real captured update can replace the plain label.
}); // End import upgrade regression.
