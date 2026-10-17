# Chat content coverage — 0.3.0

The HTML archive is a snapshot of a selected rendered branch. Preserving its 39 turns does **not** establish that every current response, original Markdown block, attachment byte, or tool call was exported.

## Run the actual content audit

```sh
node content-cli.ts --archive /absolute/path/EMBLEM_Chat_Archive.html --out /absolute/path/new-audit
```

Node 24+ runs the TypeScript SDK. Python 3's standard `html.parser` handles HTML/entity boundaries without running scripts. No Python third-party packages, network access, or browser binaries are needed for this command.

The command writes a per-turn JSON ledger, a Markdown report, and a public tool-event JSONL file. Exit **0** means the supplied verified source inventory is complete; **2** means the audit ran but source coverage is incomplete; **1** means input or execution failed. The HTML adapter deliberately leaves source and tool inventory verification false because a rendered archive cannot independently establish account-export completeness.

## Separate evidence categories

| Category | Preservation check | What it cannot prove |
|---|---|---|
| Sanitized response HTML | Source and display hashes retained per role | Original Markdown or every server-side branch |
| Multiline code | Exact decoded text, whitespace, language, order, and count | That uncaptured source blocks never existed |
| Inline code | Separate inventory and exact hashes | That a filename is a multiline code response |
| Activity summaries | Publicly displayed text and source observation time | Tool arguments, output, execution timestamps, or call counts |
| Tool events | Known turn, explicit tool name, exact input/output, error/status, ordinal, provenance | Calls absent from the supplied log |
| File references | Retained archive record and filename | Original file bytes or source code inside a linked ZIP |

The reader's own JavaScript is excluded from response-code counts. No transcript text is synthesized to fill missing code, tool calls, or assistant replies. Hidden internal reasoning is not an ingestion source.

## Add an explicitly supplied public tool log

```sh
node content-cli.ts --archive /absolute/path/archive.html --tool-events /absolute/path/public-tool-events.jsonl --out /absolute/path/new-audit
```

`ToolEvent` is exported by `content-audit.ts`. Each JSONL line must have an observation ID, conversation, actual turn ID, ordinal, tool name, exact string-or-null input/output/error, public provenance and completeness flags. The original call ID may be null. Empty observed output `""` is distinct from missing output `null`. Duplicate observation IDs, duplicate ordinals, unknown turns, hidden sources, or incomplete payloads labeled complete are rejected. Importing a partial log never upgrades the source inventory to complete.

## Browser-host collection

`captureVisibleContent(page, inspectedSelectors)` reads only the current visible conversation region through an already authorized host page. It records code hashes, public expansion state, and explicitly selected visible tool fields. It does not expand controls, navigate, discover authentication, call private endpoints, access hidden application state, or launch a browser. The host must inspect and supply any tool-field selectors. Missing or ambiguous fields stay null.

Full-scroll capture now writes `00000.content.json` beside each screenshot. The content observation is bound to the frame index and screenshot hash. A scroll report remains a visual review; it never approves source completeness on the basis of turn count.

## Current delivery evidence

The real archive audit and the observed source-panel evidence are in `../evidence/content-coverage/`. The observed activity panel exposed progress summaries without tool inputs or outputs. Browser rendering of the local candidate is still blocked by the established environment policy. No server, alternate browser, transport change, hidden state, or private endpoint was used to bypass that restriction.

The regression tests use clearly named synthetic fixture messages. They check code loss, whitespace corruption, entity decoding, inline/block separation, missing payloads, guessed turn ownership, hidden sources and duplicate calls. They are not evidence of a browser render or a complete live transcript.
# Public activity recovery — 0.3.1

`node import-activity.ts ARCHIVE.html observations.json NEW_OUTPUT.html` imports
explicitly observed public progress summaries into both embedded JSON and native
HTML details. Duplicate observations, unknown turn owners, invalid provenance,
and alleged tool payloads are rejected. Source reply HTML is not changed, and
progress text never increases the final-reply or raw-tool-record counts.

The October 16 recovery found two more activity panels (three total). Rechecking
Mountain's final turn and Street turn 11 showed no final reply in their visible
source turns. Street turn 16 exposed progress messages, not a final reply. These
are limited UI observations, not proof about alternate branches or server data.
Street also has newer turns outside this archive and an interrupted active
response. The archive remains incomplete; do not present it as a current export.

