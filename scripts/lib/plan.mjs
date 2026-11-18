// Plan of one tool (spec §5.3, D41): every upstream version gets a decision, publish, wait or skip, with its reason.
import { renovateLookup, versioningFor } from './renovate.mjs';
import { archFolder, lineFor, parseDuration, PLATFORMS, revisionOf } from './tool-definition.mjs';
import { compareVersions, sortVersions, tagFor } from './versions.mjs';

// lookup: Renovate's getPkgReleases or a stand-in.
export async function planTool(tool, { lookup = renovateLookup, tagExists, now = Date.now() }) {
  const scheme = await versioningFor(tool.source);
  const releases = await upstreamReleases(tool, lookup);
  const pinned = Object.values(tool.publish.lines).flatMap((line) => [...(line.versions ?? []), ...Object.keys(line.revisions ?? {})]);
  const notFound = pinned.filter((version) => !releases.has(version));
  if (notFound.length) throw new Error(`${tool.name}: not found upstream: ${sortVersions(notFound).join(', ')}`);
  const versions = [];
  for (const version of sortVersions(releases.keys())) {
    const line = lineFor(tool, version);
    let [decision, reason] = decide(line, version, scheme);
    const missing = PLATFORMS.filter((p) => !releases.get(version).platforms.has(p));
    if (decision === 'publish' && missing.length) [decision, reason] = ['wait', `missing on ${missing.join(', ')}`];
    if (decision === 'publish' && reason === 'new') {
      const minAge = line.minAge ?? tool.publish.minAge;
      // Some datasources (java-version, maven) give no release date: minAge cannot apply, and the reason says so.
      const released = Date.parse(releases.get(version).releaseTimestamp);
      if (Number.isNaN(released)) reason = 'new, no release date: minAge not applied';
      else if (now - released < parseDuration(minAge)) [decision, reason] = ['wait', `released less than ${minAge} ago`];
    }
    if (decision !== 'publish') {
      versions.push({ version, decision, reason });
      continue;
    }
    const revision = revisionOf(tool, version);
    const tag = tagFor(tool.name, version, revision);
    if (await tagExists(tag)) versions.push({ version, decision: 'skip', reason: 'published' });
    else versions.push({ version, decision, reason, line: line.key, revision, tag });
  }
  return { tool: tool.name, versions };
}

// Upstream releases by exact version, with the platforms they exist for. `{arch}` in the package name makes one lookup per
// platform (with the tool cache arch folder); otherwise one lookup covers every platform.
async function upstreamReleases(tool, lookup) {
  const { packageName } = tool.source;
  const lookups = packageName.includes('{arch}')
    ? PLATFORMS.map((platform) => [[platform], packageName.replaceAll('{arch}', archFolder(tool, platform))])
    : [[PLATFORMS, packageName]];
  const results = await Promise.all(
    lookups.map(async ([, name]) => {
      const result = await lookup({ ...tool.source, packageName: name });
      // An outage must fail the run, never read as "no versions".
      if (!result?.releases?.length) throw new Error(`${tool.name}: no upstream versions from ${tool.source.datasource} ${name} (lookup failed or empty)`);
      return result;
    }),
  );
  const releases = new Map();
  results.forEach((result, i) => {
    for (const release of result.releases) {
      const entry = releases.get(release.version) ?? { ...release, platforms: new Set() };
      lookups[i][0].forEach((platform) => entry.platforms.add(platform));
      releases.set(release.version, entry);
    }
  });
  return releases;
}

// A version's line rule (D41), in order: no line, retired or ignored, pinned (no stability or minAge check), outside from,
// unstable, then new.
function decide(line, version, scheme) {
  if (!line) return ['skip', 'in no line'];
  if (line.retired === 'all') return ['skip', 'line retired'];
  if (line.retired?.includes(version)) return ['skip', 'retired'];
  if (line.ignoredVersions?.includes(version)) return ['skip', 'ignored'];
  if (line.revisions?.[version]) return ['publish', `revision ${line.revisions[version]}`];
  if (line.versions?.includes(version)) return ['publish', 'pinned in versions'];
  if (!line.from) return ['skip', 'line stopped'];
  if (compareVersions(version, line.from) < 0) return ['skip', `before from ${line.from}`];
  if (!scheme.isVersion(version) || !scheme.isStable(version)) return ['skip', 'unstable'];
  return ['publish', 'new'];
}
