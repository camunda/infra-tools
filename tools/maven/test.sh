#!/usr/bin/env bash
set -euo pipefail
test -x "${TOOL_DIR}/bin/mvn"
test -f "${TOOL_DIR}/lib/maven-core-${VERSION}.jar"
