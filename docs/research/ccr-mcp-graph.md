---
title: CCR MCP Server and Knowledge Graph Inventory (feature and data-shape parity input for GCR)
description: Read-only inventory of every MCP tool in CCR src/server.ts + src/mcp/tools.ts and every module in src/graph/ at commit f66e24e, with params, defaults, returns, live-vs-offline class, file:line, HTML export security/accessibility findings, test coverage, and a CCR-to-GCR tool mapping table.
version: 1.0.0
created: 2026-10-10T22:16:34Z
last_updated: 2026-10-10T22:16:34Z
---

# CCR MCP server and knowledge graph inventory

Scope: features and data shapes only. No CCR code is copied or proposed for copying (CCR has no LICENSE file; `package.json:31` says `"license": "ISC"`). DDL is summarised as column tables, not pasted.

- CCR checkout: `<ccr-checkout>`, `git rev-parse HEAD` = `f66e24e06b15e75060a65b2bf9b646395ddac0d1`. Nothing in CCR was modified. Paths below are relative to `src/` unless they start with `tests/`, `.githooks/` etc.
- GCR target tool names and constraints come from `<gcr-checkout>/SPEC.md` section 7 (read only; same text as the uploaded spec `EMBLEM-NLP_GCR_Codex_Repo_Spec_v1.0.md`, lines 119-121) and `CODEX_TASK.md` Phase 2.
- Date accessed for web facts: 2026-10-10. Method: every CCR fact is from reading source. I ran no CCR command, no CCR test, and made no network or auth attempt against claude.ai. The only code I executed is a 20-line scratch script (`scratchpad/xsscheck/check.mjs`) that shows `JSON.stringify` does not escape `<` and computes WCAG contrast ratios.
- Confidence labels: "read" = stated directly by the cited lines; "inferred" = my reasoning from the cited lines, not executed; "unverified" = not checked.

## 1. Headline facts

| Fact | Value | Evidence |
|---|---|---|
| MCP entry point | `server.ts` (20 lines): `McpServer({name:'claude-conversation-reader', version:'0.1.0'})`, `registerTools(server)`, `StdioServerTransport` only | `server.ts:12-20` |
| Transport | stdio only. No HTTP/SSE transport, no `--help`, no config flags, no env handling in `server.ts` | `server.ts:19-20` |
| Registered MCP tools | **33** (count of `server.tool(` = 33; first `claude_login` :100, last `search_code_sessions` :946) | `mcp/tools.ts:99-979`, `grep -c "server.tool("` |
| Stale tool-count claims | `server.ts:3` says "22 tools"; `mcp/tools.ts:3` says 33; `CHANGELOG.md` v1.0.0 says "25 MCP tools" | headers |
| SDK / validation | `@modelcontextprotocol/sdk` locked at 1.29.0, `zod` 3.25.76, `better-sqlite3` 12.8.0, `vis-network` 9.1.13 | `package-lock.json:1164,6213,2336,5476` |
| Registration style | 4-argument `server.tool(name, description, zodShape, handler)` for all 33. No tool annotations (`readOnlyHint`/`destructiveHint`), no `outputSchema`, no `structuredContent`, no `resources`, no `prompts` | `mcp/tools.ts:99-979` (read) |
| Return shape | every handler returns `{content:[{type:'text', text}]}` with human-formatted plain text / markdown. Errors are `isError:true` with text `Error: <message>`. No JSON, no error codes, no `source`/`completeness`/`warnings`/`ids` fields | `mcp/tools.ts:214,234,254` etc. (read) |
| Error convention | only machine-ish token is the string prefix `auth_required:` in a thrown Error | `mcp/tools.ts:87` |
| DB path | every offline tool takes optional `db_path: string`, default `path.resolve('.ccr-import.sqlite')` evaluated once at module load (CWD of the server process) | `mcp/tools.ts:45` |
| Input bounds | every numeric param is bare `z.number().optional()`: no `.int()`, `.min()`, `.max()`. Strings have no length cap | `mcp/tools.ts` (read; e.g. :116, :205-206, :568) |
| Graph module count | 10 files in `graph/` (the project docs mention 8): `analyze, build, categorize, cluster, embeddings, export, index, kmeans, query, schema` | `ls src/graph` |
| Graph size at time of design | CHANGELOG cites 1,795 conversations, 217 tool nodes, 4,761 uses-tool edges | `CHANGELOG.md` v1.0.0 (read) |
| Tests | 5 vitest files, 325 lines total; **none touches `mcp/tools.ts` or `graph/*`** (section 8) | `tests/*.ts` |

### Scope classes

- **LIVE** = calls claude.ai over the network and/or uses session cookies, Playwright login, or Claude Code session endpoints. **OUT-OF-SCOPE for GCR** (SPEC NFR-01 `SPEC.md:125`, section 9 `SPEC.md:136`: no cookie replay, no private consumer API, no unsupervised deletion).
- **OFF-R** = offline, reads the local SQLite DB (opened `{readonly:true}`).
- **OFF-W** = offline but mutates the DB or writes files.

Result: 12 LIVE (the project docs say 5), 11 OFF-R SQLite, 6 OFF-R graph, 4 OFF-W. 12 + 11 + 6 + 4 = 33.

## 2. MCP tool inventory (file order, `mcp/tools.ts`)

"Lines" = the whole `server.tool(...)` block. "Default" is the value used by the handler's `??`, not a zod `.default()` (there are no zod defaults anywhere). All offline tools also take `db_path?: string` (default above); it is omitted from the params column to save space unless it differs.

### 2.1 LIVE tools (OUT-OF-SCOPE for GCR)

