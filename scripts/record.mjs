// Usage: node record.mjs --image <registry>/<repository> [--out <dir>]
// Reconciler record (spec §5.3, step 4), once the run's builds are pushed: plans every tool again against upstream and the
// published tags in --image, and records every published version the catalog lacks (lib/reconcile.mjs recordRun). Writes
// published/<tool>.json, and in <out> (default build/out/reconcile): published.json, the tool versions that need a tool release
// (publish.mjs), and commit.txt, the record commit message, empty when nothing changed.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { planTool } from './lib/plan.mjs';
import { commitMessage, recordRun } from './lib/reconcile.mjs';
import { Registry } from './lib/registry.mjs';
import { readCatalog, readToolDefinition, readToolNames, ROOT, writeCatalog } from './lib/repository.mjs';

const { values } = parseArgs({ options: { image: { type: 'string' }, out: { type: 'string', default: join(ROOT, 'build/out/reconcile') } } });
if (!values.image) throw new Error('usage: node record.mjs --image <registry>/<repository> [--out <dir>]');

const registry = new Registry(values.image);
const tools = [];
const catalogs = {};
const plans = {};
for (const name of await readToolNames()) {
  const tool = await readToolDefinition(name);
  tools.push(tool);
  catalogs[name] = await readCatalog(name);
  plans[name] = await planTool(tool, { tagExists: (tag) => registry.exists(tag), now: Date.now() });
}
const run = recordRun({ tools, catalogs, plans, now: new Date().toISOString() });
for (const tool of tools) {
  const entries = run.catalogs[tool.name];
  if (JSON.stringify(entries) !== JSON.stringify(catalogs[tool.name])) await writeCatalog(tool.name, entries);
}
await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'published.json'), `${JSON.stringify(run.published, null, 2)}\n`);
const message = commitMessage(run.changes);
await writeFile(join(values.out, 'commit.txt'), message);
console.log(message ? `recorded:\n${message}` : 'nothing to record');
