import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { importActivities } from './import-activity.ts';

// Rebuild the reader and its exact embedded side-by-side candidate together.
const root = new URL('../', import.meta.url);
const archive = new URL('review/EMBLEM_Chat_Archive.html', root);
const comparison = new URL('review/EMBLEM_Chat_GUI_Comparison.html', root);
const before = readFileSync(archive, 'utf8');
const observations = JSON.parse(readFileSync(new URL('evidence/content-coverage/recovered-activities.json', root), 'utf8'));
let after = importActivities(before, observations).replace('data-reader-revision="8"', 'data-reader-revision="9"');
const note = 'Source rechecked October 16: newer Street View turns exist outside this snapshot. Three original turns still have no captured final reply; recovered progress text is shown separately. This is not a complete current chat export.';
after = after.replace('<summary>Archive contents · incomplete source coverage</summary>', '<summary>Archive contents · incomplete source coverage</summary><p class="coverage-note">' + note + '</p>');
const tag = /(<script\b[^>]*\bid="chat-data"[^>]*>)([\s\S]*?)(<\/script>)/;
const original = JSON.parse(before.match(tag)![2]);
const updated = JSON.parse(after.match(tag)![2]);
updated.contentCoverage.version = '0.3.1';
updated.contentCoverage.limitations.push(note);
after = after.replace(tag, (_m, a, _b, c) => a + JSON.stringify(updated).replaceAll('<', '\\u003c') + c);
// Check every pre-existing field except the deliberately added observations.
for (const [key, chat] of Object.entries(original.conversations) as any) for (const old of chat.turns) {
  const next = updated.conversations[key].turns.find((t: any) => t.id === old.id);
  for (const [field, value] of Object.entries(old)) if (field !== 'activityObservations' && JSON.stringify(value) !== JSON.stringify(next[field])) throw new Error('Unexpected mutation: ' + old.id + ' ' + field);
}
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
const sha = createHash('sha256').update(after).digest('hex');
let review = readFileSync(comparison, 'utf8');
if ((review.match(/srcdoc="/g) || []).length !== 1) throw new Error('Expected one exact candidate iframe');
review = review.replace(/srcdoc="[^"]*"/, () => 'srcdoc="' + esc(after) + '"');
review = review.replace(/Candidate SHA-256 <code>[a-f0-9]{64}<\/code>/, 'Candidate SHA-256 <code>' + sha + '</code>');
review = review.replace(/Built [^<]* · Candidate/, 'Built ' + new Date().toISOString() + ' · Candidate');
writeFileSync(archive, after); writeFileSync(comparison, review);
writeFileSync(new URL('evidence/content-coverage/recovery-integrity.json', root), JSON.stringify({ readerRevision: 9, packageVersion: '0.3.1', allOriginalTurnFieldsPreserved: true, activitySummaries: 3, detailedToolRecords: 0, exactCandidateSha256: sha, sourceCompleteness: false, browserRenderingVerified: false }, null, 2));
console.log(JSON.stringify({ sha, archive: archive.pathname, comparison: comparison.pathname }));
