/**
 * SPEC-06 regression tests (low): messages stored in an unreachable cycle (no root) are searchable but cannot be read through
 * get / thread, and the NO_BRANCHES warning wrongly said the stored tree was "empty".
 *
 * Reproduction (before the fix): import fixtures/chatgpt/broken-trees.json, `get 00000000-0000-4000-8000-000000000030` (F07
 * "cycle with no root", two messages) -> NO_BRANCHES "The stored message tree of this snapshot is empty: there is no thread to
 * show." while `search cycle` finds both messages.
 *
 * Fixed: when messages are stored but no root reaches any of them the warning says so and gives the count; the true-empty
 * snapshot keeps the original text. `thread()` (BRANCH_NOT_FOUND / no_branches) is worded the same way. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, OMIT } from '../helpers/chatgpt-export-builder.js';
import { ID, expectGcr, fixedClock, importBuilders, makeTempDir, removeDir, thrown, title } from './sdk.helpers.test.js';

const CYCLE_ID = '00000000-0000-4000-8000-000000000030';
const FIXTURE = new URL('../../../fixtures/chatgpt/broken-trees.json', import.meta.url).pathname;

let dir = '';
let gcr: Gcr;

before(async () => {
  dir = await makeTempDir();
  gcr = Gcr.open({ dbPath: join(dir, 'bt.sqlite'), clock: fixedClock });
  await gcr.importExport({ source: { kind: 'path', path: FIXTURE } });
});

after(async () => {
  gcr.close();
  await removeDir(dir);
});

describe('SPEC-06: NO_BRANCHES for messages that no root reaches', () => {
  it('says that N messages are stored but none is reachable from a root, not that the tree is empty', () => {
    const env = gcr.get(CYCLE_ID);
    assert.equal(env.data.thread, null);
    assert.equal(env.data.conversation.messageCount, 2);
    const w = env.warnings.find((x) => x.code === 'NO_BRANCHES');
    assert.ok(w !== undefined, 'NO_BRANCHES is still reported');
    assert.match(w.message, /\b2 message\(s\) are stored\b/);
    assert.match(w.message, /none of them is reachable from a root/);
    assert.match(w.message, /found with search/);
    assert.doesNotMatch(w.message, /\bempty\b/i, 'the tree is not empty, the nodes are unreachable');
    assert.deepEqual(w.ids, [CYCLE_ID]);
  });

  it('the messages really are findable by search (the claim in the warning)', () => {
    const hits = gcr.search({ query: 'cycle', conversationId: CYCLE_ID });
    assert.deepEqual(hits.data.items.map((h) => h.messageId).sort(), ['cyc-a', 'cyc-b']);
  });

  it('thread() fails with BRANCH_NOT_FOUND / no_branches and the same distinction', () => {
    const e = expectGcr(thrown(() => gcr.thread(CYCLE_ID)), 'BRANCH_NOT_FOUND');
    assert.equal(e.details?.['reason'], 'no_branches');
    assert.equal(e.details?.['unreachableMessages'], 2);
    assert.match(e.message, /2 message\(s\) are stored but none is reachable from a root/);
    assert.doesNotMatch(e.message, /\bempty\b/i);
  });

  it('a snapshot with no message at all keeps the true-empty wording', async () => {
    const empty = new ConversationBuilder({ id: ID.empty, title: title('nothing here') });
    empty.setCurrent(OMIT);
    await importBuilders(gcr, dir, [empty]);
    const env = gcr.get(ID.empty);
    const w = env.warnings.find((x) => x.code === 'NO_BRANCHES');
    assert.ok(w !== undefined);
    assert.equal(w.message, 'The stored message tree of this snapshot is empty: there is no thread to show.');
    const e = expectGcr(thrown(() => gcr.thread(ID.empty)), 'BRANCH_NOT_FOUND');
    assert.match(e.message, /stored message tree is empty/);
    assert.equal(e.details?.['unreachableMessages'], undefined);
  });
});
