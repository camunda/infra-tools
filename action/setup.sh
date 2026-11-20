#!/usr/bin/env bash
# The action (action.yml): installs the selected tools from the index into the tool cache, and puts plain tools on PATH.
# Inputs come from the environment: TOOLS (plain tool selectors), TOOL_CACHE_TOOLS (tool-cache tool selectors), MODE
# (`extract` or `validate`), TOKEN (registry token), INDEX (<registry>/<repository>:<tag>; empty: the release's index) and
# SUMMARY (`true`: table of the selected tools in the job summary).
# Requires bash 5, curl, jq, tar and sha256sum on Linux; yq for MODE=validate.
set -euo pipefail

# Other runners run the action with the bash they have (3.2 on macOS): nothing before this check may need bash 5.
if [[ "${RUNNER_OS:-}" != Linux ]]; then
  echo "::notice::infra-tools: ${RUNNER_OS:-this OS} runners are not supported, nothing installed"
  echo "versions={}" >>"${GITHUB_OUTPUT}"
  exit 0
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
annotation=io.camunda.infra-tools
media_index=application/vnd.oci.image.index.v1+json
media_manifest=application/vnd.oci.image.manifest.v1+json
now_ms() { echo $((${EPOCHREALTIME//[.,]/} / 1000)); }
seconds() { printf '%d.%d' $(($1 / 1000)) $(($1 % 1000 / 100)); }
begin="$(now_ms)"
mb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1048576 }'; }
fail() {
  echo "::error::infra-tools: $1"
  exit 1
}

# Linux platforms of the index; mode: validate checks selectors on each.
platforms=(amd64 arm64)
case "${RUNNER_ARCH:-}" in
X64) arch=amd64 ;;
ARM64) arch=arm64 ;;
*) fail "unsupported runner architecture ${RUNNER_ARCH:-}" ;;
esac
tool_cache="${RUNNER_TOOL_CACHE:?}"
tmp="${RUNNER_TEMP:?}"

# Without the index input, the index of the release at the pinned commit: the version of its release-please manifest, whose
# initial 0.0.0 is no release.
if [[ -z "${INDEX:-}" ]]; then
  release="$(jq -r '."." // empty' "${root}/.github/config/.release-please-manifest.json" 2>/dev/null || true)"
  if [[ -n "${release}" && "${release}" != 0.0.0 ]]; then
    INDEX="ghcr.io/camunda/infra-tools:${release}-tools"
  fi
fi

# Highest version among the arguments that matches a selector's version prefix: equal, or followed by `.`, `+` or `-`
# (`+` is written `-` in tool cache folders). Ordered by every number, build metadata included (D23).
highest() {
  local want="${1//+/-}"
  shift
  jq -rn --arg want "${want}" '[$ARGS.positional[] | select($want == "" or . == $want or (gsub("\\+"; "-")
    | . == $want or startswith($want + ".") or startswith($want + "-")))]
    | sort_by([scan("[0-9]+") | tonumber]) | last // empty' --args "$@"
}

