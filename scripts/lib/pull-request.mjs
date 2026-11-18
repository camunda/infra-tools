// Pull request checks (spec §5.4): what a PR changing tools or their build would publish, before it is merged.
import { buildTarget } from './build.mjs';
import { mergeCatalog } from './catalog.mjs';
import { planTool } from './plan.mjs';
import { buildIndex, releaseNotes } from './release.mjs';
import { PLATFORMS } from './tool-definition.mjs';
import { compareVersions, majorOf } from './versions.mjs';

// Files every tool version is built or tested with (build/docker-bake.hcl, scripts/build.mjs).
const SHARED_BUILD = ['build/', 'scripts/build.mjs', 'scripts/lib/build.mjs'];

// Tool files: tools/<tool>/..., plus the shared build.
const toolFiles = (tool, changedFiles) => changedFiles.filter((file) => file.startsWith(`tools/${tool.name}/`) || SHARED_BUILD.some((p) => file.startsWith(p)));

// Changed tool files that change its tool images: not its tests, and tool.json only when its install block changed (the
// publish block decides which versions are built, not what they hold).
function imageFiles(tool, files, base) {
  const test = [`tools/${tool.name}/test.sh`, 'build/test.Dockerfile'];
  return files
    .filter((file) => !test.includes(file))
    .flatMap((file) => {
      if (file !== `tools/${tool.name}/tool.json`) return [file];
      return JSON.stringify(base?.install) === JSON.stringify(tool.install) ? [] : [`${file} (install)`];
    });
}

// tools: every tool definition at the PR head; baseTools: the PR base's, by name. changedFiles: paths changed by the PR.
// lookup, tagExists, now: as planTool's. catalogs: the catalog entries of every tool, by name. previousIndex and
// previousVersion: the index and version of the latest release (none: [] and undefined). toolImageLayers(tag): the layers of a
// published tool image (Registry.toolImageLayers). repository: owner/name, for tool release links.
// Returns:
// - builds: the dry run, the planned versions of every changed tool plus its latest published version per major;
// - warnings: published versions whose build files changed without a revision bump (published tool images never change);
// - notes: the release notes of the next release once the planned versions are published, or null when no tool changed.
export async function checkPullRequest({ tools, baseTools, changedFiles, lookup, tagExists, now, catalogs, previousIndex, previousVersion, toolImageLayers, repository }) {
  const builds = [];
  const warnings = [];
  const planned = {};
  const changedTools = tools.filter((t) => toolFiles(t, changedFiles).length);
  for (const tool of changedTools) {
    const plan = await planTool(tool, { lookup, tagExists, now });
    planned[tool.name] = plan.versions.filter((v) => v.decision === 'publish');
    const published = plan.versions.filter((v) => v.reason === 'published');
    const changed = imageFiles(tool, toolFiles(tool, changedFiles), baseTools[tool.name]);
    if (changed.length && published.length) {
      const versions = published.map((v) => `${v.version} (${buildTarget(tool, v.version).tag})`);
      warnings.push(`${tool.name}: ${changed.join(', ')} changed, but these published versions keep their tool image unless their revision is bumped: ${versions.join(', ')}`);
    }
    const latest = new Map();
    for (const v of published) {
      const m = majorOf(v.version);
      if (!latest.has(m) || compareVersions(v.version, latest.get(m)) > 0) latest.set(m, v.version);
    }
    for (const v of plan.versions) {
      let reason;
      if (v.decision === 'publish') reason = `planned: ${v.reason}`;
      else if (latest.get(majorOf(v.version)) === v.version) reason = `latest published of major ${majorOf(v.version)}`;
      else continue;
      builds.push({ tool: tool.name, version: v.version, tag: buildTarget(tool, v.version).tag, reason });
    }
  }
  if (!changedTools.length) return { builds, warnings, notes: null };

  // The next index as the release would build it, once the reconciler has recorded the planned versions. Planned tool images
  // do not exist yet: their layers are placeholders, new to the index.
  const layers = {};
  for (const e of previousIndex) (layers[e.tag] ??= {})[e.platform] = { digest: e.digest, size: e.size, mediaType: e.mediaType };
  const nextCatalogs = {};
  for (const tool of tools) {
    const toPublish = planned[tool.name] ?? [];
    nextCatalogs[tool.name] = mergeCatalog(tool, catalogs[tool.name] ?? [], toPublish, { now: new Date(now).toISOString() }).entries;
    for (const { tag } of toPublish) layers[tag] = Object.fromEntries(PLATFORMS.map((p) => [p, { digest: `planned:${tag}`, size: 0, mediaType: null }]));
    for (const e of nextCatalogs[tool.name]) if (!e.retired && !layers[e.tag]) layers[e.tag] = await toolImageLayers(e.tag);
  }
  const after = buildIndex({ tools, catalogs: nextCatalogs, previousIndex, layers });
  return { builds, warnings, notes: releaseNotes({ previousVersion, repository, before: previousIndex, after }) };
}
