# Release: undraft

## Likely causes

- The infra-releases App token lacks `workflows: write` (`HTTP 403`, `refusing to allow a GitHub App to create or update workflow`): the draft's target changes a workflow file and is no longer a branch head (D64). Check the App's installation permissions.
- The tag exists already (`HTTP 422`, `already_exists`): a tag `<release>` was pushed by hand, on another commit than the draft's target. Delete the tag if it was a mistake, or retarget the draft.
- The GitHub API kept failing past the retries (`HTTP 5xx`, `HTTP 429`): check [githubstatus.com](https://www.githubstatus.com); the next run publishes the draft.

## Procedure

1. Read the error above and the failed step of the run.
2. Check the tag and the draft: `gh api repos/camunda/infra-tools/git/ref/tags/<release>` and `gh api repos/camunda/infra-tools/releases --paginate --jq '.[] | select(.draft) | "\(.id) \(.tag_name) \(.target_commitish)"'`.
3. For a permission, fix the App's installation; for a stray tag, delete it with `gh api -X DELETE repos/camunda/infra-tools/git/refs/tags/<release>`; for an outage, wait for it to end.
4. Start a run: `gh workflow run release.yml -R camunda/infra-tools`.

## Verify

The next release run publishes the release as the latest (`gh release view <release> -R camunda/infra-tools`), which creates tag `<release>` on the draft's target, and closes this issue with a comment.

## Agents

An agent may read the logs, the tag and the draft, and start a release run with `gh workflow run release.yml -R camunda/infra-tools` unattended; App permission changes and deleting a tag need a person.
