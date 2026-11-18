#!/usr/bin/env bash
# The action (action.yml): installs the selected tools from the index into the tool cache, and puts plain tools on PATH.
# Inputs come from the environment: TOOLS (plain tool selectors), TOOL_CACHE_TOOLS (tool-cache tool selectors), MODE
# (`extract` or `validate`), TOKEN (registry token), INDEX (<registry>/<repository>:<tag>) and SUMMARY (`true`: table of the
# selected tools in the job summary).
# Requires bash 5, curl, jq, tar and sha256sum on Linux; yq for MODE=validate.
set -euo pipefail

# Other runners run the action with the bash they have (3.2 on macOS): nothing before this check may need bash 5.
if [[ "${RUNNER_OS:-}" != Linux ]]; then
  echo "::notice::infra-tools: ${RUNNER_OS:-this OS} runners are not supported, nothing installed"
  echo "versions={}" >>"${GITHUB_OUTPUT}"
  exit 0
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

case "${RUNNER_ARCH:-}" in
X64) arch=amd64 ;;
ARM64) arch=arm64 ;;
*) fail "unsupported runner architecture ${RUNNER_ARCH:-}" ;;
esac
tool_cache="${RUNNER_TOOL_CACHE:?}"
tmp="${RUNNER_TEMP:?}"

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

# Set by connect(): the index's registry host, its API base URL, the authorization header and the platform's index layers.
registry="" api="" auth=() layers=""

