#!/usr/bin/env bash
set -euo pipefail
[[ "$("${TOOL_DIR}/bin/jq" --version)" == "jq-${VERSION}" ]]
