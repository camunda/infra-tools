# syntax=docker/dockerfile:1
# Build-platform image where every tool is downloaded and installed (download, install-tool); never published.
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/ubuntu:26.04
# hadolint ignore=DL3008
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates curl jq unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY --chmod=755 <<'SCRIPT' /usr/local/bin/download
#!/usr/bin/env bash
# Usage: download <url> [<file>]; writes to stdout without <file>.
set -euo pipefail
curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 ${2:+-o "$2"} "$1"
SCRIPT

COPY --chmod=755 tool-dir /usr/local/bin/

COPY --chmod=755 <<'SCRIPT' /usr/local/bin/install-tool
#!/usr/bin/env bash
# Runs <tool dir>/install.sh with VERSION, TARGETARCH, ARCH (tool cache arch folder) and DEST set, then marks DEST complete.
set -euo pipefail
DEST="$(tool-dir)"
ARCH="$(basename "${DEST}")"
mkdir -p "${DEST}"
export VERSION TARGETARCH ARCH DEST
"$1/install.sh"
touch "${DEST}.complete"
SCRIPT
