# infra-tools

CI jobs spend time downloading the same tools over and over (JDKs, language runtimes, CLIs). infra-tools builds each tool version
once, stores it in a registry, and gives you actions that drop it into the runner's tool cache. Your job gets the tool in seconds,
and gets it for free when the runner already has it.

## Using it in a workflow

There are two actions, because tools come in two kinds.

Some tools have an official `setup-*` action (`setup-java`, `setup-node`, …). Keep that action: it configures the tool
(environment variables, settings files, caches). Run `camunda/infra-tools/cache` before it, and `setup-*` finds the tool
already in the tool cache instead of downloading it.

The other tools need no setup: `camunda/infra-tools` installs them and puts them on `PATH`.

The available tools are the folders in [`tools/`](tools); a tool whose `tool.json` sets `install.addToPath` goes in
`camunda/infra-tools`, any other in `camunda/infra-tools/cache`. The versions available in a release are listed in its
`tools.json` asset.

```yaml
- uses: camunda/infra-tools/cache@<sha> # X.Y.Z
  id: tools
  with:
    tools: |
      java@21
- uses: actions/setup-java@<sha> # vX
  with:
    distribution: temurin
    java-version: ${{ fromJSON(steps.tools.outputs.versions).java }}
- uses: camunda/infra-tools@<sha> # X.Y.Z
  with:
    tools: |
      jq@1
```

Each line of `tools` is a selector, `<tool>@<version prefix>`, and the highest matching version wins: `java@21` gives the latest
Java 21, `java@21.0` the latest 21.0 patch, `java@21.0.12+8` one exact build. The resolved versions come back in the
`versions` output as JSON, ready to pass to `setup-*`. Pick the wrong action for a tool and it tells you which one to use.

A few details:

- Linux runners only (`amd64`, `arm64`); on other runners the actions do nothing.
- Some tools get an extra link where their users look for them (for example the Docker CLI plugin folder, or the `./mvnw`
  distribution folder).
- `mode: validate` checks every selector in your repository's workflows against the pinned release, without installing anything.
- Runners can pull from a mirror of the registry: set `INFRA_TOOLS_MIRROR` (for example
  `europe-west1-docker.pkg.dev/<project>/<repository>`) in the runner environment. On Artifact Registry the action uses the runner
  pod's Workload Identity; if the mirror fails, it falls back to ghcr.io.
- Renovate updates the action pin out of the box. To also update the selectors, extend
  `github>camunda/infra-tools//.github/renovate-preset.json5`.

## How it works

Every tool version is a single-layer image, `ghcr.io/camunda/infra-tools:<tool>-<version>-r<revision>`, holding exactly the
files the tool cache needs (`/opt/hostedtoolcache/<tool>/<version>/<arch>`). Installing a tool means pulling one layer and
unpacking it.

```text
upstream releases ─► reconciler ─► one layer per tool version (amd64, arm64)
                         │  └─► fix PR when a version fails to build or test
                         ▼
               published/<tool>.json ─► release X.Y.Z ─► index X.Y.Z-tools
                                                              │
     your job ─► camunda/infra-tools[/cache]@X.Y.Z ─► pulls only missing layers ─► tool cache
```

1. A scheduled **reconciler** watches upstream releases (through Renovate datasources), builds every new version for both
   platforms with Docker Bake, tests it, pushes it and records it in `published/`.
2. Each record commit leads to a **release** `X.Y.Z` (release-please). It publishes an **index** listing every available tool
   version with its layer digest per platform. Pinning the action to a release therefore pins the set of tools you can select.
3. At run time, the **action** reads that index, skips tools already in the tool cache, and pulls the missing layers in parallel.

When a new version fails to build or test, the reconciler opens a **fix PR** for it instead of retrying forever. Push the fix
there and merge to publish the version, or close the PR to skip it.

## Adding or changing a tool

Each tool lives in `tools/<tool>/`: `install.sh` downloads it into `$DEST`, `test.sh` checks it from `$TOOL_DIR`, and
`tool.json` says where versions come from, which ones to publish and where they go in the tool cache. For example (versions
illustrative):

```json
{
  "source": { "datasource": "java-version", "packageName": "java-jdk?os=linux&architecture={arch}" },
  "publish": {
    "lines": {
      "17": { "versions": ["17.0.4+8"], "reason": "legacy job" },
      "21": { "from": "21.0.5", "reason": "used by ci.yml" },
      "*": { "from": "25.0.0" }
    }
  },
  "install": { "cacheFolder": "Java_Temurin-Hotspot_jdk", "archFolders": { "amd64": "x64", "arm64": "aarch64" } }
}
```

Read `publish.lines` as "keep Java 21 up to date from 21.0.5, publish every new major from 25, and keep one Java 17 build".

| Block | Options |
| --- | --- |
| `source` | Renovate lookup: `datasource`, `packageName` (`{arch}` for one lookup per platform), `versioning`, `extractVersion`. |
| `publish.lines` | Keyed by a major, a minor or `"*"` (anything in no other line); lines never overlap. Per line: `from`, `versions` (older pins), `ignoredVersions`, `revisions` (`{"26.11.1": 2}` rebuilds a layer), `retired` (list or `"all"`), `minAge` (default `1 day`), `reason`. |
| `install` | `cacheFolder` and `archFolders` as the `setup-*` action expects them; `addToPath` makes it a plain tool (root action). |

Removing a line's `from` stops it; retiring versions drops them from the next release, while older releases keep them.
A tool that doesn't fit the default build adds its own `Dockerfile` next to its scripts.

## Repository

```text
action.yml, cache/   the two actions (both run scripts/action/setup.sh)
tools/               one folder per tool
build/               Docker Bake targets and Dockerfiles: builder, tool, test
scripts/             Node.js reconciler: plan, build, publish, record, fix-pr, index (+ lib/, test/)
published/           record of published versions, written by the reconciler
docs/spec.md         requirements, decisions, open questions and measurements
```

To work on it locally:

```shell
cd scripts
npm ci
npm test
node plan.mjs --tools <tool> --skip-registry --limit-per-tool 1 # GITHUB_TOKEN for GitHub-hosted sources
node build.mjs --platforms linux/arm64                         # build and test, no push
pre-commit install --install-hooks -t commit-msg -t pre-commit
```

## References

- [docs/spec.md](docs/spec.md)
- [camunda/team-infrastructure#1138](https://github.com/camunda/team-infrastructure/issues/1138)
