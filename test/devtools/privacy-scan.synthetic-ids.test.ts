/**
 * The conversation-URL rule accepts a synthetic id by SHAPE. Besides the all-zero first group, any first group is accepted when the
 * remaining groups are the fixed synthetic tail (-0000-4000-8000-0000000000XX), which a random UUIDv4 matches with probability ~2^-82.
 * Anything else with a chatgpt.com/c/ link is still flagged. (The ids below are invented; the "real-looking" ones are random hex.)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanContent } from '../../src/devtools/privacy-scan.js';

const findings = (id: string) => scanContent('docs/note.md', `see https://chatgpt.com/c/${id} for details`).filter((f) => f.rule === 'chatgpt-conversation-url');

describe('synthetic conversation-id shapes', () => {
  for (const ok of [
    '00000000-0000-4000-8000-000000000001', // repo convention
    '00000000-0000-0000-0000-000000000000', // nil
    'f00dfeed-0000-4000-8000-0000000000aa', // any first group + synthetic tail
    'DEADBEEF-0000-4000-8000-0000000000FF', // case-insensitive
    '12345678-0000-4000-8000-000000000000',
  ]) {
    it(`accepts ${ok}`, () => assert.deepEqual(findings(ok), []));
  }

  for (const bad of [
    '3f6c1a52-9b7e-4c1d-8a2f-5d0e7b9a4c13', // ordinary random-looking v4
    'f00dfeed-0001-4000-8000-0000000000aa', // group2 not zero
    'f00dfeed-0000-4001-8000-0000000000aa', // group3 not 4000
    'f00dfeed-0000-4000-8001-0000000000aa', // group4 not 8000
    'f00dfeed-0000-4000-8000-000000000abc', // only nine leading zeros in the last group
    'f00dfeed-0000-4000-8000-00000000abcd',
    '6ac95b6f-9fa0-83e8-bbb0-8107079a8720', // one hex digit off the SPEC reference id
  ]) {
    it(`still flags ${bad}`, () => {
      const f = findings(bad);
      assert.equal(f.length, 1);
      assert.equal(f[0]?.rule, 'chatgpt-conversation-url');
      // masked: the full id never appears in the finding text
      assert.ok(!f[0]?.detail.includes(bad), 'finding detail must be masked');
    });
  }

  it('the SPEC reference id is accepted, nothing else near it', () => {
    assert.deepEqual(findings('6ac95b6e-9fa0-83e8-bbb0-8107079a8720'), []);
  });
});
