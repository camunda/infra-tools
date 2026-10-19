#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/uv" --version)"
grep -q "^uv ${VERSION}" <<<"${out}"
"${TOOL_DIR}/uvx" --version
