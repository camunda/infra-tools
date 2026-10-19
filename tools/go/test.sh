#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/bin/go" version)"
grep -q "go${VERSION} " <<<"${out}"
