# What GCR extracts from a ChatGPT export

This page explains, for people who use GCR, what the ChatGPT importer takes from an official ChatGPT data export, how it
turns that into GCR's provider-neutral records, what it deliberately does *not* do, and what every import warning means.
The code is `src/ingest/chatgpt-export.ts` (`ChatGPTExportAdapter`); the data model is in `docs/ARCHITECTURE.md` and
`SPEC.md` section 5.

## Read this first: what is verified and what is not

* **No live export could be verified.** GCR was developed without access to a real ChatGPT export. Everything below that
  describes the *contents* of `conversations.json` is taken from community projects that reverse-engineered the format,
  and has been tested only against **synthetic fixtures** (`fixtures/chatgpt/`). A passing test run is evidence that the
  code does what this page says on that synthetic data. It is not evidence that a current real export imports correctly.
* **How to request an export is reported, UNVERIFIED; what is inside it is undocumented as far as GCR could find.** OpenAI's Help
  Center article on exporting your ChatGPT history and data (article 7260999; reached, as reported, via ChatGPT Settings > Data controls >
  Export data, or via the Privacy Portal) is reported to say that the ZIP holds your chat history and other account data, and
  to name no files and no JSON fields. GCR never read that article (it could not be fetched while the research was done), so every
  statement about delivery time, link expiry, plan eligibility and archive contents is a second-hand paraphrase: check the
  live article for the current rules. See `docs/USER_GUIDE.md` section a for the paraphrase.
* The format drifts without notice. Reports from 2026 describe exports whose nodes have **no `children`**, no system or
  tool messages, no `recipient`, sharded files and extension-less assets. GCR is built to accept both that shape and the
  richer earlier shape, and to say so when something is missing rather than to guess.

### Evidence labels used on this page

| Label | Meaning |
|---|---|
| **OFFICIAL** | Stated by OpenAI and verified against OpenAI's own page. **Nothing on this page carries this label**: no OpenAI page could be read, so even the delivery mechanics are only "reported, UNVERIFIED". |
| **COMMUNITY** | Reported by one or more third-party parsers, specifications or issue reports. `COMMUNITY x2` means two or more independent observers. Never confirmed by OpenAI. |
| **UNCERTAIN** | A single weak source, contradicted elsewhere, or inferred. |
| **GCR POLICY** | A decision GCR made so that it never presents a guess as a fact. |
| **SYNTHETIC-TESTED** | Exercised by the repository's tests on invented data. |

## What is extracted

For every conversation object in `conversations.json` (or a `conversations-NNN.json` shard) GCR keeps:

* **Identity and dates.** `conversation_id` (else `id`), title, `create_time`, `update_time`, the conversation-level
  default model if present, and the `current_node` pointer. Nothing is invented: absent means `null`.
* **Every node of `mapping`**, including nodes that are not on the visible branch (edited prompts, regenerated answers,
  abandoned drafts), the structural root (a node whose `message` is `null`), `parent` and `children` links, and the
  position of each node in the file.
* **Every message field GCR models:** role, author name, `recipient`, `channel`, `status`, content type, creation and
  update time, the model slug when the message states one, readable text, typed content blocks, and attachment
  *metadata*.
* **Everything else, untouched.** The parsed message object is kept as `rawSource`; every conversation key except
  `mapping` is kept in `rawMetadata`. Unknown keys, new content types and odd parts are preserved, never dropped.
* **Provenance.** Each record says it came from `official_chatgpt_export`, carries a completeness level, and the SHA-256
  of the exact source text of the conversation (`rawMetadata._gcr.sourceElementSha256`).

GCR does **not** read `user.json`, `user_settings.json`, feedback, shared-link files or other account files here, does not
download or dereference any asset pointer, and has no network code.

## Normalization rules

