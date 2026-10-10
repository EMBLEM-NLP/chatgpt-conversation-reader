/**
 * ClaudeExportAdapter adversarial cases: sanitization (NUL, lone surrogates), size caps, prototype-looking keys,
 * prompt injection as data, skipped/invalid elements, error-message hygiene, depth and count bombs, and static
 * source checks (no clock, no randomness, no network, no console). All data is synthetic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ConversationRecord } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import {
  MAX_JSON_DEPTH,
  MAX_MESSAGES_PER_CONVERSATION,
  TEXT_TRUNCATION_MARKER,
  capUnits,
  jsonDepthExceeds,
  sanitizeString,
  truncateUtf8,
} from '../../src/ingest/claude-export.js';
import {
  claudeAdapter,
  claudeConversation,
  claudeCtx,
  claudeMessage,
  fixtureElementTexts,
  findWarning,
  message,
  recordOf,
  runElement,
  warningCodes,
} from '../helpers/claude-export-builder.js';

type Obj = Record<string, unknown>;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every string the domain schema validates (NOT rawSource / rawMetadata / block metadata, which keep the raw value). */
function validatedStrings(r: ConversationRecord): string[] {
  const out: string[] = [r.id, r.accountLabel];
  if (r.title !== null) out.push(r.title);
  if (r.defaultModelSlug !== null) out.push(r.defaultModelSlug);
  for (const w of r.warnings) out.push(w.code, w.message, ...(w.ids ?? []));
  for (const m of r.messages) {
    out.push(m.id, m.conversationId, m.authorRole, m.text);
    if (m.parentId !== null) out.push(m.parentId);
    if (m.modelSlug !== null) out.push(m.modelSlug);
    out.push(...m.childIds);
    for (const b of m.blocks) out.push(b.type, ...(b.text === undefined ? [] : [b.text]));
    for (const a of m.attachments) out.push(...[a.id, a.name, a.mimeType].filter((x): x is string => x !== null));
  }
  return out;
}

function errorOf(fn: () => unknown): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    return e;
  }
  return assert.fail('expected an error, nothing was thrown');
}

describe('sanitizeString / capUnits / truncateUtf8 (unit)', () => {
  it('strips NUL and reports it; leaves clean strings untouched (same reference semantics)', () => {
    assert.deepEqual(sanitizeString('a\u0000b\u0000'), { value: 'ab', nulStripped: true, loneSurrogates: false });
    assert.deepEqual(sanitizeString('clean'), { value: 'clean', nulStripped: false, loneSurrogates: false });
  });

  it('replaces only UNPAIRED surrogates, keeps valid pairs (astral emoji, ZWJ sequences)', () => {
    assert.equal(sanitizeString('\uD800').value, '\uFFFD');
    assert.equal(sanitizeString('\uDFFF').value, '\uFFFD');
    assert.equal(sanitizeString('a\uD800b').value, 'a\uFFFDb');
    assert.equal(sanitizeString('\uD800\uD800\uDC00').value, '\uFFFD\uD800\uDC00', 'high,high,low: only the first is lone');
    assert.equal(sanitizeString('\uD800\uDC00\uDC00').value, '\uD800\uDC00\uFFFD', 'high,low,low: only the last is lone');
    const family = '\u{1F469}\u200D\u{1F4BB}';
    assert.equal(sanitizeString(family).value, family);
    assert.equal(sanitizeString(family).loneSurrogates, false);
  });

  it('is idempotent and removes NUL before repairing surrogates', () => {
    for (const s of ['a\u0000\uD800\u0000b', '\uD83D\u0000\uDE00', 'x\uDC00\u0000\uD800y', '']) {
      const once = sanitizeString(s).value;
      assert.equal(sanitizeString(once).value, once);
      assert.ok(!once.includes('\u0000'));
      assert.ok(!LONE_SURROGATE.test(once));
    }
  });

  it('capUnits cuts at a unit boundary and never splits a surrogate pair', () => {
    assert.deepEqual(capUnits('abc', 3), { value: 'abc', truncated: false });
    assert.deepEqual(capUnits('abcd', 3), { value: 'abc', truncated: true });
    const s = `ab${'\u{1F600}'}cd`; // the emoji occupies units 2 and 3
    assert.deepEqual(capUnits(s, 3), { value: 'ab', truncated: true }); // would cut between the halves
    assert.deepEqual(capUnits(s, 4), { value: 'ab\u{1F600}', truncated: true });
  });

  it('truncateUtf8 leaves in-limit text alone, including text of exactly the limit', () => {
    assert.deepEqual(truncateUtf8('héllo', 100), { value: 'héllo', truncated: false });
    assert.deepEqual(truncateUtf8('abcde', 5), { value: 'abcde', truncated: false });
    assert.deepEqual(truncateUtf8('\u{1F600}', 4), { value: '\u{1F600}', truncated: false });
  });

  it('truncateUtf8 never exceeds the byte limit INCLUDING the marker and never cuts inside a character', () => {
    const marker = '[cut]'; // 5 bytes
    for (const text of ['x'.repeat(100), 'é'.repeat(100), '日'.repeat(100), '\u{1F600}'.repeat(100), `a${'日'.repeat(60)}b`]) {
      for (const limit of [5, 6, 7, 8, 9, 10, 11, 12, 13, 31, 32, 33]) {
        const r = truncateUtf8(text, limit, marker);
        assert.equal(r.truncated, true);
        assert.ok(Buffer.byteLength(r.value, 'utf8') <= limit, `${limit}`);
        assert.ok(r.value.endsWith(marker));
        assert.ok(!r.value.includes('\uFFFD'), 'no replacement char: the cut is on a character boundary');
        assert.ok(!LONE_SURROGATE.test(r.value));
        assert.ok(text.startsWith(r.value.slice(0, -marker.length)), 'what is kept is a prefix of the original');
      }
    }
  });

  it('truncateUtf8 degrades to the bare marker when the limit is smaller than the marker', () => {
    assert.equal(truncateUtf8('abcdefghij', 3, '[cut]').value, '[cut]');
  });

  it('the default marker is explicit text', () => {
    assert.ok(TEXT_TRUNCATION_MARKER.includes('truncated'));
  });
});

