import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importActivities } from './import-activity.ts';

const data = { conversations: { test: { turns: [{ id: 'turn', durations: ['Worked for 1s'], hasAssistant: false, sourceAssistantHtml: '', toolEvents: [], activityObservations: [] }] } }, contentCoverage: { totals: { activitySummaries: 0, capturedReplies: 0, toolEvents: 0 } } };
const source = '<article data-turn-id="turn"><details class="activity"><summary>Worked for 1s</summary></details></article><th>Recovered activity panels</th><td>0</td><script id="chat-data" type="application/json">' + JSON.stringify(data) + '</script>';
const observation = { conversation: 'test', sourceTurnId: 'turn', observationId: 'one', kind: 'activity-summary', sourceUrl: 'https://chatgpt.com/c/test', observedAt: '2026-10-16T14:00:00Z', toolPayloadsExposed: false, text: 'Worked for 1s\n\nA </script> & B' };
const parse = (s: string) => JSON.parse(s.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]);
test('Preserves exact text in JSON, escapes native HTML, and never promotes progress to replies or tool records', () => {
  const result = importActivities(source, [observation]); const d = parse(result);
  assert.equal(d.conversations.test.turns[0].activityObservations[0].text, observation.text);
  assert.equal(d.conversations.test.turns[0].hasAssistant, false);
  assert.equal(d.contentCoverage.totals.capturedReplies, 0);
  assert.equal(d.contentCoverage.totals.toolEvents, 0);
  assert.equal(d.contentCoverage.totals.activitySummaries, 1);
  assert.match(result, /A &lt;\/script&gt; &amp; B/);
  assert.match(result, /panels<\/th><td>1<\/td>/);
});
test('Rejects duplicate observations rather than inflating coverage', () => assert.throws(() => importActivities(importActivities(source, [observation]), [observation]), /duplicate/));
test('Rejects unknown ownership', () => assert.throws(() => importActivities(source, [{ ...observation, sourceTurnId: 'missing' }]), /Unknown/));
test('Rejects alleged raw payloads in the summary importer', () => assert.throws(() => importActivities(source, [{ ...observation, toolPayloadsExposed: true }]), /Invalid/));
test('Rejects non-public source locations', () => assert.throws(() => importActivities(source, [{ ...observation, sourceUrl: 'file:///secret' }]), /source chat URL/));
