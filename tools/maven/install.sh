#!/usr/bin/env bash
# Maven is the same for every platform: the binary distribution, unpacked into DEST.
set -euo pipefail
download "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${VERSION}/apache-maven-${VERSION}-bin.tar.gz" \
  | tar xz -C "${DEST}" --strip-components=1
