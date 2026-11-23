// Usage: node failure-issues.mjs --repository <owner>/<name> --run-url <url> [--failures <dir>] [--resolve <scope>]...
// Failure issues (ADR 0012, D63), shared by the reconciler and the release, once a run knows its failures: each failure report
// in --failures (one JSON file per failure, { key, context, state, errors }, as lib/failure-issues.mjs syncFailureIssues takes
// them; the folder is missing when nothing failed) opens, updates or reopens its failure issue, with its runbook from
// docs/runbooks/; the open failure issue of a key within a --resolve scope (tool, reconcile/push, release/index/1.2.0, ...)
// that no report has is closed. An issue opened or reopened posts one line to #infra-alerts through the Slack webhook in
// SLACK_WEBHOOK_INFRA_ALERTS. Uses gh and its token (GH_TOKEN or GITHUB_TOKEN): the job's GITHUB_TOKEN, with issues: write.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { syncFailureIssues } from './lib/failure-issues.mjs';
import { ghApi, ghJson, ROOT } from './lib/repository.mjs';

const { values } = parseArgs({
  options: { repository: { type: 'string' }, 'run-url': { type: 'string' }, failures: { type: 'string' }, resolve: { type: 'string', multiple: true, default: [] } },
});
if (!values.repository || !values['run-url']) {
  throw new Error('usage: node failure-issues.mjs --repository <owner>/<name> --run-url <url> [--failures <dir>] [--resolve <scope>]...');
}
const repo = `repos/${values.repository}`;

// The failure reports of this run; the folder is missing when nothing failed.
async function readFailures(dir) {
  if (!dir) return [];
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))));
}

// Creates a label the repository lacks, once per run: issues are found by their label, which creating an issue with a missing
// label does not reliably add.
const ensuredLabels = new Set();
function ensureLabel(name) {
  if (ensuredLabels.has(name)) return;
  try {
    ghJson(`${repo}/labels`, { method: 'POST', body: { name, color: 'B60205', description: 'Failure issue (ADR 0012): opened and closed by the workflows' } });
  } catch (err) {
    if (!/already_exists/.test(err.stdout ?? '') && !/already_exists/.test(err.stderr ?? '')) throw err;
  }
  ensuredLabels.add(name);
}

const github = {
  // The issues API lists pull requests too: those are left out.
  listIssues: async (label) =>
    JSON.parse(ghApi('', '--paginate', '--slurp', `${repo}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`))
      .flat()
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({ number: issue.number, state: issue.state, title: issue.title, body: issue.body, url: issue.html_url })),
  createIssue: async ({ title, body, labels }) => {
    labels.forEach(ensureLabel);
    const { number, html_url: url } = ghJson(`${repo}/issues`, { method: 'POST', body: { title, body, labels } });
    console.log(`${title}: opened ${url}`);
    return { number, url };
  },
  updateIssue: async (number, changes) => {
    ghJson(`${repo}/issues/${number}`, { method: 'PATCH', body: changes });
    console.log(`#${number}: ${changes.state === 'closed' ? 'closed' : changes.state === 'open' ? 'reopened' : 'updated'}`);
  },
  addComment: async (number, body) => ghJson(`${repo}/issues/${number}/comments`, { method: 'POST', body: { body } }),
};

// One Slack line in #infra-alerts, retried on a network error, a rate limit or a server error (3 attempts, 2 s then 4 s apart).
async function postAlert(text) {
  const webhook = process.env.SLACK_WEBHOOK_INFRA_ALERTS;
  if (!webhook) throw new Error(`SLACK_WEBHOOK_INFRA_ALERTS is not set, alert not sent: ${text}`);
  // null once posted, else the error and whether to retry it.
  const post = () =>
    fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(
      async (response) => (response.ok ? null : { error: `HTTP ${response.status} ${await response.text()}`, retry: response.status === 429 || response.status >= 500 }),
      (err) => ({ error: err.message, retry: true }),
    );
  for (let attempt = 1; ; attempt++) {
    const failed = await post();
    if (!failed) break;
    if (!failed.retry || attempt === 3) throw new Error(`Slack webhook: ${failed.error}, alert not sent: ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  console.log(`alerted: ${text}`);
}

// Alerts are sent once every issue is written: a Slack error then fails the run without leaving a failure untracked; the alert
// itself is lost, as the next run only updates the issue.
const alerts = [];
await syncFailureIssues({
  github,
  alert: async (text) => alerts.push(text),
  readRunbook: (path) => readFile(join(ROOT, 'docs', 'runbooks', path), 'utf8'),
  failures: await readFailures(values.failures),
  resolve: values.resolve,
  runUrl: values['run-url'],
});
for (const text of alerts) await postAlert(text);
