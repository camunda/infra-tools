# syntax=docker/dockerfile:1
# Curated apt repository for one Ubuntu release, in the apt-transport-oci layout. Built by scripts/apt.mjs.
ARG IMAGE=mirror.gcr.io/library/ubuntu:24.04

# Per platform: the requested packages plus every dependency the plain image lacks (no Recommends).
FROM ${IMAGE} AS download
ARG PACKAGES
# hadolint ignore=DL3008,DL3009
RUN apt-get update -y \
  && apt-get install --download-only -y --no-install-recommends ${PACKAGES} \
  && mkdir -p /out && cp /var/cache/apt/archives/*.deb /out/

FROM scratch AS debs
COPY --from=download /out/ /

# Build platform: one repository for every platform; Release is generated from inside dists/<suite> (relative paths).
FROM --platform=$BUILDPLATFORM ${IMAGE} AS build-repo
ARG SUITE
ARG ARCHES
# hadolint ignore=DL3008
RUN apt-get update -y && apt-get install -y --no-install-recommends apt-utils && rm -rf /var/lib/apt/lists/*
# hadolint ignore=DL3022
COPY --from=platform-debs / /tmp/debs/
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3003
RUN mkdir -p /repo/pool/main && for d in /tmp/debs/*/; do cp -f "${d}"*.deb /repo/pool/main/; done && cd /repo \
  && for a in ${ARCHES}; do \
       d="dists/${SUITE}/main/binary-${a}"; mkdir -p "${d}"; \
       apt-ftparchive --arch "${a}" packages pool > "${d}/Packages" && gzip -9nk "${d}/Packages"; \
     done \
  && cd "dists/${SUITE}" \
  && apt-ftparchive -o APT::FTPArchive::Release::Origin=infra-tools -o APT::FTPArchive::Release::Label=infra-tools \
       -o APT::FTPArchive::Release::Suite="${SUITE}" -o APT::FTPArchive::Release::Codename="${SUITE}" \
       -o APT::FTPArchive::Release::Architectures="${ARCHES}" -o APT::FTPArchive::Release::Components=main \
       release . > /tmp/Release && mv /tmp/Release Release

FROM scratch AS repo
COPY --from=build-repo /repo/ /

# Per platform: install offline from this repository only, then run the smoke tests.
FROM ${IMAGE} AS test
ARG SUITE
ARG PACKAGES
ARG TESTS
COPY --from=repo / /repo/
# hadolint ignore=DL3008,DL3009
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
  && echo "deb [trusted=yes] file:/repo ${SUITE} main" > /etc/apt/sources.list.d/repo.list \
  && apt-get update -y && apt-get install -y --no-install-recommends ${PACKAGES} \
  && bash -c "${TESTS}"
