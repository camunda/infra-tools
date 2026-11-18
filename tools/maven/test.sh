#!/usr/bin/env bash
# The test image has no Java, so the check stays on the distribution's files.
set -euo pipefail
test -x "${TOOL_DIR}/bin/mvn"
test -f "${TOOL_DIR}/lib/maven-core-${VERSION}.jar"
