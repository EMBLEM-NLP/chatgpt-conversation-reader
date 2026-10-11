# PR notes: ready-to-paste pull request descriptions for milestones M0 to M4

Written 2026-10-11 from the real git history of branch `claude/chatgpt-conversation-reader-rraexo` (read-only `git log`, `git show`, `git diff`, `git archive`) and fact-checked a second time at about 14:00 to 14:45 UTC the same day (section 7). The history keeps growing while documents are written: re-run `git log --oneline` before you cut anything. Milestones are those of
[EXECUTION_PLAN.md](EXECUTION_PLAN.md). Companion rules: [../AGENTS.md](../AGENTS.md), [DECISIONS.md](DECISIONS.md).

## 0. Read this first

* **No pull request has been opened by the implementing agent** (ADR-0006; whether anyone opened one on GitHub was not checked: no network). `gh pr create` is the operator's to run; the commands are in section 2. A local remote-tracking ref `origin/claude/chatgpt-conversation-reader-rraexo` exists and pointed at the same commit as the local branch when checked on 2026-10-11 (`1e27fa0` at 14:05 UTC, `d8e111a` at 14:37 UTC), which means the branch has been pushed from this clone at least once; what GitHub holds was **not verified**. No `git push` was run by the author of this file or by the fact-checker.
* **The history was not squashed and is mostly work-in-progress checkpoints.** The branch has 26 commits between 2026-10-10 22:13 UTC and 2026-10-11 14:36 UTC (`git rev-list --count HEAD` gave 25 at 14:05 UTC and 26 at 14:37 UTC; it grows while people work): 18 are checkpoints (`wip(m1)`, `wip(m2)`, `wip:`, `test: checkpoint 9`, and checkpoints 15 to 18, `2d81c65`, `91caaf2`, `1e27fa0` and `d8e111a`) and 8 are
  focused changes (`chore(m0)`, `fix(drafts)`, `chore(m3)`, `fix(db)` twice, `ci`, `fix(sdk)`, `fix(mcp)`). Checkpoints were taken when a session limit or a review boundary was reached, so a commit label (`m1`, `m2`) names the phase in progress, **not** the scope of the files in it.
  For example the graph, entity and draft modules (scope of M2 in the plan) first land inside commits labelled `wip(m1)`.
