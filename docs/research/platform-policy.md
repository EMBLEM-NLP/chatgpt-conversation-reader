---
title: GCR Platform-Policy Research (OpenAI ToU, export, API, Compliance API)
description: Phase 0 read-only research feeding GCR docs/SECURITY_AND_BOUNDARIES.md; documents what could and could not be verified about OpenAI platform policy
version: 1.1.0
created: 2026-10-10T22:36:49Z
last_updated: 2026-10-12T13:31:32Z
---

# GCR platform-policy research (INCOMPLETE: primary sources could not be fetched)

Date accessed: 2026-10-10. Researcher: read-only subagent. NOT LEGAL ADVICE.

## 0. Read this first: status banner

**No OpenAI primary page was fetched.** Every OpenAI host was unreachable from this sandbox, so
nothing in this file is verified OpenAI text: there is **no verified quotation** from the current OpenAI
Terms of Use, Usage Policies, Services Agreement, help-center articles or API docs, and (see below) no
unverified quotation either.

What this file does contain:

1. An access log showing exactly what failed and why (section 1).
2. Findings that came from the WebSearch tool. These are **search-tool summaries of OpenAI and
   third-party pages**, not fetched page text. Treat every one as **UNVERIFIED-SECONDARY** (section 2 to 6).
3. CCR facts with file:line citations, verified by reading the local CCR checkout (section 7).
4. Implications, an operator checklist, and a list of unverified items (sections 8 to 10).

**This file reproduces no OpenAI sentence or clause.** (It does name help-center article titles and button labels as the search tool reported them, in quotation marks, only so that a human can find the page: they are labels, not policy text, and are as unverified as everything else here.) Per the task rules I did not reconstruct policy text from
memory, and since the review of 2026-10-12 I no longer reproduce the sentences that the search tool returned
either: an earlier version of this file quoted candidate Terms of Use phrases, help-center sentences and a
privacy-policy sentence, labelled "not verified". They are removed, because text that could not be checked
against the live page should not sit in a repository between quotation marks. Each topic below is described
in the researcher's own words as **reported by a search tool, UNVERIFIED**, together with the URL where the
text has to be read. Before any of it is cited in `docs/SECURITY_AND_BOUNDARIES.md`, a human or a
network-enabled agent must open the live URL and record the clause verbatim, with its section number and
the date read, outside this repository (section 11 lists the URLs).

## 1. Access log (what was tried)

| Attempt | Tool | Result |
|---|---|---|
| `https://openai.com/policies/terms-of-use/` | WebFetch | `getaddrinfo ENOTFOUND openai.com` |
| `https://openai.com/policies/usage-policies/` | WebFetch | `getaddrinfo ENOTFOUND openai.com` |
| `https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data` | WebFetch | `getaddrinfo ENOTFOUND help.openai.com` |
| `https://openai.com/policies/row-terms-of-use/` | WebFetch | `ENOTFOUND` |
| `https://www.openai.com/policies/terms-of-use/` | WebFetch | `ENOTFOUND` |
| `https://open.windriver.com/.../openai-tou-20241211.html` (third-party mirror of Dec 2024 terms) | WebFetch | `ENOTFOUND` |
| `https://web.archive.org/web/2026/https://openai.com/policies/terms-of-use/` | WebFetch | "Claude Code is unable to fetch from web.archive.org" |
| `https://example.com/` (control) | WebFetch | `ENOTFOUND` (so WebFetch cannot resolve any host in this sandbox) |
| `https://openai.com/policies/terms-of-use/` | curl via the sandbox proxy | `CONNECT tunnel failed, response 403` |
| `help.openai.com`, `platform.openai.com`, `cdn.openai.com`, `openai.com/policies/usage-policies/`, `news.ycombinator.com` | curl via the sandbox proxy | all `CONNECT tunnel failed, response 403` |
| `https://github.com/` (control) | curl via the sandbox proxy | HTTP 400 (tunnel succeeded, so the proxy is an allowlist, not a general outage) |
| Reading the proxy README and proxy status endpoint | Bash | **Denied by the auto-mode classifier** (reason given: "Exfil Scouting"). I did not retry or work around this. |
| WebSearch (about 14 queries) | WebSearch | Worked. Returns a model-written summary plus link titles and URLs, not page text. |

