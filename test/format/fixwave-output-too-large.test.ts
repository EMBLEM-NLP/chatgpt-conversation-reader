/**
 * ATK-06: `gcr get <id> --all-branches --format json` on a conversation within the import limits (500,000 nodes) ended in
 * `INTERNAL_ERROR` "An unexpected internal error occurred" because `JSON.stringify` of a ~300 MB document throws
 * `RangeError: Invalid string length`. The renderers now turn a size failure into a CODED error that says what to do:
 * `INVALID_ARGUMENT` (the existing code closest to "this request asks for more than one text can hold"; src/errors.ts has no
 * RESULT_TOO_LARGE), `details.reason = "OUTPUT_TOO_LARGE"`, and a remedy that suggests --format jsonl, a narrower scope, --limit
 * or paging.
 *
 * No 500,000-node fixture here: a REAL oversized value (two strings of 290 million characters, about 3 s) proves that the
 * failure V8 raises is the one that is handled; the other formats and renderers are covered by making JSON.stringify throw the
 * very same RangeError. SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BranchListResult, ConversationSummary, ImportReport, Page, SearchHit, ThreadResult } from '../../src/domain/results.js';
import type { ResultEnvelope, SourceSummary } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { isOutputSizeFailure, outputTooLargeError, renderBranchList, renderConversationList, renderEnvelope, renderImportReport, renderSearchHits, renderThread } from '../../src/format/render.js';
import { iso, msg } from '../helpers/records.js';

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

const SUMMARY: ConversationSummary = {
  provider: 'chatgpt',
  accountLabel: 'default',
  conversationId: 'conv-a',
  title: 'Synthetic title',
  createdAt: iso(0),
  updatedAt: iso(3),
  messageCount: 2,
  currentNodeId: 'conv-a-a0',
  defaultModelSlug: null,
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  batchId: 'b_synthetic00000003',
  importedAt: '2025-02-01T00:00:00.000Z',
};

const ENVELOPE: ResultEnvelope<{ n: number }> = { ok: true, data: { n: 1 }, source: [SRC], completeness: 'exported_tree', warnings: [], ids: {}, untrustedContent: false };

/** Run `fn` while JSON.stringify fails exactly the way V8 fails on a document over its string limit. */
function withStringifyOverflow<T>(fn: () => T): T {
  const real = JSON.stringify;
  JSON.stringify = ((): string => {
    throw new RangeError('Invalid string length');
  }) as typeof JSON.stringify;
  try {
    return fn();
  } finally {
    JSON.stringify = real;
  }
}

