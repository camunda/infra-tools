# infra-tools

Publishes the tools CI jobs need as OCI artifacts in registries next to the runners, and installs them in jobs with one action step, on GitHub-hosted and self-hosted runners alike ([camunda/team-infrastructure#1138](https://github.com/camunda/team-infrastructure/issues/1138)).

Work in progress: phase 1 is tracked in [#7](https://github.com/camunda/infra-tools/issues/7). The PoC implementation is on the [`poc`](https://github.com/camunda/infra-tools/tree/poc) branch.

- [Spec](docs/spec.md)
- [Glossary](GLOSSARY.md)
- [Architecture decisions](docs/adr/)

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
