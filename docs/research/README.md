---
title: Phase 0 research notes
description: Where the committed research notes came from, what they can and cannot be trusted for, and what was changed before committing them
version: 1.1.0
created: 2026-10-12T04:30:00Z
last_updated: 2026-10-12T13:16:00Z
---

# Phase 0 research notes

These files are the working notes behind `docs/PARITY_MATRIX.md`, `docs/SECURITY_AND_BOUNDARIES.md`, `docs/IMPORT_FORMAT.md` and the MCP server. They were produced in October 2026 by read-only research agents, kept as evidence, and committed so that a reviewer can check where a claim came from (the Phase 0 gate "research notes committed" in `docs/EXECUTION_PLAN.md`).

| File | What it is | Status |
| --- | --- | --- |
| `chatgpt-export-format.md` | The ChatGPT data-export layout and the `conversations.json` conversation tree as understood from public descriptions and from the shape of the synthetic fixtures. Section 14 lists the eight questions only a real export can settle. | **UNVERIFIED against a live export.** GCR has only ever imported synthetic data. Section 1 (how to request an export) is what a search summary and another repository report about OpenAI's Help Center article, labelled REP (reported, UNVERIFIED; earlier versions called it OFF/OFFICIAL); no OpenAI wording is reproduced. |
| `platform-policy.md` | What could and could not be checked about OpenAI's terms, export feature, API and Compliance API. | **INCOMPLETE.** No OpenAI primary page could be fetched from the sandbox (egress to `*.openai.com` was blocked), so nothing in it is verified OpenAI text. It reproduces no OpenAI sentence or clause: topics are described in the researcher's words as reported by a search tool (UNVERIFIED), each with the URL where a human must read the live text (it names a few article titles and button labels in quotation marks, as reported, only to identify what to open). This is not legal advice and the terms review required by `AGENTS.md` has NOT been performed. |
| `ccr-cli.md`, `ccr-db-importers.md`, `ccr-mcp-graph.md`, `ccr-auth-license.md` | Feature and data-shape inventories of the Claude Conversation Reader (CCR) at one commit: commands, tables, MCP tools, authentication surface, licence facts. | Notes **about** CCR, not copies of it. CCR has no `LICENSE` file, so no CCR code was copied or adapted; the notes are the input to the parity matrix only. CCR was never modified. |
| `mcp-sdk-cookbook.md` | Behaviour of `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.5 established by running small experiments, with the pitfalls that shaped `src/mcp/`. | Experiments were run against the installed versions; re-check when upgrading either package. |
| `action-pins.md` | The commit SHAs used to pin GitHub Actions in `.github/workflows/gcr-ci.yml`. | The workflow has never run on GitHub; the pins were looked up, not exercised. |

## What was changed before committing

* Local absolute paths of the research machine were replaced by placeholders (`<ccr-checkout>`, `<gcr-checkout>`, `<scratchpad>`, `<home>`). Line numbers and commit ids that refer to the CCR checkout are unchanged.
* `mcp-sdk-cookbook.md` names test files at the root of a research sandbox (`test/aliases.test.ts`, `test/stdio.e2e.test.ts`, ...). They do not exist in this repository; the tests that grew out of them live under `test/mcp/`.
* `platform-policy.md` was edited again on 2026-10-12 after an independent documentation review: the candidate Terms of Use phrases, help-center sentences and the privacy-policy sentence that an earlier version quoted (labelled "not verified") were replaced by a plain description of each topic plus the URL where the text has to be checked. A quotation that could not be checked against the live page does not belong in the repository, even with a warning label.
* Nothing else was edited: statements of uncertainty were kept as written. If a note and the code disagree, the code and `docs/DECISIONS.md` win.

## Rules for adding more notes

1. Never paste real conversation text, account data, cookies or tokens. Synthetic ids only (`00000000-0000-4000-8000-<12 hex>`).
2. Mark what was verified and how; mark what was not (`UNVERIFIED`).
3. Do not quote another project's code unless its licence allows it; describe features and data shapes instead.
4. Run `node scripts/privacy-scan.mjs` before committing.
5. Do not put text of a page you could not fetch and check (a Terms of Use clause, a help-center sentence, a privacy-policy sentence) between quotation marks, even with an "unverified" label: describe the topic in your own words, mark it `reported, UNVERIFIED`, and give the URL where a human must read the live text. Never label such a statement OFFICIAL.
