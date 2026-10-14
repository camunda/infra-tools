#!/usr/bin/env bash
set -euo pipefail
[[ "$("${TOOL_DIR}/bin/node" --version)" == "v${VERSION}" ]]
"${TOOL_DIR}/bin/node" "${TOOL_DIR}/lib/node_modules/npm/bin/npm-cli.js" --version
