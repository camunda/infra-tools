import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { indexEntries, ociIndex } from '../lib/oci-index.mjs';

const layerType = 'application/vnd.oci.image.layer.v1.tar+gzip';
const entry = (platform, tool, version, extra = {}) => ({
  platform,
  tool,
  version,
  line: '3.9',
  folderVersion: version.replaceAll('+', '-'),
  revision: 1,
  tag: `${tool}-${version.replaceAll('+', '-')}-r1`,
  cacheFolder: tool,
  archFolder: platform === 'linux/amd64' ? 'x64' : 'arm64',
  addToPath: 'bin',
  digest: `sha256:${tool}-${version}-${platform.split('/')[1]}`,
  size: 9000000,
  mediaType: layerType,
  ...extra,
});
const entries = [
  entry('linux/amd64', 'maven', '3.9.16'),
  entry('linux/arm64', 'maven', '3.9.16'),
  entry('linux/amd64', 'java', '21.0.12+8', { line: '21', cacheFolder: 'Java_Temurin-Hotspot_jdk', addToPath: null }),
  entry('linux/arm64', 'java', '21.0.12+8', { line: '21', cacheFolder: 'Java_Temurin-Hotspot_jdk', archFolder: 'aarch64', addToPath: null }),
];

test('the index has one artifact manifest per platform listing the tool layers with their annotations', () => {
  const { index, manifests } = ociIndex(entries);
  assert.deepEqual(
    index.manifests.map((m) => m.platform),
    [
      { os: 'linux', architecture: 'amd64' },
      { os: 'linux', architecture: 'arm64' },
    ],
  );
  const amd64 = manifests[index.manifests[0].digest];
  assert.deepEqual(amd64, {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'application/vnd.camunda.infra-tools.index.v1+json',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', size: 2 },
    layers: [
      {
        mediaType: layerType,
        digest: 'sha256:maven-3.9.16-amd64',
        size: 9000000,
        annotations: {
          'io.camunda.infra-tools.tool': 'maven',
          'io.camunda.infra-tools.version': '3.9.16',
          'io.camunda.infra-tools.line': '3.9',
          'io.camunda.infra-tools.folder-version': '3.9.16',
          'io.camunda.infra-tools.revision': '1',
          'io.camunda.infra-tools.tag': 'maven-3.9.16-r1',
          'io.camunda.infra-tools.cache-folder': 'maven',
          'io.camunda.infra-tools.arch-folder': 'x64',
          'io.camunda.infra-tools.add-to-path': 'bin',
        },
      },
      {
        mediaType: layerType,
        digest: 'sha256:java-21.0.12+8-amd64',
        size: 9000000,
        annotations: {
          'io.camunda.infra-tools.tool': 'java',
          'io.camunda.infra-tools.version': '21.0.12+8',
          'io.camunda.infra-tools.line': '21',
          'io.camunda.infra-tools.folder-version': '21.0.12-8',
          'io.camunda.infra-tools.revision': '1',
          'io.camunda.infra-tools.tag': 'java-21.0.12-8-r1',
          'io.camunda.infra-tools.cache-folder': 'Java_Temurin-Hotspot_jdk',
          'io.camunda.infra-tools.arch-folder': 'x64',
        },
      },
    ],
  });
});

test('the index references each manifest by the digest and size of its pushed bytes', () => {
  const { index, manifests } = ociIndex(entries);
  assert.equal(index.mediaType, 'application/vnd.oci.image.index.v1+json');
  for (const descriptor of index.manifests) {
    const bytes = Buffer.from(JSON.stringify(manifests[descriptor.digest]));
    assert.equal(descriptor.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal(descriptor.size, bytes.length);
    assert.equal(descriptor.mediaType, 'application/vnd.oci.image.manifest.v1+json');
  }
});

test('an index read back gives the entries it was built from', () => {
  const { index, manifests } = ociIndex(entries);
  const sorted = (list) => [...list].sort((a, b) => `${a.tool}${a.platform}`.localeCompare(`${b.tool}${b.platform}`));
  assert.deepEqual(sorted(indexEntries(index, manifests)), sorted(entries));
});

test('an empty index has a manifest per platform with no layers', () => {
  const { index, manifests } = ociIndex([]);
  assert.equal(index.manifests.length, 2);
  assert.deepEqual(indexEntries(index, manifests), []);
});
