# GCR architecture and module contracts

Status: **normative, synchronized with the code on 2026-10-11** (package `0.2.0-dev.0`, schema version 1). This file was first written before
implementation as a contract; it has since been diffed against `src/**`, `src/db/schema.ts` and the command output of the built tool, and every place
where the build differs from the original contract is listed in section 12. Where this file and the code disagree, the code is the fact and this file is the defect.

Source of truth for behaviour requirements is `SPEC.md`; for hard boundaries `AGENTS.md` and `docs/SECURITY_AND_BOUNDARIES.md`; for the reasons behind
decisions `docs/DECISIONS.md`; for every warning code `docs/WARNING_CODES.md`. Shared types live in `src/domain/types.ts` and `src/domain/results.ts`,
error codes in `src/errors.ts`.

Evidence statement. Everything below that describes the ChatGPT export format is **synthetic-only**: GCR has never been run against a real ChatGPT or
Claude export, and no official schema for the archive was available to this project (whether one exists elsewhere is NOT VERIFIED; no network access was used). Behaviour statements were read from the code and, where marked, reproduced by a command
run on 2026-10-11 with Node 22.22.0; claims that could not be verified say `NOT VERIFIED`.

## 1. Layering and files (no upward imports)

```
cli/  mcp/                thin adapters: parse arguments / tool input, call sdk/, render output
  └── sdk/                `Gcr` facade (gcr.ts): the stable typed API; envelope.ts, resolve.ts, doctor.ts
        ├── ingest/       layout.ts, zip.ts, json-stream.ts, registry.ts, adapters, import-runner.ts, manual-copy.ts
        ├── analysis/     stats.ts, audit.ts
        ├── graph/        build.ts, cluster.ts, query.ts, export-html.ts
        ├── drafts/       drafts.ts (local drafts, annotations, append-only audit log)
        ├── entities/     extract.ts
        ├── format/       render.ts (json / markdown / compact / jsonl), time.ts
        ├── db/           schema.ts, open.ts, repo.ts, search.ts, cjk.ts
        └── domain/       types.ts, results.ts, ids.ts, validate.ts, branches.ts   (pure, no I/O)
errors.ts, version.ts, logger.ts, suppress-warnings.ts: leaf modules usable everywhere.
devtools/                 privacy-scan.ts, licenses.ts: development gates for scripts/; never imported by the product.
```

Checked on 2026-10-11 with a script that lists the relative imports (static and dynamic) of every file in `src/**/*.ts` and groups them by directory: `domain` imports no other module directory; `db` imports only `domain`;
`ingest`, `entities`, `format` and `drafts` import `domain` (and `db` for `ingest` and `drafts`); `graph` imports `db`, `domain`, `entities`; `analysis` imports `db`,
`domain` and one constant (`NAMED_CONTENT_TYPES`) from `ingest/chatgpt-export.ts`; `sdk` imports `analysis`, `db`, `domain`, `drafts`, `graph` and `ingest` (it does **not** import `entities` or `format`; the diagram above shows layers, not import edges, and `src/index.ts` re-exports the renderers from `format/` itself); `mcp` imports `sdk`, `domain` and two constant lists from
`analysis`; `cli` imports `sdk`, `format`, `domain` and a few constants/types from `ingest`, `entities`, `analysis`, and loads `mcp/entry.js` lazily for `gcr mcp`. Nothing outside `cli/` imports `cli/`; apart from that one lazy import nothing outside `mcp/` imports `mcp/`; `sdk` and everything below it import neither. `devtools/` imports nothing but the root leaf modules and nothing in the product imports it.

| Directory | Real files | Owns |
| --- | --- | --- |
| `src/` | `index.ts`, `errors.ts`, `version.ts`, `logger.ts`, `suppress-warnings.ts` | Public SDK re-exports (the package `main`), error codes and exit codes, constants, stderr-only logger, filter for the single `node:sqlite` ExperimentalWarning |
| `src/domain/` | `types.ts`, `results.ts`, `ids.ts`, `validate.ts`, `branches.ts` | Model, result shapes, URL/UUID parsing, zod record validation, tree analysis |
| `src/db/` | `schema.ts`, `open.ts`, `repo.ts`, `search.ts`, `cjk.ts` | DDL and migrations, opening and error mapping, import writer and readers, FTS query compilation and paging, search-text normalization |
| `src/ingest/` | `layout.ts`, `zip.ts`, `json-stream.ts`, `limits.ts`, `adapter.ts`, `registry.ts`, `chatgpt-export.ts`, `claude-export.ts`, `openai-api.ts`, `manual-copy.ts`, `import-runner.ts` | Container discovery, safe ZIP reader, JSON splitter, limits, adapters, two-pass runner |
| `src/analysis/` | `stats.ts`, `audit.ts` | Read-only statistics and data-quality audit |
| `src/entities/` | `extract.ts` | Fixed-pattern entity extraction (URL, UUID, timestamp, tool, code language, file name, keyword) |
| `src/graph/` | `build.ts`, `cluster.ts`, `query.ts`, `export-html.ts` | Derived knowledge graph, label propagation, queries, offline HTML |
| `src/drafts/` | `drafts.ts` | `local_drafts`, `local_annotations`, `local_audit_log` |
| `src/format/` | `render.ts`, `time.ts` | Output formats, time zones |
| `src/sdk/` | `gcr.ts`, `envelope.ts`, `resolve.ts`, `doctor.ts` | The facade, provenance envelope, reference resolution, self-check |
| `src/mcp/` | `entry.ts`, `server.ts`, `tools.ts`, `registry.ts`, `envelope.ts`, `approved-roots.ts`, `aliases.ts`, `stdio-bootstrap.ts`, `stdout-guard.ts` | MCP server over stdio |
| `src/cli/` | `main.ts`, `run.ts`, `route.ts`, `parse.ts`, `options.ts`, `spec.ts`, `help.ts`, `context.ts`, `input.ts`, `output.ts`, `export-file.ts`, `render-local.ts`, `report-error.ts`, `text.ts`, `warnings.ts`, `commands/{index,system,import,read,graph,local,common}.ts` | The `gcr` binary |
| `src/devtools/` | `privacy-scan.ts`, `licenses.ts` | Repository gates (`scripts/privacy-scan.mjs`, `scripts/licenses.mjs`) |

Runtime and conventions:

* Node `>=22.16.0` (the first Node 22 whose bundled SQLite has FTS5; ADR-0012). ESM, NodeNext, TypeScript strict (`noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`). Runtime dependencies are exactly `@modelcontextprotocol/sdk` (1.32.1) and `zod` (4.6.5); dev dependencies `typescript`, `@types/node`, `fast-check`.
* SQLite is `node:sqlite` (`DatabaseSync`; SQLite 3.50.4 on Node 22.22.0). ZIP and JSON streaming are hand-written (`node:zlib`, `node:fs`) so every limit is explicit.
* GCR contains no network code: no `http`, `https`, `net`, `fetch` or similar import in `src/`. `test/security/no-network.test.ts` enforces it with its own tokenizer, and allows exactly one exception: `child_process.execFile` inside `src/devtools/` (git, for the privacy scan).
* Relative imports use the `.js` extension. Named exports only (no `export default` in `src/`, grep on 2026-10-11). `import type` for types. `src/` contains no `console.<method>(` call (grep on 2026-10-11 found only comments that mention it); diagnostics go through `logger.ts` (stderr only; callers must pass ids, counts and codes only, which is a convention the logger does not enforce), CLI output through `cli/output.ts`, and the MCP stdio server redirects every stray `process.stdout.write` to stderr (`mcp/stdout-guard.ts`; writes to file descriptor 1 that bypass `process.stdout` are not covered, and GCR spawns no child process).
* Comment security-sensitive logic and tricky transforms (ZIP validation, branch traversal, FTS query building); the source does.

## 2. Identity, provenance, merge semantics

* **Account scope**: `account_label` (operator-chosen at import, default `default`, pattern `^[A-Za-z0-9][A-Za-z0-9_.@ -]{0,63}$`) keeps exports of different accounts apart. The same conversation or message id under another provider or account never collides: every key carries `(provider, account_label)`.
* **Source batch**: one *logical* import is one `source_batches` row. `batch_id = 'b_' + sha256_hex(provider \0 account_label \0 content_digest).slice(0, 32)` (`computeBatchId` in `db/repo.ts`).
  `content_digest` is the SHA-256 over the lines `"<file name>\t<sha256 of the file bytes>"`, sorted by code-unit order and joined with `\n`, of the **conversation files** that were read (`conversations.json`, `conversations-N.json`; nested archive members are named `<outer entry>!/<inner name>`). Auxiliary files, the manifest and attachments do not contribute. Re-zipping identical data yields the same batch; a different export, even of the same conversations, is a new batch. A single `.json` file given by path is named `conversations.json` unless its name already matches the conversation-file pattern, so renaming it does not change the batch.
