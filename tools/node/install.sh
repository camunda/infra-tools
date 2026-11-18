#!/usr/bin/env bash
# Node.js binary distribution, unpacked into DEST. ARCH is the tool cache arch folder, which is also Node.js's (x64, arm64).
set -euo pipefail
download "https://nodejs.org/dist/v${VERSION}/node-v${VERSION}-linux-${ARCH}.tar.xz" | tar xJ -C "${DEST}" --strip-components=1
