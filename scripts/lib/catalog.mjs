// Catalog (published/<tool>.json): the record of every published tool version, written by the reconciler.
import { isRetired } from './tool-definition.mjs';
import { compareVersions, folderVersion } from './versions.mjs';

// Merges published results ({ version, line, revision, tag }) and the tool's retirements into its catalog entries.
// Returns the new entries and one conventional change per version for the record commit (spec §5.3, step 4).
export function mergeCatalog(tool, entries, published, { now = new Date().toISOString() } = {}) {
  const next = entries.map((e) => ({ ...e }));
  const changes = [];
  for (const r of published) {
    const entry = {
      version: r.version,
      line: r.line,
      folderVersion: folderVersion(r.version),
      revision: r.revision,
      tag: r.tag,
      ...tool.install,
      publishedAt: now,
    };
    const i = next.findIndex((e) => e.version === r.version);
    if (i < 0) {
      next.push(entry);
      changes.push({ type: 'feat', tool: tool.name, text: `publish ${r.version}` });
    } else if (r.revision > next[i].revision) {
      next[i] = entry;
      changes.push({ type: 'fix', tool: tool.name, text: `republish ${r.version} (r${r.revision})` });
    }
  }
  for (const e of next) {
    if (!e.retired && isRetired(tool, e.version)) {
      e.retired = true;
      changes.push({ type: 'feat', breaking: true, tool: tool.name, text: `retire ${e.version}` });
    }
  }
  return { entries: next.sort((a, b) => compareVersions(a.version, b.version)), changes };
}
