import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runbookErrors, syncFailureIssues } from '../lib/failure-issues.mjs';
import { ROOT } from '../lib/repository.mjs';

const runUrl = (id) => `https://github.com/camunda/infra-tools/actions/runs/${id}`;

const runbook = (title) =>
  [
    `# ${title}`,
    '',
    '## Likely causes',
    '',
    '- Upstream changed its archive layout: adapt `install.sh`.',
    '',
    '## Procedure',
    '',
    '1. Reproduce: `node scripts/build.mjs <tool> <version>`.',
    '',
    '## Verify',
    '',
    'The next reconciler run publishes the version.',
    '',
    '## Agents',
    '',
    'An agent may run `node scripts/build.mjs` unattended; anything that pushes needs a person.',
    '',
  ].join('\n');
const runbooks = { 'tool-failure.md': runbook('Tool failure'), 'reconcile/push.md': runbook('Reconcile: push'), 'release/mirror.md': runbook('Release: mirror') };
const readRunbook = async (path) => {
  if (!(path in runbooks)) throw new Error(`ENOENT: ${path}`);
  return runbooks[path];
};

// A repository's issues and their comments, in memory, behind the GitHub API syncFailureIssues uses.
function fakeGithub() {
  const issues = [];
  const github = {
    issues,
    listIssues: async (label) => issues.filter((i) => i.labels.includes(label)).map(({ number, state, title, body, url }) => ({ number, state, title, body, url })),
    createIssue: async ({ title, body, labels }) => {
      const number = issues.length + 1;
      const url = `https://github.com/camunda/infra-tools/issues/${number}`;
      issues.push({ number, state: 'open', title, body, labels, url, comments: [] });
      return { number, url };
    },
    updateIssue: async (number, changes) => Object.assign(issues.find((i) => i.number === number), changes),
    addComment: async (number, body) => issues.find((i) => i.number === number).comments.push(body),
  };
  return github;
}

const javaFailure = (errors) => ({
  key: { tool: 'java', major: '21' },
  context: 'The reconciler could not build java 21.0.13+5.',
  state: 'java 21.0.13+5 is not published.',
  errors,
});
const downloadFailed = 'curl: (22) The requested URL returned error: 404\n#12 ERROR: process "/bin/sh -c install-tool" did not complete successfully: exit code: 22';

async function sync(github, options) {
  const alerts = [];
  await syncFailureIssues({ github, alert: async (text) => alerts.push(text), readRunbook, ...options });
  return alerts;
}

test('a new tool failure opens its issue, labelled, with its error and runbook, and alerts #infra-alerts', async () => {
  const github = fakeGithub();
  const alerts = await sync(github, { failures: [javaFailure({ '21.0.13+5 (build)': downloadFailed })], runUrl: runUrl(1) });
  assert.equal(github.issues.length, 1);
  const [issue] = github.issues;
  assert.equal(issue.title, 'Tool failure: java 21');
  assert.deepEqual(issue.labels, ['tool-failure']);
  assert.equal(issue.body.split('<!-- infra-tools: failure ')[0], [
    'The reconciler could not build java 21.0.13+5.',
    '',
    `Last failed run: ${runUrl(1)}`,
    '',
    '## Observed state',
    '',
    'java 21.0.13+5 is not published.',
    '',
    '## Error',
    '',
    '### 21.0.13+5 (build)',
    '',
    '```text',
    downloadFailed,
    '```',
    '',
    runbook('Tool failure').replace('# Tool failure\n\n', '').trimEnd(),
    '',
    '',
  ].join('\n'));
  assert.deepEqual(alerts, [':rotating_light: Failure issue opened: <https://github.com/camunda/infra-tools/issues/1|Tool failure: java 21>']);
});