* **Message identity**: `(provider, account_label, conversation_id, message_id, source_batch)` (SPEC section 5). Re-importing identical input is a no-op: the runner computes the batch id from pass 1 and returns the stored counts (`alreadyImported: true`) without running an adapter; the repository additionally uses `INSERT ... ON CONFLICT DO NOTHING` (FR-10).
* **Head batch**: for each `(provider, account_label, conversation_id)` the *head* is the snapshot with the greatest conversation `updated_at` compared as instants (`unixepoch(..., 'subsec')`, NULL lowest), ties broken by the greatest `source_batches.seq`. `conversation_heads` holds it and is recomputed for the touched conversations at the end of each import. All read APIs default to the head; `batchId` pins another snapshot. Older snapshots are retained and excluded from default search, list, stats and audit (`allBatches` includes them; `search`, `stats` and `audit` then carry `SUPERSEDED_SNAPSHOTS_INCLUDED`).
* **Immutability**: `source_batches`, `source_batch_stats`, `conversations` and `messages` abort `UPDATE` and `DELETE` through triggers (message `imported data is immutable`); only the import path inserts. `recursive_triggers` is ON, so `INSERT OR REPLACE` cannot bypass the delete trigger. Local data (`local_*`) lives in separate tables, is anchored by `(provider, account_label, conversation_id[, message_id])` and **not** by batch, and survives re-imports. Deleting a batch is not a v1 operation.
* **Duplicates inside one stream**: the same normalized conversation id twice in one batch keeps the first and adds `DUPLICATE_CONVERSATION_IN_BATCH`. Duplicates across shards are resolved earlier, by the runner rule in section 5.
* **Ordering of ids**: `domain/branches.ts`, `ingest/*` and `import-runner.ts` order ids and names with JavaScript `<` (UTF-16 code-unit order); SQLite `BINARY` collation (used by every SQL `ORDER BY` on ids) orders by UTF-8 bytes, i.e. code-point order. The two agree except when ids mix astral characters with U+E000 to U+FFFF (reproduced on 2026-10-11: the comparison of code point U+10000 with code point U+FFFF is true in JavaScript (`String.fromCodePoint(0x10000) < String.fromCodePoint(0xFFFF)`), and `SELECT ((? COLLATE BINARY) < ?)` returns 0 in SQLite for the same two strings). `audit` samples use code-point order so they match SQL. Branch order ties between such ids are therefore not guaranteed to match an SQL ordering of the same ids. No real export is known to contain such ids; synthetic tests do not cover the mixed case (NOT VERIFIED).

## 3. SQLite schema v1 (authoritative DDL lives in `src/db/schema.ts`; this is the final DDL as built)

`PRAGMA user_version = 1`; `PRAGMA application_id = 0x47435231` ("GCR1"; a file with a different non-zero id is refused as `not_gcr_database`); `gcr_meta` holds `schema_version = '1'` and
`fts_design = 'contentless-unicode61-v2'`. Connection settings applied by `openDatabase`: `foreign_keys = ON`, `trusted_schema = OFF`, `recursive_triggers = ON`,
`busy_timeout = 5000`, `journal_mode = WAL` for writable on-disk files, `query_only = ON` for read-only opens. A new database file is created with mode `0600` before SQLite touches it. All regular tables are `STRICT` (the two FTS5 virtual tables are not and cannot be). **Every value is a bound parameter**;
the string-built SQL that exists (listed by a grep for template literals inside `prepare(` / `exec(` on 2026-10-11) consists of fixed fragments, allow-listed table and column names, `?` placeholder lists, and integer constants inside `PRAGMA` statements (a `PRAGMA` cannot take parameters). The DDL below was cross-checked on 2026-10-11 against `sqlite_schema` of a freshly created database: all 33 objects spelled out here (tables, indexes, triggers, the two FTS tables) matched the real statements after comments and whitespace were normalized; the 8 FTS shadow tables and `sqlite_sequence` are created by SQLite itself and are not spelled out. `test/db/schema.adversarial.test.ts` reads this section too: it runs the `CREATE TABLE` and `CREATE INDEX` statements below into a scratch database, compares each table's columns, types, `NOT NULL` flags, defaults, primary keys, foreign keys and `STRICT` flag with the real schema, and checks that each documented index name exists. That test does not compare the virtual tables or the trigger bodies, and checks trigger names only for `source_batches`, `conversations`, `messages` and `local_audit_log`.

```sql
CREATE TABLE gcr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE source_batches (
  batch_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,                  -- import order, assigned inside the write transaction
  provider TEXT NOT NULL, account_label TEXT NOT NULL,
  provenance TEXT NOT NULL, completeness TEXT NOT NULL,   -- the adapter's NOMINAL completeness; per-conversation values are authoritative
  source_kind TEXT NOT NULL,                    -- 'zip' | 'conversations_json' | 'directory' | 'stdin_json' | 'manual_copy'
  source_label TEXT,                            -- basename only
  input_sha256 TEXT NOT NULL,                   -- the content digest of section 2
  imported_at TEXT NOT NULL,                    -- first import time; unchanged by idempotent re-imports
  tool_version TEXT NOT NULL, schema_version INTEGER NOT NULL,
  conversation_count INTEGER NOT NULL, message_count INTEGER NOT NULL,   -- real messages only (structural nodes excluded)
  warnings_json TEXT NOT NULL DEFAULT '[]'
) STRICT;

-- Helper that is not in the original contract: node counts that the immutable batch row cannot hold.
CREATE TABLE source_batch_stats (
  batch_id TEXT PRIMARY KEY REFERENCES source_batches(batch_id),
  node_count INTEGER NOT NULL,
  structural_count INTEGER NOT NULL
) STRICT;

CREATE TABLE conversations (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  title TEXT, source_uri TEXT,
  provenance TEXT NOT NULL, completeness TEXT NOT NULL, imported_at TEXT NOT NULL,
  created_at TEXT, updated_at TEXT,
  current_node_id TEXT, default_model_slug TEXT,
  message_count INTEGER NOT NULL,
  raw_metadata_json TEXT, warnings_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (provider, account_label, conversation_id, source_batch)
) STRICT;
CREATE INDEX conversations_by_conv ON conversations(conversation_id);
CREATE INDEX conversations_by_batch ON conversations(source_batch);

CREATE TABLE messages (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL, source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  ordinal INTEGER NOT NULL,
  parent_id TEXT, child_ids_json TEXT NOT NULL DEFAULT '[]',
  node_kind TEXT NOT NULL CHECK (node_kind IN ('message','structural_empty')),
  author_role TEXT NOT NULL, author_name TEXT,
  model_slug TEXT, channel TEXT, recipient TEXT, content_type TEXT, status TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  created_at TEXT, updated_at TEXT,
  text TEXT NOT NULL, blocks_json TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
  raw_source_json TEXT,
  PRIMARY KEY (provider, account_label, conversation_id, message_id, source_batch)
) STRICT;
CREATE INDEX messages_parent ON messages(provider, account_label, conversation_id, source_batch, parent_id);
CREATE INDEX messages_created ON messages(created_at);
CREATE INDEX messages_role ON messages(author_role);

CREATE TABLE conversation_heads (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  PRIMARY KEY (provider, account_label, conversation_id)
) STRICT;
CREATE INDEX conversation_heads_by_conv ON conversation_heads(conversation_id);

-- Full-text indexes: CONTENTLESS (content = ''), rowid = rowid of messages / conversations, written in the import transaction.
-- They hold the inverted index only; the indexed string is buildSearchText(text) from src/db/cjk.ts (section 6).
CREATE VIRTUAL TABLE messages_fts USING fts5(search_text, content = '', tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'");
CREATE VIRTUAL TABLE conversations_fts USING fts5(title_text, content = '', tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'");

-- Immutability triggers on the four imported tables: only the import path inserts.
CREATE TRIGGER source_batches_no_update BEFORE UPDATE ON source_batches
BEGIN SELECT RAISE(ABORT, 'imported data is immutable'); END;
CREATE TRIGGER source_batches_no_delete BEFORE DELETE ON source_batches
BEGIN SELECT RAISE(ABORT, 'imported data is immutable'); END;
CREATE TRIGGER source_batch_stats_no_update BEFORE UPDATE ON source_batch_stats
BEGIN SELECT RAISE(ABORT, 'imported data is immutable'); END;
CREATE TRIGGER source_batch_stats_no_delete BEFORE DELETE ON source_batch_stats
BEGIN SELECT RAISE(ABORT, 'imported data is immutable'); END;
CREATE TRIGGER conversations_no_update BEFORE UPDATE ON conversations
BEGIN SELECT RAISE(ABORT, 'imported data is immutable'); END;
CREATE TRIGGER conversations_no_delete BEFORE DELETE ON conversations
BEGIN SELECT RAISE(ABORT, 'imported data is immutable'); END;
CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'imported data is immutable'); END;
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'imported data is immutable'); END;

-- Local (writable) data: separate from imported originals, never transmitted anywhere.
CREATE TABLE local_drafts (
  draft_id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  anchor_message_id TEXT,
  title TEXT, body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','archived')),   -- deliberately NO 'sent' state (ADR-0020)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_via TEXT NOT NULL    -- 'cli' | 'mcp' | 'sdk'
) STRICT;
CREATE TABLE local_annotations (
  annotation_id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT,                              -- NULL = conversation-level
  kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,           -- optimistic concurrency
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_via TEXT NOT NULL
) STRICT;
CREATE TABLE local_audit_log (                  -- append-only
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'       -- ids, lengths and a short hash prefix only, never body text
) STRICT;
CREATE TRIGGER local_audit_log_no_update BEFORE UPDATE ON local_audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER local_audit_log_no_delete BEFORE DELETE ON local_audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

-- Derived artifacts: created empty by migration 1, emptied and refilled wholesale by graph build (ADR-0019).
CREATE TABLE entities (entity_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, normalized TEXT NOT NULL, UNIQUE(kind, normalized)) STRICT;
CREATE TABLE entity_mentions (entity_id INTEGER NOT NULL REFERENCES entities(entity_id), provider TEXT NOT NULL, account_label TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, source_batch TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (entity_id, provider, account_label, conversation_id, message_id, source_batch)) STRICT;
CREATE TABLE graph_nodes (node_id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, ref TEXT, weight REAL NOT NULL DEFAULT 1, community_id INTEGER) STRICT;
CREATE TABLE graph_edges (edge_id INTEGER PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
  UNIQUE(src, dst, kind)) STRICT;
CREATE TABLE graph_edge_evidence (edge_id INTEGER NOT NULL REFERENCES graph_edges(edge_id), provider TEXT NOT NULL, account_label TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT, source_batch TEXT NOT NULL) STRICT;   -- every graph fact traces to message ids; branch ids are resolved on demand
CREATE TABLE graph_communities (community_id INTEGER PRIMARY KEY, size INTEGER NOT NULL, label TEXT) STRICT;
```

