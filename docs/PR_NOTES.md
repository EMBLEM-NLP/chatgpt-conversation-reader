# PR notes: ready-to-paste pull request descriptions for milestones M0 to M4

Regenerated on 2026-10-12 (about 09:46 UTC) from the real git history of branch `claude/chatgpt-conversation-reader-rraexo` at `HEAD` = `d9bac73` (38 commits), with read-only git commands only (`git log`, `git show`, `git diff`, `git rev-list`, `git cat-file`). It replaces the versions of 2026-10-11, whose commit map stopped at 26 commits and whose evidence tables quoted run results that went stale. The history keeps growing while documents are written: re-run the commands in section 1 before you cut anything.
Milestones are those of [EXECUTION_PLAN.md](EXECUTION_PLAN.md); its Status column still reads `planned` for all five rows at the time of writing, so the gate status of each milestone is in its PR body below. Companion rules: [../AGENTS.md](../AGENTS.md), [DECISIONS.md](DECISIONS.md).

**This file quotes no test count, duration, load average, smoke-check count or "N of M runs" for the current tree.** All of those belong in [ACCEPTANCE.md](ACCEPTANCE.md) (the acceptance record: command, exit code, counts, Node version, date); **that file did not exist when this file was regenerated** (section 0), so every link to it below is dangling until it is written. The only counts kept here are dated facts about early milestone heads that were extracted with `git archive` on 2026-10-11 (section 0, M1 and M2).

## 0. Read this first

