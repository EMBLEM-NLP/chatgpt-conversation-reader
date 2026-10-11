# Changelog

All notable changes to GCR (EMBLEM-NLP ChatGPT Conversation Reader & Writer) are recorded here, in the spirit of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow the `package.json` version. This file states, for every entry,
what was **tested** (by whom, how, with which numbers) and what was **not**. A passing test run on synthetic data is not evidence that
a real ChatGPT export imports correctly.

## 0.2.0-dev.0 - unreleased

First entry of a clean-room implementation of `SPEC.md` (target "GCR v0.2.0"). It is **not** a release: the package is `private`, there is no
`LICENSE` file (ADR-0008) and no tag. The version `0.2.0-dev.0` was chosen so that it does not imply lineage with the baseline v0.1.1,
which was never available (ADR-0001).

### Added (what exists)

* **CLI `gcr`** (`dist/cli/main.js`): `doctor`, `import`, `import-copy`, `batches`, `list`, `get`, `search`, `branches`, `thread`, `stats`, `audit`,
  `graph build|query|path|neighbors|god-nodes|explain|export`, `draft create|list|show|archive`, `annotate create|update|list|show`, `mcp`, `help`.
  Output formats `markdown` (default), `compact`, `json`, `jsonl`; stable exit codes per error code; stdout carries only the result. 31 help pages are captured in `docs/CLI_HELP.txt`.
* **Local MCP server** (stdio, `dist/mcp/entry.js` or `gcr mcp`): 12 tools (`gcr_list`, `gcr_get`, `gcr_search`, `gcr_branches`, `gcr_thread`, `gcr_stats`, `gcr_audit`, `gcr_graph_query`,
  `gcr_doctor`, `gcr_create_local_draft`, `gcr_update_local_annotation`, `gcr_import_export`). Read-only by default; writes need `--allow-local-writes`; import needs approved roots.
  One result envelope with `source`, `completeness`, `warnings`, `ids`, `untrustedContent`. The legacy `chatgpt_*` alias table is empty because the v0.1.1 names are unknown (ADR-0002).
* **TypeScript SDK** (`Gcr` facade, `src/index.ts`) shared by the CLI and the MCP server; typed results and `GcrError` with 28 stable error codes (`src/errors.ts`).
* **Import** from an official export ZIP, an extracted folder, `conversations*.json`, sharded `conversations-NNN.json` (with or without `export_manifest.json`), a ZIP nested one level, and standard input.
  First-party ZIP reader (STORE/DEFLATE; rejects traversal, symlinks, encryption, duplicates, bombs) and streaming JSON splitter with explicit limits. Atomic, idempotent import; immutable snapshots with a
  per-conversation head; account labels; `--strict`. Adapters: ChatGPT (full), Claude export (offline data shape), OpenAI developer API (interface plus a disabled implementation, Mode D).
* **Mode B manual copy** (`import-copy`), always `partial_user_supplied`.
* **SQLite schema v1** (`node:sqlite`, STRICT tables, FTS5 index, immutability triggers, `local_*` tables for drafts, annotations and an append-only audit log, derived graph tables) with versioned migrations.
* **Search**: plain mode (Unicode NFKC, case and accent insensitive, CJK by character, prefix `word*`, implicit AND), `--raw` FTS5 mode, scopes, filters, `--limit/--offset/--cursor` paging, snippets.
* **Branches**: cycle-safe tree analysis, branch ids = leaf ids, active branch only from a valid `current_node` (ADR-0009), opt-in labelled heuristics (`last_child`, `latest_leaf`).
* **Stats and audit** (by role, model, channel, day, conversation, provider, content type; nine audit checks) that never infer a model or a timestamp.
* **Entity extraction and knowledge graph** (URLs, UUIDs, timestamps, tool names, code languages, file names, keywords), deterministic label-propagation communities, query, shortest path, neighbours, god nodes,
  evidence for every edge, and a self-contained offline HTML export (strict Content-Security-Policy, no network references).
