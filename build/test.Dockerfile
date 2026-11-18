# syntax=docker/dockerfile:1
# Runs tools/<tool>/test.sh against the tool image on the target platform, as on a runner; never published.
# Packages runners have that some tools need: a Java runtime for maven.
FROM mirror.gcr.io/library/ubuntu:24.04
# hadolint ignore=DL3008
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/*
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG TARGETARCH
ARG VERSION
ARG FOLDER_VERSION
ARG CACHE_FOLDER
ARG ARCH_FOLDERS
# hadolint ignore=DL3022
COPY --from=tool /opt/hostedtoolcache/ /opt/hostedtoolcache/
COPY --chmod=755 . /src/
RUN ARCH="$(tr ' ' '\n' <<<"${ARCH_FOLDERS}" | sed -n "s/^${TARGETARCH}=//p")" \
  && TOOL_DIR="/opt/hostedtoolcache/${CACHE_FOLDER}/${FOLDER_VERSION}/${ARCH}" \
  && test -f "${TOOL_DIR}.complete" \
  && VERSION="${VERSION}" TOOL_DIR="${TOOL_DIR}" /src/test.sh
