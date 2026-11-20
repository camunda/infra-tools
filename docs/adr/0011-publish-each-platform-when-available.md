# Publish each platform when available

A version is published as soon as one platform has it, as revision 1 with the platforms available. When a missing platform appears upstream, the reconciler builds only that platform and publishes the next revision as an image index that points at the existing platforms' manifests and layers (same digests) next to the new one, so the next catalog index replaces the previous revision and consumers on the existing platforms keep their digest. The reconciler derives that revision from the registry (the highest published tag plus one, or the manual `revisions` value when higher) and never commits to `tool.json`. A platform still missing after 7 days is reported as a warning in the reconciler's job summary, and the completeness check counts it as tracked. This replaces D28, which held a version back until every platform had it and never opened its fix PR, so one missing platform blocked every runner and nobody was told.

## Considered Options

- **Wait for every platform, fix PR after N days** (D28): blocks every platform on the slowest one, and a fix PR has nothing to change in the repository.
- **Commit the revision bump to `tool.json`**: adds a bot commit per late platform that can race with human edits to the same file.

## Consequences

- `node@26` can resolve to different versions per platform, and an exact selector fails on a platform that lacks it, with an error saying the version is not published for that platform yet.
- `minAge` applies once per version, from its upstream release date; a late platform is published right away.
- Each late platform produces a new revision, catalog index update and release.
- A platform that upstream never publishes stays in the job summary warning on every run.
- A manual `revisions` value must be above the highest published revision: the PR check fails otherwise, and the reconciler refuses to overwrite a tag.
