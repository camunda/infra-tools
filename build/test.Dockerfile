# syntax=docker/dockerfile:1
# Runs tools/<tool>/test.sh against the tool image on the target platform and on one Ubuntu release runners use (UBUNTU, set
# by build/docker-bake.hcl), as on a runner; never published.
ARG UBUNTU
FROM mirror.gcr.io/library/ubuntu:${UBUNTU}
# The apt packages the tool's test needs (test.packages of its tool definition, e.g. a Java runtime for maven), as runners have
# them; none skips apt.
ARG TEST_PACKAGES
# hadolint ignore=DL3008,SC2086
RUN if [ -n "${TEST_PACKAGES}" ]; then \
    apt-get update -y \
      && apt-get install -y --no-install-recommends ${TEST_PACKAGES} \
      && rm -rf /var/lib/apt/lists/*; \
  fi
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