Facts about the schema that the DDL cannot show:

| Topic | As built |
| --- | --- |
| FTS tokenization | `unicode61 remove_diacritics 2` with `categories 'L* N* Co Mn Mc'` so combining marks of Indic scripts stay inside their word. No stemming (predictable and language-independent; use `word*`). No FTS `prefix=` index: a comment in `src/db/schema.ts` records an earlier measurement on 50,000 synthetic messages in which it would have raised the index from about 0.36 to 0.67 times the raw text while only speeding up very broad prefixes (not re-measured here). The recorded baseline of the built index is 0.43 times the raw text (`docs/PERFORMANCE.md`, 2026-10-11, 12.9 MiB for 30.4 MiB of synthetic text). |
| FTS maintenance | Contentless tables cannot `UPDATE`/`DELETE` single rows; imported rows are immutable so only inserts happen. `Repository.rebuildSearchIndex()` empties both indexes (FTS5 `delete-all`), refills them from the tables in one transaction and rewrites `fts_design`; it is a repository method only, not reachable from the SDK, CLI or MCP (grep of `src/` on 2026-10-11). A database whose `fts_design` marker is older would keep working but could miss words next to symbols or emoji until rebuilt; no such database can be created by this version. |
| Shadow tables | SQLite creates `messages_fts_data`, `_idx`, `_docsize`, `_config` (and the same four for `conversations_fts`) and `sqlite_sequence` itself; they are not part of the contract. |
| Indexes created by `graph build`, not by migration | `graph_edges_dst ON graph_edges(dst)`, `graph_edge_evidence_edge ON graph_edge_evidence(edge_id)`, `graph_nodes_community ON graph_nodes(community_id)`. They are dropped at the start and recreated at the end of every build. |
| Counts | `conversations.message_count` and `source_batches.message_count` count real messages (`node_kind = 'message'`); `source_batch_stats.node_count` counts all stored nodes, `structural_count` the structural ones. |
| Timestamps | Stored as ISO-8601 UTC strings, with or without milliseconds (`...:SSZ` and `...:SS.mmmZ` are both valid); every comparison goes through `strftime` / `unixepoch` so the spellings compare as instants. |
| Raw columns | `raw_source_json` (message) and `raw_metadata_json` (conversation) hold the parsed source objects re-serialized, not the source bytes: duplicate keys keep the last value and numbers beyond 2^53 are rounded. ChatGPT only: structures nested deeper than 256 levels are cut (ADR-0013), and the SHA-256 of the exact source element is stored in `rawMetadata._gcr.sourceElementSha256`. Claude: elements nested deeper than 128 levels are refused instead of cut, and the element hash is returned by the adapter but **not stored** (`rawMetadata._gcr` exists only when `chat_messages` entries were skipped). |

### Migrations

`src/db/schema.ts` exports `MIGRATIONS: ReadonlyArray<{ version; name; up(db) }>` (one entry: `1 initial_schema`) and `applyMigrations(db, migrations = MIGRATIONS)`.
It requires a gap-free list that matches `SCHEMA_VERSION`, refuses a file whose `user_version` is greater than this tool's (`DB_SCHEMA_TOO_NEW`), refuses a non-empty file with `user_version = 0` and a foreign `application_id` or foreign objects (`DB_ERROR`, `details.reason = "not_gcr_database"`),
and applies each pending migration in its own `BEGIN IMMEDIATE` transaction, re-reading the version inside the transaction so two processes opening a fresh file cannot both apply it. A failing migration rolls back and throws `DB_MIGRATION_FAILED`.
`assertCompatible(db)` runs on every open (after the migrations for a read-write open, and as the only gate for a read-only one, which never creates or migrates): exact schema version, expected tables present, `gcr_meta.schema_version` consistent; it never writes.
`openDatabase` probes FTS5 on a private in-memory connection first and fails with `DB_ERROR` (`details.reason = "FTS5_UNAVAILABLE"`) on a Node build without it (ADR-0012), and checks `assertSchemaNotNewer` before switching the journal mode so a newer file is left byte-for-byte untouched.
`Gcr.open()` (read-write) additionally runs `peekOpenRefusal` first. Reproduced on 2026-10-11 with a synthetic foreign SQLite file: calling `openDatabase()` directly refused it with `not_gcr_database` but had already switched its header to WAL (file-format bytes 18 and 19 changed from `01 01` to `02 02`), whereas `Gcr.open()` refused it and left the header byte-identical. Migrations must be backward compatible or explicitly versioned (SPEC section 5).

## 4. Domain rules (`src/domain/*`, pure)

* `ids.ts`: `parseChatGptUrl(input)` accepts exactly `https://chatgpt.com/c/<uuid>` (scheme, host and UUID case-insensitive; one optional trailing `/`; a query string and fragment are cut off before parsing; surrounding ASCII whitespace trimmed) and returns the lower-cased UUID plus the canonical URL. It does not trust `new URL()` to decide acceptance; WHATWG parsing is only a second confirmation.
  Error classification: `INVALID_ARGUMENT` for a non-string; `INVALID_URL` for text that is not a canonical absolute `https://` URL (empty, longer than 2,048 characters, control characters, backslash, percent-encoding in the path, no scheme, missing `//`, empty host); `UNSUPPORTED_URL` for a well-formed URL that is not the one form (other scheme or host including `www.` and `chat.openai.com`, userinfo, any port, any path other than `/c/<segment>[/]`, extra segments); `INVALID_UUID` when the single segment is not a UUID. `parseConversationRef(input)` accepts a bare UUID or such a URL (anything starting with `<scheme>:` is parsed as a URL) and **enforces the 2,048-character bound for every input**, before any linear scan. Never performs network access.
