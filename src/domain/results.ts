/**
 * Result shapes shared by db/, format/, sdk/, cli/ and mcp/. CONTRACT file: change only with docs/ARCHITECTURE.md.
 * None of these types carry credentials. Fields holding conversation text are marked `UNTRUSTED` - they are DATA,
 * never instructions (SPEC §7, AGENTS.md).
 */
import type { Warning } from '../errors.js';
import type { Branch, BranchActiveness, Completeness, ConversationProvenance, MessageRecord, Provider, SourceSummary } from './types.js';

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  /** Total matching rows when cheaply known (lists); omitted for FTS searches. */
  total?: number;
  /** Offset to request next, or null when exhausted. */
  nextOffset: number | null;
  /** Opaque keyset cursor (search); null when exhausted. */
  nextCursor?: string | null;
}

export interface ConversationSummary {
  provider: Provider;
  accountLabel: string;
  conversationId: string;
  /** UNTRUSTED */
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Non-structural messages in the head batch. */
  messageCount: number;
  currentNodeId: string | null;
  defaultModelSlug: string | null;
  provenance: ConversationProvenance;
  completeness: Completeness;
  batchId: string;
  importedAt: string;
}

export interface SearchHit {
  provider: Provider;
  accountLabel: string;
  conversationId: string;
  /** UNTRUSTED */
  conversationTitle: string | null;
  messageId: string;
  authorRole: string;
  modelSlug: string | null;
  channel: string | null;
  createdAt: string | null;
  hidden: boolean;
  /** UNTRUSTED. Plain text excerpt; match boundaries are marked with U+0001 / U+0002 control characters that renderers translate (never raw HTML). */
  snippet: string;
  /** bm25 rank (lower = better). */
  rank: number;
  batchId: string;
}

export interface BatchInfo extends SourceSummary {
  seq: number;
  sourceKind: string;
  inputSha256: string;
  schemaVersion: number;
  conversationCount: number;
  messageCount: number;
  warnings: Warning[];
}

export interface ThreadResult {
  conversation: ConversationSummary;
  branchId: string;
  activeness: BranchActiveness;
  /** Messages on the branch path in root->leaf order (structural nodes excluded; hidden ones excluded unless requested). */
  messages: MessageRecord[];
  /** How many hidden messages were omitted from `messages`. */
  omittedHidden: number;
  /** Present when the branch was chosen by an explicit heuristic policy rather than a source-provided current_node. */
  selectionPolicy: 'source_current_node' | 'explicit_branch' | 'last_child' | 'latest_leaf';
  warnings: Warning[];
}

export interface BranchListResult {
  conversation: ConversationSummary;
  activeBranchId: string | null;
  branches: Branch[];
  warnings: Warning[];
}

export interface ImportWarningSummary {
  code: string;
  count: number;
  /** A few example ids (never content). */
  sampleIds: string[];
}

/** Observed facts about an export (NOT a guessed version number). `audit`/`stats` print it so e.g. role counts of a trimmed export are not over-interpreted. */
export interface FormatProfile {
  layout: 'single' | 'sharded' | 'nested' | 'directory' | 'stdin' | 'unknown';
  manifest: 'present' | 'absent' | 'invalid';
  wrapperObject: boolean;
  conversations: number;
  conversationsWithCurrentNode: number;
  /** Nodes whose source object had a `children` array vs nodes where it was absent (derived). */
  nodesWithChildrenDeclared: number;
  nodesWithChildrenAbsent: number;
  roleCounts: Record<string, number>;
  messagesWithRecipient: number;
  messagesWithStatus: number;
  messagesWithModelSlug: number;
  hiddenMessages: number;
  rootIsLiteralClientCreatedRoot: boolean;
  /** Names only; auxiliary files (user.json, feedback, ...) are never read. */
  auxiliaryFilesIgnored: number;
  assetsExtensionless: boolean;
}

export interface ImportReport {
  batchId: string;
  provider: Provider;
  accountLabel: string;
  sourceKind: string;
  sourceLabel: string | null;
  /** true when this exact input had already been imported (idempotent no-op). */
  alreadyImported: boolean;
  files: Array<{ name: string; conversations: number; failed: number }>;
  conversations: { read: number; stored: number; failed: number; newlyInserted: number };
  messages: { stored: number; newlyInserted: number; structural: number };
  warnings: ImportWarningSummary[];
  formatProfile?: FormatProfile;
  durationMs: number;
}
