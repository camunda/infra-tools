// Release indexes in the registry (spec §5.5, D3): the per-platform manifests reference the tool image layers already pushed,
// so no layer is uploaded twice.
import { indexEntries, ociIndex } from './oci-index.mjs';
import { manifestBytes, sha256 } from './oci.mjs';
import { buildIndex, previousRelease } from './release.mjs';

// Publishes the index of release `version` to registry, the Registry of the tool images (spec §5.5): the previous release's
// index + the catalog entries of tools − retired versions, pushed as <version>-tools. catalogs: the catalog entries of every
// tool, by name. Throws, pushing nothing, when a catalog version lost its tag. Pushes nothing either when the tag already has
// the index's digest (pushed: false): a rerun of the release. Returns the entries of the index, its digest, whether it was
// pushed, and the previous release (previousVersion, none for the first release) and its index entries (before).
export async function publishReleaseIndex(registry, version, { tools, catalogs }) {
  const previousVersion = previousRelease(await registry.tags(), version);
  const before = previousVersion ? await readIndex(registry, `${previousVersion}-tools`) : [];
  const layers = {};
  for (const tool of tools) {
    for (const e of catalogs[tool.name] ?? []) {
      if (!e.retired && (await registry.exists(e.tag))) layers[e.tag] = await registry.toolImageLayers(e.tag);
    }
  }
  const entries = buildIndex({ tools, catalogs, previousIndex: before, layers });
  const tag = `${version}-tools`;
  const { index, manifests } = ociIndex(entries);
  const digest = sha256(manifestBytes(index));
  const pushed = !(await registry.exists(tag)) || (await registry.digest(tag)) !== digest;
  if (pushed) {
    await registry.ensureBlob(Buffer.from('{}'));
    for (const manifest of Object.values(manifests)) await registry.putManifest(manifest);
    await registry.putManifest(index, tag);
  }
  return { entries, digest, pushed, previousVersion, before };
}

// The entries of the index at tag, [] when the tag is missing.
export async function readIndex(registry, tag) {
  if (!(await registry.exists(tag))) return [];
  const index = await registry.manifest(tag);
  const manifests = {};
  for (const { digest } of index.manifests) manifests[digest] = await registry.manifest(digest);
  return indexEntries(index, manifests);
}
