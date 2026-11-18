// Release (spec §5.5): its index (D3), every tool version per platform with its layer and tool cache layout, and its
// release notes (D20).
import { archOf, isRetired, PLATFORMS } from './tool-definition.mjs';
import { compareVersions } from './versions.mjs';

// One tool version, and one tool version on one platform.
const versionKey = (e) => `${e.tool}|${e.version}`;
const keyOf = (e) => `${e.platform}|${versionKey(e)}`;

// Index = previous index + catalog entries − retired versions. layers maps each catalog tag to its layer per platform
// ({ 'linux/amd64': { digest, size, mediaType } }). Throws when a catalog version lost its tag or a layer, or when a layer
// changed without a higher revision (published tool images never change, R7).
export function buildIndex({ tools, catalogs, previousIndex, layers }) {
  const merged = new Map(previousIndex.map((e) => [keyOf(e), e]));
  const retired = new Set();
  const errors = [];
  for (const tool of tools) {
    for (const entry of catalogs[tool.name] ?? []) {
      if (entry.retired || isRetired(tool, entry.version)) {
        retired.add(versionKey({ tool: tool.name, version: entry.version }));
        continue;
      }
      const name = `${tool.name} ${entry.version}`;
      const tagLayers = layers[entry.tag];
      if (!tagLayers) {
        errors.push(`${name}: tag ${entry.tag} not found`);
        continue;
      }
      for (const platform of PLATFORMS) {
        const layer = tagLayers[platform];
        if (!layer) {
          errors.push(`${name}: tag ${entry.tag} has no layer for ${platform}`);
          continue;
        }
        const indexEntry = {
          platform,
          tool: tool.name,
          version: entry.version,
          line: entry.line,
          folderVersion: entry.folderVersion,
          revision: entry.revision,
          tag: entry.tag,
          cacheFolder: entry.cacheFolder,
          archFolder: entry.archFolders[archOf(platform)],
          addToPath: entry.addToPath,
          digest: layer.digest,
          size: layer.size,
          mediaType: layer.mediaType,
        };
        const old = merged.get(keyOf(indexEntry));
        if (old && old.digest !== indexEntry.digest && indexEntry.revision <= old.revision) {
          errors.push(`${name} (${platform}): layer changed without a higher revision (r${old.revision} → r${indexEntry.revision})`);
          continue;
        }
        merged.set(keyOf(indexEntry), indexEntry);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return [...merged.values()]
    .filter((e) => !retired.has(versionKey(e)))
    .sort((a, b) => a.tool.localeCompare(b.tool) || compareVersions(a.version, b.version) || a.platform.localeCompare(b.platform));
}

// Tool versions added, replaced (new revision) and retired between two indexes, once per version.
function diffIndex(before, after) {
  const byVersion = (entries) => {
    const versions = new Map();
    for (const e of entries) {
      const key = versionKey(e);
      const item = versions.get(key) ?? { tool: e.tool, version: e.version, line: e.line, revision: e.revision, tag: e.tag, platforms: [], digests: {} };
      item.platforms.push(e.platform);
      item.digests[e.platform] = e.digest;
      versions.set(key, item);
    }
    return versions;
  };
  const [oldVersions, newVersions] = [byVersion(before), byVersion(after)];
  const changes = { added: [], replaced: [], retired: [] };
  for (const [key, item] of newVersions) {
    const old = oldVersions.get(key);
    if (!old) changes.added.push(item);
    else if (JSON.stringify(old.digests) !== JSON.stringify(item.digests)) changes.replaced.push({ ...item, previousRevision: old.revision });
  }
  for (const [key, item] of oldVersions) if (!newVersions.has(key)) changes.retired.push(item);
  return changes;
}

// Release notes of release `version` (none: the next release, previewed on PRs): the Added / Replaced / Retired tables against
// the previous index (D20).
export function releaseNotes({ version, previousVersion, repository, before, after }) {
  const changes = diffIndex(before, after);
  const link = (i) => `[${i.tag}](https://github.com/${repository}/releases/tag/${i.tag})`;
  const arches = (i) => i.platforms.map(archOf).sort().join(', ');
  const out = [`Index: ${version ? `\`${version}-tools\`` : 'next release'}${previousVersion ? `, previous: \`${previousVersion}-tools\`` : ''}`, ''];
  const table = (title, header, rows) => {
    if (!rows.length) return;
    out.push(`### ${title}`, '', `| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
  };
  table('➕ Added', ['Tool', 'Version', 'Line', 'Platforms', 'Tool release'], changes.added.map((i) => [i.tool, i.version, i.line, arches(i), link(i)]));
  table('🔁 Replaced', ['Tool', 'Version', 'Line', 'Revision', 'Tool release'], changes.replaced.map((i) => [i.tool, i.version, i.line, `r${i.previousRevision} → r${i.revision}`, link(i)]));
  table('➖ Retired', ['Tool', 'Version', 'Line', 'Tool release'], changes.retired.map((i) => [i.tool, i.version, i.line, link(i)]));
  if (out.length === 2) out.push('No tool changes.', '');
  return out.join('\n');
}
