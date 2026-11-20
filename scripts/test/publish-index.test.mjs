// Adding tool versions to an index in a registry (scripts/index.mjs), against the fake registry.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { sha256 } from '../lib/oci.mjs';
import { publishIndex, publishReleaseIndex } from '../lib/publish-index.mjs';
import { Registry } from '../lib/registry.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';
import { catalogEntry } from './catalog-entry.mjs';
import { FakeRegistry, TOKEN } from './fake-registry.mjs';

const maven = parseToolDefinition('maven', {
  source: { datasource: 'maven' },
  publish: { lines: { 3.9: { versions: ['3.9.16'], revisions: { '3.9.16': 2 } } } },
  install: { addToPath: 'bin' },
});
const digest = (text) => sha256(Buffer.from(text));
const layers = (name) => ({ 'linux/amd64': Buffer.from(`${name} amd64`), 'linux/arm64': Buffer.from(`${name} arm64`) });
const summary = (entries) => entries.map((e) => `${e.platform} ${e.tool} ${e.version} r${e.revision} ${e.tag} ${e.archFolder} ${e.addToPath} ${e.digest}`).sort();

let fake;
let registry;
beforeEach(async () => {
  await fake?.stop();
  fake = new FakeRegistry();
  await fake.start();
  registry = new Registry(fake.repository, { token: TOKEN, scheme: 'http' });
});
after(() => fake.stop());

test('adding a tool version to a missing index creates it with the tool image layers of every platform', async () => {
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16'));
  await publishIndex(registry, 'tracer-tools', [{ tool: maven, version: '3.9.16' }]);
  assert.deepEqual(summary(fake.indexEntries('tracer-tools')), [
    `linux/amd64 maven 3.9.16 r2 maven-3.9.16-r2 x64 bin ${digest('maven 3.9.16 amd64')}`,
    `linux/arm64 maven 3.9.16 r2 maven-3.9.16-r2 arm64 bin ${digest('maven 3.9.16 arm64')}`,
  ]);
});

const javaEntry = (platform) => ({
  platform,
  tool: 'java',
  version: '21.0.12+8',
  line: '21',
  folderVersion: '21.0.12-8',
  revision: 1,
  tag: 'java-21.0.12-8-r1',
  cacheFolder: 'Java_Temurin-Hotspot_jdk',
  archFolder: platform === 'linux/amd64' ? 'x64' : 'aarch64',
  addToPath: null,
  digest: digest(`java ${platform}`),
  size: 10,
  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
});

test('an existing index keeps its other tool versions', async () => {
  fake.addIndex('tracer-tools', [javaEntry('linux/amd64'), javaEntry('linux/arm64')]);
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16'));
  await publishIndex(registry, 'tracer-tools', [{ tool: maven, version: '3.9.16' }]);
  assert.deepEqual(summary(fake.indexEntries('tracer-tools')), [
    `linux/amd64 java 21.0.12+8 r1 java-21.0.12-8-r1 x64 null ${digest('java linux/amd64')}`,
    `linux/amd64 maven 3.9.16 r2 maven-3.9.16-r2 x64 bin ${digest('maven 3.9.16 amd64')}`,
    `linux/arm64 java 21.0.12+8 r1 java-21.0.12-8-r1 aarch64 null ${digest('java linux/arm64')}`,
    `linux/arm64 maven 3.9.16 r2 maven-3.9.16-r2 arm64 bin ${digest('maven 3.9.16 arm64')}`,
  ]);
});

test('adding a tool version again leaves the index as it was', async () => {
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16'));
  const first = await publishIndex(registry, 'tracer-tools', [{ tool: maven, version: '3.9.16' }]);
  const second = await publishIndex(registry, 'tracer-tools', [{ tool: maven, version: '3.9.16' }]);
  assert.equal(second.digest, first.digest);
});

test('a tool image whose layers changed at the same revision is refused and the index is left as it was', async () => {
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16'));
  await publishIndex(registry, 'tracer-tools', [{ tool: maven, version: '3.9.16' }]);
  const before = fake.manifest('tracer-tools');
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16 rebuilt'));
  await assert.rejects(publishIndex(registry, 'tracer-tools', [{ tool: maven, version: '3.9.16' }]), {
    message: /maven 3\.9\.16 \(linux\/amd64\): layer changed without a higher revision/,
  });
  assert.deepEqual(fake.manifest('tracer-tools'), before);
});

