# GitHub repository and Codex execution runbook

## Repository choice

Create **new private repository** `EMBLEM-NLP/chatgpt-conversation-reader` (name proposed; not yet created). Import the **contents** of this ZIP's `chatgpt-conversation-reader/` folder at repository root. Keep `EMBLEM-NLP/claude-conversation-reader-public` as an unchanged source-of-truth/reference and future provider-neutral interoperability target. Do not create duplicate PRs against CCR's Claude-specific internal authentication stack.

## Local commands

```bash
# After extracting, from the repository root:
node --version
npm test
node scripts/ci-smoke.mjs
npm install --no-audit --no-fund
npm run typecheck
npm run build
# Optional only if Chromium installed:
npm run test:browser
```

`npm test` initially uses the precompiled checked-in `dist/` output; Codex must rebuild then re-run tests to verify the current TS sources. Add `package-lock.json` to make `npm ci` reproducible. The current version on disk remains **0.1.1** until implementation work passes the new acceptance gates.

## Suggested private-repo setup (run on a trusted GitHub-connected developer machine)

```bash
# Requires GitHub CLI signed in by the user, and a repository not yet created.
cd chatgpt-conversation-reader
git init
git checkout -b main
git add .
git commit -m "chore: import verified GCR 0.1.1 baseline and Codex specification"
gh repo create EMBLEM-NLP/chatgpt-conversation-reader --private --source=. --remote=origin --push
```

If repo exists, clone it first and reconcile changes; **do not** forcibly overwrite the default branch. Use short feature branches + PRs. Set branch protection/checks on main, restrict Actions permissions to read-only, disable secrets in fork PRs and enable secret scanning when available. A private GitHub repository is still remote storage: **do not upload real chat exports**.

## Codex handoff

Open the new repo in Codex, read `CODEX_START_HERE.md`, paste the work order from `CODEX_TASK.md` or point Codex at it, and ask for one milestone per PR, beginning with M0/M1. Ask the agent to report exact shell commands, code diff, tests run, failure paths and PR URL. No credentials or account approval should be provided through chat text.

## GitHub Actions / Codespaces distinction

Actions does unattended fixture-only testing, no ChatGPT login. Codespaces provides a remote interactive terminal but still does not inherently have the user's signed-in ChatGPT consumer session. To work with private exported chat data, prefer a trusted local developer computer; only use Codespaces after assessing privacy and storage.

## Existing baseline metadata

Package: `@emblem-nlp/chatgpt-conversation-reader@0.1.1`, Node ≥22.13; uses built-in Node SQLite; `.github/workflows/gcr-ci.yml` and `.devcontainer/devcontainer.json` are supplied but not verified as run on GitHub. `dist/` is included for convenience; compiled-file policy should be decided as a dedicated PR.
