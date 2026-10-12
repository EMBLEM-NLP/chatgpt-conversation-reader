---
title: ChatGPT Official Export Archive Format (research input for the GCR importer)
description: Evidence-labelled description of the ChatGPT "Export data" ZIP and its conversations.json (or sharded conversations-NNN.json) as documented by OpenAI and observed by community parsers, with a field schema, format drift timeline, tolerant-parsing strategy, 63 edge cases and a synthetic fixture plan.
version: 1.0.0
created: 2026-10-10T22:30:00Z
last_updated: 2026-10-10T22:30:00Z
---

# ChatGPT official export archive: structure, drift, tolerant parsing, edge cases, fixtures

Date accessed for every web source: 2026-10-10. Scope: features and data shapes only; no third-party code is reproduced or proposed for copying.

## 0. Read this first: limits of this research

1. **GCR cannot verify any of this against a live ChatGPT export in this environment.** No real export was available, none was requested, and nothing here was checked against one. Every field, type and enumeration below is either OpenAI's delivery wording (section 1) or a *secondhand observation* by community projects. Synthetic fixtures built from this document can only ever be classified `synthetic-only` in the parity matrix.
2. **OpenAI publishes no schema for the archive contents.** Its Help Center article describes how to request the export and says the ZIP holds "your chat history and other relevant account data"; it names no files and no JSON fields (see section 1). Everything about `conversations.json` is reverse-engineered by third parties, and several of them say plainly that the format changes without notice [S2, S5, S8].
3. **Access problems (reported, not worked around):**
   - `help.openai.com` was refused by the egress proxy (`403` on CONNECT, recorded in the proxy status endpoint). I therefore could **not** read OpenAI's article directly. The OFFICIAL claims in section 1 come from a WebSearch summary of that article (S1) and are corroborated only by another repository's research note that says it read the article (S20). Treat them as OFFICIAL-but-unverified-by-fetch.
   - `community.openai.com`, `ai-chat-importer.com`, `levelup.gitconnected.com` and `takeoutday.org` could not be fetched (DNS failure, `ENOTFOUND`). Their content appears here only as search-engine summaries or as quoted by other repositories, and is labelled accordingly.
   - The GitHub MCP tool is restricted to two repositories, so third-party sources were read through public `raw.githubusercontent.com` URLs pinned to the commit SHAs shown in section 12, and through GitHub code-search text fragments (those fragments are verbatim). No repository was added to the session.
4. **Paraphrase risk.** The fetch tool answers prompts through a small summarizing model, so quotations from fetched pages are paraphrases unless marked "verbatim (code-search fragment)". Where a number matters it was cross-checked against a second source when one existed.
5. **Prompt-injection hygiene.** All fetched content was treated as data. Nothing in it tried to redirect the task; no instruction found in any page was followed.
6. The newest sources describe changes made in the weeks before today (2026-10-10), including a report filed 2026-10-07. Facts that new are single-observer by construction.

### Label legend

| Label | Meaning |
|---|---|
| **OFF** | OFFICIAL: stated by OpenAI (URL given). In this document only delivery mechanics qualify, and only via S1/S20 (see limit 3). |
| **CO** | COMMUNITY-OBSERVED: reported by a third-party parser, census, spec or issue. `CO x2` means two or more *independent* observers (compilations that cite each other count once). |
| **UNC** | UNCERTAIN: single weak source, contradicted by another source, inferred, or my own derivation. |
| **VERIFIED-LOCAL** | Checked by running code in this environment (Node v22.22.0). Applies to JavaScript/JSON behaviour only, never to the export format. |

## 1. What OpenAI actually states (OFFICIAL, via S1 and S20)

Source article: OpenAI Help Center, "How do I export my ChatGPT history and data" (article 7260999), https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data (direct fetch blocked; see limit 3).

| # | Claim | Label | Src |
|---|---|---|---|
| 1.1 | Two routes exist: ChatGPT Settings > Data controls > Export data > Export (confirm on next screen), or the Privacy Portal (Make a Privacy Request > consumer ChatGPT account > Download my data). | OFF (unverified by fetch) | S1, S20 |
| 1.2 | An email or SMS announces readiness; delivery can take up to 7 days; the download link expires 24 hours after receipt. | OFF (unverified by fetch) | S1, S20 |
| 1.3 | The Settings route is available for Free, Plus, Pro and eligible ChatGPT Edu workspaces; **not** for Business or Enterprise workspaces (contact the workspace owner). | OFF (unverified by fetch) | S1 |
| 1.4 | The download is a ZIP containing "your chat history and other relevant account data". The article lists no file names and no JSON schema. | OFF (unverified by fetch) | S1, S20 |
| 1.5 | The export cannot restore chats that were already deleted. | OFF (unverified by fetch) | S1 |
| 1.6 | The article was shown as updated roughly 29 days before 2026-09-23 (about late August 2026). | UNC | S20 |
| 1.7 | Temporary chats are excluded from the export. | CO (vendor guides, search summary only) | S27 |

Consequence for GCR: the user-facing import docs may cite 1.1 to 1.5 as OFFICIAL. Nothing about `conversations.json` field names may be described as OpenAI-documented.

## 2. Archive layout (what may be inside the ZIP)

### 2.1 Container shapes reported

| Shape | Description | Label | Src |
|---|---|---|---|
| Flat ZIP, single file | Root has `conversations.json` (one JSON array, often minified on a single line, possibly hundreds of MB) plus `chat.html`, `user.json`, etc. | CO x4 | S2, S8, S14, S27 |
| Flat ZIP, sharded | `conversations.json` absent; `conversations-000.json`, `conversations-001.json`, ... each a top-level JSON array of conversation objects; pattern `^conversations-\d+\.json$` | CO x5 | S4, S5, S8, S18, S24, S29 |
| Sharded plus manifest | As above plus `export_manifest.json` (section 3) | CO x4 | S5, S16, S18, S19 |
| Nested ZIP ("ZIP-in-ZIP", Privacy Portal) | An outer ZIP wraps part-ZIPs named `Conversations__...part-00N.zip` and `Files__...files-00N.zip`; top-level folders such as `Financial/`, `User Profile/`, and uploads under `personal/files/<name>` are mentioned | CO x1 (single README) | S10, relayed by S20 |
| Nested folder prefix | Some exports nest everything under an `<export-name>/` folder; parsers search case-insensitively and in subfolders | CO x2 | S19, shape-report script (see S26) |
| `personal/conversations/conversations.json` | One upload tool lists this single-file path "for current exports" | UNC (search summary only) | S27 |
| Large archive without ZIP64 | The Privacy Portal export can exceed 4 GiB as a "non-ZIP64 archive whose internal offsets wrap at the 4 GiB boundary", defeating standard unzip tools (5 GB test export, 1,968 conversations, 5,936 media files) | CO x1 | S10 |
| macOS ZIP junk | `__MACOSX/` and `._*` entries appear when a user re-zips on macOS | CO x2 | S18, S19 |

Wrapper variants of the JSON itself: bare array (normal), or an object `{"conversations": [...]}` accepted by two independent parsers [CO x2, S8, S19]. Whether OpenAI ever emits the wrapper is UNC.

### 2.2 Files and folders

| Member | Content | Label | Src |
|---|---|---|---|
| `conversations.json` or `conversations-NNN.json` | The conversation array(s). The only file every source treats as required. | CO x many | all |
| `chat.html` | Offline viewer; embeds JSON; one parser reads `var assetsJson = ` from it, which maps message ids to asset file names. Not a primary source. | CO x3 | S2, S18, S11 |
| `user.json` | One object: `id`, `email`, `phone_number`, `birth_year`, `chatgpt_plus_user` (sources disagree on the exact field list). **PII.** | CO x3 | S2, S11, S12 |
| `user_settings.json` | Array of `{user_id, settings{chat_theme, training_allowed, voice_name, ...}}` | CO x2 | S5, S11 |
| `message_feedback.json` | Array of feedback records (sections 6.8) | CO x4 | S2, S11, S12, S26 |
| `shared_conversations.json` | Array of shared-link metadata (section 6.8) | CO x3 | S2, S11, S26 |
| `model_comparisons.json` | A/B "which response is better" data, usually empty; shape unknown | CO x2 (existence), UNC (shape) | S2, S8 |
| `group_chats.json`, `shopping.json`, `sora.json` | 2025 additions, mostly empty (`{"chats": []}`, `[]`, `{}`) | CO x2 | S2, S8 |
| `export_manifest.json` | See section 3 | CO x4 | S5, S16, S18, S19 |
| `conversation_asset_file_names.json` | Map of `<fileId>.dat` to an original or display name (values may be plain names, `dalle-generations/<uuid>.webp`, or `<conv-uuid>/audio/<uuid>.wav`); names may be sensitive | CO x4 | S3, S5, S9, S11 |
| `library_files.json` | Array of the user's file library entries (`file_id`, `file_name`, `mime_type`, `file_size_bytes`, `sha256_digest`, `library_artifact_type`, `origination_message_id`, `origination_thread_id`, `image_gen_generation_id`, ...) | CO x2 | S5, S11 |
| `textdocs/*.json` | Canvas documents, one JSON per document; schema unknown | CO x2 (existence) | S2, S8 |
| `dalle-generations/file-<id>-<uuid>.webp` | Generated images (older exports) | CO x2 | S2, S8 |
| `user-<user_id>/file_<hex>-<uuid>.png` | Newer generated images | CO x2 | S2, S8 |
| `<conversation_uuid>/audio/file_<id>-<suffix>.wav` | Voice recordings | CO x2 | S5, S23 |
| Root `file-<alnum>-<original name>`, `file_<hex>-sanitized.<ext>` | User uploads (older naming) | CO x2 | S2, S8 |
| Root `file-<id>.dat`, `file_<id>.dat` | Extension-less assets in 2026 exports; real type must be sniffed from magic bytes; some assets referenced by messages are missing from the package (23 of 271 in one test) | CO x4 | S3, S5, S9, S10 |

Reported name/ordering facts for later asset work (all CO x1-2): pointer `sediment://file_X` maps to package file `file_X.dat` [S9]; `file-service://file-<id>` often maps to `file-<id>-<suffix>.<ext>` [S23]; a pointer can carry a suffix such as `sediment://<hash>#file_<hex>#p_N.jpg` (PDF page renders) [S7].

## 3. Sharding and the manifest

