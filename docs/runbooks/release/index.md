# Release: index

## Likely causes

- A catalog version lost its tag (`<tool> <version>: tag <tag> not found`) or a platform layer (`has no layer for <platform>`): a tool image was deleted from `ghcr.io/camunda/infra-tools`, or the catalog at the draft's target lists one that was never pushed. Published tool images never change: restore the tag, or retire the version in a pull request.
- A layer changed without a higher revision (`layer changed without a higher revision`): a tool image tag was overwritten. Bump the version's revision in `tools/<tool>/tool.json`.
- A tool definition at the draft's target is invalid (`tools/<tool>/tool.json: ...`): fix it on `main`.
- `ghcr.io` or the GitHub API kept failing past the retries (`HTTP 5xx`, `HTTP 429`): check [githubstatus.com](https://www.githubstatus.com); the next run pushes the index.

The index is built from the tool definitions and the catalog at the draft's target commit, so a fix merged to `main` reaches the release only once its draft is retargeted to that commit (ADR 0013).

## Procedure

1. Read the error above and match it with a likely cause.
2. Find the draft's id and target: `gh api repos/camunda/infra-tools/releases --paginate --jq '.[] | select(.draft) | "\(.id) \(.tag_name) \(.target_commitish)"'`.
3. For an outage, wait for it to end and go to step 6.
4. Fix the cause on `main` in a pull request (a revision bump, a retired version, a tool definition fix), and wait for the reconciler to record what it publishes.
5. Retarget the draft to the commit of `main` that holds the fix, keeping its tag name: `gh api -X PATCH repos/camunda/infra-tools/releases/<id> -f tag_name=<release> -f target_commitish=<sha>`. A retargeted release whose index changed fails on each mirror that already holds its earlier index: delete those mirror tags too (`docs/runbooks/release/mirror.md`).
6. Start a run: `gh workflow run release.yml -R camunda/infra-tools`.

## Verify

The next release run pushes `<release>-tools` to `ghcr.io/camunda/infra-tools`, publishes the release, and closes this issue with a comment. A retargeted release's tag points to the new target: `gh api repos/camunda/infra-tools/git/ref/tags/<release> --jq .object.sha`.

## Agents

An agent may read the logs, the draft and the catalog, and start a release run with `gh workflow run release.yml -R camunda/infra-tools` unattended; the fix on `main` needs a person's review, and retargeting the draft needs a person.
