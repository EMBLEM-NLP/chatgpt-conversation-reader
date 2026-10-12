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
import { escapeJsonHazards } from '../format/scrub.js';

/**
 * The warnings a rendered thread must carry: the SDK envelope's warnings FIRST (in the envelope's own order, so
 * SOURCE_NOT_FULL_HISTORY stays first for every non-`exported_tree` source: FR-09), then the thread-level ones the envelope
 * does not already hold. Duplicates are removed by CODE: the envelope of `get` / `thread` is built from the thread's warnings
 * plus the conversation-level ones, so a thread warning normally reappears there, and listing the same code twice would only
 * make the output longer.
 *
 * Why this exists: `renderThread` prints `ThreadResult.warnings` and nothing else. The envelope's lead warning
 * (SOURCE_NOT_FULL_HISTORY), the one thing that tells a reader that a partial or rendered-only source is not the whole
 * history, lives only on the envelope, so without this merge `gcr get` and `gcr thread` printed fewer warnings than the SDK
 * and MCP for the same call (SPEC-02). Pure and deterministic.
 */
export function mergeWarningsByCode(envelope: readonly Warning[], thread: readonly Warning[]): Warning[] {
  const copy = (w: Warning): Warning => (w.ids === undefined ? { code: w.code, message: w.message } : { code: w.code, message: w.message, ids: [...w.ids] });
  const codes = new Set(envelope.map((w) => w.code));
  const out = envelope.map(copy);
  for (const w of thread) {
    if (codes.has(w.code)) continue;
    codes.add(w.code);
    out.push(copy(w));
  }
  return out;
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
      return `${escapeJsonHazards(JSON.stringify(doc, null, 2))}\n`;
    }
    if (format === 'jsonl') {
      const lines = rendered.trimEnd().split('\n');
      const last = lines.length - 1;
      const footer = JSON.parse(lines[last] ?? '') as Record<string, unknown>;
      if (footer['type'] !== 'footer') return rendered;
      footer['warnings'] = merged(footer['warnings'], extra);
      lines[last] = escapeJsonHazards(JSON.stringify(footer));
      return `${lines.join('\n')}\n`;
    }
  } catch {
    // The renderer's output is always valid JSON; if that ever stops being true, printing it unchanged beats failing.
    return rendered;
  }
  return rendered;
}
