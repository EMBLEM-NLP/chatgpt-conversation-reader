/**
 * Builder for RAW ChatGPT-export JSON (the wire shape of `conversations.json` elements), NOT for domain records
 * (see ./records.ts for those). 100% SYNTHETIC: every id, title and text is invented; ids look like
 * `00000000-0000-4000-8000-0000000000NN`; every default title carries the marker GCR-SYNTHETIC-FIXTURE that the
 * privacy scanner requires in committed fixtures.
 *
 * Dependency-free on purpose (only a type import from the adapter contract), so later modules (import runner, CLI,
 * MCP tests) can use it as is. Overview of the API:
 *
 *   const b = new ConversationBuilder({ title: 'GCR-SYNTHETIC-FIXTURE demo' });
 *   const root = b.root();                           // 'client-created-root' (rootStyle: 'literal' | 'uuid' | 'none')
 *   const u1 = b.user(root, 'hello');                // message nodes; parent/children are maintained for you
 *   const a1 = b.assistant(u1, 'hi', { model: 'synthetic-model-1' });
 *   b.regenerate(a1, 'second answer');               // sibling assistant under the same user turn
 *   b.editUser(u1, 'hello again');                   // sibling user turn under the same parent (a new subtree)
 *   b.setCurrent(a1);                                // default: the last message node added
 *   const raw = b.build();                           // plain JS object (integer-like ids may be re-ordered by JS!)
 *   const text = b.text({ pretty: true });           // exact, insertion-ordered JSON text (what the adapter receives)
 *
 * Absent vs null vs value: option value `undefined` means "use the default"; `OMIT` means "write no such key"; `null` writes
 * `null`. The `set*` overrides apply `OMIT` the same way. Raw-text control (duplicate keys, `__proto__`, integer-like ids,
 * `1e999`...) is done with `ordered([...])` (an object that may repeat keys and keeps order) and `rawJson('...')` (verbatim
 * JSON text) inside any value, then `stringify`. `splitTopLevelArray` cuts a fixture file into the per-element texts the
 * adapter consumes, preserving them byte for byte.
 */
import type { AdapterContext } from '../../src/ingest/adapter.js';

export const SYNTHETIC_MARKER = 'GCR-SYNTHETIC-FIXTURE';

/** Marker value: "write no such key". */
export const OMIT: unique symbol = Symbol('OMIT');
export type Omittable<T> = T | typeof OMIT;

export type RawObject = Record<string, unknown>;

/** `00000000-0000-4000-8000-0000000000NN`: the clearly synthetic UUID family required for fixtures. */
export function syntheticUuid(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('syntheticUuid needs a non-negative integer');
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Unix seconds of 2025-10-09T08:53:20Z; every builder clock starts here (inside the adapter's plausibility window). */
export const BASE_UNIX_SECONDS = 1_760_000_000;

// ------------------------------------------------------------------------------------------
// Serializer: ordered objects, verbatim JSON, exact pretty printing (same layout as JSON.stringify(v, null, 2))
// ------------------------------------------------------------------------------------------

/** Verbatim JSON text inside a value (e.g. `rawJson('1e999')`, `rawJson('9007199254740993')`, `rawJson('-0')`). Not validated. */
export class RawJson {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}
export function rawJson(text: string): RawJson {
  return new RawJson(text);
}

/** An object that keeps entry order and may repeat keys (duplicate keys, `__proto__`, integer-like keys in file order). */
export class OrderedObject {
  readonly entries: Array<[string, unknown]>;
  constructor(entries: Array<[string, unknown]>) {
    this.entries = entries;
  }
}
export function ordered(entries: Array<[string, unknown]>): OrderedObject {
  return new OrderedObject(entries);
}

function serialize(value: unknown, space: number, level: number, out: string[]): void {
  if (value instanceof RawJson) {
    out.push(value.text);
    return;
  }
  if (value === null || value === undefined) {
    out.push('null');
    return;
  }
  const t = typeof value;
  if (t === 'string' || t === 'boolean') {
    out.push(JSON.stringify(value));
    return;
  }
  if (t === 'number') {
    // JSON.stringify prints non-finite numbers as null; use rawJson('1e999') to emit them verbatim.
    out.push(JSON.stringify(value));
    return;
  }
  const nl = space > 0 ? `\n${' '.repeat(space * (level + 1))}` : '';
  const nlEnd = space > 0 ? `\n${' '.repeat(space * level)}` : '';
  const colon = space > 0 ? ': ' : ':';
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push('[]');
      return;
    }
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      out.push(i === 0 ? nl : `,${nl}`);
      serialize(value[i], space, level + 1, out);
    }
    out.push(nlEnd, ']');
    return;
  }
  if (t === 'object') {
    const entries: Array<[string, unknown]> = value instanceof OrderedObject ? value.entries : Object.entries(value as RawObject);
    const kept = entries.filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol');
    if (kept.length === 0) {
      out.push('{}');
      return;
    }
    out.push('{');
    kept.forEach(([k, v], i) => {
      out.push(i === 0 ? nl : `,${nl}`, JSON.stringify(k), colon);
      serialize(v, space, level + 1, out);
    });
    out.push(nlEnd, '}');
    return;
  }
  throw new TypeError(`cannot serialize value of type ${t}`);
}