describe('hostile-strings fixture', () => {
  const [text] = fixtureElementTexts('hostile-strings.json');
  const r = recordOf(text);

  it('every validated string is NUL-free and well-formed UTF-16', () => {
    for (const s of validatedStrings(r)) {
      assert.ok(!s.includes('\u0000'), s.slice(0, 40));
      assert.ok(!LONE_SURROGATE.test(s), s.slice(0, 40));
    }
  });

  it('strips NUL from the title but keeps markup and bidi controls verbatim (rendering escapes them, not the adapter)', () => {
    assert.equal(r.title, "GCR-SYNTHETIC-FIXTURE <script>alert('title')</script> \u202E bidi  nul");
    assert.ok(findWarning(r, 'NUL_STRIPPED') !== undefined);
  });

  it('repairs lone surrogates to U+FFFD, keeps valid pairs, U+2028, bidi and private-use characters in message text', () => {
    const t = message(r, 1).text;
    assert.ok(t.includes('nul::end'));
    assert.ok(t.includes('lone-high:\uFFFD:end'));
    assert.ok(t.includes('lone-low:\uFFFD:end'));
    assert.ok(t.includes('line-sep:\u2028:end'));
    assert.ok(t.includes('bidi:\u202E:end'));
    assert.ok(t.includes('zwj:\u{1F469}\u200D\u{1F4BB}:end'));
    assert.ok(t.includes('private-use:\uE200:end'));
    assert.ok(findWarning(r, 'LONE_SURROGATE') !== undefined);
  });

  it('sanitizes block text too', () => {
    assert.equal(message(r, 1).blocks[0]?.text, 'block nul::end block lone:\uFFFD:end');
  });

  it('keeps the ORIGINAL (unsanitized) values in rawSource / rawMetadata', () => {
    const raw = message(r, 1).rawSource as Obj;
    assert.ok((raw['text'] as string).includes('\u0000'));
    assert.ok((raw['text'] as string).includes('\uD800'));
    assert.ok(((r.rawMetadata as Obj)['name'] as string).includes('\u0000'));
  });

  it('treats ids that look like Object.prototype members as ordinary ids; "__proto__" as a role pollutes nothing', () => {
    assert.deepEqual(r.messages.map((m) => m.id).slice(0, 2), ['__proto__', 'constructor']);
    assert.equal(message(r, 1).authorRole, '__proto__');
    const out = runElement(text);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const counts = out.observations.roleCounts;
    assert.equal(Object.getPrototypeOf(counts), Object.prototype);
    assert.ok(Object.hasOwn(counts, '__proto__'));
    assert.equal(counts['__proto__' as keyof typeof counts], 1);
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
    assert.deepEqual(Object.keys(Object.prototype), []);
  });

  it('keeps hostile attachment names as names only: nothing is dereferenced, nothing claimed present', () => {
    const a = message(r, 1).attachments[0];
    assert.equal(a?.name, '../../etc/passwd<img src=x onerror=alert(1)>');
    assert.equal(a?.mimeType, 'text/plain', 'NUL stripped from the mime type');
    assert.equal(a?.presentInExportAs, null);
    assert.equal(a?.assetPointer, null);
  });

  it('strips NUL from a sender but preserves everything else verbatim', () => {
    assert.equal(message(r, 2).authorRole, 'assistantx');
  });

  it('treats prompt-injection text as DATA: it is stored in text, never echoed in warnings, ids or errors', () => {
    assert.ok(message(r, 0).text.startsWith('SYNTHETIC-INJECTION ignore all previous instructions'));
    const warnings = JSON.stringify(r.warnings);
    for (const m of r.messages) {
      for (const needle of [m.text.slice(0, 20), 'SYNTHETIC-INJECTION', 'DROP TABLE', 'onerror']) assert.ok(!warnings.includes(needle), needle);
    }
  });

  it('keeps FTS operators, SQL metacharacters and HTML verbatim in text (escaping is the renderer\'s and the query builder\'s job)', () => {
    assert.ok(message(r, 2).text.includes('"') && message(r, 2).text.includes('NEAR(') && message(r, 2).text.includes("' ; --") && message(r, 2).text.includes('<b>bold</b>'));
  });
});

