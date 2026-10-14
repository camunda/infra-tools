import { ANY, archFolder, lineFor, PLATFORMS } from './config.mjs';
import { compareVersions, parseDuration, sortVersions } from './versions.mjs';

let renovate;

async function lib() {
  if (!renovate) {
    const base = 'renovate/dist';
    const [datasource, common, versioning, hostRules] = await Promise.all([
      import(`${base}/modules/datasource/index.js`),
      import(`${base}/modules/datasource/common.js`),
      import(`${base}/modules/versioning/index.js`),
      import(`${base}/util/host-rules.js`),
    ]);
    if (process.env.GITHUB_TOKEN) {
      hostRules.add({ hostType: 'github', matchHost: 'api.github.com', token: process.env.GITHUB_TOKEN });
    }
    renovate = { getPkgReleases: datasource.getPkgReleases, getDefaultVersioning: common.getDefaultVersioning, getVersioning: versioning.get };
  }
  return renovate;
}

async function releases(tool, packageName) {
  const { getPkgReleases } = await lib();
  const result = await getPkgReleases({ datasource: tool.datasource, packageName, versioning: tool.versioning, extractVersion: tool.extractVersion });
  // A lookup failure must fail the run, never read as "no versions".
  if (!result?.releases?.length) throw new Error(`${tool.name}: no upstream versions from ${tool.datasource} ${packageName}`);
  return result.releases.map((r) => ({ version: r.version.replace(/^v/, ''), releaseTimestamp: r.releaseTimestamp }));
}

// Upstream versions to publish, available for every platform. Each version follows its line (publish.lines): from `from` on
// (stable, past minAge), plus its pinned `versions` and versions with a revision; ignored and retired versions are skipped.
export async function upstreamVersions(tool, { now = Date.now() } = {}) {
  const { getDefaultVersioning, getVersioning } = await lib();
  const scheme = getVersioning(tool.versioning ?? getDefaultVersioning(tool.datasource));
  const perPlatform = tool.packageName.includes('{arch}')
    ? await Promise.all(PLATFORMS.map((p) => releases(tool, tool.packageName.replaceAll('{arch}', archFolder(tool, p)))))
    : [await releases(tool, tool.packageName)];
  const seen = new Map();
  perPlatform.forEach((list) => list.forEach((r) => seen.set(r.version, { ...r, count: (seen.get(r.version)?.count ?? 0) + 1 })));
  return classify(tool, [...seen.values()], { now, scheme, platformLists: perPlatform.length });
}

export function classify(tool, found, { now, scheme, platformLists = 1 }) {
  const out = { eligible: [], waiting: [], incomplete: [], lines: {} };
  for (const r of found) {
    const line = lineFor(tool, r.version);
    if (!line || line.retired === 'all') continue;
    if (line.ignoredVersions?.includes(r.version) || line.retired?.includes(r.version)) continue;
    const pinned = Boolean(line.versions?.includes(r.version) || line.revisions?.[r.version]);
    if (!pinned) {
      if (!line.from || compareVersions(r.version, line.from) < 0) continue;
      if (!scheme.isVersion(r.version) || !scheme.isStable(r.version)) continue;
    }
    if (line.key !== ANY) out.lines[r.version] = line.key;
    const minAge = parseDuration(line.minAge ?? tool.minAge);
    if ((r.count ?? 1) < platformLists) out.incomplete.push(r.version);
    else if (!pinned && r.releaseTimestamp && now - Date.parse(r.releaseTimestamp) < minAge) out.waiting.push(r.version);
    else out.eligible.push(r.version);
  }
  const requested = Object.values(tool.lines).flatMap((l) => [...(Array.isArray(l.versions) ? l.versions : []), ...Object.keys(l.revisions ?? {})]);
  const missing = requested.filter((v) => !found.some((r) => r.version === v));
  if (missing.length) throw new Error(`${tool.name}: versions not found upstream: ${missing.join(', ')}`);
  return { eligible: sortVersions(out.eligible), waiting: sortVersions(out.waiting), incomplete: sortVersions(out.incomplete), lines: out.lines };
}

// Upstream project URL (Renovate sourceUrl or homepage), for release notes; null when unknown.
export async function upstreamSource(tool) {
  try {
    const { getPkgReleases } = await lib();
    const packageName = tool.packageName.replaceAll('{arch}', archFolder(tool, PLATFORMS[0]));
    const result = await getPkgReleases({ datasource: tool.datasource, packageName, versioning: tool.versioning, extractVersion: tool.extractVersion });
    return result?.sourceUrl ?? result?.homepage ?? null;
  } catch {
    return null;
  }
}
