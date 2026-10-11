/**
 * Result envelopes for the SDK facade (SPEC section 7 and FR-09, docs/ARCHITECTURE.md section 8).
 *
 * Every read the SDK performs comes back as a `ResultEnvelope<T>` that says WHERE the data came from (`source`), HOW
 * COMPLETE that source is (`completeness`), what was noticed on the way (`warnings`), which ids the data cites (`ids`)
 * and whether the data holds imported text that must be treated as DATA (`untrustedContent`).
 *
 * Rules implemented here (and nowhere else, so CLI and MCP cannot drift):
 *  - `source` has ONE entry per distinct import batch that contributed, derived from the stored `source_batches` row.
 *    The label is a BASENAME only (a path would leak the operator's directory layout, NFR-07). Order: import order (seq).
 *  - `completeness` is computed per contributing CONVERSATION: its own `completeness` column is authoritative
 *    (ARCHITECTURE section 5) but is never allowed to be STRONGER than its batch row (a batch the importer marked partial
 *    cannot yield complete conversations). One distinct value -> that value; several -> "mixed"; nothing contributed ->
 *    "unknown" (we then know nothing about completeness and say so). `source[i].completeness` is the weakest such value
 *    among the contributing conversations of that batch, so a source never contradicts the envelope that cites it.
 *  - Whenever the result is not a complete exported tree, the FIRST warning is SOURCE_NOT_FULL_HISTORY, which states what
 *    is missing. A rendered or partial source must never be mistaken for the full conversation history (FR-09).
 *  - Warnings are de-duplicated (same code, message and ids) and keep their first-occurrence order: deterministic output.
 *
 * Pure module: no I/O, no clock, no randomness. Batch rows are supplied through a lookup function by the caller.
 */
import type { BatchInfo } from '../domain/results.js';
import type { Completeness, ResultEnvelope, SourceSummary } from '../domain/types.js';
import type { Warning } from '../errors.js';

/** Code of the warning attached to every envelope whose completeness is not `exported_tree`. */
export const SOURCE_NOT_FULL_HISTORY = 'SOURCE_NOT_FULL_HISTORY';

export type OverallCompleteness = Completeness | 'mixed';

/** Strongest first. The index is the rank: a larger index is a weaker claim about the history. */
export const COMPLETENESS_ORDER: readonly Completeness[] = [
  'exported_tree',
  'api_owned_conversation',
  'rendered_active_view_only',
  'partial_user_supplied',
  'unknown',
];

const MAX_WARNING_IDS = 20;

/** A stored value that is not a known completeness (a damaged or newer database) counts as "unknown", never as complete. */
export function normalizeCompleteness(value: string): Completeness {
  return (COMPLETENESS_ORDER as readonly string[]).includes(value) ? (value as Completeness) : 'unknown';
}

/** Index in COMPLETENESS_ORDER (larger = weaker). */
export function completenessRank(value: Completeness): number {
  return COMPLETENESS_ORDER.indexOf(value);
}

/** The weakest value of the list, or null for an empty list. */
export function weakestCompleteness(values: readonly Completeness[]): Completeness | null {
  let weakest: Completeness | null = null;
  for (const v of values) {
    if (weakest === null || completenessRank(v) > completenessRank(weakest)) weakest = v;
  }
  return weakest;
}

/** One value if all agree, "mixed" if they differ, "unknown" if nothing contributed. */
export function overallCompleteness(values: readonly Completeness[]): OverallCompleteness {
  const first = values[0];
  if (first === undefined) return 'unknown';
  return values.every((v) => v === first) ? first : 'mixed';
}

/** Last path segment of a label; `null` when nothing printable is left. Defensive: stored labels are basenames already. */
export function basenameLabel(label: string | null): string | null {
  if (label === null) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = label.replace(/[\u0000-\u001f\u007f]/g, '');
  const last = cleaned.split(/[\\/]+/).filter((p) => p !== '' && p !== '.' && p !== '..').at(-1);
  return last === undefined ? null : last.slice(0, 255);
}

