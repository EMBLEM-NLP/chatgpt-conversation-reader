/**
 * renderThread: golden output in all four formats, hidden/structural handling, truncation, NOTICE for non-exported_tree
 * completeness, provenance/warnings in every format, option validation, determinism. Fixtures are built from
 * test/helpers/records.ts; every id, title and text is invented.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConversationSummary, ThreadResult } from '../../src/domain/results.js';
import type { Completeness, MessageRecord, SourceSummary } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { renderThread } from '../../src/format/render.js';
import type { RenderOptions } from '../../src/format/render.js';
import { TOOL_VERSION } from '../../src/version.js';
import { iso, msg } from '../helpers/records.js';

const CONV = 'conv-1';
const FORMATS = ['json', 'markdown', 'compact', 'jsonl'] as const;

function source(over: Partial<SourceSummary> = {}): SourceSummary {
  return {
    provider: 'chatgpt',
    accountLabel: 'default',
    provenance: 'official_chatgpt_export',
    completeness: 'exported_tree',
    batchId: 'b_synthetic00000001',
    sourceLabel: 'synthetic-export.zip',
    importedAt: '2025-02-01T00:00:00.000Z',
    toolVersion: 'import-tool-9.9.9',
    ...over,
  };
}

function summary(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    provider: 'chatgpt',
    accountLabel: 'default',
    conversationId: CONV,
    title: 'Synthetic title',
    createdAt: iso(0),
    updatedAt: iso(3),
    messageCount: 3,
    currentNodeId: 'conv-1-a0',
    defaultModelSlug: null,
    provenance: 'official_chatgpt_export',
    completeness: 'exported_tree',
    batchId: 'b_synthetic00000001',
    importedAt: '2025-02-01T00:00:00.000Z',
    ...over,
  };
}

const ROOT = msg({ id: 'conv-1-root', conversationId: CONV, nodeKind: 'structural_empty', authorRole: '', contentType: null });
const U0 = msg({ id: 'conv-1-u0', conversationId: CONV, parentId: 'conv-1-root', authorRole: 'user', createdAt: iso(1), text: 'Hello there', ordinal: 1 });
const A0 = msg({ id: 'conv-1-a0', conversationId: CONV, parentId: 'conv-1-u0', authorRole: 'assistant', modelSlug: 'synthetic-model-1', createdAt: iso(2), text: 'Hi!\nSecond line', ordinal: 2 });
const SYS = msg({ id: 'conv-1-s0', conversationId: CONV, parentId: 'conv-1-a0', authorRole: 'system', hidden: true, createdAt: iso(3), text: 'scaffold', ordinal: 3 });

function thread(messages: MessageRecord[], over: Partial<ThreadResult> = {}): ThreadResult {
  return {
    conversation: summary(),
    branchId: 'conv-1-a0',
    activeness: 'active',
    messages,
    omittedHidden: 0,
    selectionPolicy: 'source_current_node',
    warnings: [],
    ...over,
  };
}

/** The standard fixture: structural root + user + assistant + hidden system message; the SDK already dropped one more hidden message. */
function standard(): ThreadResult {
  return thread([ROOT, U0, A0, SYS], { omittedHidden: 1 });
}

function render(result: ThreadResult, opts: Partial<RenderOptions> & { format: RenderOptions['format'] }, src: SourceSummary = source()): string {
  return renderThread(result, src, opts);
}

