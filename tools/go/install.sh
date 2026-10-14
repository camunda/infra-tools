#!/usr/bin/env bash
set -euo pipefail
download "https://go.dev/dl/go${VERSION}.linux-${TARGETARCH}.tar.gz" | tar xz -C "${DEST}" --strip-components=1
