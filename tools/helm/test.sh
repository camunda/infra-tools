#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/bin/helm" version --short)"
grep -q "^v${VERSION}" <<<"${out}"
