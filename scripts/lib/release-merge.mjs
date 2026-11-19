// Daily release merge (spec §5.5, D25): merges the open release PR of release-please once its Check CI passed, and alerts
// #infra-alerts when it is not merged in time.

// Label release-please puts on its open release PR.
export const RELEASE_PR_LABEL = 'autorelease: pending';
// A release PR with this label is left alone.
const NO_MERGE_LABEL = 'no-merge';
// The required check of ci.yml: the merge bypasses the ruleset (D56), so it waits for it itself.
export const RELEASE_PR_CHECK = 'Check CI';
// A release PR open this long alerts: its CI keeps failing, or the merge does not happen.
const STALE_HOURS = 48;
const INFRA_MEDIC = '<!subteam^S01K6MZC3AQ|infra-medic>';

// The result of the latest Check CI run: 'pass', 'pending', its conclusion (e.g. 'failure') or 'missing'.
function checkResult(checkRuns) {
  const latest = checkRuns.toSorted((a, b) => a.id - b.id).at(-1);
  if (!latest) return 'missing';
  if (latest.status !== 'completed') return 'pending';
  return latest.conclusion === 'success' ? 'pass' : latest.conclusion;
}

// github: the GitHub API of the repository:
// - releasePrs(): its open release PRs ([{ number, labels: [name], createdAt }]);
// - checkRuns(pr): the Check CI runs of the PR's head commit ([{ id, status, conclusion }]);
// - merge(pr): gh pr merge --auto --squash, which merges, or only enables auto-merge when a requirement is not met yet;
// - mergeState(pr): the PR once merge returned, 'merged', 'queued' (auto-merge enabled) or 'open'.
// now: the time, in ms. repository: owner/name, for links. runUrl: this workflow run.
// Returns the messages to log and to write to the job summary, and the Slack incoming webhook payload of the alert, or null.
export async function mergeReleasePr(github, { now, repository, runUrl }) {
  const pr = (await github.releasePrs()).filter((p) => !p.labels.includes(NO_MERGE_LABEL)).sort((a, b) => a.number - b.number)[0];
  if (!pr) return { messages: ['No release PR to merge.'], alert: null };
  const link = `<https://github.com/${repository}/pull/${pr.number}|#${pr.number}>`;
  const alert = (text) => ({ text: [`:warning: <https://github.com/${repository}|${repository}>`, text, `${INFRA_MEDIC} — <${runUrl}|View workflow run>`].join('\n') });

  const check = checkResult(await github.checkRuns(pr));
  if (check !== 'pass') {
    const messages = [`Release PR #${pr.number} not merged: ${RELEASE_PR_CHECK} is ${check}.`];
    if (now - Date.parse(pr.createdAt) < STALE_HOURS * 3600 * 1000) return { messages, alert: null };
    return { messages: [...messages, `Release PR #${pr.number} is open for 2 days or more.`], alert: alert(`Release PR ${link} open for 2 days or more: its CI fails, or it is not merged`) };
  }
  await github.merge(pr);
  const state = await github.mergeState(pr);
  if (state === 'merged') return { messages: [`Release PR #${pr.number} merged.`], alert: null };
  if (state === 'queued') {
    return {
      messages: [`Release PR #${pr.number} not merged: auto-merge is enabled and waits on its requirements (e.g. a review).`],
      alert: alert(`Release PR ${link} not merged: auto-merge waits on its requirements (e.g. a review)`),
    };
  }
  return { messages: [`Release PR #${pr.number} not merged: the merge left it open.`], alert: alert(`Release PR ${link} not merged: the merge left it open`) };
}
