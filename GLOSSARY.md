# infra-tools

Publishes the tools CI jobs need as OCI artifacts in registries next to the runners, and installs them in jobs with one action step, on GitHub-hosted and self-hosted runners alike.

## Language

### Tools

**Tool**:
A program a CI job needs, published by infra-tools and named by a short identifier (`java`, `node`, `jq`).
_Avoid_: package (reserved for apt), dependency, binary

**Plain tool**:
A tool that is ready to use after the action, with nothing else to run.
_Avoid_: setup tool, binary tool

**Tool-cache tool**:
A tool with an official `setup-*` action: infra-tools only places it in the tool cache, and the `setup-*` action still configures it.
_Avoid_: cached tool, setup tool

**Tool cache**:
The runner folder where `setup-*` actions look for a tool version before downloading it.
_Avoid_: hostedtoolcache, Actions cache

**Tool definition**:
The description of one tool: where its versions come from, which ones are published, how it is installed and how it is tested.
_Avoid_: tool config, recipe

**Tool onboarding**:
The reviewed addition of a tool: its tool definition, plus the checks specific to that tool, such as how its `setup-*` action uses the tool cache.
_Avoid_: tool request, tool migration

**Version line**:
A group of a tool's versions sharing a major or a minor (or every version in no other line) that is published under one rule.
_Avoid_: line image, series, track, range

**Revision**:
The rebuild number of one tool version; a new revision replaces the published tool image of that version.

**Retired version**:
A tool version left out of the next release's index; older releases keep it.

### Publication

**Upstream**:
The third party that publishes a tool's versions (Adoptium, `dl.google.com`, Maven Central, …).
_Avoid_: source registry, origin

**Tool image**:
A single-layer image holding exactly one tool version at one revision, for every platform; it is stored, never run.
_Avoid_: line image, toolset image, bundle image, runner image

**Reconciler**:
The scheduled process that publishes every upstream version within a tool's version lines that is not published yet.
_Avoid_: publisher, Renovate bot

**Fix PR**:
A pull request the reconciler opens for a tool version that fails to build or test; the fix lands in it.
_Avoid_: failure issue

**Catalog**:
The in-repository record of every published tool version, written by the reconciler.
_Avoid_: published list, inventory

**Tool release**:
A GitHub release documenting one published tool image.

**Release**:
A versioned release `X.Y.Z` of the action together with its index.
_Avoid_: toolset release, toolset version

**Index**:
The list, per platform, of every tool version available in a release with its layer digest.
_Avoid_: manifest, toolset

### Distribution

**Registry**:
An OCI registry storing tool images, the index and the apt repository.

**Source registry**:
The registry every tool image is first published to, and the one GitHub-hosted runners read from.
_Avoid_: upstream, origin, primary

**Mirror**:
A registry next to a runner set that serves the same content, with the same digests, as the source registry.
_Avoid_: cache, proxy, replica

**Runner set**:
A group of self-hosted runners sharing one configuration and one cloud location.
_Avoid_: runner group, node pool

**apt repository**:
The curated set of Ubuntu packages, with their required dependencies, published as one OCI artifact next to the tools.
_Avoid_: PPA, apt mirror, apt cache

### Consumption

**Selector**:
A tool name with an optional version prefix (`java@21`), resolved to the highest matching version in the pinned release.
_Avoid_: version constraint, version spec

**Present**:
A tool is present when the tool cache holds a complete version matching its selector, whatever installed it.
_Avoid_: installed, pre-installed, cached
