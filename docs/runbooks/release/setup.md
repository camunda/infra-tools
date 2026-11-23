# Release: setup

## Likely causes

- Vault could not be read (`Import Secrets`): the JWT role or the secret paths `secret/data/products/infra/ci/infra-releases` and `secret/data/products/infra/ci/infra-core` changed, or Vault was unreachable.
- The infra-releases App token could not be generated (`Generate a GitHub token`): its credentials in Vault were rotated, or the App lost its installation or a permission the step asks for (contents, issues, pull requests, workflows).
- release-please failed (`Create the draft release`, `Open or update the release PR`): the GitHub API kept failing, the config in `.github/config/` is invalid, or a merged release PR is still labelled `autorelease: pending`.
- Node.js or the dependencies of `scripts/` could not be installed (`Set up Node.js`, `Install dependencies`): an npm registry outage, or a lock file out of sync.

A failure of the release steps themselves (`drafts`, `index`, `mirror.<name>`, `notes`, `undraft`) has its own failure issue.

## Procedure

1. Read the failed steps above, and their logs in the run.
2. For Vault or App credentials, fix them in Vault or in the App's settings; for release-please, fix the config on `main` or the release PR's labels; for an outage, wait for it to end.
3. Start a run: `gh workflow run release.yml -R camunda/infra-tools`.

## Verify

The next release run gets past its setup to the release steps, and closes this issue with a comment.

## Agents

An agent may read the logs, the release-please config and the release PR, and start a release run with `gh workflow run release.yml -R camunda/infra-tools` unattended; Vault, App and label changes need a person.