function parseLines(jsonl: string): Array<Record<string, unknown>> {
  assert.ok(jsonl.endsWith('\n'));
  return jsonl
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectInvalidArgument(fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${String(e)}`);
    assert.equal(e.code, 'INVALID_ARGUMENT');
    return true;
  });
}

describe('renderThread golden output (UTC)', () => {
  it('markdown', () => {
    const expected = `# Synthetic title

- Conversation ID: \`conv-1\`
- Provider / account: chatgpt / \`default\`
- Provenance: official_chatgpt_export
- Completeness: exported_tree
- Source batch: \`b_synthetic00000001\`
- Source file: \`synthetic-export.zip\`
- Imported at: 2025-02-01 00:00:00 UTC (UTC+00:00)
- Imported with tool version: import-tool-9.9.9
- Conversation created: 2025-01-01 00:00:00 UTC (UTC+00:00)
- Conversation updated: 2025-01-01 00:03:00 UTC (UTC+00:00)
- Tool version: gcr ${TOOL_VERSION}
- Selected branch: \`conv-1-a0\` (activeness: active)
- Branch selection: source_current_node - from the source's own current node
- Timezone: \`UTC\`
- Messages shown: 2 (hidden omitted: 2; structural omitted: 1)
- Message body: fenced (each body is inside a code fence; embedded Markdown/HTML is shown literally)

## Messages

### 1. user - 2025-01-01 00:01:00 UTC (UTC+00:00)

id \`conv-1-u0\` · type \`text\`

\`\`\`
Hello there
\`\`\`

### 2. assistant (synthetic-model-1) - 2025-01-01 00:02:00 UTC (UTC+00:00)

id \`conv-1-a0\` · type \`text\`

\`\`\`
Hi!
Second line
\`\`\`

## Warnings

None.
`;
    assert.equal(render(standard(), { format: 'markdown' }), expected);
  });

  it('compact', () => {
    // The "# omitted:" line was added by the adversarial review: the fixture drops 2 hidden messages and 1 structural root,
    // and a compact rendering that does not say so presents a partial branch as the whole one (FR-09).
    const expected = `# Synthetic title | chatgpt | exported_tree | conv-1-a0
# source: provenance=official_chatgpt_export | account=default | batch=b_synthetic00000001 | imported=2025-02-01 00:00:00 UTC (UTC+00:00) | tool=gcr ${TOOL_VERSION} | tz=UTC | selection=source_current_node | conversation=conv-1
# omitted: 2 hidden message(s), 1 structural node(s)
[user] Hello there
[assistant] Hi!
  Second line
`;
    assert.equal(render(standard(), { format: 'compact' }), expected);
  });

  it('jsonl: header, one line per message, footer; every line standalone JSON', () => {
    const out = render(standard(), { format: 'jsonl' });
    const lines = parseLines(out);
    assert.equal(lines.length, 4);
    const [header, m1, m2, footer] = lines;
    assert.ok(header && m1 && m2 && footer);
    assert.equal(header['type'], 'header');
    assert.equal(header['kind'], 'thread');
    assert.equal(header['completeness'], 'exported_tree');
    assert.deepEqual(header['tool'], { name: 'gcr', version: TOOL_VERSION });
    assert.deepEqual(header['source'], [{ ...source() }]);
    assert.equal(header['untrustedContent'], true);
    assert.equal(header['branchId'], 'conv-1-a0');
    assert.equal(header['omittedHidden'], 2);
    assert.equal(header['omittedStructural'], 1);
    assert.equal(header['messageCount'], 2);
    assert.deepEqual(header['ids'], { conversationIds: [CONV], messageIds: ['conv-1-u0', 'conv-1-a0'], branchIds: ['conv-1-a0'] });
    assert.equal(m1['type'], 'message');
    assert.equal(m1['id'], 'conv-1-u0');
    assert.equal(m1['text'], 'Hello there');
    assert.equal(m1['createdAt'], '2025-01-01T00:01:00.000Z', 'timestamps stay UTC ISO in machine formats');
    assert.equal(m2['modelSlug'], 'synthetic-model-1');
    assert.equal(m2['text'], 'Hi!\nSecond line');
    assert.deepEqual(footer, { type: 'footer', warnings: [] });
    for (const raw of out.slice(0, -1).split('\n')) assert.ok(!raw.includes('\n') && raw.startsWith('{') && raw.endsWith('}'));
  });

  it('json: pretty-printed with 2 spaces and the documented top-level key order', () => {
    const out = render(standard(), { format: 'json' });
    assert.ok(out.startsWith('{\n  "ok": true,\n  "data": {\n    "conversation": {'));
    assert.ok(out.endsWith('\n}\n'));
    const parsed = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['ok', 'data', 'source', 'completeness', 'warnings', 'ids', 'untrustedContent', 'tool']);
    assert.deepEqual(parsed['tool'], { name: 'gcr', version: TOOL_VERSION });
    assert.deepEqual(parsed['warnings'], []);
    const data = parsed['data'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(data), ['conversation', 'branchId', 'activeness', 'selectionPolicy', 'omittedHidden', 'omittedStructural', 'messages']);
    assert.equal((data['messages'] as unknown[]).length, 2);
    assert.equal(JSON.stringify(JSON.parse(out), null, 2) + '\n', out, 'canonical 2-space pretty printing');
  });

  it('every format ends with exactly one newline', () => {
    for (const format of FORMATS) {
      const out = render(standard(), { format });
      assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'), format);
    }
  });
});

