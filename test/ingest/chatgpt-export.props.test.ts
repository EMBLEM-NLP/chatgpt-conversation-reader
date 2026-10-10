/**
 * Property tests (fast-check, fixed seed): hostile or random mapping graphs, random JSON elements, random message
 * content and random strings never break the adapter, always yield records the domain validator accepts, and keep
 * the invariants that make the output trustworthy (soundness of `exported_tree`, no guessed active branch, no
 * fabricated model, determinism, no prototype pollution).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { analyzeTree } from '../../src/domain/branches.js';
import type { ConversationRecord, MessageRecord } from '../../src/domain/types.js';
import { UNIX_SECONDS_MAX, UNIX_SECONDS_MIN, validateConversationRecord } from '../../src/domain/validate.js';
import { isGcrError } from '../../src/errors.js';
import type { AdapterOutcome } from '../../src/ingest/adapter.js';
import { chatGptExportAdapter, NAMED_CONTENT_TYPES } from '../../src/ingest/chatgpt-export.js';
import { adapterContext, ordered, stringify } from '../helpers/chatgpt-export-builder.js';
import type { RawObject } from '../helpers/chatgpt-export-builder.js';

const SEED = 20261013;
const ctx = adapterContext();
const PROTO_BASELINE = Object.getOwnPropertyNames(Object.prototype).sort().join('|');

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 300): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** Normalize; anything thrown must be a GcrError. Returns the outcome (or the GcrError). */
function safeRun(text: string, idx = 0): AdapterOutcome | Error {
  try {
    return chatGptExportAdapter.normalizeElementText(text, ctx, idx);
  } catch (e) {
    assert.ok(isGcrError(e), `non-GcrError thrown: ${String(e)}`);
    return e;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function noPollution(): void {
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join('|'), PROTO_BASELINE);
  assert.equal(({} as RawObject)['polluted'], undefined);
}

// ------------------------------------------------------------------------------------------
// Random mapping graphs
// ------------------------------------------------------------------------------------------

const ID_POOL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '__proto__', 'constructor', 'toString', '10', '9', '', 'ctl\u0001', 'L'.repeat(600), 'ghost1', 'ghost2', 'client-created-root'] as const;
const idArb = fc.constantFrom(...ID_POOL);
const parentArb = fc.oneof(idArb, idArb, idArb, idArb, fc.constant(null), fc.constant(undefined), fc.constant(5), fc.constant(''));
const childrenArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(undefined),
  fc.constant(undefined),
  fc.constant(null),
  fc.array(fc.oneof(idArb, idArb, idArb, idArb, fc.constant(7), fc.constant(null)), { maxLength: 5 }),
  fc.constant('not-an-array'),
);
const timeArb = fc.oneof(fc.integer({ min: 1_500_000_000, max: 2_000_000_000 }), fc.constant(0), fc.constant(null), fc.constant(undefined), fc.string({ maxLength: 8 }), fc.double({ noNaN: true }));
const roleArb = fc.constantFrom('user', 'assistant', 'system', 'tool', 'function', '__proto__', '', 'x'.repeat(600));
const nodeArb = fc.record({
  key: idArb,
  parent: parentArb,
  children: childrenArb,
  kind: fc.constantFrom('message', 'message', 'message', 'structural', 'junk'),
  role: roleArb,
  idField: fc.constantFrom('same', 'other', 'absent'),
  time: timeArb,
  text: fc.string({ maxLength: 8 }),
});
const currentArb = fc.oneof(idArb, idArb, idArb, fc.constant(null), fc.constant(undefined), fc.constant(5), fc.constant([]));

type NodeSpec = typeof nodeArb extends fc.Arbitrary<infer T> ? T : never;

function nodeValue(n: NodeSpec): unknown {
  if (n.kind === 'junk') return n.text;
  const o: RawObject = {};
  if (n.idField === 'same') o['id'] = n.key;
  else if (n.idField === 'other') o['id'] = `${n.key}-other`;
  o['parent'] = n.parent;
  if (n.children !== undefined) o['children'] = n.children;
  o['message'] =
    n.kind === 'structural'
      ? null
      : { id: n.key, author: { role: n.role, name: null }, create_time: n.time, content: { content_type: 'text', parts: [n.text] }, metadata: {} };
  return o;
}

