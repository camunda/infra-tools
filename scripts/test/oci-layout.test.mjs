// Pushing the tested tool image (an OCI layout written by Bake) to the registry, against the fake registry.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { sha256 } from '../lib/oci.mjs';
import { pushOciLayout } from '../lib/oci-layout.mjs';
import { Registry } from '../lib/registry.mjs';
import { FakeRegistry, TOKEN } from './fake-registry.mjs';

// An OCI layout as Bake's oci exporter writes it: index.json → image index → one manifest per platform. Manifests are
// pretty-printed, so a push that re-serializes them would change their digests.
async function writeLayout(dir) {
  const blob = async (bytes) => {
    await writeFile(join(dir, 'blobs/sha256', sha256(bytes).slice(7)), bytes);
    return { digest: sha256(bytes), size: bytes.length };
  };
  await mkdir(join(dir, 'blobs/sha256'), { recursive: true });
  const config = await blob(Buffer.from('{"architecture":"amd64","os":"linux"}'));
  const platforms = {};
  for (const architecture of ['amd64', 'arm64']) {
    const layer = await blob(Buffer.from(`maven 3.9.16 ${architecture} layer`));
    const manifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }],
    };
    platforms[architecture] = { layer: layer.digest, manifest: await blob(Buffer.from(JSON.stringify(manifest, null, 2))) };
  }
  const index = await blob(
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: Object.entries(platforms).map(([architecture, { manifest }]) => ({
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            ...manifest,
            platform: { architecture, os: 'linux' },
          })),
        },
        null,
        2,
      ),
    ),
  );
  await writeFile(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', ...index }] }));
  return { index: index.digest, platforms };
}

let work;
let layout;
before(async () => {
  work = await mkdtemp(join(tmpdir(), 'infra-tools-layout-'));
  layout = await writeLayout(work);
});
after(() => rm(work, { recursive: true, force: true }));

let fake;
let registry;
beforeEach(async () => {
  await fake?.stop();
  fake = new FakeRegistry();
  await fake.start();
  registry = new Registry(fake.repository, { token: TOKEN, scheme: 'http' });
});
after(() => fake.stop());

test('the tool image is pushed byte for byte under its tag', async () => {
  await pushOciLayout(registry, work, 'maven-3.9.16-r2');
  assert.equal(sha256(fake.manifests.get('maven-3.9.16-r2').bytes), layout.index);
  assert.equal(await registry.digest('maven-3.9.16-r2'), layout.index);
  assert.deepEqual(await registry.toolImageLayers('maven-3.9.16-r2'), {
    'linux/amd64': { digest: layout.platforms.amd64.layer, size: 24, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' },
    'linux/arm64': { digest: layout.platforms.arm64.layer, size: 24, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' },
  });
  const layer = await readFile(join(work, 'blobs/sha256', layout.platforms.arm64.layer.slice(7)));
  assert.deepEqual(fake.blobs.get(layout.platforms.arm64.layer), layer);
});

test('a tool image is never pushed over an existing tag', async () => {
  fake.addToolImage('maven-3.9.16-r2', { 'linux/amd64': Buffer.from('published'), 'linux/arm64': Buffer.from('published') });
  const before = fake.manifest('maven-3.9.16-r2');
  await assert.rejects(pushOciLayout(registry, work, 'maven-3.9.16-r2'), {
    message: `${fake.repository}:maven-3.9.16-r2 already exists; published tool images never change: bump the revision`,
  });
  assert.deepEqual(fake.manifest('maven-3.9.16-r2'), before);
});

// An OCI layout as Bake writes it for one platform: index.json → its image manifest, annotated with the build commit.
async function writeOnePlatformLayout(dir) {
  const blob = async (bytes) => {
    await writeFile(join(dir, 'blobs/sha256', sha256(bytes).slice(7)), bytes);
    return { digest: sha256(bytes), size: bytes.length };
  };
  await mkdir(join(dir, 'blobs/sha256'), { recursive: true });
  const config = await blob(Buffer.from('{"architecture":"arm64","os":"linux"}'));
  const layer = await blob(Buffer.from('maven 3.9.16 arm64 layer'));
  const manifest = await blob(Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }],
    annotations: { 'org.opencontainers.image.revision': 'abc123' },
  }, null, 2)));
  const descriptor = { mediaType: 'application/vnd.oci.image.manifest.v1+json', ...manifest, annotations: { 'org.opencontainers.image.ref.name': 'latest' }, platform: { architecture: 'arm64', os: 'linux' } };
  await writeFile(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [descriptor] }));
  return { manifest: manifest.digest, layer: layer.digest };
}

test('a platform added to a published tool image is pushed with the other platforms reused as they are (D62)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'infra-tools-layout-'));
  try {
    const built = await writeOnePlatformLayout(dir);
    fake.addToolImage('maven-3.9.16-r1', { 'linux/amd64': Buffer.from('published amd64 layer') }, { 'org.opencontainers.image.revision': 'old' });
    const reused = fake.manifest('maven-3.9.16-r1').manifests[0];
    await pushOciLayout(registry, dir, 'maven-3.9.16-r2', { reuse: 'maven-3.9.16-r1' });
    const index = fake.manifest('maven-3.9.16-r2');
    assert.deepEqual(index.manifests.map((d) => [d.platform.architecture, d.digest]), [['amd64', reused.digest], ['arm64', built.manifest]]);
    assert.deepEqual(index.annotations, { 'org.opencontainers.image.revision': 'abc123' }, 'the build commit of the platform built');
    assert.equal((await registry.toolImageLayers('maven-3.9.16-r2'))['linux/arm64'].digest, built.layer);
    assert.deepEqual(await registry.toolImagePlatforms('maven-3.9.16-r2'), ['linux/amd64', 'linux/arm64']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
