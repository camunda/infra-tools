#!/usr/bin/env bash
set -euo pipefail
output="$("${TOOL_DIR}/bin/mvn" --version)"
grep -qF "Apache Maven ${VERSION} " <<<"${output}"
