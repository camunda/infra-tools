// Build of one tool version (spec §5.2): the tool image tag and the arguments build/docker-bake.hcl reads.
import { isRetired, lineFor, revisionOf } from './tool-definition.mjs';
import { compareVersions, folderVersion, tagFor } from './versions.mjs';

// Throws when the tool definition does not publish the version: in no line, ignored, retired, or neither pinned (versions,
// revisions) nor at or above its line's from. Upstream stability and minAge are the plan's to check.
// catalogEntry: the version's catalog entry, for dry runs only (spec §5.4): a published version the tool definition no longer
// publishes (fixed pin replaced, line stopped or removed, from raised) is still built, with its catalog line and revision,
// unless the tool definition retires it: one it restores is built while the catalog still marks it retired (mergeCatalog).
export function buildTarget(tool, version, { catalogEntry } = {}) {
  const where = `tools/${tool.name}/tool.json`;
  const line = lineFor(tool, version);
  let key = line?.key;
  let revision = revisionOf(tool, version);
  const unpublished = unpublishedReason(tool, version, line);
  if (unpublished) {
    if (!catalogEntry || isRetired(tool, version)) throw new Error(`${where}: ${tool.name} ${version} ${unpublished}`);
    ({ line: key, revision } = catalogEntry);
  }
  const { cacheFolder, archFolders } = tool.install;
  return {
    tool: tool.name,
    version,
    line: key,
    revision,
    tag: tagFor(tool.name, version, revision),
    args: {
      TOOL: tool.name,
      VERSION: version,
      FOLDER_VERSION: folderVersion(version),
      CACHE_FOLDER: cacheFolder,
      ARCH_FOLDERS: Object.entries(archFolders).map(([arch, folder]) => `${arch}=${folder}`).join(' '),
    },
  };
}

// Why the tool definition does not publish a version, or undefined when it does.
function unpublishedReason(tool, version, line) {
  if (!line) return 'is in no version line';
  if (line.ignoredVersions?.includes(version)) return `is ignored in line ${line.key}`;
  if (isRetired(tool, version)) return `is retired in line ${line.key}`;
  const pinned = line.versions?.includes(version) || line.revisions?.[version];
  if (!pinned && !(line.from && compareVersions(version, line.from) >= 0)) return `is not published by line ${line.key}`;
  return undefined;
}
