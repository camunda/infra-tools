# Tool failure

## Likely causes

- Upstream changed its archive name, layout or download URL from a version on: add an `if version ≥ X` branch in `tools/<tool>/install.sh` (D22).
- The tool's test no longer matches the version (a renamed binary, a new version output, a new runtime requirement): adapt `tools/<tool>/test.sh`, or its `test.packages` in `tools/<tool>/tool.json`.
- The shared build (`build/`, `scripts/build.mjs`, `scripts/lib/build.mjs`) changed and broke every version of a tool: fix the build.
- The version is broken upstream (withdrawn, incomplete, or missing a file every other version has): ignore it.
- Upstream was unreachable for the whole build: the next run builds the version again; if the error is gone, the issue closes by itself.

## Procedure

1. Read the error of each version above, and compare it with the last version of the line that built (its tool release, `gh release list -R camunda/infra-tools`).
2. Reproduce one version locally, from the repository root (needs a Buildx builder with the `docker-container` driver): `node scripts/build.mjs <tool> <version>`.
3. Fix it in one of two ways, in a pull request whose description refers to this issue (`Refs #<issue>`, not `Closes`: the reconciler closes it once the versions are published):
   - Change the build: usually an `if version ≥ X` in `tools/<tool>/install.sh` or `tools/<tool>/test.sh`. The PR's checks build and test every planned version of the tool, so they pass only once every failing version builds.
   - Ignore the versions: add them to the `ignoredVersions` of their line in `tools/<tool>/tool.json`, and say why in the line's `reason`. They are never published; the PR checks stop building them.
4. Merge the PR once its checks pass: the next reconciler run publishes the versions, or leaves the ignored ones out.

## Verify

The next reconciler run after the merge (`gh workflow run reconcile.yml -R camunda/infra-tools`, or the push to `main`) publishes each version (`published/<tool>.json`, a tool release `<tool>-<version>-r<revision>`) or no longer plans it, and closes this issue with a comment. Closing it by hand changes nothing: a run reopens it while a version still fails. A tool removed from `tools/`, or a major no line holds any more, is checked by no run: close its issue by hand.

## Agents

An agent may run `node scripts/build.mjs` and read the logs, the tool definition and the tool releases unattended, and may open the pull request; merging it, and ignoring a version, need a person's review.