* **No pull request has been opened by the implementing agent** (ADR-0006). Whether anyone opened one on GitHub was not checked (no network). `gh pr create` is the operator's to run; the commands are in section 2. The local remote-tracking ref `origin/claude/chatgpt-conversation-reader-rraexo` pointed at the same commit as the local branch (`d9bac73`) when checked with `git for-each-ref` on 2026-10-12 at about 09:30 UTC, so, as far as this clone knows, the branch exists on `origin` at that commit (the ref is moved by a push or a fetch); what GitHub holds now was **not verified**. No `git push` was run by the author of this file.
* **The history was not squashed and is mostly work-in-progress checkpoints.** The branch has 38 commits between 2026-10-10 22:13 UTC and 2026-10-12 09:26 UTC (`git rev-list --count HEAD`; it grows while people work). 21 of them are checkpoints (subject starts with `wip` or contains `checkpoint`: `git log --format=%s | grep -cE '^wip|checkpoint'`) and 17 are focused changes (`chore`, `fix`, `ci`, `docs`). Checkpoints were taken when a session limit or a review boundary was reached, so a commit label (`m1`, `m2`) names the phase in progress, **not** the scope of the files in it: the graph, entity and draft modules (M2 scope) first land inside the commit labelled `wip(m1): checkpoint 5`, the eleven SDK test files (M2 scope) inside a `fix(db)` commit, and the subject of `9028d6a` promises stats, audit, graph, drafts and runner that it does not contain. Section 1 assigns every commit by what it contains.
* **The milestone heads are not all green.** Each head below was extracted with `git archive` into a scratch folder on 2026-10-11 and typechecked, built and tested there (Node 22.22.0, the same `package-lock.json`, the `node_modules` of the working tree). These are historical facts about those commits; they were not re-run for this file.
  * `68c016d` (M0): typecheck and build exit 0; **there are no tests yet**.
  * `bc6af53` (M1 cut point): **one failing test**, `test/sdk/errors.test.ts`, a wrong expectation (the test passed a nonexistent import path); fixed by a test edit in `8cfb1b2`. 5,807 tests, 5,803 pass, 1 fail, 3 skipped, on Node 22.22.0 and again on Node 22.16.0 (reproduced the same day). The three skips: two root-permission tests and the privacy self-test ("not running inside a git checkout", an artefact of `git archive`).
  * `99cd600` (the last commit before checkpoint 15): **one failing test file**: `test/mcp/limits.adversarial.test.ts` is killed with `SIGKILL` (after 36 to 53 s in the first author's runs, 28 s when re-run alone). 6,565 tests, 6,561 pass, 1 fail, 3 skipped.
  * `2d81c65` (checkpoint 15): **not measured as a commit** (its tree was never extracted for a run). Its message says "NOT a milestone completion" and that the suite was not re-run. A full run on the moving working tree from about 13:04 UTC on 2026-10-11 showed failures that were not Node-specific: the rebuilt `dist/` came from in-flight sources that already said `destructiveHint: true` for `gcr_update_local_annotation`, while `docs/mcp-tool-schemas.json` and the smoke expectations still said `false` (tests in `test/mcp/docs.consistency.test.ts` and `test/scripts/ci-smoke.pass.test.ts`). The next commit, `1341059`, reconciles them.
  * `1341059` (M2 cut point): no failing test on Node 22.22.0 and on Node 22.16.0, in the first author's run and again in an independent re-run on 2026-10-11, both compiled from a working tree whose `src/` and `test/` equal `1341059` (so **not** a `git archive` extraction); the skipped tests are the root-permission tests, which skip themselves when run as root. Its message says the full suite was not re-run for the commit itself.
  * `caf76d1` (M3 cut point) and every later commit: **no per-commit extraction was made**. Their messages say: `a0c75fd` "do not read this commit as verified"; `1ac22fd` that the first full run after the fix wave failed in three places (the smoke script still expected raw bidi characters in MCP results, a sabotage test's anchor in the compiled `db/search.js` of its private copy of the build had moved (`includeHidden` is read from the filter object), a comment fooled the import-specifier scan of `src/ingest/registry.ts`) and that they were fixed; `d9bac73` that it is in progress and not yet verified. The result for the final tree belongs in [ACCEPTANCE.md](ACCEPTANCE.md), which did not exist when this file was regenerated.
* **Documents and scripts arrived in stages.** Early drafts of `README.md`, `CHANGELOG.md`, `docs/USER_GUIDE.md`, an earlier version of this file, `docs/SECURITY_AND_BOUNDARIES.md`, `scripts/ci-smoke.mjs`, `scripts/no-network-guard.cjs`, `scripts/perf-baseline.mjs` and `scripts/coverage-summary.mjs` are in checkpoint 15 (`2d81c65`); `docs/PARITY_MATRIX.md` and `docs/PERFORMANCE.md` in `1341059`; `docs/COVERAGE.md` in `91caaf2`; `docs/WARNING_CODES.md`, ADR-0013 to ADR-0021 and `test/scripts/no-network-guard.adversarial.test.ts` in `1e27fa0`; the fact-checked set in `ef921ee`; `docs/AUDIT_REPORT.md`, `docs/research/` and the audit and checksum scripts in `171b7dd`; ADR-0022 to ADR-0027 in `c8062e4`. **[ACCEPTANCE.md](ACCEPTANCE.md), which `SPEC.md` and ADR-0001 name, did not exist when this file was regenerated** (`ls docs/ACCEPTANCE.md` on 2026-10-12); it is being written, and this file refers to it for every result of the current tree.
* **Evidence rule** (EXECUTION_PLAN): every result below names the command, the exit status, the Node version where it matters and the date; "not run" is stated where it applies. All data is synthetic. Nothing here shows that a real ChatGPT export imports correctly: none was ever available.
* **The smoke script** (`scripts/ci-smoke.mjs`, the CI step `npm run smoke`): one intermittent failure pair was seen on 2026-10-11 under heavy machine load and was not diagnosed (the failing checks were the JSON `search` read and the check that no absolute repository path appears in any output). The script was edited afterwards (`1ac22fd`). See [ACCEPTANCE.md](ACCEPTANCE.md) for the repeated runs.
* **The history privacy scan is clean.** `node scripts/privacy-scan.mjs --root . --history` had one finding, in the old test commit `c8533e4` (an invented id in a chatgpt.com URL); `0bd3fb3` widened the scanner's synthetic-id rule instead of rewriting history, and the scan has been clean since. Re-run for this file on 2026-10-12 at about 09:33 UTC against the working tree and every commit, with the `dist/` built at 06:35 UTC: exit 0. The gate record belongs in [ACCEPTANCE.md](ACCEPTANCE.md), which did not exist when this file was regenerated.
* **Uncommitted work.** `git status --short` at generation time lists modified test files and new untracked test helpers that are in no commit (and this file). They belong to no PR range: commit or stash them before cutting.
* **Migration note for every PR: none.** SQLite schema v1 is created fresh (`PRAGMA user_version = 1`) in the user's own local file; nothing is migrated and no shared data exists. `src/db/schema.ts` does not differ between `caf76d1` and `HEAD`.
* **Rollback note for every PR:** before merge, delete the branch; after merge, `git revert -m 1 <merge commit>` (merge commits) or `git revert --no-commit <base>..<head>` followed by `git commit` (fast-forwarded ranges). Local data: delete the database file and its `-wal` and `-shm` files (`rm gcr.sqlite gcr.sqlite-wal gcr.sqlite-shm`); an import is atomic, and the default location is `./.gcr/`. Exports are never modified by GCR.

## 1. Commit-to-milestone map

**Rule.** The Milestone column is the plan scope of the deliverable that the commit message names; for checkpoints, whose messages list status and not deliverables, it is the scope that holds most of the commit's added lines. Scopes by path: **M0** is the bootstrap commit; **M1** is `src/{domain,ingest,db,format,analysis}`, their tests, `fixtures/` and `docs/{ADAPTERS,IMPORT_FORMAT,IMPORT_GUIDE}.md`; **M2** is `src/{entities,graph,drafts,sdk,cli,mcp}`, `src/index.ts`, `src/suppress-warnings.ts`, their tests, `docs/{SDK,CLI_REFERENCE,MCP_TOOLS}.md`, `docs/CLI_HELP.txt` and `docs/mcp-tool-schemas.json`; **M3** is `scripts/`, `src/devtools`, `.github/`, `.devcontainer/`, `test/{devtools,scripts}`, `package.json` and every other file; **M4** is `docs/BROWSER_GATE.md`, `scripts/test-browser-gated.mjs` and `test/security/no-network.test.ts`; **FW** is the final review and fix wave (its own section below), from `c062899` on. "Also" lists every other scope with at least 10% of the commit's added lines, or any M4 file whatever its size (for `68c016d` M4 is added by hand: ADR-0010). Where the message and the added-line majority disagree, the message wins (`1917348`, `bc6af53`, `148845b`, `1341059`; their Notes say what else came with them). Size is the commit's own files and added / deleted lines (`git show --numstat`). Hashes are abbreviated; dates are UTC.

| # | Commit | Date (UTC) | Subject | Milestone | Also | Size | Notes |
|---|---|---|---|---|---|---|---|
| 1 | `68c016d` | 2026-10-10 22:13 | chore(m0): bootstrap GCR clean-room scaffold, contracts and decision records | M0 | M4 | 23 files, +3,139 -0 | Supplied documents kept verbatim (`SPEC.md`, `AGENTS.md`, `CODEX_TASK.md`, `docs/REPO_RUNBOOK.md`), `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR-0001 to ADR-0011, ADR-0010 is the M4 decision), `docs/EXECUTION_PLAN.md`, `package.json`, lockfile, tsconfig, `src/errors.ts`, `src/logger.ts`, `src/version.ts`, `src/domain/types.ts`, `src/domain/results.ts`, test helpers. Message: only `tsc --noEmit` was run. |
| 2 | `c1b4854` | 2026-10-10 22:41 | wip(m1): checkpoint of in-progress core modules (domain, ZIP/JSON stream) + Phase 4 gate doc | M1 | M4 | 22 files, +7,922 -31 | First core modules: `src/domain` (ids, validate, branches), `src/ingest` (limits, ZIP reader, JSON stream splitter, adapter contract) and `docs/BROWSER_GATE.md`, which is the whole M4 deliverable. Message: not a milestone completion; failing JSON-stream tests unresolved at commit time. |
| 3 | `636fef6` | 2026-10-10 23:06 | wip(m1): checkpoint 2 - SQLite layer, ChatGPT/Claude adapters, privacy scanner (in progress) | M1 | M3, M4 | 72 files, +25,130 -77 | `src/db` (schema, open, repo, search, CJK), ChatGPT / Claude / disabled OpenAI-API adapters and registry, synthetic fixtures, `docs/ADAPTERS.md`. Also `src/devtools` (privacy scan, licenses), `scripts/privacy-scan.mjs`, `scripts/licenses.mjs` (M3) and `test/security/no-network.test.ts` (M4). Message: failing DB search tests unresolved at commit time. |
| 4 | `9028d6a` | 2026-10-10 23:11 | wip(m1): checkpoint 3 - renderers, stats/audit/graph/drafts/runner in progress | M1 | - | 23 files, +3,051 -32 | `src/format/time.ts`, adapter and search fixes, search and adapter tests. The subject also names stats, audit, graph, drafts and runner: no source or test file for them is in this commit (their modules are first added in `c8533e4`). |
| 5 | `32b9c7b` | 2026-10-10 23:12 | wip(m1): checkpoint 4 - renderer first draft (known type error) + schema test additions | M1 | - | 3 files, +1,427 -0 | `src/format/render.ts` first draft. **Message: one known type error** (`only_branch` missing in a label map); tests not re-run. |
| 6 | `c8533e4` | 2026-10-10 23:45 | wip(m1): checkpoint 5 - db/render/adapters/security-tools builders done; reviews, graph, drafts, runner in progress | M1 | M2, M4 | 88 files, +25,919 -561 | `src/ingest/import-runner.ts`, `src/ingest/layout.ts`, `src/ingest/manual-copy.ts`; `src/analysis` (stats, audit); first versions of `src/entities`, `src/graph` (build, cluster, query, export-html) and `src/drafts`; `docs/IMPORT_FORMAT.md`, `docs/IMPORT_GUIDE.md`. Message: failing tests in modules still being built, including the no-network scan (fixed by `12de7a9`). |
| 7 | `12de7a9` | 2026-10-10 23:46 | `fix(drafts): use \u escapes instead of raw invisible characters in oneLine()` | M2 | - | 1 file, +6 -3 | `src/drafts/drafts.ts`: raw invisible characters in `oneLine()` replaced by `\u` escapes so that the no-network source scan passes. |
| 8 | `f14350b` | 2026-10-11 04:48 | wip(m1): checkpoint 6 - session-limit interruption; partial graph/drafts, breaker fixes landed | M2 | M1, M4 | 11 files, +3,713 -14 | Tests for graph, drafts and ingest written by agents that were interrupted by a session limit; small edits in `src/ingest`, `src/devtools`. Message: failing tests in unfinished graph and drafts work, and a drafts test whose invented id the privacy scan flags (that line is the one the history scan flagged later; changed in `f164efd`). |
| 9 | `f164efd` | 2026-10-11 05:25 | wip(m1): checkpoint 7 - graph + drafts built; domain and ZIP/JSON reviews done; others in review | M1 | M2, M4 | 58 files, +9,261 -365 | Review fixes in `src/graph`, `src/drafts`, `src/entities`, `src/analysis`, `src/ingest`, `src/domain`, `src/devtools` and many new adversarial tests; the invented id in `test/drafts/drafts.test.ts` becomes a `00000000-...` id. Message: reviewer tests whose source fixes were still in progress. |
| 10 | `1917348` | 2026-10-11 05:27 | chore(m3): wire npm scripts (build/test/smoke/privacy-scan/licenses/...) and gated test:browser | M3 | M1, M4 | 10 files, +151 -32 | `package.json` scripts (`privacy-scan`, `privacy-scan:history`, `licenses`, `test:browser`, `capture:cli-help`, `dump:mcp-schemas`, `perf`, `--test-concurrency=2`), `"license": "UNLICENSED"`, `files`; `scripts/test-browser-gated.mjs` (M4). The remaining added lines are small edits in `src/analysis`, `src/ingest` and tests that the message says were included as found. Some scripts point to files that do not exist yet. |
| 11 | `0033c9c` | 2026-10-11 05:37 | wip: checkpoint 8 - adapters, import runner and security tooling reviews complete | M1 | M2 | 30 files, +3,244 -104 | Review fixes in `src/db`, `src/ingest`, `src/format`, `src/entities`; first SDK files (`src/sdk/doctor.ts`, `src/sdk/envelope.ts`, `src/sdk/resolve.ts`); more tests in `test/db` and `test/format`. Message: full suite not re-run. |
| 12 | `5cccdcd` | 2026-10-11 05:45 | test: checkpoint 9 - analysis, graph and drafts reviews complete; full suite green | M2 | M1 | 20 files, +3,329 -44 | `src/sdk/gcr.ts` (the facade) and `src/index.ts` (public API); review fixes in `src/db`, `src/drafts`, `src/entities`, `src/format`; tests for drafts and SDK. Message: full suite green for that tree in a private build directory. |
| 13 | `bc6af53` | 2026-10-11 05:59 | `fix(db): require Node >= 22.16.0 (FTS5) and fail fast with a clear error on older runtimes` | M1 | M2 | 22 files, +4,355 -24 | `engines.node` `>=22.16.0`, FTS5 probe in `src/db/open.ts` (`FTS5_UNAVAILABLE`), ADR-0012, `test/db/fts5-required.test.ts`. Eleven new `test/sdk` files (SDK tests, M2 scope) came with it, and **one of them fails at this commit** (`test/sdk/errors.test.ts`, fixed by a test edit in `8cfb1b2`). M1 cut point. |
| 14 | `148845b` | 2026-10-11 05:59 | ci: add read-only, SHA-pinned GitHub Actions workflow and devcontainer (not run on GitHub) | M3 | M2 | 6 files, +705 -1 | `.github/workflows/gcr-ci.yml` and `.devcontainer/devcontainer.json` (never run on GitHub; unchanged since). Also three new `test/sdk` files and a small `src/sdk/gcr.ts` edit that the message does not mention. |
| 15 | `8cfb1b2` | 2026-10-11 06:05 | wip(m2): checkpoint 10 - SDK facade built (second-instance edits merged); CLI and MCP in progress | M2 | - | 22 files, +2,386 -6 | `docs/SDK.md`; first `src/cli` (context, options, output, parse, report-error, spec, text) and `src/mcp` (approved-roots, envelope, stdio-bootstrap, stdout-guard) files; `src/suppress-warnings.ts`; the test edit that fixes `test/sdk/errors.test.ts`. Message: a timing-sensitive SDK scale test failed once under CPU contention. |
| 16 | `f059040` | 2026-10-11 06:31 | wip(m2): checkpoint 11 - CLI and MCP server first drafts in progress; SDK review edits | M2 | - | 63 files, +15,809 -128 | CLI (`src/cli/commands/*`, `main`, `route`, `run`, `help`, `input`, `warnings`, `export-file`, `render-local`) and MCP server (`entry`, `server`, `registry`, `tools`, `aliases`) first drafts; `docs/MCP_TOOLS.md`, `docs/mcp-tool-schemas.json`, `scripts/dump-mcp-schemas.mjs`; SDK review edits. Message: unreviewed, tests not re-run. |
| 17 | `7e3deb1` | 2026-10-11 06:36 | wip(m2): checkpoint 12 - SDK facade complete (build + independent review); CLI/MCP still building | M2 | M3 | 10 files, +374 -42 | SDK review finished; `scripts/capture-cli-help.mjs`; small CLI and MCP edits (`src/mcp/sqlite-warning.ts` deleted); CLI tests. |
| 18 | `ea0029a` | 2026-10-11 07:05 | wip(m2): checkpoint 13 - CLI and MCP server built (reviews running); verified by driving the binaries | M2 | - | 38 files, +4,604 -79 | `docs/CLI_REFERENCE.md`, `docs/CLI_HELP.txt` (captured), CLI and MCP review edits, `coverage-summary` npm script, and the first version of `test/mcp/limits.adversarial.test.ts`. Message records the built CLI and MCP server being driven by hand. |
| 19 | `02b0644` | 2026-10-11 07:05 | wip(m2): checkpoint 14 - MCP reviewer's adversarial limits test update | M2 | - | 1 file, +72 -0 | Only `test/mcp/limits.adversarial.test.ts` changes (the file added in `ea0029a`; touched again in `2d81c65`). That file is the one killed at `99cd600` (section 0). |
| 20 | `3721e54` | 2026-10-11 12:17 | fix(db): refuse newer-schema files before any write (WAL switch no longer touches them) | M1 | - | 3 files, +72 -1 | `src/db/open.ts`, `src/db/schema.ts`: `PRAGMA user_version` is checked before the WAL switch, so a newer-schema file is refused untouched; `test/db/newer-schema-untouched.test.ts`. M1 content inside the M2 range. |
| 21 | `99cd600` | 2026-10-11 12:18 | fix(sdk): accurate GRAPH_EMPTY warning when a graph exists but has nothing connected to show | M2 | - | 1 file, +12 -1 | `src/sdk/gcr.ts`: the `GRAPH_EMPTY` message distinguishes "no graph" from "nothing connected". Last commit before checkpoint 15; **red** (section 0). |
| 22 | `2d81c65` | 2026-10-11 12:51 | wip: checkpoint 15 - CLI/MCP review edits, verification scripts and docs in progress | M3 | M2 | 36 files, +7,277 -75 | Early drafts of `README.md`, `CHANGELOG.md`, `docs/USER_GUIDE.md`, `docs/SECURITY_AND_BOUNDARIES.md`, `docs/PR_NOTES.md`; `scripts/ci-smoke.mjs`, `scripts/no-network-guard.cjs`, `scripts/perf-baseline.mjs`, `scripts/coverage-summary.mjs` and `test/scripts`; CLI and MCP review edits (`src/mcp/envelope.ts`, `src/mcp/registry.ts`, `src/mcp/tools.ts`, `src/cli/context.ts`, `src/cli/export-file.ts`, `src/cli/output.ts`, `src/cli/route.ts`). Message: "NOT a milestone completion", tests not re-run. |
| 23 | `1341059` | 2026-10-11 13:13 | fix(mcp): annotate gcr_update_local_annotation destructiveHint:true (it overwrites the old text) | M2 | M3 | 17 files, +714 -61 | `gcr_update_local_annotation` annotated `destructiveHint: true`, schemas regenerated, and (per message) 20 CLI and MCP reviewer defects fixed, 2 of them high-severity MCP result-size issues. Most added lines are M3 documents it also brings: `docs/PARITY_MATRIX.md`, `docs/PERFORMANCE.md`. M2 cut point. |
| 24 | `91caaf2` | 2026-10-11 13:27 | wip: checkpoint 16 - verification scripts and docs drafts in progress | M3 | - | 8 files, +257 -125 | `docs/COVERAGE.md`; drafts of PARITY_MATRIX, PERFORMANCE, README, CHANGELOG, SECURITY_AND_BOUNDARIES, PR_NOTES; one `scripts/ci-smoke.mjs` edit. Message: documents not yet fact-checked. |
| 25 | `1e27fa0` | 2026-10-11 14:04 | wip: checkpoint 17 - verification scripts and docs still in progress | M3 | - | 12 files, +1,807 -364 | `docs/WARNING_CODES.md`, ARCHITECTURE sync, ADR-0013 to ADR-0021, growth of `scripts/ci-smoke.mjs` and `scripts/no-network-guard.cjs`, `test/scripts/no-network-guard.adversarial.test.ts`. Message: tests not re-run. |
| 26 | `d8e111a` | 2026-10-11 14:36 | wip: checkpoint 18 - docs fact-check and smoke-script mutation testing in progress | M3 | - | 11 files, +494 -134 | Fact-check corrections to the documents, `scripts/ci-smoke.mjs` edits, `test/scripts/ci-smoke.adversarial.test.ts`. Message: tests not re-run, documents not final. |
| 27 | `ef921ee` | 2026-10-11 14:45 | docs: parity matrix, security & boundaries, user guide, README, changelog, PR notes, architecture sync | M3 | - | 6 files, +53 -43 | Documents corrected by independent fact-checkers (per message): ARCHITECTURE, DECISIONS, WARNING_CODES, README, CHANGELOG, PR_NOTES. No `src/` change. |
| 28 | `0bd3fb3` | 2026-10-11 14:59 | fix(privacy-scan): accept the fixed synthetic-id tail with any first group (clears history scan) | M3 | - | 2 files, +48 -1 | `src/devtools/privacy-scan.ts`: the synthetic-id shape accepts any first group with the fixed tail `-0000-4000-8000-0000000000XX`, which clears the history-scan finding in `c8533e4`; new `test/devtools/privacy-scan.synthetic-ids.test.ts`. History was not rewritten. |
| 29 | `caf76d1` | 2026-10-11 15:09 | docs: regenerate PERFORMANCE.md and COVERAGE.md on a quiet machine (Node 22.22.0, 2026-10-11) | M3 | - | 2 files, +27 -27 | `docs/PERFORMANCE.md` and `docs/COVERAGE.md` regenerated on a quiet machine (figures: those files). Last commit before the review-driven fixes. M3 cut point. |
| 30 | `c062899` | 2026-10-11 16:03 | fix(import): stop retaining conversation texts during pass 1 (NFR-05 bounded memory) | FW | M1 | 2 files, +87 -1 | `src/ingest/import-runner.ts` (`flatString()`) and `test/ingest/import-runner.heapcap.test.ts`: NFR-05 import memory, found by the spec-conformance review (ADR-0026). Dated 2026-10-11, before the 2026-10-12 commits. |
| 31 | `171b7dd` | 2026-10-12 04:03 | docs+scripts: memory-bound wording, 5x perf scaling probe, research notes, audit report, release checksums | FW | M3 | 18 files, +4,334 -22 | `scripts/perf-baseline.mjs` scaling probe, `scripts/audit-report.mjs` and `docs/AUDIT_REPORT.md`, `scripts/release-checksums.mjs`, `docs/research/` (provenance README and eight notes), memory wording in `docs/IMPORT_GUIDE.md`, npm scripts `audit:report` and `release:checksums`, tests. Message: the security and spec fixes are "still in progress". |
| 32 | `a0c75fd` | 2026-10-12 05:49 | wip: final fix wave (security + spec findings) - checkpoint, full-suite result pending | FW | M1, M2, M3 | 91 files, +9,913 -475 | The security and spec fixes themselves: database path safety (`src/db/open.ts`), `src/format/scrub.ts`, MCP, CLI and SDK changes, search scope `attachments`, privacy scanner (`src/devtools/privacy-scan.ts`), `scripts/install-git-hooks.mjs` with `scripts/git-hooks/`, wider `.gitignore`, regenerated `docs/CLI_HELP.txt` and `docs/mcp-tool-schemas.json`, many `fixwave-*` tests. Message: checkpoint, "do not read this commit as verified". |
| 33 | `1ac22fd` | 2026-10-12 05:57 | fix(tests): adapt smoke check and sabotage anchor to the fix wave; keep a source-scan-safe comment in registry.ts | FW | M1, M3 | 3 files, +7 -3 | Smoke check and a sabotage anchor adapted to the fix wave; a comment in `src/ingest/registry.ts` reworded so the import-specifier scan is not fooled. |
| 34 | `c8062e4` | 2026-10-12 05:57 | wip(docs): ADRs for the fix wave (docs-sync in progress, not yet fact-checked) | FW | M3 | 1 file, +94 -2 | ADR-0022 to ADR-0027 added to `docs/DECISIONS.md`. Message: not yet fact-checked. |
| 35 | `491cf9c` | 2026-10-12 06:36 | docs: sync reference docs with the fix wave (fact-checked) and correct one help sentence | FW | M2, M3 | 13 files, +251 -109 | Reference documents synced with the fix wave and fact-checked (per message: 11 statements corrected); the help sentence for `gcr search --scope attachments` corrected in `src/cli` and `docs/CLI_HELP.txt` regenerated. |
| 36 | `56a0af9` | 2026-10-12 06:37 | docs: README and CHANGELOG stop quoting stale run numbers; record the first-review fixes | FW | M3 | 2 files, +33 -42 | README and CHANGELOG: stale run numbers removed (they live in `docs/ACCEPTANCE.md`), stale "history scan fails" statements removed, entry for the first-review fixes added. |
| 37 | `c35137d` | 2026-10-12 09:25 | fix(ci): leak checks no longer fail for accounts named runner/node/nobody; privacy history scan fails closed on a shallow clone | FW | M3 | 9 files, +184 -9 | Round-2 test review: shape-based `machineLeaks()` check (TQ-01) and `privacy-scan --history` failing closed on a shallow clone (TQ-02), in `src/devtools/privacy-scan.ts` and `test/scripts`, `test/devtools`; also one-line edits to `docs/CLI_REFERENCE.md`, `docs/SECURITY_AND_BOUNDARIES.md` and `docs/research/README.md`. |
| 38 | `d9bac73` | 2026-10-12 09:26 | wip(tests): test hardening for round-2 findings TQ-03..TQ-09 in progress (not yet verified) | FW | M1, M2 | 7 files, +232 -0 | Test files only (`test/db`, `test/domain`, `test/entities`, `test/ingest`, `test/sdk`): hardening for round-2 findings TQ-03 to TQ-09. **Message: in progress, not yet verified.** `HEAD` when this file was generated. |

Counts and ranges per group, computed from the table above by a script (not by hand); a group's commits are not contiguous, so "first" and "last" bound a range that contains commits of other groups:

| Group | Commits | First | Last | Positions (#) | Commits of other groups inside first..last | Other commits that also carry its content | Lines added / deleted (sum of its commits) |
|---|---|---|---|---|---|---|---|
| M0 | 1 | `68c016d` | `68c016d` | 1 | 0 | 0 | +3,139 -0 |
| M1 | 9 | `c1b4854` | `3721e54` | 2, 3, 4, 5, 6, 9, 11, 13, 20 | 10 | 7 | +80,381 -1,195 |
| M2 | 10 | `12de7a9` | `1341059` | 7, 8, 12, 15, 16, 17, 18, 19, 21, 23 | 7 | 9 | +31,019 -378 |
| M3 | 9 | `1917348` | `caf76d1` | 10, 14, 22, 24, 25, 26, 27, 28, 29 | 11 | 10 | +10,819 -802 |
| FW | 9 | `c062899` | `d9bac73` | 30, 31, 32, 33, 34, 35, 36, 37, 38 | 0 | 0 | +15,135 -663 |
| M4 | 0 | - | - | - | - | 7 (`68c016d`, `c1b4854`, `636fef6`, `c8533e4`, `f14350b`, `f164efd`, `1917348`) | - |

M4 has no commit of its own: its files ride in the seven commits listed (`test/security/no-network.test.ts` was added in `636fef6` and edited in `c8533e4`, `f14350b`, `f164efd` and `1917348`; `docs/BROWSER_GATE.md` is `c1b4854`; `scripts/test-browser-gated.mjs` is `1917348`; ADR-0010 is in `68c016d`).

Recompute and check, from the repository root (no output from the first command means the table lists exactly the commits of the branch up to the anchor `d9bac73`, in order; the second prints group, commits, first, last and the number of foreign commits inside first..last):

```bash
diff <(git log --reverse --format=%h d9bac73) <(awk -F'|' '/^\| [0-9]+ \| `[0-9a-f]+` \|/ && $2+0<=38 {c=$3; gsub(/[ `]/,"",c); print c}' docs/PR_NOTES.md)
awk -F'|' '/^\| [0-9]+ \| `[0-9a-f]+` \|/ && $2+0<=38 {g=$6; gsub(/ /,"",g); c=$3; gsub(/[ `]/,"",c); n[g]++; if (!(g in f)) {f[g]=c; fi[g]=$2+0}; l[g]=c; li[g]=$2+0} END {for (g in n) printf "%s %d %s %s %d\n", g, n[g], f[g], l[g], li[g]-fi[g]+1-n[g]}' docs/PR_NOTES.md | sort
```

**Cut points** for the stacked PRs. A cut point is chosen by the state of the tree, not by the primary scope of its last commit: `bc6af53` is the first commit that declares Node 22.16.0 and `1341059` the first measured commit after `bc6af53` without a failing test (section 0); it also corrects the `destructiveHint` of `gcr_update_local_annotation`, which the committed code and schema before it both stated wrongly as `false`. The composition column counts the commits of the range by their Milestone column; the diff columns are `git diff --shortstat <base> <head>` (net, what a reviewer sees; `pr/m0` uses the empty tree as base) and `git diff --name-only` by top-level directory.

| PR branch | Base..head | Commits (#) | Count | Composition by milestone column | Files changed | Lines added / deleted (`git diff --shortstat`) | In `src/` | In `test/` | In `fixtures/` | In `docs/` | Other |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `pr/m0` | `68c016d` | 1 to 1 | 1 | M0 1 | 23 | +3,139 -0 | 5 | 3 | 0 | 4 | 11 |
| `pr/m1` | `68c016d..bc6af53` | 2 to 13 | 12 | M1 8, M2 3, M3 1 | 213 | +86,263 -42 | 38 | 142 | 22 | 6 | 5 |
| `pr/m2` | `bc6af53..1341059` | 14 to 23 | 10 | M1 1, M2 7, M3 2 | 115 | +31,716 -85 | 37 | 57 | 0 | 10 | 11 |
| `pr/m3` | `1341059..caf76d1` | 24 to 29 | 6 | M3 6 | 17 | +2,525 -533 | 1 | 3 | 0 | 9 | 4 |
| `pr/fw` | `caf76d1..d9bac73` | 30 to 38 | 9 | FW 9 | 124 | +15,102 -630 | 23 | 66 | 0 | 23 | 12 |

**Commits after the anchor.** The tables above were generated at `d9bac73` (38 commits) and are not extended row by row. The commits below were added afterwards; all belong to the final review and fix pass (group FW, pr/fw). The sum of FW is therefore larger than the table says, and `pr/fw` is cut at the branch head (section 2), not at `d9bac73`. Their messages state what each contains; the acceptance record for the head is [ACCEPTANCE.md](ACCEPTANCE.md). To list them: `git log --reverse --oneline d9bac73..HEAD`.

| # | Commit | Date (UTC) | Subject |
|---|---|---|---|
| 39 | `a762297` | 2026-10-12 09:56 | docs: regenerate PR_NOTES from the real history (38 commits mapped, M0..M4 + fix-wave PR bodies, fact-checked) |
| 40 | `a7c34d4` | 2026-10-12 09:56 | wip(tests): environment-robust tests, exit-code pin, helpers (TQ-06..TQ-09) - in progress, not yet verified |
| 41 | `39e92b9` | 2026-10-12 12:13 | fix(db): concurrent creation of one new database no longer fails with 'busy' or 'not a GCR database' |
| 42 | `48e1519` | 2026-10-12 12:54 | perf: measure child RSS with VmHWM (maxRSS includes the parent's size at fork); regenerate PERFORMANCE and COVERAGE |
| 43 | `9641ed3` | 2026-10-12 12:55 | docs: README/CHANGELOG corrections from the round-2 docs review (Chromium run, mutation count, npm ci status, data deletion pointer) |
| 44 | `8b50b3e` | 2026-10-12 13:37 | docs: round-2 docs review fixes (no OpenAI wording reproduced or labelled OFFICIAL, Chromium run recorded, delete-your-data, SDK consumption, DB_ERROR recovery, runnable examples) |
| 45 | `751bd0f` | 2026-10-12 13:49 | docs(release): tarball hash depends on file modes on disk; build from a fresh clone (found comparing a work tree with a fresh clone) |

To recompute one row: `git rev-list --count <head>` gives the position of the head, `git diff --shortstat <base> <head>` the diff size.

## 2. How to cut and open the PRs (operator)

`origin` is `https://github.com/EMBLEM-NLP/chatgpt-conversation-reader` (`git remote -v`). When this work began that repository was **empty** (no commits, no branches; ADR-0001, not re-checkable offline). The local clone has a remote-tracking ref for this branch only; whether `main` exists, and what GitHub holds, was **not checked** (no network). A pull request needs an existing base branch. If `main` does not exist yet, create it first, for example from an empty root commit (`git commit --allow-empty -m "chore: empty root"` on an orphan branch, then push it as `main`), or publish M0 as `main` and open the others against it. The choice is the operator's.

```bash
# 0. Orientation (read-only)
git log --oneline --reverse claude/chatgpt-conversation-reader-rraexo | cat
git status --short                          # anything listed here is NOT in a PR range; commit or stash it first

# 1. Stacked branches at the cut points (local refs only; `git branch` does not touch files)
git branch pr/m0 68c016d
git branch pr/m1 bc6af53                    # red: one failing test (section 0)
git branch pr/m2 1341059                    # the first measured commit after bc6af53 without a failing test (section 0); 99cd600 is red
git branch pr/m3 caf76d1                    # last commit before the review-driven fixes
git branch pr/fw origin/claude/chatgpt-conversation-reader-rraexo   # the branch head: the last commit of this work
git push -u origin pr/m0 pr/m1 pr/m2 pr/m3 pr/fw

# 2. Extract each description from the FINAL tree of this file (markers <!-- PR-Mx-BEGIN --> ... <!-- PR-Mx-END -->)
for m in M0 M1 M2 M3 M4 FW; do
  sed -n "/<!-- PR-$m-BEGIN -->/,/<!-- PR-$m-END -->/p" docs/PR_NOTES.md | sed '1d;$d' > "/tmp/pr-$m.md"
done

# 3. Open the PRs (stacked: each one targets the previous branch; retarget to main as the earlier ones merge)
gh pr create --base main  --head pr/m0 --title "M0: bootstrap, contracts and decision records"            --body-file /tmp/pr-M0.md
gh pr create --base pr/m0 --head pr/m1 --title "M1: official-export ingestion, SQLite/FTS5, branches"       --body-file /tmp/pr-M1.md
gh pr create --base pr/m1 --head pr/m2 --title "M2: SDK, CLI, MCP server, graph, local drafts"              --body-file /tmp/pr-M2.md
gh pr create --base pr/m2 --head pr/m3 --title "M3: CI, security tooling, documentation; M4: gated browser" --body-file /tmp/pr-M3.md
gh pr create --base pr/m3 --head pr/fw --title "Final review and fix wave (2026-10-12)"                     --body-file /tmp/pr-FW.md
# M4 has no unique commits: paste /tmp/pr-M4.md as a comment on the M3 PR (or open it separately if you re-cut a docs-only branch)
```

The `sed` extraction was re-tested on this file when it was regenerated (all six markers produce a non-empty description); `gh` itself was **not run** here. The workflow `.github/workflows/gcr-ci.yml` triggers on `pull_request` only for base branch `main` (and on `push` to `main` and manual dispatch; read from the workflow file, which has not changed since `148845b`): a stacked PR whose base is `pr/m0`, `pr/m1`, `pr/m2` or `pr/m3` **does not start CI**, and the workflow has never run on GitHub. If you would rather have one PR with CI at the end, open `pr/fw` against `main` directly and paste all six descriptions into it. The history is a sequence of checkpoints, and the commits `bc6af53` (a cut point) and `99cd600` are red (section 0).

---

<!-- PR-M0-BEGIN -->
## M0: bootstrap, contracts and decision records

### Summary

Clean-room scaffold for GCR (EMBLEM-NLP ChatGPT Conversation Reader & Writer): the user-supplied specification and rules, the architecture contract, decision records, the TypeScript project, and the first pure modules. **The v0.1.1 baseline named in the task was not available** (ADR-0001), so nothing here claims lineage or parity with it; the version is `0.2.0-dev.0`.

### What changed (commit `68c016d`, 23 files, +3,139)

* Supplied documents kept verbatim: `SPEC.md`, `AGENTS.md`, `CODEX_TASK.md`, `docs/REPO_RUNBOOK.md`; plus `CODEX_START_HERE.md` and the skill `.agents/skills/gcr-implementation/SKILL.md`. The four supplied documents are still unchanged (`git log -- AGENTS.md SPEC.md CODEX_TASK.md docs/REPO_RUNBOOK.md` shows this one commit).
* `docs/ARCHITECTURE.md` (layering, identity, SQLite schema v1 contract, domain rules), `docs/DECISIONS.md` (ADR-0001 to ADR-0011: clean-room, empty alias table, `node:sqlite`, no committed build output, snapshots and heads, no PR by the agent, CCR rules not applied, licensing, no guessed active branch, no browser code, accepted URL forms), `docs/EXECUTION_PLAN.md`.
* TypeScript project (strict, NodeNext, ES2023), `package.json` (`private`; `engines.node` is `>=22.13` at this commit and becomes `>=22.16.0` in `bc6af53`; **no `license` field yet**, `"license": "UNLICENSED"` arrives in `1917348`; runtime dependencies `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.5 only; a `smoke` script that points at `scripts/ci-smoke.mjs`, which does not exist until `2d81c65`), committed `package-lock.json`, a `.gitignore` that keeps exports, databases and secrets out of Git.
* First code: `src/errors.ts` (28 error codes, exit codes), `src/logger.ts`, `src/version.ts`, `src/domain/types.ts` and `src/domain/results.ts` (shared types), test helpers (`records`, `tmp`, `zip-builder`).

### Why

The task asked for a baseline that did not exist; the contracts (errors, results, schema DDL, ADRs) are written first so that M1 and M2 can be reviewed against them.

### Evidence

Measured on `git archive 68c016d` extracted to a scratch folder, Node 22.22.0, 2026-10-11.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 (emits `dist/domain`, `errors`, `logger`, `version`) |
| `npm test` | **no tests exist yet** (`test/` holds helpers only); not run |
| `node scripts/ci-smoke.mjs` | the script does not exist at this commit; not run |

EXECUTION_PLAN gate for M0 ("typecheck green on the skeleton; research notes committed; parity matrix classifies every FR/NFR"): the typecheck part is met. The research notes were written outside Git and `docs/PARITY_MATRIX.md` is not part of this commit, so the rest is **not met by `68c016d`**. In the current tree both exist: `docs/PARITY_MATRIX.md` (added in `1341059`; a script found a row for each of FR-01 to FR-17 and NFR-01 to NFR-08 of `SPEC.md` on 2026-10-12) and `docs/research/` (added in `171b7dd`, with a provenance README that marks unverified items).

### Risks

* ADR-0001 (no baseline) is marked "needs operator confirmation"; if the real v0.1.1 tree turns up it must be reconciled by a reviewed PR (no shared history, expect conflicts).
* The Node minimum stated in the runbook (22.13) is wrong for FTS5; corrected later by ADR-0012 (M1).
* No license: ADR-0008 leaves the choice to the owner.

### How to review

Files to look at first: `SPEC.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR-0001 to ADR-0011), `docs/EXECUTION_PLAN.md`, `src/errors.ts`, `src/domain/types.ts`, `src/domain/results.ts`, `package.json`, `tsconfig.json`, `.gitignore`. The supplied documents (`SPEC.md`, `AGENTS.md`, `CODEX_TASK.md`, `docs/REPO_RUNBOOK.md`) are the user's own; check only that they are verbatim. All of these exist at `68c016d` and in the current tree.

### Migration note

None. No database exists yet.

### Rollback note

`git revert 68c016d` (or delete the branch before merge). Nothing outside the repository was changed.

### Checklist (mirrors AGENTS.md)

- [x] `CODEX_START_HERE.md` and `SPEC.md` read before runtime code; requirement ids used
- [x] TypeScript-first; no invented identity, model or completeness metadata
- [x] Hard boundary respected: no scraping, cookies, login bypass or private endpoints; a `chatgpt.com/c/<uuid>` link is only a lookup key
- [x] Local writes separate from remote sends (no remote send exists)
- [x] Imported text is untrusted data; no secrets, raw exports, tokens, user messages or real screenshots committed
- [x] Milestone plan written in `docs/EXECUTION_PLAN.md` before implementation
- [ ] Baseline run before modification: **not possible** (no baseline, ADR-0001)
- [x] Upstream CCR repository not modified; CCR code not copied (ADR-0008)
- [ ] `docs/SECURITY_AND_BOUNDARIES.md` consulted: the file is referenced by `AGENTS.md` but **was not part of this commit**
- [x] `npm run typecheck`, `npm run build` green; `npm test`, `node scripts/ci-smoke.mjs`: not applicable yet (no tests, no script)
- [ ] Validated on Codex's own runner: **not done**
<!-- PR-M0-END -->

---

<!-- PR-M1-BEGIN -->
## M1: official-export ingestion, SQLite/FTS5 index, search, branches, renderers

### Summary

Reads an official ChatGPT export (ZIP, folder, `conversations*.json`, shards, nested ZIP one level, stdin) into a local SQLite v1 database with full-text search, immutable snapshots, branch analysis, renderers, statistics and audit. Also contains, inside the same checkpoint commits, the first versions of the entity, graph and draft modules and of the SDK facade that M2 builds on: **the M2 pull request shows only later changes to them, so their first versions are reviewed here.**
**Synthetic fixtures only; a real export was never used.** Adds the Node 22.16.0 minimum (ADR-0012).

### Why

The user's own export is the only supported data source (hard boundary in `AGENTS.md`), so ingestion, storage and search come first; the graph, the SDK, the CLI and the MCP server read from this database.

### What changed (range `68c016d..bc6af53`; composition in section 1: `pr/m1`)

* `src/domain` (branch analysis, cycle safe, branch id = leaf id, active branch only from a valid `current_node`; URL/UUID parsing), `src/ingest` (first-party ZIP reader and streaming JSON splitter with explicit limits, ChatGPT / Claude / disabled OpenAI-API adapters, import runner, manual copy, layout detection), `src/db` (schema v1, migrations, FTS5 search with NFKC and per-character CJK, repository), `src/format` (markdown, compact, json, jsonl), `src/analysis` (stats, audit).
* Also here (M2 scope): `src/entities`, `src/graph`, `src/drafts` (from `c8533e4`), `src/sdk` (from `0033c9c`; the facade `src/sdk/gcr.ts` and `src/index.ts` from `5cccdcd`) and eleven `test/sdk` files (from `bc6af53`).
* Also here (M3 scope): `src/devtools` and `scripts/` for the privacy scanner and license inventory (`636fef6`), the npm scripts of `1917348`.
* Synthetic fixtures under `fixtures/chatgpt` and `fixtures/claude`; `docs/ADAPTERS.md`, `docs/IMPORT_FORMAT.md`, `docs/IMPORT_GUIDE.md`, `docs/BROWSER_GATE.md`.
* `bc6af53`: `engines.node` becomes `>=22.16.0`; `openDatabase` probes FTS5 before touching a file and fails with `DB_ERROR` / `FTS5_UNAVAILABLE`; ADR-0012.

### Evidence

Historical, measured on `git archive bc6af53` extracted to a scratch folder on 2026-10-11 (`node --test --test-concurrency=2` over `tsc --outDir dist-test` output); not re-run. The current tree is in [ACCEPTANCE.md](ACCEPTANCE.md).

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Compiled suite, Node 22.22.0 | **5,807 tests, 5,803 pass, 1 fail, 3 skipped**. The failure: `test/sdk/errors.test.ts` "a connection that was closed behind the facade's back" (expected `DB_ERROR`, got `IMPORT_INPUT_NOT_FOUND`: the test passed a nonexistent import path). A test-only edit in `8cfb1b2` fixes it. The 3 skips: two "running as root" permission tests and the privacy self-test (an artefact of `git archive`). |
| Compiled suite, Node 22.16.0 | the same counts and the same failing test (the declared minimum shows the same result at this commit) |
| FTS5 probe | Node 22.13.1: `gcr doctor` says "TOO OLD" and "FTS5 NOT available" (checked with the real binary on 2026-10-11); the per-version table is in ADR-0012 |
| `node scripts/ci-smoke.mjs` | script not present at this commit; not run |

ADR-0012 quotes suite figures from an earlier moment; they describe an earlier tree than `bc6af53` (the eleven `test/sdk` files arrive in this very commit), so they do not describe this commit.

### Risks

* The ChatGPT export format is documented only by community reports; every expectation is **synthetic-only**. A real export may break assumptions (`children` presence, shard naming, nested archives, asset names, timestamp forms).
* `bc6af53` is red (one test); `32b9c7b` documents a type error in its own message, so intermediate commits do not all build.
* **Defects found later by the final review sit in this range and are fixed in the fix wave** (section "Final review and fix wave" below): import memory retention in `src/ingest/import-runner.ts` (NFR-05, `c062899`), database path handling in `src/db/open.ts` (ATK-01), and a privacy scanner that skipped large files (ATK-02). A reviewer of this PR alone will see them in the code.
* `node:sqlite` is experimental in Node 22; GCR hides exactly one `ExperimentalWarning`.

### How to review

Read ADR-0005 (snapshots and heads), ADR-0009 (no guessed active branch), ADR-0011 (URL forms), ADR-0012 (Node minimum) first. Files to look at first: `src/ingest/zip.ts` and `src/ingest/json-stream.ts` (hostile input and limits), `src/ingest/chatgpt-export.ts` and `src/ingest/import-runner.ts`, `src/domain/branches.ts` and `src/domain/ids.ts`, `src/db/schema.ts` (immutability triggers), `src/db/open.ts` (FTS5 probe), `src/db/search.ts`, `src/format/render.ts`, `docs/IMPORT_FORMAT.md`, `docs/ADAPTERS.md`, `test/db/fts5-required.test.ts`. All exist at `bc6af53` and in the current tree.

### Migration note

None. Schema v1 is created fresh in the user's own file (`PRAGMA user_version = 1`); `applyMigrations` refuses newer files (`DB_SCHEMA_TOO_NEW`).

### Rollback note

`git revert --no-commit 68c016d..bc6af53 && git commit` (or delete the branch before merge). Local databases created by this code: delete the `.sqlite`, `-wal`, `-shm` files; imports never modify the source export.

### Checklist (mirrors AGENTS.md)

- [x] Requirement ids (FR-01 to FR-11 and FR-16) referenced; layering per `docs/ARCHITECTURE.md`. FR-15 (attachment search) is first met by the fix wave (SPEC-04, ADR-0024)
- [x] Unknown stays unknown: no inferred model, active branch, timestamp or completeness (tests in `test/domain`, `test/ingest`, `test/analysis`)
- [x] No network, cookie, browser or private-endpoint code (`test/security/no-network.test.ts`, a tripwire, not a proof)
- [x] Local data separate from imported originals; imported rows immutable (triggers)
- [x] Imported text treated as data; logs and reports content-free
- [x] Synthetic fixtures only; each carries the marker `GCR-SYNTHETIC-FIXTURE`
- [x] Plan row for M1 in `docs/EXECUTION_PLAN.md`
- [ ] All tests green at the milestone head: **no (one failure at `bc6af53`)**
- [ ] `node scripts/ci-smoke.mjs`: **not run (script absent at this commit)**
- [ ] Validated on Codex's own runner: **not done**
<!-- PR-M1-END -->

---

<!-- PR-M2-BEGIN -->
## M2: SDK facade, CLI, local MCP server, graph, local drafts and annotations

### Summary

Adds the stable TypeScript SDK (`Gcr`), the `gcr` CLI (31 help pages in `docs/CLI_HELP.txt`), the local stdio MCP server (12 tools in `docs/mcp-tool-schemas.json`, read-only by default, approved import roots), the knowledge graph with an offline HTML export, and local drafts and annotations with an audit log. Nothing can send to ChatGPT; a draft has no "sent" state (ADR-0020). The first versions of the entity, graph, draft and SDK modules are in the M1 diff (section 1); this PR shows the CLI, the MCP server and later changes.

### Why

The CLI and the local MCP server are two front ends of one SDK, so that both enforce the same rules: read-only by default, no remote send, imported text treated as untrusted data.

### What changed (range `bc6af53..1341059`; composition in section 1: `pr/m2`)

* `src/sdk/*`: later changes to the facade, resolver and error normalisation (`7e3deb1` marks the facade complete, after an independent review); `docs/SDK.md` (new in `8cfb1b2`).
* `src/cli/*` (commands, option parser, routing, output, signal and EPIPE handling), `src/suppress-warnings.ts`, `docs/CLI_REFERENCE.md`, `docs/CLI_HELP.txt` (`scripts/capture-cli-help.mjs`).
* `src/mcp/*` (tool table, envelope with size cap, approved roots, stdout guard, alias mechanism with an empty table per ADR-0002), `docs/MCP_TOOLS.md`, `docs/mcp-tool-schemas.json` (`scripts/dump-mcp-schemas.mjs`).
* Fixes: `3721e54` (a database with a newer schema version is refused before any write), `99cd600` (accurate `GRAPH_EMPTY` warning).
* `1341059`: `gcr_update_local_annotation` is annotated `destructiveHint: true` (the update overwrites the previous text); schemas regenerated; reviewers' fixes for MCP error results that bypassed the size cap and for unbounded serialization before the cap check (as stated in the commit message).
* Checkpoint 15 (`2d81c65`, unreviewed by its own message): reworked MCP result-size handling (`src/mcp/envelope.ts`, `src/mcp/registry.ts`, `src/mcp/tools.ts`), CLI error handling (a failing write to stdout is reported as `INTERNAL_ERROR` with a reason; safer file creation for `graph export`; `src/cli/context.ts`, `src/cli/export-file.ts`, `src/cli/output.ts`, `src/cli/route.ts`), and new adversarial tests under `test/cli` and `test/mcp`.
* Test additions: `test/cli`, `test/mcp` (real SDK client over an in-memory transport and over stdio child processes), `test/sdk`.

### Evidence

Historical, from 2026-10-11; not re-run. The current tree is in [ACCEPTANCE.md](ACCEPTANCE.md).

| Command | Result |
|---|---|
| At `99cd600` (`git archive`, Node 22.22.0): `npm run typecheck`, `npm run build` | exit 0, exit 0 |
| At `99cd600`: compiled suite | **6,565 tests, 6,561 pass, 1 fail, 3 skipped**. The failure is a **killed test file**: `test/mcp/limits.adversarial.test.ts` ends with `signal: 'SIGKILL'` after 36 to 53 s; its other sub-tests passed, and re-running that single file gave the same result. Cause **NOT VERIFIED** (memory pressure from a test case, or a defect that the then-uncommitted MCP edits address). |
| At `1341059` (proposed M2 head) | no failing test on Node 22.22.0 and Node 22.16.0, in the first author's run and an independent re-run, compiled from a working tree whose `src/` and `test/` equal `1341059` (not a `git archive` extraction); the skipped tests are the root-permission tests |
| By hand on 2026-10-11 (CLI in several import layouts, branches, thread, search, stats, audit, graph, drafts, annotations; MCP over stdio with the SDK client) | outputs match `docs/USER_GUIDE.md`; see "Earlier verification passes" below |
| `node scripts/dump-mcp-schemas.mjs --check`, `node scripts/capture-cli-help.mjs --check` | "up to date" on 2026-10-11; the freshness check is one of the gates that [ACCEPTANCE.md](ACCEPTANCE.md) is meant to record (the file did not exist when this was written) |

### Risks

* MCP result-size handling was reworked late (checkpoint 15 and `1341059`) and was reviewed only by the MCP reviewers; open the PR at `1341059`, not at `99cd600`, whose committed tests do not all run to completion. The MCP output handling changed again in the fix wave (ADR-0023, section "Final review and fix wave" below).
* VS Code, Claude Desktop and Codex were **never used** against the server; configuration snippets are unverified. Windows is untested.
* CLI remedy texts occasionally use SDK vocabulary (`maxElementBytes`, `getAnnotation`). The nested-ZIP limit has no CLI flag. `FEATURE_GATED` and `REMOTE_ACCESS_FORBIDDEN` are never emitted.
* `gcr_update_local_annotation` overwrites the previous text (only a hash is audited).

### How to review

Read ADR-0002 (empty alias table), ADR-0016 (read-only by default, write flag, approved roots), ADR-0018 (reads refused during a write), ADR-0019 (graph is derived, rebuilt wholesale), ADR-0020 (no "sent" state) first. Files to look at first: `src/sdk/gcr.ts` and `src/sdk/envelope.ts`, `src/cli/run.ts`, `src/cli/route.ts` and `src/cli/context.ts`, `src/mcp/tools.ts`, `src/mcp/envelope.ts`, `src/mcp/registry.ts` and `src/mcp/approved-roots.ts`, `src/graph/build.ts`, `src/drafts/drafts.ts`, `docs/MCP_TOOLS.md`, `docs/mcp-tool-schemas.json`, `docs/SDK.md`, `docs/CLI_REFERENCE.md`, `test/mcp/tools.write.test.ts`. All exist at `1341059` and in the current tree.

### Migration note

None (schema v1; no new migration in this range). `3721e54` only makes opening a newer-schema file safer: verified on 2026-10-11, a copy with `PRAGMA user_version = 99` kept the SHA-256 of its main file after `list` and `import` were refused; SQLite still created `-wal` and `-shm` files beside it. The fix wave later changed how stray side files are treated (ADR-0022).

### Rollback note

`git revert --no-commit bc6af53..1341059 && git commit`. MCP clients that were pointed at `dist/mcp/entry.js` simply stop finding it. Local drafts and annotations live in the user's database (`local_drafts`, `local_annotations`, `local_audit_log`); deleting the database file removes them.

### Checklist (mirrors AGENTS.md)

- [x] Local writes (draft, annotation) separate from any remote send; default is read-only for MCP; no automatic or browser sends
- [x] Hard boundary respected; the consumer URL is a lookup key; `NOT_IN_LOCAL_EXPORT` with the export remedy otherwise
- [x] Imported text is untrusted data: results carry `untrustedContent`; tool metadata is static (test: `test/mcp/security.injection.test.ts`)
- [x] No secrets, raw exports or real screenshots committed; synthetic ids only
- [x] `docs/EXECUTION_PLAN.md` row for M2 exists
- [x] No failing test at the proposed head `1341059` (not a `git archive` extraction); `99cd600` is red
- [ ] `node scripts/ci-smoke.mjs`: the script exists at the head (added in `2d81c65`, edited in `1341059`) but was not run for that commit; results for later trees: [ACCEPTANCE.md](ACCEPTANCE.md)
- [ ] Real MCP clients (VS Code, Codex, Claude Desktop): **not tested**
- [ ] Validated on Codex's own runner: **not done**
<!-- PR-M2-END -->

---

<!-- PR-M3-BEGIN -->
## M3: packaging, CI definition, security tooling, documentation

### Summary

Makes the project reproducible and reviewable: committed lockfile and `npm ci`, a read-only SHA-pinned GitHub Actions workflow and a devcontainer (**never executed on GitHub**), a privacy scanner, a dependency license inventory, a smoke test of the built CLI and MCP server with a network guard, captured CLI help and MCP schemas, and the user-facing documentation with explicit tested / untested wording. Range `1341059..caf76d1` holds the last documents and fixes; most M3 content arrived earlier, inside the M1 and M2 ranges (section 1: Also column).

### Why

`AGENTS.md` names local gates (`npm test`, `node scripts/ci-smoke.mjs`, `npm run typecheck`, `npm run build`) and forbids secrets, raw exports and real screenshots in source control and CI; this milestone makes those gates runnable and the claims reviewable.

### What changed

* In earlier ranges: `1917348` (npm scripts `privacy-scan`, `privacy-scan:history`, `licenses`, `test:browser`, `capture:cli-help`, `dump:mcp-schemas`, `perf`, `--test-concurrency=2` for `test`; the `"license": "UNLICENSED"` and `files` fields of `package.json`; `scripts/test-browser-gated.mjs`), `148845b` (`.github/workflows/gcr-ci.yml`, `.devcontainer/devcontainer.json`), `636fef6` (`src/devtools/*`, `scripts/privacy-scan.mjs`, `scripts/licenses.mjs`), `f059040` (`scripts/dump-mcp-schemas.mjs`), `7e3deb1` (`scripts/capture-cli-help.mjs`), `ea0029a` (the `coverage-summary` npm script), `2d81c65` (early drafts of `README.md`, `CHANGELOG.md`, `docs/USER_GUIDE.md`, `docs/SECURITY_AND_BOUNDARIES.md`, `scripts/ci-smoke.mjs`, `scripts/no-network-guard.cjs`, `scripts/perf-baseline.mjs`, `scripts/coverage-summary.mjs` and `test/scripts`).
* In this range: `docs/COVERAGE.md` (`91caaf2`); `docs/WARNING_CODES.md`, ARCHITECTURE sync, ADR-0013 to ADR-0021, `test/scripts/no-network-guard.adversarial.test.ts` (`1e27fa0`); smoke-script mutation tests (`d8e111a`); the fact-checked documents (`ef921ee`); `0bd3fb3` (the privacy scanner accepts the fixed synthetic-id tail with any first group; the history scan is clean since); `docs/PERFORMANCE.md` and `docs/COVERAGE.md` regenerated (`caf76d1`). `docs/PARITY_MATRIX.md` and `docs/PERFORMANCE.md` were added by `1341059`, in the M2 range.
* Workflow facts (read from `.github/workflows/gcr-ci.yml`): `permissions: contents: read`; `pull_request` (not `pull_request_target`); actions pinned to commit SHAs; `fetch-depth: 0` so that the history scan sees all commits; matrix Node `22.16.0` and `22.x` (Node 24 deliberately absent); steps: `npm ci`, `npm audit --omit=dev --audit-level=high`, typecheck, build, test, smoke, `privacy-scan:history`, `licenses`, `test:browser`.

### Evidence

All results of the current tree (typecheck, build, the compiled suite on Node 22.22.0 and on the declared minimum 22.16.0, smoke, privacy scan of tree and history, license inventory, `npm audit`, CLI-help and MCP-schema freshness, performance and coverage runs) belong in [ACCEPTANCE.md](ACCEPTANCE.md): command, exit code, counts, durations, Node version and date. The file exists now; this file repeats none of its numbers. Checked for this file on 2026-10-12:

| Command | Result |
|---|---|
| `node scripts/privacy-scan.mjs --root . --history` | `privacy-scan: clean`, exit 0 (about 09:33 UTC, working tree and all commits, with the `dist/` built at 06:35 UTC, which is older than `src/devtools/privacy-scan.ts`; the gate result is in [ACCEPTANCE.md](ACCEPTANCE.md)) |
| `node scripts/test-browser-gated.mjs` | `NOT_RUN: no browser code exists in this build ...`, exit 0 |
| `npm audit --omit=dev --audit-level=high` | needs the npm registry; **not run** for this file (no network); the first author's run on 2026-10-11 exited 0 |
| `node scripts/ci-smoke.mjs` | not run for this file; one intermittent failure pair was seen on 2026-10-11 under heavy machine load and was not diagnosed (section 0); repeated runs: [ACCEPTANCE.md](ACCEPTANCE.md) |
| The GitHub Actions workflow | **never run on GitHub**; each step except `npm ci` was run locally by the commands above |

### Risks

* The workflow is untested on GitHub: action SHAs were resolved on 2026-10-10 and not re-checked; runner image and `setup-node` behaviour are unknown. The history scan needs `fetch-depth: 0` (it fails closed on a shallow clone since `c35137d`).
* `0bd3fb3` made the history scan clean by widening the scanner's synthetic-id rule, not by rewriting history (the old finding stays in `c8533e4`). Review that rule: its message argues that a random UUIDv4 matches the fixed tail with probability about 2^-82.
* The privacy scanner is a tripwire with documented limits (secrets without a distinctive shape are not found). The no-network test is a tripwire too; the MCP SDK dependency tree contains HTTP packages that GCR never imports.
* The privacy history scan (`--history`) rewrites nothing but reads all refs; it is bounded (64 MiB by default) and says when it truncated.
* Documentation states what is untested; reviewers should check that no sentence says more than the evidence. The documents were fact-checked by other agents, not by an operator.

### How to review

Files to look at first: `.github/workflows/gcr-ci.yml`, `.devcontainer/devcontainer.json`, `scripts/ci-smoke.mjs`, `scripts/no-network-guard.cjs`, `scripts/privacy-scan.mjs` with `src/devtools/privacy-scan.ts`, `scripts/licenses.mjs`, `docs/SECURITY_AND_BOUNDARIES.md`, `docs/PARITY_MATRIX.md`, `docs/WARNING_CODES.md`, `README.md`, `CHANGELOG.md`, `docs/USER_GUIDE.md`, `package.json`. All exist at `caf76d1` and in the current tree. Run the gate commands of `AGENTS.md` (`npm test`, `node scripts/ci-smoke.mjs`, `npm run typecheck`, `npm run build`) on your own runner and compare with [ACCEPTANCE.md](ACCEPTANCE.md).

### Migration note

None.

### Rollback note

`git revert` the range, or remove the workflow file; scripts have no side effects outside the working tree (the smoke test uses a temp directory removed in `finally`; `licenses` and `privacy-scan` are read-only).

### Checklist (mirrors AGENTS.md)

- [x] Required local gates exist: `npm test`, `node scripts/ci-smoke.mjs`, `npm run typecheck`, `npm run build`, `npm run test:browser` (reports `NOT_RUN`)
- [x] Read-only token, pinned actions, no secrets, no ChatGPT login in CI; synthetic fixtures only
- [x] Evidence recorded with exact commands, exit codes, Node versions and dates, in [ACCEPTANCE.md](ACCEPTANCE.md) (sections 2 to 4, including the runs on Node 22.16.0, in a fresh clone and as a non-root user)
- [x] No claim of live integration from synthetic fixtures; OpenAI policy review stated as **NOT PERFORMED**
- [ ] CI job executed on GitHub: **no**
- [ ] `docs/SECURITY_AND_BOUNDARIES.md` consulted for auth/network/browser changes: the file exists since checkpoint 15; the author of this description only listed its section headings, a reviewer should read it
- [ ] Validated on Codex's own runner: **not done**
<!-- PR-M3-END -->

---

<!-- PR-M4-BEGIN -->
## M4: browser UI capability (gated): documentation only

### Summary

Mode E (browser interaction, FR-17) is **gated and ships no code** (ADR-0010). The deliverables are the gate document, the human checklist, the stop conditions, and a script that reports `NOT_RUN`. The v0.1.1 extension and live bridge were not available (ADR-0001), so there was nothing to disable.
This milestone has **no unique commits**: its content is in `68c016d` (ADR-0010), `c1b4854` (`docs/BROWSER_GATE.md`), `636fef6` (`test/security/no-network.test.ts`) and `1917348` (`scripts/test-browser-gated.mjs`, `npm run test:browser`). Paste this description into the M3 PR, or into a docs-only PR if you re-cut the history.

### Why

FR-17 needs written terms-of-use approval and a separate manual test (`SPEC.md`); an agent can produce neither, so the milestone ships the gate and no code (ADR-0010).

### What changed

* `docs/BROWSER_GATE.md`: why the feature is gated (consumer URL is not an API resource; OpenAI terms **not verified**: every `*.openai.com` host was unreachable from the sandbox), what is allowed today (user logs in personally, official export, manual copy, local draft, manual paste), what GCR will not do, a 14-item human gate procedure (agents must not tick it), supported alternatives.
* `test/security/no-network.test.ts`: fails if any file under `src/` imports a network, browser-automation or process module (`src/devtools` may use `child_process` for git only) or if the runtime dependency set leaves its reviewed allow-list.
* `npm run test:browser` prints `NOT_RUN` (exit 0).

### Evidence

| Command | Result |
|---|---|
| `node scripts/test-browser-gated.mjs` | `NOT_RUN: no browser code exists in this build (FR-17 is GATED; see docs/BROWSER_GATE.md). This is not a pass; it means the capability is not implemented.` exit 0 (run on 2026-10-12) |
| `test/security/no-network.test.ts` | part of the compiled suite (counts: [ACCEPTANCE.md](ACCEPTANCE.md)); a source tripwire, with limits stated in the test header |
| `gcr doctor` (built CLI, scratch directory, 2026-10-12) | Mode E: `gated - no code (docs/BROWSER_GATE.md)`; Mode D: `not implemented (interface + disabled adapter only)` |

EXECUTION_PLAN gate ("`docs/BROWSER_GATE.md` present; no network/browser code (test)"): met. FR-17 itself ("written ToU/permissions approval + separate manual test") is **not met and cannot be met by an agent**: it stays `GATED`.

### Risks

* A reader may mistake "gated" for "coming soon". It is not scheduled. Any future proposal needs the human checklist and a reviewed ADR first.
* The OpenAI policy review is **NOT PERFORMED**: no clause is quoted or paraphrased as fact anywhere in this repository.

### How to review

Files to look at first: `docs/BROWSER_GATE.md`, `test/security/no-network.test.ts`, `scripts/test-browser-gated.mjs`, ADR-0010 in `docs/DECISIONS.md`, `src/sdk/doctor.ts` (the wording of modes D and E). All exist at `caf76d1` and in the current tree. Check that no sentence in the repository presents mode E as available.

### Migration note

None.

### Rollback note

Nothing to roll back at run time (no code). Reverting removes the documentation and the script only.

### Checklist (mirrors AGENTS.md)

- [x] Hard boundary: no undocumented ChatGPT API, cookie or token handling, scraping, bot-protection bypass or automated sending
- [x] Feature flag default OFF: there is no flag because there is no code
- [x] Stop conditions recorded; no workaround presented as parity
- [x] `npm run test:browser` reports `NOT_RUN` (not a pass)
- [ ] Human gate procedure completed: **no** (human-owned; agents must not tick it)
- [ ] Current OpenAI Terms of Use and Usage Policies read by a human and recorded in an ADR: **no**
<!-- PR-M4-END -->

---

<!-- PR-FW-BEGIN -->
## Final review and fix wave (2026-10-12)

### Summary

After the documentation pass of M3 (`caf76d1`), a final multi-lens review of four reviewers (spec conformance, black-box security, test quality, docs) found defects; per the CHANGELOG entry "Fixed and hardened after the first independent review", each was reproduced first, fixed with a regression test that fails without the fix, and attacked again by a second reviewer. This range (`caf76d1..HEAD`, section 1: `pr/fw`) holds those fixes and their documentation: nine commits, `c062899` (dated 2026-10-11 16:03 UTC, counted in this wave by the CHANGELOG entry and ADR-0026) to `d9bac73`. Schema v1 is unchanged. The decision records are ADR-0022 to ADR-0027, **written after the code existed** and not confirmed by an operator or by legal review.

### What each reviewer found and what was done

Ids are the ones written in the CHANGELOG entry, ADR-0022 to ADR-0027 and the commit messages; severities ("HIGH") only where the CHANGELOG gives one. The findings of the test-quality and docs reviewers are **not itemised in the CHANGELOG or in an ADR**; their rows come from commit messages and test comments and say so.

| Reviewer | Finding | What was done | Recorded in |
|---|---|---|---|
| Security | **ATK-01 (HIGH)**: a dangling symbolic link as `--db` made SQLite create the link's target with default permissions (0644, readable by group and other); so did a link to a 0- or 1-byte or table-less SQLite file. The ADR-0022 context adds, without an id of their own: creating a database beside an operator's own `-wal` / `-journal` / `-shm` files destroyed or reinitialised them, and a read-only open of a FIFO blocked the process for ever | The database name is inspected with `lstat` before anything is created or opened: refused with `SYMLINK_DB_PATH` (links), `STRAY_SIDECAR_FILES` (a new database beside existing side files), `not_a_regular_file` (FIFO, device, socket); `EEXIST` counts as a lost race only for a regular file owned by the user | ADR-0022; `src/db/open.ts`; `test/db/fixwave-open-symlink.test.ts`, `test/db/open.path.adversarial.test.ts` |
| Security | **ATK-05**: a failed first import unlinked an operator's unrelated `<db>-wal`, `-shm` or `-journal` file | A snapshot (`lstat`) of the four names is taken first; only names that did not exist before and exist now are removed; the default `./.gcr` goes only if the command created it and it is empty. **Not fixed, documented:** no lock, so two commands creating the same new database at once can lose an import | ADR-0027; `src/cli/context.ts`; `test/cli/fixwave-db-safety.test.ts`, `test/cli/db-safety.adversarial.test.ts` |
| Security | **ATK-08a, ATK-11**: a read-only open of another application's SQLite file said "not initialized"; the default `./.gcr/gcr.sqlite` is relative to the current directory, so a planted database in a prepared directory is opened | `not_gcr_database` error; one stderr warning when the default database or its directory is not owned by the current user (POSIX only, advisory, not for `--db` / `GCR_DB`, not for `gcr doctor`) | ADR-0022 items 4 and 5; `src/cli/context.ts` |
| Security | **ATK-02 (HIGH), ATK-03, ATK-09**: the privacy scanner skipped every file above 2 MiB (an unmarked export of a few megabytes under almost any name was clean), did not recognise GCR's own output or the usual export locations, and lacked common credential shapes | Fails closed: head and tail windows and the finding `unscanned-large-file`, `scan-truncated`, `gcr-output-file`, more credential rules, `--staged` mode, opt-in git hooks (`node scripts/install-git-hooks.mjs`), wider `.gitignore`. **Left open:** the synthetic marker is still a plain text match anywhere in a file (follow-up ADR needed); hooks can be bypassed; the pre-push hook scans the work tree, not the pushed commits | ADR-0025; `src/devtools/privacy-scan.ts`, `scripts/install-git-hooks.mjs`, `scripts/git-hooks/pre-commit`, `scripts/git-hooks/pre-push`; `test/devtools/fixwave-privacy-large.test.ts` |
| Security | **ATK-04**: MCP results kept DEL, C1 controls, bidi controls, TAG characters and U+2028 / U+2029 raw | Shown as visible `\uXXXX` escapes in every string and key (text block and `structuredContent`); the size cap is measured on the escaped form. **Not lossless:** an id containing such a character comes back escaped and cannot be passed to another tool; the CLI JSON stays lossless | ADR-0023; `src/format/scrub.ts`, `src/mcp/envelope.ts`; `test/mcp/fixwave-scrub.test.ts` |
| Security | **ATK-10**: a hard link is not a symbolic link, so `realpath` cannot see that a name inside an approved root is the same file as one outside it (comment in `src/mcp/approved-roots.ts`) | Regular files with more than one hard link are refused as import paths under approved roots | CHANGELOG; `src/mcp/approved-roots.ts`; `docs/MCP_TOOLS.md` |
| Security | **ATK-06, ATK-08**: output too large for one string surfaced as `INTERNAL_ERROR`; error wording for a foreign SQLite file and for an element too large to sniff | `INVALID_ARGUMENT` / `OUTPUT_TOO_LARGE`; a foreign SQLite file says "not a GCR database" (see ATK-08a); an element too large to sniff says to pass `--provider` | CHANGELOG; `src/format/render.ts`; `test/format/fixwave-output-too-large.test.ts`, `test/ingest/fixwave-registry-sniff.test.ts` |
| Spec conformance | **NFR-05 import memory (HIGH; "SPEC-01" in the message of `171b7dd`)**: pass 1 kept conversation-id strings that pinned the full text of every conversation, so a 210 MB export died under a 192 MiB heap cap | Keys are copied into flat strings (`flatString()`, `c062899`); the memory model is the number of conversations plus the largest conversation, classified `supported-with-bounds`; the perf script now probes 1/5x, 1x and 5x of the data and warns above 1.6x peak RSS (`171b7dd`). Figures: ADR-0026 and `docs/PERFORMANCE.md` | ADR-0026; `src/ingest/import-runner.ts`; `test/ingest/import-runner.heapcap.test.ts` |
| Spec conformance | **SPEC-02, SPEC-03**: `gcr get` / `gcr thread` did not print the warnings of the SDK and MCP in every format; `gcr graph query "EMBLEM-NLP"` returned a silent empty graph | Same warnings in every format with `SOURCE_NOT_FULL_HISTORY` first; hyphenated terms are split (`TERM_SPLIT`) and a miss reports `NO_MATCHING_NODE` | CHANGELOG; `src/cli/warnings.ts`, `src/graph/query.ts`; `test/cli/fixwave-spec-warnings.test.ts`, `test/cli/fixwave-spec-graph-query.test.ts` |
| Spec conformance | **SPEC-04 (FR-15)**: an attachment file name was findable only as a graph entity, which the default graph build dropped when it occurred in one conversation | New search scope `attachments`: file name and MIME type only, no index, no schema change, no file content. **Behaviour change:** `--scope all` now also returns attachment items | ADR-0024; `src/db/search.ts`; `test/db/fixwave-spec-attachments.test.ts` |
| Spec conformance | **SPEC-06, SPEC-07, SPEC-08** | `NO_BRANCHES` distinguishes an empty tree from messages no root reaches; `branchProvenance` is `null` when no tree check ran (**breaking for typed consumers**); a symbol-only query says so. (SPEC-05 is not mentioned in the CHANGELOG or in an ADR.) | CHANGELOG; `test/cli/fixwave-spec-no-branches.test.ts`, `test/cli/fixwave-spec-audit.test.ts`, `test/cli/fixwave-spec-symbols.test.ts` |
| Test quality | Behaviour pinned by three existing tests changed on purpose (MCP escapes instead of raw separators); the first full run after the fix wave failed in the smoke script, a sabotage anchor and an import-specifier scan (side effects of the fix wave, listed here for want of a better row: the repository does not say that the test-quality reviewer reported them) | Tests updated, none weakened or deleted (CHANGELOG); smoke check, sabotage anchor and a comment in `src/ingest/registry.ts` adapted | CHANGELOG; commit `1ac22fd` |
| Test quality | **TQ-01 (high, "round-2 test review")**: the leak check in `test/scripts/perf-baseline.test.ts` searched the generated page for the bare OS user name, which fails for the accounts `runner`, `node`, `nobody`, so the first CI run would have been red. **TQ-02**: `privacy-scan --history` reported clean on a shallow clone | Shape-based `machineLeaks()` check with a regression test over the committed generated pages; `--history` reports `scan-truncated` (exit 1) when `git rev-parse --is-shallow-repository` is true | commit `c35137d` (message); `test/scripts/machine-leaks.test.ts`, `test/devtools/fixwave-privacy-shallow.test.ts` |
| Test quality | **TQ-03 to TQ-09**: hardening against surviving mutants and gaps. Test comments committed in `d9bac73` name TQ-03 (a bare UUID is trimmed of ASCII whitespace only), TQ-04 (userinfo of a URL ends at the last `@`; a vanished batch row gives `mixed` plus `SOURCE_BATCH_MISSING`) and TQ-05 (import idempotency race path; foreign-owner refusal); TQ-06 to TQ-09 appear in **no committed file**: at `d9bac73` they exist only as the end of the range "TQ-03..TQ-09" in the commit message. Uncommitted test changes in the working tree (in no PR range) name them in their comments: TQ-06 (the `NODE_OPTIONS` quoting and Unix-socket helpers in `test/helpers`), TQ-07 (the oversized-element scenario in `test/ingest/json-stream.adversarial.test.ts` runs in a child process with a heap cap instead of being skipped when free memory is low), TQ-08 (`test/errors.test.ts` pins the error-code to exit-code mapping), TQ-09 (the source scan in `test/ingest/manual-copy.import.test.ts` can no longer pass when the file is missing) | Tests added in `test/db`, `test/domain`, `test/entities`, `test/ingest`, `test/sdk`; **the commit message says in progress, not yet verified**; no `src/` change in it | commit `d9bac73` (message and test comments) |
| Docs | A fact-check of the reference documents against the code and the built CLI corrected 11 statements (per the message of `491cf9c`), among them a false example in the help text of `gcr search --scope attachments` ("diagram" does not find `synthetic-notes.txt`) | Documents synced with the fix wave; the help sentence fixed in `src/cli` and `docs/CLI_HELP.txt` regenerated; ADR-0022 to ADR-0027 written | commits `c8062e4`, `491cf9c` (messages) |
| Docs | Run numbers in README and CHANGELOG had gone stale, and statements that the history scan fails were obsolete (attribution to the docs reviewer is not stated in the commit message) | Numbers removed from both (test counts, durations and dates now live only in [ACCEPTANCE.md](ACCEPTANCE.md)); CHANGELOG entry for the first-review fixes added | commit `56a0af9` (message); CHANGELOG |

Also in the wave, not tied to a finding id: `scripts/audit-report.mjs` and `docs/AUDIT_REPORT.md` (branch and model provenance audit of the synthetic fixtures), `scripts/release-checksums.mjs` (SHA-256 manifest of the `npm pack` tarball; NFR-02 stays `partial`), and the Phase 0 research notes `docs/research/` (all in `171b7dd`).

### Risks

* Visible changes for callers: `--scope all` returns attachment items (ADR-0024); `branchProvenance` can be `null` (SPEC-07); MCP results are not a lossless copy of imported text (ADR-0023); a read-write open of a symbolic link to an empty file is refused (ADR-0022).
* Known limitations left open on purpose: concurrent creation of one new database (ADR-0027); the plain-text synthetic marker in the privacy scanner (ADR-0025); the pre-push hook and the ignore rules are bypassable; the ownership warning is advisory and gives false positives for checkouts owned by another uid.
* The decision records were written after the code and are not confirmed by an operator.
* `a0c75fd` is a checkpoint ("do not read this commit as verified") and `d9bac73` is labelled in progress; the wave is reviewable only as a whole range. Verified results for the final tree: [ACCEPTANCE.md](ACCEPTANCE.md).
* Real ChatGPT exports, real MCP clients, Windows, macOS and Node 24 remain untested.

### How to review

Read ADR-0022 to ADR-0027 first (each lists its evidence and what it did not check). Files to look at first: `src/db/open.ts` (path checks), `src/cli/context.ts` (first-import take-back, ownership warning), `src/format/scrub.ts` and `src/mcp/envelope.ts` (escapes and size cap), `src/devtools/privacy-scan.ts` (fail-closed rules) with `scripts/install-git-hooks.mjs`, `src/ingest/import-runner.ts` (`flatString`), `src/db/search.ts` (`searchAttachments`), then `docs/AUDIT_REPORT.md`, `docs/research/README.md`, `scripts/audit-report.mjs`, `scripts/release-checksums.mjs`. Regression tests: `test/ingest/import-runner.heapcap.test.ts`, `test/db/fixwave-open-symlink.test.ts`, `test/mcp/fixwave-scrub.test.ts`, `test/devtools/fixwave-privacy-large.test.ts`, `test/db/fixwave-spec-attachments.test.ts`. All exist at `d9bac73`.

### Migration note

None. `src/db/schema.ts` is identical at `caf76d1` and `HEAD`; the attachment search needs no index (ADR-0024).

### Rollback note

`git revert --no-commit caf76d1..origin/claude/chatgpt-conversation-reader-rraexo && git commit`. Local databases are unaffected; the git hooks are copies that exist only where the operator ran `node scripts/install-git-hooks.mjs` (never run in this repository).

### Checklist (mirrors AGENTS.md)

- [x] Hard boundary respected: still no network, cookie, browser or private-endpoint code
- [x] Each fix has a regression test named in the ADR or the table above
- [x] Imported text stays untrusted data; MCP results escape hazardous characters visibly (ADR-0023)
- [ ] All gates green at the final head: see [ACCEPTANCE.md](ACCEPTANCE.md); **not asserted here**
- [ ] The test-quality and docs findings itemised in a durable record: **no** (commit messages and test comments only)
- [ ] Validated on Codex's own runner: **not done**
<!-- PR-FW-END -->

---

## Earlier verification passes of 2026-10-11 (kept for the record)

Two passes were done on 2026-10-11, by the first author (about 12:38 to 13:35 UTC) and by an independent second reader (about 14:00 to 14:45 UTC): Linux, as `root`, no network, Node 22.22.0 unless stated. Their counts, timings and machine loads are not repeated here, because the tree changed afterwards and the record for the final tree is [ACCEPTANCE.md](ACCEPTANCE.md). What was checked, and the outcome:

| Check | How | Outcome |
|---|---|---|
| Quoted CLI outputs match the CLI | A battery of the documented commands (import, re-import, list, get by UUID and by link, `NOT_IN_LOCAL_EXPORT`, share link, bad UUID, branches, thread, search in several modes, stats, audit, draft, graph build / god-nodes / path / explain / export, import errors, `import-copy`, CJK and accent search) was recorded in several rounds and diffed after masking timestamps, durations, cursors and random ids | identical in every round, although `src/cli` changed in checkpoint 15 |
| Other demos | Import layouts (sharded ZIP, folder, nested ZIP, stdin), snapshots and head rule, account labels, branch policies, the CLI error codes, manual copy, Cyrillic / Greek / CJK search | same results when repeated |
| MCP | The SDK client over stdio against `dist/mcp/entry.js`: default mode and `--allow-local-writes` with an approved root; a raw JSON-RPC pipe through `gcr mcp` | `WRITE_FORBIDDEN`, `IMPORT_PATH_NOT_ALLOWED`, `NOT_IN_LOCAL_EXPORT`, `ANNOTATION_CONFLICT` as documented; stderr empty |
| Generated documents | `node scripts/dump-mcp-schemas.mjs --check`, `node scripts/capture-cli-help.mjs --check` | both "up to date" |
| Cross-references | Every relative Markdown link, `#anchor` and backticked repository path in the user-facing documents and in the earlier version of this file | no broken reference; the only unresolved names were example file names and the then-missing `ACCEPTANCE.md` |
| Privacy | `node scripts/privacy-scan.mjs --root .` and `--history` | tree clean; history had one finding (`c8533e4`), since resolved by `0bd3fb3` |
| Old Node | `gcr doctor` and `gcr import` under a real Node 22.13.1 binary | `FTS5_UNAVAILABLE` answer, exit 5, no database file created |
| Milestone heads | `git archive` of `68c016d`, `bc6af53`, `99cd600` | results in section 0 and in the M0, M1 and M2 evidence; measured once, not repeated (the commits cannot change) |
| Not re-run in those passes | `npm audit` (network), `npm ci` (network), anything on GitHub, the three MCP client products, a browser on the graph page, permission-denied paths (running as root) | **NOT VERIFIED** by those passes |

Raw logs of those runs were kept in the authors' scratch folders, not in the repository (they contain test output and temporary paths).
