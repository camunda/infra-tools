#!/usr/bin/env bash
set -euo pipefail
out="$("${TOOL_DIR}/bin/docker-compose" version)"
grep -q "v${VERSION}$" <<<"${out}"
