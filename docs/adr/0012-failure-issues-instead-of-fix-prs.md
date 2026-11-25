# Failure issues instead of fix PRs

Every failure of the reconciler or of a release is tracked in a failure issue that says what happened and how to fix it, and that follows the failure's state: the run that finds the failure gone closes it, and a run that finds it again reopens it. A tool failure gets one issue per tool and major, listing each failing version with its own error; a run failure gets one issue per flow and step (and release). The issue is written for a person and read by an agent: its procedure comes from `docs/runbooks/`, a hidden marker holds its key, and it says which commands are safe to run unattended. The plan never reads GitHub state: it depends only on the repository, upstream and the registry, so the same inputs give the same plan, and a version is ignored by adding it to its line's `ignoredVersions` with a `reason`, in a reviewed commit, not by closing anything. This replaces the fix PRs of ADR 0005 (D21), and wires the `#infra-alerts` alert D54 deferred: one Slack line when a failure issue opens or reopens, or, for a reconciler run failure, once its step has kept failing for a day (D67).

## Considered Options

- **Fix PRs** (D21): closing one without merge ignored its versions, so the plan read pull request state; each started from an empty commit and needed an App token for its checks to run; and grouping versions by a normalized error signature split or merged wrongly. An ordinary PR fixes a tool failure just as well: its checks already build the versions it plans.
- **One issue per tool version**: a burst of upstream releases opens one issue each for the same break.
- **Slack alerts only**: no place for the procedure or the state, and nothing closes when the failure is gone.

## Consequences

- A tool failure leaves the run green: it is tracked, and a permanently red run would hide new run failures. A run failure turns the run red, which only matters when the failure issue itself could not be opened.
- Transient errors are retried inside the scripts, call by call, so a step fails only when its error persists and a run failure opens its issue on the first failed run; `rerun-failed-jobs` goes. An outage that outlasts the retries still opens an issue, but a reconciler run failure alerts no one until it has lasted a day (D67).
- A failing version is rebuilt on every reconciler run until it builds or is ignored: no backoff state.
- A pull request touching a tool, or the shared build, fails while any planned version of that tool fails: it has to fix the version or ignore it.
- Closing a failure issue by hand changes nothing: the next run reopens it while the failure lasts.
- `release-merge.yml` has no procedure worth an issue (rerun, or look at the release PR's checks): its failures alert `#infra-alerts` directly.
