// Pull request checks (spec §5.4): what a PR changing tools or their build would publish, before it is merged.
import { mergeCatalog } from './catalog.mjs';
import { planTool } from './plan.mjs';
import { buildIndex, releaseNotes } from './release.mjs';
import { isRetired, PLATFORMS } from './tool-definition.mjs';
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
// plan: planTool's options (lookup, tagExists, now). catalogs: the catalog entries of every tool, by name. previousRelease:
// the index and version of the latest release (none: { index: [] }). toolImageLayers(tag): the layers of a published tool
// image (Registry.toolImageLayers). repository: owner/name, for tool release links.
// Returns:
// - builds: the dry run, the planned versions of every changed tool plus its latest published version per major (catalog
//   entries, built by scripts/build.mjs even when the tool definition no longer publishes them);
// - warnings: published versions whose build files changed without a revision bump (published tool images never change);
// - notes: the release notes of the next release once the planned versions are published, or null when no tool changed.
export async function checkPullRequest({ tools, baseTools, changedFiles, plan: planOptions, catalogs, previousRelease, toolImageLayers, repository }) {
  const { index: previousIndex, version: previousVersion } = previousRelease;
  const builds = [];
  const warnings = [];
  const planned = {};
  const changedTools = tools.filter((t) => toolFiles(t, changedFiles).length);
  for (const tool of changedTools) {
    const plan = await planTool(tool, planOptions);
    planned[tool.name] = plan.versions.filter((v) => v.decision === 'publish');
    const plannedVersions = new Set(planned[tool.name].map((v) => v.version));
    // A version stays available to consumers until it is retired, even out of every line or delisted upstream: available
    // versions come from the catalog, not the plan. A planned revision replaces its published tool image.
    const available = (catalogs[tool.name] ?? []).filter((e) => !e.retired && !isRetired(tool, e.version) && !plannedVersions.has(e.version));
    const changed = imageFiles(tool, toolFiles(tool, changedFiles), baseTools[tool.name]);
    if (changed.length && available.length) {
      const versions = available.map((e) => `${e.version} (${e.tag})`);
      warnings.push(`${tool.name}: ${changed.join(', ')} changed, but these published versions keep their tool image unless their revision is bumped: ${versions.join(', ')}`);
    }
    const latest = new Map();
    for (const e of available) {
      const m = majorOf(e.version);
      if (!latest.has(m) || compareVersions(e.version, latest.get(m).version) > 0) latest.set(m, e);
    }
    const toolBuilds = [
      ...planned[tool.name].map((v) => ({ tool: tool.name, version: v.version, tag: v.tag, reason: `planned: ${v.reason}` })),
      ...[...latest].map(([m, e]) => ({ tool: tool.name, version: e.version, tag: e.tag, reason: `latest published of major ${m}` })),
    ];
    builds.push(...toolBuilds.sort((a, b) => compareVersions(a.version, b.version)));
  }
  if (!changedTools.length) return { builds, warnings, notes: null };

  // The next index as the release would build it, once the reconciler has recorded the planned versions. Planned tool images
  // do not exist yet: their layers are placeholders, new to the index.
  const layers = {};
  for (const e of previousIndex) (layers[e.tag] ??= {})[e.platform] = { digest: e.digest, size: e.size, mediaType: e.mediaType };
  const nextCatalogs = {};
  for (const tool of tools) {
    const toPublish = planned[tool.name] ?? [];
    nextCatalogs[tool.name] = mergeCatalog(tool, catalogs[tool.name] ?? [], toPublish, { now: new Date(planOptions.now).toISOString() }).entries;
    for (const { tag } of toPublish) layers[tag] = Object.fromEntries(PLATFORMS.map((p) => [p, { digest: `planned:${tag}`, size: 0, mediaType: null }]));
    for (const e of nextCatalogs[tool.name]) if (!e.retired && !layers[e.tag]) layers[e.tag] = await toolImageLayers(e.tag);
  }
  const after = buildIndex({ tools, catalogs: nextCatalogs, previousIndex, layers });
  return { builds, warnings, notes: releaseNotes({ previousVersion, repository, before: previousIndex, after }) };
}

// Marks the release notes preview comment, one per PR, updated on each push.
const MARKER = '<!-- infra-tools: pull request checks -->';
// Posted by the workflow's token.
const BOT = 'github-actions[bot]';

// The release notes preview comment of a checkPullRequest result, or null when no tool changed.
export function previewComment({ builds, warnings, notes }) {
  if (notes === null) return null;
  return [
    MARKER,
    '## Next release preview',
    '',
    ...warnings.flatMap((w) => ['> [!WARNING]', `> ${w}`, '']),
    '**Dry run** (built and tested on every platform, never pushed):',
    '',
    ...(builds.length ? builds.map((b) => `- ${b.tool} ${b.version} \`${b.tag}\`: ${b.reason}`) : ['- nothing to build']),
    '',
    '**Release notes** of the next release, once the reconciler has published the planned versions:',
    '',
    notes,
  ].join('\n');
}

// How to bring a PR's preview comment up to date. comments: the PR's issue comments ({ id, user: { login }, body }, GitHub
// REST API); preview: previewComment's. Returns { id, body } to update the existing comment, { body } to create one, or null
// when there is nothing to post: a PR that no longer changes tools gets its stale comment replaced, and none created.
export function previewCommentUpdate(comments, preview) {
  const existing = comments.find((c) => c.user?.login === BOT && c.body?.startsWith(MARKER));
  const body = preview ?? (existing && [MARKER, '## Next release preview', '', 'No tool changes: this pull request publishes nothing.'].join('\n'));
  if (!body) return null;
  return existing ? { id: existing.id, body } : { body };
}
