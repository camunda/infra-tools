// Usage: node build.mjs <tool> <version> [--push <registry>/<repository>]
// Builds the tool image of one tool version and runs its test.sh on every platform (build/docker-bake.hcl). With --push,
// pushes it as <tool>-<version>-r<revision>, never over an existing tag.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildTarget } from './lib/build.mjs';
import { Registry } from './lib/registry.mjs';
import { readToolDefinition, ROOT } from './lib/repository.mjs';

const { values, positionals } = parseArgs({ options: { push: { type: 'string' } }, allowPositionals: true });
const [name, version] = positionals;
if (!name || !version) throw new Error('usage: node build.mjs <tool> <version> [--push <registry>/<repository>]');
const target = buildTarget(await readToolDefinition(name), version);

const bake = (...args) => {
  const env = { ...process.env, ...target.args, IMAGE: values.push ? `${values.push}:${target.tag}` : '' };
  const { status } = spawnSync('docker', ['buildx', 'bake', '-f', 'build/docker-bake.hcl', '--progress=plain', ...args], { cwd: ROOT, env, stdio: 'inherit' });
  if (status !== 0) throw new Error(`docker buildx bake ${args.at(-1)} failed for ${target.tool} ${target.version}`);
};

console.log(`${target.tool} ${target.version}: build and test (${target.tag})`);
bake('test');
if (values.push) {
  if (await new Registry(values.push).exists(target.tag)) {
    throw new Error(`${values.push}:${target.tag} already exists; published tool images never change: bump the revision of ${version}`);
  }
  bake('--provenance=false', '--set', 'tool.output=type=registry,oci-mediatypes=true', 'tool');
  console.log(`${target.tool} ${target.version}: pushed ${values.push}:${target.tag}`);
}
