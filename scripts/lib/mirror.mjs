// Copies release indexes, with their manifests and layers, from the source registry to a mirror, same digests (ADR 0007).
import { releaseVersions } from './release.mjs';

// Copies the release indexes the mirror lacks, oldest first; the tag goes last, so an interrupted copy is redone.
export async function mirrorReleases(source, mirror) {
  const copied = [];
  for (const tag of releaseVersions(await source.tags()).map((v) => `${v}-tools`)) {
    if (await mirror.exists(tag)) continue;
    const index = await source.manifestBytes(tag);
    for (const descriptor of JSON.parse(index.bytes).manifests) {
      const manifest = await source.manifestBytes(descriptor.digest);
      const { config, layers } = JSON.parse(manifest.bytes);
      for (const { digest } of [config, ...layers]) {
        if (!(await mirror.hasBlob(digest))) await mirror.uploadBlob(await source.blob(digest));
      }
      await mirror.putManifestBytes(manifest.bytes, manifest.mediaType, descriptor.digest);
    }
    await mirror.putManifestBytes(index.bytes, index.mediaType, tag);
    copied.push(tag);
  }
  return copied;
}
