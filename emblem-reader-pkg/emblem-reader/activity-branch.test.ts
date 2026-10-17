import {test} from 'node:test'; // Exercise source text and disclosure structure without claiming browser execution.
import assert from 'node:assert/strict'; // Reject altered source text and misleading diagnostics.
import {activityContent} from './import-tool-events.ts'; // Test the same renderer shipped in both reader modes.
const presentation={intro:'Exact intro <tag> & text',label:'Prepared and validated image comparison plates and archive bundle',steps:['Preparing side-by-side original and rendered image plates','Creating property comparison plates and archive bundle','Analyzed image','Validating Zip Archive and Image Pairs']}; // Use the four user-visible step labels from the supplied screenshot.
test('public branch preserves wording, nesting and collapsed default',()=>{ // Guard against flattening back into a monospace log.
 const markup=activityContent({activityPresentation:presentation,toolEvents:[]}); // Render the public disclosure with no fabricated calls.
 assert.ok(markup.includes('Exact intro &lt;tag&gt; &amp; text')); // Escape text without executing it.
 assert.ok(markup.includes('<details class="activity-branch"><summary>')); // Use a browser-native nested control.
 assert.ok(!markup.includes(' open'));assert.ok(!markup.includes('<pre')); // Start collapsed and use normal prose typography.
 assert.ok(!markup.includes('public activity records'));assert.ok(!markup.includes('Source:')); // Exclude audit metadata from the conversation view.
 for(const step of presentation.steps)assert.equal(markup.split(step).length-1,1); // Preserve each line once and in its source spelling.
 assert.ok(markup.indexOf(presentation.steps[0])<markup.indexOf(presentation.steps[3])); // Preserve source sequence.
}); // End source-text regression.
test('duration is not repeated inside the activity content',()=>{ // Preserve the source hierarchy.
 const markup=activityContent({durations:['Worked for 4m 16s'],activityObservations:[{text:'Worked for 4m 16s\n\nPublic progress'}]}); // Model an existing capture with its duration prefix.
 assert.equal(markup,'<p class="activity-intro">Public progress</p>'); // Keep the duration only on the outer summary.
}); // End duration regression.
