// Version identity is the exact string; ordering uses every number, build metadata included (D23), so builds of the same
// X.Y.Z (21.0.12+8.0.LTS, 21.0.12+101.0.LTS) stay distinct and ordered. A prerelease (27.0.0-rc.1) sorts before its release.

const numbers = (text) => (text.match(/\d+/g) ?? []).map(Number);

const compareNumbers = (pa, pb) => {
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return pa.length - pb.length;
};

const parts = (version) => {
  const [main, build = ''] = String(version).split(/\+(.*)/s);
  const dash = main.indexOf('-');
  return dash < 0 ? { core: main, pre: null, build } : { core: main.slice(0, dash), pre: main.slice(dash + 1), build };
};

export function compareVersions(a, b) {
  const [pa, pb] = [parts(a), parts(b)];
  const pre = pa.pre === pb.pre ? 0 : pa.pre === null ? 1 : pb.pre === null ? -1 : compareNumbers(numbers(pa.pre), numbers(pb.pre));
  return compareNumbers(numbers(pa.core), numbers(pb.core)) || pre || compareNumbers(numbers(pa.build), numbers(pb.build)) || (a < b ? -1 : a > b ? 1 : 0);
}

export const sortVersions = (versions) => [...versions].sort(compareVersions);

// Whether a version belongs to a line key: a major ("21" holds 21.0.13+5 and 21+35) or a minor ("1.25" holds 1.25.12).
export const inLine = (version, key) => version === key || ['.', '+', '-'].some((s) => version.startsWith(`${key}${s}`));

// `+` is written as `-` in tool cache folders and tags.
export const folderVersion = (version) => String(version).replaceAll('+', '-');

export function tagFor(tool, version, revision) {
  const tag = `${tool}-${folderVersion(version)}-r${revision}`;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) throw new Error(`invalid image tag: ${tag}`);
  return tag;
}
