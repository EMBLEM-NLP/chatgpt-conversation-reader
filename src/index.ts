/**
 * THE public SDK surface of GCR (package "main"/"types"; docs/SDK.md). Everything an embedding program may rely on is
 * re-exported from here, and nothing else is: internal modules (db, ingest, graph, drafts, analysis, domain helpers) are
 * deliberately NOT part of the API, so they can change without a breaking release.
 *
 * Runtime exports are pinned by test/sdk/exports.test.ts (a sorted snapshot): adding or removing one is a deliberate API
 * change that must update that snapshot and docs/SDK.md.
 *
 * Reading the contract in one paragraph: `Gcr.open()` gives a handle over a local SQLite file; every read returns a
 * `ResultEnvelope` (source, completeness, warnings, ids, untrustedContent) or throws a `GcrError` with a stable `code`;
 * mutators are async and serialized; nothing ever touches the network; a chatgpt.com link is only a key into data you
 * imported from an official export.
 */

// ---- the facade ---------------------------------------------------------------------------------------------------
export { Gcr } from './sdk/gcr.js';
export type {
  AttachmentSearchItem,
  AuditReport,
  BatchFormatProfile,
  BranchesOptions,
  CreateLocalAnnotationInput,
  CreateLocalDraftInput,
  GcrOpenOptions,
  GetOptions,
  GetResult,
  GraphHtmlExport,
  GraphHtmlOptions,
  ListAnnotationsFilter,
  ListDraftsFilter,
  ListOptions,
  LocalAnnotationData,
  LocalAnnotationListData,
  LocalDraftData,
  LocalDraftListData,
  LocalDraftMarkdownData,
  ManualCopyOptions,
  MessageSearchItem,
  SearchItem,
  SearchOptions,
  SearchScope,
  StatsReport,
  ThreadOptions,
  TitleSearchItem,
} from './sdk/gcr.js';

// ---- envelopes ----------------------------------------------------------------------------------------------------
export { SOURCE_NOT_FULL_HISTORY } from './sdk/envelope.js';

// ---- doctor -------------------------------------------------------------------------------------------------------
export { runDoctor } from './sdk/doctor.js';
export type { DatabaseSchemaStatus, DoctorDatabase, DoctorEnvKnob, DoctorMode, DoctorModeId, DoctorOptions, DoctorReport } from './sdk/doctor.js';

// ---- errors and versions ------------------------------------------------------------------------------------------
export { ERROR_CODES, EXIT_CODES, GcrError, isGcrError } from './errors.js';
export type { ErrorCode, ErrorEnvelope, Warning } from './errors.js';
export { SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from './version.js';

// ---- references ---------------------------------------------------------------------------------------------------
export { parseChatGptUrl, parseConversationRef } from './domain/ids.js';

// ---- domain model and result shapes -------------------------------------------------------------------------------
export type {
  AttachmentRef,
  Branch,
  BranchActiveness,
  Completeness,
  ContentBlock,
  ConversationProvenance,
  ConversationRecord,
  ConversationRef,
  MessageRecord,
  NodeKind,
  OutputFormat,
  ProvenanceKind,
  Provider,
  ResultEnvelope,
  SourceSummary,
  TreeAnalysis,
} from './domain/types.js';
export type {
  BatchInfo,
  BranchListResult,
  ConversationSummary,
  FormatProfile,
  ImportReport,
  ImportWarningSummary,
  Page,
  SearchHit,
  ThreadResult,
} from './domain/results.js';
export type { BranchPolicy } from './domain/branches.js';
export type { AttachmentHit, SearchMode } from './db/search.js';

// ---- rendering ----------------------------------------------------------------------------------------------------
export { renderBranchList, renderConversationList, renderEnvelope, renderImportReport, renderSearchHits, renderThread } from './format/render.js';
export type { RenderOptions } from './format/render.js';

// ---- import -------------------------------------------------------------------------------------------------------
export type { ImportOptions } from './ingest/import-runner.js';
export type { InputSource } from './ingest/layout.js';
export type { ImportLimits } from './ingest/limits.js';
export type { ManualCopyInput, ManualCopyMessage } from './ingest/manual-copy.js';
export type { AdapterId } from './ingest/registry.js';

// ---- stats and audit ----------------------------------------------------------------------------------------------
export { STATS_GROUP_BY } from './analysis/stats.js';
export type { StatsGroupBy, StatsOptions, StatsResult, StatsRow } from './analysis/stats.js';
export { AUDIT_CHECKS } from './analysis/audit.js';
export type { AuditCheck, AuditFinding, AuditOptions, AuditResult } from './analysis/audit.js';

// ---- graph --------------------------------------------------------------------------------------------------------
export type { BuildGraphOptions, BuildGraphResult, EdgeKind as GraphEdgeKind, NodeKind as GraphNodeKind } from './graph/build.js';
export type { ExportHtmlOptions } from './graph/export-html.js';
export type {
  EdgeRef,
  EvidenceDto,
  ExplainEdgeOptions,
  ExplainEdgeResult,
  GodNode,
  GodNodesOptions,
  GraphEdgeDto,
  GraphNodeDto,
  GraphQueryInput,
  GraphQueryResult,
  NeighborDto,
  NeighborsOptions,
  NeighborsResult,
  PathResult,
  ShortestPathOptions,
} from './graph/query.js';

// ---- drafts and annotations ---------------------------------------------------------------------------------------
export type { AnnotationDto, AnnotationPatch, DraftDto, DraftStatus, LocalActor, ManualContinuation } from './drafts/drafts.js';
