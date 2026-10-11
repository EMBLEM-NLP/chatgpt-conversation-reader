# GCR command-line reference

`gcr` is the command-line interface of GCR, the offline reader for your own ChatGPT export data. It is a thin adapter over the
SDK class `Gcr` ([`docs/SDK.md`](SDK.md)): everything it prints comes from an SDK result, and every failure it reports is an SDK
`GcrError`. The MCP server ([`gcr mcp`](#gcr-mcp)) is a second adapter over the same class.

* **Offline.** The CLI contains no network code of any kind. A `https://chatgpt.com/c/<uuid>` link is only a *key* into data you
  imported from an official export; it is never opened (see [NOT_IN_LOCAL_EXPORT](#exit-codes-and-errors)).
* **Local.** Everything lives in one SQLite file that you choose. Nothing is uploaded, synced or sent.
* **Scriptable.** `--format json` prints one JSON document on stdout, errors are one JSON document on stderr, and the exit code is
  stable per error code.
* **Text first.** No colour, no ANSI sequences, no spinners, no mouse; the output reads the same in a pipe, a log file and a screen
  reader.

The complete `--help` text of every command is captured in [`CLI_HELP.txt`](CLI_HELP.txt) (`npm run capture:cli-help`
regenerates it from the built CLI, and a test fails when it is stale). This page is the reference around it.

Contents: [Quick start](#quick-start) | [Conventions](#conventions) | [Global options](#global-options) | [Commands](#commands) |
[Exit codes and errors](#exit-codes-and-errors) | [Scripting recipes](#scripting-recipes) | [Privacy notes](#privacy-notes) |
[What the CLI deliberately cannot do](#what-the-cli-deliberately-cannot-do)

## Quick start

Requires the Node version in `package.json` `engines` (currently `>=22.16.0`, the first release whose `node:sqlite` includes FTS5).

```bash
npm ci && npm run build                 # once; the executable is dist/cli/main.js (package.json "bin": gcr)
node dist/cli/main.js doctor            # or, after `npm link`: gcr doctor

gcr import ~/Downloads/chatgpt-export.zip     # your official export (Settings > Data controls > Export data)
gcr list --limit 10
gcr get 00000000-0000-4000-8000-000000000001
gcr search "release notes" --format json | jq '.data.items[].snippet'
gcr graph build && gcr graph query "release"
```

All ids in this document are synthetic (`00000000-0000-4000-8000-<12 hex>`).

## Conventions

### Streams: stdout is the result, stderr is everything else

stdout carries **only** the command's result. Notes ("created ./.gcr ..."), progress lines and errors go to stderr, so
`gcr list --format json | jq` can never be corrupted by a diagnostic. On a successful run stderr is normally **empty**;
the only notes that exist are listed here: the creation of the default `./.gcr` directory, a hint that superseded snapshots were
searched (`search --all-batches`, human formats), and "reading from standard input" when a person types into a terminal.
`--quiet` suppresses notes; it never suppresses errors. Progress lines (import) are printed only when stderr is a terminal.

### Output formats (`--format`)

| Format | What you get | Use it for |
|---|---|---|
| `markdown` (default) | A titled document: a NOTICE when the data is not a complete export, provenance, the result, a *Warnings* section. Untrusted text is quoted or escaped so it cannot forge headings, links or tables. | reading |
| `compact` | Token-light plain text: a header line, a `# source:` line, then `[role] text` lines. Continuation lines are indented so imported text can never imitate a structural line. | pasting into a prompt, small logs |
| `json` | One JSON document: `{ ok, data, source, completeness, warnings, ids, untrustedContent, tool }`. | scripts |
| `jsonl` | One JSON value per line: a `header` line, one line per item (message, branch, conversation, ...), a `footer` line with the warnings. | streaming (`jq -c`) |

An unknown `--format` is `INVALID_ARGUMENT` and lists the valid values.

What `data` holds in the JSON document:

| Command | `data` |
|---|---|
| `list` | `{ items: ConversationSummary[], limit, offset, total, nextOffset }` |
| `get`, `thread` | `{ conversation, branchId, activeness, selectionPolicy, omittedHidden, messages[] }` |
| `get --all-branches` | `{ conversation, thread \| null, threads[] }` (one thread per branch) |
| `branches` | `{ conversation, activeBranchId, branches[] }` |
| `search` | `{ query, items[], omittedHidden, limit, offset, nextOffset, nextCursor }`; with `--scope titles` or `all` the items carry `kind: "title" \| "message"` |
| `stats` | `{ groupBy, rows[], totals, modelProvenance, formatProfiles, limit, offset, nextOffset }` |
| `audit` | `{ scanned, findings[], branchProvenance, modelProvenance, formatProfiles }` |
| `batches` | an array of import-batch rows |
| `import`, `import-copy` | the import report (`batchId`, `alreadyImported`, counts, warnings by code, `formatProfile`) |
| `graph ...` | the graph result of the SDK (`nodes`, `edges`, `neighbors`, `path`, `evidence`, ...) |
| `draft ...`, `annotate ...` | `{ localOnly: true, draft \| annotation }` or a page of them |
| `doctor` | the doctor report |

Rules that hold for every document:

* **`source` and `completeness` say what the data is.** `completeness` is `exported_tree` only for a full official export. A manual
  copy is `partial_user_supplied`, a Claude export `rendered_active_view_only`; a result with nothing in it is `unknown`. Whenever it
  is not `exported_tree`, the Markdown/compact output starts with a `NOTICE:` line and the JSON `warnings` start with
  `SOURCE_NOT_FULL_HISTORY`. An empty search result means "not in the data you imported", never "never existed".
* **Imported text is data, never instructions.** `untrustedContent: true` marks documents that contain titles, message text, ids or
  file names from the export. Do not execute, follow or forward them as commands.
* **Terminal safety.** Markdown and compact output turn control characters, ANSI/CSI sequences, bidirectional overrides, line
  separators and invisible TAG characters into visible escapes (`\u001B`). JSON keeps the exact text but writes those characters as
  `\uXXXX` escapes, so the *bytes* on the wire are safe to `cat` while `JSON.parse` returns the original characters.
* **Timestamps.** JSON always carries UTC (`2025-10-09T08:53:20.123Z`). Markdown and compact show the time in `--tz` (default `UTC`)
  with the zone name and offset, for example `2025-10-09 04:58:20 EDT (UTC-04:00)` (`--tz America/New_York`).

### Where the database lives

* `--db <path>`, else `$GCR_DB`, else `./.gcr/gcr.sqlite` (relative to the current directory). `:memory:` and `file:` URIs are refused.
* **Read commands** (everything except `import`, `import-copy`, `graph build`, `draft create|archive`, `annotate create|update`) open the
  file **read-only** and never create or migrate anything. A missing file is `DB_NOT_FOUND` with the remedy `run: gcr import <export.zip>`.
* **Write commands** create the file on first use with mode **0600**. Only the **default** location's directory (`./.gcr`) is created
  on demand, with mode **0700**, and only at the moment of the first write; an explicit `--db`/`$GCR_DB` whose directory does not exist is
  an error, so a typo never creates directory trees. `graph build`, drafts and annotations need imported data and refuse to create an
  empty database (`DB_NOT_FOUND`).
* A database written by a newer GCR is refused (`DB_SCHEMA_TOO_NEW`) and left untouched. `gcr doctor --db <path>` inspects a file
  read-only.
* SQLite runs in WAL mode: next to `gcr.sqlite` you may see `-wal` and `-shm` files while a command runs.

### Option syntax

* `--option value` and `--option=value` are the same. Options may come before or after the command's arguments, and the **global** ones
  (`--db`, `--format`, `--tz`) may even precede the command name: `gcr --db work.sqlite list`. Options that belong to one command go
  after its name.
* **`--` ends the options.** Everything after it is an argument, so `gcr search -- "-draft"` searches for `-draft`, and
  `gcr import --db x.sqlite -- -odd-name.zip` imports a file called `-odd-name.zip`. (`./-odd-name.zip` works too.)
* **A value that starts with a dash needs the `=` form:** `--db=-odd.sqlite`. `--db --format json` is an error ("needs a value"), not a
  database called `--format`.
* **Conversation references** (`<ref>`, `--conversation`) are a UUID or an exact `https://chatgpt.com/c/<uuid>` link, validated before the database is
  opened. An id that is not a UUID (GCR synthesizes one for an export element that has none; `gcr list` prints it) needs `--stored-id`.
* **A lone `-` is standard input** where a command reads input (`import -`, `import-copy -`, `--input -`). A file really named `-` is `./-`.
* **A value option given twice is an error** (`--limit 1 --limit 2`): GCR does not choose between two answers for you. Switches may repeat.
  List options (`--kinds`) accumulate repeats and commas: `--kinds url --kinds tool,keyword`.
* **Numbers** are plain decimal digits within the documented range. `1e3`, `0x10`, `5.0`, `+5`, ` 5` and `-1` are errors, as is a value
  outside the range (the message names the range).
* **Unknown commands and options are never executed or guessed.** They print the problem, the nearest known name by edit distance
  ("Did you mean ...?") and a pointer to `--help`, and exit 2. `--help` anywhere on a line (before `--`) wins over other errors on it.
* No option can send, post, open a browser or contact a server: there are none (a test checks every command and option name).

### Environment variables

| Variable | Effect |
|---|---|
| `GCR_DB` | Database path when `--db` is not given. `--db` wins. |
| `GCR_DEBUG` | `1` is the same as `--debug`: stack traces on stderr when a command fails, debug-level log lines from the shared logger. |
| `GCR_LOG_LEVEL` | `error`, `warn` (default), `info` or `debug`: threshold of the logger (stderr, content-free). |
| `GCR_APPROVED_IMPORT_ROOTS`, `GCR_MCP_ALLOW_WRITES`, `GCR_MCP_MAX_RESULT_BYTES` | Used by `gcr mcp` only (see the MCP documentation). |

Proxy variables, `NO_COLOR`/`FORCE_COLOR` and the terminal width are ignored: there is no network code and no colour.

### Signals, closed pipes, and the experimental-warning filter

* `gcr list | head -1`: when the reader of stdout goes away (EPIPE) the CLI closes the database and exits **0** silently.
* **SIGINT** (Ctrl-C) and **SIGTERM** close the database and exit **130** / **143**. An import that was in flight is rolled back by SQLite
  the next time the file is opened: a half-imported batch can never be read. (`gcr mcp` runs its own graceful shutdown and exits 0.)
* Node prints "SQLite is an experimental feature" when `node:sqlite` loads. The CLI (and the MCP entry) drop exactly that one
  `ExperimentalWarning` (matched by name and message) with `src/suppress-warnings.ts`; every other warning still reaches stderr.

## Global options

| Option | Meaning | Default |
|---|---|---|
| `--db <path>` | SQLite database file. | `$GCR_DB`, else `./.gcr/gcr.sqlite` |
| `--format <format>` | `json`, `markdown`, `compact` or `jsonl`. | `markdown` |
| `--tz <IANA>` | Time zone for human-readable times and for `stats --group-by day`. An unknown zone is `INVALID_ARGUMENT`. | `UTC` |
| `--quiet` | Suppress non-essential notes on stderr. Errors are always printed. | off |
| `--debug` | Stack traces on stderr when a command fails (sets `GCR_DEBUG=1`). | off |
| `-h`, `--help` | Help for the command (or for `gcr`). `gcr help <command>` is the same. | |
| `-V`, `--version` | Print `gcr <version>` (only without a command). | |

`gcr mcp` accepts only `--db`, `--quiet`, `--debug` and `--help`: its stdout belongs to the protocol.

## Commands

| Command | Purpose |
|---|---|
| [`doctor`](#gcr-doctor) | Check this machine and the database; list what GCR supports and what it does not. |
| [`import`](#gcr-import), [`import-copy`](#gcr-import-copy) | Bring an official export, or a manual copy, into the database. |
| [`batches`](#gcr-batches) | The import batches (one per distinct export). |
| [`list`](#gcr-list), [`get`](#gcr-get), [`thread`](#gcr-thread), [`branches`](#gcr-branches) | Read conversations. |
| [`search`](#gcr-search) | Full-text search over messages and titles. |
| [`stats`](#gcr-stats), [`audit`](#gcr-audit) | Counts, and data-quality / provenance checks. |
| [`graph`](#gcr-graph-build) `build\|query\|path\|neighbors\|god-nodes\|explain\|export` | The derived knowledge graph. |
| [`draft`](#gcr-draft-create) `create\|list\|show\|archive`, [`annotate`](#gcr-annotate-create) `create\|update\|list\|show` | Local drafts and notes (never sent). |
| [`mcp`](#gcr-mcp) | The local MCP server over stdio. |

The sections below are generated from the command table that also drives the parser and `--help`; a test fails when this page lacks
a command or one of its options.

### `gcr doctor`

Check this machine and the database; list what GCR supports and what it does not.

Fully offline: reports the Node version, node:sqlite and FTS5, the supported schema version, the state of the database file (read-only inspection, nothing is created or changed) and the capability modes A to E, stated honestly (for example "no live export verified").

Environment variables are reported as present or absent; their values are never read. Paths are reduced to file names.

```text
gcr doctor
```

Examples:

```bash
# Check the environment and the default database.
gcr doctor
# Inspect a specific database file, machine-readable.
gcr doctor --db ./work.sqlite --format json
```

Can fail with: `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1). doctor exits 0 when every check passes, 5 when the inspected database is unusable (newer schema, not a GCR database, unreadable) and 1 when the environment is missing a prerequisite (old Node, no FTS5). The report is printed in every case.

### `gcr import`

Import an official ChatGPT (or Claude) export into the local database.

The input is the ZIP you downloaded from ChatGPT (Settings > Data controls > Export data), an extracted folder, a conversations*.json file, or "-" for JSON on standard input. GCR never fetches an export and reads no browser data.

Importing is atomic and idempotent: the same input twice changes nothing, a newer export of the same conversations becomes the default snapshot and older ones are kept. The report shows counts and warning codes, never message text.

The database is created on first use (mode 0600). With no --db and no GCR_DB the default ./.gcr/gcr.sqlite is used and ./.gcr is created with mode 0700.

```text
gcr import <path> [options]
```

| Argument | Meaning |
|---|---|
| `<path>` | Export ZIP, extracted folder, conversations*.json file, or "-" for standard input (a file named "-" is written ./-). |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--account` | `<label>` | - | Label that keeps exports of different accounts apart (letters, digits, _ . @ - and spaces, up to 64). |
| `--provider` | chatgpt \| claude | detected from the file | Force the provider instead of detecting it from the file. |
| `--strict` | switch | - | Abort and store NOTHING if any conversation or manifest problem is found (default: record it as a warning and continue). |
| `--max-entries` | integer 1-100000000 | - | Safety limit: most entries a ZIP may hold. |
| `--max-entry-bytes` | integer 1-999999999999999 | - | Safety limit: largest uncompressed size of one ZIP entry. |
| `--max-total-bytes` | integer 1-999999999999999 | - | Safety limit: total uncompressed bytes read from one import. |
| `--max-ratio` | integer 1-1000000 | - | Safety limit: largest compression ratio of an entry (a decompression-bomb guard). |
| `--max-element-bytes` | integer 1-999999999999999 | - | Safety limit: largest single conversation in bytes (also bounds standard input). |

Examples:

```bash
# Import the ZIP into the default database.
gcr import ~/Downloads/chatgpt-export.zip
# Import an extracted folder into a chosen database under the account label "work".
gcr import ./export-folder --db ./work.sqlite --account work
# Read conversations.json from standard input; fail instead of skipping damaged conversations.
gcr import - --strict < conversations.json
# Tighten the per-conversation size limit to 64 MiB and print the report as JSON.
gcr import export.zip --max-element-bytes 67108864 --format json
```

Can fail with: `IMPORT_INPUT_NOT_FOUND` (4), `IMPORT_UNSUPPORTED_FORMAT` (4), `IMPORT_ZIP_UNSAFE` (4), `IMPORT_LIMIT_EXCEEDED` (4), `IMPORT_PARSE_ERROR` (4), `NOT_IMPLEMENTED` (7), `DB_SCHEMA_TOO_NEW` (5), `DB_MIGRATION_FAILED` (5), `DB_ERROR` (5), `WRITE_FORBIDDEN` (6), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr import-copy`

Index a manual copy of a conversation (Mode B). Always marked partial.

For text you copied out of a conversation yourself. The input is one JSON document: {"conversationId"?, "title"?, "sourceUri"?: "https://chatgpt.com/c/<uuid>", "messages": [{"role", "text", "createdAt"?, "modelSlug"?}]} with 1 to 10000 messages.

The result is always labelled partial_user_supplied: only the copied messages exist, no branch is invented and the active branch stays unknown. sourceUri is stored as a label and never opened.

```text
gcr import-copy <file> [options]
```

| Argument | Meaning |
|---|---|
| `<file>` | JSON file with the copied messages, or "-" for standard input. |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--account` | `<label>` | - | Label that keeps copies of different accounts apart. |

Examples:

```bash
# Index a copy; the output says completeness is partial_user_supplied.
gcr import-copy copied-messages.json
# Read the copy from standard input under the account label "work".
gcr import-copy - --account work --format json < copied-messages.json
```

Can fail with: `IMPORT_INPUT_NOT_FOUND` (4), `IMPORT_UNSUPPORTED_FORMAT` (4), `IMPORT_LIMIT_EXCEEDED` (4), `IMPORT_PARSE_ERROR` (4), `INVALID_URL` (2), `INVALID_UUID` (2), `DB_SCHEMA_TOO_NEW` (5), `DB_MIGRATION_FAILED` (5), `DB_ERROR` (5), `WRITE_FORBIDDEN` (6), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr batches`

List the import batches in the database (one per distinct export imported).

Use a batch id with --batch to read an older snapshot. Source file names are shown as basenames only.

```text
gcr batches
```

Examples:

```bash
# Every import with its counts, provenance and completeness.
gcr batches
# The same, machine-readable.
gcr batches --format json
```

Can fail with: `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr list`

List imported conversations.

Shows each conversation once (its newest imported snapshot) with id, title, message count, times and how complete its source is. Titles are untrusted text from your export.

```text
gcr list [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--sort` | updated \| created \| title | updated | Order: most recently updated, most recently created, or title A-Z. |
| `--title-query` | `<words>` | - | Only conversations whose title contains these words (full-text, plain mode). |
| `--provider` | chatgpt \| claude \| openai_api | - | Only conversations of this provider. |
| `--account` | `<label>` | - | Only conversations imported under this account label. |
| `--limit` | integer 1-500 | 50 | Maximum number of conversations (1-500). |
| `--offset` | integer 0-10000000 | 0 | Number of results to skip (paging). |
| `--all-batches` | switch | - | Include superseded import snapshots, not only the newest one of each conversation (every stored snapshot is listed). |

Examples:

```bash
# The 20 most recently updated conversations, as Markdown.
gcr list --limit 20
# ChatGPT conversations by title, machine-readable.
gcr list --provider chatgpt --sort title --format json
# Titles that mention "roadmap", with times shown in Berlin time.
gcr list --title-query roadmap --tz Europe/Berlin
```

Can fail with: `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr get`

Show one imported conversation (its active thread, or every branch).

The active thread is chosen by the export's own current-node pointer. If the export has none and the conversation has several branches, GCR refuses to guess (ACTIVE_BRANCH_UNKNOWN) unless you pass --branch, --all-branches or --branch-policy.

A chatgpt.com link succeeds only if that conversation is in your database; otherwise the command fails with NOT_IN_LOCAL_EXPORT. GCR never contacts chatgpt.com.

```text
gcr get <ref> [options]
```

| Argument | Meaning |
|---|---|
| `<ref>` | Conversation UUID or an exact https://chatgpt.com/c/<uuid> link. The link is only a key into data you imported; nothing is fetched. |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--branch` | `<id>` | - | Show this branch (a branch id is the id of its leaf message; list them with "gcr branches"). |
| `--branch-policy` | last_child \| latest_leaf | none: GCR never guesses the active branch | Opt in to a labelled heuristic when the export does not say which branch was active: last_child follows the last child from the root, latest_leaf takes the newest leaf. The result carries the warning ACTIVE_BRANCH_HEURISTIC. |
| `--all-branches` | switch | - | Also show every other branch (edited prompts, regenerated answers). With --format json the result holds one thread per branch. |
| `--include-hidden` | switch | - | Include messages the export marks as hidden (system scaffolding, memory, ...). |
| `--batch` | `<id>` | - | Read this import snapshot (a batch id from "gcr batches") instead of the newest one. |
| `--provider` | chatgpt \| claude \| openai_api | - | Disambiguate when the id exists under several providers. |
| `--account` | `<label>` | - | Disambiguate when the id exists under several accounts. |
| `--stored-id` | switch | - | Take the conversation as an id exactly as "gcr list" prints it. Needed only for ids that are not UUIDs (for example one GCR synthesized for an export that had none). Links are not accepted with this switch. |

Examples:

```bash
# Print the conversation as Markdown.
gcr get 00000000-0000-4000-8000-000000000001
# Look a link up in your local data and print JSON (fails with NOT_IN_LOCAL_EXPORT if it was never imported).
gcr get https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 --format json
# Every branch in token-light text.
gcr get 00000000-0000-4000-8000-000000000001 --all-branches --format compact
# Opt in to the newest-leaf heuristic when the export has no current node.
gcr get 00000000-0000-4000-8000-000000000001 --branch-policy latest_leaf
```

Can fail with: `INVALID_URL` (2), `INVALID_UUID` (2), `UNSUPPORTED_URL` (2), `NOT_IN_LOCAL_EXPORT` (3), `AMBIGUOUS_CONVERSATION` (3), `BRANCH_NOT_FOUND` (3), `ACTIVE_BRANCH_UNKNOWN` (3), `MESSAGE_NOT_FOUND` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr search`

Full-text search over message text and conversation titles.

The query is treated as plain words (operators and quotes are inert; a trailing * makes a prefix). Case and accents are ignored and CJK text matches by character. Use --raw to pass SQLite FTS5 syntax through.

Hidden messages are skipped unless --include-hidden. A query that starts with "-" goes after "--".

```text
gcr search <query> [options]
```

| Argument | Meaning |
|---|---|
| `<query>` | Words to search for (quote it when it has spaces). |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--raw` | switch | - | Pass the query to SQLite FTS5 unchanged (AND/OR/NEAR/phrases). A syntax error is FTS_SYNTAX_ERROR. |
| `--scope` | messages \| titles \| all | messages | Search message text, conversation titles, or both (titles first). |
| `--role` | `<role>` | - | Only messages by this author role (user, assistant, system, tool, ...). Messages scope only. |
| `--channel` | `<channel>` | - | Only messages on this channel (for example final). Messages scope only. |
| `--has-model` | switch | - | Only messages whose export states the model explicitly. Messages scope only. |
| `--conversation` | `<ref>` | - | Only inside this conversation (UUID, chatgpt.com link or stored id). Messages scope only. |
| `--after` | `<ISO>` | - | Only messages created at or after this ISO-8601 UTC time. Messages scope only. |
| `--before` | `<ISO>` | - | Only messages created before this ISO-8601 UTC time. Messages scope only. |
| `--include-hidden` | switch | - | Include messages the export marks as hidden (system scaffolding, memory, ...). |
| `--all-batches` | switch | - | Include superseded import snapshots, not only the newest one of each conversation (the same message can then appear once per snapshot). |
| `--provider` | chatgpt \| claude \| openai_api | - | Only conversations of this provider. |
| `--account` | `<label>` | - | Only conversations imported under this account label. |
| `--limit` | integer 1-200 | 20 | Maximum number of hits (1-200). |
| `--offset` | integer 0-10000000 | 0 | Number of results to skip (paging). |
| `--cursor` | `<cursor>` | - | Continue after the `nextCursor` printed by the previous page. |

Examples:

```bash
# Messages containing both words, best match first.
gcr search "marsupial habitat"
# Conversation titles that mention "roadmap".
gcr search roadmap --scope titles --format json
# Prefix match, assistant messages from 2025 on.
gcr search "quok*" --role assistant --after 2025-01-01T00:00:00Z --limit 5
# Inside one conversation; "--" lets the query start with a dash.
gcr search --conversation 00000000-0000-4000-8000-000000000001 -- "-draft"
```

Can fail with: `FTS_SYNTAX_ERROR` (2), `INVALID_URL` (2), `INVALID_UUID` (2), `UNSUPPORTED_URL` (2), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr branches`

List the branches of a conversation (edited prompts, regenerated answers).

A branch id is the id of its leaf message; pass it to "gcr thread --branch". The active branch is shown only when the export names it.

```text
gcr branches <ref> [options]
```

| Argument | Meaning |
|---|---|
| `<ref>` | Conversation UUID or an exact https://chatgpt.com/c/<uuid> link. The link is only a key into data you imported; nothing is fetched. |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--batch` | `<id>` | - | Read this import snapshot (a batch id from "gcr batches") instead of the newest one. |
| `--provider` | chatgpt \| claude \| openai_api | - | Disambiguate when the id exists under several providers. |
| `--account` | `<label>` | - | Disambiguate when the id exists under several accounts. |
| `--stored-id` | switch | - | Take the conversation as an id exactly as "gcr list" prints it. Needed only for ids that are not UUIDs (for example one GCR synthesized for an export that had none). Links are not accepted with this switch. |

Examples:

```bash
# All branches with their activeness.
gcr branches 00000000-0000-4000-8000-000000000001
# The same, looked up by link, as JSON.
gcr branches https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 --format json
```

Can fail with: `INVALID_URL` (2), `INVALID_UUID` (2), `UNSUPPORTED_URL` (2), `NOT_IN_LOCAL_EXPORT` (3), `AMBIGUOUS_CONVERSATION` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr thread`

Show one branch of a conversation as a message thread.

Like "gcr get" but always a single thread; use --branch to pick one from "gcr branches".

```text
gcr thread <ref> [options]
```

| Argument | Meaning |
|---|---|
| `<ref>` | Conversation UUID or an exact https://chatgpt.com/c/<uuid> link. The link is only a key into data you imported; nothing is fetched. |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--branch` | `<id>` | - | Show this branch (a branch id is the id of its leaf message; list them with "gcr branches"). |
| `--branch-policy` | last_child \| latest_leaf | none: GCR never guesses the active branch | Opt in to a labelled heuristic when the export does not say which branch was active: last_child follows the last child from the root, latest_leaf takes the newest leaf. The result carries the warning ACTIVE_BRANCH_HEURISTIC. |
| `--include-hidden` | switch | - | Include messages the export marks as hidden (system scaffolding, memory, ...). |
| `--batch` | `<id>` | - | Read this import snapshot (a batch id from "gcr batches") instead of the newest one. |
| `--provider` | chatgpt \| claude \| openai_api | - | Disambiguate when the id exists under several providers. |
| `--account` | `<label>` | - | Disambiguate when the id exists under several accounts. |
| `--stored-id` | switch | - | Take the conversation as an id exactly as "gcr list" prints it. Needed only for ids that are not UUIDs (for example one GCR synthesized for an export that had none). Links are not accepted with this switch. |

Examples:

```bash
# The active thread of a conversation.
gcr thread 00000000-0000-4000-8000-000000000001
# A specific branch, named by the id of its leaf message.
gcr thread 00000000-0000-4000-8000-000000000001 --branch 00000000-0000-4000-8000-000000000012
# One JSON value per line, for streaming tools.
gcr thread 00000000-0000-4000-8000-000000000001 --format jsonl
```

Can fail with: `INVALID_URL` (2), `INVALID_UUID` (2), `UNSUPPORTED_URL` (2), `NOT_IN_LOCAL_EXPORT` (3), `AMBIGUOUS_CONVERSATION` (3), `BRANCH_NOT_FOUND` (3), `ACTIVE_BRANCH_UNKNOWN` (3), `MESSAGE_NOT_FOUND` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr stats`

Count messages by role, model, channel, day, conversation, provider or content type.

Models are counted only where the export states one on the message; everything else is the single group "unknown (not supplied by source)". GCR never infers a model from timestamps or conversation defaults.

Grouping by day uses --tz for the day boundaries.

```text
gcr stats [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--group-by` | role \| model \| channel \| day \| conversation \| provider \| content_type | role | What to group the message counts by. |
| `--provider` | chatgpt \| claude \| openai_api | - | Only conversations of this provider. |
| `--account` | `<label>` | - | Only conversations imported under this account label. |
| `--role` | `<role>` | - | Only messages by this author role. |
| `--after` | `<ISO>` | - | Only messages created at or after this ISO-8601 UTC time. |
| `--before` | `<ISO>` | - | Only messages created before this ISO-8601 UTC time. |
| `--include-hidden` | switch | - | Include messages the export marks as hidden (system scaffolding, memory, ...). |
| `--all-batches` | switch | - | Include superseded import snapshots, not only the newest one of each conversation (every snapshot is counted). |
| `--limit` | integer 1-1000 | 100 | Maximum number of groups (1-1000). |
| `--offset` | integer 0-10000000 | 0 | Number of results to skip (paging). |

Examples:

```bash
# How many user, assistant, system and tool messages.
gcr stats --group-by role
# Messages per explicitly stated model, plus the "unknown" group.
gcr stats --group-by model --format json
# Messages per local calendar day since 2025.
gcr stats --group-by day --tz Asia/Kolkata --after 2025-01-01T00:00:00Z
```

Can fail with: `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr audit`

Check the imported data for gaps: missing models, empty or untitled conversations, broken trees.

Without check flags every check runs; with one or more flags only those do. The report holds counts and sample ids, never message text, and states how many branches have a known active branch and how many assistant messages state a model.

```text
gcr audit [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--missing-model` | switch | - | Assistant messages whose export does not state a model. |
| `--empty` | switch | - | Conversations with no messages. |
| `--untitled` | switch | - | Conversations without a title. |
| `--tree` | switch | - | Broken message trees: missing parents, cycles, child/parent mismatches. |
| `--no-current-node` | switch | - | Conversations whose export names no valid active branch. |
| `--unknown-roles` | switch | - | Author roles other than user, assistant, system and tool. |
| `--unknown-content-types` | switch | - | Content types GCR has no dedicated handling for. |
| `--timestamps` | switch | - | Missing or implausible timestamps. |
| `--hidden` | switch | - | Messages the export marks as hidden. |
| `--provider` | chatgpt \| claude \| openai_api | - | Only conversations of this provider. |
| `--account` | `<label>` | - | Only conversations imported under this account label. |
| `--all-batches` | switch | - | Include superseded import snapshots, not only the newest one of each conversation (every snapshot is audited). |
| `--sample` | integer 1-50 | 5 | Sample ids listed per finding (1-50). |

Examples:

```bash
# Run every check.
gcr audit
# Only these three checks.
gcr audit --missing-model --untitled --empty
# Branch provenance and tree integrity, machine-readable.
gcr audit --no-current-node --tree --format json
```

Can fail with: `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr graph build`

Build (or rebuild) the knowledge graph from the imported conversations.

Extracts URLs, UUIDs, timestamps, tool names, code languages, file names and keywords from message text (locally, with fixed patterns) and links the conversations they appear in. Only derived tables are rewritten; imported data is never touched. Rebuild after importing.

Every edge keeps its evidence (conversation, message and branch ids): see "gcr graph explain".

```text
gcr graph build [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--min-conversations` | integer 1-1000000 | 2 | Keep an entity only if it occurs in at least this many conversations (tool names are always kept). |
| `--kinds` | list: url, uuid, timestamp, tool, code_language, file_name, keyword | all | Entity kinds to extract. |
| `--provider` | chatgpt \| claude \| openai_api | - | Build the graph from this provider only. |
| `--account` | `<label>` | - | Build the graph from this account label only. |

Examples:

```bash
# Build the graph from everything imported.
gcr graph build
# Keep only URLs and tool names that occur in at least three conversations.
gcr graph build --min-conversations 3 --kinds url,tool --format json
```

Can fail with: `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `WRITE_FORBIDDEN` (6), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr graph query`

Show the neighbourhood of a term in the graph (breadth-first).

The term is matched against node labels and ids (plain text). Results are bounded by --depth and --max-nodes, and truncation is reported.

```text
gcr graph query <term> [options]
```

| Argument | Meaning |
|---|---|
| `<term>` | Word or phrase to look for in node labels (quote it when it has spaces). |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--depth` | integer 1-4 | 2 | How many hops to follow from the matching nodes (1-4). |
| `--max-nodes` | integer 1-500 | 100 | Most nodes in the answer (1-500). |
| `--kinds` | list: conversation, entity, tool, url, uuid, timestamp, tool, code_language, file_name, keyword | - | Only nodes of these node kinds or entity kinds. |

Examples:

```bash
# Everything within two hops of nodes that mention "quokka".
gcr graph query quokka
# URL nodes next to "release notes", machine-readable.
gcr graph query "release notes" --depth 1 --kinds url --format json
```

Can fail with: `NOT_IN_LOCAL_EXPORT` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr graph path`

Find the shortest path between two graph nodes.

Node ids are printed by "gcr graph query" and "gcr graph god-nodes".

A search budget bounds the work; if it is exhausted the answer says "not found within the budget", not "no path exists".

```text
gcr graph path <from> <to> [options]
```

| Argument | Meaning |
|---|---|
| `<from>` | Node id to start from. |
| `<to>` | Node id to reach. |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--max-depth` | integer 1-12 | 6 | Longest path in hops (1-12). |

Examples:

```bash
# The shortest chain of shared entities between two conversations (use the ids printed by graph query).
gcr graph path conv:chatgpt:default:00000000-0000-4000-8000-000000000001 conv:chatgpt:default:00000000-0000-4000-8000-000000000002
# Limit the search to three hops.
gcr graph path tool:python ent:keyword:quokka --max-depth 3 --format json
```

Can fail with: `NOT_IN_LOCAL_EXPORT` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr graph neighbors`

List the direct neighbours of one graph node.

Node ids are printed by "gcr graph query" and "gcr graph god-nodes".

```text
gcr graph neighbors <node> [options]
```

| Argument | Meaning |
|---|---|
| `<node>` | Node id. |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--limit` | integer 1-500 | 50 | Maximum number of neighbours (1-500). |
| `--kinds` | list: conversation, entity, tool, url, uuid, timestamp, tool, code_language, file_name, keyword | - | Only neighbours of these node kinds or entity kinds. |
| `--edge-kinds` | list: mentioned_in, co_occurs, uses_tool | - | Only follow edges of these kinds. |

Examples:

```bash
# The ten strongest neighbours of a conversation node.
gcr graph neighbors conv:chatgpt:default:00000000-0000-4000-8000-000000000001 --limit 10
# Only the tools a conversation used.
gcr graph neighbors conv:chatgpt:default:00000000-0000-4000-8000-000000000001 --edge-kinds uses_tool --format json
```

Can fail with: `NOT_IN_LOCAL_EXPORT` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr graph god-nodes`

List the most connected nodes (highest weighted degree).

Useful as a map of what your conversations are about: the entities and tools that appear everywhere.

```text
gcr graph god-nodes [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--limit` | integer 1-500 | 10 | Maximum number of nodes (1-500). |
| `--kinds` | list: conversation, entity, tool, url, uuid, timestamp, tool, code_language, file_name, keyword | - | Only nodes of these node kinds or entity kinds. |

Examples:

```bash
# The ten most connected nodes.
gcr graph god-nodes
# The 25 most connected tools and URLs.
gcr graph god-nodes --limit 25 --kinds tool,url --format json
```

Can fail with: `NOT_IN_LOCAL_EXPORT` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr graph explain`

Show the evidence behind one graph edge: the messages and branches that support it.

Name the edge by its numeric id (from graph query or neighbors) or by its source node, target node and kind. Every graph fact traces back to message ids and the branch ids that contain them.

```text
gcr graph explain <edge-id> [options]
gcr graph explain <src> <dst> <kind> [options]
```

| Argument | Meaning |
|---|---|
| `<edge-id>` | Numeric edge id, or the source node id when dst and kind follow. |
| `<dst>` (optional) | Target node id. |
| `<kind>` (optional) | Edge kind: mentioned_in, co_occurs or uses_tool. |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--limit` | integer 1-1000 | 100 | Most evidence rows (1-1000). |

Examples:

```bash
# Evidence for edge number 12.
gcr graph explain 12
# Evidence for the co-occurrence edge between two nodes.
gcr graph explain ent:keyword:marsupial ent:keyword:quokka co_occurs --format json
```

Can fail with: `NOT_IN_LOCAL_EXPORT` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr graph export`

Write the graph (or the neighbourhood of a term) as a self-contained offline HTML page.

The page loads nothing from the network and escapes every label. It contains labels from your conversations, so the file is created with mode 0600. An existing file is never overwritten unless --force is given, and a symbolic link is never written through.

Prints the path written (JSON output prints only the file name).

```text
gcr graph export [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--out` | `<file.html>` | - | File to create (required; must end in .html and its directory must exist). |
| `--force` | switch | - | Replace an existing regular file. Links and directories are still refused. |
| `--term` | `<term>` | - | Export the neighbourhood of this term instead of the most connected nodes. |
| `--depth` | integer 1-4 | 2 | Hops to follow from the term (with --term). |
| `--max-nodes` | integer 1-500 | 100 | Most nodes on the page (1-500). |
| `--kinds` | list: conversation, entity, tool, url, uuid, timestamp, tool, code_language, file_name, keyword | - | Only nodes of these node kinds or entity kinds. |
| `--title` | `<text>` | GCR graph export | Page title (up to 200 characters). |

Examples:

```bash
# The most connected nodes of the whole graph.
gcr graph export --out graph.html
# The neighbourhood of "quokka", replacing quokka.html if it exists.
gcr graph export --term quokka --depth 2 --out quokka.html --force
```

Can fail with: `NOT_IN_LOCAL_EXPORT` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr draft create`

Save a local draft for a conversation (it is never sent).

GCR never sends messages. No command or option sends, posts or opens a browser.

The draft is stored in your database. The output gives its id and the link of the conversation for YOU to open and paste the text into yourself.

```text
gcr draft create [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--conversation` | `<ref>` | - | (required) The conversation the draft belongs to. Conversation UUID or an exact https://chatgpt.com/c/<uuid> link (only a key into your imported data). |
| `--input` | `<file|->` | - | (required) File with the text, or "-" for standard input. At most 256 KiB, UTF-8; a directory or a link pointing outside its own directory is refused. |
| `--message-id` | `<id>` | - | Anchor the draft to this message of the conversation. |
| `--title` | `<text>` | - | Short title (up to 200 characters). |
| `--namespace` | `<name>` | default | Namespace to keep drafts of different purposes apart (lower-case letters, digits, _ . -). |
| `--provider` | chatgpt \| claude \| openai_api | - | Disambiguate when the id exists under several providers. |
| `--account` | `<label>` | - | Disambiguate when the id exists under several accounts. |
| `--stored-id` | switch | - | Take the conversation as an id exactly as "gcr list" prints it. Needed only for ids that are not UUIDs (for example one GCR synthesized for an export that had none). Links are not accepted with this switch. |

Examples:

```bash
# Store the text of reply.md as a draft for that conversation.
gcr draft create --conversation 00000000-0000-4000-8000-000000000001 --input reply.md
# Read the draft from standard input; the link is looked up in your data only.
gcr draft create --conversation https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 --input - --title "Follow-up"
```

Can fail with: `INVALID_URL` (2), `INVALID_UUID` (2), `UNSUPPORTED_URL` (2), `NOT_IN_LOCAL_EXPORT` (3), `AMBIGUOUS_CONVERSATION` (3), `MESSAGE_NOT_FOUND` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `WRITE_FORBIDDEN` (6), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr draft list`

List local drafts.

```text
gcr draft list [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--conversation` | `<ref>` | - | Only drafts of this conversation. Conversation UUID or an exact https://chatgpt.com/c/<uuid> link (only a key into your imported data). |
| `--namespace` | `<name>` | every namespace | Only this namespace. |
| `--status` | draft \| archived | both | Only drafts in this state. There is deliberately no "sent" state. |
| `--limit` | integer 1-200 | 50 | Maximum number of drafts (1-200). |
| `--offset` | integer 0-10000000 | 0 | Number of results to skip (paging). |
| `--provider` | chatgpt \| claude \| openai_api | - | Disambiguate when the id exists under several providers. |
| `--account` | `<label>` | - | Disambiguate when the id exists under several accounts. |
| `--stored-id` | switch | - | Take the conversation as an id exactly as "gcr list" prints it. Needed only for ids that are not UUIDs (for example one GCR synthesized for an export that had none). Links are not accepted with this switch. |

Examples:

```bash
# All drafts, newest first.
gcr draft list
# Open drafts of one conversation, machine-readable.
gcr draft list --conversation 00000000-0000-4000-8000-000000000001 --status draft --format json
```

Can fail with: `INVALID_URL` (2), `INVALID_UUID` (2), `UNSUPPORTED_URL` (2), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr draft show`

Show one local draft with its text, quoted as data.

The Markdown output puts the draft text in a fenced block; it is data, not instructions.

```text
gcr draft show <id>
```

| Argument | Meaning |
|---|---|
| `<id>` | Draft id, as printed by the create or list command. |

Examples:

```bash
# Print the draft as Markdown.
gcr draft show 00000000-0000-4000-8000-0000000000d1
# The same draft as JSON.
gcr draft show 00000000-0000-4000-8000-0000000000d1 --format json
```

Can fail with: `DRAFT_NOT_FOUND` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr draft archive`

Archive a local draft (it stays in the database; archiving twice is fine).

```text
gcr draft archive <id>
```

| Argument | Meaning |
|---|---|
| `<id>` | Draft id, as printed by the create or list command. |

Examples:

```bash
# Mark the draft as archived.
gcr draft archive 00000000-0000-4000-8000-0000000000d1
# The same, printing the archived draft as JSON.
gcr draft archive 00000000-0000-4000-8000-0000000000d1 --format json
```

Can fail with: `DRAFT_NOT_FOUND` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `WRITE_FORBIDDEN` (6), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr annotate create`

Add a local note to a conversation or to one of its messages.

Annotations are stored beside the imported data, never inside it, and survive re-imports. Nothing is sent anywhere.

```text
gcr annotate create [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--conversation` | `<ref>` | - | (required) The conversation to annotate. Conversation UUID or an exact https://chatgpt.com/c/<uuid> link (only a key into your imported data). |
| `--input` | `<file|->` | - | (required) File with the text, or "-" for standard input. At most 256 KiB, UTF-8; a directory or a link pointing outside its own directory is refused. |
| `--message-id` | `<id>` | - | Annotate this message instead of the whole conversation. |
| `--kind` | `<kind>` | note | Kind of note (lower-case letters, digits and _, up to 32). |
| `--namespace` | `<name>` | default | Namespace to keep notes of different purposes apart. |
| `--provider` | chatgpt \| claude \| openai_api | - | Disambiguate when the id exists under several providers. |
| `--account` | `<label>` | - | Disambiguate when the id exists under several accounts. |
| `--stored-id` | switch | - | Take the conversation as an id exactly as "gcr list" prints it. Needed only for ids that are not UUIDs (for example one GCR synthesized for an export that had none). Links are not accepted with this switch. |

Examples:

```bash
# A conversation-level note from a file.
gcr annotate create --conversation 00000000-0000-4000-8000-000000000001 --input note.txt
# A "todo" note on one message, text from standard input.
gcr annotate create --conversation 00000000-0000-4000-8000-000000000001 --message-id 00000000-0000-4000-8000-000000000011 --kind todo --input -
```

Can fail with: `INVALID_URL` (2), `INVALID_UUID` (2), `UNSUPPORTED_URL` (2), `NOT_IN_LOCAL_EXPORT` (3), `AMBIGUOUS_CONVERSATION` (3), `MESSAGE_NOT_FOUND` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `WRITE_FORBIDDEN` (6), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr annotate update`

Replace the text of a local note (optimistic concurrency).

Pass the version you last saw. If someone else changed the note meanwhile the command fails with ANNOTATION_CONFLICT instead of overwriting their change; read it again and retry with the new version.

```text
gcr annotate update <id> [options]
```

| Argument | Meaning |
|---|---|
| `<id>` | Annotation id, as printed by the create or list command. |

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--input` | `<file|->` | - | (required) File with the text, or "-" for standard input. At most 256 KiB, UTF-8; a directory or a link pointing outside its own directory is refused. |
| `--expected-version` | integer 1-1000000000 | - | (required) The version of the note you read last (printed by create, show and list). |

Examples:

```bash
# Replace the text of version 1.
gcr annotate update 00000000-0000-4000-8000-0000000000a1 --input note.txt --expected-version 1
# Text from standard input, result as JSON.
gcr annotate update 00000000-0000-4000-8000-0000000000a1 --input - --expected-version 2 --format json
```

Can fail with: `ANNOTATION_NOT_FOUND` (3), `ANNOTATION_CONFLICT` (6), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `WRITE_FORBIDDEN` (6), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr annotate list`

List local notes.

```text
gcr annotate list [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--conversation` | `<ref>` | - | Only notes of this conversation. Conversation UUID or an exact https://chatgpt.com/c/<uuid> link (only a key into your imported data). |
| `--message-id` | `<id>` | - | Only notes on this message (needs --conversation). |
| `--kind` | `<kind>` | - | Only notes of this kind. |
| `--namespace` | `<name>` | every namespace | Only this namespace. |
| `--limit` | integer 1-200 | 50 | Maximum number of notes (1-200). |
| `--offset` | integer 0-10000000 | 0 | Number of results to skip (paging). |
| `--provider` | chatgpt \| claude \| openai_api | - | Disambiguate when the id exists under several providers. |
| `--account` | `<label>` | - | Disambiguate when the id exists under several accounts. |
| `--stored-id` | switch | - | Take the conversation as an id exactly as "gcr list" prints it. Needed only for ids that are not UUIDs (for example one GCR synthesized for an export that had none). Links are not accepted with this switch. |

Examples:

```bash
# All notes, newest first.
gcr annotate list
# The "todo" notes of one conversation.
gcr annotate list --conversation 00000000-0000-4000-8000-000000000001 --kind todo --format json
```

Can fail with: `INVALID_URL` (2), `INVALID_UUID` (2), `UNSUPPORTED_URL` (2), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr annotate show`

Show one local note (its text is quoted as data in the JSON form).

```text
gcr annotate show <id>
```

| Argument | Meaning |
|---|---|
| `<id>` | Annotation id, as printed by the create or list command. |

Examples:

```bash
# Print the note's metadata as Markdown.
gcr annotate show 00000000-0000-4000-8000-0000000000a1
# The note including its text, as JSON.
gcr annotate show 00000000-0000-4000-8000-0000000000a1 --format json
```

Can fail with: `ANNOTATION_NOT_FOUND` (3), `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1).

### `gcr mcp`

Run the local MCP server on stdio over the database.

Speaks the Model Context Protocol over stdin/stdout for an MCP client such as VS Code or Codex. While it runs NOTHING but JSON-RPC is written to stdout; logs go to stderr. The database is opened read-only unless --allow-local-writes is given.

Read tools: list, get, search, branches, thread, stats, audit, graph query. With --allow-local-writes the server may also create local drafts and annotations (it can never send a message anywhere). Importing through MCP additionally needs GCR_APPROVED_IMPORT_ROOTS.

The server exits cleanly when its input closes. It handles SIGINT and SIGTERM itself and then exits 0 after closing the database.

```text
gcr mcp [options]
```

| Option | Value | Default | Meaning |
|---|---|---|---|
| `--allow-local-writes` | switch | - | Let MCP clients create local drafts and annotations (and, with approved roots, import). Without it the database is read-only. |

Examples:

```bash
# Read-only MCP server over work.sqlite (configure your MCP client to run exactly this command).
gcr mcp --db ./work.sqlite
# Also allow local drafts and annotations.
gcr mcp --db ./work.sqlite --allow-local-writes
```

Can fail with: `DB_NOT_FOUND` (5), `DB_SCHEMA_TOO_NEW` (5), `DB_ERROR` (5), `INVALID_ARGUMENT` (2), `INTERNAL_ERROR` (1). The exit code is the one the server reports: 0 after a clean shutdown, otherwise the code of the failure.

## Exit codes and errors

Every failure is an SDK `GcrError` with a stable `code`; the process exit code is `EXIT_CODES[code]` (`src/errors.ts`). `0` is success.
Anything that is *not* a `GcrError` (a bug) is reported as `INTERNAL_ERROR` with a generic message and exit code 1: raw messages from
SQLite, the file system or a parser can contain paths or conversation text, so they are never forwarded. Re-run with `--debug` to see the
stack, and report it without private data.

### The error contract

* **stdout stays empty** when a command fails.
* **Text mode** (any `--format` except `json`): stderr is `error[CODE]: message`, then an indented `remedy:` line (every error the CLI prints
  has one; SDK validation errors get a pointer to the command's `--help`):

  ```text
  error[NOT_IN_LOCAL_EXPORT]: The conversation is not present in the locally imported data.
    remedy: This conversation is not in the data you imported. GCR cannot fetch chatgpt.com conversations. Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>
  ```

* **`--format json`**: stderr is the `ErrorEnvelope` of `src/errors.ts` as **one line of JSON**, and nothing else:

  ```json
  {"ok":false,"error":{"code":"NOT_IN_LOCAL_EXPORT","message":"The conversation is not present in the locally imported data.","remedy":"...","details":{"conversationId":"00000000-0000-4000-8000-0000000000ff","provider":"chatgpt"}},"warnings":[]}
  ```

  `details` holds ids, limits and counts, never conversation text; the offending value of an argument is never echoed (a link may carry a
  token in its query string).
* **`--debug`** adds the stack and the cause chain: in text mode as an indented `debug:` block, in JSON mode as `error.details.stack`.
* Errors found while reading the command line (unknown command or option, a bad number, a missing value) are `INVALID_ARGUMENT` and exit 2
  *before* any file is opened or written. Conversation references are validated before the database is touched: a malformed id or a
  share link exits 2 whatever the state of the database.

### Exit code table

| Code | Exit | When the CLI reports it | What to do |
|---|---|---|---|
| `INVALID_ARGUMENT` | 2 | Bad command line: unknown command/option, missing or repeated value, number out of range, bad `--format`/`--tz`, an SDK-side validation failure, an input file that is a directory or too large. | Read the message; `gcr <command> --help`. |
| `INVALID_URL` | 2 | A link that is not a well-formed canonical `https://` URL (no scheme separator, backslashes, percent-encoding in the path, over 2048 characters). | Use `https://chatgpt.com/c/<uuid>` or a bare UUID. |
| `INVALID_UUID` | 2 | A reference that is not a UUID, or a link whose id is not one. | Use the UUID from `gcr list`. |
| `UNSUPPORTED_URL` | 2 | Share links (`/share/...`), other hosts (`www.`, `chat.openai.com`), `http:`, ports, user info, extra path segments. | Only `https://chatgpt.com/c/<uuid>` is accepted, and only as a key into your data. |
| `FTS_SYNTAX_ERROR` | 2 | `search --raw` with FTS5 syntax that SQLite rejects. | Drop `--raw` (plain mode makes operators inert) or fix the expression. |
| `NOT_IN_LOCAL_EXPORT` | 3 | The conversation, batch or graph node is not in the local data. **Never guessed, never fetched.** | Request your official export (ChatGPT Settings > Data controls > Export data) and `gcr import` it. |
| `BRANCH_NOT_FOUND` | 3 | `--branch` names a branch that does not exist; a snapshot without branches. | `gcr branches <ref>` and pass one of the ids. |
| `MESSAGE_NOT_FOUND` | 3 | `--message-id` of a draft or note is not in the conversation. | Use a message id from `gcr get --format json`. |
| `AMBIGUOUS_CONVERSATION` | 3 | The id exists under several providers or accounts. | Add `--provider` and `--account`. |
| `ACTIVE_BRANCH_UNKNOWN` | 3 | The export names no active branch and the conversation has several. **GCR does not guess.** | `--branch <id>`, `--all-branches`, or opt in with `--branch-policy last_child\|latest_leaf`; the result is then labelled `ACTIVE_BRANCH_HEURISTIC`. |
| `DRAFT_NOT_FOUND` | 3 | Unknown draft id. | `gcr draft list`. |
| `ANNOTATION_NOT_FOUND` | 3 | Unknown note id. | `gcr annotate list`. |
| `IMPORT_INPUT_NOT_FOUND` | 4 | The path given to `import`/`import-copy` does not exist or cannot be read. Nothing is created. | Check the path. GCR never downloads anything. |
| `IMPORT_UNSUPPORTED_FORMAT` | 4 | Not an official export (no `conversations*.json`), mixed providers, a directory or non-UTF-8 manual copy. | Import the ZIP, the extracted folder or the file itself. |
| `IMPORT_ZIP_UNSAFE` | 4 | Path traversal, symlink, encrypted or duplicate entries, bad structure. Nothing is extracted. | Download a fresh export; do not import archives from untrusted sources. |
| `IMPORT_LIMIT_EXCEEDED` | 4 | A safety limit tripped (entries, entry size, total size, compression ratio, element size) or an input over its size bound. | Raise the named `--max-*` flag only for input you trust. |
| `IMPORT_PARSE_ERROR` | 4 | Malformed JSON (a truncated export) under `--strict`, or an invalid manual-copy document. | Obtain a fresh export; without `--strict` the readable part is imported and the damage is reported. |
| `IMPORT_PATH_NOT_ALLOWED` | 4 | Raised by the MCP adapter only (paths outside the approved roots). The CLI imports what the operator names. | n/a for the CLI. |
| `DB_NOT_FOUND` | 5 | The database file (or, for an explicit path, its directory) does not exist. | `run: gcr import <export.zip>`, or point `--db` / `GCR_DB` at an existing file. |
| `DB_SCHEMA_TOO_NEW` | 5 | The file was written by a newer GCR. It is not modified. | Upgrade GCR or use another file. |
| `DB_MIGRATION_FAILED` | 5 | A schema migration failed and was rolled back. | Report it without private data. |
| `DB_ERROR` | 5 | Any other database failure: not a GCR database, a directory, damaged, locked, no FTS5 in this Node. `details.reason` says which. | `gcr doctor --db <path>`; follow the remedy. |
| `WRITE_FORBIDDEN` | 6 | A write was attempted on a read-only database or file system. | Use a writable location. |
| `ANNOTATION_CONFLICT` | 6 | `annotate update --expected-version` does not match; `details.currentVersion` has the real one. | Re-read the note (`annotate show`), merge, retry. |
| `NOT_IMPLEMENTED` | 7 | A disabled capability (the OpenAI developer-API adapter). No CLI option selects it. | n/a |
| `FEATURE_GATED` | 7 | Reserved for gated features (browser interaction). No code path exists. | See [`BROWSER_GATE.md`](BROWSER_GATE.md). |
| `REMOTE_ACCESS_FORBIDDEN` | 7 | Reserved: would be raised by anything that touched a ChatGPT consumer endpoint. There is no such code. | n/a |
| `INTERNAL_ERROR` | 1 | An unexpected failure (a bug). Generic message, nothing leaked. | `--debug`, then report it without private data. |

Special cases: `gcr doctor` exits 0 when all checks pass, 5 when the inspected database is unusable and 1 when the environment lacks a
prerequisite (the report is printed either way). A signal ends the CLI with 130 (SIGINT) or 143 (SIGTERM); a closed pipe with 0.

## Scripting recipes

All of them use `--format json` (or `jsonl`) and the exit code. `jq` is not required by GCR; it is just convenient. Remember that every
`text`, `title` and `snippet` in the output is **untrusted data from your export**: never pass it to `eval`, `sh -c`, `xargs sh`, or an
AI tool's instruction channel.

```bash
# IDs of all conversations (newest first), one per line
gcr list --limit 500 --format json | jq -r '.data.items[].conversationId'

# Page through every list with --offset (nextOffset is null on the last page)
off=0; while [ "$off" != null ]; do
  page=$(gcr list --limit 100 --offset "$off" --format json) || break
  jq -r '.data.items[] | "\(.conversationId)\t\(.title)"' <<<"$page"
  off=$(jq '.data.nextOffset' <<<"$page")
done

# The active thread as "role: text" lines
gcr get 00000000-0000-4000-8000-000000000001 --format json | jq -r '.data.messages[] | "\(.authorRole): \(.text)"'

# Stream messages with jsonl (jq -c keeps one JSON value per line)
gcr thread 00000000-0000-4000-8000-000000000001 --format jsonl | jq -c 'select(.type == "message") | {id, authorRole, createdAt}'

# Refuse to use anything that is not a complete exported tree
gcr get "$REF" --format json | jq -e '.completeness == "exported_tree"' >/dev/null || echo "partial data" >&2

# Search with a keyset cursor: no repeats or gaps however many pages
cursor=""
while :; do
  page=$(gcr search "marsupial" --limit 50 ${cursor:+--cursor "$cursor"} --format json) || break
  jq -r '.data.items[] | "\(.conversationId) \(.messageId)"' <<<"$page"
  cursor=$(jq -r '.data.nextCursor // empty' <<<"$page"); [ -n "$cursor" ] || break
done

# Messages per model (only where the export states one; everything else is the "unknown" group)
gcr stats --group-by model --format json | jq -r '.data.rows[] | "\(.messages)\t\(.label)"'

# Data-quality gate for CI: fail when any conversation has no title
gcr audit --untitled --format json | jq -e '.data.findings[0].count == 0' >/dev/null

# Branch ids, then one branch
gcr branches 00000000-0000-4000-8000-000000000001 --format json | jq -r '.data.branches[] | "\(.activeness)\t\(.branchId)"'

# React to the stable exit codes, and read the JSON error from stderr
if ! out=$(gcr get "$REF" --format json 2>err.json); then
  case $? in
    3) jq -r '.error.code + ": " + .error.remedy' err.json ;;   # NOT_IN_LOCAL_EXPORT, ACTIVE_BRANCH_UNKNOWN, ...
    5) echo "database problem: $(jq -r .error.code err.json)" >&2 ;;
    *) cat err.json >&2 ;;
  esac
fi

# Idempotent re-import from cron: the same export twice changes nothing
gcr import ~/Downloads/chatgpt-export.zip --quiet --format json | jq -r '.data.alreadyImported'

# Local draft from a pipe; the output tells you where to paste it yourself
printf 'Thanks, that answers it.' | gcr draft create --conversation 00000000-0000-4000-8000-000000000001 --input -
```

## Privacy notes

* **Local only.** There is no network code, no telemetry, no update check. Proxy settings are irrelevant.
* **The database is private data.** It is created with mode 0600 (and `./.gcr` with 0700). `.gcr/` and `*.sqlite` are git-ignored; keep exports and
  databases out of Git, CI and coding agents ([`IMPORT_GUIDE.md`](IMPORT_GUIDE.md), section "Privacy guidance").
* **What reaches your screen.** `import`, `import-copy`, `batches`, `audit` and the draft/note summaries print counts, ids, codes and file
  names, never message text. `stats` prints counts grouped by labels taken from your export (roles, model names, channels, and with
  `--group-by conversation` conversation titles). `get`, `thread`, `search`, `list`, `branches`, `graph ...`, `draft show` and `annotate show`
  print conversation text, titles or labels. Redirecting that output to a file creates a file with your default permissions.
* **`graph export`** writes labels from your conversations into an HTML file; it is created with mode 0600, never overwrites without `--force`,
  and never writes through a symbolic link. The page loads nothing from the network.
* **Error messages and logs** contain codes, ids and basenames, never absolute paths or text. `--debug` is the exception by design: a stack
  trace can name internal files and the cause chain can quote a library error. Do not paste a debug trace into a public issue without reading it.
* **Input files are read defensively** (`--input`, `import-copy`): bounded size, regular files only, strict UTF-8, and a symbolic link must
  stay inside its own directory.
* **Standard input** for `import -` is buffered in memory up to four times `--max-element-bytes`; for drafts and notes up to 256 KiB.

## What the CLI deliberately cannot do

GCR is a reader for exports you obtained yourself. By design (SPEC section 9, [`BROWSER_GATE.md`](BROWSER_GATE.md), `AGENTS.md`) the CLI cannot:

* fetch, read or refresh a conversation from `chatgpt.com`, with or without a link, a login or a browser. A link is a lookup key and nothing else;
  `gcr get https://chatgpt.com/c/<uuid>` works only if that conversation is already in your database, otherwise it fails with `NOT_IN_LOCAL_EXPORT`;
* log in, ask for a password, read browser cookies or storage, replay a session, call any private endpoint, or automate a browser;
* send, post, queue or schedule a message, or open a browser page. `draft create` stores text locally and prints the conversation link as *text* for you
  to open and paste into yourself; a draft has only the states `draft` and `archived`;
* accept a share link, a link on another host, or a non-UUID id as a ChatGPT link;
* guess which branch was active, which model answered, or whether an export is complete: unknown stays unknown (`--branch-policy` is a labelled opt-in);
* change or delete imported conversations (they are immutable; local notes and drafts live in separate tables);
* upload an export anywhere, or serve data over a network (`gcr mcp` speaks stdio to a local client only).

If a task needs one of these, the right answer is the official export (`Settings > Data controls > Export data`) followed by `gcr import`.

## Files

| File | What it is |
|---|---|
| `src/cli/main.ts` | Process entry (`#!/usr/bin/env node`): warning filter, signals, broken pipes, exit code. |
| `src/cli/commands/*.ts` | The command table: one spec per command (options, defaults, examples, error codes) and its handler. |
| `src/cli/parse.ts`, `route.ts`, `help.ts` | Parsing on `node:util` `parseArgs`, command routing and help text, all driven by the table. |
| `src/cli/output.ts` | The only module that writes to stdout/stderr. |
| `src/suppress-warnings.ts` | Drops the `node:sqlite` ExperimentalWarning and nothing else; also used by the MCP entry. |
| `scripts/capture-cli-help.mjs` | Regenerates `docs/CLI_HELP.txt` from the built CLI (`npm run capture:cli-help`; `--check` verifies). |
| `test/cli/*.test.ts` | Child-process tests of the compiled CLI, in all formats, with synthetic data only. |