| Fact | Label | Src |
|---|---|---|
| Large exports are split into `conversations-000.json`, `-001.json`, ...; each shard is a top-level JSON array with the same element schema as the single file. | CO x5 | S4, S5, S8, S12, S18 |
| One 2026-06 bulk export was 92 shards (`-000` to `-091`) of 100 conversations each, sharded by conversation id, not date. Another census analysed 8 files for 2,913 conversations. **Shard size is therefore not constant**; never assume 100. | CO (single for 92x100), UNC overall | S4, S6 |
| Sharding was reported by a guide dated 2026-02-13 (and by temnoon's README) as a change "in mid-February" (the year of that change is not confirmed by my sources); small histories may still get the single file. Existence of sharding is CO x2; its start date is UNC. | CO x2 / UNC | S20 (citing ai-chat-importer guide, temnoon), S27 |
| `export_manifest.json` fields as read by independent consumers: `version` (1), `manifest_file`, `export_files_count`, `logical_files_count`, `export_files` (array of `{path, size_bytes}`), `logical_files` (object keyed by logical name, e.g. `"conversations.json"`, each `{files: string[], sharded: boolean}`). The shard list is `logical_files["conversations.json"].files`. | CO x3 consumers (S16, S18, S19); S17 is a synthetic generator written to match, not evidence | |
| Consumer tolerance seen in the wild: manifest optional (warn, fall back to structural detection) [S18]; unknown `version` is "unverified" but data still preserved [S18]; manifest listing a shard that is missing is an error [S19]; `sharded` truthy or more than one file means sharded layout [S19]; one tool re-throws on a malformed manifest instead of falling back [S16] (do not copy that). | CO | S16, S18, S19 |
| Manifest "lists every file in the export with its byte size"; in a multipart export the first part's manifest lists every part's files. | CO x2 | S5, code comment in S26 |
| Lexical sort of shard names is wrong once names exceed fixed width (`conversations-10.json` before `conversations-2.json`; with 3-digit padding `-1000` sorts before `-999`). Sort by the parsed integer. | UNC (my derivation; the lexical bug itself is observed in S16 code behaviour) | S16 |
| Another source (S8) says `export_manifest.json` is "not confirmed by any source". Four later code bases read it, so treat it as CO but optional. | conflict, resolved CO | S8 vs S5, S16, S18, S19 |

## 4. Format-drift timeline (what changed, as reported)

Dates are the observer's, not OpenAI's. Nothing here is official.

| When (reported) | Change | Label | Src |
|---|---|---|---|
| Jan 2023 (sample ids) | Earliest documented shape comes from the *backend API*, not the export: conversation keys `create_time`, `current_node`, `mapping`, `moderation_results`, `title`; message keys include a flat `role` and `user: null`. The modern `author{role,name,metadata}` shape is not shown there. Whether very early exports used flat `role` is unknown. | UNC | S22 |
| Sep 2023 - Jun 2025 | A long OpenAI-community thread says the `conversations.json` format "recently changed" and sample code goes stale. | CO x1 (search summary) | S27 |
| Feb 2024; Nov 2024 | Warnings of changes; new content for Canvas, Search, Deep Research, Tasks and reasoning from Nov 2024. | UNC | S20 |
| Jan 2025 | New content types observed: `real_time_user_audio_video_asset_pointer` (voice with video), `sonic_webpage`, `tether_quote`, `system_error`. | CO x1 | S4 |
| Mar 2025 | Media naming changed; attachments reported as `.dat`, UUID folder structure removed. | UNC (weak source) | S25 |
| 2025 | `group_chats.json`, `shopping.json`, `sora.json`, `user-<id>/` added; many new conversation flags (`is_study_mode`, `is_do_not_remember`, `memory_scope`, `blocked_urls`, `disabled_tool_ids`, `async_status`, `sugar_item_*`). | CO x2 | S2, S6 |
| 2026-02-05 | Community spec v3.0 consolidates `sonic_webpage`, `system_error`, Canvas, `tether_v4` citations. | CO | S2 |
| 2026-02-27 | Full-fidelity census: 8 files, 2,913 conversations, 79,910 messages, roles `assistant` 33,432 / `user` 25,724 / `tool` 11,719 / `system` 9,035; `recipient` present on every message; presence of `children` is not reported by this census. | CO | S6 |
| ~2026-06 | "Bulk export generator" changed: conversation-level `gizmo_id`, `blocked_urls`, `is_read_only`, `is_study_mode`, `owner`, `pinned_time`, `plugin_ids`, `safe_urls`, `sugar_item_id`, `sugar_item_visible` dropped; `gizmo_type`, `conversation_template_id`, per-message `metadata.gizmo_id`/`model_slug` kept; hidden `system` nodes pre-trimmed; described as a strict subset of the old format. | CO x1 | S4 |
| 2026 (undated) | Privacy Portal ZIP-in-ZIP packaging; `file-<ID>.dat` assets; sharded `conversations-NNN.json`; `Financial/`, `User Profile/` folders. | CO x1 | S10 |
| 2026 (undated) | "New 2026 export format": every attachment is `<fileId>.dat` at the ZIP root; `conversation_asset_file_names.json`, `library_files.json`, `user_settings.json`, `export_manifest.json` present. | CO x2 | S5, S3 |
| 2026-07-10 (test) | On a 432-conversation export: only user/assistant visible messages kept (tool and system stripped); Canvas, code-interpreter payloads and `recipient` absent; `mapping` nodes carry only `parent` (**no `children`**); 47 of 432 (all 2023) conversations had `create_time`/`update_time` rewritten by a server-side migration (both equal the day before export; real time must come from message timestamps); 23 of 271 referenced attachments missing from the package; "Branch in new chat" conversations have `branching_from_conversation_title` but no parent id and copy the parent's message ids. | CO x1 (detailed), partly echoed by S5 | S9 |
| mid-2026 to Aug 2026 | Generated images were absent from exports entirely (no `.dat`, no index entry, no `metadata.dalle`), then returned via `library_files.json`; the message that displayed the image is sometimes omitted. | CO x1 | S5 |
| ~Jul 2026 onward | `status` and `weight` may be omitted from messages. | CO x1 (compilation) | S8 |
| 2026-10-06/07 | A fresh export (requested 2026-10-06) has **no `children` key** on nodes (26-message linear chat collapsed to one message in a parser that follows `children`); one shard contained a bare `{}` among 5,974 conversations; assets saved as `file-<id>.dat` or `file_0000...<hash>.dat`; top-level `conversation_asset_file_names.json`. | CO x1 (issue; second observer S9 agrees on missing `children`) | S3 |

Take-away for design: since mid-2026 the same user may receive an export whose graph is **parent-only**, **without system/tool/recipient data**, with **extension-less assets**, in **nested/sharded** containers. The importer must also still handle the richer early-2026 shape.

## 5. Source disagreements to design around

| # | Disagreement | Resolution for GCR |
|---|---|---|
| D1 | `children` present (S2, S7, S13, S14) vs absent (S3, S9) | Parent pointer is authoritative; `children` is an optional ordering hint. |
| D2 | System/tool nodes: full (S6) vs hidden-system trimmed (S4) vs all tool+system stripped (S5, S9) | Never assume roles exist; stats and `audit` must report the observed profile. |
| D3 | `thoughts.thoughts` is an array of `{summary, content, chunks, finished}` (S2, S8, S13) vs a **JSON-encoded string** (S7) | Accept both; if a string, try `JSON.parse` with a size cap, keep raw on failure. |
| D4 | `metadata.citations[]` elements are objects with `start_ix`, `end_ix`, `citation_format_type`, `metadata{...}` (S8, S15) vs `string[]` (S7) | Type as `unknown[]`; keep raw. |
| D5 | `weight` is `0` or `1` (S7) vs float such as `1.0`/`0.0` (S2, S6) | Accept any finite number; store raw. |
| D6 | Roles: four (most) vs also `function` (S8, "verified in a parser") | Preserve any string (SPEC already requires this). |
| D7 | `channel`: `final`, `commentary` (S6, S7) vs also `analysis` (S15, S28 known set) | Open string; null allowed. |
| D8 | Status: `finished_successfully`, `in_progress` (S6, S7), plus `finished_partial_completion` (1 message, S6) and `error` (S2) | Open string; absent allowed. |
| D9 | Root id: literal `client-created-root` (S7 for its data; code constants in S26) vs ordinary UUID in newer data (S13) vs "some exports don't use the key" (S26 comment) | Root = node with null/missing/dangling `parent`; never key on the literal. |
| D10 | `default_model_slug` always present (S7, 656/656) vs present on 2,098 of 2,913 (S6) | Optional. |
| D11 | `message_feedback.json.create_time` is an ISO string (S12) vs `number or null` (S11); `shared_conversations.json` times `number, string or null` (S11) | Auxiliary files: parse timestamps with the same tolerant reader as conversations. |
| D12 | Conversation `id` vs `conversation_id`: always equal in the 2,913-census (S6) but described as internal vs public (S2) | Index both aliases; prefer `conversation_id` for `/c/<uuid>` lookup; warn if they differ. |
| D13 | S7 spec is "derived from 656 exported conversation files (of ~1,171)", provenance (ZIP vs per-conversation API download) not stated | Do not treat S7 as proof of ZIP contents; use as a shape cross-check. |
| D14 | `export_manifest.json` "unconfirmed" (S8) vs read by four tools | Optional, tolerated. |

## 6. Schema tables

Convention: "present n/N" are counts from census S6 (2,913 conversations, 79,910 messages, analysis dated 2026-02-27) or S7 (656 conversation files, 2026 data) as stated. Absence in a census means "unknown", not "never".

### 6.1 Top level of a conversations file

| Item | Type | Notes | Label |
|---|---|---|---|
| File body | JSON array of conversation objects | Normal case | CO x5 |
| File body (variant) | object with key `conversations` holding the array | Accepted by two parsers; emission by OpenAI unproven | CO x2 (parsers), UNC (emission) |
| Array element | conversation object | **May be `{}`** (empty object) in a shard [S3]; non-object elements are silently dropped by one parser [S19] | CO x2 |

### 6.2 Conversation object

| Field | Type and nullability | Variants / notes | Label | Src |
|---|---|---|---|---|
| `id` | string (UUID) | Present 2,913/2,913 [S6]; usually equal to `conversation_id` | CO x3 | S2, S6, S7 |
| `conversation_id` | string (UUID) | Present 2,913/2,913 and duplicates `id` [S6]; described as the public id [S2]; some parsers read `conversation_id` first, others `id` first | CO x3 | S2, S6, S7 |
| `title` | string or null | Missing/null on 11 of 2,913 [S6]; new or empty chats | CO x2 | S2, S6 |
| `create_time` | number (float, Unix **seconds**) or null | Non-null 2,913/2,913 [S6]; typed nullable in S11; the old assumption "microseconds" was refuted by sample values [S20]; unit not stated by S11 | CO x3 | S2, S6, S20 |
| `update_time` | number (float, Unix seconds) or null | Same as above | CO x3 | S2, S6 |
| `mapping` | object (node id to node) | Typed possibly null in S11 (UNC); key order not message order | CO x many | all |
| `current_node` | string or null | Leaf of the active branch; present 2,913/2,913 [S6], 656/656 [S7]; may be missing or dangling in damaged data | CO x many | S2, S6, S7, S14 |
| `moderation_results` | array | Always `[]` in practice | CO x2 | S6, S7 |
| `default_model_slug` | string | 2,098/2,913 [S6] but 656/656 [S7]: treat as optional | CO, conflicting | S6, S7 |
| `model_slug` | string or null | Conversation-level model, newer | CO x1 | S2 |
| `gizmo_id`, `gizmo_type`, `conversation_template_id` | string or null | 758/2,913 each [S6]; `gizmo_type` values `gpt` (10) and opaque `snorlax` (748) [S6]; template ids starting `g-p-` denote Projects [S4]; `gizmo_id` dropped at conversation level in the 2026-06 bulk export [S4] | CO x3 | S4, S6, S7 |
| `is_archived` | boolean | Present always [S6] | CO x3 | |
| `is_starred` | boolean or null | Non-null on only 4 of 2,913 [S6] | CO | S6, S7 |
| `is_read_only`, `is_do_not_remember`, `is_study_mode`, `is_temporary_chat`, `atlas_mode_enabled` | boolean or null | `is_do_not_remember` 1,026/2,913 [S6] | CO | S6, S7, S8 |
| `safe_urls`, `blocked_urls`, `disabled_tool_ids` | array of string | `[]` typical | CO | S6, S7 |
| `plugin_ids` | array of string or null | 65/2,913 [S6] | CO | |
| `conversation_origin`, `voice`, `async_status` | string or null | `voice` string or object [S8]; `async_status` 25/2,913 [S6] | CO | S6, S7, S8 |
| `memory_scope` | string | Observed `global_enabled` (2,759), `project_enabled` (154) [S6] | CO | S6 |
| `context_scopes`, `sugar_item_id`, `sugar_item_visible`, `pinned_time`, `owner` | mixed, nullable | `pinned_time` number or null, 2/2,913 [S6] | CO | S2, S6, S7 |
| `branching_from_conversation_title` | string | Only on branch-in-new-chat conversations; parent id not given | CO x1 | S9 |
| (any other key) | unknown | "Any other key is expected to appear" [S8]; S11: unknown fields are forward-compatible additions | CO x2 | S8, S11 |

Verbatim (code-search fragment, undated notebook) key list of one conversation object: `title, create_time, update_time, mapping, moderation_results, current_node, plugin_ids, conversation_id, conversation_template_id, gizmo_id, gizmo_type, is_archived, is_starred, safe_urls, blocked_urls, default_model_slug, conversation_origin, voice, async_status, disabled_tool_ids, id` [CO x1, S26].

### 6.3 Node (`mapping` value)

| Field | Type and nullability | Notes | Label | Src |
|---|---|---|---|---|
| `id` | string | UUID or the literal `client-created-root`; equal to the map key in the samples reviewed [S7], but equality is not guaranteed | CO x3 | S7, S2, S26 |
| `message` | object or null | Null on the synthetic root (exactly one root per conversation in samples: 2,913 null-message nodes for 2,913 conversations [S6]); failed generations may also have `message: null` [S2]; "any node may have null message" [S15] | CO x4 | S2, S6, S7, S15 |
| `parent` | string or null | Null on the root. **Present in both old and new formats** [S3] | CO x many | |
| `children` | array of string | `[]` on leaves; more than one entry at branch points. **Absent in exports reported from 2026-07 / 2026-10** | CO x4 (present), CO x2 (absent) | S2, S7, S13, S14 vs S3, S9 |

Node count arithmetic seen in a census: total nodes 82,823 = 79,910 messages + 2,913 null roots [S6].

### 6.4 Message

| Field | Type and nullability | Variants / notes | Label | Src |
|---|---|---|---|---|
| `id` | string | Usually equals node id [S7]; **branch-in-new-chat conversations copy the parent conversation's message ids**, so ids are unique only within one conversation [S9] | CO | S7, S9 |
| `author` | object `{role, name, metadata}` | `name` null on most messages (set on tool messages; 11,719 of 79,910 had a name in S6); `metadata` usually `{}` | CO x4 | S2, S6, S7 |
| `author.role` | string | `user`, `assistant`, `system`, `tool`; `function` reported by one parser | CO x4 | S6, S7, S8 |
| `create_time`, `update_time` | number or null | Message `create_time` present on all 79,910 in S6 but null is common on root/system nodes [S20, S7]; `update_time` mostly null | CO x3 | S6, S7, S20 |
| `content` | object | Polymorphic by `content_type` (6.5) | CO x many | |
| `status` | string | `finished_successfully` (79,672), `in_progress` (237), `finished_partial_completion` (1) [S6]; 238 messages lacked `status` [S6]; may be omitted entirely from ~Jul 2026 [S8] | CO x3 | S6, S7, S8 |
| `end_turn` | boolean or null | | CO x3 | S2, S7, S8 |
| `weight` | number | `0.0` on 7,884 of 79,910 [S6]; 0 marks discarded/hidden or off-active-branch nodes (inferred); may be omitted | CO x3 | S6, S7, S8 |
| `recipient` | string | `all` by default; tool targets otherwise (6.9); absent in the 2026-07 trimmed export [S9] | CO x4 | S6, S7, S9 |
| `channel` | string or null | 2,712 of 79,910 had it [S6]; values 6.9 | CO x3 | S6, S7, S15 |
| `metadata` | object or null | Open key set (6.7); can be null [S4] | CO x3 | |

### 6.5 Content object: `content_type` values

Counts: S6 = 2,913-conversation census (12 types). Fields not named by an observer are marked "unknown".

| `content_type` | Fields inside `content` | S6 count | Label | Src |
|---|---|---|---|---|
| `text` | `parts`: array of string | 66,123 | CO x many | |
| `multimodal_text` | `parts`: array mixing strings and objects (6.6) | 1,569 | CO x many | |
| `code` | `language` (often `"unknown"`), `text`, `response_format_name` (string or null); assistant tool call, target in `recipient`; Canvas text is JSON inside `text` with `{name, type, content}` or `updates` | 1,931 | CO x4 | S7, S13, S15, S6 |
| `execution_output` | `text`; images in `metadata.aggregate_result.messages[]` | 773 | CO x4 | |
| `tether_quote` | `url`, `domain`, `title`, `text` (references to uploaded files use `file-id` forms in 4,965 of 5,161) | 5,161 | CO x3 | S6, S8, S15 |
| `tether_browsing_display` | `result`, `summary` (nullable), `assets`, `tether_id` | 1,244 | CO x3 | S7, S8, S13 |
| `tether_browsing_code` | exists; fields unknown | n/a | CO (existence) x1 | S8 |
| `sonic_webpage` | `url`, `domain`, `title`, `text`, `snippet`, `pub_date`, `crawl_date`, `pub_timestamp`, `crawl_timestamp`, `ref_id` | not in S6 | CO x3 | S2, S7, S4 |
| `system_error` | `name`, `text` | 81 | CO x3 | S6, S7, S8 |
| `user_editable_context` | `user_profile`, `user_instructions` (custom instructions); real values may live only in `metadata.user_context_message_data.{about_user_message, about_model_message}`; `text` may be empty or `"None"` | 1,170 | CO x5 | S4, S6, S7, S14, S24 |
| `model_editable_context` | `model_set_context` (memory as given to the model), `repository`, `repo_summary`, `structured_context` | not in S6 | CO x4 | S7, S13, S26 |
| `thoughts` | `thoughts`: array of `{summary, content, chunks, finished}` **or a JSON string** (D3); `source_analysis_msg_id` | 1,042 | CO x3 (array), CO x1 (string) | S2, S8, S7 |
| `reasoning_recap` | `content` (string); `metadata.finished_duration_sec`, `reasoning_title` | 788 | CO x4 | S8, S7, S13 |
| `computer_output` | `computer_id`, `screenshot`, `tether_id`, `state`, `is_ephemeral` (Operator/agent) | 15 | CO x2 | S6, S7 |
| `citable_code_output` | `output_str` | 13 | CO x1 | S6 |
| `app_pairing_content` | unknown | n/a | CO x1 (name only) | S26 (echomine table) |
| anything else | keep verbatim | n/a | policy | S8 gotcha 1 |

Observed null-`parts` content types (no `parts` array at all): `tether_browsing_display`, `user_editable_context`, `thoughts`, `reasoning_recap`, `execution_output`, `computer_output`, `citable_code_output`; `tether_quote` and `code` too per one parser analysis [CO x2, S6, S4]. The reference note "parts can be None!" [S4] applies to every type.

### 6.6 `parts[]` element variants (inside `multimodal_text`)

| Variant | Fields | Count / note | Label | Src |
|---|---|---|---|---|
| string | text | 67,767 in S6 | CO | S6 |
| `image_asset_pointer` object | `content_type`, `asset_pointer` (`sediment://file_<hex>`, `file-service://file-<id>`, or `sediment://<hash>#file_<hex>#p_N.jpg`), `size_bytes`, `width`, `height`, `fovea` (nullable), `metadata{dalle{gen_id, prompt, seed, serialization_title}, gizmo, generation, container_pixel_height/width, sanitized}` | 1,378 in S6 (all in `multimodal_text`); pointer schemes `file-service://` 1,052 vs `sediment://` 326 [S6] | CO x many | S2, S6, S7, S8 |
| `audio_transcription` | `decoding_id`, `direction` (`in` or `out`), `text` | | CO x3 | S7, S8, S23 |
| `audio_asset_pointer` | `asset_pointer`, `expiry_datetime`, `format` (`wav`), `size_bytes`, `metadata{start_timestamp, end_timestamp, pretokenized_vq}`, `tool_audio_direction` | | CO x3 | S7, S8, S23 |
| `real_time_user_audio_video_asset_pointer` | `audio_asset_pointer`, `audio_start_timestamp`, `expiry_datetime`, `frames_asset_pointers[]`, `video_container_asset_pointer` | | CO x3 | S7, S8, S23 |
| `video_container_asset_pointer` | unknown | not present in the S23 snapshot | UNC | S23 |
| `search_result_group` / `search_result` | keyed by `type` (not `content_type`); `entries[]` with `ref_id{ref_type, turn_index, ref_index}`, `title`, `url`, `snippet` | | CO x2 | S8, S15 |
| any other object | keep verbatim | | policy | |

Mixed-type `parts` is normal, not an error [S2, S5, S15].

### 6.7 `metadata` keys (open set; consume what is mapped, keep the rest)

| Key | Type / meaning | Presence in S6 (of 79,910) | Label | Src |
|---|---|---|---|---|
| `model_slug` | string; per message, may change mid-conversation; the only place a model is *stated* | 48,963 | CO x many | |
| `default_model_slug` | string | 43,542 | CO | S6, S7 |
| `finish_details` | `{type: "stop", stop_tokens: number[]}` or `{type: "interrupted", reason}` (e.g. `client_stopped`) | 26,136 | CO x3 | S6, S7, S14 |
| `is_complete` | boolean | 25,438 | CO | S6 |
| `message_type` | string; `next`, `suggestion` seen [S7]; null in older data | 19,830 | CO x2 | S6, S7 |
| `parent_id` | string (message id) | 46,546 | CO | S6, S7 |
| `request_id`, `turn_exchange_id` | string | 64,044 / 10,812 | CO | S6, S7 |
| `timestamp_` | the marker string `"absolute"`, **not a time** | 68,736 | CO | S6, S22 |
| `is_visually_hidden_from_conversation` | boolean; system prompts, memory, custom instructions, reasoning scaffolding | 17,107 | CO x many | |
| `is_user_system_message` | boolean | | CO | S7, S8, S24 |
| `user_context_message_data` | `{about_user_message, about_model_message}` | 1,525 | CO x3 | S4, S14, S24 |
| `citations` | array (D4); legacy tether format with `start_ix`, `end_ix`, `citation_format_type`, `metadata{title,url,text,type,extra}` | 24,588 | CO x3 | |
| `content_references` | array of open `type` objects (`grouped_webpages`, `sources_footnote`, `webpage`, `image_group`, `file`); in the trimmed export has no `matched_text`/`start_idx` and file refs use `input_pointer(message_index, file_index)` | 22,551 | CO x3 | S6, S8, S9, S13 |
| `search_result_groups`, `search_queries` | arrays | 984 (798 in another table of the same note) | CO | S6, S13 |
| `_cite_metadata` | `{citation_format{name}, metadata_list[]}` | | CO | S2, S8 |
| `attachments` | array (6.8a) | 2,210 | CO x many | |
| `aggregate_result` | `{code, final_expression_output, start_time, end_time, jupyter_messages[], messages[], run_id, status, update_time, files}` | 773 | CO x3 | S6, S8, S15 |
| `canvas` | object (Canvas operations) | 854 | CO x1 | S6 |
| `dictation`, `selected_sources`, `selected_github_repos`, `developer_mode_connector_ids`, `classifier_response`, `serialization_metadata`, `can_save`, `pad`, `command`, `args`, `kwargs` | opaque | see S6 | CO x1 | S6 |
| `reasoning_status`, `thinking_effort`, `reasoning_title`, `finished_duration_sec`, `is_thinking_preamble_message` | reasoning-model metadata | | CO x2 | S6, S7, S8 |
| `gizmo_id` (message-level) | string | 9,340 | CO | S4, S6 |
| `image_gen_title`, `async_task_id`, `async_task_type`, `invoked_plugin`, `rebase_system_message`, `rebase_developer_message` | misc | | CO x1-2 | S6, S7, S8 |

S7 counted **118 unique metadata keys** across 656 files; the open-set rule is non-negotiable.

### 6.8 Attachments, assets, citations, auxiliary files

**6.8a `metadata.attachments[]`** (CO x many): `id` (`file-<alnum>` or `file_<hex>`), `name`, `mime_type` (some entries use camelCase `mimeType`), `size` (alternates `fileSizeTokens`/`file_token_size` seen), `source` (`local`, `library`), `library_file_id`. Items counted: 7,999 in 2,210 messages [S6]; MIME mix includes mis-detections such as `video/mp2t` for `.ts` source files [S6]. Every attachment reference sits on a *user* message; assistant-generated images are not referenced inline [S5]. Attachment filenames and `conversation_asset_file_names.json` values are untrusted strings (path traversal text, markup).

**6.8b Pointers.** `file-service://` is legacy, `sediment://` is current [S2, S6, S23, S26]. Pointers are internal to OpenAI and cannot be downloaded [S6]; only the package copy (if present) is usable. Resolution order reported: exact file name equal to id, then first root file whose name starts with the id, then the same in `dalle-generations/`, then in each `user-*/` [S8]; 2026 `.dat` form resolves via `conversation_asset_file_names.json` or by trying `<fileId>.dat` [S5].

**6.8c Citation tokens.** Inline markers like `citeturn0search3` use invisible private-use delimiters U+E200 to U+E203; match on `matched_text`, not on `start_idx`/`end_idx`; some `sources_footnote` entries have a plain-space `matched_text` [S13]. "Ghost citations" (search groups present, `citations` empty) occur [S8].

**6.8d Auxiliary file shapes (all CO, shapes weak).**

| File | Shape | Label |
|---|---|---|
| `user.json` | single object `{id, email, phone_number, birth_year?, chatgpt_plus_user}` | CO x3 |
| `message_feedback.json` | array of `{id, conversation_id, message_id, user_id, workspace_id, rating ("thumbs_up"/"thumbs_down"/other), content (string, possibly JSON like `{"tags":[...],"text":"..."}`), create_time, update_time}`; time is ISO string in S12 and `number or null` in S11 | CO x2, times conflicting |
| `shared_conversations.json` | array of `{id, conversation_id, title, is_anonymous, create_time, update_time}`; times `number, string or null` | CO x1 (S11, self-described as not verified) |
| `group_chats.json` | `{chats: [{id, name, members, messages[]}]}`; messages are arrays, **not** a `mapping` graph | CO x1 (S11) |
| `user_settings.json` | array of `{user_id, settings{...}}` | CO x1 |
| `library_files.json` | array, many optional fields plus unknown keys | CO x2 |
| `conversation_asset_file_names.json` | `Record<string,string>` | CO x4 |
| `model_comparisons.json` | unknown | UNC |

### 6.9 Open-string enumerations (never close these in a type or a CHECK constraint)

| Field | Values observed | Src |
|---|---|---|
| `author.role` | `user` 25,724; `assistant` 33,432; `tool` 11,719; `system` 9,035; `function` (one parser) | S6, S8 |
| `status` | `finished_successfully` 79,672; `in_progress` 237; `finished_partial_completion` 1; `error` (spec) | S6, S2 |
| `channel` | `final` 2,479; `commentary` 233; `analysis` (known-set in two parsers); null | S6, S15, S28 |
| `recipient` | `all` 75,441; `assistant` 1,020; `python` 824; `bio` 602; `canmore.update_textdoc` 327; `web` 316; `canmore.create_textdoc` 288; `web.run` 262; `t2uay3k.sj1i4kz` 224 (opaque codename); `browser` 175; `dalle.text2im` 168; `web.search` 72; `file_search.msearch` 54; ...; long tail of plugin names and codenames (`q7dr546`, `a8km123`) | S6, S7 |
| `author.name` | 23 distinct values in S7 (`web.run`, `python`, `mtbrowser.search`, `browser.open`, `file_search`, `container.exec`, `computer.do`, `api_tool.call_tool`, ...) | S7 |
| `finish_details.type` | `stop`, `interrupted` | S7 |
| `message_type` | `next`, `suggestion`, null | S7, S6 |
| `memory_scope` | `global_enabled`, `project_enabled` | S6 |
| `gizmo_type` | `gpt`, `snorlax` | S6 |

## 7. Visibility rules reported by working viewers (display attributes, not deletion rules)

A lossless importer keeps all of these; "hidden" is an attribute (S8 section 11 and S2 agree):

- empty content, `is_visually_hidden_from_conversation == true`;
- `system` messages except custom instructions (`user_editable_context`);
- `tool` output except `tether_quote`;
- assistant messages whose `recipient` is not `all` (or `python`/null in some viewers);
- content types `code`, `sonic_webpage`, `system_error`, `tether_browsing_display`, `thoughts`, `reasoning_recap`;
- `weight == 0` off the active branch, `channel == "commentary"`.
- Abandoned regeneration branches typically show `status: "in_progress"` with `finish_details.type == "interrupted"` [S14].

GCR privacy note: `user_editable_context`/`model_editable_context`/`user_context_message_data` carry custom instructions and memory, which repeat in every conversation and may contain PII; `user.json`, `user_settings.json`, feedback `content`, shared-link `title` and asset display names are also sensitive. Recommend: store hidden/system/context blocks with a `hidden` flag, exclude them from default search and default rendering, and never import `user.json` content beyond a hash of the account id.

## 8. Tree semantics

| Rule | Evidence | Label |
|---|---|---|
| The visible thread is the path from `current_node` up `parent` links to the root, reversed. | S2, S4, S6, S8, S12, S15, S20 (many) | CO x many |
| `mapping` holds every node ever created, including branches abandoned by edits and regenerations; iterating the map yields never-displayed messages; more nodes than the active branch is normal, not corruption. | S13, S15 | CO x2 |
| A branch point is a node with more than one child (edited user turn or regenerated assistant turn). Without `children`, a branch point is a node that is the `parent` of more than one node. | S2, S8, S15; derived | CO / derivation |
| Following `children[0]` (or the last child) enumerates abandoned drafts and is wrong. | S13, S26 (openwebui-importer note) | CO x2 |
| Fallback when `current_node` is missing or dangling: newest leaf by `create_time`; correct in nearly all but not all heavily-edited cases. GCR ADR-0009 deliberately forbids using this silently. | S15, S20 | CO x2 |
| Cycles are guarded with a visited set by several parsers (S26). One importer (S14) skips the whole conversation as `malformed_tree` on a parent-chain cycle and as `broken_current_node` when `current_node` points at a missing node. | S14, S26 | CO x2 |
| Message ordering among alternatives: `create_time`, then node id. | S8 | CO x1 |
| Consecutive assistant messages may be continuations to merge; `_graph_index` may confirm adjacency. | S4 | CO x1 |

Parity note (local fact): CCR flattens by "follow the last child, sorted by created_at" (`<ccr-checkout>/src/extractors/conversation.ts:31` comment, children sort at `:49-52`, root detection at `:28-29`). The ChatGPT export instead has an explicit active-branch pointer (`current_node`), so GCR must not port CCR's heuristic as its default; this matches GCR ADR-0009.

## 9. Recommended tolerant-parsing strategy

Principle: **parse the container strictly (it is hostile input), parse the data leniently (it is drifting input), and never lose information.** Strictness and leniency live in different layers.

### Layer 0: input discovery (strict on safety, lenient on layout)

1. Accept: ZIP, extracted directory, single `conversations.json`, a set of shards, JSON from stdin. Detect by content signature, not by extension alone.
2. Find candidate conversation files by basename regex `^conversations(?:-(\d+))?\.json$`, case-insensitive, at any depth, skipping `__MACOSX/` and `._*`; also descend into **one level of nested `.zip` entries** (Privacy Portal layout) with the same safety checks and a shared cumulative inflate budget (a nested archive multiplies decompression-bomb risk).
3. If `export_manifest.json` exists and parses and `logical_files["conversations.json"].files` is a non-empty string array: use it as the *expected* shard list, then reconcile with what was discovered (warnings `MANIFEST_SHARD_MISSING`, `MANIFEST_COUNT_MISMATCH`, `SHARD_NOT_IN_MANIFEST`). A missing, malformed or unknown-`version` manifest produces a warning and structural detection, never a failure. Reject manifest paths that traverse out of the archive.
4. Sort shards by the parsed integer, not lexically. If both `conversations.json` and shards exist, import all, dedupe by conversation id with a deterministic rule (newest `update_time`, then largest element, then file order) and a `DUPLICATE_CONVERSATION` warning that records which won; never silently pick.
5. Auxiliary files (`user.json`, `user_settings.json`, feedback, shared links, library, asset-name map) are optional, size-capped, and imported only as metadata the caller opts into.

### Layer 1: bytes to text (lenient)

6. Strip a UTF-8 BOM; reject UTF-16/UTF-32 with `IMPORT_UNSUPPORTED_FORMAT` and a remedy; decode UTF-8 with replacement and count replacements (`INVALID_UTF8`).
7. Keep each conversation element's **exact source bytes** (or a lossless slice) plus a SHA-256. Do not re-serialize for raw preservation: re-serializing changes numbers (`1700000000.123456789`, integers above 2^53), duplicate keys and key order (VERIFIED-LOCAL, section 10).

### Layer 2: streaming JSON (strict syntax, bounded resources)

8. Standard JSON only. `NaN`, `Infinity`, trailing commas and concatenated documents are errors for that element/file with a precise offset (VERIFIED-LOCAL that `JSON.parse` rejects them; a Python-written export could contain `NaN`, so this is a documented UNC risk, see EC-27).
9. Enforce a maximum element size, nesting depth and total node/part counts; fail the element, not the run (default: record warning and continue; `--strict` aborts), matching GCR's current `maxElementBytes`.
10. **Detect duplicate object keys at tokenization time** (in `mapping` and `metadata` particularly). `JSON.parse` silently keeps the last value (VERIFIED-LOCAL), so a duplicate node id is invisible to any later "dedupe adapter" stage.
11. Preserve object key order with an ordered map: JavaScript objects reorder integer-like keys (`"10"` sorts after `"9"`, before string keys; VERIFIED-LOCAL), and `__proto__` as a key must be an own property (use `Map` or `Object.create(null)`; assignment through `obj["__proto__"]` mutates the prototype, VERIFIED-LOCAL).
12. Unwrap `{"conversations": [...]}` only when the object has a `conversations` array and no `mapping`; otherwise treat the object as a single conversation. An empty `{}` element, `null` and non-object elements are skipped with `EMPTY_CONVERSATION_ENTRY` / `NON_OBJECT_ENTRY` and counted.

### Layer 3: lenient lens over each conversation (never throw on a bad optional field)

13. Read every field through a typed accessor that returns a value plus a recorded issue, never an exception: wrong type means "absent" plus a counted warning; the raw value stays in the raw slice.
14. Identity: `conversation_id ?? id`; index both; if neither, synthesize a deterministic id from the element hash and ordinal (`CONVERSATION_ID_MISSING`). Do not trust `message.id === node key`; record both and warn on mismatch.
15. Tree: build edges from `parent` (authoritative). Treat `children` as an ordering hint: absent array is `CHILDREN_ABSENT` (derive once, one warning per conversation), present and inconsistent is `CHILD_PARENT_MISMATCH`. Derived child order: `(message.create_time asc nulls last, file ordinal, id)`. Roots are nodes with null/missing/dangling `parent`. Do not key on the literal `client-created-root`. The walk is iterative with a visited set (GCR `analyzeTree` already is).
16. Active branch: only from a `current_node` that exists in `mapping` (even if it is not a leaf: record `CURRENT_NODE_NOT_LEAF` as info). Otherwise `ACTIVE_BRANCH_UNKNOWN` (GCR ADR-0009), never a guess.
17. Timestamps: accept finite numbers as seconds; accept numeric strings and ISO-8601 strings with a `TIMESTAMP_FORMAT` info; reject non-finite, negative, zero, or outside a plausibility window (suggest 2015-01-01 to 2100-01-01) as null plus `TIMESTAMP_OUT_OF_RANGE`; detect millisecond-scale values (e.g. 1.7e12) instead of silently accepting them (a ms value read as seconds is a valid but absurd Date, VERIFIED-LOCAL). Keep the raw value. Do not trust conversation-level times for old chats (S9): derive `first_message_at` from messages as a separate column.
18. Content: switch on `content_type` into **typed blocks**, with explicit handlers for the 16 named types in 6.5 (two of them, `tether_browsing_code` and `app_pairing_content`, have unknown field sets, so handle them as raw-preserving) and a catch-all `unknown:<type>` that keeps the raw JSON. `parts` is `null`, absent, an array of strings, or a mixed array; non-string parts become `image_ref`/`audio_ref`/`file_ref`/`unknown` blocks with the raw object attached. `thoughts` may be an array or a JSON string. Text for FTS is built only from visible string content; placeholders for non-text parts are explicit (`[image: sediment://...]`) and never invented.
19. Roles, channels, statuses, recipients, `author.name`: open strings preserved verbatim; legacy flat `role` (S22) is read as a fallback for `author.role` (UNC).
20. Model attribution: only `message.metadata.model_slug`; `default_model_slug` is stored as a default, never as the used model (SPEC FR-16).
21. Assets: record pointers and attachment metadata; classify each as `present_in_package`, `missing_from_package` (expected: 23 of 271 in one test), or `not_resolvable`; never fabricate multimodal assets; sniff `.dat` types by magic bytes only for display, never execute.
22. Sanitize at the boundary, not at storage: NUL bytes stripped from searchable text with a warning (GCR already does this), lone surrogates replaced with U+FFFD with `LONE_SURROGATE` (SQLite UTF-8 conversion would otherwise do it silently, VERIFIED-LOCAL that encoding yields `EF BF BD`), and all message text treated as untrusted data in HTML export, FTS query building, logs and MCP output.

### Layer 4: reporting

23. Emit an `ImportReport` per source file with counts by warning code, and a **format profile** of observed facts (not a guessed version number): `{layout: single|sharded|nested, manifest: present|absent, rootIsLiteral, childrenPresentRatio, roleCounts, recipientPresent, statusPresent, weightPresent, assetsExtensionless, wrapperObject}`. `audit` and `stats` print it so users can see that a count by role is meaningless for a trimmed export. Completeness is `exported_tree` only when parent links form a forest with a valid `current_node`; otherwise lower it and say why.
24. Idempotency: key `(provider, conversation_id, message_id, source_batch)` as in the SPEC; because message ids can repeat across conversations (S9) and conversation ids can repeat across shards, the conflict policy in step 4 must be deterministic and tested.

## 10. Local verification of platform behaviour (VERIFIED-LOCAL, Node v22.22.0, V8 12.4.254.21-node.33)

Script: `<scratchpad>/gcr-format-probe/probe.mjs` and `probe2.mjs`. These facts constrain the importer; they say nothing about OpenAI's data.

| Probe | Result | Implication |
|---|---|---|
| `buffer.constants.MAX_STRING_LENGTH` | 536,870,888 (about 512 MiB of characters) | A `conversations.json` larger than ~512 MiB cannot be read into one string: streaming is mandatory (exports of 105 MB and several GB are reported) |
| `JSON.parse('{"a":1,"a":2}')` | `{"a":2}` | Duplicate keys vanish silently |
| `JSON.parse('{"__proto__":{...}}')` | own key `__proto__`, no pollution at parse; `m["__proto__"]=x` on a plain object sets the prototype | Use `Map` for `mapping` |
| `Object.keys(JSON.parse('{"b":1,"2":1,"1":1,"a":1,"10":1,"9":1}'))` | `["1","2","9","10","b","a"]` | Plain objects lose file order for integer-like ids |
| `JSON.parse('1e999')`; `12345678901234567890`; `-0`; `1700000000.123456789` | `Infinity`; `12345678901234567000`; `-0`; `1700000000.1234567` | Non-finite and lossy numbers must be guarded; keep raw text |
| `JSON.parse('"a\\ud800b"')` | accepted; string not well-formed; UTF-8 encoding of it gives `61 EF BF BD 62` | Lone surrogates survive parse but not storage |
| `JSON.parse('"a\\u0000b"')` ok; raw NUL byte inside a string rejected | | NUL arrives only as an escape; strip for FTS, keep raw |
| `JSON.parse('﻿[]')` | rejected | Strip BOM before parsing |
| `NaN`, `Infinity`, `[1,]`, `{'a':1}`, two concatenated documents, trailing text, empty input | all rejected | Strict-syntax errors need precise offsets and per-file isolation |
| `JSON.parse` of 1,000,000-deep nesting | succeeded; `JSON.stringify` at depth 100,000 threw `RangeError` | Native parse is not the DoS vector; recursive walkers and re-serializers are; GCR's own tokenizer needs an explicit depth cap |
| 50 MiB single string part | parsed in ~49 ms | A 50 MB message is cheap to parse but must still pass `maxElementBytes`, FTS tokenization and output caps |
| `new Date(1700000000000*1000)` | valid (year ~55841) | Millisecond-as-seconds is not caught by `isNaN(date)`; use a window |

## 11. Edge cases a robust importer and its test-suite must cover

Legend for "Basis": CO/UNC as above, ADV = adversarial (from the task or derived by me, no community report), LOC = verified locally. Suggested warning/error codes are proposals; GCR's existing ones are used where they exist.

### 11.1 Container, ZIP, shards

| ID | Case | Expected behaviour | Basis |
|---|---|---|---|
| EC-01 | Single `conversations.json` at ZIP root | Import | CO |
| EC-02 | Sharded `conversations-000..NNN.json`, no single file | Import all in numeric order | CO |
| EC-03 | Both `conversations.json` and shards present | Import all; deterministic dedupe; `DUPLICATE_CONVERSATION` | CO (S6 file list suggests mixing), ADV |
| EC-04 | Shard numbering gaps (`-000`, `-002`) or width change (`-999`, `-1000`) | Numeric sort; `SHARD_GAP` warning; manifest cross-check | ADV, derived from S16 |
| EC-05 | Manifest present and consistent | Use as expected set; no warnings | CO |
| EC-06 | Manifest absent | Structural detection; one info warning | CO |
| EC-07 | Manifest malformed JSON, wrong types, `version` 2, empty `files`, shard path with `..` or absolute path, lists a missing shard | Warn (or error only for the traversal case); never abort import for manifest problems | CO (S16, S18, S19), ADV |
| EC-08 | Nested ZIPs (`Conversations__...part-001.zip`, `Files__...`) | Read one nesting level with shared budget; deeper nesting refused `IMPORT_LIMIT_EXCEEDED` | CO x1 |
| EC-09 | Export under an `<export-name>/` prefix or `personal/conversations/` | Found by recursive search; ambiguity (two matches) is an error asking for a path | CO, UNC |
| EC-10 | `__MACOSX/`, `._*`, `.DS_Store` entries | Ignored | CO |
| EC-11 | Case-variant names (`Conversations.JSON`), duplicate names differing only in case | Case-insensitive match; duplicate names rejected | CO, ADV |
| EC-12 | ZIP > 4 GiB written without ZIP64 (offsets wrapped) | `IMPORT_ZIP_UNSAFE` with a remedy ("re-download or extract with a ZIP64-aware tool"); no partial import | CO x1 (S10) |
| EC-13 | Path traversal, absolute path, drive letter, backslash, NUL in name, symlink, encrypted entry, CRC or size mismatch, overlapping offsets, high compression ratio, huge entry count | Existing GCR guards; each a distinct test with the right code | ADV (GCR spec) |
| EC-14 | ZIP bomb via nested archive (small outer, large inner) | Budget shared across nesting levels; trip `IMPORT_LIMIT_EXCEEDED` | ADV |
| EC-15 | A shard is truncated mid-element or mid-string | Elements before the break are kept; `IMPORT_PARSE_ERROR` for that file with offset; run continues unless `--strict` | ADV |
| EC-16 | A shard is not an array (object wrapper, `{}`, string, number, `null`) | Unwrap `{"conversations":[..]}`; otherwise `IMPORT_UNSUPPORTED_FORMAT` for that file | CO x2, ADV |
| EC-17 | Array contains `{}`, `null`, a number, a string, a nested array | Skip with a counted warning; other elements import | CO (S3), ADV |
| EC-18 | UTF-8 BOM; invalid UTF-8 bytes; UTF-16 file | BOM stripped; invalid bytes replaced + warning; UTF-16 refused with remedy | LOC, ADV |
| EC-19 | Whole file minified on one line of hundreds of MB | Streams within memory bound; line length never limits | CO |
| EC-20 | Element larger than `maxElementBytes` (e.g. 300 MiB conversation) | Fail that element with `IMPORT_LIMIT_EXCEEDED`; others continue | ADV |

### 11.2 JSON text level

| ID | Case | Expected behaviour | Basis |
|---|---|---|---|
| EC-21 | **Duplicate keys** inside `mapping` (same node id twice, different bodies) | Detected at tokenization; `DUPLICATE_NODE_ID`; last wins; both bodies' hashes recorded | ADV, LOC |
| EC-22 | Duplicate keys elsewhere (`content_type`, `parts`, `metadata`) | Same detection, warning, last wins | ADV, LOC |
| EC-23 | Node ids `__proto__`, `constructor`, `toString`, `hasOwnProperty` | Stored as ordinary ids; no prototype pollution; lookups by `Map` | ADV, LOC |
| EC-24 | Integer-like node ids (`"1"`, `"10"`, `"9"`) | File order preserved for tie-breaks | ADV, LOC |
| EC-25 | **Huge numbers**: integers above 2^53, `1e999`, `-0`, 400-digit literals, `weight` 1e308 | Non-finite becomes null + warning; lossy integers flagged; raw slice untouched | ADV, LOC |
| EC-26 | Nesting depth 100,000 inside `metadata` | Depth cap trips `IMPORT_LIMIT_EXCEEDED`; no stack overflow in any walker or serializer | ADV, LOC |
| EC-27 | `NaN`/`Infinity` literals (Python `json.dumps` default) | Precise parse error for that file; remedy text; documented as UNC risk | UNC, LOC |
| EC-28 | **Lone surrogates** (`\ud800`, `\udfff`) in text, titles, ids | Kept in raw; replaced by U+FFFD in stored text with `LONE_SURROGATE`; round-trip hash stable | ADV, LOC |
| EC-29 | **NUL bytes** (`\u0000`) in text, titles, ids, attachment names | Stripped from searchable text + warning; ids containing NUL rejected or escaped deterministically | ADV, LOC |
| EC-30 | U+2028/U+2029, bidi controls (U+202E), zero-width joiners, astral emoji, private-use U+E200-E203 | Stored verbatim; rendering escapes bidi controls; FTS handles tokens | ADV |
| EC-31 | **One 50 MB message** (string part), also 50 MB with escapes, also 1M parts of 10 bytes | Accepted within limits; FTS and output truncated with explicit markers; memory stays bounded | ADV, LOC |

### 11.3 Conversation level

| ID | Case | Expected behaviour | Basis |
|---|---|---|---|
| EC-32 | Missing `id` and `conversation_id`; both present but different; non-UUID; uppercase UUID; whitespace | Synthetic deterministic id or skip with code; both aliases indexed; lowercase canonical form | CO, ADV |
| EC-33 | Same conversation id in two shards or two imports with different content | Deterministic conflict rule; idempotent re-import; no cross-provider corruption | ADV (SPEC section 5) |
| EC-34 | `title` null/absent/non-string/very long/markup | Null stays null; never used as identity | CO |
| EC-35 | `create_time`/`update_time` null, string, ISO, milliseconds, 0, negative, 1e20, update before create, rewritten-by-migration pattern (both equal day before export, old chats) | Normalised tolerantly; implausible values null + warning; derive `first_message_at` separately | CO (S9), ADV, LOC |
| EC-36 | `mapping` null, `{}`, array, string | Conversation kept with zero messages + warning; never aborts | UNC (S11), ADV |
| EC-37 | `current_node` null, absent, empty string, dangling, pointing to the root, pointing to a mid-tree node | `ACTIVE_BRANCH_UNKNOWN` / `INVALID_CURRENT_NODE` / `CURRENT_NODE_NOT_LEAF`; never guess without opt-in | CO (S14, S15, S20), ADV |
| EC-38 | Conversation-level fields dropped or added (2026-06 bulk trimming; unknown new keys such as `atlas_mode_enabled`) | Unknown keys retained in raw; missing keys never error | CO |
| EC-39 | "Branch in new chat" conversation: copies parent message ids, only `branching_from_conversation_title` | No parent linking by id; message ids scoped per conversation; no false dedupe | CO x1 |

### 11.4 Tree level

| ID | Case | Expected behaviour | Basis |
|---|---|---|---|
| EC-40 | **Cycle** reachable from a root; **cycle with no root**; self-parent | `CYCLE_DETECTED`, nodes listed unreachable, import continues, no infinite loop | CO (S14, S26), ADV |
| EC-41 | **Missing parent** (dangling `parent`) | Node becomes a root, `MISSING_PARENT` | ADV (GCR) |
| EC-42 | **`children` lists an id that does not exist** | Ignore the phantom edge, `CHILD_NOT_FOUND`, keep the rest | CO (S8 failure modes), ADV |
| EC-43 | `children` entry whose node names a different `parent`; node listed under two parents | `CHILD_PARENT_MISMATCH`; parent field wins | ADV |
| EC-44 | `children` absent on every node (2026 trimmed export) | Derive edges; **one** `CHILDREN_ABSENT` warning per conversation, not one per node | CO x2 (S3, S9) |
| EC-45 | `children` present but empty on non-leaf nodes while children point back via `parent` | Derive and warn once | ADV |
| EC-46 | Multiple roots; root with a message; no root at all | All handled by "parent null/missing/dangling = root"; root with message imports normally | ADV |
| EC-47 | Node key differs from `node.id`; `message.id` differs from node id; duplicate `message.id` in different nodes | Key is identity; mismatches recorded; duplicates warned | ADV |
| EC-48 | Deep chain of 20,000+ nodes; fan-out of 10,000 children on one node | Iterative traversal, linear time, bounded memory | CO (S21 tests 20,000- and 100,000-deep chains) |
| EC-49 | Active branch not the last child; abandoned branch with `in_progress`/`interrupted`; edited user message siblings | Branch list deterministic; active selection from `current_node` only | CO (S14) |

### 11.5 Message and content level

| ID | Case | Expected behaviour | Basis |
|---|---|---|---|
| EC-50 | Node with `message: null` in the middle of a chain | Skipped in text rendering but kept as a structural node; chain continues through it | CO (S15) |
| EC-51 | `content` null/absent/not an object; `content_type` absent; `parts` null/absent/non-array/empty | Message kept with zero text blocks + warning | CO (S4), ADV |
| EC-52 | **`parts` containing objects, numbers, booleans, null, nested arrays** | Typed blocks, never coerced with `String()`; raw retained; no `[object Object]` in text | CO, ADV |
| EC-53 | Unknown `content_type` (e.g. `future_widget_v9`); known type with unexpected shape (`thoughts` as string, `code` with no `text`) | `unknown` block + `UNKNOWN_CONTENT_TYPE` / shape warning; raw kept | CO (S7 vs S2), ADV |
| EC-54 | Roles/statuses/channels/recipients never seen before | Stored verbatim; no CHECK constraints | CO |
| EC-55 | Hidden/system/tool/context/thoughts/commentary messages | Imported with `hidden` attributes; excluded from default search and render; opt-in flag | CO (S8) |
| EC-56 | Custom-instruction and memory blocks repeated in every conversation | Deduplicated for reporting only; never logged; marked sensitive | CO (S24) |
| EC-57 | `metadata` null/array/string; `metadata.model_slug` absent, changing mid-conversation, or equal to `default_model_slug` | `model_slug` stays null when unstated; no inference | CO, SPEC FR-16 |
| EC-58 | Citation markers with private-use delimiters; `citations`/`content_references` indices out of range, inverted, fractional, overlapping, tens of thousands in one message | Never crash; keep raw; any rendering is bounded and clamps like S21 | CO (S21), ADV |
| EC-59 | Attachments: camelCase vs snake_case keys; attachment id with no file in the package; filename containing `../`, markup or prompt-injection text; `.dat` with wrong or unknown magic bytes | Metadata stored escaped; pointers never dereferenced; `ASSET_NOT_IN_EXPORT` accounting; type sniff display-only | CO (S6, S9), ADV |
| EC-60 | Prompt-injection text inside message bodies, titles, tool output | Treated as data; MCP responses flag `untrustedContent`; tests assert it is never interpreted | ADV (SPEC section 7) |
| EC-61 | HTML, `<script>`, FTS5 operators (`"`, `*`, `NEAR(`, `AND`, `-`), SQL metacharacters inside any string | Output escaping and prepared statements; malformed FTS query returns `FTS_SYNTAX_ERROR`, never a crash | ADV (SPEC) |
| EC-62 | Legacy flat `role` on a message instead of `author.role` | Fallback read; flagged `LEGACY_ROLE_FIELD` | UNC (S22) |
| EC-63 | Empty export (no conversations), conversations with zero messages, export with only `{}` | Clean zero-count report; non-zero exit only with `--strict` | CO (S14), ADV |

(63 cases; the 20+ required are met many times over. The adversarial subset explicitly requested in the task maps to EC-21 duplicate keys, EC-40 cycles, EC-41 missing parents, EC-42 phantom children, EC-52 object parts, EC-25 huge numbers, EC-28 lone surrogates, EC-29 NUL bytes, EC-31 50 MB message.)

## 12. Recommended minimal SYNTHETIC fixture set

Rules (apply to all): synthetic only; no text copied from any real export or from the sources above; UUIDs of the form `00000000-0000-4000-8000-0000000000NN`; placeholder text such as "synthetic user turn 1"; domains `example.invalid`; fake PII in `user.json` (`synthetic-user@example.invalid`); every fixture file gets a header comment in its sibling `README` or in a `_fixture` note in the test (JSON itself cannot carry comments, and adding unknown top-level keys would change shape). Large cases are **generated at test time** by helpers (`test/helpers/zip-builder.ts`, `test/helpers/synthetic.ts`), not committed. All are `synthetic-only` in the parity matrix; none proves compatibility with a live export.

### 12.1 Committed JSON fixtures (`fixtures/chatgpt/`), P0 first

| ID | File | Purpose |
|---|---|---|
| F01 | `minimal-linear.json` | Baseline: bare array, one conversation, literal `client-created-root` (message null) then user then assistant; all core conversation and message keys; floats with microseconds; `conversation_id == id`; valid `current_node`. Round-trip of raw plus normalized. |
| F02 | `branching.json` | One regenerated assistant reply (two children) and one edited user turn (two subtrees); `current_node` deliberately **not** the last child; abandoned branch has `status: in_progress` + `finish_details.type: interrupted` and `weight: 0`. Proves active-branch selection and branch enumeration differ from "last child". |
| F03 | `trimmed-2026.json` | Same graph as F02 but the 2026-07/10 shape: **no `children`**, no system/tool nodes, no `recipient`, `channel`, `status` or `weight`, root id an ordinary UUID. Proves parent-derived edges and one `CHILDREN_ABSENT` warning. |
| F04 | `content-types.json` | One message per named `content_type` (all 16 in 6.5; for `tether_browsing_code` and `app_pairing_content` use a minimal invented shape and say so in the test) with the field names from 6.5, including `thoughts` as array **and** as JSON string, `code` with `language: "unknown"`, `tether_quote` with `file-id`-style url, `user_editable_context` with real data only in `metadata.user_context_message_data`, plus `future_widget_v9` as the unknown type; roles user/assistant/system/tool; recipients `python`, `web.run`, `canmore.create_textdoc`; channels final/commentary/analysis; hidden flags. Proves typed blocks, unknown preservation, default-search exclusions. |
| F05 | `multimodal-parts.json` | `multimodal_text` with strings plus `image_asset_pointer` (`sediment://file_00000000000000000000000000000001`, `file-service://file-SYNTHETIC1`, suffix form `...#file_...#p_2.jpg`), `audio_transcription`, `audio_asset_pointer`, `real_time_user_audio_video_asset_pointer`, a `search_result_group` keyed by `type`, and a bare object with no `content_type`. Proves object parts never stringify as `[object Object]`. |
| F06 | `nulls-and-wrappers.json` | Array containing: a good conversation; `{}`; `null`; `42`; a conversation with `title: null`, `mapping: null`; one with `mapping: {}`; one with `current_node: null`; one with message `content: null`, `parts: null`, `metadata: null`, `author` lacking `name`. Proves per-element isolation and counted warnings. (A second file `wrapper-object.json` is `{"conversations":[...F01...]}`.) |
| F07 | `broken-trees.json` | Separate conversations for: 2-cycle with no root; cycle reachable from a root; self-parent; dangling `parent`; `children` naming a missing id; node claimed by two parents; `current_node` dangling; `current_node` on a mid-tree node; two roots; node key different from `node.id`; `message.id` different from node id. Each expects a specific code from section 11.4 and **continued import**. |
| F08 | `duplicate-keys.json` (raw text, hand-written) | Duplicate node ids in `mapping` with different bodies; duplicate `content_type`; node ids `__proto__`, `constructor`, `"10"`, `"9"`, `"2"`. Proves tokenization-time duplicate detection, `Map` usage and file-order preservation. |
| F09 | `hostile-strings.json` | Lone surrogate escapes, `\u0000` in text/title/id/attachment name, U+2028/2029, U+202E, ZWJ emoji, astral characters, U+E200-E203 citation markers, 100 KB token with no whitespace, `<script>`, FTS5 operators, SQL metacharacters, `../../x` attachment names, prompt-injection sentences labelled as test data. Proves sanitization, escaping, FTS safety and log hygiene. |
| F10 | `numbers-and-time.json` (raw text) | Timestamps as integer, float with 9 fractional digits, millisecond-scale, `0`, negative, `1e20`, `1e999`, numeric string, ISO string, boolean, null; `weight` 1e308 and `0.0`; `size_bytes` 9007199254740993; `-0`. Proves tolerant time/number handling and raw preservation. |
| F11 | `attachments-citations.json` | `metadata.attachments[]` in snake_case and camelCase forms, duplicate attachment ids across messages, id with no matching package file; legacy `citations[]` and `content_references[]` (`grouped_webpages`, `sources_footnote`, `file` with `input_pointer`), inverted/out-of-range/fractional indices. Used with Z02 for asset accounting. |
| F12 | `identity-collisions.json` | Same `conversation_id` appearing twice with different content; same message ids reused in two different conversations (branch-copy case) plus `branching_from_conversation_title`; `id` different from `conversation_id`; uppercase UUID. Proves deterministic conflict rule and per-conversation message-id scope. |

### 12.2 ZIP/layout fixtures (built in memory at test time by `zip-builder`)

| ID | Layout | Purpose |
|---|---|---|
| Z01 | Flat: `conversations.json`, `chat.html`, `user.json` (fake PII), `message_feedback.json`, `shared_conversations.json`, `model_comparisons.json` | Happy-path single-file import; proves auxiliary files are not ingested by default and `user.json` content never reaches DB or logs |
| Z02 | Sharded `conversations-000..002.json` + `export_manifest.json` (`version 1`, `export_files_count`, `export_files[{path,size_bytes}]`, `logical_files["conversations.json"]{files,sharded:true}`) + `file-SYNTHETIC1.dat` + `conversation_asset_file_names.json` + `library_files.json` | Shard order, manifest reconciliation, asset index, `.dat` handling |
| Z03 | Sharded with no manifest; sharded with manifest that lies (missing shard, wrong counts, malformed JSON, `..` path, unknown version); shard names `-9`, `-10`, `-999`, `-1000` | Fallback, warnings vs errors, numeric sort |
| Z04 | Nested: outer ZIP containing `Conversations__SYNTHETIC-part-001.zip` and `Files__SYNTHETIC-files-001.zip`; `<export-name>/` prefix; `__MACOSX/` junk; case-variant names; also a doubly-nested archive | Nested-archive policy and shared budget |
| Z05 | Both `conversations.json` and `conversations-000.json` with overlapping ids | Duplicate-conversation rule |
| Z06 | Hostile ZIPs: traversal, absolute, drive letter, backslash, NUL name, symlink, encrypted, duplicate names, CRC mismatch, overlapping offsets, bomb ratio, huge entry count, "non-ZIP64 with wrapped offsets" header-only simulation | Container safety codes (extends existing GCR ZIP tests) |
| Z07 | Extracted directory form of Z02 plus a symlink escaping the directory | Directory reader never follows symlinks |

### 12.3 Generated-at-test-time stress inputs (never committed)

| ID | Input | Purpose |
|---|---|---|
| G01 | Chain of 20,000 and 100,000 nodes; fan-out of 10,000 children | Iterative traversal, no recursion limits |
| G02 | One conversation with a single 50 MiB string part; one with escapes (`é` x 25M); one element over `maxElementBytes` | Size limits, bounded memory, output truncation |
| G03 | `metadata` nested 100,000 deep | Depth cap, no stack overflow |
| G04 | 50,000 synthetic messages across 500 conversations in 5 shards | NFR-05 performance baseline |
| G05 | 1,000 shards (`-000`..`-999`) and 1,001 (`-1000`) | Shard scaling and numeric sort |
| G06 | `fast-check` generator of random trees (cycles, dangling parents, absent `children`, duplicate ids) with fixed seeds | Property: importer never throws, never loops, idempotent re-import yields identical counts and hashes |
| G07 | Truncation fuzz: every prefix length of F01 and F04 | No crash; precise error offsets; partial-element isolation |

Minimal P0 subset if time is short: F01, F02, F03, F04, F06, F07, F08, F09, Z01, Z02, Z04, Z06, G01, G02, G06.

## 13. Gaps in the current GCR architecture implied by this research (documentation read only; no code reviewed or edited)

Read-only observations from `<gcr-checkout>/docs/ARCHITECTURE.md` (sections 4 and 5) and `src/ingest/limits.ts`:

1. **Duplicate node ids "can't occur within one record set (the adapter dedups with DUPLICATE_NODE_ID)".** If the adapter receives objects produced by `JSON.parse`, duplicate keys in `mapping` have already collapsed (VERIFIED-LOCAL). Detection must happen in the tokenizer or in a raw-text pre-pass over `"mapping"` (EC-21).
2. **`CHILD_PARENT_MISMATCH`** would fire for every node of a children-less export. Distinguish "absent" from "inconsistent" (EC-44).
3. **`json-stream.ts` "single top-level object (wrapped as one element)".** An object `{"conversations": [...]}` would be wrongly treated as one conversation (EC-16).
4. **Nested ZIP entries** are not mentioned; "only entries whose names are needed are inflated" does not cover `Conversations__*.zip` (EC-08, EC-14).
5. **Shard ordering** and manifest reconciliation are not specified; ordering must be numeric (EC-04).
6. **Lone surrogates:** NUL stripping is specified, lone-surrogate replacement is not (EC-28).
7. **`thoughts` as a JSON string** and `parts: null` are not covered by "explicit types" wording (EC-52, EC-53).
8. **Timestamp window**: "invalid/NaN/0/absurd => null" is right; add millisecond-scale detection and the conversation-level rewritten-time pattern (EC-35).
9. **`audit`/`stats`** should print the observed format profile (section 9, step 23) because by-role counts differ by export vintage.
10. The ZIP64 stance ("rejects ZIP64 beyond limits") is fine, but the reported non-ZIP64 wrapped-offset archives (EC-12) need a clear error and remedy, not a generic parse error.

## 14. What only a live export can settle (cannot be done here)

1. Full member list and sizes of today's ZIP, and whether nesting is the default for each route (Settings vs Privacy Portal).
2. Whether `children` is absent in all current exports or only some accounts/regions/dates; whether `current_node` is always present.
3. Exact `export_manifest.json` contents and whether `sharded` is ever true with one file.
4. The census of `content_type`, `metadata` keys, `author.name`, `recipient` and `channel` for a current export.
5. How `attachments[].id`, `asset_pointer` values and package file names line up for current exports, and the share of missing assets.
6. Timestamp forms in auxiliary files and any timezone or string forms.
7. Duplicate message ids across conversations, invalid UTF-8, lone surrogates and NUL bytes in real strings.
8. Shapes of `model_comparisons.json`, `shared_conversations.json`, `message_feedback.json`, `textdocs/*.json`.

Each of these is a candidate row for the parity matrix with status `blocked by platform` (needs a real export from a consenting user) rather than `supported`.

## 15. Sources

All accessed 2026-10-10 unless another date is shown. "Pinned" means read at that commit SHA through `raw.githubusercontent.com` (WebFetch, summarized) unless marked "code-search fragment (verbatim)".

| ID | Source | Notes |
|---|---|---|
| S1 | OpenAI Help Center, article 7260999, https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data | **Direct fetch blocked by egress policy**; content from two WebSearch summaries of the article |
| S2 | mohamed-chs/convoviz `docs/dev/chatgpt-spec.md` (community spec v3.0, 2026-02-05), pinned `6c22e7398bdceb16c34c974512fc460f7bf642c6`, https://github.com/mohamed-chs/convoviz/blob/6c22e7398bdceb16c34c974512fc460f7bf642c6/docs/dev/chatgpt-spec.md | Self-described as unofficial, reverse-engineered, possibly lagging; also `convoviz/message_logic.py` pointer-prefix handling (code-search fragment, verbatim) |
| S3 | convoviz issue #70, "New ChatGPT export format (2026-10)...", filed 2026-10-07, https://github.com/mohamed-chs/convoviz/issues/70 | Page fetched; no comments or maintainer replies present |
| S4 | slyubarskiy/chatgpt-conversation-extractor `docs/SCHEMA_NOTES.md`, `docs/TECHNICAL_REFERENCE.md`, `docs/QUICK_REFERENCE.md`, pinned `579f795e290e1e4b4da4e37b009d29256914fbdb` | Documents the 2026-06 bulk-export change and 92-shard layout |
| S5 | Superkikim/nexus-ai-chat-importer `docs/architecture/providers/chatgpt-export-format.md` and `CLAUDE.md`, pinned `f2cef57296a106e416cb724a953a72ee74d1cbdd` | States OpenAI does not document the format publicly |
| S6 | matt-goldman/MattGPT `docs/TechnicalReference/export-analysis.md` and `export-analysis-raw.md`, pinned `27d688abe46f344407df9fffeed667ed040a7cf7` | Empirical census, analysis dated 2026-02-27; the note itself has conflicting counts (798 vs 984; 601 vs 602) |
| S7 | eamonma/chatgpt-etl `spec.md`, pinned `c7f9a730ba8a4bcd0f9f73e43b8f059ab2f5b9bd` | 656 of ~1,171 conversations; provenance (ZIP vs API) unstated; its `ExportManifest` is the tool's own, not OpenAI's |
| S8 | klb-t/chatadhd `docs/exports/OPENAI_ANTHROPIC_EXPORT_FORMATS.md`, pinned `209f261130a635836b4675897e1717bdb44e14fb` | Evidence-graded compilation (V/D/I/U), retrieved 2026-09-29; says no real export examined; a compilation, not an independent observer |
| S9 | ZhenHuangLab/inkstone `PLAN.md` and `cli/export.ts`, pinned `593e9412ceae44ce4c1bbf87fcdd5bc7e3b704b2` | 2026-07-10 test on 432 conversations; the `children`-absent comment is a verbatim code-search fragment |
| S10 | temnoon/openai_export_parser README, https://github.com/temnoon/openai_export_parser | Era table (pre-2024, 2024-2025, 2026), ZIP-in-ZIP, >4 GiB non-ZIP64 |
| S11 | Systina12/ChatGPT-Wrapped `docs/export-data-schema.md`, pinned `02977878b63d7d0a527d59f169bbc85bae5f57c3` | Self-described as general and unverified |
| S12 | difegam/chatgpt-to-markdown `docs/explanation/export-format.md`, pinned `db7993eee7c773c2df41a90dfc353e740d12b57c` | Auxiliary file shapes |
| S13 | ThierryAbalea/chatgpt-conversation-export `docs/format.md`, pinned `543a98a3f6cfb0f59ad23cd1c0b6d070f4e98324` | Written around the live API; shapes overlap with the export; used with care |
| S14 | symphonic-navigator/chatsune `devdocs/specs/2026-05-11-chatgpt-import-design.md`, pinned `5cf746087823c3cfa51e12fdb03216aec6487e33` | Import skip reasons, cycle guard, 105 MB real export mentioned |
| S15 | danielrosehill/Claude-ChatGPT-Importer-Plugin `references/chatgpt-conversation-format.md`, pinned `eb6dfcca240871255eed072e7e7e3a51a939d637` | Mixes API and export; one 35-node specimen |
| S16 | sanand0/chatgpt-to-markdown `chatgpt-to-markdown-cli.js`, pinned `e5b620e398767021548851229e3559dff421c068` | Reads `manifest.logical_files["conversations.json"].files` (verbatim fragment) |
| S17 | RainPPR/ai-math-chat-studio `shared/chatgpt-export.ts`, pinned `88dc1bfe505db233bacf35e707c8c616da24106d` | **Generator of synthetic manifests**, not evidence of the real file |
| S18 | max-ng/datamoat `src/chatgpt-export.ts`, pinned `1f3caa91080b8ca9370e0f99173a025feb8a999e` | Manifest tolerance, file patterns, safe-path rules |
| S19 | hotmeme/Psyche `psyche/ingest/chatgpt_export.py`, pinned `fbd7a898a0992e94c71dfea049a7e78a102fe27b` | Manifest/shard/wrapper handling |
| S20 | aslafy-z/deja-web `docs/spike/S0-T10-export-formats-naming-upstream.md`, pinned `1640ee881dc9173b120b626269596fba43e5ebec` | Evidence-labelled spike; says it read OpenAI's article through a mirror (not reproduced here) |
| S21 | LibreChat-AI/LibreChat `packages/api/src/conversations/chatgpt.spec.ts`, pinned `e1dfc10449ff713faffacd60273fddcfe2c0a698` | Test names only (cycles, 20,000- and 100,000-deep chains, citation edge cases) |
| S22 | 0xdevalias gist (backend API, early 2023), https://gist.github.com/0xdevalias/4e54bb28a02db5357ea4fa3a872fc5fc | API, not export; earliest shape |
| S23 | mirableio/chat-history `plans/MULTIMODAL.md`, pinned `a57dc5829b1fed0d120f82b3e4fb0389f699fb15` | Multimodal part census and asset naming |
| S24 | letta-ai/skills `importing-chatgpt-memory` (`SKILL.md`, `references/chatgpt-export-notes.md`), pinned `6785511e7d3913d9ec598435a77ae637cd45fc89` | Memory-bearing fields, sensitive files |
| S25 | darrellwhitelaw/chatgpt-to-claude `.planning/research/FEATURES.md`, pinned `e47553523376a78c32ec218a9d580fe8a2a64891` | Low-quality, partly unverified claims; used only where marked UNC |
| S26 | GitHub code-search fragments (verbatim), queries run via the GitHub MCP `search_code` tool: `"client-created-root"` (yetanotherchris/openwebui-importer `convert_chatgpt.py`, newo-ether/Agora `GptChatImporter.kt`, v5ma/selfawarenetworks), `tether_browsing_display`/`reasoning_recap`/`user_editable_context` (OB1, seCall, AGiXT, echomine, others), `finish_details` samples, `conversation_asset_file_names.json`, `sediment://`, cycle-guard parsers (fukami/minitrace, KitchenSoup), `export_manifest.json` consumers, ClaudeTool `scripts/chatgpt-shape-report.mjs` (via WebFetch) | Used for existence and naming, not for long-form claims |
| S27 | WebSearch summaries (not fetched pages): ai-chat-importer.com guides, takeoutday.org, chatgptexporter.com, OpenAI community thread 403144 ("Decoding Exported Data by Parsing conversations.json and/or chat.html"), urls: https://ai-chat-importer.com/guides/chatgpt-export-format-explained, https://community.openai.com/t/decoding-exported-data-by-parsing-conversations-json-and-or-chat-html/403144, https://takeoutday.org/guides/export-chatgpt-conversations | Fetch of these hosts failed; weakest evidence class |
| S28 | martinfrancois/chatgpt-extract-markdown `extract_chatgpt_markdown.py` (`KNOWN_MESSAGE_CHANNELS = {"analysis","commentary","final"}`, verbatim code-search fragment) | |
| S29 | kenn-io/agentsview `internal/parser/chatgpt.go` (comment: numbered shards `conversations-000.json` or a single file; verbatim fragment) | |

Search queries and the failed fetches are recorded in the scratchpad session only; no real data was handled at any point.