| Topic | Rule | Evidence |
|---|---|---|
| **Identity** | `conversation_id` is used, else `id`. Both are kept in `rawMetadata`; a difference is reported (`ID_ALIAS_MISMATCH`). An unusable value (empty, not a string, over 512 characters, control characters) counts as missing. If neither is usable, a deterministic id is derived from the element's hash and its position (`CONVERSATION_ID_MISSING`). A UUID-shaped id is lower-cased (`ID_CASE_NORMALIZED`); anything else is kept verbatim, never trimmed. No `sourceUri` is made up from the id. | COMMUNITY x3 (both ids present), GCR POLICY |
| **Node identity** | The key in `mapping` is the node's identity. The `id` field of the node and of its message are recorded but not trusted (`NODE_ID_MISMATCH`, `MESSAGE_ID_MISMATCH`, `DUPLICATE_MESSAGE_ID`). A key that cannot be an identifier (empty, over 512 characters, control character, lone surrogate) is replaced by a stand-in `gcr-node-<24 hex>` derived from the key; pointers to it are rewritten consistently. A pointer (`parent`, a `children` entry, `current_node`) that names **no** node keeps its own spelling only if that is a safe identifier nobody else uses; otherwise it becomes `gcr-ref-<24 hex>` (with `-1`, `-2` ... on a clash). So a missing parent can never turn into an edge to some other node by spelling it like that node's id, and two different missing pointers never merge. | UNCERTAIN (ids can differ), GCR POLICY |
| **Parent / children** | The `parent` pointer is authoritative. `children` is only an ordering hint. A node with a `null` or missing `parent` is a root; the literal `client-created-root` is not special. If a node has no `children` list, its children are **derived** from the parent pointers, ordered by creation time (unknown last), then file position, then id, and **one** `CHILDREN_ABSENT` warning is recorded per conversation. If every `children` list is empty although parent pointers define edges, the same derivation applies. If `children` is present but disagrees with the parent pointers, it is **left as declared** and the branch analysis reports the mismatch. A parent that is not a string is treated as "no parent" and reported. | COMMUNITY x4 (present), x2 (absent from mid-2026), GCR POLICY |
| **Node order** | Messages are numbered (`ordinal`) in the order the node keys appear **in the file**. A raw-text pre-pass establishes this because JavaScript objects re-order integer-like keys (`"10"` would come after `"9"` and before `"b"`). | SYNTHETIC-TESTED |
| **Active branch** | `currentNodeId` is set only if `current_node` is a key of `mapping`. Otherwise it is `null` with `NO_CURRENT_NODE` (absent) or `INVALID_CURRENT_NODE` (dangling or not a string). GCR never picks "the newest leaf" for you. A `current_node` that is not a leaf is kept and noted (`CURRENT_NODE_NOT_LEAF`, informational). | COMMUNITY x many, ADR-0009 |
| **Completeness** | `exported_tree` only when the parent links form a forest (no cycle, no parent that points outside the mapping, no malformed parent), no node id was duplicated, none of the structural keys `mapping`, `current_node`, `parent`, `children`, `message` was written twice in the same object (JSON parsers keep the last value, but then the file itself names two trees or two active branches), no node was dropped, there is at least one node, and `current_node` is valid. Otherwise `unknown`, with `COMPLETENESS_LOWERED` listing the reasons. `exported_tree` never means "every message OpenAI ever stored": it means "this conversation's exported tree is internally consistent". | GCR POLICY |
| **Timestamps** | `create_time` / `update_time` are unix **seconds** (floats). They become ISO-8601 UTC with millisecond precision. Values outside 2015-01-01..2100-01-01, `0`, negatives, non-finite numbers and **millisecond-scale numbers** become `null` with `TIMESTAMP_OUT_OF_RANGE`. Numeric strings and ISO-8601 strings **with an explicit zone** are converted and flagged `TIMESTAMP_FORMAT` (informational). A string without a zone, an impossible date, a boolean or an object becomes `null` with `TIMESTAMP_UNPARSEABLE`. The raw value is always still in `rawSource` / `rawMetadata`. A time is never copied from another field. | COMMUNITY x3, GCR POLICY |
| **Model slug** | A message's `modelSlug` comes **only** from that message's `metadata.model_slug`. `default_model_slug` (on the message or the conversation) is **never** used as the model that produced a message; the conversation's default goes only to `defaultModelSlug`. An empty or non-string slug is `null`, for the conversation default too (`default_model_slug`, else the newer conversation-level `model_slug`; an empty one counts as absent). | COMMUNITY x many, SPEC FR-16 |
| **Roles, channel, recipient, status, author name** | Open strings, stored verbatim (including values never seen before). A flat `role` on the message is used only as a fallback when `author.role` is missing (`LEGACY_ROLE_FIELD`). A wrong type becomes `null` / `''` with `UNEXPECTED_FIELD_TYPE`. | COMMUNITY x4, UNCERTAIN (flat role) |
| **Hidden** | A message is `hidden` when its `metadata.is_visually_hidden_from_conversation` is exactly `true`, **or** its role is exactly `system`, **or** its content type is `user_editable_context`, `model_editable_context`, `thoughts` or `reasoning_recap`. Tool, code, execution-output, browsing and error messages are **not** hidden. Hidden messages keep all their content: `hidden` is an attribute so that search and rendering can leave them out by default (they hold custom instructions, memory and reasoning that repeat in every chat and may contain personal data). | COMMUNITY x many (viewer behaviour), GCR POLICY |
| **Text** | `text` is only readable text the export really contains, joined with a newline. Non-text parts contribute a generic placeholder: `[image]`, `[audio]`, `[file]`. A pointer, a URL or a JSON dump never becomes text; objects are never converted with `String()`. Unknown payloads contribute no text. | GCR POLICY, SYNTHETIC-TESTED |
| **Content blocks** | Every message has typed blocks (table below). Anything not understood becomes a block of type `unknown` with the raw value in `metadata` (`UNKNOWN_CONTENT_TYPE`, `UNKNOWN_PART_TYPE`). | COMMUNITY x many |
| **Attachments** | `AttachmentRef` records *metadata only*: id, name, MIME type, size in bytes, the asset pointer, and `presentInExportAs`. They come from `metadata.attachments[]` (snake_case or camelCase keys) and from asset pointers inside `parts`. Token-count size fields are not bytes and are ignored; a size that is not a safe non-negative integer is `null`. The same file mentioned twice in one message is merged. The file id of an asset pointer is its first path component that looks like a file id (`file-...` or `file_...`, also inside a `#` suffix form), so `file-service://file-ABC/foo.png` is the file `file-ABC`, never `foo.png`; only when no component looks like a file id is the last component used. | COMMUNITY x many |
| **`presentInExportAs`** | Set **only** when the caller supplied the names of the files in the container *and* one matches the attachment's file id: an entry named exactly like the id, else `<id>.dat`, else the smallest entry whose file name starts with the id followed by `-`, `_` or `.`. Otherwise `null`. Display names never decide this. GCR never fabricates an asset: the container's name list is re-checked against the supplied set for every conversation that has an attachment id, so a changed set is never answered from a stale index. | COMMUNITY x2 (naming), GCR POLICY |
| **Sanitation** | NUL characters are removed (`NUL_STRIPPED`); unpaired UTF-16 surrogates become U+FFFD (`LONE_SURROGATE`); other characters, including bidirectional controls, U+2028/2029, zero-width joiners, astral characters and private-use citation delimiters, are kept as they are. Unicode is not normalized. | COMMUNITY (hostile inputs), GCR POLICY |
| **Size limits** | At most 500,000 nodes per conversation, 50,000 `parts` (or `thoughts` items, or `metadata.attachments`) converted per message, 1,000 frame pointers per real-time part, a `thoughts` JSON string is expanded only up to 8 MiB of characters (longer ones stay raw, with `CONTENT_SHAPE_UNEXPECTED`), 64 MiB of text per message, and 256 levels of nesting kept inside `rawSource`, `rawMetadata` and block metadata. Beyond a limit GCR truncates (never throws) and says so (`TOO_MANY_NODES`, `PARTS_TRUNCATED`, `TEXT_TRUNCATED`, `NESTING_TOO_DEEP`). The full text of an over-long message stays in `rawSource`; a structure nested deeper than 256 levels is replaced below that depth by `{"_gcr_truncated": "nesting_too_deep"}`. | GCR POLICY |

