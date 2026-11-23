// Usage: node plan.mjs --image <registry>/<repository> [--check] [--failures <dir>] [--out <dir>]
// Reconciler plan (spec §5.3, step 1): plans every tool against upstream and the published tags in --image (lib/plan.mjs), and
// checks that every catalog version still has its tag (lib/reconcile.mjs). Reads no GitHub state (ADR 0012). Writes
// <out>/builds.json (default build/out/reconcile), the tool versions to build, test and push ([{ tool, version, revision, tag,
// platforms, reuse, reason }], reuse empty unless it adds platforms, D62), versions that failed in earlier runs included. An
// upstream or registry outage fails it, never reads as "nothing to publish".
// With --check, the completeness check (step 6, R17) instead, once the run's builds are recorded, against the run's plan in
// <out>/builds.json: the tool failures build.mjs --failure wrote to --failures (one JSON file per failed tool version; the
// folder is missing when none failed) are written as failure issue reports to <out>/reports/ (one per tool and major), with a
// push report for each build job that failed without writing its own there (reconcile-push-<tag>.json; one an earlier attempt
// left before a rerun published the version is removed), and the failure issue keys the run checked to
// <out>/resolve.txt, one per line (lib/reconcile-failures.mjs), for failure-issues.mjs; then it fails when a version the run
// built is neither published nor failed. It also warns, in the job summary, of versions upstream still lacks a platform for 7
// days or more after their release (D62).
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkCatalogTags, latePlatforms } from './lib/reconcile.mjs';
import { reconcileFailures } from './lib/reconcile-failures.mjs';
import { planEveryTool, reconcilerOptions } from './lib/reconcile-scripts.mjs';
import { Registry, tagExists } from './lib/registry.mjs';
import { readJsonFiles } from './lib/repository.mjs';

const values = reconcilerOptions('plan.mjs', {}, ['check'], { failures: '<dir>' });

const registry = new Registry(values.image);
const { tools, catalogs, plans } = await planEveryTool(registry);
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
  const builds = JSON.parse(await readFile(join(values.out, 'builds.json'), 'utf8'));
  const reportsDir = join(values.out, 'reports');
  const reported = (await readJsonFiles(reportsDir)).filter((r) => r.key.step === 'push').flatMap((r) => Object.keys(r.errors));
  const { reports, resolve, gaps, stale } = reconcileFailures({ plans, builds, failures: await readJsonFiles(values.failures), reported });
  for (const tag of stale) {
    await rm(join(reportsDir, `reconcile-push-${tag}.json`), { force: true });
    console.log(`run failure: push of ${tag} recovered by a rerun, its earlier report dropped`);
  }
  await mkdir(reportsDir, { recursive: true });
  for (const report of reports) {
    const { tool, major, step } = report.key;
    const [subject] = Object.keys(report.errors);
    await writeFile(join(reportsDir, tool ? `tool-${tool}-${major}.json` : `reconcile-${step}-${subject}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(tool ? `tool failure: ${tool} ${major}, ${Object.keys(report.errors).join(', ')}` : `run failure: ${step} of ${subject}, its build job failed without reporting`);
  }
  await writeFile(join(values.out, 'resolve.txt'), resolve.map((scope) => `${scope}\n`).join(''));
  if (gaps.length) throw new Error(`versions this run built neither published nor failed with their failure issue (R17), see their build jobs in this run:\n${gaps.join('\n')}`);
  console.log('complete: every version this run built is published or failed');
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
