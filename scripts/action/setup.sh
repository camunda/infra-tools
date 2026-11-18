#!/usr/bin/env bash
# The action (action.yml): installs the selected tools from the index into the tool cache, and puts plain tools on PATH.
# Inputs come from the environment: TOOLS (selectors), TOKEN (registry token) and INDEX (<registry>/<repository>:<tag>).
# Requires bash 5, curl, jq, tar and sha256sum.
set -euo pipefail

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

if [[ "${RUNNER_OS:-}" != Linux ]]; then
  echo "::notice::infra-tools: ${RUNNER_OS:-this OS} runners are not supported, nothing installed"
  echo "versions={}" >>"${GITHUB_OUTPUT}"
  exit 0
fi
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

# Logs in to the index's registry and reads the layers of this platform's manifest.
connect() {
  [[ -n "${INDEX:-}" ]] || fail "no index to install from: set the index input"
  registry="${INDEX%%/*}"
  local repository="${INDEX#*/}" challenge realm service bearer digest
  name="${repository%:*}"
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
    | jq -r --arg arch "${arch}" '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest')" \
    || fail "cannot read the index ${INDEX}"
  [[ -n "${digest}" ]] || fail "the index ${INDEX} has no linux/${arch} manifest"
  layers="$(get -H "Accept: ${media_manifest}" "${api}/manifests/${digest}" | jq -c .layers)" || fail "cannot read the index ${INDEX}"
  echo "index: $(($(now_ms) - started)) ms"
  echo "::endgroup::"
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
  tar xzf "${file}" -C "${tool_cache}" --strip-components=2 --exclude='*.complete'
  rm -f "${file}"
  [[ -d "${target}" ]] || fail "${tool}: layer ${digest} does not hold ${target#"${tool_cache}"/}"
  touch "${target}.complete"
}

mapfile -t selectors < <(tr -s ' \t\r\n' '\n' <<<"${TOOLS:-}" | sed '/^$/d')
declare -A want folder arch_folder add_path home version detail
missing=()
for selector in "${selectors[@]}"; do
  tool="${selector%%@*}"
  want["${selector}"]=""
  [[ "${selector}" == *@* ]] && want["${selector}"]="${selector#*@}"
  [[ -f "${root}/tools/${tool}/tool.json" ]] || fail "unknown tool '${tool}'; tools: $(cd "${root}/tools" && echo *)"
  IFS=$'\t' read -r folder["${selector}"] arch_folder["${selector}"] add_path["${selector}"] < <(layout "${tool}")
  present=()
  for complete in "${tool_cache}/${folder[${selector}]}"/*/"${arch_folder[${selector}]}.complete"; do
    [[ -f "${complete}" ]] && present+=("$(basename "$(dirname "${complete}")")")
  done
  hit="$(highest "${want[${selector}]}" "${present[@]}")"
  if [[ -n "${hit}" ]]; then
    home["${selector}"]="${tool_cache}/${folder[${selector}]}/${hit}/${arch_folder[${selector}]}"
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
    mapfile -t published < <(jq -r --arg tool "${tool}" --arg a "${annotation}" \
      '.[] | select(.annotations[$a + ".tool"] == $tool) | .annotations[$a + ".version"]' <<<"${layers}")
    resolved="$(highest "${want[${selector}]}" "${published[@]}")"
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
echo "infra-tools: ${INDEX:-no index} (linux/${arch})"
for selector in "${selectors[@]}"; do
  if [[ -n "${add_path[${selector}]}" ]]; then echo "${home[${selector}]}/${add_path[${selector}]}" >>"${GITHUB_PATH}"; fi
  versions="$(jq -c --arg tool "${selector%%@*}" --arg version "${version[${selector}]}" '.[$tool] = $version' <<<"${versions}")"
  echo "${selector}: ${version[${selector}]} ${detail[${selector}]} -> ${home[${selector}]}"
done
echo "versions=${versions}" >>"${GITHUB_OUTPUT}"
echo "done in $(seconds $(($(now_ms) - begin))) s: $((${#selectors[@]} - ${#missing[@]})) cached, ${#missing[@]} installed"
