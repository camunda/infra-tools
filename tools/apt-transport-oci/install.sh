#!/usr/bin/env bash
# Static build of the apt method, cross-compiled on the build platform.
set -euo pipefail
GO_VERSION=1.27.3
case "$(uname -m)" in x86_64) build_arch=amd64 ;; aarch64) build_arch=arm64 ;; *) exit 1 ;; esac
download "https://go.dev/dl/go${GO_VERSION}.linux-${build_arch}.tar.gz" | tar xz -C /tmp
download "https://github.com/AkihiroSuda/apt-transport-oci/archive/refs/tags/v${VERSION}.tar.gz" | tar xz -C /tmp
cd "/tmp/apt-transport-oci-${VERSION}"
CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" /tmp/go/bin/go build -trimpath -ldflags='-s -w' -o "${DEST}/oci" ./cmd/usr-lib-apt-methods-oci
