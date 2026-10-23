# Changelog

## 0.3.0 (2026-10-23)

### Features

* configure an apt source for curated packages over OCI ([80ead5f](https://github.com/camunda/infra-tools/commit/80ead5f5718536c4169f86ac1085530dd525cdfa))
* apt-transport-oci 0.1.2; apt repository for Ubuntu 24.04 (noble) with clamav 1.5.4

## 0.2.0 (2026-10-20)

### Features

* report each tool's version, source, size, time and path ([9076267](https://github.com/camunda/infra-tools/commit/907626792021a2c1b5929c2062d55f77ca0ae875))

### Bugfixes

* use the metadata server token directly on Artifact Registry ([9fd0b3f](https://github.com/camunda/infra-tools/commit/9fd0b3f77a9b96f77610899b90869ab29abb06b6))

## 0.1.0 (2026-10-19)

### Features

* `camunda/infra-tools` (plain tools, ready to use) and `camunda/infra-tools/cache` (tools with a `setup-*` action) actions
* 20 tool versions for `linux/amd64` and `linux/arm64`: actionlint, codeowners-cli, conftest, docker-compose, gcloud, go, helm,
  java, jq, kubectl, maven, node, python, uv and yq (see the release's `changes.md` and `tools.json`)
