/**
 * ATK-04: MCP tool results (the JSON text block AND structuredContent) must not carry raw C1 controls, bidi controls, TAG
 * characters or U+2028 / U+2029 from imported text. The CLI writes them as visible \uXXXX escapes; the MCP result now does the same,
 * through the ONE shared implementation (src/format/scrub.ts).
 *
 * Contract (docs/MCP_TOOLS.md section 3.4): the result stays valid JSON; parsing content[0].text still gives exactly the
 * structuredContent; every string equals the original text EXCEPT that each of these characters is replaced by its six visible
 * characters (backslash, u, four hex digits; a TAG character, being a surrogate pair, by two such escapes). Keys, numbers and
 * booleans are unchanged. Ordinary text of every script (CJK, accents, emoji), TAB, LF and CR are untouched.
 *
 * Real SDK client over a real database built through the production import path; the stdio test reads the raw bytes the compiled
 * server writes. SYNTHETIC data only; every hazardous character is built from a code point (this file has none typed in).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { GcrError } from '../../src/errors.js';
import { visibleEscapes } from '../../src/format/scrub.js';
import { boundEnvelope, errorEnvelope, successEnvelope, toCallToolResult } from '../../src/mcp/envelope.js';
import type { McpEnvelope, Reduction } from '../../src/mcp/envelope.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, SYNTHETIC_MARKER, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { INITIALIZED, assertOnlyJsonRpcFrames, connectMem, conversationsJson, envelopeOf, fixedClock, initializeMessage, makeTempDir, removeDir, spawnRaw, writeText } from './mcp.helpers.test.js';
import type { MemHarness } from './mcp.helpers.test.js';

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const unit = (u: number): string => `\\u${u.toString(16).padStart(4, '0')}`;
/** The visible form of ONE character, spelled out independently of the implementation. */
function visible(ch: string): string {
  return Array.from({ length: ch.length }, (_, i) => unit(ch.charCodeAt(i))).join('');
}

/** Every class the finding names, with representatives at both ends of each range. */
const HAZARDS: ReadonlyArray<readonly [name: string, chars: readonly string[]]> = [
  ['C1 controls', [cp(0x80), cp(0x85), cp(0x9b), cp(0x9f)]],
  ['DEL', [cp(0x7f)]],
  ['bidi marks', [cp(0x200e), cp(0x200f), cp(0x61c)]],
  ['bidi embeddings and overrides', [cp(0x202a), cp(0x202b), cp(0x202c), cp(0x202d), cp(0x202e)]],
  ['bidi isolates', [cp(0x2066), cp(0x2067), cp(0x2068), cp(0x2069)]],
  ['TAG characters', [cp(0xe0000), cp(0xe0041), cp(0xe007f)]],
  ['line and paragraph separators', [cp(0x2028), cp(0x2029)]],
];
const ALL_HAZARDS: readonly string[] = HAZARDS.flatMap(([, chars]) => chars);
const ORDINARY = `plain ${cp(0x65e5, 0x672c, 0x8a9e)} Caf${cp(0xe9)} na${cp(0xef)}ve ${cp(0x1f600)} ${cp(0x5d0, 0x5d1)} ${cp(0x627, 0x628)} tab\there\nnew line\r\nand CR`;

/** true when `text` holds any raw hazardous character (the C1 range, bidi, TAG block, separators, DEL). */
function hasRawHazard(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x7f && c <= 0x9f) || c === 0x61c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x2028 || c === 0x2029 || (c >= 0xe0000 && c <= 0xe007f)) return true;
  }
  return false;
}

/** Every string and every key found anywhere in a parsed value. */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      stringsOf(v, into);
    }
  }
  return into;
}

function textOf(res: CallToolResult): string {
  return (res.content[0] as { type: 'text'; text: string }).text;
}

