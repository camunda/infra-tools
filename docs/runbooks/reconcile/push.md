# Reconcile: push

## Likely causes

- `ghcr.io` kept failing past the retries (`HTTP 5xx`, `HTTP 429`, a network error): check [githubstatus.com](https://www.githubstatus.com); the next run builds and pushes the version again.
- The job token cannot write the package (`HTTP 401`, `HTTP 403`): the package lost the repository's write access in its settings (Manage Actions access).
- The tag exists already (`ghcr.io/camunda/infra-tools:<tag> already exists`): another run or workflow pushed it after the plan, which the `publish-tool-images` concurrency group should prevent; the next run finds it published and records it.
- The build job failed for another reason than a tool failure: a setup step (Node.js, QEMU, Buildx), the runner, or its 60-minute timeout (`No log:` above).

## Procedure

1. Read the error of each tool image above, and the failed build job's log in the run.
2. Check the published tags: `gh api /orgs/camunda/packages/container/infra-tools/versions --paginate --jq '.[].metadata.container.tags[]' | grep <tool>-<version>`.
3. For an outage, wait for it to end; for package access, fix the package settings; for a runner or timeout problem, look at the runner set.
4. Start a run: `gh workflow run reconcile.yml -R camunda/infra-tools`.

## Verify

The next reconciler run pushes the tool images (its build jobs pass), records them, and closes this issue with a comment.

## Agents

An agent may read the logs and the published tags and start a reconciler run with `gh workflow run reconcile.yml -R camunda/infra-tools` unattended; package settings and runner changes need a person.
