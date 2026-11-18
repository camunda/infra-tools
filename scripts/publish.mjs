// Usage: node publish.mjs --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]
// Reconciler tool releases (spec §5.3, step 3; §5.5): creates the tool release of every tool version in <out>/tool-releases.json
// (record.mjs; default build/out/reconcile), tagged on the build commit its tool image carries (lib/tool-release.mjs). A tool
// image without one gets no tool release, with a workflow warning; the version is still recorded. A tool release that exists
// is left as it is. Uses gh and its token (GH_TOKEN or GITHUB_TOKEN).
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reconcilerOptions } from './lib/reconcile-scripts.mjs';
import { Registry } from './lib/registry.mjs';
import { readToolDefinition } from './lib/repository.mjs';
import { BUILD_COMMIT, imageToolRelease } from './lib/tool-release.mjs';

const values = reconcilerOptions('publish.mjs', { repository: '<owner>/<name>' });

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
  const release = await imageToolRelease({ tool: await readToolDefinition(p.tool), recorded: p, registry, repository: values.repository });
  if (!release) {
    console.log(`::warning title=No tool release::${p.tag}: its tool image has no build commit (${BUILD_COMMIT} annotation), so no tool release`);
    continue;
  }
  const created = JSON.parse(gh(JSON.stringify(release), '--method', 'POST', `repos/${values.repository}/releases`, '--input', '-'));
  console.log(`${p.tag}: tool release created, ${created.html_url}`);
}