| # | Tool | Lines | Params (type, default) | Returns | Implemented by | Why OUT-OF-SCOPE |
|---|---|---|---|---|---|---|
| 1 | `claude_login` | 99-108 | `headed?: boolean` (true) | text "Login successful. Session saved." | `auth/claude-login.ts` `login` | Playwright browser login, writes `~/.ccr/session.json` cookies |
| 2 | `list_conversations` | 110-134 | `query?: string` (title substring), `limit?: number` (20) | bullet list: name, URL, UUID, `Updated` | `getClient()` :66 -> `client.listConversations`; filter `extractors/search.ts` | cookie-authenticated claude.ai API |
| 3 | `get_conversation` | 136-151 | `conversation_id: string`, `format?: 'markdown'\|'json'\|'compact'` (markdown) | full primary-branch thread, formatted | `client.getConversation` -> `flattenConversation` -> `formatConversation` | live API |
| 4 | `search_conversations` | 153-180 | `query?: string` (title only), `after?: string` ISO, `before?: string` ISO, `limit?: number` (20) | bullet list with Created/Updated | `searchConversations` | live API; title match only, despite the description "or keyword" |
| 5 | `get_conversation_as_context` | 182-196 | `conversation_id: string` | compact XML (`<human>`/`<assistant>`) | as #3 with `'compact'` | live API |
| 6 | `extract_attachments` | 321-362 | `conversation_id: string` | per-attachment metadata + `extracted_content` truncated to 2000 chars | `client.getConversation`, reads `msg.attachments` via an unsafe cast (:336) | live API |
| 7 | `extract_artifacts` | 364-402 | `conversation_id: string` | artifacts created via the `artifacts` tool_use `create` command, content truncated to 3000 chars | `client.getConversation` | live API and Claude-specific (artifacts) |
| 8 | `list_projects` | 442-468 | `include_archived?: boolean` (false) | projects with docs/files counts | `client.listProjects` | live API; Claude "projects" |
| 9 | `delete_conversation` | 472-494 | `conversation_id: string`, `local_only?: boolean` (false), `db_path?` | text confirmation | `client.deleteConversation` then `deleteConversationLocal` (`importers/advanced-queries.ts:160-178`) | **destructive remote delete, no confirm/dry-run parameter** (CLI needs `--yes`, the MCP tool does not). The `local_only:true` path is offline but deletes imported originals |
| 10 | `get_code_session` | 881-906 | `session_id: string`, `format?` (markdown), `limit?: number` (1000) | session metadata + events | `api/code-session-client.ts` (Playwright `BrowserContext.request`) | Cloudflare-bypass Playwright client |
| 11 | `list_code_sessions` | 908-943 | `query?: string`, `limit?: number` (50) | sessions with status/model | same | same |
| 12 | `search_code_sessions` | 945-979 | `query: string`, `limit?: number` (20) | title-substring matches | same | same |

### 2.2 Offline SQLite read tools (OFF-R)

| # | Tool | Lines | Params (type, default) | Returns | Implemented by (file:line) |
|---|---|---|---|---|---|
| 13 | `search_sqlite` | 200-217 | `query: string` (raw FTS5 syntax), `limit?: number` (10) | per conversation: `**name** (N hits)`, URL, UUID, optional project line, up to 3 snippets (each cut to 200 chars) | `searchMessagesGrouped` `importers/sqlite-search.ts:101-135` |
| 14 | `search_entity` | 219-237 | `entity: string`, `type?: 'topic'\|'url'\|'uuid'`, `limit?: number` (10) | same grouped format | `searchByEntityGrouped` `importers/entity-search.ts:68`; entity is lower-cased before match |
| 15 | `get_conversation_messages` | 239-257 | `conversation_uuid: string` | all main-branch messages as `[created_at] sender: text`, joined by `\n---\n`; no length cap | `getMainBranch` = `getConversationTree` `importers/advanced-queries.ts:234-281` |
| 16 | `search_thinking` | 261-278 | `query: string`, `limit?: number` (10) | grouped format | `searchThinkingGrouped` `sqlite-search.ts:160` (FTS on `content_blocks` where `block_type='thinking'`) |
| 17 | `search_tool_calls` | 280-297 | `tool_name: string` (exact `=` match, not FTS), `limit?: number` (10) | grouped format | `searchByToolNameGrouped` `sqlite-search.ts:218` |
| 18 | `search_content` | 299-317 | `query: string`, `block_type?: 'text'\|'thinking'\|'tool_use'\|'tool_result'\|'voice_note'\|'token_budget'`, `limit?: number` (10) | grouped format | `searchContentGrouped` `sqlite-search.ts:283` |
| 19 | `conversation_stats` | 406-438 | none beyond `db_path` | text: conversations (total/untitled/empty/in-projects), messages by sender and avg per conversation, content-block counts by type, thinking totals, date range, last 12 months, top 10 conversations by message count, top 10 tools, entity counts by type | `getFullStats` `advanced-queries.ts:100-155`. The `profiles` aggregate in `FullStats` (:97) is computed but **not printed** |
| 20 | `audit_conversations` | 498-534 | `mode?: 'stats'\|'untitled'\|'empty'` ('stats'), `limit?: number` (50) | stats: total/untitled/empty with percentages. untitled: `uuid \| N msgs \| updated_at`. empty: `uuid \| name \| updated_at` | `getConversationStats` :75, `getUntitledConversations` :38, `getEmptyConversations` :57 |
| 21 | `get_conversation_branches` | 538-561 | `conversation_uuid: string` | header `N thread(s), M total messages, B branch point(s)` and per thread `Thread i (main\|forks at depth d): n messages, last: ts`. `forkPoint` and `firstDivergentSender` exist in the data but are not printed | `getConversationBranches` `advanced-queries.ts:313-417` |
| 22 | `get_conversation_thread` | 563-586 | `conversation_uuid: string`, `thread_index: number` (required, not constrained to int) | `[created_at] sender [shared]: text`, joined by `\n---\n`; `[shared]` marks the prefix shared with the parent thread | `getThread` `advanced-queries.ts:424-497` |
| 23 | `query_profiles` | 614-644 | `primary_type?: 'coding'\|'devops'\|'research'\|'qa'\|'general'`, `min_density?: number`, `limit?: number` (20), `order_by?: 'technical_density'\|'code_blocks'\|'tool_invocations'\|'total_words'\|'duration_minutes'` (technical_density) | one line per profile (`type=`, `density=`, `words=`, `duration=`, counts) | `getProfiles` `importers/conversation-profiler.ts:665-696` |

### 2.3 Offline graph read tools (OFF-R)

| # | Tool | Lines | Params (type, default) | Returns | Implemented by |
|---|---|---|---|---|---|
| 24 | `graph_query` | 706-732 | `keyword: string`, `depth?: number` (2) | `N nodes, M edges`, node lines (`*` marks seeds) `label [type] degree= community=`, first 30 edges only (:723); nodes are not capped | `queryGraph` `graph/query.ts:61-113` |
| 25 | `graph_god_nodes` | 734-756 | `limit?: number` (10) | top entities `label [entity_type] degree= community=` plus up to 5 "Suggested queries" | `godNodes` `graph/analyze.ts:26-41`, `suggestQuestions` :210-229 |
| 26 | `graph_neighbors` | 758-780 | `node_id: string` (exact id: entity value, `conv:<uuid>`, `tool:<name>`), `limit?: number` (20) | `-> / <-` lines with relation and weight | `getNeighbors` `graph/query.ts:115-138` |
| 27 | `graph_shortest_path` | 782-801 | `from_id: string`, `to_id: string` (exact node ids) | `Path (N hops): a -> b -> c` or "No path found" | `shortestPath` `graph/query.ts:165-216` |
| 28 | `graph_community` | 803-827 | `community_id: number` | label, cohesion, members | `getCommunity` `graph/query.ts:140-162` |
| 29 | `graph_surprising_connections` | 829-850 | `limit?: number` (10) | `a <-> b (weight, shared conversations)` | `surprisingConnections` `graph/analyze.ts:43-69` |

