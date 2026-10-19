#!/usr/bin/env bash
set -euo pipefail
case "${TARGETARCH}" in amd64) garch=x86_64 ;; arm64) garch=arm ;; esac
download "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${VERSION}-linux-${garch}.tar.gz" | tar xz -C "${DEST}" --strip-components=1