### Block types

| `block.type` | Produced from | Contributes to `text`? |
|---|---|---|
| `text` | string parts; `audio_transcription` parts | yes |
| `code` | `code` content (language and response format in `metadata`) | yes |
| `tool_output` | `execution_output`, `tether_browsing_display` (the `result`), `citable_code_output`, `computer_output` | yes, except `computer_output` itself |
| `citation` | `tether_quote`, `sonic_webpage`; `search_result_group` parts | text of quotes and pages; search groups no |
| `error` | `system_error` | yes |
| `context` | `user_editable_context`, `model_editable_context` (custom instructions, memory) | yes (message is hidden) |
| `thoughts` | `thoughts` (array or JSON-string form) | yes (message is hidden) |
| `reasoning_recap` | `reasoning_recap` | yes (message is hidden) |
| `image_ref`, `audio_ref`, `file_ref` | asset-pointer parts | placeholder only: `[image]`, `[audio]`, `[file]` |
| `unknown` | unknown content types, `tether_browsing_code`, `app_pairing_content` (field sets unknown), odd parts, malformed content | no |

`tether_browsing_code` and `app_pairing_content` exist in the community notes but nobody has published their fields, so GCR
keeps the whole payload raw and interprets nothing. The `thoughts` content is kept exactly as exported; GCR never writes or
infers reasoning that is not in the file.

## What is NOT preserved byte-for-byte

`rawSource` and `rawMetadata` are the objects produced by `JSON.parse`, so:

1. **Numbers** beyond 2^53 and numbers with more than about 17 significant digits are rounded; `1e999` becomes infinity;
   `-0` stays `-0`. (The exact text is identified by the SHA-256 in `_gcr.sourceElementSha256`.)
