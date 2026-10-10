/**
 * Scale and resource behaviour (NFR-05): a 50k-message conversation, huge fan-out, very deep chains, very large single
 * messages, very deep JSON nesting. Inputs are generated at test time (never committed). Timing bounds are generous
 * (CI machines vary); the point is "linear, no recursion, bounded memory", not a benchmark.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import { analyzeTree } from '../../src/domain/branches.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { MAX_TEXT_BYTES, validateConversationRecord } from '../../src/domain/validate.js';
import { chatGptExportAdapter } from '../../src/ingest/chatgpt-export.js';
import { BASE_UNIX_SECONDS, adapterContext, linearConversationText, ordered, stringify, syntheticUuid } from '../helpers/chatgpt-export-builder.js';

const ctx = adapterContext();

/** `gc()` without the --expose-gc flag, so heap measurements are comparable. */
function makeGc(): () => void {
  v8.setFlagsFromString('--expose-gc');
  const g = vm.runInNewContext('gc') as () => void;
  return g;
}
const gc = makeGc();

function normalize(text: string): ConversationRecord {
  const out = chatGptExportAdapter.normalizeElementText(text, ctx, 0);
  assert.equal(out.kind, 'record');
  if (out.kind !== 'record') throw new Error('unreachable');
  return out.record;
}

function timed<T>(f: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = f();
  return { value, ms: performance.now() - t0 };
}

describe('50,000-message conversation (NFR-05 baseline)', () => {
  for (const omitChildren of [false, true]) {
    it(`converts, validates and analyses in linear time with bounded memory (children ${omitChildren ? 'absent' : 'present'})`, () => {
      const text = linearConversationText(50_000, { omitChildren });
      gc();
      const before = process.memoryUsage().heapUsed;
      const { value: rec, ms } = timed(() => normalize(text));
      gc();
      const retained = process.memoryUsage().heapUsed - before;

      assert.equal(rec.messages.length, 50_001);
      assert.equal(rec.completeness, 'exported_tree');
      assert.equal(rec.currentNodeId, 'm49999');
      assert.ok(ms < 15_000, `normalize took ${ms.toFixed(0)} ms`);
      // the record (every message, block, raw object) plus the input must stay within a small multiple of the input size
      assert.ok(retained < text.length * 12 + 50_000_000, `retained heap ${(retained / 1e6).toFixed(0)} MB for ${(text.length / 1e6).toFixed(1)} MB of input`);

      const v = timed(() => validateConversationRecord(rec));
      assert.ok(v.ms < 15_000, `validate took ${v.ms.toFixed(0)} ms`);
      const a = timed(() => analyzeTree(rec.id, rec.messages, rec.currentNodeId));
      assert.ok(a.ms < 15_000, `analyze took ${a.ms.toFixed(0)} ms`);
      assert.equal(a.value.branches.length, 1);
      assert.equal(a.value.activeBranchId, 'm49999');
      assert.equal(a.value.branches[0]?.path.length, 50_001);
      assert.deepEqual(a.value.warnings, []);
      const absent = rec.warnings.filter((w) => w.code === 'CHILDREN_ABSENT').length;
      assert.equal(absent, omitChildren ? 1 : 0);
    });
  }

  it('500 conversations of 100 messages each (the 5-shard shape of the benchmark) convert quickly in total', () => {
    const texts = Array.from({ length: 500 }, (_, i) => linearConversationText(100, { id: syntheticUuid(0x100 + i), omitChildren: i % 2 === 0 }));
    const { ms } = timed(() => {
      for (const [i, t] of texts.entries()) {
        const out = chatGptExportAdapter.normalizeElementText(t, ctx, i);
        assert.equal(out.kind, 'record');
        if (out.kind === 'record') assert.equal(out.record.messages.length, 101);
      }
    });
    assert.ok(ms < 15_000, `took ${ms.toFixed(0)} ms`);
  });
});