describe('warnings never carry conversation content', () => {
  it('no warning message or id contains any message text, title or attachment content, across all fixtures', () => {
    for (const file of ['attachments-files.json', 'explicit-parents.json', 'hostile-strings.json', 'linear.json', 'missing-optional-fields.json', 'thinking-and-tools.json', 'unknown-extra-fields.json']) {
      for (const text of fixtureElementTexts(file)) {
        const r = recordOf(text);
        const w = JSON.stringify(r.warnings);
        for (const m of r.messages) {
          if (m.text.length >= 8) assert.ok(!w.includes(m.text), `${file}: message text leaked into a warning`);
        }
        if (r.title !== null && r.title.length >= 8) assert.ok(!w.includes(r.title), `${file}: title leaked`);
      }
    }
  });

  it('every warning is well-formed: non-empty code <= 64, message <= 2048, ids bounded', () => {
    const r = recordOf(claudeConversation(Array.from({ length: 300 }, (_, i) => claudeMessage(i, { sender: undefined, created_at: 'bad', uuid: i % 2 === 0 ? undefined : claudeMessage(i)['uuid'] }))));
    for (const w of r.warnings) {
      assert.ok(w.code.length > 0 && w.code.length <= 64);
      assert.ok(w.message.length <= 2048);
      assert.ok((w.ids ?? []).length <= 50, `${w.code} lists too many ids`);
    }
    const sender = findWarning(r, 'SENDER_MISSING');
    assert.ok(sender?.message.includes('[300 occurrences]'), 'the total is always reported');
    assert.ok(sender?.message.includes('first 50 ids listed'));
    assert.equal(r.warnings.length, new Set(r.warnings.map((w) => w.code)).size, 'one warning per code');
  });
});

describe('size caps', () => {
  it('truncates an over-long title to 8192 units, reports it, and keeps the full title in rawMetadata', () => {
    const name = 'T'.repeat(9000);
    const r = recordOf(claudeConversation([], { name }));
    assert.equal(r.title?.length, 8192);
    assert.deepEqual(findWarning(r, 'FIELD_TRUNCATED')?.ids, [r.id]);
    assert.equal((r.rawMetadata as Obj)['name'], name);
  });

  it('never leaves half of a surrogate pair at a cut', () => {
    const name = `${'a'.repeat(8191)}${'\u{1F600}'.repeat(3)}`;
    const r = recordOf(claudeConversation([], { name }));
    assert.equal(r.title, 'a'.repeat(8191));
  });

  it('caps role, model, mime type and attachment name; and the result still validates', () => {
    const r = recordOf(
      claudeConversation([claudeMessage(1, { sender: 's'.repeat(600), model: 'm'.repeat(600), attachments: [{ file_name: 'n'.repeat(5000), file_type: 't'.repeat(600) }] })], { model: 'd'.repeat(700) }),
    );
    const m = message(r, 0);
    assert.equal(m.authorRole.length, 512);
    assert.equal(m.modelSlug?.length, 512);
    assert.equal(m.attachments[0]?.name?.length, 4096);
    assert.equal(m.attachments[0]?.mimeType?.length, 512);
    assert.equal(r.defaultModelSlug?.length, 512);
    assert.ok(findWarning(r, 'FIELD_TRUNCATED') !== undefined);
  });

  it('empty title strings are "untitled": null, with the raw value kept', () => {
    const r = recordOf(claudeConversation([], { name: '' }));
    assert.equal(r.title, null);
    assert.equal((r.rawMetadata as Obj)['name'], '');
    assert.equal(findWarning(r, 'INVALID_TITLE'), undefined);
  });

  it('a non-string title is null with INVALID_TITLE', () => {
    for (const name of [5, {}, ['t'], true]) {
      const r = recordOf(claudeConversation([], { name }));
      assert.equal(r.title, null);
      assert.deepEqual(findWarning(r, 'INVALID_TITLE')?.ids, [r.id]);
    }
  });
});

