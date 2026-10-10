/**
 * Source adapters turn ONE provider-specific conversation element (raw JSON text, as yielded by
 * json-stream.ts) into the provider-neutral ConversationRecord. CONTRACT file: change only with docs/ARCHITECTURE.md.
 *
 * Adapters are pure: no I/O, no clocks (importedAt comes from the context), no network. They never throw for a bad
 * OPTIONAL field (record a warning, keep the raw value); they throw GcrError IMPORT_PARSE_ERROR only when the element
 * is unusable as a conversation, and the runner then skips just that element (unless --strict).
 */
import type { ConversationProvenance, ConversationRecord, Provider } from '../domain/types.js';
import type { Warning } from '../errors.js';

export interface AdapterContext {
  provider: Provider;
  /** Operator-chosen account label stored on every record (default 'default'). */
  accountLabel: string;
  /** ISO-8601 UTC import time supplied by the caller (adapters never read the clock). */
  importedAt: string;
  /** Names (never contents) of files present in the container, used only to set AttachmentRef.presentInExportAs. */
  availableAssetNames?: ReadonlySet<string>;
}

/** Counts a single conversation contributes to the batch FormatProfile (src/domain/results.ts). */
export interface FormatObservations {
  nodesWithChildrenDeclared: number;
  nodesWithChildrenAbsent: number;
  hasCurrentNode: boolean;
  roleCounts: Record<string, number>;
  messagesWithRecipient: number;
  messagesWithStatus: number;
  messagesWithModelSlug: number;
  hiddenMessages: number;
  rootIsLiteralClientCreatedRoot: boolean;
}

export type AdapterOutcome =
  | { kind: 'record'; record: ConversationRecord; observations: FormatObservations; sourceElementSha256: string }
  | { kind: 'skipped'; reason: 'EMPTY_CONVERSATION_ENTRY' | 'NON_OBJECT_ENTRY' | 'NOT_A_CONVERSATION'; warnings: Warning[] };

export interface ConversationSourceAdapter {
  readonly name: string;
  readonly provider: Provider;
  readonly provenance: ConversationProvenance;
  /** `elementIndex` is the 0-based position of the element in its file and is only used for deterministic fallback ids / warnings. */
  normalizeElementText(text: string, ctx: AdapterContext, elementIndex: number): AdapterOutcome;
}
