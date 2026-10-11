# GCR - ChatGPT Conversation Reader & Writer

**EMBLEM-NLP GCR** is a local, offline command-line tool, TypeScript SDK and local MCP server for reading, searching and
annotating **your own ChatGPT export data**. You download the official export yourself, GCR indexes it into a SQLite file on
your machine, and you search it, rebuild its branches, look at statistics and a knowledge graph, and keep local drafts and notes.

Version `0.2.0-dev.0` (pre-release, `private`, not published). Date of the runs quoted below: 2026-10-11.

> **Read this first.** GCR has only ever been run on **synthetic, invented data** (`fixtures/chatgpt/`). It has **never** been run
> on a real ChatGPT export, because none was available. OpenAI publishes no schema for the export, so every statement about what
> is inside `conversations.json` comes from third-party reports. If a real export does not import cleanly, that is an expected
> finding, not a surprise. See [Tested vs NOT tested](#tested-vs-not-tested).

## What GCR is, and what it is not

| GCR is | GCR is not |
|---|---|
| An importer for an official ChatGPT export ZIP, an extracted folder, `conversations*.json`, or JSON on standard input | A way to read a conversation from a `chatgpt.com/c/<uuid>` link. The link is only a lookup key into data you already imported; if it is not there you get `NOT_IN_LOCAL_EXPORT` |
| A local SQLite index with full-text search (FTS5), branch reconstruction, statistics, audit and a knowledge graph | A live sync, a backup service or a guarantee that the export is complete |
| A CLI (`gcr`), a TypeScript SDK and a stdio MCP server over the same code | A ChatGPT client: it never sends, posts, deletes or edits anything on chatgpt.com |
| A place for local drafts and notes (Mode C), clearly separated from the imported originals | A browser extension, scraper or automation. There is no network code, no cookie handling and no browser code in this repository |
| Honest about gaps: every result carries its provenance and completeness, and unknown stays unknown (no guessed model, no guessed active branch) | An OpenAI product, legal advice or a statement about OpenAI's terms. The platform policy review was **NOT PERFORMED** (see below) |

## Requirements

* **Node.js >= 22.16.0** (`engines` in `package.json`). Reason (ADR-0012 in [docs/DECISIONS.md](docs/DECISIONS.md)): GCR needs SQLite
  FTS5 from the built-in `node:sqlite`, and Node 22.13 to 22.15 ship SQLite without FTS5. On 22.13.1 the tool refuses to open a
  database and says why (real output in [the user guide, section j](docs/USER_GUIDE.md#fts5_unavailable-on-old-node)).
  Node 24 and newer were **not tested** (no such binary was available).
* No network access is needed to run GCR, and no ChatGPT login. Installing the dependencies (`npm ci`) needs the npm registry once.
* Runtime dependencies: `@modelcontextprotocol/sdk` and `zod` only. Everything else (ZIP reader, streaming JSON parser, SQLite) is first-party code or built into Node.
* Developed and run on Linux. Windows and macOS were **not tested**.

## Install and build

```bash
git clone https://github.com/EMBLEM-NLP/chatgpt-conversation-reader   # or use your existing checkout
cd chatgpt-conversation-reader
npm ci            # reproducible install from the committed package-lock.json
npm run build     # compiles src/ to dist/ (about 2 s here)
node dist/cli/main.js --help
```

* The executable is `dist/cli/main.js`; `package.json` declares it as the binary **`gcr`**. The package is `private` and not
  published, so run it as `node dist/cli/main.js ...` (or add `alias gcr='node /ABSOLUTE/PATH/dist/cli/main.js'`).
  The examples below write `gcr` for that command.
* `npm ci` was **not run** while this README was written (no network permitted); `node_modules` was already present. The clone
  URL above is the repository named in `docs/REPO_RUNBOOK.md`; its availability was not checked. **NOT VERIFIED.**
* `npm run build` and `node dist/cli/main.js --help` were run on 2026-10-11 with Node 22.22.0.

## Two-minute quick start (synthetic data)

Every command below was run on 2026-10-11 with Node 22.22.0 against the committed synthetic fixtures; the output is abridged
(`--format compact` keeps it short; the default is Markdown). All ids are synthetic (`00000000-0000-4000-8000-<12 hex>`).

```bash
export GCR_REPO=/ABSOLUTE/PATH/TO/chatgpt-conversation-reader
gcr() { node "$GCR_REPO/dist/cli/main.js" "$@"; }          # bash/zsh function; skip if you aliased it
mkdir -p /tmp/gcr-demo && cd /tmp/gcr-demo                  # any folder OUTSIDE the repository

# 1. Build a synthetic export ZIP from four committed fixtures (the importer looks for conversations.json inside the ZIP)
node -e "
const fs = require('fs');
const dir = process.env.GCR_REPO + '/fixtures/chatgpt/';
const names = ['minimal-linear', 'branching', 'trimmed-2026', 'content-types'];
const all = names.flatMap((n) => JSON.parse(fs.readFileSync(dir + n + '.json', 'utf8')));
fs.writeFileSync('conversations.json', JSON.stringify(all));
"
python3 -m zipfile -c synthetic-export.zip conversations.json     # or: zip synthetic-export.zip conversations.json
```

```bash
# 2. Import (idempotent: running it twice changes nothing) and list
gcr import synthetic-export.zip --db ./demo.sqlite --format compact
gcr list --db ./demo.sqlite --format compact
```

```text
# result | chatgpt | exported_tree | object
# source: provenance=official_chatgpt_export | account=default | batch=b_53f8bfa98c5dbcb85ed3cd786abc3a97 | ...
  batchId: b_53f8bfa98c5dbcb85ed3cd786abc3a97
  provider: chatgpt
  sourceKind: zip
  sourceLabel: synthetic-export.zip
  alreadyImported: false
# conversations | chatgpt | exported_tree | offset=0 limit=50 total=4 next=none
[chatgpt] 00000000-0000-4000-8000-000000000004 | GCR-SYNTHETIC-FIXTURE F04 one message per content type | ... | 23 msgs | exported_tree
[chatgpt] 00000000-0000-4000-8000-000000000002 | GCR-SYNTHETIC-FIXTURE F02 branching: regenerated reply and edited user turn | ... | 7 msgs | exported_tree
[chatgpt] 00000000-0000-4000-8000-000000000003 | GCR-SYNTHETIC-FIXTURE F03 trimmed 2026-style export (...) | ... | 7 msgs | exported_tree
[chatgpt] 00000000-0000-4000-8000-000000000001 | GCR-SYNTHETIC-FIXTURE F01 minimal linear conversation | ... | 2 msgs | exported_tree
```

```bash
# 3. Read one conversation, by UUID or by link (the link is NOT opened: it is looked up in your database)
gcr get https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 --db ./demo.sqlite --format compact
gcr branches 00000000-0000-4000-8000-000000000002 --db ./demo.sqlite --format compact
gcr search "synthetic assistant" --limit 2 --db ./demo.sqlite --format compact
```

```text
# GCR-SYNTHETIC-FIXTURE F01 minimal linear conversation | chatgpt | exported_tree | 00000000-0000-4000-8000-000000000011
# source: provenance=official_chatgpt_export | account=default | batch=b_53f8... | selection=source_current_node | ...
[user] synthetic user turn 1
[assistant] synthetic assistant answer 1

[branch 1] 00000000-0000-4000-8000-000000000013 | root client-created-root | fork - | 4/4 msgs | active
[branch 2] 00000000-0000-4000-8000-000000000014 | root client-created-root | fork 00000000-0000-4000-8000-000000000010 | 2/2 msgs | inactive
[branch 3] 00000000-0000-4000-8000-000000000016 | root client-created-root | fork client-created-root | 2/2 msgs | inactive

[assistant] 00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000011 GCR-SYNTHETIC-FIXTURE F01 ... | [[synthetic]] [[assistant]] answer 1
[assistant] 00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000011 GCR-SYNTHETIC-FIXTURE F02 ... | [[synthetic]] [[assistant]] answer 1 (active branch)
```

```bash
# 4. Statistics and audit (models are counted only where the export states one)
gcr stats --group-by model --db ./demo.sqlite --format compact
gcr audit --missing-model --untitled --empty --db ./demo.sqlite --format compact
```

```text
  rows[0].label: unknown (not supplied by source)
  rows[0].messages: 20
  rows[1].label: synthetic-model-1
  rows[1].messages: 10
  ...
  findings[0].check: missing_model
  findings[0].description: 3 of 15 visible assistant messages (20.0%) carry no explicit model_slug from the source. GCR never infers a model ...
```

```bash
# 5. A local draft (never sent) and the knowledge graph
printf 'Synthetic draft text.\n' > reply.md
gcr draft create --conversation 00000000-0000-4000-8000-000000000001 --input reply.md --db ./demo.sqlite --format compact
gcr graph build --db ./demo.sqlite --format compact
gcr graph god-nodes --limit 3 --db ./demo.sqlite --format compact
gcr graph export --out graph.html --db ./demo.sqlite          # self-contained offline HTML page, file mode 0600
```

```text
# draft created | local only | id=00000000-0000-4000-8000-0000000000d1        (the real id is a random UUID and differs per run)
conversation: 00000000-0000-4000-8000-000000000001 | provider=chatgpt account=default | status=draft namespace=default
link: https://chatgpt.com/c/00000000-0000-4000-8000-000000000001
GCR never sends messages; open this link yourself and paste the draft
  edges: 74
  entities: 19
  [0].node.label: synthetic
```

```bash
# 6. A link that is NOT in your export: GCR refuses to guess and tells you what to do
gcr get https://chatgpt.com/c/00000000-0000-4000-8000-0000000000ff --db ./demo.sqlite; echo "exit code: $?"
```

```text
error[NOT_IN_LOCAL_EXPORT]: The conversation is not present in the locally imported data.
  remedy: This conversation is not in the data you imported. GCR cannot fetch chatgpt.com conversations. Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>
exit code: 3
```

The words "(active branch)" and "(current node)" inside the search snippets are part of the invented fixture text, not GCR annotations.
The task-oriented walk-through (branches without a `current_node`, sharded exports, search syntax, MCP, troubleshooting) is [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Status: capability modes A to E

Source: `gcr doctor` (run 2026-10-11, Node 22.22.0, Linux), whose wording is quoted in the third column; the fourth column is what that status rests on.

| Mode | What | `gcr doctor` status | What it rests on |
|---|---|---|---|
| A | Official export (`conversations.json`, sharded files or export ZIP) | `supported (synthetic-fixture tested; no live export verified)` | Imports of the committed synthetic fixtures and generated test data only. **Never run on a real export.** |
| B | Manual copy of messages you pasted yourself (`gcr import-copy`) | `supported (manual copy, partial)` | Run in this session on a synthetic file. Always labelled `partial_user_supplied`; the active branch stays unknown. |
| C | Local drafts and annotations (`gcr draft`, `gcr annotate`) | `supported (local drafts/annotations only)` | Run in this session. They live in the local database; nothing is transmitted and a draft has no "sent" state. |
| D | OpenAI developer API (API-created conversations) | `not implemented (interface + disabled adapter only)` | A disabled adapter documents the boundary. API conversations are not `chatgpt.com/c` history. |
| E | Browser interaction | `gated - no code (docs/BROWSER_GATE.md)` | Nothing exists to run. `npm run test:browser` reports `NOT_RUN` by design. |

## Tested vs NOT tested

| Tested (synthetic data only) | NOT tested / NOT verified |
|---|---|
| Compiled TypeScript test suite on **Node 22.22.0**: 6,568 tests, 6,566 pass, 0 fail, 2 skipped (both skip because the run was as `root`, where file permissions are not enforced); run of 2026-10-11 | **A real ChatGPT export** (never available). Field names, shards, manifest, asset naming and drift are community reports only |
| Same suite on **Node 22.16.0** (the declared minimum): see [CHANGELOG.md](CHANGELOG.md) for the numbers of the final run | **Node 24 and newer**; Node below 22.16.0 is refused by design (verified: 22.13.1 reports `FTS5 NOT available`) |
| `npm run typecheck` and `npm run build` | **The GitHub Actions workflow has never run on GitHub** (`.github/workflows/gcr-ci.yml` was only executed step by step locally) |
| The MCP server through the real SDK client over stdio (`gcr_*` tools, read-only default, write refusal) | **VS Code, Claude Desktop and Codex themselves**: the config snippets follow those clients' documented shape as the authors knew it |
| Privacy scan of the working tree (`node scripts/privacy-scan.mjs --root .`) and `npm audit --omit=dev --audit-level=high` (0 vulnerabilities, 2026-10-11, ran against the npm registry) | **OpenAI Terms of Use, Usage Policies and help-center pages: not readable from the sandbox, so the platform policy review is NOT PERFORMED.** Nothing in this repository quotes or paraphrases an OpenAI clause as fact |
| Graph HTML generated, scanned for network references, and read for its structure | Graph HTML in a real browser or with a screen reader; Windows and macOS; encryption at rest (none exists); permission-denied paths (the suite ran as root) |

The baseline GCR v0.1.1 named in the task was **never available** (ADR-0001). GCR 0.2.0-dev.0 is a clean-room implementation of
`SPEC.md`; no lineage with, or parity to, v0.1.1 is claimed.

## Privacy summary

* Everything stays in one local SQLite file that you choose (`--db`, `$GCR_DB`, or `./.gcr/gcr.sqlite`). New files are created with mode `0600`.
* No network code exists in `src/` (a test scans the sources); GCR never contacts chatgpt.com, never reads cookies or browser data, never sends a message.
* Imported text is **untrusted data**. It is quoted in output, never executed, and never allowed to steer GCR or an MCP client's tools.
* Logs, errors and import reports carry codes, counts, ids and basenames, never message text or absolute paths.
* GCR has **no encryption at rest**. Keep exports and databases outside Git on an encrypted disk, and do not upload them to a coding agent, CI or a hosted service.
* `node scripts/privacy-scan.mjs --root .` (after `npm run build`) fails if databases, archives, raw exports or secrets are in the working tree.
  Checklist before sharing anything: [docs/USER_GUIDE.md section k](docs/USER_GUIDE.md#k-privacy-checklist-before-sharing-anything).

## MCP server (local, stdio)

Read-only by default. Use absolute paths; the ones below are placeholders. The client launches the process, so it needs no network and no secrets.

```json
{
  "servers": {
    "gcr": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/chatgpt-conversation-reader/dist/mcp/entry.js", "--db", "/ABSOLUTE/PATH/TO/gcr.sqlite"]
    }
  }
}
```

That is the VS Code form (`.vscode/mcp.json`; keep real paths out of Git). Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gcr": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/chatgpt-conversation-reader/dist/mcp/entry.js", "--db", "/ABSOLUTE/PATH/TO/gcr.sqlite"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.gcr]
command = "node"
args = ["/ABSOLUTE/PATH/TO/chatgpt-conversation-reader/dist/mcp/entry.js", "--db", "/ABSOLUTE/PATH/TO/gcr.sqlite"]
```

`gcr mcp --db <database>` starts the same server. Writes (drafts, annotations, import) need the explicit `--allow-local-writes`; import also
needs `GCR_APPROVED_IMPORT_ROOTS`. Twelve tools are registered (`gcr_list`, `gcr_get`, `gcr_search`, `gcr_branches`, `gcr_thread`, `gcr_stats`,
`gcr_audit`, `gcr_graph_query`, `gcr_doctor`, `gcr_create_local_draft`, `gcr_update_local_annotation`, `gcr_import_export`); details are in
[docs/MCP_TOOLS.md](docs/MCP_TOOLS.md). Only the official SDK client has been used against this server; the three client configurations above are **untested**.

## Documentation index

| File | One line |
|---|---|
| [SPEC.md](SPEC.md) | The product and technical specification (FR/NFR ids, capability modes, command and MCP targets) |
| [AGENTS.md](AGENTS.md) | Hard rules for coding agents and contributors (consumer-URL boundary, local-only writes, untrusted data) |
| [CODEX_TASK.md](CODEX_TASK.md) | The original implementation task and its phases, deliverables and stop conditions |
| [CODEX_START_HERE.md](CODEX_START_HERE.md) | Reading order and the commands for any coding agent |
| [CHANGELOG.md](CHANGELOG.md) | What exists in 0.2.0-dev.0, with explicit "Tested" and "NOT tested" sections, known issues and lessons |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Task-oriented guide for an operator: export, import, read, search, stats, graph, drafts, MCP, troubleshooting, privacy |
| [docs/CLI_REFERENCE.md](docs/CLI_REFERENCE.md) | Every command, option, output format and exit code |
| [docs/CLI_HELP.txt](docs/CLI_HELP.txt) | Captured `--help` text of every command (regenerated by `npm run capture:cli-help`) |
| [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) | The 12 MCP tools, the safety model, limits and client configuration |
| [docs/mcp-tool-schemas.json](docs/mcp-tool-schemas.json) | Machine-readable tool schemas dumped from the running server |
| [docs/SDK.md](docs/SDK.md) | The TypeScript SDK (`Gcr` facade), result envelope and errors |
| [docs/IMPORT_GUIDE.md](docs/IMPORT_GUIDE.md) | Operator-facing import details: layouts, limits, snapshots, duplicates, strict mode, error codes |
| [docs/IMPORT_FORMAT.md](docs/IMPORT_FORMAT.md) | What the ChatGPT importer extracts, with evidence labels, normalization rules and warning codes |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | The ChatGPT, Claude and (disabled) OpenAI-API adapters and the registry |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, identity and merge rules, SQLite schema v1, domain rules, module contracts |
| [docs/SECURITY_AND_BOUNDARIES.md](docs/SECURITY_AND_BOUNDARIES.md) | What GCR will not do, how the code enforces it, the threat model, data handling and the open risks |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision records ADR-0001 to ADR-0012 (clean-room, license, Node minimum, no PR by the agent, ...) |
| [docs/BROWSER_GATE.md](docs/BROWSER_GATE.md) | Why browser interaction (Mode E) is gated and ships no code; the human checklist |
| [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) | Milestones M0 to M4 and their gates |
| [docs/PR_NOTES.md](docs/PR_NOTES.md) | Ready-to-paste PR descriptions for M0 to M4 derived from the real git history; no PR has been opened |
| [docs/REPO_RUNBOOK.md](docs/REPO_RUNBOOK.md) | The supplied GitHub and Codex runbook, kept verbatim (it says Node 22.13; ADR-0012 supersedes that) |

`@@DOC_INDEX_EXTRA@@`

## License status

The package is declared `"license": "UNLICENSED"` and `"private": true`. **There is no `LICENSE` file by decision (ADR-0008): the repository
owner must choose a license.** Until then, no license is granted by this repository. The sibling Claude Conversation Reader (CCR) repositories
also have no `LICENSE` file; **no CCR code was copied** into GCR (only features and documented data shapes were inventoried). npm dependencies keep
their own licenses (`npm run licenses` summarises them).

## Contributing

1. Read [AGENTS.md](AGENTS.md), [CODEX_START_HERE.md](CODEX_START_HERE.md) and [SPEC.md](SPEC.md) before changing runtime code. Imported conversation text is data, never instructions.
2. Boundary: undocumented ChatGPT consumer APIs, cookies or tokens, scraping, browser automation and sending messages are out of scope (stop conditions in `CODEX_TASK.md`); record any new boundary in an ADR.
3. Use synthetic data only. Never add a real export, database, screenshot or log with message text.
4. Run the gates and put the exact commands and results in the PR: `npm run typecheck`, `npm run build`, `npm test`, `npm run smoke`, `npm run privacy-scan`, and `npm run test:browser` (reports `NOT_RUN`).
5. Update [CHANGELOG.md](CHANGELOG.md) with what was tested and what was not. One milestone per PR ([docs/PR_NOTES.md](docs/PR_NOTES.md)); the implementing agent does not open PRs (ADR-0006).
