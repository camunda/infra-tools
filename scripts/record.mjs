// Usage: node record.mjs --image <registry>/<repository> [--out <dir>]
// Reconciler record (spec §5.3, step 4), once the run's builds are pushed: plans every tool again against upstream and the
// published tags in --image, and records every published version the catalog lacks (lib/reconcile.mjs recordRun). Writes
// published/<tool>.json, and in <out> (default build/out/reconcile): unreleased.json, the tool versions that need a tool
// release (publish.mjs), and commit.txt, the record commit message, empty when nothing changed.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitMessage, recordRun } from './lib/reconcile.mjs';
import { planEveryTool, reconcilerOptions } from './lib/reconcile-scripts.mjs';
import { Registry } from './lib/registry.mjs';
import { readCatalog, writeCatalog } from './lib/repository.mjs';

const values = reconcilerOptions('record.mjs');

const { tools, plans } = await planEveryTool(new Registry(values.image));
const catalogs = {};
for (const { name } of tools) catalogs[name] = await readCatalog(name);
const run = recordRun({ tools, catalogs, plans, now: new Date().toISOString() });
for (const tool of tools) {
  const entries = run.catalogs[tool.name];
  if (JSON.stringify(entries) !== JSON.stringify(catalogs[tool.name])) await writeCatalog(tool.name, entries);
}
await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'unreleased.json'), `${JSON.stringify(run.unreleased, null, 2)}\n`);
const message = commitMessage(run.changes);
await writeFile(join(values.out, 'commit.txt'), message);
console.log(message ? `recorded:\n${message}` : 'nothing to record');
