# Browser UI capability (SPEC FR-17, Mode E, CODEX_TASK Phase 4) — GATED, NOT IMPLEMENTED

**Status: `GATED` · default OFF · no code exists.** This repository contains no browser, extension, DOM-reading, cookie, token, or
`chatgpt.com` network code. A test (`test/security/no-network.test.ts`) fails if any source file imports a network, browser-automation or
child-process module. The v0.1.1 extension/live bridge mentioned in the task was not available to this implementation (ADR-0001), so there is nothing to disable.

## Why it is gated

* `chatgpt.com/c/<uuid>` is a **private consumer URL**, not an authenticated OpenAI API resource (`AGENTS.md`). Knowing the link does not entitle anyone — human or tool — to read or alter it.
* OpenAI's current Terms of Use / Usage Policies have **not been verified** here: during Phase 0 every `*.openai.com` host was unreachable from the sandbox (egress policy), so no primary page was read and no Terms of Use or Usage Policies clause is quoted
  in this repository (an earlier research note that quoted candidate phrases was reduced to topic descriptions on 2026-10-12; see `docs/research/platform-policy.md`). Secondary search summaries mention restrictions on automatic/programmatic extraction, circumventing protective measures/rate limits and credential sharing; **these are paraphrases of search-tool output, unverified, and are not legal advice**.
  Until a human completes the checklist below, GCR treats any automated reading of, or sending into, the consumer UI as unsupported.
* Accounts can be suspended for prohibited automation (reported, unverified). The operator, not GCR, bears that risk.

## What is allowed today (the "initial UI path" of CODEX_TASK Phase 4)

1. The user logs in to ChatGPT **personally**.
2. The user deliberately obtains data through the **official** routes (Settings → Data controls → Export data, or the Privacy Portal) and imports it with `gcr import` (Mode A), or deliberately copies text by hand (Mode B, `partial_user_supplied`).
3. For writing: `gcr draft create` stores a **local draft** (Mode C). Output includes the canonical conversation link so the human can open it and paste the draft **manually**. GCR never sends, and a draft has no `sent` state.

## What GCR will not do (stop conditions, `CODEX_TASK.md`)

Undocumented consumer APIs · session-cookie/token capture or replay · reading browser storage · spoofing user agents or `navigator.webdriver` · defeating bot protection · unattended or bulk extraction/sync · automated sending ·
inspecting private endpoints. If a future proposal needs any of these: **stop that feature**, record the constraint in an ADR, and continue with the offline/export path. A workaround must never be presented as parity.

## Gate procedure (human-owned; agents must not tick these)

All items must be completed and recorded in `docs/DECISIONS.md` as a reviewed ADR **before** any implementation or test of a browser-interaction feature.

- [ ] Open the live consumer Terms of Use for **your jurisdiction** (ROW vs EU/UK variant). Record URL, the document's stated effective date, the date you read it, and keep a saved copy outside Git.
- [ ] Copy verbatim, with section numbers, the clauses on: automated or programmatic extraction of data or output; interference with the services / circumvention of rate limits or protective measures; account and credential sharing; suspension/termination.
- [ ] Read the live Usage Policies, and the Services Agreement/Service Terms if a workspace, business or API account is involved.
- [ ] Confirm the account type. For workspace accounts, get **written** permission from the workspace owner/admin and use the workspace Compliance route (admin-supplied files) if conversation content is needed (whether GCR can import such files is not verified; see the last table row).
- [ ] Ask OpenAI Support or counsel **in writing** whether the specific mechanism (extension, DOM read, manual paste, automated insertion) is permitted. Keep the reply. Silence or a generic reply counts as "no".
- [ ] Take a fresh official export first so nothing depends on the experiment.
- [ ] Accept the account risk personally; use only your own account; never create extra accounts to avoid limits or enforcement.
- [ ] Write the protocol down: one conversation, human-initiated, human-paced, attended, no loops/schedules/bulk/sync, and a stop rule for any CAPTCHA, challenge, warning, rate limit or error.
- [ ] Confirm the experiment will not capture/store credentials or cookies, replay tokens, call private endpoints, alter headers/user agent, hide automation, defeat bot protection, or send without a human reviewing and clicking.
- [ ] If a Chrome extension is involved, review Chrome extension permissions and Chrome Web Store policy yourself (minimal host permissions, no remote code, no `<all_urls>`). *(Not researched here.)*
- [ ] Feature flag default OFF; code absent from the default build; CI has no ChatGPT network access, no secrets, no real exports.
- [ ] Privacy: the conversation may contain third-party personal data. Store locally, outside Git, with GCR's retention settings.
- [ ] Re-open the live terms on the day of the experiment and confirm nothing changed.
- [ ] Record the outcome (including negative ones) as *tested* or *untested* in `CHANGELOG.md`. Do not report a "verified live send" unless a human saw the message appear and authorized it.

## Acceptance (SPEC FR-17)

"Written ToU/permissions approval + separate manual test." Neither exists. FR-17 is therefore `GATED` in `docs/PARITY_MATRIX.md` and `docs/ACCEPTANCE.md`; `npm run test:browser` reports `NOT_RUN: no browser code in this build`.

## Related alternatives (supported, out of scope or not verified)

| Need | Route in GCR |
|---|---|
| Read my history | Official export ZIP → `gcr import` |
| Read a conversation I only have a link to | Not possible by design; `gcr get <url>` returns `NOT_IN_LOCAL_EXPORT` with the export remedy |
| Continue a conversation | `gcr draft create`, then paste manually at the printed link |
| API-created conversations (Mode D) | Out of scope for this version; interface + disabled adapter only (`docs/ADAPTERS.md`) |
| Workspace (Enterprise/Edu) data | **Not verified: no fixture exists and it is unknown whether such files import at all** (nothing shows that admin-supplied compliance export files have the `conversations.json` shape; the Compliance route is out of scope in `docs/PARITY_MATRIX.md`). GCR never calls the admin API |
