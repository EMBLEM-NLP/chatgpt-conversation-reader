# Start here (Codex / any coding agent)

**Product:** EMBLEM-NLP ChatGPT Conversation Reader & Writer (**GCR**) — a local-first, offline reader for *user-provided* ChatGPT export data
with search, branch reconstruction, a knowledge graph, a stable TypeScript SDK, a CLI (`gcr`) and a local MCP server.

## Read in this order
1. `AGENTS.md` — hard rules (consumer-URL boundary, local-only writes, imported text is untrusted data).
2. `SPEC.md` — the product/technical specification (FR/NFR ids referenced everywhere).
3. `docs/ARCHITECTURE.md` — normative module contracts, DDL, invariants.
4. `docs/SECURITY_AND_BOUNDARIES.md` and `docs/DECISIONS.md` — what is deliberately not built, and why.
5. `docs/EXECUTION_PLAN.md`, `docs/ACCEPTANCE.md`, `docs/PARITY_MATRIX.md` — plan, evidence, honest status.
6. `.agents/skills/gcr-implementation/SKILL.md` — the working procedure.

## Commands (Node ≥ 22.16.0 — see ADR-0012; 22.13–22.15 lack SQLite FTS5)
```bash
npm ci                    # reproducible install (package-lock.json is committed)
npm run typecheck         # tsc --noEmit over src + test
npm run build             # tsc -> dist/
npm test                  # compiles src+test to dist-test/ then runs node --test (always builds from TypeScript)
npm run smoke             # node scripts/ci-smoke.mjs : synthetic end-to-end import/search/MCP smoke
npm run privacy-scan      # fails if private data patterns or forbidden files are tracked
npm run test:browser      # Phase 4 is gated: prints NOT_RUN (no browser code exists)
```

## What GCR will and will not do
* **Does:** import an official ChatGPT export ZIP / `conversations.json` / sharded `conversations-NNN.json` that the *operator* downloaded; index it in a local SQLite
  file; search; rebuild branches; render JSON/Markdown/compact/JSONL; extract entities; build a graph; keep local drafts and annotations; serve all of that over MCP (stdio).
* **Does not:** fetch `chatgpt.com/c/<uuid>` (a private consumer URL is only a *lookup key* into data you already imported), call private ChatGPT endpoints, read browser cookies, bypass login,
  send messages, or upload exports anywhere. There is no network code in this repository.
* **Synthetic only:** tests and fixtures are invented data. Do not add real exports, screenshots or logs containing conversation text.

## Definition of done for a change
Run `npm run typecheck && npm run build && npm test && npm run smoke && npm run privacy-scan`, record exact results in the PR (see `docs/PR_NOTES.md`), update
`docs/ACCEPTANCE.md` / `docs/PARITY_MATRIX.md` where a status changed, and describe tested vs untested behaviour in `CHANGELOG.md`.
