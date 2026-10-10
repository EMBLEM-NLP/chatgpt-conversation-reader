# Source adapters (ChatGPT, Claude, OpenAI developer API) and the registry

Status: normative for adapter authors, together with `docs/ARCHITECTURE.md` section 5 and the contract in `src/ingest/adapter.ts`.
Requirement: SPEC FR-14 ("same provider-neutral schema; provenance never lost"); CODEX_TASK Phase 2 ("separate `ClaudeExportAdapter`,
`ChatGPTExportAdapter` and `OpenAIAPIOwnedAdapter` interfaces; do not claim that the OpenAI API covers a `chatgpt.com/c` user's history").

All statements about **real** export formats below are `synthetic-only`: no real Claude or ChatGPT export was available while this was
written, so the field names come from documented data-shape notes and every behaviour is tested against invented fixtures only. Nothing here
proves compatibility with a live export.

## 1. The three adapters

| | `ChatGPTExportAdapter` | `ClaudeExportAdapter` | `OpenAIAPIOwnedAdapter` (Mode D) |
|---|---|---|---|
| Source file | `src/ingest/chatgpt-export.ts` | `src/ingest/claude-export.ts` | `src/ingest/openai-api.ts` |
| Provider | `chatgpt` | `claude` | `openai_api` |
| Provenance | `official_chatgpt_export` | `official_claude_export` | `openai_developer_api` |
| Completeness | `exported_tree` (lowered when the tree is damaged, with a warning) | `rendered_active_view_only` (always) | `api_owned_conversation` (when implemented) |
| Input | ONE conversation element of an official ChatGPT `conversations.json` (or shard) | ONE conversation element of an official Claude `conversations.json` | none: **disabled**, every method throws `NOT_IMPLEMENTED` |
| In the registry | yes (`chatgpt`) | yes (`claude`) | **no** (asking for `openai_api` gives `NOT_IMPLEMENTED`) |
| Active branch | `current_node` when it exists in `mapping`, else null | the single chain's only leaf, else null (section 3.3) | n/a |

### What every adapter MAY do
* Turn **one** element's JSON text into a `ConversationRecord`, deterministically and purely: no I/O, no clock (`importedAt` comes from the
  context), no randomness, no network.
* Preserve unknown fields (`rawSource` per message, `rawMetadata` per conversation) and report every normalization it applied as a `Warning`.
* Fail one element with a `GcrError` (`IMPORT_PARSE_ERROR`, `IMPORT_LIMIT_EXCEEDED`) so the runner can skip just that element.

### What no adapter may do
* Read files, open sockets, call `fetch`, spawn processes, read the environment or credentials, or dereference an attachment pointer.
* Infer what the source did not say: model identity, timestamps, the active branch, completeness, or that an attachment file is present.
* Treat imported text as instructions. Text, titles, attachment names and tool inputs are untrusted DATA; warnings and errors carry fixed text
  plus ids/counts only, never content.
* Label data with a provider other than its own. `ClaudeExportAdapter` throws `INVALID_ARGUMENT` when the context says `provider !== 'claude'`
  (a wiring bug that would otherwise silently destroy provenance).
* Be reconfigured. The registry shares ONE instance per adapter for the whole process, so the registry **freezes** them (`Object.freeze`; the disabled Mode D adapter freezes itself in its constructor): a caller
  cannot reassign `provider`, `provenance`, `name` (or, for Mode D, `implemented`) and thereby relabel every later import or `listAdapters()` result.

## 2. Mode D: the OpenAI developer API (SPEC section 3)

> **Mode D is the user's own API-created conversations, separately authorized, and distinct from `chatgpt.com/c` web chat.**
> A `https://chatgpt.com/c/<uuid>` conversation is ChatGPT *consumer* history. The OpenAI developer API does not expose it, and GCR never
> reaches for it (AGENTS.md, SPEC section 9). Mode D is a different resource family: conversations that the user's own application created through
> the API, readable only with an API key that the operator holds **outside GCR** (GCR never requests, stores or logs credentials).

This version ships the *contract* only:

* `interface OpenAIAPIOwnedAdapter extends ConversationSourceAdapter` with `provider: 'openai_api'`, `provenance: 'openai_developer_api'`,
  `mode: 'D'`, `implemented: boolean`, `listOwnedConversations(request?)`, `readOwnedConversation(id)`. There is deliberately **no credential
  parameter**.