/** JSON text of `value`, honouring OrderedObject and RawJson. `space` 0 = minified (the real export is one long line). */
export function stringify(value: unknown, space = 0): string {
  const out: string[] = [];
  serialize(value, space, 0, out);
  return out.join('');
}

/**
 * Splits the text of a top-level JSON array into the exact source text of each element (whitespace trimmed). Test-only,
 * linear, string-aware. Throws on anything that is not an array. Lets tests feed fixture files to the adapter element by
 * element without re-serializing (which would hide duplicate keys and number spellings).
 */
export function splitTopLevelArray(text: string): string[] {
  let i = 0;
  const n = text.length;
  const skipWs = (): void => {
    while (i < n && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x0a || text.charCodeAt(i) === 0x0d || text.charCodeAt(i) === 0x09)) i++;
  };
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  skipWs();
  if (text[i] !== '[') throw new Error('not a JSON array');
  i++;
  const elements: string[] = [];
  skipWs();
  if (text[i] === ']') return elements;
  for (;;) {
    skipWs();
    const start = i;
    let depth = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        while (i < n && text.charCodeAt(i) !== 0x22) i += text.charCodeAt(i) === 0x5c ? 2 : 1;
        i++;
        continue;
      }
      if (c === 0x7b || c === 0x5b) depth++;
      else if (c === 0x7d || c === 0x5d) {
        if (depth === 0) break;
        depth--;
      } else if (c === 0x2c && depth === 0) break;
      i++;
    }
    elements.push(text.slice(start, i).trim());
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === ']') return elements;
    throw new Error('unterminated JSON array');
  }
}

/** AdapterContext for tests: fixed import time, default account, optional asset names. */
export function adapterContext(over: Partial<AdapterContext> = {}): AdapterContext {
  return { provider: 'chatgpt', accountLabel: 'default', importedAt: '2026-01-01T00:00:00.000Z', ...over };
}

// ------------------------------------------------------------------------------------------
// Content and part helpers (shapes from the research notes, section 6.5 / 6.6; all values invented)
// ------------------------------------------------------------------------------------------

