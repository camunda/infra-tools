# Self-hosted runners use `/opt/hostedtoolcache` as tool cache

Self-hosted runners use `/opt/hostedtoolcache` as their tool cache, the same path as GitHub-hosted runners, instead of the runner's default `_work/_tool`. Some prebuilt tools only run from that path (GitHub's Python builds), and later image volumes can be mounted at `/opt/hostedtoolcache/<folder>/<version>` straight from tool images (ADR 0003). The change lives in the runner pod spec, not in the runner image: an `emptyDir` volume mounted at `/opt/hostedtoolcache` in both the `runner` and `dind` containers, with `RUNNER_TOOL_CACHE` and `AGENT_TOOLSDIRECTORY` pointing to it.

## Considered Options

- **Keep `_work/_tool`**: no change, but path-bound tools break on self-hosted runners only, and every such tool needs its own workaround.
- **Set the path in the runner image** (`ENV` plus a writable folder): `container:` jobs lose the tool cache, because the dind daemon resolves the bind-mounted path inside its own container; it also ties the change to an image release.

## Consequences

Steps that delete `/opt/hostedtoolcache` to free disk space (seen on GitHub-hosted runners in a few repositories) would wipe installed tools if they ever ran on self-hosted runners. Caches keyed on the tool cache path miss once after the switch.
