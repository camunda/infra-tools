# syntax=docker/dockerfile:1
# Tool image (ADR 0002, ADR 0003): one layer holding opt/hostedtoolcache/<folder>/<version>/<arch>. Context: tools/<tool>.
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
