# Install figures travel through `submit-build-status` into a JSON column

The action appends one JSON line per selected tool to `$RUNNER_TEMP/ci-analytics/tool-installs.jsonl`, and nothing else: no credentials, no network call. `submit-build-status` in `camunda/infra-global-github-actions`, which jobs already run as their last step, loads that file when present into a NULLABLE `tool_installs` column of type `JSON` on `prod_ci_analytics.build_status_v2`. If BigQuery rejects the row (`insertErrors`), it resends the row without `tool_installs`, so a bad file never costs the build status. This follows the existing hand-off of `start-build-monitor`, whose files `submit-build-status` reads at job end.

## Considered Options

- **The action sends to BigQuery itself**: every consuming job would need `id-token: write` or a Vault secret, and the install step would wait on a network call it must never fail on.
- **A new table `tool_install_v1`** (one row per tool, joined on `ci_url`, `build_id`, `job_name`, `job_id`, like `test_status_v1`): isolated, but a second write per job, a new IAM grant and a four-key join in every query.
- **A typed `REPEATED RECORD` column on `build_status_v2`**: every field we add would need the `infra-core` schema first; until then `insertAll` drops the whole build status row, CPU and duration included, and answers HTTP 200.

## Consequences

- Fields inside `tool_installs` change with infra-tools releases and need no schema change; the contract lives in this repository (spec §5.6), not in BigQuery. Queries read it with `JSON_QUERY_ARRAY` and `JSON_VALUE`.
- Figures exist only for jobs that run `submit-build-status`; jobs whose runner is OOM-killed or lost have none, like their CPU and memory figures.
- This supersedes D14 (satellite actions of `infra-global-github-actions` unchanged).