function assertTooLarge(e: unknown, format: string): true {
  assert.ok(e instanceof GcrError, `expected a GcrError, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  assert.equal(e.code, 'INVALID_ARGUMENT');
  assert.equal(e.details?.['reason'], 'OUTPUT_TOO_LARGE');
  assert.equal(e.details?.['format'], format);
  assert.match(e.message, /too large/i);
  if (format === 'jsonl') assert.doesNotMatch(e.remedy ?? '', /--format jsonl/, 'does not suggest what was already asked for');
  else assert.match(e.remedy ?? '', /--format jsonl/, 'suggests the streaming format');
  assert.match(e.remedy ?? '', /--limit/, 'suggests a smaller page');
  assert.match(e.remedy ?? '', /narrow|scope|one conversation|branch/i, 'suggests a narrower scope');
  assert.match(e.remedy ?? '', /pag(e|ing)|offset/i, 'suggests paging');
  assert.ok(e.cause instanceof RangeError, 'the original failure is kept as the cause (shown by --debug only)');
  assert.equal(JSON.stringify({ m: e.message, r: e.remedy, d: e.details }).includes('Invalid string length'), false, 'V8 text is not forwarded');
  return true;
}

describe('isOutputSizeFailure', () => {
  const sizeErrors: unknown[] = [
    new RangeError('Invalid string length'),
    new RangeError('Invalid array length'),
    new RangeError('Invalid typed array length: 4294967296'),
    new RangeError('Array buffer allocation failed'),
    Object.assign(new Error('Cannot create a string longer than 0x1fffffe8 characters'), { code: 'ERR_STRING_TOO_LONG' }),
    Object.assign(new RangeError('The value of "size" is out of range'), { code: 'ERR_BUFFER_TOO_LARGE' }),
  ];
  const others: unknown[] = [
    new RangeError('Maximum call stack size exceeded'),
    new RangeError('toFixed() digits argument must be between 0 and 100'),
    new Error('Invalid string length'),
    new GcrError('INVALID_ARGUMENT', 'Invalid string length'),
    'Invalid string length',
    null,
    undefined,
  ];

  it('recognises the size failures V8 and Node raise', () => {
    for (const e of sizeErrors) assert.equal(isOutputSizeFailure(e), true, String(e));
  });

  it('recognises nothing else: a stack overflow, another RangeError, a plain Error with the same words, a GcrError, a string', () => {
    for (const e of others) assert.equal(isOutputSizeFailure(e), false, String(e));
  });
});

describe('outputTooLargeError', () => {
  it('is INVALID_ARGUMENT with the OUTPUT_TOO_LARGE reason and an actionable remedy', () => {
    const e = outputTooLargeError('json', new RangeError('Invalid string length'));
    assert.equal(e.code, 'INVALID_ARGUMENT');
    assert.equal(e.details?.['reason'], 'OUTPUT_TOO_LARGE');
    assert.equal(e.details?.['format'], 'json');
    assert.match(e.remedy ?? '', /--format jsonl/);
  });

  it('does not suggest --format jsonl to someone who already asked for it', () => {
    const e = outputTooLargeError('jsonl', new RangeError('Invalid string length'));
    assert.doesNotMatch(e.remedy ?? '', /--format jsonl/);
    assert.match(e.remedy ?? '', /--limit/);
  });
});

describe('a REAL document over V8\'s string limit', () => {
  it('renderEnvelope --format json answers OUTPUT_TOO_LARGE, not an unexpected RangeError', { timeout: 60_000 }, () => {
    const big = 'x'.repeat(290_000_000);
    assert.throws(
      () => renderEnvelope({ ...ENVELOPE, data: { a: big, b: big } }, { format: 'json' }),
      (e) => assertTooLarge(e, 'json'),
    );
  });

  it('a document that fits is unaffected', () => {
    const out = renderEnvelope({ ...ENVELOPE, data: { a: 'x'.repeat(1_000_000) } }, { format: 'json' });
    assert.ok(out.length > 1_000_000 && out.endsWith('\n'));
  });
});

describe('every renderer turns the size failure into the coded error', () => {
  const page: Page<ConversationSummary> = { items: [SUMMARY], limit: 20, offset: 0, total: 1, nextOffset: null };
  const hit: SearchHit = {
    provider: 'chatgpt',
    accountLabel: 'default',
    conversationId: 'conv-a',
    conversationTitle: 'First',
    messageId: 'conv-a-m2',
    authorRole: 'assistant',
    modelSlug: null,
    channel: null,
    createdAt: iso(2),
    hidden: false,
    snippet: 'find the \u0001needle\u0002 here',
    rank: -2.5,
    batchId: 'b_synthetic00000003',
  };
  const hits: Page<SearchHit> = { items: [hit], limit: 20, offset: 0, nextOffset: null, nextCursor: null };
  const branches: BranchListResult = {
    conversation: SUMMARY,
    activeBranchId: 'conv-a-a0',
    branches: [{ index: 0, branchId: 'conv-a-a0', rootId: 'conv-a-root', leafId: 'conv-a-a0', path: ['conv-a-root', 'conv-a-a0'], visibleMessageCount: 1, messageCount: 1, forkNodeId: null, activeness: 'active' }],
    warnings: [],
  };
  const report: ImportReport = {
    batchId: 'b_synthetic00000003',
    provider: 'chatgpt',
    accountLabel: 'default',
    sourceKind: 'zip',
    sourceLabel: 'synthetic-export.zip',
    alreadyImported: false,
    files: [{ name: 'conversations.json', conversations: 1, failed: 0 }],
    conversations: { read: 1, stored: 1, failed: 0, newlyInserted: 1 },
    messages: { stored: 2, newlyInserted: 2, structural: 1 },
    warnings: [],
    durationMs: 1,
  };
  const root = msg({ id: 'conv-a-root', conversationId: 'conv-a', nodeKind: 'structural_empty', authorRole: '', contentType: null });
  const user = msg({ id: 'conv-a-u0', conversationId: 'conv-a', parentId: 'conv-a-root', authorRole: 'user', createdAt: iso(1), text: 'Hello there', ordinal: 1 });
  const threadResult: ThreadResult = { conversation: SUMMARY, branchId: 'conv-a-u0', activeness: 'active', messages: [root, user], omittedHidden: 0, selectionPolicy: 'source_current_node', warnings: [] };

  const renderers: Array<[string, (format: 'json' | 'jsonl') => string]> = [
    ['renderEnvelope', (format) => renderEnvelope(ENVELOPE, { format })],
    ['renderConversationList', (format) => renderConversationList(page, [SRC], { format })],
    ['renderSearchHits', (format) => renderSearchHits(hits, [SRC], { format, query: 'needle' })],
    ['renderBranchList', (format) => renderBranchList(branches, SRC, { format })],
    ['renderImportReport', (format) => renderImportReport(report, { format })],
    ['renderThread', (format) => renderThread(threadResult, SRC, { format })],
  ];

  for (const [name, run] of renderers) {
    for (const format of ['json', 'jsonl'] as const) {
      it(`${name} --format ${format}`, () => {
        assert.doesNotThrow(() => run(format), 'sanity: it renders when nothing overflows');
        const e = (() => {
          try {
            withStringifyOverflow(() => run(format));
          } catch (err) {
            return err;
          }
          return undefined;
        })();
        assertTooLarge(e, format);
      });
    }
  }

  it('a failure that is NOT a size failure is not relabelled (it stays whatever it was)', () => {
    const real = JSON.stringify;
    JSON.stringify = ((): string => {
      throw new RangeError('Maximum call stack size exceeded');
    }) as typeof JSON.stringify;
    let thrown: unknown;
    try {
      renderEnvelope(ENVELOPE, { format: 'json' });
    } catch (e) {
      thrown = e;
    } finally {
      JSON.stringify = real;
    }
    assert.ok(thrown instanceof RangeError && !(thrown instanceof GcrError), 'the stack overflow is still a RangeError');
  });

  it('argument errors keep their own code (the guard only maps size failures)', () => {
    assert.throws(() => renderEnvelope(ENVELOPE, { format: 'nope' as 'json' }), (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && e.details?.['option'] === 'format');
  });
});