### 2.4 Offline mutating tools (OFF-W)

| # | Tool | Lines | Params (type, default) | Side effects | Returns | Implemented by |
|---|---|---|---|---|---|---|
| 30 | `profile_conversations` | 590-612 | `db_path?` | creates/fills `conversation_profiles` (incremental; skips already profiled) | counts, avg technical density, type distribution | `profileConversations` `importers/conversation-profiler.ts:507` |
| 31 | `rename_local_untitled_conversations` | 646-676 | `dry_run?: boolean` (false), `limit?: number` (0 = all) | **overwrites `conversations.name`** (the imported title) via `UPDATE conversations SET name = ?` (`importers/conversation-renamer.ts:191`) | list of old uuid -> new title and source (answer / topic entity / first human message) | `renameUntitled` `conversation-renamer.ts:161` |
| 32 | `graph_build` | 680-704 | `cluster_method?: 'label-propagation'\|'kmeans'` (label-propagation), `k?: number` | `extractEntities` runs `DELETE FROM entities` then re-extracts (`importers/entity-extract.ts:32`); `buildGraph` **drops and recreates** `graph_edges`, `graph_communities`, `graph_nodes` (`graph/build.ts:55-56`) and may run the profiler (:47-50); clustering rewrites `community_id` | one summary line: node/edge counts by type, communities, largest, avg cohesion | `tools.ts:690-693` calls `extractEntities`, `buildGraph`, `clusterGraph`. Does **not** call `categorizeConversations` (CLI only) |
| 33 | `graph_export` | 852-873 | `output_path?: string` ('graph.html', resolved from CWD), `seed_entity?: string`, `max_nodes?: number` (50) | writes an HTML file at any path the process can write, plus copies `vis-network.min.js` next to it, overwriting an existing file of that name (`graph/export.ts:925-927`) | `Graph exported to <path>` | `toHtml` `graph/export.ts:201-931`. The tool does not expose `seedDepth`, `entityTypes`, `minDegree`, `communityId`, `entityOnly` (they exist in `ExportOptions` :80-88 and the CLI `index.ts:1536-1543`) |

### 2.5 Cross-cutting MCP observations

1. **No allow-listed roots.** `db_path` and `output_path` are client-supplied free strings (`tools.ts:205` and many others, `:856`). A client (or a prompt-injected model) can point read tools at any SQLite file the process can open, and OFF-W tools at any path. `new Database(path)` without `readonly` creates a missing file (better-sqlite3 default; inferred, not executed), so `graph_build` on a wrong path can leave an empty file. SPEC section 7 requires "refuses to read outside approved roots".
2. **stdout noise in stdio mode (inferred, not executed).** `graph_build` and `profile_conversations` reach `console.log` calls: `importers/entity-extract.ts:72`, `graph/build.ts:48`, `graph/cluster.ts:249`, `importers/conversation-profiler.ts:539,544,548,617`. In a stdio MCP server stdout carries the JSON-RPC stream, so these lines are protocol noise. CODEX_TASK Phase 2 explicitly requires "no stdout noise in stdio mode". How a given client reacts is unverified.
3. **Unbounded output and limits.** `get_conversation_messages` / `get_conversation_thread` return whole conversations (:249-252, :577-580). A negative `limit` reaches SQLite `LIMIT ?` as a bound parameter (e.g. `sqlite-search.ts:114`); SQLite treats a negative LIMIT as "no upper bound", so `limit:-1` is an unbounded query (SQLite documented behaviour; not executed). `depth` in `graph_query` has no cap.
4. **No untrusted-data marking.** Message text, conversation titles and tool names are returned raw in tool output with no data fencing (e.g. `:249-252`). SPEC section 7 requires treating imported instructions as untrusted DATA.
5. **No provenance fields.** No tool reports where the data came from, whether the tree is complete, or which message ids back a fact.
6. **`delete_conversation` has no confirmation gate** and defaults to the remote path (`:472-494`).
7. **Import is not an MCP tool.** CCR has no MCP tool that imports an export; import is CLI-only (`import-sqlite`). So GCR's `gcr_import_export` has no MCP precedent in CCR.
8. **Enum mismatch.** `search_entity.type` allows `topic|url|uuid` (:225) but the extractor also writes `type='tool'` rows (`entity-extract.ts:64`), so tool entities cannot be filtered through this tool.
9. **Cosmetic bug.** `audit_conversations` stats mode divides by `stats.total` (:526); with zero conversations this prints `NaN%` (inferred).
10. **Lazy-import risk.** `mcp/tools.ts:37-42` imports the graph barrel, whose `export.ts:15` runs `createRequire(...).resolve('vis-network/...')` at module load. A missing `vis-network` would stop the whole MCP server at startup, including the non-graph tools (inferred).

## 3. Knowledge graph (`graph/*`)

### 3.1 Module map

| File | Lines | Role | Exposed via |
|---|---|---|---|
| `graph/schema.ts` | 62 | DDL create/drop (`createGraphSchema` :10, `dropGraphSchema` :56) | internal |
| `graph/build.ts` | 251 | `buildGraph` :35-251 | CLI `graph-build`, MCP `graph_build` |
| `graph/cluster.ts` | 312 | dispatcher `clusterGraph` :99; label propagation :33-97, :114-312 | CLI, MCP |
| `graph/kmeans.ts` | 337 | `kmeansClusterGraph` :251-337 | CLI `--method kmeans`, MCP `cluster_method` |
| `graph/query.ts` | 216 | `queryGraph` :61, `getNeighbors` :115, `getCommunity` :140, `shortestPath` :165 | queryGraph and shortestPath: CLI+MCP. getNeighbors, getCommunity: **MCP only** |
| `graph/analyze.ts` | 229 | `godNodes` :26, `surprisingConnections` :43, `topicHubs` :79, `temporalBursts` :106, `bridgeEntities` :135, `toolUsageStats` :178, `suggestQuestions` :210 | godNodes, suggestQuestions: CLI+MCP. surprisingConnections: **MCP only**. bridgeEntities, temporalBursts, toolUsageStats: **CLI only** (`graph-god-nodes --bridges/--bursts/--tools`, `index.ts:1476-1507`). `topicHubs`: no caller (grep) |
| `graph/export.ts` | 931 | `toHtml` :201 | CLI `graph-export`, MCP `graph_export` |
| `graph/categorize.ts` | 486 | `categorizeConversations` :359 (TF-IDF + k-means, or Gemini embeddings) | CLI `graph-build` (always, `index.ts:1410`) and `categorize` (`:1423-1440`). **Not in MCP** |
| `graph/embeddings.ts` | 191 | Gemini embedding client + SQLite cache | via categorize only |
| `graph/index.ts` | 24 | barrel | |

### 3.2 Schema (graph tables, `graph/schema.ts:10-54`)

