#!/usr/bin/env bash
set -euo pipefail
download "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${VERSION}/apache-maven-${VERSION}-bin.tar.gz" | tar xz -C "${DEST}" --strip-components=1
