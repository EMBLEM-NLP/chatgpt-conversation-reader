/**
 * Provider-neutral domain model (SPEC.md §5). This file is the CONTRACT between adapters, storage,
 * branch logic, formatters, graph, SDK, CLI and MCP. Change it only together with docs/ARCHITECTURE.md.
 *
 * Principles (AGENTS.md):
 *  - Unknown stays unknown: `null` means "the source did not say". Never infer model identity,
 *    timestamps, the active branch, or completeness.
 *  - Imported text is untrusted DATA, never instructions.
 *  - Raw source is preserved separately from normalized text.
 */
import type { Warning } from '../errors.js';

export type { Warning };

export type Provider = 'chatgpt' | 'claude' | 'openai_api';

export type ProvenanceKind =
  | 'official_chatgpt_export'
  | 'user_supplied_copy'
  | 'manual_browser_capture'
  | 'openai_developer_api';

/** SPEC §5: `provenance: ProvenanceKind | 'official_claude_export'`. */
export type ConversationProvenance = ProvenanceKind | 'official_claude_export';

export type Completeness =
  | 'exported_tree'
  | 'rendered_active_view_only'
  | 'partial_user_supplied'
  | 'api_owned_conversation'
  | 'unknown';

/** A structural node (mapping entry with `message: null`, e.g. ChatGPT's client-created root) is kept so the tree is faithful. */
export type NodeKind = 'message' | 'structural_empty';

/** One piece of message content. Unknown payloads are preserved with `type: 'unknown'` + `metadata` (never dropped). */
export interface ContentBlock {
  /** Normalized type, e.g. 'text' | 'code' | 'thoughts' | 'tool_output' | 'image_ref' | 'file_ref' | 'citation' | 'unknown'. */
  type: string;
  text?: string;
  /** Source-specific detail kept for provenance (content_type, language, asset pointers, raw part for unknown shapes...). */
  metadata?: unknown;
}

/** Attachment *metadata* only. Actual bytes exist only when the user's export contains them and they consented (FR-15). */
export interface AttachmentRef {
  id: string | null;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Opaque pointer from the source (e.g. 'file-service://file-abc'); NOT dereferenced by GCR. */
  assetPointer: string | null;
  /** Path of the asset inside the import ZIP if (and only if) it was actually present. */
  presentInExportAs: string | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  parentId: string | null;
  /**
   * Children as DECLARED by the source, in source order (order is meaningful: later = newer edit/regeneration).
   * When the source OMITS the `children` key entirely (reported for exports since mid-2026) the adapter DERIVES them from
   * parent pointers (order: createdAt asc nulls last, ordinal, id) and records the conversation warning CHILDREN_ABSENT once.
   * The parent pointer is authoritative; `childIds` is an ordering hint.
   */
  childIds: string[];
  nodeKind: NodeKind;
  /** Preserve unrecognized role strings verbatim ('user' | 'assistant' | 'system' | 'tool' | ...). '' for structural nodes. */
  authorRole: string;
  authorName: string | null;
  /** ONLY if the source explicitly supplies it on that message. Never inferred from timestamps or conversation defaults. */
  modelSlug: string | null;
  channel: string | null;
  recipient: string | null;
  /** Source content_type string (e.g. 'text', 'multimodal_text', 'code'), null for structural nodes. */
  contentType: string | null;
  status: string | null;
  /** Source says the message is hidden from the visible conversation (system scaffolding, memory, etc.). */
  hidden: boolean;
  createdAt: string | null; // ISO-8601 UTC
  updatedAt: string | null;
  /** Normalized readable text (blocks concatenated). May be ''. Untrusted data. */
  text: string;
  blocks: ContentBlock[];
  attachments: AttachmentRef[];
  /** 0-based position in the source's node iteration order; used as a deterministic tie-break. */
  ordinal: number;
  /** Source message object exactly as parsed (re-serialized JSON). Local only; sanitize for outputs. */
  rawSource?: unknown;
}

