/**
 * Export census for src/domain/{ids,validate,branches}.ts: every exported function (and zod schema) must have a
 * NEGATIVE case in the table below, executed here. Adding an export without adding a negative case fails the census,
 * so "every public function has a negative test" is enforced mechanically instead of by review.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import * as ids from '../../src/domain/ids.js';
import * as validate from '../../src/domain/validate.js';
import * as branches from '../../src/domain/branches.js';
import type { MessageRecord, TreeAnalysis } from '../../src/domain/types.js';
import { convo, msg } from '../helpers/records.js';

function throwsGcr(fn: () => unknown, code?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    if (code !== undefined) assert.equal(e.code, code);
    return true;
  });
}

const msgs: MessageRecord[] = [msg({ id: 'a', conversationId: 'c' }), msg({ id: 'b', conversationId: 'c', parentId: 'a' })];
const analysis: TreeAnalysis = branches.analyzeTree('c', msgs, null);

type Negatives = Record<string, () => void>;

const NEGATIVE: Record<string, Negatives> = {
  ids: {
    isUuid: () => assert.equal(ids.isUuid('not-a-uuid'), false),
    normalizeUuid: () => throwsGcr(() => ids.normalizeUuid('not-a-uuid'), 'INVALID_UUID'),
    parseChatGptUrl: () => throwsGcr(() => ids.parseChatGptUrl('https://chatgpt.com/share/6ac95b6e-9fa0-83e8-bbb0-8107079a8720'), 'UNSUPPORTED_URL'),
    parseConversationRef: () => throwsGcr(() => ids.parseConversationRef('nope'), 'INVALID_UUID'),
  },
  validate: {
    unixSecondsToIso: () => assert.deepEqual(validate.unixSecondsToIso('1700000000'), { iso: null, reason: 'not_number' }),
    isIso8601Utc: () => assert.equal(validate.isIso8601Utc('2025-02-30T00:00:00Z'), false),
    parseIsoUtcToEpochMs: () => assert.equal(validate.parseIsoUtcToEpochMs('yesterday'), null),
    validateConversationRecord: () => throwsGcr(() => validate.validateConversationRecord({}), 'IMPORT_PARSE_ERROR'),
  },
  branches: {
    analyzeTree: () => throwsGcr(() => branches.analyzeTree('c', msgs, null, { maxBranches: 0 }), 'INVALID_ARGUMENT'),
    threadForBranch: () => throwsGcr(() => branches.threadForBranch(analysis, msgs, 'no-such-branch'), 'BRANCH_NOT_FOUND'),
    selectBranchByPolicy: () => throwsGcr(() => branches.selectBranchByPolicy(analysis, msgs, 'bogus' as never), 'INVALID_ARGUMENT'),
  },
};

const SCHEMA_NEGATIVE: Record<string, () => void> = {
  attachmentRefSchema: () => assert.equal(validate.attachmentRefSchema.safeParse({ id: 1 }).success, false),
  contentBlockSchema: () => assert.equal(validate.contentBlockSchema.safeParse({ type: '' }).success, false),
  messageRecordSchema: () => assert.equal(validate.messageRecordSchema.safeParse({ ...msgs[0], ordinal: -1 }).success, false),
  conversationRecordSchema: () => assert.equal(validate.conversationRecordSchema.safeParse({ ...convo('c', msgs), provider: 'bing' }).success, false),
};

function functionExports(mod: object): string[] {
  return Object.entries(mod)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
}

describe('every exported function has an executed negative case', () => {
  const modules: Array<[string, object]> = [
    ['ids', ids],
    ['validate', validate],
    ['branches', branches],
  ];
  for (const [name, mod] of modules) {
    it(`${name}: the census matches the exports exactly`, () => {
      assert.deepEqual(functionExports(mod), Object.keys(NEGATIVE[name] as Negatives).sort());
    });
    for (const [fn, negative] of Object.entries(NEGATIVE[name] as Negatives)) {
      it(`${name}.${fn} rejects bad input`, negative);
    }
  }

  it('validate: every exported zod schema has a rejecting case, and the census of schema exports is exact', () => {
    const schemas = Object.entries(validate)
      .filter(([, v]) => typeof v === 'object' && v !== null && 'safeParse' in v)
      .map(([k]) => k)
      .sort();
    assert.deepEqual(schemas, Object.keys(SCHEMA_NEGATIVE).sort());
    for (const negative of Object.values(SCHEMA_NEGATIVE)) negative();
  });

  it('exported constants keep their documented values', () => {
    assert.equal(ids.MAX_URL_LENGTH, 2048);
    assert.equal(validate.MAX_ID_LENGTH, 512);
    assert.equal(validate.MAX_TEXT_BYTES, 64 * 1024 * 1024);
    assert.equal(validate.UNIX_SECONDS_MIN, Date.UTC(2015, 0, 1) / 1000);
    assert.equal(validate.UNIX_SECONDS_MAX, Date.UTC(2100, 0, 1) / 1000);
    assert.equal(branches.DEFAULT_MAX_BRANCHES, 10_000);
    assert.equal(branches.DEFAULT_MAX_TOTAL_PATH_NODES, 5_000_000);
  });
});