function graphText(nodes: NodeSpec[], current: unknown, omitChildren: boolean): string {
  const entries = nodes.map((n) => {
    const v = nodeValue(n);
    if (omitChildren && v !== null && typeof v === 'object') Reflect.deleteProperty(v as RawObject, 'children');
    return [n.key, v] as [string, unknown];
  });
  return stringify({ id: 'conv-prop', title: 'GCR-SYNTHETIC-FIXTURE property graph', current_node: current, mapping: ordered(entries) });
}


// A mostly-valid tree: node i (> 0) hangs under a random earlier node; optional damage is applied afterwards.
const treeArb = fc.record({
  size: fc.integer({ min: 1, max: 12 }),
  parentPick: fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 12, maxLength: 12 }),
  childMode: fc.constantFrom('consistent', 'absent', 'empty', 'reversed'),
  mutate: fc.array(
    fc.record({ at: fc.integer({ min: 0, max: 11 }), kind: fc.constantFrom('ghost-parent', 'self', 'reparent', 'dup', 'none', 'none', 'none', 'none'), to: fc.integer({ min: 0, max: 11 }) }),
    { maxLength: 2 },
  ),
  current: fc.integer({ min: -1, max: 14 }),
  times: fc.array(fc.option(fc.integer({ min: 1_600_000_000, max: 1_900_000_000 }), { nil: null }), { minLength: 12, maxLength: 12 }),
});
type TreeSpec = typeof treeArb extends fc.Arbitrary<infer T> ? T : never;

function treeModel(spec: TreeSpec): { text: string; finalParents: Array<string | null> } {
  const ids = Array.from({ length: spec.size }, (_, i) => `n${i}`);
  const parent: Array<string | null> = ids.map((_, i) => (i === 0 ? null : (ids[(spec.parentPick[i] as number) % i] as string)));
  const entries: Array<[string, RawObject]> = [];
  for (const m of spec.mutate) {
    if (m.at >= spec.size) continue;
    if (m.kind === 'ghost-parent') parent[m.at] = 'ghost';
    else if (m.kind === 'self') parent[m.at] = ids[m.at] as string;
    else if (m.kind === 'reparent') parent[m.at] = ids[m.to % spec.size] as string;
  }
  const childrenOf = (id: string): string[] => ids.filter((x, i) => parent[i] === id && x !== id);
  ids.forEach((id, i) => {
    const o: RawObject = { id, parent: parent[i] ?? null };
    if (spec.childMode === 'consistent') o['children'] = childrenOf(id);
    else if (spec.childMode === 'reversed') o['children'] = childrenOf(id).reverse();
    else if (spec.childMode === 'empty') o['children'] = [];
    o['message'] = i === 0 ? null : { id, author: { role: i % 2 === 1 ? 'user' : 'assistant' }, create_time: spec.times[i], content: { content_type: 'text', parts: [`t${i}`] }, metadata: {} };
    entries.push([id, o]);
  });
  for (const m of spec.mutate) {
    if (m.kind === 'dup' && m.at < spec.size) entries.push([ids[m.at] as string, { ...(entries[m.at]?.[1] as RawObject) }]);
  }
  const current = spec.current < 0 ? undefined : spec.current < spec.size ? ids[spec.current] : 'ghost-current';
  return { text: stringify({ id: 'conv-tree', current_node: current, mapping: ordered(entries) }), finalParents: parent };
}

