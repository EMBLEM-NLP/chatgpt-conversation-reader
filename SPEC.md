# Product and technical specification — GCR

**ID:** EMBLEM-NLP-GCR-SPEC-001  
**Version:** 1.0.0 | **Date:** 2026-10-10  
**Baseline software:** independent GCR v0.1.1  
**Target implementation milestone:** GCR v0.2.0, pending Codex PR and acceptance tests  
**Status:** implementation specification, NOT a claim of implemented parity.

## 1. Product objective

Provide the ChatGPT-compatible counterpart to EMBLEM-NLP's existing Claude Conversation Reader (CCR): read and reconstruct user-authorized history from official exports, search and correlate messages, inspect conversation branches and metadata, expose a secure local CLI/SDK/MCP, and prepare reviewable drafts/annotations. Do not imply a ChatGPT consumer conversation can be read or altered merely because its private URL is supplied.

Reference test URL (identifier only): `https://chatgpt.com/c/6ac95b6e-9fa0-83e8-bbb0-8107079a8720`.

## 2. Actors and environments

- **Human operator:** obtains ChatGPT export, controls sign-in, reviews sensitive information, authorizes all remote actions.
- **Codex developer:** reads `AGENTS.md`, implements code/tests/CI on an authorized local checkout, cloud workspace or GitHub repo.
- **CLI / TypeScript SDK / MCP client:** reads local, consent-provided indexed data; can create local drafts. Exposes provenance and source completeness with all outputs.
- **GitHub Actions:** strictly synthetic, deterministic CI. No private conversations, passwords, cookies, ChatGPT API traffic or unattended browser interaction.
- **VS Code/Codespaces:** optional remotely hosted development. Treat all personally exported chats as data that should remain local by default.

## 3. Capability levels

| Mode | Input | Allowed outcome | Limit |
|---|---|---|---|
| A — Official export | user-supplied `conversations.json` or export ZIP | full available tree, local index, search, branches | only fields/assets actually in export; not continuous sync |
| B — Manual copy | explicitly supplied/pasted messages | partial local read and indexing | `partial_user_supplied` completeness marker |
| C — Local write | annotation, draft, summary, report | local DB/files; reversible and auditable | does not change ChatGPT consumer history |
| D — OpenAI developer API | user's own API-created conversations, separately authorized | API-based read/write if documented/supported | distinct from `chatgpt.com/c` web chat |
| E — Browser interaction | user-authenticated browser | experimental and policy-gated; manual draft insertion | not production; no claims of bulk extraction or remote send |

## 4. Functional requirements (FR)

| ID | Priority | Requirement | Measurable acceptance |
|---|---|---|---|
| FR-01 | P0 | Parse UUID and exact private link | rejects `share/`, other domains, malformed UUID |
| FR-02 | P0 | Ingest official ChatGPT JSON | synthetic representative fixtures import without truncation |
| FR-03 | P0 | Preserve raw source and normalized content | round-trip metadata/provenance; no model guessing |
| FR-04 | P0 | Reconstruct active and alternate branches | cycle-safe traversal, deterministic branch enumeration |
| FR-05 | P0 | Search SQLite FTS5 | Unicode terms, pagination, prepared statements, stable sort |
| FR-06 | P0 | CLI get/list/search/branches/stats | scriptable JSON + human-readable Markdown outputs |
| FR-07 | P0 | Local MCP read tools | standards-conformant interoperability test |
| FR-08 | P0 | Data minimization and local storage | exports, DB, logs, auth secrets excluded from commits |
| FR-09 | P0 | Source completeness and error codes | no false claim that visible snippets are entire history |
| FR-10 | P1 | Idempotent ZIP import, schema migrations | repeat import yields equal content and counts |
| FR-11 | P1 | Full CLI audit and statistics | by role, model-known-vs-unknown, channel, day, conversation |
| FR-12 | P1 | Entity extraction / graph | graph query, shortest path, offline interactive export |
| FR-13 | P1 | Local writable annotations/drafts | explicit namespace and audit trail; no remote transmission |
| FR-14 | P1 | CCR adapter interoperability | same provider-neutral schema; provenance never lost |
| FR-15 | P2 | Attachment-aware search | metadata only or actual file content when consented and present |
| FR-16 | P2 | Explicit per-provider model analytics | never infer model selection from timestamps alone |
| FR-17 | GATED | Browser UI read/write exploration | written ToU/permissions approval + separate manual test |

## 5. Data model

