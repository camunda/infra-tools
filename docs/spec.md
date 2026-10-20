# infra-tools: high-level spec

Living spec for the infra-tools PoC ([camunda/team-infrastructure#1138](https://github.com/camunda/team-infrastructure/issues/1138)),
moved here from [camunda/infra-actions-runner#199](https://github.com/camunda/infra-actions-runner/pull/199).
IDs are stable: entries are never deleted, only marked `superseded` with a link to their replacement.
Status values: `proposed`, `decided`, `superseded` (requirements, decisions); `open`, `resolved` (questions).

## 1. Problem and goals

CI jobs download the same tools (JDK, Node.js, gcloud, …) at runtime, in every job. This costs time on every job, and occasionally
stalls a job for minutes.

| ID | Goal |
| --- | --- |
| G1 | Remove runtime tool downloads from CI jobs, on GitHub-hosted and self-hosted Linux runners. |
| G2 | Shorten the critical path to merging into `camunda/camunda` `main` (merge queue). |
| G3 | Remove download stalls (worst cases observed: 178 s JDK, 614 s gcloud). |
| G4 | Keep tool versions current with low effort, without gaps. |

Baseline (`camunda/camunda`, `ci.yml` on `main`): see [section 9](#9-poc-plan-and-evidence).

## 2. Scope

In scope:

- A dedicated repository `camunda/infra-tools` (D37), internal for the PoC (Q14).
- Tool layers in a registry, one layer per tool version, published continuously from upstream releases.
- Per-tool releases and releases of the index of available tool versions.
- Two composite actions extracting selected tool layers into the runner tool cache: the root action and `cache` (D42).
- Renovate support for consumers (action pin, tool selectors).
- A `camunda/camunda` PoC PR measuring the setup time.

Out of scope (for now):

- Self-hosted runner image built from the tool layers (assembled image, deployment to runner sets).
- Registry mirrors (GAR, Harbor, ECR); GHCR only.
- Satellite actions in `camunda/infra-global-github-actions` (e.g. `submit-test-status`), kept unchanged.
- Dev runners for `camunda/camunda`.
- apt packages on GitHub-hosted runners, macOS and Windows runners.
- Caches that are not tools (Maven repository, npm/yarn caches).

## 3. Requirements

| ID | Requirement | Status |
| --- | --- | --- |
| R1 | Each tool version is stored as its own layer, in the runner tool cache layout `<folder>/<version>/<arch>` plus `<arch>.complete`, so a single layer can be pulled and extracted on its own. | decided |
| R2 | Layers exist for `linux/amd64` and `linux/arm64`. | decided |
| R3 | The action extracts only the selected tools that are missing. | decided |
| R4 | A tool counts as present only when the tool cache holds a complete version matching the selector, whatever installed it. Binaries outside the tool cache are the job's concern. | decided |
| R5 | When every selected tool is present, the action makes no network call. | decided |
| R6 | Selectors are written at the precision the consuming CI accepts (e.g. `java@21`, `node@26`), so compatible versions already present are hits. | decided |
| R7 | Published layers never change. Only new tool versions or revisions are built and pushed. | decided |
| R8 | A tool's build can differ per version without affecting other versions; the repository layout shows what it publishes. | decided |
| R9 | New upstream versions arrive through Renovate PRs that build and test them with the default install; the PR fails if the build or test fails. | superseded by R15 |
| R10 | Each release publishes an immutable index readable by the action through the registry protocol only. | decided |
| R11 | Consumers' Renovate can update the action pins (release version) and the selectors. | decided |
| R12 | Public consumers (including fork PRs) pull layers without credentials. | proposed (Q14) |
| R13 | Downloads are retried and verified (layer digest). | decided |
| R14 | Each release lists the tool versions it added, replaced and retired compared with the previous release, for people and machines. | decided |
| R15 | Every upstream version within a tool's declared range is published, without gaps (bursts included). A version that fails to build or test is tracked in a fix PR, never skipped silently. | decided |
| R16 | Every upstream build is a distinct version: builds of the same `X.Y.Z` (e.g. `21.0.12+8`, `21.0.12+101.0.LTS`) are all published. | decided |
| R17 | Each reconciler run verifies completeness: upstream versions in range − published − tracked (fix PR, ignored, waiting) must be empty, otherwise the run fails. | decided |

## 4. Concepts

| Term | Meaning |
| --- | --- |
| Tool | A program installed into the tool cache, e.g. `node`, `java`, `gcloud`. Its folder name in `tools/` is its selector name. |
| Tool config | `tools/<tool>/tool.json`: upstream source (Renovate datasource), version lines (`from`, pinned, ignored, revised and retired versions) and tool cache layout. |
| Revision | Rebuild number of a given tool version. Defaults to 1; bumped to override an already published layer. |
| Line image | Single-layer `FROM scratch` image holding one tool version, tagged `<tool>-<version>-r<revision>` (`+` written as `-`). Never run. |
| Reconciler | Scheduled job publishing every upstream version in range that is not published yet, and opening fix PRs for failures. |
| Fix PR | PR opened by the reconciler for a version that fails to build or test; the fix lands in it. |
| Tool release | GitHub release `<tool>-<version>-r<revision>` documenting one published line image. |
| Catalog | `published/<tool>.json`: bot-written record of published versions; the only path that triggers a release. |
| Index | OCI artifact `<X.Y.Z>-tools`: for each platform, every tool version available in release `X.Y.Z` with its layer digest. |
| Release | Release-please release `X.Y.Z` of the actions and the index, with JSON assets. |
| Selector | `<tool>[@<version prefix>]` in the action's `tools` input, resolved to the highest matching version of the index. |

## 5. Components

### 5.1 Repository layout

```text
infra-tools/
├── README.md                     # usage, tools available, add a tool / fix a build
├── CHANGELOG.md                  # release-please
├── action.yml                    # plain tools: ready to use (camunda/infra-tools@…)
├── cache/action.yml              # tools with a setup-* action: pre-fill the tool cache (camunda/infra-tools/cache@…)
├── tools/                        # one folder per tool: tool.json, install.sh, test.sh (+ Dockerfile when needed, D31)
├── docs/
│   └── spec.md
├── build/                        # image build: Bake and Dockerfiles (out/ gitignored)
│   ├── docker-bake.hcl           # shared targets: builder, _line, _test
│   ├── builder.Dockerfile        # build-platform image where install.sh runs (download, install-tool)
│   ├── tool.Dockerfile           # default tool build → FROM scratch line image
│   └── test.Dockerfile           # runs test.sh on the target platform
├── scripts/                      # Node.js: plan, build, publish, record, fix-pr, index (+ lib/, test/)
│   ├── package.json              # renovate (getPkgReleases)
│   └── action/setup.sh           # implementation of both actions
├── published/                    # bot-written record of published versions
└── .github/
    ├── CODEOWNERS
    ├── renovate.json5
    ├── renovate-preset.json5     # for consumers
    ├── config/                   # release-please-config.json, .release-please-manifest.json
    └── workflows/                # reconcile.yml, pr.yml, release.yml, release-merge.yml (Q15)
```

### 5.2 Tool definition and build

`tool.json` has three blocks (D38): `source` (Renovate lookup options, passed as-is), `publish` (which versions are published)
and `install` (tool cache layout); unknown blocks and options are rejected. Blocks with only defaults can be left out.

| Option | Default | Explanation |
| --- | --- | --- |
| `source.datasource` | required | Renovate source listing the tool's versions (e.g. `node-version`, `github-releases`, `java-version`). |
| `source.packageName` | tool name | Package to look up in that source; `{arch}` makes one lookup per platform. |
| `source.versioning` | the source's default | Version scheme used to compare and sort versions (e.g. `semver`, `maven`). |
| `source.extractVersion` | none | Regex turning an upstream tag into a version (e.g. `v26.11.1` → `26.11.1`). |
| `publish.lines` | required | Version lines to publish, keyed by a major (`"21"`), a minor (`"1.25"`) or `"*"` (versions in no other line). |
| `publish.minAge` | `1 day` | Wait after an upstream release before building it; a line can override it. |
| `install.cacheFolder` | tool name | Tool cache folder, matching what the tool's `setup-*` action expects (e.g. `Java_Temurin-Hotspot_jdk`). |
| `install.archFolders` | `{"amd64": "x64", "arm64": "arm64"}` | Arch folder per platform, as the `setup-*` action expects it (e.g. `aarch64` for Java). |
| `install.addToPath` | none | Folder added to `PATH`: the tool is ready to use (`setup` action); without it, `cache` action. |

Line options (`publish.lines.<key>`):

| Option | Explanation |
| --- | --- |
| `from` | Publish every version of the line from this one on (inclusive). Required on `"*"`. Without it, nothing new is published. |
| `versions` | Older versions of the line, always published (pins). Must be older than `from`. Not on `"*"`. |
| `ignoredVersions` | Versions of the line never published. |
| `revisions` | Rebuild number per version, replacing an already published layer (e.g. `{"26.11.1": 2}`). |
| `retired` | Versions of the line dropped from the next release index (older releases keep them), or `"all"` for every published version of the line (then only `reason` is allowed). |
| `minAge` | Overrides `publish.minAge` for the line. |
| `reason` | Why the line exists (JSON has no comments). |

Each version belongs to exactly one line: lines never overlap (`26` and `26.11` together, or a line at or above `"*".from`, are
rejected), and `"*"` covers versions in no other line from its `from` on. A line's state follows from its options: with `from`,
it publishes new versions; with only `versions`, only those; with neither, nothing new (stopped, kept for `retired` or
`revisions`); with `"retired": "all"`, its versions leave the next release.

```json
{
  "source": {
    "datasource": "node-version",
    "versioning": "semver",
    "extractVersion": "^v(?<version>.+)$"
  },
  "publish": {
    "lines": {
      "24": { "from": "24.22.0", "reason": "camunda/camunda ci.yml: release-notes-action-ci node-version 24" },
      "26": { "from": "26.12.0", "versions": ["26.10.0"], "reason": "camunda/camunda ci.yml: node-version 26; parent/pom.xml pins 26.10.0 (Optimize)" },
      "*": { "from": "27.0.0" }
    }
  }
}
```

Lines (D41), per upstream version: find its line (the explicit line it belongs to, else `"*"` from its `from` on, else none →
skip); `"retired": "all"`, `ignoredVersions` or `retired` → skip; in `versions` or `revisions` → publish (no stability or
`minAge` check); older than `from` or no `from` → skip; unstable → skip; newer than `minAge` → wait; otherwise publish.
Validation rejects unknown options, line keys that are not a major, a minor or `"*"`, empty lines, line options naming versions
outside their line, `versions` at or above `from`, `"*"` without `from` or with `versions` or `"retired": "all"`, other options
next to `"retired": "all"`, nested lines and lines at or above `"*".from`. The catalog, index annotations and release notes record
each version's line.

- Build stages (`build/tool.Dockerfile`): `builder` image (build platform, never published) → `install` stage: `install-tool` runs `install.sh` with
  `VERSION`, `TARGETARCH`, `ARCH` (tool cache arch folder) and `DEST`, then marks `DEST` complete →
  `FROM scratch` line image holding `/opt/hostedtoolcache/<cacheFolder>/<folder version>/<arch>` (D34).
- Test stage (`build/test.Dockerfile`): Ubuntu 24.04 on the target platform with the packages runners have (`python3`, …),
  layer copied in, `test.sh` run with `VERSION` and `TOOL_DIR`; never published.
- Version differences: `if version ≥ X` in the default `install.sh` and `test.sh` (D22).
- Versions with build metadata: `+` is written as `-` in folder names and tags (`java-21.0.12-101.0.LTS-r1`).

### 5.3 Reconciler

Runs on a schedule, on push to `main` and on demand; one run at a time (`concurrency`).

1. Plan, per tool:
   - List upstream versions per platform; keep versions available for every platform (others wait; fix PR after N days).
   - Apply each version's line (D41): `from` (inclusive), `versions`, `ignoredVersions`, `revisions`, `retired`, stability, `minAge`.
   - Deduplicate by exact string only; order with build metadata (D23).
   - Skip versions with an open fix PR, or a fix PR closed without merge (treated as ignored).
   - Plan = remaining versions whose tag `<tool>-<version>-r<revision>` is missing (404; any other registry error fails the run).
2. Build and test each planned version and platform (Bake).
3. Publish each success: push the line image, create the tool release (skip if it exists).
4. Record: update `published/<tool>.json`, one commit per run with one conventional entry per version
   (`feat(node): publish 26.11.2`, `fix(java): republish 21.0.12+101.0.LTS (r2)`, `feat(node)!: retire 24.19.0`).
5. Fix PRs, per failure:
   - Same tool and major with an open fix PR and the same error: add the version to it; otherwise open
     `tool-build/<tool>-<version>` (label `tool-build`), starting from an empty commit (the version is already in its line).
   - Body: failing step, log excerpt, run link; comment only when the error changes.
   - Close the PR (with a comment) when the version builds again; maintainers can split a grouped PR.
6. Completeness check (R17): `plan --check` must find nothing left to publish; fail and alert otherwise.

Scripts (`scripts/`): `plan.mjs` (1, 6), `build.mjs` (2, push), `publish.mjs` (tool releases), `record.mjs` (4), `fix-pr.mjs` (5).

Safeguards: never overwrite a tag; fail when a version of the catalog lost its tag; datasource or registry outages fail the run
(never read as "no versions"); retention policies exclude `*-r*` tags.

### 5.4 Pull requests

- Plan and build in dry run: planned versions, plus the latest published version per major of every tool whose files changed.
- Warn when a published version's build files changed without a revision bump.
- Comment the release notes the next release would produce.

### 5.5 Releases

Tool releases:

- Created by the reconciler when it publishes a line image; tag `<tool>-<version>-r<revision>` on the commit the layers were
  built from, never marked latest (GitHub shows the newest one as latest until the first `X.Y.Z` release exists).
- Content: upstream project link, usage snippet (action and selector), tool cache path, layer digest and size per platform,
  image digest, line, revision and build commit. `publish.mjs --update` rewrites existing releases and moves their tag.

Releases (release-please, D25):

- One component at `.`, `exclude-paths`: `tools`, `docs`, `build`, `.github` and every entry of `scripts/` except `action/`.
  Bot record commits (`published/`) and action changes (`action.yml`, `cache/`, `scripts/action/`) produce release PRs.
- Config in `.github/config/` (infra convention); tags `X.Y.Z` (D30).
- A daily workflow merges the open release PR if it is green; the merge creates `X.Y.Z`.
- On `release_created` (`index.mjs`):
  1. Index = previous index + `published/` entries − retired versions; fail if a declared entry has no tag.
  2. Push the per-platform artifact manifests and the `X.Y.Z-tools` index; no layer is uploaded twice.
  3. Compare with the previous index; append the Added / Replaced / Retired tables (with tool release links) to the notes.
  4. Attach `tools.json` (every tool version per platform with its tag, layer digest and size); the tables go in the notes.

### 5.6 Actions (root, `cache`)

- `camunda/infra-tools@<sha> # X.Y.Z` (root): plain tools (`addToPath`); ready to use. `camunda/infra-tools/cache@<sha> # X.Y.Z`:
  tools with an official `setup-*` action (`tool.json` without `addToPath`); pre-fills the tool cache, the `setup-*` step then
  finds them. Each rejects the other kind with a message naming the right action (D42).
- One implementation (`scripts/action/setup.sh`, bash, curl, jq; `KIND` (`setup`, `cache`) selects the action); both actions share the release version,
  read from the release-please manifest at the pinned commit; there is no `version` input.
- Inputs: `tools` (selectors, one per line), `token`, `mode` (`extract`, `validate`), `index` (override, for tests and mirrors),
  `summary` (`true`: table of the selected tools in the job summary).
- Log: the release and platform, one line per tool (selector, resolved version, `installed` with size, duration, speed and
  registry, or `cached`, and the tool cache path) and a total; login and index timings in a collapsed group; layer digests as
  debug messages.
  Output: `versions`, JSON of the resolved version per selected tool in the form `setup-*` actions expect
  (`{"java":"21.0.12+101.0.LTS"}`, read with `fromJSON(steps.<id>.outputs.versions).java`); `{}` when nothing is installed (D43).
- Tool layouts (cache folder, arch folders, `addToPath`) come from `tools/*/tool.json` at the pinned commit, so present tools
  need no network.
- Flow:
  1. For each selector, look for a complete matching version in `$RUNNER_TOOL_CACHE`; if every tool is present, stop (R4, R5).
  2. Otherwise fetch `X.Y.Z-tools` from GHCR and pick the platform manifest.
  3. Resolve each missing selector to the highest matching version, build metadata included; fail if none.
  4. Pull each missing layer by digest, verify it, extract it into the tool cache and mark it complete; retry on failure.
  5. Root action only: add `addToPath` folders to `PATH`; link docker-compose as a Docker CLI plugin; link Maven for `./mvnw` when
     `.mvn/wrapper/maven-wrapper.properties` asks for the same version (D32).
- Selectors: `java@21` and `java@21.0.12` resolve to the highest build; an exact build can be pinned (`java@21.0.12+8`, `-` accepted).
- Non-Linux runners: no-op. `mode: validate` checks a repository's selectors against the pinned index.
- Mirror (D44): with `INFRA_TOOLS_MIRROR` set, the action reads `<mirror>/infra-tools:<tag>` instead of
  `ghcr.io/camunda/infra-tools:<tag>`; on `*.pkg.dev` it sends the GKE metadata server token (Workload Identity) as bearer token
  directly, skipping the registry token endpoint (occasionally ~5 s on Artifact Registry), elsewhere it exchanges `token`; it falls back to ghcr.io with a warning when the mirror fails.

### 5.7 Renovate

| What | Where | How |
| --- | --- | --- |
| Tool versions | `tools/*/tool.json` | Not Renovate: the reconciler (D21). |
| Repository dependencies | `scripts/package.json` (renovate), actions, base images | Default Renovate config. |
| Action pins | Consumer workflows | Renovate's built-in github-actions manager (`@<sha> # X.Y.Z`; both actions share one version, D30). |
| Selectors | Consumer `tools: \|` blocks | Preset `github>camunda/infra-tools//.github/renovate-preset.json5`: custom datasource reading `published/<tool>.json` at the pinned tag through the contents API (D29); npm versioning keeps each selector's precision; exact build pins are left alone. |

## 6. Flows

| Flow | Steps |
| --- | --- |
| New upstream version | Upstream releases → after `minAge`, the reconciler builds, tests, publishes it and records it → next daily release adds it. |
| Burst of versions | Each version is planned on its own; all are published (R15). |
| New major | Published by `"*"` once released (D41); consumers move to it through their selectors. To keep an older major maintained, PR adds its line and moves `"*".from` past it. |
| Build failure | Fix PR opened or extended (same major, same error) → fix pushed to the PR (`if version ≥ X`) → PR CI green → merge → next run publishes. |
| Won't build | Close the fix PR → the version is ignored. |
| New tool | PR adds `tools/<tool>/` (`tool.json`, `install.sh`, `test.sh`) → PR builds and tests it → merge → reconciler publishes. |
| Override | PR bumps the version's revision in its line → reconciler publishes the new tag → next release lists it under "Replaced". |
| Retire | PR adds the version to its line's `retired` (or `"retired": "all"`) → bot records it (`feat!`) → next release removes it; older indexes keep it. |
| Stop a line | PR removes the line's `from` (and `versions`) → nothing new is published for it; published versions stay. |
| Release | Daily: release PR merged if green → `X.Y.Z` → index, notes and assets. |
| Consumer update | New release → Renovate bumps the action pins (release notes in the PR body) → selectors checked against the new `<tool>.json` → PR CI fails if a selector no longer matches. |

## 7. Decisions

| ID | Decision | Options considered | Why | Status |
| --- | --- | --- | --- | --- |
| D1 | Separate image and package, independent of the runner image, same upstream base for tests. | Extend the runner image | Independent lifecycle; no impact on runners. | decided |
| D2 | One layer per tool version in the tool cache layout. | Tarball per tool; generic OCI artifacts | `setup-*` actions find tools without change; one layer can be pulled alone. | decided |
| D3 | Index as OCI artifact `X.Y.Z-tools` referencing existing layers, plus a GitHub release pointing to it. | `tools.json` release asset only | The action only needs the registry; no layer is uploaded twice. | decided |
| D4 | Renovate selector data as release assets (`<tool>.json`). | Read the OCI index | A Renovate custom datasource cannot perform the registry token exchange. | superseded by D29 |
| D5 | Present = complete matching version in the tool cache only. | Also probe binaries on `PATH`; known system paths | Predictable; binaries outside the tool cache stay the job's concern. | decided |
| D6 | Selectors at the precision the consuming CI accepts. | Exact versions | Exact versions miss compatible tools already present. | decided |
| D7 | No GitHub Actions cache for tools. | Cache the extracted tools | Measured no gain (14 s with and without), 343 MB of cache quota per toolset version. | decided |
| D8 | Docker Bake, one folder per tool, overrides per line. | Single Dockerfile; data file + generator; `crane append` | Readable layout, per-version builds, BuildKit caching. | superseded by D22 (Bake and folder per tool kept) |
| D9 | One image per tool version; incremental publishing; index accumulates across releases. | Rebuild everything with registry cache; build on the previous release | Nothing is rebuilt; overrides and retirements are explicit. | decided |
| D10 | Build when the tag `<tool>-<version>-r<revision>` is missing; revisions per version. | Compare with the previous index; recipe hash | One rule for new versions and overrides; safe to rerun. | decided |
| D11 | Majors through a `current` line plus a fork workflow. | One manual PR per major | Renovate cannot add a version line on its own. | superseded by D21 |
| D12 | PoC published from the `1138-*` branch of `infra-actions-runner` by a manual tag, to GHCR only. | Releases from `main`; GAR | PoC only; no impact on `main`. | superseded by D26 |
| D13 | Self-hosted runner image out of scope. | Assemble it from the line images | Focus on the action and the index first. | decided |
| D14 | Satellite actions of `infra-global-github-actions` unchanged in the PoC. | Route gcloud versions through them | Keeps the PoC small. | decided |
| D15 | `camunda/camunda` calls the action centrally in `setup-build` and `build-frontend`; single-job tools per job; redundant setup steps removed. | Per job only | Covers most jobs with two call sites. | decided |
| D16 | Measure with one PoC branch compared against BigQuery history. | Paired baseline and toolset branches | Enough for a first signal. | decided |
| D17 | No dev runners for `camunda/camunda`. | Dev runner group with the toolset image | The action must work on today's runners. | decided |
| D18 | Manual releases for the PoC; automatic releases with a derived semver later. | Automatic from the start | Not needed to prove the gain. | superseded by D25 |
| D19 | Line images are pushed on merge; a release only assembles the index from existing tags. | Push line images during the release | Fast releases with no build. | superseded by D21 |
| D20 | Release notes include the Added / Replaced / Retired tables from comparing the new index with the previous one, and as a dry-run comment on PRs. | Hand-written notes; git log only | Lists exactly what consumers gain or lose; reviewers see the next release before merging. | decided |
| D21 | A scheduled reconciler publishes every upstream version in range (Renovate datasources) and opens fix PRs for failures, grouped per tool and major when the error matches. | Renovate PR per version line; reconciler without PRs ([containerbase](https://github.com/containerbase/node-prebuild)); moving lines (docker-library) | No gaps (R15), bursts handled; review where it matters; same model as [actions/node-versions](https://github.com/actions/node-versions). | decided |
| D22 | Version differences with `if version ≥ X` in the default `install.sh` and `test.sh`; per-range override folders only if needed later. | Per-line folders from the start | Most tools are download-and-unpack; same approach as GitHub's builders. | decided |
| D23 | Version identity is the exact string; ordering includes build metadata; `startVersion` inclusive; ranges resolve to the highest build; exact builds can be pinned. | One build per `X.Y.Z` (newest replaces older) | Keeps every build (R16); semver equality would drop builds. | decided |
| D24 | One GitHub release per published tool version, created directly by the reconciler (idempotent). | No per-tool release; release-please per tool | Traceability per version; release-please cannot release upstream-driven versions. | decided |
| D25 | Releases via release-please, driven by the bot record commits in `published/`, release PR merged daily if green. | Own daily job deriving semver from the index comparison; no index ([containerbase](https://github.com/containerbase/base) URL convention) | Same release flow as other repositories; in-repo record of published versions. | decided |
| D26 | Dedicated public repository `camunda/infra-toolset`; `tools/` and docs prominent, build tooling (`.build/`), catalog (`.catalog/`) and action implementation (`.action/`) hidden. | Subfolder of `infra-actions-runner` | Own release flow and tags; public package and assets for public consumers. | superseded by D37, layout by D42 |
| D27 | The action lives at the root of `camunda/infra-toolset`, with one version line for the action and the toolset; no `version` input. | Action in `infra-global-github-actions` with a `version` input | One pin gives a consistent action and index; simpler Renovate. | superseded by D37 (one version line kept) |
| D28 | Publish a version only when available for every platform; open a fix PR after N days otherwise. | Publish per platform as available | An index entry must exist for every platform. | decided |
| D29 | Renovate selector data read from `published/<tool>.json` at the release tag through the GitHub contents API; the release only attaches `tools.json`, for people and scripts. | Release assets (D4) | Works while the repository is internal (Renovate sends its token to `api.github.com`), no extra file. | decided |
| D30 | Release tags `X.Y.Z` (infra convention, release-please config in `.github/config/`); the action pin is tracked by Renovate's github-actions manager. | `toolset-X.Y.Z` with a custom manager | Tool release tags (`node-26.11.2-r1`) are not versions, so no prefix is needed. | decided |
| D31 | One generic `build/tool.Dockerfile`; a tool adds its own `Dockerfile` only when needed (python). | A Dockerfile per tool | 14 of 15 tools build the same way. | decided |
| D32 | The action links the tool cache Maven into `~/.m2/wrapper/dists/<name>/<hash>` when the wrapper asks for the same version. | Only `mvn` on `PATH`; drop Maven | `./mvnw` uses it without downloading (same hash as `mvnw`). | decided |
| D33 | Build scripts in Node.js (ESM, no build step, `node:test`); bash for `install.sh`, `test.sh` and the action. | TypeScript; bash scripts | `plan` needs Renovate's library; no compile step. | decided |
| D34 | Line image layers hold `opt/hostedtoolcache/...`; the action strips two path components. | Tool cache folders at the layer root | Layers stay usable as-is by a future runner image (D13). | decided |
| D35 | Node versions use `semver` versioning. | Renovate's `node` versioning | `node` versioning marks non-LTS majors (Node 26 today) unstable, which would skip them. | decided |
| D36 | Python from GitHub's prebuilt archives, installed with their `setup.sh` on the target platform. | Build from source | Same build as GitHub-hosted runners; only runs from `/opt/hostedtoolcache` (Q5). | decided |
| D37 | Repository `camunda/infra-tools` (renamed from `infra-toolset`) with two actions on one version line: `tool-cache` (tools with a `setup-*` action, pre-fills the tool cache) and `setup` (plain tools, ready to use); each rejects the other kind; no root action. | One root action; `cache` instead of `tool-cache`; names `infra-toolset`, `infra-prebuilt-tools`, `infra-ci-tools` | Each name matches what happens: java still needs `setup-java`, jq needs nothing; `tool-cache` avoids confusion with `actions/cache`. | superseded by D42 (repository name and two actions kept) |
| D38 | `tool.json` grouped in three blocks: `source` (Renovate lookup), `publish` (versions to publish), `install` (tool cache layout). | Flat options; YAML with explicit version lines; JSON schema only; datasource presets | Each block has one reader and one meaning; `source` is passed to Renovate unchanged; readable without new syntax. | decided |
| D39 | No upper bound: `startVersion` is the latest stable version when a tool is added, so every newer version (majors included) is published; older versions a CI pins today go in `extraVersions` and get no new patches. First publish for `camunda/camunda` `ci.yml`: 23 versions instead of 67. | `startVersion` at the version a CI uses (publishes every major since, e.g. Java 22–27); per-line ranges keeping older lines patched | Minimal first publish, new majors without edits; a CI that needs patches of an older line adds its versions or a range. | superseded by D41 |
| D40 | Publish defaults with per-line overrides: `publish.lines` keyed by major or minor, each with `startVersion`, `allowedVersions`, `minAge`, `frozen` and an optional `reason`; versions in no line follow the defaults (new majors). Lines replace `extraVersions` for older versions a CI uses, so they keep getting patches. First publish for `camunda/camunda` `ci.yml`: 26 versions. | `series`, `overrides`, `versionOverrides`, `majors`/`minors` maps; a list with match ranges; one file per line | Short domain term (Node.js and Java "release lines"); a line reads as "keep this one maintained"; `reason` documents why, since JSON has no comments. | superseded by D41 |
| D41 | Version lines only: `publish.lines` keyed by a major, a minor or `"*"` (versions in no other line, from its `from` on); a line has `from`, `versions` (older pins), `ignoredVersions`, `revisions`, `retired` (or `"all"`), `minAge` and `reason`; lines never overlap; stopping a line = removing its `from`. Replaces the top-level `startVersion`, `allowedVersions`, `extraVersions`, `ignoredVersions`, `revisions`, `retired` and `frozen`; fix PRs start from an empty commit. | Defaults plus per-line overrides with a `frozen` flag (D40); `*` with longest-match precedence; `extraVersions` at the top level | One concept covers every case; the file alone tells which rule applies to each version; everything about a version sits under its line. | decided |
| D42 | Root action for plain tools (`camunda/infra-tools@…`) and `cache` for tools with a `setup-*` action (`camunda/infra-tools/cache@…`); no dot folders: `build/` (Bake and Dockerfiles), `scripts/` (Node.js scripts and the action implementation `scripts/action/setup.sh`), `published/` (bot-written record of published versions). | `tool-cache` and `setup` subfolders (D37); `.build/`, `.action/`, `.catalog/`; `catalog/`, `released/`, `versions/` | Plain tools are the common case and get the shortest `uses:`; `cache` says what it fills; each folder says what it holds; `published/` matches the publish step. | decided |
| D43 | One JSON output `versions` on both actions (`fromJSON(steps.<id>.outputs.versions).java`), `{}` when nothing is installed. | One declared output per tool; both | Composite actions only expose declared outputs, so per-tool outputs need an `action.yml` edit for every new tool; an unknown output and an unknown JSON key are both empty, so per-tool outputs catch no more typos; adding a tool stays a `tools/<tool>/` folder. | decided |
| D44 | Runner-level mirror: `INFRA_TOOLS_MIRROR` in the runner environment points the action to a copy of the registry (Artifact Registry for GKE runners, same digests), with Workload Identity credentials and fallback to ghcr.io. | Artifact Registry remote repository in front of ghcr.io (needs a PAT, as the package cannot be public); `index` input per workflow | No workflow change; no long-lived credential; same-region pulls for self-hosted runners; ghcr.io stays the source of truth. | proposed |
| D45 | Bootstrap with the latest version of each line: `from` set to the latest patch (go `1.25`, node `24` and `26`, helm), the older Java 21.0.12 build ignored; pins in `versions` kept. First release: 20 versions (4 published during the PoC, 16 built from `main`). | Every version from the original `from` (27 versions) | Nothing consumes the older patches yet; halves the first build; a CI pinned to an older patch keeps its usual download. | decided |

## 8. Open questions

| ID | Question | Blocking | Status |
| --- | --- | --- | --- |
| Q1 | The GHCR package inherited the internal visibility of `infra-actions-runner`. | PoC on public consumers | resolved (D26; verify package visibility on first publish) |
| Q2 | Can `camunda/camunda`'s Renovate read release assets of an internal repository? | Selector updates | resolved (D26) |
| Q3 | Datasource for the toolset version. | Toolset version updates | resolved (D27: action pin, `github-releases`) |
| Q4 | `./mvnw` only looks in `~/.m2/wrapper/dists/<name>/<hash>`, not in the tool cache: link Maven there from the action, or drop Maven. | Maven gain | resolved (D32) |
| Q5 | The Python build only runs from `/opt/hostedtoolcache` (its build prefix); self-hosted runners use `/home/runner/_work/_tool`. | Python on self-hosted | open |
| Q6 | gcloud callers use `version: latest`, which bypasses the tool cache; `gcs-build-cache-auth` can pin it, `submit-test-status` is out of scope (D14). | gcloud gain | open |
| Q7 | Connection resets were seen when pulling GHCR layers from GKE; is a regional mirror needed for self-hosted runners? | Self-hosted reliability | open |
| Q8 | Retention: how many versions per tool stay in the index; how long line images and tool releases are kept. | No | open |
| Q9 | Move the toolset and the action to a dedicated repository? | No | resolved (D26) |
| Q10 | Version the action and the toolset together or independently? | No | resolved (D27) |
| Q11 | The reconciler commits records to `main`: GitHub App ruleset bypass, or an auto-merged record PR? | Releases | open |
| Q12 | With several builds of one version in the tool cache, does `setup-java` pick the highest? Otherwise pass the action's resolved version. | No | open |
| Q13 | Repository creation and ownership of `camunda/infra-tools` (org admin, CODEOWNERS, Vault/App credentials). | Migration | resolved (repository created, `infrastructure` admin, CODEOWNERS); App credentials in Q15 |
| Q14 | Switch `camunda/infra-tools` and its package to public before `camunda/camunda` fork PRs rely on it. | Fork PRs | open |
| Q15 | Workflows (`reconcile.yml`, `pr.yml`, `release.yml`, `release-merge.yml`) and the GitHub App credentials for record commits, fix PRs and releases. | First publish | open |

## 9. PoC plan and evidence

### Work items

| Repository | Branch / PR | Content | Status |
| --- | --- | --- | --- |
| `camunda/infra-actions-runner` | `1138-toolset`, [#199](https://github.com/camunda/infra-actions-runner/pull/199) | First version; kept as a draft for reference. | superseded |
| `camunda/infra-tools` | `1138-toolset`, [#1](https://github.com/camunda/infra-tools/pull/1) | Tools, build scripts, actions, Renovate preset, release-please config. Workflows not included (Q15). | in progress |
| `camunda/camunda` | PR | Call the action in `setup-build` and `build-frontend`; measure. | to do |

Measured jobs: `build-distball` and `async-replication-integration-tests` (merge queue critical path, self-hosted),
`build-platform-frontend` or `webapp-client` (GitHub-hosted, Node 26).

### Local verification (`camunda/infra-tools`, `1138-toolset`)

- Unit tests (`npm test` in `scripts`): 27 passed (versions and lines, catalog and index merge, fix PR grouping, upstream filters, tool configs and validation).
- `plan.mjs` against real upstream data (D41 lines): 26 versions for the 15 tools, covering every version `ci.yml` uses;
  versions newer than `minAge` held back.
- `build.mjs`: all 15 tools built and tested for `linux/amd64` and `linux/arm64`, including the new latest versions (Go 1.27.2,
  Java 27.0.0, kubectl 1.37.1, Maven 3.10.0, Node 26.12.0, uv 0.13.1) and both Java 21.0.12 builds; full rebuild of the
  26 planned versions passed. Tests capture command output before matching it (`cmd | grep -q` fails under `pipefail` when the
  command gets SIGPIPE, seen with kubectl 1.37).
- Actions with tools already in the tool cache, no network: `cache` with `java@21` (`versions` output set, no `PATH` entry);
  root action with `maven@3` (`PATH` set, `./mvnw` of `camunda/camunda` running the linked Maven 3.9.16); exact build selector
  resolved; each action rejecting the other kind of tool.
- Renovate configs validated (`renovate-config-validator --strict`); selector regexes and the catalog transform tested.
- Pushing to ghcr.io, `index.mjs`, `record.mjs`, `publish.mjs` and extraction from ghcr.io verified with Java 21, Node 26, Maven 3.9
  and gcloud (test index `test-1138-tools`). Not verified: `fix-pr.mjs` against GitHub.

### Baseline (`camunda/camunda`, October 2026)

- Merging: the only required check is `check-results` (`ci.yml`), the only workflow running in the merge queue.
  Merge queue CI wall clock: p50 24.2 min, p90 28.1 min (40 runs).
- Critical path: `build-distball` (p50 4.6 min, p90 5.4 min) → slowest dependent (`async-replication-integration-tests` p90 17.7 min,
  `physical-tenant-acceptance-tests` 16.2 min, `integration-tests` 15.6 min). Source: `prod_ci_analytics.build_status_v2`, 14 days.
- Tool setup per job (46 job logs of CI run
  [38428572169](https://github.com/camunda/camunda/actions/runs/38428572169)):

| Tool | GitHub-hosted | Self-hosted |
| --- | --- | --- |
| Java 21 | tool cache hit, 1.2 s | downloaded in 20/20 jobs, median 4.8 s, worst 178 s |
| gcloud | downloaded every job, 6.5 s | downloaded twice per job, 11.7 s, worst 614 s |
| Node 26 | downloaded, about 6 s | downloaded, about 5.5 s |
| jq, tzdata, codeowners-cli | already present, 0 s | already present, 0 s |

### Earlier PoC (`camunda/infra-github-demo`)

Same tools and versions, 5 runs each (median install / job time):

| Approach | Runner | Install | Job | Run |
| --- | --- | --- | --- | --- |
| setup-* actions downloading | GitHub-hosted | 22 s | 36 s | [37939821782](https://github.com/camunda/infra-github-demo/actions/runs/37939821782) |
| Toolset layers from GHCR | GitHub-hosted | 14 s | 23 s | same |
| Toolset layers + GitHub cache | GitHub-hosted | 14 s | 25 s | same |
| Toolset layers from GHCR | self-hosted (GKE) | 19 s | 28 s | [37942159129](https://github.com/camunda/infra-github-demo/actions/runs/37942159129) |
