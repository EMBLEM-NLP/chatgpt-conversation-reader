# Importing your first real export

GCR has only ever been run on synthetic data (`docs/ACCEPTANCE.md` section 6). The first real export is the most valuable test it can get, and the one most likely to find something. This page is how to do it without putting your conversations anywhere they should not be.

## Who logs in

**You do, in your own browser, on your own machine.** GCR (and the agent that built it) never logs in to ChatGPT, never handles your password, session cookie or token, and has no code that could (`AGENTS.md`, `docs/SECURITY_AND_BOUNDARIES.md`, `docs/BROWSER_GATE.md`). The route is OpenAI's own export feature: you request the export from your account, OpenAI prepares an archive, you download it. Check the current steps, plan eligibility and delivery time in OpenAI's Help Center article on exporting your data (https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data); what this repository says about them is second-hand and unverified.

## Steps (all on your machine)

1. **Download the archive** to a private folder that is **not inside any Git repository** and not synced to a shared drive (`~/private/chatgpt-export.zip`). Do not unpack it unless you want to.
2. **Check your setup:** `node --version` (22.16.0 or newer), then in a clone of this repository `npm ci && npm run build`, then `node dist/cli/main.js doctor`.
3. **Import into a database that lives next to the archive**, never in the repository:
   ```bash
   node dist/cli/main.js import ~/private/chatgpt-export.zip --db ~/private/gcr.sqlite --format json > ~/private/import-report.json
   echo "exit code: $?"
   ```
   A failure prints a coded error (no conversation text, by design) and a non-zero exit code; see `docs/CLI_REFERENCE.md` for the exit-code table. Nothing is written to the archive. An import is atomic: if it fails you get no half-filled database.
4. **Read the content-free summary** of the import and look at it yourself first:
   ```bash
   node scripts/import-summary.mjs ~/private/import-report.json
   ```
5. **Then try the commands you care about** against the database: `gcr list`, `gcr search "<a word you remember>"`, `gcr get <uuid>` for a conversation with a branch, `gcr branches <uuid>`, `gcr stats --group-by model`, `gcr audit`. Compare what GCR shows with what you see in ChatGPT for two or three conversations you know well: titles, order of messages, the branch you consider "the" answer, the model. Differences are findings.

## What to send back

Send **only** the output of step 4 (`import-summary.mjs`) and, for a failure, the error code, its message and the exit code. The summary is an allow-list: counts, the observed format profile (layout, whether `children` and `current_node` are present, role counts, how many messages have a model name, a recipient, a status ...) and warning codes with counts. It leaves out ids, titles, account labels, warning messages and every piece of text. That is enough to check the assumptions in `docs/IMPORT_FORMAT.md` and to see which warnings a real export raises.

Do **not** send, commit or upload: the archive, the database (`gcr.sqlite`, `-wal`, `-shm`), the full import report, output of `get`, `thread`, `search` or `graph export`, screenshots of your conversations, or anything from a ChatGPT page. Do not put the archive into a cloud coding session, CI or a chat. `node scripts/privacy-scan.mjs` and the opt-in git hooks (`node scripts/install-git-hooks.mjs`) exist to catch an accident in a repository; they are not a reason to rely on luck.

## What a real export can settle

These are the open questions of `docs/research/chatgpt-export-format.md` section 14, with where to look:

| Question | Where the summary or the CLI answers it |
|---|---|
| Which files the archive holds, nested or flat, sharded or not | `files[].name`, `formatProfile.layout`, `formatProfile.manifest` |
| Are `children` and `current_node` always present? | `nodesWithChildrenDeclared` / `nodesWithChildrenAbsent`, `conversationsWithCurrentNode` vs `conversations`, warning codes `CHILDREN_ABSENT`, `NO_CURRENT_NODE` |
| Which roles, models, recipients and statuses occur | `roleCounts`, `messagesWithModelSlug`, `messagesWithRecipient`, `messagesWithStatus`; `gcr stats --group-by model`; `gcr audit` (unknown roles and content types) |
| Hidden or system messages, odd roots | `hiddenMessages`, `rootIsLiteralClientCreatedRoot` |
| Assets and auxiliary files | `auxiliaryFilesIgnored`, `assetsExtensionless` |
| Broken trees, duplicates, bad timestamps | the warning codes (`docs/WARNING_CODES.md` explains each) and `gcr audit` |
| Anything else (attachment naming, `shared_conversations.json`, `model_comparisons.json`, timestamp forms in auxiliary files) | not exposed by the CLI today: it needs a code change after you have seen the summary |

Each answer becomes a row in `docs/PARITY_MATRIX.md` (status `supported` instead of `synthetic-only`) once there is a fixture that reproduces it. Write that fixture by hand from the shape, never from your content.

## If you want a second pair of eyes on the data

Do the inspection yourself on your machine, or run Claude Code locally on a **copy of the repository without the archive or database in it** and paste only the summary. GCR's MCP server is local and read-only by default (`docs/MCP_TOOLS.md`), but any language-model client that reads your conversations through it sees them: that is a decision about your data, not about GCR.
