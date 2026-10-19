# syntax=docker/dockerfile:1
# Runs tools/<tool>/test.sh against a line image on the target platform. Never published.
# Packages present on GitHub-hosted and self-hosted runners, needed by some tools (gcloud: python3, node: libatomic1).
FROM mirror.gcr.io/library/ubuntu:24.04
# hadolint ignore=DL3008
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates libatomic1 libsqlite3-0 python3 \
  && rm -rf /var/lib/apt/lists/*
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG TARGETARCH
ARG VERSION
ARG FOLDER_VERSION
ARG CACHE_FOLDER
ARG ARCH_FOLDERS
# hadolint ignore=DL3022
COPY --from=line /opt/hostedtoolcache/ /opt/hostedtoolcache/
COPY --chmod=755 . /src/
# hadolint ignore=SC3011
RUN ARCH="$(tr ' ' '\n' <<<"${ARCH_FOLDERS}" | sed -n "s/^${TARGETARCH}=//p")" \
  && TOOL_DIR="/opt/hostedtoolcache/${CACHE_FOLDER}/${FOLDER_VERSION}/${ARCH}" \
  && test -f "${TOOL_DIR}.complete" \
  && VERSION="${VERSION}" TOOL_DIR="${TOOL_DIR}" /src/test.sh
