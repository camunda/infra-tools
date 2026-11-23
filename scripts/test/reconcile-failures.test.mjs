import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFailureSummary, logExcerpt, reconcileFailures, runFailureReport } from '../lib/reconcile-failures.mjs';

// The output of a failing Bake stage, as build.mjs hands it over (logExcerpt).
const downloadFailed = (version) => [`#12 0.512 + curl -fsSL https://api.adoptium.net/v3/binary/version/jdk-${version}/linux/x64`, '#12 3.201 curl: (22) The requested URL returned error: 404', '#12 ERROR: process "/bin/sh -c install-tool" did not complete successfully: exit code: 22'].join('\n');
const failure = (tool, version, step = 'build') => ({ tool, version, tag: `${tool}-${version.replace('+', '-')}-r1`, step, excerpt: downloadFailed(version) });

// planTool's result of a tool once the run's builds are recorded.
const planned = (version, line) => ({ version, decision: 'publish', reason: 'new', line, revision: 1, tag: `java-${version.replace('+', '-')}-r1`, platforms: ['linux/amd64', 'linux/arm64'] });
const published = (version) => ({ version, decision: 'skip', reason: 'published' });
const plans = {
  java: { tool: 'java', versions: [published('21.0.12+8'), planned('21.0.13+5', '21'), planned('21.0.14+7', '21'), published('25.0.1+8'), planned('25.0.2+4', '25'), planned('27.0.1+2', '*')] },
  node: { tool: 'node', versions: [published('26.11.1'), { version: '26.11.2', decision: 'skip', reason: 'ignored' }] },
};
// This run's builds (the plan's builds.json): the versions planned since, such as java 27.0.1+2 once its minAge passed, were
// not built.
const builds = ['21.0.13+5', '21.0.14+7', '25.0.2+4'].map((version) => ({ tool: 'java', version, tag: `java-${version.replace('+', '-')}-r1` }));
const check = (options) => reconcileFailures({ plans, builds, failures: [], reported: [], ...options });

test('the tool failures of a run open one report per tool and major, with each version, its error and how to reproduce it', () => {
  const { reports } = check({ failures: [failure('java', '21.0.14+7', 'test'), failure('java', '21.0.13+5'), failure('java', '25.0.2+4')] });
  assert.deepEqual(reports.map((r) => r.key), [{ tool: 'java', major: '21' }, { tool: 'java', major: '25' }]);
  const [java21] = reports;
  assert.equal(java21.context, [
    'The reconciler could not build or test java 21.0.13+5, 21.0.14+7: they are not published, and every reconciler run builds them again.',
    'Reproduce one with `node scripts/build.mjs java 21.0.13+5`.',
    'Fix the build in a pull request that refers to this issue, or ignore the versions in `tools/java/tool.json`: see the procedure below.',
  ].join(' '));
  assert.equal(java21.state, [
    '- java 21.0.13+5: the `build` step failed; line `21`, tag `java-21.0.13-5-r1`, linux/amd64, linux/arm64',
    '- java 21.0.14+7: the `test` step failed; line `21`, tag `java-21.0.14-7-r1`, linux/amd64, linux/arm64',
  ].join('\n'));
  assert.deepEqual(java21.errors, { '21.0.13+5 (build)': downloadFailed('21.0.13+5'), '21.0.14+7 (test)': downloadFailed('21.0.14+7') });
});

test('a failure whose version is no longer planned, published or ignored since, is none', () => {
  const { reports } = check({ builds: [...builds, { tool: 'node', version: '26.11.2' }, { tool: 'java', version: '21.0.12+8' }], failures: [failure('node', '26.11.2'), failure('java', '21.0.12+8'), ...builds.map((b) => failure('java', b.version))] });
  assert.deepEqual(reports.map((r) => r.key), [{ tool: 'java', major: '21' }, { tool: 'java', major: '25' }]);
});

test('the tool failure issues a run closes are those of every tool and major whose versions it built all failed or published', () => {
  // java 25.0.2+4 neither published nor failed: its build job failed for another reason, so java 25 is left as it is.
  const { resolve } = check({ failures: [failure('java', '21.0.13+5'), failure('java', '21.0.14+7')] });
  assert.deepEqual(resolve, ['tool/java/21', 'tool/java/27', 'tool/node']);
  assert.deepEqual(check({ failures: builds.map((b) => failure('java', b.version)) }).resolve, ['tool/java', 'tool/node']);
});

