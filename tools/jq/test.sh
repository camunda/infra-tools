#!/usr/bin/env bash
set -euo pipefail
[[ "$("${TOOL_DIR}/bin/jq" --version)" == "jq-${VERSION}" ]]
[[ "$("${TOOL_DIR}/bin/jq" -n '1 + 1')" == "2" ]]
