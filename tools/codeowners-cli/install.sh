#!/usr/bin/env bash
set -euo pipefail
case "${TARGETARCH}" in amd64) carch=x86_64 ;; arm64) carch=arm64 ;; esac
mkdir -p "${DEST}/bin"
download "https://github.com/multimediallc/codeowners-plus/releases/download/v${VERSION}/codeowners-cli_${VERSION}_Linux_${carch}.tar.gz" | tar xz -C "${DEST}/bin" codeowners-cli
