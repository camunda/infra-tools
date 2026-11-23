# infra-tools

Publishes the tools CI jobs need as OCI artifacts in registries next to the runners, and installs them in jobs with one action step, on GitHub-hosted and self-hosted runners alike ([camunda/team-infrastructure#1138](https://github.com/camunda/team-infrastructure/issues/1138)).

Work in progress: phase 1 is tracked in [#7](https://github.com/camunda/infra-tools/issues/7). The PoC implementation is on the [`poc`](https://github.com/camunda/infra-tools/tree/poc) branch.

- [Spec](docs/spec.md)
- [Glossary](GLOSSARY.md)
- [Architecture decisions](docs/adr/)

## Publication

The [Reconcile](.github/workflows/reconcile.yml) workflow publishes every upstream version within the version lines of `tools/*/tool.json`, every 6 hours, on push to `main` and on demand: it builds, tests and pushes each missing tool image to `ghcr.io/camunda/infra-tools`, creates its tool release, and records it in `published/<tool>.json` with one commit per run, pushed to `main` by the Infra - Misc App. Run it now:

```sh
gh workflow run reconcile.yml
```

See what the next run would publish (reads upstream, the registry and the fix PRs, with a token that can read the package):

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/plan.mjs --image ghcr.io/camunda/infra-tools --repository camunda/infra-tools
```

### Fix a tool version that fails to build

A version that fails to build or test gets a fix PR (label `tool-build`), opened by the Infra - Misc App, with the failing step, a log excerpt and the run link; a version of the same tool and major failing with the same error joins it. Push the fix to its branch, usually an `if version ≥ X` in `install.sh` or `test.sh`: merging publishes the version on the next run. Every run builds the version again until then: the reconciler comments when its error changes, and closes the fix PR once it builds. Closing a fix PR without merging ignores its versions. Any other reconciler failure, including a version in range neither published nor tracked, fails the run, with guidance in its job summary; Slack alerting is not wired yet.

## Releases

Record commits and action changes keep a release-please release PR open ([Release](.github/workflows/release.yml), config in `.github/config/`). Every day, the [Release merge](.github/workflows/release-merge.yml) workflow enables GitHub auto-merge on it as the Infra - Releases App (the repository setting "Allow auto-merge" must be on): GitHub merges it once its required checks pass; a release PR still open the next day (a required check fails), or any other failure of the workflow, alerts `#infra-alerts`. The merge creates release `X.Y.Z` as a draft, without its tag, which the Release workflow then publishes: the `X.Y.Z-tools` index pushed to `ghcr.io/camunda/infra-tools` (the previous release's index, plus the catalog, minus retired versions), the Added / Replaced / Retired tables added to the release notes, `tools.json` attached, and the draft published last, which creates tag `X.Y.Z`. The action installs from the index of the release it is pinned to; the action tests use the latest published release's.

### Build a tool version locally

Build and test a tool version locally, for both platforms (needs a Buildx builder with the `docker-container` driver):

```sh
cd scripts && node build.mjs maven 3.9.16
```

## Mirrors

Self-hosted runner sets read the index and tool layers from a mirror of `ghcr.io` in their own cloud ([ADR 0007](docs/adr/0007-ghcr-source-registry-with-mirrors.md)), set once per runner set with `INFRA_TOOLS_MIRROR` in the runner environment; workflows don't change. The log shows the registry each tool came from; when the mirror fails, the action warns and falls back to `ghcr.io`. A job opts out with `INFRA_TOOLS_MIRROR: ""` in its `env`.

| Runners | Mirror | Managed in |
| --- | --- | --- |
| GKE (`camunda-ci`) | Artifact Registry repository `europe-west1-docker.pkg.dev/ci-30-162810/infra-tools`, read with the runner pod's Workload Identity | [`camunda/infra-core`](https://github.com/camunda/infra-core): `camunda-ci/terraform/google/prod/artifact-registry-repository.tf`, `INFRA_TOOLS_MIRROR` in the runner sets' `default-config` |

The `mirror` job of the [Release](.github/workflows/release.yml) workflow fills it: on every push to `main`, after the releases are published, it copies each release index the mirror lacks, with its manifests and layers, logged in with GitHub OIDC as `infra-tools-mirror-sa`. No credential is stored. A failed copy fails only that job, and the next run copies it; GKE runners use `ghcr.io` meanwhile. Another mirror filled the same way is one more entry in that job's matrix, with a login step for its cloud.

## Development

Prerequisites: the Node.js version pinned in [`.tool-versions`](.tool-versions) (`asdf install`), [pre-commit](https://pre-commit.com) and `make`. `make help` lists the targets.

Run the tests (Node.js [`node:test`](https://nodejs.org/api/test.html) suites in `scripts/test/`, after installing the dependencies of `scripts/` when its lock file changed):

```sh
make test
```

Run a single test file:

```sh
cd scripts && node --test test/renovate.test.mjs
```

Run the linters (the pre-commit hooks, the same ones as in CI):

```sh
make lint
```

Install the hooks once to run them, and the commit message check, on every commit:

```sh
pre-commit install
```
