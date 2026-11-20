import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPullRequest, previewComment, previewCommentUpdate } from '../lib/pull-request.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';
import { catalogEntry } from './catalog-entry.mjs';

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
const tagsIn = (...tags) => tags;

const check = ({ plan, ...options }) => checkPullRequest({
  baseTools: {},
  catalogs: {},
  previousRelease: { index: [] },
  toolImageLayers: async (tag) => Object.fromEntries(['linux/amd64', 'linux/arm64'].map((p) => [p, { digest: `sha256:${tag}-${p}`, size: 100, mediaType: null }])),
  repository: 'camunda/infra-tools',
  ...options,
  plan: { now, platformsOf: async () => ['linux/amd64', 'linux/arm64'], ...plan },
});
const builds = (result) => result.builds.map((b) => `${b.tool} ${b.version} ${b.tag} (${b.reason})`);

test('a PR changing a tool builds its planned versions and its latest published version per major; other tools are not planned', async () => {
  const lookedUp = [];
  const result = await check({
    tools: [java({ 17: { from: '17.0.17' }, 21: { from: '21.0.12' } }), maven({ '*': { from: '3.9.16' } })],
    changedFiles: ['tools/java/install.sh'],
    catalogs: { java: [['17.0.17+10', '17'], ['17.0.18+8', '17'], ['21.0.12+8', '21'], ['21.0.13+5', '21']].map(([v, line]) => catalogEntry(java({ 21: { from: '21.0.12' } }), v, 1, line)) },
    plan: {
      lookup: upstreamOf({ 'java-version': ['17.0.17+10', '17.0.18+8', '21.0.12+8', '21.0.13+5', '21.0.14+2'] }, lookedUp),
      tags: tagsIn('java-17.0.17-10-r1', 'java-17.0.18-8-r1', 'java-21.0.12-8-r1', 'java-21.0.13-5-r1'),
    },
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
  const tags = tagsIn('java-21.0.12-8-r1', 'maven-3.9.16-r1');
  const catalogs = { java: [catalogEntry(tools[0], '21.0.12+8', 1, '21')], maven: [catalogEntry(tools[1], '3.9.16', 1, '*')] };
  for (const file of ['build/tool.Dockerfile', 'build/test.Dockerfile', 'scripts/lib/build.mjs']) {
    assert.deepEqual(builds(await check({ tools, changedFiles: [file], catalogs, plan: { lookup, tags } })), [
      'java 21.0.12+8 java-21.0.12-8-r1 (latest published of major 21)',
      'maven 3.9.16 maven-3.9.16-r1 (latest published of major 3)',
    ], file);
  }
  const lookedUp = [];
  const result = await check({ tools, changedFiles: ['README.md', 'scripts/lib/plan.mjs'], plan: { lookup: upstreamOf({}, lookedUp), tags } });
  assert.deepEqual(result.builds, []);
  assert.deepEqual(lookedUp, []);
});

test('a PR changing the build files of published versions without a revision bump warns; a bump plans them again', async () => {
  const lines = { 3.9: { versions: ['3.9.15', '3.9.16'], revisions: { '3.9.16': 2 } } };
  const tags = tagsIn('maven-3.9.15-r1', 'maven-3.9.16-r2');
  const catalogs = { maven: [catalogEntry(maven(lines), '3.9.15', 1, '3.9'), catalogEntry(maven(lines), '3.9.16', 2, '3.9')] };
  const run = (tool, changedFiles, baseTools = { maven: maven(lines) }) => check({
    tools: [tool], baseTools, changedFiles, catalogs, plan: { lookup: upstreamOf({ maven: ['3.9.15', '3.9.16'] }), tags },
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

test('a published version out of every line, even delisted upstream, still gets its warning and its latest-per-major dry run', async () => {
  // Line 17 was removed, and 17.0.18+8 is no longer listed upstream: consumers can still install it until it is retired.
  const tool = java({ 21: { from: '21.0.13' } });
  const catalogs = { java: [catalogEntry(tool, '17.0.18+8', 2, '17'), catalogEntry(tool, '21.0.13+5', 1, '21')] };
  const result = await check({
    tools: [tool],
    changedFiles: ['tools/java/install.sh'],
    catalogs,
    plan: { lookup: upstreamOf({ 'java-version': ['21.0.13+5', '21.0.14+2'] }), tags: tagsIn('java-21.0.13-5-r1') },
  });
  assert.deepEqual(result.warnings, [
    'java: tools/java/install.sh changed, but these published versions keep their tool image unless their revision is bumped: 17.0.18+8 (java-17.0.18-8-r2), 21.0.13+5 (java-21.0.13-5-r1)',
  ]);
  assert.deepEqual(builds(result), [
    'java 17.0.18+8 java-17.0.18-8-r2 (latest published of major 17)',
    'java 21.0.13+5 java-21.0.13-5-r1 (latest published of major 21)',
    'java 21.0.14+2 java-21.0.14-2-r1 (planned: new)',
  ]);

  // A version the PR retires is neither warned about nor built.
  const retiring = await check({
    tools: [java({ 17: { retired: ['17.0.18+8'] }, 21: { from: '21.0.13' } })],
    changedFiles: ['tools/java/install.sh'],
    catalogs,
    plan: { lookup: upstreamOf({ 'java-version': ['21.0.13+5'] }), tags: tagsIn('java-21.0.13-5-r1') },
  });
  assert.deepEqual(builds(retiring), ['java 21.0.13+5 java-21.0.13-5-r1 (latest published of major 21)']);
  assert.match(retiring.warnings[0], /: 21\.0\.13\+5 \(java-21\.0\.13-5-r1\)$/);
});

test('a version the PR restores gets its warning and its latest-per-major dry run, like the release notes preview', async () => {
  // 17.0.18+8 is retired in the catalog; the PR removes it from its line's retired, which the reconciler records as a restore.
  const base = java({ 17: { retired: ['17.0.18+8'] }, 21: { from: '21.0.13' } });
  const catalogs = { java: [{ ...catalogEntry(base, '17.0.18+8', 1, '17'), retired: true }, catalogEntry(base, '21.0.13+5', 1, '21')] };
  const result = await check({
    tools: [java({ 21: { from: '21.0.13' } })],
    baseTools: { java: base },
    changedFiles: ['tools/java/tool.json', 'tools/java/install.sh'],
    catalogs,
    plan: { lookup: upstreamOf({ 'java-version': ['21.0.13+5'] }), tags: tagsIn('java-17.0.18-8-r1', 'java-21.0.13-5-r1') },
  });
  assert.deepEqual(result.warnings, [
    'java: tools/java/install.sh changed, but these published versions keep their tool image unless their revision is bumped: 17.0.18+8 (java-17.0.18-8-r1), 21.0.13+5 (java-21.0.13-5-r1)',
  ]);
  assert.deepEqual(builds(result), [
    'java 17.0.18+8 java-17.0.18-8-r1 (latest published of major 17)',
    'java 21.0.13+5 java-21.0.13-5-r1 (latest published of major 21)',
  ]);
  assert.match(result.notes, /17\.0\.18\+8/);
});

// Index entries of one published tool version, as the previous release's index holds them.
const indexed = (tool, version, revision, line) => ['linux/amd64', 'linux/arm64'].map((platform) => ({
  platform,
  tool: tool.name,
  version,
  line,
  folderVersion: version.replaceAll('+', '-'),
  revision,
  tag: `${tool.name}-${version.replaceAll('+', '-')}-r${revision}`,
  cacheFolder: tool.install.cacheFolder,
  archFolder: tool.install.archFolders[platform.split('/')[1]],
  addToPath: tool.install.addToPath,
  digest: `sha256:${tool.name}-${version}-r${revision}-${platform}`,
  size: 100,
  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
}));

test('the release notes preview shows what the next release adds, replaces and retires once the planned versions are published', async () => {
  const before = { java: java({ 17: { from: '17.0.18' }, 21: { from: '21.0.12' } }), maven: maven({ '*': { from: '3.9.15' } }) };
  const head = { java: java({ 17: { retired: 'all' }, 21: { from: '21.0.12', revisions: { '21.0.12+8': 2 } } }), maven: before.maven };
  const fetched = [];
  const result = await check({
    tools: [head.java, head.maven],
    baseTools: before,
    changedFiles: ['tools/java/tool.json'],
    plan: {
      lookup: upstreamOf({ 'java-version': ['17.0.18+8', '21.0.12+8', '21.0.13+5'] }),
      tags: tagsIn('java-17.0.18-8-r1', 'java-21.0.12-8-r1'),
    },
    previousRelease: {
      version: '1.2.0',
      index: [
        ...indexed(before.java, '17.0.18+8', 1, '17'),
        ...indexed(before.java, '21.0.12+8', 1, '21'),
        ...indexed(before.maven, '3.9.15', 1, '*'),
      ],
    },
    // maven 3.9.16 was published after release 1.2.0: the next release adds it too.
    catalogs: {
      java: [catalogEntry(before.java, '17.0.18+8', 1, '17'), catalogEntry(before.java, '21.0.12+8', 1, '21')],
      maven: [catalogEntry(before.maven, '3.9.15', 1, '*'), catalogEntry(before.maven, '3.9.16', 1, '*')],
    },
    toolImageLayers: async (tag) => {
      fetched.push(tag);
      return Object.fromEntries(['linux/amd64', 'linux/arm64'].map((p) => [p, { digest: `sha256:${tag}-${p}`, size: 100, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }]));
    },
  });
  const release = (tag) => `[${tag}](https://github.com/camunda/infra-tools/releases/tag/${tag})`;
  assert.equal(result.notes, [
    'Index: next release, previous: `1.2.0-tools`',
    '',
    '### ➕ Added',
    '',
    '| Tool | Version | Line | Platforms | Tool release |',
    '| --- | --- | --- | --- | --- |',
    `| java | 21.0.13+5 | 21 | amd64, arm64 | ${release('java-21.0.13-5-r1')} |`,
    `| maven | 3.9.16 | * | amd64, arm64 | ${release('maven-3.9.16-r1')} |`,
    '',
    '### 🔁 Replaced',
    '',
    '| Tool | Version | Line | Revision | Tool release |',
    '| --- | --- | --- | --- | --- |',
    `| java | 21.0.12+8 | 21 | r1 → r2 | ${release('java-21.0.12-8-r2')} |`,
    '',
    '### ➖ Retired',
    '',
    '| Tool | Version | Line | Tool release |',
    '| --- | --- | --- | --- |',
    `| java | 17.0.18+8 | 17 | ${release('java-17.0.18-8-r1')} |`,
    '',
  ].join('\n'));
  // Only tool images missing from the previous index are read from the registry.
  assert.deepEqual(fetched, ['maven-3.9.16-r1']);
});

test('the dry run and the release notes preview skip a version whose fix PR was closed without merge, as the reconciler does', async () => {
  const result = await check({
    tools: [java({ 21: { from: '21.0.12' } })],
    changedFiles: ['tools/java/install.sh'],
    fixPrs: { java: { '21.0.13+5': { number: 7, state: 'closed' }, '21.0.14+2': { number: 8, state: 'open' } } },
    plan: { lookup: upstreamOf({ 'java-version': ['21.0.13+5', '21.0.14+2'] }), tags: tagsIn() },
  });
  assert.deepEqual(builds(result), ['java 21.0.14+2 java-21.0.14-2-r1 (planned: new, retried: fix PR #8)']);
  assert.doesNotMatch(result.notes, /21\.0\.13\+5/);
  assert.match(result.notes, /21\.0\.14\+2/);
});

test('a manual revision the PR sets must be above the highest published one, which the reconciler can have raised (D62)', async () => {
  // r2 added linux/arm64 to r1 without a revision in tool.json.
  const base = maven({ 3.9: { versions: ['3.9.16'] } });
  const run = (revisions, baseTools = { maven: base }) => check({
    tools: [maven({ 3.9: { versions: ['3.9.16'], revisions } })],
    baseTools,
    changedFiles: ['tools/maven/tool.json', 'tools/maven/install.sh'],
    plan: { lookup: upstreamOf({ maven: ['3.9.16'] }), tags: tagsIn('maven-3.9.16-r1', 'maven-3.9.16-r2') },
  });
  const stale = await run({ '3.9.16': 2 });
  assert.deepEqual(stale.errors, [
    'maven 3.9.16: revision 2 is not above r2, its highest published revision, so nothing would be built; set it to 3 or more in tools/maven/tool.json',
  ]);
  assert.match(previewComment(stale), /> \[!CAUTION\]\n> maven 3\.9\.16: revision 2 is not above r2/);
  const bumped = await run({ '3.9.16': 3 });
  assert.deepEqual(bumped.errors, []);
  assert.deepEqual(builds(bumped), ['maven 3.9.16 maven-3.9.16-r3 (planned: revision 3)']);
  // A revision the PR does not change is not checked again.
  assert.deepEqual((await run({ '3.9.16': 2 }, { maven: maven({ 3.9: { versions: ['3.9.16'], revisions: { '3.9.16': 2 } } }) })).errors, []);
});

test('a platform upstream adds is built alone in dry run, and the next release replaces the version with it (D62)', async () => {
  const tool = parseToolDefinition('java', {
    source: { datasource: 'java-version', packageName: 'java-jdk?architecture={arch}' },
    publish: { lines: { 21: { from: '21.0.13' } } },
    install: { cacheFolder: 'Java_Temurin-Hotspot_jdk', archFolders: { amd64: 'x64', arm64: 'aarch64' } },
  });
  // Upstream has 21.0.13+5 on both platforms now.
  const lookup = async () => ({ releases: [{ version: '21.0.13+5', releaseTimestamp: old }] });
  const amd64 = (entries) => entries.filter((e) => e.platform === 'linux/amd64');
  const result = await check({
    tools: [tool],
    changedFiles: ['tools/java/install.sh'],
    catalogs: { java: [{ ...catalogEntry(tool, '21.0.13+5', 1, '21'), platforms: ['linux/amd64'] }] },
    plan: { lookup, tags: tagsIn('java-21.0.13-5-r1'), platformsOf: async () => ['linux/amd64'] },
    previousRelease: { version: '1.2.0', index: amd64(indexed(tool, '21.0.13+5', 1, '21')) },
    toolImageLayers: async (tag) => ({ 'linux/amd64': { digest: `sha256:${tag}-linux/amd64`, size: 100, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' } }),
  });
  assert.deepEqual(result.builds.map((b) => `${b.tag} ${b.platforms} (${b.reason})`), ['java-21.0.13-5-r2 linux/arm64 (planned: adds linux/arm64 to java-21.0.13-5-r1)']);
  assert.match(result.notes, /\| java \| 21\.0\.13\+5 \| 21 \| r1 → r2 \|/);
});

test('a PR changing no tool has no release notes preview', async () => {
  const result = await check({ tools: [maven({ '*': { from: '3.9.16' } })], changedFiles: ['README.md'], plan: { lookup: upstreamOf({}), tags: tagsIn() } });
  assert.equal(result.notes, null);
});

// Issue comments of a PR, as the GitHub REST API lists them.
const comment = (id, login, body) => ({ id, user: { login }, body });

test('the release notes preview comment is created once, then updated on each push', async () => {
  const preview = previewComment({ builds: [], warnings: [], notes: 'Index: next release' });
  assert.deepEqual(previewCommentUpdate([comment(1, 'someone', 'LGTM')], preview), { body: preview });
  const comments = [comment(1, 'someone', preview), comment(2, 'github-actions[bot]', 'other'), comment(3, 'github-actions[bot]', preview)];
  assert.deepEqual(previewCommentUpdate(comments, 'new preview'), { id: 3, body: 'new preview' });
});

test('a push that no longer changes tools updates the release notes preview comment to say so, and posts none without one', async () => {
  assert.equal(previewComment({ builds: [], warnings: [], notes: null }), null);
  assert.equal(previewCommentUpdate([comment(1, 'someone', 'LGTM')], null), null);
  const old = previewComment({ builds: [], warnings: [], notes: 'Index: next release' });
  const update = previewCommentUpdate([comment(1, 'someone', 'LGTM'), comment(2, 'github-actions[bot]', old)], null);
  assert.equal(update.id, 2);
  assert.match(update.body, /^<!-- infra-tools: pull request checks -->\n## Next release preview\n\nNo tool changes/);
});
