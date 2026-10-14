// Usage: node plan.mjs [--tools a,b] [--registry <repo>] [--limit-per-tool N] [--out plan.json] [--check] [--skip-registry]
// Lists upstream versions in range, drops tracked ones (fix PRs) and keeps those whose tag is missing from the registry.
// --check fails when anything is left to publish: the completeness check after a reconciler run.
// --skip-registry plans every candidate without checking published tags (local builds).
import { join } from 'node:path';
import { args, log, main, writeJson } from './lib/cli.mjs';
import { archFoldersArg, DEFAULT_REGISTRY, dockerfileFor, loadTools, revisionOf, ROOT } from './lib/config.mjs';
import { LABEL, trackedVersions } from './lib/fixpr.mjs';
import { GitHub } from './lib/github.mjs';
import { Registry } from './lib/registry.mjs';
import { upstreamVersions } from './lib/upstream.mjs';
import { folderVersion, tagFor } from './lib/versions.mjs';

main(async () => {
  const opts = args({
    tools: { type: 'string' },
    registry: { type: 'string', default: process.env.INFRA_TOOLS_REGISTRY ?? DEFAULT_REGISTRY },
    'limit-per-tool': { type: 'string' },
    out: { type: 'string', default: join(ROOT, 'build/out/plan.json') },
    check: { type: 'boolean', default: false },
    'skip-registry': { type: 'boolean', default: false },
  });
  const tools = await loadTools(opts.tools?.split(','));
  const registry = new Registry(opts.registry);
  const github = new GitHub();
  const tracked = github.enabled ? trackedVersions(await github.labeledPulls(LABEL)) : { open: new Map(), ignored: new Map() };
  if (!github.enabled) log('GITHUB_TOKEN not set: fix PRs not checked');

  const plan = { registry: opts.registry, generatedAt: new Date().toISOString(), items: [], tools: {} };
  for (const tool of tools) {
    const { eligible, waiting, incomplete, lines } = await upstreamVersions(tool);
    const summary = { eligible: eligible.length, published: 0, planned: [], tracked: [], ignored: [], waiting, incomplete };
    let candidates = eligible.filter((v) => {
      const key = `${tool.name}|${v}`;
      if (tracked.open.has(key)) return summary.tracked.push(v), false;
      if (tracked.ignored.has(key)) return summary.ignored.push(v), false;
      return true;
    });
    if (opts['limit-per-tool']) candidates = candidates.slice(0, Number(opts['limit-per-tool']));
    for (const version of candidates) {
      const revision = revisionOf(tool, version);
      const tag = tagFor(tool.name, version, revision);
      if (!opts['skip-registry'] && (await registry.exists(tag))) {
        summary.published++;
        continue;
      }
      summary.planned.push(version);
      plan.items.push({
        tool: tool.name,
        version,
        line: lines[version] ?? null,
        folderVersion: folderVersion(version),
        revision,
        tag,
        cacheFolder: tool.cacheFolder,
        archFolders: archFoldersArg(tool),
        dockerfile: await dockerfileFor(tool.name),
      });
    }
    plan.tools[tool.name] = summary;
    log(`${tool.name}: ${eligible.length} in range, ${summary.published} published, ${summary.planned.length} to build` +
      `${summary.tracked.length ? `, ${summary.tracked.length} in fix PRs` : ''}${summary.ignored.length ? `, ${summary.ignored.length} ignored` : ''}` +
      `${waiting.length ? `, waiting: ${waiting.join(' ')}` : ''}${incomplete.length ? `, incomplete platforms: ${incomplete.join(' ')}` : ''}`);
  }
  await writeJson(opts.out, plan);
  if (opts.check && plan.items.length) {
    throw new Error(`not published and not tracked: ${plan.items.map((i) => `${i.tool} ${i.version}`).join(', ')}`);
  }
});
