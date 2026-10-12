/**
 * Independent verification of TQ-03 at the command line: a bare conversation UUID is trimmed of ASCII whitespace ONLY.
 *
 * The domain, SDK-resolver and facade tests pin this inside the library. The CLI validates its reference once more (and, with
 * --provider / --account, turns it into an object reference itself), so a `raw.trim()` there would accept an id padded with
 * NBSP, a byte order mark or an em space without any library test noticing. Synthetic ids only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ID, assertJsonError, assertOk, envelope, gcr, obj, tempDir, templateDb } from './cli.helpers.test.js';

// Written as escapes: the CLI hygiene scan (cli.process.test.ts) refuses raw invisible characters in test/cli/*.ts.
const PADDINGS: ReadonlyArray<readonly [string, string]> = [
  ['no-break space U+00A0', '\u00a0'],
  ['byte order mark U+FEFF', '\ufeff'],
  ['em space U+2003', '\u2003'],
];

describe('a bare UUID padded with non-ASCII whitespace is refused by the CLI (INVALID_UUID, exit 2), with and without a scope', () => {
  for (const [label, ch] of PADDINGS) {
    it(`${label}: get / thread / branches, plain and with --provider chatgpt`, async () => {
      const cwd = tempDir();
      for (const command of ['get', 'thread', 'branches']) {
        for (const padded of [`${ch}${ID.linear}`, `${ID.linear}${ch}`, `${ch}${ID.linear}${ch}`]) {
          for (const scope of [[], ['--provider', 'chatgpt'], ['--account', 'default']]) {
            const r = await gcr([command, padded, ...scope, '--format', 'json'], { cwd });
            assertJsonError(r, 'INVALID_UUID');
          }
        }
      }
    });
  }

  it('control: the same id padded with ASCII whitespace resolves the conversation, with and without --provider', async () => {
    const { dbPath } = await templateDb();
    for (const scope of [[], ['--provider', 'chatgpt']]) {
      const r = await gcr(['get', ` \t${ID.linear.toUpperCase()}\n`, ...scope, '--db', dbPath, '--format', 'json']);
      assertOk(r);
      const data = envelope(r.stdout).data;
      assert.equal(obj(data['conversation'])['conversationId'], ID.linear);
    }
  });
});