# Tool cache layout of a tool (folder, arch folder, addToPath), from tools/<tool>/tool.json at the pinned commit: no
# network needed to find present tools.
layout() {
  jq -r --arg tool "$1" --arg arch "${arch}" '.install // {}
    | [.cacheFolder // $tool, (.archFolders // {amd64: "x64", arm64: "arm64"})[$arch], .addToPath // ""] | @tsv' \
    "${root}/tools/$1/tool.json"
}

# Why a tool's selector cannot be listed under an input (tools or tool-cache), or nothing when it can: an unknown tool, or
# the wrong input. The tool definition decides the input (ADR 0006): with addToPath, a plain tool; without, a tool-cache
# tool.
selector_error() {
  local input="$1" tool="$2" add_path
  if [[ ! -f "${root}/tools/${tool}/tool.json" ]]; then
    echo "unknown tool '${tool}'; tools: $(cd "${root}/tools" && echo *)"
    return 0
  fi
  IFS=$'\t' read -r _ _ add_path < <(layout "${tool}")
  if [[ -n "${add_path}" && "${input}" != tools ]]; then
    echo "${tool} is a plain tool: list it under tools, not ${input}"
  elif [[ -z "${add_path}" && "${input}" != tool-cache ]]; then
    echo "${tool} is a tool-cache tool: list it under tool-cache, not ${input}, and keep its setup-* step"
  fi
}

# INFRA_TOOLS_MIRROR, from the runner environment, replaces ghcr.io in the index (ADR 0007).
mirror_index=""
if [[ -n "${INFRA_TOOLS_MIRROR:-}" && "${INDEX:-}" == ghcr.io/* ]]; then
  mirror_index="${INFRA_TOOLS_MIRROR%/}/${INDEX#ghcr.io/}"
fi

# Set by use_index(); why holds its last failure.
registry="" api="" auth=() layers="" why=""

# Reads a platform's index layers (this runner's by default) from the mirror, else or on failure from the source registry.
connect() {
  [[ -n "${INDEX:-}" ]] || fail "no release yet: set the index input"
  local platform="${1:-${arch}}"
  if [[ -n "${mirror_index}" ]]; then
    use_index "${mirror_index}" "${platform}" && return
    fall_back
  fi
  use_index "${INDEX}" "${platform}" || fail "${why}"
}

# Stops using the mirror for the rest of the step.
fall_back() {
  echo "::warning::infra-tools: mirror ${mirror_index} failed (${why}), using ${INDEX}"
  mirror_index=""
}

# Records why an index cannot be used; returns 1.
index_failed() {
  why="$1"
  echo "::endgroup::"
  return 1
}

# Logs in and reads a platform's index layers; on failure sets why and returns 1.
use_index() {
  local index="$1" platform="$2" repository="${1#*/}" challenge realm service bearer status digest started
  local name="${repository%:*}" tag="${repository##*:}"
  registry="${index%%/*}"
  # INFRA_TOOLS_REGISTRY_SCHEME is for tests only (scripts/test/action.test.mjs serves a fake registry over http).
  api="${INFRA_TOOLS_REGISTRY_SCHEME:-https}://${registry}/v2/${name}"
  auth=()
  echo "::group::infra-tools: index ${index}"
  started="$(now_ms)"
  if [[ "${registry}" == *.pkg.dev ]]; then
    # Artifact Registry takes the pod's Workload Identity token directly, skipping its slow token endpoint.
    bearer="$(curl -fsS -m 5 --retry 2 -H "Metadata-Flavor: Google" \
      http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | jq -er .access_token)" \
      || { index_failed "no Workload Identity token for ${registry}"; return; }
    auth=(-H "Authorization: Bearer ${bearer}")
  else
    challenge="$(curl -sS --retry 3 --connect-timeout 10 -m 30 -o /dev/null -D - -H "Accept: ${media_index}" "${api}/manifests/${tag}" \
      | tr -d '\r' | sed -nE 's/^[Ww][Ww][Ww]-[Aa]uthenticate: *//p')" || { index_failed "cannot reach ${registry}"; return; }
    if [[ "${challenge}" == Bearer* ]]; then
      realm="$(sed -nE 's/.*realm="([^"]+)".*/\1/p' <<<"${challenge}")"
      service="$(sed -nE 's/.*service="([^"]+)".*/\1/p' <<<"${challenge}")"
      bearer="$(curl -fsSL --retry 3 --connect-timeout 10 -m 30 ${TOKEN:+-u "token:${TOKEN}"} "${realm}?service=${service}&scope=repository:${name}:pull" \
        | jq -r '.token // .access_token // empty')" || { index_failed "login to ${registry} failed"; return; }
      auth=(-H "Authorization: Bearer ${bearer}")
    fi
  fi
  echo "login ${registry}: $(($(now_ms) - started)) ms"
  started="$(now_ms)"
  # A missing index (not copied yet) is no transient error: no retries.
  status="$(curl -sS -o /dev/null -w '%{http_code}' -I --retry 3 --connect-timeout 10 -m 30 "${auth[@]}" \
    -H "Accept: ${media_index}" "${api}/manifests/${tag}")" || { index_failed "cannot reach ${registry}"; return; }
  [[ "${status}" != 404 ]] || { index_failed "no index ${index}"; return; }
  digest="$(get -H "Accept: ${media_index}" "${api}/manifests/${tag}" \
    | jq -r --arg arch "${platform}" '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest')" \
    || { index_failed "cannot read the index ${index}"; return; }
  [[ -n "${digest}" ]] || { index_failed "the index ${index} has no linux/${platform} manifest"; return; }
  layers="$(get -H "Accept: ${media_manifest}" "${api}/manifests/${digest}" | jq -c .layers)" \
    || { index_failed "cannot read the index ${index}"; return; }
  echo "index: $(($(now_ms) - started)) ms"
  echo "::endgroup::"
}

# Versions of a tool in the index layers read by connect().
published() {
  jq -r --arg tool "$1" --arg a "${annotation}" \
    '.[] | select(.annotations[$a + ".tool"] == $tool) | .annotations[$a + ".version"]' <<<"${layers}"
}

# Aborts stalled reads (below 1 KB/s for 30 s), with no total limit for large layers.
get() { curl -fsSL --retry 3 --retry-all-errors --retry-delay 1 --connect-timeout 10 --speed-limit 1024 --speed-time 30 "${auth[@]}" "$@"; }

# Downloads and verifies a layer, with retries; on failure sets why and returns 1.
download_layer() {
  local tool="$1" digest="$2" file="$3" attempt
  echo "::debug::infra-tools: ${tool} layer ${digest} from ${registry}"
  for attempt in 1 2 3; do
    # This loop retries, digest mismatches included.
    if get --retry 0 -o "${file}" "${api}/blobs/${digest}" && [[ "sha256:$(sha256sum "${file}" | cut -d' ' -f1)" == "${digest}" ]]; then
      return 0
    fi
    echo "::warning::infra-tools: ${tool} download failed or does not match its digest (attempt ${attempt})"
    ((attempt < 3)) || break
    sleep "${attempt}"
  done
  why="${tool}: could not download layer ${digest}"
  return 1
}

# Downloads a layer, verifies it against its digest and extracts it into the tool cache, then marks the tool version
# complete. The layer holds opt/hostedtoolcache/<folder>/<version>/<arch> (ADR 0003): two path components are stripped.
install_layer() {
  local tool="$1" digest="$2" target="$3" file="${tmp}/infra-tools-$1.tar.gz"
  if ! download_layer "${tool}" "${digest}" "${file}"; then
    [[ -n "${mirror_index}" ]] || fail "${why}"
    fall_back
    use_index "${INDEX}" "${arch}" || fail "${why}"
    download_layer "${tool}" "${digest}" "${file}" || fail "${why}"
  fi
  rm -rf "${target}" "${target}.complete"
  mkdir -p "${tool_cache}"
  tar xzf "${file}" -C "${tool_cache}" --strip-components=2 --exclude='*.complete'
  rm -f "${file}"
  [[ -d "${target}" ]] || fail "${tool}: layer ${digest} does not hold ${target#"${tool_cache}"/}"
  touch "${target}.complete"
}

# Hash ./mvnw (only-script) names its distribution folder with: Java's String.hashCode of the distribution URL, in hex.
wrapper_hash() {
  local text="$1" h=0
  while [[ -n "${text}" ]]; do
    h=$(((h * 31 + $(LC_CTYPE=C printf %d "'${text:0:1}")) % 4294967296))
    text="${text:1}"
  done
  printf %x "${h}"
}

# Links Maven into the folder ./mvnw runs it from, $MAVEN_USER_HOME/wrapper/dists/apache-maven-<version>/<hash>, when the
# repository's .mvn/wrapper asks for the same version (D32); ./mvnw then does not download it. Only the script-only ./mvnw of
# Maven Wrapper 3.3+ uses that folder, and MVNW_REPOURL is not honoured (./mvnw hashes the rewritten URL): ./mvnw then
# downloads Maven.
link_wrapper() {
  local home="$1" maven="$2" properties="${GITHUB_WORKSPACE:-}/.mvn/wrapper/maven-wrapper.properties" url name dists
  [[ -n "${GITHUB_WORKSPACE:-}" && -f "${properties}" ]] || return 0
  url="$(sed -n 's/^distributionUrl=//p' "${properties}" | tr -d '[:space:]')"
  name="${url##*/}"
  name="${name%.*}"
  name="${name%-bin}"
  [[ "${name}" == apache-maven-* ]] || return 0
  if [[ "${name}" != "apache-maven-${maven}" ]]; then
    echo "::notice::infra-tools: .mvn/wrapper asks for maven ${name#apache-maven-}, not the installed ${maven}: ./mvnw downloads it"
    return 0
  fi
  dists="${MAVEN_USER_HOME:-${HOME}/.m2}/wrapper/dists/${name}"
  mkdir -p "${dists}"
  [[ -e "${dists}/$(wrapper_hash "${url}")" ]] || ln -s "${home}" "${dists}/$(wrapper_hash "${url}")"
  echo "maven: ./mvnw linked to ${home}"
}

# mode: validate checks the selectors of the tools and tool-cache inputs of every infra-tools step in the repository's
# workflows and local actions against the index on every platform, so an invalid one fails before merge; it installs
# nothing and exits. Each invalid selector gets an error annotation on its file and fails the step.
validate() {
  echo "versions={}" >>"${GITHUB_OUTPUT}"
  command -v yq >/dev/null || fail "mode: validate needs yq"
  cd "${GITHUB_WORKSPACE:?}"
  local declared=() # "<file>\t<input>\t<selector>"
  local file inputs declaration input selector tool want error found absent platform resolved candidates failed=0
  for file in .github/workflows/*.y*ml .github/actions/*/action.y*ml; do
    [[ -f "${file}" ]] || continue
    inputs="$(yq -r '.. | select(type == "!!map" and has("uses")) | select(.uses | test("^camunda/infra-tools@"))
      | ("tools " + (.with.tools // "" | sub("\s+"; " ")), "tool-cache " + (.with["tool-cache"] // "" | sub("\s+"; " ")))' \
      "${file}" 2>&1)" || {
      echo "::error file=${file}::infra-tools: cannot read ${file}: ${inputs//$'\n'/ }"
      exit 1
    }
    mapfile -t -O "${#declared[@]}" declared < <(awk -v file="${file}" '{ for (i = 2; i <= NF; i++) print file "\t" $1 "\t" $i }' <<<"${inputs}")
  done
  if ((${#declared[@]} == 0)); then
    echo "::notice::infra-tools: no infra-tools step in .github/workflows or .github/actions, nothing to validate"
    exit 0
  fi
  local -A platform_layers
  for platform in "${platforms[@]}"; do
    connect "${platform}"
    platform_layers["${platform}"]="${layers}"
  done
  for declaration in "${declared[@]}"; do
    IFS=$'\t' read -r file input selector <<<"${declaration}"
    tool="${selector%%@*}" want=""
    [[ "${selector}" == *@* ]] && want="${selector#*@}"
    error="$(selector_error "${input}" "${tool}")"
    if [[ -n "${error}" ]]; then
      echo "::error file=${file}::infra-tools: ${error}"
      failed=1
      continue
    fi
    found="" absent=""
    for platform in "${platforms[@]}"; do
      layers="${platform_layers[${platform}]}"
      mapfile -t candidates < <(published "${tool}")
      resolved="$(highest "${want}" "${candidates[@]}")"
      if [[ -n "${resolved}" ]]; then
        found+="${found:+, }${resolved} on linux/${platform}"
      else
        absent+="${absent:+, }linux/${platform}"
      fi
    done
    if [[ -n "${absent}" ]]; then
      echo "::error file=${file}::infra-tools: ${selector} matches no version in ${INDEX} on ${absent}"
      failed=1
    else
      echo "${file}: ${selector}: ${found}"
    fi
  done
  exit "${failed}"
}

[[ "${MODE:-extract}" =~ ^(extract|validate)$ ]] || fail "unknown mode '${MODE}': use extract or validate"
if [[ "${MODE:-extract}" == validate ]]; then validate; fi

# "<input> <selector>" for each selector, plain tools first.
mapfile -t listed < <(
  tr -s ' \t\r\n' '\n' <<<"${TOOLS:-}" | sed '/^$/d; s/^/tools /'
  tr -s ' \t\r\n' '\n' <<<"${TOOL_CACHE_TOOLS:-}" | sed '/^$/d; s/^/tool-cache /'
)
selectors=()
declare -A want folder arch_folder add_path home version detail
missing=()
for entry in "${listed[@]}"; do
  input="${entry%% *}" selector="${entry#* }"
  selectors+=("${selector}")
  tool="${selector%%@*}"
  want["${selector}"]=""
  [[ "${selector}" == *@* ]] && want["${selector}"]="${selector#*@}"
  error="$(selector_error "${input}" "${tool}")"
  [[ -z "${error}" ]] || fail "${error}"
  IFS=$'\t' read -r folder["${selector}"] arch_folder["${selector}"] add_path["${selector}"] < <(layout "${tool}")
  present=()
  for complete in "${tool_cache}/${folder[${selector}]}"/*/"${arch_folder[${selector}]}.complete"; do
    [[ -f "${complete}" ]] && present+=("$(basename "$(dirname "${complete}")")")
  done
  hit="$(highest "${want[${selector}]}" "${present[@]}")"
  if [[ -n "${hit}" ]]; then
    home["${selector}"]="${tool_cache}/${folder[${selector}]}/${hit}/${arch_folder[${selector}]}"
    # Folders write `+` as `-`; the first `-` is the build metadata one, since prereleases are never published (D41).
    version["${selector}"]="${hit/-/+}"
    detail["${selector}"]=cached
  else
    missing+=("${selector}")
  fi
done

if ((${#missing[@]})); then
  connect
  for selector in "${missing[@]}"; do
    tool="${selector%%@*}"
    mapfile -t candidates < <(published "${tool}")
    resolved="$(highest "${want[${selector}]}" "${candidates[@]}")"
    [[ -n "${resolved}" ]] || fail "${selector} matches no version in ${INDEX}"
    layer="$(jq -c --arg tool "${tool}" --arg version "${resolved}" --arg a "${annotation}" \
      '[.[] | select(.annotations[$a + ".tool"] == $tool and .annotations[$a + ".version"] == $version)][0]' <<<"${layers}")"
    target="${tool_cache}/${folder[${selector}]}/${resolved//+/-}/${arch_folder[${selector}]}"
    size="$(jq -r .size <<<"${layer}")"
    started="$(now_ms)"
    install_layer "${tool}" "$(jq -r .digest <<<"${layer}")" "${target}"
    took="$(($(now_ms) - started))"
    home["${selector}"]="${target}"
    version["${selector}"]="${resolved}"
    detail["${selector}"]="installed $(mb "${size}") MB in $(seconds "${took}") s ($(mb $((size * 1000 / (took > 0 ? took : 1)))) MB/s) from ${registry}"
  done
fi

versions='{}'
rows=()
echo "infra-tools: ${INDEX:-no index} (linux/${arch})"
for selector in "${selectors[@]}"; do
  if [[ -n "${add_path[${selector}]}" ]]; then echo "${home[${selector}]}/${add_path[${selector}]}" >>"${GITHUB_PATH}"; fi
  versions="$(jq -c --arg tool "${selector%%@*}" --arg version "${version[${selector}]}" '.[$tool] = $version' <<<"${versions}")"
  echo "${selector}: ${version[${selector}]} ${detail[${selector}]} -> ${home[${selector}]}"
  if [[ "${selector%%@*}" == maven ]]; then link_wrapper "${home[${selector}]}" "${version[${selector}]}"; fi
  rows+=("| ${selector} | ${version[${selector}]} | ${detail[${selector}]} | ${home[${selector}]} |")
done
echo "versions=${versions}" >>"${GITHUB_OUTPUT}"
echo "done in $(seconds $(($(now_ms) - begin))) s: $((${#selectors[@]} - ${#missing[@]})) cached, ${#missing[@]} installed"
if [[ "${SUMMARY:-false}" == true ]] && ((${#rows[@]})); then
  {
    echo "### infra-tools: ${INDEX:-no index} (linux/${arch})"
    echo
    echo "| Selector | Version | Result | Tool cache path |"
    echo "| --- | --- | --- | --- |"
    printf '%s\n' "${rows[@]}"
    echo
  } >>"${GITHUB_STEP_SUMMARY}"
fi