Diagnosis: the environment network policy blocks all `*.openai.com` hosts (403 on CONNECT) and
WebFetch has no working DNS. This is an environment setting, not an OpenAI-side block. To unblock,
the operator edits the cloud environment's Network access (environment menu in the session title bar,
then Edit) to a broader level, or adds the hosts in section 11 under Allowed domains.
Steps: https://code.claude.com/docs/en/cloud-environments#network-access (not fetched; taken from the
in-product documentation tool).

## 2. Terms of Use: version and clauses (UNVERIFIED-SECONDARY)

### 2.1 Which document and which version is current

| Item | Search-tool report | Status |
|---|---|---|
| Canonical consumer terms URL | `https://openai.com/policies/row-terms-of-use/` (the rest-of-world Terms of Use); `https://openai.com/policies/terms-of-use/` also returned by search | URL listed by search, not fetched |
| Regional variants | `https://openai.com/en-GB/policies/eu-terms-of-use/` (the European Terms of Use, reported as updated on 16 January 2026); older `https://openai.com/policies/dec-2024-eu-terms/` | UNVERIFIED. The operator's jurisdiction decides which document binds them. |
| ROW Terms date | One search summary reported an effective date of 1 January 2026 and another reported that the page marks that version as a previous one, which would suggest that a newer version exists. | **UNRESOLVED. Current effective date of the consumer terms as of 2026-10-10 is unverified.** |
| Business / API terms | `https://openai.com/policies/services-agreement/` and `https://cdn.openai.com/osa/openai-services-agreement.pdf` (file label v.010126), reported as effective 1 January 2026 | UNVERIFIED |
| Usage Policies | `https://openai.com/policies/usage-policies/`, reported as effective 29 October 2025 | UNVERIFIED; may have changed since |
| Service terms | `https://openai.com/policies/service-terms/` | Listed only; contents not reported |
| Change notice | The ROW terms are reported to promise advance notice of material changes (reported as at least 30 days) by email or in-product notice | UNVERIFIED; implies the terms can change under GCR between releases |
| Terms update log | `https://help.openai.com/en/articles/8541941-terms-of-use-updates` | Listed only |

### 2.2 Topics the search tool reported for the Terms of Use (no wording reproduced)

All rows: **status = NOT VERIFIED**. Each row is the researcher's paraphrase of a search-tool summary, not a
quotation; the page was not fetched. Date accessed for the search: 2026-10-10. The "Read it here" column is
the URL where the text has to be read and recorded verbatim by a human (section 11).

| Topic | What the search tool reported (paraphrase) | Read it here | Action before citing |
|---|---|---|---|
| Automated or programmatic extraction | The consumer terms are reported to list, among the things a user may not do, extracting data or output automatically or programmatically. One summary said the current rest-of-world terms (effective 1 January 2026, per that summary) carry it and that the EU version repeats it. Older copies of the terms on third-party sites were reported to carry a similar item; those are not authoritative and are not listed here. | `https://openai.com/policies/row-terms-of-use/` and `https://openai.com/en-GB/policies/eu-terms-of-use/` | Record the section number and the exact wording. Check whether the terms define "output" so that it includes conversation transcripts. |
| Competing models | Reported (from an older third-party copy of the terms): a restriction on using output to develop models that compete with the provider. | the same two pages | Verify in the current text. Relevant if GCR analytics or embeddings are ever used for training. |
| Human-generated misrepresentation | Reported (from the same older copy): a restriction on presenting output as human-generated when it was not. | the same two pages | Verify. Relevant to the draft/send feature. |
| Interfering with the Services, rate limits | The search summary said the terms bar circumventing rate limits and bypassing protective measures and safety mitigations, under an item about interfering with or disrupting the Services. The rest-of-world and EU texts were described as nearly identical. | the same two pages | Obtain the verbatim text and section number. |
| Credential or account sharing | The summary said users may not share account credentials or make their account available to others, and are responsible for activity under their account. | consumer terms (the same two pages) | Obtain the verbatim text. |
| Business customers, credentials and limits | The summary said the Services Agreement bars sharing login credentials across multiple users, circumventing rate limits and protective measures, and configuring the Services to avoid usage limits. | `https://openai.com/policies/services-agreement/` | Obtain the verbatim text. Applies only if the operator is a business, API or workspace customer. |
| API keys | The summary said OpenAI's key-safety help article states that sharing API keys violates the terms and is unsupported. | `https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety` | Verify. |
| Suspension | The summary said OpenAI may suspend or terminate access, or delete an account, on a determined violation, with an appeal route through Support. | consumer terms (the same two pages) | Verify. |
| Reverse engineering | The consumer terms were reported to bar attempting, or helping anyone, to reverse engineer or decompile the services or to discover their source code or underlying components, subject to applicable law. | the same two pages | Verify. Relevant to any "inspect private APIs" step, which the Codex task already forbids. |
| ChatGPT agent policy page | The summary said `https://openai.com/policies/using-chatgpt-agent-in-line-with-our-policies/` repeats that users may not bypass rate limits, restrictions or safety measures, and that it also applies to the standalone Operator product. The page was described as roughly 450 days old. | that URL | Verify and date it. |

