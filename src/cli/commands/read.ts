/**
 * Read-only commands over the local database: list, get, search, branches, thread, stats, audit, batches.
 *
 * Every one of them opens the database READ-ONLY (never creates or migrates), validates conversation references before
 * touching the file, and prints through the shared renderers of src/format/render.ts.
 */
import type { AuditCheck } from '../../analysis/audit.js';
import type { StatsGroupBy } from '../../analysis/stats.js';
import type { BranchPolicy } from '../../domain/branches.js';
import type { Page, ThreadResult } from '../../domain/results.js';
import type { ResultEnvelope } from '../../domain/types.js';
import { renderBranchList, renderConversationList, renderEnvelope, renderSearchHits, renderThread } from '../../format/render.js';
import { notFullHistoryWarning, overallCompleteness, toSourceSummary } from '../../sdk/envelope.js';
import type { SearchItem, SearchOptions, SearchScope } from '../../sdk/gcr.js';
import type { CommandContext } from '../context.js';
import { mergeWarningsByCode, withEnvelopeWarnings } from '../warnings.js';
import { accountOption, allBatchesOption, batchOption, cursorOption, includeHiddenOption, limitOption, offsetOption, providerOption, storedIdOption } from '../options.js';
import type { CommandSpec, OptionSpec } from '../spec.js';
import { conversationFilterValue, defined, emit, first, refFromArgs } from './common.js';

export const DB_READ_ERRORS = ['DB_NOT_FOUND', 'DB_SCHEMA_TOO_NEW', 'DB_ERROR'] as const;
const REF_ERRORS = ['INVALID_URL', 'INVALID_UUID', 'UNSUPPORTED_URL', 'NOT_IN_LOCAL_EXPORT', 'AMBIGUOUS_CONVERSATION'] as const;

/** Documented in the help; pinned against the SDK's own lists by test/cli/spec.test.ts. */
export const STATS_GROUPS: readonly StatsGroupBy[] = ['role', 'model', 'channel', 'day', 'conversation', 'provider', 'content_type'];

const REF_ARG = {
  name: 'ref',
  description: 'Conversation UUID or an exact https://chatgpt.com/c/<uuid> link. The link is only a key into data you imported; nothing is fetched.',
} as const;

const BRANCH_POLICIES: readonly BranchPolicy[] = ['last_child', 'latest_leaf'];

