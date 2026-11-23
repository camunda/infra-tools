// Plan of one tool (spec §5.3, D41): every upstream version gets a decision, publish, wait or skip, with its reason, and the
// upstream project link (its source repository, else its homepage, else null) for the tool releases.
import { renovateLookup, versioningFor } from './renovate.mjs';
import { archFolder, lineFor, parseDuration, PLATFORMS, revisionOf } from './tool-definition.mjs';
import { compareVersions, sortVersions, tagFor } from './versions.mjs';

// A version is published as soon as one platform has it upstream, with the platforms it has (D62, ADR 0011): every planned
// version has its platforms to build, and the ones upstream lacks (missing) with its upstream release date (released, null
// without one), for the completeness check to report. Once published, a platform upstream adds is planned as the next revision
// (the highest published one plus one): it builds only the platforms added and reuses the others from the tool image it replaces
// (reuse, its tag). A manual revision above the highest published one builds every platform again.
// lookup: Renovate's getPkgReleases or a stand-in. tags: the published tags of the registry. platformsOf(tag): the platforms of a
// published tool image (Registry.toolImagePlatforms). retryDelays: the waits before each retry of a failed lookup. The plan
// reads no GitHub state (ADR 0012): a version that fails is planned again on every run, until it builds or its line ignores
// it (ignoredVersions).
export async function planTool(tool, { lookup = renovateLookup, tags, platformsOf, now = Date.now(), retryDelays = LOOKUP_RETRY_DELAYS }) {
  const scheme = await versioningFor(tool.source);
  const { upstream, link } = await upstreamVersions(tool, lookup, retryDelays);
  const pinned = Object.values(tool.publish.lines).flatMap((line) => [...(line.versions ?? []), ...Object.keys(line.revisions ?? {})]);
  const notFound = pinned.filter((version) => !upstream.has(version));
  if (notFound.length) throw new Error(`${tool.name}: not found upstream: ${sortVersions(notFound).join(', ')}`);
  const versions = [];
  for (const version of sortVersions(upstream.keys())) {
    const line = lineFor(tool, version);
    let [decision, reason] = decide(line, version, scheme);
    // Some datasources (java-version, maven) give no release date: minAge cannot apply, and the reason says so.
    const released = Date.parse(upstream.get(version).releaseTimestamp);
    if (decision === 'publish' && reason === 'new') {
      const minAge = line.minAge ?? tool.publish.minAge;
      if (Number.isNaN(released)) reason = 'new, no release date: minAge not applied';
      else if (now - released < parseDuration(minAge)) [decision, reason] = ['wait', `released less than ${minAge} ago`];
    }
    if (decision !== 'publish') {
      versions.push({ version, decision, reason });
      continue;
    }
    const available = PLATFORMS.filter((p) => upstream.get(version).platforms.has(p));
    const missing = PLATFORMS.filter((p) => !available.includes(p));
    const waiting = missing.length ? { missing, released: Number.isNaN(released) ? null : new Date(released).toISOString() } : {};
    const target = await nextTarget(tool, version, available, { tags, platformsOf });
    if (target.published) versions.push({ version, decision: 'skip', reason: 'published', line: line.key, ...target.published, ...waiting });
    else {
      if (target.reuse) reason = `adds ${target.platforms.join(', ')} to ${target.reuse}`;
      versions.push({ version, decision, reason, line: line.key, ...target, ...waiting });
    }
  }
  return { tool: tool.name, versions, upstream: link };
}

// What publishing a version takes, given the platforms upstream has it for (available) and its published tags (tags): its
// revision and tag, the platforms to build, and the tool image to reuse the other platforms from (reuse, its tag) when only
// platforms are added; or { published: { revision, tag, platforms } } when its highest published revision has every available
// platform. A manual revision (revisions in its line) above the highest published one builds every available platform.
async function nextTarget(tool, version, available, { tags, platformsOf }) {
  const highest = highestRevision(tags, tool.name, version);
  const manual = revisionOf(tool, version);
  if (manual > highest) return { revision: manual, tag: tagFor(tool.name, version, manual), platforms: available };
  const tag = tagFor(tool.name, version, highest);
  const platforms = await platformsOf(tag);
  const added = available.filter((p) => !platforms.includes(p));
  if (!added.length) return { published: { revision: highest, tag, platforms } };
  return { revision: highest + 1, tag: tagFor(tool.name, version, highest + 1), platforms: added, reuse: tag };
}

// The highest published revision of a tool version among the published tags (tags), 0 when none.
export function highestRevision(tags, tool, version) {
  const prefix = tagFor(tool, version, 0).slice(0, -1);
  const revisions = [...tags].filter((t) => t.startsWith(prefix) && /^\d+$/.test(t.slice(prefix.length))).map((t) => Number(t.slice(prefix.length)));
  return Math.max(0, ...revisions);
}

// Waits before each retry of a failed upstream lookup (ADR 0012): the plan fails only when the lookup keeps failing.
const LOOKUP_RETRY_DELAYS = [2000, 4000, 8000];

// A lookup's result, retried after each of delays while it throws or finds no versions, which an outage gives (Renovate's
// getPkgReleases returns null when a lookup fails); the last error throws.
async function lookupRetrying(lookup, config, delays, describe) {
  for (let retry = 0; ; retry++) {
    let error;
    try {
      const result = await lookup(config);
      if (result?.releases?.length) return result;
      error = new Error(`${describe} (lookup failed or empty)`);
    } catch (err) {
      error = err;
    }
    if (retry >= delays.length) throw error;
    console.log(`${error.message}, retried in ${delays[retry] / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, delays[retry]));
  }
}

// Upstream versions by exact version string, with the platforms they exist for, and the upstream project link. `{arch}` in the package name makes one lookup per
// platform (with the tool cache arch folder); otherwise one lookup covers every platform.
async function upstreamVersions(tool, lookup, retryDelays) {
  const { packageName } = tool.source;
  const lookups = packageName.includes('{arch}')
    ? PLATFORMS.map((platform) => [[platform], packageName.replaceAll('{arch}', archFolder(tool, platform))])
    : [[PLATFORMS, packageName]];
  const results = await Promise.all(
    // An outage must fail the run, never read as "no versions".
    lookups.map(([, name]) => lookupRetrying(lookup, { ...tool.source, packageName: name }, retryDelays, `${tool.name}: no upstream versions from ${tool.source.datasource} ${name}`)),
  );
  const upstream = new Map();
  results.forEach((result, i) => {
    for (const found of result.releases) {
      const entry = upstream.get(found.version) ?? { ...found, platforms: new Set() };
      lookups[i][0].forEach((platform) => entry.platforms.add(platform));
      upstream.set(found.version, entry);
    }
  });
  const link = results.map((r) => r.sourceUrl ?? r.homepage).find(Boolean) ?? null;
  return { upstream, link };
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
