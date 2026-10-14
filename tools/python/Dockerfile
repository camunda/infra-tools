# syntax=docker/dockerfile:1
# GitHub's Python builds only run from their build prefix, so setup.sh runs on the target platform under /opt/hostedtoolcache.
# hadolint ignore=DL3006
FROM --platform=$BUILDPLATFORM builder AS download
ARG TARGETARCH
ARG VERSION
ARG ARCH_FOLDERS
COPY --chmod=755 . /src/
# The builder image sets SHELL to bash with pipefail.
# hadolint ignore=DL4006,SC3011
RUN ARCH="$(tr ' ' '\n' <<<"${ARCH_FOLDERS}" | sed -n "s/^${TARGETARCH}=//p")" \
  && VERSION="${VERSION}" ARCH="${ARCH}" /src/download.sh

FROM mirror.gcr.io/library/ubuntu:24.04 AS install
COPY --from=download /python /python
COPY --chmod=755 . /src/
RUN /src/install.sh

FROM scratch
COPY --from=install /opt/hostedtoolcache/ /opt/hostedtoolcache/
