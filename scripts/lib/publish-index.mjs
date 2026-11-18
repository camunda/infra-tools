// Adds tool versions to an index in the registry (spec §5.5, D3): the per-platform manifests reference the tool image layers
// already pushed, so no layer is uploaded twice. The index is created when missing.
import { buildTarget } from './build.mjs';
import { mergeCatalog } from './catalog.mjs';
import { indexEntries, ociIndex } from './oci-index.mjs';
import { buildIndex } from './release.mjs';

// registry: a Registry of the repository holding the tool images and the index. toolVersions: [{ tool, version }], with tool
// a parsed tool definition. Returns the entries of the pushed index and its digest.
export async function publishIndex(registry, tag, toolVersions) {
  const tools = [];
  const catalogs = {};
  const layers = {};
  for (const { tool, version } of toolVersions) {
    const target = buildTarget(tool, version);
    if (!catalogs[tool.name]) tools.push(tool);
    catalogs[tool.name] = mergeCatalog(tool, catalogs[tool.name] ?? [], [target]).entries;
    layers[target.tag] = await registry.toolImageLayers(target.tag);
  }
  const entries = buildIndex({ tools, catalogs, previousIndex: await readIndex(registry, tag), layers });
  const { index, manifests } = ociIndex(entries);
  await registry.ensureBlob(Buffer.from('{}'));
  for (const manifest of Object.values(manifests)) await registry.putManifest(manifest);
  return { entries, digest: await registry.putManifest(index, tag) };
}

async function readIndex(registry, tag) {
  if (!(await registry.exists(tag))) return [];
  const index = await registry.manifest(tag);
  const manifests = {};
  for (const { digest } of index.manifests) manifests[digest] = await registry.manifest(digest);
  return indexEntries(index, manifests);
}
