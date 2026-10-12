/**
 * src/mcp/envelope.ts: how SDK results and errors become tool results, and how oversize results are reduced.
 * Pure unit tests plus properties (fast-check, fixed seed): whatever the sizes, the output is valid JSON within the cap,
 * a prefix of the original list, deterministic, and never silently shortened.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import type { ResultEnvelope } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import {
  DEFAULT_MAX_RESULT_BYTES,
  MAX_MAX_RESULT_BYTES,
  MIN_MAX_RESULT_BYTES,
  boundEnvelope,
  errorEnvelope,
  fixPage,
  maxResultBytesFromEnv,
  mcpEnvelopeSchema,
  parseMaxResultBytes,
  successEnvelope,
  toCallToolResult,
} from '../../src/mcp/envelope.js';
import type { McpEnvelope, Reduction } from '../../src/mcp/envelope.js';
import { LINE_SEPARATOR } from './mcp.helpers.test.js';

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

function envOf(data: Record<string, unknown>, extra: Partial<McpEnvelope> = {}): McpEnvelope {
  return { ok: true, data, source: [], completeness: 'exported_tree', warnings: [], ids: {}, untrustedContent: true, truncated: false, ...extra };
}

const ITEMS_PLAN: readonly Reduction[] = [{ kind: 'list', path: ['items'], fix: fixPage }];

function pageOf(items: unknown[], offset = 0, nextOffset: number | null = null): Record<string, unknown> {
  return { items, limit: items.length, offset, nextOffset, nextCursor: 'opaque-cursor-1' };
}

describe('successEnvelope', () => {
  const sdk: ResultEnvelope<unknown> = {
    ok: true,
    data: { a: 1 },
    source: [],
    completeness: 'mixed',
    warnings: [{ code: 'SOURCE_NOT_FULL_HISTORY', message: 'first' }],
    ids: { conversationIds: ['c1'] },
    untrustedContent: true,
  };

  it('copies the SDK fields and appends extra warnings after the SDK ones', () => {
    const env = successEnvelope(sdk, [{ code: 'DEPRECATED_TOOL_ALIAS', message: 'later' }]);
    assert.equal(env.ok, true);
    assert.deepEqual(env.data, { a: 1 });
    assert.equal(env.completeness, 'mixed');
    assert.deepEqual(env.warnings.map((w) => w.code), ['SOURCE_NOT_FULL_HISTORY', 'DEPRECATED_TOOL_ALIAS']);
    assert.deepEqual(env.ids, { conversationIds: ['c1'] });
    assert.equal(env.truncated, false);
  });

  it('wraps a non-object payload so `data` is always an object', () => {
    assert.deepEqual(successEnvelope({ ...sdk, data: [1, 2] }).data, { value: [1, 2] });
    assert.deepEqual(successEnvelope({ ...sdk, data: null }).data, { value: null });
    assert.deepEqual(successEnvelope({ ...sdk, data: 'text' }).data, { value: 'text' });
  });
});

describe('errorEnvelope', () => {
  it('carries the explicit code, message, remedy and details, and the neutral provenance fields', () => {
    const env = errorEnvelope(new GcrError('NOT_IN_LOCAL_EXPORT', 'gone', { remedy: 'import it', details: { conversationId: 'x' }, warnings: [{ code: 'W', message: 'w' }] }));
    assert.equal(env.ok, false);
    assert.deepEqual(env.error, { code: 'NOT_IN_LOCAL_EXPORT', message: 'gone', remedy: 'import it', details: { conversationId: 'x' } });
    assert.deepEqual(env.source, []);
    assert.equal(env.completeness, 'unknown');
    assert.deepEqual(env.ids, {});
    assert.deepEqual(env.warnings, [{ code: 'W', message: 'w' }]);
    assert.equal(env.untrustedContent, true, 'details may quote ids from the imported data');
    assert.equal(env.data, undefined);
  });

  it('is not marked untrusted when there are no details', () => {
    assert.equal(errorEnvelope(new GcrError('WRITE_FORBIDDEN', 'no')).untrustedContent, false);
  });

  it('satisfies the strict output schema, for every error code shape', () => {
    for (const env of [errorEnvelope(new GcrError('INTERNAL_ERROR', 'm')), errorEnvelope(new GcrError('INVALID_ARGUMENT', 'm', { details: { issues: [{ path: 'a', message: 'b' }] } }))]) {
      assert.equal(mcpEnvelopeSchema.safeParse(env).success, true);
    }
  });
});

describe('toCallToolResult', () => {
  it('puts the same JSON in the text block and in structuredContent, and sets isError only for failures', () => {
    const ok = toCallToolResult(envOf({ n: 1 }));
    assert.equal(ok.isError, undefined);
    assert.deepEqual(ok.structuredContent, JSON.parse((ok.content[0] as { text: string }).text));
    const bad = toCallToolResult(errorEnvelope(new GcrError('INVALID_ARGUMENT', 'm')));
    assert.equal(bad.isError, true);
    assert.deepEqual(bad.structuredContent, JSON.parse((bad.content[0] as { text: string }).text));
  });

  it('drops undefined members and keeps text with special characters intact', () => {
    const text = `quote " backslash \\ newline \n tab \t nul \u0000 emoji \u{1F600} lone ${String.fromCharCode(0xd800)}`;
    const res = toCallToolResult(envOf({ text, gone: undefined }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text) as McpEnvelope;
    assert.equal((parsed.data as { text: string }).text, text);
    assert.equal('gone' in (parsed.data as object), false);
    assert.deepEqual(res.structuredContent, parsed);
  });

  it('writes the line separator as its visible escape, in the text block and in structuredContent (ATK-04; test/mcp/fixwave-scrub.test.ts has the full matrix)', () => {
    const res = toCallToolResult(envOf({ text: `a${LINE_SEPARATOR}b` }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text) as McpEnvelope;
    assert.equal((parsed.data as { text: string }).text, 'a\\u2028b');
    assert.deepEqual(res.structuredContent, parsed);
    assert.equal((res.content[0] as { text: string }).text.includes(LINE_SEPARATOR), false);
  });
});

describe('result size cap configuration', () => {
  it('defaults to 200 000 bytes', () => {
    assert.equal(DEFAULT_MAX_RESULT_BYTES, 200_000);
    assert.equal(parseMaxResultBytes(undefined), 200_000);
    assert.equal(parseMaxResultBytes(''), 200_000);
    assert.equal(maxResultBytesFromEnv({}), 200_000);
  });

  it('GCR_MCP_MAX_RESULT_BYTES configures it within bounds', () => {
    assert.equal(parseMaxResultBytes('50000'), 50_000);
    assert.equal(parseMaxResultBytes(String(MIN_MAX_RESULT_BYTES)), MIN_MAX_RESULT_BYTES);
    assert.equal(parseMaxResultBytes(String(MAX_MAX_RESULT_BYTES)), MAX_MAX_RESULT_BYTES);
    assert.equal(maxResultBytesFromEnv({ GCR_MCP_MAX_RESULT_BYTES: '123456' }), 123_456);
  });

  it('a bad value is an error, never a silent default', () => {
    for (const bad of ['0', '-5', 'abc', '1e6', '12.5', ' 200000', '200000 ', String(MIN_MAX_RESULT_BYTES - 1), String(MAX_MAX_RESULT_BYTES + 1), '99999999999', '0x1000']) {
      assert.throws(() => parseMaxResultBytes(bad), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', `value ${JSON.stringify(bad)}`);
    }
  });
});

describe('boundEnvelope: lists', () => {
  it('returns the very same object when the result fits', () => {
    const env = envOf(pageOf([{ id: 'a' }]));
    assert.equal(boundEnvelope(env, ITEMS_PLAN, 10_000), env);
  });

  it('drops trailing items, keeps valid JSON within the cap, says so, and keeps paging coherent', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}`, text: 'x'.repeat(300) }));
    const env = envOf(pageOf(items, 40, 140));
    const cap = 10_000;
    const out = boundEnvelope(env, ITEMS_PLAN, cap);
    assert.ok(bytes(out) <= cap);
    assert.equal(out.truncated, true);
    assert.equal(out.ok, true);
    const kept = (out.data?.['items'] as unknown[]).length;
    assert.ok(kept > 0 && kept < 100);
    assert.deepEqual(out.data?.['items'], items.slice(0, kept), 'a prefix of the original, in order');
    assert.equal(out.data?.['nextOffset'], 40 + kept, 'the next page starts right after the last item shown');
    assert.equal('nextCursor' in (out.data ?? {}), false, 'a keyset cursor would skip the dropped items');
    const warning = out.warnings.find((w) => w.code === 'RESULT_TRUNCATED');
    assert.ok(warning);
    assert.match(warning.message, new RegExp(`kept ${kept} of 100 items`));
    assert.match(warning.message, /10000-byte limit/);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out, 'plain JSON');
  });

  it('keeps the longest prefix that fits: one more item would exceed the cap', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `item-${i}`, text: 'y'.repeat(100 + (i % 7) * 40) }));
    const cap = 6_000 + 2_300;
    const out = boundEnvelope(envOf(pageOf(items)), ITEMS_PLAN, cap);
    const kept = (out.data?.['items'] as unknown[]).length;
    assert.ok(kept < items.length);
    assert.ok(bytes(out) + bytes(items[kept]) + 1 > cap - 8, 'maximal (allowing a few bytes for digits in the warning text)');
  });

  it('is deterministic: the same input gives byte-identical output', () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ id: `item-${i}`, text: 'z'.repeat(200) }));
    const a = JSON.stringify(boundEnvelope(envOf(pageOf(items)), ITEMS_PLAN, 9_000));
    const b = JSON.stringify(boundEnvelope(envOf(pageOf(items)), ITEMS_PLAN, 9_000));
    assert.equal(a, b);
  });

  it('does not mark a page as having a continuation when nothing was dropped from the last page', () => {
    const out = boundEnvelope(envOf(pageOf([{ id: 'a' }], 0, null)), ITEMS_PLAN, 10_000);
    assert.equal(out.data?.['nextOffset'], null);
    assert.equal(out.truncated, false);
  });

  it('keeps the existing warnings first and appends the truncation warning', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, text: 'q'.repeat(400) }));
    const out = boundEnvelope(envOf(pageOf(items), { warnings: [{ code: 'SOURCE_NOT_FULL_HISTORY', message: 'first' }] }), ITEMS_PLAN, 9_000);
    assert.deepEqual(out.warnings.map((w) => w.code), ['SOURCE_NOT_FULL_HISTORY', 'RESULT_TRUNCATED']);
  });

  it('prunes ids that only lived in dropped items and keeps those that are still shown or shown elsewhere', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ messageId: `m-${i}`, conversationId: i < 20 ? 'c-first' : 'c-second', text: 'p'.repeat(500) }));
    const ids = { messageIds: items.map((i) => i.messageId), conversationIds: ['c-first', 'c-second', 'c-elsewhere'] };
    const env = envOf({ ...pageOf(items), pinned: 'c-elsewhere' }, { ids });
    const out = boundEnvelope(env, ITEMS_PLAN, 8_300);
    const kept = (out.data?.['items'] as Array<{ messageId: string }>).map((i) => i.messageId);
    assert.ok(kept.length > 0 && kept.length < 40);
    assert.deepEqual(out.ids.messageIds, kept, 'exactly the message ids still shown');
    assert.ok(out.ids.conversationIds?.includes('c-first'));
    assert.ok(out.ids.conversationIds?.includes('c-elsewhere'), 'an id that also occurs outside the list stays');
    assert.equal(out.ids.conversationIds?.includes('c-second'), kept.length > 20, 'c-second is cited only while one of its items is shown');
  });

  it('a thread-style nested list is reduced through its path', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ id: `msg-${i}`, text: 'w'.repeat(400) }));
    const env = envOf({ conversation: { id: 'c' }, thread: { branchId: 'b', messages }, threads: [] });
    const out = boundEnvelope(env, [{ kind: 'list', path: ['thread', 'messages'] }], 8_500);
    const kept = ((out.data?.['thread'] as { messages: unknown[] }).messages).length;
    assert.ok(kept > 0 && kept < 50);
    assert.deepEqual((out.data?.['thread'] as { branchId: string }).branchId, 'b');
    assert.deepEqual(out.data?.['conversation'], { id: 'c' });
  });

  it('plan order is priority order: the first list is emptied before the second is cut', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, text: 'a'.repeat(1000) }));
    const small = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, text: 'b'.repeat(400) })); // 12 KB: too big to fit next to anything
    const env = envOf({ big, small });
    const out = boundEnvelope(env, [{ kind: 'list', path: ['big'] }, { kind: 'list', path: ['small'] }], 8_500);
    assert.equal((out.data?.['big'] as unknown[]).length, 0, 'the whole first list went first: emptied, because that alone was not enough');
    assert.ok((out.data?.['small'] as unknown[]).length > 0);
    assert.ok(bytes(out) <= 8_500);
    assert.equal(out.warnings.filter((w) => w.code === 'RESULT_TRUNCATED').length, 1, 'one warning describes every step');
    // and when the first list alone is enough, the second is untouched
    const light = boundEnvelope(envOf({ big, small: small.slice(0, 5) }), [{ kind: 'list', path: ['big'] }, { kind: 'list', path: ['small'] }], 8_500);
    assert.ok((light.data?.['big'] as unknown[]).length > 0 && (light.data?.['big'] as unknown[]).length < 30);
    assert.equal((light.data?.['small'] as unknown[]).length, 5);
  });

  it('dropping graph nodes drops the edges that would point at nothing', () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, label: 'l'.repeat(200) }));
    const edges = Array.from({ length: 59 }, (_, i) => ({ src: `n${i}`, dst: `n${i + 1}` }));
    const fix: NonNullable<Extract<Reduction, { kind: 'list' }>['fix']> = (container) => {
      const kept = new Set((container['nodes'] as Array<{ id: string }>).map((n) => n.id));
      container['edges'] = (container['edges'] as Array<{ src: string; dst: string }>).filter((e) => kept.has(e.src) && kept.has(e.dst));
      container['truncated'] = true;
    };
    const out = boundEnvelope(envOf({ nodes, edges, truncated: false }), [{ kind: 'list', path: ['nodes'], fix }], 9_000);
    const keptIds = new Set((out.data?.['nodes'] as Array<{ id: string }>).map((n) => n.id));
    for (const e of out.data?.['edges'] as Array<{ src: string; dst: string }>) assert.ok(keptIds.has(e.src) && keptIds.has(e.dst));
    assert.equal(out.data?.['truncated'], true);
  });

  it('a list that cannot fit even when emptied, with nothing else to reduce, becomes an explicit error', () => {
    const out = boundEnvelope(envOf({ items: [{ a: 1 }], huge: 'h'.repeat(20_000) }), ITEMS_PLAN, 8_192);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'INTERNAL_ERROR');
    assert.equal(out.error?.details?.['reason'], 'result_too_large');
    assert.match(out.error?.remedy ?? '', /Narrow/);
    assert.ok(bytes(out) <= 8_192);
  });
});

describe('boundEnvelope: elision of an echoed body', () => {
  it('replaces the string by an empty one and says how large it was; everything else is kept', () => {
    const draft = { draftId: 'd1', bodySha256: 'abc', body: 'B'.repeat(30_000), title: 'T' };
    const out = boundEnvelope(envOf({ localOnly: true, draft }), [{ kind: 'elide', path: ['draft', 'body'] }], 8_192);
    assert.equal(out.ok, true);
    assert.equal(out.truncated, true);
    assert.deepEqual(out.data, { localOnly: true, draft: { ...draft, body: '' } });
    const warning = out.warnings.find((w) => w.code === 'RESULT_TRUNCATED');
    assert.match(warning?.message ?? '', /data\.draft\.body omitted from this response \(30000 bytes; the stored original is unchanged\)/);
  });

  it('a missing or already-empty target is skipped, not an error', () => {
    const out = boundEnvelope(envOf({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, t: 'x'.repeat(100) })) }), [{ kind: 'elide', path: ['nothing', 'here'] }, ...ITEMS_PLAN], 8_192);
    assert.equal(out.ok, true);
    assert.ok(bytes(out) <= 8_192);
  });
});

describe('boundEnvelope: errors', () => {
  it('an error whose details are too large keeps its code and message and loses only the details', () => {
    const big = errorEnvelope(new GcrError('ACTIVE_BRANCH_UNKNOWN', 'unknown active', { remedy: 'r'.repeat(10), details: { branchIds: Array.from({ length: 2000 }, (_, i) => `branch-${i}`.padEnd(30, 'x')) } }));
    assert.ok(bytes(big) > 8_192);
    const out = boundEnvelope(big, [], 8_192);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'ACTIVE_BRANCH_UNKNOWN');
    assert.equal(out.error?.message, 'unknown active');
    assert.equal(out.error?.details, undefined);
    assert.ok(bytes(out) <= 8_192);
  });
});

describe('boundEnvelope: properties', () => {
  const itemArb = fc.record({ id: fc.stringMatching(/^[a-z0-9]{1,12}$/), text: fc.string({ minLength: 0, maxLength: 2500 }) });

  it('whatever the sizes: valid JSON within the cap, a prefix of the original, deterministic, never silent', () => {
    fc.assert(
      fc.property(fc.array(itemArb, { minLength: 0, maxLength: 120 }), fc.integer({ min: 8_192, max: 60_000 }), fc.integer({ min: 0, max: 50 }), (items, cap, offset) => {
        const env = envOf(pageOf(items, offset, items.length > 0 ? offset + items.length : null), {
          ids: { messageIds: items.map((i) => i.id) },
        });
        const out = boundEnvelope(env, ITEMS_PLAN, cap);
        assert.ok(bytes(out) <= cap, 'within the cap');
        assert.deepEqual(JSON.parse(JSON.stringify(out)), JSON.parse(JSON.stringify(out)));
        assert.equal(JSON.stringify(boundEnvelope(env, ITEMS_PLAN, cap)), JSON.stringify(out), 'deterministic');
        if (bytes(env) <= cap) {
          assert.equal(out, env);
          return;
        }
        if (!out.ok) {
          assert.equal(out.error?.code, 'INTERNAL_ERROR');
          return;
        }
        assert.equal(out.truncated, true);
        const kept = out.data?.['items'] as Array<{ id: string; text: string }>;
        assert.ok(kept.length < items.length);
        assert.deepEqual(kept, items.slice(0, kept.length), 'a prefix');
        assert.ok(out.warnings.some((w) => w.code === 'RESULT_TRUNCATED'), 'never silent');
        assert.equal(out.data?.['nextOffset'], offset + kept.length);
        // ids: exactly the ids of shown items (item ids are unique here only when no duplicates; compare as sets)
        const shown = new Set(kept.map((i) => i.id));
        for (const id of out.ids.messageIds ?? []) assert.ok(shown.has(id), 'no id of a dropped item is cited');
        for (const id of shown) assert.ok((out.ids.messageIds ?? []).includes(id), 'every shown id is still cited');
      }),
      { seed: 20261010, numRuns: 150 },
    );
  });
});

describe('fixPage', () => {
  it('moves nextOffset to offset + kept and removes the cursor, only when something was dropped', () => {
    const cut = { offset: 10, nextOffset: 30, nextCursor: 'c', items: [] };
    fixPage(cut, 5, 20);
    assert.deepEqual(cut, { offset: 10, nextOffset: 15, items: [] });
    const whole = { offset: 10, nextOffset: 30, nextCursor: 'c' };
    fixPage(whole, 20, 20);
    assert.deepEqual(whole, { offset: 10, nextOffset: 30, nextCursor: 'c' });
    const noOffset = { nextOffset: null } as Record<string, unknown>;
    fixPage(noOffset, 3, 9);
    assert.equal(noOffset['nextOffset'], 3);
  });
});
