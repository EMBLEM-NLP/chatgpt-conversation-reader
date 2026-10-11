/**
 * The PUBLIC SDK surface (src/index.ts). The sorted list of runtime export names is pinned: an accidental API change shows
 * up here. To change the API deliberately, update EXPECTED_RUNTIME_EXPORTS and docs/SDK.md in the same change.
 * Type-only exports are checked at compile time by the `Public` block below (a missing type fails the build).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import * as sdk from '../../src/index.js';
import type {
  AdapterId,
  AuditOptions,
  AuditReport,
  BatchInfo,
  BranchListResult,
  BranchPolicy,
  BuildGraphOptions,
  BuildGraphResult,
  Completeness,
  ConversationRecord,
  ConversationRef,
  ConversationSummary,
  DoctorReport,
  DraftDto,
  ErrorCode,
  ErrorEnvelope,
  FormatProfile,
  GcrOpenOptions,
  GetOptions,
  GetResult,
  GraphHtmlExport,
  ImportOptions,
  ImportReport,
  MessageRecord,
  Page,
  RenderOptions,
  ResultEnvelope,
  SearchHit,
  SearchItem,
  SearchOptions,
  SourceSummary,
  StatsOptions,
  StatsReport,
  ThreadResult,
  Warning,
} from '../../src/index.js';

/** Compile-time anchor: if any exported type above disappears or changes shape incompatibly this block stops compiling. */
interface Public {
  open: GcrOpenOptions;
  envelope: ResultEnvelope<Page<ConversationSummary>>;
  search: [SearchOptions, SearchItem, SearchHit];
  get: [GetOptions, GetResult, ThreadResult, BranchListResult];
  import: [ImportOptions, ImportReport, BatchInfo, FormatProfile, AdapterId];
  analysis: [StatsOptions, StatsReport, AuditOptions, AuditReport];
  graph: [BuildGraphOptions, BuildGraphResult, GraphHtmlExport];
  domain: [ConversationRecord, ConversationRef, MessageRecord, Completeness, SourceSummary, BranchPolicy];
  errors: [ErrorCode, ErrorEnvelope, Warning];
  other: [DoctorReport, DraftDto, RenderOptions];
}
const publicTypes = null as unknown as Public;
void publicTypes;

const EXPECTED_RUNTIME_EXPORTS = [
  'AUDIT_CHECKS',
  'ERROR_CODES',
  'EXIT_CODES',
  'Gcr',
  'GcrError',
  'SCHEMA_VERSION',
  'SOURCE_NOT_FULL_HISTORY',
  'STATS_GROUP_BY',
  'TOOL_NAME',
  'TOOL_VERSION',
  'isGcrError',
  'parseChatGptUrl',
  'parseConversationRef',
  'renderBranchList',
  'renderConversationList',
  'renderEnvelope',
  'renderImportReport',
  'renderSearchHits',
  'renderThread',
  'runDoctor',
] as const;

describe('public export snapshot', () => {
  it('the sorted runtime export names are exactly the documented list', () => {
    assert.deepEqual(Object.keys(sdk).sort(), [...EXPECTED_RUNTIME_EXPORTS].sort());
  });

  it('no internal module leaks: repositories, database openers, adapters, the local store and the graph functions are not exported', () => {
    const names = new Set(Object.keys(sdk));
    for (const internal of [
      'Repository',
      'openDatabase',
      'closeDatabase',
      'toDbError',
      'runImport',
      'runManualCopyImport',
      'LocalStore',
      'buildGraph',
      'exportGraphHtml',
      'searchMessages',
      'computeStats',
      'runAudit',
      'analyzeTree',
      'extractEntities',
      'normalizeError',
      'buildEnvelope',
      'toGcrError',
      'log',
      'getAdapter',
      'SafeZipReader',
    ]) {
      assert.ok(!names.has(internal), `${internal} must stay internal`);
    }
  });

  it('values are what they claim to be', () => {
    assert.equal(typeof sdk.Gcr.open, 'function');
    assert.equal(sdk.TOOL_NAME, 'gcr');
    assert.equal(sdk.SCHEMA_VERSION, 1);
    assert.match(sdk.TOOL_VERSION, /^\d+\.\d+\.\d+/);
    assert.ok(sdk.ERROR_CODES.includes('NOT_IN_LOCAL_EXPORT'));
    assert.equal(sdk.EXIT_CODES.NOT_IN_LOCAL_EXPORT, 3);
    assert.ok(new sdk.GcrError('INTERNAL_ERROR', 'x') instanceof Error);
    assert.equal(sdk.isGcrError(new sdk.GcrError('INTERNAL_ERROR', 'x')), true);
    assert.equal(sdk.isGcrError(new Error('x')), false);
    assert.equal(sdk.SOURCE_NOT_FULL_HISTORY, 'SOURCE_NOT_FULL_HISTORY');
    assert.equal(sdk.parseChatGptUrl('https://chatgpt.com/c/00000000-0000-4000-8000-000000000001').conversationId, '00000000-0000-4000-8000-000000000001');
    assert.equal(sdk.parseConversationRef('00000000-0000-4000-8000-000000000001').viaUrl, false);
    assert.deepEqual([...sdk.STATS_GROUP_BY], ['role', 'model', 'channel', 'day', 'conversation', 'provider', 'content_type']);
    assert.ok(sdk.AUDIT_CHECKS.includes('missing_model'));
  });

  it('the Gcr class exposes exactly the documented public methods (a pinned list)', () => {
    const methods = Object.getOwnPropertyNames(sdk.Gcr.prototype)
      .filter((n) => n !== 'constructor' && !n.startsWith('_'))
      .filter((n) => typeof Object.getOwnPropertyDescriptor(sdk.Gcr.prototype, n)?.value === 'function')
      .sort();
    // Methods that are TypeScript-private are still own properties at runtime; they are listed here so a rename is visible too.
    const privateOnes = ['anchorRef', 'closeHandle', 'filterRef', 'assertOpen', 'assertWritableHandle', 'read', 'exclusive', 'envelope', 'conversationCompleteness', 'scopeContributions', 'anchorContributions', 'graphProvenance', 'computeGraphProvenance', 'supersededAmong', 'prepare', 'formatProfilesFor', 'importEnvelope', 'parseThreadOptions', 'loadConversation', 'messageHitContributions', 'searchAll', 'graphEnvelope', 'edgesAmong', 'draftEnvelope'];
    const publicMethods = methods.filter((m) => !privateOnes.includes(m));
    assert.deepEqual(publicMethods, [
      'archiveDraft',
      'audit',
      'branches',
      'buildGraph',
      'close',
      'createAnnotation',
      'createDraft',
      'doctor',
      'get',
      'getAnnotation',
      'getByUrl',
      'getDraft',
      'graphExplain',
      'graphExport',
      'graphExportHtml',
      'graphGodNodes',
      'graphNeighbors',
      'graphPath',
      'graphQuery',
      'importExport',
      'importManualCopy',
      'list',
      'listAnnotations',
      'listBatches',
      'listDrafts',
      'renderDraftMarkdown',
      'search',
      'stats',
      'thread',
      'updateAnnotation',
    ]);
    assert.equal(typeof sdk.Gcr.doctor, 'function', 'static doctor (no handle needed)');
  });

  it('src/index.ts uses explicit re-exports only (no `export *`), so the surface cannot grow silently', async () => {
    const text = await readFile(new URL('../../../src/index.ts', import.meta.url), 'utf8');
    assert.ok(!/^\s*export\s+\*/m.test(text), 'no wildcard re-exports');
  });
});