/** The public view of a stored batch (no counts, hashes or warnings). */
export function toSourceSummary(b: BatchInfo): SourceSummary {
  return {
    provider: b.provider,
    accountLabel: b.accountLabel,
    provenance: b.provenance,
    completeness: normalizeCompleteness(b.completeness),
    batchId: b.batchId,
    sourceLabel: basenameLabel(b.sourceLabel),
    importedAt: b.importedAt,
    toolVersion: b.toolVersion,
  };
}

function wordsFor(c: OverallCompleteness): string {
  switch (c) {
    case 'rendered_active_view_only':
      return 'only the active view as rendered was captured: branches and turns that were not rendered are missing';
    case 'partial_user_supplied':
      return 'the user supplied only part of the conversation (manual copy): messages that were not copied are missing and the active branch is unknown';
    case 'api_owned_conversation':
      return 'the conversation came from the OpenAI developer API, which is not ChatGPT consumer chat history, and may be incomplete';
    case 'mixed':
      return 'the contributing sources differ in completeness and at least one is not a complete exported tree';
    case 'unknown':
      return 'the source does not establish whether it holds the full conversation history';
    case 'exported_tree':
      return 'the export holds the full tree it contained';
  }
}

/** The warning that every non-`exported_tree` envelope starts with. It states what is missing (FR-09). */
export function notFullHistoryWarning(overall: OverallCompleteness, values: readonly Completeness[], sources: readonly SourceSummary[]): Warning {
  const ids = sources.filter((s) => s.completeness !== 'exported_tree').map((s) => s.batchId).slice(0, MAX_WARNING_IDS);
  if (values.length === 0 && sources.length === 0) {
    return {
      code: SOURCE_NOT_FULL_HISTORY,
      message:
        'No imported conversation contributed to this result, so nothing is known about its completeness. An empty result is not proof that a conversation is absent from the original history, only from the data you imported.',
    };
  }
  const weakest = weakestCompleteness(values);
  const detail =
    overall === 'mixed' && weakest !== null
      ? `${wordsFor('mixed')} (distinct values: ${[...new Set(values)].sort().join(', ')}; weakest: ${weakest}: ${wordsFor(weakest)})`
      : wordsFor(overall);
  const message = `This result is NOT the full conversation history: completeness is "${overall}": ${detail}.`;
  return ids.length === 0 ? { code: SOURCE_NOT_FULL_HISTORY, message } : { code: SOURCE_NOT_FULL_HISTORY, message, ids };
}

/** De-duplicate warnings (same code, message and ids), keeping first-occurrence order. */
export function mergeWarnings(...lists: ReadonlyArray<readonly Warning[] | undefined>): Warning[] {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const list of lists) {
    if (list === undefined) continue;
    for (const w of list) {
      const key = JSON.stringify([w.code, w.message, w.ids ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w.ids === undefined ? { code: w.code, message: w.message } : { code: w.code, message: w.message, ids: [...w.ids] });
    }
  }
  return out;
}

/** true when any warning cites ids: they come from the import and are untrusted strings like everything else. */
export function warningsCarryIds(warnings: readonly Warning[]): boolean {
  return warnings.some((w) => w.ids !== undefined && w.ids.length > 0);
}

/** First-occurrence-ordered distinct values. */
export function uniq<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** One conversation snapshot that contributed to a result: which batch it lives in and how complete it is. */
export interface Contribution {
  batchId: string;
  completeness: Completeness;
}

export type BatchLookup = (batchId: string) => BatchInfo | null;

export interface EnvelopeParts<T> {
  data: T;
  /** One entry per contributing conversation snapshot (repeats are fine). */
  contributions: readonly Contribution[];
  /** Batches that must be listed as sources even when no conversation contributed (an import of an empty export). */
  extraBatchIds?: readonly string[];
  warnings?: readonly Warning[];
  /** Empty lists are dropped; duplicates removed. */
  ids?: {
    conversationIds?: readonly string[];
    messageIds?: readonly string[];
    branchIds?: readonly string[];
    draftIds?: readonly string[];
    annotationIds?: readonly string[];
  };
  /** Default true: results are derived from imported text. Pass false only when data AND warnings hold no imported strings. */
  untrustedContent?: boolean;
}

