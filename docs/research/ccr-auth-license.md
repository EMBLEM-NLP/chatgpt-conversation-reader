# CCR auth/network surface, license facts, conventions and test coverage

Researcher: READ-ONLY pass for the GCR parity matrix. Accessed/produced 2026-10-10.
Subject: `EMBLEM-NLP/claude-conversation-reader-public` checkout at `<ccr-checkout>`, commit `f66e24e06b15e75060a65b2bf9b646395ddac0d1` (2026-07-15, "wip: code-session probing helpers + profiler improvements"). The checkout has exactly 1 commit in history (`git log | wc -l` = 1), so no history analysis was possible.

All CCR paths below are relative to that checkout. Line numbers are 1-based and refer to f66e24e. Nothing in CCR or GCR was modified (`git status --porcelain --ignored` empty in both after the work). Any build/test runs were done in a scratch copy made with `git archive HEAD` under the session scratchpad.

GCR boundary references used below (identical to the uploaded files, verified with `cmp` against `<gcr-checkout>/{SPEC,CODEX_TASK,AGENTS}.md`):

| Tag | Source | Text (short) |
|---|---|---|
| B-SCOPE | SPEC.md:136 (section 9) | "No consumer ChatGPT live-history API, no account password capture, no replay of cookies, no bypass of security protections, no unsupervised deletion or sending in the consumer UI, ... no silent upload of exports to GitHub or remote coding agents." |
| B-NFR01 | SPEC.md:125 | "no credentials stored in Git; no raw session cookies; no private consumer API calls." |
| B-NFR06 | SPEC.md:130 | "local SQLite by default ... no hosted vector indexing by default." |
| B-AGENTS | AGENTS.md:6 | Hard boundary: "Import official user-provided exports; do not scrape private endpoints, collect browser cookies, or bypass login." |
| B-P1 | CODEX_TASK.md:19 | "Never fetch exports using cookies or private ChatGPT endpoints." |
| B-P4 | CODEX_TASK.md:42 | "Do not capture credentials/session cookies, inspect private APIs, defeat authentication/bot protections, or automate sending without an approved, supported platform route." |
| B-CI | CODEX_TASK.md:49 | "No network contact to ChatGPT consumer endpoints from CI or MCP. No credentials or data in Git history ... No real exports in tests." |
| B-STOP | CODEX_TASK.md:58 | Stop condition: undocumented consumer APIs, token theft, session cookie replay, unattended browser scraping, or ToU conflict. |
| B-LIC | CODEX_TASK.md:14, AGENTS.md:10 | Verify LICENSE terms; "do not ... assert code-license rights by inference"; review upstream license before code reuse. |

---

## 0. Executive summary

1. CCR's whole "live" path (12 of 33 MCP tools, about 20 of 49 CLI commands) depends on a reverse-engineered, undocumented claude.ai consumer API authenticated by replaying the user's browser session cookies, with explicit bot-detection evasion (spoofed User-Agent, `navigator.webdriver` override, `--disable-blink-features=AutomationControlled`, Cloudflare "warm-up"), plus scripts that kill the user's browser and read cookies out of the real profile over the Chrome DevTools Protocol (CCR's own CHANGELOG says this "bypasses v20 App Bound encryption"). All of it violates the GCR hard boundary and none of it may be ported.
2. The offline half (importers, FTS search, entities, graph, branch/thread, formatter) has no imports from `src/auth/` or `src/api/` (grep for `from '../(auth|api)'` in `src/importers`, `src/extractors`, `src/graph` returned no matches). Network calls outside `auth/`, `api/`, `index.ts` and `mcp/tools.ts` exist in only three importer files (`ai-titler.ts`, `speaker-image-extractor.ts`, and the Gemini path in `graph/embeddings.ts` + `graph/categorize.ts`), plus `project-downloader.ts`, which receives an authenticated client by parameter. That separation is the one architectural lesson worth mirroring.
3. Licensing: there is NO LICENSE/NOTICE/COPYING file anywhere in the 98 tracked files. The only license statement is `"license": "ISC"` in package.json:31 (and package-lock.json root). `author` is empty. No README/CHANGELOG/source-header license, copyright, attribution, or third-party notice. Reuse rights cannot be concluded; treat CCR as reference-only (features and data shapes), exactly as the GCR plan says.
4. CCR conventions: Vitest (5 files, 35 tests, all pass in my scratch run once the native sqlite addon is built), ESLint 9 flat + Prettier on `src/` only, opt-in git hooks, NO CI workflow. Gates are not actually enforced: lint currently reports 44 errors, `npm ci` fails with ERESOLVE, and docs disagree with code on tool/command counts and versions.
5. Dependency licenses (declared, from npm registry metadata) are permissive except weak-copyleft LGPL-3.0-or-later on optional `sharp` native binary packages. No GPL/AGPL/SSPL declared.

---

## 1. CCR authentication and network surface

### 1.1 Secrets and cookies handled

