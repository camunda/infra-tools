# Index in the registry, catalog for Renovate

Each release's index is an OCI artifact (`X.Y.Z-tools`) that references the existing tool image layers. The action therefore needs only a registry, and mirrors serve the index the same way they serve the tools. Renovate cannot perform the registry token exchange, so consumers' Renovate reads the catalog (`published/<tool>.json`) at the release tag through the GitHub contents API instead. The `tools.json` release asset exists only for people and scripts.

## Considered Options

- **`tools.json` release asset as the action's index**: the action would need the GitHub API, and mirrors could not serve it.
- **Release assets for Renovate**: cannot be read while the repository is internal.
