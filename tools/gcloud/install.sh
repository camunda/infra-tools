#!/usr/bin/env bash
# Google Cloud CLI archive, with its bundled Python, gsutil and bq, unpacked into DEST. Versions are listed from the
# google/cloud-sdk image tags; the archive comes from dl.google.com, named by Google's architecture (x86_64, arm).
# setup-gcloud given `latest` looks up the newest version online and downloads it whenever the tool cache is older, which is
# most weeks: consumers select a bare `gcloud` (its major changes every week) and pass
# `fromJSON(steps.<id>.outputs.versions).gcloud` as `version`, never `latest` (D53).
set -euo pipefail
case "${TARGETARCH}" in amd64) garch=x86_64 ;; arm64) garch=arm ;; esac
download "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${VERSION}-linux-${garch}.tar.gz" \
  | tar xz -C "${DEST}" --strip-components=1
