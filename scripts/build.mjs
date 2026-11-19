// Usage: node build.mjs <tool> <version> [--push <registry>/<repository>] [--failure <file>]
// Builds the tool image of one tool version into build/out/<tag> (an OCI layout) and runs its test.sh against it on every
// platform (build/docker-bake.hcl). With --push, pushes that tested layout as <tag>, never over an existing tag. Without it (dry
// run), a published version the tool definition no longer publishes is built too, from its catalog entry (lib/build.mjs).
// With --failure, a build or test that fails is handed over to the fix PRs instead of failing (spec §5.3, step 5): its tool,
// version, tag, failing step (build or test) and log excerpt are written to that file as JSON, and to the job summary
// ($GITHUB_STEP_SUMMARY), and it exits successfully. A failed push still fails: it is no failure of the tool version.
import { execFileSync, spawn } from 'node:child_process';
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildTarget } from './lib/build.mjs';
import { failureSummary, logExcerpt } from './lib/fix-pr.mjs';
import { pushOciLayout } from './lib/oci-layout.mjs';
import { Registry } from './lib/registry.mjs';
import { readCatalog, readToolDefinition, ROOT } from './lib/repository.mjs';

const { values, positionals } = parseArgs({ options: { push: { type: 'string' }, failure: { type: 'string' } }, allowPositionals: true });
const [name, version] = positionals;
if (!name || !version) throw new Error('usage: node build.mjs <tool> <version> [--push <registry>/<repository>] [--failure <file>]');
const catalogEntry = values.push ? undefined : (await readCatalog(name)).find((e) => e.version === version);
const target = buildTarget(await readToolDefinition(name), version, { catalogEntry });
const layout = join('build/out', target.tag);
// The build commit, annotated on the tool image (build/docker-bake.hcl).
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

// Keeps the end of a Bake output only, where its error is.
const LOG_LENGTH = 1_000_000;

// Runs a Bake target, its output streamed as it comes; returns the end of that output when it fails, null otherwise.
async function bake(...args) {
  const env = { ...process.env, ...target.args, LAYOUT: layout, REVISION: revision };
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

console.log(`${target.tool} ${target.version}: build and test (${target.tag})`);
await rm(join(ROOT, layout), { recursive: true, force: true });
for (const [step, args] of [['build', ['--provenance=false', 'tool']], ['test', ['test']]]) {
  const log = await bake(...args);
  if (log === null) continue;
  if (!values.failure) throw new Error(`docker buildx bake ${args.at(-1)} failed for ${target.tool} ${target.version}`);
  const failure = { tool: target.tool, version: target.version, tag: target.tag, step, excerpt: logExcerpt(log) };
  await writeFile(values.failure, `${JSON.stringify(failure, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, failureSummary(failure));
  console.log(`::warning title=${target.tool} ${target.version} failed::the ${step} step failed: handed over to its fix PR, see the job summary`);
  process.exit(0);
}
if (values.push) {
  await pushOciLayout(new Registry(values.push), join(ROOT, layout), target.tag);
  console.log(`${target.tool} ${target.version}: pushed ${values.push}:${target.tag}`);
}