export const contents = {
  text: (...parts: unknown[]): RawObject => ({ content_type: 'text', parts }),
  multimodal: (parts: unknown[]): RawObject => ({ content_type: 'multimodal_text', parts }),
  code: (text: string, language = 'unknown'): RawObject => ({ content_type: 'code', language, response_format_name: null, text }),
  executionOutput: (text: string): RawObject => ({ content_type: 'execution_output', text }),
  tetherQuote: (o: { url?: string; domain?: string; title?: string; text?: string } = {}): RawObject => ({
    content_type: 'tether_quote',
    url: o.url ?? 'https://example.invalid/synthetic-page',
    domain: o.domain ?? 'example.invalid',
    title: o.title ?? 'Synthetic quoted page',
    text: o.text ?? 'synthetic quoted passage',
  }),
  tetherBrowsingDisplay: (o: { result?: string; summary?: string | null; assets?: unknown; tetherId?: string | null } = {}): RawObject => ({
    content_type: 'tether_browsing_display',
    result: o.result ?? 'synthetic browsing result',
    summary: o.summary ?? null,
    assets: o.assets ?? null,
    tether_id: o.tetherId ?? null,
  }),
  /** `tether_browsing_code`: field set unknown in the research; this minimal INVENTED shape only exercises raw preservation. */
  tetherBrowsingCode: (): RawObject => ({ content_type: 'tether_browsing_code', synthetic_invented_field: 'search("synthetic query")' }),
  sonicWebpage: (o: { text?: string } = {}): RawObject => ({
    content_type: 'sonic_webpage',
    url: 'https://example.invalid/sonic',
    domain: 'example.invalid',
    title: 'Synthetic sonic page',
    text: o.text ?? 'synthetic sonic page text',
    snippet: 'synthetic snippet',
    ref_id: 'turn0search0',
  }),
  systemError: (text = 'synthetic error text'): RawObject => ({ content_type: 'system_error', name: 'SyntheticError', text }),
  userEditableContext: (o: { profile?: string; instructions?: string } = {}): RawObject => ({
    content_type: 'user_editable_context',
    user_profile: o.profile ?? 'None',
    user_instructions: o.instructions ?? 'None',
  }),
  modelEditableContext: (o: { memory?: string } = {}): RawObject => ({
    content_type: 'model_editable_context',
    model_set_context: o.memory ?? 'synthetic memory line',
    repository: null,
    repo_summary: null,
    structured_context: null,
  }),
  thoughts: (items: Array<{ summary?: string; content?: string; chunks?: string[]; finished?: boolean }>, asJsonString = false): RawObject => ({
    content_type: 'thoughts',
    thoughts: asJsonString ? JSON.stringify(items) : items,
    source_analysis_msg_id: syntheticUuid(0xaa),
  }),
  reasoningRecap: (text = 'Thought for 3s'): RawObject => ({ content_type: 'reasoning_recap', content: text }),
  computerOutput: (o: { screenshot?: unknown } = {}): RawObject => ({
    content_type: 'computer_output',
    computer_id: 'synthetic-computer-1',
    screenshot: o.screenshot ?? null,
    tether_id: null,
    state: 'ok',
    is_ephemeral: false,
  }),
  citableCodeOutput: (text = 'synthetic citable output'): RawObject => ({ content_type: 'citable_code_output', output_str: text }),
  /** `app_pairing_content`: field set unknown in the research; INVENTED minimal shape, raw preservation only. */
  appPairingContent: (): RawObject => ({ content_type: 'app_pairing_content', synthetic_invented_field: { app: 'synthetic-app' } }),
  unknown: (type = 'future_widget_v9'): RawObject => ({ content_type: type, widget: { synthetic: true, items: [1, 2, 3] } }),
} as const;