describe('skipped elements and invalid input', () => {
  const skippedReason = (text: string): string => {
    const out = claudeAdapter.normalizeElementText(text, claudeCtx(), 3);
    assert.equal(out.kind, 'skipped', text.slice(0, 60));
    if (out.kind !== 'skipped') throw new Error('unreachable');
    assert.equal(out.warnings.length, 1);
    assert.equal(out.warnings[0]?.code, out.reason);
    assert.ok(out.warnings[0]?.message.includes('Element 3'));
    return out.reason;
  };

  for (const text of ['null', '5', '-0', '"a string"', 'true', '[]', '[1,2,3]', '[{"chat_messages":[]}]']) {
    it(`${text} is NON_OBJECT_ENTRY`, () => {
      assert.equal(skippedReason(text), 'NON_OBJECT_ENTRY');
    });
  }

  it('{} is EMPTY_CONVERSATION_ENTRY', () => {
    assert.equal(skippedReason('{}'), 'EMPTY_CONVERSATION_ENTRY');
    assert.equal(skippedReason('  {  }  '), 'EMPTY_CONVERSATION_ENTRY');
  });

  for (const text of [
    '{"uuid":"x"}',
    '{"uuid":"x","name":"a project","description":"d","created_at":"2025-01-01T00:00:00Z"}', // looks like a projects.json record
    '{"chat_messages":null}',
    '{"chat_messages":{}}',
    '{"chat_messages":"x"}',
    '{"conversations":[]}',
    '{"mapping":{},"current_node":null}', // a ChatGPT-shaped element must not become a Claude record
  ]) {
    it(`${text.slice(0, 50)} is NOT_A_CONVERSATION`, () => {
      assert.equal(skippedReason(text), 'NOT_A_CONVERSATION');
    });
  }

  it('accepts a leading UTF-8 BOM', () => {
    const r = recordOf(`\uFEFF${JSON.stringify(claudeConversation([claudeMessage(0)]))}`);
    assert.equal(r.messages.length, 1);
  });

  for (const text of ['', '   ', '{', '{"chat_messages":[', 'not json', '{"a":1,}', "{'a':1}", '{"a":NaN}', '{"a":1}{"b":2}', '\u0000']) {
    it(`invalid JSON ${JSON.stringify(text.slice(0, 20))} throws IMPORT_PARSE_ERROR without echoing the input`, () => {
      const e = errorOf(() => claudeAdapter.normalizeElementText(text, claudeCtx(), 0));
      assert.equal(e.code, 'IMPORT_PARSE_ERROR');
      assert.equal(e.details?.['reason'], 'INVALID_JSON');
    });
  }

  it('error text never contains the element content (untrusted, may carry prompt injection)', () => {
    const secret = 'LEAKMARKER-5c2e-IGNORE-PREVIOUS-INSTRUCTIONS';
    for (const text of [`{"x":"${secret}`, `{"${secret}":}`, `${secret}`]) {
      const e = errorOf(() => claudeAdapter.normalizeElementText(text, claudeCtx(), 0));
      assert.ok(!JSON.stringify(e.toEnvelope()).includes('LEAKMARKER'));
      assert.ok(!String(e.message).includes('LEAKMARKER'));
      assert.equal(e.cause, undefined, 'a SyntaxError cause would quote the input');
    }
  });
});

