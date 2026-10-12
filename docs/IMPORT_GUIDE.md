# Import guide (operator-facing)

Audience: the person who owns a ChatGPT (or Claude) data export and wants GCR to index it locally.
Normative companions: `SPEC.md` sections 3-5, `docs/ARCHITECTURE.md` sections 2 and 5, `docs/ADAPTERS.md`.
Code: `src/ingest/layout.ts` (what is in the input), `src/ingest/import-runner.ts` (the import), `src/ingest/manual-copy.ts` (Mode B).

Options are named here by their SDK names (`accountLabel`, `provider`, `strict`, `limits`, `clock`). `--strict` is the CLI spelling named in `docs/ARCHITECTURE.md`; the other flag names are defined by the CLI module, so check `gcr import --help`. A `--provider` / `--account` mention below means the corresponding option.

## 1. What import does, and what it never does

GCR imports data **you already hold**: an official export ZIP, the extracted folder, a `conversations.json` file, or the same JSON on standard input.
It reads those bytes on this machine and writes a local SQLite database. That is all.

* It never downloads an export, never calls a ChatGPT or Claude endpoint, never uses browser cookies or a session, never signs in for you.
  A `https://chatgpt.com/c/<uuid>` link is only a lookup key into data you imported; it is never opened.
* Imported conversation text is **untrusted data**. It is stored and searched, never executed, and it never appears in logs, error messages or import reports.
* Imports are **atomic**: either the whole batch is stored or the database is unchanged.

## 2. Requesting the export

What follows is what OpenAI states in its Help Center article "How do I export my ChatGPT history and data"
(`help.openai.com`, article 7260999). Status: **OFFICIAL, but unverified by fetch**: the article could not be downloaded while GCR was designed,
so these statements come from a search-engine summary of it that a second source corroborates. Check the live article before relying on a detail.

1. Two routes exist: in ChatGPT, **Settings > Data controls > Export data > Export** (then confirm on the next screen), or the **Privacy Portal**
   (Make a Privacy Request > consumer ChatGPT account > Download my data).
2. You get an email or SMS when the export is ready. Delivery can take up to **7 days**; the download link expires **24 hours** after you receive it.
3. The Settings route is offered for Free, Plus, Pro and eligible ChatGPT Edu workspaces, **not** for Business or Enterprise workspaces (ask the workspace owner).
4. The download is a ZIP with "your chat history and other relevant account data".
5. An export cannot restore chats that were already deleted.

OpenAI publishes **no** description of the file names or JSON fields inside the archive. Everything GCR knows about `conversations.json`,
`conversations-NNN.json` and `export_manifest.json` was observed by third parties and is exercised by GCR only against **synthetic** fixtures.
GCR has not been verified against a live export. If your export does not import, the layout may have changed: see section 13.

## 3. What GCR looks for