2. **Duplicate keys.** If an object lists the same key twice, only the **last** value survives, exactly as in every JSON
   parser. GCR detects duplicate keys in the raw text (`DUPLICATE_NODE_ID`, `DUPLICATE_KEY`) and, for a duplicated node id,
   stores a SHA-256 of **every** body in `rawMetadata._gcr.duplicateNodeBodySha256` so you can tell that data was lost and
   check it against the original file. The earlier bodies themselves are not kept. The evidence is bounded so that a hostile file cannot multiply memory by repeating one key millions of times: for at most 1,000 duplicated node ids, the first 15 bodies and the last one are hashed, and `rawMetadata._gcr.duplicateNodeBodiesNotHashed` counts every body left out (the field is absent when nothing was left out).
3. **Key order** of integer-like keys: JavaScript lists them first, in numeric order. (The *node* order is taken from the file
   and does not have this problem.)
4. **Whitespace and escape spelling** are not kept (`"é"` and `"é"` are the same string).
5. **Depth.** Nesting deeper than 256 levels is cut (see `NESTING_TOO_DEEP`). Real exports nest about 10 levels. The reason is
   practical: `JSON.stringify` and `structuredClone` throw from a few thousand levels on, which would make a hostile message
   crash storage. The SHA-256 of the whole element still identifies the original text.

A key named `_gcr` in the source is stored as `_gcr_original` (as `_gcr_original_` and so on if the source also has that key), so it can never forge the hash and never overwrites another source value.

## Warning codes

Warnings are attached to the conversation (`warnings` on the record) and summarized in the import report. A warning has a
stable `code`, a fixed English `message`, and `ids` (conversation, node or message ids only). **No warning ever contains
conversation text, titles, attachment names or author names.** The one place text from the file appears is the name of an
unknown content type, reduced to at most 64 harmless characters. Messages for informational codes start with `[info] `.
Several occurrences in one conversation are merged into one warning with an occurrence count and at most 1000 ids.

