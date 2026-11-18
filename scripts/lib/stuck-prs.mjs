// Weekly digest of stuck Renovate PRs, from the processed-prs output of the renovate-pr-maintainer action.

// The maintainer requests a rebase of a behind PR after its stale-hours (24), so 48h leaves it a day of grace.
export const STUCK_HOURS = 48;
const REASONS = { dirty: 'merge conflict', 'rebase-labeled': 'awaiting rebase' };
const INFRA_MEDIC = '<!subteam^S01K6MZC3AQ|infra-medic>';

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
// Slack mrkdwn control characters (https://api.slack.com/reference/surfaces/formatting#escaping).
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// processedPrs: the action's processed-prs output, JSON text of [{ number, base, state, age_hours, ... }], read as no PR when
// empty. repository: owner/name, for PR links. runUrl: the workflow run, linked from the message. Returns the Slack incoming
// webhook payload, or null when no PR is stuck.
export function stuckPrDigest(processedPrs, { repository, runUrl }) {
  const stuck = JSON.parse(processedPrs.trim() || '[]').filter((pr) => REASONS[pr.state] && pr.age_hours >= STUCK_HOURS);
  if (!stuck.length) return null;
  const lines = [`:warning: *${stuck.length} Renovate PR(s) not rebased in days*, far past the window where they should have caught up to their base branch:`];
  for (const base of [...new Set(stuck.map((pr) => pr.base))].sort()) {
    lines.push(`• *${escape(base)}*`);
    for (const pr of stuck.filter((p) => p.base === base).sort((a, b) => b.age_hours - a.age_hours)) {
      const days = Math.floor(pr.age_hours / 24);
      lines.push(`        ◦ <https://github.com/${repository}/pull/${pr.number}|#${pr.number}> stuck ${days}d (${REASONS[pr.state]})`);
    }
  }
  return {
    blocks: [
      section(lines.join('\n')),
      section(`These are normally kept in sync with their base branch automatically through automatic rebases. Days behind means some PRs are stuck, or Renovate has stopped running for this repo.\n${INFRA_MEDIC} please check the PRs above and confirm Renovate is still processing the repo.`),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_From the <${runUrl}|Renovate PR maintainer> run_` }] },
    ],
  };
}
