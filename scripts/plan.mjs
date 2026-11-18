// Usage: node plan.mjs --image <registry>/<repository> [--out <dir>]
// Reconciler plan (spec §5.3, step 1): checks that every catalog version still has its tag in --image (lib/reconcile.mjs), then
// plans every tool against upstream and the published tags (lib/plan.mjs). Writes <out>/builds.json (default
// build/out/reconcile), the tool versions to build, test and push ([{ tool, version, tag, reason }]). An upstream or registry
// outage fails it, never reads as "nothing to publish".
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { planTool } from './lib/plan.mjs';
import { checkCatalogTags } from './lib/reconcile.mjs';
import { Registry } from './lib/registry.mjs';
import { readCatalog, readToolDefinition, readToolNames, ROOT } from './lib/repository.mjs';

const { values } = parseArgs({ options: { image: { type: 'string' }, out: { type: 'string', default: join(ROOT, 'build/out/reconcile') } } });
if (!values.image) throw new Error('usage: node plan.mjs --image <registry>/<repository> [--out <dir>]');

const registry = new Registry(values.image);
const tagExists = (tag) => registry.exists(tag);
const names = await readToolNames();
await checkCatalogTags({ catalogs: Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readCatalog(name)]))), tagExists });

const builds = [];
for (const name of names) {
  const plan = await planTool(await readToolDefinition(name), { tagExists, now: Date.now() });
  for (const v of plan.versions) {
    if (v.decision === 'publish') builds.push({ tool: name, version: v.version, tag: v.tag, reason: v.reason });
    else if (v.decision === 'wait') console.log(`${name} ${v.version}: waits, ${v.reason}`);
  }
}
await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'builds.json'), `${JSON.stringify(builds, null, 2)}\n`);
console.log(builds.length ? `to publish: ${builds.map((b) => `${b.tool} ${b.version} (${b.reason})`).join(', ')}` : 'nothing to publish');