function branchOptions(): OptionSpec[] {
  return [
    { name: 'branch', kind: 'string', valueName: 'id', description: 'Show this branch (a branch id is the id of its leaf message; list them with "gcr branches").' },
    {
      name: 'branch-policy',
      kind: 'choice',
      valueName: 'policy',
      choices: BRANCH_POLICIES,
      description:
        'Opt in to a labelled heuristic when the export does not say which branch was active: last_child follows the last child from the root, latest_leaf takes the newest leaf. The result carries the warning ACTIVE_BRANCH_HEURISTIC.',
      defaultText: 'none: GCR never guesses the active branch',
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------------------------

const SORTS = { updated: 'updated_desc', created: 'created_desc', title: 'title_asc' } as const;

export const listCommand: CommandSpec = {
  path: ['list'],
  summary: 'List imported conversations.',
  details: ['Shows each conversation once (its newest imported snapshot) with id, title, message count, times and how complete its source is. Titles are untrusted text from your export.'],
  positionals: [],
  options: [
    { name: 'sort', kind: 'choice', valueName: 'order', choices: Object.keys(SORTS), description: 'Order: most recently updated, most recently created, or title A-Z.', defaultText: 'updated' },
    { name: 'title-query', kind: 'string', valueName: 'words', description: 'Only conversations whose title contains these words (full-text, plain mode).' },
    providerOption(),
    accountOption(),
    limitOption(500, 50, 'conversations'),
    offsetOption(),
    allBatchesOption('every stored snapshot is listed'),
  ],
  examples: [
    { command: 'list --limit 20', note: 'The 20 most recently updated conversations, as Markdown.' },
    { command: 'list --provider chatgpt --sort title --format json', note: 'ChatGPT conversations by title, machine-readable.' },
    { command: 'list --title-query roadmap --tz Europe/Berlin', note: 'Titles that mention "roadmap", with times shown in Berlin time.' },
  ],
  errors: [...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const gcr = await ctx.openRead();
    const sort = a.choice<keyof typeof SORTS>('sort');
    const env = gcr.list(
      defined({
        provider: a.string('provider'),
        accountLabel: a.string('account'),
        titleQuery: a.string('title-query'),
        sort: sort === undefined ? undefined : SORTS[sort],
        limit: a.int('limit'),
        offset: a.int('offset'),
        allBatches: a.flag('all-batches') ? true : undefined,
      }),
    );
    emit(ctx, withEnvelopeWarnings(renderConversationList(env.data, env.source, ctx.renderOptions()), ctx.format, env.warnings));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------------------------------------------

export const getCommand: CommandSpec = {
  path: ['get'],
  summary: 'Show one imported conversation (its active thread, or every branch).',
  details: [
    'The active thread is chosen by the export\'s own current-node pointer. If the export has none and the conversation has several branches, GCR refuses to guess (ACTIVE_BRANCH_UNKNOWN) unless you pass --branch, --all-branches or --branch-policy.',
    'A chatgpt.com link succeeds only if that conversation is in your database; otherwise the command fails with NOT_IN_LOCAL_EXPORT. GCR never contacts chatgpt.com.',
    'Every format lists the same warnings as the SDK and the MCP tools; SOURCE_NOT_FULL_HISTORY comes first when the source is a partial copy or a rendered-only export. Messages that no root reaches (a damaged tree) are stored and searchable but cannot be shown here: the warning NO_BRANCHES says so.',
  ],
  positionals: [REF_ARG],
  options: [
    ...branchOptions(),
    { name: 'all-branches', kind: 'boolean', description: 'Also show every other branch (edited prompts, regenerated answers). With --format json the result holds one thread per branch.' },
    includeHiddenOption('messages'),
    batchOption(),
    providerOption(undefined, 'Disambiguate when the id exists under several providers.'),
    accountOption('Disambiguate when the id exists under several accounts.'),
    storedIdOption(),
  ],
  examples: [
    { command: 'get 00000000-0000-4000-8000-000000000001', note: 'Print the conversation as Markdown.' },
    { command: 'get https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 --format json', note: 'Look a link up in your local data and print JSON (fails with NOT_IN_LOCAL_EXPORT if it was never imported).' },
    { command: 'get 00000000-0000-4000-8000-000000000001 --all-branches --format compact', note: 'Every branch in token-light text.' },
    { command: 'get 00000000-0000-4000-8000-000000000001 --branch-policy latest_leaf', note: 'Opt in to the newest-leaf heuristic when the export has no current node.' },
  ],
  errors: [...REF_ERRORS, 'BRANCH_NOT_FOUND', 'ACTIVE_BRANCH_UNKNOWN', 'MESSAGE_NOT_FOUND', ...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const ref = refFromArgs(ctx, first(ctx)); // validated before the database is touched
    const gcr = await ctx.openRead();
    const includeHidden = a.flag('include-hidden');
    const allBranches = a.flag('all-branches');
    const env = gcr.get(
      ref,
      defined({
        branch: a.string('branch'),
        branchPolicy: a.choice<BranchPolicy>('branch-policy'),
        includeHidden: includeHidden ? true : undefined,
        batchId: a.string('batch'),
        allBranches: allBranches ? true : undefined,
      }),
    );
    const ro = ctx.renderOptions({ includeHidden });
    const source = env.source[0];
    const threads = env.data.threads;
    // SPEC-02: the renderer prints only ThreadResult.warnings; the envelope's (SOURCE_NOT_FULL_HISTORY first) are merged in.
    const withEnv = (t: ThreadResult): ThreadResult => ({ ...t, warnings: mergeWarningsByCode(env.warnings, t.warnings) });
    if (allBranches && ctx.format !== 'json' && threads !== undefined && threads.length > 0 && source !== undefined) {
      // One document per branch. JSON is a single document (renderEnvelope below); the text formats are concatenated.
      // Each document stands alone, so each carries the conversation-level warnings.
      const docs = threads.map((t) => renderThread(withEnv(t), source, ro));
      emit(ctx, docs.join(ctx.format === 'jsonl' ? '' : '\n'));
      return;
    }
    if (!allBranches && env.data.thread !== null && source !== undefined) {
      emit(ctx, renderThread(withEnv(env.data.thread), source, ro));
      return;
    }
    // --all-branches as JSON, or nothing to thread (an empty snapshot): the envelope is the faithful answer.
    emit(ctx, renderEnvelope(env, ro));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// thread
// ---------------------------------------------------------------------------------------------------------------

export const threadCommand: CommandSpec = {
  path: ['thread'],
  summary: 'Show one branch of a conversation as a message thread.',
  details: ['Like "gcr get" but always a single thread; use --branch to pick one from "gcr branches". The warnings are the same as in "gcr get": SOURCE_NOT_FULL_HISTORY first for a partial or rendered-only source.'],
  positionals: [REF_ARG],
  options: [
    ...branchOptions(),
    includeHiddenOption('messages'),
    batchOption(),
    providerOption(undefined, 'Disambiguate when the id exists under several providers.'),
    accountOption('Disambiguate when the id exists under several accounts.'),
    storedIdOption(),
  ],
  examples: [
    { command: 'thread 00000000-0000-4000-8000-000000000001', note: 'The active thread of a conversation.' },
    { command: 'thread 00000000-0000-4000-8000-000000000001 --branch 00000000-0000-4000-8000-000000000012', note: 'A specific branch, named by the id of its leaf message.' },
    { command: 'thread 00000000-0000-4000-8000-000000000001 --format jsonl', note: 'One JSON value per line, for streaming tools.' },
  ],
  errors: [...REF_ERRORS, 'BRANCH_NOT_FOUND', 'ACTIVE_BRANCH_UNKNOWN', 'MESSAGE_NOT_FOUND', ...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const ref = refFromArgs(ctx, first(ctx));
    const gcr = await ctx.openRead();
    const includeHidden = a.flag('include-hidden');
    const env = gcr.thread(
      ref,
      defined({
        branch: a.string('branch'),
        branchPolicy: a.choice<BranchPolicy>('branch-policy'),
        includeHidden: includeHidden ? true : undefined,
        batchId: a.string('batch'),
      }),
    );
    const ro = ctx.renderOptions({ includeHidden });
    const source = env.source[0];
    // SPEC-02: same merge as `get` (see mergeWarningsByCode): the CLI must show the warnings the SDK and MCP return.
    const merged: ThreadResult = { ...env.data, warnings: mergeWarningsByCode(env.warnings, env.data.warnings) };
    emit(ctx, source === undefined ? renderEnvelope(env, ro) : renderThread(merged, source, ro));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------------------------------------------

export const branchesCommand: CommandSpec = {
  path: ['branches'],
  summary: 'List the branches of a conversation (edited prompts, regenerated answers).',
  details: ['A branch id is the id of its leaf message; pass it to "gcr thread --branch". The active branch is shown only when the export names it.'],
  positionals: [REF_ARG],
  options: [batchOption(), providerOption(undefined, 'Disambiguate when the id exists under several providers.'), accountOption('Disambiguate when the id exists under several accounts.'), storedIdOption()],
  examples: [
    { command: 'branches 00000000-0000-4000-8000-000000000001', note: 'All branches with their activeness.' },
    { command: 'branches https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 --format json', note: 'The same, looked up by link, as JSON.' },
  ],
  errors: [...REF_ERRORS, ...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const ref = refFromArgs(ctx, first(ctx));
    const gcr = await ctx.openRead();
    const env = gcr.branches(ref, defined({ batchId: ctx.args.string('batch') }));
    const source = env.source[0];
    // The dedicated renderer prints result.warnings; the envelope also carries the importer's stored warnings, so hand it those.
    const data = { ...env.data, warnings: env.warnings };
    emit(ctx, source === undefined ? renderEnvelope(env, ctx.renderOptions()) : renderBranchList(data, source, ctx.renderOptions()));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------------------------

const SEARCH_SCOPES: readonly SearchScope[] = ['messages', 'titles', 'attachments', 'all'];

/** Titles/all results are rendered generically; make the snippet match markers (U+0001 / U+0002) visible text first. */
function plainSnippets(env: ResultEnvelope<Page<SearchItem>>): ResultEnvelope<unknown> {
  const items = env.data.items.map((item) => ({ ...item, snippet: item.snippet.replace(/\u0001/g, '[[').replace(/\u0002/g, ']]') }));
  return { ...env, data: { ...env.data, items } };
}

export const searchCommand: CommandSpec = {
  path: ['search'],
  summary: 'Full-text search over message text, conversation titles and attachment file names.',
  details: [
    'The query is treated as plain words (operators and quotes are inert; a trailing * makes a prefix). Case and accents are ignored and CJK text matches by character. Use --raw to pass SQLite FTS5 syntax through.',
    'Folded when matching: case, accents, character width (fullwidth letters), ligatures (fi) and CJK substrings. Not folded: "ß" is not "ss". Emoji and other symbols are not indexed (only letters, digits and combining marks are), so a query made only of them is refused with INVALID_ARGUMENT: search for words.',
    '--scope attachments matches the file NAMES and MIME types of attachments (metadata only: attachment files are never read and no attachment content is searched, not even the text a Claude export carries inline; a ChatGPT export may not contain the files). Each search word must occur anywhere inside the folded name or type (so "notes", "diagram" and "synthetic-notes.txt" all find synthetic-notes.txt, and "image/png" finds every PNG). Results are not ranked: oldest message first. --scope all lists titles, then messages, then attachments (attachment names are part of "all"); with --raw the attachment part is skipped and ATTACHMENTS_NOT_SEARCHED says so.',
    'Hidden messages (and their attachments) are skipped unless --include-hidden. A query that starts with "-" goes after "--".',
  ],
  positionals: [{ name: 'query', description: 'Words to search for (quote it when it has spaces).' }],
  options: [
    { name: 'raw', kind: 'boolean', description: 'Pass the query to SQLite FTS5 unchanged (AND/OR/NEAR/phrases). A syntax error is FTS_SYNTAX_ERROR.' },
    { name: 'scope', kind: 'choice', valueName: 'scope', choices: SEARCH_SCOPES, description: 'Search message text, conversation titles, attachment file names and MIME types, or all three (titles, then messages, then attachments).', defaultText: 'messages' },
    { name: 'role', kind: 'string', valueName: 'role', description: 'Only messages by this author role (user, assistant, system, tool, ...). Messages and attachments scopes only.' },
    { name: 'channel', kind: 'string', valueName: 'channel', description: 'Only messages on this channel (for example final). Messages and attachments scopes only.' },
    { name: 'has-model', kind: 'boolean', description: 'Only messages whose export states the model explicitly. Messages and attachments scopes only.' },
    { name: 'conversation', kind: 'string', valueName: 'ref', description: 'Only inside this conversation (UUID, chatgpt.com link or stored id). Messages and attachments scopes only.' },
    { name: 'after', kind: 'string', valueName: 'ISO', description: 'Only messages created at or after this ISO-8601 UTC time. Messages and attachments scopes only.' },
    { name: 'before', kind: 'string', valueName: 'ISO', description: 'Only messages created before this ISO-8601 UTC time. Messages and attachments scopes only.' },
    includeHiddenOption('messages'),
    allBatchesOption('the same message can then appear once per snapshot'),
    providerOption(),
    accountOption(),
    limitOption(200, 20, 'hits'),
    offsetOption(),
    cursorOption(),
  ],
  examples: [
    { command: 'search "marsupial habitat"', note: 'Messages containing both words, best match first.' },
    { command: 'search roadmap --scope titles --format json', note: 'Conversation titles that mention "roadmap".' },
    { command: 'search "report pdf" --scope attachments', note: 'Attachments whose file name or type contains both "report" and "pdf" (metadata only).' },
    { command: 'search "quok*" --role assistant --after 2025-01-01T00:00:00Z --limit 5', note: 'Prefix match, assistant messages from 2025 on.' },
    { command: 'search --conversation 00000000-0000-4000-8000-000000000001 -- "-draft"', note: 'Inside one conversation; "--" lets the query start with a dash.' },
  ],
  errors: ['FTS_SYNTAX_ERROR', 'INVALID_URL', 'INVALID_UUID', 'UNSUPPORTED_URL', ...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const query = first(ctx);
    const scope = a.choice<SearchScope>('scope') ?? 'messages';
    const conversation = a.string('conversation');
    const includeHidden = a.flag('include-hidden');
    const base: SearchOptions = {
      query,
      ...defined({
        mode: a.flag('raw') ? ('raw' as const) : undefined,
        provider: a.string('provider'),
        accountLabel: a.string('account'),
        conversationId: conversation === undefined ? undefined : conversationFilterValue(conversation),
        role: a.string('role'),
        channel: a.string('channel'),
        hasModel: a.flag('has-model') ? true : undefined,
        createdAfter: a.string('after'),
        createdBefore: a.string('before'),
        includeHidden: includeHidden ? true : undefined,
        allBatches: a.flag('all-batches') ? true : undefined,
        limit: a.int('limit'),
        offset: a.int('offset'),
        cursor: a.string('cursor'),
      }),
    };
    const gcr = await ctx.openRead();
    const ro = ctx.renderOptions({ includeHidden });
    if (scope === 'messages') {
      const env = gcr.search({ ...base, scope: 'messages' });
      emit(ctx, withEnvelopeWarnings(renderSearchHits(env.data, env.source, { ...ro, query }), ctx.format, env.warnings));
      // The dedicated renderer prints this warning in neither Markdown nor compact (json/jsonl got it above): say it as a note.
      if (ctx.format === 'markdown' || ctx.format === 'compact') {
        for (const w of env.warnings) if (w.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED') ctx.note(w.message);
      }
      return;
    }
    emit(ctx, renderEnvelope(plainSnippets(gcr.search({ ...base, scope })), ro));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------------------------

export const statsCommand: CommandSpec = {
  path: ['stats'],
  summary: 'Count messages by role, model, channel, day, conversation, provider or content type.',
  details: [
    'Models are counted only where the export states one on the message; everything else is the single group "unknown (not supplied by source)". GCR never infers a model from timestamps or conversation defaults.',
    'Grouping by day uses --tz for the day boundaries.',
  ],
  positionals: [],
  options: [
    { name: 'group-by', kind: 'choice', valueName: 'field', choices: STATS_GROUPS, description: 'What to group the message counts by.', defaultText: 'role' },
    providerOption(),
    accountOption(),
    { name: 'role', kind: 'string', valueName: 'role', description: 'Only messages by this author role.' },
    { name: 'after', kind: 'string', valueName: 'ISO', description: 'Only messages created at or after this ISO-8601 UTC time.' },
    { name: 'before', kind: 'string', valueName: 'ISO', description: 'Only messages created before this ISO-8601 UTC time.' },
    includeHiddenOption('messages'),
    allBatchesOption('every snapshot is counted'),
    limitOption(1000, 100, 'groups'),
    offsetOption(),
  ],
  examples: [
    { command: 'stats --group-by role', note: 'How many user, assistant, system and tool messages.' },
    { command: 'stats --group-by model --format json', note: 'Messages per explicitly stated model, plus the "unknown" group.' },
    { command: 'stats --group-by day --tz Asia/Kolkata --after 2025-01-01T00:00:00Z', note: 'Messages per local calendar day since 2025.' },
  ],
  errors: [...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const gcr = await ctx.openRead();
    const groupBy = a.choice<StatsGroupBy>('group-by') ?? 'role';
    const env = gcr.stats({
      groupBy,
      tz: ctx.tz,
      ...defined({
        provider: a.string('provider'),
        accountLabel: a.string('account'),
        role: a.string('role'),
        createdAfter: a.string('after'),
        createdBefore: a.string('before'),
        includeHidden: a.flag('include-hidden') ? true : undefined,
        allBatches: a.flag('all-batches') ? true : undefined,
        limit: a.int('limit'),
        offset: a.int('offset'),
      }),
    });
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------------------------------------------

/** One flag per audit check. Pinned against the SDK's AUDIT_CHECKS by test/cli/spec.test.ts. */
export const AUDIT_FLAGS: ReadonlyArray<{ flag: string; check: AuditCheck; description: string }> = [
  { flag: 'missing-model', check: 'missing_model', description: 'Assistant messages whose export does not state a model.' },
  { flag: 'empty', check: 'empty', description: 'Conversations with no messages.' },
  { flag: 'untitled', check: 'untitled', description: 'Conversations without a title.' },
  { flag: 'tree', check: 'tree_integrity', description: 'Broken message trees: missing parents, cycles, child/parent mismatches.' },
  { flag: 'no-current-node', check: 'no_current_node', description: 'Conversations whose export names no valid active branch.' },
  { flag: 'unknown-roles', check: 'unknown_roles', description: 'Author roles other than user, assistant, system and tool.' },
  { flag: 'unknown-content-types', check: 'unknown_content_types', description: 'Content types GCR has no dedicated handling for.' },
  { flag: 'timestamps', check: 'timestamps', description: 'Missing or implausible timestamps.' },
  { flag: 'hidden', check: 'hidden', description: 'Messages the export marks as hidden.' },
];

const BRANCH_PROVENANCE_NOT_COMPUTED_TEXT = 'not computed (no tree-based check selected: use --tree, --no-current-node or --timestamps)';

export const auditCommand: CommandSpec = {
  path: ['audit'],
  summary: 'Check the imported data for gaps: missing models, empty or untitled conversations, broken trees.',
  details: [
    'Without check flags every check runs; with one or more flags only those do. The report holds counts and sample ids, never message text, and states how many branches have a known active branch and how many assistant messages state a model.',
    'Branch provenance (known and unknown active branches, branch counts) is measured by the tree pass, which runs only when --tree, --no-current-node or --timestamps is selected (or no flag at all). Without them branchProvenance is null ("not computed") and the warning BRANCH_PROVENANCE_NOT_COMPUTED says so; it is never reported as zeros.',
  ],
  positionals: [],
  options: [
    ...AUDIT_FLAGS.map((f): OptionSpec => ({ name: f.flag, kind: 'boolean', description: f.description })),
    providerOption(),
    accountOption(),
    allBatchesOption('every snapshot is audited'),
    { name: 'sample', kind: 'int', valueName: 'n', min: 1, max: 50, description: 'Sample ids listed per finding (1-50).', defaultText: '5' },
  ],
  examples: [
    { command: 'audit', note: 'Run every check.' },
    { command: 'audit --missing-model --untitled --empty', note: 'Only these three checks (no tree check, so branchProvenance is null: not computed).' },
    { command: 'audit --no-current-node --tree --format json', note: 'Branch provenance and tree integrity, machine-readable.' },
  ],
  errors: [...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const gcr = await ctx.openRead();
    const checks = AUDIT_FLAGS.filter((f) => a.flag(f.flag)).map((f) => f.check);
    const env = gcr.audit(
      defined({
        checks: checks.length === 0 ? undefined : checks,
        provider: a.string('provider'),
        accountLabel: a.string('account'),
        allBatches: a.flag('all-batches') ? true : undefined,
        sampleSize: a.int('sample'),
      }),
    );
    // SPEC-07: null is the machine-readable "not measured" (json/jsonl); the generic text renderers would print a bare "null",
    // so the human formats say what it means.
    const human = ctx.format === 'markdown' || ctx.format === 'compact';
    const shown: ResultEnvelope<unknown> = human && env.data.branchProvenance === null ? { ...env, data: { ...env.data, branchProvenance: BRANCH_PROVENANCE_NOT_COMPUTED_TEXT } } : env;
    emit(ctx, renderEnvelope(shown, ctx.renderOptions()));
  },
};

// ---------------------------------------------------------------------------------------------------------------
// batches
// ---------------------------------------------------------------------------------------------------------------

export const batchesCommand: CommandSpec = {
  path: ['batches'],
  summary: 'List the import batches in the database (one per distinct export imported).',
  details: ['Use a batch id with --batch to read an older snapshot. Source file names are shown as basenames only.'],
  positionals: [],
  options: [],
  examples: [
    { command: 'batches', note: 'Every import with its counts, provenance and completeness.' },
    { command: 'batches --format json', note: 'The same, machine-readable.' },
  ],
  errors: [...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const gcr = await ctx.openRead();
    const batches = gcr.listBatches();
    const source = batches.map(toSourceSummary);
    const values = source.map((s) => s.completeness);
    const completeness = overallCompleteness(values);
    // Flat rows (no nested arrays) so the Markdown output is a real table; the per-batch warnings are summarized by count.
    const rows = batches.map((b) => ({
      batchId: b.batchId,
      seq: b.seq,
      provider: b.provider,
      accountLabel: b.accountLabel,
      sourceKind: b.sourceKind,
      sourceLabel: b.sourceLabel,
      provenance: b.provenance,
      completeness: b.completeness,
      importedAt: b.importedAt,
      conversations: b.conversationCount,
      messages: b.messageCount,
      warnings: b.warnings.length,
      toolVersion: b.toolVersion,
    }));
    const env: ResultEnvelope<typeof rows> = {
      ok: true,
      data: rows,
      source,
      completeness,
      warnings: completeness === 'exported_tree' || values.length === 0 ? [] : [notFullHistoryWarning(completeness, values, source)],
      ids: {},
      untrustedContent: true,
    };
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};
