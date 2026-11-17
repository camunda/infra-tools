# apt packages over OCI with apt-transport-oci

A curated list of packages per Ubuntu release is built into one apt repository, together with the required dependencies that a plain image lacks (Recommends are left out). The repository is pushed as an OCI artifact in the apt-transport-oci layout, referenced from the index, and mirrored like the tools. Runners add it as a pinned apt source, with the Ubuntu mirrors as fallback, so jobs keep using plain `apt-get install` and get real installs (maintainer scripts, dpkg database). The repository is pinned by digest instead of GPG. Ubuntu 26.04 ships apt-transport-oci; on 24.04 we publish the plugin with the tools.

## Considered Options

- **Unpacking packages into the tool cache**: skips maintainer scripts and the dpkg database.
- **A local repository per job**: every job downloads and indexes the packages again.
- **An Artifact Registry apt proxy**: GCP only, and does not cover GitHub-hosted runners.
- **Ubuntu snapshots**: not verified yet; left for later.
