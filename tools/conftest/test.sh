#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/bin/conftest" --version)"
grep -q "${VERSION}" <<<"${out}"
