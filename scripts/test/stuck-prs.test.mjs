import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stuckPrDigest } from '../lib/stuck-prs.mjs';

const options = { repository: 'camunda/infra-tools', runUrl: 'https://github.com/camunda/infra-tools/actions/runs/1' };

// A processed-prs entry of the renovate-pr-maintainer action.
const pr = (number, state, ageHours, base = 'main') => ({ number, base, state, action: 'none', behind_by: 0, age_hours: ageHours, blockers: [], automerge: false });
// The action's processed-prs output, as the workflow passes it on stdin (a here-string adds a newline).
const output = (...prs) => `${JSON.stringify(prs)}\n`;

test('no digest when no PR is dirty or awaiting rebase for 48h or more', () => {
  assert.equal(stuckPrDigest(output(), options), null);
  assert.equal(stuckPrDigest(output(pr(1, 'dirty', 47), pr(2, 'rebase-labeled', 47), pr(3, 'behind', 500), pr(4, 'clean', 500)), options), null);
});

test('no digest when the action processed nothing and left its output empty', () => {
  assert.equal(stuckPrDigest('\n', options), null);
});

test('the digest lists stuck PRs by base branch, oldest first, and pings infra-medic', () => {
  const digest = stuckPrDigest(output(pr(12, 'dirty', 50), pr(20, 'dirty', 48, 'stable/8.8'), pr(11, 'clean', 300), pr(10, 'rebase-labeled', 100)), options);
  assert.deepEqual(digest, {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            ':warning: *3 Renovate PR(s) not rebased in days*, far past the window where they should have caught up to their base branch:',
            '• *main*',
            '        ◦ <https://github.com/camunda/infra-tools/pull/10|#10> stuck 4d (awaiting rebase)',
            '        ◦ <https://github.com/camunda/infra-tools/pull/12|#12> stuck 2d (merge conflict)',
            '• *stable/8.8*',
            '        ◦ <https://github.com/camunda/infra-tools/pull/20|#20> stuck 2d (merge conflict)',
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'These are normally kept in sync with their base branch automatically through automatic rebases. Days behind means some PRs are stuck, or Renovate has stopped running for this repo.\n<!subteam^S01K6MZC3AQ|infra-medic> please check the PRs above and confirm Renovate is still processing the repo.',
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_From the <https://github.com/camunda/infra-tools/actions/runs/1|Renovate PR maintainer> run_' }],
      },
    ],
  });
});

// Quotes and backslashes are kept as they are; Slack reads &, < and > as control characters in mrkdwn, so they are escaped.
test('a base branch name cannot break the digest', () => {
  const digest = stuckPrDigest(output(pr(1, 'dirty', 48, 'release/"a"&<b>\\c')), options);
  assert.equal(digest.blocks[0].text.text.split('\n')[1], '• *release/"a"&amp;&lt;b&gt;\\c*');
});
