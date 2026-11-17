# infra-tools

Pre-built tools for GitHub Actions runners. Each tool version is built once and published as a container image to a
registry. Jobs get the tools they need from there instead of downloading them from upstream.

## Action

One action, `camunda/infra-tools`, with two inputs:

| Input | For | Result |
| --- | --- | --- |
| `tools` | Plain tools (e.g. jq, yq, kubectl, helm, maven, conftest) | Tool installed and added to `PATH` |
| `tool-cache` | Tools with an official `setup-*` action (e.g. java, node, go, python, uv, gcloud) | Tool cache filled; the `setup-*` action finds the tool there |

A tool listed in the wrong input fails the step with a message naming the right one.

```yaml
- uses: camunda/infra-tools@<sha> # X.Y.Z
  id: tools
  with:
    tools: |
      jq@1
      kubectl@1.37
      helm@4.3.1
    tool-cache: |
      java@21.0.12+101.0.LTS
      node@26.12.0
      go@1.25
      gcloud
- uses: actions/setup-java@<sha> # vX
  with:
    distribution: temurin
    java-version: ${{ fromJSON(steps.tools.outputs.versions).java }}
```

One tool per line, `<tool>[@<version>]`. The highest published version matching the selector is used:

| Selector | Resolves to |
| --- | --- |
| `gcloud` | Latest version |
| `java@21` | Latest `21.x.y` |
| `go@1.25` | Latest `1.25.x` |
| `node@26.12.0` | Exactly `26.12.0` |
| `java@21.0.12+101.0.LTS` | One specific build |

The resolved versions are available as JSON in the `versions` output (`{}` when nothing is installed). Tools already present on the runner are skipped. The release pinned by the action defines which tool versions are available.

On Ubuntu runners, `enable-apt-source: true` also adds the infra-tools apt source (off by default): `apt-get install` then takes curated packages from the registry, without `apt-get update`, and falls back to the Ubuntu mirrors for the rest.

```yaml
- uses: camunda/infra-tools@<sha> # X.Y.Z
  with:
    enable-apt-source: true
- run: sudo apt-get install -y --no-install-recommends clamav
```

## Tools

One folder per tool in [`tools/`](tools): a definition of where versions come from and which ones are published, plus an
install script and a test script.

Each tool version is built for `amd64` and `arm64`, tested, and published as a one-layer container image. The layer holds the
tool in the runner tool cache layout, ready to use once extracted.

## apt packages

Curated apt packages per Ubuntu release are listed in [`apt/`](apt) (for example `apt/noble.json`). Each package and the
dependencies a plain Ubuntu lacks are built into one apt repository, tested, and published as an OCI artifact read by
[apt-transport-oci](https://github.com/AkihiroSuda/apt-transport-oci).

## Releases

Publishing is automated: new upstream versions are detected, built, tested and published, and each published version gets its
own release. A version that fails to build or test gets a pull request where the fix lands.

Each release of this repository publishes an index of every available tool version. Pinning the action to a release pins that set of tools.
