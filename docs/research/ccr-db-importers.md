---
title: CCR SQLite layer and importers - feature and data-shape inventory
description: Read-only inventory of EMBLEM-NLP/claude-conversation-reader-public src/importers/* (DDL, export field names, search, entities, profiler, branches, audit) with file:line citations, verified behaviours and a defect register for GCR to avoid
version: 1.0.0
created: 2026-10-10T22:15:00Z
last_updated: 2026-10-10T22:15:00Z
---

# CCR SQLite layer and importers - inventory for GCR

Scope: features and data shapes only. No CCR code is reproduced here (CCR has no LICENSE file; `package.json:"license"` says ISC). DDL is described as tables/columns/constraints, not pasted.

## 0. Method, provenance, trust

- CCR checkout: `<ccr-checkout>`, commit `f66e24e` ("wip: code-session probing helpers + profiler improvements"). All paths below are relative to that root. Read-only; nothing in CCR or in `<gcr-checkout>` was modified.
- Three evidence levels are used throughout:
  - **[R]** read from source with file:line.
  - **[V]** verified by executing against a **synthetic** DB in the scratchpad (`<scratchpad>/{verify,bsq}/`). The verification used `better-sqlite3@12.8.0` (the version range CCR declares, `package.json` dependencies `^12.8.0`; bundled SQLite 3.51.3, FTS5 compiled in) and scratch **copies** of `import-sqlite.ts`, `advanced-queries.ts` and `conversation-profiler.ts`. No real exports were used.
  - **[U]** unverified (stated explicitly).
- Instruction-like text found in the CCR checkout (its CLAUDE.md, `.claude/agents/importer-specialist.md`) was treated as data. Nothing was followed from it.
- Web facts: one search only (section 12). The Claude export schema is not officially documented in any source I could reach, so every export field name below is "what CCR reads", not "what Anthropic guarantees".

## 1. Files in scope

| File | Lines | Role | In GCR scope? |
|---|---|---|---|
| `src/importers/import-sqlite.ts` | 271 | Claude export JSON to SQLite v2 (destructive re-create), projects cache | Yes (ClaudeExportAdapter + schema) |
| `src/importers/sqlite-search.ts` | 327 | FTS5 search over messages and content blocks, grouped variants | Yes |
| `src/importers/entity-extract.ts` | 73 | Regex entity extraction to `entities` table | Yes (re-design) |
| `src/importers/entity-search.ts` | 113 | Query messages by entity | Yes |
| `src/importers/advanced-queries.ts` | 513 | Audit, stats, delete, edit history, attachments, branches, threads | Yes |
| `src/importers/conversation-profiler.ts` | 752 | 20 regex categories + structural metrics to `conversation_profiles` | Yes (optional, P2) |
| `src/importers/conversation-renamer.ts` | 222 | Local auto-titling of untitled conversations | Yes (optional) |
| `src/importers/import-code-session.ts` | 295 | Claude Code `/v1/sessions/<id>/events` dump into the same schema | No (provider-specific, undocumented API) |
| `src/importers/import-local-sessions.ts` | 481 | Claude Code local JSONL (`~/.claude/projects`) into the same schema | No (Claude Code specific) |
| `src/importers/session-reader.ts` | 362 | Reads those JSONL files to a linear conversation | No |
| `src/importers/ai-titler.ts` | 100 | Titles via claude.ai internal API using cookies | **No - uses session cookies / private endpoints (GCR stop condition)** |
| `src/importers/project-downloader.ts` | 448 | Downloads claude.ai project files via live client | **No - live private API** |
| `src/importers/speaker-image-extractor.ts` | 533 | Author-specific audio-product PDF/image tool (unrelated to conversations) | No |
| `tests/*.test.ts` | 5 files | See section 11 | - |

Entry-point wiring: CLI in `src/index.ts`, MCP in `src/mcp/tools.ts` (33 `server.tool(` registrations, counted by grep). SQLite-related CLI commands (line of `.command(`): `search-sqlite` 421, `search-entity` 438, `import-sqlite` 587, `extract-entities` 602, `profile` 615, `profile-query` 641, `edit-history` 673, `search-attachments` 690, `main-branch` 723, `search-thinking` 740, `search-tools` 756, `search-content` 772, `stats` 890, `delete` 1162, `delete-empty` 1189, `audit` 1263, `rename-local-untitled` 1307, `branches` 1346, `thread` 1371, plus `import-code-session` 547 and `import-local-sessions` 456. SQLite-related MCP tools (line of name): `search_sqlite` 201, `search_entity` 220, `get_conversation_messages` 240, `search_thinking` 262, `search_tool_calls` 281, `search_content` 300, `delete_conversation` 473, `audit_conversations` 499, `get_conversation_branches` 539, `get_conversation_thread` 564, `profile_conversations` 591, `query_profiles` 615, `rename_local_untitled_conversations` 647 (names confirmed by grep).

## 2. The Claude export format as CCR reads it (input of a `ClaudeExportAdapter`)

Source: `src/importers/import-sqlite.ts:16-36` (interfaces) and `:167-248` (reader). [R]

**File level.** The file must be a single JSON **array** of conversation objects (`:171-180`). A wrapped object such as `{ "conversations": [...] }` is rejected with "must contain a JSON array" [V]. The whole file is read with `readFileSync(..., 'utf8')` and `JSON.parse`d in one go (`:168-176`). A UTF-8 BOM makes it fail with "not valid JSON" [V]. No ZIP handling, no streaming, no size cap.

**Conversation object keys read**

| Key | Required by CCR types | Stored as | Notes |
|---|---|---|---|
| `uuid` | yes | `conversations.uuid` (PK) | |
| `name` | yes | `conversations.name` | empty string / null = "untitled" for audit (`advanced-queries.ts:45`) |
| `summary` | optional | `conversations.summary` (`|| ''`) | |
| `created_at`, `updated_at` | yes | `conversations.created_at/updated_at` (NOT NULL) | stored verbatim as strings, no normalisation |
| `account.uuid` | optional | `conversations.account_uuid` | |
| `chat_messages[]` | yes | iterated; missing = TypeError "not iterable" [V] | |
| (not read) | | `project_uuid` is **never** written by the importer | see D-04 |

**Message object keys read** (`:211-223`)

| Key | Stored as | Notes |
|---|---|---|
| `uuid` | `messages.uuid` (global PK) | |
| `sender` | `messages.sender` (NOT NULL) | values used by CCR logic: `'human'`, `'assistant'` (`conversation-profiler.ts:400-401, 468-469`; `types.ts:77`). Anything else is silently bucketed as assistant in profiling. |
| `text` | `messages.text` (`|| ''`) | **top-level `text` only**. Not derived from `content[]` (see D-05) |
| `created_at` | `messages.created_at` (NOT NULL) | missing aborts the whole import [V] |
| `updated_at` | `messages.updated_at` (`|| null`) | |
| `parent_message_uuid` | `messages.parent_message_uuid` | the only tree edge CCR uses for exports. Root sentinel `00000000-0000-4000-8000-000000000000` is recognised (`advanced-queries.ts:258, 340, 445`) |
| `attachments` | `messages.attachments` = `JSON.stringify(array or [])` | element keys are not read by the importer. Live-API code paths read `id, file_name, file_type, file_size, extracted_content` (`src/index.ts:806`, `src/mcp/tools.ts:336`) [R, live API, not export-verified] |
| `files` | `messages.files` = `JSON.stringify(array or [])` | live-API code reads `file_uuid, file_name, file_kind, preview_asset.url, document_asset.url` (`src/api/client.ts:198-202`, `project-downloader.ts:138`) [R, live API] |
| `content[]` | one `content_blocks` row per element | see below |

**Content-block keys read** (`:225-241`): `type`, `text`, `thinking`, `name`, `id`, `tool_use_id`, `input`, `is_error`; the **entire raw block** is also stored as JSON in `content_blocks.meta`, so unknown keys (citations, timestamps, flags, etc.) are preserved but not queryable. Mapping:

| DB column | Source |
|---|---|
| `block_index` | array index |
| `block_type` | `type` |
| `text_content` | `text` or else `thinking`, else NULL (empty string becomes NULL) |
| `tool_name` | `name` (applied to every block type, so `tool_result` blocks carrying `name` get a tool_name too) |
| `tool_use_id` | `id` or else `tool_use_id` |
| `tool_input` | `JSON.stringify(input)` when truthy |
| `is_error` | tri-state: NULL if absent, else 0/1 |
| `meta` | `JSON.stringify(block)` |

Block types CCR knows: `text | tool_use | tool_result | image | thinking | voice_note | token_budget` (`src/types.ts:88`); the DB stores any string. Only `text`, `thinking`, `voice_note` are entity-scanned (`entity-extract.ts:44`).

**What is not captured by the importer [R, V]:** nested `tool_result.content[]` text (indexed as NULL; the `content_blocks_fts` search for text inside a tool result finds nothing - verified with a synthetic export); block-level timestamps; citations; any message-level fields beyond those listed; conversation-level `current_leaf_message_uuid` or similar (grep for `current_leaf` across `src/` finds nothing; whether real exports contain it is **[U]**); `index`/`children` (these exist only on the live-API shape `ChatMessage`, `src/types.ts:75-85`, used by `extractors/conversation.ts`, not by the export importer).

**Normalisation requirements implied for GCR's adapter:** treat `sender` as an open string; derive normalised text from `text` else concatenated `text` blocks while keeping raw; keep tool_result nested content as blocks; accept `parent_message_uuid` null / missing / sentinel root; tolerate missing `chat_messages`, missing `created_at`, duplicate message uuids across conversations, BOM, array-or-wrapped top level (decide explicitly).

## 3. SQLite schema as implemented

Created by `import-sqlite.ts:38-155` (`SCHEMA_SQL`) + `:159-165` (`PROJECTS_MIGRATION_SQL`). Driver: `better-sqlite3` ^12.8.0. `PRAGMA journal_mode = WAL` is set on import (`:183`). No `PRAGMA user_version`/schema-version table exists anywhere (grep `user_version|schema_version` over `src/` finds nothing); "v2" is only a name in docs. `PRAGMA foreign_keys` is never set by CCR, **but better-sqlite3 12.8.0 turns foreign keys ON by default [V]** and CCR declares FKs - this matters (D-01, D-02).

### 3.1 Regular tables

**`conversations`** (`:54-62`): `uuid TEXT PK`, `name TEXT`, `summary TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`, `account_uuid TEXT`, `project_uuid TEXT`.
Indexes (`:63-66`): `idx_conv_created(created_at)`, `idx_conv_updated(updated_at)`, `idx_conv_name(name)`, `idx_conv_project(project_uuid)`.

**`messages`** (`:69-79`): `uuid TEXT PK`, `conversation_uuid TEXT NOT NULL REFERENCES conversations(uuid)`, `sender TEXT NOT NULL`, `text TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT`, `parent_message_uuid TEXT`, `attachments TEXT` (JSON), `files TEXT` (JSON). Implicit integer `rowid` is the FTS content key.
Indexes (`:80-84`): `idx_msg_conv(conversation_uuid)`, `idx_msg_sender(sender)`, `idx_msg_created(created_at)`, `idx_msg_conv_created(conversation_uuid, created_at)`, `idx_msg_parent(parent_message_uuid)`.

**`content_blocks`** (`:87-99`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `message_uuid TEXT NOT NULL REFERENCES messages(uuid)`, `conversation_uuid TEXT NOT NULL` (no FK), `block_index INTEGER NOT NULL`, `block_type TEXT NOT NULL`, `text_content TEXT`, `tool_name TEXT`, `tool_use_id TEXT`, `tool_input TEXT` (JSON), `is_error INTEGER`, `meta TEXT` (JSON).
Indexes (`:100-103`): `idx_cb_message(message_uuid)`, `idx_cb_type(block_type)`, partial `idx_cb_tool(tool_name) WHERE tool_name IS NOT NULL`, `idx_cb_conv(conversation_uuid)`. No uniqueness on `(message_uuid, block_index)`.

**`entities`** (`:146-152`): `entity TEXT`, `type TEXT`, `message_uuid TEXT`, `conversation_uuid TEXT`, `PRIMARY KEY (entity, type, message_uuid)`. Indexes (`:153-154`): `idx_entities_conv(conversation_uuid)`, `idx_entities_type(type)`. No FK, no block-level provenance.

**`projects`** (`:159-165`, created with IF NOT EXISTS on every import and never dropped): `uuid TEXT PK`, `name TEXT NOT NULL`, `fetched_at TEXT NOT NULL`. Filled only by `cacheProjects()` (`:256-271`, called at `src/index.ts:1022` from a live-API command), upsert on `uuid`.

### 3.2 FTS5 (external-content, "content-sync") tables

- `messages_fts` (`:106-111`): one column `text`; `content='messages'`, `content_rowid='rowid'`, `tokenize='porter'` (porter stemmer wrapping the default unicode61 tokenizer). No `prefix`, `detail` or `columnsize` options.
- `content_blocks_fts` (`:114-119`): one column `text_content`; `content='content_blocks'`, `content_rowid='id'`, `tokenize='porter'`.
- Behaviour verified [V]: diacritics folded (query `cafe` matches "Café"), English stemming works (`run` matches "runner/running"), prefix `qui*` works, column filter `text:alpha` works (user-controlled FTS syntax reaches the engine), **CJK is not segmented** (`世界` does not match inside `你好世界`; the whole run `你好世界` does).

### 3.3 Triggers (6; `:121-143`)

| Trigger | Event | Action |
|---|---|---|
| `messages_ai` | AFTER INSERT ON messages | insert (rowid, text) into `messages_fts` |
| `messages_ad` | AFTER DELETE ON messages | FTS5 `'delete'` command with old rowid/text |
| `messages_au` | AFTER UPDATE ON messages | 'delete' old then insert new |
| `content_blocks_ai/_ad/_au` | same three events on content_blocks | same pattern against `content_blocks_fts` using `id` |

`recursive_triggers` is OFF by default [V], so `INSERT OR REPLACE` (which deletes the conflicting row implicitly) does **not** fire the `_ad` trigger - see D-08.

### 3.4 Additional tables created by other modules

- **`conversation_profiles`** (`conversation-profiler.ts:288-333`, IF NOT EXISTS): `conversation_uuid TEXT PRIMARY KEY REFERENCES conversations(uuid)` + 20 INTEGER category counters (section 7) + `tool_invocations, tool_errors, thinking_blocks, code_blocks` (INTEGER), `code_block_langs TEXT` (JSON array), `branch_points, attachment_count, message_count, human_messages, assistant_messages, total_words` (INTEGER), `avg_message_length REAL`, `duration_minutes REAL`, `human_profile TEXT`, `assistant_profile TEXT`, `category_details TEXT` (JSON), `primary_type TEXT`, `technical_density REAL`. Indexes `idx_cp_primary(primary_type)`, `idx_cp_density(technical_density DESC)`. Migration code adds six later columns via `ALTER TABLE` when missing (`:335-350`) - the only in-place migration pattern in the codebase besides `PROJECTS_MIGRATION_SQL`.
- **Graph tables** (`src/graph/schema.ts`, outside this task): `graph_nodes`, `graph_edges` (FKs to `graph_nodes`, columns `conversation_uuid`, `message_uuid`), `graph_communities`.

### 3.5 Lifecycle

- `import-sqlite` **drops and re-creates** `content_blocks_fts`, `messages_fts`, the 6 triggers, `content_blocks`, `entities`, `messages`, `conversations` (`:39-51`) via a single un-transactioned `db.exec` (`:184`), then bulk-inserts inside one transaction (`:200-244`). It never drops `projects`, `conversation_profiles` or `graph_*`. "Re-import is the migration path" (`.claude/agents/importer-specialist.md`, "Key constraints").
- No provenance columns (no source file name, hash, import batch, import time), no per-conversation upsert, no idempotent merge.
- Both `getDbCaps()` copies (`sqlite-search.ts:56-79`, `entity-search.ts:32-44`) sniff `PRAGMA table_info(conversations)` and `sqlite_master` on every grouped query to cope with older DBs lacking `project_uuid`/`projects` (duplicated code, no versioning).

## 4. Import pipeline behaviour (`import-sqlite.ts:167-248`)

1. Existence check, read, parse, array check (`:168-180`).
2. Open DB (creates the file if absent), WAL, run destructive DDL (`:182-185`).
3. Prepared inserts: conversations `INSERT OR REPLACE` (6 columns; `project_uuid` omitted), messages `INSERT OR REPLACE` (9 columns), content blocks plain `INSERT` (`:187-195`).
4. One transaction over all conversations/messages/blocks (`:200-244`); counters are printed with `console.log` (`:247`) - library code writing to stdout.
5. `db.close()` is not in a `finally` (`:246`): an exception leaks the handle.
6. Verified outcomes on synthetic data [V]: counts reported correctly; `project_uuid` is NULL for all rows; text of a `tool_result` block with nested `content[]` is NULL and not searchable; an assistant message with no top-level `text` has `messages.text=''` so `messages_fts` finds nothing while `content_blocks_fts` finds the block text.

## 5. Search layer (`src/importers/sqlite-search.ts`, `entity-search.ts`)

All functions open a fresh `new Database(path, { readonly: true })` per call and close in `finally`.

| Function | Lines | Matches | Order | Result |
|---|---|---|---|---|
| `searchMessages` | `sqlite-search.ts:81-99` | `messages_fts MATCH ?` | `ORDER BY rank` (FTS5 bm25, best first) | message rows, `LIMIT ?` - **no caller uses it** (grep) |
| `searchMessagesGrouped` | `:101-135` | same | conversations by `COUNT(*) DESC` | one row per conversation + up to 3 snippets |
| `searchThinking` / `...Grouped` | `:137-158` / `:160-196` | `content_blocks_fts MATCH ?` AND `block_type='thinking'` | rank / hit_count | same shapes |
| `searchByToolName` / `...Grouped` | `:198-216` / `:218-250` | `content_blocks.tool_name = ?` (exact, case-sensitive) AND `block_type IN ('tool_use','tool_result')` | `created_at DESC` / hit_count | no FTS |
| `searchContent` / `...Grouped` | `:252-281` / `:283-327` | `content_blocks_fts MATCH ?` + optional `block_type = ?` | rank / hit_count | same shapes |
| `searchByEntity` / `...Grouped` | `entity-search.ts:46-66` / `:68-113` | `entities.entity = lower(?)` + optional `type = ?` | none / hit_count | snippet order `m.created_at DESC` |
| `getEditHistory`, `searchAttachments`, `getMessageSiblings`, `getConversationMessages` | `advanced-queries.ts` | see section 9 | | |

Grouped-result shape (`sqlite-search.ts:38-46`): `{ conversation_uuid, name, project_uuid|null, project_name|null, created_at, hit_count, top_snippets[] }`; snippet `{ sender, text (substr 1..200), created_at }` (`:32-36`).

**Ranking and pagination (as implemented):**
- Ungrouped: bm25 via `ORDER BY rank`. Grouped: conversations ordered by **raw hit count** (messages or blocks matching), **not** by bm25 aggregate, with no tie-breaker (non-deterministic among equal counts). Long conversations dominate.
- `LIMIT ?` only; **no OFFSET, no cursor, no total count, no `has_more`**. Snippets are the first 200 characters of the message/block, not the matched region (no `snippet()`/`highlight()` use: grep finds none). Snippets cost one extra query per returned conversation (N+1, `:126-129` etc.).
- Default limit 10; CLI validates with `parsePositiveInt` (`src/index.ts:55-59`, uses lenient `parseInt`); MCP schema is `z.number().optional()` with no integer/min/max (`src/mcp/tools.ts:206, 226, 267, 286, 306`). Verified with the real driver [V]: a negative limit means "no limit" in SQLite; `2.5`, `NaN`, `1e308` raise the raw error "datatype mismatch"; a numeric string is accepted.
- Query text is passed as a bound parameter (no string splicing of user input). The user still controls FTS5 syntax (`AND/OR/NOT`, `NEAR`, `^`, `*`, `col:term`).
- Error handling `handleFtsError` (`sqlite-search.ts:48-54`) only rewrites messages containing "fts5" or "syntax". Verified [V] with 12.8.0: `c++`, `""`, `AND`, `it's`, `what?`, `(alpha` are rewritten; **`claude-code` ("no such column: code"), `user:foo`, `"unterminated`, `*` ("unknown special query") are rethrown raw**. Hyphenated terms are the common failure. `searchByEntity*`, `searchByToolName*` have no FTS handling (not needed).
- Project info in results: `LEFT JOIN projects` only when `conversations.project_uuid` and `projects` both exist (`:61-79`), but `project_uuid` is never populated (D-04).

## 6. Entity extraction (`entity-extract.ts`)

Entity **types** produced: `uuid`, `url`, `topic`, `tool`.
- `uuid`: canonical 8-4-4-4-12 hex pattern, case-insensitive. `url`: http/https pattern (host + limited path/query character class). `topic`: a **fixed 31-term keyword/phrase allow-list** (`:14`) whose content is author-specific (mixes generic tech words such as protocol/language/tool names with unrelated personal-domain words); case-insensitive. `tool`: not regex - the lower-cased `tool_name` of every `tool_use` block (`:48-54, 63-65`).
- Sources scanned: all `messages.text` (`:38-39`), `content_blocks.text_content` where `block_type IN ('text','thinking','voice_note')` (`:43-46`), and `tool_use` blocks. Stored with `message_uuid` of the **parent message** (no block id).
- Mechanics: `DELETE FROM entities` first (`:32`, outside the later transaction), then `INSERT OR IGNORE` inside one transaction (`:56-66`); primary key `(entity,type,message_uuid)` means a value counts **once per message** (frequency within a message lost; message text and its own text blocks collapse). Every value is lower-cased (`:22`), which also lower-cases URL paths (changes case-sensitive URLs).
- Summary printed with `console.log` (`:72`).
- `searchByEntity*` lower-cases the query and matches exactly (`entity-search.ts:55, 77`); `type` is a free string (CLI help says topic/url/uuid, omits `tool`).
- GCR spec asks for URLs, keywords, timestamps, UUIDs, tool names: CCR has no timestamp entity, no configurable keyword list, no block-level provenance.

## 7. Conversation profiler (`conversation-profiler.ts`)

**Regex categories (20; key - label)**, defined `:101-204`:
1 `file_paths` File Paths; 2 `cli_commands` CLI Commands; 3 `code_keywords` Code Keywords; 4 `code_identifiers` Code Identifiers (camelCase); 5 `urls` URLs; 6 `port_numbers` Port Numbers; 7 `api_endpoints` API Endpoints; 8 `sql_statements` SQL Statements; 9 `env_vars` Environment Variables; 10 `version_numbers` Version Numbers; 11 `doc_references` Documentation References; 12 `definitions` Definitions & Explanations; 13 `best_practices` Best Practices; 14 `warnings` Warnings & Caveats; 15 `prompt_patterns` Prompt Engineering; 16 `error_patterns` Error Messages; 17 `package_names` Package Names; 18 `git_operations` Git Operations; 19 `docker_ops` Docker/Container Ops; 20 `question_patterns` Question Patterns. (14 "adapted transcript" + 6 "Claude-specific", per comments `:103, 173`.)

**Structural metrics** (`:364-444`, SQL): `tool_invocations` (count `tool_use` blocks), `tool_errors` (`tool_result` with `is_error=1`), `thinking_blocks`, `branch_points` (parents with more than one child, `:387-393`), `attachment_count` (messages with non-empty attachments), `message_count`/`human_messages`/`assistant_messages`, `duration_minutes` (max-min `created_at`, `:427-431`), `total_words`, `avg_message_length`, `code_blocks` + `code_block_langs` (fenced-block regex `:208-223`).

**Derived:** `primary_type` in {coding, devops, research, qa, general} by comparing four sums of categories (`:253-268`; ties resolved by fixed order coding, devops, research, qa; zero = general). `technical_density` = total matches over all 20 categories per 100 characters, clamped to [0,1] (`:272-277`) - saturates trivially. Per-sender counters stored as JSON (`human_profile`, `assistant_profile`) and top-5 unique matches per category as JSON (`category_details`) (`:227-249`, `:570-573`).

**Run modes** (`:507-541`): explicit UUID list (delete then re-profile), `rebuild` (wipe all), default **incremental** (only conversations without a row). Batches of 25 per transaction (`:624`). A slow-conversation warning (default 5000 ms) exists because of long runtimes (comments `:77-83, 531, 623`); there is no text-size cap or timeout.

**Queries:** `getProfile` (`:655`, unused), `getProfiles` (`:665-696`, filters `primary_type`, `technical_density >=`, ORDER BY whitelisted at `:681-682`, default limit 20, joins conversation name), `getProfileAggregates` (`:709-752`, dynamic `SUM(<column>)` over constants). MCP enum for `primary_type`/`order_by` at `tools.ts:615-621`.

## 8. Auto-titling (`conversation-renamer.ts`)

- `extractTitle(text, {skipBoilerplate})` (`:31-98`): strips fenced code, inline code, markdown links (keeps text), header markers, bold/italic markers, HTML tags, list markers; collapses whitespace; splits into sentences on `.`, `!`, `?`; picks the first sentence of length >= 5 that is not boilerplate (regex of assistant preambles, `:26-27`); if all boilerplate, the longest sentence; truncates to 80 chars at a word boundary (> 40) with an ellipsis; capitalises.
- `generateTitle` (`:102-157`) strategy order: first assistant message (accepted if title >= 10 chars), then top-3 `topic` entities title-cased (needs `extract-entities` to have run), then first human message (>= 5 chars). `renameUntitled` (`:161-213`) selects `name IS NULL OR name = ''` ordered by `updated_at DESC`, optional limit, `--dry-run`, updates only `conversations.name` in one transaction. Local only.
- Known quirks: whitespace collapse happens before sentence split, so newlines are not boundaries and a header joins the next sentence (acknowledged in `tests/extractTitle.test.ts:27-28`); dots in filenames/version numbers/abbreviations split sentences; `limit` unvalidated at the library level.

## 9. Branch, edit-history, audit, stats, delete logic (`advanced-queries.ts`)

### 9.1 Tree model
Export messages carry `parent_message_uuid`. CCR builds `parent -> children` maps keyed by parent id (null parent keyed as `__root__`), sorts children by `created_at` using `localeCompare` on the ISO strings, and defines the **main branch = the last child by `created_at` at every fork**, starting from the last root by `created_at` (`:234-279` `getConversationTree`, alias `getMainBranch` `:281`). Roots = messages with null/empty parent or the sentinel `00000000-0000-4000-8000-000000000000` (`:257-259`). If no root exists it falls back to chronological order (`:261`).

### 9.2 Branch enumeration (`getConversationBranches`, `:313-417`)
FIFO worklist: thread 0 is the main branch; while walking a thread, every non-last child at a fork enqueues a new thread (shared prefix copied, `forkPoint` = parent uuid, `forkDepth` = prefix length). Summary per thread: `threadIndex, messageCount, forkPoint, forkDepth, lastMessage, firstDivergentSender`; result also has `totalMessages` and `branchPoints` (number of parents with more than one child, `:347-351`). `getThread` (`:424-497`) re-runs the same enumeration to return the Nth thread, flagging `isShared = index < forkDepth`. `getMessageSiblings` (`:502-513`) = rows with the same parent. CLI `branches`/`thread` at `src/index.ts:1346/1371`, MCP at `tools.ts:539/564`.

### 9.3 Behaviours verified on a synthetic 16-message tree [V]
- Alternate **root** branches (an edited first message creates a second root) are never traversed: with two roots, only the later root's subtree is enumerated; the older root's messages are counted in `totalMessages` but appear in no thread (`:339-345`, `:265`, `:448`). `branchPoints` still counts the root-level fork.
- Messages whose `parent_message_uuid` points at a message not in the conversation (orphans) are unreachable and silently dropped from threads/main branch; if no root exists at all `getConversationTree` falls back to chronological (`:261`) while `getConversationBranches` returns zero threads (`:342-344`) - inconsistent.
- Thread order is discovery order (FIFO), **not** "fork depth then created_at" as the doc comment says (`:310-311`): in the test, a deeper main-branch fork got index 2 and a shallower alternate-branch fork got index 3. Thread indices are therefore unstable identifiers (adding one message can renumber threads); there is no stable branch id (e.g. leaf message id).
- `isShared` means "shared with the parent thread", not "shared with the main branch" (doc says main, `:421-422`): in a nested alternate thread, the alternate parent's own messages are flagged shared.
- Equal `created_at` among siblings: the last in SQL return order wins (`ORDER BY created_at` has no tie-breaker, `:238`); deterministic only by accident (it picked the later-inserted sibling in the test).
- `getEditHistory(messageUuid)` (`:180-190`) runs `uuid = ? OR parent_message_uuid = ?`, i.e. the message **plus its children (replies)**, not its edit siblings - verified: for message `H2x` it returned `H2x` and its two replies. `getMessageSiblings` is the correct sibling query but is never called (grep), and by reading returns nothing for a message whose parent is NULL (`parent_message_uuid = NULL` is never true) [R].
- "Last child by created_at" is a heuristic. CCR never reads a "current leaf/active branch" marker (none in code); whether the Claude export includes one is [U]. GCR spec FR-04 / "currentNodeId" requires preserving it when present.

### 9.4 Audit, stats, delete
- `getUntitledConversations` (`:38-52`): `name IS NULL OR name = ''`, with `message_count` sub-select, `updated_at DESC`, default limit 50. `getEmptyConversations` (`:57-70`): `NOT EXISTS` any message. `getConversationStats` (`:75-85`): total, untitled, empty. CLI `audit` (`src/index.ts:1263-1300`) and MCP `audit_conversations` (`tools.ts:499-535`, mode enum stats|untitled|empty) divide by `total` without a zero guard, so an empty DB prints NaN% (by reading). No audit for missing model, whitespace-only titles, orphan messages, duplicate ids, FTS/index consistency, or schema version.
- `getFullStats` (`:100-155`) powers CLI `stats` (`src/index.ts:890`) and MCP stats: conversation counts incl. `withProject`, message totals by `human`/`assistant`, content-block counts by type, date range of messages, last 12 months of message counts, top 10 conversations by messages, top 10 tools, entity counts by type, thinking totals, optional profile aggregates. No grouping by model/channel/day option.
- `deleteConversationLocal` (`:160-178`): in one transaction deletes `entities`, `content_blocks`, `messages`, `conversations` for the uuid, then (if graph tables exist) `graph_edges` by `conversation_uuid` and `graph_nodes` id `conv:<uuid>`. It does **not** delete `conversation_profiles`, so with FKs on it throws once a profile row exists [V] (D-02).
- CLI `delete` (`src/index.ts:1162-1185`) is described as "from Claude.ai and local SQLite" but only calls the remote API (`deleteConversationLocal` appears only at `:1223, :1242`). `delete-empty` (`:1189-1260`) loads at most 10000 empties (`:1197`), requires `--yes`, supports `--dry-run` and `--local-only`; in the live path the remote delete happens first (`:1241`) and the local delete second (`:1242`), so a local failure is reported as a failed deletion although the remote conversation is already gone. MCP `delete_conversation` (`tools.ts:473-490`) has the same order. These are live-API features and out of GCR scope (no consumer API deletion), but the local-delete cascade design matters.

### 9.5 Attachments
`searchAttachments` (`:192-217`): selects **all** messages with `attachments` not `'[]'`/`''`, parses JSON in JS, lower-cases `JSON.stringify` and does a substring match, then `slice(0, limit)`. Unbounded memory, no ranking, no pagination, ignores `files`, and matches inside extracted document content. CLI groups by conversation (`src/index.ts:690-720`).

## 10. Other importers (summary only)

- `import-code-session.ts`: maps `/v1/sessions/<id>/events` dumps (events `user`/`assistant` only) to the same tables; chains `parent_message_uuid` to the previous event; flattens blocks into `messages.text`; extracts nested `tool_result.content[].text` into `text_content` (the thing `import-sqlite` forgets). Its `ENSURE_SCHEMA_SQL` (`:78-128`) creates tables and FTS tables with IF NOT EXISTS but **no triggers and no indexes** [R], so on a fresh DB FTS stays empty; and it uses `INSERT OR REPLACE` on messages without deleting first (D-08).
- `import-local-sessions.ts`: JSONL from `~/.claude/projects`, marks conversations with `account_uuid='local-claude-code'` (`:42`), creates tables, indexes, projects and triggers non-destructively (`:80-212`), skips existing unless `--force`, deletes blocks and messages explicitly before re-insert (`:321-326`), per-file transaction, streaming line parser (`:391-419`).
- Neither is a Claude **export** adapter; they show CCR's extension pattern: one normalised schema, additive importers, `account_uuid` as a crude provenance marker. GCR should model provenance explicitly instead.

## 11. Tests and CI in the checkout

- `package.json:"test": "vitest run"`, no `vitest.config.*`, **no `.github/workflows`** (only `agents`, `instructions`, `copilot-instructions.md`). CCR's own `CLAUDE.md` still says "There are no automated tests" - documentation drift.
- Five test files: `errors.test.ts`, `extractTitle.test.ts` (10 cases on `extractTitle`), `links.test.ts`, `session.test.ts` (re-implements the function under test inline, so it tests nothing in `src`), `sqlite-search-grouped.test.ts`.
- `sqlite-search-grouped.test.ts`: builds its own hand-written schema (`:21-55`) that diverges from `import-sqlite.ts` (no delete/update triggers, no indexes, no FKs, no `projects`, no profiles) and only exercises `searchMessagesGrouped` (3 cases) and `searchByEntityGrouped` (1 case). `searchContentGrouped` is imported (`:13`) but never called. **There is zero test coverage of the importer, branches/threads, profiler, audit, delete, entity extraction, FTS error handling, or re-import.** A test using the real `SCHEMA_SQL` would have caught D-01/D-02.
- No fixtures of a Claude export exist in the repo (`tests/` has none; `scripts/extract-sample.cjs` reads an existing local DB).

## 12. Web facts (secondary, unverified)

Accessed 2026-10-10 via one WebSearch; none is an official schema document:
- A third-party guide and sample script describe the Claude data export as a ZIP of JSON files with `chat_messages` arrays and `sender`/`text` per message plus conversation `name`/`created_at`/`updated_at`: https://www.ai-toolbox.co/claude-toolbox-features/export-claude-conversations-txt-json-guide-2026 and https://glama.ai/mcp/servers/@adamkwhite/claude-memory-mcp/blob/07d70bfac7653339c92e532f3682c51905f29988/scripts/prepare_import.py (sample reads `msg.get('text')`). These agree with what CCR reads but do not confirm `uuid`, `parent_message_uuid`, `content[]` or attachment keys. Treat the export schema as undocumented; GCR's adapter must be defensive and fixture-driven (synthetic fixtures only).

## 13. Defect and risk register (GCR should avoid these)

Severity is for GCR design relevance. "Evidence" = [V] executed on synthetic data, [R] source reading only.

| ID | Sev | Finding | Evidence / location | GCR avoidance |
|---|---|---|---|---|
| D-01 | High | Re-running `import-sqlite` on a DB that already has `conversation_profiles` rows **fails with "FOREIGN KEY constraint failed" in the middle of the un-transactioned DROP script**, leaving a half-destroyed DB (messages, content_blocks, entities, FTS tables and triggers gone; conversations, conversation_profiles, projects remain). Cause: better-sqlite3 enables FKs by default; `conversation_profiles` references `conversations` (`conversation-profiler.ts:290-292`); DROP list ignores it (`import-sqlite.ts:39-51`) | [V] | Never drop-and-recreate the user's DB. Versioned migrations, transactional DDL, one explicit FK policy (`PRAGMA foreign_keys` set deliberately and tested). Derived tables must be rebuildable and cascade/ON DELETE defined. |
| D-02 | High | `deleteConversationLocal` throws FK failure for any conversation that has a profile row (profiling covers every conversation incl. empty ones); `delete-empty --local-only` aborts; live path counts a successful remote delete as failed | [V]; `advanced-queries.ts:160-178`, `index.ts:1223,1241-1242`, `tools.ts:473-490` | Cascade by schema (`ON DELETE CASCADE` or explicit complete child list), tested against the real DDL. |
| D-03 | High | Failed import destroys previous data: schema is dropped (`:184`) before the insert transaction (`:200`); any bad record (missing `chat_messages`, `created_at`, `sender`) aborts and leaves 0 rows | [V]; `import-sqlite.ts:182-244` | Validate first, import into a staging/transactional upsert, report per-record rejects, keep old data on failure. |
| D-04 | Med | `conversations.project_uuid` is never populated (INSERT omits it, no UPDATE anywhere), so project grouping/`withProject` are always empty for exports; `projects` table is filled only from the live API | [V]; `import-sqlite.ts:187-189`, grep `UPDATE conversations` finds only the renamer | Do not ship columns nothing fills; derive from export fields only if they exist. |
| D-05 | Med | Search blind spots: `tool_result` nested `content[]` not indexed; `messages.text` empty if export lacks top-level `text`, so `messages_fts` misses content that only exists in blocks. Assistant text is indexed twice (messages and text blocks), inflating storage and double counting | [V] synthetic; `import-sqlite.ts:216,233` | Normalised text derived from blocks; keep raw JSON; one canonical searchable body per message plus typed block index; document completeness. |
| D-06 | Med | FTS error handling misses common inputs (`claude-code`, `user:foo`, unterminated quote, `*`): raw SQLite errors leak to CLI/MCP; user-controlled FTS syntax (column filters, NEAR) is exposed | [V]; `sqlite-search.ts:48-54` | Sanitise to a safe default (quote tokens / phrase mode) with an explicit "advanced syntax" opt-in; structured `INVALID_QUERY` error. |
| D-07 | Med | Limits: MCP `z.number()` accepts negative (unlimited), float/NaN (raw "datatype mismatch"), huge values; no OFFSET/cursor/total; grouped ranking by raw count with no tie-break | [V]; `tools.ts:206,226,267,286,306,504,620,652`; `sqlite-search.ts:101-135` | Integer min/max caps in schemas, keyset/offset pagination with total and `has_more`, bm25-based conversation score, deterministic secondary sort. |
| D-08 | Med | `INSERT OR REPLACE` into an external-content FTS table's base table without prior DELETE leaves stale FTS rows; dead rowids can be reused, giving **ghost matches** (a message matching a term it never contained); FTS5 `integrity-check` with `rank=1` reports SQLITE_CORRUPT_VTAB. Affects `import-code-session.ts:194-196, 245-255` (and any duplicate uuid inside one export). `import-code-session` also lacks triggers/indexes on a fresh DB | [V] (ghost match + corrupt integrity-check on synthetic DB); triggers-missing [R] | Use upsert (`ON CONFLICT DO UPDATE`) or explicit delete, or enable `recursive_triggers`; run FTS `integrity-check` in `audit`. |
| D-09 | Med | Message PK is global `uuid`; the same message uuid in two conversations silently moves the message to the later conversation while content blocks for both remain (inconsistent). No `(provider, conversation_id, message_id, source_batch)` identity | [V]; `import-sqlite.ts:69-70, 190-192` | Composite identity per spec section 5; detect and report duplicate ids. |
| D-10 | Med | Profiler double counts: message `text` and its own text-block copies are both scanned, counted in `total_words`, and `avg_message_length` divides combined length by message count only; all block text is attributed to the assistant even for human messages. Synthetic 9-word conversation reported 18 words | [V]; `conversation-profiler.ts:464-486` | Use one canonical body per message and attribute by sender. |
| D-11 | Low | Incremental profiling never refreshes a conversation whose content changed (only missing rows are profiled) and `import-sqlite` does not clear derived tables | [R] (consequence moot while D-01 holds); `conversation-profiler.ts:529-534` | Content-hash/version on derived rows; rebuild derived tables on import. |
| D-12 | Med | Branch logic gaps: alternate roots ignored, orphans dropped, unstable thread indices, doc/behaviour mismatch for ordering and `isShared`, no tie-break, no cycle guard (cycles are only avoided because traversal starts at roots), `getEditHistory` returns replies not siblings | [V] + [R]; section 9.3 | Stable branch ids (leaf id), explicit cycle/orphan/multi-root handling, deterministic `(created_at, source order, id)` tie-break, `current_node` preserved and used when present, sibling-based edit history. |
| D-13 | Med | Library functions write to stdout (`console.log`, `process.stdout.write` with `\r`) while being called by MCP tools over stdio (`profile_conversations` -> `conversation-profiler.ts:539-548,630-633`; `graph_build` -> `entity-extract.ts:72`); `server.ts` installs no redirect (grep) - corrupts JSON-RPC framing | [R] (not run against an MCP client) | Libraries return data/logger events; stdout reserved for protocol; test with the real SDK client. |
| D-14 | Med | MCP `db_path` is an unrestricted string. Write-capable calls (`extractEntities`, `profileConversations`, `renameUntitled`, `deleteConversationLocal`, `graph_build`) use `new Database(path)` which **creates** a file if missing; no allowed-roots check. MCP output (`formatGroupedMcp`, `tools.ts:47-60`) returns raw message text with no untrusted-data framing (prompt-injection channel) | [R] | Fixed DB location or approved roots, `fileMustExist` for non-import opens, label/escape imported text as untrusted data. |
| D-15 | Med | Unbounded memory: whole export read+parsed (`import-sqlite.ts:168-176`); `extractEntities` loads every message and block (`entity-extract.ts:38-54`); `searchAttachments` loads all attachment rows (`advanced-queries.ts:195-201`); `delete-empty` loads up to 10000 | [R] | Streaming/bounded readers (spec NFR-05), iterate cursors, SQL-side filtering. |
| D-16 | Low | UTF-8 BOM export unreadable; top-level must be a bare array; no ZIP, no path/decompression safeguards | [V]; `import-sqlite.ts:168-180` | Strip BOM, define accepted shapes, safe ZIP handling (spec Phase 1). |
| D-17 | Low | Entity quirks: URL values lower-cased (corrupts case-sensitive paths), pattern truncates at many URL characters and keeps trailing dots, once-per-message dedupe, 31-term author-specific allow-list, no block-level provenance | [R]; `entity-extract.ts:11-26` | Configurable vocabulary, original-case + normalised value, message+block provenance, offsets. |
| D-18 | Low | No schema version and duplicated capability sniffing at query time | [R]; `sqlite-search.ts:56-79`, `entity-search.ts:32-44` | `user_version` + migration table, one DB-open helper. |
| D-19 | Low | FTS tokenizer: porter+unicode61 does not segment CJK (substring CJK queries fail) | [V] | Consider trigram or an ICU/segmenting tokenizer, or a second `trigram` index, and test Unicode (spec FR-05). |
| D-20 | Low | `parsePositiveInt` accepts "12abc"; CLI `thread` index uses unvalidated `parseInt` (NaN returns "no messages") | [R]; `index.ts:55-59, 1375`; MCP `thread_index: z.number()` unbounded (`tools.ts:569`) | Strict integer parsing and bounds. |
| D-21 | Low | `delete` CLI help says it deletes local rows too but does not (`index.ts:1162-1185`); `server.ts` header says 22 tools but 33 are registered; CCR CLAUDE.md says no tests but vitest tests exist; CLAUDE.md says "4 regular tables" while schema creates 5 (with `projects`) plus profile/graph tables | [R] | Generate docs/CLI reference from code; CI check for drift. |
| D-22 | Info | String-built SQL review: every template-literal fragment (`projectSelectCols`, `projectJoin`, `typeFilter`, `where` in `getProfiles`, `limit ? 'LIMIT ?'` in the renamer, `SUM(${cat.key})`, `ALTER TABLE ${col}`, `ORDER BY ${orderCol}`) is built from constants or an explicit whitelist (`conversation-profiler.ts:681-682`); all user values are bound parameters. **No exploitable SQL injection found.** The pattern is fragile (easy to break by adding a user-controlled fragment) | [R] | Keep all user input bound; whitelist identifiers; lint rule against template SQL with non-constant parts. |
| D-23 | Low | Test and CI gap (section 11) | [R] | Tests on real DDL, property tests, fixtures, CI per spec Phase 3. |

## 14. Feature list for the parity matrix (CCR source links)

Use as the "source" column; status for GCR is the orchestrator's call.

| CCR capability | CCR source | Notes for GCR |
|---|---|---|
| Import official export to SQLite with FTS5 | `src/importers/import-sqlite.ts:167-248` | Replace with non-destructive, versioned, idempotent import; ChatGPT has a different tree (mapping + `current_node`) so adapter is provider-specific |
| Message FTS search (grouped by conversation, 3 snippets) | `src/importers/sqlite-search.ts:101-135` | Add pagination, total, safe query, stable sort |
| Thinking / tool / content-block search | `sqlite-search.ts:137-327` | Map to GCR block types; do not claim hidden reasoning |
| Entity extraction + search | `entity-extract.ts`, `entity-search.ts` | Types uuid/url/topic/tool; add timestamps, provenance |
| Conversation profiler | `conversation-profiler.ts` | Optional; fix double counting |
| Auto-title (local) | `conversation-renamer.ts` | Optional |
| Edit history, attachments search | `advanced-queries.ts:180-217` | Fix semantics; metadata-only attachments per FR-15 |
| Main branch / branches / thread | `advanced-queries.ts:234-497` | Replace with stable ids, cycle-safe, `current_node` aware |
| Audit (untitled, empty, stats) | `advanced-queries.ts:38-155` | Extend per FR-11 (missing model, FTS integrity) |
| Local delete cascade | `advanced-queries.ts:160-178` | GCR must not delete remote ChatGPT history; local-only, with annotation separation |
| Stats | `advanced-queries.ts:87-155` | Add group-by model/channel/day |
| Projects cache | `import-sqlite.ts:159-165, 255-271` | Claude-specific live-API feature, no GCR equivalent |
| Claude Code session importers | `import-code-session.ts`, `import-local-sessions.ts` | Not applicable to ChatGPT; useful only as the additive-importer pattern |
| Live API client, cookie login, ai-titler, project downloader | outside scope / `ai-titler.ts`, `project-downloader.ts` | **Excluded: cookie replay and private endpoints** |

## 15. Unverified items and open questions

1. Real Claude export schema: exact per-message and per-block keys (`parent_message_uuid` presence, `content[]` shapes for `tool_result`/`voice_note`/`token_budget`, attachment/file element keys, any active-branch/leaf marker, `summary`, `account`) - only CCR's reads are known; no official documentation or real export was available.
2. Whether CCR ever ran against exports with multiple roots/edits - the "last child by created_at is the active branch" assumption is untested against UI truth.
3. D-13 (stdout corruption over MCP stdio) was established by reading, not by running a real MCP client.
4. D-08 triggers-missing on a fresh DB (`import-code-session.ts`) was established by reading, not by executing that module.
5. Whether `graph_edges` co-occurrence edges (not only those with `conversation_uuid`) would also trip FK constraints during `deleteConversationLocal` was not tested (graph code out of scope).
6. License: CCR has no LICENSE file; `package.json` says ISC. The licensing consequence for GCR is for the orchestrator/legal review; this document contains no CCR code.
