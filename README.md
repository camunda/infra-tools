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

See what the next run would publish (reads upstream and the registry, with a token that can read the package):

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/plan.mjs --image ghcr.io/camunda/infra-tools
```

## Releases

Record commits and action changes keep a release-please release PR open ([Release](.github/workflows/release.yml), config in `.github/config/`). The [Release merge](.github/workflows/release-merge.yml) workflow merges it every day once its CI is green, and alerts `#infra-alerts` when it stays open for 2 days. The merge creates release `X.Y.Z`, which the Release workflow then publishes: the `X.Y.Z-tools` index pushed to `ghcr.io/camunda/infra-tools` (the previous release's index, plus the catalog, minus retired versions), the Added / Replaced / Retired tables added to the release notes, and `tools.json` attached. The action installs from the index of the release it is pinned to; the action tests use the latest release's.

### Publish a tool version by hand

Until the first release, the action tests read a test index filled by hand. The [Publish tool](.github/workflows/publish-tool.yml) workflow builds, tests and pushes the tool image of one version that its tool definition publishes and that the reconciler has not published yet, then adds it to an index (`ghcr.io/camunda/infra-tools:tracer-tools` by default):

```sh
gh workflow run publish-tool.yml -f tool=maven -f version=3.9.16
```

Build and test a tool version locally, for both platforms (needs a Buildx builder with the `docker-container` driver):

```sh
cd scripts && node build.mjs maven 3.9.16
```

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
