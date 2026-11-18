// Usage: node publish.mjs --image <registry>/<repository> --repository <owner>/<name> --commit <sha> [--out <dir>]
// Reconciler tool releases (spec §5.3, step 3; §5.5): creates the tool release of every tool version in <out>/published.json
// (record.mjs; default build/out/reconcile), tagged on --commit, the commit its layers were built from (lib/tool-release.mjs).
// A tool release that exists is left as it is. Uses the GitHub token in GH_TOKEN or GITHUB_TOKEN.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Registry } from './lib/registry.mjs';
import { readToolDefinition, ROOT } from './lib/repository.mjs';
import { toolRelease } from './lib/tool-release.mjs';

const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    repository: { type: 'string' },
    commit: { type: 'string' },
    out: { type: 'string', default: join(ROOT, 'build/out/reconcile') },
  },
});
if (!values.image || !values.repository || !values.commit) {
  throw new Error('usage: node publish.mjs --image <registry>/<repository> --repository <owner>/<name> --commit <sha> [--out <dir>]');
}

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
// GitHub REST API call on the repository; null on 404 when allowed, any other error throws.
async function github(method, path, { body, allow404 = false } = {}) {
  const res = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${values.repository}${path}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    body: body && JSON.stringify(body),
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const registry = new Registry(values.image);
const published = JSON.parse(await readFile(join(values.out, 'published.json'), 'utf8'));
for (const p of published) {
  const existing = await github('GET', `/releases/tags/${encodeURIComponent(p.tag)}`, { allow404: true });
  if (existing) {
    console.log(`${p.tag}: tool release exists, ${existing.html_url}`);
    continue;
  }
  const release = toolRelease({
    tool: await readToolDefinition(p.tool),
    published: p,
    layers: await registry.toolImageLayers(p.tag),
    digest: await registry.digest(p.tag),
    image: values.image,
    repository: values.repository,
    commit: values.commit,
  });
  const created = await github('POST', '/releases', { body: release });
  console.log(`${p.tag}: tool release created, ${created.html_url}`);
}