Note on a search-summary inference I did not adopt: one summary ended by interpreting the terms as forbidding
the activity that had been asked about and by calling the API the sanctioned route for programmatic access.
That is the search tool's interpretation, was not tied to a clause, and was not confirmed, so it is not used here.

## 3. Data export and portability routes (UNVERIFIED-SECONDARY)

Source URLs returned by search (help center):

- `https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data` (title "Exporting your ChatGPT history and data"; the older slug `...how-do-i-export-my-chatgpt-history-and-data` also appears)
- `https://help.openai.com/en/articles/8167885-how-to-export-your-data-from-the-chatgpt-android-app`
- `https://help.openai.com/en/articles/20001279` ("Exporting data from a ChatGPT Edu workspace")
- `https://help.openai.com/en/articles/7730893-data-controls-faq`
- `https://help.openai.com/en/articles/20001488-privacy-center-in-chatgpt` ("Privacy Center in ChatGPT")

Reported content (paraphrase of search summaries):

| Fact | Reported value | Status |
|---|---|---|
| In-app route | Profile menu, Settings, Data controls, Export, then confirm | UNVERIFIED |
| Privacy Portal route | Privacy Portal, "Make a Privacy Request", consumer ChatGPT account, then the download-my-data option | UNVERIFIED |
| Delivery | Email or SMS when ready. Reported as taking up to 7 days. Download link reported to expire 24 hours after receipt. Download while signed in to the same account. | UNVERIFIED |
| Contents | ZIP with chat history and other account data. Deleted chats cannot be restored through an export. | UNVERIFIED. The summaries did not name `conversations.json` or `chat.html`; see `chatgpt-export-format.md` in this directory for the format work. |
| Who can self-serve | Free, Go, Plus and Pro signed-in users. Business, Enterprise and ChatGPT for Healthcare workspaces were reported as having no self-service export (the search tool returned a sentence to that effect; not reproduced). Edu depends on admin settings (export reported as off by default). | UNVERIFIED |
| Workspace users | Reported to be directed to their workspace owner for organization-managed data access (the search tool returned a sentence to that effect; not reproduced). | UNVERIFIED |
| Personal-to-managed move | Export before moving; the old export link or a new export may become unavailable once the personal workspace is removed. | UNVERIFIED |

Deletion and privacy-request routes (same status):

| Fact | Reported value |
|---|---|
| Source | `https://help.openai.com/en/articles/6378407-how-to-delete-your-account` ("Deleting your ChatGPT account"); also `https://openai.com/consumer-privacy/` ("ChatGPT privacy settings") and `https://openai.com/en-GB/policies/row-privacy-policy/` |
| In-app deletion | Settings, Account, Delete |
| Portal deletion | For users who cannot sign in: Privacy Portal, "Make a Privacy Request", consumer ChatGPT account, "Delete my ChatGPT account", then verification via the linked email or phone |
| Timing | Reported: after an account deletion, the data is deleted within 30 days, except that a limited set may be kept longer where the law requires or permits it (the search tool returned a privacy-policy sentence to that effect; it is not reproduced here). Deletion is reported as permanent. Check the privacy policy and the deletion article above. |
| Managed workspaces | Self-service account deletion reported as unavailable |
| Training opt-out | Turning off model training does not delete existing chats |
| Privacy Portal host | `privacy.openai.com` (named by search summaries; the host itself was not probed) |

GCR implication: the only portability route GCR should depend on is the official export ZIP, with the
delivery delay and link expiry above treated as operator-facing documentation, not as guarantees.

## 4. Is `chatgpt.com/c/<id>` reachable through the OpenAI API? (inference, not a quoted statement)

**No primary-source sentence stating this was found or fetched.** What the search tool reported:

