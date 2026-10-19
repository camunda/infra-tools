#!/usr/bin/env bash
set -euo pipefail
download "https://github.com/astral-sh/uv/releases/download/${VERSION}/uv-${ARCH}-unknown-linux-gnu.tar.gz" | tar xz -C "${DEST}" --strip-components=1
