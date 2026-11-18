// Usage: node plan.mjs --image <registry>/<repository> [--out <dir>]
// Reconciler plan (spec §5.3, step 1): plans every tool against upstream and the published tags in --image (lib/plan.mjs), and
// checks that every catalog version still has its tag (lib/reconcile.mjs). Writes <out>/builds.json (default
// build/out/reconcile), the tool versions to build, test and push ([{ tool, version, tag, reason }]). An upstream or registry
// outage fails it, never reads as "nothing to publish".
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkCatalogTags } from './lib/reconcile.mjs';
import { planEveryTool, reconcilerOptions } from './lib/reconcile-scripts.mjs';
import { Registry, tagExists } from './lib/registry.mjs';

const values = reconcilerOptions('plan.mjs');

const registry = new Registry(values.image);
const { tools, catalogs, plans } = await planEveryTool(registry);
await checkCatalogTags({ catalogs, tagExists: tagExists(registry) });

const builds = [];
for (const { name } of tools) {
  for (const v of plans[name].versions) {
    if (v.decision === 'publish') builds.push({ tool: name, version: v.version, tag: v.tag, reason: v.reason });
    else if (v.decision === 'wait') console.log(`${name} ${v.version}: waits, ${v.reason}`);
  }
}
await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'builds.json'), `${JSON.stringify(builds, null, 2)}\n`);
console.log(builds.length ? `to publish: ${builds.map((b) => `${b.tool} ${b.version} (${b.reason})`).join(', ')}` : 'nothing to publish');