/** No raw hazardous character in the text block (as a string) nor in any string or key of structuredContent. */
function assertNoRawHazards(res: CallToolResult, what: string): void {
  assert.equal(hasRawHazard(textOf(res)), false, `${what}: content[0].text carries a raw hazardous character`);
  const bad = stringsOf(res.structuredContent).filter(hasRawHazard);
  assert.deepEqual(bad.map((s) => s.slice(0, 40)), [], `${what}: structuredContent carries raw hazardous characters`);
}

describe('visibleEscapes (the shared string-level scrubber)', () => {
  it('replaces every hazardous character by its visible escape and nothing else', () => {
    for (const [name, chars] of HAZARDS) {
      for (const ch of chars) assert.equal(visibleEscapes(`a${ch}b`), `a${visible(ch)}b`, `${name} U+${(ch.codePointAt(0) ?? 0).toString(16)}`);
    }
    assert.equal(visibleEscapes(cp(0xe0041)), `${unit(0xdb40)}${unit(0xdc41)}`, 'a TAG character is its surrogate pair, escaped per code unit like the CLI JSON');
  });

  it('is exactly the identity on ordinary text, C0 controls and lone surrogates (JSON.stringify already escapes those)', () => {
    for (const text of [ORDINARY, '', 'ascii only', `esc ${cp(0x1b)}[31m bell ${cp(7)}`, `lone ${String.fromCharCode(0xd800)} high`, `${cp(0x1f600, 0xe9, 0x4e16)}`]) {
      assert.equal(visibleEscapes(text), text);
    }
  });

  it('returns the same string object when there is nothing to do, and is idempotent on its own output', () => {
    const dirty = `x${ALL_HAZARDS.join('')}y`;
    const once = visibleEscapes(dirty);
    assert.equal(hasRawHazard(once), false);
    assert.equal(visibleEscapes(once), once);
  });
});

