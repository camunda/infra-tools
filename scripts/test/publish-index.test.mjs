// Adding tool versions to an index in a registry (scripts/index.mjs), against the fake registry.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { sha256 } from '../lib/oci.mjs';
import { publishIndex } from '../lib/publish-index.mjs';
import { Registry } from '../lib/registry.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';
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