/** Provenance fields shared by every envelope-like result, without `data`. */
export type Provenance = Pick<ResultEnvelope<never>, 'source' | 'completeness' | 'warnings' | 'untrustedContent'>;

/** Everything except `data` and `ids`: used by results that are not wrapped in a ResultEnvelope (graph HTML export). */
export function buildProvenance(lookup: BatchLookup, parts: Omit<EnvelopeParts<unknown>, 'data' | 'ids'>): Provenance {
  const batchIds = uniq([...parts.contributions.map((c) => c.batchId), ...(parts.extraBatchIds ?? [])]);
  const found = new Map<string, BatchInfo>();
  const missing: string[] = [];
  for (const id of batchIds) {
    const b = lookup(id);
    if (b === null) missing.push(id);
    else found.set(id, b);
  }

  // Effective completeness of every contributing conversation: its own value, capped by its batch row.
  const values: Completeness[] = [];
  const perBatch = new Map<string, Completeness[]>();
  for (const c of parts.contributions) {
    const b = found.get(c.batchId);
    const effective = b === undefined ? 'unknown' : (weakestCompleteness([normalizeCompleteness(c.completeness), normalizeCompleteness(b.completeness)]) ?? 'unknown');
    values.push(effective);
    const list = perBatch.get(c.batchId);
    if (list === undefined) perBatch.set(c.batchId, [effective]);
    else list.push(effective);
  }
  // A batch listed without any contributing conversation speaks for itself (an import of an empty export).
  for (const [id, b] of found) {
    if (perBatch.has(id)) continue;
    const own = normalizeCompleteness(b.completeness);
    values.push(own);
    perBatch.set(id, [own]);
  }
  // A batch row that vanished (cannot happen with foreign keys, but the database is a file anyone can edit) is unknown, never complete.
  if (missing.length > 0) values.push('unknown');

  const sources = [...found.values()].sort((a, b) => a.seq - b.seq || (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0));
  const source: SourceSummary[] = sources.map((b) => ({ ...toSourceSummary(b), completeness: weakestCompleteness(perBatch.get(b.batchId) ?? []) ?? 'unknown' }));
  const overall = overallCompleteness(values);

  const lead: Warning[] = [];
  if (overall !== 'exported_tree') lead.push(notFullHistoryWarning(overall, values, source));
  if (missing.length > 0) {
    lead.push({
      code: 'SOURCE_BATCH_MISSING',
      message: `${missing.length} contributing import batch row(s) could not be read; their provenance is unknown.`,
      ids: missing.slice(0, MAX_WARNING_IDS),
    });
  }
  return {
    source,
    completeness: overall,
    warnings: mergeWarnings(lead, parts.warnings),
    untrustedContent: parts.untrustedContent ?? true,
  };
}

/** Build the envelope. See the file header for the rules. */
export function buildEnvelope<T>(lookup: BatchLookup, parts: EnvelopeParts<T>): ResultEnvelope<T> {
  const p = buildProvenance(lookup, parts);
  const ids: ResultEnvelope<T>['ids'] = {};
  const put = (key: keyof ResultEnvelope<T>['ids'], values: readonly string[] | undefined): void => {
    const u = values === undefined ? [] : uniq(values);
    if (u.length > 0) ids[key] = u;
  };
  put('conversationIds', parts.ids?.conversationIds);
  put('messageIds', parts.ids?.messageIds);
  put('branchIds', parts.ids?.branchIds);
  put('draftIds', parts.ids?.draftIds);
  put('annotationIds', parts.ids?.annotationIds);
  return { ok: true, data: parts.data, source: p.source, completeness: p.completeness, warnings: p.warnings, ids, untrustedContent: p.untrustedContent };
}
