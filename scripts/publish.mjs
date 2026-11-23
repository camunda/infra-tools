// Usage: node publish.mjs --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]
// Reconciler tool releases (spec §5.3, step 3; §5.5): creates the tool release of every tool version in <out>/unreleased.json
// (record.mjs; default build/out/reconcile), tagged on the build commit its tool image carries (lib/tool-release.mjs). A tool
// image without one fails the run before its record commit. A tool release that exists is left as it is. Uses gh and its token
// (GH_TOKEN or GITHUB_TOKEN).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reconcilerOptions } from './lib/reconcile-scripts.mjs';
import { Registry } from './lib/registry.mjs';
import { ghJson, readToolDefinition } from './lib/repository.mjs';
import { imageToolRelease } from './lib/tool-release.mjs';

const values = reconcilerOptions('publish.mjs', { repository: '<owner>/<name>' });

const registry = new Registry(values.image);
const unreleased = JSON.parse(await readFile(join(values.out, 'unreleased.json'), 'utf8'));
for (const recorded of unreleased) {
  // null when the tool release does not exist yet.
  const existing = ghJson(`repos/${values.repository}/releases/tags/${encodeURIComponent(recorded.tag)}`);
  if (existing) {
    console.log(`${recorded.tag}: tool release exists, ${existing.html_url}`);
    continue;
  }
  const release = await imageToolRelease({ tool: await readToolDefinition(recorded.tool), recorded, registry, repository: values.repository });
  let created;
  try {
    created = ghJson(`repos/${values.repository}/releases`, { method: 'POST', body: release });
  } catch (err) {
    // A retried create GitHub had applied (a 502 after creating it) answers already_exists: the tool release exists.
    created = /already_exists/.test(err.stderr ?? '') && ghJson(`repos/${values.repository}/releases/tags/${encodeURIComponent(recorded.tag)}`);
    if (!created) throw err;
  }
  console.log(`${recorded.tag}: tool release created, ${created.html_url}`);
}
