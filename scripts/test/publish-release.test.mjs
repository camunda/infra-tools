// Publishing the release (scripts/release.mjs, ADR 0013), against fake registries and a fake GitHub.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { publishRelease } from '../lib/publish-release.mjs';
import { releaseFailureReport } from '../lib/release-failures.mjs';
import { Registry } from '../lib/registry.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';
import { catalogEntry } from './catalog-entry.mjs';
import { FakeRegistry, TOKEN } from './fake-registry.mjs';

const REPOSITORY = 'camunda/infra-tools';
const mavenDefinition = { source: { datasource: 'maven' }, publish: { lines: { 3.9: { versions: ['3.9.16'], revisions: { '3.9.16': 2 } } } }, install: { addToPath: 'bin' } };
// The release commit: a draft release has no tag yet, so its files exist only at this commit.
const COMMIT = '1279cdf9dd25cff3b284407d39f131ae50a2e546';
const FILES = {
  'tools/maven/tool.json': mavenDefinition,
  'published/maven.json': [catalogEntry(parseToolDefinition('maven', mavenDefinition), '3.9.16', 2, '3.9')],
};

const draft = { id: 7, name: '0.1.0', tag_name: '0.1.0', target_commitish: COMMIT, body: '## Features\n\n* maven', draft: true };
const published = { id: 3, name: '0.0.9', tag_name: '0.0.9', target_commitish: 'main', body: '', draft: false };

let ghcr;
let gar;
let registry;
let mirrors;
beforeEach(async () => {
  await Promise.all([ghcr, gar].filter(Boolean).map((f) => f.stop()));
  ghcr = new FakeRegistry();
  gar = new FakeRegistry({ name: 'ci-30-162810/infra-tools/camunda/infra-tools', user: 'oauth2accesstoken' });
  await Promise.all([ghcr.start(), gar.start()]);
  registry = new Registry(ghcr.repository, { token: TOKEN, scheme: 'http' });
  mirrors = [{ name: 'gar', registry: new Registry(gar.repository, { token: TOKEN, user: 'oauth2accesstoken', scheme: 'http', retryDelays: [0] }) }];
  ghcr.addToolImage('maven-3.9.16-r2', { 'linux/amd64': Buffer.from('maven amd64'), 'linux/arm64': Buffer.from('maven arm64') });
});
after(() => Promise.all([ghcr.stop(), gar.stop()]));

// GitHub as publishRelease uses it, holding releases and the draft's tools.json, with the files at the release commit; records
// its writes in calls with whether the index was on ghcr.io and on the mirror by then. fail: the call that fails ('files',
// 'list', 'notes', 'upload' or 'undraft'), until cleared.
function fakeGitHub(releases, { fail } = {}) {
  const state = () => ({ indexed: ghcr.manifest('0.1.0-tools') !== undefined, mirrored: gar.manifest('0.1.0-tools') !== undefined });
  const failing = (call) => {
    if (call === github.fail) throw new Error(`${call} failed`);
  };
  const github = {
    releases: structuredClone(releases),
    fail,
    calls: [],
    asset: null,
    listReleases: async () => {
      failing('list');
      return structuredClone(github.releases);
    },
    toolNames: async (ref) => (ref === COMMIT ? ['maven'] : []),
    file: async (path, ref) => {
      failing('files');
      return ref === COMMIT ? (FILES[path] ?? null) : null;
    },
    updateRelease: async (id, fields) => {
      failing(fields.draft === false ? 'undraft' : 'notes');
      github.calls.push({ id, ...fields, ...state() });
      Object.assign(
        github.releases.find((r) => r.id === id),
        fields,
      );
    },
    toolsJson: async () => github.asset,
    uploadToolsJson: async (release, content) => {
      failing('upload');
      github.asset = content;
      github.calls.push({ upload: release.id, release: JSON.parse(content).release, ...state() });
    },
  };
  return github;
}

const run = (github) => publishRelease({ registry, mirrors, repository: REPOSITORY, github });
const STEPS = ['release/drafts', 'release/index', 'release/mirror.gar', 'release/notes', 'release/undraft'];