* `branches.ts` (`analyzeTree(conversationId, messages, currentNodeId, opts)`): iterative (no recursion limit), cycle-safe, deterministic, independent of input order. Total order for siblings and ties: `(createdAt ascending with null last, ordinal, id)`. Roots are nodes whose `parentId` is null or names a missing node (`MISSING_PARENT`, still treated as a root). Parent pointers are authoritative; declared `childIds` order siblings only when they agree exactly with the parent pointers, otherwise `CHILD_PARENT_MISMATCH` and the sorted order is used. A **dangling declared child is reported as `CHILD_PARENT_MISMATCH`**. A node that lists itself as parent is reported as `SELF_PARENT` and is unreachable. Cycles are `CYCLE_DETECTED` (at most 100 listed individually); their nodes and descendants are `unreachableIds`. Duplicate ids in the input are `DUPLICATE_NODE_ID` (one record is chosen by a total preorder over its fields, never by input order). Branch ids are leaf ids. Enumeration is bounded: `maxBranches` 10,000 and `maxTotalPathNodes` 5,000,000, then `BRANCH_LIMIT_EXCEEDED`; `leafIds` still lists **all** reachable leaves.
  Active branch only from a valid `currentNodeId` (a node reachable from a root). A `currentNodeId` that is not a leaf gives `CURRENT_NODE_NOT_LEAF` when several branches pass through it. Otherwise every branch is `activeness: 'unknown'` and `activeBranchId` is `null` (`NO_CURRENT_NODE` / `INVALID_CURRENT_NODE`): no guessing (ADR-0009).
* `selectBranchByPolicy(analysis, messages, 'last_child' | 'latest_leaf')` exists for callers that opt in and always returns an `ACTIVE_BRANCH_HEURISTIC` warning with the branch. `'latest_leaf'` considers **all reachable leaves** (`analysis.leafIds`), ignores leaves without a usable timestamp, and returns `null` when the winning leaf was not enumerated in a truncated analysis (a truncated analysis never yields a different answer than the full one).
* `validate.ts`: strict zod schemas for `ConversationRecord` / `MessageRecord` used at the adapter-to-database boundary (the repository validates every record again), `isIso8601Utc`, `parseIsoUtcToEpochMs` (never `Date.parse`), `unixSecondsToIso` (plausible window 2015-01-01 to 2100-01-01). Limits: id 512 characters, text 64 MiB per message, title 8,192, URI 2,048, attachment strings 4,096, short strings 512.
* `results.ts`: `Page<T>`, `ConversationSummary`, `SearchHit`, `BatchInfo`, `ThreadResult` (with `selectionPolicy: 'source_current_node' | 'explicit_branch' | 'only_branch' | 'last_child' | 'latest_leaf'`), `BranchListResult`, `ImportReport`, and `FormatProfile` (observed facts about an export: layout, manifest status, wrapper object, counts of conversations with `current_node`, nodes with and without `children`, role counts, messages with recipient/status/model slug, hidden messages, literal `client-created-root`, ignored auxiliary files, extension-less assets). The per-conversation counts an adapter contributes to the profile are `FormatObservations` in `ingest/adapter.ts`.

## 5. Ingestion

* **Inputs** (`InputSource` = `{ kind: 'path', path }` or `{ kind: 'stream', stream, label }`): an official export ZIP; one level of nested ZIP (an entry of the export ZIP whose basename ends in `.zip` and contains `conversations`, case-insensitive; the error remedies call it `Conversations*.zip`); an extracted folder (up to 4 levels deep; `.zip` files found inside a folder are **not** opened); a single `conversations.json` / `conversations-N.json`; standard input. Detection is by content signature, not extension (`PK\x03\x04`, `PK\x05\x06` and `PK\x07\x08` start a ZIP; after an optional UTF-8 BOM and ASCII whitespace, `[` or `{` start JSON; UTF-16/UTF-32 is refused with a remedy; any other start gets one chance as a ZIP preceded by a stub). The recognized conversation files are those whose basename matches `^conversations(?:-(\d+))?\.json$` (case-insensitive, any depth); order is plain file first, then ascending integer shard number (so 2 before 10). `export_manifest.json` is read leniently and only ever produces warnings. Well-known personal files (`user.json`, `message_feedback.json`, `shared_conversations.json`, `chat.html`, and others in `AUXILIARY_FILE_NAMES`) are counted by name and **never read**; every other file is listed by name only, to set `AttachmentRef.presentInExportAs`. Folder walks use `lstat`, never follow symlinks found inside the folder, and open files with `O_NOFOLLOW | O_NONBLOCK`; the one path the user typed may itself be a symlink and is followed (`stat`). Nothing is fetched.
* **`zip.ts`** (`SafeZipReader`; SPEC Phase 1 security): central-directory parser; STORE and DEFLATE only; rejects encrypted entries, multi-disk archives, symlink and special-file entries (Unix mode bits), absolute paths, UNC and drive-letter names, `..` and `.` segments, empty segments, backslashes, control characters, bidi/format characters, over-long names, duplicate names (NFC and case-folded), overlapping or out-of-bounds entries, a local header whose name or method differs from the central directory; supports ZIP64. Sizes, offsets and CRC come **only** from the central directory (ADR-0017); CRC-32 and the final size are verified when a stream ends, so bytes delivered before the iterator completes are unverified until it finishes without throwing. Inflation is bounded three ways (declared size as hard cap on produced bytes, compression-ratio guard, cumulative budget). Names are lookup keys only and are never used as file-system paths; the archive is never extracted to disk. Error messages carry an entry index and a reason code, never a name.
* **`json-stream.ts`**: byte-level state machine that reads a top-level JSON array (or a single object, or NDJSON lines) and yields the raw text of each element without `JSON.parse`; memory is bounded by one element plus the current chunk; handles BOM and UTF-8 split across chunks; identical results for any chunking down to 1-byte chunks. It validates framing only; a framing error carries a byte offset and one of `JSON_PARSE_REASONS`.
* **Adapters** implement `ConversationSourceAdapter.normalizeElementText(text, ctx, elementIndex) -> AdapterOutcome` (`ingest/adapter.ts`; pure: no I/O, no clock, no network): `ChatGPTExportAdapter` (`provider 'chatgpt'`, `provenance 'official_chatgpt_export'`), `ClaudeExportAdapter` (`'claude'`, `'official_claude_export'`), and `DisabledOpenAIAPIOwnedAdapter` (Mode D: interface plus an implementation whose every method throws `NOT_IMPLEMENTED`; **not** registered, `getAdapter('openai_api')` answers `NOT_IMPLEMENTED`). The registry sniffs a provider from the first recognizable element of each file (`mapping` object means ChatGPT, `chat_messages` array means Claude; both or neither means no guess). `docs/ADAPTERS.md` describes both adapters.
* **ChatGPT normalization**: timestamps (unix seconds, float) become ISO-8601 UTC; invalid, 0, negative, millisecond-scale or outside 2015 to 2100 gives null plus a warning. `model_slug` only from `message.metadata.model_slug` (never `default_model_slug`, never inferred). `current_node` is kept only if it is a key of the mapping, else null plus `INVALID_CURRENT_NODE`. The 16 named `content_type` values have explicit handlers; anything else becomes a raw `unknown` block plus `UNKNOWN_CONTENT_TYPE`. Hidden and placeholder rules are ADR-0014. A conversation is `exported_tree` only when nothing found by the adapter weakens that claim; otherwise it is `unknown` with `COMPLETENESS_LOWERED` listing the reasons. NUL is stripped and lone surrogates replaced, each with a warning.
* **Claude normalization**: always `rendered_active_view_only` plus `LINEAR_EXPORT_ACTIVE_BRANCH_ONLY` (ADR-0015); `sender 'human'` becomes role `user`, other senders are kept verbatim; the tree is the linear chain in file order unless a message carries `parent_message_uuid`, in which case the pointers win.
* **Import runner** (`import-runner.ts`, `runImport(repo, opts)`), two passes with memory proportional to the number of conversations, not to the export size:
  1. *Pass 1* streams every conversation file once: SHA-256 of the file bytes, an identity peek of every element (a linear key scanner, not a `JSON.parse`), wrapper expansion (`{"conversations": [...]}` without `mapping`), provider sniffing, and the duplicate-resolution winners. From the per-file hashes it derives the content digest and the batch id; an input imported before is recognized here and returned as a no-op.
  2. *Pass 2* streams the files again and normalizes only the winning elements, feeding the records to `Repository.importBatch` as an async generator inside **one** `BEGIN IMMEDIATE` transaction. If a file no longer hashes to its pass-1 digest, the generator throws and the transaction rolls back (a half-changed input is never stored). Each record is validated before the repository sees it, so one invalid conversation is an element failure rather than the loss of the whole import.
  The report (`ImportReport`) holds counts, per-file results, warnings grouped by code (count plus up to 5 sample ids), the `FormatProfile` and the duration; never message content. `--strict` (`strict: true`) turns every problem listed in `STRICT_FATAL_CODES`, any element failure and any manifest inconsistency into an abort that stores nothing.