export const parts = {
  image: (pointer = 'sediment://file_00000000000000000000000000000001', sizeBytes = 1234): RawObject => ({
    content_type: 'image_asset_pointer',
    asset_pointer: pointer,
    size_bytes: sizeBytes,
    width: 512,
    height: 512,
    fovea: null,
    metadata: { dalle: null, gizmo: null, generation: null, sanitized: true },
  }),
  audioTranscription: (text: string, direction: 'in' | 'out' = 'in'): RawObject => ({ content_type: 'audio_transcription', text, direction, decoding_id: null }),
  audioPointer: (pointer = 'sediment://file_00000000000000000000000000000002'): RawObject => ({
    content_type: 'audio_asset_pointer',
    asset_pointer: pointer,
    size_bytes: 2048,
    format: 'wav',
    expiry_datetime: null,
    metadata: { start_timestamp: null, end_timestamp: null },
  }),
  realTime: (): RawObject => ({
    content_type: 'real_time_user_audio_video_asset_pointer',
    expiry_datetime: null,
    audio_start_timestamp: 1.5,
    audio_asset_pointer: { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000000000000003', size_bytes: 10, format: 'wav' },
    video_container_asset_pointer: { content_type: 'video_container_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000000000000004', size_bytes: 20 },
    frames_asset_pointers: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000000000000005', size_bytes: 30 }],
  }),
  videoContainer: (pointer = 'sediment://file_00000000000000000000000000000006'): RawObject => ({ content_type: 'video_container_asset_pointer', asset_pointer: pointer, size_bytes: 40 }),
  searchResultGroup: (): RawObject => ({
    type: 'search_result_group',
    domain: 'example.invalid',
    entries: [{ type: 'search_result', url: 'https://example.invalid/r1', title: 'Synthetic result', snippet: 'synthetic snippet', ref_id: { ref_type: 'search', turn_index: 0, ref_index: 0 } }],
  }),
  unknownObject: (): RawObject => ({ synthetic_unknown_part: true, value: 7 }),
} as const;

// ------------------------------------------------------------------------------------------
// The conversation builder
// ------------------------------------------------------------------------------------------

export interface MessageOptions {
  /** Node id AND message id (default: next synthetic UUID). */
  id?: string;
  /** Message id when it should differ from the node id (mismatch tests). */
  messageId?: string | typeof OMIT;
  model?: string | null;
  /** Put a model in metadata.default_model_slug (the trap: it must never become modelSlug). */
  defaultModel?: string;
  status?: string | null | typeof OMIT;
  channel?: string | null | typeof OMIT;
  recipient?: string | null | typeof OMIT;
  authorName?: string | null;
  createTime?: unknown;
  updateTime?: unknown;
  /** metadata.is_visually_hidden_from_conversation */
  hidden?: boolean;
  /** Extra metadata keys (merged over the defaults); pass `null` to write `metadata: null`. */
  metadata?: RawObject | null;
  weight?: number | null | typeof OMIT;
  attachments?: unknown[];
  /** Raw overrides on the message object (OMIT deletes a key). */
  set?: RawObject;
  /** Raw overrides on the NODE object (OMIT deletes a key). */
  nodeSet?: RawObject;
}

export interface ConversationInit {
  id?: Omittable<string>;
  conversationId?: Omittable<string>;
  title?: Omittable<string | null>;
  createTime?: unknown;
  updateTime?: unknown;
  /** Conversation-level `default_model_slug` (default 'synthetic-default-model'; the fabrication trap for message models). */
  defaultModel?: Omittable<string | null>;
  /** Only id/title/times/mapping/current_node (the trimmed 2026 shape) instead of the full key set. */
  minimal?: boolean;
  /** `root()` style: the literal 'client-created-root', a UUID, or no root helper. */
  rootStyle?: 'literal' | 'uuid';
  /** Strip `children` from every node when building (the 2026 export shape). */
  omitChildren?: boolean;
  /** Extra unknown conversation-level keys. */
  extra?: RawObject;
  /** Raw overrides on the conversation object (OMIT deletes a key). */
  set?: RawObject;
  /** First message time and step in unix seconds. */
  clock?: { start: number; step: number };
}

interface BuilderNode {
  id: string;
  message: unknown;
  parent: string | null;
  children: string[];
  /** Extra / overriding node-level keys. */
  set: RawObject;
}

function applyOverrides(target: RawObject, overrides: RawObject | undefined): void {
  if (overrides === undefined) return;
  for (const key of Object.keys(overrides)) {
    const v = overrides[key];
    if (v === OMIT) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, { value: v, writable: true, enumerable: true, configurable: true });
  }
}