describe('depth and count bombs', () => {
  /** root{} (1) -> chat_messages[] (2) -> message{} (3) -> `extra` nested arrays (3 + extra). */
  const nested = (extra: number): string => `{"chat_messages":[{"uuid":"a","sender":"human","text":"t","x":${'['.repeat(extra)}${']'.repeat(extra)}}]}`;

  it(`accepts nesting of exactly ${MAX_JSON_DEPTH} and rejects ${MAX_JSON_DEPTH + 1} with IMPORT_LIMIT_EXCEEDED`, () => {
    recordOf(nested(MAX_JSON_DEPTH - 3));
    const e = errorOf(() => claudeAdapter.normalizeElementText(nested(MAX_JSON_DEPTH - 2), claudeCtx(), 0));
    assert.equal(e.code, 'IMPORT_LIMIT_EXCEEDED');
    assert.equal(e.details?.['limit'], 'MAX_JSON_DEPTH');
  });

  it('survives absurd nesting (200 000 levels) with a GcrError, not a stack overflow', () => {
    const e = errorOf(() => claudeAdapter.normalizeElementText(nested(200_000), claudeCtx(), 0));
    assert.equal(e.code, 'IMPORT_LIMIT_EXCEEDED');
  });

  it('deep nesting inside an unknown key of the CONVERSATION is caught as well', () => {
    const text = `{"chat_messages":[],"x":${'{"a":'.repeat(500)}1${'}'.repeat(500)}}`;
    assert.equal(errorOf(() => claudeAdapter.normalizeElementText(text, claudeCtx(), 0)).code, 'IMPORT_LIMIT_EXCEEDED');
  });

  it('jsonDepthExceeds is exact at the boundary and handles arrays, objects and primitives', () => {
    assert.equal(jsonDepthExceeds(1, 1), false);
    assert.equal(jsonDepthExceeds([], 1), false);
    assert.equal(jsonDepthExceeds([[]], 1), true);
    assert.equal(jsonDepthExceeds([[]], 2), false);
    assert.equal(jsonDepthExceeds({ a: { b: [1, { c: 2 }] } }, 4), false);
    assert.equal(jsonDepthExceeds({ a: { b: [1, { c: 2 }] } }, 3), true);
  });

  it(`rejects more than ${MAX_MESSAGES_PER_CONVERSATION} messages (output amplification guard) with IMPORT_LIMIT_EXCEEDED`, () => {
    const text = `{"chat_messages":[${'{},'.repeat(MAX_MESSAGES_PER_CONVERSATION)}{}]}`;
    const e = errorOf(() => claudeAdapter.normalizeElementText(text, claudeCtx(), 0));
    assert.equal(e.code, 'IMPORT_LIMIT_EXCEEDED');
    assert.equal(e.details?.['count'], MAX_MESSAGES_PER_CONVERSATION + 1);
  });
});

describe('purity (static source checks of src/ingest/claude-export.ts)', () => {
  const source = readFileSync(new URL('../../../src/ingest/claude-export.ts', import.meta.url), 'utf8');
  /** Comments stripped, so prose such as "no clock" cannot trip the identifier scans. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  it('imports only the pure modules it needs (node:crypto for SHA-256, errors, domain types/validate, adapter types)', () => {
    const specifiers = [...code.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(specifiers, ['../domain/types.js', '../domain/validate.js', '../domain/validate.js', '../errors.js', '../errors.js', './adapter.js', 'node:crypto']);
    assert.ok(!/\brequire\s*\(/.test(code) && !/\bimport\s*\(/.test(code), 'no dynamic imports');
  });

  it('never reads a clock, randomness, the environment, the network or the console', () => {
    for (const pattern of [/\bDate\b/, /Math\.random/, /\bperformance\b/, /\bprocess\b/, /\bconsole\b/, /\bfetch\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bglobalThis\b/, /\beval\b/, /new\s+Function/, /\bstructuredClone\b/]) {
      assert.ok(!pattern.test(code), `forbidden construct: ${pattern}`);
    }
  });
});

describe('contract: only GcrError ever escapes', () => {
  it('a getter-throwing context object surfaces as GcrError, never a raw TypeError', () => {
    const ctx = {
      provider: 'claude',
      get accountLabel(): string {
        throw new Error('boom: SECRET-CTX');
      },
      importedAt: '2026-01-02T03:04:05.000Z',
    };
    const e = errorOf(() => claudeAdapter.normalizeElementText('{}', ctx as never, 0));
    assert.equal(e.code, 'IMPORT_PARSE_ERROR');
    assert.equal(e.details?.['reason'], 'UNEXPECTED_ADAPTER_FAILURE');
    assert.ok(!JSON.stringify(e.toEnvelope()).includes('SECRET-CTX'));
  });

  it('well-formed conversation objects never reach the catch-all (it is reserved for adapter bugs)', () => {
    for (const file of ['attachments-files.json', 'empty-conversation.json', 'explicit-parents.json', 'hostile-strings.json', 'linear.json', 'missing-optional-fields.json', 'thinking-and-tools.json', 'unknown-extra-fields.json']) {
      for (const text of fixtureElementTexts(file)) assert.equal(runElement(text).kind, 'record', file);
    }
    assert.ok(warningCodes(recordOf(claudeConversation([]))).includes('LINEAR_EXPORT_ACTIVE_BRANCH_ONLY'));
  });
});
