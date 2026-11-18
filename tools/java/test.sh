#!/usr/bin/env bash
set -euo pipefail
# The runtime reports the OpenJDK version without Adoptium's build metadata, and a major's first release as "25", not "25.0.0".
want="${VERSION%%+*}"
want="${want%.0.0}"
output="$("${TOOL_DIR}/bin/java" -version 2>&1)"
grep -qE "version \"${want//./\\.}(\"|\\.)" <<<"${output}"
# A JDK, not only a runtime: builds need the compiler.
"${TOOL_DIR}/bin/javac" -version
