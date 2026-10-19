#!/usr/bin/env bash
set -euo pipefail
[[ "$(cat "${TOOL_DIR}/VERSION")" == "${VERSION}" ]]
out="$("${TOOL_DIR}/bin/gcloud" version)"
grep -qx "Google Cloud SDK ${VERSION}" <<<"${out}"
