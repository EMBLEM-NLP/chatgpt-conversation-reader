# Decision records (ADRs)

Changes to the boundaries in `SPEC.md` §9, `AGENTS.md` and `docs/SECURITY_AND_BOUNDARIES.md` require a reviewed ADR here.
Status values: `accepted` · `proposed` · `superseded`. Dates are UTC.

ADR-0001 to ADR-0012 are the original records (kept as written; changes made later on 2026-10-11 are the dated note marked "Update" at the end of ADR-0012 and fact-check edits inside ADR-0008 (scope of the licence search, the weak no-copy check) and ADR-0012 (the source of the Node 22.13 statement, a note on historical figures, the CI wording)). Statements in ADR-0001 about the state of the remote repository and of the supplied ZIP at the start of the work are historical and cannot be re-checked offline (NOT VERIFIED here). One path named in the original
text does not exist in the repository at the time of writing (2026-10-11, checked with a file-existence test): `docs/ACCEPTANCE.md`. ADR-0001 lists it among the files that were not available
and `SPEC.md` still references it; it has not been written. Every other file path that ADR-0001 lists as unavailable now exists; the extension/live bridge it also lists was not built (`docs/BROWSER_GATE.md`).

ADR-0013 to ADR-0021 were **recorded on 2026-10-11 after the
corresponding code existed**: each states what the code does, why, and which code path and test show it, and says where something is not verified. No decision here was
confirmed by an operator or by legal review, and every statement about the ChatGPT or Claude export format is synthetic-only (GCR has never been run against a real export).

| ADR | Title | Status |
| --- | --- | --- |
| 0001 | Clean-room implementation; the v0.1.1 baseline was not available | accepted (needs operator confirmation) |
| 0002 | MCP legacy `chatgpt_*` alias table is empty | accepted |
| 0003 | SQLite via built-in `node:sqlite`; hand-written ZIP and JSON stream parsers | accepted |
| 0004 | Compiled output is not committed; tests always build from TypeScript | accepted |
| 0005 | Immutable import snapshots with a per-conversation head batch | accepted |
| 0006 | No pull request is opened by the implementing agent | accepted |
| 0007 | CCR repository rules are not applied to GCR | accepted |
| 0008 | Licensing and code reuse | accepted |
| 0009 | Active branch is never guessed | accepted |
| 0010 | Browser interaction (FR-17 / Phase 4) ships no code | accepted |
| 0011 | Accepted ChatGPT URL forms | accepted |
| 0012 | Minimum Node.js is 22.16.0, not 22.13 | accepted |
| 0013 | Depth and size limits for untrusted JSON; per-file versus per-element failure | accepted |
| 0014 | ChatGPT hidden-message and text-placeholder rules | accepted |
| 0015 | Claude export completeness is `rendered_active_view_only`; when `currentNodeId` is set | accepted |
| 0016 | MCP server: read-only by default, explicit write flag, approved import roots | accepted |
| 0017 | ZIP reader: local-header leniency (bit 3, central-directory sizes) and Unicode name handling | accepted |
| 0018 | SDK reads are refused while a write is in progress (`write_in_progress`) | accepted |
| 0019 | The graph is derived data, rebuilt wholesale; default minimum of two conversations per entity | accepted |
| 0020 | A draft has no "sent" state; the only continuation is a manual link | accepted |
| 0021 | No encryption at rest in v1 (NFR-06) | accepted |

## ADR-0001 — Clean-room implementation; the v0.1.1 baseline was not available
* Date: 2026-10-10 · Status: accepted (needs operator confirmation)
* Context: `CODEX_TASK.md` says "use existing TypeScript v0.1.1 as baseline" and the runbook says the ZIP's `chatgpt-conversation-reader/` folder is imported at the
  repo root. At the start of this work the remote repository `EMBLEM-NLP/chatgpt-conversation-reader` was **empty** (no commits, no branches) and only four
  documents of the ZIP were supplied (`SPEC`, `RUNBOOK`, `CODEX_TASK`, `AGENTS`). `SPEC.md`-referenced files (`CODEX_START_HERE.md`, `docs/ACCEPTANCE.md`,
  `docs/SECURITY_AND_BOUNDARIES.md`, `docs/PARITY_MATRIX.md`, `.agents/skills/...`, `scripts/ci-smoke.mjs`, `dist/`, the extension/live bridge) were not available.
* Decision: implement GCR from the specification as a clean-room TypeScript codebase on a feature branch, re-authoring the missing documents from the spec.
  Nothing from v0.1.1 is claimed to be preserved, tested or reproduced. Package version is `0.2.0-dev.0` (not `0.1.1`) to avoid implying baseline lineage.
* Consequences: Phase 0 "reproduce baseline" is recorded as **not possible**. If the operator later imports the real v0.1.1 tree, it must be reconciled with
  this branch by a reviewed PR (expect conflicts; this branch has no shared history with it). Compatibility aliases for v0.1.1 names are impossible to define (ADR-0002).

## ADR-0002 — MCP legacy `chatgpt_*` alias table is empty
* Status: accepted · SPEC §7 asks to keep existing `chatgpt_*` tool names as aliases "where safe". Those names are unknown (ADR-0001), so inventing them would
  fabricate compatibility. `src/mcp/aliases.ts` provides and tests the mechanism; the table is empty until the real v0.1.1 names are supplied.

