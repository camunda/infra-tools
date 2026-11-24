// Copies a release index, with its manifests and layers, from the source registry to a mirror, same digests (ADR 0007).
import { duration, size } from './log.mjs';

// Copies the index at tag to the mirror before its release is published (D65): true once copied, false when the mirror holds it
// with the same digest. A mirror tag pointing to other content, such as the earlier index of a retargeted draft, is replaced by
// the source's: nothing reads a release's index before its release is published, and the source registry is the reference
// (ADR 0007). The tag goes last, so an interrupted copy leaves the tag as it was and is redone. log: called with each line of
// the copy (one per layer, then a total), so a long copy shows its progress.
export async function mirrorIndex(source, mirror, tag, { log = () => {} } = {}) {
  const digest = await source.digest(tag);
  const mirrored = (await mirror.exists(tag)) ? await mirror.digest(tag) : null;
  if (mirrored === digest) {
    log(`${mirror.repository}:${tag} already holds ${digest}, nothing to copy`);
    return false;
  }
  const index = await source.manifestBytes(tag);
  const copied = { count: 0, bytes: 0 };
  let present = 0;
  for (const descriptor of JSON.parse(index.bytes).manifests) {
    const manifest = await source.manifestBytes(descriptor.digest);
    const { config, layers } = JSON.parse(manifest.bytes);
    if (!(await mirror.hasBlob(config.digest))) await mirror.uploadBlob(await source.blob(config.digest));
    for (const { digest: layer } of layers) {
      const name = `layer ${layer.slice(0, 'sha256:'.length + 8)}…`;
      if (await mirror.hasBlob(layer)) {
        present++;
        log(`${name} present, skipped`);
        continue;
      }
      const start = Date.now();
      const bytes = await source.blob(layer);
      await mirror.uploadBlob(bytes);
      const took = Date.now() - start;
      copied.count++;
      copied.bytes += bytes.length;
      log(`${name} ${size(bytes.length)} copied in ${duration(took)} (${size((bytes.length * 1000) / Math.max(took, 1))}/s)`);
    }
    await mirror.putManifestBytes(manifest.bytes, manifest.mediaType, descriptor.digest);
  }
  await mirror.putManifestBytes(index.bytes, index.mediaType, tag);
  log(`${copied.count} copied (${size(copied.bytes)}), ${present} present, index tagged ${tag}`);
  if (mirrored) log(`replaced ${mirror.repository}:${tag} (${mirrored} → ${digest})`);
  return true;
}