* **Local drafts and annotations** (Mode C) with namespaces, optimistic concurrency and an audit log; a draft has no "sent" state and carries a manual continuation link.
* **Dev tooling**: privacy scanner (`scripts/privacy-scan.mjs`), dependency license inventory (`scripts/licenses.mjs`), CLI-help capture and MCP-schema dump with `--check` modes, a gated `test:browser` that reports `NOT_RUN`, a smoke script (`scripts/ci-smoke.mjs`), a SHA-pinned read-only GitHub Actions workflow and a devcontainer definition.
* **Documentation**: README, user guide, CLI reference, MCP tools, SDK, import guide and format notes, adapters, architecture, decision records ADR-0001 to ADR-0012, browser gate, execution plan, PR notes.
* **Mode E (browser interaction) ships no code** (ADR-0010, `docs/BROWSER_GATE.md`).

### Tested

Everything below used **synthetic, invented data** only. Dates are 2026-10-11 unless stated; platform Linux (x64 sandbox, running as `root`).

| What | How | Result |
|---|---|---|
| Typecheck and build | `npm run typecheck`, `npm run build` (TypeScript 7.0.2) | exit 0 both, Node 22.22.0 |
| Full compiled test suite, **Node 22.22.0** | `npx tsc -p tsconfig.json --outDir dist-test-docs && node --test --test-concurrency=2 "dist-test-docs/test/**/*.test.js"` | @@FINAL_2222@@ |
| Full compiled test suite, **Node 22.16.0** (declared minimum) | same command with the 22.16.0 binary | @@FINAL_2216@@ |
| Earlier whole-suite run, Node 22.22.0, same day | same command, started 12:24 UTC, before the last concurrent edits | 6,568 tests, 6,566 pass, 0 fail, 2 skipped, 261.7 s |
| Test skips | both skips say "running as root: file permissions are not enforced" | the unreadable-file paths are **untested** here |
| Privacy scan | `npm run build && node scripts/privacy-scan.mjs --root .` | @@PRIVACY@@ |
| Dependency audit | `npm audit --omit=dev --audit-level=high` (this contacts the npm registry) | "found 0 vulnerabilities", exit 0 |
| Licenses | `node scripts/licenses.mjs` | 98 packages (92 runtime, 6 dev), 0 unknown, 0 non-permissive, release gate PASS |
| Smoke script | `node scripts/ci-smoke.mjs` (builds a ZIP of the 13 fixtures, drives the built CLI and the built MCP server over real stdio with the SDK client, network guard active) | @@SMOKE@@ |
| Doc freshness | `node scripts/dump-mcp-schemas.mjs --check`, `node scripts/capture-cli-help.mjs --check` | both "up to date" (31 help pages) |
| Browser gate | `node scripts/test-browser-gated.mjs` | prints `NOT_RUN: no browser code exists in this build ...`, exit 0 (not a pass) |
| Old-Node behaviour | `gcr doctor` and `gcr import` under a real Node 22.13.1 binary | `doctor` reports "TOO OLD" and "FTS5 NOT available"; `import` fails with `DB_ERROR` / `FTS5_UNAVAILABLE`, exit 5, no database file created |
| CLI by hand | import (ZIP, sharded ZIP, folder, nested ZIP, stdin, re-import, second snapshot, account labels), list, get by UUID and by link, branches, thread, search (plain, prefix, CJK, accents, raw, filters, paging by offset and cursor), stats, audit, graph (build, query, path, neighbors, god-nodes, explain, export), drafts, annotations, import-copy, doctor, and 21 distinct error codes through the CLI (23 with the two MCP-only ones) | outputs reproduced in `docs/USER_GUIDE.md` and `README.md` |
| MCP by hand | the official SDK client over stdio against `dist/mcp/entry.js`: `tools/list` (12 tools with annotations), read calls, `NOT_IN_LOCAL_EXPORT`, `WRITE_FORBIDDEN` and `IMPORT_PATH_NOT_ALLOWED` in the default mode, then a server with `--allow-local-writes` and an approved root (import accepted inside the root, refused outside and via `..`; draft; annotation create, update, stale-version conflict); a raw JSON-RPC pipe through `gcr mcp` | as described; stdout carried only JSON-RPC, stderr empty |
| Graph page | generated by `gcr graph export`, searched for network references, read for structure | one Content-Security-Policy meta tag, no external URL; skip link, filter, sortable table; **not opened in a browser** |
| Per-milestone history | each milestone head was extracted with `git archive` into a scratch folder and typechecked, built and tested on Node 22.22.0 | see `docs/PR_NOTES.md` (M0: 68c016d typecheck/build green, no tests; M1 head bc6af53: 5,807 tests, 1 failing test; M2 head 99cd600: see PR notes) |

