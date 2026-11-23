# Reconcile: record

## Likely causes

- A tool image was built with another `install` block than its tool definition's (`its tool image was built with another install block`): an earlier run pushed it, then the `install` block changed without a revision bump. Bump the version's revision in `tools/<tool>/tool.json` to build it again.
- A tool image has no build commit (`its tool image has no build commit`, the `org.opencontainers.image.revision` annotation): it was pushed before the annotation existed; bump its revision.
- The record commit could not be pushed to `main`: the Infra - Misc App is no longer a bypass actor of the `main` ruleset (D49), or its token could not be generated from Vault (`secret/data/products/infra/ci/team-infrastructure`).
- A tool release could not be created (`HTTP 422`): its tag exists on another commit.
- `ghcr.io` or the GitHub API kept failing past the retries: the next run records every published tool image the catalog lacks.

## Procedure

1. Read the error above and the failed step of the Record job in the run.
2. Run the record locally, from the repository root, on an up-to-date `main` (it writes `published/` and `build/out/reconcile/`, and commits nothing): `GITHUB_TOKEN="$(gh auth token)" node scripts/record.mjs --image ghcr.io/camunda/infra-tools`, then `git checkout published`.
3. For an `install` block or annotation problem, bump the revision in a pull request; for the ruleset or the App, fix their settings; for an outage, wait for it to end.
4. Start a run: `gh workflow run reconcile.yml -R camunda/infra-tools`.

## Verify

The next reconciler run records the published tool versions (a record commit on `main`, or "Nothing to record.") and closes this issue with a comment.

## Agents

An agent may read the logs, run the local record and discard its changes, and start a reconciler run with `gh workflow run reconcile.yml -R camunda/infra-tools` unattended; revision bumps, ruleset, App and Vault changes need a person.
