#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/bin/yq" --version)"
grep -q "v${VERSION}$" <<<"${out}"
