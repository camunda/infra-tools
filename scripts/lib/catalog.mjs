// Catalog (published/<tool>.json): the record of every published tool version, written by the reconciler.
import { archOf, isRetired, PLATFORMS } from './tool-definition.mjs';
import { compareVersions, folderVersion } from './versions.mjs';

// Merges published results ({ version, line, revision, tag, platforms }) and the tool's retirements into its catalog entries.
// An entry lists its platforms only when upstream lacks some (D62): none means every platform. Returns the new entries and one
// conventional change per version for the record commit (spec §5.3, step 4): a revision that adds platforms publishes them.
export function mergeCatalog(tool, entries, published, { now = new Date().toISOString() } = {}) {
  const merged = entries.map((e) => ({ ...e }));
  const changes = [];
  for (const result of published) {
    const entry = {
      version: result.version,
      line: result.line,
      folderVersion: folderVersion(result.version),
      revision: result.revision,
      tag: result.tag,
      ...tool.install,
      ...(result.platforms && result.platforms.length < PLATFORMS.length && { platforms: result.platforms }),
      publishedAt: now,
    };
    const only = entry.platforms ? ` for ${entry.platforms.map(archOf).join(', ')}` : '';
    const i = merged.findIndex((e) => e.version === result.version);
    if (i < 0) {
      merged.push(entry);
      changes.push({ type: 'feat', tool: tool.name, text: `publish ${result.version}${only}` });
    } else if (result.revision > merged[i].revision) {
      const added = (entry.platforms ?? PLATFORMS).filter((p) => !(merged[i].platforms ?? PLATFORMS).includes(p));
      merged[i] = entry;
      if (added.length) changes.push({ type: 'feat', tool: tool.name, text: `publish ${result.version} for ${added.map(archOf).join(', ')} (r${result.revision})` });
      else changes.push({ type: 'fix', tool: tool.name, text: `republish ${result.version} (r${result.revision})` });
    }
  }
  // The retired flag follows the tool definition both ways: removing a version from retired restores it.
  for (const e of merged) {
    const retired = isRetired(tool, e.version);
    if (retired && !e.retired) {
      e.retired = true;
      changes.push({ type: 'feat', breaking: true, tool: tool.name, text: `retire ${e.version}` });
    } else if (!retired && e.retired) {
      delete e.retired;
      changes.push({ type: 'feat', tool: tool.name, text: `restore ${e.version}` });
    }
  }
  return { entries: merged.sort((a, b) => compareVersions(a.version, b.version)), changes };
}
