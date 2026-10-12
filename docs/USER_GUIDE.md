# GCR user guide

For an operator who is not a developer: you have (or will request) your own ChatGPT data export and want to search and read it
offline with GCR. Other documents go deeper: [CLI_REFERENCE.md](CLI_REFERENCE.md) (every option), [IMPORT_GUIDE.md](IMPORT_GUIDE.md)
(import internals), [MCP_TOOLS.md](MCP_TOOLS.md) (MCP), [SDK.md](SDK.md) (TypeScript API), [../README.md](../README.md) (overview and status).

## How to read this guide

* **Evidence.** Every command and output shape below was run on 2026-10-11 with Node 22.22.0 on Linux, against **synthetic** data only
  (the committed `fixtures/chatgpt/` files). Output is abridged (`...`) and mostly shown with `--format compact`; the default format is Markdown.
  The parts added on 2026-10-12 after the security and spec-conformance fix wave (the warnings of `get` and `thread`, attachment search and symbol-only queries, `audit` with `null` branch provenance, `graph query` of compound terms, the database-path refusals and the ownership warning, the contributor scanner notes) were checked on that day with the built CLI by the engineers who changed the code; the database-path refusals, the ownership warning and the search and audit behaviours were also re-run by hand for this edit. The documentation review of the same day then added, and checked by hand against the built CLI in scratch folders, the database-error recovery rows and the back-up note (section j), the "Delete your data" steps (section k: the listing of which files each command leaves behind, the absence of any delete command, the loss of drafts on a fresh re-import, the copy of a database with its drafts) and the Node-only way to read the audit log (section g); the export-request table (section a) and the browser statements about the graph page rest on second-hand reports and on one independent reviewer's run, and say so. Test counts and timings are not quoted in this guide: `docs/ACCEPTANCE.md` holds them.
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
h. [Manual copy import](#h-manual-copy-import-mode-b) | i. [MCP](#i-mcp-server) | j. [Troubleshooting](#j-troubleshooting-by-error-code) | k. [Privacy checklist](#k-privacy-checklist-before-sharing-anything) (with [Delete your data](#delete-your-data))

---

## a. Get your official export

### How to request it (reported, UNVERIFIED: check the Help Center article for the current rules)

OpenAI's own Help Center article on exporting your ChatGPT history and data is the place that states the current rules
(`help.openai.com`, article 7260999; the address was returned by a search tool and never fetched, see
[research/platform-policy.md](research/platform-policy.md) section 11). **The sandbox that produced this guide could not open any
`*.openai.com` page**, so nothing in the table below was read from OpenAI. It is a paraphrase of what a search-engine summary reported about that
article, corroborated by one other repository's research note: **reported, UNVERIFIED**. It is not a quotation and it is not labelled
OFFICIAL, because GCR cannot vouch for it (the same items are listed as unverified topics in
[SECURITY_AND_BOUNDARIES.md](SECURITY_AND_BOUNDARIES.md) section 6, item 7). **Open the live article and follow it, not this table.**

| Topic | What was reported (paraphrase) | Status |
|---|---|---|
| Where to ask | Two routes: inside ChatGPT (Settings, then Data controls, then Export data, then confirm), or through OpenAI's Privacy Portal (a privacy request for a consumer ChatGPT account, choosing to download your data) | reported, UNVERIFIED |
| Delivery time and link expiry | You are notified by email or SMS when the export is ready. Delivery was reported to take up to about 7 days, and the download link to stop working about 24 hours after you receive it | reported, UNVERIFIED; the figures may be out of date |
| Who can use the Settings route | Reported for individual plans (Free, Plus, Pro) and for ChatGPT Edu workspaces where the administrator allows it; reported as not available to Business or Enterprise workspace members, who are pointed to their workspace owner | reported, UNVERIFIED; plan names and rules change |
| What the archive contains | A ZIP with your chat history and other account data. Which files, and which JSON fields, is not described in anything GCR could read | reported, UNVERIFIED |
| Deleted chats | Reported to be unrecoverable through an export | reported, UNVERIFIED |

OpenAI publishes **no list of the files or JSON fields** inside the ZIP (as far as GCR could determine; also NOT VERIFIED).

### What is only community-observed

Third-party tools report the following; none of it is confirmed by OpenAI or verified by GCR, and the format changes without notice:

* A `conversations.json` (one JSON array), or, for larger histories, shards `conversations-000.json`, `conversations-001.json`, ... possibly with an `export_manifest.json`.
* Other files such as `chat.html`, `user.json` (this holds personal data such as your e-mail address), feedback and shared-link files, and assets named `<id>.dat`.
* A "ZIP inside a ZIP" (`Conversations__...part-001.zip`) from the Privacy Portal route.
* Temporary chats are reportedly not included.
* Recent exports reportedly omit the `children` list of each node and system/tool messages. GCR is built for both shapes, but only synthetic samples of each were tested.

### Where to keep it

* **Outside Git**, and outside any folder that is synced, shared or backed up to a place you do not control. This repository's `.gitignore` already excludes `*.zip`, `*.sqlite`, `.gcr/` and `/conversations*.json`, but the safest place is a folder that is not in a repository at all.
* On an **encrypted disk** (FileVault, BitLocker, LUKS). GCR has no encryption at rest of its own; the database is as private as the disk it sits on. GCR does not test or verify disk encryption.
* The ZIP and the GCR database both contain your full conversations. GCR never reads `user.json` or the other account files (it only counts them by name), but they are still in the ZIP. Do not forward the ZIP.
* The download link is reported to expire soon after delivery (table above), so save the ZIP when you get it; GCR never downloads for you.

---

## b. Import

```bash
gcr import synthetic-export.zip --db ./demo.sqlite
```

Import is meant to be **atomic** (all or nothing; a refused `--strict` import and a refused ZIP left no database file in the cases tried by hand) and **idempotent** (a repeated import was a no-op, shown below). If you interrupt a *first* import with Ctrl-C, the empty database file it had created stays, per [CLI_REFERENCE.md](CLI_REFERENCE.md) (not tried by hand). Exit code 0 on success. The report prints counts, warning codes and file names, never message text.

### Layouts GCR accepts

Each layout below was imported on 2026-10-11 from synthetic data built out of the committed fixtures. None was tried with a real export.

| Input | Command | Result seen |
|---|---|---|
| ZIP containing `conversations.json` | `gcr import synthetic-export.zip --db ./demo.sqlite` | `sourceKind: zip`, `formatProfile.layout: single` |
| ZIP with shards `conversations-000.json`, `conversations-001.json` | `gcr import sharded.zip --db ./s.sqlite` | `layout: sharded`, one `MANIFEST_ABSENT` info warning (no `export_manifest.json`) |
| Extracted folder | `gcr import ./folder --db ./f.sqlite` | `sourceKind: directory`, `layout: directory` |
| Outer ZIP holding `Conversations__part-001.zip` (**one** level) | `gcr import nested.zip --db ./n.sqlite` | `layout: nested`, file shown as `Conversations__part-001.zip!/conversations.json` |
| A `conversations.json` file | `gcr import conversations.json --db ./j.sqlite` | `sourceKind: conversations_json` |
| JSON on standard input | `gcr import - --db ./i.sqlite < conversations.json` | `sourceKind: stdin_json`, `sourceLabel: stdin` |

Refusals tried by hand on 2026-10-11: a ZIP piped to standard input and a ZIP nested more than one level are `IMPORT_UNSUPPORTED_FORMAT`; a ZIP with a `../` entry name is `IMPORT_ZIP_UNSAFE` (`NAME_DOT_DOT`). Encrypted, symlink, duplicate-name and damaged archives are also meant to be `IMPORT_ZIP_UNSAFE` (decision ADR-0017, covered by the test suite; not tried by hand).
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
$ gcr get 00000000-0000-4000-8000-000000000001 --account work --db ./accounts.sqlite --format compact      # returns the conversation (tried)
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
Example with `fixtures/chatgpt/identity-collisions.json` (the same conversation id appears twice):

```text
$ gcr import conversations.json --db ./lenient.sqlite --format compact      # 4 read, 3 stored, exit 0; warnings DUPLICATE_CONVERSATION, ID_ALIAS_MISMATCH, ID_CASE_NORMALIZED
$ gcr import conversations.json --strict --db ./strict.sqlite
error[IMPORT_PARSE_ERROR]: A conversation id occurs more than once in the input.
  remedy: Re-run without --strict to import what can be read (the problem is then recorded as a warning), or obtain a fresh export.
exit=4        (no database file was created)
```

Empty (`{}`), `null` and scalar entries are skipped with a warning even under `--strict` (checked with `fixtures/chatgpt/nulls-and-wrappers.json`: exit 0 both ways).
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

A conversation whose `current_node` is null (tried above) is also stored with completeness `unknown` instead of `exported_tree` (warning `COMPLETENESS_LOWERED`, reason `no_current_node`), and every result for it starts with a `NOTICE:` line. A heuristic is a **labelled guess**; do not treat its answer as what you saw on screen. A wrong branch id is `BRANCH_NOT_FOUND` (exit 3). A conversation with no `current_node` but only one branch is shown with `selection=only_branch` (nothing to guess) and a `NO_CURRENT_NODE` warning.
Hidden messages (system scaffolding, memory, reasoning) are left out unless you pass `--include-hidden`.

### Warnings printed by `get` and `thread`

Every format (`markdown`, `compact`, `json`, `jsonl`) lists the same warnings that the SDK and the MCP tools return for the same call: first the warnings of the whole result, in their own order, then the warnings of the thread that are not already listed (one entry per code). `SOURCE_NOT_FULL_HISTORY` is the **first** warning whenever the source is not a complete exported tree (a manual copy, a Claude export, a damaged tree), so a partial source is never mistaken for the whole history; the `NOTICE:` line of the human formats says the same in one sentence. In `markdown` the warnings are the `## Warnings` section, in `compact` the `# warnings:` line, in `json` the `warnings` array and in `jsonl` the `footer` line.

```bash
gcr import-copy copy.json --db ./mc.sqlite                      # a manual copy (section h)
gcr get 00000000-0000-4000-8000-0000000000aa --db ./mc.sqlite --format json
# warnings: SOURCE_NOT_FULL_HISTORY, NO_CURRENT_NODE, PARTIAL_USER_SUPPLIED
```

### Known limitation: messages that no root reaches

If a damaged export gives messages parent pointers that form a cycle with no root (the synthetic fixture `fixtures/chatgpt/broken-trees.json`, case "cycle with no root"), those messages are stored but they are **not part of any branch**. `get` then returns no thread and the warning `NO_BRANCHES` says so ("2 message(s) are stored for this snapshot but none of them is reachable from a root ..."; the tree is not empty, its nodes are unreachable), `thread` fails with `BRANCH_NOT_FOUND` (`details.reason` is `no_branches`, `details.unreachableMessages` counts them) and `branches` lists nothing. Naming such a message with `--branch <message id>` (for example an id copied from a search hit) fails with `BRANCH_NOT_FOUND` too, but with `details.reason` `unreachable` and the text "This message is stored, but no root reaches it ...", never with the generic "No such branch"; an id that is not in the conversation at all keeps `unknown_branch`. The text is still in the database: **`gcr search` finds it, but no command can read such a message in full** (there is no option to show unreachable nodes). `gcr audit --tree` lists the damaged conversation (`CYCLE_DETECTED`). A snapshot with no message at all keeps the wording "The stored message tree of this snapshot is empty".

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

* **Folded** (these find each other): case (`cafe`, `Café`, `CAFE`), accents (also the decomposed form `Cafe` + U+0301), character width (fullwidth `ＡＢＣ` finds `abc` and the other way round), compatibility ligatures (`ﬁne` finds `fine`), Cyrillic and Greek case and accents (`привет` finds `ПРИВЕТ`, `ελληνικα` finds `Ελληνικά`), and CJK substrings (below). **Not folded:** `ß` is not `ss` (`strasse` does not find `Straße`), and Thai, Lao, Khmer and Myanmar text is not split into words.
* **All words must be present** (implicit AND). Words like `OR`, `NEAR` and a leading `-` are ordinary text or punctuation, **not** operators. `gcr search "synthetic OR reply NEAR"` returned 0 hits on the demo: all four words must be present, and "or" and "near" are searched as words.
* A trailing `*` makes a prefix: `marsup*` finds `marsupials`.
* **CJK** is matched by character, so one character is enough: `語` and `日本語` both found `これは日本語のテスト` (synthetic manual copy).
* **Emoji and other symbols are not indexed.** Only letters, digits and combining marks are (SQLite `unicode61` tokenisation after GCR's own folding); every other character is a separator: emoji (`😀`, family sequences), currency signs (`₽`), mathematical symbols and punctuation. So the emoji itself can never be searched for, and a query made only of such characters (`😀`, `!!!`, `""`) is `INVALID_ARGUMENT` with the message "the query contains only symbols or punctuation, which are not indexed; search for words" (a blank query of spaces says "the query is empty; search for words"; an empty command-line argument is refused by the CLI itself before the search). A symbol next to a word is simply dropped: `grin 😀` searches `grin`. Two exceptions to keep in mind: a compatibility character that Unicode folds into letters or digits is searched in its folded form (`™` is `tm`, `Ⅳ` is `iv`, `²` is `2`, so a query of only those is not refused), and with `--raw` ASCII punctuation is FTS5 syntax (`!!!` is `FTS_SYNTAX_ERROR`; an emoji-only raw query is still `INVALID_ARGUMENT`).
* A query that starts with `-` must follow `--`: `gcr search --conversation <uuid> -- "-answer"` (the dash is dropped as punctuation; it searched `answer`).

### Raw FTS5 mode

`--raw` passes your query to SQLite FTS5 unchanged (AND / OR / NOT / NEAR / phrases / column filters). A syntax error is reported, not hidden:

```text
$ gcr search 'answer OR "turn 1"' --raw --limit 3 --db ./demo.sqlite --format compact      # 3 hits (limit 3), each marking "turn 1" (tried)
$ gcr search 'answer AND' --raw --db ./demo.sqlite
error[FTS_SYNTAX_ERROR]: The query is not valid FTS5 syntax.
  remedy: Use plain mode, or fix the raw FTS5 expression (quote phrases, balance parentheses, use AND/OR/NOT in upper case).
exit=2
```

### Scope and filters

| Option | Effect |
|---|---|
| `--scope messages` (default) / `titles` / `attachments` / `all` | message text, conversation titles, attachment file names and MIME types (below), or all three: titles first, then messages, then attachments. **`all` includes attachment names** (it used to mean titles plus messages only). Items carry `kind: "message"`, `"title"` or `"attachment"` outside the plain messages scope |
| `--role <role>` , `--channel <name>` , `--has-model` | only that author role or channel; only messages whose export states a model (messages and attachments scopes only; `titles` and `all` refuse them) |
| `--conversation <uuid or link>` | only inside one conversation (messages and attachments scopes only) |
| `--after <ISO>` , `--before <ISO>` | message creation time window (ISO-8601 UTC; messages and attachments scopes only) |
| `--provider`, `--account` | restrict to a provider or account label |
| `--include-hidden` | also search hidden messages (system scaffolding, memory...) and, with `--scope attachments`, their attachments (`titles` and `all` refuse it, like the other message filters). On the demo with `--limit 200`: 28 hits for `synthetic` by default, 34 with `--include-hidden` (the default `--limit` is 20, so without it both print `hits=20`) |
| `--all-batches` | include superseded snapshots (the same message can then appear once per snapshot) |

### Attachment names (`--scope attachments`)

```bash
gcr search "diagram png" --scope attachments --db ./att.sqlite --format compact       # att.sqlite = fixtures/chatgpt/attachments-citations.json
```

```text
  items[0].kind: attachment      items[0].conversationId: 00000000-0000-4000-8000-00000000000b
  items[0].messageId: 00000000-0000-4000-8000-000000000010      items[0].attachmentIndex: 1
  items[0].attachmentName: synthetic-diagram.png      items[0].attachmentMimeType: image/png
  items[0].snippet: synthetic-[[diagram]].[[png]] (image/[[png]])
```

* **Metadata only.** The search looks at the **file name** and the **MIME type** of each attachment reference (FR-15). It never searches attachment content: GCR does not open attachment files, a ChatGPT export may not even contain them, and text a Claude export carries inside an attachment (`extracted_content`) is kept as an `attachment_text` block of the message (and in the raw source) but is **not searched** by this scope or by message search. Message text is not searched by this scope either: use the default scope for that.
* **Matching.** The query is read like a plain message query (the same folding as above; operators and quotes are inert), and **every word must occur as a substring** of the folded file name or of the folded MIME type of the same attachment. `notes`, `ynthetic-note`, `synthetic-notes.txt` and `NOTES.TXT` all find `synthetic-notes.txt`; `diagram`, `diagram png` and `png diagram` find `synthetic-diagram.png` (one word in the name, one in the type is fine: `diagram image`); `image/png` finds every PNG; a quoted `"synthetic notes"` is the two words in sequence. A symbol-only query is refused as above. `--raw` is `INVALID_ARGUMENT` for this scope: FTS5 syntax cannot be applied to file names.
* **One hit per attachment**, with the conversation, message and attachment position (`attachmentIndex`, the place in the message's stored attachment list), the author role, time, `hidden`, the file name, type and size as the export gave them, and a snippet that names the attachment (`name (type)`, matched whole words marked). The hit is identified by `messageId` + `attachmentIndex`.
* **No relevance ranking.** Hits are ordered oldest message first (messages without a time last), then by conversation, message and attachment position; paging with `--limit` / `--offset` is stable. There is no `--cursor` for attachments (`INVALID_ARGUMENT`).
* **`--include-hidden`, `--all-batches` and the message filters apply** as in the messages scope (see the table). With `--scope all --raw` the attachment part is skipped and the warning `ATTACHMENTS_NOT_SEARCHED` says so.
* **Cost.** Attachments have no search index (adding one would change the database schema), so every call reads the messages that have attachments and folds their names in memory. On the synthetic 50,000-message performance corpus (two runs on a shared 4-CPU sandbox, warm cache, attachments injected into a scratch copy) a call took about 45 ms with no attachments at all, about 50 ms with attachments on 1% of the messages and 60 to 175 ms with attachments on 10% of them (the upper figure is a query that matches nothing or only late: the whole scan runs). The cost grows roughly linearly with the size of the database, because a message row is read to get at its attachment list (a cold cache or a database of long messages costs more); message search stays at about 0.4 ms. A real export may behave differently.
* **Lists that are not fully searched say so.** Only the first 5,000 attachments of one message are searched (a ChatGPT export can list up to 50,000 per message); each message cut that way is counted in the warning `ATTACHMENTS_PARTLY_SEARCHED`, and a stored list that cannot be read in `STORED_JSON_INVALID`. Both counts read "At least N" when the page was full before the scan finished (a lower bound).

### Pagination

`--limit` 1 to 200 (default 20), `--offset`, or the opaque `--cursor` printed as `nextCursor` (JSON) / "Next cursor" (Markdown); the cursor is for the messages scope only, the other scopes page with `--offset`. Order is stable: relevance, then time, conversation, message id.
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
`branchProvenance` comes from the tree pass, which runs only when `--tree`, `--no-current-node` or `--timestamps` is selected (or no flag at all). With other flags only (the SPEC form `gcr audit --missing-model --empty --untitled`) it was **not measured**: it is `null` in `json` / `jsonl`, reads "not computed" in `markdown` / `compact`, and the warning `BRANCH_PROVENANCE_NOT_COMPUTED` explains it. It is never reported as zeros. `modelProvenance` is always measured.

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

**How `graph query` matches the term.** Keywords are single words, so a hyphenated name is stored as separate keywords: `EMBLEM-NLP` in a message becomes the keyword nodes `emblem` and `nlp`, never a node `emblem-nlp`.

1. The whole term is looked up first (an exact node id, a normalised label, or a substring of a label; case is ignored).
2. If nothing matches and the term contains a hyphen, an underscore, a dot between letters or white space (`EMBLEM-NLP`, `emblem nlp`, `emblem_nlp`), it is split into the same keywords the extractor would produce from it (lower case, at least three letters, no stop words), **every keyword node that matches one of them becomes a seed**, and the warning `TERM_SPLIT` names the words that were used (and any word that has no node; a word whose node exists but was left out by `--max-nodes` is named as cut by the limit, not as missing). `gcr graph query "EMBLEM-NLP" --depth 2` therefore returns the neighbourhood of `emblem` and `nlp`.
3. If there is still no seed the answer is an empty graph **with the warning `NO_MATCHING_NODE`** (try another term, or list `gcr graph god-nodes`; a word of fewer than three letters is never a keyword, and a name that occurs in only one conversation is left out by the default `graph build`, `--min-conversations 1` keeps it); an empty graph is never silent. (A database without any graph says `GRAPH_EMPTY` instead.)

Extraction is not changed by this and the stored graph is not touched; only the lookup is.
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
Open it in a browser as a local file. **How much this was tested:** the project's own tests execute the page's program in a fake DOM (`node:vm`), and an independent security reviewer opened an export of hostile synthetic conversations once in a real headless Chromium 141 on 2026-10-11: all 31 buttons of that page were clicked, 24 SVG nodes were activated by click and by Enter, a script string was typed into the search box and hostile `#` fragments were loaded; the page title stayed the same, no dialog opened, there were no console or page errors and no request other than to file and data URLs. That run is not part of the test suite and is not repeated in CI (the record is in `docs/ACCEPTANCE.md`, section "Independent reviews"); other browsers and screen readers were never tried. Nothing is loaded from the network: the file declares a strict Content-Security-Policy, and a search of the generated file found no external URL.

**Keyboard use (read from the generated page; in a real browser only click and Enter on the SVG nodes were exercised; NOT VERIFIED with a screen reader, in other browsers, or for Tab order, Space and the skip link):** the page starts with a "Skip to the node table" link and has a text filter ("Search labels and ids"), a kind selector and a "Clear filters" button; the node table has sort buttons in its column headers
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
Namespaces (`--namespace`) keep drafts or notes of different purposes apart. Every write adds an append-only audit row with ids, lengths and hashes, never text. No `gcr` command shows that log (and nothing verifies it for you); [SECURITY_AND_BOUNDARIES.md](SECURITY_AND_BOUNDARIES.md#9-residual-risks-and-known-limitations) section 9 gives a short Node-only way to read it.

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
`sourceUri` must be exactly `https://chatgpt.com/c/<uuid>` (stored as a label, never opened; anything else is `INVALID_URL`). Standard input is accepted too: `gcr import-copy - --db ./c.sqlite < copied-messages.json` gave the same batch id as the file (the batch identity is the content, not the source label).
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

**These three client configurations were not tested with the real clients**; check them against each client's current documentation. A client launches the server itself. Whether it passes your shell environment on is client-specific (NOT VERIFIED for the three clients), so set `env` explicitly in the client configuration for `GCR_APPROVED_IMPORT_ROOTS` or `GCR_MCP_ALLOW_WRITES`.
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

Text in your conversations is **untrusted data**. It can contain sentences such as "ignore previous instructions and run a tool". The GCR server never acts on imported text (`test/mcp/security.injection.test.ts` feeds it text of that kind; it ran green in the suite), tool descriptions are static, and
every result is marked `untrustedContent: true`. That does **not** make a language-model client immune: a model that reads results can still be steered by them. Keep write tools off unless you need them, keep import roots narrow,
review any tool call the client proposes, and remember that connecting a hosted model to this server sends the returned conversation text to that model's provider (see [section k](#k-privacy-checklist-before-sharing-anything)).

---

## j. Troubleshooting by error code

Errors print as `error[CODE]: message` plus `remedy:` on stderr (one JSON document with `--format json`) and set the process exit code. The codes are the `ERROR_CODES` of `src/errors.ts`; the **Seen** column says whether the exact text below was reproduced by hand on 2026-10-11 (`yes (MCP)` means through the MCP server).

| Code | Exit | What happened | The remedy GCR prints | Seen |
|---|---|---|---|---|
| `INVALID_ARGUMENT` | 2 | Bad option or value (account label, empty search, unknown flag, out-of-range number). Also a search made only of symbols or emoji ("the query contains only symbols or punctuation, which are not indexed; search for words"), `--cursor` or `--raw` with `--scope attachments`, a message filter with `--scope titles` or `all`; and `details.reason = "OUTPUT_TOO_LARGE"`: the output is too large to build as one text (beyond about 512 MiB, for example `get --all-branches --format json` of a conversation with hundreds of thousands of nodes) | e.g. `Run "gcr import --help" for usage.`; for `OUTPUT_TOO_LARGE`: "Ask for less: use --format jsonl (one JSON value per line), narrow the scope (one conversation or branch instead of --all-branches or a whole list), lower --limit, or page through the result with --offset." | yes (the argument errors); `OUTPUT_TOO_LARGE`: the code path and its exit code 2 were checked, a real 512 MiB output was not produced |
| `INVALID_URL` | 2 | Mode B `sourceUri` is not a chatgpt.com/c link | "Give the exact conversation link (https://chatgpt.com/c/<uuid>) or omit sourceUri. GCR stores it as a label only and never opens it." | yes |
| `INVALID_UUID` | 2 | Malformed id | "Use a link of the form https://chatgpt.com/c/<uuid> or a bare conversation UUID. GCR never opens the link ..." | yes |
| `UNSUPPORTED_URL` | 2 | Share link, other host, `http:`, port, other path | same remedy as above | yes |
| `NOT_IN_LOCAL_EXPORT` | 3 | The conversation (or graph node) is not in your database | "This conversation is not in the data you imported. GCR cannot fetch chatgpt.com conversations. Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>" | yes |
| `BRANCH_NOT_FOUND` | 3 | No such branch id (`details.reason` `unknown_branch`); a snapshot with no branch (`no_branches`); a stored message that no root reaches (`unreachable`, see section c) | "List the branches (gcr branches <conversation>) and pass one of the returned branch ids; a branch id is the id of its leaf message." | yes |
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
| `DB_SCHEMA_TOO_NEW` | 5 | The file was written by a newer GCR (checked on a copy with `PRAGMA user_version = 99`) | "Upgrade GCR, or use a different database file. The file was not modified." (the SHA-256 of the database file was unchanged after `list` and `import` were refused; a zero-byte `-wal` file and a 32 KiB `-shm` file appeared next to it, because SQLite creates them when it opens a WAL-mode file) | yes |
| `DB_MIGRATION_FAILED` | 5 | A schema migration failed and was rolled back | "The database was left at its previous version. Report the issue (without attaching private data)." | no (source text) |
| `DB_ERROR` | 5 | SQLite problem; on old Node, `details.reason = "FTS5_UNAVAILABLE"` (see below). Database-path refusals: `SYMLINK_DB_PATH` (a command that writes was given a `--db` symbolic link that is dangling or leads to an empty file: GCR never creates or initialises a database through a link; a read command answers `DB_NOT_FOUND` for a dangling link), `STRAY_SIDECAR_FILES` (a new database would be created beside an existing `-wal`, `-shm` or `-journal`), `not_a_regular_file` (a FIFO, device or socket), `not_gcr_database` (a SQLite file of another application; read commands say this instead of "not initialized") | e.g. the Node upgrade remedy; for `SYMLINK_DB_PATH` "Pass the real path of the database file instead of the link."; for `STRAY_SIDECAR_FILES` "Move or delete them yourself ..., or choose another --db path."; for `not_gcr_database` "Choose a different --db path." | yes (FTS5; the four path reasons were reproduced on 2026-10-12 with the built CLI) |
| `DB_ERROR` + `details.reason` `corrupt` | 5 | "The database file is damaged (malformed database image)." Reproduced with a copy of a database cut to its first 50,000 bytes | "Restore the database from a backup or re-import your export into a new file." **Read [Back up the database first](#back-up-the-database-first) before the second half of that advice:** a new file has none of your drafts and notes. Copy the damaged file (and its `-wal`/`-shm`) aside first and do not delete it; a refused `list` or `import` left the file itself byte-identical (a read may add empty `-wal`/`-shm` files beside it) | yes (2026-10-12) |
| `DB_ERROR` + `not_a_database` | 5 | "The file is not a SQLite database (or is encrypted)." Reproduced with random bytes, with text, and with a real database whose first 16 bytes were overwritten | "Choose a different --db path." Check that you named the right file; if it is a database of yours that was damaged, restore a backup (a refused `list` or `import` left the file byte-identical) | yes (2026-10-12) |
| `DB_ERROR` + `busy` | 5 | "The database is busy (locked by another process)." A command that writes (`import`, `graph build`, `draft`, `annotate`) waited about 5 seconds for another process that held a write transaction. Reads kept working in the test | "Close other programs using the database file, then retry." The holder in the test was a small Node program with an open write transaction; in practice another `gcr` command that is writing at that moment would do the same | yes (2026-10-12) |
| `DB_ERROR` + `needs_migration` | 5 | "The database has not been initialized." A read command on an empty (0-byte) file (for example one created with `touch`), or on a SQLite file that holds no tables at all; a SQLite file with the tables of another application is `not_gcr_database` instead | "Open the database once in read-write mode (for example by running an import) to initialize or migrate it." `gcr import <export.zip> --db <that file>` initialised a 0-byte file (tried). If the file was supposed to hold your data, it does not: look for a backup | yes (2026-10-12) |
| `DB_ERROR` + `is_directory` | 5 | "The database path is a directory." `--db` named a folder, for example `./.gcr` instead of `./.gcr/gcr.sqlite` | Name a file: `--db ./.gcr/gcr.sqlite`. (The printed remedy also suggests `gcr doctor --db <path>`.) Reads and imports both refuse it and create nothing | yes (2026-10-12) |
| `FTS_SYNTAX_ERROR` | 2 | Invalid `--raw` search syntax | see section d | yes |
| `WRITE_FORBIDDEN` | 6 | Write attempted on a read-only database or a read-only MCP server | "The operator can restart the server with --allow-local-writes ..." | yes (MCP) |
| `DRAFT_NOT_FOUND` | 3 | No draft with that id | "List drafts to find the id." | yes |
| `ANNOTATION_NOT_FOUND` | 3 | No annotation with that id | "List annotations to find the id." | yes |
| `ANNOTATION_CONFLICT` | 6 | Stale `--expected-version` | see section g | yes |
| `NOT_IMPLEMENTED` | 7 | Mode D (OpenAI API) access; emitted by the disabled adapter (`src/ingest/openai-api.ts`). `gcr import --provider openai_api` is rejected earlier as `INVALID_ARGUMENT` ("must be one of: chatgpt, claude"); `gcr list` and `gcr stats` accept `--provider openai_api` as a filter and return an empty result | n/a | no: the CLI never reaches it (tried) |
| `FEATURE_GATED` | 7 | Defined for browser-interaction features | **No code path in `src/` emits it** (searched); there is nothing to unlock | no |
| `REMOTE_ACCESS_FORBIDDEN` | 7 | Defined for anything that would touch a ChatGPT endpoint | **No code path in `src/` emits it**; no such feature exists | no |
| `INTERNAL_ERROR` | 1 | A bug; the raw message is withheld because it can hold paths or text | "Re-run with GCR_DEBUG=1 to print the stack trace to stderr, then report the issue without attaching private data." | no (source text) |

### Back up the database first

Your **drafts and annotations exist only in the database file** (section g). Your export ZIP can recreate the imported conversations (import again) and the graph (`gcr graph build`), but never your own drafts and notes. So, before an experiment, before upgrading, before a risky repair and before you import into a fresh file:

* Copy the database while no `gcr` process is running, together with its `-wal` and `-shm` files if they exist: `cp gcr.sqlite gcr.sqlite.bak` (a copy of just the `.sqlite` file was enough after a write command, which leaves no side files; with side files present, copy them as well, because recent changes may sit in the `-wal`). Checked: the backup copy listed the same draft as the original.
* Try risky things on a copy: `--db ./scratch.sqlite` costs nothing and never touches the original.
* Keep the backup as private as the database: it holds your full conversations (section k).
* A fresh re-import (`gcr import ... --db ./new.sqlite`) starts with no drafts and no notes (checked). To carry them over, print them before (`gcr draft show <id>`, `gcr annotate show <id> --format json`) and re-create them afterwards, or keep working in the old file.

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
* **A warning about "the default database ... is not owned by the current user"** on stderr means that `./.gcr/gcr.sqlite` (or the `./.gcr` folder) of the folder you are standing in belongs to somebody else, so that person may have prepared what is in it; its provenance and completeness are whatever they wrote. It appears for every command that opens the default database (and for `gcr mcp`), also on the first `import` into such a folder, and `--quiet` does not hide it. Stop and look, or use `--db <path>` / `GCR_DB` to choose a database you trust (a database named that way gets no warning, because you chose it). POSIX only; it is a warning, not a check of the content.
* A **first** import never touches files that are already there. It refuses to create a database beside an existing `<database>-wal`, `-shm` or `-journal` (`STRAY_SIDECAR_FILES`: move the file away, or pick another `--db`), and when it fails after it created the database it takes back only the files it created. Start the first import of a new path once; two first imports into the same new path at the same moment are not coordinated.
* Known limitations (an interrupted first import, a database in a read-only folder, per-handle read refusal during writes in the SDK, MCP result and deadline limits) are listed in [SECURITY_AND_BOUNDARIES.md](SECURITY_AND_BOUNDARIES.md#9-residual-risks-and-known-limitations) and [IMPORT_GUIDE.md](IMPORT_GUIDE.md) section 14; the author of this guide did not reproduce them (the checks ran as `root`, where folder permissions are not enforced).
* If your real export imports with many warnings, run `gcr audit` and read `formatProfile` in the import report; report the warning **codes** and counts, not the content.

---

## k. Privacy checklist before sharing anything

Your export and your GCR database contain your full conversations. GCR has no encryption and no way to redact. Before you send, attach, upload, commit or paste anything:

- [ ] **Not shared:** the export ZIP, the extracted folder, `conversations*.json`, the `.sqlite` database and its `-wal` / `-shm` files, the `.gcr/` folder, backups of any of these.
- [ ] **`graph.html`** contains labels from your conversations (titles, keywords, URLs). Treat it like the conversations.
- [ ] **Command output** (`list`, `get`, `search`, `branches`, `thread`, JSON from any command) contains titles and message text. So do screenshots. Pasting it into a hosted chat or an issue tracker discloses it.
- [ ] **MCP clients:** a hosted model connected to `gcr mcp` receives whatever the tools return. The GCR server itself has no network code; the client does. Decide knowingly which client and model may see which conversations.
- [ ] **Version control:** nothing from the list above is staged or committed (`git status`). Run `npm run build && node scripts/privacy-scan.mjs --root .`; it must say `clean`. Do not allow-list databases, archives or raw exports. Contributors: see "The privacy scanner and the opt-in git hooks" below.
- [ ] **Remote environments** (Codespaces, cloud agents, CI) are other people's computers. Do not copy a real export into them. CI uses synthetic fixtures only.
- [ ] **Bug reports:** include the error **code**, GCR version, Node version and command; do not attach a database, an export, a stack trace you have not read (it can hold paths) or output with message text. Use synthetic data to reproduce.
- [ ] **Other people's data:** your conversations may contain third-party personal data. Keep the database local and delete what you no longer need. GCR has no `delete` command in this version, so deleting means removing files: see [Delete your data](#delete-your-data) below (which files, stop `gcr mcp` first, no secure erase, no per-conversation delete, and your drafts and notes go with the database).
- [ ] **Drafts:** a draft is stored in the database in clear text. The continuation link is for you to open; GCR never sends the draft.
- [ ] **Disk:** the database sits unencrypted on whatever disk you choose; use full-disk encryption and sensible file permissions (GCR creates files `0600`, folders `0700`).
- [ ] **Whose database is it?** Without `--db`, `gcr` opens `./.gcr/gcr.sqlite` of the folder you are in. A stderr warning that it is "not owned by the current user" means someone else prepared that folder: stop, or choose your own database with `--db` / `GCR_DB`.

### Delete your data

GCR keeps everything in plain files on your disk and sends nothing anywhere, so deleting your data means deleting those files yourself. The file list below was checked on 2026-10-12 by importing the synthetic export into a scratch folder, running a few commands and listing the folder; what happens to the freed disk blocks cannot be checked from here (see "not a secure erase").

1. **Stop whatever has the database open.** Stop a running `gcr mcp`, and close the MCP client that started it or remove the server from its configuration (a client may start it again). Let a running `gcr import` finish.
2. **Delete the database and its side files, together.** The database is the file named by `--db`, else by `$GCR_DB`, else `./.gcr/gcr.sqlite` in the folder where you ran `gcr`. Next to it SQLite keeps `<name>-wal` and `<name>-shm` (and a `<name>-journal` if one ever appears). In the check, the commands that write (`import`, `graph build`, `draft create`) left only `gcr.sqlite`, while commands that only read (`list`, `get`, `graph export`, `gcr mcp` without `--allow-local-writes`) left an empty `-wal` and a 32 KiB `-shm` beside it; an import interrupted with Ctrl-C was seen to leave a `-wal` of tens of megabytes behind (a large synthetic import stopped with SIGINT, 2026-10-12; the database held no conversations afterwards). Stray side files are also why a new database is refused beside them: [SECURITY_AND_BOUNDARIES.md](SECURITY_AND_BOUNDARIES.md) section 4.1. So whichever commands you ran last, remove all three names. For the default location that is the whole `./.gcr` folder, which held nothing else (`rm -r ./.gcr`). Do not delete only the `.sqlite` file: a new database is never created beside a leftover `-wal`, `-shm` or `-journal` (`STRAY_SIDECAR_FILES`).
3. **Delete what GCR or you made from it.** Every graph page you exported (`gcr graph export --out graph.html` holds labels from your conversations), every file you saved command output to (`gcr get ... > thread.md`, `--format json > out.json`, screenshots), and the export itself: the ZIP you downloaded, any folder you extracted it to and any loose `conversations.json`.
4. **Look where GCR cannot.** Backups, synchronised or cloud folders, the trash, desktop search indexes, shell history that contains paths, a Codespace or any remote machine, and any MCP client or hosted model that was shown conversation text keep what they keep ([SECURITY_AND_BOUNDARIES.md](SECURITY_AND_BOUNDARIES.md) section 4.1).

What you **cannot** do, and what to know first:

* **There is no per-conversation delete, snapshot delete or prune.** `gcr delete` and `gcr prune` are unknown commands (exit 2), imported rows cannot be changed or deleted by GCR, and every import of a different export adds a snapshot, so the file only grows (ADR-0005). A draft can only be archived (`gcr draft archive` keeps its text in the database) and a note can only be replaced. The one way to remove a single conversation, snapshot, draft or note is to delete the whole database and, if you want the rest back, import into a new file.
* **Your drafts and notes are in the same database file** and are lost with it; a fresh re-import into a new file starts with none (checked). There is no export command for them, only printing. Before you delete or start over, print what you want to keep and save it somewhere private: `gcr draft list` and `gcr draft show <id>` (also with `--format json`), `gcr annotate list` and `gcr annotate show <id> --format json`.
* **Deleting a file is not a secure erase.** The database is plain SQLite (GCR has no encryption of its own), and removing a file only frees its blocks: on a solid-state disk, on a journaling or copy-on-write file system, and in a synchronised folder, remnants and copies may remain. Use full-disk encryption and delete the copies you made.
* **Nothing here touches your ChatGPT account** or anything OpenAI stores; what OpenAI keeps is governed by its own policies, which GCR did not review.

The same list from the security side: [SECURITY_AND_BOUNDARIES.md](SECURITY_AND_BOUNDARIES.md#44-retention-and-deletion) (section 4.4, "Retention and deletion").

### The privacy scanner and the opt-in git hooks (for contributors)

This section is for people who commit to the GCR repository, not for people who only read an export. The scanner needs `npm run build` first (`scripts/privacy-scan.mjs` loads `dist/devtools/privacy-scan.js`; a stale build does not know the newer flags); the installer does not, but the hooks it installs refuse to run without a built scanner. Nothing here uses the network, and none of it is a promise that private data cannot reach Git: the ignore rules and the hooks can be bypassed (`git add -f`, `git commit --no-verify`), so only the scan that CI runs is a gate, and CI has never run on GitHub. See [SECURITY_AND_BOUNDARIES.md](SECURITY_AND_BOUNDARIES.md) section 4.7 for the rules and section 9 for the gaps.

```bash
npm run build && node scripts/privacy-scan.mjs --root .   # work tree + the staged diff; exit 0 clean, 1 findings, 2 error
npm run privacy-scan:history                                # also every path and added line in all refs (what CI runs)
npm run privacy-scan:staged                                 # exactly what the next commit would record, read from the index
npm run hooks:install                                       # opt in: pre-commit (--staged) and pre-push (tree scan) hooks
```

* **`unscanned-large-file`.** A file above 2 MiB (`--max-file-bytes`) is no longer skipped: its first 256 KiB and last 64 KiB are judged by every rule, and the rest, which the scanner did not read, is a failing finding (exit 1). It goes away only if the exact path is listed in `.privacy-scan-allow`, the file lies below `node_modules`, `dist`, `dist-test*` or `coverage`, or you pass `--allow-large-unscanned`. **That flag is for local use only**: it turns `unscanned-large-file` and `scan-truncated` (a history or staged-diff pass cut by `--max-history-bytes`) into notes, so a clean result then proves less; CI never uses it. An export-shaped file without the synthetic marker is flagged under any name, large or not, because its shape is read from the head and the tail.
* **`gcr-output-file`.** Files that GCR itself wrote (a graph page, `--format json` or `jsonl` results of the CLI or the MCP server, Markdown or compact renderings, the renderings of drafts and annotations) hold titles, entity labels and message text, so saving them in the repository is a finding, whatever the file is called. Only a file under `fixtures/` that carries the synthetic marker is exempt.
* **`--staged` and the hooks.** `--staged` judges the index, so a secret that was staged and then edited away in the work tree is still found. `node scripts/install-git-hooks.mjs` (or `npm run hooks:install`) copies `scripts/git-hooks/pre-commit` (runs `--staged`) and `pre-push` (runs the normal scan) into `.git/hooks`; nothing is installed unless you run it, no git setting changes, a hook it did not write is not replaced without `--force` (the old file is kept as a backup), `--uninstall` removes only its own copies, and it stops if `core.hooksPath` is set. Both hooks refuse when `node` is missing, when the scanner is not built and when the scan finds something, and they print how to bypass knowingly (`git commit --no-verify`) and why not to: once a conversation, a database or a credential is in a commit it stays in the history after the file is deleted, and once pushed it has to be treated as leaked. **The pre-push hook scans the work tree and the index, not the commits that are being pushed**: use `--history` for those. The hooks are copies; run the installer again after `scripts/git-hooks/` changes.
* **Known weaknesses.** The synthetic marker `GCR-SYNTHETIC-FIXTURE` is a plain text match: a real export whose message text contains the literal marker is waived by it, so keep real exports out of the working tree altogether. Text in UTF-16 without a byte-order mark, and text padded with NUL bytes, is not judged by the secret rules. The middle of a large file, binary attachments of an unpacked export and encoded data are not judged.