* **Duplicate-resolution rule** (conversations with the same id in several shards; only objects an adapter would accept as conversations take part, keyed `conversation_id ?? id` for ChatGPT shape and `uuid` for Claude shape, UUIDs lower-cased). The winner is chosen by this total order: (1) greatest update time (`update_time` seconds, or `updated_at`; missing is lowest); (2) greatest element size in source bytes; (3) earliest file order (plain `conversations.json` first, then numeric shard order); (4) earliest element index. Every loser is reported as `DUPLICATE_CONVERSATION`. The winner is decided from identity metadata alone: if it later fails normalization, the loser is **not** tried (reported as an element failure instead).
* **Limits** (defaults are the real values; `resolveLimits` rejects `NaN`, zero, negative and infinite values and unknown keys, so no limit can be disabled):

| Limit | Default | Where | Configurable |
| --- | --- | --- | --- |
| `maxZipFileBytes` | 64 GiB | ZIP size on disk | `ImportOptions.limits` |
| `maxEntries` | 20,000 | central-directory entries of one archive; a folder walk uses the same number; archives plus nested archives together get 4 times this | `ImportOptions.limits`, CLI `--max-entries` |
| `maxEntryNameBytes` | 1,024 | raw bytes of an entry name | `ImportOptions.limits` |
| `maxEntryUncompressedBytes` | 2 GiB | declared and actual size of one entry | `ImportOptions.limits`, CLI `--max-entry-bytes` |
| `maxTotalInflatedBytes` | 8 GiB | cumulative bytes read through one reader; the runner reads every file twice, so the budget applies per pass (x2); nested archives share one pool | `ImportOptions.limits`, CLI `--max-total-bytes` |
| `maxCompressionRatio` | 200 | uncompressed to compressed ratio of a DEFLATE entry; entries up to 64 KiB are exempt | `ImportOptions.limits`, CLI `--max-ratio` |
| `maxElementBytes` | 256 MiB | one top-level JSON element (conversation) or NDJSON line; clamped to V8's string limit; stdin is buffered up to 4 times this | `ImportOptions.limits`, CLI `--max-element-bytes` |
| `maxExtraFieldBytes` | 16 KiB | ZIP extra field and entry comment, each | `ImportOptions.limits` |
| nested archive size | 256 MiB each, 1 GiB together | one level of `Conversations*.zip` inflated into memory (`MAX_NESTED_ZIP_BYTES`, `NESTED_AGGREGATE_FACTOR` in `layout.ts`) | **no** (not part of `ImportLimits`; known gap, section 13) |
| manifest size | 16 MiB | `export_manifest.json` | no |
| folder depth | 4 levels | `DIRECTORY_MAX_DEPTH` | no |
| JSON nesting inside one element | 10,000 | `MAX_JSON_DEPTH` in `json-stream.ts`; exceeding it is a framing error (ADR-0013) | no |
| ChatGPT adapter | 500,000 nodes per conversation, 50,000 parts per message, 64 MiB text per message, 256 raw nesting levels, 100 distinct unknown content types | `chatgpt-export.ts` | adapter constructor option only (not reachable from `ImportOptions` or the CLI) |
| Claude adapter | 128 nesting levels, 500,000 messages, 50,000 blocks per message, 5,000 attachments per message, 2,000,000 blocks plus attachments per conversation | `claude-export.ts`; exceeding depth or message count skips the element | no |
| Manual copy (Mode B) | 10,000 messages, 1 MiB text per message, 64 MiB text in total | `manual-copy.ts` | no |

* **Per-element versus per-file failures** (ADR-0013): a framing error (truncated file, trailing data, nesting deeper than 10,000, stray token) ends the **file** at that point: the elements before it are kept and `FILE_PARSE_FAILED` is recorded; if nothing at all could be read from any file, or under `--strict`, the import fails with the framing error `IMPORT_PARSE_ERROR` (a top-level JSON scalar, reason `TOP_LEVEL_NOT_ARRAY`, is reported as `IMPORT_UNSUPPORTED_FORMAT` instead). An element larger than `maxElementBytes` fails the **whole import** with `IMPORT_LIMIT_EXCEEDED` (asserted by `test/ingest/import-runner.test.ts`, test title in ADR-0013: nothing is stored), because the splitter cannot resynchronize. An element that is valid framing but cannot be normalized (invalid JSON, Claude depth or message-count limit, validator rejection) fails only **itself**: it is skipped with `ELEMENT_PARSE_FAILED`.
* **Mode B** (`manual-copy.ts`): a small JSON document of messages the user copied by hand becomes one linear conversation with provenance `user_supplied_copy`, completeness `partial_user_supplied`, `currentNodeId` null, `sourceKind 'manual_copy'` and the warning `PARTIAL_USER_SUPPLIED`. `sourceUri` is stored as a label and never opened.

## 6. Search (`db/search.ts`, `db/cjk.ts`)

