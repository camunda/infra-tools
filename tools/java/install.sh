#!/usr/bin/env bash
set -euo pipefail
# VERSION is the Adoptium semver (21.0.12+101.0.LTS); downloads need the release name (jdk-21.0.12.1+1).
major="${VERSION%%.*}"
openjdk="$(download "https://api.adoptium.net/v3/info/release_versions?page_size=50&project=jdk&release_type=ga&image_type=jdk&os=linux&architecture=${ARCH}&version=%5B${major}%2C$((major + 1))%29" \
  | jq -er --arg v "${VERSION}" '.versions[] | select(.semver == $v) | .openjdk_version')"
release="jdk-${openjdk%-[A-Za-z]*}"
download "https://api.adoptium.net/v3/binary/version/${release/+/%2B}/linux/${ARCH}/jdk/hotspot/normal/eclipse" | tar xz -C "${DEST}" --strip-components=1
