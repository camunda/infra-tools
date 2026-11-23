// Usage: node build.mjs <tool> <version> [--revision <n>] [--platforms <os/arch>,...] [--reuse <tag>]
//          [--push <registry>/<repository>] [--failure <file>]
// Builds the tool image of one tool version into build/out/<tag> (an OCI layout) and runs its test.sh against it on each
// platform of --platforms, every platform by default (build/docker-bake.hcl). --revision: the plan's, the tool definition's by
// default. With --push, pushes that tested layout as <tag>, never over an existing tag; with --reuse, its image index also
// lists the other platforms of that published tool image, as they are (D62). Without --push (dry run), a published version the
// tool definition no longer publishes is built too, from its catalog entry (lib/build.mjs).
// With --failure, a build or test that fails is a tool failure, handed over to its failure issue instead of failing (spec §5.3,
// step 5, ADR 0012): its tool, version, tag, failing step (build or test) and log excerpt are written to that file as JSON, and
// to the job summary ($GITHUB_STEP_SUMMARY), and it exits successfully. A failed push still fails: it is a run failure.
import { execFileSync, spawn } from 'node:child_process';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildTarget } from './lib/build.mjs';
import { pushOciLayout } from './lib/oci-layout.mjs';
import { buildFailureSummary, logExcerpt } from './lib/reconcile-failures.mjs';
import { Registry } from './lib/registry.mjs';
import { readCatalog, readToolDefinition, ROOT } from './lib/repository.mjs';
import { PLATFORMS } from './lib/tool-definition.mjs';

const options = { revision: { type: 'string' }, platforms: { type: 'string' }, reuse: { type: 'string' }, push: { type: 'string' }, failure: { type: 'string' } };
const { values, positionals } = parseArgs({ options, allowPositionals: true });
const [name, version] = positionals;
if (!name || !version) throw new Error('usage: node build.mjs <tool> <version> [--revision <n>] [--platforms <os/arch>,...] [--reuse <tag>] [--push <registry>/<repository>] [--failure <file>]');
const catalogEntry = values.push ? undefined : (await readCatalog(name)).find((e) => e.version === version);
const revision = values.revision ? Number(values.revision) : undefined;
const target = buildTarget(await readToolDefinition(name), version, { catalogEntry, revision });
const platforms = values.platforms || PLATFORMS.join(',');
const layout = join('build/out', target.tag);
// The build commit, annotated on the tool image (build/docker-bake.hcl).
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

// Keeps the end of a Bake output only, where its error is.
const LOG_LENGTH = 1_000_000;

// Runs a Bake target, its output streamed as it comes; returns the end of that output when it fails, null otherwise.
async function bake(...args) {
  const env = { ...process.env, ...target.args, PLATFORMS: platforms, LAYOUT: layout, REVISION: commit };
  const child = spawn('docker', ['buildx', 'bake', '-f', 'build/docker-bake.hcl', '--progress=plain', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    from.on('data', (chunk) => {
      to.write(chunk);
      log = (log + chunk).slice(-LOG_LENGTH);
    });
  }
  const status = await new Promise((resolve, reject) => child.on('error', reject).on('close', resolve));
  return status === 0 ? null : log;
}

console.log(`${target.tool} ${target.version}: build and test on ${platforms} (${target.tag}${values.reuse ? `, other platforms from ${values.reuse}` : ''})`);
await rm(join(ROOT, layout), { recursive: true, force: true });
for (const [step, args] of [['build', ['--provenance=false', 'tool']], ['test', ['test']]]) {
  const log = await bake(...args);
  if (log === null) continue;
  if (!values.failure) throw new Error(`docker buildx bake ${args.at(-1)} failed for ${target.tool} ${target.version}`);
  const failure = { tool: target.tool, version: target.version, tag: target.tag, step, excerpt: logExcerpt(log) };
  await mkdir(dirname(values.failure), { recursive: true });
  await writeFile(values.failure, `${JSON.stringify(failure, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, buildFailureSummary(failure));
  console.log(`::warning title=${target.tool} ${target.version} failed::the ${step} step failed: handed over to its failure issue, see the job summary`);
  process.exit(0);
}
if (values.push) {
  await pushOciLayout(new Registry(values.push), join(ROOT, layout), target.tag, { reuse: values.reuse });
  console.log(`${target.tool} ${target.version}: pushed ${values.push}:${target.tag}`);
}
