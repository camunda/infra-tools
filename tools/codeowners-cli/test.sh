#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/bin/codeowners-cli" --version)"
grep -q "${VERSION}" <<<"${out}"