* **What is indexed**: `buildSearchText(text)` = NFKC, lower-case, removal of combining diacritics for every script (not only Latin; only the combining-diacritic blocks and variation selectors are dropped, Indic vowel signs and similar marks stay inside their word), final sigma folded to sigma, every character that is not a token character (`\p{L} \p{N} \p{Co} \p{Mn} \p{Mc}`) replaced by a space, and one space around every Han/Hiragana/Katakana/Hangul code point, so each CJK character is its own token (stock `unicode61` would index an unbroken CJK run as one token and `日本語` would not match inside `これは日本語のテスト`). Titles use the same transform. Structural nodes and empty messages are not indexed. `ß` is not folded to `ss` and Thai, Lao, Khmer and Myanmar are not word-split (documented limitations).
* **Query compilation, plain mode (default)**: the query (at most 2,000 characters, at most 32 terms and 128 tokens, no NUL) is normalized with the same function and tokenized in JavaScript: words are maximal runs of token characters, a double-quoted run is a phrase (an unbalanced quote is a separator), `*` right after a word or closing quote is a prefix marker, `AND`, `OR`, `NOT`, `NEAR` and every FTS5 operator character are ordinary text, a word containing CJK becomes a phrase of its single-character tokens. Each term becomes a quoted FTS5 phrase (`"tok1 tok2"`, with `*` after the closing quote for a prefix); terms are separated by a space (implicit AND). The expression is a bound parameter of `WHERE messages_fts MATCH ?`. An empty or punctuation-only query is `INVALID_ARGUMENT`. **Raw mode** (`mode: 'raw'`, CLI `--raw`) passes FTS5 syntax through after the CJK and diacritic transforms; SQLite syntax errors (primary result code 1) become `FTS_SYNTAX_ERROR` without forwarding SQLite's text.
* **Statement shape**: `WITH h AS MATERIALIZED (SELECT rowid AS rid, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ?) SELECT ... FROM h JOIN messages m ON m.rowid = h.rid JOIN conversations c ON ... [JOIN conversation_heads ...] WHERE m.node_kind = 'message' [AND m.hidden = 0] [filters] ORDER BY ... LIMIT ? OFFSET ?`. bm25 statistics cover the whole index, including superseded snapshots. Title search (`searchConversationTitles`) uses `conversations_fts` the same way and supports offset paging only.
* **Filters** (message scope): `provider`, `accountLabel`, `conversationId`, `role`, `channel`, `hasModel`, `createdAfter` (inclusive) / `createdBefore` (exclusive) compared as instants (a message without a timestamp never matches a bound), `includeHidden` (default false), `allBatches` (default false: only each conversation's head). The SDK adds `scope: 'messages' | 'titles' | 'all'` (`all` lists every title hit first, then message hits; the two rankings are not comparable and are not interleaved).
* **Ordering and paging**: total order `rank ASC, (created_at IS NULL) ASC, canonical created_at instant ASC, conversation_id, message_id, provider, account_label, source_batch` (all ascending), so offset and keyset paging return identical sequences while the index does not change. `limit` 1 to 200 (default 20), `offset` up to 10,000,000. The **cursor** is opaque `base64url(JSON({ v: 1, f: <16-hex fingerprint of mode + MATCH string + filters>, k: [rank, createdAtIsNull, canonicalInstant, conversationId, messageId, provider, accountLabel, batchId] }))`, at most 8,192 characters; it is valid only with the identical query and filters, cannot be combined with a non-zero offset, is applied as a row-value comparison `(h.rank, ...) > (?, ...)` with bound parameters, and is never used as SQL text. In cursor mode `nextOffset` is `null`.
* **Snippets** are built in JavaScript from the **original** message text (not the transformed copy; this is why CJK excerpts are not space-separated): at most 160 UTF-16 units including the ellipses; matches wrapped in U+0001 / U+0002 after those characters (and other control and bidi characters) are stripped from the source, so message content cannot forge a highlight; only the first 200,000 characters of a message are fetched (`substr` in SQL) and one page may spend at most 2,000,000 characters looking for highlights, after which remaining hits show the start of the text without a highlight. Renderers translate the markers; no raw HTML is produced.

## 7. Output (`format/render.ts`, `format/time.ts`)

Formats: `json`, `markdown` (default for the CLI), `compact` (token-light plain text, `[role] text`), `jsonl` (one JSON value per line, with a `footer` line carrying warnings). Pure functions: the same input gives the same bytes; every rendering ends with exactly one newline. Every document carries source provenance, completeness, import time, tool version, branch identity and warnings. Timestamps stay UTC ISO in JSON; markdown and compact add the time in `--tz <IANA>` (default `UTC`) and the UTC value.
Everything from an import is untrusted data, so renderers: put message bodies in a fenced block whose fence is longer than any backtick or tilde run inside (markdown); indent every continuation line by two spaces in compact so untrusted text never starts a line with `[role]` or `#` in column 0; replace hazardous characters (C0 controls except TAB/LF, DEL, C1 controls, U+2028/2029, bidi embeddings and isolates, Unicode TAG characters, lone surrogates) by visible `\uXXXX` escapes in markdown and compact and by lossless `\uXXXX` JSON escapes in JSON and JSONL; and copy only allow-listed fields (never `rawSource` / `rawMetadata`). Hidden and structural messages are omitted and counted unless `includeHidden`. `RenderOptions` = `{ format, tz?, includeHidden?, markdownBody?: 'fenced' | 'raw', maxMessageChars? }`; `maxMessageChars` is reachable only through the SDK renderers (`MESSAGE_TRUNCATED`). The CLI merges envelope warnings that the dedicated renderers do not print into the JSON and JSONL output (`cli/warnings.ts`).

## 8. SDK facade (`src/sdk/gcr.ts`; full reference `docs/SDK.md`)

`Gcr.open({ dbPath, readOnly?, create?, actor?, clock? })` is synchronous. **Reads are synchronous and return `ResultEnvelope<T>`** (`ok: true`, `data`, `source[]`, `completeness`, `warnings[]`, `ids`, `untrustedContent`) or throw a `GcrError`; **mutators are asynchronous**, serialized by a per-handle writer lock, and reject with `WRITE_FORBIDDEN` on a read-only handle. While a mutator runs, every read method of the handle fails with `DB_ERROR` (`details.reason = "write_in_progress"`; ADR-0018); the instance method `doctor()` is not guarded because it inspects the file through its own read-only connection (`src/sdk/doctor.ts`).

| Group | Method (real signature, abridged) |
| --- | --- |
| Lifecycle | `static open(opts: GcrOpenOptions): Gcr`; `static doctor(opts?: DoctorOptions): DoctorReport`; `doctor(): DoctorReport`; `close(): void`; getters `isOpen`, `readOnly`, `dbLabel`, `actor` |
| Import | `importExport(opts: ImportOptions): Promise<ResultEnvelope<ImportReport>>`; `importManualCopy(text: string, opts?: ManualCopyOptions): Promise<ResultEnvelope<ImportReport>>` |
| Read | `list(opts?: ListOptions): ResultEnvelope<Page<ConversationSummary>>`; `get(ref: string \| ConversationRef, opts?: GetOptions): ResultEnvelope<GetResult>`; `getByUrl(url: string, opts?: GetOptions)`; `branches(ref, opts?): ResultEnvelope<BranchListResult>`; `thread(ref, opts?): ResultEnvelope<ThreadResult>`; `search(opts: SearchOptions): ResultEnvelope<Page<SearchItem>>` (overloaded by `scope`); `listBatches(): BatchInfo[]` (a plain list) |
| Analysis | `stats(opts: StatsOptions): ResultEnvelope<StatsReport>`; `audit(opts?: AuditOptions): ResultEnvelope<AuditReport>` |
| Graph | `buildGraph(opts?: BuildGraphOptions): Promise<ResultEnvelope<BuildGraphResult>>`; `graphQuery(q)`, `graphPath(from, to, opts?)`, `graphNeighbors(nodeId, opts?)`, `graphGodNodes(opts?)`, `graphExplain(ref: EdgeRef, opts?)` each returning a `ResultEnvelope`; `graphExportHtml(opts?)` and its alias `graphExport` return `GraphHtmlExport` (HTML string plus provenance fields, **not** wrapped in an envelope) |
| Drafts and notes | `createDraft(input): Promise<...>`, `archiveDraft(id)`, `getDraft(id)`, `listDrafts(filter?)`, `renderDraftMarkdown(id)`, `createAnnotation(input)`, `updateAnnotation(id, patch)`, `getAnnotation(id)`, `listAnnotations(filter?)`; every result carries `localOnly: true` |

Branch precedence for the primary thread (`get`, `thread`): explicit `branch` > the source's `current_node` > exactly one branch in the tree > the caller's opt-in `branchPolicy` (flagged `ACTIVE_BRANCH_HEURISTIC`) > `ACTIVE_BRANCH_UNKNOWN` (an error with the branch list and a remedy; with `allBranches` it is a warning and `thread` is null). Option objects are checked against allow-lists of key names (`OPTION_KEYS`): a misspelled option is `INVALID_ARGUMENT`, not a silently wider answer.
`envelope.ts` computes provenance: one `source` entry per contributing batch, completeness per contributing conversation capped by its batch row, overall value = the single common value or `mixed`, `unknown` when nothing contributed; whenever that is not `exported_tree`, `SOURCE_NOT_FULL_HISTORY` is the first warning. `src/index.ts` re-exports exactly the public API; `test/sdk/exports.test.ts` pins the sorted list of runtime exports. Format profiles of an import are kept in memory per handle and shown by `stats`/`audit` only for batches imported through that handle (they are not persisted).

## 9. MCP (`src/mcp/*`; full reference `docs/MCP_TOOLS.md`, schemas `docs/mcp-tool-schemas.json`)

Official SDK (`@modelcontextprotocol/sdk` 1.32.1), stdio transport, started by `node dist/mcp/entry.js --db <path>` or `gcr mcp`. The handle is opened **read-only** unless `--allow-local-writes` or `GCR_MCP_ALLOW_WRITES=1` (only the exact value `1` counts) is given (ADR-0016). The tool list is the same either way; `gcr_create_local_draft` and `gcr_update_local_annotation` answer `WRITE_FORBIDDEN` while writes are disabled. `gcr_import_export` checks the path policy first: with no approved root, or with a path outside the roots, it answers `IMPORT_PATH_NOT_ALLOWED` even while writes are disabled, and only an approved path reaches the `WRITE_FORBIDDEN` check (reproduced on 2026-10-11 with the real SDK `Client` over an in-memory transport, four server configurations).

| Tool | Kind | Annotations (`readOnly / destructive / idempotent / openWorld`) |
| --- | --- | --- |
| `gcr_list`, `gcr_get`, `gcr_search`, `gcr_branches`, `gcr_thread`, `gcr_stats`, `gcr_audit`, `gcr_graph_query`, `gcr_doctor` | read | true / false / true / false |
| `gcr_create_local_draft` | local write | false / false / false / false |
| `gcr_update_local_annotation` | local write; creates when no `annotationId` is given, updates (replaces the body, needs `expectedVersion`) when it is | false / **true** / false / false (an update overwrites the old text; lead decision 2026-10-11) |
| `gcr_import_export` | local write; needs `--allow-local-writes` **and** a path inside `GCR_APPROVED_IMPORT_ROOTS` | false / false / true / false |

Every tool has a strict zod input schema with bounds; every result, success or failure, is one flat `McpEnvelope` JSON (`ok`, `data`, `error{code,message,remedy,details}`, `source`, `completeness`, `warnings`, `ids`, `untrustedContent`, `truncated`) placed byte-identically in `structuredContent` and in the text block, with `isError: true` on failure. The registry installs its own `tools/call` handler so that argument errors carry `INVALID_ARGUMENT` instead of the SDK's free text. Result size is capped (default 200,000 bytes, `GCR_MCP_MAX_RESULT_BYTES` 8,192 to 3,000,000): oversize results are reduced at item boundaries, never cut mid-item, with `truncated: true` and `RESULT_TRUNCATED`. Tool deadline 30 s (import 600 s). Approved roots are canonicalized with `realpath` at startup; a candidate must resolve inside one of them, `..` segments are refused, and every refusal has the same message. The legacy-alias mechanism (`aliases.ts`, `DEPRECATED_TOOL_ALIAS`) exists and is tested, and the alias table is **empty** (ADR-0002). No tool can send, post or fetch anything from chatgpt.com. Descriptions and schemas are static text and tell the model that returned conversation text is untrusted data.

## 10. CLI (`src/cli/*`; full reference `docs/CLI_REFERENCE.md`, captured help `docs/CLI_HELP.txt`)

| Command | Purpose |
| --- | --- |
| `gcr doctor` | Self-check: Node, SQLite and FTS5, schema status of a database, environment knobs (present or absent only), capability modes A to E |
| `gcr import <path or ->` | Official export (ZIP, folder, `conversations*.json`, stdin); options `--account`, `--provider`, `--strict`, `--max-entries`, `--max-entry-bytes`, `--max-total-bytes`, `--max-ratio`, `--max-element-bytes` |
| `gcr import-copy <file or ->` | Mode B manual copy |
| `gcr batches`, `gcr list`, `gcr get`, `gcr search`, `gcr branches`, `gcr thread`, `gcr stats`, `gcr audit` | Reads |
| `gcr graph build / query / path / neighbors / god-nodes / explain / export` | Derived graph (`export` writes one HTML file with mode 0600 and never overwrites without `--force`) |
| `gcr draft create / list / show / archive`, `gcr annotate create / update / list / show` | Local drafts and notes (never sent) |
| `gcr mcp` | Run the MCP server over the database |

Global options: `--db <path>` (default `$GCR_DB`, else `./.gcr/gcr.sqlite`; only the default directory is created, with mode 0700, and only on a first write), `--format json|markdown|compact|jsonl` (default `markdown`), `--tz <IANA>`, `--quiet`, `--debug`, `-h/--help`, `-V/--version`. Exit codes come from `EXIT_CODES` in `src/errors.ts` (0 success, 1 internal, 2 bad arguments, 3 lookup, 4 import, 5 storage, 6 write refused or annotation conflict, 7 boundaries); errors are printed as JSON on stderr when `--format json` is given. An unknown command is never executed or guessed. `gcr --help` never loads SQLite.

## 11. Testing conventions

* Runner: `node:test` over compiled output. `npm test` runs `pretest` (`tsc -p tsconfig.json`, which compiles `src/` and `test/` to the git-ignored `dist-test/`) and then `node --test --test-concurrency=2 "dist-test/test/**/*.test.js"`. `npm run build` compiles only `src/` to `dist/` (`tsconfig.build.json`). Tests live in `test/`, mirror `src/` (`analysis cli db devtools domain drafts entities format graph ingest mcp sdk`) and add `test/security` (the no-network and repository-boundary scan) and `test/scripts` (the CI smoke, coverage, performance and no-network-guard scripts). Property tests use `fast-check` with a fixed seed that is printed on failure.
* **Synthetic data only**, generated in tests or kept under `fixtures/chatgpt` and `fixtures/claude` (each fixture carries the marker the privacy scan requires). Helpers: `test/helpers/zip-builder.ts` (in-memory ZIPs with arbitrary names, methods and headers), `chatgpt-export-builder.ts`, `claude-export-builder.ts`, `records.ts`, `tmp.ts` (temp directories). No real export is ever used, so every format statement in the documentation is `synthetic-only`.
* Every P0 requirement has positive and negative tests; security tests (ZIP, FTS, HTML injection, prompt injection treated as data, log hygiene, no network) are explicit. Tests assert behaviour; the code under test is not mocked. MCP is tested with the real SDK `Client` over an in-memory transport and over real stdio (`test/mcp/stdio.e2e.test.ts`).
* Measured on 2026-10-11 in a sandbox with 4 CPUs and a load average between about 3 and 16 (other jobs ran at the same time, so the durations are not benchmarks). The tests were compiled into a private directory (`tsc -p tsconfig.json --outDir`) at 13:21Z and again at 13:45Z; both compiles contain 6,750 tests in 905 suites. Other agents kept adding test files and editing `scripts/` while these runs were going, so the repository's own test count is higher than 6,750 by now and the numbers below describe those compiles, not the final tree. The two skips in every run are permission tests that skip themselves when the process runs as root, which it did.
  * **Node 22.22.0**: 6,750 tests, 6,748 pass, 0 fail, 0 cancelled, 2 skipped, 417.9 s (13:21:51Z to 13:28:49Z).
  * **Node 22.16.0** (the declared minimum): 6,750 tests, 6,748 pass, 0 fail, 0 cancelled, 2 skipped, 365.3 s (13:28:49Z to 13:34:54Z).
  * Second pair, started 13:45Z while another agent was rewriting `scripts/ci-smoke.mjs`: on 22.22.0 6,747 pass and **1 failed** (`test/scripts/ci-smoke.sabotage.mcp.test.ts`, the `http.get` sabotage case), against the intermediate version of that script; on 22.16.0 6,748 pass, 0 fail, 362.6 s (13:52:59Z to 13:59:02Z). Re-running only the three compiled `ci-smoke.*.test` files (`pass`, `sabotage.cli`, `sabotage.mcp`; 4 suites) on 22.22.0 against the next version of the script gave 14 of 14 tests passing (about 124 s, finished 14:08Z), and a third full run on 22.22.0 (14:08:05Z to 14:17:14Z, 549.3 s, load 13 to 16) gave 6,750 tests, 6,748 pass, 0 fail, 2 skipped. The script was edited again at 14:13Z, during that last run; a run against the final version of `scripts/ci-smoke.mjs` and `scripts/no-network-guard.cjs` was not made by this task (NOT VERIFIED).
  * Node 24 and later are not available in this sandbox and are **untested**. The GitHub Actions workflow `.github/workflows/gcr-ci.yml` has **never run** on GitHub.
* Documentation consistency is itself tested where cheap: `test/db/schema.adversarial.test.ts` reads section 3 of this file and compares it with the real schema; `test/sdk/docs.test.ts` and `test/mcp/docs.consistency.test.ts` do the same for `docs/SDK.md` and `docs/MCP_TOOLS.md`. The warning-code catalogue has a script-based check (`docs/WARNING_CODES.md`, section 2), not a repository test.

## 12. Known deviations from the original contract

Each row is a place where the build differs from the pre-implementation text of this file or from `SPEC.md` / the runbook, and why.

| # | Original contract | As built | Why / evidence |
| --- | --- | --- | --- |
| 1 | Node `>=22.13` with "FTS5 verified available" (original section 1; `docs/REPO_RUNBOOK.md` states the same for the baseline package, whose own `package.json` was never available, ADR-0001) | `>=22.16.0` | `node:sqlite` in 22.13 to 22.15 has no FTS5, so the original "verified available" holds only from 22.16.0 (ADR-0012; re-checked on 2026-10-11 on 12 real Node binaries from 22.13.1 to 22.21.1 plus the system 22.22.0). The run on the declared minimum is in section 11. |
| 2 | `source_kind` in `'zip' \| 'conversations_json' \| 'conversation_shards' \| 'stdin_json'` | Written: `'zip'`, `'conversations_json'`, `'directory'`, `'stdin_json'`, `'manual_copy'`. `'conversation_shards'` is never produced | Shards in a ZIP or folder are `'zip'` / `'directory'`; the shard layout is reported in `FormatProfile.layout` (`single`, `sharded`, `nested`, `directory`, `stdin`; the type also admits `unknown`, which no code path sets). The comment on `ImportBatchMeta.sourceKind` in `repo.ts` still lists `conversation_shards` (stale comment). |
| 3 | FTS design delegated to the implementer | Two contentless FTS5 tables over `buildSearchText`; JS snippets; marker `fts_design` | Section 3 and 6. Index size 0.43 times the raw text on 50,000 synthetic messages (`docs/PERFORMANCE.md`; the contract allowed about 3 times). |
| 4 | Tables as listed; pragmas `foreign_keys`, `journal_mode = WAL`, `busy_timeout`, `trusted_schema = OFF` | Added `source_batch_stats`, three secondary indexes (`conversations_by_conv`, `conversations_by_batch`, `conversation_heads_by_conv`), three derived indexes created by `graph build`, triggers on `source_batch_stats`; `PRAGMA application_id`, `recursive_triggers = ON`, `query_only` for read-only opens, and the `gcr_meta` row `fts_design` | The immutable batch row cannot hold node counts; lookups by id would scan; `recursive_triggers` stops `INSERT OR REPLACE` from bypassing the delete triggers; `application_id` lets the opener refuse a foreign SQLite file. |
| 5 | Warning codes named in the original: `MISSING_PARENT`, `CHILD_PARENT_MISMATCH`, `CYCLE_DETECTED`, `DUPLICATE_NODE_ID` (as an adapter warning only), `ACTIVE_BRANCH_HEURISTIC`, `INVALID_CURRENT_NODE`, `UNKNOWN_CONTENT_TYPE` | 116 distinct codes, including `SELF_PARENT`, `CURRENT_NODE_NOT_LEAF`, `BRANCH_LIMIT_EXCEEDED`, `COMPLETENESS_LOWERED`, `SOURCE_NOT_FULL_HISTORY`, the manifest and shard codes | `docs/WARNING_CODES.md`, generated from the code. |
| 6 | The original is silent on a read issued while a write runs on the same handle | A read on a handle whose writer lock is held fails with `DB_ERROR` / `write_in_progress` | A read during an import would see uncommitted rows (ADR-0018). |
| 7 | Duplicate ids "can't occur within one record set (the adapter dedups with `DUPLICATE_NODE_ID` warning)" | `analyzeTree` also tolerates duplicate ids and reports `DUPLICATE_NODE_ID` itself. The ChatGPT adapter pre-scans the raw element text: `JSON.parse` keeps the last duplicate, every body is hashed into `rawMetadata._gcr`, and a duplicated structural key lowers completeness; the runner additionally resolves duplicate conversations across shards (section 5) | Silent loss of an alternative reading would be a false completeness claim. |
| 8 | ZIP: reject CRC and size mismatch, ZIP64 beyond limits | ZIP64 is supported within limits; sizes and CRC come from the central directory only; local-header sizes and CRC are never compared; one level of nested ZIP is supported | ADR-0017. |
| 9 | JSON stream: per-element byte limit | Plus a nesting limit of 10,000 (file-level failure), an adapter nesting cut at 256, and a Claude limit of 128 (element-level failure) | ADR-0013. |
| 10 | Thoughts kept as labelled blocks, excluded from default rendering | Same, implemented through a `hidden` flag on the whole message (`system` role, `is_visually_hidden_from_conversation`, four scaffolding content types); reference blocks leave `[image]` / `[audio]` / `[file]` placeholders in `text` | ADR-0014. |
| 11 | Claude export normalized "-> same model"; completeness and current node not specified | Always `rendered_active_view_only`; `currentNodeId` set only when the messages form one chain | ADR-0015. |
| 12 | MCP: 8 read tools, 2 local-write tools, `gcr_import_export` | 12 tools: adds `gcr_doctor`; `gcr_update_local_annotation` also creates; its `destructiveHint` is true (contract: false); writes need `--allow-local-writes`; import needs both that and approved roots, listed with the platform path delimiter (`:` on POSIX, `;` on Windows) where the original said colon-separated; flat envelope with `truncated`; result cap and deadlines | ADR-0016, section 9. There are no `RESULT_TOO_LARGE` or `DEADLINE_EXCEEDED` error codes: a deadline is `INTERNAL_ERROR` with `details.reason = "deadline_exceeded"`. |
| 13 | `chatgpt_*` legacy aliases "where safe" | Mechanism implemented and tested; table empty | The v0.1.1 names are unknown (ADR-0001, ADR-0002). Earlier text claiming more was removed. |
| 14 | `ImportReport`: batch id, counts, warnings, per-file results | Plus `formatProfile` (observed facts, not persisted) and `alreadyImported` | Section 4 and 8. |
| 15 | SDK: every read returns a `ResultEnvelope` | Exceptions: `listBatches()` returns a plain array; `graphExportHtml()` returns an HTML string with flat provenance fields; `Gcr.doctor()` returns a `DoctorReport` | Documented in `docs/SDK.md`. |
| 16 | Graph clustering unspecified | One method: label propagation (`clusterMethod` accepts only `'label_propagation'`); the graph records no build scope or time, so staleness (`GRAPH_STALE`) is derived from the evidence rows | ADR-0019. |
| 17 | A synthetic-data helper module named `synthetic.ts` in the test helpers | Does not exist; the helpers that do exist are listed in section 11 | Corrected. |
| 18 | `console.*` forbidden outside CLI output | No `console.<method>(` call anywhere in `src/` (comments mention it) | CLI output uses `process.stdout/stderr.write` through `cli/output.ts`. |
| 19 | Draft body limit not specified | Draft body 256 KiB and annotation body 64 KiB in UTF-8 bytes (SDK, `MAX_DRAFT_BODY_BYTES`, `MAX_ANNOTATION_BODY_BYTES`); the MCP input schema is stricter and counts characters (UTF-16 code units): 65,536 for a draft body, 16,384 for an annotation body | `drafts.ts`, `mcp/tools.ts`. |
| 20 | Licensing not mentioned in the original | `"license": "UNLICENSED"`, `"private": true`, no LICENSE file; CCR has no LICENSE file in the two local checkouts and no CCR code is claimed to be copied | ADR-0008 (including the weak no-copy check). |
| 21 | Open-time checks: `DB_SCHEMA_TOO_NEW`, `DB_MIGRATION_FAILED` | Also: an FTS5 probe before any file is touched (`FTS5_UNAVAILABLE`), refusal of a foreign SQLite file (`not_gcr_database`), `file:` URIs refused, new files created `0600`, `Gcr.open` looks before it writes (`peekOpenRefusal`) | Section 3; ADR-0012, ADR-0021. |
| 22 | Inputs: official ZIP, `conversations.json`, sharded files; no manual copy | Mode B manual copy (`manual-copy.ts`, `Gcr.importManualCopy`, `gcr import-copy`) | SPEC section 3 lists Mode B; the original architecture text did not. |
| 23 | Search order `bm25 ASC, created_at ASC NULLS LAST, conversation_id ASC, message_id ASC`; snippets via `snippet()` | The order ends with `provider, account_label, source_batch` so it is total across accounts and snapshots; snippets are built in JavaScript from the original text | Section 6; contentless FTS tables have no `snippet()`. |

## 13. Known limitations that shape the design

Reviewer-originated notes (kept from the integration list) and facts confirmed by running the code on 2026-10-11:

* **Batch-level completeness is nominal.** The batch row is written after the transaction opens and before any adapter ran, so `source_batches.completeness` is the adapter's nominal level (`exported_tree` for ChatGPT, `rendered_active_view_only` for Claude, `unknown` when no conversation object was found). The runner adds `COMPLETENESS_BELOW_BATCH_LEVEL` when conversations turned out weaker; the per-conversation column is authoritative and the SDK envelope never lets a conversation exceed its batch row. Making the batch value read live, and a public `getBatchStats(batchId)` on the repository, were planned and are **not implemented**.
* **`maxNestedZipBytes` is not part of `ImportLimits`** (it is a constant in `layout.ts`, an option of `discoverInput` only), so it cannot be set from `ImportOptions` or the CLI.
* **An element that has both a `mapping` object and a `conversations` array** is neither unwrapped nor imported: it is skipped with `NOT_A_CONVERSATION` (reproduced on 2026-10-11 with a synthetic file: the sibling conversation was imported, the ambiguous element was not). Whether that is the intended rule has not been confirmed by an owner.
* Format profiles exist only in memory for batches imported through the same `Gcr` handle; the graph tables record no build scope or time; reads are refused during writes (`write_in_progress`).
* `node:sqlite` reads are synchronous and cannot be cancelled: the MCP deadline only stops waiting for asynchronous work; a write that was started may commit after a deadline error. The approved-root check and the later open are two filesystem operations (mitigated by canonical paths, narrowed by checking twice, not closed). A single SDK item larger than the MCP cap (for example one 5 MB message) cannot be returned over MCP. Reported by the MCP reviewers and consistent with the code read; not separately reproduced here.
* Reported by the SDK builder and not re-verified here: `SDK 1.32.1` accepts `tools/call` before `initialize` and drops malformed requests that carry an id (behaviour outside `src/mcp`).
* Stale code comments found while writing this file (not edited here, documentation task only): `db/repo.ts` lists `conversation_shards` as a `sourceKind`; `db/open.ts` `closeDatabase` mentions `engines` allowing 22.13; the comment in `src/version.ts` refers to a `version.test.ts` that does not exist; the header of `ingest/import-runner.ts` says an oversize element "aborts its file" while the code and its test abort the whole import.

## 14. Cross-references

| Topic | Document |
| --- | --- |
| Decisions and their evidence | `docs/DECISIONS.md` (ADR-0001 to ADR-0021) |
| Every warning code | `docs/WARNING_CODES.md` |
| SDK reference | `docs/SDK.md` |
| MCP tools and safety model | `docs/MCP_TOOLS.md`, `docs/mcp-tool-schemas.json` |
| CLI reference | `docs/CLI_REFERENCE.md`, `docs/CLI_HELP.txt` |
| Import behaviour, limits, troubleshooting | `docs/IMPORT_GUIDE.md`, `docs/IMPORT_FORMAT.md`, `docs/ADAPTERS.md` |
| Boundaries and the browser gate | `docs/SECURITY_AND_BOUNDARIES.md`, `docs/BROWSER_GATE.md` |
| Plan, parity, performance | `docs/EXECUTION_PLAN.md`, `docs/PARITY_MATRIX.md`, `docs/PERFORMANCE.md` |
