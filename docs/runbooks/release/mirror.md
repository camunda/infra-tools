# Release: mirror

## Likely causes

- The login to the mirror failed (`MIRROR_TOKEN_<NAME> is not set`): for Artifact Registry, the Workload Identity Federation provider or `infra-tools-mirror-sa` lost its binding or its write access to the repository (`camunda/infra-core`). See the log of the mirror's login step.
- The mirror holds another index under the tag, such as the earlier index of a retargeted draft, and refuses to replace it: its tags are immutable (Artifact Registry `immutable_tags`). The release replaces such a tag; turn immutable tags off in `camunda/infra-core`.
- The mirror refuses the push (`HTTP 401`, `HTTP 403`) or kept failing past the retries (`HTTP 5xx`, `HTTP 429`): check the cloud's status page; the next run copies the index.

A mirror outage delays the release: a release is published only once every mirror holds its index (ADR 0007, D65). Runners keep the previous release meanwhile.

## Procedure

1. Read the error above and the log of the mirror's login step in the run.
2. For a login or permission problem, fix the service account, its binding or the repository settings in `camunda/infra-core`; for an outage, wait for it to end.
3. Start a run: `gh workflow run release.yml -R camunda/infra-tools`.

## Verify

The next release run copies `<release>-tools` to the mirror with the same digest as on `ghcr.io`, publishes the release, and closes this issue with a comment.

## Agents

An agent may read the logs and start a release run with `gh workflow run release.yml -R camunda/infra-tools` unattended; service account and repository changes need a person.