describe('random mapping graphs (cycles, dangling parents, random children, duplicate keys, hostile ids)', () => {
  it('never throws anything but GcrError, always validates, and the tree analysis never throws', () => {
    runProperty(
      fc.property(fc.array(nodeArb, { maxLength: 14 }), currentArb, fc.boolean(), (nodes, current, omit) => {
        const out = safeRun(graphText(nodes, current, omit));
        assert.ok(!(out instanceof Error), 'valid JSON must not be a parse error');
        if (out instanceof Error) return;
        assert.equal(out.kind, 'record');
        if (out.kind !== 'record') return;
        const r = validateConversationRecord(out.record);
        analyzeTree(r.id, r.messages, r.currentNodeId);
        noPollution();
      }),
      600,
    );
  });

  it('is deterministic: two runs give identical output', () => {
    runProperty(
      fc.property(fc.array(nodeArb, { maxLength: 12 }), currentArb, (nodes, current) => {
        const text = graphText(nodes, current, false);
        assert.equal(JSON.stringify(safeRun(text, 3)), JSON.stringify(safeRun(text, 3)));
      }),
    );
  });

  it('structure invariants: unique ids, ordinals follow file order, valid pointers, unique child lists, one conversation id', () => {
    runProperty(
      fc.property(fc.array(nodeArb, { maxLength: 14 }), currentArb, fc.boolean(), (nodes, current, omit) => {
        const out = safeRun(graphText(nodes, current, omit));
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const r = out.record;
        assert.equal(new Set(r.messages.map((m) => m.id)).size, r.messages.length);
        assert.deepEqual(r.messages.map((m) => m.ordinal), r.messages.map((_, i) => i));
        const distinctKeys = new Set(nodes.map((n) => n.key));
        assert.equal(r.messages.length, distinctKeys.size, 'one record per DISTINCT mapping key (duplicates collapse like JSON.parse)');
        for (const m of r.messages) {
          assert.equal(m.conversationId, r.id);
          assert.equal(new Set(m.childIds).size, m.childIds.length);
          assert.ok(m.parentId === null || typeof m.parentId === 'string');
          if (m.nodeKind === 'structural_empty') assert.ok(m.authorRole === '' && m.text === '' && m.blocks.length === 0);
        }
      }),
      500,
    );
  });

  it('SOUNDNESS: completeness "exported_tree" implies the domain analyzer sees a clean forest and an active branch', () => {
    let claimed = 0;
    runProperty(
      fc.property(fc.array(nodeArb, { maxLength: 10 }), currentArb, fc.boolean(), (nodes, current, omit) => {
        const out = safeRun(graphText(nodes, current, omit));
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const r = out.record;
        if (r.completeness !== 'exported_tree') return;
        claimed++;
        assert.ok(r.currentNodeId !== null, 'a full tree needs a valid current node');
        const t = analyzeTree(r.id, r.messages, r.currentNodeId);
        const bad = t.warnings.filter((w) => ['CYCLE_DETECTED', 'SELF_PARENT', 'MISSING_PARENT', 'NO_CURRENT_NODE', 'INVALID_CURRENT_NODE', 'DUPLICATE_NODE_ID'].includes(w.code));
        assert.deepEqual(bad, []);
        assert.ok(t.activeBranchId !== null);
        assert.equal(t.unreachableIds.length, 0);
        assert.ok(!r.warnings.some((w) => ['DUPLICATE_NODE_ID', 'INVALID_CURRENT_NODE', 'NO_CURRENT_NODE', 'MAPPING_INVALID', 'TOO_MANY_NODES'].includes(w.code)));
      }),
      1500,
    );
    assert.ok(claimed >= 3, `the generator must exercise the "exported_tree" branch (claimed ${claimed})`);
  });

  it('SOUNDNESS on mostly-valid trees with optional damage (ghost parent, self parent, re-parenting cycles, duplicate keys)', () => {
    let claimed = 0;
    let clean = 0;
    runProperty(
      fc.property(treeArb, (spec) => {
        const { text, finalParents } = treeModel(spec);
        const out = safeRun(text);
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const r = validateConversationRecord(out.record);
        const t = analyzeTree(r.id, r.messages, r.currentNodeId);
        const damaged = spec.mutate.some((m) => m.kind !== 'none');
        if (r.completeness === 'exported_tree') {
          claimed++;
          assert.ok(r.currentNodeId !== null);
          assert.deepEqual(t.warnings.filter((w) => ['CYCLE_DETECTED', 'SELF_PARENT', 'MISSING_PARENT', 'NO_CURRENT_NODE', 'INVALID_CURRENT_NODE', 'DUPLICATE_NODE_ID'].includes(w.code)), []);
          assert.ok(t.activeBranchId !== null);
          assert.equal(t.unreachableIds.length, 0);
        } else {
          // the converse for undamaged trees: nothing was wrong, so nothing may be claimed away without a reason
          assert.ok(damaged || spec.current < 0 || spec.current >= spec.size, `undamaged tree with a valid current node was downgraded: ${r.warnings.map((w) => w.code).join(',')}`);
        }
        if (!damaged && spec.current >= 0 && spec.current < spec.size) {
          clean++;
          assert.equal(r.completeness, 'exported_tree');
          assert.deepEqual(t.warnings.filter((w) => w.code !== 'CURRENT_NODE_NOT_LEAF'), [], 'declared/derived children agree with the parent pointers');
          assert.deepEqual(r.warnings.filter((w) => !['CHILDREN_ABSENT', 'CURRENT_NODE_NOT_LEAF'].includes(w.code)), []);
          assert.equal(r.messages.length, spec.size);
        }
        // every damage that survives the mutations is visible to someone: the adapter itself or the domain analyzer
        const reported = new Set([...r.warnings, ...t.warnings].map((w) => w.code));
        if (finalParents.includes('ghost')) assert.ok(reported.has('MISSING_PARENT'), 'ghost parent unreported');
        if (spec.mutate.some((m) => m.kind === 'dup' && m.at < spec.size)) assert.ok(reported.has('DUPLICATE_NODE_ID'), 'duplicate key unreported');
        finalParents.forEach((p, i) => {
          if (p === `n${i}`) assert.ok(reported.has('SELF_PARENT'), 'self parent unreported');
        });
      }),
      1500,
    );
    assert.ok(claimed > 150, `exported_tree claims exercised: ${claimed}`);
    assert.ok(clean > 100, `undamaged trees exercised: ${clean}`);
  });

  it('NO GUESSING: a current_node that is not a key of the mapping is never turned into an active branch', () => {
    runProperty(
      fc.property(fc.array(nodeArb, { maxLength: 10 }), currentArb, (nodes, current) => {
        const out = safeRun(graphText(nodes, current, false));
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const keys = new Set(nodes.map((n) => n.key));
        const isKey = typeof current === 'string' && keys.has(current);
        if (!isKey) {
          assert.equal(out.record.currentNodeId, null);
          assert.equal(out.record.completeness, 'unknown');
          const t = analyzeTree(out.record.id, out.record.messages, out.record.currentNodeId);
          assert.equal(t.activeBranchId, null);
        } else {
          assert.ok(out.record.currentNodeId !== null);
        }
      }),
    );
  });

  it('children omitted everywhere: derived child lists never disagree with the parent pointers (no CHILD_PARENT_MISMATCH)', () => {
    runProperty(
      fc.property(fc.array(nodeArb, { maxLength: 12 }), currentArb, (nodes, current) => {
        const out = safeRun(graphText(nodes, current, true));
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const t = analyzeTree(out.record.id, out.record.messages, out.record.currentNodeId);
        assert.ok(!t.warnings.some((w) => w.code === 'CHILD_PARENT_MISMATCH'), JSON.stringify(t.warnings.filter((w) => w.code === 'CHILD_PARENT_MISMATCH')));
        const absent = out.record.warnings.filter((w) => w.code === 'CHILDREN_ABSENT').length;
        assert.ok(absent <= 1, 'never more than one CHILDREN_ABSENT');
        if (out.record.messages.length > 0) assert.equal(absent, 1);
      }),
    );
  });

  it('file order is the node order: permuting the entries permutes the messages the same way and keeps every edge', () => {
    const uniqueNodes = fc.uniqueArray(nodeArb, { selector: (n) => n.key, maxLength: 9 });
    runProperty(
      fc.property(uniqueNodes, fc.integer({ min: 0, max: 1000 }), (nodes, rot) => {
        if (nodes.length < 2) return;
        const k = rot % nodes.length;
        const rotated = nodes.slice(k).concat(nodes.slice(0, k));
        const a = safeRun(graphText(nodes, null, true));
        const b = safeRun(graphText(rotated, null, true));
        if (a instanceof Error || b instanceof Error || a.kind !== 'record' || b.kind !== 'record') return assert.fail('expected records');
        // ids are stand-ins for unusable keys, which depend only on the key, so the id order follows the file order
        assert.deepEqual(b.record.messages.map((m) => m.id), rotated.map((n) => a.record.messages.find((m) => m.ordinal === nodes.indexOf(n))?.id));
        const edges = (rec: ConversationRecord): string[] => rec.messages.map((m) => `${m.id}<-${m.parentId}`).sort();
        assert.deepEqual(edges(a.record), edges(b.record));
        const kids = (rec: ConversationRecord): string[] => rec.messages.map((m) => `${m.id}:${[...m.childIds].sort().join(',')}`).sort();
        assert.deepEqual(kids(a.record), kids(b.record));
      }),
    );
  });

  it('the source hash is the SHA-256 of the exact text for every input', () => {
    runProperty(
      fc.property(fc.array(nodeArb, { maxLength: 8 }), currentArb, (nodes, current) => {
        const text = graphText(nodes, current, false);
        const out = safeRun(text);
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        assert.equal(out.sourceElementSha256, sha256(text));
        assert.equal(((out.record.rawMetadata as RawObject)['_gcr'] as RawObject)['sourceElementSha256'], sha256(text));
      }),
    );
  });
});