Derived artifacts: dropped and rebuilt on every `buildGraph` (`build.ts:55-56`). No `PRAGMA foreign_keys` anywhere in `src/graph` or `import-sqlite.ts` (grep), so the `REFERENCES` clauses are not enforced (inferred).

`graph_nodes` (PK `id TEXT`)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | entity: lower-cased value; conversation: `conv:<uuid>`; tool: `tool:<tool_name>` (original case) (`build.ts:71,81,91`) |
| `label` | TEXT NOT NULL | conversation name or uuid; entity value; tool name |
| `node_type` | TEXT NOT NULL | `entity` \| `conversation` \| `tool` |
| `entity_type` | TEXT | `topic` \| `url` \| `uuid` \| `tool` for entity nodes; NULL for conversation/tool-node |
| `degree` | INTEGER 0 | count of incident edge rows (unweighted), `build.ts:181-186` |
| `community_id` | INTEGER | set only on entity nodes |
| `first_seen`, `last_seen` | TEXT | entity: min/max message `created_at`; conversation: `created_at`/`updated_at`; tool: NULL (`build.ts:188-208`) |
| `meta` | TEXT (JSON) | conversation profile metrics (`build.ts:210-233`) |
| `tool_count`, `tool_names` | INTEGER, TEXT (JSON array) | conversation nodes only (`build.ts:129-142`) |
| `category` | TEXT | set twice with different meanings: profile `primary_type` (`build.ts:216`), later overwritten by the categorize cluster label (`categorize.ts:459-471`) |

Indexes: `idx_gn_type(node_type)`, `idx_gn_community(community_id)`, `idx_gn_degree(degree DESC)`.

`graph_edges` (PK autoincrement `id`, `UNIQUE(source_id, target_id, relation)`)

| Column | Type | Notes |
|---|---|---|
| `source_id`, `target_id` | TEXT NOT NULL | node ids |
| `relation` | TEXT NOT NULL | `co_occurs` \| `mentioned_in` \| `uses_tool` |
| `confidence` | TEXT NOT NULL | the only value ever written is `'EXTRACTED'` (`build.ts:111,122,170,174`; grep finds no `INFERRED`/`AMBIGUOUS` elsewhere) |
| `weight` | REAL 1.0 | incremented by the upsert `ON CONFLICT ... DO UPDATE SET weight = weight + excluded.weight` (`build.ts:61-65`) |
| `conversation_uuid`, `message_uuid` | TEXT | provenance of the **first** insert only; later upserts keep the first values (inferred from the upsert, which updates only `weight`) |

Indexes: `idx_ge_source`, `idx_ge_target`, `idx_ge_relation`, `idx_ge_conv`.

`graph_communities` (PK `id INTEGER`): `node_count`, `cohesion_score REAL`, `top_entities TEXT` (JSON array of up to 5 labels), `label TEXT` (top 3 labels joined by ", ").

Upstream tables the graph reads (from `importers/import-sqlite.ts:54-153`): `conversations(uuid, name, summary, created_at, updated_at, account_uuid, project_uuid)`, `messages(uuid, conversation_uuid, sender, text, created_at, updated_at, parent_message_uuid, attachments, files)`, `content_blocks(id, message_uuid, conversation_uuid, block_index, block_type, text_content, tool_name, tool_use_id, tool_input, is_error, meta)`, `entities(entity, type, message_uuid, conversation_uuid, PK(entity,type,message_uuid))`, plus `conversation_profiles` (`conversation-profiler.ts:290-330`) and optionally `conversation_embeddings` (`embeddings.ts:31-40`).

### 3.3 Node types, edge types, build steps (`graph/build.ts`)

Node types: `entity`, `conversation`, `tool` (the docs say three; the code has a fourth concept, see collision note).

| Edge relation | Endpoints | Weight | Where |
|---|---|---|---|
| `co_occurs` | entity <-> entity, any two entities in the same message; stored once with lexicographic id order | number of messages sharing the pair | `build.ts:163-172` |
| `co_occurs` | tool <-> tool, any two tools used in the same conversation | number of conversations | `build.ts:117-125` |
| `mentioned_in` | entity -> conversation | number of messages in that conversation mentioning the entity | `build.ts:173-175` |
| `uses_tool` | conversation -> tool | number of `tool_use` calls | `build.ts:97-113` |

Steps: 1 conversation nodes; 2 entity nodes (`SELECT DISTINCT entity, type`); 3 tool nodes from `content_blocks.tool_name`; 4 uses_tool + tool co_occurs; 5 conversation tool metadata; 6 entity co_occurs + mentioned_in; 7 degree; 8 temporal; 9 profile enrichment.

Entity extraction feeding the graph (`importers/entity-extract.ts:11-15,28-73`): three regexes (uuid, `https?://...` url, topic) plus one `tool` entity per `tool_use` block (:63-65); values are lower-cased (:22,:64). The **topic list is a fixed, personal vocabulary** (includes terms such as `led`, `dmx`, `grandma`, `ma2`, `invoice`), so topics are not general. The URL regex `[\w.-]+[\w/\-?&=.%#]+` cannot match `<`, `>`, quotes, which limits (but does not remove) HTML-injection risk from URL entities.

Quirks found in the build (all inferred from code, not executed):

1. **Per-fact provenance is lost.** Because edges are unique on `(source, target, relation)` and the upsert only adds weight, each edge keeps only the first `conversation_uuid`/`message_uuid`. GCR NFR-08 ("trace every graph fact to message/branch IDs", `SPEC.md:132`) cannot be met with this model.
2. **`shared_conversations` in `surprisingConnections` is always 1** (`analyze.ts:52,61`): it groups by `(source_id,target_id)` over `relation='co_occurs'`, which is unique per pair, so `COUNT(DISTINCT conversation_uuid)` counts one row. The ordering therefore reduces to `weight`.
3. **Entity/tool id collision.** `INSERT OR IGNORE` is keyed by `id` only (`build.ts:59,81`). If the same lower-cased string occurs under two entity types (for example a topic and a tool name) only the first type survives, while `entityNodes` counts both `DISTINCT (entity,type)` rows (:241), and a same-string pair in one message would produce a self-loop edge (:169-170). Whether this occurs in real data is unverified.
4. **Tool is represented twice**: as entity nodes with `entity_type='tool'` (from the `entities` table) and as `tool:<name>` nodes with `node_type='tool'`. Export balancing uses `entity_type='tool'` (`export.ts:289`), analytics use `node_type='tool'` (`analyze.ts:181-192`).
5. **Dead feature in k-means.** The `tool_assoc` dimension counts `co_occurs` edges whose target is a `node_type='tool'` node (`kmeans.ts:214-217`), but `co_occurs` edges only join entity-entity or `tool:`-`tool:` pairs (`build.ts:122,170`), so for entity sources `tool_assoc` is always 0 and the "7D" vector is effectively 6D.
6. `buildGraph` silently runs the profiler first when `conversation_profiles` is empty or missing (`build.ts:36-50`), i.e. a graph build can write to a table the user did not mention.