function put(target: RawObject, key: string, value: unknown): void {
  if (value !== OMIT) Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

export class ConversationBuilder {
  private readonly init: ConversationInit;
  private readonly nodes = new Map<string, BuilderNode>();
  private uuidCounter: number;
  private tick = 0;
  private current: string | null | undefined = undefined;
  private lastMessageId: string | null = null;
  readonly conversationId: string;

  constructor(init: ConversationInit = {}) {
    this.init = init;
    // Conversation ids use 1..0x0f; node/message ids start at 0x10, so up to 239 auto ids keep the two-digit
    // `...0000000000NN` form required for committed fixtures (larger generated conversations simply get longer tails).
    this.uuidCounter = 0x10;
    this.conversationId = typeof init.id === 'string' ? init.id : syntheticUuid(1);
  }

  /** Next synthetic UUID for a node/message. */
  nextId(): string {
    return syntheticUuid(this.uuidCounter++);
  }

  private nextTime(): number {
    const c = this.init.clock ?? { start: BASE_UNIX_SECONDS, step: 60 };
    const t = c.start + c.step * this.tick++ + 0.123456; // microsecond-style fraction, like the real export
    return t;
  }

  /** The synthetic root: `client-created-root` (message null) or an ordinary UUID. */
  root(id?: string): string {
    const rid = id ?? (this.init.rootStyle === 'uuid' ? this.nextId() : 'client-created-root');
    return this.structural(null, rid);
  }

  /** A node whose `message` is null (structural placeholder). */
  structural(parent: string | null, id?: string): string {
    const nid = id ?? this.nextId();
    this.insert({ id: nid, message: null, parent, children: [], set: {} });
    return nid;
  }

  /** Insert a node whose value is used verbatim (any shape, for hostile-input tests). Parent/children are NOT maintained. */
  rawNode(id: string, value: unknown): string {
    this.nodes.set(id, { id, message: OMIT, parent: null, children: [], set: { __rawValue: value } });
    return id;
  }

  private insert(n: BuilderNode): void {
    this.nodes.set(n.id, n);
    if (n.parent !== null) this.nodes.get(n.parent)?.children.push(n.id);
  }

  /** Generic message node. `content` is the full content object. */
  message(parent: string | null, role: string | null, content: unknown, o: MessageOptions = {}): string {
    const id = o.id ?? this.nextId();
    const meta: RawObject = {};
    if (o.metadata !== null) {
      meta['timestamp_'] = 'absolute';
      if (o.model !== undefined && o.model !== null) meta['model_slug'] = o.model;
      if (o.defaultModel !== undefined) meta['default_model_slug'] = o.defaultModel;
      if (o.hidden !== undefined) meta['is_visually_hidden_from_conversation'] = o.hidden;
      if (o.attachments !== undefined) meta['attachments'] = o.attachments;
      applyOverrides(meta, o.metadata);
    }
    const author: RawObject = {};
    if (role !== null) author['role'] = role;
    author['name'] = o.authorName ?? null;
    author['metadata'] = {};
    const msg: RawObject = {};
    put(msg, 'id', o.messageId === undefined ? id : o.messageId);
    msg['author'] = author;
    msg['create_time'] = o.createTime === undefined ? this.nextTime() : o.createTime;
    msg['update_time'] = o.updateTime === undefined ? null : o.updateTime;
    msg['content'] = content;
    if (o.status !== OMIT) msg['status'] = o.status === undefined ? 'finished_successfully' : o.status;
    msg['end_turn'] = role === 'assistant' ? true : null;
    if (o.weight !== OMIT) msg['weight'] = o.weight === undefined ? 1.0 : o.weight;
    msg['metadata'] = o.metadata === null ? null : meta;
    if (o.recipient !== OMIT) msg['recipient'] = o.recipient === undefined ? 'all' : o.recipient;
    if (o.channel !== undefined && o.channel !== OMIT) msg['channel'] = o.channel;
    applyOverrides(msg, o.set);
    this.insert({ id, message: msg, parent, children: [], set: o.nodeSet ?? {} });
    this.lastMessageId = id;
    return id;
  }

  user(parent: string | null, text: string, o: MessageOptions = {}): string {
    return this.message(parent, 'user', contents.text(text), o);
  }
  assistant(parent: string | null, text: string, o: MessageOptions = {}): string {
    return this.message(parent, 'assistant', contents.text(text), { channel: 'final', ...o });
  }
  system(parent: string | null, text: string, o: MessageOptions = {}): string {
    return this.message(parent, 'system', contents.text(text), { hidden: true, ...o });
  }
  /** Tool message (`author.role` 'tool', `author.name` set, e.g. 'python' / 'web.run'). */
  tool(parent: string | null, text: string, o: MessageOptions & { name?: string } = {}): string {
    return this.message(parent, 'tool', contents.text(text), { authorName: o.name ?? 'python', ...o });
  }
  /** Assistant code turn addressed to a tool (`content_type` code, `recipient` python by default). */
  code(parent: string | null, code: string, o: MessageOptions & { language?: string } = {}): string {
    return this.message(parent, 'assistant', contents.code(code, o.language), { recipient: 'python', channel: 'commentary', ...o });
  }
  multimodal(parent: string | null, partsList: unknown[], role: string = 'user', o: MessageOptions = {}): string {
    return this.message(parent, role, contents.multimodal(partsList), o);
  }
  thoughts(parent: string | null, items: Array<{ summary?: string; content?: string; chunks?: string[]; finished?: boolean }>, o: MessageOptions & { asJsonString?: boolean } = {}): string {
    return this.message(parent, 'assistant', contents.thoughts(items, o.asJsonString === true), o);
  }

  /** Sibling of `assistantId` (same parent): a regenerated answer. */
  regenerate(assistantId: string, text: string, o: MessageOptions = {}): string {
    return this.assistant(this.parentOf(assistantId), text, o);
  }
  /** Sibling of `userId` (same parent): an edited user turn (a new subtree). */
  editUser(userId: string, text: string, o: MessageOptions = {}): string {
    return this.user(this.parentOf(userId), text, o);
  }
  private parentOf(id: string): string | null {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error('unknown node');
    return n.parent;
  }

  /** Raw overrides on an existing NODE object (e.g. `{ parent: 'ghost', children: OMIT }`). */
  setNode(id: string, overrides: RawObject): this {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error('unknown node');
    Object.assign(n.set, overrides);
    return this;
  }
  /** Raw overrides on an existing node's MESSAGE object. */
  setMessage(id: string, overrides: RawObject): this {
    const n = this.nodes.get(id);
    if (n === undefined || typeof n.message !== 'object' || n.message === null) throw new Error('node has no message');
    applyOverrides(n.message as RawObject, overrides);
    return this;
  }

  /** `current_node`: a node id, `null` (explicit null), or OMIT (no key). Default: the last message node added. */
  setCurrent(id: string | null | typeof OMIT): this {
    this.current = id === OMIT ? undefined : id;
    this.currentOmitted = id === OMIT;
    return this;
  }
  private currentOmitted = false;

  private buildNodeObject(n: BuilderNode): unknown {
    if (Object.hasOwn(n.set, '__rawValue')) return n.set['__rawValue'];
    const node: RawObject = {};
    node['id'] = n.id;
    node['message'] = n.message;
    node['parent'] = n.parent;
    node['children'] = n.children.slice();
    if (this.init.omitChildren === true) Reflect.deleteProperty(node, 'children');
    applyOverrides(node, n.set);
    return node;
  }

  /** The conversation object with an ORDERED mapping (insertion order, safe for integer-like ids / `__proto__`); embed it in arrays and `stringify`. */
  value(mappingEntries?: Array<[string, unknown]>): RawObject {
    return this.build(ordered(mappingEntries ?? this.mappingEntries()));
  }

  /** The `mapping` entries in insertion order (use with `ordered()` to emit exact order / duplicates). */
  mappingEntries(): Array<[string, unknown]> {
    return Array.from(this.nodes.values(), (n) => [n.id, this.buildNodeObject(n)] as [string, unknown]);
  }

  /** The conversation object. Its `mapping` is a PLAIN object (JS re-orders integer-like ids); use text() for exact order. */
  build(mapping?: unknown): RawObject {
    const i = this.init;
    const conv: RawObject = {};
    const clock = i.clock ?? { start: BASE_UNIX_SECONDS, step: 60 };
    const full = i.minimal !== true;
    put(conv, 'id', i.id === undefined ? this.conversationId : i.id);
    if (full) {
      put(conv, 'conversation_id', i.conversationId === undefined ? this.conversationId : i.conversationId);
    }
    put(conv, 'title', i.title === undefined ? `${SYNTHETIC_MARKER} synthetic conversation` : i.title);
    put(conv, 'create_time', i.createTime === undefined ? clock.start - 120 + 0.654321 : i.createTime);
    put(conv, 'update_time', i.updateTime === undefined ? clock.start + clock.step * this.tick + 0.654321 : i.updateTime);
    conv['mapping'] = mapping ?? this.plainMapping();
    const cur = this.currentOmitted ? OMIT : this.current === undefined ? this.lastMessageId : this.current;
    put(conv, 'current_node', cur);
    if (full) {
      conv['moderation_results'] = [];
      conv['plugin_ids'] = null;
      conv['conversation_template_id'] = null;
      conv['gizmo_id'] = null;
      conv['gizmo_type'] = null;
      conv['is_archived'] = false;
      conv['is_starred'] = null;
      conv['safe_urls'] = [];
      conv['blocked_urls'] = [];
      conv['conversation_origin'] = null;
      conv['voice'] = null;
      conv['async_status'] = null;
      conv['disabled_tool_ids'] = [];
    }
    if (i.defaultModel !== OMIT) put(conv, 'default_model_slug', i.defaultModel === undefined ? 'synthetic-default-model' : i.defaultModel);
    if (i.extra !== undefined) for (const k of Object.keys(i.extra)) put(conv, k, i.extra[k]);
    applyOverrides(conv, i.set);
    return conv;
  }

  private plainMapping(): RawObject {
    const m: RawObject = {};
    for (const n of this.nodes.values()) Object.defineProperty(m, n.id, { value: this.buildNodeObject(n), writable: true, enumerable: true, configurable: true });
    return m;
  }

  /**
   * Exact JSON text with the mapping in INSERTION order (also for integer-like ids and `__proto__`). `mappingEntries`
   * replaces the mapping entries (use it to inject duplicates). `pretty` = 2-space indentation, else minified.
   */
  text(o: { pretty?: boolean; mappingEntries?: Array<[string, unknown]> } = {}): string {
    const conv = this.build(ordered(o.mappingEntries ?? this.mappingEntries()));
    return stringify(conv, o.pretty === true ? 2 : 0);
  }
}

/** A linear conversation of `pairs` user/assistant turns after a root: the common baseline. */
export function linearConversation(pairs: number, init: ConversationInit = {}): ConversationBuilder {
  const b = new ConversationBuilder(init);
  let prev = b.root();
  for (let i = 0; i < pairs; i++) {
    prev = b.user(prev, `synthetic user turn ${i + 1}`);
    prev = b.assistant(prev, `synthetic assistant answer ${i + 1}`, { model: 'synthetic-model-1' });
  }
  return b;
}

/**
 * A big linear conversation as raw TEXT, built without per-node objects retained (for the 50k-message scale test).
 * Ids are `m<index>`; the first node is a structural root.
 */
export function linearConversationText(messages: number, o: { omitChildren?: boolean; id?: string } = {}): string {
  const id = o.id ?? syntheticUuid(7);
  const entries: Array<[string, unknown]> = [];
  entries.push(['client-created-root', { id: 'client-created-root', message: null, parent: null, ...(o.omitChildren === true ? {} : { children: messages > 0 ? ['m0'] : [] }) }]);
  let prev = 'client-created-root';
  for (let i = 0; i < messages; i++) {
    const mid = `m${i}`;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    entries.push([
      mid,
      {
        id: mid,
        message: {
          id: mid,
          author: { role, name: null, metadata: {} },
          create_time: BASE_UNIX_SECONDS + i + 0.5,
          update_time: null,
          content: { content_type: 'text', parts: [`synthetic ${role} message ${i} about topic${i % 97}`] },
          status: 'finished_successfully',
          metadata: role === 'assistant' ? { model_slug: 'synthetic-model-1' } : {},
          recipient: 'all',
        },
        parent: prev,
        ...(o.omitChildren === true ? {} : { children: i + 1 < messages ? [`m${i + 1}`] : [] }),
      },
    ]);
    prev = mid;
  }
  return stringify({ id, conversation_id: id, title: `${SYNTHETIC_MARKER} scale`, create_time: BASE_UNIX_SECONDS, update_time: BASE_UNIX_SECONDS + messages, mapping: ordered(entries), current_node: messages > 0 ? prev : null }, 0);
}
