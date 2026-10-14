#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${DEST}/bin"
download "https://get.helm.sh/helm-v${VERSION}-linux-${TARGETARCH}.tar.gz" | tar xz -C "${DEST}/bin" --strip-components=1 "linux-${TARGETARCH}/helm"
