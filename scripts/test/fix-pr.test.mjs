import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureSummary, fixPrChanges, logExcerpt, openFixPr, trackedVersions } from '../lib/fix-pr.mjs';

const runUrl = 'https://github.com/camunda/infra-tools/actions/runs/1';

// The output of a failing Bake stage, as build.mjs hands it over (lib/fix-pr.mjs logExcerpt).
const downloadFailed = (version) => [`#12 0.512 + curl -fsSL https://api.adoptium.net/v3/binary/version/jdk-${version}/linux/x64`, '#12 3.201 curl: (22) The requested URL returned error: 404', '#12 ERROR: process "/bin/sh -c install-tool" did not complete successfully: exit code: 22'].join('\n');
const failure = (version, { tool = 'java', step = 'build', excerpt = downloadFailed(version) } = {}) => ({ tool, version, step, excerpt });

// planTool's result of each tool once the run's builds are recorded: versions still to publish, and their fix PR if any.
const plans = (tool, versions) => ({ [tool]: { tool, versions: Object.entries(versions).map(([version, decision]) => ({ version, ...decision })) } });
const toPublish = { decision: 'publish', reason: 'new' };

test('a failing version opens a fix PR with the failing step, a log excerpt and the run link', () => {
  const changes = fixPrChanges({ failures: [failure('21.0.13+5')], pullRequests: [], plans: plans('java', { '21.0.13+5': toPublish }), runUrl });
  assert.equal(changes.length, 1);
  const [open] = changes;
  assert.equal(open.action, 'open');
  assert.equal(open.branch, 'tool-build/java-21.0.13-5');
  assert.equal(open.title, 'fix(java): build 21.0.13+5');
  // The empty start commit has a type release-please hides, so that it cuts no release should it land on main.
  assert.equal(open.commitMessage, 'chore(java): start the fix PR of 21.0.13+5');
  assert.match(open.body, /^The reconciler could not build or test java 21\.0\.13\+5\.$/m);
  assert.match(open.body, /^\*\*Failing step\*\*: `build`, in \[this reconciler run\]\(https:\/\/github\.com\/camunda\/infra-tools\/actions\/runs\/1\)$/m);
  assert.ok(open.body.includes(`\`\`\`text\n${downloadFailed('21.0.13+5')}\n\`\`\``));
});

// The fix PR an earlier run opened for these failures, as gh pr list gives it.
function openedFixPr(number, ...failures) {
  const tools = Object.fromEntries(failures.map((f) => [f.tool, {}]));
  for (const f of failures) tools[f.tool][f.version] = toPublish;
  const changes = fixPrChanges({ failures, pullRequests: [], plans: Object.assign({}, ...Object.entries(tools).map(([t, v]) => plans(t, v))), runUrl });
  assert.equal(changes.length, 1);
  return { number, state: 'OPEN', body: changes[0].body };
}

test('a failure with the same tool, major and error joins the open fix PR', () => {
  const pullRequests = [openedFixPr(5, failure('21.0.13+5'))];
  const changes = fixPrChanges({ failures: [failure('21.0.14+7')], pullRequests, plans: plans('java', { '21.0.13+5': { ...toPublish, fixPr: 5 }, '21.0.14+7': toPublish }), runUrl });
  assert.deepEqual(changes.map(({ action, number, title }) => ({ action, number, title })), [{ action: 'update', number: 5, title: 'fix(java): build 21.0.13+5, 21.0.14+7' }]);
  assert.match(changes[0].body, /^The reconciler could not build or test java 21\.0\.13\+5, 21\.0\.14\+7\.$/m);
});

test('a failure of another major or with another error opens its own fix PR', () => {
  const pullRequests = [openedFixPr(5, failure('21.0.13+5'))];
  const failures = [failure('25.0.2+4'), failure('21.0.14+7', { step: 'test', excerpt: 'Error: java -version printed 21.0.14\n#14 ERROR: process "/bin/sh -c test.sh" did not complete successfully: exit code: 1' })];
  const changes = fixPrChanges({ failures, pullRequests, plans: plans('java', { '21.0.13+5': { ...toPublish, fixPr: 5 }, '21.0.14+7': toPublish, '25.0.2+4': toPublish }), runUrl });
  assert.deepEqual(changes.map(({ action, branch, title }) => ({ action, branch, title })), [
    { action: 'open', branch: 'tool-build/java-25.0.2-4', title: 'fix(java): build 25.0.2+4' },
    { action: 'open', branch: 'tool-build/java-21.0.14-7', title: 'fix(java): build 21.0.14+7' },
  ]);
});