test('the completeness check finds the versions this run built that are neither published nor failed (R17)', () => {
  const failures = [failure('java', '21.0.13+5'), failure('java', '21.0.14+7')];
  assert.deepEqual(check({ failures }).gaps, ['java 25.0.2+4 (new)']);
  // java 27.0.1+2, planned since the run's plan, is the next run's.
  assert.deepEqual(check({ failures: [...failures, failure('java', '25.0.2+4')] }).gaps, []);
});

test('a revision planned after the plan of the run, such as one adding a platform released upstream meanwhile, is left to the next run', () => {
  const node = { tool: 'node', versions: [{ ...planned('26.12.0', '26'), tag: 'node-26.12.0-r2', reason: 'adds linux/arm64 to node-26.12.0-r1' }] };
  const { gaps, reports } = reconcileFailures({ plans: { node }, builds: [{ tool: 'node', version: '26.12.0', tag: 'node-26.12.0-r1' }], failures: [], reported: [] });
  assert.deepEqual(gaps, []);
  assert.deepEqual(reports, []);
});

test('a push report of an earlier attempt whose version is published since, by a rerun, is stale', () => {
  const failures = [failure('java', '21.0.13+5'), failure('java', '21.0.14+7')];
  assert.deepEqual(check({ failures, reported: ['java-25.0.2-4-r1', 'node-26.11.1-r1'] }).stale, ['node-26.11.1-r1']);
});

test('a version whose build job failed without reporting, as on a timeout, gets a push report without a log', () => {
  const failures = [failure('java', '21.0.13+5')];
  const silent = check({ failures }).reports.filter((r) => r.key.step === 'push');
  assert.deepEqual(silent.map((r) => Object.keys(r.errors)), [['java-21.0.14-7-r1'], ['java-25.0.2-4-r1']]);
  assert.match(silent[0].errors['java-21.0.14-7-r1'], /^No log:/);
  // One that reported its push failure keeps its report.
  assert.deepEqual(check({ failures, reported: ['java-21.0.14-7-r1'] }).reports.filter((r) => r.key.step === 'push').map((r) => Object.keys(r.errors)), [['java-25.0.2-4-r1']]);
});

test('a run failure reports the end of its step log, with the context and state of its step', () => {
  const log = [...Array.from({ length: 80 }, (_, i) => `line ${i}`), 'Error: PUT https://ghcr.io/v2/camunda/infra-tools/manifests/node-26.1.0-r1: HTTP 503'].join('\n');
  const report = runFailureReport({ step: 'push', subject: 'node-26.1.0-r1', log });
  assert.deepEqual(report.key, { flow: 'reconcile', step: 'push' });
  assert.match(report.context, /could not push/);
  assert.equal(report.errors['node-26.1.0-r1'].split('\n').length, 50);
  assert.match(report.errors['node-26.1.0-r1'], /HTTP 503$/);
  // Without a log, the job failed before its step ran or logged: the report says so, the run link has the rest.
  assert.match(runFailureReport({ step: 'record' }).errors.record, /^No log:/);
  assert.throws(() => runFailureReport({ step: 'deploy' }), { message: 'unknown reconciler step deploy: plan, push, record or completeness' });
});

test('the log excerpt ends a few lines after the first BuildKit error, or is the end of the log without one', () => {
  const output = Array.from({ length: 40 }, (_, i) => `#12 ${i}.000 line ${i}`);
  const log = ['#1 [internal] load build definition', ...output, '#12 ERROR: process "/bin/sh -c install-tool" did not complete successfully: exit code: 22', '------', ' > [install 3/3] RUN install-tool:', '------', 'ERROR: failed to solve: exit code: 22', 'ERROR: target tool failed', 'trailing'].join('\n');
  assert.deepEqual(logExcerpt(log).split('\n'), [...output.slice(-25), '#12 ERROR: process "/bin/sh -c install-tool" did not complete successfully: exit code: 22', '------', ' > [install 3/3] RUN install-tool:', '------', 'ERROR: failed to solve: exit code: 22', 'ERROR: target tool failed']);
  assert.deepEqual(logExcerpt(`\u001b[31mred\u001b[0m\n${output.join('\n')}\n`).split('\n'), output.slice(-30));
});

test('the job summary of a failed build names the tool, version and step, with the log excerpt', () => {
  assert.equal(buildFailureSummary(failure('java', '21.0.13+5')), [
    '## java 21.0.13+5: the `build` step failed',
    '',
    'Nothing was pushed. The **Failure issues** job of this run tracks it in the failure issue of java 21 (`tool-failure` label), and every run builds it again until it builds or is ignored. The end of the `build` step log:',
    '',
    '```text',
    downloadFailed('21.0.13+5'),
    '```',
    '',
  ].join('\n'));
});
