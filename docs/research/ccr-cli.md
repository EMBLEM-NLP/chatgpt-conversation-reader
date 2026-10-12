---
title: CCR CLI Command Inventory (feature and data-shape parity input for GCR)
description: Read-only inventory of every CLI command registered by CCR src/index.ts at commit f66e24e, with options, defaults, source file:line, implementing module, network/auth flags, output formats and a CCR-to-GCR mapping table.
version: 1.0.0
created: 2026-10-10T22:07:23Z
last_updated: 2026-10-10T22:07:23Z
---

# CCR CLI command inventory

Scope: features and data shapes only. No CCR code is copied or proposed for copying (CCR has no LICENSE file; `package.json:31` says `"license": "ISC"`).
Date accessed: 2026-10-10. No web sources were used; every fact below is from the local CCR checkout.

- CCR checkout: `<ccr-checkout>`, `git rev-parse HEAD` = `f66e24e06b15e75060a65b2bf9b646395ddac0d1` (commit subject "wip: code-session probing helpers + profiler improvements").
- Path prefix used below: `src/...` means `<checkout>/src/...`. Line numbers refer to that commit.
- GCR target command list is from `<gcr-checkout>/SPEC.md:96-117` (section 6, command block at :99-114). Only read, not edited.
- Nothing in CCR was modified. The only code I executed was a scratch copy of `formatter.ts` under the research scratchpad (`scratchpad/fmtcheck/`) to confirm the invalid-`--format` behaviour.

## 1. Headline facts

| Fact | Value | Evidence |
|---|---|---|
| Binary name | `ccr` (Commander.js) | `src/index.ts:85`; `package.json:7-9` (`bin.ccr = dist/index.js`) |
| Dev invocation | `npm run dev -- <command>` (tsx) | `package.json:11` |
| Registered commands | **49** | `grep -c "^  \.command("` on `src/index.ts` = 49 (first at line 92, last at line 1928) |
| Stale count claims | `src/index.ts:4` header says "39 commands"; `CHANGELOG.md` says "28 CLI commands" (v1.0.0) | the header and changelog are out of date |
| Commander version string | `0.1.0` | `src/index.ts:87` (`package.json:3` is `1.0.0`; `src/index.ts:5` header says `1.11.0`) |
| Global options | none beyond Commander built-ins (`-V/--version`, `-h/--help`) | `src/index.ts:84-87` |
| Env loading | `import 'dotenv/config'` loads `.env` from CWD | `src/index.ts:10` |
| Env vars read | `SESSION_PATH` (`src/auth/session.ts:13`), `GOOGLE_API_KEY` / `GEMINI_API_KEY` (`src/graph/categorize.ts:384`), `PDFTOPPM_PATH` (`src/importers/speaker-image-extractor.ts:28`), Windows paths (`src/auth/cookie-grabber.ts:56-80`) | grep of `process.env` |
| Default DB path | `.ccr-import.sqlite` in CWD. It is a default only for `import-local-sessions`, `get-code-session`, `import-code-session` (`--db`) and the MCP server (`src/mcp/tools.ts:45`). Every other offline command requires `<dbPath>` as a positional argument. | `src/index.ts:462,502,553` |
| Session file | `~/.ccr/session.json` (overridable by `SESSION_PATH`); loading is refused if the path is inside the project tree | `src/auth/session.ts:13-15`, `:19-30` |
| MCP server | NOT a CLI subcommand. Separate entry point `src/server.ts` (20 lines, stdio), run by `npm run dev:server` / `start:server`. 33 tools registered in `src/mcp/tools.ts` (first `claude_login` at :100, last `search_code_sessions` at :946). `server.ts:3` header still says "22 tools". | `package.json:12,15`; `src/server.ts:9-20` |
| Tests | `package.json:19` has `"test": "vitest run"`; `tests/` holds 5 files (errors, extractTitle, links, session, sqlite-search-grouped). None exercise CLI commands. `CLAUDE.md` says "no automated tests", which is stale. | `ls tests` |

### Output formats

- Three formats exist: `markdown` (default), `json`, `compact` (`type OutputFormat = 'markdown' | 'json' | 'compact'`, `src/types.ts:115`). Implemented by `formatConversation()` at `src/extractors/formatter.ts:17-29`.
  - `markdown`: `# title`, then `**ID:**`, optional `**Model:**`, `**Created:**`, `**Messages:**`, `---`, then per message `### **Human**|**Assistant** — <time>` + text + `---` (`formatter.ts:31-55`). Time is `new Date(ts).toLocaleString()` (`:45`), so it is locale and timezone dependent, not deterministic.
  - `json`: `JSON.stringify(LinearConversation, null, 2)` (`:25`). Shape `{uuid, title, model?, created_at, messages:[{role, text, timestamp, uuid}]}` (`src/types.ts:100-113` for `LinearMessage` and `LinearConversation`).
  - `compact`: `<conversation title=".." id=".."><human>..</human><assistant>..</assistant></conversation>` with XML escaping of `& < > "` (`formatter.ts:57-73`).
- Only **two** CLI commands accept a format flag: `get` (`src/index.ts:355`) and `read-session` (`:225`). Every other command prints chalk-coloured human text to stdout; there is **no `--json` output mode** for `list`, `search*`, `stats`, `audit`, `branches`, `thread`, `graph-*`, etc.
- `--format` is not validated. `formatConversation` has a `switch` with no `default` (`formatter.ts:21-28`); with an unknown value it returns `undefined` and the CLI would `console.log(undefined)`. Verified on a scratch copy: `formatConversation(conv, 'xml')` returned `typeof undefined`.
- `formatCodeSession()` (`formatter.ts:77-90`) is used only by the MCP tool `get_code_session` (`src/mcp/tools.ts:897`), not by any CLI command.
- Human text conventions: `chalk` colours, `ora` spinners; errors go to stderr via `console.error`/`spinner.fail` and set `process.exitCode = 1` in most commands. Exceptions with no exit code on error: `probe-project-api` (`:1153-1155`), `probe-completion` (`:1697-1699`), `probe-file-download` (`:1828-1830`), and the `delete`/`delete-empty` "pass --yes to confirm" early-returns exit 0 (`:1172-1176`, `:1215-1218`).

