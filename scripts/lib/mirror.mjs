// Copies a release index, with its manifests and layers, from the source registry to a mirror, same digests (ADR 0007).

// Copies the index at tag to the mirror before its release is published (D65): true once copied, false when the mirror holds it
// with the same digest. A mirror tag pointing to other content throws, left as it is: a person deletes it. The tag goes last,
// so an interrupted copy leaves no tag and is redone.
export async function mirrorIndex(source, mirror, tag) {
  const digest = await source.digest(tag);
  if (await mirror.exists(tag)) {
    const mirrored = await mirror.digest(tag);
    if (mirrored === digest) return false;
    throw new Error(`${mirror.repository}:${tag} is ${mirrored}, not ${digest} as on ${source.repository}: delete the mirror's tag, then run the workflow`);
  }
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
  return true;
}
