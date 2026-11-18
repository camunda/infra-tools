// Pull request checks (spec §5.4): what a PR changing tools or their build would publish, before it is merged.
import { buildTarget } from './build.mjs';
import { planTool } from './plan.mjs';
import { compareVersions } from './versions.mjs';

const major = (version) => version.match(/^\d+/)?.[0] ?? version;

// Files every tool version is built or tested with (build/docker-bake.hcl, scripts/build.mjs).
const SHARED_BUILD = ['build/', 'scripts/build.mjs', 'scripts/lib/build.mjs'];

// Tool files: tools/<tool>/..., plus the shared build.
const toolFiles = (tool, changedFiles) => changedFiles.filter((file) => file.startsWith(`tools/${tool.name}/`) || SHARED_BUILD.some((p) => file.startsWith(p)));

// tools: every tool definition at the PR head. changedFiles: paths changed by the PR. lookup, tagExists, now: as planTool's.
// Returns the builds of the dry run: the planned versions of every changed tool, plus its latest published version per major.
export async function checkPullRequest({ tools, changedFiles, lookup, tagExists, now }) {
  const builds = [];
  for (const tool of tools.filter((t) => toolFiles(t, changedFiles).length)) {
    const plan = await planTool(tool, { lookup, tagExists, now });
    const latest = new Map();
    for (const v of plan.versions.filter((v) => v.reason === 'published')) {
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
  return { builds };
}
