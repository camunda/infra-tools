// Usage: node index.mjs [--version X.Y.Z] [--previous X.Y.Z] [--registry <repo>] [--out dir] [--dry-run]
// Builds the release index: previous index + published/ entries − retired versions. Pushes the per-platform artifact manifests
// and the <version>-tools index (reusing the line image layers), and writes the release assets and notes.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { args, log, main, writeJson } from './lib/cli.mjs';
import { ANNOTATION, changesMarkdown, diffIndex, mergeIndex, readCatalog, renovateReleases } from './lib/catalog.mjs';
import { archFolder, DEFAULT_REGISTRY, isRetired, loadTools, PLATFORMS, ROOT, releaseVersion } from './lib/config.mjs';
import { EMPTY_DIGEST, MEDIA, Registry } from './lib/registry.mjs';
import { compareVersions } from './lib/versions.mjs';

const ARTIFACT = 'application/vnd.camunda.infra-tools.index.v1+json';
const keys = ['tool', 'version', 'line', 'folder-version', 'revision', 'tag', 'cache-folder', 'arch-folder', 'add-to-path'];
const fields = ['tool', 'version', 'line', 'folderVersion', 'revision', 'tag', 'cacheFolder', 'archFolder', 'addToPath'];

const toAnnotations = (e) => ({
  'org.opencontainers.image.title': `${e.tool}-${e.folderVersion}-${e.archFolder}.tar.gz`,
  ...Object.fromEntries(keys.map((k, i) => [`${ANNOTATION}.${k}`, String(e[fields[i]] ?? '')])),
});

const fromLayer = (platform, layer) => {
  const a = layer.annotations ?? {};
  const e = Object.fromEntries(keys.map((k, i) => [fields[i], a[`${ANNOTATION}.${k}`]]));
  return { ...e, line: e.line || null, revision: Number(e.revision), addToPath: e.addToPath || null, platform, digest: layer.digest, size: layer.size, mediaType: layer.mediaType };
};

async function readIndex(registry, reference) {
  const { json } = await registry.manifest(reference);
  const entries = [];
  for (const m of json.manifests ?? []) {
    const platform = `${m.platform.os}/${m.platform.architecture}`;
    const { json: manifest } = await registry.manifest(m.digest);
    entries.push(...manifest.layers.map((l) => fromLayer(platform, l)));
  }
  return entries;
}

main(async () => {
  const opts = args({
    version: { type: 'string' },
    previous: { type: 'string' },
    registry: { type: 'string', default: process.env.INFRA_TOOLS_REGISTRY ?? DEFAULT_REGISTRY },
    out: { type: 'string', default: join(ROOT, 'build/out/release') },
    'dry-run': { type: 'boolean', default: false },
  });
  const version = opts.version ?? (await releaseVersion());
  const repository = process.env.GITHUB_REPOSITORY ?? 'camunda/infra-tools';
  const registry = new Registry(opts.registry);

  const previous = opts.previous ?? (await registry.tags())
    .map((t) => t.match(/^(\d+\.\d+\.\d+)-tools$/)?.[1])
    .filter((v) => v && compareVersions(v, version) < 0)
    .sort(compareVersions)
    .at(-1);
  const before = previous ? await readIndex(registry, `${previous}-tools`) : [];
  log(`previous index: ${previous ?? 'none'} (${before.length} layers)`);

  const tools = await loadTools();
  const retired = new Set();
  const current = [];
  for (const tool of tools) {
    for (const entry of await readCatalog(tool.name)) {
      if (entry.retired || isRetired(tool, entry.version)) {
        retired.add(`${tool.name}|${entry.version}`);
        continue;
      }
      const layers = await registry.lineLayers(entry.tag);
      for (const platform of PLATFORMS) {
        if (!layers[platform]) throw new Error(`${entry.tag}: no layer for ${platform}`);
        const archFolders = entry.archFolders ?? tool.archFolders;
        current.push({
          tool: tool.name, version: entry.version, line: entry.line ?? null, folderVersion: entry.folderVersion, revision: entry.revision, tag: entry.tag,
          cacheFolder: entry.cacheFolder, archFolder: archFolders[platform.split('/')[1]] ?? archFolder(tool, platform),
          addToPath: entry.addToPath ?? null, platform, digest: layers[platform].digest, size: layers[platform].size, mediaType: layers[platform].mediaType,
        });
      }
    }
  }

  const { entries, errors } = mergeIndex(before, current, retired);
  for (const e of entries.filter((x) => !current.includes(x))) {
    if (!(await registry.exists(e.tag))) errors.push(`${e.tool} ${e.version}: ${e.tag} no longer exists`);
  }
  if (errors.length) throw new Error(errors.join('\n'));

  const changes = diffIndex(before, entries);
  if (!opts['dry-run']) {
    await registry.ensureBlob(Buffer.from('{}'));
    const manifests = [];
    for (const platform of PLATFORMS) {
      const manifest = {
        schemaVersion: 2, mediaType: MEDIA.ociManifest, artifactType: ARTIFACT,
        config: { mediaType: MEDIA.empty, digest: EMPTY_DIGEST, size: 2 },
        layers: entries.filter((e) => e.platform === platform).map((e) => ({ mediaType: e.mediaType, digest: e.digest, size: e.size, annotations: toAnnotations(e) })),
        annotations: { 'org.opencontainers.image.version': version },
      };
      const { digest, size } = await registry.putManifest(manifest, MEDIA.ociManifest);
      const [os, architecture] = platform.split('/');
      manifests.push({ mediaType: MEDIA.ociManifest, artifactType: ARTIFACT, digest, size, platform: { os, architecture } });
    }
    const index = { schemaVersion: 2, mediaType: MEDIA.ociIndex, artifactType: ARTIFACT, manifests, annotations: { 'org.opencontainers.image.version': version } };
    const { digest } = await registry.putManifest(index, MEDIA.ociIndex, `${version}-tools`);
    log(`pushed ${opts.registry}:${version}-tools@${digest}`);
  }

  const toolsJson = {};
  for (const e of entries) ((toolsJson[e.platform] ??= {})[e.tool] ??= {})[e.folderVersion] = { revision: e.revision, tag: e.tag, digest: e.digest, size: e.size };
  await writeJson(join(opts.out, 'tools.json'), toolsJson);
  for (const tool of tools) await writeJson(join(opts.out, `${tool.name}.json`), renovateReleases(entries, tool.name));
  await writeJson(join(opts.out, 'changes.json'), { version, previous: previous ?? null, ...changes });
  await writeFile(join(opts.out, 'changes.md'), changesMarkdown({ version, previous, repository, changes }));
  log(`added ${changes.added.length}, replaced ${changes.replaced.length}, retired ${changes.retired.length}`);
});