describe('shapes that break naive implementations', () => {
  it('a chain of 100,000 nodes converts without recursion and the tree analysis agrees', () => {
    const rec = normalize(linearConversationText(100_000));
    assert.equal(rec.messages.length, 100_001);
    assert.equal(rec.completeness, 'exported_tree');
    const t = analyzeTree(rec.id, rec.messages, rec.currentNodeId);
    assert.equal(t.branches.length, 1);
  });

  it('a node with 10,000 children (declared and derived) is linear and keeps every child once', () => {
    for (const declared of [true, false]) {
      const kids = Array.from({ length: 10_000 }, (_, i) => `k${i}`);
      const entries: Array<[string, unknown]> = [['root', { id: 'root', parent: null, message: null, ...(declared ? { children: kids } : {}) }]];
      for (const k of kids) entries.push([k, { id: k, parent: 'root', message: { id: k, author: { role: 'user' }, create_time: BASE_UNIX_SECONDS + Number(k.slice(1)), content: { content_type: 'text', parts: [k] } }, ...(declared ? { children: [] } : {}) }]);
      const text = stringify({ id: 'fan', current_node: 'k9999', mapping: ordered(entries) });
      const { value: rec, ms } = timed(() => normalize(text));
      assert.ok(ms < 10_000, `took ${ms.toFixed(0)} ms`);
      const root = rec.messages[0];
      assert.equal(root?.childIds.length, 10_000);
      assert.equal(new Set(root?.childIds).size, 10_000);
      assert.deepEqual(root?.childIds.slice(0, 3), ['k0', 'k1', 'k2']);
      const t = analyzeTree(rec.id, rec.messages, rec.currentNodeId);
      assert.equal(t.branches.length, 10_000);
      assert.deepEqual(t.warnings, []);
    }
  });

  it('a node with 200,000 duplicate entries in its children list is deduplicated in linear time', () => {
    const kids = Array.from({ length: 200_000 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'));
    const text = stringify({ id: 'dupkids', current_node: 'a', mapping: ordered([['p', { id: 'p', parent: null, message: null, children: kids }], ['a', { id: 'a', parent: 'p', message: null, children: [] }], ['b', { id: 'b', parent: 'p', message: null, children: [] }]]) });
    const { value: rec, ms } = timed(() => normalize(text));
    assert.deepEqual(rec.messages[0]?.childIds, ['a', 'b']);
    assert.ok(rec.warnings.some((w) => w.code === 'DUPLICATE_CHILD_ENTRY'));
    assert.ok(ms < 5_000);
  });

  it('a cycle of 100,000 nodes (no root) is found without recursion and reported through completeness', () => {
    const n = 100_000;
    const entries: Array<[string, unknown]> = Array.from({ length: n }, (_, i) => [`c${i}`, { id: `c${i}`, parent: `c${(i + 1) % n}`, message: null }]);
    const text = stringify({ id: 'cyc', current_node: 'c0', mapping: ordered(entries) });
    const { value: rec, ms } = timed(() => normalize(text));
    assert.equal(rec.completeness, 'unknown');
    assert.match(rec.warnings.find((w) => w.code === 'COMPLETENESS_LOWERED')?.message ?? '', /cycle/);
    assert.ok(ms < 10_000, `took ${ms.toFixed(0)} ms`);
    const t = analyzeTree(rec.id, rec.messages, rec.currentNodeId);
    assert.equal(t.unreachableIds.length, n);
  });

  it('JSON nested 200,000 levels deep inside metadata does not overflow the adapter or the scanner', () => {
    const depth = 200_000;
    const deep = '['.repeat(depth) + ']'.repeat(depth);
    const text = `{"id":"deep","current_node":"m","mapping":{"m":{"id":"m","parent":null,"message":{"id":"m","author":{"role":"user"},"content":{"content_type":"text","parts":["still readable"]},"metadata":{"deep":${deep}}}},"after":{"id":"after","parent":null,"message":null}}}`;
    const { value: rec, ms } = timed(() => normalize(text));
    assert.deepEqual(rec.messages.map((m) => m.id), ['m', 'after']);
    assert.equal(rec.messages[0]?.text, 'still readable');
    assert.ok(ms < 10_000, `took ${ms.toFixed(0)} ms`);
    // The record validates (rawSource is opaque to the validator). Serializing rawSource is the DB layer's job and needs its own depth guard.
    validateConversationRecord(rec);
  });

  it('nodes with 5,000 distinct keys each in message objects (wide, not deep) are fine', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i;
    const text = stringify({ id: 'wide', current_node: 'm', mapping: ordered([['m', { id: 'm', parent: null, message: { id: 'm', author: { role: 'user' }, content: { content_type: 'text', parts: ['x'] }, metadata: wide } }]]) });
    const rec = normalize(text);
    assert.deepEqual(rec.warnings, []);
  });
});

describe('very large single messages', () => {
  it('a 50 MB message is accepted untruncated; memory stays bounded; the text is the same string (no copy)', () => {
    const big = 'a'.repeat(50 * 1024 * 1024);
    const text = `{"id":"big","current_node":"m","mapping":{"m":{"id":"m","parent":null,"message":{"id":"m","author":{"role":"user"},"content":{"content_type":"text","parts":["${big}"]}}}}}`;
    gc();
    const before = process.memoryUsage().heapUsed + process.memoryUsage().external;
    const { value: rec, ms } = timed(() => normalize(text));
    gc();
    const retained = process.memoryUsage().heapUsed + process.memoryUsage().external - before;
    const m = rec.messages[0];
    assert.equal(m?.text.length, big.length);
    assert.ok(!rec.warnings.some((w) => w.code === 'TEXT_TRUNCATED'));
    assert.equal(m?.blocks[0]?.text, m?.text);
    assert.ok(ms < 15_000, `took ${ms.toFixed(0)} ms`);
    assert.ok(retained < 4 * big.length + 100_000_000, `retained ${(retained / 1e6).toFixed(0)} MB`);
    validateConversationRecord(rec);
  });

  it('a 50 MB message made of escapes (é as \\u00e9) is accepted: its text is 50 MB of characters, ~100 MB of UTF-8', () => {
    const chars = 26_000_000; // 52 MB of text as characters, 52 MB as UTF-8 (2 bytes each) = ~52 MB < 64 MiB
    const text = `{"id":"esc","current_node":"m","mapping":{"m":{"id":"m","parent":null,"message":{"id":"m","author":{"role":"user"},"content":{"content_type":"text","parts":["${'\\u00e9'.repeat(chars)}"]}}}}}`;
    const { value: rec, ms } = timed(() => normalize(text));
    assert.equal(rec.messages[0]?.text.length, chars);
    assert.ok(!rec.warnings.some((w) => w.code === 'TEXT_TRUNCATED'));
    assert.ok(ms < 20_000, `took ${ms.toFixed(0)} ms`);
  });

  it('text beyond the 64 MiB domain limit is truncated at a character boundary with TEXT_TRUNCATED, and the record still validates', () => {
    const big = 'é'.repeat(34 * 1024 * 1024); // 2 bytes each = 68 MiB
    const text = `{"id":"huge","current_node":"m","mapping":{"m":{"id":"m","parent":null,"message":{"id":"m","author":{"role":"user"},"content":{"content_type":"text","parts":["${big}"]}}}}}`;
    const { value: rec, ms } = timed(() => normalize(text));
    const m = rec.messages[0];
    assert.ok(m);
    assert.ok(Buffer.byteLength(m.text) <= MAX_TEXT_BYTES);
    assert.equal(m.text.length, MAX_TEXT_BYTES / 2, 'filled up to the limit with whole characters');
    assert.equal(m.blocks[0]?.text, m.text);
    assert.ok(rec.warnings.some((w) => w.code === 'TEXT_TRUNCATED'));
    assert.ok(ms < 20_000, `took ${ms.toFixed(0)} ms`);
    validateConversationRecord(rec);
    assert.equal((((m.rawSource as Record<string, unknown>)['content'] as Record<string, unknown>)['parts'] as string[])[0]?.length, big.length, 'the raw value keeps the full text');
  });

  it('the default node cap (500,000) is enforced on a real conversation of 500,001 nodes', () => {
    const n = 500_001;
    const parts: string[] = new Array<string>(n);
    for (let i = 0; i < n; i++) parts[i] = `"n${i}":{"id":"n${i}","parent":null,"message":null}`;
    const text = `{"id":"cap","current_node":"n0","mapping":{${parts.join(',')}}}`;
    const { value: rec, ms } = timed(() => normalize(text));
    assert.equal(rec.messages.length, 500_000);
    assert.equal(rec.messages[499_999]?.id, 'n499999');
    assert.ok(rec.warnings.some((w) => w.code === 'TOO_MANY_NODES'));
    assert.equal(rec.completeness, 'unknown');
    assert.ok(ms < 25_000, `took ${ms.toFixed(0)} ms`);
  });
});
