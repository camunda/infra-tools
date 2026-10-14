#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${DEST}/bin"
download "https://github.com/jqlang/jq/releases/download/jq-${VERSION}/jq-linux-${TARGETARCH}" "${DEST}/bin/jq"
chmod +x "${DEST}/bin/jq"
