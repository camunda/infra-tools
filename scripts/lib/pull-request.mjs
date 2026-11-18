// Pull request checks (spec §5.4): what a PR changing tools or their build would publish, before it is merged.
import { buildTarget } from './build.mjs';
import { planTool } from './plan.mjs';
import { compareVersions } from './versions.mjs';

const major = (version) => version.match(/^\d+/)?.[0] ?? version;

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
// lookup, tagExists, now: as planTool's.
// Returns the builds of the dry run: the planned versions of every changed tool, plus its latest published version per major;
// and the warnings: published versions whose build files changed without a revision bump (published tool images never change).
export async function checkPullRequest({ tools, baseTools, changedFiles, lookup, tagExists, now }) {
  const builds = [];
  const warnings = [];
  for (const tool of tools.filter((t) => toolFiles(t, changedFiles).length)) {
    const plan = await planTool(tool, { lookup, tagExists, now });
    const published = plan.versions.filter((v) => v.reason === 'published');
    const changed = imageFiles(tool, toolFiles(tool, changedFiles), baseTools[tool.name]);
    if (changed.length && published.length) {
      const versions = published.map((v) => `${v.version} (${buildTarget(tool, v.version).tag})`);
      warnings.push(`${tool.name}: ${changed.join(', ')} changed, but these published versions keep their tool image unless their revision is bumped: ${versions.join(', ')}`);
    }
    const latest = new Map();
    for (const v of published) {
      const m = major(v.version);
      if (!latest.has(m) || compareVersions(v.version, latest.get(m)) > 0) latest.set(m, v.version);
    }
    for (const v of plan.versions) {
      let reason;
      if (v.decision === 'publish') reason = `planned: ${v.reason}`;
      else if (latest.get(major(v.version)) === v.version) reason = `latest published of major ${major(v.version)}`;
      else continue;
      builds.push({ tool: tool.name, version: v.version, tag: buildTarget(tool, v.version).tag, reason });
    }
  }
  return { builds, warnings };
}