test('the same error again only updates the last failed run, BuildKit step timings and hashes aside', async () => {
  const github = fakeGithub();
  const timed = (seconds, digest) => `#11 DONE ${seconds}s\n#12 ${seconds} curl: (22) The requested URL returned error: 404 for sha256:${digest}\n#12 ERROR: exit code: 22`;
  await sync(github, { failures: [javaFailure({ '21.0.13+5 (build)': timed('0.512', 'a'.repeat(64)) })], runUrl: runUrl(1) });
  const alerts = await sync(github, { failures: [javaFailure({ '21.0.13+5 (build)': timed('0.734', 'b'.repeat(64)) })], runUrl: runUrl(2) });
  assert.equal(github.issues.length, 1);
  const [issue] = github.issues;
  assert.match(issue.body, new RegExp(`^Last failed run: ${runUrl(2)}$`, 'm'));
  assert.deepEqual(issue.comments, []);
  assert.deepEqual(alerts, []);
});

test('a new error on the same key, a changed one or a new failing version, comments with it, and the body lists every error', async () => {
  const github = fakeGithub();
  const testFailed = 'Error: java -version exited with 127\n#14 ERROR: exit code: 1';
  await sync(github, { failures: [javaFailure({ '21.0.13+5 (build)': downloadFailed, '21.0.14+7 (build)': downloadFailed })], runUrl: runUrl(1) });
  const alerts = await sync(github, { failures: [javaFailure({ '21.0.13+5 (test)': testFailed, '21.0.14+7 (build)': downloadFailed })], runUrl: runUrl(2) });
  const [issue] = github.issues;
  assert.deepEqual(issue.comments, [[`New error in [this run](${runUrl(2)}):`, '', '### 21.0.13+5 (test)', '', '```text', testFailed, '```'].join('\n')]);
  assert.match(issue.body, /^### 21\.0\.13\+5 \(test\)$/m);
  assert.match(issue.body, /^### 21\.0\.14\+7 \(build\)$/m);
  assert.doesNotMatch(issue.body, /21\.0\.13\+5 \(build\)/);
  assert.deepEqual(alerts, []);

  // The new error is recorded: the next run failing with it changes nothing but the last failed run.
  await sync(github, { failures: [javaFailure({ '21.0.13+5 (test)': testFailed, '21.0.14+7 (build)': downloadFailed })], runUrl: runUrl(3) });
  assert.equal(issue.comments.length, 1);
});

const pushFailure = {
  key: { flow: 'reconcile', step: 'push' },
  context: 'The reconciler could not push node 26.1.0.',
  state: 'node 26.1.0 is built, not pushed.',
  errors: { push: 'unexpected status from PUT request: 503 Service Unavailable' },
};

test('reports of one key, such as the push failures of several build jobs, open one issue with every error', async () => {
  const github = fakeGithub();
  const push = (tag) => ({ ...pushFailure, errors: { [tag]: `PUT ${tag}: HTTP 503` } });
  const alerts = await sync(github, { failures: [push('node-26.1.0-r1'), push('java-21.0.13-5-r1')], runUrl: runUrl(1) });
  assert.equal(github.issues.length, 1);
  const [issue] = github.issues;
  assert.equal(issue.body.match(/The reconciler could not push node 26\.1\.0\./g).length, 1);
  assert.match(issue.body, /^### node-26\.1\.0-r1$/m);
  assert.match(issue.body, /^### java-21\.0\.13-5-r1$/m);
  assert.deepEqual(alerts, []);
});

// A time n hours after the first failure of the reconciler run failure tests, in milliseconds.
const atHour = (n) => Date.parse('2026-11-25T00:00:00Z') + n * 60 * 60 * 1000;

test('a reconciler run failure opens its issue without an alert, and alerts once, by the first run that finds it failing for 24 h', async () => {
  const github = fakeGithub();
  const run = async (id, now) => {
    const alerts = [];
    const { pendingAlerts } = await syncFailureIssues({ github, alert: async (text) => alerts.push(text), readRunbook, failures: [pushFailure], runUrl: runUrl(id), now });
    return { alerts, pendingAlerts };
  };
  const pending = [{ title: 'Run failure: reconcile push', url: 'https://github.com/camunda/infra-tools/issues/1', alertAt: '2026-11-26T00:00:00.000Z' }];
  assert.deepEqual(await run(1, atHour(0)), { alerts: [], pendingAlerts: pending });
  assert.equal(github.issues[0].state, 'open');
  assert.deepEqual(await run(2, atHour(22)), { alerts: [], pendingAlerts: pending });
  assert.deepEqual(await run(3, atHour(24.5)), { alerts: [':rotating_light: Failure issue failing for 24 h: <https://github.com/camunda/infra-tools/issues/1|Run failure: reconcile push>'], pendingAlerts: [] });
  assert.deepEqual(await run(4, atHour(26)), { alerts: [], pendingAlerts: [] });
  assert.equal(github.issues.length, 1);
});

test('a reconciler run failure found again after its issue closed starts over, without an alert, even when reopened by hand', async () => {
  const github = fakeGithub();
  await sync(github, { failures: [pushFailure], runUrl: runUrl(1), now: atHour(0) });
  await sync(github, { failures: [pushFailure], runUrl: runUrl(2), now: atHour(24) });
  await sync(github, { failures: [], resolve: ['reconcile/push'], runUrl: runUrl(3), now: atHour(26) });
  const [issue] = github.issues;
  assert.equal(issue.state, 'closed');

  // Reopened by a run.
  assert.deepEqual(await sync(github, { failures: [pushFailure], runUrl: runUrl(4), now: atHour(30) }), []);
  assert.equal(issue.state, 'open');
  assert.deepEqual(await sync(github, { failures: [pushFailure], runUrl: runUrl(5), now: atHour(52) }), []);
  assert.equal((await sync(github, { failures: [pushFailure], runUrl: runUrl(6), now: atHour(54) })).length, 1);

  // Closed by a run, then reopened by hand: the failure that comes back waits a day again.
  await sync(github, { failures: [], resolve: ['reconcile/push'], runUrl: runUrl(7), now: atHour(56) });
  await github.updateIssue(issue.number, { state: 'open' });
  assert.deepEqual(await sync(github, { failures: [pushFailure], runUrl: runUrl(8), now: atHour(58) }), []);
  assert.equal((await sync(github, { failures: [pushFailure], runUrl: runUrl(9), now: atHour(82) })).length, 1);
});

test('closing or reopening a reconciler run failure issue by hand keeps its streak: the failure never stopped', async () => {
  const github = fakeGithub();
  await sync(github, { failures: [pushFailure], runUrl: runUrl(1), now: atHour(0) });
  const [issue] = github.issues;

  // Closed and reopened by hand between two runs.
  await github.updateIssue(issue.number, { state: 'closed' });
  await github.updateIssue(issue.number, { state: 'open' });
  assert.deepEqual(await sync(github, { failures: [pushFailure], runUrl: runUrl(2), now: atHour(12) }), []);

  // Closed by hand: the run that finds it failing reopens it without an alert, which still comes 24 h after the failure started.
  await github.updateIssue(issue.number, { state: 'closed' });
  assert.deepEqual(await sync(github, { failures: [pushFailure], runUrl: runUrl(3), now: atHour(20) }), []);
  assert.equal(issue.state, 'open');
  assert.equal((await sync(github, { failures: [pushFailure], runUrl: runUrl(4), now: atHour(24) })).length, 1);

  // Alerted, then closed by hand: reopened without a second alert.
  await github.updateIssue(issue.number, { state: 'closed' });
  assert.deepEqual(await sync(github, { failures: [pushFailure], runUrl: runUrl(5), now: atHour(26) }), []);
  assert.equal(issue.state, 'open');
});

test('a run that finds a failure of its scope gone closes its issue with a comment; failures out of its scope stay open', async () => {
  const github = fakeGithub();
  await sync(github, { failures: [javaFailure({ '21.0.13+5 (build)': downloadFailed }), pushFailure], runUrl: runUrl(1) });
  const alerts = await sync(github, { failures: [], resolve: ['tool'], runUrl: runUrl(2) });
  const [java, push] = github.issues;
  assert.equal(push.title, 'Run failure: reconcile push');
  assert.deepEqual(push.labels, ['run-failure']);
  assert.equal(java.state, 'closed');
  assert.deepEqual(java.comments, [`No longer fails in [this run](${runUrl(2)}): closing.`]);
  assert.equal(push.state, 'open');
  assert.deepEqual(alerts, []);

  await sync(github, { failures: [], resolve: ['reconcile/push'], runUrl: runUrl(3) });
  assert.equal(push.state, 'closed');
  // A closed issue is not closed again.
  await sync(github, { failures: [], resolve: ['tool', 'reconcile'], runUrl: runUrl(4) });
  assert.equal(java.comments.length, 1);
});

test('a run that finds a failure again reopens its closed issue, even one closed by hand, with a comment and an alert', async () => {
  const github = fakeGithub();
  const mirrorFailure = {
    key: { flow: 'release', step: 'mirror.gar', release: '1.2.0' },
    context: 'The release could not copy its index to Artifact Registry.',
    state: 'Release 1.2.0 is a draft.',
    errors: { 'mirror.gar': 'PERMISSION_DENIED' },
  };
  await sync(github, { failures: [mirrorFailure], runUrl: runUrl(1) });
  const [issue] = github.issues;
  assert.equal(issue.title, 'Run failure: release 1.2.0 mirror.gar');
  assert.match(issue.body, /^## Procedure$/m);
  await github.updateIssue(issue.number, { state: 'closed' });

  const alerts = await sync(github, { failures: [mirrorFailure], runUrl: runUrl(2) });
  assert.equal(github.issues.length, 1);
  assert.equal(issue.state, 'open');
  assert.deepEqual(issue.comments, [[`Failing again in [this run](${runUrl(2)}):`, '', '### mirror.gar', '', '```text', 'PERMISSION_DENIED', '```'].join('\n')]);
  assert.match(issue.body, new RegExp(`^Last failed run: ${runUrl(2)}$`, 'm'));
  assert.deepEqual(alerts, [':rotating_light: Failure issue reopened: <https://github.com/camunda/infra-tools/issues/1|Run failure: release 1.2.0 mirror.gar>']);
});

test('errors too long for an issue keep their end, within the 65536 characters of an issue body', async () => {
  const github = fakeGithub();
  const longLog = (version) => [...Array.from({ length: 500 }, (_, i) => `#12 ${i}.000 downloading part ${i} of ${version}`), `#12 ERROR: ${version} failed`].join('\n');
  const versions = Array.from({ length: 20 }, (_, i) => `21.0.${i}+1`);
  await sync(github, { failures: [javaFailure(Object.fromEntries(versions.map((v) => [`${v} (build)`, longLog(v)])))], runUrl: runUrl(1) });
  const [issue] = github.issues;
  assert.ok(issue.body.length <= 65536, `${issue.body.length} characters`);
  for (const v of versions) assert.match(issue.body, new RegExp(`^#12 ERROR: ${v.replace('+', '\\+')} failed$`, 'm'));
});

test('a runbook without its likely causes, procedure, verification or agent commands fails the sync before any issue changes', async () => {
  const github = fakeGithub();
  const withoutAgents = async () => runbook('Tool failure').split('## Agents')[0];
  await assert.rejects(syncFailureIssues({ github, alert: async () => {}, readRunbook: withoutAgents, failures: [javaFailure({ '21.0.13+5 (build)': downloadFailed })], runUrl: runUrl(1) }), {
    message: 'docs/runbooks/tool-failure.md: missing the ## Agents section',
  });
  assert.deepEqual(github.issues, []);
});

test('every runbook of docs/runbooks has its likely causes, procedure, verification and agent commands', async () => {
  const dir = join(ROOT, 'docs', 'runbooks');
  const paths = (await readdir(dir, { recursive: true })).filter((p) => p.endsWith('.md') && p !== 'README.md');
  for (const path of paths) assert.deepEqual(runbookErrors(await readFile(join(dir, path), 'utf8')), [], path);
});
