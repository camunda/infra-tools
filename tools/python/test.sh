#!/usr/bin/env bash
set -euo pipefail
[[ "$("${TOOL_DIR}/bin/python" --version)" == "Python ${VERSION}" ]]
"${TOOL_DIR}/bin/python" -c 'import ctypes, json, sqlite3, ssl, zlib'
"${TOOL_DIR}/bin/python" -m pip --version
