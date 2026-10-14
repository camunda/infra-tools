#!/usr/bin/env bash
set -euo pipefail
url="https://dl.k8s.io/release/v${VERSION}/bin/linux/${TARGETARCH}/kubectl"
mkdir -p "${DEST}/bin"
download "${url}" "${DEST}/bin/kubectl"
echo "$(download "${url}.sha256")  ${DEST}/bin/kubectl" | sha256sum -c -
chmod +x "${DEST}/bin/kubectl"