* `class DisabledOpenAIAPIOwnedAdapter` implements it with `implemented = false`. **Every** method (`normalizeElementText`,
  `listOwnedConversations`, `readOwnedConversation`) throws `GcrError('NOT_IMPLEMENTED')` *synchronously* (a rejected promise that nobody awaits
  could be lost) with a remedy that says: API-owned conversations are not ChatGPT consumer history; they need a separately authorized API key held
  outside GCR; the capability is not implemented in this version; use an official ChatGPT data export for consumer history.
* **Security invariant:** `openai-api.ts` imports nothing that can perform I/O. Its only runtime import is `../errors.js`; the other imports are
  `import type`. `test/ingest/openai-api.test.ts` asserts this at the source level *and* on the compiled JavaScript (no `fs`, `net`, `http`, `https`,
  `child_process`, `dns`, `tls`, `worker_threads`, `fetch`, ...).
* Enabling Mode D later requires a reviewed ADR in `docs/DECISIONS.md` and a new module that the registry opts into explicitly. It must not be
  retrofitted into the disabled class.

## 3. `ClaudeExportAdapter` in detail

### 3.1 Input shape (documented data shape; synthetic-only)

| Level | Fields read | Notes |
|---|---|---|
| Conversation | `uuid`, `name`, `created_at`, `updated_at`, `chat_messages[]`, optional `model` | `summary`, `account`, and every unknown key go to `rawMetadata` (the conversation minus `chat_messages`) |
| Message | `uuid`, `sender`, `text`, `content[]`, `attachments[]`, `files[]`, `created_at`, `updated_at`, optional `parent_message_uuid`, optional `model` | the whole message object is kept as `rawSource` |
| Content block | `type` = `text` / `thinking` / `tool_use` / `tool_result` / `image` / `voice_note` / `token_budget`, else unknown | |
| Attachment / file | `id` \| `uuid` \| `file_uuid` \| `file_id`, `file_name` \| `name`, `file_type` \| `mime_type`, `file_size`, `extracted_content` | `file_kind` and URLs are not mapped (kept in `rawSource`) |

An element is a conversation **iff** it is an object with a `chat_messages` **array** (the registry sniffs the same marker). Anything else is
skipped, not guessed: `null`/numbers/strings/arrays -> `NON_OBJECT_ENTRY`; `{}` -> `EMPTY_CONVERSATION_ENTRY`; an object without a `chat_messages`
array (a project or user record, a ChatGPT element, a wrapper) -> `NOT_A_CONVERSATION`. Invalid JSON -> `IMPORT_PARSE_ERROR`.

### 3.2 Normalization rules

