// Renovate used as a library (ADR 0005): datasource lookups and versioning schemes. Its dist layout is not a public API;
// test/renovate.test.mjs checks the entry points used here.
const base = 'renovate/dist';

// Renovate's getPkgReleases: { releases: [{ version, releaseTimestamp }] }, or null when the lookup failed.
export async function renovateLookup(config) {
  const { getPkgReleases } = await import(`${base}/modules/datasource/index.js`);
  return getPkgReleases(config);
}

// Versioning scheme of a tool's source: its own, else its datasource's default.
export async function versioningFor(source) {
  const [{ get }, { getDefaultVersioning }] = await Promise.all([
    import(`${base}/modules/versioning/index.js`),
    import(`${base}/modules/datasource/common.js`),
  ]);
  return get(source.versioning ?? getDefaultVersioning(source.datasource));
}
