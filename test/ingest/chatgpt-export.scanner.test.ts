/**
 * The raw-text pre-pass (scanConversationElement): duplicate keys, key order, prototype-pollution names, integer-like
 * ids, string look-alikes, nesting depth, plus its use inside the adapter (DUPLICATE_NODE_ID, ordinals).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { validateConversationRecord } from '../../src/domain/validate.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { ChatGPTExportAdapter, chatGptExportAdapter, resolveNodeOrder, scanConversationElement } from '../../src/ingest/chatgpt-export.js';
import type { ElementScan } from '../../src/ingest/chatgpt-export.js';
import { ConversationBuilder, adapterContext, contents, ordered, stringify, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { RawObject } from '../helpers/chatgpt-export-builder.js';

const SEED = 20261012;
const ctx = adapterContext();

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 300): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}
function rec(text: string): ConversationRecord {
  const out = chatGptExportAdapter.normalizeElementText(text, ctx, 0);
  assert.equal(out.kind, 'record');
  if (out.kind !== 'record') throw new Error('unreachable');
  return validateConversationRecord(out.record);
}

describe('scanConversationElement: key order', () => {
  it('reports mapping keys in FILE order; JSON.parse would reorder integer-like keys (which is why the scan exists)', () => {
    const text = '{"id":"c","mapping":{"b":{},"2":{},"1":{},"a":{},"10":{},"9":{}}}';
    assert.deepEqual(scanConversationElement(text).mappingKeys, ['b', '2', '1', 'a', '10', '9']);
    assert.deepEqual(Object.keys((JSON.parse(text) as { mapping: object }).mapping), ['1', '2', '9', '10', 'b', 'a']);
  });

  it('works for minified, pretty-printed and odd-whitespace text', () => {
    const body = '{"mapping":{"x":{"a":[1,2,{"b":"}"}]},"y":null,"z":"{"}}';
    const pretty = JSON.stringify(JSON.parse(body), null, 3);
    const spaced = body.replaceAll(',', ' ,\r\n\t').replaceAll(':', ' : ');
    for (const t of [body, pretty, spaced]) assert.deepEqual(scanConversationElement(t).mappingKeys, ['x', 'y', 'z']);
  });

  it('no mapping, mapping not an object, or empty mapping', () => {
    assert.equal(scanConversationElement('{"id":"c"}').mappingKeys, null);
    assert.equal(scanConversationElement('{"mapping":null}').mappingKeys, null);
    assert.equal(scanConversationElement('{"mapping":[{"a":1}]}').mappingKeys, null);
    assert.equal(scanConversationElement('{"mapping":"str"}').mappingKeys, null);
    assert.deepEqual(scanConversationElement('{"mapping":{}}').mappingKeys, []);
  });

  it('only the top-level "mapping" counts; nested objects named mapping are ignored', () => {
    assert.deepEqual(scanConversationElement('{"meta":{"mapping":{"zzz":{}}},"mapping":{"a":{}}}').mappingKeys, ['a']);
    assert.deepEqual(scanConversationElement('{"mapping":{"n":{"mapping":{"inner":{}}}}}').mappingKeys, ['n']);
    assert.deepEqual(scanConversationElement('{"list":[{"mapping":{"q":1}}],"mapping":{"a":1}}').mappingKeys, ['a']);
    assert.equal(scanConversationElement('{"meta":{"mapping":{"zzz":{}}}}').mappingKeys, null);
  });

  it('when "mapping" occurs twice the LAST one wins (like JSON.parse); the repeat is a conversation-level duplicate', () => {
    const t = '{"mapping":{"a":{}},"x":1,"mapping":{"b":{},"c":{}}}';
    const s = scanConversationElement(t);
    assert.deepEqual(s.mappingKeys, ['b', 'c']);
    assert.equal(s.conversationKeyDuplicates, 1);
    assert.deepEqual(Object.keys((JSON.parse(t) as { mapping: object }).mapping), ['b', 'c']);
    assert.equal(scanConversationElement('{"mapping":{"a":{}},"mapping":null}').mappingKeys, null);
    assert.deepEqual(scanConversationElement('{"mapping":[1],"mapping":{"k":{}}}').mappingKeys, ['k']);
    // duplicates inside the shadowed first mapping do not leak into the result
    const shadow = scanConversationElement('{"mapping":{"d":{},"d":{}},"mapping":{"e":{}}}');
    assert.deepEqual(shadow.duplicateMappingKeys, []);
  });
});

describe('scanConversationElement: duplicates', () => {
  it('detects a duplicated node id and hashes every body from its exact source text', () => {
    const t = '{"mapping":{"x":{"a":1},"y":{},"x":{"a":2},"x":{ "a" : 3 }}}';
    const s = scanConversationElement(t);
    assert.deepEqual(s.mappingKeys, ['x', 'y']);
    assert.deepEqual(s.duplicateMappingKeys, ['x']);
    assert.deepEqual(s.duplicateBodySha256.get('x'), [sha256('{"a":1}'), sha256('{"a":2}'), sha256('{ "a" : 3 }')]);
    assert.equal(s.duplicateBodySha256.has('y'), false);
  });

  it('non-object bodies are counted as duplicates but not hashed', () => {
    const s = scanConversationElement('{"mapping":{"x":1,"x":{"a":1},"z":null,"z":null}}');
    assert.deepEqual(s.duplicateMappingKeys, ['x', 'z']);
    assert.deepEqual(s.duplicateBodySha256.get('x'), [sha256('{"a":1}')]);
    assert.equal(s.duplicateBodySha256.has('z'), false);
  });

  it('keys are compared after unescaping: "a\\u0062" and "ab" are the same key', () => {
    const s = scanConversationElement('{"mapping":{"a\\u0062":{},"ab":{},"\\u00e9":{},"é":{},"q\\"":{},"q\\u0022":{}}}');
    assert.deepEqual(s.mappingKeys, ['ab', 'é', 'q"']);
    assert.deepEqual(s.duplicateMappingKeys, ['ab', 'é', 'q"']);
  });

  it('distinct keys that merely look alike are not duplicates (case, prefix, whitespace, escapes of the backslash)', () => {
    const s = scanConversationElement('{"mapping":{"A":{},"a":{},"a ":{}," a":{},"a\\\\":{},"a\\\\\\\\":{},"":{},"\\u0000":{}}}');
    assert.deepEqual(s.duplicateMappingKeys, []);
    assert.equal(s.mappingKeys?.length, 8);
    assert.deepEqual(s.mappingKeys, ['A', 'a', 'a ', ' a', 'a\\', 'a\\\\', '', '\u0000']);
  });

  it('duplicate keys that only exist INSIDE string values are never reported', () => {
    const nasty = ['{"a":1,"a":2}', '\\"a\\":1,\\"a\\":2', '\\', '\\\\', '"', '\\"', '" , "', '}{][', '"mapping":{"k":1,"k":2}', '\\\\"a":1,"a":2', 'a","a'];
    for (const n of nasty) {
      const t = stringify({ id: 'c', title: n, mapping: ordered([['n1', { id: 'n1', message: { content: { parts: [n, n] } }, parent: null }], ['n2', { note: n, parent: 'n1' }]]) });
      const s = scanConversationElement(t);
      assert.deepEqual(s.mappingKeys, ['n1', 'n2'], n);
      assert.deepEqual(s.duplicateMappingKeys, [], n);
      assert.equal(s.nodeKeyDuplicates.size, 0, n);
      assert.equal(s.conversationKeyDuplicates, 0, n);
    }
  });

  it('counts duplicate keys inside node objects (attributed to the node) and in the conversation object', () => {
    const t = '{"title":"a","title":"b","voice":{"k":1,"k":2},"mapping":{"n1":{"message":{"content":{"content_type":"a","content_type":"b"}}},"n2":{"x":1,"x":2,"x":3},"n3":{"parts":[{"a":1,"a":2},{"a":1}]}}}';
    const s = scanConversationElement(t);
    assert.equal(s.conversationKeyDuplicates, 2);
    assert.deepEqual([...s.nodeKeyDuplicates], [['n1', 1], ['n2', 2], ['n3', 1]]);
    assert.deepEqual(s.duplicateMappingKeys, []);
  });

  it('the same key in sibling objects is not a duplicate', () => {
    const s = scanConversationElement('{"mapping":{"n":{"a":{"k":1},"b":{"k":2},"c":[{"k":1},{"k":2}]}},"x":{"k":1},"y":{"k":2}}');
    assert.equal(s.nodeKeyDuplicates.size, 0);
    assert.equal(s.conversationKeyDuplicates, 0);
  });

  it('large objects (> 16 keys, set-backed) still detect duplicates', () => {
    const entries: Array<[string, unknown]> = Array.from({ length: 40 }, (_, i) => [`k${i}`, i]);
    entries.push(['k7', 'again'], ['k39', 'again']);
    const t = stringify({ mapping: ordered([['n', ordered(entries)]]) });
    assert.deepEqual([...scanConversationElement(t).nodeKeyDuplicates], [['n', 2]]);
  });
});

describe('scanConversationElement: robustness', () => {
  it('survives 200,000-deep nesting inside a node (iterative, no stack overflow) and keeps scanning afterwards', () => {
    const depth = 200_000;
    const deep = '['.repeat(depth) + ']'.repeat(depth);
    const t = `{"mapping":{"n1":{"metadata":${deep},"x":1,"x":2},"n2":{"k":1,"k":2}}}`;
    const s = scanConversationElement(t);
    assert.deepEqual(s.mappingKeys, ['n1', 'n2']);
    // `x` is duplicated at shallow depth and still found; anything inside the untracked depths is skipped by design
    assert.equal(s.nodeKeyDuplicates.get('n1'), 1);
    assert.equal(s.nodeKeyDuplicates.get('n2'), 1);
    const deepObj = '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000);
    assert.deepEqual(scanConversationElement(`{"mapping":{"n":${deepObj},"m":{}}}`).mappingKeys, ['n', 'm']);
  });

  it('is linear: a 30 MB string value is skipped without trouble', () => {
    const big = 'x'.repeat(30 * 1024 * 1024);
    const t0 = performance.now();
    const s = scanConversationElement(`{"mapping":{"n":{"text":"${big}"}},"after":1}`);
    assert.deepEqual(s.mappingKeys, ['n']);
    assert.ok(performance.now() - t0 < 5000);
  });

  it('long runs of backslashes before a quote are handled by parity (pathological but valid JSON)', () => {
    const slashes = '\\\\'.repeat(5000); // 5000 escaped backslashes, then a real closing quote
    const t = `{"mapping":{"k${slashes}":{"a":1,"a":2}}}`;
    const s = scanConversationElement(t);
    assert.deepEqual(s.mappingKeys, [`k${'\\'.repeat(5000)}`]);
    assert.equal(s.nodeKeyDuplicates.size, 1);
  });
});

describe('scanConversationElement: differential property tests', () => {
  const keyPool = fc.oneof(
    fc.constantFrom('a', 'b', 'c', '__proto__', 'constructor', 'toString', '10', '9', '2', '1', '', ' ', 'é', '"', '\\', 'a"b', '\u0000', ' ', '日本語'),
    fc.string({ maxLength: 6, unit: 'grapheme' }),
    fc.string({ maxLength: 4 }),
  );
  const jsonLeaf = fc.oneof(fc.constant(null), fc.boolean(), fc.integer(), fc.string({ maxLength: 12 }), fc.constantFrom('{"a":1,"a":2}', '\\', '"', '}{'));

  it('mapping keys and duplicate sets agree with a reference model and with JSON.parse', () => {
    const entry = fc.tuple(keyPool, fc.oneof(jsonLeaf, fc.constant('OBJ')));
    runProperty(
      fc.property(fc.array(entry, { maxLength: 24 }), fc.array(fc.tuple(keyPool, jsonLeaf), { maxLength: 4 }), (entries, rootExtra) => {
        // each 'OBJ' becomes an object with possibly repeated keys, so node-level duplicates are exercised too
        const nodeDupExpected = new Map<string, number>();
        const mapped: Array<[string, unknown]> = entries.map(([k, v], i) => {
          if (v !== 'OBJ') return [k, v];
          const inner: Array<[string, unknown]> = [['x', i], ['y', i], ['x', 'again']];
          if (i % 2 === 0) inner.pop();
          return [k, ordered(inner)];
        });
        // reference: first-occurrence order, duplicate set, per-node duplicate counts (last occurrence of a key defines its value, but
        // every OBJECT body, shadowed or not, is scanned, so count duplicates for every object occurrence under that key)
        const distinct: string[] = [];
        const dupSet: string[] = [];
        const seen = new Set<string>();
        for (const [k] of mapped) {
          if (!seen.has(k)) {
            seen.add(k);
            distinct.push(k);
          } else if (!dupSet.includes(k)) dupSet.push(k);
        }
        mapped.forEach(([k, v], i) => {
          if (v instanceof Object && Array.isArray((v as { entries?: unknown }).entries)) {
            const extra = i % 2 === 0 ? 0 : 1;
            if (extra > 0) nodeDupExpected.set(k, (nodeDupExpected.get(k) ?? 0) + extra);
          }
        });
        const text = stringify({ a_first: 1, mapping: ordered(mapped), ...Object.fromEntries(rootExtra.filter(([k]) => k !== 'mapping' && k !== '__proto__')) });
        const s = scanConversationElement(text);
        assert.deepEqual(s.mappingKeys, distinct);
        assert.deepEqual(s.duplicateMappingKeys, dupSet);
        assert.deepEqual(s.nodeKeyDuplicates, nodeDupExpected);
        const parsed = (JSON.parse(text) as { mapping: Record<string, unknown> }).mapping;
        assert.deepEqual(new Set(Object.keys(parsed)), new Set(distinct), 'same key SET as the JS engine');
        assert.equal(resolveNodeOrder(s.mappingKeys, parsed).fallback, false);
      }),
    );
  });

  it('any valid JSON text scans without throwing (even when it is not a conversation)', () => {
    runProperty(
      fc.property(fc.jsonValue(), (v) => {
        const s = scanConversationElement(JSON.stringify(v));
        assert.ok(s.mappingKeys === null || Array.isArray(s.mappingKeys));
      }),
      500,
    );
  });

  it('scan of a real conversation object always reproduces Object.keys as a set, in insertion order', () => {
    runProperty(
      fc.property(fc.uniqueArray(keyPool, { maxLength: 30 }), (keys) => {
        const text = stringify({ mapping: ordered(keys.map((k) => [k, { id: k }] as [string, unknown])) });
        const s = scanConversationElement(text);
        assert.deepEqual(s.mappingKeys, keys, 'exact file order');
      }),
    );
  });
});

describe('scanConversationElement: nesting depth', () => {
  it('maxDepth counts container nesting; the conversation object itself is depth 1', () => {
    assert.equal(scanConversationElement('{}').maxDepth, 1);
    assert.equal(scanConversationElement('{"a":1}').maxDepth, 1);
    assert.equal(scanConversationElement('{"a":[]}').maxDepth, 2);
    assert.equal(scanConversationElement('{"mapping":{"n":{"m":{"c":{"parts":["x"]}}}}}').maxDepth, 6);
    assert.equal(scanConversationElement('{"a":{"b":{}},"c":[[[1]]]}').maxDepth, 4);
    assert.equal(scanConversationElement('{"a":"{[[[[[[[[[[[[[[[[[[[[[[[[[[["}').maxDepth, 1, 'brackets inside strings do not count');
  });
  it('is exact beyond the tracked depth (million-level nesting)', () => {
    const d = 1_000_000;
    assert.equal(scanConversationElement(`{"x":${'['.repeat(d)}${']'.repeat(d)}}`).maxDepth, d + 1);
  });
  it('matches an independent depth computation on random JSON', () => {
    const depthOf = (v: unknown): number => (typeof v === 'object' && v !== null ? 1 + Math.max(0, ...Object.values(v).map(depthOf)) : 0);
    runProperty(
      fc.property(fc.object({ maxDepth: 6 }), (o) => {
        assert.equal(scanConversationElement(JSON.stringify(o)).maxDepth, depthOf(o));
      }),
    );
  });
});

describe('resolveNodeOrder', () => {
  it('uses the scan order when it agrees with the parsed object', () => {
    const o = { b: 1, a: 2 };
    const r = resolveNodeOrder(['b', 'a'], o);
    assert.deepEqual(r, { keys: ['b', 'a'], fallback: false });
  });
  it('falls back to the engine order when the scan is missing, has another size, or names an absent key', () => {
    const o = { 1: 'x', b: 'y' };
    assert.deepEqual(resolveNodeOrder(null, o), { keys: ['1', 'b'], fallback: true });
    assert.deepEqual(resolveNodeOrder(['b'], o), { keys: ['1', 'b'], fallback: true });
    assert.deepEqual(resolveNodeOrder(['b', 'zzz'], o), { keys: ['1', 'b'], fallback: true });
  });
  it('the returned array is a copy: mutating it cannot corrupt the scan result', () => {
    const scan = ['a'];
    const r = resolveNodeOrder(scan, { a: 1 });
    r.keys.push('x');
    assert.deepEqual(scan, ['a']);
  });
});

describe('adapter: duplicates and ordering end to end', () => {
  it('KEY_ORDER_FALLBACK: an inconsistent scanner result falls back to the engine order and says so', () => {
    const bad: ElementScan = { mappingKeys: ['b'], duplicateMappingKeys: [], duplicateBodySha256: new Map(), nodeKeyDuplicates: new Map(), conversationKeyDuplicates: 0, maxDepth: 1 };
    const adapter = new ChatGPTExportAdapter({ scanner: () => bad });
    const text = '{"id":"c","mapping":{"b":{"id":"b","parent":null,"message":null},"1":{"id":"1","parent":null,"message":null}}}';
    const out = adapter.normalizeElementText(text, ctx, 0);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.deepEqual(out.record.messages.map((m) => m.id), ['1', 'b']);
    assert.ok(out.record.warnings.some((w) => w.code === 'KEY_ORDER_FALLBACK'));
  });

  it('ordinals and message order follow the file for integer-like ids and Object.prototype names', () => {
    const t = '{"id":"c","current_node":null,"mapping":{"10":{"id":"10","parent":null,"message":null},"__proto__":{"id":"__proto__","parent":"10","message":null},"9":{"id":"9","parent":null,"message":null},"constructor":{"id":"constructor","parent":"9","message":null},"toString":{"id":"toString","parent":"constructor","message":null},"2":{"id":"2","parent":null,"message":null}}}';
    const r = rec(t);
    assert.deepEqual(r.messages.map((m) => m.id), ['10', '__proto__', '9', 'constructor', 'toString', '2']);
    assert.deepEqual(r.messages.map((m) => m.ordinal), [0, 1, 2, 3, 4, 5]);
    assert.equal(r.messages[1]?.parentId, '10');
    assert.deepEqual(r.messages[0]?.childIds, ['__proto__'], 'a "__proto__" id works as an ordinary child id');
    assert.equal(r.messages[4]?.parentId, 'constructor');
    assert.equal(Object.getPrototypeOf(r.messages[1]), Object.prototype);
    assert.equal(({} as RawObject)['id'], undefined);
  });

  it('a parent pointer or current_node named after an Object.prototype member resolves only when that key exists', () => {
    const noKey = rec('{"id":"c","current_node":"toString","mapping":{"a":{"id":"a","parent":"constructor","message":null}}}');
    assert.equal(noKey.currentNodeId, null, '"toString" is not a key of this mapping, even though every object inherits it');
    assert.equal(noKey.messages[0]?.parentId, 'constructor');
    assert.equal(noKey.completeness, 'unknown');
    const withKey = rec('{"id":"c","current_node":"toString","mapping":{"toString":{"id":"toString","parent":null,"message":null}}}');
    assert.equal(withKey.currentNodeId, 'toString');
  });

  it('DUPLICATE_NODE_ID: warns with ids only, last body wins, bodies are hashed, completeness is lowered', () => {
    const first = '{"id":"dup","parent":null,"children":[],"message":{"id":"dup","author":{"role":"user"},"content":{"content_type":"text","parts":["CANARY-FIRST-BODY"]}}}';
    const second = '{"id":"dup","parent":null,"children":[],"message":{"id":"dup","author":{"role":"assistant"},"content":{"content_type":"text","parts":["CANARY-SECOND-BODY"]}}}';
    const third = '{"id":"dup","parent":null,"children":[],"message":null}';
    const t = `{"id":"c","current_node":"dup","mapping":{"dup":${first},"other":{"id":"other","parent":null,"message":null},"dup":${second},"dup":${third}}}`;
    const r = rec(t);
    assert.equal(r.messages.length, 2);
    assert.deepEqual(r.messages.map((m) => m.id), ['dup', 'other'], 'position of the first occurrence');
    assert.equal(r.messages[0]?.nodeKind, 'structural_empty', 'the LAST body wins');
    const w = r.warnings.find((x) => x.code === 'DUPLICATE_NODE_ID');
    assert.deepEqual(w?.ids, ['dup']);
    assert.ok(!JSON.stringify(r.warnings).includes('CANARY'), 'warnings carry no content');
    const hashes = ((r.rawMetadata as RawObject)['_gcr'] as RawObject)['duplicateNodeBodySha256'] as Array<{ id: string; bodySha256: string[] }>;
    assert.deepEqual(hashes, [{ id: 'dup', bodySha256: [sha256(first), sha256(second), sha256(third)] }]);
    assert.equal(r.completeness, 'unknown');
    assert.match(r.warnings.find((x) => x.code === 'COMPLETENESS_LOWERED')?.message ?? '', /duplicate_node_id/);
  });

  it('a duplicated UNUSABLE node id is reported under its stand-in id', () => {
    const t = '{"id":"c","current_node":null,"mapping":{"bad\\u0001":{"id":"x","parent":null,"message":null},"bad\\u0001":{"id":"x","parent":null,"message":null}}}';
    const r = rec(t);
    assert.equal(r.messages.length, 1);
    const w = r.warnings.find((x) => x.code === 'DUPLICATE_NODE_ID');
    assert.deepEqual(w?.ids, [r.messages[0]?.id]);
  });

  it('DUPLICATE_KEY: duplicates elsewhere are reported against the node (or conversation) with a count, never with key names', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    b.message(b.root(), 'user', ordered([['content_type', 'text'], ['content_type', 'text'], ['parts', ['hi']]]), { id: 'n1' });
    const r = rec(b.text().replace('"title"', '"title":"first","title"'));
    const w = r.warnings.find((x) => x.code === 'DUPLICATE_KEY');
    assert.ok(w);
    assert.deepEqual(w.ids?.slice().sort(), ['n1', syntheticUuid(1)].sort());
    assert.match(w.message, /\(2 occurrences\)$/);
    assert.ok(!w.message.includes('content_type'));
  });

  it('look-alike text inside strings triggers neither DUPLICATE_NODE_ID nor DUPLICATE_KEY end to end', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1), title: '{"title":"a","title":"b"}' });
    b.message(b.root(), 'user', contents.text('{"mapping":{"x":1,"x":2}} and "a":1,"a":2 and \\"q\\":1,\\"q\\":2'), { id: 'n1' });
    const r = rec(b.text());
    assert.ok(!r.warnings.some((w) => w.code === 'DUPLICATE_NODE_ID' || w.code === 'DUPLICATE_KEY'));
    assert.equal(r.completeness, 'exported_tree');
  });

  it('every distinct element gets its own scan: duplicate state never leaks between calls', () => {
    const dup = '{"id":"c","mapping":{"a":{"id":"a","parent":null,"message":null},"a":{"id":"a","parent":null,"message":null}}}';
    const clean = '{"id":"c","mapping":{"a":{"id":"a","parent":null,"message":null}}}';
    assert.ok(rec(dup).warnings.some((w) => w.code === 'DUPLICATE_NODE_ID'));
    assert.ok(!rec(clean).warnings.some((w) => w.code === 'DUPLICATE_NODE_ID'));
    assert.ok(rec(dup).warnings.some((w) => w.code === 'DUPLICATE_NODE_ID'));
  });
});
