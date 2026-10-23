# infra-tools

Pre-built tools for GitHub Actions runners. Each tool version is built once and published as a container image to a
registry. Jobs get the tools they need from there instead of downloading them from upstream.

## Actions

Two actions with the same interface:

| Action | For | Result |
| --- | --- | --- |
| `camunda/infra-tools/cache` | Tools with an official `setup-*` action | Tool cache filled; the `setup-*` action finds the tool there |
| `camunda/infra-tools` | Other tools | Tool installed and added to `PATH` |

```yaml
- uses: camunda/infra-tools/cache@<sha> # X.Y.Z
  with:
    tools: |
      java@21
- uses: camunda/infra-tools@<sha> # X.Y.Z
  with:
    tools: |
      jq@1
```

Tools already present on the runner are skipped. The release pinned by the action defines which tool versions are available.

## Tools

One folder per tool in [`tools/`](tools): a definition of where versions come from and which ones are published, plus an
install script and a test script.

Each tool version is built for `amd64` and `arm64`, tested, and published as a one-layer container image. The layer holds the
tool in the runner tool cache layout, ready to use once extracted.

## Releases

Publishing is automated: new upstream versions are detected, built, tested and published, and each published version gets its
own release. A version that fails to build or test gets a pull request where the fix lands.

Each release of this repository publishes an index of every available tool version. Pinning the actions to a release pins
that set of tools.