| Rule | Behaviour |
|---|---|
| Role | `sender === "human"` (exact) -> `authorRole "user"`; every other string is kept verbatim (after NUL/surrogate sanitizing, capped at 512). A missing/non-string/empty sender -> `"unknown"` + `SENDER_MISSING` (never `""`, which is reserved for structural nodes). The original sender always stays in `rawSource` |
| Ids | a UUID-shaped conversation `uuid` is **lower-cased** (like the ChatGPT adapter, so lookups by the lower-cased uuid find it; `ID_CASE_NORMALIZED`, an `[info]` warning; the raw value stays in `rawMetadata`), any other conversation id and every message id is kept verbatim. Missing/invalid -> `gcr-synth-<sha256[0:32]>-<elementIndex>` (same form as the ChatGPT adapter) + `CONVERSATION_ID_MISSING/INVALID`. Message `uuid` missing/invalid -> `synthetic-msg-<ordinal>` + `MESSAGE_ID_MISSING/INVALID`. An id is **unusable** (invalid) when it is not a string, is empty, longer than 512 units, contains a control character (NUL included) or contains an **unpaired surrogate**; unlike text, surrogates in ids are never "repaired" to U+FFFD, because that would map distinct ids (`"a\ud800"`, `"a\ud801"`) to one and silently merge two conversations or make a parent pointer hit the wrong message. A repeated message uuid keeps both messages: later ones get `~dup2`, `~dup3`... + `DUPLICATE_MESSAGE_ID` (pointers resolve to the first occurrence; the suffix search is amortized linear: one remembered counter per id stem) |
| Tree | **Linear chain in file order** unless any message carries the key `parent_message_uuid`; then pointers win for every message. `null` and the Claude root sentinel `00000000-0000-4000-8000-000000000000` mean "no parent". A dangling pointer is kept verbatim (`branches.ts` reports `MISSING_PARENT`). In explicit mode a message **without** the key (and not the first) is a root + `PARENT_POINTER_ABSENT`: linking it to its file-order predecessor would be a guess. Unusable pointers -> root + `INVALID_PARENT_POINTER` |
| `childIds` | Claude has no `children`; they are derived from the parent pointers in `(createdAt asc nulls last, ordinal, id)` order. One `CHILDREN_ABSENT` warning per non-empty conversation |
| Model | `modelSlug` is null unless THAT message has a non-empty string `model`. A conversation-level `model` fills `defaultModelSlug` and is never copied to messages. Look-alikes (`model_slug`, `metadata.model`) are not read |
| Timestamps | ISO-8601 with a **mandatory** zone (`Z` or `+-HH[:MM]`), 1-9 fraction digits -> `YYYY-MM-DDTHH:MM:SS.fffZ` (fraction **truncated** to ms, offset applied, plausibility window 2015..2100 like the ChatGPT adapter). Zone-less, date-only, numeric, impossible dates -> null + `INVALID_TIMESTAMP` (absent -> null silently) |
| `message.text` | the top-level `text` string if non-empty, else the `text` blocks joined by a blank line. Differing sources -> `TEXT_FIELD_MISMATCH` (the `text` field wins, both are kept). If `text` exists but no text block does, one derived block (`metadata.derivedFrom: "text"`) is added |
| Thinking | `thinking` block -> `{ type: "thoughts", text, metadata: { hidden: true, sourceType: "thinking" } }`. `ContentBlock` is a strict schema without a `hidden` key, so the flag lives in `metadata`. It is **never** part of `message.text`; renderers must exclude `thoughts` blocks by default (ARCHITECTURE section 5). The message itself keeps `hidden: false` |
| Tool blocks | `tool_use` -> `{ type: "tool_use", metadata: { toolName, toolUseId, input } }` (no text). `tool_result` -> `{ type: "tool_result", text: <nested text parts joined by "\n">, metadata: { toolUseId, toolName, isError, nonTextContent? } }`; nested non-text parts are preserved, not dropped |
| Other blocks | `image` -> `image_ref` (media type only; the payload is **not** copied out of `rawSource`); `voice_note` (text kept); `token_budget`; anything else -> `type "unknown"` with `metadata.raw` + `UNKNOWN_CONTENT_TYPE`; a non-object / typeless block -> `unknown` + `MALFORMED_CONTENT_BLOCK` |
| Attachments | `attachments[]` and `files[]` -> `AttachmentRef` metadata only. `extracted_content` -> a separate `attachment_text` block (with `attachmentIndex`, `fileName`), **not** merged into `message.text`. `file_size` must be a safe non-negative integer (`-0` is stored as `0`; `1e999`, fractions, strings and unsafe integers become `null` + `INVALID_ATTACHMENT_FIELD`). `assetPointer` and `presentInExportAs` are **always null**: Claude exports are not known to contain attachment bytes, and matching a file name could falsely claim presence, so `ctx.availableAssetNames` is ignored on purpose. Names such as `../../x` are stored as data and never used as paths |
| `sourceUri` | always `null` |
| Second provider's marker | An element with a `chat_messages` array **and** an object `mapping` is the registry's "ambiguous" case (detection returns `null`). If the operator still selects this adapter, `chat_messages` is converted, the mapping is **not** read (it stays in `rawMetadata`) and `FOREIGN_PROVIDER_MARKER` says so. A `mapping` of another type is not a marker (same rule as the registry) |
| Unknown fields | message-level in `rawSource`, conversation-level in `rawMetadata`, unknown block types in `metadata.raw`. Nothing is dropped |

### 3.3 Why `currentNodeId` can be set, and when it is not

