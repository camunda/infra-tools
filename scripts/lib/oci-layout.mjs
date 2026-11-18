// Pushes a tool image from the OCI layout Bake writes (build/out/<tag>), so the pushed bytes are the tested ones.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The layout's index.json holds one image index, with one manifest per platform. Manifests are pushed as they are stored:
// re-serializing them would change their digests.
export async function pushOciLayout(registry, dir, tag) {
  if (await registry.exists(tag)) {
    throw new Error(`${registry.repository}:${tag} already exists; published tool images never change: bump the revision`);
  }
  const blob = (digest) => readFile(join(dir, 'blobs', ...digest.split(':')));
  const { manifests } = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
  if (manifests?.length !== 1) throw new Error(`${dir}: expected one image index in index.json, got ${manifests?.length}`);
  const indexBytes = await blob(manifests[0].digest);
  const index = JSON.parse(indexBytes);
  for (const descriptor of index.manifests) {
    const bytes = await blob(descriptor.digest);
    const manifest = JSON.parse(bytes);
    for (const { digest } of [manifest.config, ...manifest.layers]) await registry.ensureBlob(await blob(digest));
    await registry.putManifestBytes(bytes, descriptor.mediaType, descriptor.digest);
  }
  await registry.putManifestBytes(indexBytes, index.mediaType, tag);
}
