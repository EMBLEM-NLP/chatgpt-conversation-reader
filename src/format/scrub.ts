/**
 * Hazardous-character scrubbing for MACHINE-READABLE output (JSON, JSONL, MCP tool results). One implementation, shared by
 * the CLI renderers (`format/render.ts`) and the MCP envelope (`mcp/envelope.ts`).
 *
 * WHY. `JSON.stringify` escapes only U+0000-U+001F (and lone surrogates). Everything else that matters to a TERMINAL, a
 * LINE READER or a LANGUAGE MODEL that is shown the text stays raw: DEL and the C1 controls (U+009B is an 8-bit CSI, U+0085 a
 * NEXT LINE), the line and paragraph separators U+2028 / U+2029, the bidi embeddings, overrides and isolates (Trojan Source),
 * and the invisible Unicode TAG block (U+E0000-U+E007F) that smuggles text a person cannot see. Imported conversation text is
 * untrusted DATA (AGENTS.md), so none of these may reach a consumer as a raw character.
 *
 * TWO LEVELS, ONE SET OF RULES
 *  - `escapeJsonHazards(json)` works on SERIALIZED JSON text and is LOSSLESS: the characters (which can only occur inside
 *    string values there) are rewritten as `\uXXXX` JSON escapes, so `JSON.parse` returns the exact original text while the raw
 *    bytes never reach a terminal. The CLI output uses it; its bytes are pinned by the CLI tests.
 *  - `visibleEscapes(text)` works on one JAVASCRIPT STRING and is NOT lossless: each character becomes the six visible
 *    characters `\uXXXX` (a TAG character, a surrogate pair, becomes two escapes `󠁁`: exactly what the CLI JSON shows
 *    for it). The MCP envelope uses it because a tool result is consumed as parsed data too (`structuredContent` is an object,
 *    not text), where a lossless escape would be undone by the first `JSON.parse`.
 *
 * The MCP set additionally covers the directional MARKS U+061C, U+200E and U+200F (invisible, and they reorder neighbouring
 * text). The CLI set deliberately does not: its output is pinned byte for byte, and in the human formats ordinary right-to-left
 * text legitimately carries these marks. Both lists are built from `String.raw` text and `new RegExp`, never regex literals:
 * TypeScript 7 re-prints U+2028 / U+2029 escapes inside a regex literal as the raw character, which ends the line inside the
 * literal (see mcp/stdout-guard.ts).
 *
 * Pure: no I/O, no clock, no randomness. Same input, same bytes.
 */

/** DEL and C1 (U+007F-U+009F), LS/PS, bidi embeddings and overrides (U+202A-U+202E), isolates (U+2066-U+2069). */
const BASE_CLASS = String.raw`\u007F-\u009F  ‪-‮⁦-⁩`;
/** Arabic letter mark, left-to-right mark, right-to-left mark. */
const MARK_CLASS = String.raw`؜‎‏`;
/** A Unicode TAG character U+E0000-U+E007F is the surrogate pair DB40 + DC00..DC7F (no `u` flag: matched as code units). */
const TAG_PAIR = String.raw`\uDB40[\uDC00-\uDC7F]`;

/** The set the CLI's JSON writers escape. Global: use only with `String.prototype.replace`, never `.test` (lastIndex state). */
const CLI_HAZARDS = new RegExp(`[${BASE_CLASS}]|${TAG_PAIR}`, 'g');
/** The MCP set: the CLI set plus the directional marks. */
const MCP_HAZARDS = new RegExp(`[${BASE_CLASS}${MARK_CLASS}]|${TAG_PAIR}`, 'g');
/** Non-global twin of MCP_HAZARDS for a stateless yes/no. */
const MCP_HAZARDS_PROBE = new RegExp(`[${BASE_CLASS}${MARK_CLASS}]|${TAG_PAIR}`);

function unitEscape(codeUnit: number): string {
  return `\\u${codeUnit.toString(16).padStart(4, '0')}`;
}

/** `\uXXXX` for every UTF-16 code unit of the match (a TAG character arrives as its surrogate pair and gives two escapes). */
function escapeMatch(match: string): string {
  return match.length === 2 ? unitEscape(match.charCodeAt(0)) + unitEscape(match.charCodeAt(1)) : unitEscape(match.charCodeAt(0));
}

/**
 * LOSSLESS pass over serialized JSON text: hazardous characters (which can only be inside string values) become `\uXXXX` JSON
 * escapes. `JSON.parse(escapeJsonHazards(JSON.stringify(x)))` equals `x`.
 */
export function escapeJsonHazards(json: string): string {
  return json.replace(CLI_HAZARDS, escapeMatch);
}

/**
 * VISIBLE pass over one string for MCP tool results: every hazardous character (the CLI set plus U+061C, U+200E, U+200F) is
 * replaced by its literal `\uXXXX` text. Returns the very same string when it holds none (the common case costs one scan).
 * Ordinary text is never touched: letters of any script, accents, CJK, emoji, TAB, LF, CR and the C0 controls (which
 * `JSON.stringify` already writes as escapes in the text copy of a result).
 */
export function visibleEscapes(text: string): string {
  return MCP_HAZARDS_PROBE.test(text) ? text.replace(MCP_HAZARDS, escapeMatch) : text;
}
