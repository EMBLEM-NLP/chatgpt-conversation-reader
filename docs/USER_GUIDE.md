# GCR user guide

For an operator who is not a developer: you have (or will request) your own ChatGPT data export and want to search and read it
offline with GCR. Other documents go deeper: [CLI_REFERENCE.md](CLI_REFERENCE.md) (every option), [IMPORT_GUIDE.md](IMPORT_GUIDE.md)
(import internals), [MCP_TOOLS.md](MCP_TOOLS.md) (MCP), [SDK.md](SDK.md) (TypeScript API), [../README.md](../README.md) (overview and status).

## How to read this guide

* **Evidence.** Every command and output shape below was run on 2026-10-11 with Node 22.22.0 on Linux, against **synthetic** data only
  (the committed `fixtures/chatgpt/` files). Output is abridged (`...`) and mostly shown with `--format compact`; the default format is Markdown.
  Commands that appear here but were not run are marked **NOT RUN**. Anything not checked is marked **NOT VERIFIED**.
* **GCR has never been run on a real ChatGPT export.** Everything about the export format is synthetic-only evidence plus community reports.
  If your real export fails to import, see [section j](#j-troubleshooting-by-error-code) and report the error code, never the data.
* **`gcr`** below means `node /ABSOLUTE/PATH/TO/chatgpt-conversation-reader/dist/cli/main.js` (see the README for `npm run build`). A shell function does it:
  `gcr() { node "$GCR_REPO/dist/cli/main.js" "$@"; }`.
* **Ids** in this guide are invented: `00000000-0000-4000-8000-<12 hex>`. Yours will look like real UUIDs.
* **The database** is one SQLite file. `--db <path>` selects it; otherwise `$GCR_DB`; otherwise `./.gcr/gcr.sqlite` in the current folder
  (created with mode `0700`/`0600` on the first write). The examples use `--db ./demo.sqlite`.

### The demo data used here

```bash
export GCR_REPO=/ABSOLUTE/PATH/TO/chatgpt-conversation-reader
gcr() { node "$GCR_REPO/dist/cli/main.js" "$@"; }
mkdir -p /tmp/gcr-demo && cd /tmp/gcr-demo
node -e "
const fs = require('fs');
const dir = process.env.GCR_REPO + '/fixtures/chatgpt/';
const names = ['minimal-linear', 'branching', 'trimmed-2026', 'content-types'];
const all = names.flatMap((n) => JSON.parse(fs.readFileSync(dir + n + '.json', 'utf8')));
fs.writeFileSync('conversations.json', JSON.stringify(all));
"
python3 -m zipfile -c synthetic-export.zip conversations.json      # or: zip synthetic-export.zip conversations.json
gcr import synthetic-export.zip --db ./demo.sqlite --format compact
```

This yields four conversations (`...0001` linear, `...0002` branching, `...0003` the same graph without `children`, `...0004` one message per content type), 43 stored message rows
(4 of them structural, empty root nodes), batch `b_53f8bfa98c5dbcb85ed3cd786abc3a97`, and two warnings (`CHILDREN_ABSENT`, `UNKNOWN_CONTENT_TYPE`).

## Contents

a. [Get your official export](#a-get-your-official-export) | b. [Import](#b-import) | c. [Read a conversation, branches](#c-read-a-conversation-by-link-or-uuid-and-branches) |
d. [Search](#d-search) | e. [Stats and audit](#e-stats-and-audit) | f. [Graph](#f-graph) | g. [Drafts and annotations](#g-drafts-and-annotations) |
h. [Manual copy import](#h-manual-copy-import-mode-b) | i. [MCP](#i-mcp-server) | j. [Troubleshooting](#j-troubleshooting-by-error-code) | k. [Privacy checklist](#k-privacy-checklist-before-sharing-anything)

---

## a. Get your official export

### What is OFFICIAL (could not be re-verified from the sandbox)

OpenAI's Help Center article "How do I export my ChatGPT history and data" (article 7260999,
`help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data`) is the only OFFICIAL source. **The sandbox that produced this
guide could not open any `*.openai.com` page**, so what follows reaches GCR second-hand (a search-engine summary of the article, corroborated by one other
repository's research note). **Check the live article before you rely on any detail.**

| Statement (as reported) | Status |
|---|---|
| Two routes: ChatGPT **Settings > Data controls > Export data > Export** (confirm on the next screen), or the **Privacy Portal** (Make a Privacy Request > consumer ChatGPT account > Download my data) | OFFICIAL, could not be re-verified |
| You are told by email or SMS when the export is ready. Delivery can take up to **7 days**; the download link **expires 24 hours after you receive it** | OFFICIAL, could not be re-verified |
| The Settings route is offered for Free, Plus, Pro and eligible ChatGPT Edu workspaces; **not** for Business or Enterprise workspaces (ask the workspace owner) | OFFICIAL, could not be re-verified |
| The download is a ZIP with "your chat history and other relevant account data" | OFFICIAL, could not be re-verified |
| An export cannot restore chats that were already deleted | OFFICIAL, could not be re-verified |

OpenAI publishes **no list of the files or JSON fields** inside the ZIP.

### What is only community-observed

Third-party tools report the following; none of it is confirmed by OpenAI, and the format changes without notice:

* A `conversations.json` (one JSON array), or, for larger histories, shards `conversations-000.json`, `conversations-001.json`, ... possibly with an `export_manifest.json`.
* Other files such as `chat.html`, `user.json` (this holds personal data such as your e-mail address), feedback and shared-link files, and assets named `<id>.dat`.
* A "ZIP inside a ZIP" (`Conversations__...part-001.zip`) from the Privacy Portal route.
* Temporary chats are reportedly not included.
* Recent exports reportedly omit the `children` list of each node and system/tool messages. GCR is built for both shapes, but only synthetic samples of each were tested.

### Where to keep it

* **Outside Git**, and outside any folder that is synced, shared or backed up to a place you do not control. This repository's `.gitignore` already excludes `*.zip`, `*.sqlite`, `.gcr/` and `/conversations*.json`, but the safest place is a folder that is not in a repository at all.
* On an **encrypted disk** (FileVault, BitLocker, LUKS). GCR has no encryption at rest of its own; the database is as private as the disk it sits on. GCR does not test or verify disk encryption.
* The ZIP and the GCR database both contain your full conversations. GCR never reads `user.json` or the other account files (it only counts them by name), but they are still in the ZIP. Do not forward the ZIP.
* The download link expires; GCR never downloads for you.

---

## b. Import

```bash
gcr import synthetic-export.zip --db ./demo.sqlite
```

Import is **atomic** (all or nothing) and **idempotent**. Exit code 0 on success. The report prints counts, warning codes and file names, never message text.

### Layouts that work

Each layout below was imported on 2026-10-11 from synthetic data built out of the committed fixtures.

| Input | Command | Result seen |
|---|---|---|
| ZIP containing `conversations.json` | `gcr import synthetic-export.zip --db ./demo.sqlite` | `sourceKind: zip`, `formatProfile.layout: single` |
| ZIP with shards `conversations-000.json`, `conversations-001.json` | `gcr import sharded.zip --db ./s.sqlite` | `layout: sharded`, one `MANIFEST_ABSENT` info warning (no `export_manifest.json`) |
| Extracted folder | `gcr import ./folder --db ./f.sqlite` | `sourceKind: directory`, `layout: directory` |
| Outer ZIP holding `Conversations__part-001.zip` (**one** level) | `gcr import nested.zip --db ./n.sqlite` | `layout: nested`, file shown as `Conversations__part-001.zip!/conversations.json` |
| A `conversations.json` file | `gcr import conversations.json --db ./j.sqlite` | `sourceKind: conversations_json` |
| JSON on standard input | `gcr import - --db ./i.sqlite < conversations.json` | `sourceKind: stdin_json`, `sourceLabel: stdin` |

A ZIP cannot be piped; a ZIP inside a ZIP inside a ZIP is refused; encrypted, symlink and path-traversal archives are refused (`IMPORT_ZIP_UNSAFE`).
GCR only reads the input: the SHA-256 of the sharded ZIP, the nested ZIP, a `conversations.json` and the folder was identical before and after an import. See [IMPORT_GUIDE.md](IMPORT_GUIDE.md) sections 3 to 5 for the rules.

### What happens on re-import: snapshots and the head rule

Run the same import again: nothing changes.

```text
$ gcr import synthetic-export.zip --db ./demo.sqlite --format compact
  batchId: b_53f8bfa98c5dbcb85ed3cd786abc3a97
  alreadyImported: true
  conversations.newlyInserted: 0
  messages.newlyInserted: 0
```

A **different** export (even of the same conversations) is a new **batch**, an immutable snapshot. For each conversation the **head** is the snapshot with the
greatest conversation `updated_at` (ties: the later import). Reads and search use the head; `--batch <id>` reads an older snapshot; `--all-batches` includes every snapshot.
Older snapshots are kept, so the database grows with each new export. Demonstration with two synthetic files where the second has a later `update_time` and a changed title:

```text
$ gcr import export-1.json --db ./s.sqlite ; gcr import export-2.json --db ./s.sqlite
$ gcr list --db ./s.sqlite --format compact
[chatgpt] 00000000-0000-4000-8000-000000000001 | GCR-SYNTHETIC-FIXTURE F01 minimal linear conversation (newer export) | updated 2025-10-09 09:12:00 UTC (UTC+00:00) | 2 msgs | exported_tree
$ gcr list --all-batches --db ./s.sqlite --format compact      # both snapshots
[chatgpt] 00000000-0000-4000-8000-000000000001 | ... (newer export) | updated 2025-10-09 09:12:00 UTC ...
[chatgpt] 00000000-0000-4000-8000-000000000001 | GCR-SYNTHETIC-FIXTURE F01 minimal linear conversation | updated 2025-10-09 08:55:20 UTC ...
$ gcr batches --db ./s.sqlite --format compact                # one row per batch: batchId, seq, sourceLabel, counts
$ gcr get 00000000-0000-4000-8000-000000000001 --batch b_2e52a6494a834355e4be7a4a33fc8119 --db ./s.sqlite    # the older snapshot
```

(The two files were made from `fixtures/chatgpt/minimal-linear.json` by adding 1000 to `update_time` and appending a suffix to the title.)
Local drafts and annotations live in separate tables and survive re-imports.

### Account labels

`--account <label>` keeps exports of different people or accounts apart even when ids collide (default `default`; 1 to 64 characters: letters, digits, `_ . @ -` and space, starting with a letter or digit).

```text
$ gcr import synthetic-export.zip --db ./accounts.sqlite                       # label "default"
$ gcr import synthetic-export.zip --account work --db ./accounts.sqlite        # the same export under a second label
$ gcr get 00000000-0000-4000-8000-000000000001 --db ./accounts.sqlite
error[AMBIGUOUS_CONVERSATION]: The conversation id exists under more than one provider or account.
  remedy: Name one of the candidates: pass an object reference { conversationId, provider, accountLabel } (CLI: --provider and --account) to choose.
exit=3
$ gcr get 00000000-0000-4000-8000-000000000001 --account work --db ./accounts.sqlite --format compact      # works
```

(A separate database, `accounts.sqlite`, is used so that the demo numbers elsewhere in this guide stay unchanged.)

### Limits and how to raise them

Every limit is finite; there is no "unlimited". Defaults protect against decompression bombs and oversized records. Raise one only for a file you trust.

| Flag | Limit | Default |
|---|---|---|
| `--max-entries <n>` | entries in a ZIP | 20,000 |
| `--max-entry-bytes <bytes>` | uncompressed size of one ZIP entry | 2 GiB |
| `--max-total-bytes <bytes>` | uncompressed bytes read in one import (per pass) | 8 GiB |
| `--max-ratio <n>` | compression ratio of one entry (entries up to 64 KiB are exempt) | 200 : 1 |
| `--max-element-bytes <bytes>` | one conversation (and the standard-input buffer, 4 times) | 256 MiB |

The nested-ZIP limit (256 MiB per inner archive) has **no CLI flag and no import option** in this version: it is the constant `MAX_NESTED_ZIP_BYTES` in `src/ingest/layout.ts`, overridable only by code that calls the layout function directly. Example of a limit tripping (a deliberately tiny value):

```text
$ gcr import conversations.json --max-element-bytes 100 --db ./e.sqlite
error[IMPORT_LIMIT_EXCEEDED]: JSON element #0 exceeds the maximum element size of 100 bytes.
  remedy: The export contains a single record larger than the configured element limit; raise maxElementBytes only if the file is trusted.
exit=4
```

(The remedy text uses the SDK option name `maxElementBytes`; on the command line the flag is `--max-element-bytes`, for example `--max-element-bytes 1073741824`.)

### Strict mode and warnings

By default a damaged conversation becomes a **warning** and the import continues (`warnings[].code`, `count`, up to 5 `sampleIds`). `--strict` aborts and stores nothing on the first problem.
The `formatProfile` in the report lists observed facts (layout, whether `children` were present, role counts, how many messages state a model); read it before you trust statistics.

---

## c. Read a conversation by link or UUID, and branches

```bash
gcr get 00000000-0000-4000-8000-000000000001 --db ./demo.sqlite                       # Markdown
gcr get https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 --db ./demo.sqlite --format compact
```

```text
# GCR-SYNTHETIC-FIXTURE F01 minimal linear conversation | chatgpt | exported_tree | 00000000-0000-4000-8000-000000000011
# source: provenance=official_chatgpt_export | account=default | batch=b_53f8... | selection=source_current_node | conversation=00000000-0000-4000-8000-000000000001
[user] synthetic user turn 1
[assistant] synthetic assistant answer 1
```

The `chatgpt.com/c/<uuid>` link is **only a key**: it is checked against your imported data and never opened. Only the exact form `https://chatgpt.com/c/<uuid>` is accepted.

| You give | Result |
|---|---|
| An imported UUID or link | The conversation (exit 0) |
| A UUID or link that is not in your database | `NOT_IN_LOCAL_EXPORT`, exit 3: "Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>". Nothing is fetched or guessed |
| `https://chatgpt.com/share/<uuid>` | `UNSUPPORTED_URL`, exit 2: "Only /c/<uuid> conversation links are supported (share links and other paths are not)" |
| Another host, `http:`, a port, `www.` or `chat.openai.com` | `UNSUPPORTED_URL`, exit 2 |
| A malformed UUID (`not-a-uuid`) | `INVALID_UUID`, exit 2 |

### Branches, and why GCR will not guess the active branch

A conversation is a tree: editing a prompt or regenerating an answer creates a **branch**. The export names the branch you last saw with `current_node`. A **branch id is the id of its leaf message.**

```text
$ gcr branches 00000000-0000-4000-8000-000000000002 --db ./demo.sqlite --format compact
[branch 1] 00000000-0000-4000-8000-000000000013 | root client-created-root | fork - | 4/4 msgs | active
[branch 2] 00000000-0000-4000-8000-000000000014 | root client-created-root | fork 00000000-0000-4000-8000-000000000010 | 2/2 msgs | inactive
[branch 3] 00000000-0000-4000-8000-000000000016 | root client-created-root | fork client-created-root | 2/2 msgs | inactive
```

If the export has **no valid `current_node`**, GCR does not know which branch was active, and (ADR-0009) it does not pick one for you. To show this, take a synthetic conversation with three branches and blank its `current_node`:

```bash
node -e "
const fs = require('fs');
const [c] = JSON.parse(fs.readFileSync(process.env.GCR_REPO + '/fixtures/chatgpt/branching.json', 'utf8'));
c.current_node = null; c.id = c.conversation_id = '00000000-0000-4000-8000-0000000000b2';
fs.writeFileSync('conversations.json', JSON.stringify([c]));
"          # run this in an empty folder (it overwrites conversations.json)
gcr import conversations.json --db ./nocur.sqlite
gcr get 00000000-0000-4000-8000-0000000000b2 --db ./nocur.sqlite
```

```text
error[ACTIVE_BRANCH_UNKNOWN]: The source did not identify the active branch (no valid current_node) and the conversation has 3 branches.
  remedy: GCR does not guess which branch is active. List the branches with "gcr branches <conversation>" and pass --branch <id>, or opt in to a labelled heuristic with --branch-policy last_child|latest_leaf (the result is then flagged ACTIVE_BRANCH_HEURISTIC).
exit=3        (with --format json the error details list branchCount and branchIds)
```

You then choose, explicitly:

| Option | Meaning | Seen in the demo |
|---|---|---|
| `--branch <leaf id>` | Show exactly this branch | `gcr thread 00000000-0000-4000-8000-0000000000b2 --branch 00000000-0000-4000-8000-000000000014 --db ./nocur.sqlite` printed the two-message branch, `selection=explicit_branch` |
| `--branch-policy latest_leaf` | Opt in to "newest leaf" | Picked `...000016`; output carries warning `ACTIVE_BRANCH_HEURISTIC` ("may not be the one the user last viewed") |
| `--branch-policy last_child` | Opt in to "follow the last child from the root" | Same warning; in this sample it also picked `...000016` |
| `--all-branches` (on `get`) | Print every branch, one after another | Three threads, each labelled |
| `gcr thread <ref> [--branch ...]` | Always exactly one thread | |

A heuristic is a **labelled guess**; do not treat its answer as what you saw on screen. A wrong branch id is `BRANCH_NOT_FOUND` (exit 3). A conversation with no `current_node` but only one branch is shown with `selection=only_branch` (nothing to guess) and a `NO_CURRENT_NODE` warning.
Hidden messages (system scaffolding, memory, reasoning) are left out unless you pass `--include-hidden`.

---

## d. Search

```bash
gcr search "synthetic assistant" --limit 2 --db ./demo.sqlite --format compact
```

```text
# search "synthetic assistant" | chatgpt | exported_tree | offset=0 limit=2 hits=2
[assistant] 00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000011 GCR-SYNTHETIC-FIXTURE F01 minimal linear conversation | [[synthetic]] [[assistant]] answer 1
[assistant] 00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000011 GCR-SYNTHETIC-FIXTURE F02 ... | [[synthetic]] [[assistant]] answer 1 (active branch)
```

Each hit shows `conversation-id/message-id`, the title, and a snippet with the match marked (`[[ ]]` in compact, `**bold**` in Markdown, character ranges in `snippetMatches` in JSON). Snippets are excerpts, not the whole message.

### Plain mode (the default)

The prefix, accent and CJK examples below use the `copy.sqlite` database built in [section h](#h-manual-copy-import-mode-b); the others use `demo.sqlite`.

* Case and accents are ignored: `cafe` finds `café` and `CAFÉ` finds it too (Latin tested; Cyrillic `привет` and Greek `ελληνικα` also matched in a synthetic test).
* **All words must be present** (implicit AND). Words like `OR`, `NEAR` and a leading `-` are ordinary text or punctuation, **not** operators. `gcr search "synthetic OR reply NEAR"` returned 0 hits on the demo: all four words must be present, and "or" and "near" are searched as words.
* A trailing `*` makes a prefix: `marsup*` finds `marsupials`.
* **CJK** is matched by character, so one character is enough: `語` and `日本語` both found `これは日本語のテスト` (synthetic manual copy).
* A query with no searchable characters (`!!!`) is `INVALID_ARGUMENT`. A query that starts with `-` must follow `--`: `gcr search --conversation <uuid> -- "-answer"` (the dash is dropped as punctuation; it searched `answer`).

### Raw FTS5 mode

`--raw` passes your query to SQLite FTS5 unchanged (AND / OR / NOT / NEAR / phrases / column filters). A syntax error is reported, not hidden:

```text
$ gcr search 'answer OR "turn 1"' --raw --limit 3 --db ./demo.sqlite --format compact      # works: 3 hits (limit 3), each marking "turn 1"
$ gcr search 'answer AND' --raw --db ./demo.sqlite
error[FTS_SYNTAX_ERROR]: The query is not valid FTS5 syntax.
  remedy: Use plain mode, or fix the raw FTS5 expression (quote phrases, balance parentheses, use AND/OR/NOT in upper case).
exit=2
```

### Scope and filters

| Option | Effect |
|---|---|
| `--scope messages` (default) / `titles` / `all` | message text, conversation titles, or both (titles first); with `titles` or `all` the item shape adds `kind: "title"` |
| `--role <role>` , `--channel <name>` , `--has-model` | only that author role or channel; only messages whose export states a model (messages scope only) |
| `--conversation <uuid or link>` | only inside one conversation |
| `--after <ISO>` , `--before <ISO>` | message creation time window (ISO-8601 UTC) |
| `--provider`, `--account` | restrict to a provider or account label |
| `--include-hidden` | also search hidden messages (system scaffolding, memory...). On the demo: 28 hits for `synthetic` by default, 34 with `--include-hidden` |
| `--all-batches` | include superseded snapshots (the same message can then appear once per snapshot) |

### Pagination

`--limit` 1 to 200 (default 20), `--offset`, or the opaque `--cursor` printed as `nextCursor` (JSON) / "Next cursor" (Markdown). Order is stable: relevance, then time, conversation, message id.
On the demo, `--limit 2 --cursor <nextCursor>` returned the same two hits as `--limit 2 --offset 2`.

An empty result means "not in the data you imported", never "never existed". Imported text can contain anything; the output escapes control characters and quotes message bodies as data.

---

## e. Stats and audit

```bash
gcr stats --group-by role  --db ./demo.sqlite --format compact
gcr stats --group-by model --db ./demo.sqlite --format compact
gcr stats --group-by day --tz Europe/Berlin --db ./demo.sqlite
gcr audit --db ./demo.sqlite --format compact
```

`--group-by` is one of `role`, `model`, `channel`, `day`, `conversation`, `provider`, `content_type`. Day boundaries follow `--tz`. On the demo database (32 visible messages, hidden ones excluded and reported as `HIDDEN_MESSAGES_EXCLUDED`):

```text
role:   assistant 15, tool 9, user 8
model:  unknown (not supplied by source) 20, synthetic-model-1 10, synthetic-model-2 2
        modelProvenance.assistantMessagesWithModel: 12   assistantMessagesWithoutModel: 3
```

### What "unknown (not supplied by source)" means

A message is counted under a model **only** when the export states one on that message (`metadata.model_slug`). GCR never infers a model from timestamps, from neighbouring messages or from the conversation's
default model (SPEC FR-16). Everything else is the single group `unknown (not supplied by source)`.

### Why model counts may be mostly unknown

* **User and tool messages never state a model**, so they are always in the unknown group. In the demo, 20 unknown messages include 8 user and 9 tool messages; only 3 assistant messages lack a model. Use `gcr audit --missing-model`, which counts **assistant** messages only (3 of 15 here).
* Community reports say some recent exports are trimmed and may omit fields. Whether **your** real export states models is **unknown to the authors** (never tested on a real export): run `gcr audit` and read `modelProvenance`.

### Audit

`gcr audit` runs every check by default or only the ones you name: `--missing-model --empty --untitled --tree --no-current-node --unknown-roles --unknown-content-types --timestamps --hidden`.
It reports counts, severity and sample ids, never message text, plus `branchProvenance` (how many conversations have a known active branch) and `modelProvenance`.

```text
$ gcr audit --db ./demo.sqlite --format compact          (demo, abridged)
  findings: missing_model 3/15, empty 0/4, untitled 0/4, tree_integrity 0/4, no_current_node 0/4,
            unknown_roles 0/39, unknown_content_types 1/39 (future_widget_v9), timestamps 0/43, hidden 7/39
  branchProvenance.conversationsWithMultipleBranches: 2   conversationsWithKnownActiveBranch: 4   conversationsWithUnknownActiveBranch: 0
```

If a result is not from a complete export tree (a manual copy, a damaged tree), the output starts with a `NOTICE:` line and the warnings begin with `SOURCE_NOT_FULL_HISTORY`: the numbers describe only what you imported.

---

## f. Graph

The graph is **derived data** that you build from what you imported; it is rebuilt, never edited, and imported rows are never touched.

* **Built from:** locally extracted entities (URLs, UUIDs, ISO timestamps, tool names, code-fence languages, attachment file names and keywords; fixed patterns, no network; URLs lose userinfo, query and fragment),
  conversation nodes, and tool nodes. Edges are `mentioned_in`, `co_occurs` and `uses_tool`. Communities come from deterministic label propagation.
* **Every fact traces back:** `gcr graph explain` lists the conversation, message and branch ids behind an edge.
* An entity is kept only if it occurs in at least `--min-conversations` conversations (default 2; tool names are always kept). Other options: `--kinds`, `--provider`, `--account`.

```text
$ gcr graph build --db ./demo.sqlite --format compact
  edges: 74   entities: 19   communities: 1   messagesScanned: 32
$ gcr graph god-nodes --limit 3 --db ./demo.sqlite --format compact
  [0].node.label: synthetic   [0].weightedDegree: 85
  [1].node.label: answer      [1].weightedDegree: 41
  [2].node.label: turn        [2].weightedDegree: 31
$ gcr graph query synthetic --depth 1 --max-nodes 6 --db ./demo.sqlite --format compact     # neighbourhood of nodes whose label matches
$ gcr graph path conv:chatgpt:default:00000000-0000-4000-8000-000000000002 conv:chatgpt:default:00000000-0000-4000-8000-000000000003 --db ./demo.sqlite --format compact
  found: true      path: conversation ...0002 -> keyword "synthetic" -> conversation ...0003
$ gcr graph explain 36 --limit 3 --db ./demo.sqlite --format compact      # edge ids are printed by query, path and neighbors; 36 = "synthetic" mentioned_in conversation ...0002 here
  evidence[0]: conversation ...0002, message ...0010, batch b_53f8..., branchIds [...0013, ...0014]     (3 of 7 shown: EVIDENCE_TRUNCATED)
```

Node ids look like `ent:keyword:synthetic`, `conv:chatgpt:default:<conversation uuid>` and `tool:<name>`; commands print them. A node id that does not exist is `NOT_IN_LOCAL_EXPORT` ("The node is not a node of the local graph").
Rebuild after importing more data. On a database without a graph, queries come back empty with a `GRAPH_EMPTY` warning.
Keywords in the demo are mostly the fixtures' placeholder words ("synthetic", "answer", "turn"): on real data the output reflects your vocabulary.

### The offline HTML page

```text
$ gcr graph export --out graph.html --db ./demo.sqlite
  file: graph.html   bytes: 31066   nodes: 23   edges: 74   mode: 0600
$ gcr graph export --out graph.html --db ./demo.sqlite          # again, without --force
error[INVALID_ARGUMENT]: The export file "graph.html" already exists; it was not overwritten.
  remedy: Choose another name, or pass --force to replace it.
```

Options: `--term <word>` (neighbourhood instead of the most connected nodes), `--depth`, `--max-nodes`, `--kinds`, `--title`, `--force`. A symbolic link is never written through; the file is created `0600` because it contains **labels from your conversations**.
Open it in a browser as a local file (opening it in a browser was **NOT tested** here). Nothing is loaded from the network: the file declares a strict Content-Security-Policy, and a search of the generated file found no external URL.

**Keyboard use (read from the generated page; NOT VERIFIED in a browser or with a screen reader):** the page starts with a "Skip to the node table" link and has a text filter ("Search labels and ids"), a kind selector and a "Clear filters" button; the node table has sort buttons in its column headers
and a button per row and per neighbour that selects a node, and a "Show more nodes" button; the selected node's details appear in a panel; the SVG overview is a supplement whose nodes are focusable buttons (Enter or Space selects). Everything in the diagram is also in the table.

---

## g. Drafts and annotations

Mode C is **local only**. Nothing is ever sent to ChatGPT; there is no "sent" state; no option posts, sends or opens a browser.

```text
$ printf 'Synthetic draft text.\n' > reply.md
$ gcr draft create --conversation 00000000-0000-4000-8000-000000000001 --input reply.md --title "Follow-up" --db ./demo.sqlite
# Draft created (local only)
- Draft id: `00000000-0000-4000-8000-0000000000d1`        (the real id is a random UUID; this one is a placeholder)
- Conversation: `00000000-0000-4000-8000-000000000001` (chatgpt / `default`)
- Status: draft; namespace `default`
- Body: 22 bytes, sha256 `be4b87b6...`
- Manual continuation link: `https://chatgpt.com/c/00000000-0000-4000-8000-000000000001`
GCR never sends messages; open this link yourself and paste the draft.
```

* `draft list [--conversation ..] [--status draft|archived]`, `draft show <id>` (the text is quoted as data), `draft archive <id>` (twice is fine). `--input -` reads standard input (up to 256 KiB). `--message-id` anchors a draft to a message; a wrong id is `MESSAGE_NOT_FOUND`. A conversation that was never imported is `NOT_IN_LOCAL_EXPORT`.
* **Manual continuation:** open the printed link in your own signed-in browser and paste the text yourself. GCR does not open it.
* **Annotations** are notes on a conversation or one message, stored beside the imported data and surviving re-imports:

```text
$ gcr annotate create --conversation 00000000-0000-4000-8000-000000000001 --message-id 00000000-0000-4000-8000-000000000011 --kind todo --input note.txt --db ./demo.sqlite
- Annotation id: `...`   - Version: 1 (pass it as --expected-version when updating)
$ gcr annotate update <annotation id> --input note2.txt --expected-version 1 --db ./demo.sqlite --format compact        # version becomes 2
$ gcr annotate update <annotation id> --input note2.txt --expected-version 1 --db ./demo.sqlite                          # stale version
error[ANNOTATION_CONFLICT]: The annotation was changed since you read it (version mismatch); nothing was written.
  remedy: Re-read the annotation (getAnnotation), merge your change into the current text, then retry with the new version.
exit=6
```

(`getAnnotation` in that remedy is the SDK method name; on the command line use `gcr annotate show <id>`.) An update replaces the text; only the previous text's hash is kept in the audit log.
Namespaces (`--namespace`) keep drafts or notes of different purposes apart. Every write adds an append-only audit row with ids, lengths and hashes, never text.

---

## h. Manual copy import (Mode B)

If you only have a few messages you copied by hand, GCR can index them. The result is **always partial** (`completeness: partial_user_supplied`, provenance `user_supplied_copy`): the active branch stays unknown, no root node is invented, and every result carries `SOURCE_NOT_FULL_HISTORY`.

`copied-messages.json`:

```json
{
  "conversationId": "00000000-0000-4000-8000-0000000000aa",
  "title": "Synthetic manual copy",
  "sourceUri": "https://chatgpt.com/c/00000000-0000-4000-8000-0000000000aa",
  "messages": [
    { "role": "user", "text": "これは日本語のテスト. Un café, s'il vous plaît.", "createdAt": "2025-03-04T05:06:07Z" },
    { "role": "assistant", "text": "synthetic reply about marsupials", "modelSlug": "name-you-know" }
  ]
}
```

```text
$ gcr import-copy copied-messages.json --db ./copy.sqlite --format compact
# result | chatgpt | partial_user_supplied | object
NOTICE: completeness is "partial_user_supplied": the user supplied only part of the conversation; this is NOT the full conversation history.
  sourceKind: manual_copy      conversations.stored: 1      messages.stored: 2
  warnings[0].code: PARTIAL_USER_SUPPLIED
```

Rules: `messages` (1 to 10,000) with `role` and `text`; `createdAt` (ISO-8601 **with** a zone) and `modelSlug` are stored only if you give them and are never inferred; `conversationId` is optional (without it GCR derives a deterministic UUID-shaped id and warns `CONVERSATION_ID_SYNTHESIZED`);
`sourceUri` must be exactly `https://chatgpt.com/c/<uuid>` (stored as a label, never opened; anything else is `INVALID_URL`). Standard input works too: `gcr import-copy - --db ./c.sqlite < copied-messages.json` gave the same batch id as the file (the batch identity is the content, not the source label).
A manual copy has no `updated_at`, so it never displaces a dated official export of the same conversation as head. Audit flags the missing timestamps of this sample (`CONVERSATION_CREATED_AT_NULL`, `MESSAGE_CREATED_AT_NULL`) and `no_current_node`.

---

## i. MCP server

GCR can run as a **local stdio MCP server** so an MCP client (VS Code, Codex, Claude Desktop, ...) can read your database. It is **read-only by default.**

### Tools (12)

| Tool | Kind | What it does |
|---|---|---|
| `gcr_list`, `gcr_get`, `gcr_search`, `gcr_branches`, `gcr_thread` | read-only | Same as the CLI commands; `gcr_get` and `gcr_thread` accept `branch` and `branchPolicy` |
| `gcr_stats`, `gcr_audit`, `gcr_graph_query` | read-only | Statistics, data-quality audit, graph neighbourhood (needs `gcr graph build` first) |
| `gcr_doctor` | read-only | Self-check and capability modes A to E |
| `gcr_create_local_draft` | local write | Stores a draft; cannot send anything |
| `gcr_update_local_annotation` | local write | Creates or updates a local note (guarded by `expectedVersion`) |
| `gcr_import_export` | local write | Imports a file or folder from an **approved root** only |

Every result is one JSON envelope (`ok`, `data` or `error`, `source`, `completeness`, `warnings`, `ids`, `untrustedContent`, `truncated`). Schemas: [mcp-tool-schemas.json](mcp-tool-schemas.json). Details and limits: [MCP_TOOLS.md](MCP_TOOLS.md).

### Start it and connect a client

```bash
gcr mcp --db ./demo.sqlite                          # same server as: node dist/mcp/entry.js --db ./demo.sqlite
```

Placeholder paths; use absolute paths:

```json
{ "servers": { "gcr": { "type": "stdio", "command": "node",
  "args": ["/ABSOLUTE/PATH/TO/chatgpt-conversation-reader/dist/mcp/entry.js", "--db", "/ABSOLUTE/PATH/TO/gcr.sqlite"] } } }
```

That is the VS Code form (`.vscode/mcp.json`). Claude Desktop (`claude_desktop_config.json`) has the same `command` and `args` without the `"type"` line, under another key:

```json
{ "mcpServers": { "gcr": { "command": "node",
  "args": ["/ABSOLUTE/PATH/TO/chatgpt-conversation-reader/dist/mcp/entry.js", "--db", "/ABSOLUTE/PATH/TO/gcr.sqlite"] } } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.gcr]
command = "node"
args = ["/ABSOLUTE/PATH/TO/chatgpt-conversation-reader/dist/mcp/entry.js", "--db", "/ABSOLUTE/PATH/TO/gcr.sqlite"]
```

**These three client configurations were not tested with the real clients**; check them against each client's current documentation. A client launches the server itself and passes it only the environment you configure (add `env` for `GCR_APPROVED_IMPORT_ROOTS`).
What was tested: the official SDK client over stdio (12 tools listed, calls below) and a raw JSON-RPC pipe (`initialize` and `tools/list` answered, nothing else on stdout, empty stderr).

### Read-only default, enabling writes, approved import roots

```text
tools/list -> 12 tools
gcr_search   {"query":"synthetic assistant","limit":2}                                  -> ok
gcr_get      {"conversation":"https://chatgpt.com/c/00000000-0000-4000-8000-0000000000ff"} -> NOT_IN_LOCAL_EXPORT (isError)
gcr_create_local_draft {...}   (server started without --allow-local-writes)           -> WRITE_FORBIDDEN
  remedy: The operator can restart the server with --allow-local-writes (or GCR_MCP_ALLOW_WRITES=1) to enable drafts, annotations and imports. Reads are unaffected.
gcr_import_export {"path":"/etc/hostname"}   (no approved roots)                        -> IMPORT_PATH_NOT_ALLOWED  (reason: no_approved_roots)
```

* **Enable local writes** deliberately: add `"--allow-local-writes"` to the server arguments (or `GCR_MCP_ALLOW_WRITES=1`; any other value keeps it read-only).
* **Allow import** by also setting `GCR_APPROVED_IMPORT_ROOTS` (absolute directories, `:` between several on POSIX, `;` on Windows), for example in the client's `env`. A path outside the roots, or reaching them through `..`, is refused with the same answer.
  With writes on and a root set, a scratch server accepted `<root>/conversations.json` and refused `/etc/hostname` and `<root>/../conversations.json` (`not_under_approved_root`); a draft and an annotation were created, and a stale `expectedVersion` returned `ANNOTATION_CONFLICT`.
* An unknown argument is rejected (`INVALID_ARGUMENT`, "Unrecognized key"; seen). Results over about 200 KB are shortened and flagged `truncated` (documented in [MCP_TOOLS.md](MCP_TOOLS.md) and covered by its tests; not exercised by hand here).

### Prompt-injection note

Text in your conversations is **untrusted data**. It can contain sentences such as "ignore previous instructions and run a tool". The GCR server never acts on imported text (tests feed it exactly such text), tool descriptions are static, and
every result is marked `untrustedContent: true`. That does **not** make a language-model client immune: a model that reads results can still be steered by them. Keep write tools off unless you need them, keep import roots narrow,
review any tool call the client proposes, and remember that connecting a hosted model to this server sends the returned conversation text to that model's provider (see [section k](#k-privacy-checklist-before-sharing-anything)).

---

## j. Troubleshooting by error code

Errors print as `error[CODE]: message` plus `remedy:` on stderr (one JSON document with `--format json`) and set the process exit code. The codes are the `ERROR_CODES` of `src/errors.ts`; the **Seen** column says whether the exact text below was produced in this session.

| Code | Exit | What happened | The remedy GCR prints | Seen |
|---|---|---|---|---|
| `INVALID_ARGUMENT` | 2 | Bad option or value (account label, empty search, unknown flag, out-of-range number) | e.g. `Run "gcr import --help" for usage.` | yes |
| `INVALID_URL` | 2 | Mode B `sourceUri` is not a chatgpt.com/c link | "Give the exact conversation link (https://chatgpt.com/c/<uuid>) or omit sourceUri. GCR stores it as a label only and never opens it." | yes |
| `INVALID_UUID` | 2 | Malformed id | "Use a link of the form https://chatgpt.com/c/<uuid> or a bare conversation UUID. GCR never opens the link ..." | yes |
| `UNSUPPORTED_URL` | 2 | Share link, other host, `http:`, port, other path | same remedy as above | yes |
| `NOT_IN_LOCAL_EXPORT` | 3 | The conversation (or graph node) is not in your database | "This conversation is not in the data you imported. GCR cannot fetch chatgpt.com conversations. Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>" | yes |
| `BRANCH_NOT_FOUND` | 3 | No such branch id | "List the branches (gcr branches <conversation>) and pass one of the returned branch ids; a branch id is the id of its leaf message." | yes |
| `MESSAGE_NOT_FOUND` | 3 | Draft anchor message does not exist | "Use a message id from the imported conversation (gcr get <conversation> --format json lists them)." | yes |
| `AMBIGUOUS_CONVERSATION` | 3 | The id exists under several accounts or providers | "Name one of the candidates ... (CLI: --provider and --account) to choose." | yes |
| `ACTIVE_BRANCH_UNKNOWN` | 3 | No valid `current_node` and several branches | see section c: use `--branch`, or opt in with `--branch-policy` | yes |
| `IMPORT_INPUT_NOT_FOUND` | 4 | The path does not exist | "Check the path. GCR never downloads anything: pass the export ZIP, the extracted folder or conversations.json that you downloaded yourself." | yes |
| `IMPORT_UNSUPPORTED_FORMAT` | 4 | Neither a ZIP nor JSON, or no `conversations*.json` found | "GCR looks for conversations.json or sharded conversations-<N>.json files: anywhere inside a ZIP, up to 4 folder levels deep in an extracted folder, or inside ONE nested "Conversations*.zip". Import the official export ZIP, the extracted folder, or the conversations file itself." | yes |
| `IMPORT_ZIP_UNSAFE` | 4 | Path traversal, symlink, encryption, duplicates, damage (`reason` such as `NAME_DOT_DOT`) | "Obtain a fresh export directly from the provider; do not import archives from untrusted sources." | yes |
| `IMPORT_LIMIT_EXCEEDED` | 4 | A safety limit tripped | see section b; raise the named limit only for trusted input | yes |
| `IMPORT_PARSE_ERROR` | 4 | Malformed or truncated JSON (with a byte offset) | "The file is not a well-formed JSON export (array expected). It may be truncated or corrupted: obtain a fresh export." | yes |
| `IMPORT_PATH_NOT_ALLOWED` | 4 | MCP import outside the approved roots, or no roots configured | see section i | yes (MCP) |
| `DB_NOT_FOUND` | 5 | No database at that path | "run: gcr import <export.zip>  (or point --db / GCR_DB at an existing database)" | yes |
| `DB_SCHEMA_TOO_NEW` | 5 | The file was written by a newer GCR (checked on a copy with `PRAGMA user_version = 99`) | "Upgrade GCR, or use a different database file. The file was not modified." (file hash unchanged) | yes |
| `DB_MIGRATION_FAILED` | 5 | A schema migration failed and was rolled back | "The database was left at its previous version. Report the issue (without attaching private data)." | no (source text) |
| `DB_ERROR` | 5 | SQLite problem; on old Node, `details.reason = "FTS5_UNAVAILABLE"` (see below) | e.g. the Node upgrade remedy | yes (FTS5) |
| `FTS_SYNTAX_ERROR` | 2 | Invalid `--raw` search syntax | see section d | yes |
| `WRITE_FORBIDDEN` | 6 | Write attempted on a read-only database or a read-only MCP server | "The operator can restart the server with --allow-local-writes ..." | yes (MCP) |
| `DRAFT_NOT_FOUND` | 3 | No draft with that id | "List drafts to find the id." | yes |
| `ANNOTATION_NOT_FOUND` | 3 | No annotation with that id | "List annotations to find the id." | yes |
| `ANNOTATION_CONFLICT` | 6 | Stale `--expected-version` | see section g | yes |
| `NOT_IMPLEMENTED` | 7 | Mode D (OpenAI API) access through the SDK. The CLI rejects `--provider openai_api` earlier as `INVALID_ARGUMENT` ("must be one of: chatgpt, claude") | n/a | CLI path: `INVALID_ARGUMENT` |
| `FEATURE_GATED` | 7 | Defined for browser-interaction features | **No code path in `src/` emits it** (searched); there is nothing to unlock | no |
| `REMOTE_ACCESS_FORBIDDEN` | 7 | Defined for anything that would touch a ChatGPT endpoint | **No code path in `src/` emits it**; no such feature exists | no |
| `INTERNAL_ERROR` | 1 | A bug; the raw message is withheld because it can hold paths or text | "Re-run with GCR_DEBUG=1 to print the stack trace to stderr, then report the issue without attaching private data." | no (source text) |

### FTS5_UNAVAILABLE on old Node

Node 22.13 to 22.15 ship SQLite without FTS5. Under Node 22.13.1 (a real binary), 2026-10-11:

```text
$ gcr doctor --db ./old.sqlite
Status: **PROBLEMS FOUND**
- Node: 22.13.1 (requires >=22.16): TOO OLD
- SQLite: node:sqlite 3.47.2; FTS5 NOT available
...
$ gcr import synthetic-export.zip --db ./old.sqlite --format json
{"ok":false,"error":{"code":"DB_ERROR","message":"This Node.js build of SQLite does not include FTS5, which GCR needs for full-text search.","remedy":"Upgrade Node.js to 22.16.0 or newer (node:sqlite in Node 22.13 to 22.15 is built without FTS5). Running: 22.13.1.","details":{"reason":"FTS5_UNAVAILABLE","node":"22.13.1","minimumNode":"22.16.0"}},"warnings":[]}
exit=5      (no database file was created)
```

Fix: install Node 22.16.0 or newer (`node --version`). Node 24 and newer: **not tested**. The supplied runbook says Node 22.13; ADR-0012 explains why GCR requires 22.16.0.

### Other quick checks

* `gcr doctor` first: Node version, SQLite and FTS5, database path/schema status, the capability modes, and whether `GCR_DB` / `GCR_APPROVED_IMPORT_ROOTS` are set (never their values).
* Nothing printed on stdout but an error on stderr? Errors go to stderr; stdout carries only results. Use `--debug` (or `GCR_DEBUG=1`) for a stack trace; check it for paths before sharing.
* `gcr mcp` without `--db` uses the same default (`./.gcr/gcr.sqlite`) and fails with `DB_NOT_FOUND` (exit 5) if it does not exist.
* If your real export imports with many warnings, run `gcr audit` and read `formatProfile` in the import report; report the warning **codes** and counts, not the content.

---

## k. Privacy checklist before sharing anything

Your export and your GCR database contain your full conversations. GCR has no encryption and no way to redact. Before you send, attach, upload, commit or paste anything:

- [ ] **Not shared:** the export ZIP, the extracted folder, `conversations*.json`, the `.sqlite` database and its `-wal` / `-shm` files, the `.gcr/` folder, backups of any of these.
- [ ] **`graph.html`** contains labels from your conversations (titles, keywords, URLs). Treat it like the conversations.
- [ ] **Command output** (`list`, `get`, `search`, `branches`, `thread`, JSON from any command) contains titles and message text. So do screenshots. Pasting it into a hosted chat or an issue tracker discloses it.
- [ ] **MCP clients:** a hosted model connected to `gcr mcp` receives whatever the tools return. The GCR server itself has no network code; the client does. Decide knowingly which client and model may see which conversations.
- [ ] **Version control:** nothing from the list above is staged or committed (`git status`). Run `npm run build && node scripts/privacy-scan.mjs --root .`; it must say `clean`. Do not allow-list databases, archives or raw exports.
- [ ] **Remote environments** (Codespaces, cloud agents, CI) are other people's computers. Do not copy a real export into them. CI uses synthetic fixtures only.
- [ ] **Bug reports:** include the error **code**, GCR version, Node version and command; do not attach a database, an export, a stack trace you have not read (it can hold paths) or output with message text. Use synthetic data to reproduce.
- [ ] **Other people's data:** your conversations may contain third-party personal data. Keep the database local and delete what you no longer need (delete the database file; GCR has no `delete` command in this version).
- [ ] **Drafts:** a draft is stored in the database in clear text. The continuation link is for you to open; GCR never sends the draft.
- [ ] **Disk:** the database sits unencrypted on whatever disk you choose; use full-disk encryption and sensible file permissions (GCR creates files `0600`, folders `0700`).