## ADR-0003 — SQLite via built-in `node:sqlite`; hand-written ZIP and JSON stream parsers
* Status: accepted (minimum Node corrected by ADR-0012) · Matches runbook ("uses built-in Node SQLite"); verified here: FTS5 (`unicode61`, `trigram`, `porter`) and JSON1 available (SQLite 3.50.4 in Node 22.22).
  `node:sqlite` is still flagged experimental by Node and emits an `ExperimentalWarning`; the CLI/MCP entry points suppress only that single warning on stderr.
  No native addons, no `better-sqlite3`. ZIP and streaming-JSON are first-party code so every safety limit is explicit and testable (no third-party archive library).
* Runtime dependencies are limited to `@modelcontextprotocol/sdk` and `zod`.

## ADR-0004 — Compiled output is not committed; tests always build from TypeScript
* Status: accepted · The runbook defers the "compiled-file policy" to a dedicated PR and warns that `npm test` on a checked-in `dist/` can mask source defects.
  Decision: `dist/` and `dist-test/` are git-ignored; `npm test` compiles the TypeScript first. Revisit if a published npm package needs prebuilt output (build in CI release job instead).

## ADR-0005 — Immutable import snapshots with a per-conversation head batch
* Status: accepted · SPEC §5 makes `source_batch` part of message identity. Each distinct export is a `source_batches` row; imported rows are immutable; the *head* batch per conversation
  (latest `updated_at`, tie → latest import) is what reads/search use by default; older snapshots stay for provenance and can be pinned. Identical re-import is a no-op (FR-10).
  Trade-off: re-importing a newer export duplicates storage for unchanged conversations. A future `db prune` command may drop non-head batches (deliberately out of v1).

## ADR-0006 — No pull request is opened by the implementing agent
* Status: accepted · `CODEX_TASK.md` lists "GitHub issues/PR(s)" as a deliverable and the runbook suggests one milestone per PR. The execution environment for this work
  forbids opening a PR unless the human explicitly asks. Work is committed milestone-by-milestone on `claude/chatgpt-conversation-reader-rraexo`; the operator can open PRs
  (one per milestone commit range) when ready. `docs/PR_NOTES.md` provides ready-to-paste PR descriptions with evidence and rollback notes.

## ADR-0007 — CCR repository rules are not applied to GCR
* Status: accepted · The sibling CCR repo mandates per-file version headers (`.claude/rules/markdown-frontmatter.md`). Those rules are scoped to CCR ("this repository").
  GCR follows its own `AGENTS.md`. If the operator wants the same convention here it should be adopted by a separate ADR + lint check.

## ADR-0008 — Licensing and code reuse
* Status: accepted · CCR has **no LICENSE file** in either local checkout that was available (`https://github.com/thisis-romar/claude-conversation-reader` and `https://github.com/EMBLEM-NLP/claude-conversation-reader-public`, per their `.git/config`; a search to three directory levels for `LICENSE*`, `NOTICE*` and `COPYING*` outside `node_modules` and `.git` found none on 2026-10-11); both `package.json` files declare `"license": "ISC"`
  without a license text or copyright notice. The live GitHub repositories were not queried (this review had no network access, and the research notes record HTTP 403 for the public repository), so whether they have since gained a LICENSE is NOT VERIFIED. Reuse rights are therefore not established by inference. GCR copies **no CCR code**; it only inventories CCR's *features* and
  documented *data shapes* (e.g. the Claude export JSON field names) for the parity matrix and `ClaudeExportAdapter`. GCR itself ships with `"private": true` and **no LICENSE file**:
  the repository owner must choose one. No third-party code is vendored; npm dependencies keep their own licenses (`npm run licenses` summarises them). Weak check of the no-copy statement, run on 2026-10-11: comparing every trimmed line of 60 or more characters (not a comment, not an `import` line) of GCR `src/**/*.ts` with the `src/**/*.ts` of each CCR checkout found 0 identical lines. That would not detect a renamed or reformatted copy, so it supports the statement but does not prove it.

## ADR-0009 — Active branch is never guessed
* Status: accepted · SPEC §5: `currentNodeId: null` ⇒ "no supported active-branch inference". When a conversation has no valid `current_node`, `get`/`thread` without `--branch`
  return `ACTIVE_BRANCH_UNKNOWN` with the branch list and the remedy; an explicit, labelled `--branch-policy last_child|latest_leaf` heuristic is available and always adds an `ACTIVE_BRANCH_HEURISTIC` warning.

## ADR-0010 — Browser interaction (FR-17 / Phase 4) ships no code
* Status: accepted · Mode E is "experimental and policy-gated". The v0.1.1 extension/live bridge was not available (ADR-0001), so there is nothing to disable. This repository ships **no** browser,
  extension, cookie, or ChatGPT-endpoint code. `docs/BROWSER_GATE.md` records the gate and the human checklist. A test asserts no network modules are imported anywhere in `src/`.

## ADR-0011 — Accepted ChatGPT URL forms
* Status: accepted · `parseChatGptUrl` accepts `https://chatgpt.com/c/<uuid>` only (SPEC FR-01: "rejects `share/`, other domains, malformed UUID"). Legacy `chat.openai.com`, `www.chatgpt.com`,
  project-scoped `/g/<gizmo>/c/<uuid>` and `http:` are rejected with `UNSUPPORTED_URL` to stay inside the spec's exact-link contract. A bare UUID is accepted by CLI/SDK as a local lookup key.