// ------------------------------------------------------------------------------------------
// Random JSON as an element
// ------------------------------------------------------------------------------------------

describe('random JSON elements', () => {
  it('any JSON value is skipped or becomes a valid record; nothing else escapes', () => {
    runProperty(
      fc.property(fc.jsonValue(), (v) => {
        const out = safeRun(JSON.stringify(v));
        assert.ok(!(out instanceof Error));
        if (out instanceof Error) return;
        if (out.kind === 'record') validateConversationRecord(out.record);
        else assert.ok(['EMPTY_CONVERSATION_ENTRY', 'NON_OBJECT_ENTRY', 'NOT_A_CONVERSATION'].includes(out.reason));
      }),
      600,
    );
  });

  it('conversation-shaped objects with random JSON in every field never break and always validate', () => {
    runProperty(
      fc.property(
        fc.record({ id: fc.jsonValue(), conversation_id: fc.jsonValue(), title: fc.jsonValue(), create_time: fc.jsonValue(), update_time: fc.jsonValue(), mapping: fc.oneof(fc.jsonValue(), fc.dictionary(fc.string({ maxLength: 4 }), fc.jsonValue(), { maxKeys: 6 })), current_node: fc.jsonValue(), default_model_slug: fc.jsonValue() }),
        (o) => {
          const out = safeRun(JSON.stringify({ ...o, mapping: o.mapping === undefined ? null : o.mapping }));
          assert.ok(!(out instanceof Error));
          if (out instanceof Error || out.kind !== 'record') return;
          validateConversationRecord(out.record);
          noPollution();
        },
      ),
      600,
    );
  });

  it('truncated or corrupted prefixes of a valid element are parse errors or valid records, never crashes', () => {
    const base = stringify({ id: 'c', current_node: 'a', mapping: ordered([['a', { id: 'a', parent: null, children: [], message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['héllo 😀'] } } }]]) });
    runProperty(
      fc.property(fc.integer({ min: 0, max: base.length }), (cut) => {
        const out = safeRun(base.slice(0, cut));
        if (!(out instanceof Error) && out.kind === 'record') validateConversationRecord(out.record);
      }),
      base.length + 1,
    );
  });
});

