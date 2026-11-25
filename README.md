# infra-tools

Publishes the tools CI jobs need as OCI artifacts in registries next to the runners, and installs them in jobs with one action step, on GitHub-hosted and self-hosted runners alike ([camunda/team-infrastructure#1138](https://github.com/camunda/team-infrastructure/issues/1138)).

Work in progress: phase 1 is tracked in [#7](https://github.com/camunda/infra-tools/issues/7). The PoC implementation is on the [`poc`](https://github.com/camunda/infra-tools/tree/poc) branch.

- [Spec](docs/spec.md)
- [Glossary](GLOSSARY.md)
- [Architecture decisions](docs/adr/)

## Publication

The [Reconcile](.github/workflows/reconcile.yml) workflow publishes every upstream version within the version lines of `tools/*/tool.json`, every 2 hours, on push to `main` and on demand: it builds, tests and pushes each missing tool image to `ghcr.io/camunda/infra-tools`, creates its tool release, and records it in `published/<tool>.json` with one commit per run, pushed to `main` by the Infra - Misc App. Run it now:

```sh
gh workflow run reconcile.yml
```

See what the next run would publish (reads upstream and the registry, with a token that can read the package):

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/plan.mjs --image ghcr.io/camunda/infra-tools
```

### Fix a tool version that fails to build

A version that fails to build or test is a tool failure: it is listed, with its error, in the failure issue of its tool and major (label `tool-failure`, [ADR 0012](docs/adr/0012-failure-issues-instead-of-fix-prs.md)), and the run stays green. Reproduce it with `node scripts/build.mjs <tool> <version>`, then fix it in a pull request that refers to the issue, usually an `if version ≥ X` in `install.sh` or `test.sh`, or ignore the version: add it to its line's `ignoredVersions` in `tool.json`, with the line's `reason`. Every run builds the version again until then, and closes the issue once it is published or ignored; closing it by hand changes nothing, a run reopens it while the version fails. Any other reconciler failure (plan, push, record, a version in range neither published nor failed) is a run failure: it fails the run and opens the failure issue of its step (label `run-failure`). Each issue carries its procedure from [`docs/runbooks/`](docs/runbooks/). Opening or reopening a tool failure issue alerts `#infra-alerts`; a run failure issue alerts it only once its step has kept failing for a day, so an outage that ends on its own calls no one.

## Releases

Record commits and action changes keep a release-please release PR open ([Release](.github/workflows/release.yml), config in `.github/config/`) while no release is waiting to be published. Every day, the [Release merge](.github/workflows/release-merge.yml) workflow enables GitHub auto-merge on it as the Infra - Releases App (the repository setting "Allow auto-merge" must be on): GitHub merges it once its required checks pass; a release PR still open the next day (a required check fails), or any other failure of the workflow, alerts `#infra-alerts`. The merge creates release `X.Y.Z` as a draft, without its tag, which the Release workflow then publishes in one job ([ADR 0013](docs/adr/0013-one-draft-release-published-last.md)): the `X.Y.Z-tools` index pushed to `ghcr.io/camunda/infra-tools` (the previous release's index, plus the catalog, minus retired versions) and copied to every mirror, the Added / Replaced / Retired tables added to the release notes, `tools.json` attached, and the draft published last, which creates tag `X.Y.Z`; only then does release-please open the next release PR. Each step does nothing once done, so running the workflow again (`gh workflow run release.yml -R camunda/infra-tools`) completes a release after any failure; a failed step opens its failure issue (label `run-failure`), with its procedure from [`docs/runbooks/release/`](docs/runbooks/release/). The action installs from the index of the release it is pinned to; the action tests use the latest published release's.

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
| EKS (`camunda-ci-eks`) | ECR repository `463214588456.dkr.ecr.eu-central-1.amazonaws.com/camunda/infra-tools`, read with the runner pod's IRSA role; `INFRA_TOOLS_MIRROR` is set once a release has filled it (#16) | [`camunda/infra-core`](https://github.com/camunda/infra-core): `camunda-ci-eks/terraform/aws/prod/ecr.tf`, the release's role in `prod/github-oidc.tf`, the read policy in `modules/env-common/policies.tf` |

The [Release](.github/workflows/release.yml) workflow fills them before it publishes a release: it copies the release's index, with its manifests and layers, logged in with GitHub OIDC as `infra-tools-mirror-sa` (Artifact Registry) and the IAM role `infra-tools-mirror` (ECR), both limited to `main`, and checks the digests. No credential is stored. A release copies only its own index, so runners pinned to a release older than their mirror fall back to `ghcr.io`, with the warning. A release is published only once every mirror holds its index, so a failed copy delays the release, in the failure issue of the mirror's step, and the next run copies it. Another mirror is one more `--mirror` of `scripts/release.mjs` in that workflow, with a login step for its cloud.

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