| Code | Level | Meaning and what GCR did |
|---|---|---|
| `DUPLICATE_NODE_ID` | warning | The same node id occurs more than once in `mapping`. The last body was kept; every body is hashed in `rawMetadata._gcr`. Completeness is lowered. |
| `DUPLICATE_KEY` | warning | An object elsewhere (conversation, node, message, content, metadata ...) repeats a key. The last value was kept. If the repeated key is structural (`mapping`, `current_node`, `parent`, `children`, `message`) completeness is lowered (`duplicate_structural_key`). Duplicates inside a `mapping` that a later `mapping` key replaces are not reported: they describe nodes that are not in the record. |
| `CONVERSATION_ID_MISSING` | warning | No usable `conversation_id` / `id`; a deterministic id was derived from the element hash and position. |
| `ID_ALIAS_MISMATCH` | warning | `id` and `conversation_id` differ; `conversation_id` was used. |
| `ID_CASE_NORMALIZED` | info | An upper-case UUID id was lower-cased. |
| `INVALID_NODE_ID` | warning | A mapping key cannot be an identifier; a deterministic stand-in id was used. |
| `NODE_ID_MISMATCH` | warning | A node's `id` field differs from its mapping key; the key is the identity. |
| `MESSAGE_ID_MISMATCH` | warning | A message's `id` differs from its node key; the key is the identity. |
| `DUPLICATE_MESSAGE_ID` | warning | The same `message.id` appears in several nodes; all were kept. |
| `MAPPING_INVALID` | warning | `mapping` is present but not an object (null, array, string ...). The conversation has no messages; the raw value is kept in `rawMetadata._gcr.unsupportedMapping`. |
| `NODE_NOT_OBJECT` | warning | A mapping value is not an object; kept as a structural node with its raw value. |
| `MESSAGE_NOT_OBJECT` | warning | A node's `message` is neither `null` nor an object; kept as a structural node with its raw value. |
| `TOO_MANY_NODES` | warning | More nodes than the per-conversation limit; the first ones (file order) were kept. Completeness is lowered. |
| `KEY_ORDER_FALLBACK` | warning | The file order of the node keys could not be established; the JSON engine's order was used for ordinals. Should never happen. |
| `CHILDREN_ABSENT` | warning | Some nodes (or all) have no usable `children` list; child lists were derived from `parent` pointers. One per conversation. |
| `CHILD_NOT_FOUND` | warning | A `children` list names a node that does not exist. Left as declared; the branch analysis ignores the phantom edge. |
| `DUPLICATE_CHILD_ENTRY` | warning | A `children` list repeats an id; repeats were dropped. |
| `NO_CURRENT_NODE` | warning | The conversation has no `current_node`; no active branch is assumed. Completeness is lowered. |
| `INVALID_CURRENT_NODE` | warning | `current_node` is not a key of `mapping`; no active branch is assumed. Completeness is lowered. |
| `CURRENT_NODE_NOT_LEAF` | info | `current_node` points to a node that has children; kept as is. |
| `COMPLETENESS_LOWERED` | warning | Completeness is `unknown`, not `exported_tree`; the message lists the reasons (`cycle`, `missing_parent`, `malformed_parent`, `duplicate_node_id`, `duplicate_structural_key`, `node_limit`, `mapping_invalid`, `empty_mapping`, `no_current_node`, `invalid_current_node`). |
| `TIMESTAMP_FORMAT` | info | A time was a string (numeric or ISO with zone) instead of a number of seconds; converted. |
| `TIMESTAMP_OUT_OF_RANGE` | warning | A time is not plausible unix seconds (0, negative, non-finite, millisecond-scale, outside 2015..2100); set to `null`. |
| `TIMESTAMP_UNPARSEABLE` | warning | A time has an unsupported type or format (no zone, impossible date, boolean ...); set to `null`. |
| `UNKNOWN_CONTENT_TYPE` | warning | A `content_type` has no handler; kept as a raw `unknown` block. One warning per type per conversation, with a count. At most 100 distinct types get a warning of their own; any further ones share one summary warning (counts and ids still add up), so the list cannot grow with the number of messages. |
| `UNKNOWN_PART_TYPE` | warning | A `parts[]` entry is not a string or a recognised object; kept as a raw `unknown` block. |
| `CONTENT_MALFORMED` | warning | A message has no content object, or content that is not an object, or no `content_type`; kept without text (raw value in an `unknown` block where there is one). |
| `CONTENT_SHAPE_UNEXPECTED` | warning | A known `content_type` has a field of the wrong shape (for example `code` without `text`, `thoughts` that is not JSON). |
| `PARTS_TRUNCATED` | warning | A list inside one message is longer than its limit and the extra entries were not converted (they remain in `rawSource`): `parts` and `thoughts` items (50,000 each), `metadata.attachments` (50,000), and the frame pointers of one real-time audio/video part (1,000). One warning per kind of list; the message says which. |
| `NESTING_TOO_DEEP` | warning | Something the record keeps (`rawSource`, block metadata or `rawMetadata`) nests deeper than 256 levels; it was cut at that depth and replaced by a marker so the record can be serialized. The ids name the affected messages (or the conversation). |
| `NUL_STRIPPED` | warning | NUL characters were removed from text or a short field. |
| `LONE_SURROGATE` | warning | Unpaired UTF-16 surrogates were replaced by U+FFFD. |
| `TEXT_TRUNCATED` | warning | A text or short field exceeded its limit and was truncated. |
| `LEGACY_ROLE_FIELD` | warning | The role came from a flat `role` field because `author.role` is missing. |
| `UNEXPECTED_FIELD_TYPE` | warning | An optional field is absent or has the wrong type and was treated as absent; the message names the field. |

The branch analysis (`analyzeTree`) adds its own codes when you ask for branches: `MISSING_PARENT`, `CYCLE_DETECTED`,
`SELF_PARENT`, `CHILD_PARENT_MISMATCH`, `NO_CURRENT_NODE`, `INVALID_CURRENT_NODE`, `CURRENT_NODE_NOT_LEAF`,
`DUPLICATE_NODE_ID`, `BRANCH_LIMIT_EXCEEDED`.

## Responsibilities at the other layers

The adapter handles **one conversation**. These belong to other modules and are *not* done here: ZIP safety and limits,
nested ZIPs, shard discovery and numeric ordering, `export_manifest.json`, UTF-8/UTF-16 detection, byte-order marks and invalid
bytes, streaming and per-element size and depth limits, unwrapping `{"conversations": [...]}`, the choice between two elements
with the same conversation id, idempotent storage, the "first message time" of a conversation, and counting skipped elements
in the import report. The adapter reports unusable *elements* (`{}`, `null`, non-objects, wrappers, objects without a
mapping) as skipped with a reason and throws an `IMPORT_PARSE_ERROR` (no content echoed) only when the element is not valid
JSON.

## Privacy

Imported text is **data**, never instructions. Hidden messages (custom instructions, memory, reasoning) are flagged so that
default search and display leave them out, but they are stored. Keep your export, the SQLite database and anything derived
from them out of Git and out of shared logs; GCR's committed fixtures are all invented.
