/**
 * renderConversationList, renderSearchHits, renderBranchList, renderImportReport and renderEnvelope: golden output in all
 * four formats, pagination, snippet-marker translation, hidden hits, mixed completeness, generic data rendering, and the
 * FR-09 rule that provenance, completeness and warnings are present in EVERY format. All data synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BranchListResult, ConversationSummary, ImportReport, Page, SearchHit } from '../../src/domain/results.js';
import type { Branch, ResultEnvelope, SourceSummary } from '../../src/domain/types.js';
import type { ErrorEnvelope, Warning } from '../../src/errors.js';
import { GcrError } from '../../src/errors.js';
import { renderBranchList, renderConversationList, renderEnvelope, renderImportReport, renderSearchHits } from '../../src/format/render.js';
import { TOOL_VERSION } from '../../src/version.js';
import { iso } from '../helpers/records.js';

const FORMATS = ['json', 'markdown', 'compact', 'jsonl'] as const;

const SRC: SourceSummary = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  batchId: 'b_synthetic00000003',
  sourceLabel: 'synthetic-export.zip',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: 'import-tool-9.9.9',
};

function conv(id: string, title: string | null, minutes: number, count: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    provider: 'chatgpt',
    accountLabel: 'default',
    conversationId: id,
    title,
    createdAt: iso(0),
    updatedAt: iso(minutes),
    messageCount: count,
    currentNodeId: null,
    defaultModelSlug: null,
    provenance: 'official_chatgpt_export',
    completeness: 'exported_tree',
    batchId: 'b_synthetic00000003',
    importedAt: '2025-02-01T00:00:00.000Z',
    ...over,
  };
}

function parseLines(jsonl: string): Array<Record<string, unknown>> {
  assert.ok(jsonl.endsWith('\n') && !jsonl.endsWith('\n\n'));
  return jsonl
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      assert.ok(!line.includes('\n'));
      return JSON.parse(line) as Record<string, unknown>;
    });
}

const SOURCE_TABLE = `## Sources

| Provider | Account | Provenance | Completeness | Batch | Source file | Imported at | Imported with |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chatgpt | default | official_chatgpt_export | exported_tree | b_synthetic00000003 | synthetic-export.zip | 2025-02-01 00:00:00 UTC (UTC+00:00) | import-tool-9.9.9 |`;

const SOURCE_COMPACT = `# source: provenance=official_chatgpt_export | account=default | batch=b_synthetic00000003 | imported=2025-02-01 00:00:00 UTC (UTC+00:00) | tool=gcr ${TOOL_VERSION} | tz=UTC`;

// ---------------------------------------------------------------------------------------------------------------
describe('renderConversationList', () => {
  const page: Page<ConversationSummary> = {
    items: [conv('conv-a', 'First', 3, 3), conv('conv-b', null, 10, 7)],
    limit: 20,
    offset: 0,
    total: 2,
    nextOffset: null,
  };

  it('markdown golden', () => {
    const expected = `# Conversations

- Page: 2 item(s) at offset 0 (limit 20), 2 in total
- Next offset: none (end of results)
- Tool version: gcr ${TOOL_VERSION}
- Timezone: \`UTC\`

${SOURCE_TABLE}

## Conversations

| \\# | Title | Conversation ID | Provider/Account | Updated | Messages | Completeness |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | First | conv-a | chatgpt/default | 2025-01-01 00:03:00 UTC (UTC+00:00) | 3 | exported_tree |
| 2 | (untitled) | conv-b | chatgpt/default | 2025-01-01 00:10:00 UTC (UTC+00:00) | 7 | exported_tree |

## Warnings

None.
`;
    assert.equal(renderConversationList(page, [SRC], { format: 'markdown' }), expected);
  });

  it('compact golden', () => {
    const expected = `# conversations | chatgpt | exported_tree | offset=0 limit=20 total=2 next=none
${SOURCE_COMPACT}
[chatgpt] conv-a | First | updated 2025-01-01 00:03:00 UTC (UTC+00:00) | 3 msgs | exported_tree
[chatgpt] conv-b | (untitled) | updated 2025-01-01 00:10:00 UTC (UTC+00:00) | 7 msgs | exported_tree
`;
    assert.equal(renderConversationList(page, [SRC], { format: 'compact' }), expected);
  });

  it('json golden (parsed)', () => {
    const parsed = JSON.parse(renderConversationList(page, [SRC], { format: 'json' })) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      ok: true,
      data: {
        items: page.items,
        limit: 20,
        offset: 0,
        total: 2,
        nextOffset: null,
      },
      source: [SRC],
      completeness: 'exported_tree',
      warnings: [],
      ids: { conversationIds: ['conv-a', 'conv-b'] },
      untrustedContent: true,
      tool: { name: 'gcr', version: TOOL_VERSION },
    });
  });

  it('jsonl golden (parsed): header, one item line per conversation, footer', () => {
    const lines = parseLines(renderConversationList(page, [SRC], { format: 'jsonl' }));
    assert.equal(lines.length, 4);
    assert.deepEqual(lines[0], {
      type: 'header',
      ok: true,
      kind: 'conversation_list',
      source: [SRC],
      completeness: 'exported_tree',
      ids: { conversationIds: ['conv-a', 'conv-b'] },
      untrustedContent: true,
      tool: { name: 'gcr', version: TOOL_VERSION },
      limit: 20,
      offset: 0,
      total: 2,
      nextOffset: null,
      count: 2,
    });
    assert.deepEqual(lines[1], { type: 'item', ...page.items[0] });
    assert.deepEqual(lines[2], { type: 'item', ...page.items[1] });
    assert.deepEqual(lines[3], { type: 'footer', warnings: [] });
  });

  it('pagination: next offset, cursor and a later page number the rows from the offset', () => {
    const second: Page<ConversationSummary> = { items: [conv('conv-c', 'Third', 1, 1)], limit: 1, offset: 40, nextOffset: 41, nextCursor: 'cur`sor' };
    const md = renderConversationList(second, [SRC], { format: 'markdown' });
    assert.match(md, /^- Page: 1 item\(s\) at offset 40 \(limit 1\)$/m);
    assert.match(md, /^- Next offset: 41$/m);
    assert.match(md, /^- Next cursor: ``cur`sor``$/m);
    assert.match(md, /^\| 41 \| Third \|/m);
    assert.match(renderConversationList(second, [SRC], { format: 'compact' }), /offset=40 limit=1 next=41$/m);
  });

  it('shows times in the requested zone (markdown and compact), UTC ISO in machine formats', () => {
    const md = renderConversationList(page, [SRC], { format: 'markdown', tz: 'Asia/Kolkata' });
    assert.ok(md.includes('2025-01-01 05:33:00 Asia/Kolkata (UTC+05:30)'));
    assert.ok(renderConversationList(page, [SRC], { format: 'compact', tz: 'Asia/Kolkata' }).includes('updated 2025-01-01 05:33:00 Asia/Kolkata (UTC+05:30)'));
    const items = (JSON.parse(renderConversationList(page, [SRC], { format: 'json', tz: 'Asia/Kolkata' })) as { data: { items: ConversationSummary[] } }).data.items;
    assert.equal(items[0]?.updatedAt, '2025-01-01T00:03:00.000Z');
  });

  it('an empty page says so and keeps provenance/completeness', () => {
    const empty: Page<ConversationSummary> = { items: [], limit: 20, offset: 0, total: 0, nextOffset: null };
    const md = renderConversationList(empty, [SRC], { format: 'markdown' });
    assert.ok(md.includes('No conversations on this page.'));
    assert.ok(md.includes('official_chatgpt_export'));
    assert.deepEqual(parseLines(renderConversationList(empty, [SRC], { format: 'jsonl' })).map((l) => l['type']), ['header', 'footer']);
  });

  it('several sources with different completeness -> "mixed" with a NOTICE; no sources and no items -> "unknown" with a NOTICE', () => {
    const partial = { ...SRC, batchId: 'b_synthetic00000004', completeness: 'partial_user_supplied' as const };
    const md = renderConversationList(page, [SRC, partial], { format: 'markdown' });
    assert.match(md, /^NOTICE: completeness is "mixed"/m);
    assert.ok(md.includes('b_synthetic00000004'));
    assert.equal((JSON.parse(renderConversationList(page, [SRC, partial], { format: 'json' })) as { completeness: string }).completeness, 'mixed');
    const none = renderConversationList({ items: [], limit: 20, offset: 0, nextOffset: null }, [], { format: 'compact' });
    assert.match(none, /^NOTICE: completeness is "unknown"/m);
    assert.ok(none.includes('# source: none supplied'));
  });

  it('an item that is weaker than the declared source also downgrades the result (negative: strong items keep exported_tree)', () => {
    const weak: Page<ConversationSummary> = { ...page, items: [conv('conv-w', 'W', 1, 1, { completeness: 'rendered_active_view_only' })] };
    assert.match(renderConversationList(weak, [SRC], { format: 'markdown' }), /^NOTICE: completeness is "mixed"/m);
    assert.ok(!renderConversationList(page, [SRC], { format: 'markdown' }).includes('NOTICE'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('renderSearchHits', () => {
  function hit(over: Partial<SearchHit> = {}): SearchHit {
    return {
      provider: 'chatgpt',
      accountLabel: 'default',
      conversationId: 'conv-a',
      conversationTitle: 'First',
      messageId: 'conv-a-m2',
      authorRole: 'assistant',
      modelSlug: 'synthetic-model-1',
      channel: null,
      createdAt: iso(2),
      hidden: false,
      snippet: 'find the \u0001needle\u0002 here',
      rank: -2.5,
      batchId: 'b_synthetic00000003',
      ...over,
    };
  }
  const page: Page<SearchHit> = { items: [hit()], limit: 20, offset: 0, nextOffset: null, nextCursor: null };

  it('markdown golden: match markers become emphasis, never raw control characters', () => {
    const expected = `# Search results

- Query: \`needle\`
- Page: 1 item(s) at offset 0 (limit 20)
- Next offset: none (end of results)
- Hidden hits omitted: 0
- Note: snippets are excerpts of matching messages, NOT the full conversation history
- Tool version: gcr ${TOOL_VERSION}
- Timezone: \`UTC\`

${SOURCE_TABLE}

## Hits

| \\# | Time | Role | Title | Conversation | Message | Source | Snippet |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2025-01-01 00:02:00 UTC (UTC+00:00) | assistant | First | conv-a | conv-a-m2 | chatgpt/default | find the **needle** here |

## Warnings

None.
`;
    const out = renderSearchHits(page, [SRC], { format: 'markdown', query: 'needle' });
    assert.equal(out, expected);
    assert.ok(!/[\u0001\u0002]/.test(out));
  });

  it('compact golden', () => {
    const expected = `# search "needle" | chatgpt | exported_tree | offset=0 limit=20 hits=1
${SOURCE_COMPACT}
[assistant] conv-a/conv-a-m2 First | find the [[needle]] here
`;
    assert.equal(renderSearchHits(page, [SRC], { format: 'compact', query: 'needle' }), expected);
  });

  it('json golden: plain snippet text plus match offsets (UTF-16), markers removed', () => {
    const parsed = JSON.parse(renderSearchHits(page, [SRC], { format: 'json', query: 'needle' })) as { data: Record<string, unknown>; ids: unknown };
    assert.equal(parsed.data['query'], 'needle');
    assert.equal(parsed.data['omittedHidden'], 0);
    const item = (parsed.data['items'] as Array<Record<string, unknown>>)[0];
    assert.equal(item?.['snippet'], 'find the needle here');
    assert.deepEqual(item?.['snippetMatches'], [[9, 15]]);
    assert.equal(item?.['rank'], -2.5);
    assert.deepEqual(parsed.ids, { conversationIds: ['conv-a'], messageIds: ['conv-a-m2'] });
  });

  it('jsonl golden: hit lines', () => {
    const lines = parseLines(renderSearchHits(page, [SRC], { format: 'jsonl', query: 'needle' }));
    assert.deepEqual(lines.map((l) => l['type']), ['header', 'hit', 'footer']);
    assert.equal(lines[0]?.['query'], 'needle');
    assert.equal(lines[1]?.['messageId'], 'conv-a-m2');
    assert.equal(lines[1]?.['snippet'], 'find the needle here');
  });

  it('match offsets are in UTF-16 units of the plain snippet (astral characters before the match)', () => {
    const emoji = { ...page, items: [hit({ snippet: '\ud83d\ude00 \u0001hit\u0002' })] };
    const item = (JSON.parse(renderSearchHits(emoji, [SRC], { format: 'json', query: 'q' })) as { data: { items: Array<{ snippet: string; snippetMatches: Array<[number, number]> }> } }).data.items[0];
    assert.ok(item !== undefined);
    const [start, end] = item.snippetMatches[0] ?? [-1, -1];
    assert.equal(item.snippet.slice(start, end), 'hit');
  });

  it('tolerates malformed markers: stray ends, repeated starts, unterminated matches, adjacent matches, whitespace edges', () => {
    const cases: Array<[snippet: string, md: string, compact: string, plain: string, matches: Array<[number, number]>]> = [
      ['a\u0002b', 'ab', 'ab', 'ab', []],
      ['a\u0001\u0001b\u0002c', 'a**b**c', 'a[[b]]c', 'abc', [[1, 2]]],
      ['a\u0001b', 'a**b**', 'a[[b]]', 'ab', [[1, 2]]],
      ['\u0001a\u0002\u0001b\u0002', '**a****b**', '[[a]][[b]]', 'ab', [[0, 1], [1, 2]]],
      ['x\u0001 pad \u0002y', 'x **pad** y', 'x[[ pad ]]y', 'x pad y', [[1, 6]]],
      ['\u0001\u0002', '', '', '', []],
      ['', '', '', '', []],
    ];
    for (const [snippet, md, compact, plain, matches] of cases) {
      const p = { ...page, items: [hit({ snippet })] };
      const mdOut = renderSearchHits(p, [SRC], { format: 'markdown', query: 'q' });
      const row = mdOut.split('\n').find((l) => l.startsWith('| 1 |')) ?? '';
      assert.ok(row.endsWith(`| chatgpt/default | ${md} |`), `${JSON.stringify(snippet)} -> ${row}`);
      const compactOut = renderSearchHits(p, [SRC], { format: 'compact', query: 'q' });
      assert.ok(compactOut.includes(`First | ${compact}\n`), `${JSON.stringify(snippet)} -> ${compactOut}`);
      const item = (JSON.parse(renderSearchHits(p, [SRC], { format: 'json', query: 'q' })) as { data: { items: Array<{ snippet: string; snippetMatches: unknown }> } }).data.items[0];
      assert.equal(item?.snippet, plain);
      assert.deepEqual(item?.snippetMatches, matches);
    }
  });

  it('hidden hits are omitted by default (counted, with a warning) and labelled when includeHidden is set', () => {
    const mixed: Page<SearchHit> = { ...page, items: [hit(), hit({ messageId: 'conv-a-s0', authorRole: 'system', hidden: true, snippet: '\u0001secret\u0002 prompt' })] };
    for (const format of FORMATS) {
      const out = renderSearchHits(mixed, [SRC], { format, query: 'q' });
      assert.ok(!out.includes('conv-a-s0'), `${format} leaked a hidden hit`);
      assert.ok(out.includes('HIDDEN_HITS_OMITTED'), `${format} must warn about the omission`);
    }
    const shown = renderSearchHits(mixed, [SRC], { format: 'markdown', query: 'q', includeHidden: true });
    assert.ok(shown.includes('| 2 |'));
    assert.ok(shown.includes('system \\[hidden\\]'));
    assert.ok(!shown.includes('HIDDEN_HITS_OMITTED'));
    const json = JSON.parse(renderSearchHits(mixed, [SRC], { format: 'json', query: 'q', includeHidden: true })) as { data: { items: Array<{ hidden: boolean }> } };
    assert.deepEqual(json.data.items.map((i) => i.hidden), [false, true]);
  });

  it('shows hit times in the requested zone', () => {
    assert.ok(renderSearchHits(page, [SRC], { format: 'markdown', query: 'q', tz: 'America/New_York' }).includes('2024-12-31 19:02:00 EST (UTC-05:00)'));
  });

  it('an empty result page', () => {
    const empty: Page<SearchHit> = { items: [], limit: 20, offset: 0, nextOffset: null, nextCursor: null };
    assert.ok(renderSearchHits(empty, [SRC], { format: 'markdown', query: 'q' }).includes('No hits on this page.'));
    assert.deepEqual(parseLines(renderSearchHits(empty, [SRC], { format: 'jsonl', query: 'q' })).map((l) => l['type']), ['header', 'footer']);
  });

  it('rejects a non-string query', () => {
    assert.throws(() => renderSearchHits(page, [SRC], { format: 'json', query: 5 as unknown as string }), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('renderBranchList', () => {
  function branch(over: Partial<Branch> & { branchId: string }): Branch {
    return { index: 0, rootId: 'conv-a-root', leafId: over.branchId, path: ['conv-a-root', 'conv-a-u0', over.branchId], visibleMessageCount: 2, messageCount: 2, forkNodeId: null, activeness: 'unknown', ...over };
  }
  const result: BranchListResult = {
    conversation: conv('conv-a', 'First', 3, 3),
    activeBranchId: 'conv-a-a1',
    branches: [
      branch({ branchId: 'conv-a-a1', index: 0, activeness: 'active' }),
      branch({ branchId: 'conv-a-a2', index: 1, forkNodeId: 'conv-a-u0', activeness: 'inactive', visibleMessageCount: 1, messageCount: 2 }),
    ],
    warnings: [{ code: 'CHILD_PARENT_MISMATCH', message: 'declared children disagree', ids: ['conv-a-u0'] }],
  };

  it('markdown golden', () => {
    const expected = `# First

- Conversation ID: \`conv-a\`
- Provider / account: chatgpt / \`default\`
- Provenance: official_chatgpt_export
- Completeness: exported_tree
- Source batch: \`b_synthetic00000003\`
- Source file: \`synthetic-export.zip\`
- Imported at: 2025-02-01 00:00:00 UTC (UTC+00:00)
- Imported with tool version: import-tool-9.9.9
- Tool version: gcr ${TOOL_VERSION}
- Timezone: \`UTC\`
- Active branch: \`conv-a-a1\`
- Branches: 2

## Branches

| \\# | Branch (leaf id) | Root | Fork node | Messages (visible/total) | Activeness |
| --- | --- | --- | --- | --- | --- |
| 1 | conv-a-a1 | conv-a-root | \\- | 2/2 | active |
| 2 | conv-a-a2 | conv-a-root | conv-a-u0 | 1/2 | inactive |

## Warnings

- \`CHILD_PARENT_MISMATCH\`: declared children disagree (ids: \`conv-a-u0\`)
`;
    assert.equal(renderBranchList(result, SRC, { format: 'markdown' }), expected);
  });

  it('compact golden', () => {
    const expected = `# First | chatgpt | exported_tree | active=conv-a-a1
${SOURCE_COMPACT} | conversation=conv-a
[branch 1] conv-a-a1 | root conv-a-root | fork - | 2/2 msgs | active
[branch 2] conv-a-a2 | root conv-a-root | fork conv-a-u0 | 1/2 msgs | inactive
# warnings: CHILD_PARENT_MISMATCH: declared children disagree (ids: conv-a-u0)
`;
    assert.equal(renderBranchList(result, SRC, { format: 'compact' }), expected);
  });

  it('json and jsonl carry full branch paths, the active branch and warnings', () => {
    const json = JSON.parse(renderBranchList(result, SRC, { format: 'json' })) as { data: { activeBranchId: string; branches: Branch[] }; warnings: Warning[]; ids: unknown };
    assert.equal(json.data.activeBranchId, 'conv-a-a1');
    assert.deepEqual(json.data.branches, result.branches);
    assert.deepEqual(json.warnings, result.warnings);
    assert.deepEqual(json.ids, { conversationIds: ['conv-a'], branchIds: ['conv-a-a1', 'conv-a-a2'] });
    const lines = parseLines(renderBranchList(result, SRC, { format: 'jsonl' }));
    assert.deepEqual(lines.map((l) => l['type']), ['header', 'branch', 'branch', 'footer']);
    assert.deepEqual(lines[1], { type: 'branch', ...result.branches[0] });
    assert.deepEqual((lines[3] as { warnings: Warning[] }).warnings, result.warnings);
  });

  it('an unknown active branch is stated, never guessed', () => {
    const unknown: BranchListResult = { ...result, activeBranchId: null, branches: result.branches.map((b) => ({ ...b, activeness: 'unknown' as const })) };
    const md = renderBranchList(unknown, SRC, { format: 'markdown' });
    assert.match(md, /^- Active branch: unknown \(the source gave no valid current node; GCR does not guess\)$/m);
    assert.ok(renderBranchList(unknown, SRC, { format: 'compact' }).startsWith('# First | chatgpt | exported_tree | active=unknown\n'));
    assert.equal((JSON.parse(renderBranchList(unknown, SRC, { format: 'json' })) as { data: { activeBranchId: unknown } }).data.activeBranchId, null);
  });

  it('a non-exported_tree source prints the NOTICE', () => {
    const partialSrc = { ...SRC, completeness: 'partial_user_supplied' as const };
    const partial: BranchListResult = { ...result, conversation: conv('conv-a', 'First', 3, 3, { completeness: 'partial_user_supplied' }) };
    assert.match(renderBranchList(partial, partialSrc, { format: 'markdown' }), /^NOTICE: completeness is "partial_user_supplied"/m);
    assert.match(renderBranchList(partial, partialSrc, { format: 'compact' }), /^NOTICE: completeness is "partial_user_supplied"/m);
  });

  it('no branches', () => {
    const none: BranchListResult = { ...result, activeBranchId: null, branches: [] };
    assert.ok(renderBranchList(none, SRC, { format: 'markdown' }).includes('No branches.'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('renderImportReport', () => {
  const report: ImportReport = {
    batchId: 'b_synthetic00000003',
    provider: 'chatgpt',
    accountLabel: 'default',
    sourceKind: 'zip',
    sourceLabel: 'synthetic-export.zip',
    alreadyImported: false,
    files: [{ name: 'conversations-000.json', conversations: 2, failed: 0 }, { name: 'conversations-001.json', conversations: 1, failed: 1 }],
    conversations: { read: 4, stored: 3, failed: 1, newlyInserted: 3 },
    messages: { stored: 12, newlyInserted: 12, structural: 3 },
    warnings: [{ code: 'CHILDREN_ABSENT', count: 3, sampleIds: ['conv-a', 'conv-b'] }],
    durationMs: 17,
  };

  it('markdown golden', () => {
    const expected = `# Import report

NOTICE: completeness is "unknown": an import report does not record per-conversation completeness. Use list/get to see how complete each conversation is.

- Batch ID: \`b_synthetic00000003\`
- Provider / account: chatgpt / \`default\`
- Source kind: zip
- Source file: \`synthetic-export.zip\`
- Already imported: no
- Provenance: not part of an import report (see list/get for each conversation)
- Completeness: unknown (not part of an import report)
- Duration: 17 ms
- Tool version: gcr ${TOOL_VERSION}

## Counts

| Metric | Value |
| --- | --- |
| Conversations read | 4 |
| Conversations stored | 3 |
| Conversations failed | 1 |
| Conversations newly inserted | 3 |
| Messages stored | 12 |
| Messages newly inserted | 12 |
| Structural nodes | 3 |

## Files

| File | Conversations | Failed |
| --- | --- | --- |
| conversations-000.json | 2 | 0 |
| conversations-001.json | 1 | 1 |

## Warnings

- \`CHILDREN_ABSENT\`: 3 occurrence(s) (ids: \`conv-a\`, \`conv-b\`)
`;
    assert.equal(renderImportReport(report, { format: 'markdown' }), expected);
  });

  it('compact golden', () => {
    const expected = `# import report | chatgpt | unknown | batch=b_synthetic00000003
# source: kind=zip | file=synthetic-export.zip | account=default | alreadyImported=false | tool=gcr ${TOOL_VERSION} | tz=UTC
NOTICE: completeness is "unknown": an import report does not record per-conversation completeness. Use list/get to see how complete each conversation is.
conversations: read=4 stored=3 failed=1 new=3
messages: stored=12 new=12 structural=3
file conversations-000.json: 2 conversations, 0 failed
file conversations-001.json: 1 conversations, 1 failed
duration: 17 ms
# warnings: CHILDREN_ABSENT: 3 occurrence(s) (ids: conv-a, conv-b)
`;
    assert.equal(renderImportReport(report, { format: 'compact' }), expected);
  });

  it('json golden: full report in data, warning summaries converted to warnings, no invented provenance', () => {
    const parsed = JSON.parse(renderImportReport(report, { format: 'json' })) as Record<string, unknown>;
    assert.deepEqual(parsed['data'], { ...report });
    assert.deepEqual(parsed['warnings'], [{ code: 'CHILDREN_ABSENT', message: '3 occurrence(s)', ids: ['conv-a', 'conv-b'] }]);
    assert.deepEqual(parsed['source'], []);
    assert.equal(parsed['completeness'], 'unknown');
    assert.equal(parsed['untrustedContent'], false);
  });

  it('jsonl golden: header with the counts, one line per file, footer', () => {
    const lines = parseLines(renderImportReport(report, { format: 'jsonl' }));
    assert.deepEqual(lines.map((l) => l['type']), ['header', 'file', 'file', 'footer']);
    assert.equal(lines[0]?.['batchId'], 'b_synthetic00000003');
    assert.equal(lines[0]?.['fileCount'], 2);
    assert.deepEqual(lines[0]?.['conversations'], report.conversations);
    assert.deepEqual(lines[2], { type: 'file', name: 'conversations-001.json', conversations: 1, failed: 1 });
  });

  it('an idempotent re-import is stated plainly; a format profile is listed; a path in sourceLabel is cut to its basename', () => {
    const again: ImportReport = {
      ...report,
      alreadyImported: true,
      sourceLabel: 'C:\\Users\\alice\\Downloads\\export.zip',
      formatProfile: { layout: 'sharded', manifest: 'absent', wrapperObject: false, conversations: 3, conversationsWithCurrentNode: 3, nodesWithChildrenDeclared: 0, nodesWithChildrenAbsent: 9, roleCounts: { user: 5, assistant: 5 }, messagesWithRecipient: 0, messagesWithStatus: 0, messagesWithModelSlug: 5, hiddenMessages: 1, rootIsLiteralClientCreatedRoot: true, auxiliaryFilesIgnored: 4, assetsExtensionless: false },
    };
    for (const format of FORMATS) {
      const out = renderImportReport(again, { format });
      assert.ok(!out.includes('alice') && !out.includes('Downloads'), `${format} leaked a path`);
    }
    const md = renderImportReport(again, { format: 'markdown' });
    assert.ok(md.startsWith('# Import report (already imported: no changes)\n'));
    assert.match(md, /^- Already imported: yes \(idempotent no-op\)$/m);
    assert.ok(md.includes('## Format profile'));
    assert.ok(md.includes('| roleCounts.user | 5 |'));
    assert.ok(md.includes('`export.zip`'));
  });

  it('no warnings -> "None." / no warnings line', () => {
    const clean: ImportReport = { ...report, warnings: [] };
    assert.ok(renderImportReport(clean, { format: 'markdown' }).endsWith('## Warnings\n\nNone.\n'));
    assert.ok(!renderImportReport(clean, { format: 'compact' }).includes('# warnings'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('renderEnvelope (generic)', () => {
  function ok<T>(data: T, over: Partial<ResultEnvelope<T>> = {}): ResultEnvelope<T> {
    return { ok: true, data, source: [SRC], completeness: 'exported_tree', warnings: [], ids: {}, untrustedContent: false, ...over };
  }

  it('json: the documented top-level shape for success and for errors', () => {
    const success = JSON.parse(renderEnvelope(ok({ a: 1 }, { ids: { conversationIds: ['c'] }, warnings: [{ code: 'W', message: 'm' }] }), { format: 'json' })) as Record<string, unknown>;
    assert.deepEqual(Object.keys(success), ['ok', 'data', 'source', 'completeness', 'warnings', 'ids', 'untrustedContent', 'tool']);
    assert.deepEqual(success['data'], { a: 1 });
    assert.deepEqual(success['ids'], { conversationIds: ['c'] });
    const failure: ErrorEnvelope = { ok: false, error: { code: 'NOT_IN_LOCAL_EXPORT', message: 'not found', remedy: 'import an export', details: { id: 'c1' } }, warnings: [{ code: 'W', message: 'm' }] };
    const parsed = JSON.parse(renderEnvelope(failure, { format: 'json' })) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['ok', 'error', 'source', 'completeness', 'warnings', 'ids', 'untrustedContent', 'tool']);
    assert.deepEqual(parsed['error'], failure.error);
    assert.equal(parsed['ok'], false);
    assert.equal(parsed['completeness'], 'unknown');
    assert.deepEqual(parsed['source'], []);
    assert.deepEqual(parsed['warnings'], failure.warnings);
  });

  it('jsonl: array data -> one item line per element; object data -> a single data line; errors -> one error line', () => {
    const arr = parseLines(renderEnvelope(ok([{ n: 1 }, { n: 2 }, 3]), { format: 'jsonl' }));
    assert.deepEqual(arr.map((l) => l['type']), ['header', 'item', 'item', 'item', 'footer']);
    assert.equal(arr[0]?.['count'], 3);
    assert.deepEqual(arr[1], { type: 'item', index: 0, data: { n: 1 } });
    assert.deepEqual(arr[3], { type: 'item', index: 2, data: 3 });
    const obj = parseLines(renderEnvelope(ok({ n: 1 }), { format: 'jsonl' }));
    assert.deepEqual(obj.map((l) => l['type']), ['header', 'data', 'footer']);
    assert.deepEqual(obj[1], { type: 'data', data: { n: 1 } });
    const err = parseLines(renderEnvelope({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'bad' }, warnings: [] }, { format: 'jsonl' }));
    assert.deepEqual(err.map((l) => l['type']), ['header', 'error', 'footer']);
    assert.equal(err[0]?.['ok'], false);
    assert.deepEqual((err[1] as { error: unknown }).error, { code: 'INVALID_ARGUMENT', message: 'bad' });
    assert.deepEqual(parseLines(renderEnvelope(ok([]), { format: 'jsonl' })).map((l) => l['type']), ['header', 'footer']);
  });

  it('markdown: a uniform array of flat objects becomes a table; anything else becomes a path/value table', () => {
    const table = renderEnvelope(ok([{ a: 1, b: 'x|y' }, { a: 2, c: null }]), { format: 'markdown' });
    assert.ok(table.includes('| a | b | c |\n| --- | --- | --- |\n| 1 | x\\|y |  |\n| 2 |  | null |'));
    const flat = renderEnvelope(ok({ nested: { list: [1, 'two'], empty: [], none: {} }, flag: true }), { format: 'markdown' });
    // Paths and values are table cells, so brackets are backslash-escaped like any other untrusted text.
    for (const row of ['| nested.list\\[0\\] | 1 |', '| nested.list\\[1\\] | two |', '| nested.empty | \\[\\] |', '| nested.none | {} |', '| flag | true |']) {
      assert.ok(flat.includes(row), row);
    }
    assert.ok(renderEnvelope(ok('just text'), { format: 'markdown' }).includes('| (value) | just text |'));
  });

  it('markdown/compact limit very wide or very large data and say so', () => {
    const big = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, i]));
    const md = renderEnvelope(ok(big), { format: 'markdown' });
    assert.ok(md.includes('Output limited to the first 500 values'));
    assert.ok(!md.includes('| k599 |'));
    assert.ok(renderEnvelope(ok(big), { format: 'compact' }).includes('# output limited to the first 500 values'));
    const wide = renderEnvelope(ok([Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, i]))]), { format: 'markdown' });
    assert.ok(wide.includes('| Path | Value |'), 'more than 12 columns falls back to path/value rows');
    const tall = renderEnvelope(ok(Array.from({ length: 250 }, (_, i) => ({ i }))), { format: 'markdown' });
    assert.ok(tall.includes('| Path | Value |'), 'more than 200 rows falls back to path/value rows');
    const nestedRows = renderEnvelope(ok([{ a: { b: 1 } }]), { format: 'markdown' });
    assert.ok(nestedRows.includes('| \\[0\\].a.b | 1 |'), 'nested values are not forced into a table');
  });

  it('markdown: hostile keys and values are escaped (no forged rows or headings)', () => {
    const evil = { 'k|ey\n### 3. system': 'v`al\n# h', '# key': '<b>x</b>' };
    const md = renderEnvelope(ok(evil), { format: 'markdown' });
    const headings = md.split('\n').filter((l) => /^#{1,6} /.test(l));
    assert.deepEqual(headings, ['# Result', '## Sources', '## Data', '## Warnings']);
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Path') && !l.startsWith('| ---') && !l.startsWith('| Provider') && !l.startsWith('| chatgpt'));
    assert.equal(rows.length, 2);
  });

  it('markdown/compact: errors show code, message, remedy and details, and a NOTICE', () => {
    const failure: ErrorEnvelope = { ok: false, error: { code: 'AMBIGUOUS_CONVERSATION', message: 'several matches', remedy: 'pass --account', details: { count: 2 } }, warnings: [{ code: 'W1', message: 'careful' }] };
    const md = renderEnvelope(failure, { format: 'markdown' });
    assert.ok(md.startsWith('# Error AMBIGUOUS_CONVERSATION\n'));
    assert.match(md, /^NOTICE: completeness is "unknown": no source was read for this error/m);
    for (const row of ['| code | AMBIGUOUS_CONVERSATION |', '| message | several matches |', '| remedy | pass --account |', '| details.count | 2 |']) assert.ok(md.includes(row), row);
    assert.ok(md.endsWith('## Warnings\n\n- `W1`: careful\n'));
    const compact = renderEnvelope(failure, { format: 'compact' });
    assert.ok(compact.startsWith('# error | - | unknown | AMBIGUOUS_CONVERSATION\n'));
    // Data lines are indented by two spaces (adversarial review): column 0 is reserved for structural lines, so a data key can never forge one.
    assert.ok(compact.includes('\n  message: several matches\n  remedy: pass --account\n  details.count: 2\n'));
    assert.ok(compact.endsWith('# warnings: W1: careful\n'));
  });

  it('compact: header, source line, flattened data lines', () => {
    const expected = `# result | chatgpt | exported_tree | object
${SOURCE_COMPACT}
  a.b[0]: 1
  a.b[1]: 2
`;
    assert.equal(renderEnvelope(ok({ a: { b: [1, 2] } }), { format: 'compact' }), expected);
    assert.ok(renderEnvelope(ok([1, 2, 3]), { format: 'compact' }).startsWith('# result | chatgpt | exported_tree | 3 items\n'));
  });

  it('every format carries completeness, provenance (source) and warnings', () => {
    const env = ok({ x: 1 }, { warnings: [{ code: 'WARN_X', message: 'be careful', ids: ['i1'] }] });
    for (const format of FORMATS) {
      const out = renderEnvelope(env, { format });
      for (const needle of ['exported_tree', 'official_chatgpt_export', 'WARN_X', 'be careful']) assert.ok(out.includes(needle), `${format}: missing ${needle}`);
    }
  });

  it('a source weaker than the declared completeness is not hidden (becomes "mixed" + NOTICE)', () => {
    const env = ok({ x: 1 }, { source: [{ ...SRC, completeness: 'rendered_active_view_only' }], completeness: 'exported_tree' });
    assert.match(renderEnvelope(env, { format: 'markdown' }), /^NOTICE: completeness is "mixed"/m);
    assert.equal((JSON.parse(renderEnvelope(env, { format: 'json' })) as { completeness: string }).completeness, 'mixed');
    const stated = ok({ x: 1 }, { completeness: 'mixed' });
    assert.equal((JSON.parse(renderEnvelope(stated, { format: 'json' })) as { completeness: string }).completeness, 'mixed');
  });

  it('untrustedContent is passed through; errors are never untrusted content', () => {
    assert.equal((JSON.parse(renderEnvelope(ok({}, { untrustedContent: true }), { format: 'json' })) as { untrustedContent: boolean }).untrustedContent, true);
    assert.equal((JSON.parse(renderEnvelope({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' }, warnings: [] }, { format: 'json' })) as { untrustedContent: boolean }).untrustedContent, false);
  });

  it('is deterministic and does not mutate its input', () => {
    const env = ok({ list: [{ a: 1 }, { a: 2 }] }, { warnings: [{ code: 'W', message: 'm' }] });
    const before = JSON.stringify(env);
    for (const format of FORMATS) assert.equal(renderEnvelope(env, { format }), renderEnvelope(structuredClone(env), { format }));
    assert.equal(JSON.stringify(env), before);
  });

  it('rejects a non-object envelope and bad options', () => {
    const expectInvalid = (fn: () => unknown): void => {
      assert.throws(fn, (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
    };
    expectInvalid(() => renderEnvelope(null as unknown as ResultEnvelope<unknown>, { format: 'json' }));
    expectInvalid(() => renderEnvelope(ok(1), { format: 'json', tz: 'Nope/Zone' }));
    expectInvalid(() => renderEnvelope(ok(1), { format: 'toml' as unknown as 'json' }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('FR-09: provenance, completeness and warnings appear in every format of every renderer', () => {
  const partialSrc: SourceSummary = { ...SRC, completeness: 'partial_user_supplied' };
  const warning: Warning = { code: 'WARN_FR09', message: 'visible in all formats' };
  const cases: Array<[name: string, render: (format: (typeof FORMATS)[number]) => string]> = [
    ['list', (format) => renderConversationList({ items: [conv('c', 'T', 1, 1, { completeness: 'partial_user_supplied' })], limit: 1, offset: 0, nextOffset: null }, [partialSrc], { format })],
    ['search', (format) => renderSearchHits({ items: [], limit: 1, offset: 0, nextOffset: null }, [partialSrc], { format, query: 'q' })],
    ['branches', (format) => renderBranchList({ conversation: conv('c', 'T', 1, 1, { completeness: 'partial_user_supplied' }), activeBranchId: null, branches: [], warnings: [warning] }, partialSrc, { format })],
    ['envelope', (format) => renderEnvelope({ ok: true, data: { x: 1 }, source: [partialSrc], completeness: 'partial_user_supplied', warnings: [warning], ids: {}, untrustedContent: false }, { format })],
  ];
  for (const [name, render] of cases) {
    for (const format of FORMATS) {
      it(`${name} / ${format}`, () => {
        const out = render(format);
        assert.ok(out.includes('partial_user_supplied'), 'completeness');
        assert.ok(out.includes('official_chatgpt_export'), 'provenance');
        if (name === 'branches' || name === 'envelope') assert.ok(out.includes('WARN_FR09'), 'warnings');
        if (format === 'markdown' || format === 'compact') assert.match(out, /^NOTICE: completeness is "partial_user_supplied"/m);
        assert.ok(out.includes(TOOL_VERSION), 'tool version');
      });
    }
  }
});
