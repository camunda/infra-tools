// Usage: node plan.mjs --image <registry>/<repository> [--out <dir>]
// Reconciler plan (spec §5.3, step 1): checks that every catalog version still has its tag in --image (lib/reconcile.mjs), then
// plans every tool against upstream and the published tags (lib/plan.mjs). Writes <out>/builds.json (default
// build/out/reconcile), the tool versions to build, test and push ([{ tool, version, tag, reason }]). An upstream or registry
// outage fails it, never reads as "nothing to publish".
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkCatalogTags } from './lib/reconcile.mjs';
import { planEveryTool, reconcilerOptions } from './lib/reconcile-scripts.mjs';
import { Registry } from './lib/registry.mjs';
import { readCatalog, readToolNames } from './lib/repository.mjs';

const values = reconcilerOptions('plan.mjs');

const registry = new Registry(values.image);
const names = await readToolNames();
await checkCatalogTags({ catalogs: Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readCatalog(name)]))), tagExists: (tag) => registry.exists(tag) });

const builds = [];
const { tools, plans } = await planEveryTool(registry);
for (const { name } of tools) {
  for (const v of plans[name].versions) {
    if (v.decision === 'publish') builds.push({ tool: name, version: v.version, tag: v.tag, reason: v.reason });
    else if (v.decision === 'wait') console.log(`${name} ${v.version}: waits, ${v.reason}`);
  }
}
await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'builds.json'), `${JSON.stringify(builds, null, 2)}\n`);
console.log(builds.length ? `to publish: ${builds.map((b) => `${b.tool} ${b.version} (${b.reason})`).join(', ')}` : 'nothing to publish');
