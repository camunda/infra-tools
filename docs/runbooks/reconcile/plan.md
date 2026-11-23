# Reconcile: plan

## Likely causes

- An upstream datasource is down or answers nothing for a tool (`<tool>: no upstream versions from <datasource>`): wait for upstream; the next run plans again.
- A version in a line's `versions` or `revisions` is not found upstream (`<tool>: not found upstream`): a typo, or a version upstream delisted. Fix the line in `tools/<tool>/tool.json`.
- A catalog version lost its tag (`published versions lost their tag`): a tool image was deleted from `ghcr.io/camunda/infra-tools`. Published tool images never change: restore the tag from a mirror or a backup, or retire the version and bump its revision to publish it again.
- A tool definition is invalid (`tools/<tool>/tool.json: ...`): it was merged without passing the PR checks; fix it.
- The registry kept failing past the retries (`HTTP 5xx`, `HTTP 429`): check [githubstatus.com](https://www.githubstatus.com); the next run plans again.

## Procedure

1. Read the error above and match it with a likely cause.
2. Run the plan locally, from the repository root, with a token that can read the package: `GITHUB_TOKEN="$(gh auth token)" node scripts/plan.mjs --image ghcr.io/camunda/infra-tools`.
3. For a tool definition or tag problem, fix it in a pull request; for an outage, wait for it to end.
4. Start a run: `gh workflow run reconcile.yml -R camunda/infra-tools`.

## Verify

The next reconciler run plans (its Plan job passes) and closes this issue with a comment.

## Agents

An agent may run the local plan, read the logs and start a reconciler run with `gh workflow run reconcile.yml -R camunda/infra-tools` unattended; changes to a tool definition or to the registry need a person.
