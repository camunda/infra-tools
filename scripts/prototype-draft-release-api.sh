#!/usr/bin/env bash
# PROTOTYPE, throwaway: not part of infra-tools. Probes the GitHub draft release API in a scratch repository, to settle the
# assumptions of the release refactor (draft PATCHes, retargeting, upload by id) before the 1.1.0 repair.
# Usage: scripts/prototype-draft-release-api.sh <owner>/<scratch-repo>   (an existing repository with at least one commit)
# Leaves no release or tag behind; the repository itself is yours to delete.
set -euo pipefail

REPO="${1:?usage: $0 <owner>/<scratch-repo>}"
api() { gh api -H 'Accept: application/vnd.github+json' "$@"; }
show() { api "repos/${REPO}/releases/$1" --jq '"  draft=\(.draft) tag_name=\(.tag_name) target=\(.target_commitish[0:7]) assets=\([.assets[].name] | join(","))"'; }
tag_commit() { api "repos/${REPO}/commits/$1" --jq '.sha[0:7]' 2>/dev/null || echo 'none'; }

branch="$(api "repos/${REPO}" --jq .default_branch)"
A="$(api "repos/${REPO}/commits/${branch}" --jq .sha)"
# A second commit B, the "fix" a draft gets retargeted to.
B="$(api -X PUT "repos/${REPO}/contents/prototype-$(date +%s).txt" -f message='prototype: commit B' -f content="$(base64 <<<B)" --jq .commit.sha)"
echo "commits: A=${A:0:7} B=${B:0:7}"

echo; echo "== Q1: a PATCH of the body only resets tag_name?"
id1="$(api -X POST "repos/${REPO}/releases" -f tag_name=0.0.1 -f target_commitish="$A" -f name=0.0.1 -F draft=true --jq .id)"
echo " created draft 0.0.1 at A:"; show "$id1"
api -X PATCH "repos/${REPO}/releases/${id1}" -f body='body only' >/dev/null
echo " after PATCH {body}:"; show "$id1"

echo; echo "== Q2: a PATCH of tag_name + target_commitish restores it?"
api -X PATCH "repos/${REPO}/releases/${id1}" -f tag_name=0.0.1 -f target_commitish="$A" >/dev/null
echo " after PATCH {tag_name, target_commitish=A}:"; show "$id1"

echo; echo "== Q3: retarget to B, then un-draft: the tag lands on B?"
api -X PATCH "repos/${REPO}/releases/${id1}" -f tag_name=0.0.1 -f target_commitish="$B" -f body='retargeted' >/dev/null
echo " after PATCH {tag_name, target_commitish=B, body}:"; show "$id1"
api -X PATCH "repos/${REPO}/releases/${id1}" -f tag_name=0.0.1 -f target_commitish="$B" -F draft=false >/dev/null
echo " after PATCH {tag_name, target_commitish=B, draft=false}:"; show "$id1"
echo " tag 0.0.1 -> $(tag_commit 0.0.1) (expected B=${B:0:7})"

echo; echo "== Q4: un-drafting a broken draft (PATCH {draft:false} only) creates which tag?"
id2="$(api -X POST "repos/${REPO}/releases" -f tag_name=0.0.2 -f target_commitish="$A" -f name=0.0.2 -F draft=true --jq .id)"
api -X PATCH "repos/${REPO}/releases/${id2}" -f body='break it' >/dev/null
echo " broken draft:"; show "$id2"
api -X PATCH "repos/${REPO}/releases/${id2}" -F draft=false >/dev/null || echo " PATCH {draft:false} refused"
echo " after PATCH {draft:false}:"; show "$id2"

echo; echo "== Q5: upload an asset to a draft by release id (upload_url), body PATCH before it"
id3="$(api -X POST "repos/${REPO}/releases" -f tag_name=0.0.3 -f target_commitish="$A" -f name=0.0.3 -F draft=true --jq .id)"
api -X PATCH "repos/${REPO}/releases/${id3}" -f tag_name=0.0.3 -f target_commitish="$A" -f body='with tag_name' >/dev/null
echo '{"prototype":true}' >"${TMPDIR:-/tmp}/prototype-tools.json"
api -X POST -H 'Content-Type: application/json' "https://uploads.github.com/repos/${REPO}/releases/${id3}/assets?name=tools.json" \
  --input "${TMPDIR:-/tmp}/prototype-tools.json" --jq '" uploaded \(.name), state=\(.state)"'
show "$id3"

echo; echo "== cleanup: releases and tags"
for id in "$id1" "$id2" "$id3"; do api -X DELETE "repos/${REPO}/releases/${id}" >/dev/null; done
for t in $(api "repos/${REPO}/tags" --jq '.[].name'); do api -X DELETE "repos/${REPO}/git/refs/tags/${t}" >/dev/null && echo " deleted tag ${t}"; done
echo "done; delete the repository when finished: gh repo delete ${REPO} --yes (needs the delete_repo scope)"
