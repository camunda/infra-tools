# Release: drafts

## Likely causes

- A draft lost its tag name (`has tag name untagged-<hash>, not X.Y.Z`): it was updated without its `tag_name`, through the GitHub UI or the API, and GitHub reset it. Restore it with the command in the error.
- Two drafts exist (`2 draft releases, 1 at most`): a draft was created by hand, or release-please created the same release twice after a failed run. Keep the draft of the latest merged release PR, named after the release-please manifest version (`.github/config/.release-please-manifest.json` on `main`), and delete the other.
- A draft of a release that will never be published, such as a test: delete it.

## Procedure

1. List the drafts with their id, tag name and target: `gh api repos/camunda/infra-tools/releases --paginate --jq '.[] | select(.draft) | "\(.id) \(.name) \(.tag_name) \(.target_commitish)"'`.
2. For a lost tag name, restore it from the release name, on the same target: `gh api -X PATCH repos/camunda/infra-tools/releases/<id> -f tag_name=<X.Y.Z> -f target_commitish=<sha>`.
3. For an extra draft, delete it: `gh api -X DELETE repos/camunda/infra-tools/releases/<id>`.
4. Start a run: `gh workflow run release.yml -R camunda/infra-tools`.

## Verify

The next release run publishes the draft left, or finds none, and closes this issue with a comment; release-please then opens the next release PR when there are commits to release.

## Agents

An agent may list the drafts, read the logs and start a release run with `gh workflow run release.yml -R camunda/infra-tools` unattended; restoring a tag name and deleting a draft need a person.
