// Usage: node build.mjs <tool> <version> [--push <registry>/<repository>]
// Builds the tool image of one tool version into build/out/<tag> (an OCI layout) and runs its test.sh against it on every
// platform (build/docker-bake.hcl). With --push, pushes that tested layout as <tag>, never over an existing tag. Without it (dry
// run), a published version the tool definition no longer publishes is built too, from its catalog entry (lib/build.mjs).
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildTarget } from './lib/build.mjs';
import { pushOciLayout } from './lib/oci-layout.mjs';
import { Registry } from './lib/registry.mjs';
import { readCatalog, readToolDefinition, ROOT } from './lib/repository.mjs';

const { values, positionals } = parseArgs({ options: { push: { type: 'string' } }, allowPositionals: true });
const [name, version] = positionals;
if (!name || !version) throw new Error('usage: node build.mjs <tool> <version> [--push <registry>/<repository>]');
const published = values.push ? undefined : (await readCatalog(name)).find((e) => e.version === version);
const target = buildTarget(await readToolDefinition(name), version, { published });
const layout = join('build/out', target.tag);

const bake = (...args) => {
  const env = { ...process.env, ...target.args, LAYOUT: layout };
  const { status } = spawnSync('docker', ['buildx', 'bake', '-f', 'build/docker-bake.hcl', '--progress=plain', ...args], { cwd: ROOT, env, stdio: 'inherit' });
  if (status !== 0) throw new Error(`docker buildx bake ${args.at(-1)} failed for ${target.tool} ${target.version}`);
};

console.log(`${target.tool} ${target.version}: build and test (${target.tag})`);
await rm(join(ROOT, layout), { recursive: true, force: true });
bake('--provenance=false', 'tool');
bake('test');
if (values.push) {
  await pushOciLayout(new Registry(values.push), join(ROOT, layout), target.tag);
  console.log(`${target.tool} ${target.version}: pushed ${values.push}:${target.tag}`);
}
