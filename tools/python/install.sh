#!/usr/bin/env bash
set -euo pipefail
# Runs on the target platform from /python (see download.sh): GitHub's setup.sh installs under RUNNER_TOOL_CACHE and marks it complete.
cd /python
RUNNER_TOOL_CACHE=/opt/hostedtoolcache bash ./setup.sh
