import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPullRequest } from '../lib/pull-request.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';

const now = Date.parse('2026-10-14T12:00:00Z');
const old = '2026-10-01T00:00:00Z';

const java = (lines) => parseToolDefinition('java', {
  source: { datasource: 'java-version' },
  publish: { lines },
  install: { cacheFolder: 'Java_Temurin-Hotspot_jdk', archFolders: { amd64: 'x64', arm64: 'aarch64' } },
});
const maven = (lines) => parseToolDefinition('maven', { source: { datasource: 'maven' }, publish: { lines }, install: { addToPath: 'bin' } });

// Renovate getPkgReleases stand-in, per tool datasource; records which datasources were looked up.
const upstreamOf = (versionsByDatasource, lookedUp = []) => async ({ datasource }) => {
  lookedUp.push(datasource);
  return { releases: versionsByDatasource[datasource].map((version) => ({ version, releaseTimestamp: old })) };
};
const tagsIn = (...tags) => async (tag) => tags.includes(tag);

const check = (options) => checkPullRequest({ baseTools: {}, catalogs: {}, previousIndex: [], toolImageLayers: async () => ({}), now, repository: 'camunda/infra-tools', ...options });
const builds = (result) => result.builds.map((b) => `${b.tool} ${b.version} ${b.tag} (${b.reason})`);

test('a PR changing a tool builds its planned versions and its latest published version per major; other tools are not planned', async () => {
  const lookedUp = [];
  const result = await check({
    tools: [java({ 17: { from: '17.0.17' }, 21: { from: '21.0.12' } }), maven({ '*': { from: '3.9.16' } })],
    changedFiles: ['tools/java/install.sh'],
    lookup: upstreamOf({ 'java-version': ['17.0.17+10', '17.0.18+8', '21.0.12+8', '21.0.13+5', '21.0.14+2'] }, lookedUp),
    tagExists: tagsIn('java-17.0.17-10-r1', 'java-17.0.18-8-r1', 'java-21.0.12-8-r1', 'java-21.0.13-5-r1'),
  });
  assert.deepEqual(builds(result), [
    'java 17.0.18+8 java-17.0.18-8-r1 (latest published of major 17)',
    'java 21.0.13+5 java-21.0.13-5-r1 (latest published of major 21)',
    'java 21.0.14+2 java-21.0.14-2-r1 (planned: new)',
  ]);
  assert.deepEqual(lookedUp, ['java-version']);
});

test('a PR changing the shared build plans every tool; a PR changing neither plans none', async () => {
  const tools = [java({ 21: { from: '21.0.12' } }), maven({ '*': { from: '3.9.16' } })];
  const lookup = upstreamOf({ 'java-version': ['21.0.12+8'], maven: ['3.9.16'] });
  const tagExists = tagsIn('java-21.0.12-8-r1', 'maven-3.9.16-r1');
  for (const file of ['build/tool.Dockerfile', 'build/test.Dockerfile', 'scripts/lib/build.mjs']) {
    assert.deepEqual(builds(await check({ tools, changedFiles: [file], lookup, tagExists })), [
      'java 21.0.12+8 java-21.0.12-8-r1 (latest published of major 21)',
      'maven 3.9.16 maven-3.9.16-r1 (latest published of major 3)',
    ], file);
  }
  const lookedUp = [];
  const result = await check({ tools, changedFiles: ['README.md', 'scripts/lib/plan.mjs'], lookup: upstreamOf({}, lookedUp), tagExists });
  assert.deepEqual(result.builds, []);
  assert.deepEqual(lookedUp, []);
});

test('a PR changing the build files of published versions without a revision bump warns; a bump plans them again', async () => {
  const lines = { 3.9: { versions: ['3.9.15', '3.9.16'], revisions: { '3.9.16': 2 } } };
  const tagExists = tagsIn('maven-3.9.15-r1', 'maven-3.9.16-r2');
  const run = (tool, changedFiles, baseTools = { maven: maven(lines) }) => check({
    tools: [tool], baseTools, changedFiles, lookup: upstreamOf({ maven: ['3.9.15', '3.9.16'] }), tagExists,
  });
  const warning = (files) => `maven: ${files} changed, but these published versions keep their tool image unless their revision is bumped: 3.9.15 (maven-3.9.15-r1), 3.9.16 (maven-3.9.16-r2)`;

  assert.deepEqual((await run(maven(lines), ['tools/maven/install.sh', 'tools/maven/test.sh'])).warnings, [warning('tools/maven/install.sh')]);
  assert.deepEqual((await run(maven(lines), ['build/tool-dir'])).warnings, [warning('build/tool-dir')]);
  const relocated = parseToolDefinition('maven', { source: { datasource: 'maven' }, publish: { lines }, install: { addToPath: 'bin', cacheFolder: 'Maven' } });
  assert.deepEqual((await run(relocated, ['tools/maven/tool.json'])).warnings, [warning('tools/maven/tool.json (install)')]);
  assert.deepEqual((await run(maven(lines), ['tools/maven/tool.json'], {})).warnings, [warning('tools/maven/tool.json (install)')]);

  // Test files and the publish block do not change tool images.
  for (const file of ['tools/maven/test.sh', 'build/test.Dockerfile', 'tools/maven/tool.json']) {
    assert.deepEqual((await run(maven(lines), [file])).warnings, [], file);
  }

  const bumped = await run(maven({ 3.9: { versions: ['3.9.15', '3.9.16'], revisions: { '3.9.15': 2, '3.9.16': 3 } } }), ['tools/maven/install.sh']);
  assert.deepEqual(bumped.warnings, []);
  assert.deepEqual(builds(bumped), ['maven 3.9.15 maven-3.9.15-r2 (planned: revision 2)', 'maven 3.9.16 maven-3.9.16-r3 (planned: revision 3)']);
});
