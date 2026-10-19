#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/bin/kubectl" version --client)"
grep -q "v${VERSION}$" <<<"${out}"