test('without a draft, every release is published: nothing is pushed or changed, and every release failure issue closes', async () => {
  const github = fakeGitHub([published]);
  const requests = ghcr.requests.length;
  const outcome = await run(github);
  assert.deepEqual(outcome, { release: null, failures: [], resolve: ['release'] });
  assert.deepEqual(github.calls, []);
  assert.equal(ghcr.requests.length, requests);
  assert.deepEqual(gar.requests, []);
});

test('the draft is published from its commit: index on ghcr.io, then on every mirror, then notes and tools.json, then published as latest', async () => {
  const github = fakeGitHub([published, draft]);
  const outcome = await run(github);
  assert.deepEqual(outcome, { release: '0.1.0', failures: [], resolve: STEPS });
  assert.deepEqual(ghcr.indexEntries('0.1.0-tools').map((e) => `${e.platform} ${e.tag}`).sort(), ['linux/amd64 maven-3.9.16-r2', 'linux/arm64 maven-3.9.16-r2']);
  assert.equal(await mirrors[0].registry.digest('0.1.0-tools'), await registry.digest('0.1.0-tools'));
  const [notes, upload, undraft] = github.calls;
  assert.equal(github.calls.length, 3);
  // An update of a draft without its tag name and target would reset its tag name to untagged-<hash>.
  assert.deepEqual({ ...notes, body: undefined }, { id: 7, tag_name: '0.1.0', target_commitish: COMMIT, body: undefined, indexed: true, mirrored: true });
  assert.ok(notes.body.startsWith('## Features\n\n* maven\n\n'));
  assert.match(notes.body, /## Tools/);
  assert.deepEqual(upload, { upload: 7, release: '0.1.0', indexed: true, mirrored: true });
  assert.deepEqual(undraft, { id: 7, tag_name: '0.1.0', target_commitish: COMMIT, draft: false, make_latest: 'true', indexed: true, mirrored: true });
});

// Each failure: the failing call, the step it fails and its error; the writes a rerun still makes once it is gone.
const FAILURES = [
  { fail: 'files', step: 'index', error: 'files failed', rerun: ['notes', 'upload', 'undraft'] },
  { fail: 'mirror', step: 'mirror.gar', error: /PUT .*\/manifests\/0\.1\.0-tools: HTTP 500/, rerun: ['notes', 'upload', 'undraft'] },
  { fail: 'notes', step: 'notes', error: 'notes failed', rerun: ['notes', 'upload', 'undraft'] },
  { fail: 'upload', step: 'notes', error: 'upload failed', rerun: ['upload', 'undraft'] },
  { fail: 'undraft', step: 'undraft', error: 'undraft failed', rerun: ['undraft'] },
];
const writes = (calls) => calls.map((c) => (c.upload ? 'upload' : c.draft === false ? 'undraft' : 'notes'));

for (const { fail, step, error, rerun } of FAILURES) {
  test(`a failure of the ${step} step (${fail}) leaves the release a draft, is reported, and the next run completes the release`, async () => {
    const github = fakeGitHub([published, draft], { fail });
    if (fail === 'mirror') gar.rejected.add('0.1.0-tools');
    const outcome = await run(github);
    assert.equal(github.releases.find((r) => r.id === 7).draft, true);
    assert.deepEqual(outcome.resolve, STEPS.slice(0, STEPS.indexOf(`release/${step}`)));
    assert.equal(outcome.failures.length, 1);
    const [failure] = outcome.failures;
    assert.deepEqual(failure.key, { flow: 'release', step, release: '0.1.0' });
    assert.deepEqual(Object.keys(failure.errors), [step]);
    assert.match(failure.errors[step], typeof error === 'string' ? new RegExp(error) : error);
    assert.match(failure.context, /0\.1\.0/);
    assert.match(failure.state, /draft/);

    github.fail = undefined;
    gar.rejected.clear();
    github.calls = [];
    assert.deepEqual(await run(github), { release: '0.1.0', failures: [], resolve: STEPS });
    assert.deepEqual(writes(github.calls), rerun);
    assert.equal(github.releases.find((r) => r.id === 7).draft, false);
    assert.equal(await mirrors[0].registry.digest('0.1.0-tools'), await registry.digest('0.1.0-tools'));
  });
}

test('a second draft is a run failure: nothing is pushed or changed, and no step issue closes', async () => {
  const github = fakeGitHub([published, draft, { ...draft, id: 8, name: '0.2.0', tag_name: '0.2.0' }]);
  const outcome = await run(github);
  assert.deepEqual(outcome.resolve, []);
  assert.equal(outcome.release, null);
  const [failure] = outcome.failures;
  assert.deepEqual(failure.key, { flow: 'release', step: 'drafts' });
  assert.match(failure.errors.drafts, /^2 draft releases, 1 at most/);
  assert.deepEqual(github.calls, []);
  assert.equal(ghcr.manifest('0.1.0-tools'), undefined);
});

test('a mirror whose tag points to other content fails the release; the other mirrors still get the index', async () => {
  const other = new FakeRegistry({ name: 'other/camunda/infra-tools' });
  await other.start();
  try {
    other.addIndex('0.1.0-tools', []);
    const github = fakeGitHub([draft]);
    const both = [{ name: 'other', registry: new Registry(other.repository, { token: TOKEN, scheme: 'http' }) }, ...mirrors];
    const outcome = await publishRelease({ registry, mirrors: both, repository: REPOSITORY, github });
    assert.deepEqual(outcome.resolve, ['release/drafts', 'release/index', 'release/mirror.gar']);
    assert.deepEqual(outcome.failures.map((f) => f.key), [{ flow: 'release', step: 'mirror.other', release: '0.1.0' }]);
    assert.match(outcome.failures[0].errors['mirror.other'], /0\.1\.0-tools is sha256:\w+, not sha256:\w+ as on .*: delete the mirror's tag/);
    assert.equal(await mirrors[0].registry.digest('0.1.0-tools'), await registry.digest('0.1.0-tools'));
    assert.deepEqual(github.calls, []);
  } finally {
    await other.stop();
  }
});

test('a step that did not finish is reported without its error', () => {
  const report = releaseFailureReport({ step: 'mirror.gar', release: '0.1.0' });
  assert.deepEqual(report.key, { flow: 'release', step: 'mirror.gar', release: '0.1.0' });
  assert.deepEqual(report.errors, { 'mirror.gar': "No log: the mirror.gar step did not finish (its timeout); see the run's job log." });
});

test('each step is announced before it starts, with the failures so far, so one that never finishes can be reported', async () => {
  const github = fakeGitHub([draft]);
  const started = [];
  const both = [{ name: 'ecr', error: 'no token' }, ...mirrors];
  const onStep = async (step, release, failed) => started.push(`${step} ${release} [${failed.map((f) => f.key.step)}]`);
  await publishRelease({ registry, mirrors: both, repository: REPOSITORY, github, onStep });
  assert.deepEqual(started, ['drafts undefined []', 'index 0.1.0 []', 'mirror.ecr 0.1.0 []', 'mirror.gar 0.1.0 [mirror.ecr]']);
});

test('a release listing that keeps failing is a failure of the drafts step', async () => {
  const github = fakeGitHub([draft], { fail: 'list' });
  const outcome = await run(github);
  assert.deepEqual(outcome.resolve, []);
  assert.deepEqual(outcome.failures.map((f) => [f.key, f.errors]), [[{ flow: 'release', step: 'drafts' }, { drafts: 'list failed' }]]);
});

test('a mirror whose login failed fails its own step without any request; the other mirrors still get the index', async () => {
  const github = fakeGitHub([draft]);
  const both = [{ name: 'ecr', error: 'MIRROR_TOKEN_ECR is not set: the login step of mirror ecr failed, see its log' }, ...mirrors];
  const outcome = await publishRelease({ registry, mirrors: both, repository: REPOSITORY, github });
  assert.deepEqual(outcome.resolve, ['release/drafts', 'release/index', 'release/mirror.gar']);
  assert.deepEqual(outcome.failures.map((f) => [f.key.step, f.errors]), [['mirror.ecr', { 'mirror.ecr': 'MIRROR_TOKEN_ECR is not set: the login step of mirror ecr failed, see its log' }]]);
  assert.equal(await mirrors[0].registry.digest('0.1.0-tools'), await registry.digest('0.1.0-tools'));
});
