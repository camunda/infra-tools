#!/usr/bin/env bash
set -euo pipefail
url="$(download https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json \
  | jq -er --arg v "${VERSION}" --arg a "${ARCH}" '.[] | select(.version == $v) | .files[] | select(.platform == "linux" and .platform_version == "24.04" and .arch == $a) | .download_url')"
mkdir -p /python
download "${url}" | tar xz -C /python
