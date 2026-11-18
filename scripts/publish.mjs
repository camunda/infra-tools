// Usage: node publish.mjs --image <registry>/<repository> --repository <owner>/<name> --commit <sha> [--out <dir>]
// Reconciler tool releases (spec §5.3, step 3; §5.5): creates the tool release of every tool version in <out>/tool-releases.json
// (record.mjs; default build/out/reconcile), tagged on --commit, the commit its layers were built from (lib/tool-release.mjs).
// A tool release that exists is left as it is. Uses gh and its token (GH_TOKEN or GITHUB_TOKEN).
import { execFileSync } from 'node:child_process';
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

const gh = (input, ...args) => execFileSync('gh', ['api', ...args], { input, encoding: 'utf8' });
// The tool release of a tag, or null when there is none; any other error throws.
function existingRelease(tag) {
  try {
    return JSON.parse(gh('', `repos/${values.repository}/releases/tags/${encodeURIComponent(tag)}`));
  } catch (err) {
    if (/\(HTTP 404\)/.test(err.stderr)) return null;
    throw err;
  }
}

const registry = new Registry(values.image);
const toolReleases = JSON.parse(await readFile(join(values.out, 'tool-releases.json'), 'utf8'));
for (const p of toolReleases) {
  const existing = existingRelease(p.tag);
  if (existing) {
    console.log(`${p.tag}: tool release exists, ${existing.html_url}`);
    continue;
  }
  const release = toolRelease({
    tool: await readToolDefinition(p.tool),
    recorded: p,
    layers: await registry.toolImageLayers(p.tag),
    digest: await registry.digest(p.tag),
    image: values.image,
    repository: values.repository,
    commit: values.commit,
  });
  const created = JSON.parse(gh(JSON.stringify(release), '--method', 'POST', `repos/${values.repository}/releases`, '--input', '-'));
  console.log(`${p.tag}: tool release created, ${created.html_url}`);
}
