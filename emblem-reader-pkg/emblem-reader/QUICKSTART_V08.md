# Conversation reader 0.8.0

This is an executable source toolkit, not a bundled browser or Node runtime. Requires Node 24+. The import/query/generation commands use Node built-ins. Legacy visual tools require the pinned npm dependencies; Python recovery tools also require Python and lxml. Browser capture must run in an independently authorized host. No cookies, passwords or authentication profiles are included.

## Start with a chat URL

`node reader.ts run "https://chatgpt.com/c/CONVERSATION_UUID" ./new-job`

Creates a capture job and exits 2 with CAPTURE_REQUIRED. It does not send a prompt, create a new ChatGPT conversation, log in, or fetch history. Existing jobs are not overwritten.

## Generate from an authorized captured conversation

`node reader.ts run "https://chatgpt.com/c/CONVERSATION_UUID" ./new-job ./conversation.json ./assets main`

The input must use emblem.conversation/2. The output contains the exact original JSON bytes, a derived graph, selected branch projection, evidence session, HTML reader and build report. This is a generic reader, not verified ChatGPT GUI parity. A missing asset is reported by the build; generation alone is not release approval.

## Exact queries

`node reader.ts query ./conversation.json "search text" all`

Kinds: all, text, code, tool. Search is case-sensitive and literal. Results identify event IDs, source fields, offsets and exact text. Graph projection currently includes event ancestry and branch heads; it is not a full asset/tool-call graph or GraphRAG engine.

## Data contract

Events have stable IDs, parentId (null at a root), role user/assistant/tool and typed blocks. Each branch records an ID, display label and leaf event ID. Tool records preserve callId, name, exact input string and exact output string or null when absent. Activity blocks contain public visible summaries only. Hidden internal reasoning is neither captured nor generated.

Attachments reference asset IDs with relative path, MIME and SHA-256. Missing references, duplicate IDs, missing ancestors and cycles reject validation. Source completeness remains caller asserted; no validation of JSON proves an entire live account was captured. Branches are selected by CLI in this release; the generated reader does not yet have a branch-switch dropdown.

## Remaining work

Automatic authenticated live-chat capture; provider adapters; resumable capture; edit/version identities beyond branch ancestry; cross-conversation search; tool result linkage validation; independent source inventory verification; browser interaction/download testing; rendered full-scroll parity. Cypher and semantic indexes are optional future projections, not substitutes for original data.

Run `npm test` for the TypeScript suite. Run `python3 -m unittest discover -p test_recover_image_catalogue.py` for recovery regressions. The six v0.8 tests use synthetic fixtures, and do not establish live capture success.