| Item | Evidence | Notes |
|---|---|---|
| Full browser cookie jar for claude.ai (all cookies, HttpOnly included), persisted as JSON `{cookies:{sessionKey, raw:[...]}, savedAt}` | `src/types.ts:12-31`; `src/auth/session.ts:32-44` | `raw` holds name/value/domain/path/expires/httpOnly/secure/sameSite per cookie. Every cookie in `raw` is replayed on every request: `src/api/client.ts:101-109` (`Cookie:` header built from all of them). |
| Primary credential name `sessionKey`; other "auth-like" names `__ssid`, `activitySessionId`, `anthropic-device-id` | `src/auth/session.ts:114`; `src/auth/claude-login.ts:89`; `src/auth/cookie-grabber.ts:210`; `scripts/extract-edge-cookies.cjs:165` | Same constant copy-pasted 4 times. |
| Cloudflare cookie `__cf_bm`, `__Host-session` treated as httpOnly | `src/auth/session.ts:91`; `src/api/code-session-client.ts:95-96` (warm-up "refreshes __cf_bm") | |
| Session file location `~/.ccr/session.json` (override `SESSION_PATH` env), written with mode `0o600` | `src/auth/session.ts:13-15, 40-43` | Plaintext. `clearSession` is a plain `unlink` (`session.ts:77-83`). |
| Guard refusing to read/write the session inside the project tree "to prevent backup exfiltration" | `src/auth/session.ts:17-30` | Good concept (see section 4). |
| Freshness check looks only at `sessionKey.expires` | `src/auth/session.ts:139-150` | Silent staleness; documented as a gotcha in `.claude/skills/ccr/SKILL.md:19`. |
| Manual cookie paste: `login --cookie "<Cookie header>"` | `src/index.ts:92-105`; `src/auth/session.ts:85-124` | Hard-codes domain `.claude.ai`, marks some names httpOnly by guess. |
| Login failure screenshot `~/.ccr/last-login-failure.png` (full page, default perms) | `src/auth/claude-login.ts:62, 70` | Can contain PII. |
| Cookie value previews (first 30 chars) printed to the terminal | `scripts/extract-edge-cookies.cjs:136-140` | Secret leakage into terminal logs. |
| Third-party API key `GOOGLE_API_KEY` / `GEMINI_API_KEY`, also accepted as CLI arg `--api-key <key>` (visible in process args/shell history; copied into `process.env`) | `src/graph/categorize.ts:384`; `src/index.ts:1396-1402, 1428-1433` | Sends conversation-derived text to Google (section 1.6). |
| `ANTHROPIC_API_KEY` documented in `.env.example:7-9` for a command that no longer uses it (title generation now uses cookie-authenticated consumer completion instead) | `.env.example`; `src/importers/ai-titler.ts:1-9` | Doc drift. |
| `dotenv/config` auto-load of `.env` at CLI start | `src/index.ts:10` | |
| Playwright `storageState`-style handling is not used; cookies are re-injected with `context.addCookies` | `src/auth/discover-code-api.ts:168`; `src/api/code-session-client.ts:93`; `scripts/fetch-code-session.ts:216`; `scripts/probe-page.ts:39-42` | |

### 1.2 Modules (auth, api) and what each does

| File (lines) | What it does | Secrets / network |
|---|---|---|
| `src/auth/session.ts` (150) | Persist/validate/clear cookie session; import from Cookie-header string | Reads/writes `~/.ccr/session.json`. No network. |
| `src/auth/claude-login.ts` (129) | Launches Playwright Chromium (headed by default), opens `https://claude.ai/login` (`:14, :46`), waits for a 200 on `claude.ai/api/organizations` (`:64-68`, 90 s timeout), then calls `context.cookies('https://claude.ai')` (`:81`) and saves them | Cookie capture. Evasion at `:19-26, :33-34, :38-40`, commented as "Evasion techniques in use" at `:56-61`. |
| `src/auth/cookie-grabber.ts` (224) | `grab-cookie`: probes `127.0.0.1:<port>/json/version` (`:106-113`), optionally `taskkill.exe /F` the user's Chrome/Edge (`:127-136`), relaunches it with `--remote-debugging-port` and the REAL profile `--user-data-dir` (`:139-150`, dir resolved at `:79-84`), attaches `chromium.connectOverCDP` (`:160`), reads `ctx.cookies(['https://claude.ai'])` from all contexts (`:173-201`), saves session (`:218`) | Cookie theft from the user's live browser. Line 72 uses `require('fs')` inside an ES module (lint rule `no-require-imports` flags it); likely a ReferenceError on the `--auto-restart` path (not executed, unverified). |
| `src/auth/discover-code-api.ts` (355) | Loads the saved session into Playwright, navigates to `https://claude.ai/code/<session_id>` (`:13, :133`), records every matching request/response/WebSocket (`:178-277`, bodies up to 200 KB at `:17, :250-252`), templatizes URLs (`:92-104`), writes a JSON dump (`:350-352`) | Reverse-engineering of private API surface; dumps real session payloads (the CCR `.gitignore:46-50` exists because of this). Note `req.headers()` in Playwright omits cookie headers (see 1.7). |
| `src/api/client.ts` (216) | Plain `fetch` client for `https://claude.ai/api` (`:19`): token-bucket limiter 1 req/s burst 3 with random jitter (`:21-53`); 401/403 -> `AuthError` (`:72-74`); 429 with `Retry-After` retry (`:76-86`); 5xx backoff (`:88-95`); methods `getOrganizations` `:115`, `listConversations` `:123`, `getConversation` `:131` (URL with `tree=True&rendering_mode=messages&render_all_tools=true` at `:135`), `deleteConversation` `:141`, `listProjects` `:149`, `createProject` `:156`, `moveConversationToProject` `:163` (PUT), `listProjectConversations` `:174`, `renameConversation` `:187` (PUT), `downloadFile` `:194` | Spoofed Chrome 135 Windows User-Agent (`:106-107`). Includes WRITE and DELETE calls on the user's account. |
| `src/api/code-session-client.ts` (202) | Client for `https://claude.ai/v1/sessions/...` using a Playwright `BrowserContext.request` so "Cloudflare bot management accepts the requests" (`:3-5`); sets `anthropic-beta: ccr-byoc-2025-07-29`, `anthropic-client-platform: web_claude_ai`, `anthropic-client-feature: ccr`, `x-organization-uuid` (`:7-11, :31-36, :126`); Cloudflare "warm up" page load (`:95-99`); evasion launch args/UA/webdriver override (`:78-93`) | Cookie replay + bot-challenge bypass. |
| `src/api/errors.ts` (26) | `AuthError`, `RateLimitError`, `ApiError` classes | No secrets. Message text tells the user to run `ccr login`. |
| `src/importers/ai-titler.ts` (100) | Creates a throwaway conversation named `CCR-TITLE-GEN` in the user's account (`:46-51`), POSTs to the consumer `/completion` endpoint with model `claude-haiku-4-5-20251001` (`:12, :67-81`) to get a title, then deletes it (`:95-98`) | Uses the consumer chat as a free LLM, mutates the account. |
| `src/utils/links.ts` (20) | URL builders for `https://claude.ai/chat/<id>`, `/code/<id>`, `/project/<uuid>` | Pure strings. This is the only network-adjacent module with a legitimate analogue (deep links), and GCR's SPEC FR-01 already covers it. |

### 1.3 CLI commands that touch the network (`src/index.ts`)

