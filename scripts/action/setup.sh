#!/usr/bin/env bash
# infra-tools setup (root) and cache actions (KIND). Requires bash, curl, jq, tar, sha256sum; yq for MODE=validate.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version="$(jq -r '."."' "${here}/.github/config/.release-please-manifest.json")"
origin_index="${INDEX:-ghcr.io/camunda/infra-tools:${version}-tools}"
mirror_index=""
if [[ -n "${INFRA_TOOLS_MIRROR:-}" && "${origin_index}" == ghcr.io/camunda/* ]]; then
  mirror_index="${INFRA_TOOLS_MIRROR%/}/${origin_index#ghcr.io/camunda/}"
fi
accept_index="application/vnd.oci.image.index.v1+json"
accept_manifest="application/vnd.oci.image.manifest.v1+json"
annotation="io.camunda.infra-tools"
kind="${KIND:?}"
prefix="infra-tools"
[[ "${kind}" == cache ]] && prefix="infra-tools/cache"
tmp="${RUNNER_TEMP:-/tmp}"
auth=()
now_ms() { echo $(($(date +%s%N) / 1000000)); }
started="$(now_ms)"

if [[ "${RUNNER_OS:-Linux}" != Linux ]]; then
  echo "::notice::${prefix}: ${RUNNER_OS} runners are not supported, nothing installed"
  echo "versions={}" >>"${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi
case "${RUNNER_ARCH:-X64}" in
X64) arch=amd64 ;;
ARM64) arch=arm64 ;;
*) echo "::error::${prefix}: unsupported runner architecture ${RUNNER_ARCH}"; exit 1 ;;
esac
tc="${RUNNER_TOOL_CACHE:?}"
mkdir -p "${tc}"

# Tool layout from tools/<tool>/tool.json at the pinned commit: no network needed to find tools already present.
config() {
  local file="${here}/tools/$1/tool.json"
  [[ -f "${file}" ]] || { echo "::error::${prefix}: unknown tool '$1'"; return 1; }
  jq -c --arg t "$1" --arg a "${arch}" '.install // {} | {
    folder: (.cacheFolder // $t),
    arch: ((.archFolders // {amd64: "x64", arm64: "arm64"})[$a]),
    path: (.addToPath // "")
  }' "${file}"
}

# Plain tools (addToPath) are ready to use with setup; the others need their setup-* action, after cache.
kind_of() { [[ -n "$(jq -r .path <<<"$1")" ]] && echo setup || echo cache; }

check_kind() {
  local tool="$1" layout="$2" where="${3:-}"
  [[ "$(kind_of "${layout}")" == "${4:-${kind}}" ]] && return 0
  if [[ "${4:-${kind}}" == cache ]]; then
    echo "::error${where}::infra-tools/cache: ${tool} is ready to use: select it in camunda/infra-tools"
  else
    echo "::error${where}::infra-tools: ${tool} needs its setup-* action: select it in camunda/infra-tools/cache, then run setup-${tool}"
  fi
  return 1
}

# Highest version (tool cache folder name) matching the selector; `+` and `-` are equivalent.
pick() {
  local selector="${1//+/-}"
  shift
  printf '%s\n' "$@" | awk -v s="${selector}" 'NF && (s == "" || $0 == s || index($0, s ".") == 1 || index($0, s "-") == 1)' | sort -V | tail -n 1
}

use_index() {
  index="$1" registry="${1%%/*}" repository="${1#*/}"
  name="${repository%:*}" tag="${repository##*:}"
  api="${INFRA_TOOLS_REGISTRY_SCHEME:-https}://${registry}/v2/${name}"
  auth=()
}

