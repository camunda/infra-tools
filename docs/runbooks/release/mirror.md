# Release: mirror

## Likely causes

- The login to the mirror failed (`MIRROR_TOKEN_<NAME> is not set`): for Artifact Registry, the Workload Identity Federation provider or `infra-tools-mirror-sa` lost its binding or its write access to the repository; for ECR, the IAM role `infra-tools-mirror` lost its trust in the GitHub OIDC provider or its push access to the repository (`camunda/infra-core`). Both trust `main` only, through the repository's immutable OIDC subject (`repo:camunda@2443838/infra-tools@1419738074:ref:refs/heads/main`). See the log of the mirror's login steps (`Authenticate to Google Cloud`; `Authenticate to AWS`, `Log in to ECR`).
- The mirror holds another index under the tag, such as the earlier index of a retargeted draft, and refuses to replace it: its tags are immutable (Artifact Registry `immutable_tags`, ECR `image_tag_mutability`). The release replaces such a tag; turn immutable tags off in `camunda/infra-core`.
- The mirror refuses the push (`HTTP 401`, `HTTP 403`) or kept failing past the retries (`HTTP 5xx`, `HTTP 429`): check the cloud's status page; the next run copies the index.

A mirror outage delays the release: a release is published only once every mirror holds its index (ADR 0007, D65). Runners keep the previous release meanwhile.

## Procedure

1. Read the error above and the log of the mirror's login steps in the run.
2. For a login or permission problem, fix the service account and its binding (Artifact Registry), the IAM role and its trust policy (ECR), or the repository settings in `camunda/infra-core`; for an outage, wait for it to end.
3. Start a run: `gh workflow run release.yml -R camunda/infra-tools`.

## Verify

The next release run copies `<release>-tools` to the mirror with the same digest as on `ghcr.io`, publishes the release, and closes this issue with a comment.

## Agents

An agent may read the logs and start a release run with `gh workflow run release.yml -R camunda/infra-tools` unattended; service account, IAM role and repository changes need a person.