### 3.4 Clustering (`graph/cluster.ts`, `graph/kmeans.ts`)

| Method | Population | Algorithm (read) | Parameters | Determinism |
|---|---|---|---|---|
| `label-propagation` (default) | entity nodes, `co_occurs` edges only (`cluster.ts:117-123`) | each node adopts the neighbor label with the highest summed edge weight; random visit order per iteration; stop at <1% changes or 25 iterations (:33-97). Communities sorted by size and numbered from 1 (:137,:182). Then communities with more than 200 nodes are split: remove the top 5% by degree, re-run label propagation on the rest, re-attach the removed nodes to their strongest neighbor community (:205-298) | `maxIterations=25`, `maxCommunitySize=200` | **non-deterministic**: `Math.random` shuffle (:52-57) and random pair sampling for cohesion when a community has >200 members (:145-158) |
| `kmeans` | entity nodes only | k-means++ init, Lloyd iterations (max 100), Euclidean distance; auto-k tries k=2..min(20, floor(sqrt(n))) once per k and keeps the best silhouette (sample of 500) (`kmeans.ts:251-283`) | `--k`, 7 features: `[degree/max, is_topic, is_url, is_uuid, tool_assoc/max, first_seen scaled, conv_reach/max]` (:204-248) | **non-deterministic** (`Math.random` in init and silhouette sample) |

Notes: `cohesion_score` for every k-means community is the single global silhouette value (`kmeans.ts:319`), not a per-community score. Label propagation `avgCohesion` is averaged from the pre-split communities (`cluster.ts:175-186,308`). Conversation and tool nodes never get a `community_id`. Isolated entities become singleton communities (inferred).

`categorize.ts` (CLI only, run by `graph-build`): k-means over conversations (k=5..15 auto, silhouette sample 300, `categorize.ts:435-444`), labels from title terms and a hard-coded tool-category map (:50-58). Features are TF-IDF (vocabulary max 500, min df 2, max df 80%, :100-146) or, **if `GOOGLE_API_KEY` or `GEMINI_API_KEY` is set, Gemini `gemini-embedding-001` embeddings** (:384-401, `embeddings.ts:24,147-151`).

**Network and privacy finding (read):** with either env var present, `graph-build` (and `categorize`) sends per conversation `title | first human message (first 1000 chars) | topics`, truncated to 2000 chars (`categorize.ts:347-355,371-373,397-400`), to Google's Generative AI API via `batchEmbedContents` (`embeddings.ts:100`) with no prompt or confirmation. The trigger is the environment variable alone. This is **OUT-OF-SCOPE for GCR** (SPEC NFR-06: "no hosted vector indexing by default"). The local TF-IDF fallback is the only portable part. MCP `graph_build` never calls it.

### 3.5 Query and analysis functions

| Function | What it does (read) | Parameters/limits | Notes |
|---|---|---|---|
| `queryGraph` `query.ts:61-113` | seeds = up to 20 nodes where `lower(label) LIKE %kw%` or `lower(id) LIKE %kw%`; BFS `depth` hops over undirected edges; returns induced subgraph | `depth` default 2, no cap; seeds `LIMIT 20` | `%` and `_` in the keyword are not escaped (they act as LIKE wildcards); `lower()` is ASCII-only in SQLite. `IN (${placeholders})` is built from the whole frontier (and passed twice, :79-81), so very large frontiers can exceed SQLite's bound-variable limit (inferred, not executed) |
| `getNeighbors` `:115-138` | outgoing + incoming edges for one id, each `ORDER BY weight DESC LIMIT n`, then `.slice(0, limit)` | limit 20 | the concatenation is not re-sorted, so incoming edges are dropped whenever outgoing already fills the limit |
| `getCommunity` `:140-162` | community meta + members by degree | | |
| `shortestPath` `:165-216` | unweighted BFS over undirected edges with parent map; `from==to` returns length 0 | none (no max depth) | requires exact node ids although CLI text says "entities"; prepares one statement per visited node (N+1 queries) |
| `godNodes` `analyze.ts:26-41` | entity nodes ordered by `degree` desc | topN 10 | degree includes `mentioned_in` edges to conversations, so it mixes co-occurrence breadth and conversation reach |
| `bridgeEntities` `:135-162` | entity nodes whose `co_occurs` neighbors span >= 3 other communities | HAVING `communities_connected >= 3` hard-coded, topN 10 | CLI only |
| `temporalBursts` `:106-125` | per entity and `strftime('%Y-W%W')` week, count of entity rows; `HAVING mentions >= 5` | limit 20 | "burst" = absolute weekly count >= 5, not relative to an entity baseline; CLI only |
| `surprisingConnections` `:43-69` | `co_occurs` entity pairs in different communities, ordered by `shared_conversations` then weight | limit 10 | see quirk 2 above; MCP only |
| `topicHubs` `:79-97` | topic entities by distinct conversation count | topN 10 | no caller |
| `toolUsageStats` `:178-208` | top tools by total calls, conversations with the most tool variety | limit 10 | CLI only |
| `suggestQuestions` `:210-229` | templated strings built from the top god nodes | limit 5 | not LLM-generated |

All query functions open the DB `{readonly:true}` and use bound parameters (no string-interpolated user data besides placeholder lists).

### 3.6 HTML export (`graph/export.ts`)

**Libraries and network.** The only library is `vis-network` 9.1.13 (`standalone/umd/vis-network.min.js`), resolved from `node_modules` at import time (`export.ts:11-15`) and **copied next to the output file** as `vis-network.min.js` (:926-927). The page loads it with a relative `<script src="vis-network.min.js">` (:433). There is **no CDN, no web font, no `fetch/XMLHttpRequest/WebSocket/sendBeacon` and no hard-coded `http` literal** in `export.ts` (grep). The only outbound traffic is user-initiated navigation to `https://claude.ai/chat/<uuid>` (`links.ts:CLAUDE_BASE`, `export.ts:576,632,778,788,829,877`). Consequences: the page works offline, but moving `graph.html` without the sidecar file leaves a blank graph (inferred), and the export silently overwrites any existing `vis-network.min.js` in the target directory.