// ------------------------------------------------------------------------------------------
// Random message content
// ------------------------------------------------------------------------------------------

const typeArb = fc.oneof(fc.constantFrom(...NAMED_CONTENT_TYPES), fc.constantFrom(...NAMED_CONTENT_TYPES), fc.constantFrom(...NAMED_CONTENT_TYPES), fc.constantFrom('future_widget_v9', '', 'TEXT', 'constructor', '__proto__'), fc.string({ maxLength: 10 }));
const jsonArb = fc.jsonValue({ maxDepth: 3 });
const partArb = fc.oneof(
  fc.string({ maxLength: 10 }),
  fc.string({ maxLength: 10 }),
  jsonArb,
  fc.record({ content_type: fc.constantFrom('image_asset_pointer', 'audio_asset_pointer', 'audio_transcription', 'real_time_user_audio_video_asset_pointer', 'video_container_asset_pointer', 'x_asset_pointer'), asset_pointer: fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom('sediment://file_1', 'file-service://file-A#x', ''), jsonArb), text: jsonArb, size_bytes: jsonArb }),
  fc.record({ type: fc.constantFrom('search_result_group', 'search_result'), entries: jsonArb }),
);
const contentArb = fc.oneof(
  fc.record({ content_type: typeArb, parts: fc.oneof(fc.array(partArb, { maxLength: 6 }), jsonArb, fc.constant(null)), text: jsonArb, thoughts: fc.oneof(jsonArb, fc.constant(JSON.stringify([{ summary: 's', content: 'c' }])), fc.array(fc.record({ summary: jsonArb, content: jsonArb, chunks: jsonArb, finished: jsonArb }), { maxLength: 3 })), content: jsonArb, result: jsonArb, output_str: jsonArb, user_profile: jsonArb, user_instructions: jsonArb, model_set_context: jsonArb, screenshot: jsonArb }),
  jsonArb,
  fc.constant(null),
);
const attachmentsArb = fc.oneof(fc.constant(undefined), jsonArb, fc.array(fc.oneof(jsonArb, fc.record({ id: jsonArb, name: jsonArb, mime_type: jsonArb, mimeType: jsonArb, size: jsonArb, asset_pointer: jsonArb })), { maxLength: 4 }));
const messageArb = fc.record({
  role: fc.oneof(roleArb, jsonArb),
  name: jsonArb,
  channel: jsonArb,
  recipient: jsonArb,
  status: jsonArb,
  create_time: fc.oneof(timeArb, jsonArb),
  content: contentArb,
  metadata: fc.oneof(fc.constant(null), jsonArb, fc.record({ model_slug: jsonArb, default_model_slug: jsonArb, is_visually_hidden_from_conversation: jsonArb, attachments: attachmentsArb, user_context_message_data: jsonArb })),
});

