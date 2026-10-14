#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${DEST}/bin"
download "https://github.com/mikefarah/yq/releases/download/v${VERSION}/yq_linux_${TARGETARCH}" "${DEST}/bin/yq"
chmod +x "${DEST}/bin/yq"
