/**
 * Export census for src/domain/{ids,validate,branches}.ts: every exported function (and zod schema) must have a
 * NEGATIVE case in the table below, executed here. Adding an export without adding a negative case fails the census,
 * so "every public function has a negative test" is enforced mechanically instead of by review.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
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

describe('no export ever throws anything but a GcrError, whatever junk it is handed (fixed seed)', () => {
  const SEED = 20261018;
  const good: MessageRecord[] = [msg({ id: 'a', conversationId: 'c', childIds: ['b'] }), msg({ id: 'b', conversationId: 'c', parentId: 'a' })];
  const goodAnalysis = branches.analyzeTree('c', good, 'b');
  const junk = fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true, withTypedArray: true, withSparseArray: true, withObjectString: true });
  const junkOptions = fc.oneof(junk, fc.record({ maxBranches: junk, maxTotalPathNodes: junk }, { requiredKeys: [] }), fc.record({ includeHidden: junk, includeStructural: junk }, { requiredKeys: [] }));

  /** Every exported function, each slot filled with junk in turn while the other arguments stay valid. */
  const CALLS: Record<string, (a: unknown, b: unknown, c: unknown, d: unknown) => unknown> = {
    'ids.isUuid': (a) => ids.isUuid(a as string),
    'ids.normalizeUuid': (a) => ids.normalizeUuid(a as string),
    'ids.parseChatGptUrl': (a) => ids.parseChatGptUrl(a as string),
    'ids.parseConversationRef': (a) => ids.parseConversationRef(a as string),
    'validate.unixSecondsToIso': (a) => validate.unixSecondsToIso(a),
    'validate.isIso8601Utc': (a) => validate.isIso8601Utc(a as string),
    'validate.parseIsoUtcToEpochMs': (a) => validate.parseIsoUtcToEpochMs(a),
    'validate.validateConversationRecord': (a) => validate.validateConversationRecord(a),
    'branches.analyzeTree(conversationId, messages, currentNodeId, opts) junk everywhere': (a, b, c, d) => branches.analyzeTree(a as string, b as MessageRecord[], c as string, d as never),
    'branches.analyzeTree junk opts': (_a, _b, _c, d) => branches.analyzeTree('c', good, 'b', d as never),
    'branches.threadForBranch junk analysis': (a, _b, c, d) => branches.threadForBranch(a as TreeAnalysis, good, c as string, d as never),
    'branches.threadForBranch junk messages': (_a, b, _c, d) => branches.threadForBranch(goodAnalysis, b as MessageRecord[], 'b', d as never),
    'branches.threadForBranch junk branch id and opts': (_a, _b, c, d) => branches.threadForBranch(goodAnalysis, good, c as string, d as never),
    'branches.selectBranchByPolicy junk analysis (last_child)': (a) => branches.selectBranchByPolicy(a as TreeAnalysis, good, 'last_child'),
    'branches.selectBranchByPolicy junk analysis (latest_leaf)': (a) => branches.selectBranchByPolicy(a as TreeAnalysis, good, 'latest_leaf'),
    'branches.selectBranchByPolicy junk messages and policy': (_a, b, c) => branches.selectBranchByPolicy(goodAnalysis, b as MessageRecord[], c as never),
  };

  it('the table covers every exported function (so a new export cannot dodge the fuzz)', () => {
    const covered = new Set(Object.keys(CALLS).map((k) => k.split(/[ (]/)[0] as string));
    for (const [name, mod] of [['ids', ids], ['validate', validate], ['branches', branches]] as const) {
      for (const fn of functionExports(mod)) assert.ok(covered.has(`${name}.${fn}`), `${name}.${fn} is not fuzzed`);
    }
  });

  for (const [label, call] of Object.entries(CALLS)) {
    it(`${label}: only results or GcrErrors`, () => {
      try {
        fc.assert(
          fc.property(junk, junk, junk, junkOptions, (a, b, c, d) => {
            try {
              call(a, b, c, d);
            } catch (e) {
              assert.ok(e instanceof GcrError, `non-GcrError escaped: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
            }
          }),
          { seed: SEED, numRuns: 1000 },
        );
      } catch (e) {
        throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    });
  }
});