describe('renderThread time zones', () => {
  it('markdown shows the time in the requested zone plus the UTC value; compact header shows the zone; JSON stays UTC', () => {
    const md = render(standard(), { format: 'markdown', tz: 'America/New_York' });
    assert.match(md, /^### 1\. user - 2024-12-31 19:01:00 EST \(UTC-05:00\)$/m);
    assert.match(md, /^id `conv-1-u0` · type `text` · UTC `2025-01-01T00:01:00Z`$/m);
    assert.match(md, /^- Timezone: `America\/New_York`$/m);
    assert.match(md, /^- Imported at: 2025-01-31 19:00:00 EST \(UTC-05:00\)$/m);
    const compact = render(standard(), { format: 'compact', tz: 'Asia/Kolkata' });
    assert.ok(compact.split('\n')[1]?.includes('tz=Asia/Kolkata'));
    assert.ok(compact.split('\n')[1]?.includes('imported=2025-02-01 05:30:00 Asia/Kolkata (UTC+05:30)'));
    const json = JSON.parse(render(standard(), { format: 'json', tz: 'Asia/Kolkata' })) as { data: { messages: Array<{ createdAt: string }> } };
    assert.equal(json.data.messages[0]?.createdAt, '2025-01-01T00:01:00.000Z');
  });

  it('a missing timestamp is "unknown" in headings, never a made-up time', () => {
    const noTime = msg({ id: 'conv-1-n', conversationId: CONV, authorRole: 'user', createdAt: null, text: 'no time', ordinal: 1 });
    const md = render(thread([noTime]), { format: 'markdown', tz: 'Asia/Kolkata' });
    assert.match(md, /^### 1\. user - unknown$/m);
    assert.ok(!md.includes('UTC `'), 'no UTC line is invented either');
    const invalid = msg({ id: 'conv-1-i', conversationId: CONV, authorRole: 'user', createdAt: 'yesterday', text: 'bad time', ordinal: 1 });
    assert.match(render(thread([invalid]), { format: 'markdown' }), /^### 1\. user - invalid$/m);
  });

  it('rejects an invalid zone in EVERY format (a bad option never depends on --format)', () => {
    for (const format of FORMATS) expectInvalidArgument(() => render(standard(), { format, tz: 'Not/AZone' }));
  });
});

describe('renderThread hidden and structural messages', () => {
  it('omits them by default in every format and reports how many were omitted', () => {
    for (const format of FORMATS) {
      const out = render(standard(), { format });
      assert.ok(!out.includes('scaffold'), `${format}: hidden text must not appear`);
      // JSON legitimately mentions the root as the parentId of the first message, so only the human formats are string-checked.
      if (format === 'markdown' || format === 'compact') assert.ok(!out.includes('conv-1-root'), `${format}: structural node must not appear`);
    }
    const ids = (JSON.parse(render(standard(), { format: 'json' })) as { data: { messages: Array<{ id: string }> } }).data.messages.map((m) => m.id);
    assert.deepEqual(ids, ['conv-1-u0', 'conv-1-a0']);
    assert.deepEqual(
      parseLines(render(standard(), { format: 'jsonl' }))
        .filter((l) => l['type'] === 'message')
        .map((l) => l['id']),
      ['conv-1-u0', 'conv-1-a0'],
    );
    assert.match(render(standard(), { format: 'markdown' }), /^- Messages shown: 2 \(hidden omitted: 2; structural omitted: 1\)$/m);
  });

  it('with includeHidden they appear and are labelled', () => {
    const md = render(standard(), { format: 'markdown', includeHidden: true });
    assert.match(md, /^### 1\. \*\(no role\)\* \[structural\] - unknown$/m);
    assert.match(md, /^### 4\. system \[hidden\] - 2025-01-01 00:03:00 UTC \(UTC\+00:00\)$/m);
    assert.match(md, /^- Messages shown: 4 \(hidden omitted: 1; structural omitted: 0\)$/m);
    const compact = render(standard(), { format: 'compact', includeHidden: true });
    const tags = compact.split('\n').filter((l) => l.startsWith('['));
    assert.deepEqual(tags, ['[(no role)|structural]', '[user] Hello there', '[assistant] Hi!', '[system|hidden] scaffold']);
    const json = JSON.parse(render(standard(), { format: 'json', includeHidden: true })) as { data: { messages: Array<{ id: string; hidden: boolean; nodeKind: string }>; omittedHidden: number } };
    assert.deepEqual(
      json.data.messages.map((m) => [m.id, m.hidden, m.nodeKind]),
      [
        ['conv-1-root', false, 'structural_empty'],
        ['conv-1-u0', false, 'message'],
        ['conv-1-a0', false, 'message'],
        ['conv-1-s0', true, 'message'],
      ],
    );
    assert.equal(json.data.omittedHidden, 1, 'only what the SDK had already dropped is still omitted');
  });

  it('the SDK-reported omittedHidden is carried through and added to what rendering drops (negative: nothing hidden -> 0)', () => {
    const none = thread([U0, A0]);
    const header = parseLines(render(none, { format: 'jsonl' }))[0];
    assert.equal(header?.['omittedHidden'], 0);
    assert.equal(header?.['omittedStructural'], 0);
  });

  it('an empty selection says so instead of printing an empty section', () => {
    const md = render(thread([ROOT]), { format: 'markdown' });
    assert.ok(md.includes('No messages to show.'));
    // Adversarial review: the compact output used to be just header + source line, i.e. it did not say WHY nothing was shown.
    // It now states what was left out (FR-09), so the structural root is reported on a third comment line.
    const compact = render(thread([ROOT]), { format: 'compact' }).split('\n');
    assert.equal(compact.length, 4, 'header + source line + omitted note + trailing newline only');
    assert.equal(compact[2], '# omitted: 0 hidden message(s), 1 structural node(s)');
    assert.equal(render(thread([]), { format: 'compact' }).split('\n').length, 3, 'nothing omitted: header + source line + trailing newline only');
  });
});

describe('renderThread headings and labels', () => {
  it('model slug appears only when the source supplied it', () => {
    const md = render(standard(), { format: 'markdown' });
    assert.match(md, /^### 2\. assistant \(synthetic-model-1\) - /m);
    const noModel = msg({ id: 'x', conversationId: CONV, authorRole: 'assistant', modelSlug: null, createdAt: iso(1), text: 'a', ordinal: 1 });
    assert.match(render(thread([noModel]), { format: 'markdown' }), /^### 1\. assistant - /m);
    const emptyModel = msg({ id: 'x', conversationId: CONV, authorRole: 'assistant', modelSlug: '', createdAt: iso(1), text: 'a', ordinal: 1 });
    assert.match(render(thread([emptyModel]), { format: 'markdown' }), /^### 1\. assistant - /m);
  });

  it('unrecognized role strings are preserved verbatim', () => {
    const odd = msg({ id: 'x', conversationId: CONV, authorRole: 'tool', createdAt: iso(1), text: 'out', ordinal: 1, channel: 'commentary', recipient: 'python', status: 'finished_successfully' });
    const md = render(thread([odd]), { format: 'markdown' });
    assert.match(md, /^### 1\. tool - /m);
    assert.match(md, /channel `commentary` · recipient `python` · status `finished_successfully`/);
    assert.match(render(thread([odd]), { format: 'compact' }), /^\[tool\] out$/m);
  });

  it('untitled conversations are shown as such', () => {
    const untitled = thread([U0], { conversation: summary({ title: null }) });
    assert.ok(render(untitled, { format: 'markdown' }).startsWith('# *(untitled)*\n'));
    assert.ok(render(untitled, { format: 'compact' }).startsWith('# (untitled) | chatgpt | exported_tree | conv-1-a0\n'));
  });

  it('heuristic and single-branch selections are labelled honestly', () => {
    const heuristic = render(thread([U0], { selectionPolicy: 'last_child', activeness: 'unknown' }), { format: 'markdown' });
    assert.match(heuristic, /^- Branch selection: last_child - HEURISTIC "last_child": not provided by the source$/m);
    assert.match(heuristic, /\(activeness: unknown\)/);
    const only = render(thread([U0], { selectionPolicy: 'only_branch' }), { format: 'markdown' });
    assert.match(only, /^- Branch selection: only_branch - the conversation has exactly one branch, so nothing was inferred$/m);
    assert.match(render(thread([U0], { selectionPolicy: 'explicit_branch' }), { format: 'markdown' }), /chosen explicitly by the caller/);
  });

  it('non-text blocks and attachments are flagged so a reader knows content exists beyond the text', () => {
    const rich = msg({
      id: 'x',
      conversationId: CONV,
      authorRole: 'assistant',
      createdAt: iso(1),
      text: 'see image',
      ordinal: 1,
      blocks: [{ type: 'text', text: 'see image' }, { type: 'image_ref', metadata: { pointer: 'file-service://abc' } }],
      attachments: [{ id: 'f1', name: 'diagram.png', mimeType: 'image/png', sizeBytes: 10, assetPointer: 'file-service://abc', presentInExportAs: null }],
    });
    const md = render(thread([rich]), { format: 'markdown' });
    assert.match(md, /non-text blocks `image_ref`x1/);
    assert.match(md, /attachments 1: `diagram\.png`/);
    const json = JSON.parse(render(thread([rich]), { format: 'json' })) as { data: { messages: Array<{ blocks: unknown[]; attachments: unknown[] }> } };
    assert.equal(json.data.messages[0]?.blocks.length, 2);
    assert.equal(json.data.messages[0]?.attachments.length, 1);
  });
});

describe('renderThread truncation', () => {
  const long = msg({ id: 'conv-1-long', conversationId: CONV, authorRole: 'assistant', createdAt: iso(1), text: 'abcdefghij', ordinal: 1 });

  it('is explicit in every format: marker with the removed count, plus a MESSAGE_TRUNCATED warning', () => {
    const t = thread([long]);
    const md = render(t, { format: 'markdown', maxMessageChars: 5 });
    assert.ok(md.includes('```\nabcde\n```\n\n[truncated 5 chars]\n'));
    assert.match(md, /^- `MESSAGE_TRUNCATED`: .*maxMessageChars=5.*\(ids: `conv-1-long`\)$/m);
    assert.ok(!md.includes('abcdef'));

    const compact = render(t, { format: 'compact', maxMessageChars: 5 });
    assert.ok(compact.includes('[assistant] abcde\n  [truncated 5 chars]\n'));
    assert.match(compact, /^# warnings: MESSAGE_TRUNCATED: /m);

    const json = JSON.parse(render(t, { format: 'json', maxMessageChars: 5 })) as { data: { messages: Array<{ text: string; truncatedChars?: number }> }; warnings: Array<{ code: string; ids?: string[] }> };
    assert.equal(json.data.messages[0]?.text, 'abcde\n[truncated 5 chars]');
    assert.equal(json.data.messages[0]?.truncatedChars, 5);
    assert.equal(json.warnings[0]?.code, 'MESSAGE_TRUNCATED');
    assert.deepEqual(json.warnings[0]?.ids, ['conv-1-long']);

    const lines = parseLines(render(t, { format: 'jsonl', maxMessageChars: 5 }));
    assert.equal(lines[1]?.['text'], 'abcde\n[truncated 5 chars]');
    assert.equal((lines[2]?.['warnings'] as Array<{ code: string }>)[0]?.code, 'MESSAGE_TRUNCATED');
  });

  it('does not leave an untruncated copy of the text in block data', () => {
    const withBlocks = msg({ ...long, blocks: [{ type: 'text', text: 'abcdefghij' }, { type: 'code', text: 'zzzzzzzzzz', metadata: { big: 'y'.repeat(500) } }] });
    const out = render(thread([withBlocks]), { format: 'json', maxMessageChars: 5 });
    assert.ok(!out.includes('abcdef') && !out.includes('zzzzzz') && !out.includes('yyyyyy'), out);
    const parsed = JSON.parse(out) as { data: { messages: Array<{ blocks: Array<{ text?: string; metadata?: { omitted?: boolean } }> }> } };
    assert.equal(parsed.data.messages[0]?.blocks[0]?.text, 'abcde\n[truncated 5 chars]');
    assert.equal(parsed.data.messages[0]?.blocks[1]?.metadata?.omitted, true);
  });

  it('counts Unicode code points, never splitting a surrogate pair', () => {
    const emoji = msg({ ...long, text: '😀😀😀' });
    const json = JSON.parse(render(thread([emoji]), { format: 'json', maxMessageChars: 2 })) as { data: { messages: Array<{ text: string; truncatedChars: number }> } };
    assert.equal(json.data.messages[0]?.text, '😀😀\n[truncated 1 chars]');
    assert.equal(json.data.messages[0]?.truncatedChars, 1);
  });

  it('negative cases: a text at or under the limit is untouched and raises no warning; unlimited by default', () => {
    for (const max of [10, 11, 1000, Infinity]) {
      const out = JSON.parse(render(thread([long]), { format: 'json', maxMessageChars: max })) as { data: { messages: Array<{ text: string; truncatedChars?: number }> }; warnings: unknown[] };
      assert.equal(out.data.messages[0]?.text, 'abcdefghij');
      assert.equal(out.data.messages[0]?.truncatedChars, undefined);
      assert.deepEqual(out.warnings, []);
    }
    const md = render(thread([long]), { format: 'markdown' });
    assert.ok(!md.includes('[truncated') && md.includes('abcdefghij'));
  });

  it('0 cuts everything; raw mode marks the cut too', () => {
    const md = render(thread([long]), { format: 'markdown', maxMessageChars: 0, markdownBody: 'raw' });
    assert.ok(md.includes('*(empty)*\n\n[truncated 10 chars]'));
  });

  it('rejects invalid limits', () => {
    for (const bad of [-1, 1.5, Number.NaN, '5' as unknown as number, null as unknown as number]) {
      expectInvalidArgument(() => render(thread([long]), { format: 'json', maxMessageChars: bad }));
    }
  });
});

describe('renderThread completeness NOTICE (FR-09)', () => {
  const NON_EXPORTED: Completeness[] = ['rendered_active_view_only', 'partial_user_supplied', 'api_owned_conversation', 'unknown'];

  it('prints a visible NOTICE line in markdown and compact for every completeness other than exported_tree', () => {
    for (const completeness of NON_EXPORTED) {
      const t = thread([U0], { conversation: summary({ completeness }) });
      const src = source({ completeness });
      const md = render(t, { format: 'markdown' }, src);
      const compact = render(t, { format: 'compact' }, src);
      assert.match(md, new RegExp(`^NOTICE: completeness is "${completeness}"`, 'm'), completeness);
      assert.match(compact, new RegExp(`^NOTICE: completeness is "${completeness}"`, 'm'), completeness);
      assert.match(md, new RegExp(`^- Completeness: ${completeness}$`, 'm'));
      assert.ok(compact.split('\n')[0]?.includes(`| ${completeness} |`));
      // Machine formats carry the same fact in a field.
      assert.equal((JSON.parse(render(t, { format: 'json' }, src)) as { completeness: string }).completeness, completeness);
      assert.equal(parseLines(render(t, { format: 'jsonl' }, src))[0]?.['completeness'], completeness);
    }
  });

  it('says plainly that a rendered/partial source is not the full history', () => {
    const rendered = render(thread([U0], { conversation: summary({ completeness: 'rendered_active_view_only' }) }), { format: 'markdown' }, source({ completeness: 'rendered_active_view_only' }));
    assert.match(rendered, /NOT the full conversation history/);
    const partial = render(thread([U0], { conversation: summary({ completeness: 'partial_user_supplied' }) }), { format: 'compact' }, source({ completeness: 'partial_user_supplied' }));
    assert.match(partial, /NOT the full conversation history/);
  });

  it('prints no NOTICE for exported_tree (negative)', () => {
    for (const format of ['markdown', 'compact'] as const) assert.ok(!render(standard(), { format }).includes('NOTICE'), format);
  });

  it('a source/conversation disagreement becomes "mixed", which prints the NOTICE rather than trusting the stronger claim', () => {
    const t = thread([U0], { conversation: summary({ completeness: 'partial_user_supplied' }) });
    const md = render(t, { format: 'markdown' }, source({ completeness: 'exported_tree' }));
    assert.match(md, /^NOTICE: completeness is "mixed"/m);
    assert.equal((JSON.parse(render(t, { format: 'json' }, source({ completeness: 'exported_tree' }))) as { completeness: string }).completeness, 'mixed');
  });
});

describe('renderThread provenance and warnings are in EVERY format (FR-09)', () => {
  const warned = (): ThreadResult =>
    thread([U0, A0], { warnings: [{ code: 'MISSING_PARENT', message: 'node has no parent', ids: ['conv-1-u0', 'conv-1-a0'] }, { code: 'NO_CURRENT_NODE', message: 'no pointer' }] });

  it('markdown: header block + "## Warnings" at the end', () => {
    const md = render(warned(), { format: 'markdown' });
    for (const needle of ['official_chatgpt_export', 'exported_tree', 'b_synthetic00000001', 'import-tool-9.9.9', `gcr ${TOOL_VERSION}`, 'conv-1-a0', 'source_current_node', '`UTC`', '2025-02-01 00:00:00 UTC']) {
      assert.ok(md.includes(needle), `missing ${needle}`);
    }
    const tail = md.slice(md.indexOf('## Warnings'));
    assert.equal(tail, '## Warnings\n\n- `MISSING_PARENT`: node has no parent (ids: `conv-1-u0`, `conv-1-a0`)\n- `NO_CURRENT_NODE`: no pointer\n');
  });

  it('compact: trailing "# warnings:" line', () => {
    const lines = render(warned(), { format: 'compact' }).split('\n');
    assert.equal(lines[lines.length - 2], '# warnings: MISSING_PARENT: node has no parent (ids: conv-1-u0, conv-1-a0); NO_CURRENT_NODE: no pointer');
    assert.ok(!render(standard(), { format: 'compact' }).includes('# warnings'), 'none when there are no warnings');
  });

  it('json and jsonl: warnings array, source provenance, tool', () => {
    const json = JSON.parse(render(warned(), { format: 'json' })) as { warnings: unknown[]; source: Array<Record<string, unknown>> };
    assert.deepEqual(json.warnings, [
      { code: 'MISSING_PARENT', message: 'node has no parent', ids: ['conv-1-u0', 'conv-1-a0'] },
      { code: 'NO_CURRENT_NODE', message: 'no pointer' },
    ]);
    assert.equal(json.source[0]?.['provenance'], 'official_chatgpt_export');
    const lines = parseLines(render(warned(), { format: 'jsonl' }));
    assert.deepEqual((lines[lines.length - 1] as { warnings: unknown[] }).warnings, json.warnings);
  });

  it('markdown says "None." when there are no warnings (the section is always present)', () => {
    assert.ok(render(standard(), { format: 'markdown' }).endsWith('## Warnings\n\nNone.\n'));
  });
});

describe('renderThread raw body mode', () => {
  it('inserts the text without a fence and says so in the header; control characters are still escaped', () => {
    const t = thread([msg({ id: 'x', conversationId: CONV, authorRole: 'user', createdAt: iso(1), text: 'plain **bold**\u001b[31mred', ordinal: 1 })]);
    const md = render(t, { format: 'markdown', markdownBody: 'raw' });
    assert.match(md, /^- Message body: RAW \(/m);
    assert.ok(md.includes('\n\nplain **bold**\\u001B[31mred\n'));
    assert.ok(!md.includes('\u001b'));
    assert.ok(!/^```/m.test(md), 'no fence in raw mode');
  });

  it('fenced is the default and is stated in the header', () => {
    assert.match(render(standard(), { format: 'markdown' }), /^- Message body: fenced \(/m);
    assert.match(render(standard(), { format: 'markdown', markdownBody: 'fenced' }), /^- Message body: fenced \(/m);
  });

  it('rejects an unknown body mode', () => {
    expectInvalidArgument(() => render(standard(), { format: 'markdown', markdownBody: 'html' as unknown as 'raw' }));
  });
});

describe('renderThread hygiene and determinism', () => {
  it('never prints a path from sourceLabel and never copies rawSource / extra properties', () => {
    const SECRET = 'SECRET-RAW-SOURCE-MARKER';
    const withRaw = msg({ id: 'x', conversationId: CONV, authorRole: 'user', createdAt: iso(1), text: 'hi', ordinal: 1, rawSource: { password: SECRET } });
    const leaky = { ...summary(), rawMetadata: { token: SECRET } } as ConversationSummary;
    const src = { ...source({ sourceLabel: '/home/alice/private/exports/synthetic-export.zip' }), cookie: SECRET } as SourceSummary;
    for (const format of FORMATS) {
      const out = renderThread(thread([withRaw], { conversation: leaky }), src, { format });
      assert.ok(!out.includes(SECRET), `${format} leaked a raw field`);
      assert.ok(!out.includes('/home/alice'), `${format} leaked a path`);
      assert.ok(!out.includes('private/exports'), `${format} leaked a path`);
    }
    assert.ok(renderThread(thread([withRaw]), src, { format: 'markdown' }).includes('`synthetic-export.zip`'));
  });

  it('same input -> same bytes, and rendering does not mutate its inputs', () => {
    const t = standard();
    const before = JSON.stringify(t);
    for (const format of FORMATS) {
      const first = render(t, { format, tz: 'Europe/London', includeHidden: true });
      const second = render(structuredClone(t), { format, tz: 'Europe/London', includeHidden: true });
      assert.equal(first, second, format);
    }
    assert.equal(JSON.stringify(t), before);
  });

  it('rejects an unknown format and non-boolean includeHidden', () => {
    expectInvalidArgument(() => render(standard(), { format: 'yaml' as unknown as 'json' }));
    expectInvalidArgument(() => render(standard(), { format: 'json', includeHidden: 'yes' as unknown as boolean }));
    expectInvalidArgument(() => renderThread(standard(), source(), null as unknown as RenderOptions));
  });
});
