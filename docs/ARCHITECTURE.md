# GCR architecture and module contracts

Status: normative for implementers. Source of truth for behaviour is `SPEC.md`; for hard boundaries `AGENTS.md`
and `docs/SECURITY_AND_BOUNDARIES.md`. Shared types live in `src/domain/types.ts`, error codes in `src/errors.ts`.

## 1. Layering (no upward imports)

```
cli/  mcp/                 thin adapters: parse args / tool input, call sdk/, render output
  └── sdk/gcr.ts           `Gcr` facade: the stable typed API. All business operations live below it.
        ├── ingest/        zip.ts, json-stream.ts, adapters (chatgpt, claude, openai-api), import-runner.ts
        ├── db/            schema.ts, open.ts, repo.ts, search.ts
        ├── analysis/      stats.ts, audit.ts
        ├── entities/      extract.ts
        ├── graph/         build.ts, query.ts, cluster.ts, export-html.ts
        ├── drafts/        drafts.ts (local drafts, annotations, audit log)
        ├── format/        render.ts (markdown/json/compact/jsonl, timezone)
        └── domain/        types.ts, ids.ts, validate.ts, branches.ts  (pure, no I/O)
errors.ts, version.ts, logger.ts: leaf modules usable everywhere.
```

* Node >= 22.16.0 (the first Node 22 whose bundled SQLite has FTS5; see ADR-0012), ESM + NodeNext, TypeScript strict. Runtime deps: `@modelcontextprotocol/sdk`, `zod` only.
  SQLite is `node:sqlite` (`DatabaseSync`, FTS5 verified available). ZIP/JSON streaming are hand-written
  (`node:zlib`, `node:fs`) so every limit is explicit. GCR contains no network code at all (no `http`/`https`/`fetch`/`net` imports); a test enforces this.
* Relative imports use the `.js` extension (`import { x } from './y.js'`). Named exports only. `import type` for types.
* `console.*` is forbidden outside `cli/` output code. Diagnostics go through `logger.ts` (stderr only, never content).
* Comment security-sensitive logic and tricky transforms (ZIP validation, branch traversal, FTS query building).

## 2. Identity, provenance, merge semantics

* **Account scope**: `account_label` (operator-chosen at import, default `default`) keeps exports of different
  accounts/providers apart. Duplicate conversation/message ids across providers or accounts never collide.
* **Source batch**: one *logical* import = one `source_batches` row. `batch_id = 'b_' + sha256_hex(provider \0 account_label \0 content_digest).slice(0,32)`
  where `content_digest` is the sha256 over the sorted lines `"<entry name>\t<sha256 of uncompressed bytes>"` of the
  conversation files that were actually read (so re-zipping identical data yields the same batch; a different export,
  even of the same conversations, is a new batch).
* **Message identity**: `(provider, account_label, conversation_id, message_id, source_batch)` per SPEC §5.
  Re-importing identical input is a no-op (`INSERT ... ON CONFLICT DO NOTHING`), giving equal content and counts (FR-10).
* **Head batch**: for each `(provider, account_label, conversation_id)` the *head* is the batch with the greatest
  conversation `updated_at` (NULLs sort lowest), ties broken by the greatest `source_batches.seq`. `conversation_heads`
  holds it. All read APIs default to the head batch; `batchId` pins another snapshot. Older snapshots are retained
  (immutable provenance) and are excluded from default search results.
* Imported rows (`conversations`, `messages`, `source_batches`) are **immutable**; triggers abort UPDATE/DELETE on
  them except via the import path (which only inserts). Local data (`local_*`) lives in separate tables and survives re-imports.

## 3. SQLite schema v1 (authoritative DDL lives in `src/db/schema.ts`; this is the contract)