test('failures of one run with the same tool, major and error open one fix PR', () => {
  const changes = fixPrChanges({ failures: [failure('21.0.13+5'), failure('21.0.14+7'), failure('21.0.14+7', { tool: 'node' })], pullRequests: [], plans: { ...plans('java', { '21.0.13+5': toPublish, '21.0.14+7': toPublish }), ...plans('node', { '21.0.14+7': toPublish }) }, runUrl });
  assert.deepEqual(changes.map(({ action, branch, title }) => ({ action, branch, title })), [
    { action: 'open', branch: 'tool-build/java-21.0.13-5', title: 'fix(java): build 21.0.13+5, 21.0.14+7' },
    { action: 'open', branch: 'tool-build/node-21.0.14-7', title: 'fix(node): build 21.0.14+7' },
  ]);
});

test('a fix PR closes with a comment once none of its versions is left to publish', () => {
  const pullRequests = [openedFixPr(5, failure('21.0.13+5'), failure('21.0.14+7'))];
  // One version builds again: the fix PR still tracks the other one.
  assert.deepEqual(fixPrChanges({ failures: [failure('21.0.14+7')], pullRequests, plans: plans('java', { '21.0.13+5': { decision: 'skip', reason: 'published' }, '21.0.14+7': { ...toPublish, fixPr: 5 } }), runUrl }), []);

  const changes = fixPrChanges({ failures: [], pullRequests, plans: plans('java', { '21.0.13+5': { decision: 'skip', reason: 'published' }, '21.0.14+7': { decision: 'skip', reason: 'retired' } }), runUrl });
  assert.deepEqual(changes.map(({ action, number, comment }) => ({ action, number, comment })), [
    { action: 'close', number: 5, comment: [`No version of this PR is left to publish ([reconciler run](${runUrl})), closing:`, '- java 21.0.13+5: published', '- java 21.0.14+7: retired'].join('\n') },
  ]);
  // Closed by the reconciler, not by a maintainer: its versions are not ignored.
  assert.notEqual(changes[0].body, pullRequests[0].body);
});

test('open fix PRs track their versions; one closed without merge by a maintainer ignores them', () => {
  const open = openedFixPr(1, failure('21.0.13+5'), failure('21.0.14+7'));
  const closed = { ...openedFixPr(2, failure('25.0.2+4')), state: 'CLOSED' };
  const merged = { ...openedFixPr(3, failure('25.0.3+1')), state: 'MERGED' };
  const reconcilerClosed = openedFixPr(4, failure('25.0.4+2'));
  const [close] = fixPrChanges({ failures: [], pullRequests: [reconcilerClosed], plans: plans('java', { '25.0.4+2': { decision: 'skip', reason: 'published' } }), runUrl });
  const node = openedFixPr(6, failure('26.1.0', { tool: 'node' }));
  const tracked = trackedVersions([open, closed, merged, { ...reconcilerClosed, state: 'CLOSED', body: close.body }, node, { number: 7, state: 'CLOSED', body: 'A PR labeled by hand' }]);
  assert.deepEqual(tracked, {
    java: { '21.0.13+5': { number: 1, state: 'open' }, '21.0.14+7': { number: 1, state: 'open' }, '25.0.2+4': { number: 2, state: 'closed' } },
    node: { '26.1.0': { number: 6, state: 'open' } },
  });
});

test('the log excerpt ends a few lines after the first BuildKit error, or is the end of the log without one', () => {
  const output = Array.from({ length: 40 }, (_, i) => `#12 ${i}.000 line ${i}`);
  const log = ['#1 [internal] load build definition', ...output, '#12 ERROR: process "/bin/sh -c install-tool" did not complete successfully: exit code: 22', '------', ' > [install 3/3] RUN install-tool:', '------', 'ERROR: failed to solve: exit code: 22', 'ERROR: target tool failed', 'trailing'].join('\n');
  assert.deepEqual(logExcerpt(log).split('\n'), [...output.slice(-25), '#12 ERROR: process "/bin/sh -c install-tool" did not complete successfully: exit code: 22', '------', ' > [install 3/3] RUN install-tool:', '------', 'ERROR: failed to solve: exit code: 22', 'ERROR: target tool failed']);
  assert.deepEqual(logExcerpt(`\u001b[31mred\u001b[0m\n${output.join('\n')}\n`).split('\n'), output.slice(-30));
});

