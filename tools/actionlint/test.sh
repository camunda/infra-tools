#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/bin/actionlint" -version)"
grep -qx "${VERSION}" <<<"${out}"
