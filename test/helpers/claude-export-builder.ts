/**
 * Builders for SYNTHETIC Claude export elements (raw JSON shapes, NOT domain records; see records.ts for those) and
 * helpers to load the committed fixtures under fixtures/claude/. Everything here is invented test data.
 *
 * Convention for all `over` parameters: a key whose value is `undefined` is OMITTED from the built object, so a test
 * can express "this field is absent" as `{ created_at: undefined }`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ConversationRecord, MessageRecord } from '../../src/domain/types.js';
import { validateConversationRecord } from '../../src/domain/validate.js';
import type { Warning } from '../../src/errors.js';
import type { AdapterContext, AdapterOutcome } from '../../src/ingest/adapter.js';
import { ClaudeExportAdapter } from '../../src/ingest/claude-export.js';

/** The literal marker the privacy scanner requires in every committed fixture. */
export const SYNTHETIC_MARKER = 'GCR-SYNTHETIC-FIXTURE';

/** `00000000-0000-4000-8000-0000000000NN` generalised to 12 decimal digits so large synthetic conversations stay unique. */
export function synthUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Fixed import time so every record is reproducible. */
export const IMPORTED_AT = '2026-01-02T03:04:05.000Z';

export function claudeCtx(over: Partial<AdapterContext> = {}): AdapterContext {
  return { provider: 'claude', accountLabel: 'default', importedAt: IMPORTED_AT, ...over };
}

/** Claude-style timestamp with microseconds, `minute` minutes after 2025-03-04T05:00:00Z. Deterministic. */
export function claudeTimestamp(minute: number): string {
  const ms = Date.UTC(2025, 2, 4, 5, 0, 0) + minute * 60_000;
  return new Date(ms).toISOString().replace('Z', '123Z'); // .000Z -> .000123Z (6 fractional digits like the real export)
}

type Obj = Record<string, unknown>;

