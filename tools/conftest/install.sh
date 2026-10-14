#!/usr/bin/env bash
set -euo pipefail
case "${TARGETARCH}" in amd64) carch=x86_64 ;; arm64) carch=arm64 ;; esac
mkdir -p "${DEST}/bin"
download "https://github.com/open-policy-agent/conftest/releases/download/v${VERSION}/conftest_${VERSION}_Linux_${carch}.tar.gz" | tar xz -C "${DEST}/bin" conftest
