/**
 * src/sdk/envelope.ts: how source, completeness, warnings, ids and untrustedContent are derived (SPEC FR-09).
 * Pure unit tests; the lookup function stands in for the database (the database path is covered by provenance.test.ts).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BatchInfo } from '../../src/domain/results.js';
import type { Completeness } from '../../src/domain/types.js';
import {
  COMPLETENESS_ORDER,
  SOURCE_NOT_FULL_HISTORY,
  basenameLabel,
  buildEnvelope,
  buildProvenance,
  completenessRank,
  mergeWarnings,
  normalizeCompleteness,
  notFullHistoryWarning,
  overallCompleteness,
  toSourceSummary,
  uniq,
  warningsCarryIds,
  weakestCompleteness,
} from '../../src/sdk/envelope.js';

function batch(over: Partial<BatchInfo> = {}): BatchInfo {
  return {
    provider: 'chatgpt',
    accountLabel: 'default',
    provenance: 'official_chatgpt_export',
    completeness: 'exported_tree',
    batchId: 'b_one',
    sourceLabel: 'export.zip',
    importedAt: '2026-02-03T04:05:06.007Z',
    toolVersion: '0.2.0-dev.0',
    seq: 1,
    sourceKind: 'zip',
    inputSha256: '0'.repeat(64),
    schemaVersion: 1,
    conversationCount: 1,
    messageCount: 2,
    warnings: [],
    ...over,
  };
}

function lookupOf(...batches: BatchInfo[]): (id: string) => BatchInfo | null {
  const m = new Map(batches.map((b) => [b.batchId, b] as const));
  return (id) => m.get(id) ?? null;
}

describe('completeness ordering', () => {
  it('orders strongest to weakest: exported_tree > api_owned > rendered_active_view_only > partial_user_supplied > unknown', () => {
    assert.deepEqual([...COMPLETENESS_ORDER], ['exported_tree', 'api_owned_conversation', 'rendered_active_view_only', 'partial_user_supplied', 'unknown']);
    for (let i = 1; i < COMPLETENESS_ORDER.length; i++) {
      assert.ok(completenessRank(COMPLETENESS_ORDER[i] as Completeness) > completenessRank(COMPLETENESS_ORDER[i - 1] as Completeness));
    }
  });

  it('weakestCompleteness picks the weakest of any combination; null for an empty list', () => {
    assert.equal(weakestCompleteness([]), null);
    assert.equal(weakestCompleteness(['exported_tree']), 'exported_tree');
    assert.equal(weakestCompleteness(['exported_tree', 'rendered_active_view_only']), 'rendered_active_view_only');
    assert.equal(weakestCompleteness(['partial_user_supplied', 'rendered_active_view_only', 'exported_tree']), 'partial_user_supplied');
    assert.equal(weakestCompleteness(['api_owned_conversation', 'unknown', 'exported_tree']), 'unknown');
  });

  it('overallCompleteness: one value if all agree, "mixed" if they differ, "unknown" for nothing', () => {
    assert.equal(overallCompleteness([]), 'unknown');
    assert.equal(overallCompleteness(['exported_tree', 'exported_tree']), 'exported_tree');
    assert.equal(overallCompleteness(['partial_user_supplied']), 'partial_user_supplied');
    assert.equal(overallCompleteness(['exported_tree', 'partial_user_supplied']), 'mixed');
    assert.equal(overallCompleteness(['rendered_active_view_only', 'unknown']), 'mixed');
  });

  it('a stored value that is not a known completeness counts as "unknown", never as complete', () => {
    assert.equal(normalizeCompleteness('exported_tree'), 'exported_tree');
    assert.equal(normalizeCompleteness('definitely_complete'), 'unknown');
    assert.equal(normalizeCompleteness(''), 'unknown');
  });
});

describe('source summaries', () => {
  it('basenameLabel keeps only the last path segment, of either separator style, and drops control characters', () => {
    assert.equal(basenameLabel('export.zip'), 'export.zip');
    assert.equal(basenameLabel('/home/someone/private/export.zip'), 'export.zip');
    assert.equal(basenameLabel('C:\\Users\\someone\\export.zip'), 'export.zip');
    assert.equal(basenameLabel('/a/b/'), 'b');
    assert.equal(basenameLabel('ex\u0000po\u001brt.zip'), 'export.zip');
    assert.equal(basenameLabel('..'), null);
    assert.equal(basenameLabel('/'), null);
    assert.equal(basenameLabel(''), null);
    assert.equal(basenameLabel(null), null);
  });

  it('toSourceSummary exposes provenance fields only (no counts, hashes or warnings) and a basename label', () => {
    const s = toSourceSummary(batch({ sourceLabel: '/very/private/dir/export.zip', inputSha256: 'f'.repeat(64) }));
    assert.deepEqual(s, {
      provider: 'chatgpt',
      accountLabel: 'default',
      provenance: 'official_chatgpt_export',
      completeness: 'exported_tree',
      batchId: 'b_one',
      sourceLabel: 'export.zip',
      importedAt: '2026-02-03T04:05:06.007Z',
      toolVersion: '0.2.0-dev.0',
    });
    assert.ok(!JSON.stringify(s).includes('private'));
  });
});

describe('buildEnvelope: a complete exported tree', () => {
  it('has one source, completeness exported_tree and NO SOURCE_NOT_FULL_HISTORY warning', () => {
    const env = buildEnvelope(lookupOf(batch()), { data: { n: 1 }, contributions: [{ batchId: 'b_one', completeness: 'exported_tree' }] });
    assert.equal(env.ok, true);
    assert.deepEqual(env.data, { n: 1 });
    assert.equal(env.source.length, 1);
    assert.equal(env.completeness, 'exported_tree');
    assert.deepEqual(env.warnings, []);
    assert.deepEqual(env.ids, {});
    assert.equal(env.untrustedContent, true, 'imported text is untrusted by default');
  });

  it('many contributions from the same batch still yield exactly one source entry', () => {
    const env = buildEnvelope(lookupOf(batch()), {
      data: null,
      contributions: [
        { batchId: 'b_one', completeness: 'exported_tree' },
        { batchId: 'b_one', completeness: 'exported_tree' },
        { batchId: 'b_one', completeness: 'exported_tree' },
      ],
    });
    assert.equal(env.source.length, 1);
  });
});

describe('buildEnvelope: never present a partial source as full history (FR-09)', () => {
  const cases: Array<{ completeness: Completeness; says: RegExp }> = [
    { completeness: 'rendered_active_view_only', says: /active view/i },
    { completeness: 'partial_user_supplied', says: /manual copy/i },
    { completeness: 'api_owned_conversation', says: /developer API/i },
    { completeness: 'unknown', says: /does not establish/i },
  ];
  for (const c of cases) {
    it(`${c.completeness}: SOURCE_NOT_FULL_HISTORY is the FIRST warning and states what is missing`, () => {
      const env = buildEnvelope(lookupOf(batch({ completeness: c.completeness })), {
        data: 1,
        contributions: [{ batchId: 'b_one', completeness: c.completeness }],
        warnings: [{ code: 'SOMETHING_ELSE', message: 'other' }],
      });
      assert.equal(env.completeness, c.completeness);
      assert.equal(env.warnings[0]?.code, SOURCE_NOT_FULL_HISTORY);
      assert.match(env.warnings[0]?.message ?? '', /NOT the full conversation history/);
      assert.match(env.warnings[0]?.message ?? '', c.says);
      assert.deepEqual(env.warnings[0]?.ids, ['b_one'], 'the warning names the batch that is not complete');
      assert.equal(env.warnings[1]?.code, 'SOMETHING_ELSE');
    });
  }

  it('a conversation weaker than its batch row wins: the conversation column is authoritative, and the source agrees with the envelope', () => {
    const env = buildEnvelope(lookupOf(batch({ completeness: 'exported_tree' })), { data: 1, contributions: [{ batchId: 'b_one', completeness: 'unknown' }] });
    assert.equal(env.completeness, 'unknown');
    assert.equal(env.source[0]?.completeness, 'unknown', 'a source never contradicts the envelope that cites it');
    assert.equal(env.warnings[0]?.code, SOURCE_NOT_FULL_HISTORY);
  });

  it('a conversation can never be STRONGER than its batch row', () => {
    const env = buildEnvelope(lookupOf(batch({ completeness: 'partial_user_supplied' })), { data: 1, contributions: [{ batchId: 'b_one', completeness: 'exported_tree' }] });
    assert.equal(env.completeness, 'partial_user_supplied');
    assert.equal(env.source[0]?.completeness, 'partial_user_supplied');
    assert.equal(env.warnings[0]?.code, SOURCE_NOT_FULL_HISTORY);
  });

  it('one batch, conversations of different completeness: the envelope is "mixed", the source is the weakest of them', () => {
    const env = buildEnvelope(lookupOf(batch()), {
      data: 1,
      contributions: [
        { batchId: 'b_one', completeness: 'exported_tree' },
        { batchId: 'b_one', completeness: 'unknown' },
        { batchId: 'b_one', completeness: 'exported_tree' },
      ],
    });
    assert.equal(env.completeness, 'mixed');
    assert.equal(env.source.length, 1);
    assert.equal(env.source[0]?.completeness, 'unknown');
    assert.match(env.warnings[0]?.message ?? '', /weakest: unknown/);
    assert.deepEqual(env.warnings[0]?.ids, ['b_one']);
  });

  it('several sources of different completeness: "mixed", sorted by import order, warning names the weakest', () => {
    const a = batch({ batchId: 'b_a', seq: 2, completeness: 'exported_tree' });
    const b = batch({ batchId: 'b_b', seq: 1, completeness: 'partial_user_supplied', provenance: 'user_supplied_copy', sourceLabel: 'manual-copy' });
    const env = buildEnvelope(lookupOf(a, b), {
      data: 1,
      contributions: [
        { batchId: 'b_a', completeness: 'exported_tree' },
        { batchId: 'b_b', completeness: 'partial_user_supplied' },
      ],
    });
    assert.equal(env.completeness, 'mixed');
    assert.deepEqual(env.source.map((s) => s.batchId), ['b_b', 'b_a'], 'import order (seq)');
    const w = env.warnings[0];
    assert.equal(w?.code, SOURCE_NOT_FULL_HISTORY);
    assert.match(w?.message ?? '', /mixed/);
    assert.match(w?.message ?? '', /weakest: partial_user_supplied/);
    assert.deepEqual(w?.ids, ['b_b'], 'only the batch that is not a complete exported tree is named');
  });

  it('nothing contributed (an empty result): completeness "unknown" and a warning that an empty result proves nothing', () => {
    const env = buildEnvelope(lookupOf(), { data: [], contributions: [] });
    assert.equal(env.completeness, 'unknown');
    assert.deepEqual(env.source, []);
    assert.equal(env.warnings[0]?.code, SOURCE_NOT_FULL_HISTORY);
    assert.match(env.warnings[0]?.message ?? '', /No imported conversation contributed/);
    assert.match(env.warnings[0]?.message ?? '', /not proof/);
  });

  it('extraBatchIds list a batch as a source even when no conversation contributed (an empty export)', () => {
    const env = buildEnvelope(lookupOf(batch()), { data: 1, contributions: [], extraBatchIds: ['b_one'] });
    assert.equal(env.source.length, 1);
    assert.equal(env.completeness, 'exported_tree', 'the batch row alone decides');
    assert.deepEqual(env.warnings, []);
  });

  it('a contributing batch whose row cannot be read is reported and counts as unknown, never as complete', () => {
    const env = buildEnvelope(lookupOf(), { data: 1, contributions: [{ batchId: 'b_ghost', completeness: 'exported_tree' }] });
    assert.equal(env.completeness, 'unknown');
    assert.deepEqual(env.source, []);
    assert.deepEqual(env.warnings.map((w) => w.code), [SOURCE_NOT_FULL_HISTORY, 'SOURCE_BATCH_MISSING']);
    assert.deepEqual(env.warnings[1]?.ids, ['b_ghost']);
  });

  it('notFullHistoryWarning lists at most 20 batch ids', () => {
    const sources = Array.from({ length: 30 }, (_, i) => toSourceSummary(batch({ batchId: `b_${i}`, completeness: 'unknown' })));
    const w = notFullHistoryWarning('unknown', ['unknown'], sources);
    assert.equal(w.ids?.length, 20);
  });
});

describe('buildEnvelope: ids, warnings and flags', () => {
  it('ids are de-duplicated in first-occurrence order and empty lists are dropped', () => {
    const env = buildEnvelope(lookupOf(batch()), {
      data: 1,
      contributions: [{ batchId: 'b_one', completeness: 'exported_tree' }],
      ids: { conversationIds: ['c2', 'c1', 'c2'], messageIds: [], branchIds: ['x', 'x'], draftIds: undefined },
    });
    assert.deepEqual(env.ids, { conversationIds: ['c2', 'c1'], branchIds: ['x'] });
  });

  it('warnings are merged without duplicates (same code, message and ids) and keep first-occurrence order', () => {
    const w1 = { code: 'A', message: 'a', ids: ['1'] };
    const merged = mergeWarnings([w1, { code: 'B', message: 'b' }], [{ code: 'A', message: 'a', ids: ['1'] }, { code: 'A', message: 'a', ids: ['2'] }], undefined);
    assert.deepEqual(merged.map((w) => `${w.code}:${w.ids?.join(',') ?? ''}`), ['A:1', 'B:', 'A:2']);
    // a copy: mutating the result must not change the caller's warning
    merged[0]?.ids?.push('mutated');
    assert.deepEqual(w1.ids, ['1']);
  });

  it('untrustedContent defaults to true and can be turned off explicitly', () => {
    const lookup = lookupOf(batch());
    const c = [{ batchId: 'b_one', completeness: 'exported_tree' as const }];
    assert.equal(buildEnvelope(lookup, { data: 1, contributions: c }).untrustedContent, true);
    assert.equal(buildEnvelope(lookup, { data: 1, contributions: c, untrustedContent: false }).untrustedContent, false);
  });

  it('warningsCarryIds is true only when a warning cites ids', () => {
    assert.equal(warningsCarryIds([]), false);
    assert.equal(warningsCarryIds([{ code: 'A', message: 'a' }]), false);
    assert.equal(warningsCarryIds([{ code: 'A', message: 'a', ids: [] }]), false);
    assert.equal(warningsCarryIds([{ code: 'A', message: 'a', ids: ['x'] }]), true);
  });

  it('buildProvenance carries the same fields as an envelope, without data and ids', () => {
    const p = buildProvenance(lookupOf(batch({ completeness: 'partial_user_supplied' })), { contributions: [{ batchId: 'b_one', completeness: 'partial_user_supplied' }] });
    assert.deepEqual(Object.keys(p).sort(), ['completeness', 'source', 'untrustedContent', 'warnings']);
    assert.equal(p.completeness, 'partial_user_supplied');
    assert.equal(p.warnings[0]?.code, SOURCE_NOT_FULL_HISTORY);
  });

  it('uniq keeps first occurrences', () => {
    assert.deepEqual(uniq(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
  });

  it('is deterministic: the same parts build deep-equal envelopes', () => {
    const parts = {
      data: { x: 1 },
      contributions: [
        { batchId: 'b_one', completeness: 'exported_tree' as const },
        { batchId: 'b_two', completeness: 'unknown' as const },
      ],
      warnings: [{ code: 'W', message: 'w' }],
    };
    const lookup = lookupOf(batch(), batch({ batchId: 'b_two', seq: 2 }));
    assert.deepEqual(buildEnvelope(lookup, parts), buildEnvelope(lookup, parts));
  });
});
