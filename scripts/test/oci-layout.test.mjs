// Pushing the tested tool image (an OCI layout written by Bake) to the registry, against the fake registry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { pushOciLayout } from '../lib/oci-layout.mjs';
import { Registry } from '../lib/registry.mjs';
import { FakeRegistry, TOKEN } from './fake-registry.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

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