| Command (line) | Network/auth behavior |
|---|---|
| `login` (92) | Playwright login or `--cookie` paste |
| `grab-cookie` (120) | CDP cookie extraction, may kill/relaunch browser |
| `discover-code-api` (151) | Traffic capture of private endpoints |
| `status` (292), `logout` (306) | Local cookie file only |
| `list` (316; loadSession at 323), `get` (353; 359), `search` (379; 387) | Live consumer API reads |
| `get-code-session` (496; 511) | Playwright-backed `/v1/sessions` fetch |
| `extract-attachments` (789; 794), `extract-artifacts` (835; 840) | Live conversation tree fetch |
| `projects` (953; 960), `cache-projects` (1012; 1017) | Live project list |
| `probe-project-api` (1034; PROBE_CONV hard-coded at 1037) | Blind endpoint guessing: creates a project (`:1052-1056`), tries PATCH/PUT/POST variants moving a real conversation into it (`:1076-1125`), then deletes the project (`:1128-1152`). Labelled "read-probe" in its description (`:1036`) although it mutates. |
| `delete` (1162; 1167), `delete-empty` (1189; live path 1230-1250) | Irreversible remote deletion |
| `create-project` (1585; 1591), `move-to-project` (1608; 1612) | Remote writes |
| `probe-completion` (1640; 1647, fetches at 1661/1676/1692) | Creates conversation, posts to `/completion`, deletes it |
| `rename-project-conversations` (1704; 1710, `generateTitle` at 1746) | Bulk remote rename via consumer completion |
| `probe-file-download` (1779; 1787, fetches at 1809/1822) | Guesses `/api/{org}/files/{uuid}/{variant}` URLs with hard-coded real file UUIDs (1783, 1817) |
| `download-project-files` (1835; 1845) | Authenticated file download + `git init` + commit (`:1905-1910`, hard-coded project name "Nomad AV Rack" at 1894) |
| `extract-speaker-images` (1928) | Unauthenticated `fetch` of six hard-coded vendor PDF URLs (`src/importers/speaker-image-extractor.ts:152-230, 438`) - unrelated to conversations |
| `graph-build` (1392), `categorize` (1425) | Optional Gemini embeddings (egress of conversation text) |