| Item | Rule |
|---|---|
| Conversation files | basename `conversations.json` or `conversations-<N>.json`, case-insensitive, at any depth inside a ZIP (up to 4 folder levels in a folder) |
| Manifest | `export_manifest.json` (optional; only ever produces warnings) |
| Auxiliary files | `user.json`, `user_settings.json`, `message_feedback.json`, `shared_conversations.json`, `model_comparisons.json`, `group_chats.json`, `library_files.json`, `conversation_asset_file_names.json`, `chat.html` (and Claude's `users.json`, `projects.json`): **counted by name, never opened** |
| Everything else | listed **by name only** so that attachments can be marked "present in the export"; never read |
| Ignored junk | `__MACOSX/`, `._*`, `.DS_Store` |

Detection is by **content**, not by extension: `PK\x03\x04` or `PK\x05\x06` starts a ZIP, `[` or `{` (after an optional UTF-8 BOM and whitespace) starts JSON text,
UTF-16/UTF-32 is refused, and anything else gets one chance as a ZIP with a stub in front of it (self-extractor style).

The provider (ChatGPT or Claude) is detected per file by looking at the first recognizable conversation (`mapping` object versus `chat_messages` array).
All files of one import must agree; otherwise import them separately. `--provider` forces the choice; if it contradicts the data you get a `PROVIDER_MISMATCH` warning
and the non-matching elements are skipped one by one.

## 4. Supported layouts

| Layout (`formatProfile.layout`) | Input | Notes |
|---|---|---|
| `single` | ZIP containing `conversations.json`, or the JSON file itself | A single explicit file may have any name; it is recorded as `conversations.json`, so renaming never changes the batch identity |
| `sharded` | ZIP with `conversations-000.json`, `-001.json`, ... (optionally plus `export_manifest.json`) | Order is by the **integer** suffix (`-2` before `-10`, `-999` before `-1000`); the plain `conversations.json` comes first |
| `nested` | Outer ZIP holding `Conversations__...part-001.zip` (the Privacy Portal "ZIP-in-ZIP" layout) | **One** level is opened; see the limits; the `Files__...` part archives are not opened |
| `directory` | An extracted folder | Depth cap 4, entry cap, symlinks never followed |
| `stdin` | JSON text on standard input (`gcr import -`) | Buffered in memory under `maxElementBytes x 4`; a ZIP cannot be piped |
| (inside any of the above) | a top-level array, one top-level conversation object, `{"conversations": [...]}` wrapper (without `mapping`), or JSON Lines (one conversation per line) | Wrapper members are cut out of the wrapper's own text one at a time (nothing is parsed or re-serialized, so their bytes and element hash equal the bare-array case); one broken member does not affect its siblings (`WRAPPER_OBJECT_FORMAT`) |

`sourceKind` stored with the batch: `zip`, `conversations_json`, `directory`, `stdin_json`, `manual_copy`. (`conversation_shards` is reserved and not produced today.)
`sourceLabel` is the **basename** of what you gave GCR, never an absolute path.

### Manifest

When `export_manifest.json` has `version: 1` and `logical_files["conversations.json"].files` is a non-empty list of strings, that list is the expected shard set.
GCR reconciles it with what it found:

* `MANIFEST_SHARD_MISSING`: listed but absent (the import continues with what exists);
* `SHARD_NOT_IN_MANIFEST`: present but unlisted (it is imported anyway);
* `MANIFEST_COUNT_MISMATCH`: the manifest disagrees with itself (`export_files_count` versus `export_files`, `logical_files_count` versus `logical_files`);
* `MANIFEST_INVALID`: malformed JSON, wrong types, unknown `version`, larger than 16 MiB, or paths that leave the container (those paths are ignored, never followed);
* `MANIFEST_AMBIGUOUS` (info): several manifests, the outermost was used; `MANIFEST_ABSENT` (info): shards without a manifest; `SHARD_GAP` (info): numbering is not contiguous.

None of these is a failure unless you pass `--strict`.

## 5. What is not supported

* ZIP inside ZIP inside ZIP (a nested archive that itself holds a `*conversations*.zip`): refused with a remedy, see section 13.
* Encrypted ZIPs, ZIPs using methods other than STORE/DEFLATE, multi-disk archives, symlink entries, path traversal, duplicate names: refused (`IMPORT_ZIP_UNSAFE`).
* UTF-16 / UTF-32 text: re-save as UTF-8.
* A ZIP on standard input.
* Following symlinks inside a folder, FIFOs, devices. Folder entries whose names contain control characters, C1 controls, line/paragraph separators or bidi overrides are ignored (the same names make a ZIP unsafe).
* Archives inside a **folder**: a folder that holds `Conversations*.zip` part archives (an extracted ZIP-in-ZIP export) is not searched inside them. The error says so; import one part ZIP itself or extract it.
* Several conversation files at different depths or in different parts are all imported (no "ambiguous export" error); conversations they have in common are resolved by the rule in section 9.
* Fetching anything, or importing a URL.
* Resuming a partially written import: imports are all-or-nothing.
* An element larger than `maxElementBytes` cannot be skipped (the streaming splitter cannot resynchronize), so it aborts the import with `IMPORT_LIMIT_EXCEEDED`.

## 6. Limits

Every limit is finite and explicit; there is no way to switch one off. `Partial<ImportLimits>` is merged over the defaults and validated (zero, negative, `NaN`, `Infinity` and unknown names are `INVALID_ARGUMENT`).

| Limit | Default | Guards against |
|---|---|---|
| `maxZipFileBytes` | 64 GiB | absurd archive offsets |
| `maxEntries` | 20,000 | entry-count bombs (also bounds a folder walk) |
| `maxEntryNameBytes` | 1,024 | long names |
| `maxEntryUncompressedBytes` | 2 GiB | one huge entry |
| `maxTotalInflatedBytes` | 8 GiB | cumulative inflation; **per pass** (the import reads each file twice, so the archive reader budget is twice this value) |
| `maxCompressionRatio` | 200 : 1 (entries up to 64 KiB exempt) | decompression bombs |
| `maxElementBytes` | 256 MiB | one huge conversation / unterminated string; stdin buffer is 4 x this |
| `maxExtraFieldBytes` | 16 KiB | oversized ZIP extra fields and comments |
| nested ZIP, per archive | 256 MiB (`MAX_NESTED_ZIP_BYTES` in `layout.ts`; `maxNestedZipBytes` option of `discoverInput`) | inflating an inner archive into memory |
| nested ZIP, all together | 4 x the nested limit in bytes, and 4 x `maxEntries` entries over the outer and all inner archives | memory use by many parts (`TOO_MANY_ENTRIES`) |
| `export_manifest.json` | 16 MiB | manifest bombs |
| folder depth | 4 levels | deep or looping trees |
| Mode B | 10,000 messages; 1 MiB text per message; 64 MiB text in total; 128 MiB document | pasted-document abuse |

Nested archives, the outer archive and both import passes are charged to **one** shared budget, so a small outer ZIP cannot hide a large inner one.

Raise a limit only for input you trust. From the SDK pass `limits: { maxElementBytes: ... }`. The CLI forwards the same names; check `gcr import --help` for the flags it currently offers.

Standard input is copied into one buffer that never grows beyond `maxElementBytes x 4` (many tiny chunks cost no more than their bytes).

Memory: the import keeps one map entry per distinct conversation id (O(number of conversations); elements without an id, such as `{}` or `null` entries, cost only a counter) and holds ONE conversation element at a time. Measured on the synthetic baseline
(50,000 messages in 500 conversations, `test/ingest/import-runner.scale.test.ts`) the import runs at roughly 20,000 messages per second on a development machine with a heap growth of a few tens of MiB.
A **single** huge conversation is the expensive case: its JSON text, the normalized record and SQLite statements coexist (about 10x the JSON size was measured for one 22 MB conversation),
so on a small machine lower `maxElementBytes` rather than leaving the 256 MiB default.

## 7. Privacy guidance

* Keep exports and the database **outside Git**. GCR's privacy scanner (`src/devtools/privacy-scan.ts`, run by `scripts/privacy-scan.mjs`) refuses databases, archives and raw exports in a repository; do not allow-list them.
* Auxiliary files (`user.json` holds your email address and phone number; feedback and shared-link files hold free text) are **never read**. They are only counted.
* Reports and error messages contain codes, counts, ids and relative file names. They never contain titles, message text, or absolute paths. If you find an exception, treat it as a bug.
* Prefer a local database on an encrypted disk. Do not upload exports to a coding agent or CI; CI uses synthetic fixtures only.
* A distinct `--account` label per person or account keeps their conversations apart even when ids collide.

## 8. Idempotency and snapshots

* **Batch id** = `b_` + first 32 hex of `sha256(provider NUL accountLabel NUL contentDigest)`. **contentDigest** = sha256 of the sorted lines `<file name>\t<sha256 of the file's bytes>` over the conversation files that were read.
  Consequently: re-importing the same input is a no-op (`alreadyImported: true`, same counts, database untouched, the adapters are not run again); re-zipping the same files in a different order or compression gives the same batch;
  the same bytes arriving as ZIP, folder, plain file or stdin give the same batch; a **different** export, even of the same conversations, is a **new** batch.
* An already-imported report restores the first import's warning summaries and failure count from the stored batch, but not the per-file failure counts or the format profile (those come from running the adapters).
* **Snapshots and head selection**: every batch is an immutable snapshot. For each `(provider, account, conversation id)` the **head** is the snapshot with the greatest conversation `updated_at` (missing = lowest),
  ties going to the later import. Reads and search use the head by default; `batchId` pins an older snapshot. Older snapshots are kept (provenance), so re-importing newer exports grows the database.
* A re-import with `--strict` of an input whose first import recorded problems is refused for the same reasons.

## 9. Duplicate conversations

The same conversation id can appear in several shards (or in a plain `conversations.json` next to shards). Only objects the adapters accept as **conversations** take part: a ChatGPT conversation (an own `mapping` key, no `conversations` array) is keyed by `conversation_id`, else `id`; a Claude conversation (`chat_messages` is an array) by `uuid`. UUIDs are compared lower-case.
Elements without a usable id, and stray objects that merely carry the same id but are not conversations (they are reported as `NOT_A_CONVERSATION`), are never duplicates and can never displace a real conversation. The winner is chosen by this total order:

1. the greatest update time (`update_time`; Claude: `updated_at`); a missing value is the lowest;
2. then the largest element, in source bytes (wrapper members: the member's own bytes);
3. then the earliest file in the processing order (plain `conversations.json`, then numeric shard order, ties by name);
4. then the earliest element index within the file.

Levels 1 and 2 depend only on the data. Levels 3 and 4 depend on the name-derived file order, never on the order of entries inside the ZIP.
Every loser is counted as `DUPLICATE_CONVERSATION` (sample ids are conversation ids; the stored message names the winner and the loser of the first example).
The winner is decided from identity metadata alone: if it later fails normalization, the loser is **not** tried. `--strict` aborts on any duplicate.

## 10. Default versus `--strict`

Default: element failures, framing failures, skipped entries and manifest problems become warnings; the import continues.

* A well-framed element that is not valid JSON, or whose normalized record fails validation: `ELEMENT_PARSE_FAILED`, skipped.
* `{}`, `null` and scalar entries: `EMPTY_CONVERSATION_ENTRY` / `NON_OBJECT_ENTRY`, counted. An object that is not a conversation of the selected provider: `NOT_A_CONVERSATION`.
* A file that stops being well-formed JSON part-way (truncated download): the elements before the break are kept, `FILE_PARSE_FAILED` names the file, the rest is lost.
  If **nothing** could be read at all, the import fails with the parse error instead of storing an empty batch.
* An unexpected exception while normalizing one element: `ELEMENT_INTERNAL_ERROR` (counts only are logged).
* Bytes that are not valid UTF-8 are replaced by U+FFFD by the decoder; `INVALID_UTF8` counts the affected elements (best effort: a damaged 3-byte sequence replaced by exactly one U+FFFD is not noticed). The batch identity covers the original bytes. Not an error, also not under `--strict`.
* A conversation file whose top-level value is a single scalar (text, number, `true`/`false`/`null`) is not a damaged export but another kind of file: with nothing else to read it is `IMPORT_UNSUPPORTED_FORMAT` (`TOP_LEVEL_NOT_ARRAY`); next to good shards it is a `FILE_PARSE_FAILED` warning.

`--strict` aborts with the precise `GcrError` and stores nothing on: any of the above failures (not `{}`/`null`/scalar entries), a manifest warning, `PROVIDER_MISMATCH`, or a duplicate loser.

## 11. The format profile

Each fresh import report carries `formatProfile`: **observed facts**, not a guessed version number. Read it before over-interpreting statistics.

| Field | Meaning |
|---|---|
| `layout`, `manifest` | container facts (`present` / `absent` / `invalid`) |
| `wrapperObject` | some elements were `{"conversations": [...]}` wrappers |
| `conversations`, `conversationsWithCurrentNode` | normalized conversations; how many named a valid active node |
| `nodesWithChildrenDeclared` / `nodesWithChildrenAbsent` | exports since mid-2026 may omit `children`; absent edges are derived from `parent` pointers (one `CHILDREN_ABSENT` warning per conversation) |
| `roleCounts`, `messagesWithRecipient`, `messagesWithStatus`, `messagesWithModelSlug`, `hiddenMessages` | a trimmed export has no system/tool messages and no recipients, so role counts of such an export say little about the real conversation |
| `rootIsLiteralClientCreatedRoot` | every conversation has the literal `client-created-root` (false for newer ordinary-UUID roots, for Claude, or when mixed) |
| `auxiliaryFilesIgnored`, `assetsExtensionless` | auxiliary files counted but not read; assets named `<id>.dat` |

Batch completeness: the batch row records the adapter's **nominal** completeness (ChatGPT `exported_tree`, Claude `rendered_active_view_only`; `unknown` when no conversation was found) because the row is written before the adapters run.
Each conversation carries its own, authoritative `completeness`; the warning `COMPLETENESS_BELOW_BATCH_LEVEL` reports how many turned out weaker.

## 12. Mode B: manual copy

When you only have some messages (copied by hand), import them as a **partial** conversation. Nothing is read from ChatGPT; the result is always flagged `user_supplied_copy` / `partial_user_supplied`.

```json
{
  "conversationId": "00000000-0000-4000-8000-0000000000aa",
  "title": "Optional title",
  "sourceUri": "https://chatgpt.com/c/<uuid>",
  "messages": [
    { "role": "user", "text": "first message", "createdAt": "2025-03-04T05:06:07Z" },
    { "role": "assistant", "text": "reply", "modelSlug": "name-you-know" }
  ]
}
```

* `messages` is required (1 to 10,000). `role` and `text` are required for each message. `createdAt` (ISO-8601 **with** a zone, normalized to UTC milliseconds) and `modelSlug` are optional and are stored only when you give them; GCR never infers either.
* `conversationId` (UUID) is optional. Without it GCR derives a deterministic UUID-shaped id from the content (`CONVERSATION_ID_SYNTHESIZED`), so importing the same content again is a no-op.
* `sourceUri` must be exactly `https://chatgpt.com/c/<uuid>` (anything else is `INVALID_URL`). It is stored as a label and **never opened**.
* The messages become a **linear** chain in the order given. There is no invented root node and `currentNodeId` stays `null`: you did not say which branch was active, and GCR does not guess.
* Unknown keys are ignored with `UNKNOWN_KEY_IGNORED` (a count; the key names are not echoed). NUL characters are removed (`NUL_STRIPPED`), lone surrogates replaced (`LONE_SURROGATE`).
* The warning `PARTIAL_USER_SUPPLIED` is in the record, the stored batch and the import report, always.
* A partial copy has no `updated_at`, so it never displaces a dated official export as the head of the same conversation id; it stays available as its own pinnable snapshot.
* `sourceKind` is `manual_copy`.

## 13. Troubleshooting by error code

Every failure is a `GcrError` with a stable `code`, usually a `details.reason`, and a `remedy`. Messages never contain conversation text or absolute paths.

| Code | `details.reason` (examples) | What happened | What to do |
|---|---|---|---|
| `IMPORT_INPUT_NOT_FOUND` | `NOT_FOUND`, `NOT_READABLE` | The path does not exist or cannot be read | Check the path and permissions. GCR never downloads anything |
| `IMPORT_UNSUPPORTED_FORMAT` | `NO_CONVERSATION_FILE` | No `conversations.json` / `conversations-<N>.json` was found (`entriesSeen`, `depthLimitReached`, `nestedArchivesInFolder`) | Import the official ZIP, the extracted folder or the file itself; deeper than 4 folder levels needs a closer folder; a folder of `Conversations*.zip` parts: import a part ZIP itself |
| | `NOT_A_ZIP`, `NOT_REGULAR_FILE`, `STDIN_NOT_JSON` | The input is neither a ZIP nor JSON text | Provide the export ZIP or the JSON file |
| | `UNSUPPORTED_ENCODING` | UTF-16 / UTF-32 text | Re-save as UTF-8 or download a fresh export |
| | `TOP_LEVEL_NOT_ARRAY` | A conversation file holds one JSON scalar instead of a list of conversations | Check that it is the official `conversations.json`, or download a fresh export |
| | `ZIP_ON_STDIN` | A ZIP was piped to `-` | Pass the ZIP path, or pipe the extracted `conversations.json` |
| | `NESTING_TOO_DEEP` | A nested archive holds another conversations archive | Extract the inner `Conversations` part archive and import that, or import the extracted folder |
| | `MIXED_PROVIDERS` | ChatGPT and Claude files in one import | Import them separately (`--provider`) |
| | `PROVIDER_UNDETECTED` | No element has a `mapping` object or `chat_messages` array | Check the file, or select `--provider` |
| | `SYMLINK_REFUSED` | A symlink where a file was expected | Copy the real file; remove the link |
| | `MANIFEST_*`, `PROVIDER_MISMATCH` (only with `--strict`) | Manifest inconsistent / provider contradicts the data | Re-run without `--strict`, or fix the export |
| `IMPORT_ZIP_UNSAFE` | many (`NAME_DOT_DOT`, `ENCRYPTED`, `SYMLINK`, `CRC_MISMATCH`, `EOCD_NOT_FOUND`, ...) | The archive violates the safety rules or is damaged/truncated | Download a fresh export directly from the provider; do not import archives from untrusted sources. A ZIP over 4 GiB without ZIP64 offsets must be re-downloaded or extracted with a ZIP64-aware tool |
| `IMPORT_LIMIT_EXCEEDED` | `TOTAL_BUDGET`, `COMPRESSION_RATIO`, `ENTRY_TOO_LARGE`, `TOO_MANY_ENTRIES`, `ELEMENT_TOO_LARGE`, `NESTED_ZIP_TOO_LARGE`, `STDIN_TOO_LARGE`, `MANUAL_COPY_TOO_LARGE` | A safety limit tripped | Raise the named limit only if you trust the file; for nested archives extract the inner archive; for stdin save to a file |
| `IMPORT_PARSE_ERROR` | `TRAILING_DATA`, `UNTERMINATED_*`, `EMPTY_INPUT`, `TOP_LEVEL_NOT_ARRAY`, ... (with a byte offset) | The JSON is not well-formed (truncated or corrupted) | Obtain a fresh export. In the default mode earlier elements are kept |
| | `CONCURRENT_MODIFICATION` | A file changed (grew, shrank, was replaced or damaged) between the two passes | Do not modify the input during an import; re-run |
| | `DUPLICATE_CONVERSATION`, `ELEMENT`-level details (`file`, `elementIndex`), `NOT_A_CONVERSATION`, `FILE_PARSE_FAILED` (only with `--strict`) | Strict abort | Re-run without `--strict` or fix the export |
| `INVALID_ARGUMENT` | `accountLabel`, `LIMIT_NOT_POSITIVE_FINITE`, `UNKNOWN_LIMIT`, `clock` | A bad option | Fix the option (account label: 1-64 of letters, digits, `_ . @ -`, space; first character a letter or digit) |
| `INVALID_URL`, `INVALID_UUID` | `sourceUri`, `conversationId` | Mode B identifiers are not exact | Use `https://chatgpt.com/c/<uuid>` and a UUID |
| `NOT_IMPLEMENTED` | | `openai_api` is not an import provider | Mode D is a separate, disabled feature |
| `WRITE_FORBIDDEN`, `DB_ERROR`, `DB_SCHEMA_TOO_NEW` | | The database is read-only, locked or newer than this tool | Use a writable database / a newer GCR |
| `INTERNAL_ERROR` | | An unexpected failure (a bug) | Re-run with `GCR_DEBUG=1` for a stack trace on stderr and report it **without** private data |

### Warning codes you may see in a report

Runner and container: `WRAPPER_OBJECT_FORMAT`, `INVALID_UTF8`, `DUPLICATE_CONVERSATION`, `PROVIDER_MISMATCH`, `FILE_PARSE_FAILED`, `ELEMENT_PARSE_FAILED`, `ELEMENT_INTERNAL_ERROR`, `EMPTY_CONVERSATION_ENTRY`, `NON_OBJECT_ENTRY`, `NOT_A_CONVERSATION`,
`DUPLICATE_CONVERSATION_IN_BATCH` (two winners normalized to one id), `COMPLETENESS_BELOW_BATCH_LEVEL`, `MANIFEST_INVALID`, `MANIFEST_SHARD_MISSING`, `SHARD_NOT_IN_MANIFEST`, `MANIFEST_COUNT_MISMATCH`,
`MANIFEST_AMBIGUOUS`, `MANIFEST_ABSENT`, `SHARD_GAP`, `SYMLINK_SKIPPED`, `DIRECTORY_DEPTH_LIMIT`. Adapter warnings (`CHILDREN_ABSENT`, `INVALID_CURRENT_NODE`, `UNKNOWN_CONTENT_TYPE`, ...) are listed in `docs/ADAPTERS.md`.
Each report entry is `{ code, count, sampleIds }` with at most 5 sample ids. A `[info]` prefix in the stored message marks purely informational warnings.

## 14. Known limitations of the import runner

* The batch-level `completeness` is nominal (section 11).
* The winner of a duplicate is not replaced by a loser when it fails normalization.
* An over-limit element aborts its file (and the import); a truncated file loses everything after the break.
* A conversation object that contains both `mapping` and a `conversations` array is skipped by the ChatGPT adapter (`NOT_A_CONVERSATION`); the runner only unwraps objects that have `conversations` and **no** `mapping`.
* Nested archives are held in memory (bounded); a stdin import is buffered in memory (bounded).
* Memory is O(number of conversations) plus the largest single conversation, not O(export size): the runner keeps one small record per distinct conversation id for the whole run (the id string is copied, never a slice of the export text; an earlier version kept slices and pinned every conversation's full text, which crashed a 210 MB export under a 192 MiB heap cap and is now covered by `test/ingest/import-runner.heapcap.test.ts`). Measured on synthetic data of 100-message conversations: peak RSS 110.7 MiB at 50,000 messages, 116.2 MiB at 250,000 and 163.3 MiB at 500,000, so it is not flat (see `docs/PERFORMANCE.md`). There is no separate cap on the number of conversations; real exports hold at most a few hundred thousand.
* A conversation with a very deeply nested value (more than 10,000 levels) breaks the framing of its file (`FILE_PARSE_FAILED`): the rest of that file is lost, as for any other framing error.
* Provider detection sniffs the first conversation-looking element of each file (at most 20 attempts per file); a file whose first 20 marker-bearing elements are all unreadable is `PROVIDER_UNDETECTED`: select the provider explicitly.
* Mode B: a partial copy that has no `updated_at` ties with an undated official conversation of the same id on recency, so the later import (the partial copy) becomes the head; the batch and the record stay flagged partial.
* Per-file failure counts and the format profile are not available on an already-imported report.
* Everything above was exercised with synthetic data only; no live export has been imported.