* **The milestone heads are not all green.** Each head was extracted with `git archive` into a scratch folder and typechecked, built and tested (Node 22.22.0, same `package-lock.json`, `node_modules` of the working tree; see the evidence blocks). Findings:
  * `68c016d` (M0): typecheck and build green; **there are no tests yet**.
  * `bc6af53` (M1 head): **1 failing test** (`test/sdk/errors.test.ts`, a wrong expectation; fixed by a test edit in `8cfb1b2`). Reproduced on 2026-10-11 at 14:1x UTC on Node 22.22.0: 5,807 tests, 5,803 pass, 1 fail, 3 skipped.
  * `99cd600` (the last commit before checkpoint 15): **1 failing test file** (`test/mcp/limits.adversarial.test.ts` is killed with `SIGKILL` after 36 to 53 s in the first author's runs; reproduced again on 2026-10-11 at 14:26 UTC: 28 s when run alone, and in the full suite).
  * `2d81c65` (checkpoint 15): contains the MCP envelope rework and CLI edits that were uncommitted while `99cd600` was measured, plus early drafts of the scripts and documents. Its message says it is "NOT a milestone completion" and that the suite was not re-run for it. **Not measured as a commit** (its tree was never extracted for a run). A full run on Node 22.16.0 started at 13:04 UTC on the moving working tree had 4 failures that were not Node-specific: the repository's `dist/` had been rebuilt (by `npm run build` run by the author of this file at about 12:57) from in-flight sources that already said `destructiveHint: true` for `gcr_update_local_annotation`, while `docs/mcp-tool-schemas.json` and the smoke expectations still said `false` (two tests in `test/mcp/docs.consistency.test.ts` and two in `test/scripts/ci-smoke.pass.test.ts`). The next commit, `1341059`, reconciles them.
  * `1341059` (proposed M2 head): `fix(mcp)` sets `destructiveHint: true` on `gcr_update_local_annotation` (it overwrites the old text), regenerates `docs/mcp-tool-schemas.json`, and carries the CLI/MCP reviewers' fixes. Its own result: **6,750 tests, 6,748 pass, 0 fail, 2 skipped** on Node 22.22.0 (343 s) and on Node 22.16.0 (453 s), compiled from the tree of `1341059` (only documentation files differed); both skips are the root-permission tests
    The commit message says the full suite was not re-run for it.
* **Early drafts of `README.md`, `CHANGELOG.md`, `docs/USER_GUIDE.md`, this file, `docs/SECURITY_AND_BOUNDARIES.md`, `scripts/ci-smoke.mjs`, `scripts/no-network-guard.cjs`, `scripts/perf-baseline.mjs` and `scripts/coverage-summary.mjs` were committed in checkpoint 15 (`2d81c65`)**; `docs/PARITY_MATRIX.md` and `docs/PERFORMANCE.md` arrived in `1341059`, `docs/COVERAGE.md` in checkpoint 16 (`91caaf2`), and `docs/WARNING_CODES.md` plus `test/scripts/no-network-guard.adversarial.test.ts` in checkpoint 17 (`1e27fa0`, whose message says the tests were not re-run for it). Later versions of the four user-facing documents were committed in `1e27fa0`; checkpoint 18 (`d8e111a`, 14:36 UTC, "tests not re-run") snapshotted the second fact-check's corrections (section 7) while they were still in progress; whatever changed after that is uncommitted at the time of writing. The acceptance record that `SPEC.md` and the task name (ACCEPTANCE.md under docs/) **does not exist** (`ls` at 14:09 UTC). The M3 and M4 descriptions assume the final pass is committed first; that final commit does not exist yet, so `<FINAL_SHA>` below is a placeholder.
* **Evidence rule** (EXECUTION_PLAN): every result below names the command, the exit status or counts, the Node version and the date. "Not run" is stated where it applies. All data is synthetic. Nothing here shows that a real ChatGPT export imports correctly: none was ever available.
* **Migration note for every PR: none.** SQLite schema v1 is created fresh (`PRAGMA user_version = 1`) in the user's own local file; nothing is migrated and no shared data exists.
* **Rollback note for every PR:** before merge, delete the branch; after merge, `git revert -m 1 <merge commit>` (merge commits) or `git revert --no-commit <base>..<head>` followed by `git commit` (fast-forwarded ranges). Local data: delete the database file and its `-wal` and `-shm` files
  (`rm gcr.sqlite gcr.sqlite-wal gcr.sqlite-shm`); an import is atomic, and the default location is `./.gcr/`. Exports are never modified by GCR.

## 1. Commit-to-milestone map

"Milestone" is assigned by what the commit contains. Hashes are abbreviated; dates are UTC.

| # | Commit | Date | Subject | Milestone (by content) | Notes |
|---|---|---|---|---|---|
| 1 | `68c016d` | 10-10 22:13 | chore(m0): bootstrap GCR clean-room scaffold, contracts and decision records | **M0** | SPEC, AGENTS, task, runbook, ARCHITECTURE, DECISIONS (ADR-0001 to 0011), EXECUTION_PLAN, tsconfig, lockfile, `src/{errors,logger,version,domain}`, test helpers |
| 2 | `c1b4854` | 10-10 22:41 | wip(m1): core modules (domain, ZIP/JSON stream) + Phase 4 gate doc | M1 (and M4 doc) | `docs/BROWSER_GATE.md` is the whole M4 deliverable |
| 3 | `636fef6` | 10-10 23:06 | wip(m1): checkpoint 2 - SQLite layer, adapters, privacy scanner | M1 (+ M3 tooling) | `src/db`, adapters, fixtures, `src/devtools` (privacy scan, licenses), `scripts/privacy-scan.mjs`, `scripts/licenses.mjs` |
| 4 | `9028d6a` | 10-10 23:11 | wip(m1): checkpoint 3 | M1 | renderers started |
| 5 | `32b9c7b` | 10-10 23:12 | wip(m1): checkpoint 4 (known type error) | M1 | **commit does not typecheck by its own message** |
| 6 | `c8533e4` | 10-10 23:45 | wip(m1): checkpoint 5 | M1 (+ M2 modules) | first `src/analysis`, `src/entities`, `src/graph`, `src/drafts`; IMPORT_FORMAT / IMPORT_GUIDE |
| 7 | `12de7a9` | 10-10 23:46 | fix(drafts): use \u escapes in oneLine() | M2 module fix | one file |
| 8 | `f14350b` | 10-11 04:48 | wip(m1): checkpoint 6 - session-limit interruption | M1 / M2 modules | |
| 9 | `f164efd` | 10-11 05:25 | wip(m1): checkpoint 7 - graph + drafts built | M1 / M2 modules | |
| 10 | `1917348` | 10-11 05:27 | chore(m3): wire npm scripts and gated test:browser | **M3** (+ M4 script) | `package.json` scripts, `scripts/test-browser-gated.mjs` |
| 11 | `0033c9c` | 10-11 05:37 | wip: checkpoint 8 | M1 / M2 modules | `src/sdk` starts |
| 12 | `5cccdcd` | 10-11 05:45 | test: checkpoint 9 - full suite green | M1 / M2 modules | `src/index.ts` (public API) |
| 13 | `bc6af53` | 10-11 05:59 | fix(db): require Node >= 22.16.0 (FTS5), fail fast on older runtimes | M1 (ADR-0012) | adds `test/sdk` (11 files); **1 test fails at this commit** |
| 14 | `148845b` | 10-11 05:59 | ci: read-only, SHA-pinned workflow and devcontainer | **M3** | never run on GitHub |
| 15 | `8cfb1b2` | 10-11 06:05 | wip(m2): checkpoint 10 - SDK facade built | M2 | `docs/SDK.md`, first `src/cli`, `src/mcp`; fixes the failing SDK test |
| 16 | `f059040` | 10-11 06:31 | wip(m2): checkpoint 11 - CLI and MCP first drafts | M2 (+ M3 docs) | `docs/MCP_TOOLS.md`, `docs/mcp-tool-schemas.json`, `scripts/dump-mcp-schemas.mjs` |
| 17 | `7e3deb1` | 10-11 06:36 | wip(m2): checkpoint 12 - SDK facade complete | M2 (+ M3) | `scripts/capture-cli-help.mjs` |
| 18 | `ea0029a` | 10-11 07:05 | wip(m2): checkpoint 13 - CLI and MCP server built | M2 (+ M3 docs) | `docs/CLI_REFERENCE.md`, `docs/CLI_HELP.txt` |
| 19 | `02b0644` | 10-11 07:05 | wip(m2): checkpoint 14 - MCP reviewer's adversarial limits test | M2 | adds the test that is killed at `99cd600` |
| 20 | `3721e54` | 10-11 12:17 | fix(db): refuse newer-schema files before any write | M2 | verified again on 2026-10-11: a copy with `user_version = 99` keeps the SHA-256 of its main file after a refused `list` and `import` (`-wal` and `-shm` files were created next to it by SQLite) |
| 21 | `99cd600` | 10-11 12:18 | fix(sdk): accurate GRAPH_EMPTY warning | M2 | last commit before checkpoint 15; killed MCP test file |
| 22 | `2d81c65` | 10-11 12:51 | wip: checkpoint 15 - CLI/MCP review edits, verification scripts and docs in progress | M2 (CLI/MCP edits) + M3 (scripts, documents) | "Checkpoint only; NOT a milestone completion" |
| 23 | `1341059` | 10-11 13:13 | fix(mcp): annotate gcr_update_local_annotation destructiveHint:true (it overwrites the old text) | M2 (+ M3 docs: parity matrix, performance) | proposed M2 head; also adds `docs/PARITY_MATRIX.md`, `docs/PERFORMANCE.md` and, per its message, 20 reviewer-reported CLI/MCP defects fixed |
| 24 | `91caaf2` | 10-11 13:27 | wip: checkpoint 16 - verification scripts and docs drafts in progress | M3 (documents, smoke script) | adds `docs/COVERAGE.md`; touches only documents and `scripts/ci-smoke.mjs` |
| 25 | `1e27fa0` | 10-11 14:04 | wip: checkpoint 17 - verification scripts and docs still in progress | M3 (documents, scripts, one new test file) | `HEAD` at 14:05 UTC; adds `docs/WARNING_CODES.md` and `test/scripts/no-network-guard.adversarial.test.ts`; changes ARCHITECTURE, DECISIONS (ADR-0013 to ADR-0021), PARITY_MATRIX, SECURITY_AND_BOUNDARIES, the four user-facing documents, `scripts/ci-smoke.mjs`, `scripts/no-network-guard.cjs` (12 files, +1,807 -364); message: "tests not re-run for this commit"; no `src/` change |
| 26 | `d8e111a` | 10-11 14:36 | wip: checkpoint 18 - docs fact-check and smoke-script mutation testing in progress | M3 (documents, scripts, one new test file) | `HEAD` when checked at 14:37 UTC; documents, `scripts/ci-smoke.mjs`, `scripts/no-network-guard.cjs` and the new `test/scripts/ci-smoke.adversarial.test.ts` (11 files, +494 -134); message: "tests not re-run for this commit"; no `src/` change |

| Milestone | Commits | Contiguous range |
|---|---|---|
| M0 | 1 | `68c016d` |
| M1 | 2 to 13 (12 commits; `1917348` is M3 content interleaved) | `68c016d..bc6af53` (git range notation: excludes `68c016d`, includes `c1b4854` ... `bc6af53`) |
| M2 | 14 to 23 (10 commits; `148845b` is M3 content, `2d81c65` and `1341059` are mixed M2 / M3) | `bc6af53..1341059` (the entity, graph and draft modules and `12de7a9` are in the M1 range) |
| M3 | `1917348`, `148845b`, the scripts and documents of `2d81c65`, `1341059`, `91caaf2`, `1e27fa0` and `d8e111a`, plus any uncommitted final pass | not contiguous; finish with the final commit `<FINAL_SHA>` (it may equal `d8e111a` if nothing else is committed) |
| M4 | documentation only: `68c016d` (ADR-0010), `c1b4854` (`docs/BROWSER_GATE.md`), `1917348` (`test:browser`) | no unique commits; see PR M4 |

Size (git diff, added lines): M0 3,139 in 23 files; `68c016d..bc6af53` 86,263 added in 213 files (38 `src` files, 142 test files, 6 docs; most added lines are tests and fixtures); `bc6af53..99cd600` 23,861 added in 92 files (37 `src`, 45 test, 5 docs); checkpoint 15 adds 7,277 lines in 36 files; `1341059` changes 17 files (+714, -61); `1e27fa0` changes 12 files (+1,807, -364); `d8e111a` changes 11 files (+494, -134). All figures re-read from `git diff --shortstat` on 2026-10-11.

## 2. How to cut and open the PRs (operator)

`origin` is `https://github.com/EMBLEM-NLP/chatgpt-conversation-reader` (`git remote -v`). When this work began that repository was **empty** (no commits, no branches; ADR-0001). The local clone now has a remote-tracking ref `origin/claude/chatgpt-conversation-reader-rraexo` equal to the local branch head, so that one branch was pushed; whether `main` exists, and what GitHub holds, was **not checked** (no network). A pull request needs an existing base branch.
If `main` does not exist yet, create it first, for example from an empty root commit (`git commit --allow-empty -m "chore: empty root"` on an orphan branch, then push it as `main`), or publish M0 as `main` and open M1 to M4 against it. The choice is the operator's.

```bash
# 0. Orientation (read-only)
git log --oneline claude/chatgpt-conversation-reader-rraexo | cat
git status --short                                   # anything listed here is NOT in a PR range; commit or stash it first

# 1. Stacked branches at the milestone heads (local only; `git branch` creates refs, it does not touch files)
git branch pr/m0 68c016d
git branch pr/m1 bc6af53
git branch pr/m2 1341059            # the first commit with consistent MCP code, schemas and tests (section 0); 99cd600 is red
git branch pr/m3 <FINAL_SHA>        # after the final commit exists
git push -u origin pr/m0 pr/m1 pr/m2 pr/m3

# 2. Extract each description from this file (markers <!-- PR-Mx-BEGIN --> ... <!-- PR-Mx-END -->)
for m in M0 M1 M2 M3 M4; do
  sed -n "/<!-- PR-$m-BEGIN -->/,/<!-- PR-$m-END -->/p" docs/PR_NOTES.md | sed '1d;$d' > "/tmp/pr-$m.md"
done

# 3. Open the PRs (stacked: each one targets the previous branch; retarget to main as the earlier ones merge)
gh pr create --base main  --head pr/m0 --title "M0: bootstrap, contracts and decision records"            --body-file /tmp/pr-M0.md
gh pr create --base pr/m0 --head pr/m1 --title "M1: official-export ingestion, SQLite/FTS5, branches"       --body-file /tmp/pr-M1.md
gh pr create --base pr/m1 --head pr/m2 --title "M2: SDK, CLI, MCP server, graph, local drafts"              --body-file /tmp/pr-M2.md
gh pr create --base pr/m2 --head pr/m3 --title "M3: CI, security tooling, documentation; M4: gated browser" --body-file /tmp/pr-M3.md
# M4 has no unique commits: paste /tmp/pr-M4.md as a comment on the M3 PR (or open it separately if you re-cut a docs-only branch)
```

The `sed` extraction was tested on this file (all five markers produce a non-empty description; re-run on 2026-10-11). `gh` itself was **not run** here. The workflow `.github/workflows/gcr-ci.yml` triggers on `pull_request` only for base branch `main` (and on `push` to `main` and manual dispatch): a stacked PR whose base is `pr/m0`, `pr/m1` or `pr/m2` **does not start CI** (read from the workflow file; never run on GitHub). If you would rather have one PR with green CI at the end, open `pr/m3` against `main` directly and paste all five descriptions into it; the history is a sequence of checkpoints, and the per-milestone heads `bc6af53` and `99cd600` are red (section 0).

---

<!-- PR-M0-BEGIN -->
## M0: bootstrap, contracts and decision records

### Summary

Clean-room scaffold for GCR (EMBLEM-NLP ChatGPT Conversation Reader & Writer): the user-supplied specification and rules, the architecture contract, decision records, the TypeScript project, and the first pure modules. **The v0.1.1 baseline named in the task was not available** (ADR-0001), so nothing here claims lineage or parity with it; the version is `0.2.0-dev.0`.

### What changed (commit `68c016d`, 23 files, +3,139)

* Supplied documents kept verbatim: `SPEC.md`, `AGENTS.md`, `CODEX_TASK.md`, `docs/REPO_RUNBOOK.md`; plus `CODEX_START_HERE.md` and the skill `.agents/skills/gcr-implementation/SKILL.md`.
* `docs/ARCHITECTURE.md` (layering, identity, SQLite schema v1 contract, domain rules), `docs/DECISIONS.md` (ADR-0001 to ADR-0011: clean-room, empty alias table, `node:sqlite`, no committed build output, snapshots and heads, no PR by the agent, CCR rules not applied, licensing, no guessed active branch, no browser code, accepted URL forms), `docs/EXECUTION_PLAN.md`.
* TypeScript project (strict, NodeNext, ES2023), `package.json` (`private`; `engines.node` is `>=22.13` at this commit and becomes `>=22.16.0` in `bc6af53`; **no `license` field yet**, `"license": "UNLICENSED"` is added by `1917348`; runtime dependencies `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.5 only), committed `package-lock.json`, `.gitignore` that keeps exports, databases and secrets out of Git.
* First code: `src/errors.ts` (28 error codes, exit codes), `src/logger.ts`, `src/version.ts`, `src/domain/types.ts` and `src/domain/results.ts` (shared types), test helpers (`records`, `tmp`, `zip-builder`).

### Evidence

Measured on `git archive 68c016d` extracted to a scratch folder, Node 22.22.0, 2026-10-11.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 (emits `dist/domain`, `errors`, `logger`, `version`) |
| `npm test` | **no tests exist yet** (`test/` holds helpers only); not run |
| `node scripts/ci-smoke.mjs` | the script does not exist at this commit; not run |

EXECUTION_PLAN gate for M0 ("typecheck green on the skeleton; research notes committed; parity matrix classifies every FR/NFR"): the typecheck part is met. The research notes were written outside Git (sandbox scratch) and **`docs/PARITY_MATRIX.md` is not part of this commit**; that part of the gate is **not met by `68c016d`** (see the current tree for its status).

### Risks

* Decisions ADR-0001 (no baseline) and ADR-0006 (no PR by the agent) need operator confirmation; if the real v0.1.1 tree turns up it must be reconciled by a reviewed PR (no shared history, expect conflicts).
* The Node minimum stated in the runbook (22.13) is wrong for FTS5; corrected later by ADR-0012 (M1).
* No license: ADR-0008 leaves the choice to the owner.

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

Reads an official ChatGPT export (ZIP, folder, `conversations*.json`, shards, nested ZIP one level, stdin) into a local SQLite v1 database with full-text search, immutable snapshots, branch analysis, renderers, statistics and audit. Also contains, inside the same checkpoint commits, the first versions of the entity, graph and draft modules and the SDK facade that M2 builds on.
**Synthetic fixtures only; a real export was never used.** Adds the Node 22.16.0 minimum (ADR-0012).

### What changed (range `68c016d..bc6af53`, 12 commits, one of which, `1917348`, is M3 tooling)

* `src/domain` (branch analysis, cycle safe, branch id = leaf id, active branch only from a valid `current_node`; URL/UUID parsing), `src/ingest` (first-party ZIP reader and streaming JSON splitter with explicit limits, ChatGPT / Claude / disabled OpenAI-API adapters, import runner, manual copy, layout detection),
  `src/db` (schema v1, migrations, FTS5 search with NFKC and per-character CJK, repository), `src/format` (markdown, compact, json, jsonl), `src/analysis` (stats, audit).
* Also here (M2 scope): `src/entities`, `src/graph`, `src/drafts`, `src/sdk` (started), `src/index.ts`.
* `src/devtools` and `scripts/` (privacy scanner, license inventory); `fixtures/chatgpt` (13 synthetic files) and `fixtures/claude` (8); `docs/ADAPTERS.md`, `docs/IMPORT_FORMAT.md`, `docs/IMPORT_GUIDE.md`, `docs/BROWSER_GATE.md`.
* `bc6af53`: `engines.node` becomes `>=22.16.0`; `openDatabase` probes FTS5 before touching a file and fails with `DB_ERROR` / `FTS5_UNAVAILABLE`; ADR-0012.

### Evidence

Measured on `git archive bc6af53`, scratch folder, 2026-10-11, `node --test --test-concurrency=2` over `tsc --outDir dist-test` output.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Compiled suite, Node 22.22.0 | **5,807 tests, 5,803 pass, 1 fail, 3 skipped**, 115 s (first measurement; the fact-check re-run on 2026-10-11 gave the same counts in 173 s on a busier machine). The failure: `test/sdk/errors.test.ts` "a connection that was closed behind the facade's back" (expected `DB_ERROR`, got `IMPORT_INPUT_NOT_FOUND`: the test passed a nonexistent import path). A test-only edit in `8cfb1b2` fixes it. The 3 skips: two "running as root" permission tests and the privacy self-test ("not running inside a git checkout", an artefact of `git archive`). |
| Compiled suite, Node 22.16.0 | **5,807 tests, 5,803 pass, 1 fail, 3 skipped**, 237 s (first measurement; the fact-check re-run gave the same counts in 183 s); the same failing test as on 22.22.0 (the declared minimum therefore shows the same result at this commit) |
| FTS5 probe | Node 22.13.1: `gcr doctor` says "TOO OLD" and "FTS5 NOT available" (verified on the current tree with the real binary); ADR-0012 records the earlier runs on 22.13.1 to 22.21.1 |
| `node scripts/ci-smoke.mjs` | script not present at this commit; not run |

ADR-0012 quotes "5,771 tests, 5,770 pass, 0 fail, 1 skipped" on 22.16.0 from an earlier moment; the committed tree at `bc6af53` has more tests (11 `test/sdk` files arrive in this very commit) and one failure, so the ADR figure does not describe this commit.

### Risks

* The ChatGPT export format is documented only by community reports; every expectation is **synthetic-only**. A real export may break assumptions (`children` presence, shard naming, nested archives, asset names, timestamp forms).
* `bc6af53` is red (one test); `32b9c7b` documents a type error in its own message, so intermediate commits do not all build.
* Memory and time on very large inputs are bounded by explicit limits but were measured only on synthetic scale tests (50,000 messages).
* `node:sqlite` is experimental in Node 22; GCR hides exactly one `ExperimentalWarning`.

### Migration note

None. Schema v1 is created fresh in the user's own file (`PRAGMA user_version = 1`); `applyMigrations` refuses newer files (`DB_SCHEMA_TOO_NEW`).

### Rollback note

`git revert --no-commit 68c016d..bc6af53 && git commit` (or delete the branch before merge). Local databases created by this code: delete the `.sqlite`, `-wal`, `-shm` files; imports never modify the source export.

### Checklist (mirrors AGENTS.md)

- [x] Requirement ids (FR-01 to FR-11, FR-15, FR-16) referenced; layering per `docs/ARCHITECTURE.md`
- [x] Unknown stays unknown: no inferred model, active branch, timestamp or completeness (tests in `test/domain`, `test/ingest`, `test/analysis`)
- [x] No network, cookie, browser or private-endpoint code (`test/security/no-network.test.ts`, a tripwire, not a proof)
- [x] Local data separate from imported originals; imported rows immutable (triggers)
- [x] Imported text treated as data; logs and reports content-free
- [x] Synthetic fixtures only; each carries the marker `GCR-SYNTHETIC-FIXTURE`
- [x] Plan row for M1 in `docs/EXECUTION_PLAN.md`
- [ ] All tests green at the milestone head: **no (1 failure at `bc6af53`)**
- [ ] `node scripts/ci-smoke.mjs`: **not run (script absent at this commit)**
- [ ] Validated on Codex's own runner: **not done**
<!-- PR-M1-END -->

---

<!-- PR-M2-BEGIN -->
## M2: SDK facade, CLI, local MCP server, graph, local drafts and annotations

### Summary

Adds the stable TypeScript SDK (`Gcr`), the `gcr` CLI (31 help pages), the local stdio MCP server (12 tools, read-only by default, approved import roots), the knowledge graph with an offline HTML export, and local drafts and annotations with an audit log.
Nothing can send to ChatGPT; a draft has no "sent" state.

### What changed (range `bc6af53..1341059`, 10 commits; `148845b` is the M3 CI definition, `2d81c65` and `1341059` also carry M3 scripts and documents; the entity, graph and draft modules came earlier)

* `src/sdk/*` (facade, resolver, error normalisation), `docs/SDK.md`.
* `src/cli/*` (commands, option parser, routing, output, signal and EPIPE handling), `src/suppress-warnings.ts`, `docs/CLI_REFERENCE.md`, `docs/CLI_HELP.txt` (`scripts/capture-cli-help.mjs`).
* `src/mcp/*` (tool table, envelope with size cap, approved roots, stdout guard, alias mechanism with an empty table per ADR-0002), `docs/MCP_TOOLS.md`, `docs/mcp-tool-schemas.json` (`scripts/dump-mcp-schemas.mjs`).
* Fixes: `3721e54` (a database with a newer schema version is refused before any write), `99cd600` (accurate `GRAPH_EMPTY` warning).
* `1341059`: `gcr_update_local_annotation` is annotated `destructiveHint: true` (the update overwrites the previous text); schemas regenerated; reviewers' fixes for MCP error results that bypassed the size cap and for unbounded serialization before the cap check (as stated in the commit message).
* Checkpoint 15 (`2d81c65`, unreviewed by its own message): reworked MCP result-size handling (`src/mcp/envelope.ts`, `registry.ts`, `tools.ts`), CLI error handling (a failing write to stdout is reported as `INTERNAL_ERROR` with a reason; safer file creation for `graph export`; `src/cli/context.ts`, `route.ts`, `run.ts`), and new adversarial tests under `test/cli` and `test/mcp`.
* Test additions: `test/cli`, `test/mcp` (real SDK client over an in-memory transport and over stdio child processes), `test/sdk`.

### Evidence

`99cd600` was measured on `git archive 99cd600` in a scratch folder (Node 22.22.0, 2026-10-11); `1341059` on the repository itself, whose working tree was clean apart from documentation files.

| Command | Result |
|---|---|
| At `99cd600`: `npm run typecheck`, `npm run build` | exit 0, exit 0 |
| At `99cd600`: compiled suite | **6,565 tests, 6,561 pass, 1 fail, 3 skipped**, 379 s (the fact-check re-run on 2026-10-11 gave the same counts in 386 s). The failure is a **killed test file**: `test/mcp/limits.adversarial.test.ts` ends with `signal: 'SIGKILL'` after 36 to 53 s; its other six sub-tests passed. Re-running that single file gave the same result (36 s; 28 s in the fact-check re-run, 6 of 7 sub-tests passed). Cause **NOT VERIFIED** (memory pressure from a test case, or a defect that the then-uncommitted MCP edits address). |
| At `1341059` (proposed M2 head) | **6,750 tests, 6,748 pass, 0 fail, 2 skipped**. First author: Node 22.22.0 in 343 s and Node 22.16.0 in 453 s (about 13:15 UTC, working tree clean apart from documentation files). Fact-check re-run on 2026-10-11, 14:01 to 14:18 UTC, compiled from a working tree whose `src/` and `test/` equal `1341059`: Node 22.22.0 in 390 s, Node 22.16.0 in 575 s, the same counts (905 suites); the test file `test/scripts/no-network-guard.adversarial.test.ts` of the later commit `1e27fa0` did not exist at compile time and is not counted. Both skips are the root-permission tests |
| Working tree (HEAD + edits) at 12:24 UTC, before checkpoint 15 (first author's run; that tree no longer exists, so it was not reproduced) | 6,568 tests, 6,566 pass, 0 fail, 2 skipped, 262 s (the 2 skips are the root-permission tests) |
| `node dist/cli/main.js doctor` | `Status: OK`, modes A to E as in the README table |
| `gcr` by hand (import in six layouts, get by UUID and link, branches, thread, search, stats, audit, graph, drafts, annotations, 21 distinct error codes) | outputs in `docs/USER_GUIDE.md`; a battery of 37 commands was recorded four times and compared (section 6) |
| MCP by hand (SDK client over stdio) | 12 tools listed; read tools returned results; default mode answers `WRITE_FORBIDDEN` / `IMPORT_PATH_NOT_ALLOWED`; with `--allow-local-writes` and an approved root: import inside the root accepted, outside refused, draft and annotation created, stale version `ANNOTATION_CONFLICT` |
| `node scripts/dump-mcp-schemas.mjs --check`, `node scripts/capture-cli-help.mjs --check` | both "up to date" |
| `node scripts/ci-smoke.mjs` | Version of `91caaf2`: `SMOKE OK (41 checks)`, 12.1 s on Node 22.22.0 (re-run 2026-10-11 against the current `dist/`; the first author measured 9.6 s on 22.22.0 and 10.4 s on 22.16.0). Version of `1e27fa0`: 51 checks, `SMOKE OK (51 checks)` on Node 22.22.0 (1 run, 22.9 s). Working-tree version after it (modified 14:13 UTC): `SMOKE OK (51 checks)` on Node 22.16.0 (1 run, 22.7 s); on Node 22.22.0 **8 of 10 runs passed and 2 failed** (`SMOKE FAILED (1 of 51 checks failed)` and `(2 of 51 ...)`: the check `cli read: search (json, ...)` ended with exit 1 and no error code, and the check that no absolute repository path appears in any output); cause **NOT diagnosed**, machine load average 11 to 13. The smoke script's own tests (`test/scripts/ci-smoke.*.test`) are part of the suite counts |

### Risks

* MCP result-size handling was reworked late (checkpoint 15 and `1341059`) and was reviewed only by the MCP reviewers; open the PR at `1341059`, not at `99cd600`, whose committed tests do not all run to completion.
* VS Code, Claude Desktop and Codex were **never used** against the server; configuration snippets are unverified. Windows is untested.
* CLI remedy texts occasionally use SDK vocabulary (`maxElementBytes`, `getAnnotation`). The nested-ZIP limit has no CLI flag. `FEATURE_GATED` and `REMOTE_ACCESS_FORBIDDEN` are never emitted.
* `gcr_update_local_annotation` overwrites the previous text (only a hash is audited).

### Migration note

None (schema v1; no new migration in this range). `3721e54` only makes opening a newer-schema file safer: verified (again on 2026-10-11), a copy with `PRAGMA user_version = 99` keeps the SHA-256 of its main file after `list` and `import` are refused; SQLite still creates `-wal` and `-shm` files beside it.

### Rollback note

`git revert --no-commit bc6af53..1341059 && git commit`. MCP clients that were pointed at `dist/mcp/entry.js` simply stop finding it. Local drafts and annotations live in the user's database (`local_drafts`, `local_annotations`, `local_audit_log`); deleting the database file removes them.

### Checklist (mirrors AGENTS.md)

- [x] Local writes (draft, annotation) separate from any remote send; default is read-only for MCP; no automatic or browser sends
- [x] Hard boundary respected; the consumer URL is a lookup key; `NOT_IN_LOCAL_EXPORT` with the export remedy otherwise
- [x] Imported text is untrusted data: results carry `untrustedContent`; tool metadata is static (test: `test/mcp/security.injection.test.ts`)
- [x] No secrets, raw exports or real screenshots committed; synthetic ids only
- [x] `docs/EXECUTION_PLAN.md` row for M2 exists
- [x] All tests green at the proposed head `1341059`: 6,748 of 6,750 pass, 2 skips (root-permission tests); `99cd600` is red
- [x] `node scripts/ci-smoke.mjs`: `SMOKE OK (41 checks)` (run on the later commit `91caaf2`; the script first appeared in `2d81c65`)
- [ ] Real MCP clients (VS Code, Codex, Claude Desktop): **not tested**
- [ ] Validated on Codex's own runner: **not done**
<!-- PR-M2-END -->

---

<!-- PR-M3-BEGIN -->
## M3: packaging, CI definition, security tooling, documentation

### Summary

Makes the project reproducible and reviewable: committed lockfile and `npm ci`, a read-only SHA-pinned GitHub Actions workflow and a devcontainer (**never executed on GitHub**), a privacy scanner, a dependency license inventory, a smoke test of the built CLI and MCP server with a network guard, captured CLI help and MCP schemas, and the user-facing documentation with explicit tested/untested wording.

### What changed

* Already committed: `1917348` (npm scripts `smoke`, `privacy-scan`, `privacy-scan:history`, `licenses`, `test:browser`, `capture:cli-help`, `dump:mcp-schemas`, `perf` and `--test-concurrency=2` for `test`; the `"license": "UNLICENSED"` and `files` fields of `package.json`; `scripts/test-browser-gated.mjs`; the `coverage-summary` script came later, with `scripts/coverage-summary.mjs`), `148845b` (`.github/workflows/gcr-ci.yml`, `.devcontainer/devcontainer.json`), and from earlier checkpoints `src/devtools/*`, `scripts/privacy-scan.mjs`, `scripts/licenses.mjs`, `scripts/dump-mcp-schemas.mjs`, `scripts/capture-cli-help.mjs`.
* Committed as early drafts in checkpoint 15 (`2d81c65`; later versions in `1341059`): `README.md`, `CHANGELOG.md`, `docs/USER_GUIDE.md`, `docs/PR_NOTES.md`, `docs/SECURITY_AND_BOUNDARIES.md`, `scripts/ci-smoke.mjs`, `scripts/no-network-guard.cjs`, `scripts/perf-baseline.mjs`, `scripts/coverage-summary.mjs` and their tests (`test/scripts`). Not committed when this was written (becomes `<FINAL_SHA>`): the final edits of those files and any document that did not exist yet.
* Workflow facts: `permissions: contents: read`; `pull_request` (not `pull_request_target`); actions pinned to commit SHAs; matrix Node `22.16.0` and `22.x` (Node 24 deliberately absent); steps: `npm ci`, `npm audit --omit=dev --audit-level=high`, typecheck, build, test, smoke, privacy scan with history, license summary, `test:browser`.

### Evidence

Working tree of 2026-10-11, Linux, running as root.

| Command | Result |
|---|---|
| Compiled suite, Node 22.22.0 / 22.16.0 | **6,750 tests, 6,748 pass, 0 fail, 2 skipped** on each (390 s / 575 s in the fact-check re-run of 2026-10-11 14:01 to 14:18 UTC; 343 s / 453 s in the first author's run). `src/` and `test/` equal `1341059`; the later commits `91caaf2` and `1e27fa0` change documents and scripts, and add one test file (`test/scripts/no-network-guard.adversarial.test.ts`) that is **not** in these counts and whose message says it was not run |
| `npm run typecheck`, `npm run build` | exit 0, exit 0 |
| `node scripts/privacy-scan.mjs --root .` | `privacy-scan: clean; 340 file(s) scanned, skipped 0 large / 0 binary / 0 non-regular, 0 allow-listed`, exit 0 (working tree, 14:40 UTC; 339 files at 14:05 UTC; the first author saw 338 files before `docs/WARNING_CODES.md` and other files were added). **With `--history` (the CI step `privacy-scan:history`) the exit is 1** (re-run 14:05 and 14:40 UTC: `1 finding(s) ... history: 26 commit(s)` at the later time): one finding in old commit `c8533e4` (`test/drafts/drafts.test.ts:255`, a chatgpt.com URL with an invented id that does not match the strict synthetic pattern; the line was changed to a `00000000-...` id in `f164efd`) |
| `npm audit --omit=dev --audit-level=high` | "found 0 vulnerabilities", exit 0 in the first author's run (it contacts the npm registry); **not re-run** by the fact-check (no network allowed) |
| `node scripts/licenses.mjs` | 98 packages, 0 unknown, 0 non-permissive, release gate PASS |
| `node scripts/ci-smoke.mjs` | Version of `91caaf2`: `SMOKE OK (41 checks)`, 12.1 s on Node 22.22.0 (re-run 2026-10-11 against the current `dist/`; the first author measured 9.6 s on 22.22.0 and 10.4 s on 22.16.0). Version of `1e27fa0` and the working tree after it: 51 checks; `SMOKE OK (51 checks)` on Node 22.16.0 (1 run, 22.7 s); on Node 22.22.0 **8 of 10 runs passed and 2 failed** (`SMOKE FAILED (1 of 51 checks failed)` and `(2 of 51 ...)`: the check `cli read: search (json, ...)` ended with exit 1 and no error code, and the check that no absolute repository path appears in any output); cause **NOT diagnosed**, machine load average 11 to 13. The smoke script's own tests (`test/scripts/ci-smoke.*.test`) are part of the suite counts |
| `node scripts/test-browser-gated.mjs` | `NOT_RUN: no browser code exists in this build ...`, exit 0 |
| The GitHub Actions workflow | **never run on GitHub**; each step except `npm ci` was run locally by the commands above, and the `npm audit` result is the first author's only |

### Risks

* **The CI step `npm run privacy-scan:history` fails on the current history**: `node scripts/privacy-scan.mjs --root . --history` exits 1 with one finding in commit `c8533e4` (`test/drafts/drafts.test.ts:255`, an invented `F00DFEED-...` id in a chatgpt.com URL). The working-tree scan is clean. Resolve it (allow-list the path, which also covers history, or rewrite history) before relying on CI.
* The workflow is untested on GitHub: action SHAs were resolved on 2026-10-10 and not re-checked; runner image and `setup-node` behaviour are unknown, and the history privacy step is already known to fail (above).
* The privacy scanner is a tripwire with documented limits (secrets without a distinctive shape are not found). The no-network test is a tripwire too; the MCP SDK dependency tree contains HTTP packages that GCR never imports.
* The privacy history scan (`--history`) rewrites nothing but reads all refs; it is bounded (64 MiB) and says when it truncated.
* Documentation states what is untested; reviewers should check that no sentence says more than the evidence.

### Migration note

None.

### Rollback note

`git revert` the range, or remove the workflow file; scripts have no side effects outside the working tree (the smoke test uses a temp directory removed in `finally`; `licenses` and `privacy-scan` are read-only).

### Checklist (mirrors AGENTS.md)

- [x] Required local gates exist: `npm test`, `node scripts/ci-smoke.mjs`, `npm run typecheck`, `npm run build`, `npm run test:browser` (reports `NOT_RUN`)
- [x] Read-only token, pinned actions, no secrets, no ChatGPT login in CI; synthetic fixtures only
- [x] Evidence recorded with exact commands, counts, Node versions and dates
- [x] No claim of live integration from synthetic fixtures; OpenAI policy review stated as **NOT PERFORMED**
- [ ] CI job executed on GitHub: **no**
- [ ] `docs/SECURITY_AND_BOUNDARIES.md` consulted for auth/network/browser changes: the file exists since checkpoint 15, but the author of this description only skimmed its opening sections; a reviewer should read it
- [ ] The acceptance record (ACCEPTANCE.md under docs/) updated with command, exit code and date for each gate: depends on that file existing in the final tree; it was not present at 13:35 UTC
- [ ] Validated on Codex's own runner: **not done**
<!-- PR-M3-END -->

---

<!-- PR-M4-BEGIN -->
## M4: browser UI capability (gated): documentation only

### Summary

Mode E (browser interaction, FR-17) is **gated and ships no code** (ADR-0010). The deliverables are the gate document, the human checklist, the stop conditions, and a script that reports `NOT_RUN`. The v0.1.1 extension and live bridge were not available (ADR-0001), so there was nothing to disable.
This milestone has **no unique commits**: its content is in `68c016d` (ADR-0010), `c1b4854` (`docs/BROWSER_GATE.md`) and `1917348` (`scripts/test-browser-gated.mjs`, `npm run test:browser`). Paste this description into the M3 PR, or into a docs-only PR if you re-cut the history.

### What changed

* `docs/BROWSER_GATE.md`: why the feature is gated (consumer URL is not an API resource; OpenAI terms **not verified**: every `*.openai.com` host was unreachable from the sandbox), what is allowed today (user logs in personally, official export, manual copy, local draft, manual paste), what GCR will not do, a 14-item human gate procedure (agents must not tick it), supported alternatives.
* `test/security/no-network.test.ts`: fails if any file under `src/` imports a network, browser-automation or process module (devtools may use `child_process` for git only).
* `npm run test:browser` prints `NOT_RUN` (exit 0).

### Evidence

| Command | Result |
|---|---|
| `node scripts/test-browser-gated.mjs` | `NOT_RUN: no browser code exists in this build (FR-17 is GATED; see docs/BROWSER_GATE.md). This is not a pass; it means the capability is not implemented.` exit 0 |
| `test/security/no-network.test.ts` | part of the compiled suite (see M3 for counts); a source tripwire, with limits stated in the test header |
| `gcr doctor` | Mode E: `gated - no code (docs/BROWSER_GATE.md)`; Mode D: `not implemented (interface + disabled adapter only)` |

EXECUTION_PLAN gate ("`docs/BROWSER_GATE.md` present; no network/browser code (test)"): met. FR-17 itself ("written ToU/permissions approval + separate manual test") is **not met and cannot be met by an agent**: it stays `GATED`.

### Risks

* A reader may mistake "gated" for "coming soon". It is not scheduled. Any future proposal needs the human checklist and a reviewed ADR first.
* The OpenAI policy review is **NOT PERFORMED**: no clause is quoted or paraphrased as fact anywhere in this repository.

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

## 6. Re-verification at the end of the session (first author)

Everything in this section was re-run by the first author at the end of the session (2026-10-11, about 12:38 to 13:35 UTC, Linux, running as root, Node 22.22.0 unless stated) because other agents were still changing the CLI and MCP modules while the documents were written.

| Check | How | Result |
|---|---|---|
| Quoted CLI outputs still match the CLI | a battery of 37 documented commands (import, re-import, list, get by UUID and link, `NOT_IN_LOCAL_EXPORT`, share link, bad UUID, branches, thread, search plain, prefix, raw and errors, stats, audit, draft, graph build, god-nodes, path, explain, export, import errors, `import-copy`, CJK and accent search) was recorded in four rounds (12:38, 12:43, 12:54 and 13:32 UTC) and diffed after masking timestamps, durations, cursors and random ids | **identical in every round**, although `src/cli` changed in checkpoint 15 and the build was redone before the last round |
| Other demos | layouts (sharded ZIP, folder, nested ZIP, stdin), snapshots and head rule, account labels, branch policies | repeated at about 12:55 UTC, same results |
| MCP | the SDK-client probes (12 tools; `WRITE_FORBIDDEN`, `IMPORT_PATH_NOT_ALLOWED`, `NOT_IN_LOCAL_EXPORT`; writes-enabled flow with an approved root) | repeated at about 12:55 UTC, same results |
| Generated documents | `node scripts/dump-mcp-schemas.mjs --check`; `node scripts/capture-cli-help.mjs --check` | both "up to date" (31 help pages) |
| Cross-references | every relative link and every backticked repository path in `README.md`, `CHANGELOG.md`, `docs/USER_GUIDE.md` and this file was checked against the file system | 0 problems |
| Privacy | `node scripts/privacy-scan.mjs --root .` | clean (338 files); history scan: 1 finding, see M3 |
| Old Node | `gcr doctor` and `gcr import` under a real Node 22.13.1 binary, again on the current build (13:33 UTC) | same `FTS5_UNAVAILABLE` answer, exit 5, no database file created |
| Measured only once | the per-milestone archives (`68c016d`, `bc6af53`, `99cd600`; the suites at `bc6af53` also on Node 22.16.0) | not repeated; the commits cannot change |

Raw logs of these runs were kept in the author's scratch folder, not in the repository (they contain test output and temporary paths).

## 7. Independent fact-check (second pass)

Done on 2026-10-11 between about 14:00 and 14:45 UTC by a second reader who assumed the documents overclaim, Linux, running as `root`, no network, Node 22.22.0 unless stated. Corrections it made are in the documents themselves; this table says what it re-ran.

| Check | How | Result |
|---|---|---|
| Quick-start and user-guide commands | re-ran the import of the four-fixture ZIP, `list`, `get` by UUID and by link, `branches`, `search`, `stats`, `audit`, `draft`, `graph build/god-nodes/path/explain/export`, `NOT_IN_LOCAL_EXPORT`; also five import layouts, re-import, two snapshots, account labels, branch policies, 21 distinct CLI error codes (and the two MCP-only ones, `WRITE_FORBIDDEN` and `IMPORT_PATH_NOT_ALLOWED`), manual copy, Cyrillic/Greek/CJK search | output matched the quoted shapes and numbers (batch id, 43 rows, 74 edges, 19 entities) |
| MCP | the SDK client over stdio against `dist/mcp/entry.js`: default mode and `--allow-local-writes` with an approved root; a raw JSON-RPC pipe through `gcr mcp` | 12 tools; `WRITE_FORBIDDEN`, `IMPORT_PATH_NOT_ALLOWED`, `NOT_IN_LOCAL_EXPORT`, `ANNOTATION_CONFLICT` as documented; stderr empty |
| Test suites | see M2 and M3 evidence | 6,750 / 6,748 / 0 / 2 on Node 22.22.0 and 22.16.0 |
| Milestone heads | `git archive` of `68c016d`, `bc6af53`, `99cd600` | M0: typecheck and build exit 0, no test files; `bc6af53`: 5,807 tests, 1 fail (Node 22.22.0); `99cd600`: 6,565 tests, 1 fail (`SIGKILL` of `test/mcp/limits.adversarial.test.js`) |
| Privacy scan | `--root .` and `--root . --history` | clean (340 files at 14:40 UTC) and 1 finding in `c8533e4` (exit 1) |
| Links | a script checked every relative Markdown link, every `#anchor` and every backticked repository path in the four user-facing documents | 0 broken; the only unresolved backticked names are example file names (`conversations.json`, `user.json`, ...) and the missing `ACCEPTANCE.md`, which the documents say does not exist |
| Not re-run | `npm audit` (network), `npm ci` (network), anything on GitHub, the three MCP client products, a browser on the graph page, permission-denied paths (root) | **NOT VERIFIED** by this pass |
