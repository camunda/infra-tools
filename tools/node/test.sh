#!/usr/bin/env bash
set -euo pipefail
[[ "$("${TOOL_DIR}/bin/node" --version)" == "v${VERSION}" ]]
# npm ships with Node.js; setup-node expects it next to node.
PATH="${TOOL_DIR}/bin:${PATH}" "${TOOL_DIR}/bin/npm" --version
