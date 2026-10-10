# Codex implementation task — GCR production hardening and CCR parity

## Mission

Build and maintain EMBLEM-NLP's provider-aware conversation intelligence tooling. Product name: **EMBLEM-NLP ChatGPT Conversation Reader & Writer (GCR)**. Use existing TypeScript v0.1.1 as baseline. Produce a secure, reproducible, testable ChatGPT import, local search, branch exploration, knowledge graph and MCP interface, and later an interoperable connection to CCR. The output must be a **real executable repo**, not a design-only scaffold.

Source repo under analysis: `EMBLEM-NLP/claude-conversation-reader-public`; proposed GCR repo `EMBLEM-NLP/chatgpt-conversation-reader`. Compare against the source repo's actual tree and published feature list, but do not merge provider-specific authentication or undocumented clients. Keep all source attribution/license requirements.

### Phase 0 — reproduce, inventory, document

- Check repository working tree, tools, Node runtime, package and test commands. Record exact commit SHAs, environment and failures.
- Run `npm test`, `node scripts/ci-smoke.mjs`, `npm run typecheck`, `npm run build`, and, where Chromium exists, `npm run test:browser`; do not invent pass results.
- Clone/read CCR on a networked development host; inventory exact commands, database tables, MCP tools, knowledge-graph components, auth and importers. Compare existing GCR's current implementation; update `docs/PARITY_MATRIX.md` with links to relevant source paths.
- Verify repository LICENSE terms of both codebases; do not replace upstream attribution or assert code-license rights by inference.
- For every requirement, classify `supported`, `synthetic-only`, `experimental`, `not implemented`, `blocked by platform`, and add tests/evidence links.

### Phase 1 — reliable official-export ingestion

- Build robust, streaming-or-bounded import for user-provided official ChatGPT export ZIP or extracted `conversations.json`, with path traversal defenses and decompression limits. **Never fetch exports using cookies or private ChatGPT endpoints**.
- Preserve conversation ID, title, dates, every message node, parent/child edges, `current_node` when present, role, recipient/channel when present, model slug if provided, attachment metadata, source provenance, and unsupported/unknown payloads explicitly. Preserve exact source content separately from normalized text; do not fabricate unavailable multimodal assets or hidden reasoning.
- Include schema versioning/migrations and SQLite FTS5; deterministic upsert and idempotent reimport; branch traversal with cycle detection and deterministic tie handling; offline commands `import`, `list`, `search`, `get`, `branches`, `thread`, `stats`, `audit`.
- Provide JSON, Markdown, compact, JSONL exports with human-readable timezone and source metadata. Preserve timestamps internally in UTC. Support query limits/pagination, with safe SQL binding.
- Make `get https://chatgpt.com/c/<uuid>` succeed only when that UUID is present in imported user-authorized data; otherwise emit structured `NOT_IN_LOCAL_EXPORT` and actionable remedy, not guessed content.

### Phase 2 — tools, adapters and interoperability

- Design a provider-neutral `Conversation` / `Message` / `ContentBlock` / `Branch` domain model with **separate** `ClaudeExportAdapter`, `ChatGPTExportAdapter`, and `OpenAIAPIOwnedAdapter` interfaces. Do not claim that OpenAI's API covers a `chatgpt.com/c` user's history.
- Implement local-first entity extraction (URLs, keywords, timestamps, UUIDs, tool names when present), relationship graph (SQLite or well-justified alternative), BFS neighborhood/path, graph export with safe HTML escaping, and provenance-linked citations into conversation/message IDs.
- Harden the MCP server to conform to supported MCP SDK/protocol transport and initialization; standard error envelopes; JSON Schema for tools; no stdout noise in stdio mode; appropriate limits and timeouts. Expose read/search/graph and **local draft / annotation** tools. An MCP write action must never silently send a consumer ChatGPT message.
- Keep existing CLI commands compatible where safe; provide migrations or deprecation warnings for changed names/semantics. Add a stable TypeScript SDK with typed responses.

### Phase 3 — packaging, CI and security

- Add committed lockfile and reproducible CI with `npm ci`, explicit read-only GitHub Actions token permissions, pinned actions to immutable commits after verification, dependency audit, typecheck/build/unit/integration tests, fixture-import smoke tests, and a privacy-focused git scan.
- Unit/integration property tests: rerun imports, branches, empty exports, cyclic/missing node graphs, duplicate IDs, variable export schema, malicious ZIP entries, large inputs, malformed FTS searches, Unicode, HTML injection, no data leakage. Test MCP JSON-RPC semantics against real SDK client.
- Publish a non-sensitive coverage summary, CLI help capture, branch/model provenance audit, and source-to-target parity matrix. CI MUST require no ChatGPT login and no secrets.
- Document run from local VS Code/Codex, Codespaces, and GitHub Actions. Codespaces is a remote computer, not the ChatGPT conversation container; its network and storage may carry privacy risk.

### Phase 4 — browser UI capability: **gated investigation only**

- Treat existing extension/live bridge in v0.1.1 as **experimental**, not proven account access. Keep feature flags default OFF; do not execute automatic extraction or bulk sync. Review current OpenAI terms, Chrome extension permissions, and whether proposed feature is permitted **before implementation or testing**.
- Allowed initial UI path: user personally logs in through ChatGPT, deliberately copies/exports a conversation via official UI, or manually inserts a draft. Do not capture credentials/session cookies, inspect private APIs, defeat authentication/bot protections, or automate sending without an approved, supported platform route.
- Do not claim a verified live send until the actual user-visible message appears and a human has authorized it. If the platform does not support a compliant route, implement a safe local draft and provide a direct chat URL for manual continuation.

## Global constraints

- TypeScript-first; comment nontrivial logic and tricky transformations, especially authentication boundaries and branch traversal. Python only when justified by a clearly documented capability gap.
- Document and implement explicit provenance and completeness; unknown metadata stays unknown, never inferred as actual model identity.
- No network contact to ChatGPT consumer endpoints from CI or MCP. No credentials or data in Git history, logs or artifacts. No real exports in tests. No silently triggered output sharing.
- Capture a plan and execute it in small PRs; each PR must contain evidence and a concise migration/rollback note.

## Deliverables

A. Working code and lockfile; B. updated `AGENTS.md` and skill; C. user guide + CLI reference + MCP schemas; D. sample synthetic fixture; E. verified tests and CI; F. parity + risk/coverage report; G. GitHub issues/PR(s); H. changelog with explicit *tested vs untested* wording.

## Stop conditions

If a proposed feature requires undocumented ChatGPT consumer APIs, token theft, session cookie replay, unattended browser scraping, or a Terms of Use conflict, STOP that feature, record the constraint, and continue the permitted offline/export features. Do not misrepresent a workaround as feature parity.

## Acceptance gate

Execute and document the checks in `docs/ACCEPTANCE.md`. Report failures precisely. Do not mark a milestone complete when a corresponding CI job is absent or the acceptance test was not executed.
