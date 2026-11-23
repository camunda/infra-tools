// Publishing a release (scripts/index.mjs release), against the fake registry and a fake GitHub.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { publishRelease } from '../lib/publish-release.mjs';
import { Registry } from '../lib/registry.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';
import { catalogEntry } from './catalog-entry.mjs';
import { FakeRegistry, TOKEN } from './fake-registry.mjs';

const mavenDefinition = { source: { datasource: 'maven' }, publish: { lines: { 3.9: { versions: ['3.9.16'], revisions: { '3.9.16': 2 } } } }, install: { addToPath: 'bin' } };
// The release commit: a draft release has no tag yet, so its files exist only at this commit.
const COMMIT = '1279cdf9dd25cff3b284407d39f131ae50a2e546';
const FILES = {
  'tools/maven/tool.json': mavenDefinition,
  'published/maven.json': [catalogEntry(parseToolDefinition('maven', mavenDefinition), '3.9.16', 2, '3.9')],
};

// GitHub as publishRelease uses it, with the files at ref, recording its writes in calls with whether the index was pushed by
// then (indexed). fail: the call that fails ('files', 'notes' or 'upload').
function fakeGitHub({ ref: filesRef = COMMIT, fail } = {}) {
  const calls = [];
  const indexed = () => fake.manifest('0.1.0-tools') !== undefined;
  const failing = (call) => {
    if (call === fail) throw new Error(`${call} failed`);
  };
  return {
    calls,
    toolNames: async (ref) => (ref === filesRef ? ['maven'] : []),
    file: async (path, ref) => {
      failing('files');
      return ref === filesRef ? (FILES[path] ?? null) : null;
    },
    updateRelease: async (id, fields) => {
      if (fields.body) failing('notes');
      calls.push({ id, ...fields, indexed: indexed() });
    },
    uploadToolsJson: async (release, content) => {
      failing('upload');
      calls.push({ upload: release.tag_name, release: JSON.parse(content).release, indexed: indexed() });
    },
  };
}

const draft = { id: 7, tag_name: '0.1.0', target_commitish: COMMIT, body: '## Features\n\n* maven', draft: true };

let fake;
let registry;
beforeEach(async () => {
  await fake?.stop();
  fake = new FakeRegistry();
  await fake.start();
  registry = new Registry(fake.repository, { token: TOKEN, scheme: 'http' });
  fake.addToolImage('maven-3.9.16-r2', { 'linux/amd64': Buffer.from('maven amd64'), 'linux/arm64': Buffer.from('maven arm64') });
});
after(() => fake.stop());

test('a draft release is published from its commit: index pushed, then notes and tools.json, then the draft published as latest', async () => {
  const github = fakeGitHub();
  await publishRelease(draft, { registry, repository: 'camunda/infra-tools', github });
  assert.deepEqual(fake.indexEntries('0.1.0-tools').map((e) => `${e.platform} ${e.tag}`).sort(), ['linux/amd64 maven-3.9.16-r2', 'linux/arm64 maven-3.9.16-r2']);
  const [notes, upload, publish] = github.calls;
  assert.equal(github.calls.length, 3);
  assert.equal(notes.id, 7);
  // An update of a draft without its tag name would reset it to untagged-<hash>.
  assert.equal(notes.tag_name, '0.1.0');
  assert.equal(notes.target_commitish, COMMIT);
  assert.equal(notes.indexed, true);
  assert.ok(notes.body.startsWith('## Features\n\n* maven\n\n'));
  assert.match(notes.body, /## Tools/);
  assert.deepEqual(upload, { upload: '0.1.0', release: '0.1.0', indexed: true });
  assert.deepEqual(publish, { id: 7, tag_name: '0.1.0', target_commitish: COMMIT, draft: false, make_latest: 'true', indexed: true });
});

for (const fail of ['files', 'index', 'notes', 'upload']) {
  test(`a failure of the ${fail} step leaves the release a draft`, async () => {
    const github = fakeGitHub({ fail });
    // The index push fails on a registry that refuses the token.
    const target = fail === 'index' ? new Registry(fake.repository, { token: 'wrong', scheme: 'http' }) : registry;
    await assert.rejects(publishRelease(draft, { registry: target, repository: 'camunda/infra-tools', github }));
    assert.equal(github.calls.some((c) => c.draft === false), false);
  });
}

test('a draft that lost its tag name fails before anything is pushed or changed, with the command that restores it', async () => {
  const github = fakeGitHub();
  const broken = { ...draft, name: 'v0.1.0', tag_name: 'untagged-4f1cdd3a73e23735f2b7' };
  await assert.rejects(publishRelease(broken, { registry, repository: 'camunda/infra-tools', github }), /lost its tag name .*-f tag_name=<X\.Y\.Z> -f target_commitish=1279cdf/);
  assert.deepEqual(github.calls, []);
  assert.equal(fake.manifest('0.1.0-tools'), undefined);
});

test('a published release without tools.json gets it from its tag and is left published as it was', async () => {
  // A draft published by hand before its publication: its tag exists, and its target may be a branch that moved since.
  const github = fakeGitHub({ ref: '0.1.0' });
  await publishRelease({ ...draft, draft: false, target_commitish: 'main' }, { registry, repository: 'camunda/infra-tools', github });
  assert.equal(fake.indexEntries('0.1.0-tools').length, 2);
  assert.deepEqual(
    github.calls.map((c) => Object.keys(c).sort().join(',')),
    ['body,id,indexed', 'indexed,release,upload'],
  );
});
