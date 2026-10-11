# GCR TypeScript SDK

The SDK is the `Gcr` class exported from the package root (`src/index.ts`, compiled to `dist/index.js`). The CLI (`gcr`) and the MCP server are thin
adapters over it, so everything they can do you can do from code, with typed results.

* **Offline.** The SDK contains no network code. A `https://chatgpt.com/c/<uuid>` link is only a *key* into conversations you imported from an
  official export; it is never opened (see [NOT_IN_LOCAL_EXPORT](#not_in_local_export)).
* **Provenance on every answer.** Every result is a `ResultEnvelope` that says where the data came from, how complete that source is, what was
  noticed on the way, which ids it cites, and whether it contains imported text that must be treated as data.
* **Typed errors.** Every failure is a `GcrError` with a stable `code`, an actionable `remedy` and content-free `details`.
* **Synchronous reads, asynchronous writes.** Reads return immediately (node:sqlite is synchronous). Mutators (`importExport`, `importManualCopy`,
  `buildGraph`, `createDraft`, `archiveDraft`, `createAnnotation`, `updateAnnotation`) return promises and are serialized by a per-handle writer lock.

Requires the Node version in `package.json` `engines` (currently `>=22.16.0`, the first release whose `node:sqlite` includes FTS5; ADR-0012).
All identifiers below (`00000000-0000-4000-8000-000000000001`) are synthetic.

## Contents

1. [Quick start](#quick-start)
2. [Opening a database](#opening-a-database)
3. [Method reference](#method-reference)
4. [The envelope contract](#the-envelope-contract)
5. [Examples](#examples) (import, list, get by link, search with pagination, branches and threads, stats, graph, drafts)
6. [Branch selection](#branch-selection)
7. [NOT_IN_LOCAL_EXPORT](#not_in_local_export)
8. [Errors and remedies](#errors-and-remedies)
9. [Concurrency, closing and read-only handles](#concurrency-closing-and-read-only-handles)
10. [Public surface and stability](#public-surface-and-stability)
11. [Limitations](#limitations)

## Quick start

```ts
import { Gcr, GcrError } from '@emblem-nlp/chatgpt-conversation-reader';

const gcr = Gcr.open({ dbPath: './gcr.sqlite' }); // creates the file (mode 0600) when it does not exist

// 1. import YOUR official export (never fetched by GCR)
const imported = await gcr.importExport({ source: { kind: 'path', path: './chatgpt-export.zip' } });
console.log(imported.data.conversations.stored, 'conversations stored;', imported.completeness);

// 2. read a conversation by its link (or a bare UUID)
try {
  const got = gcr.get('https://chatgpt.com/c/00000000-0000-4000-8000-000000000001');
  for (const m of got.data.thread?.messages ?? []) console.log(m.authorRole, m.text);
  for (const w of got.warnings) console.warn(w.code, w.message);
} catch (e) {
  if (e instanceof GcrError && e.code === 'NOT_IN_LOCAL_EXPORT') console.error(e.remedy);
  else throw e;
} finally {
  gcr.close();
}
```

## Opening a database

```ts
static Gcr.open(opts: GcrOpenOptions): Gcr
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `dbPath` | `string` | required | database file, or `":memory:"` (read-write only). `file:` URIs and NUL bytes are refused. |
| `readOnly` | `boolean` | `false` | never creates, migrates or writes. A missing file is `DB_NOT_FOUND` with the remedy to run `gcr import`. |
| `create` | `boolean` | `true` unless `readOnly` | `false` makes a missing file `DB_NOT_FOUND`. `readOnly: true` together with `create: true` is `INVALID_ARGUMENT`. |
| `actor` | `"cli" \| "mcp" \| "sdk"` | `"sdk"` | recorded as `created_via` on drafts/annotations and in the append-only audit log. |
| `clock` | `() => string` | real clock | ISO-8601 UTC timestamps for imports and local writes (inject for reproducible output). |

A new file is created with mode `0600` before SQLite touches it. A database written by a newer GCR is refused with `DB_SCHEMA_TOO_NEW`; a SQLite
file that is not a GCR database is refused with `DB_ERROR` (`details.reason: "not_gcr_database"`). Both refusals happen **before** anything is written:
`Gcr.open` first looks at the file read-only, because the read-write open of `db/open.ts` switches the journal mode to WAL (which rewrites header bytes)
before it checks whose file it is. The refused file stays byte-for-byte identical and no side file appears. Unknown option names are `INVALID_ARGUMENT`.

Handle properties: `isOpen`, `readOnly`, `dbLabel` (basename only), `actor`. `close()` is idempotent.

## Method reference

Reads (synchronous, return `ResultEnvelope<...>` unless noted):

| Method | Returns (`data`) | Notes |
|---|---|---|
| `list(opts?)` | `Page<ConversationSummary>` | newest snapshot of each conversation; `allBatches` lists every snapshot |
| `get(ref, opts?)` | `GetResult = { conversation, thread: ThreadResult \| null, threads?: ThreadResult[] }` | `ref` is a bare UUID, an exact link or a `ConversationRef` |
| `getByUrl(url, opts?)` | `GetResult` | `get` for a link only (a bare UUID is `INVALID_URL`) |
| `branches(ref, opts?)` | `BranchListResult` | every branch with `activeness`, tree warnings |
| `thread(ref, opts?)` | `ThreadResult` | one thread, chosen by the [branch rules](#branch-selection) |
| `search(opts)` | `Page<SearchItem>` | scopes `messages` (default), `titles`, `all`; offset or cursor paging |
| `stats(opts)` | `StatsReport` | message statistics + the `FormatProfile`s of batches imported through this handle |
| `audit(opts?)` | `AuditReport` | data-quality and provenance findings (counts and ids only) |
| `listBatches()` | `BatchInfo[]` (not an envelope) | every import batch in import order |
| `graphQuery(q)` | `GraphQueryResult` | neighbourhood of a term |
| `graphPath(from, to, opts?)` | `PathResult` | fewest-hop path between node ids |
| `graphNeighbors(nodeId, opts?)` | `NeighborsResult` | |
| `graphGodNodes(opts?)` | `GodNode[]` | most connected nodes |
| `graphExplain(edge, opts?)` | `ExplainEdgeResult` | citations: message ids **and** branch ids |
| `graphExportHtml(opts?)` / `graphExport(opts?)` | `{ html, nodes, edges }` + provenance (not an envelope) | the SDK writes no files |
| `getDraft(id)`, `listDrafts(filter?)`, `renderDraftMarkdown(id)` | `LocalDraftData` / `LocalDraftListData` / `LocalDraftMarkdownData` | |
| `getAnnotation(id)`, `listAnnotations(filter?)` | `LocalAnnotationData` / `LocalAnnotationListData` | |
| `doctor()` / `Gcr.doctor(opts?)` | `DoctorReport` (not an envelope) | static, offline self-check; the static form needs no handle |

Mutators (asynchronous, serialized):

| Method | Returns (`data`) | Notes |
|---|---|---|
| `importExport(opts)` | `ImportReport` | atomic, idempotent; ZIP, `conversations.json`, shards, directory or byte stream |
| `importManualCopy(text, opts?)` | `ImportReport` | Mode B: always `partial_user_supplied` |
| `buildGraph(opts?)` | `BuildGraphResult` | rebuilds the derived graph tables only |
| `createDraft(input)`, `archiveDraft(id)` | `LocalDraftData` | local only; there is no "sent" state |
| `createAnnotation(input)`, `updateAnnotation(id, patch)` | `LocalAnnotationData` | optimistic concurrency via `expectedVersion` |

A mutator never throws synchronously: it always returns a promise (rejected with `GcrError`).

Option objects are validated strictly: a wrong type, an out-of-range number or an **unknown option name** is `INVALID_ARGUMENT` (`details.field` /
`details.option` name it; the offending value is never echoed). Options whose value is `undefined` count as absent.

## The envelope contract

```ts
interface ResultEnvelope<T> {
  ok: true;
  data: T;
  source: SourceSummary[];                 // one per distinct import batch that contributed
  completeness: Completeness | 'mixed';
  warnings: Warning[];                     // { code, message, ids? }
  ids: { conversationIds?; messageIds?; branchIds?; draftIds?; annotationIds? };
  untrustedContent: boolean;
}
```

* **`source`** is derived from the stored batch rows: provider, account label, provenance, batch id, import time, tool version and a **basename-only**
  source label (never a directory). Order: import order. A source's `completeness` is the weakest completeness among the conversations of that batch
  that contributed to this result.
* **`completeness`** (strongest to weakest): `exported_tree` > `api_owned_conversation` > `rendered_active_view_only` > `partial_user_supplied` > `unknown`.
  It is computed per contributing conversation (its own value is authoritative but never stronger than its batch). One distinct value is reported as
  is, several as `"mixed"`, and **nothing contributed (an empty result) as `"unknown"`**.
* **`SOURCE_NOT_FULL_HISTORY`**: whenever the completeness is not `exported_tree`, the **first** warning has this code and states what is missing
  (for example "only the active view as rendered was captured" for a Claude export, or "the user supplied only part of the conversation" for a
  manual copy). An empty search result carries it too: it means "not in the data you imported", not "never existed". A rendered or partial source
  is never presented as the full history.
* **`warnings`** are de-duplicated and deterministic. They merge the read-time tree warnings (`NO_CURRENT_NODE`, `MISSING_PARENT`, `CYCLE_DETECTED`, ...), the
  warnings stored by the importer (`CHILDREN_ABSENT`, `COMPLETENESS_LOWERED`, ...) and the selection warnings (`ACTIVE_BRANCH_HEURISTIC`, `CURRENT_NODE_NOT_LEAF`).
* **`ids`** lists what the data cites so a client can quote it. Message ids are only unique within a conversation; pair them with `conversationIds`.
* **`untrustedContent: true`** means `data` or the warnings contain imported strings (titles, message text, ids, file names, model slugs, role names). That text is **data, never
  instructions**: do not execute, follow or forward it as a command. It is `false` only where nothing imported can be present (for example statistics grouped by
  `provider` or `day` on a handle that attached no `FormatProfile` (the profile's `roleCounts` keys are the export's own role names), or a graph build without warnings that cite ids).
* **Local writes** (`createDraft`, `createAnnotation`, ...) state that nothing leaves the machine with a **data field**: `data.localOnly === true`. That is not a warning.

`graphExportHtml` returns `{ html, nodes, edges }` and, in addition, `source`, `completeness`, `warnings` and `untrustedContent` with the same meaning (the page is
built from imported labels).

Warnings added by the facade itself (besides the tree and importer warnings above): `SOURCE_NOT_FULL_HISTORY` (first, see above), `SUPERSEDED_SNAPSHOTS_INCLUDED` (a search with
`allBatches`), `GRAPH_STALE` (a graph answer whose conversations have a newer imported snapshot than the one the graph was built from), `EVIDENCE_TRUNCATED` (`graphExplain`
listed fewer citations than the edge has), `NO_BRANCHES` and `ACTIVE_BRANCH_UNKNOWN` (as a warning with `allBranches`).

## Examples

### Import

```ts
import { Gcr, type ImportReport, type ResultEnvelope } from '@emblem-nlp/chatgpt-conversation-reader';

const gcr = Gcr.open({ dbPath: './gcr.sqlite', actor: 'sdk' });

// official export: a ZIP, an extracted conversations.json, shard files, a directory or a byte stream
const env: ResultEnvelope<ImportReport> = await gcr.importExport({
  source: { kind: 'path', path: './chatgpt-export.zip' },
  accountLabel: 'personal', // keeps exports of different accounts apart (default "default")
  strict: false,            // true: any damaged element aborts and NOTHING is stored
  onProgress: (p) => console.error(p.phase, p.file, p.elements), // counts and file names only, never content
});
console.log(env.data.alreadyImported ? 'already imported (no-op)' : 'imported', env.data.batchId);

// manual copy (Mode B): a small JSON document of messages you copied yourself; always flagged partial
const copy = await gcr.importManualCopy(
  JSON.stringify({ conversationId: '00000000-0000-4000-8000-000000000002', messages: [{ role: 'user', text: 'a copied question' }] }),
  { sourceLabel: 'my-copy.json' },
);
console.log(copy.completeness); // "partial_user_supplied"; copy.warnings[0].code === "SOURCE_NOT_FULL_HISTORY"
```

The SDK reads exactly the path (or stream) it is given: it is a library running with your permissions. Restricting which directories an *agent* may import from is the
adapter's job (the MCP server refuses paths outside `GCR_APPROVED_IMPORT_ROOTS` with `IMPORT_PATH_NOT_ALLOWED`). A URL is never an import source (`source.kind` is `"path"` or `"stream"`).

Importing the same input again is an idempotent no-op (`alreadyImported: true`). A newer export of the same conversations becomes the default (head)
snapshot; older snapshots are kept and can be read with `batchId`.

### List

```ts
const page = gcr.list({ limit: 20, sort: 'updated_desc' });
for (const c of page.data.items) console.log(c.conversationId, c.title, c.messageCount, c.completeness);
console.log(page.data.total, page.data.nextOffset);           // page.untrustedContent === true (titles)
const work = gcr.list({ accountLabel: 'work', titleQuery: 'roadmap' });
```

### Get by link

```ts
import type { ConversationRef } from '@emblem-nlp/chatgpt-conversation-reader';

gcr.get('00000000-0000-4000-8000-000000000001');                                  // bare UUID
gcr.get('https://chatgpt.com/c/00000000-0000-4000-8000-000000000001?utm=x#top');   // exact link (query/fragment ignored)
gcr.getByUrl('https://chatgpt.com/c/00000000-0000-4000-8000-000000000001');        // link only
const ref: ConversationRef = { conversationId: '00000000-0000-4000-8000-000000000001', provider: 'chatgpt', accountLabel: 'work' };
const env = gcr.get(ref, { includeHidden: true, batchId: undefined });             // object reference (any id string)

const { conversation, thread } = env.data;
// thread.messages: root -> leaf, structural nodes never included, hidden ones only with includeHidden (omittedHidden counts them)
// thread.selectionPolicy / thread.activeness say HOW the branch was chosen
```

String references must be a bare UUID or an exact `https://chatgpt.com/c/<uuid>` link. Share links (`/share/...`), other hosts, `http:`, ports, userinfo and extra path
segments are `UNSUPPORTED_URL`; malformed text is `INVALID_URL` / `INVALID_UUID`. A link implies provider `chatgpt`.

An object reference may carry a link as its `conversationId` (`{ conversationId: 'https://chatgpt.com/c/<uuid>' }`): text that starts with `http:` or `https:` is read exactly
like the string form (same URL errors, provider `chatgpt`; combining it with another `provider` is `INVALID_ARGUMENT`) and is reduced to the bare id at once, so a query string
or fragment is never looked up or echoed. Any other text, even with a colon (`"col:quokka"`), is a raw stored id.

`get` options: `branch`, `branchPolicy`, `allBranches`, `includeHidden`, `includeRaw` (keep `rawSource` on messages; off by default), `batchId`.

### Search with pagination

```ts
// messages (default scope); results are ranked, ties are broken deterministically
let cursor: string | null | undefined;
do {
  const env = gcr.search({ query: 'marsupial', limit: 20, ...(cursor ? { cursor } : {}) });
  for (const hit of env.data.items) console.log(hit.conversationId, hit.messageId, hit.snippet); // item.kind === 'message'
  cursor = env.data.nextCursor;                           // keyset cursor: no repeat or skip even across many pages
} while (cursor);

// offset paging works too
const page2 = gcr.search({ query: 'marsupial', limit: 20, offset: 20 });

// titles, or titles first and then messages (every item carries `kind` so you can tell which is which)
const titles = gcr.search({ query: 'roadmap', scope: 'titles' });   // Page<TitleSearchItem>
const both = gcr.search({ query: 'roadmap', scope: 'all', limit: 50 });
for (const item of both.data.items) item.kind === 'title' ? console.log('title', item.title) : console.log('message', item.snippet);

// filters (message scope only): provider, accountLabel, conversationId (UUID or link), role, channel, hasModel, createdAfter, createdBefore, includeHidden
// a chatgpt.com link as conversationId matches ChatGPT conversations only (a Claude conversation with the same id is not a hit); a bare UUID names no provider
gcr.search({ query: 'quokka', role: 'assistant', createdAfter: '2025-01-01T00:00:00Z' });
```

`mode: "plain"` (default) treats the query as words: operators and quotes are inert. `mode: "raw"` passes FTS5 syntax through (`FTS_SYNTAX_ERROR` on a syntax error).
Snippets are plain text; match boundaries are the control characters U+0001/U+0002 (renderers translate them, never raw HTML). Message-only filters combined with
scope `titles` or `all` are `INVALID_ARGUMENT` instead of being silently ignored. For `all`, `offset + limit` may not exceed 10 000.

### Branches and threads

```ts
const b = gcr.branches('00000000-0000-4000-8000-000000000001');
console.log(b.data.activeBranchId, b.data.branches.map((x) => [x.branchId, x.activeness]));

const t = gcr.thread('00000000-0000-4000-8000-000000000001');          // active branch (see Branch selection)
const other = gcr.thread('00000000-0000-4000-8000-000000000001', { branch: b.data.branches[0]!.branchId });
const all = gcr.get('00000000-0000-4000-8000-000000000001', { allBranches: true }); // all.data.threads: one per branch, in branch order
```

### Stats and audit

```ts
const s = gcr.stats({ groupBy: 'model', createdAfter: '2025-01-01T00:00:00Z', limit: 50 });
// models are counted only where the source stated one: everything else is the single "unknown (not supplied by source)" group
for (const row of s.data.rows) console.log(row.label, row.messages, row.conversations);
console.log(s.data.formatProfiles); // FormatProfiles of batches imported through THIS handle (not stored in the database)

const a = gcr.audit({ checks: ['missing_model', 'untitled', 'no_current_node'] });
for (const f of a.data.findings) console.log(f.check, f.severity, f.count, f.sampleConversationIds);
```

### Graph

```ts
const built = await gcr.buildGraph({ minEntityConversations: 2 });       // derived tables only; imported data is never touched
const q = gcr.graphQuery({ term: 'quokka', depth: 2, maxNodes: 100 });
const convs = q.data.nodes.filter((n) => n.kind === 'conversation');
if (convs.length >= 2) console.log(gcr.graphPath(convs[0]!.id, convs[1]!.id).data.path.map((n) => n.label));
console.log(gcr.graphGodNodes({ limit: 5 }).data.map((g) => g.node.label));

// every graph fact traces to messages and branches
const edge = q.data.edges[0];
if (edge) {
  const why = gcr.graphExplain({ edgeId: edge.id });
  for (const ev of why.data.evidence) console.log(ev.conversationId, ev.messageId, ev.branchIds);
}

const page = gcr.graphExportHtml({ term: 'quokka', title: 'Quokka graph' }); // { html, nodes, edges, ...provenance }
// write page.html yourself (the SDK writes no files); the page is self-contained and loads nothing from the network
```

Graph answers cite the snapshots the graph was **built from**: every edge's evidence rows name the batch of the message they cite, so `source` and `completeness` come from those
batches (a graph built for one provider is not marked "mixed" because another provider's export is also in the database). The graph is a derived artifact: after a newer export
supersedes a conversation, answers still cite the older batch and carry the warning `GRAPH_STALE` (ids = the superseded conversations) until `buildGraph` is run again.
`graphExplain` also warns `EVIDENCE_TRUNCATED` when `limit` cut the citations short (`data.evidenceTotal` has the full number).

### Drafts and annotations (local only)

```ts
const draft = await gcr.createDraft({
  conversationRef: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001',
  anchorMessageId: 'optional-message-id',
  title: 'Reply idea',
  body: 'Thanks, that answers it.',
});
console.log(draft.data.localOnly);                               // true
console.log(draft.data.draft.manualContinuation.url);            // a link for YOU to open and paste into; GCR never sends anything
console.log(gcr.renderDraftMarkdown(draft.data.draft.draftId).data.markdown);

const note = await gcr.createAnnotation({ conversationRef: '00000000-0000-4000-8000-000000000001', body: 'check this later' });
await gcr.updateAnnotation(note.data.annotation.annotationId, { body: 'checked', expectedVersion: note.data.annotation.version }); // ANNOTATION_CONFLICT on a stale version
await gcr.archiveDraft(draft.data.draft.draftId);                // idempotent; statuses are only "draft" and "archived"
gcr.listDrafts({ conversationRef: '00000000-0000-4000-8000-000000000001', status: 'draft' });
```

Drafts and annotations live in separate tables, survive re-imports, never change imported conversations, and every change is written to an append-only audit log
(ids, sizes and hash prefixes only, never text) with the handle's `actor`.

### Doctor

```ts
const report = Gcr.doctor({ dbPath: './gcr.sqlite' }); // no handle needed; reads nothing but the database header
console.log(report.ok, report.problems);
console.log(report.modes.map((m) => `${m.mode}: ${m.status}`)); // modes A-E, stated honestly
console.log(report.statement); // "Commands never fall back to remote browser access."
```

Inspecting a file creates and writes nothing, not even SQLite's `-wal` / `-shm` side files (a database nobody else is using is opened `immutable`; one with a live WAL is read normally).

The report lists the tool and Node versions, whether Node satisfies `engines`, `node:sqlite` and FTS5 availability, the supported schema version, the database path
status (`ok`, `missing`, `needs_migration`, `newer_than_tool`, `not_a_gcr_database`, ...), which environment knobs (`GCR_DB`, `GCR_APPROVED_IMPORT_ROOTS`) are
present (never their values) and the capability modes. Paths are reduced to basenames. It performs no network access and never creates or writes a file.

FTS5 is probed on a throw-away in-memory database. When it is missing the report says so ("FTS5 is missing from this Node build's SQLite ... upgrade to Node >= 22.16.0"; `node:sqlite` in
Node 22.13 to 22.15 is built without it), and an inspected database then gets `schemaStatus: "unsupported_runtime"` instead of a schema verdict, because the same condition makes
`Gcr.open` fail with `DB_ERROR` and `details.reason: "FTS5_UNAVAILABLE"` for every file.

| Mode | Status reported by `report.modes` |
|---|---|
| A - official export | supported (synthetic-fixture tested; no live export verified) |
| B - manual copy | supported (manual copy, partial) |
| C - local write | supported (local drafts/annotations only) |
| D - OpenAI developer API | not implemented (interface + disabled adapter only) |
| E - browser interaction | gated - no code (docs/BROWSER_GATE.md) |

`report.statement` is the sentence "Commands never fall back to remote browser access.".

## Branch selection

The active branch is **never guessed** (ADR-0009). Precedence for the primary thread of `get` / `thread`:

| # | Rule | `selectionPolicy` | Result |
|---|---|---|---|
| 1 | explicit `branch` id | `explicit_branch` | that branch; unknown id: `BRANCH_NOT_FOUND` (details: `branchCount`) |
| 2 | the export's own `current_node` | `source_current_node` | the branch of that node. If the node is not a leaf, the thread runs root to that node, `activeness` is `contains_current_node` and the warning `CURRENT_NODE_NOT_LEAF` is added |
| 3 | exactly one branch in the tree | `only_branch` | that branch (nothing to choose; `activeness` stays `unknown` if the export gave no pointer) |
| 4 | `branchPolicy: "last_child" \| "latest_leaf"` | `last_child` / `latest_leaf` | an explicit heuristic; **always** with the warning `ACTIVE_BRANCH_HEURISTIC` |
| 5 | otherwise | | `ACTIVE_BRANCH_UNKNOWN` (details: `branchCount`, `branchIds`) |

* `last_child` follows the last child from the first root; `latest_leaf` takes the leaf with the newest timestamp (no timestamps: `ACTIVE_BRANCH_UNKNOWN`, `details.reason:
  "heuristic_unavailable"`). A valid `current_node` always wins over a `branchPolicy`.
* If the source's `current_node` is valid but the tree has more branches than are enumerated (10 000, `BRANCH_LIMIT_EXCEEDED`) and its branch is not among them, the active branch is
  known but cannot be listed: `get` / `thread` throw `ACTIVE_BRANCH_UNKNOWN` with `details.reason: "active_branch_not_enumerated"` (the message says so; it does not claim the source gave no
  pointer) and **no** `branchPolicy` is applied, because a heuristic would overrule a pointer the source gave. An enumerated branch can still be chosen with `branch`.
* `allBranches: true` on `get` also returns one `ThreadResult` per branch. Then `thread` is `null` (with an `ACTIVE_BRANCH_UNKNOWN` *warning*, no error) when
  rule 5 would apply. Entries of `threads` have `selectionPolicy: "explicit_branch"` (you asked for all of them).
* A snapshot with no messages: `get` returns `thread: null` and the warning `NO_BRANCHES`; `thread` throws `BRANCH_NOT_FOUND` (`details.reason: "no_branches"`).
* Exports without `children` lists (reported for recent exports) are handled: children are derived from parent pointers and `CHILDREN_ABSENT` is reported.

## NOT_IN_LOCAL_EXPORT

`get`, `getByUrl`, `thread`, `branches`, `createDraft` and `createAnnotation` look a conversation up **only in the local database**. If the id is not there they throw:

```json
{
  "ok": false,
  "error": {
    "code": "NOT_IN_LOCAL_EXPORT",
    "message": "The conversation is not present in the locally imported data.",
    "remedy": "This conversation is not in the data you imported. GCR cannot fetch chatgpt.com conversations. Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>",
    "details": { "conversationId": "00000000-0000-4000-8000-000000000001", "provider": "chatgpt" }
  },
  "warnings": []
}
```

Why: a `chatgpt.com/c/<uuid>` link is a private consumer link, not an API resource. GCR does not call ChatGPT, read browser cookies, scrape pages or replay sessions, and it
never falls back to doing so. The only supported source of ChatGPT history is the export you request yourself (Settings, Data controls, Export data) and import with
`gcr import`. There is no guessed or placeholder content in this case, `details.provider` is present only when the link implied one, and the link itself (query string,
fragment) is never echoed. An unknown batch id (`batchId`) is reported the same way with `details.reason: "unknown_batch"`.

## Errors and remedies

Every failure is a `GcrError` (`instanceof Error`): `code`, `message` (never contains conversation content, credentials or absolute paths), `remedy`, `details`, `warnings`,
`exitCode` and `toEnvelope()` (the JSON error envelope `{ ok: false, error, warnings }`). Unknown failures are `INTERNAL_ERROR` with a generic message; the original error is kept
as `cause` for `GCR_DEBUG=1` diagnostics only. SQLite errors keep their mapped codes (`DB_ERROR`, `WRITE_FORBIDDEN`, ...).

```ts
import { GcrError, isGcrError } from '@emblem-nlp/chatgpt-conversation-reader';
try { gcr.get(someReference); } catch (e) {
  if (isGcrError(e)) process.exitCode = e.exitCode, console.error(JSON.stringify(e.toEnvelope()));
  else throw e;
}
```

| Code | Exit | When the SDK raises it | Remedy |
|---|---|---|---|
| INVALID_ARGUMENT | 2 | wrong type or range, unknown option, malformed reference object, empty search query, bad cursor | fix the call; `details.field` / `details.option` name the argument |
| INVALID_URL | 2 | a link that is not a well-formed canonical https URL (no host, control characters, percent-encoding, over 2048 characters) | use `https://chatgpt.com/c/<uuid>` or a bare UUID |
| INVALID_UUID | 2 | a string reference that is not a UUID, or a link whose id is not a UUID | use a UUID from the link or from `list` |
| UNSUPPORTED_URL | 2 | share links, other hosts (`www.`, `chat.openai.com`), `http:`, userinfo, ports, extra path segments | only `https://chatgpt.com/c/<uuid>` is accepted |
| NOT_IN_LOCAL_EXPORT | 3 | the conversation (or batch, or graph node) is not in the local data | request your official export and `gcr import` it (see above) |
| BRANCH_NOT_FOUND | 3 | unknown branch id; a snapshot with no branches | list branches with `branches()` and pass one of the ids |
| MESSAGE_NOT_FOUND | 3 | a draft/annotation anchor message that is not in the conversation | use a message id from `get` |
| AMBIGUOUS_CONVERSATION | 3 | the id exists under several provider/account pairs (`details.candidates`) | pass `{ conversationId, provider, accountLabel }` |
| ACTIVE_BRANCH_UNKNOWN | 3 | no valid `current_node`, several branches, no explicit choice (or the valid `current_node` lies beyond the branch enumeration limit: `details.reason: "active_branch_not_enumerated"`) | pass `branch`, or opt in to `branchPolicy` (labelled heuristic; not applied when the source's pointer exists) |
| IMPORT_INPUT_NOT_FOUND | 4 | the import path does not exist | check the path |
| IMPORT_UNSUPPORTED_FORMAT | 4 | not an official export, mixed providers in one import | import each provider separately; check the file |
| IMPORT_ZIP_UNSAFE | 4 | unsafe archive (path traversal, symlink, encryption, duplicate names, bad structure) | request a fresh export; GCR refuses to extract it |
| IMPORT_LIMIT_EXCEEDED | 4 | size, entry-count or decompression-ratio limit | split the input or raise `limits` deliberately |
| IMPORT_PARSE_ERROR | 4 | invalid JSON or document shape (also a manual-copy document); every error under `strict` | fix the document or re-run without `strict` |
| IMPORT_PATH_NOT_ALLOWED | 4 | path outside the approved roots (raised by the MCP adapter, not by the SDK) | set `GCR_APPROVED_IMPORT_ROOTS` |
| DB_NOT_FOUND | 5 | a read-only/`create: false` open of a missing file, or a missing directory | run `gcr import <export.zip> --db <path>` |
| DB_SCHEMA_TOO_NEW | 5 | the file was written by a newer GCR | upgrade GCR or use another file |
| DB_MIGRATION_FAILED | 5 | a schema migration failed and was rolled back | report it without private data |
| DB_ERROR | 5 | any other database failure; `details.reason`: `closed`, `write_in_progress`, `busy`, `corrupt`, `not_gcr_database`, `needs_migration`, `FTS5_UNAVAILABLE` (Node older than 22.16.0), `constraint`, ... | follow the `remedy` of the specific reason |
| FTS_SYNTAX_ERROR | 2 | `mode: "raw"` with an invalid FTS5 expression | use plain mode or fix the expression |
| WRITE_FORBIDDEN | 6 | a mutator on a read-only handle | open the database without `readOnly` |
| DRAFT_NOT_FOUND | 3 | unknown draft id | list drafts |
| ANNOTATION_NOT_FOUND | 3 | unknown annotation id | list annotations |
| ANNOTATION_CONFLICT | 6 | `expectedVersion` does not match (`details.currentVersion`) | re-read, merge, retry with the new version |
| NOT_IMPLEMENTED | 7 | the developer-API adapter (Mode D) was requested | it is a disabled interface; import an export instead |
| FEATURE_GATED | 7 | reserved for gated features (browser interaction); never raised by the SDK | see `docs/BROWSER_GATE.md` |
| REMOTE_ACCESS_FORBIDDEN | 7 | reserved; the SDK has no code path that could reach a consumer endpoint | not applicable |
| INTERNAL_ERROR | 1 | an unexpected failure (also a throwing caller callback or clock) | re-run with `GCR_DEBUG=1` and report without private data |

## Concurrency, closing and read-only handles

* **Writer lock.** Every mutator of one handle runs after the previous one has settled, so `Promise.all([gcr.importExport(a), gcr.importExport(b), gcr.createDraft(c)])` runs
  them one after another in call order. They never interleave, never meet `SQLITE_BUSY`, and a failing mutator does not block the ones queued behind it.
* **Reads during a write.** While a mutator is *running* (an import awaits file reads between its statements) the connection holds an open write transaction, and a read
  would see uncommitted rows. Reads therefore throw `DB_ERROR` with `details.reason: "write_in_progress"`; await the write and retry. (Reads issued before the write starts, or after it
  settles, are unaffected.)
* **Several handles.** Handles are independent connections. Two handles writing to one file contend through SQLite's own lock (5 s busy timeout, then `DB_ERROR` `busy`); use one writer.
* **`close()`** is idempotent. A mutator that is running finishes first; mutators still queued reject with `DB_ERROR` (`reason: "closed"`). Every method after `close()` fails with that error.
* **Read-only handles** (`readOnly: true`) never create the database, migrate it or write to it (SQLite itself may add the `-wal` / `-shm` side files of a WAL database, see Limitations): every mutator rejects with `WRITE_FORBIDDEN`; reads (including existing drafts) work.

## Public surface and stability

`src/index.ts` is the stable surface; nothing else is importable from the package. Runtime exports: `Gcr`, `GcrError`, `isGcrError`, `ERROR_CODES`, `EXIT_CODES`, `TOOL_NAME`, `TOOL_VERSION`,
`SCHEMA_VERSION`, `SOURCE_NOT_FULL_HISTORY`, `STATS_GROUP_BY`, `AUDIT_CHECKS`, `parseChatGptUrl`, `parseConversationRef`, `runDoctor`, and the renderers `renderThread`,
`renderConversationList`, `renderSearchHits`, `renderBranchList`, `renderImportReport`, `renderEnvelope` (with `RenderOptions`). Everything else is a type: the domain model
(`ConversationRecord`, `MessageRecord`, `Branch`, `Completeness`, ...), the result shapes (`ResultEnvelope`, `Page`, `ConversationSummary`, `ThreadResult`, `SearchHit`, `BatchInfo`,
`ImportReport`, `FormatProfile`, ...), the option and result types of stats, audit, graph and drafts, `ImportOptions`, `AdapterId`, `ErrorCode`, `ErrorEnvelope` and `Warning`.

The sorted list of runtime export names is pinned by `test/sdk/exports.test.ts`; adding or removing one is a deliberate API change that updates that test and this page.

## Limitations

* **No live verification.** Everything is tested against synthetic exports; no real ChatGPT export has been verified (doctor mode A says so).
* **Format profiles are not persisted.** `stats` / `audit` include the `FormatProfile` only for batches imported through the same handle.
* **The graph records no build scope or time.** Provenance is derived from the evidence rows (which snapshot each citation came from), so a superseded graph is detected (`GRAPH_STALE`), but
  conversations imported **after** a build that the graph never saw are not reported, and a graph built for a scope (`provider` / `accountLabel`) is not distinguishable from a complete one.
* **Read-only handles and WAL side files.** A read-only open of a WAL-mode database makes SQLite create `-wal` and `-shm` next to it (the database file itself is never written, and such a
  handle needs a directory in which those two files can be created). This comes from `db/open.ts`, not from the SDK.
* **Large conversations** are loaded whole to compute branches (memory is proportional to the largest conversation). Branch enumeration is capped (10 000 branches); the
  `BRANCH_LIMIT_EXCEEDED` warning says so and `ACTIVE_BRANCH_UNKNOWN` / `BRANCH_NOT_FOUND` explain skipped leaves.
* **Search scope `all`** concatenates title hits and message hits (their rankings are not comparable) and bounds `offset + limit` to 10 000; use scope `messages` with a cursor for deep paging.
* **Argument errors of mutators** (a hostile getter or Proxy in an options object, a wrong type) are checked before the writer lock and reject with a `GcrError`; the options that were
  validated are the ones used.
* **Mutators are asynchronous** and reads are refused while one is running (see above); a long import therefore blocks reads on that handle. Use a second read-only handle for reads
  during a long import (committed data only).