type MessageSpec = typeof messageArb extends fc.Arbitrary<infer T> ? T : never;

function singleMessageText(s: MessageSpec): string {
  const msg: RawObject = { id: 'm', author: { role: s.role, name: s.name }, create_time: s.create_time, content: s.content, metadata: s.metadata, channel: s.channel, recipient: s.recipient, status: s.status };
  return stringify({ id: 'c', current_node: 'm', mapping: ordered([['m', { id: 'm', parent: null, children: [], message: msg }]]) });
}

const hasLone = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('random message content', () => {
  it('always validates; text is clean, placeholders are generic, no coercion artifacts appear', () => {
    runProperty(
      fc.property(messageArb, (spec) => {
        const out = safeRun(singleMessageText(spec));
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const r = validateConversationRecord(out.record);
        const m = r.messages[0] as MessageRecord;
        assert.ok(!m.text.includes('\u0000') && !hasLone(m.text));
        for (const b of m.blocks) {
          assert.ok(b.text === undefined || (!b.text.includes('\u0000') && !hasLone(b.text)));
          assert.ok(b.type.length > 0);
        }
        assert.ok(!m.text.includes('[object Object]') && !m.text.includes('undefined'));
        for (const a of m.attachments) {
          assert.ok(a.presentInExportAs === null, 'no container was supplied');
        }
        noPollution();
      }),
      800,
    );
  });

  it('model attribution: modelSlug is null or exactly metadata.model_slug; default_model_slug is never used', () => {
    runProperty(
      fc.property(messageArb, (spec) => {
        const out = safeRun(singleMessageText(spec));
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const m = out.record.messages[0] as MessageRecord;
        const md = spec.metadata;
        const stated = md !== null && typeof md === 'object' && !Array.isArray(md) ? (md as RawObject)['model_slug'] : undefined;
        if (typeof stated === 'string' && stated !== '' && !/[\u0000\ud800-\udfff]/.test(stated) && stated.length <= 512) assert.equal(m.modelSlug, stated);
        else if (m.modelSlug !== null) {
          // only possible after sanitation / truncation of a stated slug, never from anything else
          assert.equal(typeof stated, 'string');
        }
        const dflt = md !== null && typeof md === 'object' && !Array.isArray(md) ? (md as RawObject)['default_model_slug'] : undefined;
        if (typeof dflt === 'string' && dflt !== '' && dflt !== stated) assert.notEqual(m.modelSlug, dflt);
      }),
      600,
    );
  });

  it('hidden follows the documented rule exactly', () => {
    runProperty(
      fc.property(messageArb, (spec) => {
        const out = safeRun(singleMessageText(spec));
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const m = out.record.messages[0] as MessageRecord;
        const md = spec.metadata;
        const flag = md !== null && typeof md === 'object' && !Array.isArray(md) && (md as RawObject)['is_visually_hidden_from_conversation'] === true;
        const ct = m.contentType;
        const expected = flag || m.authorRole === 'system' || (ct !== null && ['user_editable_context', 'model_editable_context', 'thoughts', 'reasoning_recap'].includes(ct));
        assert.equal(m.hidden, expected);
      }),
      600,
    );
  });

  it('timestamps are null or inside the plausibility window; never NaN, never invented', () => {
    runProperty(
      fc.property(fc.oneof(timeArb, jsonArb), (t) => {
        const text = stringify({ id: 'c', create_time: t, update_time: t, current_node: null, mapping: ordered([]) });
        const out = safeRun(text);
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        for (const iso of [out.record.createdAt, out.record.updatedAt]) {
          if (iso === null) continue;
          const secs = Date.parse(iso) / 1000;
          assert.ok(secs >= UNIX_SECONDS_MIN && secs <= UNIX_SECONDS_MAX, iso);
        }
        if (typeof t === 'number' && t >= UNIX_SECONDS_MIN && t <= UNIX_SECONDS_MAX) {
          assert.ok(Math.abs(Date.parse(out.record.createdAt as string) - t * 1000) <= 1, 'millisecond rounding only');
        } else if (typeof t === 'number' || t === null || t === undefined) {
          assert.equal(out.record.createdAt, null);
        }
      }),
      800,
    );
  });
});

