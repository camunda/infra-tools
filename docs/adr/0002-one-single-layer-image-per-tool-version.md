# One single-layer OCI image per tool version

Each tool version is published as a tool image with a single layer: a compressed archive of the tool's folder, laid out as the tool cache expects it. The image is never run, so installing a tool takes one download and one extraction, verified by the layer digest. Registries already provide what we need around that archive: multi-platform tags, authentication, digests, mirroring and pull-through caching. Published tool images never change; a fix is a new revision.

## Considered Options

- **GitHub Actions cache**: no API to push entries, entries are evicted once the quota is reached, and the PoC measured no gain (14 s with and without).
- **GitHub release assets or a bucket**: works, but needs custom download, checksum and mirroring logic that registries give us for free.
- **One bundle image with a layer per tool**: one push per release, but every release rebuilds or re-pushes the bundle, and tool versions no longer have their own lifecycle. With one image per version, publication is incremental and nothing is rebuilt.