## ADR-0012 — Minimum Node.js is 22.16.0, not 22.13 (deviation from the runbook, evidence-based)
* Date: 2026-10-11 · Status: accepted · Supersedes the "Node ≥ 22.13" statement in `docs/REPO_RUNBOOK.md` line 47 (that user-supplied file is kept verbatim; `SPEC.md` names no Node version, checked 2026-10-11).
* Context: the runbook says the baseline package declares `engines.node >= 22.13` with "built-in Node SQLite" (the baseline package itself was never available, ADR-0001, so this is the runbook's statement, not an observation of it). GCR's search (FR-05) requires SQLite FTS5. The compiled suite was run on real Node binaries obtained from the npm registry:
  22.13.1 / 22.14.0 (SQLite 3.47.2) and 22.15.0 / 22.15.1 (3.49.1): `CREATE VIRTUAL TABLE … USING fts5` fails with **"no such module: fts5"** (720 of 5,707 tests failed on 22.13.0, all from the failed schema migration);
  22.16.0 (SQLite 3.49.1), 22.17.x, 22.18.0, 22.19.0, 22.20.0, 22.21.x (3.50.x): FTS5 present. Full suite on **22.16.0: 5,771 tests, 5,770 pass, 0 fail, 1 skipped**; on 22.22.0 also green. [Historical figures of the original record: not re-measured in this form, and the sandbox holds 22.13.1, not the 22.13.0 named for the 720-failure figure. The per-version FTS5 facts were re-checked on 2026-10-11, see the Update note.]
* Decision: `engines.node` is `>=22.16.0`; `openDatabase` probes FTS5 on a private in-memory connection before touching any file and fails with `DB_ERROR` (`details.reason = "FTS5_UNAVAILABLE"`, remedy names 22.16.0) instead of a misleading `DB_MIGRATION_FAILED`; `gcr doctor` reports it; the CI workflow `.github/workflows/gcr-ci.yml` is written to test the declared minimum (22.16.0) and the current 22.x line (the workflow has never run on GitHub).
* Not verified: Node 24+ (not available in this sandbox); the baseline v0.1.1 package may have used a different FTS strategy (unavailable, ADR-0001). The operator should confirm the minimum matches their deployment targets.
* Update (2026-10-11, after the original text above). Per-version FTS5 check, re-run on 2026-10-11 with real Node binaries (`CREATE VIRTUAL TABLE ... USING fts5` on `:memory:`; SQLite version in brackets): 22.13.1 [3.47.2] no, 22.14.0 [3.47.2] no, 22.15.0 [3.49.1] no, 22.15.1 [3.49.1] no, 22.16.0 [3.49.1] yes, 22.17.0 and 22.17.1 [3.50.0] yes, 22.18.0 [3.50.2] yes, 22.19.0, 22.20.0, 22.21.0, 22.21.1 and 22.22.0 [3.50.4] yes. `gcr doctor` on 22.13.1 and 22.15.1 reports `ok: false` with the FTS5 finding, and `gcr list --db <file>` on 22.13.1 fails with `DB_ERROR` / `FTS5_UNAVAILABLE` and exit code 5. Test runs of the compiled suite on 2026-10-11: the 14:20Z compile has 6,804 tests in 911 suites and ran with 6,802 passing, 0 failing and 2 skipped on both 22.22.0 (583.0 s) and the declared minimum 22.16.0 (601.5 s); an earlier compile with 6,750 tests ran with 6,748 passing, 0 failing and 2 skipped on both (the two skips are file-permission tests that skip themselves when the process runs as root). One intermediate run on 22.22.0 had 1 failure in a `scripts/ci-smoke.mjs` sabotage test while another agent was editing that script. Other agents kept changing tests and `scripts/` during this work, so no run covers the final tree and the repository's current count may be higher. See `docs/ARCHITECTURE.md` section 11 for the table with times and durations. Node 24 and later remain untested.

## ADR-0013 — Depth and size limits for untrusted JSON; per-file versus per-element failure
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: an export file is hostile until proven otherwise. `JSON.parse` accepts nesting of a million levels, but `JSON.stringify` and `structuredClone` throw `RangeError` from a few thousand levels (measured on 2026-10-11 with Node 22.22.0 on this sandbox: `JSON.stringify` of a nested object failed at depth 5,000 and succeeded at 4,000; `structuredClone` already failed at 2,000; the exact thresholds depend on the stack size), so one hostile message could crash the storage layer while it serializes `rawSource`. The streaming splitter reports a framing error by byte offset and cannot resume after one. One conversation can also be legitimately large. Different layers therefore need different bounds, and each must say what it costs: one element, the tail of one file, or the whole import.
* Decision:

| Layer | Bound | What exceeding it does |
| --- | --- | --- |
| Splitter nesting (`MAX_JSON_DEPTH` in `ingest/json-stream.ts`) | 10,000 levels inside one element | Framing error `DEPTH_EXCEEDED`: **file-level**. The elements before the break are kept, the rest of the file is not imported, `FILE_PARSE_FAILED` is recorded. Under `--strict`, or when nothing at all was readable, the import fails with `IMPORT_PARSE_ERROR` (`IMPORT_UNSUPPORTED_FORMAT` for a top-level JSON scalar). |
| Element size (`maxElementBytes`) | 256 MiB | `IMPORT_LIMIT_EXCEEDED` (`ELEMENT_TOO_LARGE`): **import-level**. The splitter stops at the first byte that does not fit; nothing is stored. |
| ChatGPT adapter nesting (`MAX_RAW_NESTING_DEPTH`) | 256 levels | Not a failure: the too-deep part of `rawSource`, `rawMetadata` or block metadata is replaced by a marker and `NESTING_TOO_DEEP` is recorded. The element is imported; the SHA-256 of the whole element still identifies the original. |
| Claude adapter nesting (`MAX_JSON_DEPTH` in `ingest/claude-export.ts`) | 128 levels | **Element-level**: the adapter throws `IMPORT_LIMIT_EXCEEDED`, the runner skips the element with `ELEMENT_PARSE_FAILED` (abort under `--strict`). Exactly 128 is accepted, 129 is refused. |
| Adapter counts | ChatGPT 500,000 nodes (`TOO_MANY_NODES`, completeness lowered), 50,000 parts per message (`PARTS_TRUNCATED`), 64 MiB text per message (`TEXT_TRUNCATED`); Claude 500,000 messages (element skipped), 50,000 blocks and 5,000 attachments per message and 2,000,000 per conversation (`BLOCKS_TRUNCATED`, `ATTACHMENTS_TRUNCATED`) | Truncation with a warning, except Claude message count, which skips the element. |

  The rule: a failure of *framing* ends the **file**, because the remaining bytes cannot be interpreted; a failure of *content* ends only the **element**, because framing proved where it ends; a single element too large to buffer ends the **import**, because it can be neither buffered nor safely stepped over.
* Consequences:
  * The same hostile shape is cut and imported in ChatGPT data but skipped in Claude data. Both keep stored JSON serializable; why one cuts and the other skips is not recorded in the code.
  * A truncated file is not an error unless nothing at all was readable; it is visible only as `FILE_PARSE_FAILED` and in the report counts, so the operator must read the warnings.
  * One conversation larger than `maxElementBytes` blocks the whole import until the limit is raised (`--max-element-bytes` or `ImportOptions.limits`).
  * The ChatGPT adapter limits are constructor options of the adapter and are not reachable from `ImportOptions` or the CLI.
  * The header comment of `ingest/import-runner.ts` says an oversize element "aborts its file"; the code and its test abort the whole import (the comment is stale).
* Evidence: `src/ingest/json-stream.ts` (`MAX_JSON_DEPTH`, `DEPTH_EXCEEDED`, `elementTooLarge`), `src/ingest/import-runner.ts` (`isFramingError`, `FILE_PARSE_FAILED`, strict handling, `ELEMENT_PARSE_FAILED`), `src/ingest/chatgpt-export.ts` (`MAX_RAW_NESTING_DEPTH`, `enforceNestingLimit`), `src/ingest/claude-export.ts` (`limitExceeded`). Tests: `test/ingest/json-stream.test.ts` (depth 10,000 accepted, 10,001 refused with the offset; `ELEMENT_TOO_LARGE`), `test/ingest/import-runner.test.ts` ("a truncated file keeps the elements before the break (FILE_PARSE_FAILED); strict aborts; nothing readable fails loudly", "an element larger than maxElementBytes fails with IMPORT_LIMIT_EXCEEDED and stores nothing"), `test/ingest/chatgpt-export.content.test.ts` and `test/ingest/chatgpt-export.scale.test.ts` (`NESTING_TOO_DEEP` at and over the limit), `test/ingest/claude-export.hostile.test.ts` (the test title is a template, `accepts nesting of exactly ${MAX_JSON_DEPTH} and rejects ${MAX_JSON_DEPTH + 1} with IMPORT_LIMIT_EXCEEDED`, which reads 128 and 129).

## ADR-0014 — ChatGPT hidden-message and text-placeholder rules
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: a ChatGPT `mapping` holds more than the visible dialogue: system prompts, custom-instruction and memory context, reasoning, and pointers to media. SPEC section 5 says hidden reasoning is never fabricated and, if present, is kept labelled and excluded from default rendering; FR-03 asks for the raw source and a normalized form; unknown stays unknown (`AGENTS.md`). Whether a message is hidden has to be a stored fact (not a read-time guess) and nothing may be deleted. The rules below come from community descriptions of the archive format and were exercised only with synthetic data; they are **not verified against a real export**.
* Decision:
  1. A message is stored with `hidden = 1` if and only if (a) `message.metadata.is_visually_hidden_from_conversation` is the boolean `true`, or (b) `author.role` is exactly `system` (case-sensitive: `System` and `system ` are not), or (c) its `content_type` is one of `user_editable_context`, `model_editable_context`, `thoughts`, `reasoning_recap`. Everything else is visible, including `tool`, `code`, `execution_output` and browsing output.
  2. Hidden is an attribute, not a deletion. All content and blocks are stored; the exported reasoning or context strings are part of the message `text`. Default search, `get`/`thread`, `stats`, the graph and all renderers leave hidden messages out and count them (`omittedHidden`, `HIDDEN_MESSAGES_EXCLUDED`, `HIDDEN_HITS_OMITTED`); `includeHidden` (`--include-hidden`) opts in.
  3. Reasoning text comes only from exported strings: a `thoughts` item contributes its `summary`, its `content` or its joined string `chunks`; anything else stays a raw block. Nothing is synthesized.
  4. Reference parts leave a generic placeholder in `text` and a typed block with the raw part in its metadata: `image_asset_pointer` gives `[image]`; `audio_asset_pointer` and `real_time_user_audio_video_asset_pointer` give `[audio]`; `video_container_asset_pointer` and any other `*_asset_pointer` give `[file]`; citations (`search_result_group`, `search_result`) leave no text. The pointer is stored only as attachment metadata and is never dereferenced. Spoken-word transcription parts are real text.
  5. The Claude adapter never sets message-level `hidden`; its `thinking` blocks carry `metadata.hidden === true` and never enter `message.text`.
* Consequences:
  * Placeholders are indexed text: a search for `image`, `audio` or `file` finds media-only messages, and they count toward `characters` in `stats`.
  * Rules (a) to (c) can misclassify real data in either direction; the hidden count is reported in `FormatProfile.hiddenMessages` so a surprising number is visible. A new scaffolding content type in a future export would be visible, not hidden, until the list is extended.
  * Hidden messages are excluded from branch `visibleMessageCount`, from the graph, and from default statistics.
* Evidence: `src/ingest/chatgpt-export.ts` (`HIDDEN_CONTENT_TYPES`, the `hidden` computation in `buildMessageRecord`, `handlePart`, `addRefBlock`, `handleThoughts`), `src/db/search.ts` (`m.hidden = 0` unless `includeHidden`), `src/ingest/claude-export.ts` (`hidden: false`, thinking blocks). Tests: `test/ingest/chatgpt-export.content.test.ts` (the `hidden` suite: "is true for role \"system\", the visually-hidden flag, and the four scaffolding content types", exact-match negatives, "hidden messages keep all their content"; "hidden reasoning is never fabricated"; placeholder assertions), `test/ingest/chatgpt-export.fixtures.test.ts` (the `[image]`/`[audio]`/`[file]` text of the multimodal fixture), `test/ingest/chatgpt-export.test.ts` (hidden counted in the format observations).

## ADR-0015 — Claude export completeness is `rendered_active_view_only`; when `currentNodeId` is set
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: the Claude export that the adapter reads (field names taken from the documented data-shape inventory of CCR; no CCR code was used, ADR-0008) holds one linear thread per conversation: the branch rendered at export time. Alternate branches, edits and regenerations are not in it. SPEC section 5 offers `rendered_active_view_only` for exactly this and says `currentNodeId: null` means no supported active-branch inference (ADR-0009). Real Claude exports were not available: every statement about the format is synthetic-only.
* Decision:
  1. Every Claude conversation is stored with `completeness = 'rendered_active_view_only'` (also as the nominal completeness of its batch) and its first warning is `LINEAR_EXPORT_ACTIVE_BRANCH_ONLY`, even when the conversation is empty.
  2. `currentNodeId` is set only when the messages form a **single chain** that contains every message (exactly one leaf, and the walk from it to the root visits all messages, with no cycle). That is a structural fact about this export format (one thread by construction), not an inference from timestamps or file order; a chain stored leaf-first still yields its only leaf. Any other shape (several leaves from explicit `parent_message_uuid` pointers, a cycle, unreachable messages) gives `currentNodeId = null` plus `ACTIVE_BRANCH_UNKNOWN`; the tree is then reported as it is and nothing is guessed.
  3. Without pointers the tree is the chain in file order; with at least one `parent_message_uuid` key the pointers win for every message and a message without one is a root (`PARENT_POINTER_ABSENT`); a pointer that is `null`, or equals the sentinel `00000000-0000-4000-8000-000000000000` while no message has that id, means "no parent" (`CLAUDE_ROOT_SENTINEL` in `src/ingest/claude-export.ts`; the value is recorded in the research notes as a data-shape fact of CCR's handling of Claude exports; it was not observed in a real export here). Child lists are always derived (`CHILDREN_ABSENT`).
* Consequences:
  * Claude data never presents as `exported_tree`; every SDK/MCP envelope that includes it starts with `SOURCE_NOT_FULL_HISTORY`, and a mixed result is `mixed`.
  * Alternative branches, edits and regenerations are unavailable for Claude data by construction.
  * The batch row's `completeness` value is fixed as `rendered_active_view_only` before any conversation is normalized; a conversation that is weaker is flagged by `COMPLETENESS_BELOW_BATCH_LEVEL` (this decision does not change that known limitation; see `docs/ARCHITECTURE.md` section 13).
* Evidence: `src/ingest/claude-export.ts` (`LINEAR_EXPORT_ACTIVE_BRANCH_ONLY`, `resolveCurrentNodeId`, the record literal), `src/ingest/import-runner.ts` (`NOMINAL_COMPLETENESS`), `src/sdk/envelope.ts` (`notFullHistoryWarning`). Tests: `test/ingest/claude-export.test.ts` ("sets currentNodeId to the last message because the export is one thread by construction", "a chain stored leaf-first still yields its only leaf as currentNodeId"), `test/ingest/claude-export.lens.adversarial.test.ts` ("EC-37 ... otherwise null with ACTIVE_BRANCH_UNKNOWN"), `test/ingest/claude-export.adversarial.test.ts`, `test/ingest/import-runner.test.ts` ("auto-detects Claude exports and stores provider claude with the Claude provenance").

## ADR-0016 — MCP server: read-only by default, explicit write flag, approved import roots
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: an MCP client is driven by a language model, and the text the tools return includes imported conversations, which are untrusted data and may contain instructions. Tool annotations (`readOnlyHint`, `destructiveHint`) are hints for clients, not enforcement. SPEC section 7 requires that `gcr_import_export` takes an explicit local path and refuses to read outside approved roots, and that no tool can send anything to ChatGPT.
* Decision:
  1. The server opens the database **read-only** (`Gcr.open({ readOnly: true })`) unless the operator starts it with `--allow-local-writes` or `GCR_MCP_ALLOW_WRITES=1` (only the exact value `1`; any other value keeps it read-only). The switch is an operator setting, not a tool argument.
  2. The tool list is identical in both modes. While writes are disabled `gcr_create_local_draft` and `gcr_update_local_annotation` answer `WRITE_FORBIDDEN` with a remedy, and so does `gcr_import_export` once its path is approved; `gcr_import_export` evaluates the path policy first, so with no approved root or a path outside the roots it answers `IMPORT_PATH_NOT_ALLOWED` even while writes are off (reproduced on 2026-10-11 with the real SDK `Client` over an in-memory transport). The flag, not the file mode, is the switch (a writable handle with `allowWrites: false` also refuses; `allowWrites: true` over a read-only handle is `WRITE_FORBIDDEN` with its own reason).
  3. `gcr_import_export` additionally needs `GCR_APPROVED_IMPORT_ROOTS` (absolute directories, platform path delimiter). Roots are canonicalized with `realpath` once at startup; the file system root and unusable entries are ignored and counted, never echoed. A candidate must resolve (`realpath`) inside a root; `..` segments, symlinks that leave the root, devices, FIFOs and missing paths are all refused with the same message and details. The check runs twice, the second time immediately before the SDK opens the canonical path.
  4. `gcr_update_local_annotation` is annotated `destructiveHint: true` because an update replaces the old text (decision of 2026-10-11; the original contract said false). Read tools are annotated read-only and a test compares a content hash of every table before and after calling each of them.
  5. Descriptions, titles and schemas are static text that never contains imported data, and every description tells the model that returned text is untrusted.
* Consequences:
  * A client sees write tools in a read-only server and learns why they fail; it does not see tools appear and disappear.
  * The check and the later open are two file-system operations: the window is narrowed (canonical path, double check) and not closed, so approved roots must be directories only the operator can write to.
  * Import over MCP is off unless two independent settings are made.
  * The `gcr_update_local_annotation` hint makes clients that gate destructive tools ask for confirmation even for creating an annotation (one tool does both).
* Evidence: `src/mcp/entry.ts` (flag and environment parsing, read-only open), `src/mcp/tools.ts` (`assertWritesAllowed`, `gcr_import_export`, annotations), `src/mcp/approved-roots.ts`, `src/mcp/server.ts`. Tests: `test/mcp/tools.write.test.ts` ("the server is read-only by default", "the tool list is the same with writes disabled", "allowWrites:false over a WRITABLE handle still refuses", "allowWrites:true over a READ-ONLY handle is WRITE_FORBIDDEN with its own reason", "import is refused: IMPORT_PATH_NOT_ALLOWED while no root is configured"), `test/mcp/approved-roots.test.ts`, `test/mcp/approved-roots.adversarial.test.ts` (symlink, FIFO, `..`, canonicalization), `test/mcp/readonly.truthfulness.test.ts` and `test/mcp/readonly.adversarial.test.ts` (content hash unchanged by every read tool).

## ADR-0017 — ZIP reader: local-header leniency (bit 3, central-directory sizes) and Unicode name handling
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: export ZIPs come from writers that stream (general-purpose flag bit 3: the local header holds zero CRC and sizes and a data descriptor follows the data), may use ZIP64, and name entries with UTF-8 (bit 11) or with the legacy code page. A reader that trusts two sources of truth (local and central headers) invites archive-confusion attacks; a reader that rejects every inconsistency refuses valid streamed archives.
* Decision:
  1. **Sizes, offsets and CRC come only from the central directory.** The local header is read for its signature, flags, method, name and extra-field length (to find the data start). Its CRC and sizes are never consulted, whether or not bit 3 is set, and the data descriptor is never read. Consequently a streamed archive (bit 3) and an archive whose local CRC and sizes are stale or wrong are both accepted; the central values are enforced while streaming (hard cap on produced bytes, compression-ratio guard, cumulative budget) and the CRC-32 and final size are verified when the stream ends. Bytes delivered before the iterator finishes are unverified.
  2. **Structural consistency is still enforced:** the local name must equal the central name byte for byte (`LOCAL_NAME_MISMATCH`), the local method must equal the central method (`LOCAL_METHOD_MISMATCH`), encryption bits in either header are refused, entries must lie before the central directory and must not overlap (`ENTRY_OVERLAP`).
  3. **Names:** with flag bit 11 set the name must be valid UTF-8 (`NAME_ENCODING` otherwise). Without it, the name is decoded as UTF-8 when valid and otherwise as IBM code page 437 (a byte-to-character bijection, so distinct raw names never collapse). The Info-ZIP "Unicode path" extra field is **ignored**, so an entry has exactly one name. Path-shape checks run twice: on the raw bytes (as Latin-1) and on the NFKC form of the decoded name, so look-alike spellings (fullwidth dot and solidus) cannot slip through. C1 controls, line and paragraph separators, bidi controls and isolates are refused (`NAME_FORMAT_CHAR`). Duplicate detection uses the NFC, case-folded name (`NAME_DUPLICATE`), so a case-insensitive or normalizing consumer never sees two files under one name. Names are lookup keys only and appear in messages only after `sanitizeEntryName` (escaped, at most 80 characters) or not at all (entry index plus reason code).
* Consequences:
  * No check that a local CRC or size agrees with the central one exists, by design; a disagreement is invisible unless the central data is wrong, in which case the stream fails with `CRC_MISMATCH` or `SIZE_MISMATCH`. Reproduced on 2026-10-11 with a synthetic archive: lying local CRC and sizes (bit 3 clear) were ignored and the entry read correctly, while a wrong central CRC failed with `IMPORT_ZIP_UNSAFE` / `CRC_MISMATCH`. No repository test pins the "lying local header is accepted" half; the data-descriptor half is covered.
  * Legacy-encoded names are shown in their CP437 reading, which may differ from the writer's intention; this affects only display and lookup keys, never file-system paths.
  * Names that contain explicit bidi embedding, override or isolate controls (U+202A to U+202E, U+2066 to U+2069), C1 controls or line and paragraph separators are refused as a whole archive (`IMPORT_ZIP_UNSAFE`). By the character classes in the source, ordinary right-to-left letters and the U+200E / U+200F marks are not affected; that was not tested with such names.
* Evidence: `src/ingest/zip.ts` (`verifyLocalHeaders` and its comment on bit 3, `decodeName`, `validateName`, `checkPathShape`, `FORBIDDEN_NAME_CHARS`, `readZip64Extra` which interprets only the ZIP64 extra field). Tests: `test/ingest/zip.valid.test.ts` (data descriptors with and without signature, STORE and DEFLATE, with ZIP64; "names: UTF-8 flagged, NFD, unflagged UTF-8, and unflagged non-UTF-8 (decoded as CP437, deterministically)"), `test/ingest/zip.reject.test.ts` (`NAME_FORMAT_CHAR`, `NAME_ENCODING`, `NAME_DUPLICATE`, `LOCAL_NAME_MISMATCH`, `LOCAL_METHOD_MISMATCH`), `test/ingest/zip.truncation.test.ts`, `test/ingest/zip.adversarial.test.ts`, `test/helpers/zip-builder.ts` (`dataDescriptor`).

## ADR-0018 — SDK reads are refused while a write is in progress (`write_in_progress`)
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: `node:sqlite` is synchronous and a `Gcr` handle owns one connection. An import awaits file reads between its SQL statements, so for its whole duration the connection holds an open write transaction. A read issued on the same connection in that gap would see **uncommitted** rows (read-your-own-writes): a half-imported batch presented as data, with provenance that says it is complete.
* Decision: while a mutator (`importExport`, `importManualCopy`, `buildGraph`, `createDraft`, `archiveDraft`, `createAnnotation`, `updateAnnotation`) is running on a handle, every read method of that handle throws `GcrError` `DB_ERROR` with `details.reason = "write_in_progress"` and the remedy "Await the pending write, then retry the read." (all read methods go through one private `read()` wrapper in `src/sdk/gcr.ts`; the one exception is the instance method `doctor()`, which opens its own read-only connection; the SDK test below exercises `list`, `search`, `listBatches`, `stats`, `get` and `listDrafts`, not every method) Mutators are serialized by a per-handle writer lock (the second never meets `SQLITE_BUSY` or the repository's own "import already in progress" guard); a closed handle is `DB_ERROR` `closed`; a read-only handle rejects mutators with `WRITE_FORBIDDEN`.
* Consequences:
  * Embedders must await a write before reading from the same handle; the MCP server surfaces the same error to clients (its eight conversation-reading tools answer `DB_ERROR` while an import runs and recover afterwards; `gcr_doctor` reads no conversation and keeps answering, as the same test asserts).
  * It is a per-handle guard. A second connection or process reads committed data under WAL; that behaviour was not tested here (NOT VERIFIED).
  * The CLI is unaffected (one command per process).
  * The code is `DB_ERROR` (exit code 5) rather than a dedicated code: no new error code was added.
* Evidence: `src/sdk/gcr.ts` (header contract, `read()`, `exclusive()`, `writeInProgressError`). Tests: `test/sdk/import.test.ts` ("reads are refused while a mutator is running (they would see uncommitted rows) and work again right after": `list`, `search`, `listBatches`, `stats`, `get` and `listDrafts` during an import), `test/mcp/concurrency.adversarial.test.ts` ("every read tool answers a coded DB_ERROR (write_in_progress) with a remedy, none shows uncommitted rows, and all recover afterwards").

## ADR-0019 — The graph is derived data, rebuilt wholesale; default minimum of two conversations per entity
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: the knowledge graph (SPEC FR-12, NFR-08) is computed from imported messages with fixed local patterns (no model, no network). Imported data is immutable and re-imports add snapshots; the graph must trace every fact to message ids and must never alter imported tables. Entities that occur in a single conversation connect nothing and, with keywords, dominate the node count.
* Decision:
  1. `buildGraph` is a **full rebuild**: in one `BEGIN IMMEDIATE` transaction it drops the three lookup indexes, deletes every row of `graph_edge_evidence`, `graph_edges`, `graph_communities`, `graph_nodes`, `entity_mentions` and `entities` (children first), rescans, rewrites, reclusters and recreates the indexes. Either the complete new graph replaces the old one or nothing changes. There is no incremental update.
  2. Input is the messages of each conversation's **head** batch that are real (`node_kind = 'message'`) and not hidden. Optional `provider` / `accountLabel` scope the build; the tables then describe only that scope.
  3. An entity seen in fewer than `minEntityConversations` conversations is dropped, except tools. The default is **2** (CLI `--min-conversations`, 1 to 1,000,000), so a small export can build a graph with no connected entity; the overview export (`graphExportHtml` / `gcr graph export` without a term) then answers `GRAPH_EMPTY` and names `--min-conversations 1`.
  4. Clustering is label propagation only (`clusterMethod: 'label_propagation'`, at most 50 passes by default, `CLUSTER_NOT_CONVERGED` when it does not settle). Two builds over the same data produce byte-identical rows.
  5. The graph records neither its build scope nor its build time. Staleness is derived: the evidence rows name the exact snapshot each fact came from, and any conversation whose head batch has changed since yields `GRAPH_STALE` on every graph envelope.
* Consequences:
  * After every import that should be reflected, the operator must run `gcr graph build`; until then results describe the older snapshots (flagged by `GRAPH_STALE`).
  * Building scales with the whole corpus, not with the new data.
  * A scoped build replaces the whole graph, including parts built earlier for another scope.
  * URL secrets never reach the derived tables: userinfo, query string and fragment are removed before anything is stored (privacy rule in the header of `src/entities/extract.ts`).
* Evidence: `src/graph/build.ts` (`clearDerived`, `buildGraph`, `DEFAULT_MIN_ENTITY_CONVERSATIONS`, `DERIVED_INDEXES`), `src/graph/cluster.ts`, `src/sdk/gcr.ts` (`graphProvenance`, `supersededWarnings`), `src/cli/commands/graph.ts` (`--min-conversations`, default 2). Tests: `test/graph/build.test.ts` ("two builds give byte-identical derived tables", "a rebuild replaces old derived rows entirely and picks up newly imported data", "a failing rebuild rolls back completely and leaves the previous graph untouched", "minEntityConversations controls which entities survive; tools are exempt", "never changes imported data", "uses only each conversation head batch", "url secrets never reach any derived table"), `test/sdk/graph.test.ts`, `test/graph/graph.props.test.ts`.

## ADR-0020 — A draft has no "sent" state; the only continuation is a manual link
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: `AGENTS.md` keeps local writes separate from ChatGPT remote sends and forbids automatic or browser sends without an explicitly reviewed route; `docs/BROWSER_GATE.md` records that no such route exists. SPEC FR-13 asks for local drafts and annotations with an audit trail and no remote transmission. A data model that can say "sent" invites code (or an MCP client) to claim it.
* Decision:
  1. `local_drafts.status` admits exactly `draft` and `archived` (a `CHECK` constraint); no `LocalStore` method accepts a status, and no module in `src/` can transmit a draft (the source-level network scan covers `src/drafts`).
  2. Every draft carries `manualContinuation = { url, note }`. `url` is the canonical `https://chatgpt.com/c/<uuid>` link rebuilt from a validated UUID of a ChatGPT conversation, or `null` (non-UUID ids, other providers); `note` is the fixed text "GCR never sends messages; open this link yourself and paste the draft" (or a variant for the no-link case). The link is text for a human; GCR never opens, requests or resolves it.
  3. Rendered drafts say "(not sent)"; the body sits in a fence longer than any backtick run it contains. Every result of a local write carries `localOnly: true`.
  4. Drafts and annotations are anchored by `(provider, account_label, conversation_id[, message_id])`, not by batch, so they survive re-imports; every mutation appends one `local_audit_log` row (ids, byte lengths and a short hash prefix, never body text) in the same transaction; the log is append-only by trigger.
* Consequences:
  * There is no way to mark a draft as delivered; a human who pastes it elsewhere records that nowhere in GCR.
  * A draft or annotation can only be created for a conversation that exists in the database (`NOT_IN_LOCAL_EXPORT` otherwise); because imported rows are immutable, it never loses its anchor.
  * Size limits differ by surface: SDK draft body 256 KiB, annotation body 64 KiB; MCP input schema 64 KiB and 16 KiB.
* Evidence: `src/db/schema.ts` (`local_drafts.status` CHECK, audit triggers), `src/drafts/drafts.ts` (`DraftStatus`, `MANUAL_CONTINUATION_NOTE`, `manualContinuationFor`, `renderDraftMarkdown`), `src/sdk/gcr.ts` (`localOnly: true`), `src/mcp/tools.ts` (`gcr_create_local_draft`). Tests: `test/sdk/drafts.test.ts` (the manual-continuation object; "a status field (there is no way to mark a draft as sent)" is `INVALID_ARGUMENT`; the markdown says "not sent"), `test/drafts/drafts.security.test.ts` (a non-UUID id never becomes a link; forged headers stay inside the fence), `test/drafts/drafts.audit.test.ts`, `test/mcp/tools.write.test.ts`, `test/cli/cli.write.test.ts`.

## ADR-0021 — No encryption at rest in v1 (NFR-06)
* Date: 2026-10-11 (recorded after implementation) · Status: accepted
* Context: NFR-06 says local SQLite by default and "optional encryption at rest only if key management is sound". The database holds the user's complete conversation history in clear text, plus raw source JSON. GCR has no key-management design, and `node:sqlite` is used as Node ships it (loadable extensions stay disabled; GCR never enables them). Whether any Node build offers an encrypted SQLite variant was not investigated (NOT VERIFIED).
* Decision: v1 implements **no** encryption, no passphrase handling and no key storage. Instead it limits exposure and states the limit:
  1. A new database file is created with mode `0600` (exclusive create, before SQLite touches it); on 2026-10-11 the `-wal` and `-shm` sidecars of an open database were also `0600` under a umask of 022. The default directory `./.gcr` is created with `0700` and only on a first write; `gcr graph export` HTML files are created with `0600`, an existing file is not overwritten without `--force`, and a symbolic link is never written through.
  2. Nothing leaves the machine: no network code, no hosted indexing. Logs carry ids, counts and codes only.
  3. Git hygiene: `*.sqlite*`, `.gcr/`, archives and export-shaped files are ignored and blocked by the privacy scanner (`scripts/privacy-scan.mjs`, `--history` for the whole history).
  4. Documentation tells the operator to rely on operating-system disk encryption and file permissions, and to treat a copy of the `.sqlite` file (and its `-wal`/`-shm`) as containing every imported conversation.
* Consequences:
  * Anyone with read access to the database file reads all imported conversations; a backup or sync of the file spreads that.
  * Deleting a conversation or a batch is not a v1 operation (imported rows are immutable), so removing sensitive data means deleting the file and re-importing.
  * Adding encryption later needs an ADR covering key management, the SQLite build, and a migration path.
* Evidence: `src/db/open.ts` (`createPrivateFile`, `wx` with `0o600`), `src/cli/context.ts` (`mkdirSync(dir, { mode: 0o700 })`), `src/cli/export-file.ts`, `src/devtools/privacy-scan.ts`, `.gitignore`. Tests: `test/db/schema.test.ts` ("a file database uses WAL, is created with mode 0600"), `test/cli/cli.write.test.ts` ("creates ./.gcr with mode 0700 on the first write, and the database with mode 0600"), `test/mcp/stdio.e2e.test.ts` ("with writes enabled a new database file is created, private to its owner"), `test/devtools/privacy-scan.paths.test.ts` and `test/devtools/privacy-scan.repo.test.ts` (database and archive paths are findings).