| Item | Reported | Status |
|---|---|---|
| Conversations API object | `POST /conversations` creates a durable object with `id`, `created_at`, `metadata`, `object: "conversation"`. It is reported to work with the Responses API to hold conversation state in a long-running object with its own durable identifier (the search tool returned a sentence to that effect; not reproduced) | Source: `https://developers.openai.com/api/docs/guides/conversation-state`, `https://developers.openai.com/api/reference/resources/conversations/methods/create`. UNVERIFIED |
| Items | Messages, tool calls, tool outputs and other data | UNVERIFIED |
| Retention | Reported: conversation objects and their items are not subject to a 30-day time-to-live (a retention statement from the API documentation; not reproduced verbatim) | UNVERIFIED |
| Alternative | `previous_response_id` lets OpenAI manage prior context | UNVERIFIED |
| Listing | A developer-forum post (community, not official) complains that there is no method to list conversations and that item response IDs are not exposed | Community report only; may be outdated |
| Assistants API | `https://developers.openai.com/api/docs/deprecations` reportedly lists the Assistants API for removal on **August 26, 2026**, replaced by Responses plus Conversations. Today is 2026-10-10, so that date has passed. | UNVERIFIED. Whether the sunset was executed as announced is unknown. |
| ChatGPT vs API separation | Billing, membership and access are separate: ChatGPT subscription does not cover API usage (`https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform`); workspace membership and API Platform organization membership are managed separately (`https://help.openai.com/en/articles/8265053-what-is-chatgpt-enterprise`). | UNVERIFIED. These pages concern billing and membership, not conversation visibility. |
| Search conclusion | The search tool itself said it found nothing explicit on how the API relates to ChatGPT consumer conversations, and added that the API conversation object is a developer resource separate from ChatGPT chats. | The second statement is the search tool's own wording, not an OpenAI statement |

Conclusion for GCR docs (label as inference): the documented Conversations/Responses API manages
**objects the developer's own API calls created**. No documentation found in this research says it exposes
a ChatGPT consumer user's `chatgpt.com/c/<id>` history. This matches the Codex task instruction ("Do not
claim that OpenAI's API covers a chatgpt.com/c user's history", Phase 2). It should be re-verified
against the live API reference before the doc states it as fact.

## 5. Compliance API / Compliance Platform (UNVERIFIED-SECONDARY)

| Item | Reported | Source URL (as returned) |
|---|---|---|
| Naming | Help article titled "OpenAI Compliance Platform for Enterprise and Edu customers" (slug `compliance-api-for-enterprise-customers`). Search summary: the Compliance API now sits inside a Compliance Logs Platform. | `https://help.openai.com/en/articles/9261474-compliance-api-for-enterprise-customers`; `https://developers.openai.com/cookbook/examples/chatgpt/compliance_api/logs_platform` |
| Audience | ChatGPT Enterprise and Edu workspaces | same |
| Data covered | Time-stamped conversations, uploaded files, workspace GPT configuration and metadata, memories, workspace users; audit, authentication and Codex usage logs; record-mode canvases and transcripts. Reported as delivered in immutable JSONL log files covering time windows. | Cookbook page above; `https://openai.com/index/new-tools-for-chatgpt-enterprise/` |
| Record mode | Reported: on Enterprise and Edu workspaces, canvases and transcripts created by record mode are captured by the Compliance API (the search tool returned a sentence to that effect; not reproduced). | `https://help.openai.com/en/articles/11664471-enterprise-compliance-information-for-chatgpt-record-mode` |
| Access paths | Reported: Enterprise workspace owners can use the Compliance API directly or choose a third-party compliance integration (the search tool returned a sentence to that effect; not reproduced). | same family of pages |
| Credential model | A workspace owner or admin creates a workspace-scoped **Admin key**. Reported: only owners can grant the permission for conversation messages or broad compliance access. Admin API requests reportedly use `https://api.chatgpt.com/v1`. | help article 9261474; `https://help.openai.com/en/articles/20001407-managing-admin-keys-in-admin-console` |
| Change dates | A new conversation-logs system was reported as launched on 5 March 2026 and the stateful route as removed on 5 June 2026 (per a search summary of the help article). Old integrations must migrate. | help article 9261474 |
| Not covered | Workspace analytics is not a substitute (no message text). ChatGPT Atlas is reported not to emit Compliance API logs. Shared task links and their snapshots are not included. | `https://help.openai.com/en/articles/10875114-workspace-analytics-for-chatgpt-enterprise-and-edu`; `https://help.openai.com/en/articles/12603091-chatgpt-atlas-for-enterprise` |
| Do not confuse | Different from the API Platform's `/v1/conversations` endpoint (section 4). | search summary |
| Endpoint path | The exact conversation endpoint path was **not** confirmed. A 19-month-old community post reported a 400 on `/compliance/workspaces/{workspace_id}/conversations`. | community report only |

