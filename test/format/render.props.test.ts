/**
 * Property tests for src/format/render.ts (fast-check, FIXED seed printed on failure).
 *
 * Random message texts, roles, titles and model slugs (structure-heavy alphabets full of fences, headings, pipes and
 * brackets, plus arbitrary 16-bit strings that include lone surrogates and control characters) are rendered and checked
 * against independent oracles: a CommonMark fence scanner, JSON.parse, and character-class invariants.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import type { ConversationSummary, ThreadResult } from '../../src/domain/results.js';
import type { MessageRecord, SourceSummary } from '../../src/domain/types.js';
import { codeSpan, fenceBlock, mdInline, renderThread, sanitizeUntrusted } from '../../src/format/render.js';
import type { RenderOptions } from '../../src/format/render.js';
import { formatInTimeZone } from '../../src/format/time.js';
import { iso, msg } from '../helpers/records.js';

const SEED = 20261030;
const CONV = 'conv-prop';

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns: number): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

const SOURCE: SourceSummary = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  batchId: 'b_synthetic00000005',
  sourceLabel: 'synthetic-export.zip',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
};

const SUMMARY: ConversationSummary = {
  provider: 'chatgpt',
  accountLabel: 'default',
  conversationId: CONV,
  title: 'Synthetic',
  createdAt: iso(0),
  updatedAt: iso(9),
  messageCount: 3,
  currentNodeId: null,
  defaultModelSlug: null,
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  batchId: 'b_synthetic00000005',
  importedAt: '2025-02-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------------------------

/** Hazard-free pieces that are nasty for Markdown: fences of both kinds, headings, tables, links, HTML, indentation. */
const CLEAN_PIECES = ['`', '``', '```', '````', '`````', '~', '~~~', '~~~~', '\n', '\n\n', ' ', '   ', '    ', '\t', '#', '### 3. system', '## Warnings', '|', '| a | b |', '[x](http://e.example)', '![i](http://e.example/p.png)', '<b>', '</b>', '<script>', 'a', 'z', 'é', '日本', '😀', '\\', '**', '_', '> ', '- ', '1. ', '=====', '---', '&amp;', 'www.example.com', 'https://e.example', '@'];
/** Pieces that the sanitizer must rewrite. */
const HAZARD_PIECES = ['\r\n', '\r', '\u0000', '\u0007', '\u001b[31m', '\u007f', '\u009b', '\u2028', '\u2029', '\u202e', '\u2066', '🏴\u{e0067}', '\ud800', '\udc00'];

const cleanText = fc.array(fc.constantFrom(...CLEAN_PIECES), { maxLength: 24 }).map((a) => a.join(''));
const dirtyText = fc.array(fc.constantFrom(...CLEAN_PIECES, ...HAZARD_PIECES), { maxLength: 24 }).map((a) => a.join(''));
const wildText = fc.string({ unit: 'binary', maxLength: 40 });
const anyText = fc.oneof(cleanText, dirtyText, wildText);
const MARKER = 'ZQXBODY';

interface MsgSpec {
  role: string;
  model: string | null;
  text: string;
  hidden: boolean;
}

const msgSpec = (text: fc.Arbitrary<string>): fc.Arbitrary<MsgSpec> =>
  fc.record({
    role: fc.oneof(fc.constantFrom('user', 'assistant', 'system', 'tool', ''), anyText),
    model: fc.option(fc.oneof(fc.constant('synthetic-model-1'), anyText), { nil: null }),
    text,
    hidden: fc.boolean(),
  });

