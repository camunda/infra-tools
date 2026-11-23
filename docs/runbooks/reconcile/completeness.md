# Reconcile: completeness

## Likely causes

- A build job failed or timed out before handing its failure over (a push failure, a setup step, a timeout): the version is neither published nor a tool failure. The push failure issue has its error, or `No log:` when the job could not report it.
- The check could not plan (an upstream or registry error past the retries): see the plan runbook's causes.

## Procedure

1. Read the versions the error above lists, then the build job of each in the run (`Publish <tool> <version>`).
2. If a build job failed or was cancelled, follow its push failure issue, or start a run.
3. Check what the next run plans, from the repository root: `GITHUB_TOKEN="$(gh auth token)" node scripts/plan.mjs --image ghcr.io/camunda/infra-tools`.
4. Start a run: `gh workflow run reconcile.yml -R camunda/infra-tools`.

## Verify

The next reconciler run builds the versions again, publishes them or tracks them in their tool failure issue, its completeness check passes, and it closes this issue with a comment.

## Agents

An agent may read the logs, run the local plan and start a reconciler run with `gh workflow run reconcile.yml -R camunda/infra-tools` unattended; anything else needs a person.
