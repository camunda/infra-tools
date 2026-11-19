// Usage: node plan.mjs --image <registry>/<repository> --repository <owner>/<name> [--check] [--out <dir>]
// Reconciler plan (spec §5.3, step 1): plans every tool against upstream, the published tags in --image (lib/plan.mjs) and the
// fix PRs of --repository (lib/fix-pr.mjs, with gh and its token), and checks that every catalog version still has its tag
// (lib/reconcile.mjs). Writes <out>/builds.json (default build/out/reconcile), the tool versions to build, test and push
// ([{ tool, version, tag, reason }]), versions of open fix PRs included. An upstream or registry outage fails it, never reads
// as "nothing to publish".
// With --check, the completeness check (step 6, R17) instead, once the run's builds are recorded and its failures are in fix
// PRs: fails when a version in range is neither published nor tracked; writes nothing.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIX_PR_LABEL, trackedVersions } from './lib/fix-pr.mjs';
import { checkCatalogTags, checkCompleteness } from './lib/reconcile.mjs';
import { planEveryTool, reconcilerOptions } from './lib/reconcile-scripts.mjs';
import { Registry, tagExists } from './lib/registry.mjs';
import { readPullRequests } from './lib/repository.mjs';

const values = reconcilerOptions('plan.mjs', { repository: '<owner>/<name>' }, ['check']);

const registry = new Registry(values.image);
const { tools, catalogs, plans } = await planEveryTool(registry, { fixPrs: trackedVersions(readPullRequests(values.repository, FIX_PR_LABEL)) });
await checkCatalogTags({ catalogs, tagExists: tagExists(registry) });

for (const { name } of tools) {
  for (const v of plans[name].versions) if (v.decision === 'wait') console.log(`${name} ${v.version}: waits, ${v.reason}`);
}
if (values.check) {
  checkCompleteness(plans);
  console.log('complete: every version in range is published or tracked');
} else {
  const builds = tools.flatMap(({ name }) => plans[name].versions.filter((v) => v.decision === 'publish').map((v) => ({ tool: name, version: v.version, tag: v.tag, reason: v.reason })));
  await mkdir(values.out, { recursive: true });
  await writeFile(join(values.out, 'builds.json'), `${JSON.stringify(builds, null, 2)}\n`);
  console.log(builds.length ? `to publish: ${builds.map((b) => `${b.tool} ${b.version} (${b.reason})`).join(', ')}` : 'nothing to publish');
}