`PRAGMA user_version = 1`; `gcr_meta(key, value)` mirrors it. `PRAGMA foreign_keys = ON`, `journal_mode = WAL`,
`busy_timeout = 5000`, `trusted_schema = OFF`. All tables `STRICT`. **All SQL uses bound parameters** (`prepare(...).run/get/all(...)`);
string-built SQL is limited to static identifiers chosen from allow-lists.

```sql
CREATE TABLE gcr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE source_batches (
  batch_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,                 -- monotonically increasing import order
  provider TEXT NOT NULL, account_label TEXT NOT NULL,
  provenance TEXT NOT NULL, completeness TEXT NOT NULL,
  source_kind TEXT NOT NULL,                   -- 'zip' | 'conversations_json' | 'conversation_shards' | 'stdin_json'
  source_label TEXT,                           -- basename only
  input_sha256 TEXT NOT NULL,                  -- content_digest above
  imported_at TEXT NOT NULL,                   -- first import time; unchanged by idempotent re-imports
  tool_version TEXT NOT NULL, schema_version INTEGER NOT NULL,
  conversation_count INTEGER NOT NULL, message_count INTEGER NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE conversations (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  title TEXT, source_uri TEXT,
  provenance TEXT NOT NULL, completeness TEXT NOT NULL, imported_at TEXT NOT NULL,
  created_at TEXT, updated_at TEXT,
  current_node_id TEXT, default_model_slug TEXT,
  message_count INTEGER NOT NULL,
  raw_metadata_json TEXT, warnings_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (provider, account_label, conversation_id, source_batch)
) STRICT;

CREATE TABLE messages (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL, source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  ordinal INTEGER NOT NULL,
  parent_id TEXT, child_ids_json TEXT NOT NULL DEFAULT '[]',
  node_kind TEXT NOT NULL CHECK (node_kind IN ('message','structural_empty')),
  author_role TEXT NOT NULL, author_name TEXT,
  model_slug TEXT, channel TEXT, recipient TEXT, content_type TEXT, status TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  created_at TEXT, updated_at TEXT,
  text TEXT NOT NULL, blocks_json TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
  raw_source_json TEXT,
  PRIMARY KEY (provider, account_label, conversation_id, message_id, source_batch)
) STRICT;
CREATE INDEX messages_parent ON messages(provider, account_label, conversation_id, source_batch, parent_id);
CREATE INDEX messages_created ON messages(created_at);
CREATE INDEX messages_role ON messages(author_role);

CREATE TABLE conversation_heads (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  PRIMARY KEY (provider, account_label, conversation_id)
) STRICT;

-- FTS5 (DESIGN DELEGATED to src/db/schema.ts within the constraints below; the final DDL is recorded here by the lead after review):
--   * Because imported rows are immutable, the index only ever needs INSERT, maintained in the same transaction as the message insert
--     (in code or triggers - implementer's choice). DELETE/UPDATE of imported rows is aborted by triggers.
--   * MUST support: case- and diacritic-insensitive Latin/Cyrillic/Greek ("cafe" finds "Café"); CJK substring search of 1+ characters
--     (stock unicode61 treats an unbroken CJK run as ONE token, so "日本語" would NOT match inside "これは日本語のテスト" - this must be handled,
--     e.g. by per-character tokenization of CJK ranges in an indexed `search_text` representation, using the same transform for queries);
--     prefix queries; phrase queries; Unicode normalization (NFKC) of both text and query; titles searchable too.
--   * Snippets/excerpts must come from the ORIGINAL text (not a transformed copy) so CJK is not shown space-separated.
--   * Index size must stay within ~3x the raw text size; document the measured ratio in docs/PERFORMANCE.md.
-- Immutability triggers: *_no_update / *_no_delete on source_batches, conversations, messages -> RAISE(ABORT, 'imported data is immutable').
--   (Deleting a whole batch is a deliberate future maintenance command, not part of v1.)

-- Local (writable) data: separate from imported originals, never transmitted anywhere.
CREATE TABLE local_drafts (
  draft_id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  anchor_message_id TEXT,
  title TEXT, body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','archived')),   -- there is deliberately NO 'sent' state
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_via TEXT NOT NULL    -- 'cli'|'mcp'|'sdk'
) STRICT;
CREATE TABLE local_annotations (
  annotation_id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT,                                -- NULL = conversation-level
  kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,             -- optimistic concurrency
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_via TEXT NOT NULL
) STRICT;
CREATE TABLE local_audit_log (                    -- append-only (UPDATE/DELETE aborted by triggers)
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL,   -- actor: 'cli'|'mcp'|'sdk'
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'        -- ids/hashes/counts only, never body text
) STRICT;

-- Derived artifacts (rebuilt by `gcr graph build`; safe to DROP and recreate):
CREATE TABLE entities (entity_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, normalized TEXT NOT NULL, UNIQUE(kind, normalized)) STRICT;
CREATE TABLE entity_mentions (entity_id INTEGER NOT NULL REFERENCES entities(entity_id), provider TEXT NOT NULL, account_label TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, source_batch TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (entity_id, provider, account_label, conversation_id, message_id, source_batch)) STRICT;
CREATE TABLE graph_nodes (node_id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, ref TEXT, weight REAL NOT NULL DEFAULT 1, community_id INTEGER) STRICT;
CREATE TABLE graph_edges (edge_id INTEGER PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
  UNIQUE(src, dst, kind)) STRICT;
CREATE TABLE graph_edge_evidence (edge_id INTEGER NOT NULL REFERENCES graph_edges(edge_id), provider TEXT NOT NULL, account_label TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT, source_batch TEXT NOT NULL) STRICT;   -- every graph fact traces to message ids; branch ids resolved on demand
CREATE TABLE graph_communities (community_id INTEGER PRIMARY KEY, size INTEGER NOT NULL, label TEXT) STRICT;
```