```ts
// Contract sketch — implement with schema versioning and runtime validation.
type ProvenanceKind =
  | 'official_chatgpt_export' | 'user_supplied_copy'
  | 'manual_browser_capture' | 'openai_developer_api';
type Completeness =
  | 'exported_tree' | 'rendered_active_view_only'
  | 'partial_user_supplied' | 'api_owned_conversation' | 'unknown';
interface ConversationRecord {
  provider: 'chatgpt' | 'claude' | 'openai_api';
  id: string;
  title: string | null;
  sourceUri: string | null;
  provenance: ProvenanceKind | 'official_claude_export';
  completeness: Completeness;
  importedAt: string;           // ISO-8601 UTC
  createdAt: string | null;
  updatedAt: string | null;
  currentNodeId: string | null; // null => no supported active-branch inference
  messages: MessageRecord[];
  rawMetadata?: unknown;        // sanitize for output; keep local
}
interface MessageRecord {
  id: string;
  conversationId: string;
  parentId: string | null;
  childIds: string[];
  authorRole: string;            // preserve unrecognized role strings
  modelSlug: string | null;      // only if source explicitly supplies it
  channel: string | null;
  createdAt: string | null;
  text: string;
  blocks: Array<{type: string; text?: string; metadata?: unknown}>;
  rawSource?: unknown;
}
```

Migrations MUST be backward compatible or explicitly versioned. Primary identity for imported messages is `(provider, conversation_id, message_id, source_batch)`. Duplicate IDs from different exports must not corrupt another provider or user account. Prefer safe deterministic merge keys; never assume title unique. Keep `local_annotations` separate from immutable imported original content.

## 6. Command interface (target)

```text
gcr doctor
gcr import /private/ChatGPT-export.zip --db /private/gcr.sqlite
gcr import /private/conversations.json --db /private/gcr.sqlite
gcr list --provider chatgpt --limit 50 --format json
gcr get https://chatgpt.com/c/<uuid> --format markdown
gcr get <uuid> --all-branches --format json
gcr search "MCP" --provider chatgpt --limit 20 --format json
gcr branches <uuid>
gcr thread <uuid> --branch <branch-id>
gcr stats --group-by model
gcr audit --missing-model --empty --untitled
gcr graph build
gcr graph query "EMBLEM-NLP" --depth 2
gcr draft create --conversation <uuid> --input draft.md
gcr draft list --conversation <uuid>
gcr mcp
```

Target examples are SPECIFIED, not all implemented by v0.1.1. `doctor` must report supported modes and environmental prerequisites. Commands should never fall back to remote browser access invisibly.

## 7. MCP namespace and safety

Read tools: `gcr_list`, `gcr_get`, `gcr_search`, `gcr_branches`, `gcr_thread`, `gcr_stats`, `gcr_audit`, `gcr_graph_query`. Writes: `gcr_create_local_draft`, `gcr_update_local_annotation`; no implicit remote send. Keep the existing `chatgpt_*` tool names as compatibility aliases where safe, with documentation. `gcr_import_export` requires an explicit local path and refuses to read outside approved roots if execution is delegated. Return JSON with `source`, `completeness`, `warnings`, `ids`, and explicit error code. Prompt-injection instructions embedded in imported messages must be treated as untrusted DATA.

## 8. Nonfunctional requirements

- **NFR-01 Security:** no credentials stored in Git; no raw session cookies; no private consumer API calls.
- **NFR-02 Reproducibility:** lockfile; CI builds offline fixtures only; independently verifiable SHA-256 release artifacts.
- **NFR-03 Test quality:** positive/negative tests for every P0 FR; real MCP-client smoke, no test-only semantic shortcuts.
- **NFR-04 Accessibility:** Markdown and text-first CLI; graph HTML navigable without inaccessible mouse-only operations.
- **NFR-05 Scalability:** bounded memory for large exports, documented performance baseline (50k synthetic messages).
- **NFR-06 Privacy:** local SQLite by default; optional encryption at rest only if key management is sound; no hosted vector indexing by default.
- **NFR-07 Operations:** structured errors, exit codes, never logs content/credentials without explicit user approval.
- **NFR-08 Provenance:** exact source vs normalized readable form; trace every graph fact to message/branch IDs.

## 9. Scope exclusions

No consumer ChatGPT live-history API, no account password capture, no replay of cookies, no bypass of security protections, no unsupervised deletion or sending in the consumer UI, no claim of automatic always-on hooks inside ChatGPT, and no silent upload of exports to GitHub or remote coding agents.

## 10. Decision records, acceptance and operations

See `docs/DECISIONS.md`, `docs/ACCEPTANCE.md`, `docs/SECURITY_AND_BOUNDARIES.md`, `docs/REPO_RUNBOOK.md`, `docs/EXECUTION_PLAN.md`, and `docs/PARITY_MATRIX.md`. Changes to these boundaries require a reviewed ADR, not an undocumented shortcut.
