# Runbooks

The procedures of the failure issues (ADR 0012, D63): `scripts/failure-issues.mjs` copies the runbook of a failure into its failure issue, below the failure's context, observed state and error, so a person or an agent can fix it from the issue alone. A reconciler run failure issue alerts `#infra-alerts` only once its step has kept failing for a day (D67): an issue without an alert yet may be an outage that ends on its own.

| Failure | Runbook |
| --- | --- |
| Tool failure (label `tool-failure`, one issue per tool and major) | `tool-failure.md` |
| Run failure (label `run-failure`, one issue per flow and step, and release) | `<flow>/<step>.md`: `reconcile/<step>.md` or `release/<step>.md`; a step's qualifier is left out (`release/mirror.md` for `mirror.gar`) |

A runbook starts with a `#` title, left out of the issue, and has these `##` sections, which the failure issue sync checks (a runbook without one fails the run, and the tests fail the PR that removes it):

- `## Likely causes`: each likely cause with its fix.
- `## Procedure`: the steps, with their commands.
- `## Verify`: how to tell the failure is fixed; the next run closes the failure issue once it no longer fails.
- `## Agents`: one line saying which commands of the procedure an agent may run unattended, and that the others need a person.

Commands name the repository (`-R camunda/infra-tools`) and use placeholders such as `<tool>`, `<version>` or `<release>`, which the issue's context and error fill in.
