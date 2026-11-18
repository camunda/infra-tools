// Usage: node index.mjs --index <registry>/<repository>:<tag> <tool>@<version>...
// Adds the tool images of the given tool versions to the index at --index (created when missing) and pushes it: the
// per-platform manifests reference the existing tool image layers, so no layer is uploaded twice.
import { parseArgs } from 'node:util';
import { buildTarget } from './lib/build.mjs';
import { mergeCatalog } from './lib/catalog.mjs';
import { indexEntries, ociIndex } from './lib/oci-index.mjs';
import { Registry } from './lib/registry.mjs';
import { buildIndex } from './lib/release.mjs';
import { readToolDefinition } from './lib/repository.mjs';

const { values, positionals } = parseArgs({ options: { index: { type: 'string' } }, allowPositionals: true });
const [repository, tag] = values.index?.split(/:(?=[^:/]+$)/) ?? [];
if (!tag || !positionals.length) throw new Error('usage: node index.mjs --index <registry>/<repository>:<tag> <tool>@<version>...');
const registry = new Registry(repository);

async function readIndex() {
  if (!(await registry.exists(tag))) return [];
  const index = await registry.manifest(tag);
  const manifests = {};
  for (const { digest } of index.manifests) manifests[digest] = await registry.manifest(digest);
  return indexEntries(index, manifests);
}

const tools = [];
const catalogs = {};
const layers = {};
for (const selector of positionals) {
  const [name, version] = selector.split('@');
  const tool = await readToolDefinition(name);
  const target = buildTarget(tool, version);
  if (!catalogs[name]) tools.push(tool);
  catalogs[name] = mergeCatalog(tool, catalogs[name] ?? [], [target]).entries;
  layers[target.tag] = await registry.toolImageLayers(target.tag);
}
const entries = buildIndex({ tools, catalogs, previousIndex: await readIndex(), layers });

const { index, manifests } = ociIndex(entries);
await registry.ensureBlob(Buffer.from('{}'));
for (const manifest of Object.values(manifests)) await registry.putManifest(manifest);
const digest = await registry.putManifest(index, tag);
console.log(`pushed ${values.index}@${digest}: ${entries.length} tool layers`);
for (const e of entries) console.log(`  ${e.platform} ${e.tool} ${e.version} ${e.tag} ${e.digest}`);
