#!/usr/bin/env bash
set -euo pipefail
# The test image has no Python: these run on the bundled one.
grep -qx "Google Cloud SDK ${VERSION}" <<<"$("${TOOL_DIR}/bin/gcloud" version)"
# gsutil and bq ship with the archive; consumers use both.
"${TOOL_DIR}/bin/gsutil" version
"${TOOL_DIR}/bin/bq" version