describe('toCallToolResult', () => {
  const okEnvelope = (data: Record<string, unknown>): McpEnvelope => ({ ok: true, data, source: [], completeness: 'unknown', warnings: [], ids: {}, untrustedContent: true, truncated: false });

  it('every class is escaped in the text block AND in structuredContent, in values, nested values, arrays, keys, warnings and ids', () => {
    for (const [name, chars] of HAZARDS) {
      const joined = chars.join('|');
      const env: McpEnvelope = {
        ...okEnvelope({ title: `t ${joined} t`, nested: { list: [`n ${joined}`, 1, true, null], [`k${joined}`]: 'v' } }),
        warnings: [{ code: 'X', message: `m ${joined}`, ids: [`i ${joined}`] }],
        ids: { conversationIds: [`c ${joined}`] },
      };
      const res = toCallToolResult(env);
      assertNoRawHazards(res, name);
      const parsed = JSON.parse(textOf(res)) as McpEnvelope;
      assert.deepEqual(res.structuredContent, parsed, `${name}: text and structuredContent still say the same thing`);
      const expected = chars.map(visible).join('|');
      assert.equal((parsed.data as { title: string }).title, `t ${expected} t`, name);
      assert.deepEqual((parsed.data as { nested: { list: unknown[] } }).nested.list, [`n ${expected}`, 1, true, null], name);
      assert.equal(parsed.warnings[0]?.message, `m ${expected}`);
      assert.deepEqual(parsed.warnings[0]?.ids, [`i ${expected}`]);
      assert.deepEqual(parsed.ids.conversationIds, [`c ${expected}`]);
      assert.equal(Object.keys((parsed.data as { nested: object }).nested).includes(`k${expected}`), true, 'a key is escaped too');
    }
  });

  it('keys, numbers, booleans, nulls and the envelope structure are unchanged; ordinary text survives byte for byte', () => {
    const env = okEnvelope({ ordinary: ORDINARY, count: 42, ratio: 0.5, flag: false, none: null, 'plain-key': [1, 2, 3], gone: undefined });
    const res = toCallToolResult(env);
    const parsed = JSON.parse(textOf(res)) as McpEnvelope;
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(env)), 'identical to plain JSON serialization');
    assert.equal((parsed.data as { ordinary: string }).ordinary, ORDINARY);
    assert.deepEqual(res.structuredContent, parsed);
    assert.equal(textOf(res), JSON.stringify(env), 'no hazard, so the text is the very same bytes as before');
  });

  it('the visible escape is the literal six characters: JSON-escaped once more in the text, parsed back to six characters', () => {
    const res = toCallToolResult(okEnvelope({ s: cp(0x202e) }));
    assert.ok(textOf(res).includes('"s":"\\\\u202e"'), textOf(res));
    assert.equal((res.structuredContent as { data: { s: string } }).data.s, '\\u202e');
  });

  it('an error envelope is scrubbed the same way (details can quote imported ids)', () => {
    const res = toCallToolResult(errorEnvelope(new GcrError('INVALID_ARGUMENT', 'm', { details: { id: `a${cp(0x85)}b${cp(0xe0041)}` } })));
    assertNoRawHazards(res, 'error');
    assert.equal(res.isError, true);
    assert.deepEqual((res.structuredContent as { error: { details: unknown } }).error.details, { id: `a${visible(cp(0x85))}b${visible(cp(0xe0041))}` });
  });

  it('the size cap is measured AFTER the escapes grow the text: the wire result never exceeds the cap', () => {
    // 6 visible characters (7 bytes in the envelope) for every 2-byte U+0085: a result sized by its raw bytes would overshoot 3 times over.
    const hostile = cp(0x85).repeat(400);
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `item-${i}`, text: hostile, tag: cp(0xe0041).repeat(40) }));
    const plan: readonly Reduction[] = [{ kind: 'list', path: ['items'] }];
    const cap = 20_000;
    const bounded = boundEnvelope(okEnvelope({ items }), plan, cap);
    assert.equal(bounded.truncated, true);
    const res = toCallToolResult(bounded);
    assert.ok(Buffer.byteLength(textOf(res), 'utf8') <= cap, `${Buffer.byteLength(textOf(res), 'utf8')} bytes against a cap of ${cap}`);
    assert.ok((bounded.data?.['items'] as unknown[]).length > 0, 'something still fits');
    assertNoRawHazards(res, 'bounded');
  });

  it('successEnvelope output goes through the same path (a real SDK-shaped envelope)', () => {
    const env = successEnvelope({ ok: true, data: { title: `t${cp(0x9b)}31m` }, source: [], completeness: 'unknown', warnings: [], ids: {}, untrustedContent: true });
    assertNoRawHazards(toCallToolResult(env), 'successEnvelope');
  });
});

