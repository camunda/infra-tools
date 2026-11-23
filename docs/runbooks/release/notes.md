# Release: notes

## Likely causes

- The GitHub API kept failing past the retries (`HTTP 5xx`, `HTTP 429`), or the `tools.json` upload was cut (`uploads.github.com`): check [githubstatus.com](https://www.githubstatus.com); the next run writes the notes and uploads `tools.json` again, replacing a partial one.
- The infra-releases App token lacks a permission (`HTTP 403`, `Resource not accessible by integration`): its `contents: write`, or `workflows: write` for a draft whose target changes a workflow file and is no longer a branch head (D64). Check the App's installation permissions.
- The draft was deleted or published by hand during the run (`HTTP 404`): see the release's state before running again.

## Procedure

1. Read the error above and the failed step of the run.
2. Check the draft and its assets: `gh api repos/camunda/infra-tools/releases --paginate --jq '.[] | select(.draft) | {id, tag_name, assets: [.assets[] | {name, state}]}'`.
3. For an outage, wait for it to end; for a permission, fix the App's installation.
4. Start a run: `gh workflow run release.yml -R camunda/infra-tools`.

## Verify

The next release run writes the tool tables and `tools.json`, publishes the release, and closes this issue with a comment.

## Agents

An agent may read the logs and the draft, and start a release run with `gh workflow run release.yml -R camunda/infra-tools` unattended; App permission changes need a person.