test('the job summary of a failed build names the tool, version and step, with the log excerpt', () => {
  assert.equal(failureSummary(failure('21.0.13+5')), [
    '## java 21.0.13+5: the `build` step failed',
    '',
    'Nothing was pushed. The **Fix PRs** job of this run tracks it in a fix PR (`tool-build` label), and every run builds it again until it builds. The end of the `build` step log:',
    '',
    '```text',
    downloadFailed('21.0.13+5'),
    '```',
    '',
  ].join('\n'));
});

test('a failure of a version published since, by a later attempt of the run, is no failure', () => {
  assert.deepEqual(fixPrChanges({ failures: [failure('21.0.13+5')], pullRequests: [], plans: plans('java', { '21.0.13+5': { decision: 'skip', reason: 'published' } }), runUrl }), []);
});

test('a fix PR version failing again changes nothing, unless its error changed: then a comment says so', () => {
  const pullRequests = [openedFixPr(5, failure('21.0.13+5'), failure('21.0.14+7'))];
  const tracked = plans('java', { '21.0.13+5': { ...toPublish, fixPr: 5 }, '21.0.14+7': { ...toPublish, fixPr: 5 } });
  assert.deepEqual(fixPrChanges({ failures: [failure('21.0.13+5'), failure('21.0.14+7')], pullRequests, plans: tracked, runUrl }), []);

  const testFailed = 'Error: mvn -version exited with 127\n#14 ERROR: process "/bin/sh -c test.sh" did not complete successfully: exit code: 1';
  const changes = fixPrChanges({ failures: [failure('21.0.13+5'), failure('21.0.14+7', { step: 'test', excerpt: testFailed })], pullRequests, plans: tracked, runUrl });
  assert.deepEqual(changes.map(({ action, number }) => ({ action, number })), [{ action: 'comment', number: 5 }, { action: 'update', number: 5 }]);
  assert.equal(changes[0].body, [`The error of java 21.0.14+7 changed: the \`test\` step failed in [this reconciler run](${runUrl}).`, '', '```text', testFailed, '```'].join('\n'));
  assert.match(changes[1].body, /^\*\*Failing step\*\*: `test`/m);

  // The new error is recorded: the next failure with it changes nothing.
  const updated = [{ ...pullRequests[0], body: changes[1].body }];
  assert.deepEqual(fixPrChanges({ failures: [failure('21.0.14+7', { step: 'test', excerpt: testFailed })], pullRequests: updated, plans: tracked, runUrl }), []);
});

// The GitHub API openFixPr uses, recording its calls; openPr: the open PR of the branch, if any.
function fakeGithub(openPr = null) {
  const calls = [];
  const github = {
    openPullRequest: async (branch) => (calls.push(['openPullRequest', branch]), openPr),
    resetBranch: async (branch, message) => calls.push(['resetBranch', branch, message]),
    createPullRequest: async (pr) => (calls.push(['createPullRequest', pr]), { number: 7, url: 'https://github.com/camunda/infra-tools/pull/7' }),
    addLabel: async (number) => calls.push(['addLabel', number]),
    updatePullRequest: async (number, pr) => calls.push(['updatePullRequest', number, pr]),
  };
  return { github, calls };
}

test('a fix PR opens from an empty commit on its branch, labelled', async () => {
  const [open] = fixPrChanges({ failures: [failure('21.0.13+5')], pullRequests: [], plans: plans('java', { '21.0.13+5': toPublish }), runUrl });
  const { github, calls } = fakeGithub();
  assert.equal(await openFixPr(github, open), 'opened https://github.com/camunda/infra-tools/pull/7');
  assert.deepEqual(calls, [
    ['openPullRequest', 'tool-build/java-21.0.13-5'],
    ['resetBranch', 'tool-build/java-21.0.13-5', open.commitMessage],
    ['createPullRequest', { title: open.title, head: 'tool-build/java-21.0.13-5', body: open.body }],
    ['addLabel', 7],
  ]);
});

test('a fix PR opened without its label, as when labelling failed, gets it and is updated, its branch left alone', async () => {
  const [open] = fixPrChanges({ failures: [failure('21.0.13+5')], pullRequests: [], plans: plans('java', { '21.0.13+5': toPublish }), runUrl });
  const { github, calls } = fakeGithub({ number: 6, url: 'https://github.com/camunda/infra-tools/pull/6' });
  assert.equal(await openFixPr(github, open), 'labelled and updated https://github.com/camunda/infra-tools/pull/6');
  assert.deepEqual(calls, [
    ['openPullRequest', 'tool-build/java-21.0.13-5'],
    ['addLabel', 6],
    ['updatePullRequest', 6, { title: open.title, body: open.body }],
  ]);
});