SPEC section 5 says `currentNodeId: null` means "no supported active-branch inference". A Claude export has no `current_node` field. It is
nevertheless **not** an inference when the messages form a single chain: the export holds exactly one thread per conversation (the branch rendered
at export time), so the chain's only leaf *is* the end of that thread. The adapter therefore sets `currentNodeId` to the only leaf when, and only
when, every message lies on the path from that leaf to the root (a first node whose parent is missing still counts as the root; `branches.ts` reports
`MISSING_PARENT`). For linear files this is the last message.

Whenever the (explicit) pointers describe anything else (several leaves, a cycle, a self-parent, mixed roots), `currentNodeId` is `null` and
`ACTIVE_BRANCH_UNKNOWN` is added: no active branch is guessed (ADR-0009). Empty conversations have no `currentNodeId` and no such warning.

Completeness stays `rendered_active_view_only` in **all** cases, including when explicit pointers show a fork, and every Claude record carries
exactly one `LINEAR_EXPORT_ACTIVE_BRANCH_ONLY` warning (first in the list): alternate branches, edits and regenerations are not part of the export,
so the record must never be presented as the full conversation tree (FR-09).

### 3.4 Sanitization and caps (same policy as the ChatGPT adapter)

* NUL characters are stripped from every text-like field (`NUL_STRIPPED`); unpaired UTF-16 surrogates are replaced with U+FFFD (`LONE_SURROGATE`).
  The originals stay in `rawSource` / `rawMetadata` (JSON-serialized safely). Ids that contain control characters are unusable (see Ids above).
* Caps (the validator is the authority): ids 512, short strings (role, model, mime type, block type) 512, title 8192, attachment strings 4096 UTF-16
  units (`FIELD_TRUNCATED`, surrogate pairs are never split); message/block text 64 MiB of UTF-8, cut on a character boundary with an explicit
  marker (`TEXT_TRUNCATED`); 500 000 messages per conversation and nesting depth 128 -> `IMPORT_LIMIT_EXCEEDED` (the element is skipped by the
  runner; the output of a tiny `{}` is hundreds of bytes, so the count is bounded); 50 000 blocks and 5 000 attachments per message are truncated
  with `BLOCKS_TRUNCATED` / `ATTACHMENTS_TRUNCATED` (the rest stays in `rawSource`). The per-message caps alone do not bound a conversation
  (500 000 messages x 50 000 blocks; measured amplification of the `1`-only content array is ~36x: 15 MB of JSON became ~550 MB of heap), so
  content blocks + attachment refs + attachment-text blocks share one **budget of 2 000 000 items per conversation**
  (`MAX_ITEMS_PER_CONVERSATION`); once it is spent, later content is not converted (reported with the same two warnings, kept in `rawSource`).
  `message.text` composed from several text blocks is capped at the same 64 MiB as every other body (`TEXT_TRUNCATED`) — the individual
  blocks are each capped, their join is not automatically.
* Warnings are **aggregated per code**: one `Warning` per code per conversation, listing at most 50 ids and the total count, so a hostile
  50 000-message conversation cannot produce 50 000 warning objects.

### 3.5 Warning codes emitted by `ClaudeExportAdapter`

`LINEAR_EXPORT_ACTIVE_BRANCH_ONLY`, `CHILDREN_ABSENT`, `ACTIVE_BRANCH_UNKNOWN`, `CONVERSATION_ID_MISSING`, `CONVERSATION_ID_INVALID`, `ID_CASE_NORMALIZED`,
`MESSAGE_ID_MISSING`, `MESSAGE_ID_INVALID`, `DUPLICATE_MESSAGE_ID`, `NON_OBJECT_MESSAGE`, `PARENT_POINTER_ABSENT`, `INVALID_PARENT_POINTER`,
`SENDER_MISSING`, `INVALID_TIMESTAMP`, `INVALID_TITLE`, `INVALID_MODEL_SLUG`, `INVALID_TEXT_FIELD`, `INVALID_CONTENT`, `TEXT_FIELD_MISMATCH`,
`UNKNOWN_CONTENT_TYPE`, `MALFORMED_CONTENT_BLOCK`, `INVALID_ATTACHMENT`, `INVALID_ATTACHMENT_FIELD`, `NUL_STRIPPED`, `LONE_SURROGATE`,
`FIELD_TRUNCATED`, `TEXT_TRUNCATED`, `BLOCKS_TRUNCATED`, `ATTACHMENTS_TRUNCATED`, `FOREIGN_PROVIDER_MARKER`. (Exported as `CLAUDE_WARNING_CODES`.) Tree anomalies
(`MISSING_PARENT`, `CYCLE_DETECTED`, `CHILD_PARENT_MISMATCH`) are reported by `src/domain/branches.ts`, not by the adapter.

