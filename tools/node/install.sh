#!/usr/bin/env bash
set -euo pipefail
download "https://nodejs.org/dist/v${VERSION}/node-v${VERSION}-linux-${ARCH}.tar.xz" | tar xJ -C "${DEST}" --strip-components=1