# Artifact Registry takes the runner pod's Workload Identity access token (GKE metadata server) as a bearer token directly,
# which skips its challenge and token endpoints (occasionally ~5 s each); other registries: token exchange with TOKEN.
login() {
  local challenge realm service bearer
  if [[ "${registry}" == *.pkg.dev ]]; then
    bearer="$(curl -fsS -m 5 -H "Metadata-Flavor: Google" \
      http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | jq -r .access_token)" || return 1
  else
    challenge="$(curl -sS -m 10 -o /dev/null -D - -H "Accept: ${accept_index}" "${api}/manifests/${tag}" | tr -d '\r' | awk 'tolower($1) == "www-authenticate:" { $1 = ""; print }')" || return 1
    [[ "${challenge}" == *Bearer* ]] || return 0
    realm="$(sed -nE 's/.*realm="([^"]+)".*/\1/p' <<<"${challenge}")"
    service="$(sed -nE 's/.*service="([^"]+)".*/\1/p' <<<"${challenge}")"
    bearer="$(curl -fsSL --retry 3 ${TOKEN:+-u "token:${TOKEN}"} "${realm}?service=${service}&scope=repository:${name}:pull" | jq -r '.token // .access_token')" || return 1
  fi
  [[ -n "${bearer}" && "${bearer}" != null ]] || return 1
  auth=(-H "Authorization: Bearer ${bearer}")
}

# Logs in and reads the platform's index manifest, from the mirror when set, else (or when it fails) from the origin.
connect() {
  local t0
  echo "::group::${prefix}: index"
  if [[ -n "${mirror_index}" ]]; then
    use_index "${mirror_index}"
    t0="$(now_ms)"
    if login && echo "login ${registry}: $(($(now_ms) - t0)) ms" && t0="$(now_ms)" \
      && platform_layers="$(layers "$1")" && [[ -n "${platform_layers}" ]]; then
      echo "index ${index}: $(($(now_ms) - t0)) ms (mirror)"
      echo "::endgroup::"
      return 0
    fi
    echo "::warning::${prefix}: mirror ${mirror_index} unavailable, using ${origin_index}"
  fi
  use_index "${origin_index}"
  t0="$(now_ms)"
  login
  echo "login ${registry}: $(($(now_ms) - t0)) ms"
  t0="$(now_ms)"
  platform_layers="$(layers "$1")"
  echo "index ${index}: $(($(now_ms) - t0)) ms"
  echo "::endgroup::"
}

get() { curl -fsSL --retry 3 --retry-all-errors ${auth[@]+"${auth[@]}"} "$@"; }

# Layers of the index for a platform, with their annotations.
layers() {
  local digest
  digest="$(get -H "Accept: ${accept_index}" "${api}/manifests/${tag}" | jq -r --arg a "$1" '.manifests[] | select(.platform.architecture == $a) | .digest')"
  [[ -n "${digest}" ]] || { echo "::error::${prefix}: ${index} has no linux/$1 manifest"; return 1; }
  get -H "Accept: ${accept_manifest}" "${api}/manifests/${digest}" | jq -c '.layers'
}

# Index layer of the highest version matching a selector, or nothing.
resolve() {
  jq -c --arg t "$2" --arg s "${3//+/-}" --arg p "${annotation}" '
    [.[] | select(.annotations[$p + ".tool"] == $t)
      | select(.annotations[$p + ".folder-version"] as $v | $s == "" or $v == $s or ($v | startswith($s + ".")) or ($v | startswith($s + "-")))]
    | sort_by(.annotations[$p + ".folder-version"] | [scan("[0-9]+") | tonumber]) | last // empty' <<<"$1"
}

# "<file> <kind> <selector>" for every infra-tools step of the repository's workflows and local actions.
selectors() {
  local file
  for file in .github/workflows/*.y*ml .github/actions/*/action.y*ml; do
    [[ -f "${file}" ]] || continue
    yq -r '.. | select(type == "!!map" and has("uses") and (.uses | test("camunda/infra-tools(/cache)?@")))
      | (if (.uses | test("infra-tools/cache@")) then "cache" else "setup" end) + " " + ((.with.tools // "") | sub("\s+"; " "))' "${file}" \
      | awk -v f="${file}" 'NF > 1 { for (i = 2; i <= NF; i++) print f " " $1 " " $i }'
  done
}

if [[ "${MODE:-extract}" == validate ]]; then
  failed=0
  for platform in amd64 arm64; do
    connect "${platform}"
    while read -r file step selector; do
      want=""
      [[ "${selector}" == *@* ]] && want="${selector#*@}"
      if [[ "${platform}" == amd64 ]] && ! check_kind "${selector%%@*}" "$(config "${selector%%@*}")" " file=${file}" "${step}"; then
        failed=1
      elif [[ -z "$(resolve "${platform_layers}" "${selector%%@*}" "${want}")" ]]; then
        echo "::error file=${file}::${selector} is not in infra-tools ${version} (linux/${platform})"
        failed=1
      fi
    done < <(selectors)
  done
  exit "${failed}"
fi

hash_string() { # Same hash as ./mvnw (only-script) for its distribution folder.
  local str="$1" h=0
  while [[ -n "${str}" ]]; do
    h=$(((h * 31 + $(LC_CTYPE=C printf %d "'${str:0:1}")) % 4294967296))
    str="${str:1}"
  done
  printf %x "${h}"
}

# Lets ./mvnw use the tool cache Maven when .mvn/wrapper asks for the same version.
link_mvnw() {
  local home="$1" maven_version="$2" props="${GITHUB_WORKSPACE:-.}/.mvn/wrapper/maven-wrapper.properties" url dist dir
  [[ -f "${props}" ]] || return 0
  url="$(sed -nE 's/^distributionUrl=(.*)$/\1/p' "${props}" | tr -d '\r')"
  if [[ "${url}" != *"/apache-maven-${maven_version}-bin."* ]]; then
    echo "::notice::${prefix}: .mvn/wrapper asks for another Maven version, ./mvnw downloads it"
    return 0
  fi
  dist="${url##*/}"
  dist="${dist%.*}"
  dir="${MAVEN_USER_HOME:-${HOME}/.m2}/wrapper/dists/${dist%-bin}"
  mkdir -p "${dir}"
  [[ -e "${dir}/$(hash_string "${url}")" ]] || ln -s "${home}" "${dir}/$(hash_string "${url}")"
  echo "linked ./mvnw to maven ${maven_version}"
}

install_layer() {
  local tool="$1" ver="$2" digest="$3" target="$4" sum="${tmp}/infra-tools-$1.sha256" attempt sum_pid t0
  t0="$(now_ms)"
  echo "::debug::${prefix}: ${tool} ${ver} layer ${digest} from ${registry}"
  for attempt in 1 2 3; do
    rm -rf "${target}" "${sum}.fifo"
    mkfifo "${sum}.fifo"
    sha256sum <"${sum}.fifo" | cut -d' ' -f1 >"${sum}" &
    sum_pid=$!
    if get "${api}/blobs/${digest}" | tee "${sum}.fifo" | tar xz -C "${tc}" --strip-components=2 --exclude='*.complete'; then
      wait "${sum_pid}"
      [[ "sha256:$(cat "${sum}")" == "${digest}" ]] && break
      echo "::warning::${prefix}: ${tool} layer digest mismatch (attempt ${attempt})"
    else
      wait "${sum_pid}" || true
      echo "::warning::${prefix}: ${tool} download failed (attempt ${attempt})"
    fi
    ((attempt < 3)) || { echo "::error::${prefix}: ${tool} ${ver} could not be installed"; return 1; }
    sleep "${attempt}"
  done
  rm -f "${sum}" "${sum}.fifo"
  touch "${target}.complete"
  echo "$(($(now_ms) - t0))" >"${tmp}/infra-tools-$1.ms"
}

declare -A folder arch_folder add_path resolved selected state size
order=()
missing=()
for selector in ${TOOLS:-}; do
  tool="${selector%%@*}" want=""
  selected[${tool}]="${selector}"
  order+=("${tool}")
  [[ "${selector}" == *@* ]] && want="${selector#*@}"
  layout="$(config "${tool}")"
  check_kind "${tool}" "${layout}"
  folder[${tool}]="$(jq -r .folder <<<"${layout}")"
  arch_folder[${tool}]="$(jq -r .arch <<<"${layout}")"
  add_path[${tool}]="$(jq -r .path <<<"${layout}")"
  present=()
  for done_file in "${tc}/${folder[${tool}]}"/*/"${arch_folder[${tool}]}.complete"; do
    [[ -f "${done_file}" ]] && present+=("$(basename "$(dirname "${done_file}")")")
  done
  hit="$(pick "${want}" ${present[@]+"${present[@]}"})"
  if [[ -n "${hit}" ]]; then
    resolved[${tool}]="${hit}"
    state[${tool}]=cached
  else
    missing+=("${tool}@${want}")
  fi
done

if ((${#missing[@]})); then
  connect "${arch}"
  pids=()
  for selector in "${missing[@]}"; do
    tool="${selector%%@*}" want="${selector#*@}"
    layer="$(resolve "${platform_layers}" "${tool}" "${want}")"
    if [[ -z "${layer}" ]]; then
      echo "::error::${prefix}: ${tool}${want:+@${want}} is not in infra-tools ${version}"
      exit 1
    fi
    ver="$(jq -r --arg p "${annotation}" '.annotations[$p + ".folder-version"]' <<<"${layer}")"
    resolved[${tool}]="${ver}"
    state[${tool}]=installed
    size[${tool}]="$(jq -r .size <<<"${layer}")"
    install_layer "${tool}" "${ver}" "$(jq -r .digest <<<"${layer}")" "${tc}/${folder[${tool}]}/${ver}/${arch_folder[${tool}]}" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "${pid}"; done
fi

versions="{}"
for tool in "${!resolved[@]}"; do
  ver="${resolved[${tool}]}"
  home="${tc}/${folder[${tool}]}/${ver}/${arch_folder[${tool}]}"
  versions="$(jq -c --arg t "${tool}" --arg v "${ver/-/+}" '.[$t] = $v' <<<"${versions}")"
  if [[ -n "${add_path[${tool}]}" ]]; then echo "${home}/${add_path[${tool}]}" >>"${GITHUB_PATH:-/dev/null}"; fi
  case "${tool}" in
  docker-compose)
    mkdir -p "${HOME}/.docker/cli-plugins"
    ln -sf "${home}/bin/docker-compose" "${HOME}/.docker/cli-plugins/docker-compose"
    ;;
  maven) link_mvnw "${home}" "${ver}" ;;
  esac
done
echo "versions=$(jq -cS . <<<"${versions}")" >>"${GITHUB_OUTPUT:-/dev/null}"

# One line per tool: selector, version, installed (size, time, speed, registry) or cached, tool cache path.
mb() { echo $((($1 + 524288) / 1048576)); }
installed=0 cached=0 bytes=0 rows=()
echo "infra-tools ${version} (linux/${arch})"
for tool in ${order[@]+"${order[@]}"}; do
  ver="${resolved[${tool}]}" home="${tc}/${folder[${tool}]}/${resolved[${tool}]}/${arch_folder[${tool}]}"
  if [[ "${state[${tool}]}" == installed ]]; then
    ms="$(cat "${tmp}/infra-tools-${tool}.ms")"
    rm -f "${tmp}/infra-tools-${tool}.ms"
    detail="installed $(mb "${size[${tool}]}") MB in $(printf '%d.%d' $((ms / 1000)) $((ms % 1000 / 100))) s ($(mb $((size[${tool}] * 1000 / (ms > 0 ? ms : 1)))) MB/s) from ${registry}"
    installed=$((installed + 1)) bytes=$((bytes + size[${tool}]))
  else
    detail=cached cached=$((cached + 1))
  fi
  printf '%-16s %-20s %s -> %s\n' "${selected[${tool}]}" "${ver/-/+}" "${detail}" "${home}"
  rows+=("| \`${selected[${tool}]}\` | ${ver/-/+} | ${detail} | \`${home}\` |")
done
total="$(($(now_ms) - started))"
echo "done in $(printf '%d.%d' $((total / 1000)) $((total % 1000 / 100))) s: ${installed} installed ($(mb "${bytes}") MB), ${cached} cached"
if [[ "${SUMMARY:-false}" == true && ${#rows[@]} -gt 0 ]]; then
  {
    echo "### ${prefix} ${version} (linux/${arch})"
    echo
    echo "| Selector | Version | Result | Tool cache path |"
    echo "| --- | --- | --- | --- |"
    printf '%s\n' "${rows[@]}"
    echo
  } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
