// Pushes a tool image from the OCI layout Bake writes (build/out/<tag>), so the pushed bytes are the tested ones.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_TYPES, manifestBytes } from './oci.mjs';

// The annotation holding the build commit (build/docker-bake.hcl), on the image index.
const BUILD_COMMIT = 'org.opencontainers.image.revision';

// The layout's index.json holds one image index, with one manifest per platform; or, built for one platform, its image manifest,
// annotated with the build commit (Bake rejects index annotations on one platform), which gets an image index here. Manifests
// are pushed as they are stored: re-serializing them would change their digests. reuse: the tag of a published tool image whose
// other platforms the image index also lists, as they are (D62): their layers keep their digests, and only the layout's
// platforms are built and pushed.
export async function pushOciLayout(registry, dir, tag, { reuse } = {}) {
  if (await registry.exists(tag)) {
    throw new Error(`${registry.repository}:${tag} already exists; published tool images never change: bump the revision`);
  }
  const blob = (digest) => readFile(join(dir, 'blobs', ...digest.split(':')));
  const { manifests } = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
  if (manifests?.length !== 1) throw new Error(`${dir}: expected one image index or image manifest in index.json, got ${manifests?.length}`);
  let indexBytes;
  if (manifests[0].mediaType === MEDIA_TYPES.index) indexBytes = await blob(manifests[0].digest);
  else {
    const { mediaType, digest, size, platform } = manifests[0];
    const commit = JSON.parse(await blob(digest)).annotations?.[BUILD_COMMIT];
    indexBytes = manifestBytes({
      schemaVersion: 2,
      mediaType: MEDIA_TYPES.index,
      manifests: [{ mediaType, digest, size, platform }],
      ...(commit && { annotations: { [BUILD_COMMIT]: commit } }),
    });
  }
  const index = JSON.parse(indexBytes);
  for (const descriptor of index.manifests) {
    const bytes = await blob(descriptor.digest);
    const manifest = JSON.parse(bytes);
    for (const { digest } of [manifest.config, ...manifest.layers]) await registry.ensureBlob(await blob(digest));
    await registry.putManifestBytes(bytes, descriptor.mediaType, descriptor.digest);
  }
  if (reuse) {
    const platformOf = ({ platform }) => `${platform.os}/${platform.architecture}`;
    const built = new Set(index.manifests.map(platformOf));
    const reused = (await registry.manifest(reuse)).manifests.filter((d) => !built.has(platformOf(d)));
    indexBytes = manifestBytes({ ...index, manifests: [...reused, ...index.manifests].sort((a, b) => platformOf(a).localeCompare(platformOf(b))) });
  }
  await registry.putManifestBytes(indexBytes, index.mediaType, tag);
}