GCR relevance: the Compliance route is the supported route for **workspace** conversation data, and it
needs an owner-issued key. It does not help a personal Free/Plus/Pro user. If GCR ever adds a
"workspace compliance export" reader it should ingest **files the admin hands over** (consistent with
the Codex task rule "No network contact to ChatGPT consumer endpoints from CI or MCP"), not call the
Admin API from GCR.

## 6. Browser extension and automation restrictions (UNVERIFIED-SECONDARY; mostly absence of evidence)

- No OpenAI document was found (or fetched) that either permits or prohibits a **user-installed browser
  extension that reads the rendered ChatGPT page**. The relevant clauses are the general ones in section 2.2
  (automatic or programmatic extraction; circumventing protective measures and rate limits; credential
  sharing). Whether a specific extension is covered is an interpretation question for counsel or OpenAI support.
- The reported ChatGPT agent policy page restricts what users do **with** OpenAI's agent. It is not a
  statement about third-party automation of the consumer UI.
- Chrome Web Store and Chrome extension permission policies are outside this task and were **not
  researched**. Listed as unverified in section 10.
- The search tool reported (community threads, not official) that account suspensions occur and some are
  reversed on appeal, and that an older thread is reported to cite an earlier scraping ban. Not authoritative.

## 7. CCR cross-reference: features whose shape GCR must NOT carry into a ChatGPT live path

Checkout: `<ccr-checkout>` (commit f66e24e). CCR is read-only here.
These are feature and data-shape facts only; no code is copied.

