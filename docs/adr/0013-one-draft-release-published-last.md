# One draft release, published last

A release is published by one job, as steps that each check their own end state and do nothing when it is already reached: release-please creates the draft `X.Y.Z` when its release PR was just merged, then the `X.Y.Z-tools` index is pushed to `ghcr.io`, copied to every mirror, the notes and `tools.json` added, and the draft published last, which creates its tag. release-please opens or updates the next release PR only once every draft is published, so there is at most one draft, and no release PR while it waits. A release is published when its GitHub release is no longer a draft: the action tests read the latest published release, never the registry tags or the release-please manifest. This keeps D60's draft as the single commit point, and fixes what it left open: a stuck draft no longer lets later releases pile up, and the next release PR's changelog is always computed from an existing tag.

The draft is fragile and is handled as such: GitHub resets the tag name of a draft updated without it (to `untagged-<hash>`), and publishing that draft creates that tag, so every update sends the draft's `tag_name` and `target_commitish`, `tools.json` is uploaded by release id, and a draft without an `X.Y.Z` tag name, or a second draft, is a run failure, never skipped. Its target is a commit `main` has moved past, and a commit changing a workflow file and no longer a branch head can only be released with the `workflows` permission, so the publishing token has it. Release 1.1.0 hit both: its first notes update reset its tag name, and every run then skipped it as no release, for three days.

The index is built from the tool definitions and the catalog at the draft's target commit, so a release always matches the commit its tag points to. A release that fails there for good is fixed on `main`, then its draft is retargeted to that commit and the run repeated: the tag is created at the new target (verified on the GitHub API). This replaces rolling back the release-please manifest.

## Considered Options

- **Roll back the manifest** for a release that cannot be published: a revert on `main`, a deleted draft and a new release PR, with release-please's behavior unverified.
- **Build the release from `main`'s tip**: no retargeting, but the index no longer matches the commit its tag points to, and a release can hold versions its changelog does not list.
- **Several drafts, published oldest first** (D60): a draft that fails for good blocks every later release, which keep piling up behind it.
- **The shared release action** (`camunda/infra-global-github-actions`, D56): it does not expose release-please's `skip-github-release` and `skip-github-pull-request`, so release-please is called directly, twice.

## Consequences

- A retargeted release's changelog misses the commits of its fix.
- A mirror outage delays the release (ADR 0007): its failure issue says so.
- The release PR shows up only after the previous release is published.
- Release names drop the `v` (`include-v-in-release-name: false`), so they match their tags.
