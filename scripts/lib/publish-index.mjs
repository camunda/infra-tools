// Release indexes in the registry (spec §5.5, D3): the per-platform manifests reference the tool image layers already pushed,
// so no layer is uploaded twice.
import { indexEntries, ociIndex } from './oci-index.mjs';
import { buildIndex, previousRelease } from './release.mjs';

// Publishes the index of release `version` to registry, the Registry of the tool images (spec §5.5): the previous release's
// index + the catalog entries of tools − retired versions, pushed as <version>-tools. catalogs: the catalog entries of every
// tool, by name. Throws, pushing nothing, when a catalog version lost its tag. Returns the entries of the pushed index, its
// digest, and the previous release (previousVersion, none for the first release) and its index entries (before).
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
  return { entries, digest: await pushIndex(registry, `${version}-tools`, entries), previousVersion, before };
}

async function pushIndex(registry, tag, entries) {
  const { index, manifests } = ociIndex(entries);
  await registry.ensureBlob(Buffer.from('{}'));
  for (const manifest of Object.values(manifests)) await registry.putManifest(manifest);
  return registry.putManifest(index, tag);
}

// The entries of the index at tag, [] when the tag is missing.
export async function readIndex(registry, tag) {
  if (!(await registry.exists(tag))) return [];
  const index = await registry.manifest(tag);
  const manifests = {};
  for (const { digest } of index.manifests) manifests[digest] = await registry.manifest(digest);
  return indexEntries(index, manifests);
}