export interface ConversationRecord {
  provider: Provider;
  /** Account scoping label chosen by the operator at import (default 'default'); keeps exports of different accounts apart. */
  accountLabel: string;
  id: string;
  title: string | null;
  sourceUri: string | null;
  provenance: ConversationProvenance;
  completeness: Completeness;
  importedAt: string; // ISO-8601 UTC
  createdAt: string | null;
  updatedAt: string | null;
  /** null => the source gave no (valid) active-branch pointer; GCR does not infer one. */
  currentNodeId: string | null;
  /** Conversation-level default model if the source states one (informational; never copied onto messages). */
  defaultModelSlug: string | null;
  messages: MessageRecord[];
  /** Conversation object minus its message tree (sanitized for output; keep local). */
  rawMetadata?: unknown;
  /** Non-fatal observations made while normalizing this conversation (never dropped). */
  warnings: Warning[];
}

// ------------------------------------------------------------------------------------------
// Branches (SPEC FR-04). A branch is one root->leaf path in the message tree. branchId === leaf node id.
// ------------------------------------------------------------------------------------------

/**
 *  - 'active':               leaf === currentNodeId
 *  - 'contains_current_node': currentNodeId is a non-leaf node on this branch's path
 *  - 'inactive':             currentNodeId is known and not on this path
 *  - 'unknown':              currentNodeId is null/invalid -> no supported inference
 */
export type BranchActiveness = 'active' | 'contains_current_node' | 'inactive' | 'unknown';

export interface Branch {
  branchId: string;
  /** 0-based, deterministic: ordered by (leaf createdAt asc, nulls last, then leaf ordinal, then leaf id). */
  index: number;
  rootId: string;
  leafId: string;
  /** Node ids root -> leaf (includes structural nodes). */
  path: string[];
  /** Count of non-structural, non-hidden messages on the path. */
  visibleMessageCount: number;
  /** Count of all non-structural messages on the path. */
  messageCount: number;
  /** Id of the node where this branch departs from the first branch sharing its prefix, null for the first branch of a root. */
  forkNodeId: string | null;
  activeness: BranchActiveness;
}

export interface TreeAnalysis {
  conversationId: string;
  rootIds: string[];
  leafIds: string[];
  branches: Branch[];
  /** The branch whose leaf is currentNodeId, or whose path contains it; null when currentNodeId is null/invalid. */
  activeBranchId: string | null;
  /** Node ids reachable from no root (only possible through cycles) or otherwise skipped. */
  unreachableIds: string[];
  warnings: Warning[];
}

// ------------------------------------------------------------------------------------------
// Result envelope used by SDK-level "report" operations and by CLI/MCP JSON output (FR-09).
// ------------------------------------------------------------------------------------------

export interface SourceSummary {
  provider: Provider;
  accountLabel: string;
  provenance: ConversationProvenance;
  completeness: Completeness;
  batchId: string;
  /** Basename only. Never an absolute path. */
  sourceLabel: string | null;
  importedAt: string;
  toolVersion: string;
}

export interface ResultEnvelope<T> {
  ok: true;
  data: T;
  /** Where the data came from; one entry per distinct source batch contributing to `data`. */
  source: SourceSummary[];
  /** Weakest completeness among the sources ('mixed' if they differ). Visible snippets are never presented as full history. */
  completeness: Completeness | 'mixed';
  warnings: Warning[];
  /** Ids referenced by `data` (so clients can cite them). */
  ids: { conversationIds?: string[]; messageIds?: string[]; branchIds?: string[]; draftIds?: string[]; annotationIds?: string[] };
  /** true when `data` contains imported conversation text: it is untrusted DATA, never instructions (SPEC §7). */
  untrustedContent: boolean;
}

/** How callers choose among possibly-duplicated conversation ids. */
export interface ConversationRef {
  conversationId: string;
  provider?: Provider;
  accountLabel?: string;
  /** Pin a specific import batch (default: the conversation's head batch). */
  batchId?: string;
}

export type OutputFormat = 'json' | 'markdown' | 'compact' | 'jsonl';