### Migrations
`src/db/schema.ts` exports `MIGRATIONS: ReadonlyArray<{version:number; name:string; up:(db)=>void}>`. `applyMigrations(db)`:
reads `PRAGMA user_version`; refuses (`DB_SCHEMA_TOO_NEW`) when the file is newer than this tool; applies pending migrations in
one `BEGIN IMMEDIATE` transaction each; failure rolls back and throws `DB_MIGRATION_FAILED`. Opening a brand-new file creates v1.
Migrations must be backward compatible or explicitly versioned (SPEC §5).

## 4. Domain rules (`src/domain/*`, pure)

* `ids.ts`: `parseChatGptUrl(input)` accepts exactly `https://chatgpt.com/c/<uuid>` (optional trailing `/`, query, fragment; host
  case-insensitive; `www.` and `chat.openai.com` are NOT accepted unless listed in docs/DECISIONS.md) and returns the lower-cased UUID. Rejects
  `/share/`, `/g/.../c/`, other hosts, `http:`, userinfo, ports, malformed UUIDs with `UNSUPPORTED_URL`/`INVALID_URL`/`INVALID_UUID`.
  `parseConversationRef(input)` accepts a bare UUID or such a URL. Never performs network access.
* `branches.ts` (`analyzeTree`): cycle-safe, iterative (no recursion depth limits), deterministic. Roots = nodes with `parentId`
  null or pointing to a missing node (missing => warning `MISSING_PARENT`, node still treated as a root). Declared-vs-actual child
  mismatches => `CHILD_PARENT_MISMATCH`. Cycles => `CYCLE_DETECTED` (nodes in a cycle with no root are `unreachableIds`). Duplicate ids can't
  occur within one record set (the adapter dedups with `DUPLICATE_NODE_ID` warning). Branch ids are leaf ids. Ordering of children follows
  the declared `childIds` order when consistent, otherwise `(createdAt, ordinal, id)`. Active branch only from a valid `currentNodeId`;
  otherwise `activeness: 'unknown'` and `activeBranchId: null` (no guessing). An explicit, labeled heuristic
  `selectBranchByPolicy(analysis, 'last_child' | 'latest_leaf')` exists for callers that opt in; it returns the branch plus a warning
  `ACTIVE_BRANCH_HEURISTIC` and is never the default.
