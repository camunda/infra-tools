#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${DEST}/bin"
download "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/actionlint_${VERSION}_linux_${TARGETARCH}.tar.gz" | tar xz -C "${DEST}/bin" actionlint