| CCR fact | Citation | Why it matters to platform policy |
|---|---|---|
| Playwright login with a spoofed desktop-Chrome user agent; a code comment next to it says the default agent string would draw Cloudflare's bot protection (paraphrased, not quoted) | `src/auth/claude-login.ts:32-35` | Defeating bot protection. Matches the Codex task prohibition on defeating "authentication/bot protections". |
| `navigator.webdriver` overridden to `undefined`; the code comment gives hiding automation from Cloudflare as the reason (paraphrased) | `src/auth/claude-login.ts:37-40`; also `src/api/code-session-client.ts:91`, `src/auth/discover-code-api.ts:166` | Same: protective-measure evasion. |
| A code comment lists the evasion techniques in use (paraphrased): `--disable-blink-features=AutomationControlled`, webdriver spoof, Chrome 135 UA | `src/auth/claude-login.ts:56-60` | Same. |
| Session cookies captured and replayed against an undocumented REST API; no API key is involved (as CCR's project notes put it) | project `CLAUDE.md` ("Key API Details"); `src/api/client.ts:106` sets a custom `User-Agent` | Cookie replay and private-API use. Codex task Stop conditions name "session cookie replay" and "undocumented ChatGPT consumer APIs". |
| Per-org token bucket, 1 req/s sustained, burst 3 | `src/api/client.ts:21-25` (bucket at 23-25, wait logic 32-50) | Self-throttling is a politeness measure, not a license; not a rate-limit "bypass", but GCR has no live consumer path to throttle. |
| Write-capable calls (DELETE at `client.ts:146`; POST at `:159`; PUT at `:170` and `:190`) | `src/api/client.ts:146,159,170,190` | Remote mutation of the provider account. Purposes of the POST and PUT calls were **not verified** in this task. GCR's delete and draft features must be local-only (FR-13). |
| Traffic-capture tool for reverse-engineering undocumented API surfaces (CCR's own description, paraphrased) | project `CLAUDE.md` module table (`src/auth/discover-code-api.ts`) | "Inspect private APIs" is forbidden by Codex task Phase 4. |

## 8. (a) What the clauses mean for FR-17 and Phase 4 (browser UI)

**This is NOT legal advice.** It is an engineering reading of unverified, secondhand clause summaries.
Counsel or OpenAI written confirmation is required before relying on any of it.

1. **FR-17 should stay GATED and default OFF.** If the current consumer terms contain the extraction
   item reported in 2.2, the report describes it as covering automatic or programmatic extraction in
   general, not only bulk or unattended use (the actual wording is unverified). A user-installed extension that reads conversation content from the
   page, or Playwright/DOM scraping, is at least arguably within it. The spec's FR-17 acceptance
   ("written ToU/permissions approval + separate manual test") is therefore the correct gate, and the
   approval must be about the clause as it reads on the day of the experiment.
2. **Allowed initial path stays manual.** The Codex task already limits Phase 4 to: the user logs in
   personally, deliberately copies or exports via the official UI, or manually pastes a draft. Nothing in
   this research contradicts that. It is the path least likely to trigger the extraction, protective-measure
   and credential clauses, but "least likely" is not a clearance.
3. **No credential or session handling in GCR.** Credential or account sharing clauses (consumer and
   business) are reported. GCR must never ask for, store, log or transmit passwords, cookies, bearer
   tokens or Admin keys for the consumer product, and must not offer hosted multi-user access
   through one account.
4. **Do not port CCR's evasion techniques** (section 7). Bypassing protective measures and rate limits is
   reported as prohibited in consumer terms, business terms and the agent policy page.
5. **Draft insertion and sending.** The spec says an MCP write must never silently send. Separately, a
   send that is automated may collide with the extraction and human-generated-output items (2.2) and
   with rate-limit language. No supported OpenAI route for third-party automated sending into the
   consumer UI was found. Per Codex task: if no compliant route exists, ship local drafts plus a direct
   URL for manual continuation. Do not claim live send is verified.
6. **API-owned conversations (Provider D) are a different, documented surface** (section 4). It needs the
   operator's own API key and the API/Services terms, and covers only conversations created through the
   API. Do not present it as access to `chatgpt.com/c`. Do not target the Assistants API: its announced
   sunset date (2026-08-26) has already passed (unverified whether executed).
7. **Workspace data goes through the Compliance route** (section 5), by an owner-issued key and likely a
   separate agreement. GCR should document it as an out-of-band ingestion source (admin-supplied files),
   not a feature GCR calls live.
8. **Export is the supported personal-data route** (section 3). GCR's core ingestion (FR-02) rests on it.
   Document delivery delay and link expiry as operator-facing facts to re-verify.
9. **Output use.** The reported competing-models item (2.2) is irrelevant to local search and graph
   features, but should be mentioned as a reason GCR does not fine-tune or train on user exports.
10. **Terms drift.** The reported 30-day notice and the unresolved version question mean
    `SECURITY_AND_BOUNDARIES.md` should store the clause text, its URL, section, the date it was read,
    and the document's own effective date, and should carry a review-by date.

## 9. (b) Checklist for the human operator before ANY browser-interaction experiment

Complete and record every item in `docs/DECISIONS.md` (or an ADR). Do not start the experiment until
all are ticked. Agents must not tick these on the operator's behalf.

- [ ] Open the live consumer Terms of Use for **your jurisdiction** (ROW vs EU/UK variant). Record URL, the document's stated effective date, the date you read it, and a saved copy (PDF or text) kept outside Git.
- [ ] Copy verbatim, with section numbers, the clauses on: automated or programmatic extraction of data or Output; interference with the Services and circumvention of rate limits or protective measures; account and credential sharing; suspension or termination.
- [ ] Read the live Usage Policies, and the Services Agreement/Service Terms if any workspace, business or API account is involved. Record dates.
- [ ] Confirm the account type (Free, Go, Plus, Pro, Business, Enterprise, Edu, Healthcare). If it is a workspace account, get **written** permission from the workspace owner or admin, and use the Compliance route instead if conversation content is needed.
- [ ] Ask OpenAI Support (or your counsel) in writing whether the specific experiment (name the exact mechanism: extension, DOM read, manual paste, automated insertion) is permitted. Keep the reply. Silence or a generic reply is a "no" for the purposes of FR-17.
- [ ] Take a fresh **official export** of the account first (and verify the ZIP opens) so nothing depends on the experiment. Know the in-app and Privacy Portal deletion routes in case you want to remove data afterward.
- [ ] Accept the account risk personally: the terms reportedly allow suspension or termination. Use only your own account. Do not create extra accounts to avoid enforcement or limits.
- [ ] Define the protocol in writing: one conversation, human-initiated, human-paced, attended, no loops, no schedule, no bulk or sync, a stop rule if any CAPTCHA, challenge, warning, rate-limit or error appears.
- [ ] Confirm the experiment will **not**: capture or store credentials or cookies; read or replay tokens; call private or undocumented endpoints; modify headers or user agent; hide automation (no webdriver spoofing); defeat bot protection; send a message without a human reviewing and clicking.
- [ ] Review Chrome extension permissions and Chrome Web Store policy yourself if an extension is involved: minimal host permissions, no remote code, no broad `<all_urls>` access. (Not researched here.)
- [ ] Confirm feature flag default is OFF, the code path is absent from the default build, CI has no network access to ChatGPT, no secrets, and no real exports in tests.
- [ ] Check privacy: the conversation may contain third-party personal data or confidential material. Store only locally, outside Git, and apply GCR's redaction and retention settings.
- [ ] Re-open the live terms on the day of the experiment and confirm nothing changed since step one.
- [ ] Record the outcome, including negative outcomes, as *tested* or *untested* in the changelog. Do not report a "verified live send" unless a human saw the message appear and authorized it.

## 10. (c) Things I could not verify

1. **Every verbatim OpenAI clause.** No primary page was fetched. Everything in 2.2 to 5 is a paraphrase of search-tool output, and this file reproduces no OpenAI sentence or clause (see the banner).
2. The **current effective date and version** of the consumer Terms of Use as of 2026-10-10 (search showed an effective date of 1 January 2026 with a marker that labels it a previous version; the EU variant was reported as updated on 16 January 2026).
3. Whether the extraction clause is in the **current** terms, its exact wording, section number, and whether the defined term for model output covers conversation transcripts.
4. The exact wording of the rate-limit, protective-measure and credential-sharing clauses in consumer terms, EU terms and the Services Agreement.
5. Whether the Usage Policies (reported effective 2025-10-29) contain anything about automation or circumvention. One summary said it found no such provision.
6. The help-center export article's actual text, the reported delivery time (up to 7 days) and link expiry (24 hours), ZIP file names and contents, and any plan-specific differences.
7. Privacy Portal URL and exact flow; the deletion timing statement.
8. Whether any OpenAI document explicitly says that API/Conversations objects do **not** include `chatgpt.com/c/<id>` conversations (the claim in section 4 is an inference).
9. The exact Compliance API endpoint paths, auth header, rate limits and plan eligibility; the reported dates 5 March 2026 and 5 June 2026; the `api.chatgpt.com/v1` base URL.
10. Whether the Assistants API sunset (2026-08-26) actually occurred.
11. OpenAI's position on user-installed browser extensions or Playwright automation of chatgpt.com (no document found).
12. Chrome Web Store / Chrome extension policy: not researched.
13. The purpose of CCR's POST/PUT calls at `src/api/client.ts:159,170,190` (not inspected).
14. Anything about jurisdiction-specific data-portability rights (for example GDPR Article 20). Not researched; do not cite without a source.

## 11. URLs for a network-enabled re-check (fetch each; record date and section numbers)

Hosts to allow in the environment: `openai.com`, `help.openai.com`, `platform.openai.com`,
`developers.openai.com`, `cdn.openai.com`, `privacy.openai.com`, `community.openai.com` (optional, non-authoritative).

- https://openai.com/policies/terms-of-use/ and https://openai.com/policies/row-terms-of-use/
- https://openai.com/en-GB/policies/eu-terms-of-use/
- https://openai.com/policies/usage-policies/
- https://openai.com/policies/services-agreement/ and https://cdn.openai.com/osa/openai-services-agreement.pdf
- https://openai.com/policies/service-terms/
- https://openai.com/policies/using-chatgpt-agent-in-line-with-our-policies/
- https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data
- https://help.openai.com/en/articles/7730893-data-controls-faq
- https://help.openai.com/en/articles/6378407-how-to-delete-your-account
- https://help.openai.com/en/articles/20001488-privacy-center-in-chatgpt
- https://help.openai.com/en/articles/9261474-compliance-api-for-enterprise-customers
- https://help.openai.com/en/articles/20001407-managing-admin-keys-in-admin-console
- https://help.openai.com/en/articles/8541941-terms-of-use-updates
- https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety
- https://developers.openai.com/api/docs/guides/conversation-state
- https://developers.openai.com/api/reference/resources/conversations/methods/create
- https://developers.openai.com/api/docs/deprecations
- https://developers.openai.com/cookbook/examples/chatgpt/compliance_api/logs_platform

All URLs above were returned by the WebSearch tool on 2026-10-10 and none was fetched.