* `validate.ts`: zod schemas for `ConversationRecord`/`MessageRecord` used at the adapter->db boundary and in tests.

## 5. Ingestion

* **Inputs**: official export ZIP; extracted `conversations.json`; sharded `conversations-NNN.json` (in a ZIP or directory).
  `import-runner` detects the layout. Never fetches anything. Never follows symlinks in directories.
* **`zip.ts`** (SPEC Phase 1 security): central-directory parser; STORE and DEFLATE only; rejects encrypted entries, ZIP64 beyond
  limits, symlink entries (unix mode `S_IFLNK`), absolute paths, drive letters, `..` segments, backslash separators, NUL bytes,
  duplicate names (case-insensitive), overlapping/out-of-bounds offsets, CRC mismatch, size mismatch; enforces `ImportLimits`
  (default: max entries 20k, max entry uncompressed 2 GiB, max total uncompressed 8 GiB, max ratio 200:1 per entry, only entries whose
  names are needed are inflated). Yields bounded `AsyncIterable<Buffer>` per entry. Never extracts to disk.
* **`json-stream.ts`**: incremental tokenizer that reads a top-level JSON array and emits each element's raw text without holding the
  whole file (memory bound ~ largest conversation; a per-element byte limit applies). Handles UTF-8 split across chunks, BOM, strings with
  escapes. Also supports a single top-level object (wrapped as one element) and JSON Lines.
* **Adapters** implement `ConversationSourceAdapter` (`ingest/adapter.ts`): `ChatGPTExportAdapter` (full), `ClaudeExportAdapter` (offline export JSON -> same
  model, `provider:'claude'`, `provenance:'official_claude_export'`), `OpenAIAPIOwnedAdapter` (interface + a disabled implementation that
  throws `NOT_IMPLEMENTED`; documents that API-owned conversations are *not* `chatgpt.com/c` history, Mode D, separately authorized).
* **ChatGPT normalization rules**: timestamps (unix seconds, float) -> ISO-8601 UTC, invalid/NaN/0/absurd => null + warning. `model_slug` only
  from `message.metadata.model_slug` (never `default_model_slug`, never inferred). `current_node` kept only if it exists in `mapping`, else null + `INVALID_CURRENT_NODE`.
  Content `parts` that are not strings become typed blocks (`image_ref`, `file_ref`, or `unknown` with the raw part in `metadata`). Unknown `content_type`
  => block type `unknown` + warning `UNKNOWN_CONTENT_TYPE` (code, thoughts, tool output etc. have explicit types). Hidden reasoning is never fabricated; if the export contains `thoughts`
  content it is kept as a `thoughts` block, labelled, and excluded from the default rendering. Message text never has NUL bytes (stripped + warning).
* **Import runner**: validates every record; one SQLite transaction for the batch; `INSERT ... ON CONFLICT DO NOTHING`; returns an `ImportReport`
  (batch id, counts of conversations/messages/new vs existing, warnings grouped by code with counts, per-file results). `--strict` turns any
  conversation-level parse failure into an error; default records the failure as a warning and continues. No message content in reports/logs.

## 6. Search (`db/search.ts`)

* Default query mode `plain`: the user string is NFKC-normalized and tokenized in JS (Unicode-aware; CJK per character as required in §3), each token quoted
  (`"tok"`), joined by implicit AND; trailing `*` on a token means prefix. Empty/only-punctuation query => `INVALID_ARGUMENT`. `raw` mode passes FTS5 syntax
  through and maps SQLite syntax errors to `FTS_SYNTAX_ERROR`. Always `WHERE messages_fts MATCH ?` bound.
