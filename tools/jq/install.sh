#!/usr/bin/env bash
# jq's static binary from its GitHub release, named by TARGETARCH (amd64, arm64), into DEST/bin, checked against the release's
# sha256sum.txt.
set -euo pipefail
binary="jq-linux-${TARGETARCH}"
release="https://github.com/jqlang/jq/releases/download/jq-${VERSION}"
mkdir -p "${DEST}/bin"
download "${release}/${binary}" "${DEST}/bin/jq"
sha256="$(download "${release}/sha256sum.txt" | awk -v f="${binary}" '$2 == f { print $1 }')"
[[ -n "${sha256}" ]]
sha256sum -c --strict - <<<"${sha256}  ${DEST}/bin/jq"
chmod +x "${DEST}/bin/jq"