Offline commands (no auth, no network): `import-sqlite`, `extract-entities`, `profile`, `profile-query`, `search-sqlite`, `search-entity`, `edit-history`, `search-attachments`, `main-branch`, `search-thinking`, `search-tools`, `search-content`, `stats`, `audit`, `branches`, `thread`, `delete-empty --local-only`, `rename-local-untitled`, `graph-query`, `graph-god-nodes`, `graph-export`, `graph-path`, `read-session`/`import-local-sessions`/`import-code-session` (local files; the first two read the OTHER product's `~/.claude/projects` JSONL: `src/importers/session-reader.ts:199, 251`; not relevant to ChatGPT).

Totals (grep): `src/index.ts` has 49 `.command(` calls; `src/mcp/tools.ts` has 33 `server.tool(` calls.

### 1.4 MCP tools that touch the network (`src/mcp/tools.ts`)

12 of 33 tools are live: `claude_login` (99; launches a browser from inside the MCP server), `list_conversations` (110), `get_conversation` (136), `search_conversations` (153), `get_conversation_as_context` (182), `extract_attachments` (321), `extract_artifacts` (364), `list_projects` (442), `delete_conversation` (472-495; deletes remotely with NO confirmation parameter), `get_code_session` (881), `list_code_sessions` (908), `search_code_sessions` (945). They share a module-level cached client (`:63-97`) that auto-loads the cookie session.

Other MCP-risk observations to avoid in GCR: nearly every offline tool takes an LLM-controllable `db_path` string (e.g. `:205, :225, :244`) with no approved-root check; `src/server.ts:3` says "22 tools" and registers version `0.1.0` (`:14`).

### 1.5 Scripts, hooks and docs in scope

| File | Role |
|---|---|
| `scripts/extract-edge-cookies.cjs` (191) | Standalone: `taskkill /F /IM msedge.exe` (`:69`), relaunch Edge with debug port and real profile (`:82-92`), `connectOverCDP` (`:102`), dedupe cookies, write `~/.ccr/session.json` (`:176-177`). CHANGELOG.md:21 describes it as bypassing "v20 App Bound encryption". |
| `scripts/Restart-ChromeWithCDP.ps1` (94) | `Stop-Process -Force` the browser (`:53`), relaunch with `--remote-debugging-port` + real profile (`:62-69`); leaves an unauthenticated local debug port open. |
| `scripts/fetch-code-session.ts` (127) | Same evasion stack + Cloudflare warm-up (`:207-221`), then GETs `/v1/sessions/<id>`, `/events`, `/share-status` (`:243-259`) and writes `fetched-<id>.json`. |
| `scripts/probe-code-session.ts` (62) | Guesses 11 candidate endpoint URLs with a raw `Cookie` header (`:123-155`); default session id hard-coded (`:105`). |
| `scripts/probe-page.ts` (96) | Evasion-configured headed browser with injected cookies, screenshot + body text dump to CWD (`:21-43, :72-93`). |
| `scripts/extract-sample.cjs` (31) | Writes `sample-conversations.json` with 100 random real conversations (first human message snippets, `:7-29`). `.gitignore:19-21` records "incident 2026-07-15: sample-conversations.json leaked 100 real conversations into git history". History in this checkout is a single commit, so whether the leak persists upstream is unverified. |
| `scripts/check-profiles.mjs`, `profile-one.mjs`, `session-readout.mjs`, `show-session.mjs`, `topic-scan.mjs`, `test-import-local.ts` | Local SQLite/JSON inspection helpers; no network. They hard-code real session/conversation IDs (e.g. `check-profiles.mjs:16`, `topic-scan.mjs:15`, `session-readout.mjs:16`, `test-import-local.ts:17`). |
| `.github/*` | Only Copilot instructions (`copilot-instructions.md`), 4 agent definitions, 2 instruction files. NO `workflows/`. The agents and instructions encode the auth doctrine: `.github/agents/auth.agent.md`, `.github/instructions/playwright-auth.instructions.md`. |
| `.claude/agents/auth-specialist.md:18,22` and `api-specialist.md:26` | The agent instructions describe Cloudflare bot detection as mitigated by stealth launch arguments and a real browser User-Agent string, and tell agents never to change the User-Agent to an automation string because that triggers Cloudflare (paraphrased; CCR has no licence file). |
| `README.md:216`, `.github/copilot-instructions.md:28` | Rate limiting is justified there as a way to avoid account flagging, i.e. as detection avoidance rather than as a documented quota (paraphrased). (`.github/copilot-instructions.md:43` and the checkout's `CLAUDE.md:67` mention the 1 s delay without that rationale.) |
| `HOOKS.md` | Audit of Claude Code hooks + git hooks (see section 4). Not network-related, but it embeds personal paths (`C:/Users/romar/...`, HOOKS.md:28-31; `.claude/settings.json:68`). |

### 1.6 Third-party egress

- `src/graph/embeddings.ts:8, :147-153` and `src/graph/categorize.ts:384-413`: if `GOOGLE_API_KEY`/`GEMINI_API_KEY` is set, conversation-derived text is sent to Google's `gemini-embedding-001`; otherwise TF-IDF fallback. `graph-build` runs this automatically (`src/index.ts:1392-1423`). No prominent privacy warning in README.
- `src/importers/speaker-image-extractor.ts`: fetches vendor PDFs; domain-specific, out of scope.

### 1.7 Facts from external sources

- Playwright `request.headers()` "does not return security-related headers, including cookie-related ones. You can use `Request.allHeaders` for complete list of headers that include `cookie` information." Source: https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/api/class-request.md (docs source file; accessed 2026-10-10). Consequence (inference, not run): `discover-code-api.ts:230` (`requestHeaders: req.headers()`) most likely does NOT write the Cookie header into the dump, but the dump still contains response bodies and payloads of private conversations.
- Chrome 136+ ignores `--remote-debugging-port` / `--remote-debugging-pipe` when they target the default Chrome data directory, specifically to stop cookie theft via the debug port; it must be paired with a non-default `--user-data-dir`. Source: https://developer.chrome.com/blog/remote-debugging-port (read via a web search summary, not a full page fetch; accessed 2026-10-10). `cookie-grabber.ts:79-84, :143-149` passes the DEFAULT Chrome user-data dir, so the Chrome path is very likely broken on current Chrome (not tested; Edge behavior unverified). This is a "platform is closing the hole" signal that reinforces not porting it.

### 1.8 Data-hygiene findings in the CCR repo (do not replicate)

- Hard-coded real-looking conversation/file/session IDs in source and tests: `src/index.ts:1037, 1643, 1783, 1784, 1817`; `tests/links.test.ts:24, 36`; scripts listed above.
- Domain-specific personal content in code: `src/index.ts:1894` ("Nomad AV Rack"), `:1682` (`America/Toronto`), `speaker-image-extractor.ts` vendor list, `src/importers/entity-extract.ts:14` topic list (includes personal terms), test strings such as "VOID Rack Build".
- Personal paths and a sibling private project in tracked config: `.claude/settings.json:68`, `claude-conversation-reader.code-workspace:7` (`../nomad-toronto-av`).
- `.mcp.json` runs `npx -y @modelcontextprotocol/server-time`; that package name returns HTTP 404 from the npm registry (checked 2026-10-10), so the "timestamp via MCP time server" rule (`.claude/rules/markdown-frontmatter.md`) relies on an unpublished name that anyone could claim.

---

## 2. DO NOT PORT TO GCR (with justification)

Rule of thumb: GCR has zero outbound contact with chatgpt.com or any OpenAI consumer surface, holds no credentials, and drives no browser outside the gated Phase 4. Each row names the CCR item, the boundary it conflicts with, and what GCR does instead.

| # | Do not port | CCR evidence | Conflicts with | GCR alternative |
|---|---|---|---|---|
| DNP-01 | Cookie session store, cookie-file format, `SESSION_PATH`, freshness logic | `src/auth/session.ts:13-150`; `src/types.ts:12-31` | B-SCOPE ("no replay of cookies"), B-NFR01 ("no raw session cookies"), B-AGENTS | No session concept. `gcr doctor` reports capabilities only. |
| DNP-02 | Manual cookie paste (`login --cookie`) | `src/index.ts:92-105`; `session.ts:85-124` | B-SCOPE, B-P4 ("capture credentials/session cookies") | Import a user-supplied official export file instead. |
| DNP-03 | Playwright login that captures cookies after sign-in | `src/auth/claude-login.ts:17-105` (capture at `:81`) | B-SCOPE, B-P1, B-STOP | None. Phase 4 is manual copy/export or manual draft insertion only. |
| DNP-04 | All bot-detection evasion: `--disable-blink-features=AutomationControlled`, forged Chrome UA, `navigator.webdriver` override, Cloudflare warm-up, "never change the UA" doctrine | `claude-login.ts:19-40, 56-61`; `discover-code-api.ts:152-168`; `code-session-client.ts:3-5, 78-99`; `scripts/fetch-code-session.ts:207-221`; `scripts/probe-page.ts:21-43`; `client.ts:106-107`; `.claude/agents/auth-specialist.md:18,22`; `api-specialist.md:26`; `CLAUDE.md:68` (checkout copy) | B-SCOPE ("no bypass of security protections"), B-P4 ("defeat authentication/bot protections"), B-STOP | If a browser UI is ever built, it must run as a normal, visible user session under the gated Phase 4 ADR. |
| DNP-05 | Cookie extraction from the user's real browser via CDP, including force-killing the browser, relaunching with a debug port on the real profile, and (per CHANGELOG) App-Bound-Encryption bypass | `src/auth/cookie-grabber.ts:98-224`; `scripts/extract-edge-cookies.cjs`; `scripts/Restart-ChromeWithCDP.ps1`; `CHANGELOG.md:21` | B-SCOPE (cookie capture + bypass), B-P4, B-STOP; also a local-security hazard (open debug port, data loss from `taskkill /F`) | None. Never implement. |
| DNP-06 | The authenticated consumer REST client (all verbs and URL builders) | `src/api/client.ts:19-216` | B-SCOPE ("no consumer live-history API"), B-NFR01 ("no private consumer API calls"), B-CI, SPEC.md:11 (a private URL does not make a conversation readable) | `NOT_IN_LOCAL_EXPORT` structured error for URLs not in the imported data (CODEX_TASK.md:23). |
| DNP-07 | Rate limiter/backoff designed around "avoid account flagging" | `client.ts:21-53, 76-95`; `README.md:216`; `.github/copilot-instructions.md:28` | Part of DNP-06. There is nothing to rate-limit in an offline tool. | Bounded memory and decompression limits for imports (CODEX_TASK.md:19, NFR-05). |
| DNP-08 | Claude Code `/v1/sessions` client, header recipe (`anthropic-beta`, `x-organization-uuid`, ...), Playwright request stack, and its 3 MCP tools | `src/api/code-session-client.ts` (whole); `scripts/fetch-code-session.ts`; `tools.ts:881-980` | B-SCOPE, B-STOP (and provider-specific) | A future Claude adapter may read only official exports (SPEC FR-14). |
| DNP-09 | Private-API discovery and probing tooling | `src/auth/discover-code-api.ts`; `src/index.ts:151-217` (`discover-code-api`), `1034-1160` (`probe-project-api`), `1640-1702` (`probe-completion`), `1779-1833` (`probe-file-download`); `scripts/probe-code-session.ts:123-155`; `scripts/probe-page.ts` | B-P4 ("inspect private APIs"), B-STOP | Documentation of unsupported paths in `docs/SECURITY_AND_BOUNDARIES.md` only. |
| DNP-10 | Using the consumer completion endpoint as an LLM, and creating/deleting scratch conversations in the user's account | `src/importers/ai-titler.ts:46-98`; `src/index.ts:1640-1702, 1704-1777` | B-SCOPE (private endpoint; unsupervised remote writes), B-STOP | Local deterministic title heuristics only (CCR's local `rename-local-untitled`, a feature idea, not code). Any LLM use is a separate, explicit, opt-in ADR. |
| DNP-11 | Remote mutations: delete, bulk delete-empty (live path), create project, move to project, rename | `client.ts:141-192`; `src/index.ts:1162-1262, 1585-1637, 1704-1777`; `tools.ts:472-495` (`delete_conversation` with no confirm flag) | B-SCOPE ("no unsupervised deletion or sending in the consumer UI"), SPEC.md:121 (writes limited to local drafts/annotations) | Local-only annotations/drafts in a separate namespace (FR-13). Local deletion, if offered at all, must be explicit and scoped to the GCR DB. |
| DNP-12 | Live-network MCP tools and `claude_login` MCP tool | `tools.ts:99-198, 321-420, 442-495, 881-980` | B-CI ("No network contact ... from CI or MCP"), B-NFR01 | `gcr_*` read tools on the local DB only (SPEC.md:121). |
| DNP-13 | Authenticated asset/file download | `client.ts:194-210`; `src/importers/project-downloader.ts:243`; `src/index.ts:1779-1930` | B-P1 ("never fetch exports using cookies"), B-SCOPE | Attachment metadata from the export; actual file content only when present and consented (FR-15). |
| DNP-14 | Third-party embedding egress enabled by an env var/CLI flag, secrets on argv | `embeddings.ts:8, 147-153`; `categorize.ts:384`; `index.ts:1396-1402, 1428-1433` | B-NFR06 ("no hosted vector indexing by default"), B-SCOPE ("no silent upload") | Local TF-IDF/k-means only. A remote embedding provider would need its own reviewed ADR, explicit consent text, and key via a secret store, never `--api-key`. |
| DNP-15 | `dotenv/config` auto-load | `src/index.ts:10` | B-NFR01 | GCR needs no secrets. |
| DNP-16 | Hard-coded real IDs, personal domain data, vendor URLs, personal paths, and generated artifacts of real data | section 1.8 | B-CI ("No real exports in tests"), SPEC.md NFR-06 | Synthetic fixtures only; CI privacy scan. |
| DNP-17 | Dependencies solely serving the above (`playwright`, `chrome-remote-interface`, `dotenv`, `@google/generative-ai`, `@napi-rs/canvas`/`pdfjs-dist`/`sharp` for speaker images) | `package.json:33-52` | B-NFR01, minimal attack surface | Do not add to GCR runtime. A browser test dependency may be added only under the gated Phase 4 ADR. |

Safe to INVENTORY (features/data shapes only, no code reuse) because they have no network or auth: `src/importers/*` except `ai-titler.ts`, `project-downloader.ts`, `speaker-image-extractor.ts`; `src/extractors/*`; `src/graph/*` except `embeddings.ts`/`categorize.ts` embedding path; and the offline MCP tools. Verified by grep that none of these import `../auth/` or `../api/`; `project-downloader.ts` only takes a `ClaudeApiClient` (type from `src/types.ts:185`) as a parameter. Two input formats to be careful with in the matrix: official-export JSON (in scope) vs. `~/.claude/projects` JSONL and fetched `/v1/sessions` dumps (Claude-specific and not an OpenAI export).

---

## 3. License and attribution facts

### 3.1 Files

- `git ls-files | grep -i -E 'licen|notice|copying|authors|attribution|third'` returned nothing (grep exit 1). Repo root listing (`ls -la`): no `LICENSE*`, `NOTICE*`, `COPYING*`. `.github/` contains only `agents/`, `instructions/`, `copilot-instructions.md`. No `node_modules/` in the checkout, so no vendored third-party license files.
- The tracked file list (98 files) was reviewed in full; no license text is embedded in any file.
- The GCR checkout also has no LICENSE file in its root and no `license` field in its package.json at the time of reading (verified with `ls`/`grep`). That is a GCR decision to record, not a CCR fact.

### 3.2 package.json

- `package.json:31` `"license": "ISC"`; `:30` `"author": ""`; no `repository`, `homepage`, `bugs`, `engines`, `files`, or `private` fields. Version `1.0.0` (`:3`). `package-lock.json:10` root entry also says `"license": "ISC"`.

### 3.3 Statements elsewhere

- A case-sensitive and case-insensitive grep over tracked files (excluding the lockfile) for license, copyright, SPDX, attribution, third-party, notice, credit, forked-from, derived-from found only: `package.json:31`; `.claude/rules/markdown-frontmatter.md:59` ("Third-party libraries (`vis-network.min.js`)" exempt from version headers); an unrelated regex keyword in `src/importers/conversation-profiler.ts:156`, and the unrelated phrase "derived from" in `.claude/skills/ccr-graph/SKILL.md:3`.
- README.md has no license section (headings: Prerequisites, Installation, Quick Start, CLI Reference, MCP Server, Security, Architecture). CHANGELOG.md has none. No source header contains a copyright or license line (headers carry `@file/@description/@version/@created/@lastUpdated` only, e.g. `src/auth/session.ts:1-7`).
- No third-party notices file, although the graph export copies `vis-network.min.js` next to the generated HTML (`src/graph/export.ts:15, 926`). The minified file carries its own banner naming a dual Apache-2.0/MIT license (seen in the scratch install), but CCR adds no notice of its own.
- Provenance flags that cannot be resolved from the repo: `AUDIT-conversation-profiler.md:3` describes mapping a "Generic Transcript Semantic Profiler" onto CCR and `:128, :135` say regexes were "adapted"/"Same regex" - the external origin and its license are not named. `.github/agents/researcher.agent.md:27` mentions the "claude-conversation-export bookmarklet" only as a tool to cross-reference. Neither is a statement of derivation, but neither is a statement of independence either.
- Authorship in this checkout: one commit by one git identity (handle `thisis-romar`). That is not a statement of who owns the copyright.

### 3.4 Dependency licenses (declared, summary)

Method: `package-lock.json` (lockfileVersion 3) has NO `license` field for dependencies, so I looked up each locked name@version in the npm registry on 2026-10-10 (466 lock entries). Values are what the packages declare; I did not read each tarball's LICENSE file.

| Declared license | Count |
|---|---|
| MIT | 360 |
| ISC | 40 |
| Apache-2.0 | 31 |
| LGPL-3.0-or-later | 10 |
| BSD-2-Clause | 9 |
| BSD-3-Clause | 6 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| BlueOak-1.0.0 / Python-2.0 / 0BSD | 1 each |
| (MIT OR WTFPL), (BSD-2-Clause OR MIT OR Apache-2.0), (Apache-2.0 OR MIT) | 1 each |

Non-permissive or unusual entries:

- Weak copyleft (LGPL-3.0-or-later), all optional platform binaries pulled by the direct dependency `sharp@0.34.5`: `@img/sharp-libvips-{darwin-arm64,darwin-x64,linux-arm,linux-arm64,linux-ppc64,linux-riscv64,linux-s390x,linux-x64,linuxmusl-arm64,linuxmusl-x64}@1.2.4` (LGPL-3.0-or-later); `@img/sharp-win32-{arm64,ia32,x64}@0.34.5` (Apache-2.0 AND LGPL-3.0-or-later); `@img/sharp-wasm32@0.34.5` (Apache-2.0 AND LGPL-3.0-or-later AND MIT).
- `argparse@2.0.1` (dev): Python-2.0. `expand-template@2.0.3` (prod): "(MIT OR WTFPL)". `rc@1.2.8`: tri-license choice. `vis-network@9.1.13` (prod, direct): "(Apache-2.0 OR MIT)".
- No GPL, AGPL, SSPL, or commercial/proprietary identifiers declared.
- Direct production deps: @google/generative-ai 0.24.1 Apache-2.0; @modelcontextprotocol/sdk 1.29.0 MIT; @napi-rs/canvas 0.1.100 MIT; better-sqlite3 12.8.0 MIT; chalk 5.6.2 MIT; commander 14.0.3 MIT; dotenv 17.4.1 BSD-2-Clause; ora 9.3.0 MIT; pdfjs-dist 3.11.174 Apache-2.0; playwright 1.59.1 Apache-2.0; sharp 0.34.5 Apache-2.0; vis-network 9.1.13 (Apache-2.0 OR MIT); zod 3.25.76 MIT. Dev: all MIT except typescript 6.0.2 Apache-2.0.
- For reference, GCR's pinned dependencies (not CCR's) declare: @modelcontextprotocol/sdk 1.32.1 MIT, zod 4.6.5 MIT, fast-check 4.10.2 MIT, typescript 7.0.2 Apache-2.0, @types/node 22.20.5 MIT (npm registry, 2026-10-10).

