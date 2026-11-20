// Usage: node plan.mjs --image <registry>/<repository> --repository <owner>/<name> [--check] [--out <dir>]
// Reconciler plan (spec §5.3, step 1): plans every tool against upstream, the published tags in --image (lib/plan.mjs) and the
// fix PRs of --repository (lib/fix-pr.mjs, with gh and its token), and checks that every catalog version still has its tag
// (lib/reconcile.mjs). Writes <out>/builds.json (default build/out/reconcile), the tool versions to build, test and push
// ([{ tool, version, revision, tag, platforms, reuse, reason }], reuse empty unless it adds platforms, D62), versions of open fix
// PRs included. An upstream or registry outage fails it, never reads
// as "nothing to publish".
// With --check, the completeness check (step 6, R17) instead, once the run's builds are recorded and its failures are in fix
// PRs: fails when a version in range is neither published nor tracked; writes nothing. It also warns, in the job summary, of
// versions upstream still lacks a platform for 7 days or more after their release (D62).
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIX_PR_LABEL, trackedVersions } from './lib/fix-pr.mjs';
import { checkCatalogTags, checkCompleteness, latePlatforms } from './lib/reconcile.mjs';
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
  const late = latePlatforms(plans, Date.now());
  for (const l of late) console.log(`::warning title=Platform missing upstream::${l}`);
  if (late.length && process.env.GITHUB_STEP_SUMMARY) {
    const summary = ['## Platforms missing upstream', '', 'Published on the other platforms; each platform is added as a new revision once upstream has it (D62).', '', ...late.map((l) => `- ${l}`), ''];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
  checkCompleteness(plans);
  console.log('complete: every version in range is published or tracked');
} else {
  const builds = tools.flatMap(({ name }) =>
    plans[name].versions
      .filter((v) => v.decision === 'publish')
      .map((v) => ({ tool: name, version: v.version, revision: v.revision, tag: v.tag, platforms: v.platforms.join(','), reuse: v.reuse ?? '', reason: v.reason })),
  );
  await mkdir(values.out, { recursive: true });
  await writeFile(join(values.out, 'builds.json'), `${JSON.stringify(builds, null, 2)}\n`);
  console.log(builds.length ? `to publish: ${builds.map((b) => `${b.tool} ${b.version} (${b.reason})`).join(', ')}` : 'nothing to publish');
}
