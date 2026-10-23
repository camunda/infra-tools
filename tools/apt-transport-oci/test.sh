#!/usr/bin/env bash
# The method announces its capabilities to apt on start.
set -euo pipefail
out="$(timeout 5 "${TOOL_DIR}/oci" </dev/null || true)"
[[ "${out}" == *"100 Capabilities"* ]]
