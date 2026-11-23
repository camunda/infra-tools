import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, latestIndexTag, latestPublishedRelease, previousRelease, releaseBody, releasedVersion, releaseNotes, toolsJson, unpublishedReleases } from '../lib/release.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';

const java = parseToolDefinition('java', {
  source: { datasource: 'java-version' },
  publish: { lines: { 17: { retired: 'all' }, 21: { from: '21.0.12' } } },
  install: { cacheFolder: 'Java_Temurin-Hotspot_jdk', archFolders: { amd64: 'x64', arm64: 'aarch64' } },
});
const maven = parseToolDefinition('maven', { source: { datasource: 'maven' }, publish: { lines: { '*': { from: '3.9.16' } } }, install: { addToPath: 'bin' } });

const catalogEntry = (tool, version, revision, extra = {}) => ({
  version,
  line: extra.line ?? '*',
  folderVersion: version.replaceAll('+', '-'),
  revision,
  tag: `${tool.name}-${version.replaceAll('+', '-')}-r${revision}`,
  ...tool.install,
  publishedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});
const layer = (digest) => ({ digest, size: 100, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' });
const layersOf = (tag) => ({ 'linux/amd64': layer(`sha256:${tag}-amd64`), 'linux/arm64': layer(`sha256:${tag}-arm64`) });

test('the index lists every catalog version per platform with its layer and tool cache layout', () => {
  const entries = buildIndex({
    tools: [java, maven],
    catalogs: { java: [catalogEntry(java, '21.0.12+8', 1, { line: '21' })], maven: [catalogEntry(maven, '3.9.16', 1)] },
    previousIndex: [],
    layers: { 'java-21.0.12-8-r1': layersOf('j'), 'maven-3.9.16-r1': layersOf('m') },
  });
  assert.deepEqual(entries[0], {
    platform: 'linux/amd64', tool: 'java', version: '21.0.12+8', line: '21', folderVersion: '21.0.12-8', revision: 1, tag: 'java-21.0.12-8-r1',
    cacheFolder: 'Java_Temurin-Hotspot_jdk', archFolder: 'x64', addToPath: null, ...layer('sha256:j-amd64'),
  });
  assert.deepEqual(entries.map((e) => `${e.tool} ${e.version} ${e.platform} ${e.archFolder} ${e.addToPath}`), [
    'java 21.0.12+8 linux/amd64 x64 null',
    'java 21.0.12+8 linux/arm64 aarch64 null',
    'maven 3.9.16 linux/amd64 x64 bin',
    'maven 3.9.16 linux/arm64 arm64 bin',
  ]);
});

test('the index keeps previous versions, takes new revisions and drops retired versions; older indexes are untouched', () => {
  const previousLayers = { 'java-17.0.18-8-r1': layersOf('p17'), 'java-21.0.12-8-r1': layersOf('p21'), 'maven-3.9.15-r1': layersOf('m15') };
  const previous = buildIndex({
    tools: [parseToolDefinition('java', { source: { datasource: 'java-version' }, publish: { lines: { 17: { from: '17.0.18' }, 21: { from: '21.0.12' } } } }), maven],
    catalogs: { java: [catalogEntry(java, '17.0.18+8', 1, { line: '17' }), catalogEntry(java, '21.0.12+8', 1, { line: '21' })], maven: [catalogEntry(maven, '3.9.15', 1)] },
    previousIndex: [],
    layers: previousLayers,
  });
  const before = structuredClone(previous);
  const entries = buildIndex({
    tools: [java, maven],
    catalogs: {
      java: [catalogEntry(java, '17.0.18+8', 1, { line: '17', retired: true }), catalogEntry(java, '21.0.12+8', 2, { line: '21' })],
      maven: [],
    },
    previousIndex: previous,
    layers: { 'java-21.0.12-8-r2': layersOf('n21') },
  });
  assert.deepEqual(entries.map((e) => `${e.tool} ${e.version} r${e.revision} ${e.digest}`), [
    'java 21.0.12+8 r2 sha256:n21-amd64',
    'java 21.0.12+8 r2 sha256:n21-arm64',
    'maven 3.9.15 r1 sha256:m15-amd64',
    'maven 3.9.15 r1 sha256:m15-arm64',
  ]);
  assert.deepEqual(previous, before);
});

test('a catalog version without its tag or a platform layer, or a changed layer without a higher revision, fails the index', () => {
  const build = (catalog, layers, previous = []) => () => buildIndex({ tools: [maven], catalogs: { maven: catalog }, previousIndex: previous, layers });
  assert.throws(build([catalogEntry(maven, '3.9.16', 1)], {}), { message: 'maven 3.9.16: tag maven-3.9.16-r1 not found' });
  assert.throws(build([catalogEntry(maven, '3.9.16', 1)], { 'maven-3.9.16-r1': { 'linux/amd64': layer('sha256:a') } }), {
    message: 'maven 3.9.16: tag maven-3.9.16-r1 has no layer for linux/arm64',
  });
  const previous = buildIndex({ tools: [maven], catalogs: { maven: [catalogEntry(maven, '3.9.16', 1)] }, previousIndex: [], layers: { 'maven-3.9.16-r1': layersOf('old') } });
  assert.throws(build([catalogEntry(maven, '3.9.16', 1)], { 'maven-3.9.16-r1': layersOf('new') }, previous), {
    message: 'maven 3.9.16 (linux/amd64): layer changed without a higher revision (r1 → r1)\nmaven 3.9.16 (linux/arm64): layer changed without a higher revision (r1 → r1)',
  });
});

const indexEntry = (tool, version, revision, platform, digest, line = '*') => ({
  platform, tool, version, line, revision, tag: `${tool}-${version.replaceAll('+', '-')}-r${revision}`, digest,
});
const both = (tool, version, revision, digest, line) => ['linux/amd64', 'linux/arm64'].map((p) => indexEntry(tool, version, revision, p, `${digest}-${p}`, line));

test('release notes list added, replaced and retired versions once per version, with tool release links (D20)', () => {
  const before = [...both('node', '24.19.0', 1, 'a', '24'), ...both('node', '26.11.1', 1, 'b', '26'), ...both('maven', '3.9.16', 1, 'm')];
  const after = [...both('node', '26.11.1', 2, 'c', '26'), ...both('node', '26.11.2', 1, 'd', '26'), ...both('maven', '3.9.16', 1, 'm')];
  assert.equal(releaseNotes({ version: '0.2.0', previousVersion: '0.1.0', repository: 'camunda/infra-tools', before, after }), [
    'Index: `0.2.0-tools`, previous: `0.1.0-tools`',
    '',
    '### ➕ Added',
    '',
    '| Tool | Version | Line | Platforms | Tool release |',
    '| --- | --- | --- | --- | --- |',
    '| node | 26.11.2 | 26 | amd64, arm64 | [node-26.11.2-r1](https://github.com/camunda/infra-tools/releases/tag/node-26.11.2-r1) |',
    '',
    '### 🔁 Replaced',
    '',
    '| Tool | Version | Line | Revision | Tool release |',
    '| --- | --- | --- | --- | --- |',
    '| node | 26.11.1 | 26 | r1 → r2 | [node-26.11.1-r2](https://github.com/camunda/infra-tools/releases/tag/node-26.11.1-r2) |',
    '',
    '### ➖ Retired',
    '',
    '| Tool | Version | Line | Tool release |',
    '| --- | --- | --- | --- |',
    '| node | 24.19.0 | 24 | [node-24.19.0-r1](https://github.com/camunda/infra-tools/releases/tag/node-24.19.0-r1) |',
    '',
  ].join('\n'));
});

test('the first release has no previous index, and a release without tool changes says so', () => {
  const after = both('maven', '3.9.16', 1, 'm');
  assert.match(releaseNotes({ version: '0.1.0', repository: 'camunda/infra-tools', before: [], after }), /^Index: `0\.1\.0-tools`\n\n### ➕ Added\n/);
  assert.equal(
    releaseNotes({ version: '0.1.1', previousVersion: '0.1.0', repository: 'camunda/infra-tools', before: after, after }),
    'Index: `0.1.1-tools`, previous: `0.1.0-tools`\n\nNo tool changes.\n',
  );
});

test('the previous release is the highest X.Y.Z index below the release, by number', () => {
  const tags = ['0.2.0-tools', '0.10.0-tools', '0.9.0-tools', 'tracer-tools', 'maven-3.9.16-r1', '1.0.0-tools'];
  assert.equal(previousRelease(tags, '0.11.0'), '0.10.0');
  assert.equal(previousRelease(tags, '0.10.0'), '0.9.0');
  assert.equal(previousRelease(tags, '0.2.0'), undefined);
});

test('the latest release is the version of the release-please manifest, none before the first release', () => {
  assert.equal(releasedVersion({ '.': '0.3.0' }), '0.3.0');
  // release-please needs a manifest: it starts at 0.0.0, which no release has.
  assert.equal(releasedVersion({ '.': '0.0.0' }), undefined);
  assert.equal(releasedVersion(null), undefined);
});

test('the latest published release is the manifest version once its index is pushed, the release before it until then', () => {
  const tags = ['0.2.0-tools', '0.3.0-tools', 'maven-3.9.16-r2', 'tracer-tools', 'test-1138-tools'];
  assert.equal(latestPublishedRelease({ '.': '0.3.0' }, tags), '0.3.0');
  // The release PR merge bumps the manifest before the release's index is pushed.
  assert.equal(latestPublishedRelease({ '.': '0.4.0' }, tags), '0.3.0');
  // A base before a later release keeps its own release.
  assert.equal(latestPublishedRelease({ '.': '0.2.0' }, tags), '0.2.0');
  assert.equal(latestPublishedRelease({ '.': '0.1.0' }, tags), undefined);
  assert.equal(latestPublishedRelease({ '.': '0.0.0' }, tags), undefined);
  assert.equal(latestPublishedRelease(null, tags), undefined);
});

test('the action tests install from the index of the latest published release, or from the tracer index before the first one', () => {
  assert.equal(latestIndexTag({ '.': '0.4.0' }, ['0.3.0-tools']), '0.3.0-tools');
  assert.equal(latestIndexTag({ '.': '1.0.0' }, ['tracer-tools']), 'tracer-tools');
  assert.equal(latestIndexTag(null, ['0.3.0-tools']), 'tracer-tools');
});

test('every draft release and every release without tools.json is left to publish, oldest first; tool releases are not releases', () => {
  const release = (tag, assets = [], extra = {}) => ({ tag_name: tag, draft: false, assets: assets.map((name) => ({ name, state: 'uploaded' })), ...extra });
  const releases = [
    release('0.10.0'),
    release('java-21.0.12-8-r1', ['java.tar']),
    release('0.9.0', ['tools.json']),
    release('0.2.0', ['notes.txt']),
    release('0.11.0', [], { draft: true }),
    release('maven-3.9.16-r1'),
  ];
  assert.deepEqual(unpublishedReleases(releases).map((r) => r.tag_name), ['0.2.0', '0.10.0', '0.11.0']);
  assert.deepEqual(unpublishedReleases([release('0.9.0', ['tools.json'])]), []);
});

test('a draft that lost its tag name is left to publish, first, instead of being skipped', () => {
  // An update of a draft without its tag name resets it to untagged-<hash>.
  const releases = [
    { tag_name: '0.9.0', draft: true, assets: [] },
    { tag_name: 'untagged-4f1cdd3a73e23735f2b7', draft: true, assets: [] },
  ];
  assert.deepEqual(unpublishedReleases(releases).map((r) => r.tag_name), ['untagged-4f1cdd3a73e23735f2b7', '0.9.0']);
});

test('a draft release whose tools.json is uploaded is left to publish', () => {
  // Its publication failed after the upload, before the draft was published.
  const release = { tag_name: '0.9.0', draft: true, assets: [{ name: 'tools.json', state: 'uploaded' }] };
  assert.deepEqual(unpublishedReleases([release]).map((r) => r.tag_name), ['0.9.0']);
});

test('a release whose tools.json upload failed is left to publish', () => {
  // A failed upload can leave the asset in the starter state, empty.
  const release = { tag_name: '0.9.0', draft: false, assets: [{ name: 'tools.json', state: 'starter' }] };
  assert.deepEqual(unpublishedReleases([release]).map((r) => r.tag_name), ['0.9.0']);
});

test('tools.json lists every tool version of the index per platform with its tag, layer digest and size', () => {
  const entries = [...both('maven', '3.9.16', 2, 'm', '3.9'), ...both('java', '21.0.12+8', 1, 'j', '21')].map((e) => ({ ...e, size: 100 }));
  assert.deepEqual(toolsJson({ version: '0.3.0', image: 'ghcr.io/camunda/infra-tools', entries }), {
    release: '0.3.0',
    index: 'ghcr.io/camunda/infra-tools:0.3.0-tools',
    tools: {
      java: [
        {
          version: '21.0.12+8', line: '21', revision: 1, tag: 'java-21.0.12-8-r1',
          platforms: { 'linux/amd64': { digest: 'j-linux/amd64', size: 100 }, 'linux/arm64': { digest: 'j-linux/arm64', size: 100 } },
        },
      ],
      maven: [
        {
          version: '3.9.16', line: '3.9', revision: 2, tag: 'maven-3.9.16-r2',
          platforms: { 'linux/amd64': { digest: 'm-linux/amd64', size: 100 }, 'linux/arm64': { digest: 'm-linux/arm64', size: 100 } },
        },
      ],
    },
  });
});

test('the release notes get the tool tables after the changelog of release-please, once', () => {
  const changelog = '## [0.3.0](https://example.com/compare/0.2.0...0.3.0) (2026-11-19)\n\n### Features\n\n* **maven:** publish 3.9.16\n';
  const notes = 'Index: `0.3.0-tools`, previous: `0.2.0-tools`\n\nNo tool changes.\n';
  const body = releaseBody(changelog, notes);
  assert.equal(body, `${changelog}\n<!-- infra-tools: tools -->\n## Tools\n\n${notes}`);
  // A rerun replaces the tables.
  assert.equal(releaseBody(body, 'other\n'), `${changelog}\n<!-- infra-tools: tools -->\n## Tools\n\nother\n`);
  assert.equal(releaseBody(null, notes), `<!-- infra-tools: tools -->\n## Tools\n\n${notes}`);
});

test('a catalog version upstream lacks a platform for is indexed on its platforms only (D62)', () => {
  const entries = buildIndex({
    tools: [maven],
    catalogs: { maven: [catalogEntry(maven, '3.9.16', 1, { platforms: ['linux/amd64'] })] },
    previousIndex: [],
    layers: { 'maven-3.9.16-r1': { 'linux/amd64': layer('sha256:m-amd64') } },
  });
  assert.deepEqual(entries.map((e) => `${e.version} ${e.platform}`), ['3.9.16 linux/amd64']);
});
