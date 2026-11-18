import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, releaseNotes } from '../lib/index.mjs';
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
    previous: [],
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
    previous: [],
    layers: previousLayers,
  });
  const before = structuredClone(previous);
  const entries = buildIndex({
    tools: [java, maven],
    catalogs: {
      java: [catalogEntry(java, '17.0.18+8', 1, { line: '17', retired: true }), catalogEntry(java, '21.0.12+8', 2, { line: '21' })],
      maven: [],
    },
    previous,
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
  const build = (catalog, layers, previous = []) => () => buildIndex({ tools: [maven], catalogs: { maven: catalog }, previous, layers });
  assert.throws(build([catalogEntry(maven, '3.9.16', 1)], {}), { message: 'maven 3.9.16: tag maven-3.9.16-r1 not found' });
  assert.throws(build([catalogEntry(maven, '3.9.16', 1)], { 'maven-3.9.16-r1': { 'linux/amd64': layer('sha256:a') } }), {
    message: 'maven 3.9.16: tag maven-3.9.16-r1 has no layer for linux/arm64',
  });
  const previous = buildIndex({ tools: [maven], catalogs: { maven: [catalogEntry(maven, '3.9.16', 1)] }, previous: [], layers: { 'maven-3.9.16-r1': layersOf('old') } });
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
  assert.equal(releaseNotes({ version: '0.2.0', previous: '0.1.0', repository: 'camunda/infra-tools', before, after }), [
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
    releaseNotes({ version: '0.1.1', previous: '0.1.0', repository: 'camunda/infra-tools', before: after, after }),
    'Index: `0.1.1-tools`, previous: `0.1.0-tools`\n\nNo tool changes.\n',
  );
});