test('a tool version without its tool image fails and pushes nothing', async () => {
  await assert.rejects(publishIndex(registry, 'tracer-tools', [{ tool: maven, version: '3.9.16' }]), { message: /maven-3\.9\.16-r2: HTTP 404/ });
  assert.equal(fake.manifest('tracer-tools'), undefined);
});

test('a version its tool definition does not publish is refused', async () => {
  await assert.rejects(publishIndex(registry, 'tracer-tools', [{ tool: maven, version: '3.9.15' }]), {
    message: 'tools/maven/tool.json: maven 3.9.15 is not published by line 3.9',
  });
});

// The release index (spec §5.5): previous release's index + catalog − retired versions.
const javaTool = parseToolDefinition('java', {
  source: { datasource: 'java-version' },
  publish: { lines: { 21: { from: '21.0.12', retired: ['21.0.12+8'] } } },
  install: { cacheFolder: 'Java_Temurin-Hotspot_jdk', archFolders: { amd64: 'x64', arm64: 'aarch64' } },
});
const releaseCatalogs = { java: [{ ...catalogEntry(javaTool, '21.0.12+8', 1, '21'), retired: true }], maven: [catalogEntry(maven, '3.9.16', 2, '3.9')] };

test('a release index is the previous release index plus the catalog minus retired versions; older indexes keep them', async () => {
  fake.addIndex('0.2.0-tools', [javaEntry('linux/amd64'), javaEntry('linux/arm64')]);
  fake.addIndex('0.1.0-tools', []);
  fake.addIndex('0.10.0-tools', []);
  fake.addIndex('tracer-tools', []);
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16'));
  const release = await publishReleaseIndex(registry, '0.3.0', { tools: [javaTool, maven], catalogs: releaseCatalogs });
  assert.equal(release.previousVersion, '0.2.0');
  assert.deepEqual(summary(release.before), summary(fake.indexEntries('0.2.0-tools')));
  assert.deepEqual(summary(fake.indexEntries('0.3.0-tools')), [
    `linux/amd64 maven 3.9.16 r2 maven-3.9.16-r2 x64 bin ${digest('maven 3.9.16 amd64')}`,
    `linux/arm64 maven 3.9.16 r2 maven-3.9.16-r2 arm64 bin ${digest('maven 3.9.16 arm64')}`,
  ]);
  assert.deepEqual(summary(release.entries), summary(fake.indexEntries('0.3.0-tools')));
  assert.equal(fake.indexEntries('0.2.0-tools').length, 2);
});

test('a release index uploads no layer: it references the tool image layers already pushed', async () => {
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16'));
  const blobs = fake.blobs.size;
  await publishReleaseIndex(registry, '0.1.0', { tools: [javaTool, maven], catalogs: releaseCatalogs });
  // The empty config of the index manifests, at most.
  assert.ok(fake.blobs.size - blobs <= 1);
  assert.ok(fake.requests.filter((r) => r.startsWith('POST ')).length <= 1);
});

test('the first release has no previous index', async () => {
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16'));
  const release = await publishReleaseIndex(registry, '0.1.0', { tools: [javaTool, maven], catalogs: releaseCatalogs });
  assert.equal(release.previousVersion, undefined);
  assert.deepEqual(release.before, []);
  assert.equal(fake.indexEntries('0.1.0-tools').length, 2);
});

test('the previous release is found among index tags listed over several pages', async () => {
  fake.pageSize = 2;
  for (const version of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '1.0.0']) fake.addIndex(`${version}-tools`, []);
  fake.addToolImage('maven-3.9.16-r2', layers('maven 3.9.16'));
  const release = await publishReleaseIndex(registry, '0.5.0', { tools: [javaTool, maven], catalogs: releaseCatalogs });
  assert.equal(release.previousVersion, '0.4.0');
});

test('a catalog version without its tag fails the release and pushes no index', async () => {
  await assert.rejects(publishReleaseIndex(registry, '0.1.0', { tools: [javaTool, maven], catalogs: releaseCatalogs }), { message: 'maven 3.9.16: tag maven-3.9.16-r2 not found' });
  assert.equal(fake.manifest('0.1.0-tools'), undefined);
});