**Licensing of the bundled library.** `vis-network` `package.json` on the GitHub default branch declares `"license": "(Apache-2.0 OR MIT)"` (https://raw.githubusercontent.com/visjs/vis-network/master/package.json, accessed 2026-10-10). That is the default branch, not the 9.1.13 tag, so the exact license at the locked version is unverified. `unpkg.com` was blocked by the egress proxy (403), so I could not fetch the published package.

**Layout.** Fruchterman-Reingold, 200 iterations, O(n^2) per iteration, seeded by community centroids with `Math.random` jitter (`export.ts:103-199`, jitter :131-134), then nodes are `fixed:true` (:398). Output positions differ on every export. Default node budget is 50 in CLI and MCP (`index.ts:1536`, `tools.ts:858`) and 200 in the function default (`export.ts:204`).

**Node selection.** With a seed: BFS from up to 10 seeds to `seedDepth` (default 2) capped at `maxNodes` (:214-249). Without filters: fixed quota per category (topic 30%, tool 25%, conversation 25%, url 15%, uuid 5%, :287-293). With filters: top-N by degree.

**Features.** Sidebar listing all conversations (first 200 rendered, filter box), click focuses the graph node, entity/tool double-click filters the sidebar, right-click context menu, detail panel, 5 color modes (community, timeline, entity type, category, profile type), type checkboxes, min-degree and min-weight sliders, physics toggle, `#node=<id>` hash navigation (:905-920).

**Security findings (all read from source; I did not open the page in a browser).**

| # | Finding | Evidence | Severity (my assessment) |
|---|---|---|---|
| S1 | Data is embedded in an inline `<script>` with plain `JSON.stringify`, which does not escape `<`, so any value containing `</script>` terminates the script element. I confirmed `JSON.stringify({label:'</script><img src=x onerror=alert(1)>'})` keeps the literal `</script>` (scratch script). Embedded fields: node ids/labels/titles (entity values, conversation names, tool names, conversation `summary`) and the full `conversations` list (uuid, name) | `export.ts:572-575` | High for untrusted exports. Conversation titles and tool names come from the imported file and are not restricted by the entity regexes |
| S2 | DOM XSS in the detail panel: `n.title` (contains raw `n.label`, `n.entity_type`, and `n.summary`) is concatenated into an HTML string with only `\n` -> `<br>` replacement and assigned via `innerHTML` | `export.ts:394,795,813` | High (click a crafted node) |
| S3 | `uuid` values are placed unescaped into an HTML attribute and into `href`s: `data-uuid="'+c.uuid+'"` and `CLAUDE_BASE+'/chat/'+c.uuid` (sidebar), `n._convUuid`, per-entity `uuid` lists | `export.ts:627,632,778,788` | Medium (ids come from the DB, but the DB is built from an untrusted file) |
| S4 | `escHtml` escapes `& < > "` but not `'` | `export.ts:639-641` (confirmed by scratch script) | Low (used only in text-node contexts today) |
| S5 | No Content-Security-Policy meta tag | grep: no `content-security` | Defense-in-depth gap |
| S6 | `target="_blank"` links and `window.open(...)` without `rel="noopener noreferrer"` / `noopener` | `export.ts:632,778,788,829,877` | Low (destination is claude.ai) |
| S7 | `decodeURIComponent` of the hash can throw `URIError` on malformed input and is uncaught | `export.ts:910` | Low |
| S8 | Positive: sidebar names, category badge, neighbor labels, and the panel title use `escHtml`/`textContent` | `export.ts:629,779,788,809,771` | n/a |
| S9 | Tooltips: vis-network documents a **string** `title` as plain text and an Element for HTML (https://raw.githubusercontent.com/visjs/vis-network/master/docs/network/nodes.html lines 1606-1614, accessed 2026-10-10), so the `title:` strings at `export.ts:394,417` are not the XSS vector. The runtime implementation (`Popup` in `vis-util`, called from `InteractionHandler.js`) was **not** read | | unverified at code level |

**Accessibility findings (grep + read; contrast computed with the WCAG formula in the scratch script).** This does not meet GCR NFR-04 ("graph HTML navigable without inaccessible mouse-only operations", `SPEC.md:128`):

- No `aria-*`, `role=`, `tabindex`, `prefers-reduced-motion`/`prefers-color-scheme`, or viewport meta anywhere in the template (grep). `<html lang="en">` is present (:429).
- Graph canvas: `interaction.keyboard` is not set (:590); the vis-network default is `keyboard: false` (https://raw.githubusercontent.com/visjs/vis-network/master/docs/network/interaction.html line 174, accessed 2026-10-10). Pan/zoom/select is pointer-only.
- Mouse-only actions with no keyboard equivalent: right-click context menu (:848-870), double-click to open or filter (:825-838), the close control is a click-only `<span>` (:567), conversation rows are clickable `<div>`s (:627), context-menu items are `<div>`s (:858-864).
- Unlabelled controls: the node search input, sidebar filter and `#color-mode` `<select>` rely on placeholder or nothing (:514,:516,:561). Only the five type checkboxes have `<label>`.
- `outline:none` on `#conv-search:focus` (:472); focus is shown only by a border colour change.
- Low contrast: `#666` on `#16213e` = 2.77:1 and `#666` on `#1a1a2e` = 2.97:1 (below the 4.5:1 AA minimum for small text) for `.conv-date`, `#conv-count`, `.ctrl-label`, legend text (:464,:473,:482,:529-530); `#aaa` on `#16213e` = 6.84:1 passes.
- Colour as the main community encoding (10-colour palette, :93-97); shape encodes only type.
- Live counts (`#stats`, `#conv-count`) are not in an `aria-live` region.

**Other export defects (inferred):** the min-weight slider runs 0-50 (:554) but edges are hidden when `width*width < minWeight` with `width <= 4` (:737,:419), so any value above 16 hides every edge. The "profile type" colour mode keys on `_category` values like `coding`, but the CLI `graph-build` overwrites `category` with cluster labels (`categorize.ts:459-471`), so that mode only works when categorize has not run.

## 4. Test coverage

| Capability | Test? | Evidence |
|---|---|---|
| Any of the 33 MCP tool handlers, `registerTools`, `server.ts` | **No** | no test imports `mcp/tools.js` or `server.js` (`grep "from '\.\."` over `tests/`) |
| `searchMessagesGrouped` (used by `search_sqlite`) | Yes, 3 cases: grouped result shape, no hits, hit_count ordering | `tests/sqlite-search-grouped.test.ts:84-110` |
| `searchByEntityGrouped` (used by `search_entity`) | Yes, 1 case | `tests/sqlite-search-grouped.test.ts:112-119` |
| `searchContentGrouped`, `searchThinkingGrouped`, `searchByToolNameGrouped` | **No**: `searchContentGrouped` is imported (:13) but never called; the other two are not imported | same file |
| Branches/threads/stats/audit (`advanced-queries.ts`) | **No** | no test imports it |
| Entity extraction, profiler | **No** | |
| `renameUntitled` | Only the pure helper `extractTitle` (10 cases) | `tests/extractTitle.test.ts` |
| Any `graph/*` function (build, cluster, kmeans, query, analyze, export, categorize) | **No** | no test imports `graph/` |
| Auth, errors, links | Yes (`session.test.ts`, `errors.test.ts`, `links.test.ts`) | out of scope for GCR |

Other test/CI facts:

- `package.json:19` has `"test": "vitest run"`. I did not execute it (no `node_modules` in the CCR checkout). `CLAUDE.md` says "no automated tests", which is stale.
- No `.github/workflows` directory (only `agents/`, `instructions/`, `copilot-instructions.md`), so no CI. Local git hooks only: `.githooks/pre-commit` runs typecheck, lint and `npm test`; `.githooks/pre-push` runs typecheck, lint, build and warns when the documented MCP tool count differs from the code (`.githooks/pre-push:25-34`).
- The test DB is created in `os.tmpdir()` and never deleted (`unlinkSync`/`writeFileSync` are imported but unused, `tests/sqlite-search-grouped.test.ts:10`).
- No real MCP-client smoke test, no property tests, no fixtures for graph behaviour. This matches the gap CODEX_TASK Phase 3 asks GCR to close.

## 5. Mapping: CCR MCP tool or graph capability to GCR target

GCR targets (SPEC section 7): read tools `gcr_list`, `gcr_get`, `gcr_search`, `gcr_branches`, `gcr_thread`, `gcr_stats`, `gcr_audit`, `gcr_graph_query`; write tools `gcr_create_local_draft`, `gcr_update_local_annotation`; and `gcr_import_export` (explicit local path). "none" = no GCR target. A "(mode)" means the capability should be a parameter or mode of the target tool rather than a separate tool, since SPEC lists a single graph tool.

### 5.1 Per CCR MCP tool

| # | CCR tool | Class | GCR target | Notes / gap |
|---|---|---|---|---|
| 1 | `claude_login` | LIVE/AUTH | **none** | OUT-OF-SCOPE (browser login, cookies) |
| 2 | `list_conversations` | LIVE | `gcr_list` | feature only; GCR lists local imported data with `provider`, `limit`, pagination; CCR has only title filter |
| 3 | `get_conversation` | LIVE | `gcr_get` | GCR adds URL/UUID input, `NOT_IN_LOCAL_EXPORT` error, `--all-branches`; CCR returns primary branch only |
| 4 | `search_conversations` | LIVE | `gcr_list` (title/date filters) | title-only in CCR; body keyword search belongs to `gcr_search` |
| 5 | `get_conversation_as_context` | LIVE | `gcr_get` (compact format) | same data, `compact` output; must wrap content as untrusted data |
| 6 | `search_sqlite` | OFF-R | `gcr_search` | main parity target: FTS5, grouped by conversation, hit count, 3 snippets. GCR needs pagination (offset/cursor), stable tie-break (CCR orders only by `hit_count`, `sqlite-search.ts:113`), Unicode tests, malformed-query error code |
| 7 | `search_entity` | OFF-R | `gcr_graph_query` (entity-lookup mode) or `gcr_search` entity filter | SPEC has no entity-search tool; decide in an ADR. CCR's `type` enum omits `tool` |
| 8 | `get_conversation_messages` | OFF-R | `gcr_get` (default active branch) | GCR should use the export's `current_node`, not "last child by `created_at`" (CCR heuristic, `advanced-queries.ts:263-273`); add output limits |
| 9 | `search_thinking` | OFF-R | `gcr_search` (block-type filter) | only for block types actually present in the ChatGPT export; hidden reasoning must not be fabricated (CODEX_TASK Phase 1). Whether an official export carries reasoning blocks is unverified |
| 10 | `search_tool_calls` | OFF-R | `gcr_search` (tool filter) | exact tool-name match; GCR needs the export's recipient/tool field mapping (unverified) |
| 11 | `search_content` | OFF-R | `gcr_search` (block-type filter) | CCR block types are Claude's (`text, thinking, tool_use, tool_result, voice_note, token_budget`); GCR uses the provider-neutral `blocks[].type` |
| 12 | `extract_attachments` | LIVE | **none** as implemented | live fetch is OUT-OF-SCOPE; attachment **metadata** from the export maps to `gcr_get` / `gcr_search` (FR-15, P2) |
| 13 | `extract_artifacts` | LIVE | **none** | Claude artifacts; no ChatGPT equivalent specified |
| 14 | `conversation_stats` | OFF-R | `gcr_stats` | add `group_by` (model/role/channel/day, FR-11); CCR has none. Model must be "known vs unknown", never inferred |
| 15 | `list_projects` | LIVE | **none** | Claude projects; ChatGPT project data in exports is unverified |
| 16 | `delete_conversation` | LIVE + local | **none** | SPEC section 9 forbids unsupervised deletion; imported originals stay immutable (`SPEC.md:94`). If "hide" is wanted, model it as a `gcr_update_local_annotation` flag |
| 17 | `audit_conversations` | OFF-R | `gcr_audit` | CCR modes: stats/untitled/empty. GCR adds `missing-model` (`SPEC.md:109`), and must avoid the `NaN%` on empty DBs |
| 18 | `get_conversation_branches` | OFF-R | `gcr_branches` | CCR thread ids are positional BFS indexes (`advanced-queries.ts:367-396`); GCR needs stable `branch-id`, cycle detection, deterministic tie handling. Expose `forkPoint` and `firstDivergentSender`, which CCR computes but does not print |
| 19 | `get_conversation_thread` | OFF-R | `gcr_thread` | keep the `[shared]` prefix marker; take `branch-id`, not an index |
| 20 | `profile_conversations` | OFF-W | **none** | mutating derived table, not in the GCR target list; closest read surface is `gcr_stats` |
| 21 | `query_profiles` | OFF-R | **none** (partial `gcr_stats`) | profiles are regex heuristics over Claude-style content |
| 22 | `rename_local_untitled_conversations` | OFF-W | `gcr_update_local_annotation` (title annotation) | CCR overwrites the imported title in place; GCR must keep annotations in a separate `local_annotations` store (`SPEC.md:94`) |
| 23 | `graph_build` | OFF-W | **none** as MCP tool (CLI `gcr graph build`) | SPEC lists only a read graph tool. Port the deterministic local pipeline; no auto-profiler side effect; no destructive `DELETE FROM entities` outside a transaction |
| 24 | `graph_query` | OFF-R | `gcr_graph_query` | BFS neighborhood, default depth 2 matches `SPEC.md:111`; add depth cap, LIKE escaping, provenance ids |
| 25 | `graph_god_nodes` | OFF-R | `gcr_graph_query` (mode) | |
| 26 | `graph_neighbors` | OFF-R | `gcr_graph_query` (mode) | |
| 27 | `graph_shortest_path` | OFF-R | `gcr_graph_query` (mode) | accept labels as well as ids |
| 28 | `graph_community` | OFF-R | `gcr_graph_query` (mode) | |
| 29 | `graph_surprising_connections` | OFF-R | `gcr_graph_query` (mode) | fix the always-1 `shared_conversations` |
| 30 | `graph_export` | OFF-W | **none** as MCP tool (CLI graph export) | SPEC FR-12 wants "offline interactive export" with "safe HTML escaping"; as an MCP tool it would need a fixed output root. Fix S1-S7 and accessibility items first |
| 31 | `get_code_session` | LIVE | **none** | OUT-OF-SCOPE, Playwright/Cloudflare |
| 32 | `list_code_sessions` | LIVE | **none** | OUT-OF-SCOPE |
| 33 | `search_code_sessions` | LIVE | **none** | OUT-OF-SCOPE |

### 5.2 Reverse view: GCR target to closest CCR source

| GCR target | Closest CCR source | Gap GCR must close |
|---|---|---|
| `gcr_list` | `list_conversations`, `search_conversations` (LIVE) | CCR has no offline list tool; need `provider`, pagination, date filters, `source`/`completeness` fields |
| `gcr_get` | `get_conversation_messages` (offline), `get_conversation` (LIVE) | formats (markdown/json/compact), URL parse (FR-01), `NOT_IN_LOCAL_EXPORT`, all-branches, block-level output |
| `gcr_search` | `search_sqlite`, `search_content`, `search_thinking`, `search_tool_calls` | one tool with filters instead of four; pagination; stable sort; FTS error code |
| `gcr_branches` | `get_conversation_branches` | stable branch ids; active branch from `current_node`; cycle-safe |
| `gcr_thread` | `get_conversation_thread` | branch id input; shared-prefix flag kept |
| `gcr_stats` | `conversation_stats` | `group_by`, model known/unknown |
| `gcr_audit` | `audit_conversations` | `--missing-model`; structured output |
| `gcr_graph_query` | `graph_query` + 5 other graph read tools | single tool with modes; provenance-linked facts (NFR-08); deterministic results |
| `gcr_create_local_draft` | **none** (no draft concept in CCR) | new in GCR; local only, audit trail, no remote send |
| `gcr_update_local_annotation` | `rename_local_untitled_conversations` (behavioural precedent only) | separate annotation store, never overwrite originals |
| `gcr_import_export` | **none in MCP**; CLI `import-sqlite` only | explicit path, approved roots, ZIP safety, idempotent re-import |

### 5.3 Graph capability mapping

| CCR graph capability | Source | GCR placement | Notes |
|---|---|---|---|
| Node types entity/conversation/tool | `build.ts` | `gcr graph build` data model | keep, but fix the double representation of tools (quirk 4) |
| Edge types co_occurs / mentioned_in / uses_tool | `build.ts` | same | add per-occurrence provenance rows instead of first-insert-only |
| Regex entities (uuid, url, topic) + tool entities | `entity-extract.ts` | same | CCR topic list is personal; GCR needs configurable/neutral topics and timestamps/keywords per CODEX_TASK |
| Label propagation + oversize split | `cluster.ts` | same | needs a seeded PRNG or deterministic order (NFR-02) |
| K-means 7D + silhouette auto-k | `kmeans.ts` | optional | `tool_assoc` dimension is dead; seed the RNG |
| Conversation categorize TF-IDF | `categorize.ts` | optional, local only | portable part |
| Conversation categorize via Gemini embeddings | `categorize.ts`, `embeddings.ts` | **none** | OUT-OF-SCOPE: sends text to a third party |
| God nodes / suggested queries | `analyze.ts` | `gcr_graph_query` mode | |
| Bridge entities, temporal bursts, tool usage stats | `analyze.ts` (CLI only) | `gcr_graph_query` modes or `gcr_stats` | CCR burst = count >= 5 per week |
| Surprising connections | `analyze.ts` (MCP only) | `gcr_graph_query` mode | |
| BFS query, neighbors, community, shortest path | `query.ts` | `gcr_graph_query` | |
| Interactive HTML (vis-network, sidebar, deep links) | `export.ts` | CLI export (no MCP tool in SPEC) | no CDN, sidecar lib is the right offline model; fix S1-S7; keyboard-accessible alternative needed; deep links go to `chatgpt.com` only if the user opts in |

## 6. Design notes for GCR that follow from these findings

Recommendations (mine), each tied to a cited finding and to a SPEC/CODEX_TASK line:

1. No client-supplied filesystem paths on MCP tools; fix the DB at server start and use approved roots for `gcr_import_export` (finding 2.5.1; `SPEC.md:121`).
2. Never write to stdout in `gcr mcp`; log to stderr only; add a real SDK-client smoke test (finding 2.5.2; CODEX_TASK Phase 2/3).
3. Zod schemas with `.int().min().max()` on all limits and `depth`; page size and byte caps on message-returning tools (finding 2.5.3).
4. Return structured JSON with `source`, `completeness`, `warnings`, `ids`, `error.code`, and wrap message text as untrusted data (finding 2.5.4-5; `SPEC.md:121`). Add tool annotations (`readOnlyHint`, `destructiveHint`) to every tool.
5. Graph facts must carry occurrence-level provenance (message ids and branch ids), not first-insert-only (finding 3.3 quirk 1; NFR-08).
6. Graph algorithms need a seeded RNG or deterministic ordering; add golden-file tests (3.4; NFR-02).
7. HTML export: escape `<` in embedded JSON (or use `<script type="application/json">` read with `textContent`), build DOM with `textContent` instead of `innerHTML`, validate ids used in `href`/attributes, add a CSP meta tag and `rel="noopener noreferrer"`, bundle the library without CDN, and provide keyboard access and a non-colour encoding (3.6 S1-S7 and accessibility list; NFR-04).
8. Never auto-call an embedding service from an environment variable (3.4; NFR-06).

## 7. Unverified or not examined

- I did not run any CCR code, CCR tests, or the generated HTML in a browser. All "inferred" items above are reasoning from source and may differ at runtime.
- Not read in full: `mcp`-adjacent live modules `api/client.ts`, `api/code-session-client.ts`, `auth/*`, `extractors/*` (only call sites), `importers/conversation-profiler.ts` (regex categories, only DDL and entry points), `importers/import-sqlite.ts` beyond lines 40-160, `importers/conversation-renamer.ts` beyond lines 31 and 161-200.
- vis-network: the `Popup.setText` implementation in `vis-util` was not fetched (so S9 rests on the documentation only). The 9.1.13 tag's license file was not read (master `package.json` only). unpkg.com was unreachable (proxy 403); the GitHub API was not available to this session.
- How MCP clients react to non-JSON-RPC lines on stdout (finding 2.5.2) is unverified; so is the SQLite bound-variable limit actually being hit by `queryGraph` on a realistic graph.
- The ChatGPT export schema was not examined in this task (out of scope), so the mappings that mention `current_node`, recipient/tool fields, reasoning blocks, attachments and projects are based on the GCR spec text only and need confirmation against the ChatGPT-export research file.
- The CCR checkout's `CLAUDE.md` and `README.md` tool lists were not reconciled line by line; counts here come from the code.
