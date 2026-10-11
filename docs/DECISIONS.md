# Decision records (ADRs)

Changes to the boundaries in `SPEC.md` §9, `AGENTS.md` and `docs/SECURITY_AND_BOUNDARIES.md` require a reviewed ADR here.
Status values: `accepted` · `proposed` · `superseded`. Dates are UTC.

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
* Status: accepted · CCR (both `thisis-romar/claude-conversation-reader` and `EMBLEM-NLP/claude-conversation-reader-public`) has **no LICENSE file**; `package.json` declares `"license": "ISC"`
  without a license text or copyright notice. Reuse rights are therefore not established by inference. GCR copies **no CCR code**; it only inventories CCR's *features* and
  documented *data shapes* (e.g. the Claude export JSON field names) for the parity matrix and `ClaudeExportAdapter`. GCR itself ships with `"private": true` and **no LICENSE file**:
  the repository owner must choose one. No third-party code is vendored; npm dependencies keep their own licenses (`npm run licenses` summarises them).

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
* Date: 2026-10-11 · Status: accepted · Supersedes the "Node ≥ 22.13" statement in `docs/REPO_RUNBOOK.md` / `SPEC` baseline metadata (those user-supplied files are kept verbatim).
* Context: the runbook and the baseline package declare `engines.node >= 22.13` with "built-in Node SQLite". GCR's search (FR-05) requires SQLite FTS5. The compiled suite was run on real Node binaries obtained from the npm registry:
  22.13.1 / 22.14.0 (SQLite 3.47.2) and 22.15.0 / 22.15.1 (3.49.1): `CREATE VIRTUAL TABLE … USING fts5` fails with **"no such module: fts5"** (720 of 5,707 tests failed on 22.13.0, all from the failed schema migration);
  22.16.0 (SQLite 3.49.1), 22.17.x, 22.18.0, 22.19.0, 22.20.0, 22.21.x (3.50.x): FTS5 present. Full suite on **22.16.0: 5,771 tests, 5,770 pass, 0 fail, 1 skipped**; on 22.22.0 also green.
* Decision: `engines.node` is `>=22.16.0`; `openDatabase` probes FTS5 on a private in-memory connection before touching any file and fails with `DB_ERROR` (`details.reason = "FTS5_UNAVAILABLE"`, remedy names 22.16.0) instead of a misleading `DB_MIGRATION_FAILED`; `gcr doctor` reports it; CI tests the declared minimum (22.16.0) and the current 22.x line.
* Not verified: Node 24+ (not available in this sandbox); the baseline v0.1.1 package may have used a different FTS strategy (unavailable, ADR-0001). The operator should confirm the minimum matches their deployment targets.