# Logs in to the index's registry and reads the layers of a platform's manifest (amd64 or arm64, this runner's by default).
connect() {
  [[ -n "${INDEX:-}" ]] || fail "no index to install from: set the index input"
  registry="${INDEX%%/*}"
  local platform="${1:-${arch}}" repository="${INDEX#*/}" challenge realm service bearer digest
  local name="${repository%:*}"
  # INFRA_TOOLS_REGISTRY_SCHEME is for tests only (scripts/test/action.test.mjs serves a fake registry over http).
  api="${INFRA_TOOLS_REGISTRY_SCHEME:-https}://${registry}/v2/${name}"
  auth=()
  echo "::group::infra-tools: index ${INDEX}"
  local started
  started="$(now_ms)"
  challenge="$(curl -sS --retry 3 -o /dev/null -D - -H "Accept: ${media_index}" "${api}/manifests/${repository##*:}" \
    | tr -d '\r' | sed -nE 's/^[Ww][Ww][Ww]-[Aa]uthenticate: *//p')" || fail "cannot reach ${registry}"
  if [[ "${challenge}" == Bearer* ]]; then
    realm="$(sed -nE 's/.*realm="([^"]+)".*/\1/p' <<<"${challenge}")"
    service="$(sed -nE 's/.*service="([^"]+)".*/\1/p' <<<"${challenge}")"
    bearer="$(curl -fsSL --retry 3 ${TOKEN:+-u "token:${TOKEN}"} "${realm}?service=${service}&scope=repository:${name}:pull" \
      | jq -r '.token // .access_token // empty')" || fail "login to ${registry} failed"
    auth=(-H "Authorization: Bearer ${bearer}")
  fi
  echo "login ${registry}: $(($(now_ms) - started)) ms"
  started="$(now_ms)"
  digest="$(get -H "Accept: ${media_index}" "${api}/manifests/${repository##*:}" \
    | jq -r --arg arch "${platform}" '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest')" \
    || fail "cannot read the index ${INDEX}"
  [[ -n "${digest}" ]] || fail "the index ${INDEX} has no linux/${platform} manifest"
  layers="$(get -H "Accept: ${media_manifest}" "${api}/manifests/${digest}" | jq -c .layers)" || fail "cannot read the index ${INDEX}"
  echo "index: $(($(now_ms) - started)) ms"
  echo "::endgroup::"
}

# Versions of a tool in the index layers read by connect().
published() {
  jq -r --arg tool "$1" --arg a "${annotation}" \
    '.[] | select(.annotations[$a + ".tool"] == $tool) | .annotations[$a + ".version"]' <<<"${layers}"
}

get() { curl -fsSL --retry 3 --retry-all-errors --retry-delay 1 --connect-timeout 10 "${auth[@]}" "$@"; }

# Downloads a layer, verifies it against its digest and extracts it into the tool cache, then marks the tool version
# complete. The layer holds opt/hostedtoolcache/<folder>/<version>/<arch> (ADR 0003): two path components are stripped.
install_layer() {
  local tool="$1" digest="$2" target="$3" file="${tmp}/infra-tools-$1.tar.gz" attempt
  echo "::debug::infra-tools: ${tool} layer ${digest} from ${registry}"
  for attempt in 1 2 3; do
    if get -o "${file}" "${api}/blobs/${digest}" && [[ "sha256:$(sha256sum "${file}" | cut -d' ' -f1)" == "${digest}" ]]; then
      break
    fi
    echo "::warning::infra-tools: ${tool} download failed or does not match its digest (attempt ${attempt})"
    ((attempt < 3)) || fail "${tool}: could not download layer ${digest}"
    sleep "${attempt}"
  done
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
# repository's .mvn/wrapper asks for the same version (D32); ./mvnw then does not download it.
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
# nothing. Each invalid selector gets an error annotation on its file.
[[ "${MODE:-extract}" =~ ^(extract|validate)$ ]] || fail "unknown mode '${MODE}': use extract or validate"
if [[ "${MODE:-extract}" == validate ]]; then
  echo "versions={}" >>"${GITHUB_OUTPUT}"
  command -v yq >/dev/null || fail "mode: validate needs yq"
  cd "${GITHUB_WORKSPACE:?}"
  declared=() # "<file>\t<input>\t<selector>"
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
  declare -A platform_layers
  for platform in amd64 arm64; do
    connect "${platform}"
    platform_layers["${platform}"]="${layers}"
  done
  failed=0
  for declaration in "${declared[@]}"; do
    IFS=$'\t' read -r file input selector <<<"${declaration}"
    tool="${selector%%@*}" want=""
    [[ "${selector}" == *@* ]] && want="${selector#*@}"
    if [[ ! -f "${root}/tools/${tool}/tool.json" ]]; then
      echo "::error file=${file}::infra-tools: unknown tool '${tool}'; tools: $(cd "${root}/tools" && echo *)"
      failed=1
      continue
    fi
    IFS=$'\t' read -r _ _ path_folder < <(layout "${tool}")
    if [[ -n "${path_folder}" && "${input}" != tools ]]; then
      echo "::error file=${file}::infra-tools: ${tool} is a plain tool: list it under tools, not ${input}"
      failed=1
      continue
    elif [[ -z "${path_folder}" && "${input}" != tool-cache ]]; then
      echo "::error file=${file}::infra-tools: ${tool} is a tool-cache tool: list it under tool-cache, not ${input}"
      failed=1
      continue
    fi
    found="" absent=""
    for platform in amd64 arm64; do
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
fi

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
  [[ -f "${root}/tools/${tool}/tool.json" ]] || fail "unknown tool '${tool}'; tools: $(cd "${root}/tools" && echo *)"
  IFS=$'\t' read -r folder["${selector}"] arch_folder["${selector}"] add_path["${selector}"] < <(layout "${tool}")
  # The tool definition decides the input (ADR 0006): with addToPath, a plain tool; without, a tool-cache tool.
  if [[ -n "${add_path[${selector}]}" && "${input}" != tools ]]; then
    fail "${tool} is a plain tool: list it under tools, not ${input}"
  elif [[ -z "${add_path[${selector}]}" && "${input}" != tool-cache ]]; then
    fail "${tool} is a tool-cache tool: list it under tool-cache, not ${input}, and keep its setup-* step"
  fi
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