### NOT tested / not verified

* **A real ChatGPT export.** None was available. File names, the `mapping` tree, shards, the manifest, asset naming, `children` and `current_node` presence, timestamps and model fields are community reports (see `docs/IMPORT_FORMAT.md`) exercised only by invented fixtures. **GCR has never imported a real export.**
* **The GitHub Actions workflow has never run on GitHub.** `.github/workflows/gcr-ci.yml` and `.devcontainer/devcontainer.json` were authored and their steps were run locally, one by one; the pinned action SHAs were resolved with `git ls-remote` on 2026-10-10 and not re-checked; the runner images and the Node versions they install were never exercised.
* **Node 24 and newer.** No such binary was available. Node 22.16.0 to 22.22.0 only (and 22.13.1 for the refusal path); the other Node 22.x binaries listed in ADR-0012 were run at that time, not in this entry.
* **Windows and macOS.** Path handling, file modes and `realpath` behaviour on those systems are untested.
* **OpenAI Terms of Use, Usage Policies and help-center pages: not readable from the sandbox, so the platform policy review was NOT PERFORMED.** No OpenAI clause is quoted or paraphrased as fact in this repository. The statements about how to request an export are OFFICIAL but could not be re-verified.
* **Real MCP clients** (VS Code, Claude Desktop, Codex): only the official SDK client was used. The configuration snippets follow those clients' documented shape as the authors knew it. HTTP/SSE transports do not exist.
* **Encryption at rest**: none exists. Disk-level encryption and file-permission behaviour under other users were not tested.
* **Permission-denied paths**: the suite ran as `root`, where file permissions are not enforced (two tests skip).
* **A browser or screen reader on the graph HTML**; keyboard behaviour is described from the generated file only.
* **Live behaviour of the browser features**: none exist (Mode E is gated; Mode D is a disabled adapter). No "live send" of any kind was attempted or is possible.
* **`npm ci` from an empty `node_modules`** was not re-run for this entry (no network was permitted for installs); the lockfile is committed and `node_modules` was already present.
* **Large inputs on real hardware**: the 50,000-message synthetic scale test passes in the suite; no real-size export (hundreds of MB, multi-GiB ZIP64) was imported. `docs/PERFORMANCE.md` is a separate deliverable and is not summarised here.
* **Parity with the Claude Conversation Reader (CCR)** is a feature inventory only; no CCR code was copied or run, and CCR has no `LICENSE` file (ADR-0008).

### Known issues

