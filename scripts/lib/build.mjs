// Build of one tool version (spec §5.2): the tool image tag and the arguments build/docker-bake.hcl reads.
import { isRetired, lineFor, revisionOf } from './tool-definition.mjs';
import { folderVersion, tagFor } from './versions.mjs';

// Throws when the tool definition does not publish the version: in no line, ignored or retired.
export function buildTarget(tool, version) {
  const where = `tools/${tool.name}/tool.json`;
  const line = lineFor(tool, version);
  if (!line) throw new Error(`${tool.name} ${version} is in no version line of ${where}`);
  if (line.ignoredVersions?.includes(version)) throw new Error(`${tool.name} ${version} is ignored in line ${line.key} of ${where}`);
  if (isRetired(tool, version)) throw new Error(`${tool.name} ${version} is retired in line ${line.key} of ${where}`);
  const revision = revisionOf(tool, version);
  const { cacheFolder, archFolders } = tool.install;
  return {
    tool: tool.name,
    version,
    line: line.key,
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
