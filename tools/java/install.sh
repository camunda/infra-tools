#!/usr/bin/env bash
# Eclipse Temurin JDK from Adoptium. VERSION is Adoptium's semver (21.0.12+101.0.LTS), the version setup-java reads; the binary
# is named by the OpenJDK release (jdk-21.0.12.1+1), looked up in the same API. ARCH is Adoptium's architecture (x64, aarch64).
set -euo pipefail
major="${VERSION%%.*}"
openjdk="$(download "https://api.adoptium.net/v3/info/release_versions?page_size=50&project=jdk&release_type=ga&image_type=jdk&os=linux&architecture=${ARCH}&version=%5B${major}%2C$((major + 1))%29" \
  | jq -er --arg v "${VERSION}" '[.versions[] | select(.semver == $v) | .openjdk_version][0]')"
release="jdk-${openjdk%-[A-Za-z]*}"
download "https://api.adoptium.net/v3/binary/version/${release/+/%2B}/linux/${ARCH}/jdk/hotspot/normal/eclipse" \
  | tar xz -C "${DEST}" --strip-components=1
