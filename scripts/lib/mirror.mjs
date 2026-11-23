// Copies a release index, with its manifests and layers, from the source registry to a mirror, same digests (ADR 0007).

// Copies the index at tag to the mirror before its release is published (D65): true once copied, false when the mirror holds it
// with the same digest. A mirror tag pointing to other content, such as the earlier index of a retargeted draft, is replaced by
// the source's: nothing reads a release's index before its release is published, and the source registry is the reference
// (ADR 0007). The tag goes last, so an interrupted copy leaves the tag as it was and is redone.
export async function mirrorIndex(source, mirror, tag) {
  const digest = await source.digest(tag);
  const mirrored = (await mirror.exists(tag)) ? await mirror.digest(tag) : null;
  if (mirrored === digest) return false;
  const index = await source.manifestBytes(tag);
  for (const descriptor of JSON.parse(index.bytes).manifests) {
    const manifest = await source.manifestBytes(descriptor.digest);
    const { config, layers } = JSON.parse(manifest.bytes);
    for (const { digest: blob } of [config, ...layers]) {
      if (!(await mirror.hasBlob(blob))) await mirror.uploadBlob(await source.blob(blob));
    }
    await mirror.putManifestBytes(manifest.bytes, manifest.mediaType, descriptor.digest);
  }
  await mirror.putManifestBytes(index.bytes, index.mediaType, tag);
  if (mirrored) console.log(`replaced ${mirror.repository}:${tag} (${mirrored} → ${digest})`);
  return true;
}
