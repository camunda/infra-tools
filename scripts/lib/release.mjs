// Release (spec §5.5): its index (D3), every tool version per platform with its layer and tool cache layout, and its
// release notes (D20).
import { archOf, isRetired, PLATFORMS } from './tool-definition.mjs';
import { compareVersions } from './versions.mjs';

// The tag name of a release X.Y.Z (tool releases are named after their tool image).
export const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

// The version X.Y.Z of the latest published release (ADR 0013), the one the action tests and the release notes preview read,
// from GitHub's latest release (GET /releases/latest, null when missing): never a draft, so never an index pushed before its
// release is published. Tool releases are never marked latest. Throws when there is none.
export function latestReleaseVersion(release) {
  if (!release) throw new Error('no published release: GitHub has no latest release');
  if (!RELEASE_VERSION.test(release.tag_name)) throw new Error(`the latest GitHub release ${release.tag_name} is not a release X.Y.Z: mark the latest X.Y.Z as latest`);
  return release.tag_name;
}

// The releases (X.Y.Z, not tool releases) still to publish, oldest first: the drafts, which their publication publishes last, and
// those without an uploaded tools.json, such as a draft published by hand; a failed upload can leave it in the starter state.
// Every draft is one, even when it lost its tag name (an update without it resets it to untagged-<hash>): those come first, so
// their publication fails before any later release, instead of being skipped. releases: GitHub releases ({ tag_name, draft,
// assets: [{ name, state }] }).
export function unpublishedReleases(releases) {
  const versioned = (r) => RELEASE_VERSION.test(r.tag_name);
  const unpublished = releases.filter((r) => r.draft || (versioned(r) && !r.assets.some((a) => a.name === 'tools.json' && a.state === 'uploaded')));
  return [...unpublished.filter((r) => !versioned(r)), ...unpublished.filter(versioned).sort((a, b) => compareVersions(a.tag_name, b.tag_name))];
}

// The release before `version`: the highest X.Y.Z below it among the index tags (X.Y.Z-tools) of the registry, none before the
// first release.
export function previousRelease(tags, version) {
  return releaseVersions(tags)
    .filter((v) => compareVersions(v, version) < 0)
    .at(-1);
}

// The releases X.Y.Z of the index tags (X.Y.Z-tools) among the tags of the registry, oldest first.
export const releaseVersions = (tags) =>
  tags
    .map((t) => t.match(/^(\d+\.\d+\.\d+)-tools$/)?.[1])
    .filter(Boolean)
    .sort(compareVersions);

// One tool version, and one tool version on one platform.
const versionKey = (e) => `${e.tool}|${e.version}`;
const keyOf = (e) => `${e.platform}|${versionKey(e)}`;

// Index = previous index + catalog entries − retired versions. layers maps each catalog tag to its layer per platform
// ({ 'linux/amd64': { digest, size, mediaType } }): a tool image holds the platforms upstream had when it was built (D62).
// Throws when a catalog version lost its tag or a layer of its platforms, or when a layer changed without a higher revision
// (published tool images never change, R7).
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
      for (const platform of entry.platforms ?? PLATFORMS) {
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

// tools.json, the release asset for people and scripts (ADR 0004): every tool version of the index entries of release
// `version`, per platform with its layer digest and size.
export function toolsJson({ version, image, entries }) {
  const tools = {};
  for (const e of entries) {
    const versions = (tools[e.tool] ??= []);
    let item = versions.find((v) => v.version === e.version);
    if (!item) versions.push((item = { version: e.version, line: e.line, revision: e.revision, tag: e.tag, platforms: {} }));
    item.platforms[e.platform] = { digest: e.digest, size: e.size };
  }
  const sorted = Object.keys(tools).sort().map((tool) => [tool, tools[tool].sort((a, b) => compareVersions(a.version, b.version))]);
  return { release: version, index: `${image}:${version}-tools`, tools: Object.fromEntries(sorted) };
}

// Marks the tool tables in the notes of a release, so a rerun replaces them.
const TOOLS_MARKER = '<!-- infra-tools: tools -->';

// The body of a release: its release-please changelog (body; null when empty), then the release notes (releaseNotes).
export function releaseBody(body, notes) {
  const changelog = (body ?? '').split(TOOLS_MARKER)[0].trimEnd();
  return `${changelog ? `${changelog}\n\n` : ''}${TOOLS_MARKER}\n## Tools\n\n${notes}`;
}
