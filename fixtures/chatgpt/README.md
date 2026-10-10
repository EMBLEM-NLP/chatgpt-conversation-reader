# Synthetic ChatGPT export fixtures

**Everything in this directory is invented.** No file here comes from, or was derived from, a real ChatGPT export, a real
account or a real conversation. Ids look like `00000000-0000-4000-8000-0000000000NN`, hosts are `example.invalid`, and every
text is placeholder prose ("synthetic user turn 1"). Each JSON file carries the literal marker `GCR-SYNTHETIC-FIXTURE` (in
one or more conversation titles) because the repository's privacy scanner refuses committed JSON without it. JSON cannot
hold comments, so this README is the place that explains each file.

**What these fixtures prove, and what they do not.** They exercise the importer on data *shaped like* what community
projects report about the export format (see `docs/IMPORT_FORMAT.md`, evidence labels). OpenAI publishes no schema, and no
live export could be verified, so passing these fixtures is **synthetic-only evidence**. It says nothing about whether a
current real export imports correctly.

**How they are made.** The definitions live in code: `test/ingest/chatgpt-export.fixtures.test.ts` builds each file with
`test/helpers/chatgpt-export-builder.ts`, and the test fails if a committed file differs from its definition. To rewrite
the files after changing a definition, run that test once with `GCR_REGEN_FIXTURES=1` and review the diff. Files that
contain duplicate object keys, `__proto__` or exotic number spellings are plain JSON *text* (pretty-printed by the
builder's ordered serializer), which `JSON.stringify` could not have produced.

Each `.json` file is a top-level JSON array, one conversation object per element, like a real `conversations.json`, except
`wrapper-object.json`.

| File | ID | What it demonstrates |
|---|---|---|
| `minimal-linear.json` | F01 | Baseline: literal `client-created-root` (message `null`), one user and one assistant turn, all core conversation keys, floating-point times with microseconds, `conversation_id == id`, a valid `current_node`. Normalizes to a full tree (`exported_tree`) with no warnings. |
| `branching.json` | F02 | One regenerated assistant reply (two children of the first user turn) and one edited user turn (two subtrees under the root). `current_node` is **not** the last child: the abandoned regeneration is the last child of its parent and carries `status: in_progress`, `weight: 0` and `finish_details.type: interrupted`. Proves that the active branch comes from `current_node`, not from "last child". |
| `trimmed-2026.json` | F03 | The same graph in the reported 2026 shape: **no `children` on any node**, no `recipient`/`channel`/`status`/`weight`, no system or tool nodes, an ordinary UUID as root, fewer conversation keys. Proves that edges are derived from `parent` and that exactly one `CHILDREN_ABSENT` warning is produced. |
| `content-types.json` | F04 | One message for each of the 16 named `content_type` values (two of them, `tether_browsing_code` and `app_pairing_content`, use a **minimal invented shape** because the real field sets are unknown), `thoughts` as an array and as a JSON string, custom instructions whose real values exist only in `metadata.user_context_message_data`, roles user/assistant/system/tool, recipients `python`, `web.run`, `canmore.create_textdoc`, channels `final`/`commentary`/`analysis`, a visually hidden message, one unknown type (`future_widget_v9`), and a message carrying only a `default_model_slug` (the model must stay unknown). |
| `multimodal-parts.json` | F05 | `multimodal_text` with strings plus `image_asset_pointer` in the three pointer spellings (`sediment://file_...`, `file-service://file-...`, the `#file_...#p_2.jpg` suffix form), `audio_transcription`, `audio_asset_pointer`, a real-time audio/video part, a video container, a `search_result_group` keyed by `type`, an unrecognised object, and numbers/booleans/null/nested arrays as parts. Proves typed blocks and that object parts never become `[object Object]`. |
| `nulls-and-wrappers.json` | F06 | An array holding a good conversation next to `{}`, `null`, `42`, a string, an array, a conversation with `title: null` and `mapping: null`, one with `mapping: {}`, one with `current_node: null`, and one whose messages have `content: null`, `parts: null`, `metadata: null`, a nameless author and no `content_type`. Proves per-element isolation. |
| `wrapper-object.json` | F06b | `{"conversations": [ ... ]}`. The adapter reports it as *not a conversation*; unwrapping it is the import runner's job. |
| `broken-trees.json` | F07 | Eleven tiny conversations, one structural defect each: a cycle with no root, a cycle declared from a root, a self-parent, a dangling parent, `children` naming a missing id, a node claimed by two parents, a dangling `current_node`, a `current_node` on a mid-tree node, two roots, a node key that differs from `node.id`, and `message.id` values that differ from the node id (and repeat). Every one imports; each is reported with the right code. |
| `duplicate-keys.json` | F08 | Raw text with a **duplicated node id** in `mapping` (different bodies), a **duplicated `content_type`**, node ids `__proto__`, `constructor`, `"10"`, `"9"`, `"2"` in that file order, and a message whose *text* merely looks like duplicate keys (it must not trigger anything). Proves duplicate detection on the raw text, `Map`-safe ids and file-order ordinals. |
| `hostile-strings.json` | F09 | Lone surrogate escapes, `\u0000` in text, title and node ids, U+2028/U+2029, U+202E, a ZWJ emoji family, astral characters, U+E200..E203 citation delimiters, `<script>`, FTS5 operators, SQL metacharacters, `../../x` and markup attachment names, a node id containing a newline, and an instruction-like sentence explicitly labelled as test data. Proves sanitation and that such text is only ever data. |
| `numbers-and-time.json` | F10 | Raw text with timestamps as integer, float with 9 fractional digits, milliseconds, `0`, negative, `1e20`, `1e999`, `-0`, numeric string, ISO strings with and without a zone, boolean and `null`, plus `weight` `0.0` and `1e308` and a `size` of 9007199254740993. Proves tolerant time and number handling and that no time is invented. |
| `attachments-citations.json` | F11 | `metadata.attachments[]` in snake_case and camelCase, a token-count size field (not bytes), a non-object entry, the same file attached twice, an attachment id with no file in the package, an image pointer for an already-attached file, and legacy `citations` / `content_references` with inverted, fractional and out-of-range indices. Used with a set of "available asset names" in the tests to check `presentInExportAs`. |
| `identity-collisions.json` | F12 | The same `conversation_id` in two elements with different content, message ids reused across conversations (a "branch in new chat" with `branching_from_conversation_title`), `id` different from `conversation_id`, and an upper-case UUID. |

The ZIP-level fixtures (Z01..Z07), generated stress inputs (G01..G07), and the remaining census-style cases of the format
notes belong to the ZIP, JSON-stream and import-runner modules; large inputs used by the adapter tests (50,000 messages,
fan-out of 10,000 children, 100,000-node chains, 50 MB messages, 200,000-level nesting) are generated at test time and never
committed.
