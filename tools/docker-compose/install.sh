#!/usr/bin/env bash
set -euo pipefail
case "${TARGETARCH}" in amd64) carch=x86_64 ;; arm64) carch=aarch64 ;; esac
mkdir -p "${DEST}/bin"
download "https://github.com/docker/compose/releases/download/v${VERSION}/docker-compose-linux-${carch}" "${DEST}/bin/docker-compose"
chmod +x "${DEST}/bin/docker-compose"