* CLI messages sometimes use SDK vocabulary: the limit remedy says `maxElementBytes` (flag: `--max-element-bytes`), the annotation-conflict remedy says `getAnnotation` (command: `gcr annotate show`), the ambiguity remedy mentions an "object reference".
* The nested-ZIP limit (256 MiB per inner archive) has no CLI flag (SDK option only).
* A conversation object that has both `mapping` and a `conversations` array is skipped as `NOT_A_CONVERSATION`; the wrapper rule applies only to objects without `mapping`.
* The batch-level `completeness` is the adapters' nominal level; each conversation's own value is authoritative (`COMPLETENESS_BELOW_BATCH_LEVEL` reports the difference).
* `gcr stats` and `gcr audit` print `formatProfiles: []`; the observed format profile is available only in the import report.
* `gcr batches` shows message counts without the structural root rows, while the import report's `messages.stored` includes them (43 versus 39 in the demo); both are correct, the difference is not explained in the output.
* Branch ids are compared by UTF-16 code units in the branch analysis but SQLite orders by UTF-8 bytes; the two orders differ only for ids outside the Basic Multilingual Plane. Not yet documented in `docs/ARCHITECTURE.md`.
* The ZIP reader does not compare local-header CRC and sizes with the central directory when the data-descriptor bit is clear (design decision, still to be recorded as an ADR line). A JSON nesting depth of 10,000 aborts a file while the adapter keeps 256 levels (documented in `docs/IMPORT_GUIDE.md`).
* `FEATURE_GATED` and `REMOTE_ACCESS_FORBIDDEN` are defined error codes that no code path emits.
* The result-size and deadline situations of the MCP server surface as `INTERNAL_ERROR` with a `details.reason`; a dedicated code is proposed in `docs/MCP_TOOLS.md`.
* `node:sqlite` is still experimental in Node 22; GCR hides exactly that one `ExperimentalWarning`. The installed MCP SDK drags HTTP-server packages (for example `express`) into `node_modules`; GCR never imports them (a test checks the import allow-list).
* At milestone head `bc6af53` the suite has one failing test (`test/sdk/errors.test.ts`, a test expectation, fixed in `8cfb1b2`); see `docs/PR_NOTES.md`.
* The suite contains a timing-sensitive scale test (imports 400 conversations without pathological slowness) that, according to the lead's notes, failed once under heavy CPU load at about 06:05 UTC on 2026-10-11 (not observed by the author of this entry); it passed in every run listed above although the machine was loaded (load average about 8 to 10). Whether it is still load-sensitive is **NOT VERIFIED**.
* The sibling documents `docs/ACCEPTANCE.md`, `docs/PARITY_MATRIX.md`, `docs/SECURITY_AND_BOUNDARIES.md`, `docs/PERFORMANCE.md` and `docs/COVERAGE.md` are referenced by the specification; see the documentation index in the README for which of them exist.

### Lessons

* **The baseline was missing (ADR-0001).** The task said to use the "existing TypeScript v0.1.1" as baseline and the runbook said to import its folder. The remote repository was empty and only four documents were supplied. GCR was therefore built from the specification, Phase 0 "reproduce the baseline" is recorded as **not possible**, no `chatgpt_*` tool names could be preserved (ADR-0002), and no parity or lineage with v0.1.1 is claimed.
* **The Node minimum was wrong in the runbook (ADR-0012).** The supplied runbook says Node 22.13 with "built-in Node SQLite". Real binaries showed that `node:sqlite` has no FTS5 before 22.16.0 (SQLite 3.47.2 in 22.13/22.14, 3.49.1 in 22.15, FTS5 present from 22.16.0): on 22.13 the first schema migration failed and hundreds of tests failed with "no such module: fts5". GCR now requires `>=22.16.0`, probes FTS5 before touching a file and fails with a clear `DB_ERROR` (`FTS5_UNAVAILABLE`).
* **Do not trust a green number without its date and runtime.** Suite totals changed from 5,771 (ADR-0012, earlier) to 5,807 (milestone head bc6af53) to 6,568 as tests were added; the figures above are tied to a command, a Node version and a date.
* **Never message a running workflow agent** that edits the same files: it resumed as a second concurrent writer once and overwrote work (process lesson, recorded in the lead notes).
* **Synthetic evidence has a ceiling.** The fixtures encode what community reports say; they cannot reveal what a current export really contains. The first real export is expected to teach something.