function applyOverrides(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** One chat message. Even n = human, odd n = assistant. uuid = synthUuid(1000 + n). */
export function claudeMessage(n: number, over: Obj = {}): Obj {
  const sender = n % 2 === 0 ? 'human' : 'assistant';
  const text = `synthetic ${sender} message ${n} about topic${n}`;
  return applyOverrides(
    {
      uuid: synthUuid(1000 + n),
      text,
      content: [{ type: 'text', text }],
      sender,
      created_at: claudeTimestamp(n),
      updated_at: claudeTimestamp(n),
      attachments: [],
      files: [],
    },
    over,
  );
}

/** A conversation element wrapping `messages` (default: none). The name carries the fixture marker. */
export function claudeConversation(messages: Obj[] = [], over: Obj = {}): Obj {
  return applyOverrides(
    {
      uuid: synthUuid(1),
      name: `${SYNTHETIC_MARKER} synthetic conversation`,
      summary: '',
      created_at: claudeTimestamp(0),
      updated_at: claudeTimestamp(messages.length),
      account: { uuid: synthUuid(900) },
      chat_messages: messages,
    },
    over,
  );
}

/** `count` alternating human/assistant messages in file order, no parent pointers (the official linear shape). */
export function claudeLinearConversation(count: number, over: Obj = {}): Obj {
  const messages: Obj[] = [];
  for (let n = 0; n < count; n++) messages.push(claudeMessage(n));
  return claudeConversation(messages, over);
}

/** The exact text an adapter receives: the JSON of ONE element. */
export function elementText(element: unknown): string {
  return JSON.stringify(element);
}

const FIXTURE_DIR = new URL('../../../fixtures/claude/', import.meta.url);

export const CLAUDE_FIXTURE_FILES = [
  'attachments-files.json',
  'empty-conversation.json',
  'explicit-parents.json',
  'hostile-strings.json',
  'linear.json',
  'missing-optional-fields.json',
  'thinking-and-tools.json',
  'unknown-extra-fields.json',
] as const;

export function readFixtureText(file: string): string {
  return readFileSync(new URL(file, FIXTURE_DIR), 'utf8');
}

/** The fixture as the importer would see it: each top-level array element as its own JSON text. */
export function fixtureElementTexts(file: string): string[] {
  const parsed: unknown = JSON.parse(readFixtureText(file));
  if (!Array.isArray(parsed)) throw new Error(`fixture ${file} is not a JSON array`);
  return parsed.map((e) => JSON.stringify(e));
}

export function fixtureElements(file: string): Obj[] {
  const parsed: unknown = JSON.parse(readFixtureText(file));
  if (!Array.isArray(parsed)) throw new Error(`fixture ${file} is not a JSON array`);
  return parsed as Obj[];
}

// ---- running the adapter ---------------------------------------------------------------------------------------------

export const claudeAdapter = new ClaudeExportAdapter();

/** Run the adapter on an element given as an object (serialized with JSON.stringify) or as raw JSON text. */
export function runElement(element: unknown, ctx: AdapterContext = claudeCtx(), elementIndex = 0): AdapterOutcome {
  return claudeAdapter.normalizeElementText(typeof element === 'string' ? element : elementText(element), ctx, elementIndex);
}

/** Run the adapter, assert it produced a record, and assert that record passes the domain validator. */
export function recordOf(element: unknown, ctx: AdapterContext = claudeCtx(), elementIndex = 0): ConversationRecord {
  const out = runElement(element, ctx, elementIndex);
  assert.equal(out.kind, 'record', `expected a record, got ${out.kind === 'skipped' ? `skipped(${out.reason})` : out.kind}`);
  if (out.kind !== 'record') throw new Error('unreachable');
  validateConversationRecord(out.record);
  return out.record;
}

export function warningCodes(r: ConversationRecord): string[] {
  return r.warnings.map((w) => w.code);
}

export function findWarning(r: ConversationRecord, code: string): Warning | undefined {
  return r.warnings.find((w) => w.code === code);
}

export function message(r: ConversationRecord, index: number): MessageRecord {
  const m = r.messages[index];
  assert.ok(m !== undefined, `no message at index ${index}`);
  return m;
}

// ---- static source inspection (used by the "no I/O" tests of openai-api.ts and registry.ts) ------------------------------

/**
 * `source` with comments removed. String-aware on purpose: a comment marker INSIDE a string, template literal or regular expression
 * is code (`const a = "/*"; import x from "fs"; const b = "*" + "/";` must keep its import), and a quote inside a regular expression
 * does not open a string. Handles '...' and "..." strings, template literals with nested `${ ... }` code, regex literals
 * (told from a division by the previous significant token) and line/block comments (an unterminated block comment runs to the end).
 * Used only by the static "no I/O" source checks, so it is built to fail CLOSED: when in doubt it keeps text.
 */
export function stripComments(source: string): string {
  type Mode = { kind: 'code'; depth: number; inTemplate: boolean } | { kind: 'template' };
  const n = source.length;
  const out: string[] = [];
  const modes: Mode[] = [{ kind: 'code', depth: 0, inTemplate: false }];
  const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'delete', 'void', 'throw', 'in', 'of', 'new', 'else', 'do', 'yield', 'await', 'instanceof']);
  let prev = ''; // last significant (non-whitespace) character of the code emitted so far
  let word = ''; // identifier/number immediately before `prev` (to recognise `return /re/`)
  let i = 0;

  const regexAllowed = (): boolean => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || (/[\w$]/.test(prev) && REGEX_AFTER_WORDS.has(word));
  const note = (text: string): void => {
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      word = /[\w$]/.test(ch) ? (/[\w$]/.test(prev) ? word + ch : ch) : '';
      prev = ch;
    }
  };
  const emit = (text: string): void => {
    out.push(text);
    note(text);
  };

  while (i < n) {
    const top = modes[modes.length - 1] as Mode;
    const c = source[i] as string;
    const d = source[i + 1];
    if (top.kind === 'template') {
      if (c === '\\') {
        out.push(source.slice(i, i + 2));
        i += 2;
      } else if (c === '`') {
        out.push(c);
        modes.pop();
        prev = ')';
        word = '';
        i++;
      } else if (c === '$' && d === '{') {
        out.push('${');
        modes.push({ kind: 'code', depth: 0, inTemplate: true });
        prev = '';
        word = '';
        i += 2;
      } else {
        out.push(c);
        i++;
      }
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out.push(' ');
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      emit(source.slice(i, Math.min(j + 1, n)));
      i = Math.min(j + 1, n);
      prev = ')';
      word = '';
      continue;
    }
    if (c === '`') {
      out.push(c);
      modes.push({ kind: 'template' });
      i++;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        const ch = source[j] as string;
        if (ch === '\\') j++;
        else if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j++;
      }
      while (j + 1 < n && /[a-z]/i.test(source[j + 1] as string)) j++;
      out.push(source.slice(i, j + 1));
      i = j + 1;
      prev = ')';
      word = '';
      continue;
    }
    if (c === '{') top.depth++;
    if (c === '}') {
      if (top.depth === 0 && top.inTemplate) {
        out.push(c);
        modes.pop();
        i++;
        continue;
      }
      if (top.depth > 0) top.depth--;
    }
    emit(c);
    i++;
  }
  return out.join('');
}

/** Source text of a repo file with comments removed (string-aware, see stripComments), so prose cannot trip identifier scans. */
export function codeOf(relativeToRepoRoot: string): string {
  return stripComments(readFileSync(new URL(`../../../${relativeToRepoRoot}`, import.meta.url), 'utf8'));
}

/** Every module specifier the code names: static imports/exports (`from '...'`), side-effect imports, dynamic import(), require(). */
export function moduleSpecifiers(code: string): string[] {
  const found: string[] = [];
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g, /\brequire\s*\(\s*['"]([^'"]+)['"]/g]) {
    for (const m of code.matchAll(re)) found.push(m[1] ?? '');
  }
  return found.sort();
}

/** Node built-ins (and globals) through which code could reach the network, the disk, other processes or the environment. */
export const IO_CAPABLE_MODULES = ['fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'child_process', 'dns', 'dns/promises', 'tls', 'dgram', 'cluster', 'worker_threads', 'vm', 'os', 'readline', 'inspector', 'undici', 'node-fetch', 'axios'] as const;