describe('through the real SDK client over a real database', () => {
  const id = syntheticUuid(0x41);
  const csi = cp(0x9b);
  const nel = cp(0x85);
  const rlo = cp(0x202e);
  const tag = cp(0xe0041);
  const ls = cp(0x2028);
  const lrm = cp(0x200e);
  const hostileTitle = `${SYNTHETIC_MARKER} title ${cp(0x1b)}]0;PWNED${cp(7)} ${csi}31m ${nel} ${rlo}rtl ${tag}tag ${ls} ${lrm} ${ORDINARY}`;
  const hostileText = `body ${cp(0x1b)}[2J ${csi}31m ${nel} ${rlo}exe.txt ${tag}${cp(0xe0042)} ${ls}${cp(0x2029)} ${cp(0x61c)}${cp(0x200f)}${cp(0x2066)}x${cp(0x2069)} ${ORDINARY}`;
  const expectedTitle = visibleEscapes(hostileTitle);
  const expectedText = visibleEscapes(hostileText);
  let dir: string;
  let dbPath: string;
  let h: MemHarness;

  before(async () => {
    dir = await makeTempDir();
    dbPath = join(dir, 'gcr.sqlite');
    const b = new ConversationBuilder({ id, title: hostileTitle });
    let prev = b.root();
    prev = b.user(prev, hostileText);
    b.assistant(prev, `reply ${hostileText}`, { model: 'synthetic-model-1' });
    const path = await writeText(dir, join('export', 'conversations.json'), conversationsJson([b]));
    const gcr = Gcr.open({ dbPath, clock: fixedClock });
    try {
      await gcr.importExport({ source: { kind: 'path', path } });
      await gcr.buildGraph({ minEntityConversations: 1 });
    } finally {
      gcr.close();
    }
    h = await connectMem(dbPath);
  });
  after(async () => {
    await h.close();
    await removeDir(dir);
  });

  it('the stored text really contains the hazards (the test is not vacuous), and the expected form really differs', () => {
    assert.equal(hasRawHazard(hostileTitle) && hasRawHazard(hostileText), true);
    assert.notEqual(expectedTitle, hostileTitle);
    assert.equal(hasRawHazard(expectedTitle) || hasRawHazard(expectedText), false);
  });

  it('gcr_list, gcr_get, gcr_thread and gcr_branches: no raw hazard anywhere; title and bodies are the visible-escape form; ordinary text intact', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['gcr_list', {}],
      ['gcr_get', { conversation: id }],
      ['gcr_get', { conversation: id, allBranches: true }],
      ['gcr_thread', { conversation: id }],
      ['gcr_branches', { conversation: id }],
      ['gcr_search', { query: 'body', scope: 'all' }],
      ['gcr_stats', { groupBy: 'conversation' }],
      ['gcr_audit', {}],
      ['gcr_graph_query', { term: 'body' }],
    ];
    for (const [tool, args] of calls) {
      const res = await h.call(tool, args);
      assertNoRawHazards(res, `${tool} ${JSON.stringify(args)}`);
      const env = envelopeOf(res); // text === structuredContent, strict output schema, isError iff !ok
      assert.equal(env.ok, true, `${tool}: ${env.error?.message ?? ''}`);
    }

    const list = (await h.env('gcr_list', {})).data as { items: Array<{ title: string }> };
    assert.equal(list.items[0]?.title, expectedTitle);

    const got = await h.env('gcr_get', { conversation: id });
    const data = got.data as { conversation: { title: string }; thread: { messages: Array<{ text: string }> } };
    assert.equal(data.conversation.title, expectedTitle);
    assert.equal(data.thread.messages[0]?.text, expectedText);
    assert.equal(data.thread.messages[1]?.text, `reply ${expectedText}`);
    for (const piece of [cp(0x65e5, 0x672c, 0x8a9e), `Caf${cp(0xe9)}`, cp(0x1f600), 'tab\there', 'new line\r\nand CR']) {
      assert.ok(data.thread.messages[0]?.text.includes(piece), `ordinary text ${JSON.stringify(piece)} is untouched`);
    }
  });

  it('the stdio server never writes a raw hazardous character: not one byte of the UTF-8 form of any class reaches stdout', async () => {
    const c = spawnRaw(['--db', dbPath]);
    try {
      c.send(initializeMessage(SUPPORTED_PROTOCOL_VERSIONS[0] as string, 1));
      await c.response(1);
      c.send(INITIALIZED);
      c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gcr_get', arguments: { conversation: id, allBranches: true } } });
      c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gcr_list', arguments: {} } });
      const get = await c.response(2);
      await c.response(3);
      const bytes = c.stdout();
      assertOnlyJsonRpcFrames(bytes);
      for (const ch of ALL_HAZARDS) {
        assert.equal(bytes.includes(Buffer.from(ch, 'utf8')), false, `U+${(ch.codePointAt(0) ?? 0).toString(16)} is on the wire as a raw character`);
      }
      const result = (get as { result: CallToolResult }).result;
      assertNoRawHazards(result, 'stdio gcr_get');
      assert.equal(((result.structuredContent as { data: { conversation: { title: string } } }).data).conversation.title, expectedTitle);
    } finally {
      c.child.stdin.end();
      await c.exited;
    }
  });
});
