/**
 * Small text helpers for the CLI: making user-typed text safe to echo, and "did you mean" suggestions.
 *
 * Everything here is pure. Nothing prints.
 */

// Control characters, DEL, C1 controls, line/paragraph separators, bidi controls: replaced by "?" when text typed on the
// command line (an unknown command, a flag name) is echoed back, so an argument can never carry terminal escape
// sequences into an error message (NFR-04: no ANSI anywhere).
/**
 * Builds a character class from code point ranges. The ranges are written as numbers on purpose: this source file then
 * contains no literal bidi/separator characters and no escape sequences for them either (Trojan Source hygiene).
 */
function charClass(ranges: ReadonlyArray<readonly [number, number]>): string {
  return `[${ranges.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`;
}

const UNPRINTABLE = new RegExp(
  charClass([
    [0x0000, 0x001f], // C0 controls, including ESC (ANSI sequences) and NUL
    [0x007f, 0x009f], // DEL and C1 controls (0x9b is CSI)
    [0x2028, 0x2029], // line and paragraph separators
    [0x202a, 0x202e], // bidi embeddings and overrides
    [0x2066, 0x2069], // bidi isolates
    [0xd800, 0xdfff], // lone surrogates (the `u` flag makes a surrogate pair one code point, which does not match)
    [0xe0000, 0xe007f], // Unicode TAG characters (invisible text)
  ]),
  'gu',
);

/** `text` with unprintable characters replaced by "?" and cut to `max` code points (an ellipsis marks a cut). */
export function printable(text: string, max = 80): string {
  const cleaned = text.replace(UNPRINTABLE, '?');
  const points = Array.from(cleaned);
  return points.length <= max ? cleaned : `${points.slice(0, max).join('')}...`;
}

/** Levenshtein distance with an early exit once every cell of a row exceeds `limit` (returns limit + 1 then). */
export function editDistance(a: string, b: string, limit = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length] ?? limit + 1;
}

/**
 * The pool entry closest to `candidate` (case-insensitive), or undefined when nothing is close. "Close" is an edit
 * distance of at most one third of the candidate's length, between 1 and 3. Ties go to the earlier pool entry, so the
 * suggestion is deterministic.
 */
export function nearest(candidate: string, pool: readonly string[]): string | undefined {
  const needle = candidate.toLowerCase();
  if (needle === '') return undefined;
  const allowed = Math.min(3, Math.max(1, Math.floor(needle.length / 3)));
  let best: string | undefined;
  let bestDistance = allowed + 1;
  for (const entry of pool) {
    const d = editDistance(needle, entry.toLowerCase(), allowed);
    if (d < bestDistance) {
      best = entry;
      bestDistance = d;
    }
  }
  return best;
}

/** `a, b and c` style list for messages. */
export function humanList(items: readonly string[], conjunction = 'or'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1] ?? ''}`;
}
