#!/usr/bin/env bash
set -euo pipefail
# A major's first release reports "27", later ones "27.0.1".
want="${VERSION%%+*}"
want="${want%.0.0}"
out="$("${TOOL_DIR}/bin/java" -version 2>&1)"
grep -qE "version \"${want//./\\.}(\"|\\.)" <<<"${out}"
