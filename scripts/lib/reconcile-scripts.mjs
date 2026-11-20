// Shared by the reconciler scripts (plan.mjs, record.mjs, publish.mjs, fix-pr.mjs): their options and the plan of every tool.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { planTool } from './plan.mjs';
import { readCatalog, readToolDefinition, readToolNames, ROOT } from './repository.mjs';

// Options of a reconciler script: --image <registry>/<repository>, the script's own required options (e.g. { repository:
// '<owner>/<name>' }, name to value in its usage), --out <dir> (default build/out/reconcile) and its own flags (e.g. ['check'],
// false unless given). Throws its usage when one is missing.
export function reconcilerOptions(script, required = {}, flags = []) {
  const names = ['image', ...Object.keys(required)];
  const { values } = parseArgs({
    options: {
      ...Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
      ...Object.fromEntries(flags.map((name) => [name, { type: 'boolean', default: false }])),
      out: { type: 'string', default: join(ROOT, 'build/out/reconcile') },
    },
  });
  if (names.some((name) => !values[name])) {
    const usage = ['--image <registry>/<repository>', ...Object.entries(required).map(([name, value]) => `--${name} ${value}`), ...flags.map((name) => `[--${name}]`), '[--out <dir>]'];
    throw new Error(`usage: node ${script} ${usage.join(' ')}`);
  }
  return values;
}

// Every tool definition, and its catalog entries and its plan by tool name against upstream and the published tags in registry
// (Registry), which it returns too (a Set). fixPrs: the versions fix PRs track, by tool (lib/fix-pr.mjs trackedVersions), none
// by default.
export async function planEveryTool(registry, { fixPrs = {} } = {}) {
  const tools = await Promise.all((await readToolNames()).map(readToolDefinition));
  const tags = new Set(await registry.tags());
  const options = { tags, platformsOf: (tag) => registry.toolImagePlatforms(tag), now: Date.now() };
  const catalogs = {};
  const plans = {};
  for (const tool of tools) {
    catalogs[tool.name] = await readCatalog(tool.name);
    plans[tool.name] = await planTool(tool, { ...options, fixPrs: fixPrs[tool.name] });
  }
  return { tools, catalogs, plans, tags };
}
