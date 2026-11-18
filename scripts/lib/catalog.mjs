// Catalog (published/<tool>.json): the record of every published tool version, written by the reconciler.
import { isRetired } from './tool-definition.mjs';
import { compareVersions, folderVersion } from './versions.mjs';

// Merges published results ({ version, line, revision, tag }) and the tool's retirements into its catalog entries.
// Returns the new entries and one conventional change per version for the record commit (spec §5.3, step 4).
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
      publishedAt: now,
    };
    const i = merged.findIndex((e) => e.version === result.version);
    if (i < 0) {
      merged.push(entry);
      changes.push({ type: 'feat', tool: tool.name, text: `publish ${result.version}` });
    } else if (result.revision > merged[i].revision) {
      merged[i] = entry;
      changes.push({ type: 'fix', tool: tool.name, text: `republish ${result.version} (r${result.revision})` });
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
