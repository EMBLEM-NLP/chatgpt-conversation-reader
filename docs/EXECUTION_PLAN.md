# Execution plan

Written before implementation per `AGENTS.md`. Status legend: `planned` · `in progress` · `done (evidence: …)` · `partial` · `blocked`. Only the *Status* column and the evidence
links are updated as work proceeds; scope changes need an ADR.

| Milestone | Scope (CODEX_TASK phase) | Gate to call it done | Status |
|---|---|---|---|
| **M0 Bootstrap + Phase 0** | Repo scaffold, user-supplied docs imported verbatim, ADRs, architecture contract, CCR inventory → `docs/PARITY_MATRIX.md`, platform-policy notes, baseline reproduction attempt (recorded as impossible, ADR-0001) | `npm run typecheck` green on the skeleton; research notes committed; parity matrix classifies every FR/NFR | done (evidence: commit `68c016d` typechecked; ADR-0001 to ADR-0027 in `DECISIONS.md`; `docs/research/` committed; `docs/PARITY_MATRIX.md` classifies every FR/NFR; the OpenAI platform-policy review is **NOT PERFORMED**, see `ACCEPTANCE.md` section 6) |
| **M1 Official-export ingestion** | Domain model, URL parsing, branch analysis, safe ZIP + streaming JSON, ChatGPT/Claude adapters, SQLite v1 schema + migrations + FTS5, idempotent import, search, render formats, SDK facade, CLI `doctor/import/list/get/search/branches/thread/stats/audit` | `docs/ACCEPTANCE.md` checks for FR-01…FR-11 executed with evidence; NFR-05 baseline measured | done with one miss (evidence: `docs/ACCEPTANCE.md` sections 2 and 5; FR-01..FR-11 executed on synthetic data, FR-02/03/04/11 classified synthetic-only; NFR-05 baseline measured in `docs/PERFORMANCE.md` and its **10,000 messages/s import budget is NOT met**, 7,524 measured) |
| **M2 Tools, graph, MCP** | Entity extraction, knowledge graph (build/query/path/export with escaping), local drafts + annotations + audit log, MCP server with real-SDK smoke tests, stable SDK surface | FR-07, FR-12, FR-13, FR-14 acceptance executed; MCP conformance test green | done (evidence: `docs/ACCEPTANCE.md` sections 2 and 5; FR-07, FR-12, FR-13 supported, FR-14 synthetic-only; MCP tested through the real SDK client over stdio, 12 tools) |
| **M3 Packaging, CI, security** | Lockfile + `npm ci` CI with read-only token and SHA-pinned actions, dependency audit, privacy scan, property/adversarial tests, coverage + CLI help capture, user guide/CLI reference/MCP schemas, devcontainer | CI definition present **and** all its steps executed locally (GitHub run itself not verifiable from this sandbox) | done as the gate is worded, with the GitHub run **NOT_RUN** (evidence: every step of `gcr-ci.yml` executed locally on Node 22.22.0 and 22.16.0, in a fresh clone and as a non-root user: `docs/ACCEPTANCE.md` section 2; two review rounds and their fixes: section 4) |
| **M4 Browser UI (gated)** | Documentation only: gate, checklist, feature flag default OFF, no implementation (ADR-0010) | `docs/BROWSER_GATE.md` present; no network/browser code (test) | done (docs only; evidence: `docs/BROWSER_GATE.md`; `npm run test:browser` prints `NOT_RUN`; a source-scanning test finds no network or browser code) |

## Evidence rules
* Every status change cites the exact command, exit code and date. "Not run" is a valid, honest outcome (`NOT_RUN`).
* Synthetic fixtures never prove compatibility with a live ChatGPT export; such rows are classified `synthetic-only` in the parity matrix.
* Each milestone ends with a commit on `claude/chatgpt-conversation-reader-rraexo` whose message lists tests run, plus a rollback note in `docs/PR_NOTES.md`.

## Rollback
Each milestone is a single commit range on the feature branch; rollback = `git revert <range>` (no data migrations run outside the user's own local SQLite files; schema v1 is created fresh).

## Notes on the final state (2026-10-12)
* Work after M3 (not a milestone of its own): a four-lens independent review in two rounds, a fix wave and a test-hardening pass; see `docs/ACCEPTANCE.md` section 4 and the "Final review and fix wave" section of `docs/PR_NOTES.md`.
* `AGENTS.md`, `SPEC.md`, `CODEX_TASK.md` and `docs/REPO_RUNBOOK.md` are the user's supplied files and were **intentionally left unchanged** (byte-identical to commit `68c016d`); the only agent-instruction file added is `.agents/skills/gcr-implementation/SKILL.md`.
