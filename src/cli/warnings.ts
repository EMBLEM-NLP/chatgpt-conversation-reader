/**
 * Carrying the SDK envelope's warnings into documents produced by the dedicated renderers.
 *
 * `renderConversationList` and `renderSearchHits` (src/format/render.ts) take no warnings: they derive the completeness
 * NOTICE themselves, but a warning that only the SDK envelope knows (SOURCE_NOT_FULL_HISTORY on an EMPTY result, which
 * says "nothing matched in the data you imported, not in your whole history"; SUPERSEDED_SNAPSHOTS_INCLUDED) would be lost.
 * Scripts read the machine formats, so for json and jsonl the missing warnings are merged into the rendered document's
 * `warnings` array (JSON) or footer line (JSONL). Markdown and compact already print the NOTICE; for them nothing is added.
 *
 * The merge parses the renderer's own output and serializes it again with the same layout and the same lossless escaping of
 * characters JSON.stringify leaves raw, so the only difference is the extra entries (deduplicated by code and message).
 */
import type { OutputFormat } from '../domain/types.js';
import type { Warning } from '../errors.js';

const HAZARD = new RegExp(
  [
    '[\\u007f-\\u009f]',
    `[${[0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => `\\u${c.toString(16)}`).join('')}]`,
    '\\uDB40[\\uDC00-\\uDC7F]',
  ].join('|'),
  'g',
);

function escapeHazards(json: string): string {
  return json.replace(HAZARD, (m) => Array.from({ length: m.length }, (_, i) => `\\u${m.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));
}

function isWarning(v: unknown): v is Warning {
  return typeof v === 'object' && v !== null && typeof (v as { code?: unknown }).code === 'string' && typeof (v as { message?: unknown }).message === 'string';
}

function merged(existing: unknown, extra: readonly Warning[]): unknown[] {
  const list = Array.isArray(existing) ? [...(existing as unknown[])] : [];
  const keys = new Set(list.filter(isWarning).map((w) => `${w.code}\u0000${w.message}`));
  for (const w of extra) {
    if (!keys.has(`${w.code}\u0000${w.message}`)) {
      keys.add(`${w.code}\u0000${w.message}`);
      list.push(w.ids === undefined ? { code: w.code, message: w.message } : { code: w.code, message: w.message, ids: [...w.ids] });
    }
  }
  return list;
}

export function withEnvelopeWarnings(rendered: string, format: OutputFormat, extra: readonly Warning[]): string {
  if (extra.length === 0) return rendered;
  try {
    if (format === 'json') {
      const doc = JSON.parse(rendered) as Record<string, unknown>;
      doc['warnings'] = merged(doc['warnings'], extra);
      return `${escapeHazards(JSON.stringify(doc, null, 2))}\n`;
    }
    if (format === 'jsonl') {
      const lines = rendered.trimEnd().split('\n');
      const last = lines.length - 1;
      const footer = JSON.parse(lines[last] ?? '') as Record<string, unknown>;
      if (footer['type'] !== 'footer') return rendered;
      footer['warnings'] = merged(footer['warnings'], extra);
      lines[last] = escapeHazards(JSON.stringify(footer));
      return `${lines.join('\n')}\n`;
    }
  } catch {
    // The renderer's output is always valid JSON; if that ever stops being true, printing it unchanged beats failing.
    return rendered;
  }
  return rendered;
}
