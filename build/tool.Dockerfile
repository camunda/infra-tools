# syntax=docker/dockerfile:1
# Default tool build. Context: tools/<tool>. A tool can provide its own Dockerfile instead.
# hadolint ignore=DL3006
FROM --platform=$BUILDPLATFORM builder AS install
ARG TARGETARCH
ARG VERSION
ARG FOLDER_VERSION
ARG CACHE_FOLDER
ARG ARCH_FOLDERS
COPY --chmod=755 . /src/
RUN install-tool /src

FROM scratch
COPY --from=install /opt/hostedtoolcache/ /opt/hostedtoolcache/