// ------------------------------------------------------------------------------------------
// Random strings
// ------------------------------------------------------------------------------------------

describe('random strings (arbitrary UTF-16 code units, including lone surrogates and NUL)', () => {
  const units = fc.array(fc.oneof(fc.integer({ min: 0, max: 0xffff }), fc.integer({ min: 0, max: 0xffff }), fc.constantFrom(0, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0x2028, 0x202e, 0xe200)), { maxLength: 40 }).map((a) => String.fromCharCode(...a));

  it('message text equals the reference sanitation: NUL removed, lone surrogates -> U+FFFD, everything else verbatim', () => {
    runProperty(
      fc.property(units, (s) => {
        const text = stringify({ id: 'c', current_node: 'm', mapping: ordered([['m', { id: 'm', parent: null, children: [], message: { id: 'm', author: { role: 'user' }, content: { content_type: 'text', parts: [s] } } }]]) });
        const out = safeRun(text);
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const r = validateConversationRecord(out.record);
        const noNul = s.replaceAll('\u0000', '');
        const expected = (noNul as unknown as { toWellFormed(): string }).toWellFormed();
        assert.equal(r.messages[0]?.text, expected);
        if (s === expected) assert.equal(r.messages[0]?.text, s, 'clean input is returned untouched');
        // the raw value is preserved exactly as parsed
        assert.equal(((((r.messages[0]?.rawSource as RawObject)['content'] as RawObject)['parts']) as string[])[0], s);
      }),
      800,
    );
  });

  it('titles, node ids and role strings made of arbitrary code units still produce valid records', () => {
    runProperty(
      fc.property(units, units, units, (title, key, role) => {
        const text = stringify({ id: 'c', title, current_node: key, mapping: ordered([[key, { id: key, parent: null, children: [], message: { id: key, author: { role }, content: { content_type: 'text', parts: ['x'] } } }]]) });
        const out = safeRun(text);
        if (out instanceof Error || out.kind !== 'record') return assert.fail('expected a record');
        const r = validateConversationRecord(out.record);
        assert.ok(r.currentNodeId !== null, 'the current node is a real key, so it resolves (possibly to a stand-in id)');
        assert.equal(r.currentNodeId, r.messages[0]?.id);
      }),
      800,
    );
  });
});
