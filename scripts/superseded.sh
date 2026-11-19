#!/usr/bin/env bash
# Usage: scripts/superseded.sh
# Superseded-run guard of the reconciler (spec §5.3), at the start of each job of reconcile.yml: a run whose commit
# (GITHUB_SHA) no longer matches the tip of main, published/ aside, is superseded and publishes nothing; the run on the tip
# does. Record commits only change published/ and start no run, so they supersede none. Fetches both commits at depth 1:
# works in a depth-1 checkout of either. Writes superseded=true or false to GITHUB_OUTPUT, and one line to
# GITHUB_STEP_SUMMARY when superseded.
set -euo pipefail

git fetch --quiet --no-tags --depth=1 origin "${GITHUB_SHA}" +refs/heads/main:refs/remotes/origin/main
tip="$(git rev-parse origin/main)"
# Exit status 1: the commits differ; any other failure fails the job.
status=0
git diff --quiet "${GITHUB_SHA}" "${tip}" -- . ':!published' || status=$?
case "${status}" in
0)
  echo "Not superseded: main (${tip}) matches this run's commit outside published/."
  echo "superseded=false" >>"${GITHUB_OUTPUT}"
  ;;
1)
  message="Superseded: main changed outside published/ since this run's commit (${GITHUB_SHA}), so nothing is published here; the run on main's tip (${tip}) publishes instead."
  echo "${message}"
  echo "superseded=true" >>"${GITHUB_OUTPUT}"
  echo "${message}" >>"${GITHUB_STEP_SUMMARY}"
  ;;
*) exit "${status}" ;;
esac
