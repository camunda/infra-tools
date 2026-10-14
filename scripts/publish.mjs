// Usage: node publish.mjs [--results results.json] [--commit <sha>] [--update]
// Creates one GitHub release per published tool version, its tag on the commit the layers were built from. --update also
// rewrites existing releases and moves their tag to that commit. Dry run without GITHUB_TOKEN.
import { join } from 'node:path';
import { args, log, main, readJson, writeJson } from './lib/cli.mjs';
import { loadTools, ROOT } from './lib/config.mjs';
import { GitHub } from './lib/github.mjs';
import { Registry } from './lib/registry.mjs';
import { releaseBody, releaseName } from './lib/release.mjs';
import { upstreamSource } from './lib/upstream.mjs';

main(async () => {
  const opts = args({
    results: { type: 'string', default: join(ROOT, 'build/out/results.json') },
    commit: { type: 'string', default: process.env.GITHUB_SHA },
    update: { type: 'boolean', default: false },
  });
  const data = await readJson(opts.results);
  const published = data.results.filter((x) => x.status === 'published');
  const tools = Object.fromEntries((await loadTools([...new Set(published.map((r) => r.tool))])).map((t) => [t.name, t]));
  const registry = new Registry(data.registry);
  const github = new GitHub();
  const repository = process.env.GITHUB_REPOSITORY ?? 'camunda/infra-tools';
  const sources = {};

  for (const r of published) {
    const tool = tools[r.tool];
    sources[r.tool] ??= await upstreamSource(tool);
    const commit = opts.commit ?? r.commit;
    const release = {
      name: releaseName(r),
      body: releaseBody({ r, tool, layers: await registry.lineLayers(r.tag), registry: data.registry, repository, commit, source: sources[r.tool] }),
    };
    if (!github.enabled) {
      log(`dry run: release ${r.tag}\n${release.body}`);
      continue;
    }
    let current = await github.releaseByTag(r.tag);
    if (!current) {
      current = await github.createRelease({ tag_name: r.tag, target_commitish: commit ?? 'main', make_latest: 'false', ...release });
    } else if (opts.update) {
      current = await github.updateRelease(current.id, release);
      if (commit) await github.moveTag(r.tag, commit);
    }
    r.release = current.html_url;
    log(`${r.tag}: ${r.release}`);
  }
  await writeJson(opts.results, data);
});