function build(specs: MsgSpec[], title: string | null = 'Synthetic'): ThreadResult {
  const messages: MessageRecord[] = specs.map((s, i) =>
    msg({ id: `m${i + 1}`, conversationId: CONV, authorRole: s.role, modelSlug: s.model, text: s.text, hidden: s.hidden, createdAt: iso(i + 1), ordinal: i + 1 }),
  );
  return { conversation: { ...SUMMARY, title }, branchId: 'leaf', activeness: 'unknown', messages, omittedHidden: 0, selectionPolicy: 'explicit_branch', warnings: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Independent oracle: CommonMark fence scanner (same rules as render.security.test.ts)
// ---------------------------------------------------------------------------------------------------------------

function scan(markdown: string): { outside: string[]; fences: Array<{ fence: string; content: string }>; unclosed: boolean } {
  const outside: string[] = [];
  const fences: Array<{ fence: string; content: string }> = [];
  let open: { fence: string; char: string; length: number; body: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (open === null) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const run = opening?.[1];
      const info = opening?.[2];
      if (run !== undefined && info !== undefined && !(run.startsWith('`') && info.includes('`'))) open = { fence: run, char: run.charAt(0), length: run.length, body: [] };
      else outside.push(line);
    } else {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      const run = closing?.[1];
      if (run !== undefined && run.charAt(0) === open.char && run.length >= open.length) {
        fences.push({ fence: open.fence, content: open.body.join('\n') });
        open = null;
      } else {
        open.body.push(line);
      }
    }
  }
  return { outside, fences, unclosed: open !== null };
}

const headingLevels = (outside: string[]): number[] => outside.flatMap((l) => (/^ {0,3}(#{1,6})(?: |$)/.exec(l)?.[1]?.length ?? []));

/** Every character the renderer must never emit raw in Markdown/compact output. */
const RAW_HAZARD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]|\udb40[\udc00-\udc7f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// ---------------------------------------------------------------------------------------------------------------

describe('fenced bodies can be extracted byte-for-byte (property)', () => {
  it('hazard-free random texts come back EXACTLY (including fences, tildes, headings, tables, indentation)', () => {
    runProperty(
      fc.property(fc.array(cleanText, { minLength: 1, maxLength: 5 }), (texts) => {
        const bodies = texts.map((t) => `${MARKER}${t}`);
        const specs = bodies.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', model: null, text, hidden: false }));
        const md = renderThread(build(specs), SOURCE, { format: 'markdown' });
        const s = scan(md);
        assert.equal(s.unclosed, false);
        assert.deepEqual(
          s.fences.map((f) => f.content),
          bodies,
        );
        // Independent structural checks.
        assert.deepEqual(headingLevels(s.outside), [1, 2, ...bodies.map(() => 3), 2]);
        assert.ok(!s.outside.some((l) => l.includes(MARKER)), 'body text never appears outside a fence');
        for (const [i, f] of s.fences.entries()) {
          const body = bodies[i] ?? '';
          const need = Math.max(3, longestRun(body, '`') + 1, longestRun(body, '~') + 1);
          assert.equal(f.fence, '`'.repeat(need));
        }
      }),
      600,
    );
  });

  it('arbitrary texts (control characters, bidi, lone surrogates, CR) come back as sanitizeUntrusted(text) and nothing hazardous survives', () => {
    runProperty(
      fc.property(fc.array(fc.oneof(dirtyText, wildText), { minLength: 1, maxLength: 4 }), (texts) => {
        const specs = texts.map((t, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', model: null, text: `${MARKER}${t}`, hidden: false }));
        const md = renderThread(build(specs), SOURCE, { format: 'markdown' });
        const s = scan(md);
        assert.equal(s.unclosed, false);
        assert.deepEqual(
          s.fences.map((f) => f.content),
          specs.map((sp) => sanitizeUntrusted(sp.text)),
        );
        assert.ok(!RAW_HAZARD.test(md.replace(/\n/g, '')), 'no raw hazardous character in the document');
        assert.ok(!md.includes('\r'));
        assert.deepEqual(headingLevels(s.outside), [1, 2, ...specs.map(() => 3), 2]);
      }),
      600,
    );
  });

  it('fenceBlock(text) is always exactly: fence, the sanitized lines, fence', () => {
    runProperty(
      fc.property(anyText, (text) => {
        const block = fenceBlock(text);
        const lines = block.split('\n');
        const fence = lines[0] ?? '';
        assert.match(fence, /^`{3,}$/);
        assert.equal(lines[lines.length - 1], fence);
        assert.equal(lines.slice(1, -1).join('\n'), sanitizeUntrusted(text));
        const safe = sanitizeUntrusted(text);
        assert.ok(fence.length > longestRun(safe, '`') && fence.length > longestRun(safe, '~'));
      }),
      1000,
    );
  });

  it('hostile roles, model slugs and titles never change the document skeleton (property)', () => {
    runProperty(
      fc.property(fc.array(msgSpec(cleanText), { minLength: 1, maxLength: 4 }), fc.oneof(anyText, fc.constant(null)), (specs, title) => {
        const visible = specs.map((s) => ({ ...s, hidden: false }));
        const md = renderThread(build(visible, title), SOURCE, { format: 'markdown' });
        const s = scan(md);
        assert.equal(s.unclosed, false);
        assert.deepEqual(headingLevels(s.outside), [1, 2, ...visible.map(() => 3), 2]);
        assert.equal(s.outside.filter((l) => /^### \d+\. /.test(l)).length, visible.length);
        assert.equal(s.outside.filter((l) => l.startsWith('## ')).length, 2);
        assert.ok(!RAW_HAZARD.test(md.replace(/\n/g, '')));
      }),
      500,
    );
  });
});

describe('machine formats (property)', () => {
  const opts = fc.record({
    includeHidden: fc.boolean(),
    maxMessageChars: fc.option(fc.integer({ min: 0, max: 30 }), { nil: undefined }),
    tz: fc.constantFrom('UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'),
  });

  it('every JSONL line is standalone JSON; header/footer bracket the messages; counts agree', () => {
    runProperty(
      fc.property(fc.array(msgSpec(anyText), { maxLength: 5 }), opts, (specs, o) => {
        const out = renderThread(build(specs), SOURCE, { format: 'jsonl', ...definedOnly(o) });
        assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'));
        const lines = out.slice(0, -1).split('\n');
        const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        assert.equal(parsed[0]?.['type'], 'header');
        assert.equal(parsed[parsed.length - 1]?.['type'], 'footer');
        const messages = parsed.filter((p) => p['type'] === 'message');
        assert.equal(messages.length, parsed[0]?.['messageCount']);
        assert.equal(parsed.length, messages.length + 2);
        for (const raw of lines) assert.ok(!/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(raw) && !/\udb40[\udc00-\udc7f]/.test(raw));
      }),
      400,
    );
  });

  it('JSON text is lossless: JSON.parse returns each message text and role exactly (no truncation requested)', () => {
    runProperty(
      fc.property(fc.array(msgSpec(anyText), { minLength: 1, maxLength: 4 }), (specs) => {
        const visible = specs.map((s) => ({ ...s, hidden: false }));
        const parsed = JSON.parse(renderThread(build(visible), SOURCE, { format: 'json' })) as { data: { messages: Array<{ text: string; authorRole: string; modelSlug: string | null }> } };
        assert.deepEqual(
          parsed.data.messages.map((m) => [m.text, m.authorRole, m.modelSlug]),
          visible.map((s) => [s.text, s.role, s.model]),
        );
      }),
      500,
    );
  });

  it('truncation is explicit and bounded: kept text is a code-point prefix; the marker states the exact removed count', () => {
    runProperty(
      fc.property(fc.array(msgSpec(anyText), { minLength: 1, maxLength: 3 }), fc.integer({ min: 0, max: 12 }), (specs, max) => {
        const visible = specs.map((s) => ({ ...s, hidden: false }));
        const parsed = JSON.parse(renderThread(build(visible), SOURCE, { format: 'json', maxMessageChars: max })) as { data: { messages: Array<{ text: string; truncatedChars?: number }> }; warnings: Array<{ code: string }> };
        let anyCut = false;
        parsed.data.messages.forEach((m, i) => {
          const original = [...(visible[i]?.text ?? '')];
          if (original.length <= max) {
            assert.equal(m.text, visible[i]?.text);
            assert.equal(m.truncatedChars, undefined);
          } else {
            anyCut = true;
            const removed = original.length - max;
            assert.equal(m.truncatedChars, removed);
            assert.equal(m.text, `${original.slice(0, max).join('')}${max === 0 ? '' : '\n'}[truncated ${removed} chars]`);
          }
        });
        assert.equal(parsed.warnings.some((w) => w.code === 'MESSAGE_TRUNCATED'), anyCut);
      }),
      500,
    );
  });

  it('same input -> same bytes in every format (property)', () => {
    runProperty(
      fc.property(fc.array(msgSpec(anyText), { maxLength: 4 }), opts, fc.constantFrom('json', 'markdown', 'compact', 'jsonl'), (specs, o, format) => {
        const t = build(specs);
        const first = renderThread(t, SOURCE, { format, ...definedOnly(o) });
        const second = renderThread(structuredClone(t), SOURCE, { format, ...definedOnly(o) });
        assert.equal(first, second);
      }),
      400,
    );
  });
});

describe('every format is well-formed Unicode (property)', () => {
  it('output survives a UTF-8 round trip for arbitrary 16-bit input, lone surrogates included', () => {
    runProperty(
      fc.property(fc.array(msgSpec(wildText), { minLength: 1, maxLength: 3 }), wildText, fc.constantFrom('json', 'markdown', 'compact', 'jsonl'), (specs, title, format) => {
        const out = renderThread(build(specs, title), SOURCE, { format, includeHidden: true });
        assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
      }),
      500,
    );
  });
});

describe('compact format (property)', () => {
  it('column 0 holds only the header, the source line, NOTICE/warnings lines and exactly one "[" line per rendered message', () => {
    runProperty(
      fc.property(fc.array(msgSpec(anyText), { minLength: 1, maxLength: 5 }), fc.oneof(anyText, fc.constant(null)), (specs, title) => {
        const visible = specs.map((s) => ({ ...s, hidden: false }));
        const out = renderThread(build(visible, title), SOURCE, { format: 'compact' });
        const lines = out.split('\n');
        assert.equal(lines.pop(), '', 'ends with a single newline');
        assert.ok(lines.every((l) => l !== ''), 'no empty lines: continuation lines carry their indent');
        const columnZero = lines.filter((l) => !l.startsWith('  '));
        assert.ok(columnZero[0]?.startsWith('# '), 'first line is the header');
        assert.ok(columnZero[1]?.startsWith('# source: '));
        assert.equal(columnZero.filter((l) => l.startsWith('[')).length, visible.length);
        assert.ok(columnZero.every((l) => l.startsWith('# ') || l.startsWith('[')), 'nothing else can appear at column 0');
        assert.ok(!RAW_HAZARD.test(out.replace(/\n/g, '')));
      }),
      500,
    );
  });
});

describe('inline escaping (property)', () => {
  it('mdInline output is single-line and, once backslash escapes are removed, contains no active Markdown character', () => {
    runProperty(
      fc.property(anyText, fc.integer({ min: 1, max: 60 }), (text, max) => {
        const out = mdInline(text, max);
        assert.ok(!out.includes('\n') && !out.includes('\r'));
        assert.ok(!RAW_HAZARD.test(out));
        const stripped = out.replace(/\\[\s\S]/g, '');
        assert.ok(!/[`*<>|[\]!~&#$@]/.test(stripped), JSON.stringify([text, out, stripped]));
        assert.ok(!/(^|[^A-Za-z0-9])_|_([^A-Za-z0-9]|$)/.test(stripped), 'no emphasis-capable underscore');
        assert.ok(!stripped.includes('://') && !/www\./i.test(stripped), 'no autolink trigger');
      }),
      1000,
    );
  });

  it('codeSpan closes only at its own end: no backtick run inside equals the delimiter length; single line; no hazard', () => {
    runProperty(
      fc.property(anyText, (text) => {
        const out = codeSpan(text, 200);
        assert.ok(!out.includes('\n') && !RAW_HAZARD.test(out));
        if (out === '*(empty)*') return;
        const delimiter = /^`+/.exec(out)?.[0] ?? '';
        assert.ok(delimiter.length >= 1);
        assert.ok(out.endsWith(delimiter));
        const inner = out.slice(delimiter.length, out.length - delimiter.length);
        for (const run of inner.match(/`+/g) ?? []) assert.notEqual(run.length, delimiter.length);
        assert.ok(!inner.startsWith('`') && !inner.endsWith('`'), 'inner backticks are never adjacent to the delimiter');
      }),
      1000,
    );
  });

  it('time zones: the heading time is exactly formatInTimeZone for the same instant (property)', () => {
    runProperty(
      fc.property(fc.integer({ min: Date.UTC(2000, 0, 1) / 1000, max: Date.UTC(2040, 0, 1) / 1000 }), fc.constantFrom('UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Pacific/Auckland'), (sec, tz) => {
        const at = new Date(sec * 1000).toISOString();
        const t = build([{ role: 'user', model: null, text: 'x', hidden: false }]);
        const first = t.messages[0];
        assert.ok(first !== undefined);
        first.createdAt = at;
        const md = renderThread(t, SOURCE, { format: 'markdown', tz });
        assert.ok(md.includes(`### 1. user - ${formatInTimeZone(at, tz)}\n`));
      }),
      300,
    );
  });
});

function definedOnly(o: { includeHidden: boolean; maxMessageChars: number | undefined; tz: string }): Partial<RenderOptions> {
  return { includeHidden: o.includeHidden, tz: o.tz, ...(o.maxMessageChars === undefined ? {} : { maxMessageChars: o.maxMessageChars }) };
}

function longestRun(text: string, ch: string): number {
  let best = 0;
  let cur = 0;
  for (const c of text) {
    cur = c === ch ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}