### Scope classes used in the tables

- **NET/AUTH** = touches claude.ai over the network, or uses/creates/harvests session cookies, or calls another remote service. **OUT-OF-SCOPE for GCR** (GCR `SPEC.md:125` NFR-01: no raw session cookies, no private consumer API calls; `SPEC.md:136`: no live-history API, no cookie replay).
- **CLAUDE-DATA** = offline, but its data source is Claude-specific (Claude Code JSONL or code-session dumps). Not applicable to a ChatGPT-first GCR.
- **ADHOC** = unrelated personal one-off tooling; do not port.
- **PORTABLE** = offline, concept applies to any provider's conversation tree.

## 2. Command inventory (file order, `src/index.ts`)

Registration column gives the line range of the whole `program.command(...)...action(...)` block. "Default" means the default Commander value unless noted as "in action".

### A. Auth and session (all NET/AUTH, OUT-OF-SCOPE)

| # | Command and args | Options (default) | Purpose | Registered | Implemented by | Class |
|---|---|---|---|---|---|---|
| 1 | `login` | `--headless` (off, so the browser is headed: `headed: !opts.headless`); `--cookie <string>` (paste cookie string, skips Playwright) | Authenticate to claude.ai via Playwright browser login, or save a pasted cookie string | 91-115 | `src/auth/claude-login.ts:16` `login`; `src/auth/session.ts:32` `saveSession`, `:89` `saveSessionFromCookieString` | NET/AUTH (writes `~/.ccr/session.json`) |
| 2 | `grab-cookie` | `-p, --port <number>` ('9222'); `--auto-restart` (off; closes and relaunches the user's Chrome/Edge with the debug flag); `--browser <name>` ('chrome'; anything other than 'edge' becomes chrome) | Extract claude.ai cookies from a running Chrome/Edge over CDP (loopback `127.0.0.1:<port>`) | 119-146 | `src/auth/cookie-grabber.ts:98` `grabCookiesFromChrome` | NET/AUTH (cookie harvesting; writes session file) |
| 3 | `discover-code-api <sessionIdOrUrl>` | `--headless` (off); `--filter <substring>` ('claude.ai/api'); `-o, --output <path>` (`./code-api-<id>.json`); `--idle-timeout <ms>` (8000, `parsePositiveInt`); `--dwell <ms>` (2000); `--include-static` (off) | Reverse-engineer undocumented claude.ai/code endpoints by capturing browser traffic with a saved session | 150-215 | `src/auth/discover-code-api.ts:128` `discoverCodeApi`, `:86` `normalizeSessionId` | NET/AUTH (writes JSON dump) |
| 5 | `status` | none | Print whether the saved session is valid | 291-301 | `src/auth/session.ts:68` `isSessionValid` | NET/AUTH (session check) |
| 6 | `logout` | none | Delete the saved session file | 305-311 | `src/auth/session.ts:77` `clearSession` | AUTH (local file only, but auth artefact) |

### B. Live claude.ai readers (NET/AUTH, OUT-OF-SCOPE as implemented)

All use `loadSession()` then `createClient(session)` (`src/api/client.ts:111`), then `getOrganizations()` and use only `orgs[0]`. Client rate limit is a token bucket of 1 request/s with burst 3 and up to 3 retries (`src/api/client.ts:21-25`, `:62`), not the "1s delay" `CLAUDE.md` says.

| # | Command and args | Options (default) | Purpose | Registered | Implemented by | Class |
|---|---|---|---|---|---|---|
| 7 | `list` | `-q, --query <text>`; `-n, --limit <number>` ('20', raw `parseInt`, not validated) | List recent conversations (uuid, name, updated date), filter by title substring | 315-348 | `src/api/client.ts:123` `listConversations`; `src/extractors/search.ts:17` `searchConversations` | NET/AUTH |
| 8 | `get <conversation-id>` | `-f, --format <type>` ('markdown'; values markdown, json, compact; unvalidated) | Fetch one conversation tree and print its primary branch | 352-374 | `src/api/client.ts:131` `getConversation` (`?tree=True&rendering_mode=messages&render_all_tools=true`); `src/extractors/conversation.ts:10` `flattenConversation`; `src/extractors/formatter.ts:17` | NET/AUTH |
| 9 | `search <query>` | `--after <date>`; `--before <date>` (both compare `created_at`, ISO, invalid date throws); `-n, --limit <number>` ('20') | Search live conversation list by **title substring only**, sorted by `updated_at` desc; prints name, date, URL, UUID | 378-416 | `src/extractors/search.ts:17-50`; `src/utils/links.ts:13` `conversationUrl` | NET/AUTH |
| 25 | `extract-attachments <conversation-id> [outputDir]` | none (outputDir default `./attachments`) | Save each message attachment's `extracted_content` to a file named by `file_name` | 788-831 | inline in `src/index.ts`; `client.getConversation` | NET/AUTH (writes files) |
| 26 | `extract-artifacts <conversation-id> [outputDir]` | none (outputDir default `./artifacts`) | Save Claude "artifacts" `tool_use` blocks (`name === 'artifacts'`, `command === 'create'`) to files; MIME to extension map at `:849-855`; slug is lowercase title capped at 60 chars | 834-886 | inline in `src/index.ts`; `client.getConversation` | NET/AUTH (writes files) |
| 28 | `projects [project-uuid]` | `--archived` (off); `-n, --limit <number>` ('20', applies to the per-project conversation list only) | With no arg list projects (name, star, archived, description, URL, docs/files counts); with a uuid list that project's conversations | 952-1008 | `src/api/client.ts:149` `listProjects`, `:123` `listConversations(orgId, projectUuid)`; `src/utils/links.ts:18` | NET/AUTH |

### C. Live claude.ai mutators, probes, downloaders (NET/AUTH, OUT-OF-SCOPE; some destructive)

| # | Command and args | Options (default) | Purpose | Registered | Implemented by | Class |
|---|---|---|---|---|---|---|
| 13 | `get-code-session <sessionIdOrUrl>` | `-d, --db <path>` ('.ccr-import.sqlite'); `-o, --output <path>` (`fetched-<id>.json`); `--no-import` (skip SQLite import); `--headed` (off) | Fetch a claude.ai/code session through Playwright APIRequestContext, dump JSON, import into SQLite | 495-542 | `src/api/code-session-client.ts:175` `fetchAndDumpCodeSession`, `:39` `normalizeCodeSessionId`; `src/importers/import-code-session.ts:172` | NET/AUTH + CLAUDE-DATA |
| 29 | `cache-projects <dbPath>` | none | Fetch project names from claude.ai and upsert into local `projects` table for richer search output | 1011-1028 | `src/api/client.ts:149`; `src/importers/import-sqlite.ts:256` `cacheProjects` | NET/AUTH (writes DB) |
| 30 | `probe-project-api` | none | **Mutating probe**: creates a throwaway project, tries four move-endpoint shapes on a hard-coded conversation UUID, deletes the project | 1033-1158 | inline `fetch` in `src/index.ts`; `client.createProject` (`src/api/client.ts:156`) | NET/AUTH, hard-coded IDs (lines 1037-1038) |
| 31 | `delete <conversation-id>` | `--yes` (without it prints a warning and exits 0) | DELETE a conversation on claude.ai. Description says "and local SQLite" (`:1164`) but the action only calls `client.deleteConversation` (`:1179`); there is no db argument, so local data is untouched | 1161-1185 | `src/api/client.ts:141` `deleteConversation` | NET/AUTH, **destructive** |
| 32 | `delete-empty <dbPath>` | `--dry-run`; `--yes`; `--local-only` (skip claude.ai call) | List empty conversations (cap 10000), then delete them on claude.ai and locally; `--local-only` deletes only in SQLite | 1188-1259 | `src/importers/advanced-queries.ts:57` `getEmptyConversations`, `:160` `deleteConversationLocal`; `client.deleteConversation` | NET/AUTH unless `--local-only`; **destructive** |
| 43 | `create-project <name>` | `-d, --description <text>` ('') | Create a claude.ai project | 1584-1604 | `src/api/client.ts:156` | NET/AUTH, mutating |
| 44 | `move-to-project <projectUuid> <conversationUuids...>` | none | Move conversations into a claude.ai project | 1607-1635 | `src/api/client.ts:163` `moveConversationToProject` | NET/AUTH, mutating |
| 45 | `probe-completion` | none | **Mutating probe**: creates a conversation, posts to the internal `/completion` endpoint with a hard-coded model id, deletes it | 1639-1700 | inline `fetch` in `src/index.ts` (hard-coded conv id at :1643, model at :1680) | NET/AUTH, hard-coded IDs |
| 46 | `rename-project-conversations <projectUuid>` | `--dry-run`; `-l, --limit <n>` (`parsePositiveInt`) | For each conversation in a project, ask Claude (internal `/completion` endpoint, haiku model) for a 5-8 word title and rename it on claude.ai. Per title it creates a temporary claude.ai conversation named `CCR-TITLE-GEN`, sends the first 10 messages (each cut to 300 chars) as the prompt, then deletes the temp conversation (`ai-titler.ts:37-99`) | 1703-1775 | `src/importers/ai-titler.ts:37` `generateTitle`; `client.listProjectConversations` (`:174`), `getConversation` (`:131`), `renameConversation` (`:187`); `flattenConversation` | NET/AUTH, mutating, uses remote LLM |
| 47 | `probe-file-download` | none | Probe file-download URL shapes (`/files/<uuid>/preview`, `/document_pdf`) with hard-coded file UUIDs | 1778-1831 | inline `fetch` | NET/AUTH, hard-coded IDs (1783-1784, 1817) |
| 48 | `download-project-files <projectUuid> <outputDir>` | `--dry-run`; `--no-download`; `--convert-images` (WebP to JPEG via `sharp`) | Download every project file, scaffold `date_uuid_slug/` folders plus `manifest.json`, then `git init` and commit. Project name `'Nomad AV Rack'` (`:1894`) and commit message (`:1909`) are hard-coded | 1834-1925 | `src/importers/project-downloader.ts:195` `scaffoldProject`, `:62` `slugify`; `client.downloadFile` (`src/api/client.ts:194`); `child_process.execSync` for git | NET/AUTH, writes files, shells out to git |

### D. Import and local-file readers (offline)

| # | Command and args | Options (default) | Purpose | Registered | Implemented by | Class |
|---|---|---|---|---|---|---|
| 4 | `read-session [pathOrId]` | `-f, --format <format>` ('markdown'); `-n, --limit <number>` (unlimited); `--tools`; `--thinking`. With no arg it lists sessions found under `~/.claude/projects/` | Read a local Claude Code JSONL session and print it in markdown, json or compact | 219-287 | `src/importers/session-reader.ts:69` `readLocalSession`, `:195` `findLocalSessionFile`, `:250` `listLocalSessions`; `formatter.ts:17` | CLAUDE-DATA (offline) |
| 12 | `import-local-sessions [dbPath]` | `--db <path>` ('.ccr-import.sqlite'); `--force` (reimport existing); `--sessions-dir <path>` (`~/.claude/projects/`); `--only <ids...>` | Upsert local Claude Code sessions into the same SQLite schema; marks rows with `account_uuid = 'local-claude-code'` (`import-local-sessions.ts:42`). Its closing hint prints `search-sqlite <query> <db>` but the real order is `<dbPath> <query>` (`index.ts:486`) | 455-491 | `src/importers/import-local-sessions.ts:216` `importLocalSessions` | CLAUDE-DATA (writes DB, additive) |
| 14 | `import-code-session <jsonPath>` | `-d, --db <path>` ('.ccr-import.sqlite') | Import a previously fetched claude.ai/code session JSON; additive and idempotent; skips non-message events and prints skipped type counts | 546-582 | `src/importers/import-code-session.ts:172` `importCodeSession` | CLAUDE-DATA (writes DB) |
| 15 | `import-sqlite <exportPath> <dbPath>` | none | **Core import.** Read a Claude export `conversations.json` (must be a JSON array) and build the SQLite v2 database. Prints `Import complete: N conversations, M messages, K content blocks` | 586-599 | `src/importers/import-sqlite.ts:167` `importConversationsToSqlite` | PORTABLE (writes DB) |

`import-sqlite` data shape and behaviour (relevant to the GCR `import` design):
- Input: a JSON **array** of conversations `{uuid, name, summary?, created_at, updated_at, account?.uuid, chat_messages[]}`; each message `{uuid, sender, text, created_at, updated_at, parent_message_uuid, attachments, files, content[]}` (`import-sqlite.ts:16-36`, insert logic `:167-240`). Single JSON file only; no zip handling.
- Tables created (`:38-155`): `conversations`, `messages` (with `parent_message_uuid`, `attachments` and `files` as JSON text), `content_blocks` (one row per `content[]` element; columns block_type, text_content, tool_name, tool_use_id, tool_input, is_error, meta), `entities`; FTS5 content-sync tables `messages_fts` and `content_blocks_fts` (tokenizer `porter`) and six sync triggers. A `projects` cache table is created `IF NOT EXISTS` (`:159`).
- **Destructive on re-import**: `DROP TABLE IF EXISTS` for the four base tables and both FTS tables (`:40-51`), then recreate. It does not drop `projects`, `conversation_profiles`, `conversation_embeddings` or `graph_*`, so those derived tables can go stale after a re-import (my inference from the DDL; not tested). This is the opposite of GCR `SPEC.md:94`, which requires backward-compatible merges with provenance keys.
- The only validation is "file exists, parses as JSON, is an array" (`import-sqlite.ts:168-182`); per-message fields are checked only by the SQLite `NOT NULL` constraints (for example `sender`, `created_at`).

### E. Offline search (PORTABLE)

All take `<dbPath>` first (resolved with `path.resolve`), open the DB read-only, and print grouped results through `formatGrouped()` (`src/index.ts:62-80`): separator line, name plus hit count, claude.ai URL, `UUID:`, optional project line, then up to 3 snippets (each message text cut at 200 chars in SQL via `substr(m.text,1,200)`, shown with sender and timestamp). Groups are ordered by `hit_count DESC`. The default limit is 10 (`options.limit || 10`). `-l/--limit` uses `parsePositiveInt` (`:56-60`, throws on non-positive or NaN). FTS5 query strings are passed straight to `MATCH` (so FTS5 operators, `NEAR`, quotes, `*` work); a syntax error is re-thrown as `Invalid search query "..." ... Avoid special characters like unmatched quotes.` (`src/importers/sqlite-search.ts:48-54`). Ranking is FTS5 `rank`.

| # | Command and args | Options (default) | Purpose | Registered | Implemented by |
|---|---|---|---|---|---|
| 10 | `search-sqlite <dbPath> <query>` | `-l, --limit <n>` (10) | FTS5 + Porter search over message text | 420-433 | `src/importers/sqlite-search.ts:101` `searchMessagesGrouped` (ungrouped `searchMessages` :81 used by MCP) |
| 11 | `search-entity <dbPath> <entity>` | `-t, --type <type>` (help text says topic, url, uuid; the `entities` table also holds type `tool`, `entity-extract.ts:64`); `-l, --limit <n>` (10) | Messages by extracted entity value and type | 437-451 | `src/importers/entity-search.ts:68` `searchByEntityGrouped` |
| 20 | `search-attachments <dbPath> <query>` | `-l, --limit <n>` (10) | Case-insensitive substring match over the JSON `attachments` column (filename or content), grouped per conversation in the CLI (first 3 shown, attachments text cut at 100 chars) | 689-719 | `src/importers/advanced-queries.ts:192` `searchAttachments` (loads all attachment rows then filters in JS; applies limit after filtering, before grouping) |
| 22 | `search-thinking <dbPath> <query>` | `-l, --limit <n>` (10) | FTS over `content_blocks` where block type is `thinking` | 739-752 | `sqlite-search.ts:160` `searchThinkingGrouped` |
| 23 | `search-tools <dbPath> <toolName>` | `-l, --limit <n>` (10) | Messages that invoked a given tool name | 755-768 | `sqlite-search.ts:218` `searchByToolNameGrouped` |
| 24 | `search-content <dbPath> <query>` | `-t, --type <blockType>` (text, thinking, tool_use, tool_result, voice_note); `-l, --limit <n>` (10) | FTS over all content blocks with an optional block-type filter | 771-785 | `sqlite-search.ts:283` `searchContentGrouped` |
| 19 | `edit-history <dbPath> <messageUuid>` | none | Prints the message **and its direct children** (`WHERE uuid = ? OR parent_message_uuid = ?`, ordered by `created_at`), one block per row as `---\n[created_at] sender: text`. This is replies, not sibling edits. `getMessageSiblings` (`advanced-queries.ts:502`) exists but is referenced by neither the CLI nor the MCP server | 672-686 | `advanced-queries.ts:180` `getEditHistory` |

### F. Offline conversation structure: branches and threads (PORTABLE)

CCR's tree model is `messages.parent_message_uuid`. Root = parent null/empty or the sentinel `00000000-0000-4000-8000-000000000000` (`advanced-queries.ts:258`, `:340`, `:445`). At each node the **last child by `created_at`** is the "main" continuation.

| # | Command and args | Options | Purpose and output shape | Registered | Implemented by |
|---|---|---|---|---|---|
| 21 | `main-branch <dbPath> <conversationUuid>` | none | Linearise the main branch (root, then last child by `created_at` repeatedly). Falls back to chronological order if no root is found. Output per message: `---\n[created_at] sender: text` | 722-736 | `advanced-queries.ts:234` `getConversationTree` (alias `getMainBranch` :281) |
| 35 | `branches <dbPath> <conversationUuid>` | none | Enumerate threads: header `N thread(s), M total messages, B branch point(s)`, then `Thread i (main): <n> messages, last: <created_at>` or `Thread i (forks at depth d): ...`. Thread 0 = main; alternates are queued by DFS and numbered in queue order (`pending.shift()`). The CLI prints only index, fork depth, message count and last timestamp, although `BranchSummary` also carries `forkPoint` and `firstDivergentSender` (`advanced-queries.ts:283-290`) | 1345-1367 | `advanced-queries.ts:313` `getConversationBranches` |
| 36 | `thread <dbPath> <conversationUuid> <threadIndex>` | none (`threadIndex` is raw `parseInt`; out of range prints "No messages found (thread index may be out of range).") | Print one thread; messages in the shared prefix are tagged `[shared]` (`ThreadMessage.isShared`, :299-306). Output per message `---\n[created_at] sender [shared]: text` | 1370-1388 | `advanced-queries.ts:424` `getThread` |

Note: branch ids are positional integers (thread index), not stable identifiers; the GCR example uses `--branch <branch-id>` (`SPEC.md:107`), so GCR needs stable branch ids that CCR does not have.

### G. Offline analysis and maintenance (PORTABLE unless noted)

| # | Command and args | Options (default) | Purpose | Registered | Implemented by |
|---|---|---|---|---|---|
| 16 | `extract-entities <dbPath>` | none | `DELETE FROM entities`, then regex-extract `uuid`, `url`, `topic` from message text and from content blocks of type text, thinking, voice_note, plus a `tool` entity per `tool_use` block. The `topic` regex is a hard-coded personal vocabulary list (`entity-extract.ts:11-14`; includes terms like "grandma", "ma2", "dmx"), not a general method. Prints a one-line count summary | 601-611 | `src/importers/entity-extract.ts:28` `extractEntities` |
| 17 | `profile <dbPath>` | `--verbose`; `--rebuild` (wipe and redo; default is incremental); `--slow-threshold <ms>` (5000) | Build per-conversation semantic profiles into `conversation_profiles`: 20 regex categories (14 general plus 6 Claude-specific; `conversation-profiler.ts:100-200`), structural metrics (code blocks, tool calls and errors, thinking blocks, branch points, attachment count, message counts, words, duration), per-sender profiles, `primary_type` (coding, devops, research, qa, general) and `technical_density` 0-1. Prints total, average density, type distribution | 614-637 | `src/importers/conversation-profiler.ts:507` `profileConversations`; table DDL `:290` |
| 18 | `profile-query <dbPath>` | `-t, --type <type>`; `-d, --min-density <n>` (`parseFloat`, unchecked); `-l, --limit <n>` (20 in action); `--order <field>` ('technical_density'; also code_blocks, tool_invocations, total_words, duration_minutes) | Query profiles | 640-669 | `conversation-profiler.ts:665` `getProfiles` |
| 27 | `stats <dbPath>` | none | Usage statistics, printed as sections: Conversations (total, untitled, empty, in projects); Messages (total, human, assistant, avg per conversation); Content Blocks by type; Thinking (total, avg per assistant message); Date Range (first/last message); Monthly Activity (last 12 months, text bar of `round(count/30)` capped at 40); Top 10 Conversations by message count; Top 10 Tools; Entities by type. `FullStats` also computes a `profiles` aggregate (`advanced-queries.ts:87-98`) which the CLI never prints (`index.ts:889-949`) | 889-949 | `advanced-queries.ts:100` `getFullStats` |
| 33 | `audit <dbPath>` | `--untitled`; `--empty`; `-l, --limit <n>` (50 in action) | Default: totals plus untitled and empty counts with percentages. `--untitled` lists uuid, message count, date for conversations with null/empty name. `--empty` lists conversations with zero messages. If both flags are given only `--untitled` runs | 1262-1303 | `advanced-queries.ts:38` `getUntitledConversations`, `:57` `getEmptyConversations`, `:75` `getConversationStats` |
| 34 | `rename-local-untitled <dbPath>` | `--dry-run`; `-l, --limit <n>` (0 = all) | Generate titles for untitled conversations from the first useful assistant text, else topic entities, else first human message (80-char cap, markdown stripped, boilerplate skipped) and write them to the local `conversations.name`. Not synced anywhere. `CLAUDE.md` calls it `rename-untitled`; the registered name is `rename-local-untitled` | 1306-1342 | `src/importers/conversation-renamer.ts:161` `renameUntitled`, `:31` `extractTitle`, `:102` `generateTitle` |

### H. Knowledge graph (PORTABLE; `categorize` may call a remote embedding service)

Graph model (`src/graph/schema.ts:10-52`): `graph_nodes(id, label, node_type, entity_type, degree, community_id, first_seen, last_seen, meta, tool_count, tool_names, category)`, `graph_edges(source_id, target_id, relation, confidence, weight, conversation_uuid, message_uuid; UNIQUE(source_id,target_id,relation))`, `graph_communities(id, node_count, cohesion_score, top_entities, label)`. Node ids: entity = the lowercased entity string itself (`build.ts:81`), conversation = `conv:<uuid>` (`:71`), tool = `tool:<name>` (`:91`). Edge `relation` values written by `buildGraph`: `uses_tool` (conversation to tool, weight = call count, `build.ts:111`), `co_occurs` (tool to tool `:122`, entity to entity `:170`; repeated inserts add to `weight` through `ON CONFLICT ... DO UPDATE SET weight = weight + excluded.weight`, `:62-64`), `mentioned_in` (entity to conversation, `:174`). All four inserts use `confidence = 'EXTRACTED'`.

| # | Command and args | Options (default) | Purpose | Registered | Implemented by |
|---|---|---|---|---|---|
| 37 | `graph-build <dbPath>` | `--method <type>` ('label-propagation'; or 'kmeans'); `--k <n>` (auto); `--api-key <key>` (sets `process.env.GOOGLE_API_KEY`) | Pipeline in order: `extractEntities` (clears `entities` first) then `buildGraph` (auto-runs the profiler if `conversation_profiles` is empty, `build.ts:35-50`, then **drops and recreates** the graph tables, `:55-56`) then `clusterGraph` then `categorizeConversations`. Prints node/edge/community/category summaries. `--k` reaches clustering only; `categorizeConversations(resolved)` is called without k (`index.ts:1410`) | 1391-1421 | `entity-extract.ts:28`; `src/graph/build.ts:35` `buildGraph`; `src/graph/cluster.ts:99` `clusterGraph` (+ `kmeans.ts`); `src/graph/categorize.ts:359` `categorizeConversations` |
| 38 | `categorize <dbPath>` | `--k <n>` (auto); `--api-key <key>` | Categorize conversations. If `GOOGLE_API_KEY` or `GEMINI_API_KEY` is set it calls Gemini embeddings (`gemini-embedding-001`, cached in `conversation_embeddings`); otherwise TF-IDF fallback (`categorize.ts:384-395`) | 1424-1440 | `categorize.ts:359`; `src/graph/embeddings.ts:122` `embedConversations` |
| 39 | `graph-query <dbPath> <keyword>` | `-d, --depth <n>` ('2') | Seeds = up to 20 nodes whose lowercased label or id contains the keyword; BFS to `depth`; prints node list (`label [type] degree community`, seeds starred) and the first 20 edges as `src -[relation w=N]-> tgt` | 1443-1470 | `src/graph/query.ts:61` `queryGraph` |
| 40 | `graph-god-nodes <dbPath>` | `-n, --limit <n>` ('10'); `--bridges`; `--bursts`; `--tools` (modes are mutually exclusive, first match wins in the order tools, bridges, bursts) | Top-degree entities, or bridge entities (connect multiple communities), temporal bursts (entity mentions per week), or tool usage stats; always followed by "Suggested queries" | 1473-1531 | `src/graph/analyze.ts:26` `godNodes`, `:135` `bridgeEntities`, `:106` `temporalBursts`, `:178` `toolUsageStats`, `:210` `suggestQuestions` |
| 41 | `graph-export <dbPath> [outputPath]` | `--max-nodes <n>` ('50'); `--seed <entity>`; `--seed-depth <n>` ('2'); `--entity-types <types>` (comma list, e.g. topic,url,uuid); `--min-degree <n>`; `--community <id>`; `--entity-only` | Write an interactive HTML graph (default `graph.html`) and copy `vis-network.min.js` next to it (`export.ts:926-928`), so no CDN is used at view time. Features per `CLAUDE.md`: searchable conversation sidebar, context menu, hash navigation, claude.ai deep links | 1534-1562 | `src/graph/export.ts:201` `toHtml` |
| 42 | `graph-path <dbPath> <from> <to>` | none | BFS shortest path. Help text says "between two entities", but `from` and `to` are **exact node ids** (entity string, `conv:<uuid>`, `tool:<name>`); there is no label lookup (`query.ts:165-210`). Prints `Path (N hops)` then labels joined by arrows | 1565-1581 | `src/graph/query.ts:165` `shortestPath` |

Graph functions that exist only in the MCP server and have no CLI command: `getNeighbors` (`query.ts:115`, used at `mcp/tools.ts:768`), `getCommunity` (`query.ts:140`, `mcp/tools.ts:812`), `surprisingConnections` (`analyze.ts:43`, `mcp/tools.ts:838`). `topicHubs` (`analyze.ts:79`) and `getProfile` (`conversation-profiler.ts:655`) are exported but unused by CLI and MCP.

### I. Unrelated one-off (ADHOC, do not port)

| # | Command and args | Options (default) | Purpose | Registered | Implemented by | Class |
|---|---|---|---|---|---|---|
| 49 | `extract-speaker-images <outputDir>` | `--save-pdfs <dir>`; `--mode <mode>` ('both'; cover, dims, both) | Download hard-coded loudspeaker manufacturer PDFs (cloudfront URLs, `speaker-image-extractor.ts:148-235`) and crop cover photos and drawings to transparent PNGs. Nothing to do with conversations | 1927-1972 | `src/importers/speaker-image-extractor.ts:461` `extractSpeakerImage`, `SPEAKER_PDFS` :148 | NET (non-claude host) + ADHOC |

## 3. OUT-OF-SCOPE for GCR: commands that touch network or auth

GCR boundaries: `SPEC.md:125` (NFR-01) and `SPEC.md:134-136` (section 9) exclude live consumer-history APIs, cookie capture/replay and unsupervised deletion in the consumer UI.

| Reason | Commands (index numbers) |
|---|---|
| Creates, stores, harvests or validates session cookies | `login` (1), `grab-cookie` (2), `status` (5), `logout` (6) |
| Reads live claude.ai data | `discover-code-api` (3), `list` (7), `get` (8), `search` (9), `extract-attachments` (25), `extract-artifacts` (26), `projects` (28), `cache-projects` (29), `get-code-session` (13) |
| Mutates or deletes remote data | `delete` (31), `delete-empty` (32, unless `--local-only`), `create-project` (43), `move-to-project` (44), `rename-project-conversations` (46), `probe-project-api` (30), `probe-completion` (45) |
| Downloads remote files | `probe-file-download` (47), `download-project-files` (48), `extract-speaker-images` (49, non-claude host) |
| Sends content to a remote LLM or embedding service | `rename-project-conversations` (46, claude.ai completion), `categorize` (38) and `graph-build` (37) when `GOOGLE_API_KEY`/`GEMINI_API_KEY` is set (Gemini embeddings; conflicts with `SPEC.md:130` NFR-06 "no hosted vector indexing by default") |

Secret handling to avoid: `--cookie <string>` (`index.ts:95`) and `--api-key <key>` (`:1396`, `:1428`) put secrets on the command line (shell history, process list).

Offline but Claude-specific (not applicable to ChatGPT data): `read-session` (4), `import-local-sessions` (12), `import-code-session` (14).

Hard-coded personal identifiers present in command bodies (cite lines only, values not repeated here): `index.ts:1037-1038`, `:1643`, `:1783-1784`, `:1817`, `:1894`, `:1909`; `entity-extract.ts:14`; `speaker-image-extractor.ts:148-235`.

## 4. CCR command to GCR target mapping

GCR target list (`SPEC.md:99-114`, heading at :96): `gcr doctor`, `import`, `list`, `get`, `search`, `branches`, `thread`, `stats`, `audit`, `graph build`, `graph query`, `draft create`, `draft list`, `mcp`.

"Net?" repeats the scope class. Where CCR's implementation is live-API but the user-visible feature exists in GCR over local data, the GCR equivalent is the offline command and the live code path is still OUT-OF-SCOPE.

| # | CCR command | Net? | Closest GCR equivalent | Notes |
|---|---|---|---|---|
| 1 | `login` | NET/AUTH | none | OUT-OF-SCOPE (cookies, browser login) |
| 2 | `grab-cookie` | NET/AUTH | none | OUT-OF-SCOPE (cookie harvesting from the user's browser) |
| 3 | `discover-code-api` | NET/AUTH | none | OUT-OF-SCOPE (traffic capture) |
| 4 | `read-session` | offline, CLAUDE-DATA | none | Claude Code JSONL; not a ChatGPT source |
| 5 | `status` | NET/AUTH | none | Occupies the "diagnostics" slot but is an auth check. `gcr doctor` (environment prerequisites and supported modes, `SPEC.md:117`) has a different purpose |
| 6 | `logout` | AUTH | none | OUT-OF-SCOPE |
| 7 | `list` | NET/AUTH | `gcr list` | Feature maps to local `gcr list --provider --limit --format json`; CCR has no JSON output and filters by title only |
| 8 | `get` | NET/AUTH | `gcr get` | CCR: primary branch only, 3 formats. GCR adds URL input and `--all-branches` |
| 9 | `search` | NET/AUTH | `gcr search` | CCR live search is title-only; GCR search is local. `--after/--before` filters are not in the SPEC examples |
| 10 | `search-sqlite` | offline | `gcr search` | Main parity target: FTS5 grouped by conversation, hit counts, 3 snippets |
| 11 | `search-entity` | offline | `gcr graph query` (partial) | No entity-search command in the target list |
| 12 | `import-local-sessions` | offline, CLAUDE-DATA | none | |
| 13 | `get-code-session` | NET/AUTH | none | |
| 14 | `import-code-session` | offline, CLAUDE-DATA | none | |
| 15 | `import-sqlite` | offline | `gcr import` | GCR must also accept `.zip` and be non-destructive/merge-safe (CCR drops tables, `import-sqlite.ts:40-51`) |
| 16 | `extract-entities` | offline | `gcr graph build` (folded in) | CCR runs it as step 1 of `graph-build`; no standalone GCR slot |
| 17 | `profile` | offline | none | No profiling command in the target list; closest surface would be `gcr stats` |
| 18 | `profile-query` | offline | none | |
| 19 | `edit-history` | offline | `gcr branches` (partial) | CCR output is message plus children, not sibling edits |
| 20 | `search-attachments` | offline | `gcr search` (partial) | Would need an attachment filter not shown in SPEC |
| 21 | `main-branch` | offline | `gcr thread` / default `gcr get` | Main branch is what `gcr get` shows without `--all-branches` |
| 22 | `search-thinking` | offline | `gcr search` (partial) | Needs a block-type filter |
| 23 | `search-tools` | offline | `gcr search` (partial) | Needs a tool-name filter |
| 24 | `search-content` | offline | `gcr search` (partial) | `--type` block filter is the same idea |
| 25 | `extract-attachments` | NET/AUTH | none | OUT-OF-SCOPE as implemented (live fetch) |
| 26 | `extract-artifacts` | NET/AUTH | none | OUT-OF-SCOPE as implemented (live fetch) |
| 27 | `stats` | offline | `gcr stats` | GCR example adds `--group-by model` (`SPEC.md:108`); CCR has no grouping flag |
| 28 | `projects` | NET/AUTH | none | |
| 29 | `cache-projects` | NET/AUTH | none | |
| 30 | `probe-project-api` | NET/AUTH | none | |
| 31 | `delete` | NET/AUTH | none | OUT-OF-SCOPE (`SPEC.md:136` excludes unsupervised deletion) |
| 32 | `delete-empty` | NET/AUTH (offline with `--local-only`) | `gcr audit` (listing only) | The `--empty` listing is portable; deletion is not. GCR keeps imported originals immutable (`SPEC.md:94`) |
| 33 | `audit` | offline | `gcr audit` | GCR example flags: `--missing-model --empty --untitled`; CCR has `--untitled --empty` plus a default summary |
| 34 | `rename-local-untitled` | offline | none | Mutates imported data; GCR separates `local_annotations` (`SPEC.md:94`) |
| 35 | `branches` | offline | `gcr branches` | CCR ids are positional thread indexes; GCR needs stable branch ids |
| 36 | `thread` | offline | `gcr thread` | Same: `<threadIndex>` vs GCR `--branch <branch-id>`; `[shared]` prefix marker is a useful feature |
| 37 | `graph-build` | offline (remote embeddings if key set) | `gcr graph build` | Port only the local, deterministic parts (entities, nodes, edges, label-propagation/k-means, TF-IDF) |
| 38 | `categorize` | offline TF-IDF, or remote Gemini | none | Remote embeddings out of scope; local TF-IDF part could live inside `gcr graph build` |
| 39 | `graph-query` | offline | `gcr graph query` | `--depth` default 2 matches the GCR example |
| 40 | `graph-god-nodes` | offline | `gcr graph query` (partial) | No separate GCR slot |
| 41 | `graph-export` | offline | none | HTML export is not in the target list (SPEC NFR-04 mentions an accessible graph HTML, so it is likely a flag on a graph command) |
| 42 | `graph-path` | offline | `gcr graph query` (partial) | No separate GCR slot |
| 43 | `create-project` | NET/AUTH | none | |
| 44 | `move-to-project` | NET/AUTH | none | |
| 45 | `probe-completion` | NET/AUTH | none | |
| 46 | `rename-project-conversations` | NET/AUTH | none | |
| 47 | `probe-file-download` | NET/AUTH | none | |
| 48 | `download-project-files` | NET/AUTH | none | |
| 49 | `extract-speaker-images` | NET, ADHOC | none | |

### Reverse view: GCR target to closest CCR command

| GCR target | Closest CCR source | Gap |
|---|---|---|
| `gcr doctor` | none (`status` is auth only) | New in GCR |
| `gcr import` | `import-sqlite` (15) | GCR adds zip, merge keys, provenance, completeness |
| `gcr list` | `list` (7) live | CCR has no offline list at all (offline path has no list command; closest is `audit --untitled/--empty` or `profile-query`) |
| `gcr get` | `get` (8) live, `main-branch` (21) offline | CCR offline path has no markdown/json/compact rendering; formats only exist on the live `get` and `read-session` |
| `gcr search` | `search-sqlite` (10), `search-content` (24), `search-thinking` (22), `search-tools` (23), `search-attachments` (20) | Filters (block type, tool, attachment) are separate commands in CCR |
| `gcr branches` | `branches` (35) | Stable branch ids |
| `gcr thread` | `thread` (36) | Stable branch ids |
| `gcr stats` | `stats` (27) | `--group-by` |
| `gcr audit` | `audit` (33) | `--missing-model` |
| `gcr graph build` | `graph-build` (37) + `extract-entities` (16) + auto profiler | |
| `gcr graph query` | `graph-query` (39), `graph-path` (42), `graph-god-nodes` (40) | |
| `gcr draft create` / `gcr draft list` | none | New in GCR (CCR has no draft or write-back concept except `rename-local-untitled`) |
| `gcr mcp` | `src/server.ts` via `npm run dev:server` (no CLI subcommand) | CCR's MCP is a separate binary entry; 33 tools |

## 5. Discrepancies and quirks worth knowing before building a parity matrix

1. Command count: 49 registered vs "39" in the file header (`index.ts:4`), "28" in `CHANGELOG.md`, and an 18-command list for the SQLite path in `CLAUDE.md`. Use the 49 from the code.
2. `CLAUDE.md` names `rename-untitled`; the real command is `rename-local-untitled` (`index.ts:1307`). Its MCP twin is `rename_local_untitled_conversations` (`mcp/tools.ts:647`). The MCP stats tool is `conversation_stats` (`mcp/tools.ts:407`), while the CLI command is `stats`.
3. `delete`'s description claims it also deletes locally (`index.ts:1164`); the code does not (`:1161-1185`).
4. `README.md:85` says `search` covers "title/keyword"; the code only matches the title substring (`extractors/search.ts:23-26`).
5. `README.md:101` says `main-branch` lists "all messages"; the code linearises the last-child path (`advanced-queries.ts:234-279`).
6. `--format` is unvalidated and an unknown value yields `undefined` (see section 1).
7. `-n/--limit` parsing is inconsistent: offline `-l` options use `parsePositiveInt`; `list`, `search`, `projects` and `graph-god-nodes` use raw `parseInt` (`index.ts:319,383,956,1475`), so garbage becomes NaN silently.
8. `graph-path` needs exact node ids despite saying "entities" (section 2H, row 42).
9. `import-local-sessions` prints a wrong argument order in its next-step hint (`index.ts:486`).
10. `getMessageSiblings`, `getConversationMessages` (`advanced-queries.ts:220`), `topicHubs`, `getProfile` are exported but have no CLI or MCP caller (grep over `src/`).
11. `markdown` output timestamps use the host locale (`formatter.ts:45`); nothing in CCR's CLI output is timestamp-deterministic.
12. Package metadata disagrees on the version in three places (`0.1.0` in Commander, `1.0.0` in package.json, `1.11.0` in the index.ts header).

## 6. Unverified or not examined

- I did not run any CCR command and made no network or auth attempt. Behaviour of live commands is read from code only.
- Not read in full (taken from call sites and file headers only): `src/auth/claude-login.ts`, `cookie-grabber.ts`, `discover-code-api.ts`, `src/api/code-session-client.ts`, `src/importers/project-downloader.ts`, `speaker-image-extractor.ts`, `session-reader.ts`, most of `import-local-sessions.ts`, `import-code-session.ts`, `graph/kmeans.ts`, `graph/embeddings.ts`, and the HTML/JS template inside `graph/export.ts`. All of these are OUT-OF-SCOPE or not-to-be-ported for GCR, except `kmeans.ts`, whose algorithm details (7-D features, silhouette auto-k) I took from `CLAUDE.md`, not from the code.
- The effect of re-import on stale derived tables (`conversation_profiles`, `graph_*`, `conversation_embeddings`) is inferred from DDL, not tested.
- The ora spinner's default output stream (stdout vs stderr) is library behaviour, not checked in this checkout.
- The profiler's "20 categories" were counted from `key:` entries in `conversation-profiler.ts:104-200` (20 keys seen); the per-category regexes were not reviewed.