* Results join to `conversation_heads` (unless `allBatches`) and exclude `structural_empty` and, by default, `hidden` messages.
* Ordering is total and stable: `bm25 ASC, created_at ASC NULLS LAST, conversation_id ASC, message_id ASC`. Pagination: `limit` (1..200, default 20) +
  `offset`, plus an opaque `nextCursor` (keyset over the same order). Snippets via `snippet()` with markers configurable and HTML-safe escaping done by renderers.
* Filters: provider, accountLabel, role, conversationId, createdAfter/Before, hasModel, channel.

## 7. Output (`format/render.ts`)

Formats: `json`, `markdown`, `compact` (token-light plain text, `[role] text`), `jsonl`. Every rendered document carries a header (markdown/compact) or
envelope (json/jsonl first line): source provenance, completeness, import time, tool version, branch identity, and warnings. Timestamps stay
UTC ISO in JSON; markdown/compact additionally show the time in `--tz <IANA>` (default `UTC`) via `Intl.DateTimeFormat`, plus the UTC value.
Markdown rendering is injection-safe (fence length adapts to content; no HTML interpretation implied; message text is quoted DATA). Hidden and
structural messages are omitted unless `includeHidden`.

## 8. SDK facade (`src/sdk/gcr.ts`)

`class Gcr` (constructed via `Gcr.open({dbPath, readOnly?})`) exposes typed methods used by CLI and MCP: `importExport`, `list`, `get`, `getByUrl`,
`search`, `branches`, `thread`, `stats`, `audit`, `buildGraph`, `graphQuery`, `graphPath`, `graphExport`, `createDraft`, `listDrafts`, `updateAnnotation`,
`createAnnotation`, `listAnnotations`, `doctor`, `close`. Every read returns data plus provenance/completeness/warnings (`ResultEnvelope`). `src/index.ts` re-exports the public API
and types (the stable SDK surface) and nothing internal.

## 9. MCP (`src/mcp/*`)

Official SDK, stdio transport. Tools (SPEC §7): `gcr_list`, `gcr_get`, `gcr_search`, `gcr_branches`, `gcr_thread`, `gcr_stats`, `gcr_audit`,
`gcr_graph_query` (read-only, `readOnlyHint:true`); `gcr_create_local_draft`, `gcr_update_local_annotation` (write local DB only,
`destructiveHint:false`, `openWorldHint:false`); `gcr_import_export` (explicit local path, must resolve under `GCR_APPROVED_IMPORT_ROOTS`
(colon-separated); with none configured the tool is disabled and says why). Every tool: zod input schema with bounds, output = `ResultEnvelope`/`ErrorEnvelope` JSON in both
`structuredContent` and a text block, `untrustedContent` flag, result size cap (default 200 KB, truncation reported as warning), no stdout writes other than the transport.
No tool can send anything to ChatGPT. The legacy-alias mechanism (`src/mcp/aliases.ts`) is empty by default because the v0.1.1 `chatgpt_*` names are unknown (baseline unavailable; see DECISIONS ADR-0002).

## 10. Testing conventions

* Runner: `node --test` over compiled output (`npm test` = `tsc -p tsconfig.json` then `node --test "dist-test/test/**/*.test.js"`). Tests live in `test/`, mirror `src/`, and
  use `node:test` + `node:assert/strict`. Property tests use `fast-check` with fixed seeds recorded on failure.
* **Synthetic data only** (generated in tests or under `fixtures/`). No real exports, ever. Helpers: `test/helpers/zip-builder.ts` (writes ZIPs in memory with arbitrary names/methods/headers),
  `test/helpers/synthetic.ts` (conversation builders), `test/helpers/tmp.ts` (temp dirs auto-cleaned).
* Every P0 requirement has at least one positive and one negative test; security tests (ZIP, FTS, HTML injection, prompt-injection-as-data, log hygiene) are explicit.
* Tests must assert on behaviour; no mocks of the code under test; MCP is tested with the real SDK `Client`.
