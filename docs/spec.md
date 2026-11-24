# infra-tools: high-level spec

Living spec for `camunda/infra-tools` ([camunda/team-infrastructure#1138](https://github.com/camunda/team-infrastructure/issues/1138), [proposal](https://docs.google.com/document/d/1ZvdW-dCIMUz1a9uiVACGCJ1U5vBAFGlzWbPxm0pVKb0/edit)), first written for the PoC. `main` restarted from scratch after the PoC (D55); the PoC implementation stays on the `poc` branch as reference until phase 1 is done. Sections 5 and 6 describe the target design, validated by the PoC; the code on `main` is built through the phase 1 tickets. Terms are defined in [`GLOSSARY.md`](../GLOSSARY.md); the decisions that are hard to reverse are recorded as ADRs in [`docs/adr/`](adr/). IDs are stable: entries are never deleted, only marked `superseded` with a link to their replacement. Status values: `proposed`, `decided`, `superseded` (requirements, decisions); `open`, `resolved` (questions).

## 1. Problem and goals

CI jobs download their tools at runtime from several third parties (Adoptium, GitHub `actions/node-versions`, `dl.google.com`, Maven Central, …). Each one is a point of failure: downloads occasionally stall a job for minutes or fail (INC-7417, INC-7943). The main wins are reliability and cost; speed improves significantly where we own the infrastructure, and depends on GitHub elsewhere.

| ID | Goal |
| --- | --- |
| G1 | Reliability: one co-located source per runner environment instead of several third parties, without a new single point of failure (ADR 0007). |
| G2 | Download time equal or faster than today, on GitHub-hosted and self-hosted Linux runners. |
| G3 | Remove download stalls (worst cases observed: 178 s JDK, 614 s gcloud). |
| G4 | Keep tool versions current with low effort, without gaps. |
| G5 | Negligible increase in storage and network transfer cost. |
| G6 | Same onboarding on every runner: one action step per job, versions updated by Renovate. |

Baseline and PoC results (`camunda/camunda`, `ci.yml` on `main`): see [section 9](#9-poc-plan-and-evidence).

## 2. Scope

Phases, in order (from the proposal's plan):

1. **Tools** (current phase): finish the repository, the action and the release mechanics, proven with the pilot tools java, node and maven (D51). Tools published for Linux on `amd64` and `arm64`; one action (ADR 0006) with closest-registry selection, fallbacks and per-tool logs; scheduled publication and releases, with failure alerts in `#infra-alerts` (D54), through failure issues (D63); mirrors on Artifact Registry and ECR, filled by the release (D61, D65, ADR 0007); install figures sent to CI Analytics; self-hosted tool cache moved to `/opt/hostedtoolcache` (D50, ADR 0009); fork PR access to the internal package tested (R18). Other tools are added through tool onboarding.
2. **Rollout to `camunda/camunda`**: onboard its workflows, with the mirror configured once per self-hosted runner set. Other repositories follow on demand.
3. **Self-hosted runner optimisation**: freeze the runner image (no new tools, removals where safe), then validate image volumes and image streaming for the most used tools, chosen from CI Analytics data.
4. **apt packages** (ADR 0008): a curated OCI apt repository read with apt-transport-oci, natively on Ubuntu 26.04 or earlier on 24.04 by shipping the plugin with the tools. Built in the PoC (D46, `poc` branch).
5. **Other platforms**: a selected set of tools for macOS and Windows, on `amd64` and `arm64`.
6. (Optional) **Usage-based recommendations**: tools and versions to retire, and frequently downloaded tools to pre-install per team.

Out of scope:

- Satellite actions in `camunda/infra-global-github-actions` (e.g. `submit-test-status`), kept unchanged, except `submit-build-status` loading install figures (D59, ADR 0010).
- Dev runners for `camunda/camunda`.
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
| R12 | Public consumers (including fork PRs) pull layers without credentials. | superseded by R18 (package stays internal, D48) |
| R13 | Downloads are retried and verified (layer digest). | decided |
| R14 | Each release lists the tool versions it added, replaced and retired compared with the previous release, for people and machines. | decided |
| R15 | Every upstream version within a tool's declared range is published, without gaps (bursts included). A version that fails to build or test is tracked in a failure issue, never skipped silently (D63). | decided |
| R16 | Every upstream build is a distinct version: builds of the same `X.Y.Z` (e.g. `21.0.12+8`, `21.0.12+101.0.LTS`) are all published. | decided |
| R17 | Each reconciler run verifies completeness: the versions it planned (upstream versions in range, neither ignored nor waiting for their `minAge`) − published − failed in this run with their failure issue must be empty, otherwise the run fails. A version waiting for a platform counts as published on the others; one planned after the run's plan is the next run's. | decided |
| R18 | Fork PRs of consumer repositories pull the internal package with their job token; verified by a test before the rollout. If it fails, fork PRs fall back to the usual `setup-*` download. | proposed |

## 4. Concepts

Terms are defined in [`GLOSSARY.md`](../GLOSSARY.md). Where each one lives in the repository:

| Term | In the repository |
| --- | --- |
| Tool definition | `tools/<tool>/`: `tool.json`, `install.sh`, `test.sh` (+ `Dockerfile` when needed). The folder name is the selector name. |
| Tool image | Single-layer `FROM scratch` image tagged `<tool>-<version>-r<revision>` (`+` written as `-`). |
| Tool release | GitHub release with the tool image's tag. |
| Catalog | `published/<tool>.json`; the only path that triggers a release. |
| Index | OCI artifact `<X.Y.Z>-tools`. |
| Release | Release-please release `X.Y.Z` of the action and the index, with JSON assets. |

## 5. Components

### 5.1 Repository layout

```text
infra-tools/
├── README.md                     # usage, tools available, add a tool / fix a build
├── CHANGELOG.md                  # release-please
├── GLOSSARY.md                   # domain language
├── action.yml                    # the action: tools and tool-cache inputs (camunda/infra-tools@…, ADR 0006)
├── action/setup.sh               # implementation of the action (outside scripts/, so that release-please can exclude scripts/)
├── tools/                        # one folder per tool: tool.json, install.sh, test.sh (+ Dockerfile when needed, D31)
├── docs/
│   ├── spec.md
│   ├── adr/                      # architecture decision records
│   ├── runbooks/                 # procedures of the failure issues (D63)
│   └── agents/                   # agent skills configuration
├── build/                        # image build: Bake and Dockerfiles (out/ gitignored)
│   ├── docker-bake.hcl           # targets of one tool version: builder, tool, test
│   ├── builder.Dockerfile        # build-platform image where install.sh runs (download, install-tool)
│   ├── tool.Dockerfile           # default tool build → FROM scratch tool image
│   └── test.Dockerfile           # runs test.sh on the target platform
├── scripts/                      # Node.js: plan, build, publish, record, run-failure, failure-issues, release, index, pull-request (+ lib/, test/)
│   ├── package.json              # renovate (getPkgReleases)
│   └── superseded.sh             # superseded-run guard of the reconciler
├── published/                    # bot-written record of published versions
└── .github/
    ├── CODEOWNERS
    ├── renovate.json5
    ├── renovate-preset.json5     # for consumers
    ├── config/                   # release-please-config.json, .release-please-manifest.json
    └── workflows/                # reconcile.yml, ci.yml (pull request checks: tests of the scripts and the action), release.yml, release-merge.yml (Q15)
```

### 5.2 Tool definition and build

`tool.json` has three blocks (D38): `source` (Renovate lookup options, passed as-is), `publish` (which versions are published) and `install` (tool cache layout), plus `setup` on tool-cache tools (their `setup-*` action, for the usage snippet of their tool releases, D53) and `test` (the apt packages its test needs); unknown blocks and options are rejected. Blocks with only defaults can be left out.

| Option | Default | Explanation |
| --- | --- | --- |
| `source.datasource` | required | Renovate source listing the tool's versions (e.g. `node-version`, `github-releases`, `java-version`). |
| `source.packageName` | tool name | Package to look up in that source; `{arch}` makes one lookup per platform. |
| `source.versioning` | the source's default | Version scheme Renovate reads versions with and that tells stable versions (e.g. `semver`, `maven`); ordering and `from` follow D23. |
| `source.extractVersion` | none | Regex turning an upstream tag into a version (e.g. `v26.11.1` → `26.11.1`). |
| `publish.lines` | required | Version lines to publish, keyed by a major (`"21"`), a minor (`"1.25"`) or `"*"` (versions in no other line). |
| `publish.minAge` | `1 day` | Wait after an upstream release before building it; a line can override it. |
| `install.cacheFolder` | tool name | Tool cache folder, matching what the tool's `setup-*` action expects (e.g. `Java_Temurin-Hotspot_jdk`). |
| `install.archFolders` | `{"amd64": "x64", "arm64": "arm64"}` | Arch folder per platform, as the `setup-*` action expects it (e.g. `aarch64` for Java). |
| `install.addToPath` | none | Folder added to `PATH`: the tool is a plain tool (`tools` input); without it, a tool-cache tool (`tool-cache` input). |
| `setup.action` | none | Tool-cache tools only: the `setup-*` action that configures the tool (e.g. `actions/setup-java`), with `setup.versionInput` (its version input, e.g. `java-version`) and `setup.with` (other inputs, e.g. `{"distribution": "temurin"}`). The usage snippet passes it the resolved version. |
| `test.packages` | none | apt packages the tool's `test.sh` needs on top of the Ubuntu image, as runners have them (e.g. `["openjdk-21-jre-headless"]` for maven, a Java runtime); without any, the test stage skips apt. |

Line options (`publish.lines.<key>`):

| Option | Explanation |
| --- | --- |
| `from` | Publish every version of the line from this one on (inclusive). Required on `"*"`. Without it, nothing new is published. |
| `versions` | Older versions of the line, always published (pins). Must be older than `from`. Not on `"*"`. |
| `ignoredVersions` | Versions of the line never published, such as a version that fails to build for good (ADR 0012); the line's `reason` says why, and is required with them. |
| `revisions` | Rebuild number per version, replacing an already published layer (e.g. `{"26.11.1": 2}`); must be above the highest published revision of that version, which the reconciler also raises by itself when a platform is added (D62). |
| `retired` | Versions of the line dropped from the next release index (older releases keep them), or `"all"` for every published version of the line (then only `reason` is allowed). |
| `minAge` | Overrides `publish.minAge` for the line. |
| `reason` | Why the line exists (JSON has no comments). |

Each version belongs to exactly one line: lines never overlap (`26` and `26.11` together, or a line at or above `"*".from`, are rejected), and `"*"` covers versions in no other line from its `from` on. A line's state follows from its options: with `from`, it publishes new versions; with only `versions`, only those; with neither, nothing new (stopped, kept for `retired` or `revisions`); with `"retired": "all"`, its versions leave the next release.

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

Lines (D41), per upstream version: find its line (the explicit line it belongs to, else `"*"` from its `from` on, else none → skip); `"retired": "all"`, `ignoredVersions` or `retired` → skip; in `versions` or `revisions` → publish (no stability or `minAge` check); older than `from` or no `from` → skip; unstable → skip; newer than `minAge` → wait; otherwise publish. Validation rejects unknown options, line keys that are not a major, a minor or `"*"`, empty lines (none of `from`, `versions`, `revisions` or `retired`), line options naming versions outside their line, `versions` at or above `from`, `"*"` without `from` or with `versions` or `"retired": "all"`, other options next to `"retired": "all"`, nested lines and lines at or above `"*".from`. The catalog, index annotations and release notes record each version's line.

- Build stages (`build/tool.Dockerfile`): `builder` image (build platform, never published) → `install` stage: `install-tool` runs `install.sh` with `VERSION`, `TARGETARCH`, `ARCH` (tool cache arch folder) and `DEST`, then marks `DEST` complete → `FROM scratch` tool image holding `/opt/hostedtoolcache/<cacheFolder>/<folder version>/<arch>` (D34), its image index annotated with the build commit (`org.opencontainers.image.revision`).
- Test stage (`build/test.Dockerfile`): each Ubuntu release our runners use (`UBUNTU_RELEASES`, D58) on the target platform with the tool's `test.packages` (apt skipped when it has none), layer copied in, `test.sh` run with `VERSION` and `TOOL_DIR`; never published.
- Version differences: `if version ≥ X` in the default `install.sh` and `test.sh` (D22).
- Versions with build metadata: `+` is written as `-` in folder names and tags (`java-21.0.12-101.0.LTS-r1`).

### 5.3 Reconciler

Runs on a schedule, on push to `main` and on demand; one run at a time: no other workflow pushes tool images, and the tag of a tool image is checked, then written, so two runs must not push the same one.

A run whose tool definitions no longer match `main`'s tip publishes nothing: the run on the tip does. Each job (plan, every build, record) first compares the run's commit with the tip, `published/` aside, since record commits start no run; when they differ, the run is superseded (a rerun of an older run, or `main` changed during the run), and the job skips its steps, stays green and says so in its summary. A superseded plan plans no builds, and a superseded run files no failure issues: the run on the tip, which the change to `main` starts, files the failures that persist. Images a superseded run already pushed stay unrecorded until the run on the tip records them, when still within its lines and built with its `install` block (safeguards below).

1. Plan, per tool:
   - List upstream versions per platform; keep versions available on at least one platform (D62); a platform missing upstream waits, and is reported in the job summary after 7 days.
   - Apply each version's line (D41): `from` (inclusive), `versions`, `ignoredVersions`, `revisions`, `retired`, stability, `minAge`.
   - Deduplicate by exact string only; order with build metadata (D23).
   - The plan reads no GitHub state (ADR 0012): the same tool definitions, upstream and registry give the same plan. A version that failed in an earlier run is planned again, until it builds or its line ignores it (`ignoredVersions`).
   - Plan = remaining versions without a published tag `<tool>-<version>-r<revision>` (the registry's tag list; a registry error that persists past the retries fails the run): each builds every platform upstream has, at the revision of its line (1 by default). A manual revision above the highest published one builds every platform again.
   - A published version whose platform set grew upstream is planned as the next revision (the highest published one plus one, or the manual `revisions` value when higher): it builds only the new platforms and its image index reuses the existing platforms' manifests and layers (D62).
2. Build and test each planned version and platform (Bake).
3. Publish each success: push the tool image, create the tool release (skip if it exists).
4. Record: plan again on the latest `main`, whose tool definitions are the ones the builds used (the run is not superseded), which also finds earlier pushes never recorded; update its `published/<tool>.json`, one commit per run on top of it with one conventional entry per version (`feat(node): publish 26.11.2`, `feat(java): publish 21.0.13+5 for amd64` while upstream lacks a platform, then `feat(java): publish 21.0.13+5 for arm64 (r2)`, `fix(java): republish 21.0.12+101.0.LTS (r2)`, `feat(node)!: retire 24.19.0`); a catalog entry lists its `platforms` only while upstream lacks some (D62): the first as subject, the others in `BEGIN_NESTED_COMMIT`/`END_NESTED_COMMIT` blocks, which release-please reads as one commit each.
5. Failure issues (ADR 0012, D63, §5.8), in the run's last job, also after failed jobs:
   - Tool failures: a failed build or test leaves its build job green and hands its failure over (tool, version, step, log excerpt). The failures of one tool and major go to its failure issue (label `tool-failure`): each failing version with its step, line, tag and platforms, its error, the command that reproduces it (`node scripts/build.mjs <tool> <version>`) and the two fixes, from `docs/runbooks/tool-failure.md`: change the build in a pull request that refers to the issue, or ignore the versions (`ignoredVersions`, with the line's `reason`). The run stays green, and every run builds the versions again; the issue closes once none of them is planned (published or ignored), and a run reopens it, even closed by hand, while one still fails. The issues of a tool removed from `tools/`, or of a major no line holds any more, are closed by hand: no run checks them again.
   - Run failures: a failed step of the plan, a build job (`push`), the record job (`record`) or the completeness check (`completeness`) reports the end of its log (a job that fails or times out before reporting gets a report without a log; a build job's comes from the completeness check) to the failure issue of its step (label `run-failure`, `docs/runbooks/reconcile/<step>.md`), the push failures of several build jobs in one issue. The run fails. Registry and GitHub API calls retry transient errors (network errors, rate limits, server errors) with backoff, call by call, inside the scripts, so a step fails, and opens its issue on the first failed run, only when its error persists; failed jobs are not rerun. The issue of a step that ran and passed closes.
6. Completeness check (R17), before the failure issues are written, against the run's plan (`builds.json`): the versions the run built − published − failed in this run must be empty: a version neither published nor failed, such as one whose build job failed or timed out, fails the run. A version planned after the run's plan (its `minAge` passed meanwhile) is the next run's. It also gives the tool failure keys the run checked: those of every tool and major with no such version.

Scripts (`scripts/`): `plan.mjs` (1, 6, and the tool failure reports), `build.mjs` (2, push), `publish.mjs` (tool releases), `record.mjs` (4), `run-failure.mjs` (run failure reports), `failure-issues.mjs` (5), `superseded.sh` (superseded runs).

Safeguards: never overwrite a tag; fail when a version of the catalog lost its tag; fail when a tool image to record was built with another `install` block than its tool definition's (`tool.json` at the image's build commit, fetched by record when missing; an unreadable one fails too): the action installs from the tool cache path the pinned `tool.json` gives, so a revision bump builds it again; fail when a version in a line's `versions` or `revisions` is not found upstream (a typo or a delisted version); datasource or registry outages that persist past the retries fail the run (never read as "no versions"); retention policies exclude `*-r*` tags.

### 5.4 Pull requests

Jobs of `ci.yml` on pull requests, read only: nothing is pushed or published.

- Plan and build in dry run: planned versions, as the reconciler plans them (no GitHub state: a version that fails is planned, so a PR touching its tool, or the shared build, fails until it fixes the version or ignores it, ADR 0012), plus the latest published version per major of every tool whose files changed (`tools/<tool>/`; the shared build, `build/`, `scripts/build.mjs` and `scripts/lib/build.mjs`, changes every tool), built and tested without `--push` on the platforms the reconciler builds (a published version on those its tool image holds, D62). Published versions are the catalog's entries the PR's tool definition does not retire, as the release notes preview counts them: a version stays available until it is retired, even out of every line or delisted upstream, and a version the PR restores is checked before it is available again.
- Warn when a published version's build files changed without a revision bump: its tool image files, not its tests (`test.sh`, `build/test.Dockerfile`), and `tool.json` only when its `install` block changed.
- Fail when a `revisions` value the PR adds or changes is not above the highest published revision of its version (D62), from the registry's tag list: it would build nothing, since the reconciler can have raised the revision itself.
- Comment the release notes the next release would produce: the latest release's index + the catalog + the planned versions − retired versions, compared with the latest release's index. One comment per PR, updated on each push, and updated to say so when a later push no longer changes tools; fork PRs get it in the job summary only.
- The latest release, for the comment and the action tests, is the latest published one: GitHub's latest release (`GET /releases/latest`), whose `X.Y.Z-tools` index they read (ADR 0013). A draft is never the latest release, so an index pushed before its release is published is never used; no published release, or a latest release that is not `X.Y.Z`, fails the checks. The PR checks also fail when the base predates the latest release (a rerun of an older run): its catalog can hold a lower revision than the release's index, so they ask for a push or a branch update instead.

Script: `pull-request.mjs` (plan, warnings and comment; the build jobs run `build.mjs`).

### 5.5 Releases

Tool releases:

- Created by the reconciler when it publishes a tool image; tag `<tool>-<version>-r<revision>` on the commit the layers were built from (the tool image's build commit annotation, whichever run or workflow pushed it), never marked latest (GitHub shows the newest one as latest until the first `X.Y.Z` release exists). A tool image without that annotation (pushed before it was set) fails the run before its record commit; a revision bump builds it again with one.
- Content: upstream project link, usage snippet (action and selector), tool cache path, layer digest and size per platform, image digest, line, revision and build commit. `publish.mjs --update` rewrites existing releases and moves their tag.

Releases (release-please, D25):

- One component at `.`, `exclude-paths`: `tools`, `docs`, `build`, `.github`, `.lint` and `scripts`; `deps` and `docs` commits hidden from the changelog, as `chore`, `ci` and the other types that change neither the action nor the catalog. Bot record commits (`published/`) and action changes (`action.yml`, `action/`) produce release PRs: release-please ignores a commit whose files are all under `exclude-paths` (folders only, never root files), and opens no release PR when every commit left has a hidden type (no changelog entry), such as Renovate updates of root files (`.pre-commit-config.yaml`, `.tool-versions`) and README changes. Root files cannot be excluded, so a `feat` or `fix` commit that also touches one (`README.md`, `.gitignore`, `Makefile`, …) lands in the changelog: a commit that changes neither the action nor the catalog uses a hidden type (`ci`, `chore`, `build`, `docs`, …), even when it updates the README.
- Config in `.github/config/` (infra convention); tags `X.Y.Z` (D30).
- A daily workflow (`release-merge.yml`) enables GitHub auto-merge on the open release PR as the Infra - Releases App, not a bypass actor of the `main` ruleset (D56): GitHub merges it once its required checks (Check CI, Check Lint, Check Licenses) pass, which needs the repository setting "Allow auto-merge" on; the merge creates `X.Y.Z` as a draft release, without its tag (D60). A release PR labelled `no-merge` is left alone. A release PR an earlier run already set to auto-merge and still open fails the run, naming the PR whose required checks fail, unless they are still running. A failure fails the run, with guidance in its job summary, and alerts `#infra-alerts` directly, with the run link and `gh workflow run release-merge.yml` (no failure issue: the fix is a rerun or the release PR's checks); a transient GitHub error, which `rerun-failed-jobs` retries, alerts only on the last attempt, or when the rerun cannot be requested.
- One job (`release.yml`, ADR 0013, D64), on every push to `main` and on manual runs (a fix that needs no push: a retargeted draft, a mirror back up), whose steps each check their own end state and do nothing once it is reached, so a run repeated after any failure completes the release without cleanup:
  1. release-please (`googleapis/release-please-action`, called directly with `skip-github-pull-request`, as the Infra - Releases App) creates `X.Y.Z` as a draft release, named `X.Y.Z` (`include-v-in-release-name: false`), when its release PR was just merged.
  2. `release.mjs` publishes the draft (`lib/publish-release.mjs`), from the tool definitions and `published/` at its target commit, as steps that stop at the first failure. Every draft update sends its `tag_name` and `target_commitish`: GitHub resets the tag name of a draft updated without it. The token has `workflows: write`: the draft's target is a commit `main` has moved past, and one that changes a workflow file can only be released with it. Its log holds each step in a collapsed group, then the step's outcome and duration; a mirror copy logs each layer (copied, with its size, duration and speed, or present) and a total, and each retry of a registry request its attempt, wait, method, URL without its query, and status or error. The steps:
     - `drafts`: at most one draft, whose tag name is `X.Y.Z`; a second draft, or one whose tag name GitHub reset (`untagged-<hash>`), fails instead of being skipped. Without a draft, every step is done.
     - `index`: index = previous index + `published/` entries − retired versions, failing when a declared entry has no tag; the per-platform artifact manifests and the `X.Y.Z-tools` index are pushed to `ghcr.io`, unless the tag already has the index's digest. No layer is uploaded twice.
     - `mirror.<name>`: the index is copied to every mirror (D65), with its per-platform manifests and layers, the same bytes, so the same digests; layers already there are skipped and the index tag is pushed last, so an interrupted copy leaves the tag as it was. A mirror that holds the tag with the same digest is left alone; one whose tag points to other content, such as the earlier index of a retargeted draft, gets the index of `ghcr.io` instead, logged: nothing reads it before the release is published. Each mirror is tried, then a failed one stops the release. The Artifact Registry mirror of the GKE runners is logged in with GitHub OIDC (Workload Identity Federation) as `infra-tools-mirror-sa`, the ECR mirror of the EKS runners with GitHub OIDC as the IAM role `infra-tools-mirror` (`aws ecr get-login-password`, Basic auth as `AWS`); each can only write its repository, without delete, and only from `main`; a failed login fails that mirror's step.
     - `notes`: the Added / Replaced / Retired tables (with tool release links) after the release-please changelog, and `tools.json` (every tool version per platform with its tag, layer digest and size), uploaded by release id, replacing one a failed upload left; each is written only when it differs.
     - `undraft`: the draft published as the latest release, which creates tag `X.Y.Z` on its target and starts its workflows.
  3. release-please (`skip-github-release`) opens or updates the next release PR, only once every step passed: no draft is left, so its changelog starts at the latest release's tag.
- A step of `release.mjs` that fails is a run failure (ADR 0012), in the failure issue of its step and release (`release/drafts`, `release/index/<release>`, `release/mirror.<name>/<release>`, `release/notes/<release>`, `release/undraft/<release>`), with its runbook in `docs/runbooks/release/`; a step cut by its timeout is reported without its error. The release stays a draft, without its tag, so the action is never pinned to a release whose index is missing from a registry, and no release PR is opened until it is published. A release that fails for good is fixed on `main`, then its draft retargeted to that commit (`gh api -X PATCH repos/camunda/infra-tools/releases/<id> -f tag_name=X.Y.Z -f target_commitish=<sha>`) and the workflow run again. A failure of another step of the job (secrets, token, release-please, Node.js setup) is the `release/setup` run failure, whose report names the failed steps (`run-failure.mjs release setup`, runbook `docs/runbooks/release/setup.md`); it closes once a run reaches the release steps without one.

### 5.6 Action

- `camunda/infra-tools@<sha> # X.Y.Z`, one action with two selector inputs (D47, ADR 0006): `tools` for plain tools (`tool.json` with `addToPath`), ready to use; `tool-cache` for tool-cache tools (`tool.json` without `addToPath`), pre-filled in the tool cache so the `setup-*` step finds them. A tool listed in the wrong input fails with a message naming the right input.
- Implementation: `action/setup.sh` (bash, curl, jq). The release version is read from the release-please manifest at the pinned commit; there is no `version` input.
- Inputs: `tools` and `tool-cache` (selectors, one per line), `token`, `mode` (`extract`, `validate`), `index` (override, for tests), `summary` (`true`: table of the selected tools in the job summary).
- Log: the release and platform, one line per tool (selector, resolved version, `installed` with size, duration, speed and registry, or `cached`, and the tool cache path) and a total; login and index timings in a collapsed group; layer digests as debug messages. Output: `versions`, JSON of the resolved version per selected tool in the form `setup-*` actions expect (`{"java":"21.0.12+101.0.LTS"}`, read with `fromJSON(steps.<id>.outputs.versions).java`); `{}` when nothing is installed (D43).
- Install figures (D59, ADR 0010): one JSON line per selected tool appended to `$RUNNER_TEMP/ci-analytics/tool-installs.jsonl` as soon as its outcome is known, with `tool`, `selector`, `version`, `outcome` (`present`, `installed`, `failed`), `error` for a failure (`login`, `index`, `pull`, `extract`), `size_bytes`, `duration_ms` and `registry` (the host the layer came from) for an install, `release` (the index tag) and `platform`. No repository or runner set: the build status row already holds them.
- Tool layouts (cache folder, arch folders, `addToPath`) come from `tools/*/tool.json` at the pinned commit, so present tools need no network.
- Flow:
  1. For each selector, look for a complete matching version in `$RUNNER_TOOL_CACHE`; if every tool is present, stop (R4, R5).
  2. Otherwise fetch `X.Y.Z-tools` from the runner set's mirror, or GHCR without one, and pick the platform manifest.
  3. Resolve each missing selector to the highest matching version, build metadata included, among the versions of the runner's platform manifest (D62); fail if none, with a message that says so when the version is published for another platform only (not published for this platform yet), instead of a generic "version not found".
  4. Pull each missing layer by digest, verify it, extract it into the tool cache and mark it complete; retry on failure.
  5. Plain tools only: add `addToPath` folders to `PATH`; link docker-compose as a Docker CLI plugin; link Maven for `./mvnw` when `.mvn/wrapper/maven-wrapper.properties` asks for the same version (D32).
- Selectors: `java@21` and `java@21.0.12` resolve to the highest build; an exact build can be pinned (`java@21.0.12+8`, `-` accepted). A selector resolves per platform (D62): `node@26` can give a newer version on one platform than on another while a platform is waiting for a version.
- Non-Linux runners: no-op. `mode: validate` checks a repository's selectors against the pinned index.
- apt source (D46, phase 4, D55): on Ubuntu runners with passwordless sudo, install apt-transport-oci, write the registry credentials to root's Docker config, add the release's repository for the runner's Ubuntu release (priority 600) and refresh only that source; on failure, remove it and warn.
- Mirror (D44, D48, ADR 0007): with `INFRA_TOOLS_MIRROR` set in the runner environment, the action reads `<mirror>/camunda/infra-tools:<tag>` instead of `ghcr.io/camunda/infra-tools:<tag>` (indexes on other registries ignore it); on `*.pkg.dev` it sends the GKE metadata server token (Workload Identity) as bearer token directly, skipping the registry token endpoint (occasionally ~5 s on Artifact Registry); on `<account>.dkr.ecr.<region>.amazonaws.com` it gets an ECR token with the pod's IRSA role (STS `AssumeRoleWithWebIdentity` with its web identity token, then `GetAuthorizationToken` signed with `curl --aws-sigv4`, no AWS CLI) and sends it as Basic auth on every request, layer downloads redirecting to S3 without it; elsewhere it exchanges `token`. When the mirror fails, for the index or for a layer, it warns and reads ghcr.io for the rest of the step. GKE runner sets point to the Artifact Registry repository `europe-west1-docker.pkg.dev/ci-30-162810/infra-tools`, EKS runner sets, once a release has filled it, to the ECR repository `463214588456.dkr.ecr.eu-central-1.amazonaws.com/camunda/infra-tools` (#16), both managed in `camunda/infra-core` and filled by the release (D61, D65). The release copies only its own index: a mirror added later lacks the earlier ones, and runners pinned to an earlier release fall back to ghcr.io, with the warning, until they move to a release it holds.

### 5.7 Renovate

| What | Where | How |
| --- | --- | --- |
| Tool versions | `tools/*/tool.json` | Not Renovate: the reconciler (D21). |
| Repository dependencies | `scripts/package.json` (renovate), actions, base images | Default Renovate config. |
| Renovate PRs | This repository | Rebased on conflicts only; adding the `rebase` label to a PR rebases it once (`.github/renovate.json5`). |
| Action pins | Consumer workflows | Renovate's built-in github-actions manager (`@<sha> # X.Y.Z`, D30). |
| Selectors | Consumer `tools: \|` and `tool-cache: \|` blocks | Preset `github>camunda/infra-tools//.github/renovate-preset.json5`: custom datasource reading `published/<tool>.json` at the pinned tag through the contents API (D29); npm versioning keeps each selector's precision; exact build pins are left alone. |

### 5.8 CI conventions

Workflows follow the infra team's reference repository, [`camunda/infra-services-demo`](https://github.com/camunda/infra-services-demo) (D57), except its application-specific parts (Maven, deployments, Harbor images):

- Permissions: root `permissions: {}`, minimal grants per job, each non-obvious scope with a reason comment (e.g. `id-token: write # Vault OIDC/JWT auth`).
- Every job sets `timeout-minutes`; every job and step has a `name:`; workflow files are kebab-case.
- Pinning: third-party and `actions/*` by SHA with a version comment; `camunda/*` actions by ref. zizmor runs with all audits enabled and this pinning policy.
- Steps pass values through `env:` rather than inline `${{ }}`; longer logic lives in scripts, tested like the rest of the code.
- Checkouts that don't push use `persist-credentials: false`. No harden-runner.
- Secrets come from Vault with JWT (`hashicorp/vault-action`); GitHub App tokens are minted from Vault-stored credentials.
- Each workflow of several jobs exposes one always-run aggregate job (e.g. "Check CI", "Check Lint") as its required check, failing when a needed job failed or was cancelled; a single-job workflow, such as the release, needs none.
- The reconciler retries transient registry and GitHub API errors inside its scripts, call by call (ADR 0012); the release retries them inside `release.mjs` the same way; `release-merge.yml` retries transient failures with `rerun-failed-run`. Failure guidance goes into `$GITHUB_STEP_SUMMARY`.
- Failure issues (D63, ADR 0012): a reconciler or release failure opens or updates its failure issue through `scripts/failure-issues.mjs`, written with the job's `GITHUB_TOKEN` (`issues: write`). Its key, in a hidden marker (`<!-- infra-tools: failure {...} -->`), is the tool and major of a tool failure (label `tool-failure`), or the flow and step, and release, of a run failure (`run-failure`). A new error on the key (a changed error, or a new failing version) comments; the same error, BuildKit timings and hashes aside, only updates the last failed run. A run closes, with a comment, the open failure issues of the keys it checked and no longer fails, and reopens a closed one, even closed by hand, while its failure lasts. The issue holds the failure's context, observed state and error, then its runbook, `docs/runbooks/tool-failure.md` or `docs/runbooks/<reconcile|release>/<step>.md`: likely causes and their fix, the procedure with its commands, how to verify, and which commands an agent may run unattended (`docs/runbooks/README.md`; a runbook missing a section fails the run and the tests). Opening or reopening one posts one line to `#infra-alerts` (`SLACK_WEBHOOK_INFRA_ALERTS`, Vault `secret/data/products/infra/ci/infra-core`), with its title and link; updates and closing post nothing. `release-merge.yml` alerts `#infra-alerts` directly (§5.5).
- Concurrency only where runs can conflict: `cancel-in-progress: true` for PR validation, `false` for the reconciler and releases.
- Light jobs run on `ubuntu-latest`; self-hosted runner labels used in workflows are declared in the actionlint config.
- Lint through pre-commit, locally and in CI: pre-commit-hooks, actionlint, zizmor, shellcheck, conventional commits, mdformat, renovate-config-validator, yamlfmt and yamllint; PR titles are validated with `teams/infra/pull-request/validate-title`.
- Licenses are checked with FOSSA; Renovate extends the infra presets and automerges GitHub Actions minor/patch, pre-commit hooks and lock file maintenance.

## 6. Flows

| Flow | Steps |
| --- | --- |
| New upstream version | Upstream releases → after `minAge`, the reconciler builds, tests, publishes it and records it → next daily release adds it. |
| Burst of versions | Each version is planned on its own; all are published (R15). |
| New major | Published by `"*"` once released (D41); consumers move to it through their selectors. To keep an older major maintained, PR adds its line and moves `"*".from` past it. |
| Build failure | Failure issue of the tool and major opened or updated, run green → PR with the fix (`if version ≥ X`) refers to it → PR CI green → merge → next run publishes and closes the issue. |
| Won't build | PR adds the version to its line's `ignoredVersions`, with the line's `reason` → merge → next run no longer plans it and closes the issue. |
| New tool | PR adds `tools/<tool>/` (`tool.json`, `install.sh`, `test.sh`) → PR builds and tests it → merge → reconciler publishes. |
| Override | PR bumps the version's revision in its line → reconciler publishes the new tag → next release lists it under "Replaced". |
| Retire | PR adds the version to its line's `retired` (or `"retired": "all"`) → bot records it (`feat!`) → next release removes it; older indexes keep it. |
| Stop a line | PR removes the line's `from` (and `versions`), or the whole line when it has no `retired` or `revisions` left → nothing new is published for it; published versions stay. |
| Release | Daily: release PR merged if green → draft `X.Y.Z` → index on `ghcr.io`, then on every mirror → notes and `tools.json` → draft published, tag `X.Y.Z` → next release PR. A failed step opens its failure issue; the release stays a draft until a run completes it. |
| Consumer update | New release → Renovate bumps the action pins (release notes in the PR body) → selectors checked against the new `<tool>.json` → PR CI fails if a selector no longer matches. |

## 7. Decisions

| ID | Decision | Options considered | Why | Status |
| --- | --- | --- | --- | --- |
| D1 | Separate image and package, independent of the runner image, same upstream base for tests (ADR 0001). | Extend the runner image | Independent lifecycle; no impact on runners. | decided |
| D2 | One layer per tool version in the tool cache layout (ADR 0002). | Tarball per tool; generic OCI artifacts | `setup-*` actions find tools without change; one layer can be pulled alone. | decided |
| D3 | Index as OCI artifact `X.Y.Z-tools` referencing existing layers, plus a GitHub release pointing to it (ADR 0004). | `tools.json` release asset only | The action only needs the registry; no layer is uploaded twice. | decided |
| D4 | Renovate selector data as release assets (`<tool>.json`). | Read the OCI index | A Renovate custom datasource cannot perform the registry token exchange. | superseded by D29 |
| D5 | Present = complete matching version in the tool cache only. | Also probe binaries on `PATH`; known system paths | Predictable; binaries outside the tool cache stay the job's concern. | decided |
| D6 | Selectors at the precision the consuming CI accepts. | Exact versions | Exact versions miss compatible tools already present. | decided |
| D7 | No GitHub Actions cache for tools. | Cache the extracted tools | Measured no gain (14 s with and without), 343 MB of cache quota per toolset version. | decided |
| D8 | Docker Bake, one folder per tool, overrides per line. | Single Dockerfile; data file + generator; `crane append` | Readable layout, per-version builds, BuildKit caching. | superseded by D22 (Bake and folder per tool kept) |
| D9 | One image per tool version; incremental publishing; index accumulates across releases. | Rebuild everything with registry cache; build on the previous release | Nothing is rebuilt; overrides and retirements are explicit. | decided |
| D10 | Build when the tag `<tool>-<version>-r<revision>` is missing; revisions per version. | Compare with the previous index; recipe hash | One rule for new versions and overrides; safe to rerun. | decided |
| D11 | Majors through a `current` line plus a fork workflow. | One manual PR per major | Renovate cannot add a version line on its own. | superseded by D21 |
| D12 | PoC published from the `1138-*` branch of `infra-actions-runner` by a manual tag, to GHCR only. | Releases from `main`; GAR | PoC only; no impact on `main`. | superseded by D26 |
| D13 | Self-hosted runner image out of scope. | Assemble it from the tool images | Focus on the action and the index first. | decided |
| D14 | Satellite actions of `infra-global-github-actions` unchanged in the PoC. | Route gcloud versions through them | Keeps the PoC small. | superseded by D59 |
| D15 | `camunda/camunda` calls the action centrally in `setup-build` and `build-frontend`; single-job tools per job; redundant setup steps removed. | Per job only | Covers most jobs with two call sites. | decided |
| D16 | Measure with one PoC branch compared against BigQuery history. | Paired baseline and toolset branches | Enough for a first signal. | decided |
| D17 | No dev runners for `camunda/camunda`. | Dev runner group with the toolset image | The action must work on today's runners. | decided |
| D18 | Manual releases for the PoC; automatic releases with a derived semver later. | Automatic from the start | Not needed to prove the gain. | superseded by D25 |
| D19 | Tool images are pushed on merge; a release only assembles the index from existing tags. | Push tool images during the release | Fast releases with no build. | superseded by D21 |
| D20 | Release notes include the Added / Replaced / Retired tables from comparing the new index with the previous one, and as a dry-run comment on PRs. | Hand-written notes; git log only | Lists exactly what consumers gain or lose; reviewers see the next release before merging. | decided |
| D21 | A scheduled reconciler publishes every upstream version in range (Renovate datasources) and opens fix PRs for failures, grouped per tool and major when the error matches (ADR 0005). | Renovate PR per version line; reconciler without PRs ([containerbase](https://github.com/containerbase/node-prebuild)); moving lines (docker-library) | No gaps (R15), bursts handled; review where it matters; same model as [actions/node-versions](https://github.com/actions/node-versions). | decided; fix PRs replaced by failure issues (D63) |
| D22 | Version differences with `if version ≥ X` in the default `install.sh` and `test.sh`; per-range override folders only if needed later. | Per-line folders from the start | Most tools are download-and-unpack; same approach as GitHub's builders. | decided |
| D23 | Version identity is the exact string; ordering includes build metadata; `startVersion` inclusive; ranges resolve to the highest build; exact builds can be pinned. | One build per `X.Y.Z` (newest replaces older) | Keeps every build (R16); semver equality would drop builds. | decided |
| D24 | One GitHub release per published tool version, created directly by the reconciler (idempotent). | No per-tool release; release-please per tool | Traceability per version; release-please cannot release upstream-driven versions. | decided |
| D25 | Releases via release-please, driven by the bot record commits in `published/`, release PR merged daily if green. | Own daily job deriving semver from the index comparison; no index ([containerbase](https://github.com/containerbase/base) URL convention) | Same release flow as other repositories; in-repo record of published versions. | decided |
| D26 | Dedicated public repository `camunda/infra-toolset`; `tools/` and docs prominent, build tooling (`.build/`), catalog (`.catalog/`) and action implementation (`.action/`) hidden. | Subfolder of `infra-actions-runner` | Own release flow and tags; public package and assets for public consumers. | superseded by D37, layout by D42 |
| D27 | The action lives at the root of `camunda/infra-toolset`, with one version line for the action and the toolset; no `version` input. | Action in `infra-global-github-actions` with a `version` input | One pin gives a consistent action and index; simpler Renovate. | superseded by D37 (one version line kept) |
| D28 | Publish a version only when available for every platform; open a fix PR after N days otherwise. | Publish per platform as available | An index entry must exist for every platform. | replaced by D62 |
| D29 | Renovate selector data read from `published/<tool>.json` at the release tag through the GitHub contents API; the release only attaches `tools.json`, for people and scripts (ADR 0004). | Release assets (D4) | Works while the repository is internal (Renovate sends its token to `api.github.com`), no extra file. | decided |
| D30 | Release tags `X.Y.Z` (infra convention, release-please config in `.github/config/`); the action pin is tracked by Renovate's github-actions manager. | `toolset-X.Y.Z` with a custom manager | Tool release tags (`node-26.11.2-r1`) are not versions, so no prefix is needed. | decided |
| D31 | One generic `build/tool.Dockerfile`; a tool adds its own `Dockerfile` only when needed (python). | A Dockerfile per tool | 14 of 15 tools build the same way. | decided |
| D32 | The action links the tool cache Maven into `~/.m2/wrapper/dists/<name>/<hash>` when the wrapper asks for the same version. Only the script-only `./mvnw` of Maven Wrapper 3.3+ (`distributionType=only-script`) uses that folder; `MVNW_REPOURL` is not honoured (`./mvnw` hashes the rewritten URL): in both cases `./mvnw` downloads Maven. | Only `mvn` on `PATH`; drop Maven | `./mvnw` uses it without downloading (same hash as `mvnw`). | decided |
| D33 | Build scripts in Node.js (ESM, no build step, `node:test`); bash for `install.sh`, `test.sh` and the action. | TypeScript; bash scripts | `plan` needs Renovate's library; no compile step. | decided |
| D34 | Tool image layers hold `opt/hostedtoolcache/...`; the action strips two path components (ADR 0003). | Tool cache folders at the layer root | Layers stay usable as-is by a future runner image (D13). | decided |
| D35 | Node versions use `semver` versioning. | Renovate's `node` versioning | `node` versioning marks non-LTS majors (Node 26 today) unstable, which would skip them. | decided |
| D36 | Python from GitHub's prebuilt archives, installed with their `setup.sh` on the target platform. | Build from source | Same build as GitHub-hosted runners; only runs from `/opt/hostedtoolcache` (Q5). | decided |
| D37 | Repository `camunda/infra-tools` (renamed from `infra-toolset`) with two actions on one version line: `tool-cache` (tools with a `setup-*` action, pre-fills the tool cache) and `setup` (plain tools, ready to use); each rejects the other kind; no root action. | One root action; `cache` instead of `tool-cache`; names `infra-toolset`, `infra-prebuilt-tools`, `infra-ci-tools` | Each name matches what happens: java still needs `setup-java`, jq needs nothing; `tool-cache` avoids confusion with `actions/cache`. | superseded by D42 (repository name and two actions kept) |
| D38 | `tool.json` grouped in three blocks: `source` (Renovate lookup), `publish` (versions to publish), `install` (tool cache layout). | Flat options; YAML with explicit version lines; JSON schema only; datasource presets | Each block has one reader and one meaning; `source` is passed to Renovate unchanged; readable without new syntax. | decided |
| D39 | No upper bound: `startVersion` is the latest stable version when a tool is added, so every newer version (majors included) is published; older versions a CI pins today go in `extraVersions` and get no new patches. First publish for `camunda/camunda` `ci.yml`: 23 versions instead of 67. | `startVersion` at the version a CI uses (publishes every major since, e.g. Java 22–27); per-line ranges keeping older lines patched | Minimal first publish, new majors without edits; a CI that needs patches of an older line adds its versions or a range. | superseded by D41 |
| D40 | Publish defaults with per-line overrides: `publish.lines` keyed by major or minor, each with `startVersion`, `allowedVersions`, `minAge`, `frozen` and an optional `reason`; versions in no line follow the defaults (new majors). Lines replace `extraVersions` for older versions a CI uses, so they keep getting patches. First publish for `camunda/camunda` `ci.yml`: 26 versions. | `series`, `overrides`, `versionOverrides`, `majors`/`minors` maps; a list with match ranges; one file per line | Short domain term (Node.js and Java "release lines"); a line reads as "keep this one maintained"; `reason` documents why, since JSON has no comments. | superseded by D41 |
| D41 | Version lines only: `publish.lines` keyed by a major, a minor or `"*"` (versions in no other line, from its `from` on); a line has `from`, `versions` (older pins), `ignoredVersions`, `revisions`, `retired` (or `"all"`), `minAge` and `reason`; lines never overlap; stopping a line = removing its `from`. Replaces the top-level `startVersion`, `allowedVersions`, `extraVersions`, `ignoredVersions`, `revisions`, `retired` and `frozen`; fix PRs start from an empty commit. | Defaults plus per-line overrides with a `frozen` flag (D40); `*` with longest-match precedence; `extraVersions` at the top level | One concept covers every case; the file alone tells which rule applies to each version; everything about a version sits under its line. | decided |
| D42 | Root action for plain tools (`camunda/infra-tools@…`) and `cache` for tools with a `setup-*` action (`camunda/infra-tools/cache@…`); no dot folders: `build/` (Bake and Dockerfiles), `scripts/` (Node.js scripts and the action implementation `scripts/action/setup.sh`), `published/` (bot-written record of published versions). | `tool-cache` and `setup` subfolders (D37); `.build/`, `.action/`, `.catalog/`; `catalog/`, `released/`, `versions/` | Plain tools are the common case and get the shortest `uses:`; `cache` says what it fills; each folder says what it holds; `published/` matches the publish step. | superseded by D47 (folder layout kept; the action implementation later moved to `action/setup.sh`, so release-please can exclude `scripts/`, §5.5) |
| D43 | One JSON output `versions` on the action (`fromJSON(steps.<id>.outputs.versions).java`), `{}` when nothing is installed. | One declared output per tool; both | Composite actions only expose declared outputs, so per-tool outputs need an `action.yml` edit for every new tool; an unknown output and an unknown JSON key are both empty, so per-tool outputs catch no more typos; adding a tool stays a `tools/<tool>/` folder. | decided |
| D44 | Runner-level mirror: `INFRA_TOOLS_MIRROR` in the runner environment points the action to a copy of the registry (Artifact Registry for GKE runners, same digests), with Workload Identity credentials and fallback to ghcr.io. | Artifact Registry remote repository in front of ghcr.io (needs a PAT, as the package cannot be public); `index` input per workflow | No workflow change; no long-lived credential; same-region pulls for self-hosted runners; ghcr.io stays the source of truth. | decided (ADR 0007); mirror filling: D48, D61 for Artifact Registry |
| D45 | Bootstrap with the latest version of each line: `from` set to the latest patch (go `1.25`, node `24` and `26`, helm), the older Java 21.0.12 build ignored; pins in `versions` kept. First release: 20 versions (4 published during the PoC, 16 built from `main`). | Every version from the original `from` (27 versions) | Nothing consumes the older patches yet; halves the first build; a CI pinned to an older patch keeps its usual download. | decided |
| D46 | apt packages over OCI: curated packages per Ubuntu release (`apt/<suite>.json`) plus the dependencies a plain image lacks, built into one apt repository (no Recommends, `Release` generated inside `dists/<suite>`), tested offline, pushed as one OCI artifact in the apt-transport-oci layout (one layer per file) and referenced from the `X.Y.Z-tools` index; the action adds it as a pinned, `trusted=yes` apt source (priority 600, Ubuntu mirrors as fallback) and install apt-transport-oci from the release (static build of the upstream release). Built from the live archive; the resolved versions are recorded in `published/apt/<suite>.json` (ADR 0008). | Unpacking packages into the tool cache; a local repository per job; an Artifact Registry apt proxy; Ubuntu snapshots | Real apt installs (scripts, dpkg database) with the same registry, mirror and fallback as tools; plain `apt-get install` for users; digest pin instead of GPG; snapshot builds left for later (not verified). | decided |
| D47 | One action `camunda/infra-tools@…` with two selector inputs: `tools` (plain tools, ready to use) and `tool-cache` (tool-cache tools, pre-filled for their `setup-*` action); a tool in the wrong input fails with a message naming the right one (ADR 0006). | Two actions: root and `cache` (D42); one input with a prefix (`cache:java@21`); one input, kind taken from the tool definition | One pin, one step and one index lookup per job; the separate input keeps the cache-only behaviour visible in the workflow (a job listing `java@21` without `setup-java` would otherwise silently run the Java already on `PATH`). | decided |
| D48 | The package stays internal; mirrors on Artifact Registry and ECR in phase 1, filled by pull-through from `ghcr.io` with a classic `read:packages` PAT of the `infra-connect` service account, stored in GCP Secret Manager and AWS Secrets Manager (ADR 0007). | Public package; prefill mirrors at release time; Artifact Registry only | Org policy does not allow public packages today; pull-through needs no release step per mirror; the only long-lived credential stays in the cloud secret stores. | superseded by D61 and D65 |
| D49 | The reconciler uses the Infra - Misc GitHub App (Vault `secret/data/products/infra/ci/team-infrastructure`); record commits are pushed directly to `main`, with the App as bypass actor of a `main` ruleset requiring a PR and one review. | A dedicated App; `infra-releases`; an auto-merged record PR per run | Existing App with the needed permissions, same pattern as `infra-core`'s `master`; one record commit per run without PR noise. | decided (release-please: D56) |
| D50 | Self-hosted runners use `/opt/hostedtoolcache` as tool cache: `emptyDir` mounted in the `runner` and `dind` containers, `RUNNER_TOOL_CACHE` and `AGENT_TOOLSDIRECTORY` set in the runner set pod spec (`infra-core`), trialled on a dev scale set first (ADR 0009). | Keep `_work/_tool`; set the path in the runner image | Same path as GitHub-hosted runners for path-bound tools and future image volumes; the image-only change breaks `container:` jobs. | decided |
| D51 | Phase 1 is proven with the pilot tools java, node and maven; every other tool is added through tool onboarding, where its specific issues are handled (Python's fixed path, gcloud `latest`, `setup-java` with several builds). | All 15 PoC tools in phase 1 | Keeps phase 1 about the platform; pilots cover both kinds of tools and both runner types measured in the PoC. | decided |
| D52 | `enable-apt-source` defaults to `false` until phase 4. | Keep it on by default | apt over OCI is phase 4; the code stays. | superseded by D55 |
| D53 | `setup-*` inputs that bypass the tool cache (e.g. gcloud `version: latest`) are covered by the usage snippet of each tool release, which passes `fromJSON(steps.<id>.outputs.versions).<tool>` to the `setup-*` action, and by the tool definition's documentation. | Also detect re-downloads in CI Analytics | Simple and explicit; detection can come later if needed. | decided |
| D54 | Reconciler and completeness-check failures alert in `#infra-alerts`; releases are not announced (Renovate PRs reach consumers). | A notification channel for releases | Alerts where the team already watches; no extra noise. | decided; wired by D63: failure issues alert when they open or reopen, and `release-merge.yml` failures alert directly (#50) |
| D55 | `main` restarts from scratch, with a reset history keeping only the docs (glossary, ADRs, spec, agent configuration); the PoC code stays on the `poc` branch as reference until phase 1 is done. apt over OCI is not part of phase 1 and is rebuilt in phase 4. | Keep the PoC code on `main` and refactor it | Phase 1 is built ticket by ticket, test-first, at the agreed seams, without carrying PoC shortcuts. | decided |
| D56 | release-please uses the `infra-releases` GitHub App (Vault `secret/data/products/infra/ci/infra-releases`), like other infra repositories; the App also enables GitHub auto-merge on the release PR, and GitHub merges it once the required checks pass (repository setting "Allow auto-merge" on); Infra - Misc keeps record commits and fix PRs. | Infra - Misc for release-please too; Infra - Misc merging the release PR as bypass actor, waiting for Check CI itself | Same release setup as the other infra repositories; without a bypass, the ruleset's required checks gate the release merge. | decided |
| D57 | CI follows `camunda/infra-services-demo` (§5.8), with all zizmor audits enabled, shellcheck added for the bash action, `persist-credentials: false` on checkouts that don't push, and no harden-runner. Release tags stay `X.Y.Z` (D30). | Start from blank workflows; copy the demo as-is (only the pinning audit, no shellcheck) | One set of conventions across infra repositories; a new repository has no findings to triage, so it can start strict. | decided |
| D58 | One tool image per tool version for every Ubuntu release: built once (builder on a single release), and its test stage run on every Ubuntu release our runners use (`UBUNTU_RELEASES` in Bake, e.g. `24.04,26.04`); a release is added when runners offer it and dropped when no runner set uses it. A tool whose upstream ships one build per Ubuntu release (e.g. Python from `actions/python-versions`) opts in to one image per release in its tool definition at its tool onboarding, with the release in the OCI platform (`os.version`) of the tool image and index, and the action picking the entry for the runner's `VERSION_ID`. | Test on the runners' current release only, retesting published versions when runners move; one image per Ubuntu release for every tool | Tool images never change and stay in the index for months, so each one is verified on every release it will run on; runner sets (GitHub-hosted, self-hosted) move between releases at different times; most tools are release-independent upstream binaries, and per-release images would multiply builds, tags, index entries and fix PRs, and add a runner check to the action, for identical content. | decided |
| D59 | Install figures go to CI Analytics through a file: the action appends JSON lines to `$RUNNER_TEMP/ci-analytics/tool-installs.jsonl`, and `submit-build-status` loads them into a NULLABLE `tool_installs` `JSON` column of `build_status_v2`, resending the row without it on `insertErrors` (ADR 0010). Delivered in order: the column and `camunda/infra-tools` in the WIF allowlist (`infra-core`), the loader (`infra-global-github-actions`), then the file; our e2e workflow runs `start-build-monitor` and `submit-build-status` as the test producer. | The action sends to BigQuery itself; a new `tool_install_v1` table; a typed `REPEATED RECORD` column | No credentials or network call in the action; one write per job; fields evolve without schema changes, and a bad file never drops the build status row. | decided |
| D60 | release-please creates `X.Y.Z` as a draft release, without its tag (`draft`, not `force-tag-creation`); the Release workflow publishes the draft last, once the `X.Y.Z-tools` index is pushed, the notes written and `tools.json` attached. | Publish the release, then push its index (until now); `force-tag-creation` | The action cannot be pinned to a release whose index is missing, even when publication fails. While a draft is stuck, the next release PR's changelog may list the wrong commits; it is right again once the draft is published. | decided; one draft at a time, published by steps that check their end state (D64) |
| D61 | The release copies each release index, with its manifests and layers, to the Artifact Registry mirror of the GKE runners, logged in with GitHub OIDC; the mirror is a standard repository, and no PAT is stored. The copy runs in its own job, one matrix entry per mirror, after publication: a failing mirror never blocks a release, and the next run copies what it missed. | Artifact Registry remote repository with the `infra-connect` PAT (D48); a scheduled copy job in the reconciler | A remote repository cannot be scoped to one package (Artifact Registry rejects a path in the upstream URI), so every runner, fork PRs included, could pull any package the PAT reads; copying only the release indexes gives the mirror nothing else to serve and needs no stored credential. | decided; copied before publication by D65 |
| D62 | Publish a version as soon as one platform has it, as revision 1 with those platforms; when a missing platform appears upstream, publish the next revision, building only that platform and reusing the existing platforms' manifests and layers (ADR 0011). The reconciler derives the revision from the registry (highest published plus one, or the manual `revisions` value when higher) and never commits it; a manual value not above the published one fails the PR check. A platform missing after 7 days is a warning in the reconciler's job summary, counted as tracked by R17. `minAge` applies once per version. Replaces D28. | Wait for every platform, fix PR after N days (D28); commit the revision bump to `tool.json` | One missing platform no longer blocks the others, and consumers on existing platforms keep their digest (R7); no bot commit races with human edits. | decided |
| D63 | Every reconciler and release failure is tracked in a failure issue that follows its state (closed when gone, reopened while it lasts), with its procedure from `docs/runbooks/` and the commands an agent may run: one per tool and major for tool failures (label `tool-failure`), one per flow and step for run failures (`run-failure`), one Slack line in `#infra-alerts` when one opens or reopens (ADR 0012). The plan reads no GitHub state; a version is ignored through `ignoredVersions`. Tool failures leave the run green; transient errors are retried call by call inside the scripts. `release-merge.yml` failures alert `#infra-alerts` directly. | Fix PRs (D21); one issue per version; Slack alerts only | Same inputs give the same plan; the issue carries the procedure and closes itself; an ordinary PR proves a fix. | decided; failure issues, their runbooks and alerts implemented (`scripts/failure-issues.mjs`, #50), and `release-merge.yml` alerts; the reconciler (#74) and the release (#75) use them |
| D64 | A release is published by one job, as steps that check their own end state: draft, index, mirrors, notes and `tools.json`, then the draft published; release-please opens the next release PR only once no draft is left (ADR 0013). Every draft update sends its `tag_name` and `target_commitish`, `tools.json` is uploaded by release id, the publishing token has `workflows: write`, and a draft without an `X.Y.Z` tag name, or a second draft, fails the run. A release that fails for good is fixed on `main` and its draft retargeted. The action tests read the latest published release. | Several drafts published oldest first (D60); roll back the manifest; build the release from `main`'s tip | At most one draft and a changelog always computed from an existing tag; release 1.1.0 was stuck three days as a skipped draft. | decided; draft updates, upload by id and `workflows: write` done (#69, #70), action tests on the latest published release done (#73), the release in one job done (#75) |
| D65 | Every mirror, ECR included, is a standard repository the release fills before it is published, digests checked (ADR 0007). | Copy after publication (D61); ECR by pull-through (D48) | A tag `X.Y.Z` means its index is on every registry; a daily release can wait for a mirror. | decided; implemented for Artifact Registry (#75) and ECR (#16) |
| D66 | gcloud is a tool-cache tool for `google-github-actions/setup-gcloud`: the `dl.google.com` archive (bundled Python, `gsutil` and `bq` tested), versions listed from the `google/cloud-sdk` Docker Hub tags, one `"*"` line, no `minAge`. Consumers select a bare `gcloud`, as its major changes every week, and pass the resolved version to `setup-gcloud`, never `latest` (D53). | A plain tool on `PATH`; `gcr.io/google.com/cloudsdktool/google-cloud-cli` tags; listing the `cloud-sdk-release` bucket; `minAge: 3 days` | `setup-gcloud` also logs gcloud in with the credentials of `google-github-actions/auth`, which every caller uses; Docker Hub needs no new source; `minAge` cannot apply: past 10 pages (the repository has over 2000 tags) Docker Hub refuses anonymous requests, and Renovate falls back to registry tags, without release dates. | decided |

## 8. Open questions

| ID | Question | Blocking | Status |
| --- | --- | --- | --- |
| Q1 | The GHCR package inherited the internal visibility of `infra-actions-runner`. | PoC on public consumers | resolved (D26; verify package visibility on first publish) |
| Q2 | Can `camunda/camunda`'s Renovate read release assets of an internal repository? | Selector updates | resolved (D26) |
| Q3 | Datasource for the toolset version. | Toolset version updates | resolved (D27: action pin, `github-releases`) |
| Q4 | `./mvnw` only looks in `~/.m2/wrapper/dists/<name>/<hash>`, not in the tool cache: link Maven there from the action, or drop Maven. | Maven gain | resolved (D32) |
| Q5 | The Python build only runs from `/opt/hostedtoolcache` (its build prefix); self-hosted runners use `/home/runner/_work/_tool`. | Python on self-hosted | resolved (D50 moves the self-hosted tool cache to `/opt/hostedtoolcache`; the rest is handled at Python's tool onboarding, D51) |
| Q6 | gcloud callers use `version: latest`, which bypasses the tool cache; `gcs-build-cache-auth` can pin it, `submit-test-status` is out of scope (D14). | gcloud gain | resolved (handled at gcloud's tool onboarding, D51, D66; usage snippets pin the version, D53) |
| Q7 | Connection resets were seen when pulling GHCR layers from GKE; is a regional mirror needed for self-hosted runners? | Self-hosted reliability | resolved (ADR 0007: a mirror per cloud) |
| Q8 | Retention: how many versions per tool stay in the index; how long tool images and tool releases are kept. | No | open (deferred: storage cost is negligible; retire by hand when needed) |
| Q9 | Move the toolset and the action to a dedicated repository? | No | resolved (D26) |
| Q10 | Version the action and the toolset together or independently? | No | resolved (D27) |
| Q11 | The reconciler commits records to `main`: GitHub App ruleset bypass, or an auto-merged record PR? | Releases | resolved (D49: direct push by the App, ruleset bypass) |
| Q12 | With several builds of one version in the tool cache, does `setup-java` pick the highest? Otherwise pass the action's resolved version. | No | resolved: yes, `setup-java` orders tool cache builds with `semver.compareBuild` (numeric build parts as numbers, as the action does) and matches an exact build only to itself; the CI action tests check both on runners (D51); usage passes the resolved version (D53) |
| Q13 | Repository creation and ownership of `camunda/infra-tools` (org admin, CODEOWNERS, Vault/App credentials). | Migration | resolved (repository created, `infrastructure` admin, CODEOWNERS); App credentials in Q15 |
| Q14 | Switch `camunda/infra-tools` and its package to public before `camunda/camunda` fork PRs rely on it. | Fork PRs | resolved (D48: the package stays internal; fork PR access tested, R18) |
| Q15 | Workflows (`reconcile.yml`, `pr.yml`, `release.yml`, `release-merge.yml`) and the GitHub App credentials for record commits, fix PRs and releases. | First publish | resolved (D49: Infra - Misc App; the workflows are phase 1 work) |
| Q16 | How are mirrors filled: pull-through caching (needs a stored `ghcr.io` credential while the package is internal) or prefilling at release time (the release then depends on reaching every mirror)? Depends on Q14. | Self-hosted mirrors | resolved (D48: pull-through with the `infra-connect` PAT; for Artifact Registry, D61: copied by the release) |

## 9. PoC evidence

### Work items

| Repository | Branch / PR | Content | Status |
| --- | --- | --- | --- |
| `camunda/infra-actions-runner` | `1138-toolset`, [#199](https://github.com/camunda/infra-actions-runner/pull/199) | First version; kept as a draft for reference. | superseded |
| `camunda/infra-tools` | `poc` (from `1138-toolset`, [#1](https://github.com/camunda/infra-tools/pull/1)) | Tools, build scripts, actions, Renovate preset, release-please config. Workflows not included (Q15). | done |
| `camunda/camunda` | [#66432](https://github.com/camunda/camunda/pull/66432) | Call the actions in `setup-build` and `build-frontend`; measure. | done |

Measured jobs: `build-distball` and `async-replication-integration-tests` (merge queue critical path, self-hosted), `build-platform-frontend` or `webapp-client` (GitHub-hosted, Node 26).

### Local verification (`camunda/infra-tools`, `poc`)

- Unit tests (`npm test` in `scripts`): 27 passed (versions and lines, catalog and index merge, fix PR grouping, upstream filters, tool configs and validation).
- `plan.mjs` against real upstream data (D41 lines): 26 versions for the 15 tools, covering every version `ci.yml` uses; versions newer than `minAge` held back.
- `build.mjs`: all 15 tools built and tested for `linux/amd64` and `linux/arm64`, including the new latest versions (Go 1.27.2, Java 27.0.0, kubectl 1.37.1, Maven 3.10.0, Node 26.12.0, uv 0.13.1) and both Java 21.0.12 builds; full rebuild of the 26 planned versions passed. Tests capture command output before matching it (`cmd | grep -q` fails under `pipefail` when the command gets SIGPIPE, seen with kubectl 1.37).
- Actions with tools already in the tool cache, no network: `cache` with `java@21` (`versions` output set, no `PATH` entry); root action with `maven@3` (`PATH` set, `./mvnw` of `camunda/camunda` running the linked Maven 3.9.16); exact build selector resolved; each action rejecting the other kind of tool.
- Renovate configs validated (`renovate-config-validator --strict`); selector regexes and the catalog transform tested.
- Pushing to ghcr.io, `index.mjs`, `record.mjs`, `publish.mjs` and extraction from ghcr.io verified with Java 21, Node 26, Maven 3.9 and gcloud (test index `test-1138-tools`). Not verified: `fix-pr.mjs` against GitHub.

### PoC results (`camunda/camunda` [#66432](https://github.com/camunda/camunda/pull/66432))

- Reliability: full `ci.yml` [run](https://github.com/camunda/camunda/actions/runs/39295176060), 137 jobs, no failure of the action. Java came from Artifact Registry 62×, Maven 62×, gcloud 45×, Node from GitHub Packages 19× (GitHub-hosted); tools were already cached 11×. The 2 fallbacks to GitHub Packages were on an AWS runner, with no mirror there yet.
- Download time: against the 5 latest green `main` runs on the same base commit, setup steps are 1.4 min shorter over 66 self-hosted jobs and about 0.9 min shorter over 60 GitHub-hosted jobs. The average gain is small by design: the target is the slow and failing third-party downloads. Fixed cost of the action (index lookup): about 0.5–1 s.
- Artifact Registry next to the GKE runners is the fastest and most stable source: Java (199 MB) in 2.6–5.7 s (median 2.7 s, 73 MB/s), gcloud (90 MB) in 2.7–2.9 s.

Setup time per tool ([run](https://github.com/camunda/camunda/actions/runs/39410550547): action step plus the usual setup step, median of 3 runs, max in brackets):

| Tool | Runner | Baseline (source) | From GitHub Packages | From Artifact Registry |
| --- | --- | --- | --- | --- |
| node 26 | GitHub-hosted x64 | 6.1 s (GitHub node-versions) | 3.9 s | – |
| node 26 | GitHub-hosted arm64 | 4.5 s | 2.7 s | – |
| node 26 | Self-hosted (GKE) | 8.6 s (9.0) | 4.2 s (12.6) | 2.6 s (3.2) |
| java 21 | GitHub-hosted x64 | 0.9 s (already in the runner image) | 0.9 s | – |
| java 21 | GitHub-hosted arm64 | 4.6 s (Adoptium on GitHub) | 5.5 s | – |
| java 21 | Self-hosted (GKE) | 7.2 s | 20.8 s (21.2) | 4.5 s (5.8) |
| gcloud | GitHub-hosted x64 | 7.5 s (10.1) (dl.google.com, always downloaded) | 6.8 s (7.3) | – |
| gcloud | GitHub-hosted arm64 | 4.5 s (29.7) | 5.3 s (5.7) | – |
| gcloud | Self-hosted (GKE) | 8.3 s | 12.9 s (17.5) | 8.4 s (9.4) |
| maven 3.9 | Self-hosted (GKE) | 1.7 s (Maven Central) | 2.5 s | 1.2 s (1.4) |

### Baseline (`camunda/camunda`, October 2026)

- Merging: the only required check is `check-results` (`ci.yml`), the only workflow running in the merge queue. Merge queue CI wall clock: p50 24.2 min, p90 28.1 min (40 runs).
- Critical path: `build-distball` (p50 4.6 min, p90 5.4 min) → slowest dependent (`async-replication-integration-tests` p90 17.7 min, `physical-tenant-acceptance-tests` 16.2 min, `integration-tests` 15.6 min). Source: `prod_ci_analytics.build_status_v2`, 14 days.
- Tool setup per job (46 job logs of CI run [38428572169](https://github.com/camunda/camunda/actions/runs/38428572169)):

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
| setup-\* actions downloading | GitHub-hosted | 22 s | 36 s | [37939821782](https://github.com/camunda/infra-github-demo/actions/runs/37939821782) |
| Toolset layers from GHCR | GitHub-hosted | 14 s | 23 s | same |
| Toolset layers + GitHub cache | GitHub-hosted | 14 s | 25 s | same |
| Toolset layers from GHCR | self-hosted (GKE) | 19 s | 28 s | [37942159129](https://github.com/camunda/infra-github-demo/actions/runs/37942159129) |