### 3.5 What can and cannot be concluded about reuse rights

Can be stated as fact:

1. No license text, copyright notice, NOTICE, or third-party notice exists in CCR at f66e24e.
2. The maintainer set the package metadata field to the SPDX id `ISC`.
3. GitHub's own documentation says: "without a license, the default copyright laws apply, meaning that you retain all rights to your source code and no one may reproduce, distribute, or create derivative works from your work." Source: https://raw.githubusercontent.com/github/docs/main/content/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository.md (docs source file, accessed 2026-10-10).
4. The standard ISC text conditions its permission on the copyright notice and permission notice appearing in all copies, and its template has `Copyright <year> <owner>` placeholders (SPDX list data: https://raw.githubusercontent.com/spdx/license-list-data/main/text/ISC.txt, accessed 2026-10-10). CCR supplies no such notice or holder name.

Cannot be concluded (do not assert):

- That CCR code is available to the public or to EMBLEM-NLP projects under ISC. A metadata field with no accompanying text and no named holder is not enough for me to assert a grant; whether it is legally sufficient is a legal question outside this task.
- Who owns the copyright (empty `author`, single git identity, org vs individual unknown), whether all contributors assigned or licensed their work, or whether any file includes third-party code (see the profiler provenance flag).
- Whether the live upstream repository still equals f66e24e or has since added a LICENSE or changed GitHub license metadata. Unverified: `gh api repos/EMBLEM-NLP/claude-conversation-reader-public` returned HTTP 403 ("GitHub access to this repository is not enabled for this session"), and I did not attach the repo or call `git fetch` (that would change the CCR checkout).
- That the plan "inventory features and data shapes, write original code" is legally sufficient. It is a risk-reduction practice consistent with B-LIC, not a determination.
- Anything about Anthropic's or OpenAI's terms of use. No ToU analysis was performed; the DO NOT PORT list rests on the GCR boundary documents, not on a ToU reading.

Recommended handling (process, not legal advice):

- Treat CCR as a reference-only, all-rights-reserved-by-default source: no copying of code, regex lists, prompt text, HTML/JS templates, doc prose, tests, or agent files. Describe behaviors in the parity matrix in original words and link to paths and lines.
- Ask the EMBLEM-NLP owner to either add a LICENSE with a named copyright holder to CCR, or to state in writing that GCR may reuse specified parts; record the outcome in a GCR ADR (`docs/DECISIONS.md`) before any code reuse.
- Decide GCR's own license and add it, since GCR currently has none; keep third-party notices for anything bundled (for example any HTML graph export that embeds a charting library).
- Resolve the profiler provenance question before even adapting its category list.

---

## 4. Conventions worth mirroring (concepts, no code copying)

### 4.1 What CCR does, with evidence and a GCR recommendation

| Area | CCR practice | Observed reality (run 2026-10-10 in a scratch copy) | Recommendation for GCR |
|---|---|---|---|
| Test runner | Vitest `^2.1.9` (`package.json:57`); `npm test` = `vitest run` (`:19`); `tests/*.test.ts`; no vitest config file; no coverage provider in devDependencies | 5 files, 35 tests, all pass after building the native addon | GCR already uses `node --test` plus `fast-check`; keep it. Add a coverage summary (CODEX_TASK Phase 3) which CCR lacks. |
| Type check | `tsc --noEmit`; strict, ES2022, NodeNext (`tsconfig.json`); `include` is `src/**/*` only | typecheck and build produced no errors | Include `test/` in typechecking (CCR does not, so tests are never type-checked or linted). GCR's `tsconfig.json` + `tsconfig.build.json` split already does this. |
| Lint | ESLint 9 flat config, `typescript-eslint` recommended (not type-checked rules) (`eslint.config.js:15-33`); `npm run lint` = `eslint src/` | 44 errors in 6 files: index.ts 18, speaker-image-extractor.ts 13, tools.ts 6, project-downloader.ts 5, client.ts 1, cookie-grabber.ts 1 (21 `no-explicit-any`, 17 `no-unused-vars`, 2 `no-useless-assignment`, 2 `no-empty`, 1 `no-require-imports`, 1 `preserve-caught-error`) | If GCR adopts ESLint, gate it in CI (CCR's gate is only a local hook). |
| Format | Prettier: `semi`, `singleQuote`, `trailingComma: all`, `tabWidth 2`, `printWidth 120` (`.prettierrc`); `npm run format` = `prettier --write src/`; VS Code format-on-save (`.vscode/settings.json`) | No `--check` script, so formatting cannot be gated | Add a `format:check` and `.editorconfig` (GCR has `.editorconfig` already). |
| Git hooks | `.githooks/` opt-in via `npm run install-hooks` (`package.json:21`); `HOOKS.md:53-59` itself says they are inert until configured. pre-commit: sensitive-file guard, typecheck, lint, test (`.githooks/pre-commit:12-42`). pre-push: typecheck, lint, build, doc-vs-code tool-count audit (`pre-push:26-37`). prepare-commit-msg: blocks commit messages containing words like "secret", "password", "sessionKey" (`:11-27`). Claude Code hooks (`.claude/settings.json`): Stop hook that exits 2 until work is committed AND pushed (`stop-git-check.sh`), PostToolUse hook that bumps `@lastUpdated`/`last_updated` and auto-`git add`s (`post-edit-update.sh:59-78`) | Defects found: the sensitive-file regex `".env|.session.json|*.sqlite$|..."` is unanchored with leading `*` (GNU grep warns "* at start of expression"); tested with GNU grep it BLOCKS `src/environment.ts`, `.env.example` (a tracked file), `dir/session.json`, and `x.sqlite`, while allowing `notes.sqlite.bak`. The commit-msg keyword list would block a GCR commit that merely documents "secrets" boundaries. The pre-push audit only checks one string in CLAUDE.md. | Mirror the idea of a secrets/real-data guard but implement it as an anchored path allow/deny list plus a content scan, and run it in CI (no hooks required). Do not copy the stop-hook "commit and push everything" behavior: GCR rules say never silently upload private material (B-SCOPE). Do not auto-stage files from a hook. |
| CI | None. No `.github/workflows/`, no dependabot, CODEOWNERS, SECURITY.md, CONTRIBUTING, issue templates (`git ls-files` confirms). Doc claims in `CLAUDE.md` (checkout copy) line 24: "There are no automated tests" - false, `package.json:19` and 5 test files exist. | `npm ci` FAILS on npm 10.9.4 / Node 22.22.0 with ERESOLVE: `@eslint/js@10.0.1` has an optional peer `eslint ^10` but `package.json:52` pins `eslint ^9.39.4`. `npm ci --ignore-scripts --legacy-peer-deps` installs 362 packages; `npm rebuild better-sqlite3` then succeeds. Without the native addon: 31 tests pass, 4 skipped, 1 suite fails (bindings missing). `npm audit` (advisory DB on 2026-10-10): 27 findings (1 low, 7 moderate, 15 high, 4 critical); direct deps with high/critical: `@modelcontextprotocol/sdk`, `pdfjs-dist`, `sharp`, `vitest`. | GCR must ship CI (CODEX_TASK Phase 3): `npm ci`, read-only token, pinned actions, audit, privacy scan, synthetic fixtures only. Keep lockfile reproducible and prove it with a clean `npm ci` job. |
| Docs | YAML front matter (`title/description/version/created/last_updated`) on markdown (`.claude/rules/markdown-frontmatter.md`), JSDoc `@file/@version/@created/@lastUpdated` header on code, Keep-a-Changelog (`CHANGELOG.md:12`), per-module "what it owns" table in CLAUDE.md, agent/skill docs (`.claude/agents` x8, `.claude/skills` x3, `.github/agents` x4), an `AUDIT-*.md` feature-mapping doc, `HOOKS.md` hook inventory | Compliance is incomplete: 9 code files lack the header (`scripts/extract-edge-cookies.cjs`, `extract-sample.cjs`, `fetch-code-session.ts`, `probe-code-session.ts`, `probe-page.ts`, `src/api/errors.ts`, `tests/errors.test.ts`, `tests/extractTitle.test.ts`, `tests/session.test.ts`); 6 `.github/**/*.md` files lack front matter. Counts disagree: MCP tools = 33 in code and CLAUDE.md:40 and README.md:178, but `src/server.ts:3` says 22, `.github/copilot-instructions.md:18` says 27, README.md:223 says "30 tools" and README.md:222 says "26 commands", while `src/index.ts:4` says 39 commands and the code has 49 `.command(` calls. Versions disagree: package.json 1.0.0, CHANGELOG top entry 1.1.0 (front matter says 2.0.0, last_updated 2026-04-15 yet has a 2026-04-16 entry), `src/index.ts:87` and `src/server.ts:14` say 0.1.0. | Mirror: Keep-a-Changelog with explicit tested vs untested wording (CODEX_TASK deliverable H), an architecture table of modules, a security/boundaries doc, an ADR log. Avoid: per-file timestamp stamping (diff noise, needs an auto-staging hook; GCR specs do not require it) and hand-maintained counts; generate counts or assert them in a test against the code registry. One source of truth for the version (read it from package.json). |
| Secrets hygiene | `.gitignore` lists `.env`, `*.sqlite`, graph outputs, `sample-conversations.json`, `code-api-*.json`, `fetched-session_*.json`, `probe-session_*` and records the 2026-07-15 leak incident (`.gitignore:19-21, 46-50`); session file refused inside the project tree (`session.ts:17-30`); skills say "Never commit real conversation data" (`.claude/skills/ccr/SKILL.md:24`) | Leak happened anyway (script wrote real data into the working tree). | Mirror the concepts: deny-list for local DB/exports/logs, runtime refusal to write DB/exports/logs inside a git work tree unless forced, synthetic-only fixtures, CI privacy scan. |
| Error taxonomy | Typed `AuthError`/`RateLimitError`/`ApiError` with status fields (`src/api/errors.ts`) | Tested (10 tests) | GCR already specifies structured error codes (SPEC FR-09, `NOT_IN_LOCAL_EXPORT`). Keep a typed code enum, no remote-error classes. |
| Guidance that the offline path is more durable | `.claude/skills/ccr/SKILL.md:89`: official export path "doesn't depend on the undocumented live API or cookie freshness" | n/a | This is CCR's own endorsement of GCR's model; cite it in the ADR for Mode A. |
| Separation of network from core | Core modules do not import `auth/` or `api/` (grep-verified) | n/a | Enforce it in GCR with a dependency-boundary test (no network imports outside an allow-listed module). |

### 4.2 Things CCR does that GCR should deliberately NOT mirror

- Opt-in-only local hooks as the sole quality gate; absent CI.
- `npx -y` execution of an unpinned (and unpublished) MCP package from `.mcp.json`.
- Docs that contradict code (test existence, counts, versions) and agent files that teach evasion.
- Tests that re-implement the function under test (section 5).

---

## 5. Test inventory (`tests/`, vitest, 35 tests, all passing in scratch run)

| File | Tests | Behaviors actually exercised | Notes |
|---|---|---|---|
| `tests/errors.test.ts` | 10 | `AuthError`/`RateLimitError`/`ApiError`: `name`, `status`, `retryAfter`, message contains status/text, `instanceof Error` | Pure class shape tests. No header. |
| `tests/session.test.ts` | 6 | Staleness rules: missing `sessionKey` -> false; expired -> false; `expires=-1` -> true; future -> true; other cookies expired but `sessionKey` valid -> true; lone expired `sessionKey` -> false | Imports only the `CookieEntry` type and re-implements `isSessionFresh` inline (comment at `:3-5`, copy at `:10-16`), so it does not execute `src/auth/session.ts` at all. Zero coverage of the real module (file I/O, cookie-string parsing, project-tree guard). No header. |
| `tests/links.test.ts` | 5 | `CLAUDE_BASE` value; `conversationUrl` builds `/chat/<id>`; `projectUrl` builds `/project/<uuid>` | The `session_` -> `/code/` branch (`src/utils/links.ts:13-16`) and `projectConversationUrl` are untested. Uses real-looking UUIDs (`:24, :36`). |
| `tests/extractTitle.test.ts` | 10 | `extractTitle`: empty -> null; very short -> null; strips fenced code, inline code, header markers, bold markers; truncates at 80 chars with ellipsis; capitalizes first letter; `skipBoilerplate` option; returns first sentence | Only the pure helper from `conversation-renamer.ts`; the rest of the renamer (entity/first-message fallbacks, DB writes) is untested. No header. |
| `tests/sqlite-search-grouped.test.ts` | 4 | `searchMessagesGrouped`: grouped by conversation with `hit_count`, `top_snippets` (<= 3, with sender/text/created_at), no hits for unknown term, sorted by `hit_count` desc; `searchByEntityGrouped`: groups by conversation, `hit_count >= 2` | Builds a hand-written schema in `os.tmpdir()` (`:21-55`) instead of using `import-sqlite.ts`, so it can drift from the real schema. Imports `searchContentGrouped`, `writeFileSync`, `unlinkSync` but never uses them (`:10, :13`); never deletes the temp DB (no `afterAll`). |

Not covered at all (no test imports them): conversation tree flattener (`extractors/conversation.ts`: last-child rule, missing parents, chronological fallback), formatter (markdown/JSON/compact), `search.ts`, `import-sqlite.ts` (schema, FTS5 triggers, bulk insert, idempotency), `entity-extract.ts`, `advanced-queries.ts` (edit history, branches/threads, audit, local delete), profiler, all graph modules (build, cluster, kmeans, query, analyze, HTML export and its escaping), all 33 MCP tools and the server, the CLI, `api/client.ts` (limiter, 401/403/429/5xx handling), `session.ts` real I/O, `import-code-session.ts`, `session-reader.ts`, `project-downloader.ts`, FTS5 query sanitization and malformed-query handling, Unicode and large-input behavior. No fixtures directory, no coverage tooling, no integration/MCP-client test, no property tests.

Behaviors in the table above that are worth re-deriving as GCR tests from the SPEC (not from CCR code): grouped search ordering/snippet cap, title extraction edge cases, structured error shape, URL building including non-matching schemes, and boundary tests asserting that no module outside an allow-list can make network calls.

---

## 6. Commands run and their results (for the evidence trail)

| Command (in scratch copy from `git archive HEAD`, Node v22.22.0, npm 10.9.4) | Result |
|---|---|
| `npm ci --ignore-scripts` | FAIL, ERESOLVE (`@eslint/js@10.0.1` optional peer `eslint ^10` vs `eslint ^9.39.4`) |
| `npm ci --ignore-scripts --legacy-peer-deps` | OK, 362 packages |
| `npx vitest run` before native build | 31 passed, 4 skipped, 1 suite failed (better-sqlite3 bindings not found) |
| `npm rebuild better-sqlite3` then `npx vitest run` | 5 files, 35/35 tests passed |
| `npm run typecheck` / `npm run build` | no errors printed |
| `npm run lint` | 44 errors (breakdown in section 4.1) |
| `npm audit --json` | 27 vulnerabilities: 1 low, 7 moderate, 15 high, 4 critical (advisory data of 2026-10-10) |
| Registry lookups | 466 lock entries resolved for declared license; `@modelcontextprotocol/server-time` -> HTTP 404 |
| `gh api repos/EMBLEM-NLP/claude-conversation-reader-public` | HTTP 403 (access not enabled); upstream state UNVERIFIED |
| `WebFetch` for docs.github.com, playwright.dev, developer.chrome.com | DNS/proxy failure; used raw.githubusercontent.com sources (GitHub docs, Playwright docs) and one web search summary (Chrome) instead |

Not run / unverified: runtime behavior of any auth script (intentionally not executed), the `require('fs')` ESM issue at `cookie-grabber.ts:72`, Chrome 136 effect on the Edge path, live upstream license metadata, tarball-level license text of dependencies.
