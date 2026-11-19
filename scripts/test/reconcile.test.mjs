import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { checkCatalogTags, commitMessage, recordRun } from '../lib/reconcile.mjs';
import { Registry } from '../lib/registry.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';
import { catalogEntry } from './catalog-entry.mjs';
import { FakeRegistry, TOKEN } from './fake-registry.mjs';

const node = parseToolDefinition('node', {
  source: { datasource: 'node-version' },
  publish: { lines: { 24: { retired: ['24.19.0'] }, 26: { from: '26.11.1', revisions: { '26.11.1': 2 } } } },
});
const maven = parseToolDefinition('maven', { source: { datasource: 'maven' }, publish: { lines: { 3.9: { from: '3.9.16' } } }, install: { addToPath: 'bin' } });
const now = '2026-10-14T00:00:00.000Z';

const fake = new FakeRegistry();
before(() => fake.start());
after(() => fake.stop());

const layers = { 'linux/amd64': Buffer.from('amd64 layer'), 'linux/arm64': Buffer.from('arm64 layer') };
// Pushes a tool image built from a commit, and returns that commit.
const pushed = (tag, commit = `${tag}-commit`) => {
  fake.addToolImage(tag, layers, { 'org.opencontainers.image.revision': commit });
  return commit;
};
const registry = () => new Registry(fake.repository, { token: TOKEN, scheme: 'http' });

test('a run records every version whose tool image exists and that the catalog lacks, and nothing else', async () => {
  const catalogs = { node: [catalogEntry(node, '24.19.0', 1, '24'), catalogEntry(node, '26.11.1', 1, '26')], maven: [catalogEntry(maven, '3.9.16', 1, '3.9')] };
  // The plans after the builds: 26.11.1 r2 and 26.11.2 were pushed by this run (or pushed by an earlier run that failed to
  // record them), 26.11.3 failed to build.
  const plans = {
    node: {
      tool: 'node',
      upstream: 'https://github.com/nodejs/node',
      versions: [
        { version: '24.19.0', decision: 'skip', reason: 'retired' },
        { version: '26.11.1', decision: 'skip', reason: 'published' },
        { version: '26.11.2', decision: 'skip', reason: 'published' },
        { version: '26.11.3', decision: 'publish', reason: 'new', line: '26', revision: 1, tag: 'node-26.11.3-r1' },
      ],
    },
    maven: { tool: 'maven', upstream: null, versions: [{ version: '3.9.16', decision: 'skip', reason: 'published' }] },
  };
  const commits = [pushed('node-26.11.1-r2'), pushed('node-26.11.2-r1')];
  const readToolDefinitionAt = async (name, commit) => (name === 'node' && commits.includes(commit) ? node : assert.fail(`${name} at ${commit}`));
  const run = await recordRun({ tools: [maven, node], catalogs, plans, now, registry: registry(), readToolDefinitionAt });
  assert.deepEqual(run.unreleased, [
    { tool: 'node', version: '26.11.1', line: '26', revision: 2, tag: 'node-26.11.1-r2', upstream: 'https://github.com/nodejs/node' },
    { tool: 'node', version: '26.11.2', line: '26', revision: 1, tag: 'node-26.11.2-r1', upstream: 'https://github.com/nodejs/node' },
  ]);
  assert.deepEqual(run.catalogs.node.map((e) => [e.version, e.revision, e.retired ?? false]), [['24.19.0', 1, true], ['26.11.1', 2, false], ['26.11.2', 1, false]]);
  assert.deepEqual(run.catalogs.maven, catalogs.maven);
  assert.deepEqual(run.changes, [
    { type: 'fix', tool: 'node', text: 'republish 26.11.1 (r2)' },
    { type: 'feat', tool: 'node', text: 'publish 26.11.2' },
    { type: 'feat', breaking: true, tool: 'node', text: 'retire 24.19.0' },
  ]);

  const again = await recordRun({ tools: [maven, node], catalogs: run.catalogs, plans, now, registry: registry(), readToolDefinitionAt });
  assert.deepEqual([again.unreleased, again.changes], [[], []], 'a second run records nothing');
});

