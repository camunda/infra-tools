______________________________________________________________________

## name: onboard-tool description: Onboard a new tool into infra-tools (tools/<tool>/tool.json, install.sh, test.sh) - check how CI repos use it today, decide every tool definition option with the requester in plain language, write it, check it quickly, and offer to open the PR. Use whenever someone wants to add, publish or onboard a tool in infra-tools (gcloud, helm, yq, python, ...), asks "can infra-tools provide X", or wants CI jobs to stop downloading a tool from upstream, even if they don't say "onboard".

# Onboard a tool

The requester often doesn't work on this repository. Use the terms of `GLOSSARY.md` and explain each in one line the first time; take option meanings from `docs/spec.md` §5.2 rather than restating them. Prefer examples from the requester's own repos over spec jargon.

Every question carries a recommendation, worded so that "ok" accepts it. Ask in numbered rounds: everything that can be decided now, nothing that depends on an open answer. Facts are your job (read code, run lookups, spawn subagents); decisions are the requester's.

## Flow

1. **Intake**: one round, before any scan, asking for the tool (with its upstream link when the name is ambiguous) and the repos to scan. Say why the scan matters: how CI installs and uses the tool today decides which versions to publish, whether its `setup-*` action stays, and which runners need it. Recommend `camunda/camunda` and `camunda/infra-core`, and say the requester can add others; don't suggest any.
2. **Usage inventory**: once the repos are confirmed, one subagent per repo, in parallel, with the prompt below. Start step 3 meanwhile.
3. **Upstream research**: where versions are listed (a Renovate datasource), the version scheme and release cadence, the download URL per architecture (`curl -sfI`), the archive layout and anything bundled.
4. **Decisions**: go through `references/decisions.md` and present each aspect as a card, in rounds.
5. **Write**: `tools/<tool>/tool.json`, `install.sh`, `test.sh` (executable), like the sibling tools. Add a row to the decisions table of `docs/spec.md` when a choice departs from a default or needed a trade-off.
6. **Quick check**: `GITHUB_TOKEN="$(gh auth token)" node .claude/skills/onboard-tool/scripts/check.mjs <tool>` (needs `npm ci` in `scripts/` once; GitHub sources need the token). It parses the definition, looks up upstream, lists what the reconciler would publish and why, and lints the files. When a result contradicts a decision (no release date, so `minAge` does nothing; a platform missing upstream; nothing planned), say so plainly and ask again. No local build: the PR's CI builds and tests every planned version.
7. **Pull request, asked last**: summarise the decisions in a table, then ask "Open the PR?" (recommend yes). On yes: branch from `main`, one commit `feat: add <tool>, a <plain|tool-cache> tool`, push, open the PR (why in one or two sentences, a bullet per decision), then watch its checks. `Dry run <tool> <version>` builds and tests on every platform and Ubuntu release, and the bot's "Next release preview" comment lists what the next release adds. On a failure, read `gh run view <id> --log-failed`, explain it plainly, propose a fix and ask before pushing it. The repository merges with rebase-and-merge: amend, never merge `main` into the branch. End with the PR URL.

## Usage inventory prompt

> Repo `<owner/repo>` (read-only; use `gh`, or a sparse clone of `.github` into the scratchpad). Inventory how GitHub Actions workflows and composite actions install and use `<tool>`, to decide how infra-tools should publish it. Report with file:line refs: (1) every install method (a `setup-*` action and its inputs, curl/wget, apt, container image, preinstalled), with counts; (2) versions pinned (exact, ranges, `latest`) and how they are updated; (3) subcommands, plugins or components used; (4) runners (GitHub-hosted, self-hosted, arm64, macOS/Windows); (5) anything the setup step does beyond installing (auth, config, PATH); (6) shared actions from other repos that install it. Facts only, no design. Under 400 words plus a ref table.

## Decision card

Put the findings once, above the round, in a few bullets. Each card is then two lines, in plain words, no option lists or config keys unless the requester asks:

```
❓ **<n>. <Aspect in plain words>**: <the choice and why, in one or two sentences>
➡️ <recommendation>
```