### 3.6 Errors

| Code | When |
|---|---|
| `IMPORT_PARSE_ERROR` | element is not valid JSON (no cause attached: V8's message would quote the input); or `details.reason = UNEXPECTED_ADAPTER_FAILURE` for an adapter bug (asserted never to happen by the property tests) |
| `IMPORT_LIMIT_EXCEEDED` | nesting deeper than 128, or more than 500 000 messages |
| `INVALID_ARGUMENT` | context for another provider, bad `accountLabel`/`importedAt`, non-string element text (all caller bugs; a runner should abort, not skip) |

### 3.7 Known limitations

* Duplicate JSON keys inside an element are invisible after `JSON.parse` (last wins); only the element SHA-256 covers the exact bytes.
* Real-export compatibility is unverified (see the note at the top); `parent_message_uuid` and `model` are *documented possibilities*, not
  observed facts.
* Claude project files (`projects.json`) and user records (`users.json`) are not conversations and are not read.

## 4. Registry and detection (`src/ingest/registry.ts`)

```ts
type AdapterId = 'chatgpt' | 'claude';
getAdapter(id: AdapterId): ConversationSourceAdapter        // shared stateless instances
listAdapters(): AdapterInfo[]                               // [{ id, name, provider, provenance }] in fixed order
detectAdapterFromElementText(text: string, options?: { maxChars?: number }): { adapter: AdapterId | null; reason: string }
```

`getAdapter` accepts exactly the two ids (a `switch`, so `__proto__`/`constructor` cannot resolve to inherited members, and objects that merely
stringify to an id are rejected). The returned instances are frozen and `listAdapters()` returns fresh objects on every call. Any other string is
`INVALID_ARGUMENT`; `"openai_api"` is `NOT_IMPLEMENTED` with the Mode D remedy.

**Detection rules** (one element's JSON text; cheap, safe, never guesses, never throws, reasons are fixed text):

| Element | Result |
|---|---|
| top-level **object** `mapping` (and no `chat_messages` array) | `chatgpt` |
| top-level **array** `chat_messages` (and no object `mapping`) | `claude` |
| both markers | `null`, "Ambiguous" |
| neither; `mapping` or `chat_messages` of the wrong type; markers only in nested objects or string values | `null` |
| a `{"conversations": [...]}` wrapper | `null` (sniff its elements instead) |
| a JSON array, scalar, `null`, invalid JSON, non-string input | `null` |
| longer than `maxChars` (default 64 MiB, checked **before** parsing) | `null`, "select the provider explicitly" |

Keys are read with own-property lookups on the result of `JSON.parse`, so escaped keys (`"mapping"`) and duplicated keys behave exactly as
they do for the adapters. A leading UTF-8 BOM is ignored. `null` always means "the operator must choose a provider"; the importer must not fall
back to a default.

## 5. Provenance and completeness at a glance

| SPEC mode | `provider` | `provenance` | `completeness` | Adapter |
|---|---|---|---|---|
| A: official ChatGPT export | `chatgpt` | `official_chatgpt_export` | `exported_tree` (lowered with a warning when damaged) | `ChatGPTExportAdapter` |
| A': official Claude export | `claude` | `official_claude_export` | `rendered_active_view_only` | `ClaudeExportAdapter` |
| B: manual copy | any | `user_supplied_copy` | `partial_user_supplied` | none in this module |
| C: local write | n/a | n/a | n/a (local tables; never changes imported rows) | `drafts/` |
| D: OpenAI developer API | `openai_api` | `openai_developer_api` | `api_owned_conversation` | `OpenAIAPIOwnedAdapter` (**disabled**) |
| E: browser interaction | `chatgpt` | `manual_browser_capture` | gated (FR-17) | none, no code ships |

Identity across providers: message identity is `(provider, account_label, conversation_id, message_id, source_batch)`. The same uuid under
`claude` and `chatgpt` therefore denotes two unrelated records (asserted in `test/ingest/registry.test.ts`).
