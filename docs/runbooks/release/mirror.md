# Release: mirror

## Likely causes

- The mirror's tag points to other content (`<mirror>:<release>-tools is sha256:..., not sha256:... as on ghcr.io/camunda/infra-tools`): the index was copied, then rebuilt on `ghcr.io` for a retargeted draft, or written by hand. Delete the mirror's tag; the next run copies the index again.
- The login to the mirror failed (`MIRROR_TOKEN_<NAME> is not set`): for Artifact Registry, the Workload Identity Federation provider or `infra-tools-mirror-sa` lost its binding or its write access to the repository (`camunda/infra-core`). See the log of the mirror's login step.
- The mirror refuses the push (`HTTP 401`, `HTTP 403`) or kept failing past the retries (`HTTP 5xx`, `HTTP 429`): check the cloud's status page; the next run copies the index.

A mirror outage delays the release: a release is published only once every mirror holds its index (ADR 0007, D65). Runners keep the previous release meanwhile.

## Procedure

1. Read the error above and the log of the mirror's login step in the run.
2. For a tag with other content on the Artifact Registry mirror, delete it: `gcloud artifacts docker tags delete europe-west1-docker.pkg.dev/ci-30-162810/infra-tools/camunda/infra-tools:<release>-tools`.
3. For a login or permission problem, fix the service account or its binding in `camunda/infra-core`; for an outage, wait for it to end.
4. Start a run: `gh workflow run release.yml -R camunda/infra-tools`.

## Verify

The next release run copies `<release>-tools` to the mirror with the same digest as on `ghcr.io`, publishes the release, and closes this issue with a comment.

## Agents

An agent may read the logs and start a release run with `gh workflow run release.yml -R camunda/infra-tools` unattended; deleting a mirror tag and changing a service account need a person.
