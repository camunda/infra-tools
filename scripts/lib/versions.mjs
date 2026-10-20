// Version helpers shared by the scripts. Versions are compared as exact strings for identity, and by all their numbers for ordering,
// so builds of the same X.Y.Z (21.0.12+8.0.LTS, 21.0.12+101.0.LTS) stay distinct and ordered.

const numbers = (version) => (String(version).match(/\d+/g) ?? []).map(Number);

export const folderVersion = (version) => String(version).replace('+', '-');

export const versionFromFolder = (folder) => String(folder).replace('-', '+');

export function compareVersions(a, b) {
  const [pa, pb] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return pa.length - pb.length || (a < b ? -1 : a > b ? 1 : 0);
}

export const sortVersions = (versions) => [...versions].sort(compareVersions);

export function matchesSelector(version, selector) {
  const [v, s] = [folderVersion(version), folderVersion(selector ?? '')];
  return s === '' || v === s || v.startsWith(`${s}.`) || v.startsWith(`${s}-`);
}

// Line of a version: the longest line key it starts with ("21" for 21.0.13 and 21+35, "1.25" for 1.25.12), or undefined.
export function lineOf(version, keys) {
  const matching = keys.filter((key) => matchesSelector(version, key));
  return matching.sort((a, b) => b.length - a.length)[0];
}

export function highestMatching(versions, selector) {
  const matching = versions.filter((v) => matchesSelector(v, selector));
  return matching.length ? sortVersions(matching).at(-1) : undefined;
}

export const majorOf = (version) => numbers(version)[0];

export function tagFor(tool, version, revision) {
  const tag = `${tool}-${folderVersion(version)}-r${revision}`;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) throw new Error(`invalid image tag: ${tag}`);
  return tag;
}

const UNITS = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3 };

export function parseDuration(text) {
  const match = /^(\d+)\s*(minute|hour|day|week)s?$/.exec(String(text).trim());
  if (!match) throw new Error(`invalid duration: ${text}`);
  return Number(match[1]) * UNITS[match[2]];
}
