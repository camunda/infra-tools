// Weekly digest of stuck Renovate PRs, from the processed-prs output of the renovate-pr-maintainer action.

// The maintainer requests a rebase of a behind PR after its stale-hours (24), so 48h leaves it a day of grace.
export const STUCK_HOURS = 48;
const REASONS = { dirty: 'merge conflict', 'rebase-labeled': 'awaiting rebase' };
const INFRA_MEDIC = '<!subteam^S01K6MZC3AQ|infra-medic>';
// Longest section text Slack accepts (https://docs.slack.dev/reference/block-kit/blocks/section-block/).
const SECTION_LENGTH = 3000;
// Most blocks Slack accepts in one message (https://docs.slack.dev/reference/block-kit/blocks/).
const MAX_BLOCKS = 50;

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
// Slack mrkdwn control characters (https://api.slack.com/reference/surfaces/formatting#escaping).
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// processedPrs: the action's processed-prs output, JSON text of [{ number, base, state, age_hours, ... }], read as no PR when
// empty. repository: owner/name, for PR links. runUrl: the workflow run, linked from the message. Returns the Slack incoming
// webhook payload, or null when no PR is stuck.
export function stuckPrDigest(processedPrs, { repository, runUrl }) {
  const stuck = JSON.parse(processedPrs.trim() || '[]').filter((pr) => REASONS[pr.state] && pr.age_hours >= STUCK_HOURS);
  if (!stuck.length) return null;
  // Each line with the number of PRs it lists, so the digest can say how many were left out.
  const lines = [{ text: `:warning: *${stuck.length} Renovate PR(s) not rebased in days*, far past the window where they should have caught up to their base branch:`, prs: 0 }];
  for (const base of [...new Set(stuck.map((pr) => pr.base))].sort()) {
    lines.push({ text: `• *${escape(base)}*`, prs: 0 });
    for (const pr of stuck.filter((p) => p.base === base).sort((a, b) => b.age_hours - a.age_hours)) {
      const days = Math.floor(pr.age_hours / 24);
      lines.push({ text: `        ◦ <https://github.com/${repository}/pull/${pr.number}|#${pr.number}> stuck ${days}d (${REASONS[pr.state]})`, prs: 1 });
    }
  }
  // Fills each section up to SECTION_LENGTH, breaking between lines.
  const sections = [];
  for (const line of lines) {
    const last = sections.at(-1);
    if (last && last.text.length + 1 + line.text.length <= SECTION_LENGTH) sections[sections.length - 1] = { text: `${last.text}\n${line.text}`, prs: last.prs + line.prs };
    else sections.push({ ...line });
  }
  // The closing section and the context take 2 blocks; a list cut short takes one more to say so.
  const list = sections.length > MAX_BLOCKS - 2 ? sections.slice(0, MAX_BLOCKS - 3) : sections;
  const omitted = stuck.length - list.reduce((sum, s) => sum + s.prs, 0);
  return {
    blocks: [
      ...list.map((s) => section(s.text)),
      ...(omitted ? [section(`_…and ${omitted} more PR(s) not listed here, see the <${runUrl}|Renovate PR maintainer> run_`)] : []),
      section(`These are normally kept in sync with their base branch automatically through automatic rebases. Days behind means some PRs are stuck, or Renovate has stopped running for this repo.\n${INFRA_MEDIC} please check the PRs above and confirm Renovate is still processing the repo.`),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_From the <${runUrl}|Renovate PR maintainer> run_` }] },
    ],
  };
}
