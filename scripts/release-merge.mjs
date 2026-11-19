// Usage: node release-merge.mjs --repository <owner>/<name> --run-url <url> --out <file> [--summary <file>]
// Daily release merge (spec §5.5): merges the open release PR of --repository once its Check CI passed
// (lib/release-merge.mjs), with gh and its token (GH_TOKEN or GITHUB_TOKEN): the Infra - Misc App's, bypass actor of the main
// ruleset (D56). Logs what happened, also appended to --summary (the job summary), and writes the Slack payload of the alert to
// --out only when the release PR is left open for 2 days or more, or left waiting for auto-merge.
import { execFileSync } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { mergeReleasePr, RELEASE_PR_CHECK, RELEASE_PR_LABEL } from './lib/release-merge.mjs';
import { ghJson, readPullRequests } from './lib/repository.mjs';

const { values } = parseArgs({ options: { repository: { type: 'string' }, 'run-url': { type: 'string' }, out: { type: 'string' }, summary: { type: 'string' } } });
if (!values.repository || !values['run-url'] || !values.out) throw new Error('usage: node release-merge.mjs --repository <owner>/<name> --run-url <url> --out <file> [--summary <file>]');
const repo = `repos/${values.repository}`;

const github = {
  releasePrs: async () => readPullRequests(values.repository, RELEASE_PR_LABEL).filter((pr) => pr.state === 'OPEN'),
  checkRuns: async (pr) => {
    const { head } = ghJson(`${repo}/pulls/${pr.number}`);
    return ghJson(`${repo}/commits/${head.sha}/check-runs?check_name=${encodeURIComponent(RELEASE_PR_CHECK)}`).check_runs;
  },
  merge: async (pr) => execFileSync('gh', ['pr', 'merge', String(pr.number), '--auto', '--squash', '--repo', values.repository], { stdio: 'inherit' }),
  mergeState: async (pr) => {
    const { merged, auto_merge: autoMerge } = ghJson(`${repo}/pulls/${pr.number}`);
    return merged ? 'merged' : autoMerge ? 'queued' : 'open';
  },
};

const { messages, alert } = await mergeReleasePr(github, { now: Date.now(), repository: values.repository, runUrl: values['run-url'] });
for (const message of messages) console.log(alert ? `::warning::${message}` : message);
if (values.summary) await appendFile(values.summary, `## Release merge\n\n${messages.join('\n\n')}\n`);
if (alert) await writeFile(values.out, `${JSON.stringify(alert, null, 2)}\n`);
