# syntax=docker/dockerfile:1
# Runs tools/<tool>/test.sh against the tool image on the target platform and on one Ubuntu release runners use (UBUNTU, set
# by build/docker-bake.hcl), as on a runner; never published.
# Packages runners have that some tools need: a Java runtime for maven, libatomic for node.
ARG UBUNTU
FROM mirror.gcr.io/library/ubuntu:${UBUNTU}
# hadolint ignore=DL3008
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates libatomic1 openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/*
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG TARGETARCH
ARG VERSION
ARG FOLDER_VERSION
ARG CACHE_FOLDER
ARG ARCH_FOLDERS
# hadolint ignore=DL3022
COPY --from=tool /opt/hostedtoolcache/ /opt/hostedtoolcache/
# hadolint ignore=DL3022
COPY --from=build --chmod=755 tool-dir /usr/local/bin/
COPY --chmod=755 . /src/
RUN TOOL_DIR="$(tool-dir)" \
  && test -f "${TOOL_DIR}.complete" \
  && VERSION="${VERSION}" TOOL_DIR="${TOOL_DIR}" /src/test.sh
