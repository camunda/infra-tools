// Usage: node apt.mjs [--suite noble] [--push] [--force] [--registry <repo>] [--platforms linux/amd64,linux/arm64]
// Builds the curated apt repository of one Ubuntu release (apt/<suite>.json) for every platform and tests it. With --push,
// publishes it when its packages changed, as one OCI artifact in the apt-transport-oci layout (one layer per repository file,
// path in org.opencontainers.image.title), and records it in published/apt/<suite>.json.
import { spawn } from 'node:child_process';
import { access, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { args, log, main, readJson, writeJson } from './lib/cli.mjs';
import { DEFAULT_REGISTRY, PLATFORMS, ROOT } from './lib/config.mjs';
import { parsePackages } from './lib/apt.mjs';
import { EMPTY_DIGEST, MEDIA, Registry, sha256 } from './lib/registry.mjs';

const APT_ARTIFACT = 'application/vnd.camunda.infra-tools.apt.v1+json';

const exists = (path) => access(path).then(() => true, () => false);

function bake(definition, targets) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['buildx', 'bake', '-f', definition, '--progress=plain', ...targets], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`bake ${targets.join(' ')} failed (${code})`))));
  });
}

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out.sort();
}

main(async () => {
  const opts = args({
    suite: { type: 'string', default: 'noble' },
    push: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    registry: { type: 'string', default: process.env.INFRA_TOOLS_REGISTRY ?? DEFAULT_REGISTRY },
    platforms: { type: 'string', default: PLATFORMS.join(',') },
  });
  const suite = opts.suite;
  const definition = await readJson(join(ROOT, 'apt', `${suite}.json`));
  const requested = Object.keys(definition.packages);
  const tests = Object.values(definition.packages).map((p) => p.test).filter(Boolean).join(' && ') || 'true';
  const platforms = opts.platforms.split(',');
  const arches = platforms.map((p) => p.split('/')[1]);
  const out = join(ROOT, 'build/out/apt', suite);
  await rm(out, { recursive: true, force: true });

  const common = { context: 'build', dockerfile: 'apt.Dockerfile', args: { IMAGE: definition.image, SUITE: suite, PACKAGES: requested.join(' '), ARCHES: arches.join(' '), TESTS: tests } };
  const bakeFile = join(out, 'bake.json');
  await writeJson(bakeFile, {
    target: {
      'apt-debs': { ...common, target: 'debs', platforms, output: [`type=local,dest=${join(out, 'debs')}`] },
      'apt-repo': { ...common, target: 'repo', contexts: { 'platform-debs': join(out, 'debs') }, output: [`type=local,dest=${join(out, 'repo')}`] },
      'apt-test': { ...common, target: 'test', platforms, contexts: { 'platform-debs': join(out, 'debs') }, output: ['type=cacheonly'] },
    },
  });
  log(`apt ${suite}: download ${requested.join(' ')} for ${arches.join(', ')}`);
  await bake(bakeFile, ['apt-debs']);
  if (platforms.length === 1) {
    // A single-platform local export has no per-platform folder; keep the layout the repository stage expects.
    const flat = join(out, 'debs');
    const { rename, mkdir } = await import('node:fs/promises');
    await rename(flat, `${flat}.tmp`);
    await mkdir(flat, { recursive: true });
    await rename(`${flat}.tmp`, join(flat, platforms[0].replace('/', '_')));
  }
  log(`apt ${suite}: build repository and test`);
  await bake(bakeFile, ['apt-repo', 'apt-test']);

  const repo = join(out, 'repo');
  const packages = {};
  for (const arch of arches) {
    packages[arch] = parsePackages((await readFile(join(repo, 'dists', suite, 'main', `binary-${arch}`, 'Packages'))).toString());
  }
  const recordPath = join(ROOT, 'published', 'apt', `${suite}.json`);
  const previous = (await exists(recordPath)) ? await readJson(recordPath) : null;
  const changed = JSON.stringify(previous?.packages) !== JSON.stringify(packages) || JSON.stringify(previous?.requested) !== JSON.stringify(requested);
  log(`apt ${suite}: ${Object.keys(packages[arches[0]]).length} packages per architecture, ${changed ? 'changed' : 'unchanged'}`);
  if (!opts.push) return;
  if (!changed && !opts.force) return;

  const registry = new Registry(opts.registry);
  await registry.ensureBlob(Buffer.from('{}'));
  const layers = [];
  for (const file of await files(repo)) {
    const data = await readFile(file);
    const digest = await registry.ensureBlob(data);
    layers.push({ mediaType: 'application/octet-stream', digest, size: data.length, annotations: { 'org.opencontainers.image.title': relative(repo, file) } });
  }
  const manifest = {
    schemaVersion: 2, mediaType: MEDIA.ociManifest, artifactType: APT_ARTIFACT,
    config: { mediaType: MEDIA.empty, digest: EMPTY_DIGEST, size: 2 },
    layers,
    annotations: { 'io.camunda.infra-tools.apt.suite': suite },
  };
  const digest = sha256(Buffer.from(JSON.stringify(manifest)));
  const tag = `apt-${suite}-${digest.slice(7, 19)}`;
  const { size } = await registry.putManifest(manifest, MEDIA.ociManifest, tag);
  log(`apt ${suite}: pushed ${opts.registry}:${tag}@${digest} (${layers.length} files)`);

  await writeJson(recordPath, { suite, requested, digest, size, tag, packages, publishedAt: new Date().toISOString() });
  const versions = requested.map((p) => `${p} ${packages[arches[0]][p]}`).join(', ');
  await writeJson(join(ROOT, 'build/out/apt', `${suite}-result.json`), { suite, digest, tag, message: `feat(apt): publish ${suite} repository (${versions})` });
});