// A run pushes 26.13.1, then is superseded by an install layout change (cacheFolder) that does not bump its revision: the run
// on the new tool definition finds its tag, but the action installs it from the tool cache path tool.json gives now, which
// its tool image does not hold.
test('a version whose tool image was built with another install block fails the run until a revision bump', async () => {
  const relaid = parseToolDefinition('node', { source: { datasource: 'node-version' }, publish: { lines: { 26: { from: '26.13.1' } } }, install: { cacheFolder: 'Node' } });
  const earlier = pushed('node-26.13.1-r1');
  const current = pushed('node-26.13.2-r1');
  const definitions = { [earlier]: node, [current]: relaid };
  const readToolDefinitionAt = async (name, commit) => definitions[commit];
  const plans = (...versions) => ({ node: { tool: 'node', upstream: null, versions: versions.map((version) => ({ version, decision: 'skip', reason: 'published' })) } });
  const run = await recordRun({ tools: [relaid], catalogs: {}, plans: plans('26.13.2'), now, registry: registry(), readToolDefinitionAt });
  assert.deepEqual(run.catalogs.node.map((e) => [e.version, e.cacheFolder]), [['26.13.2', 'Node']]);

  await assert.rejects(recordRun({ tools: [relaid], catalogs: {}, plans: plans('26.13.1', '26.13.2'), now, registry: registry(), readToolDefinitionAt }), {
    message: `node-26.13.1-r1: its tool image was built with another install block (tools/node/tool.json at ${earlier}) and does not hold the tool cache path the action installs from; bump the revision of node 26.13.1 in tools/node/tool.json to build it again`,
  });
  const unreadable = async (name, commit) => {
    throw new Error(`fatal: invalid object name '${commit}'`);
  };
  await assert.rejects(recordRun({ tools: [relaid], catalogs: {}, plans: plans('26.13.2'), now, registry: registry(), readToolDefinitionAt: unreadable }), {
    message: `fatal: invalid object name '${current}'`,
  });
});

// release-please reads each nested commit block as one more commit (googleapis/release-please src/commit.ts, splitMessages):
// unlike blank-line-separated entries, a breaking entry (feat(node)!) is kept apart.
test('the record commit has one changelog entry per change: the first as subject, the others as nested commits', () => {
  const change = (type, text, breaking = false) => ({ type, tool: 'node', text, breaking });
  assert.equal(commitMessage([change('fix', 'republish 26.11.1 (r2)'), change('feat', 'publish 26.11.2'), change('feat', 'retire 24.19.0', true)]), [
    'fix(node): republish 26.11.1 (r2)',
    '',
    'BEGIN_NESTED_COMMIT',
    'feat(node): publish 26.11.2',
    'END_NESTED_COMMIT',
    'BEGIN_NESTED_COMMIT',
    'feat(node)!: retire 24.19.0',
    'END_NESTED_COMMIT',
    '',
  ].join('\n'));
  assert.equal(commitMessage([change('feat', 'publish 26.11.2')]), 'feat(node): publish 26.11.2\n');
  assert.equal(commitMessage([]), '', 'no change, no commit');
});

test('a catalog version whose tag is gone fails the run instead of being published again', async () => {
  const catalogs = { node: [{ ...catalogEntry(node, '24.19.0', 1, '24'), retired: true }, catalogEntry(node, '26.11.1', 1, '26')], maven: [catalogEntry(maven, '3.9.16', 1, '3.9')] };
  const tags = new Set(['node-26.11.1-r1', 'maven-3.9.16-r1']);
  await assert.rejects(checkCatalogTags({ catalogs, tagExists: async (tag) => tags.has(tag) }), {
    message: 'published versions lost their tag; published tool images never change:\nnode 24.19.0: tag node-24.19.0-r1 not found',
  });
  tags.add('node-24.19.0-r1');
  await checkCatalogTags({ catalogs, tagExists: async (tag) => tags.has(tag) });
  await assert.rejects(checkCatalogTags({ catalogs, tagExists: async () => { throw new Error('HEAD ghcr.io: HTTP 503'); } }), { message: 'HEAD ghcr.io: HTTP 503' });
});
