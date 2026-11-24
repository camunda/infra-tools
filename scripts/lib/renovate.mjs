// Renovate used as a library (ADR 0005): datasource lookups and versioning schemes. Its dist layout is not a public API;
// test/renovate.test.mjs checks the entry points used here.
const base = 'renovate/dist';

// The registration of GITHUB_TOKEN, set by every workflow step that plans, for the GitHub lookups of the process: done once.
let githubTokenRegistered;

// Renovate's getPkgReleases: { releases: [{ version, releaseTimestamp }] }, or null when the lookup failed.
export async function renovateLookup(config) {
  await (githubTokenRegistered ??= useGithubToken(process.env.GITHUB_TOKEN));
  const { getPkgReleases } = await import(`${base}/modules/datasource/index.js`);
  return getPkgReleases(config);
}

// Registers token for Renovate's GitHub datasources (github-releases), which call api.github.com only with the token of a
// host rule, never one from the environment: without it, their lookups fail. No token, no rule.
export async function useGithubToken(token) {
  if (!token) return;
  const hostRules = await import(`${base}/util/host-rules.js`);
  hostRules.add({ hostType: 'github', matchHost: 'api.github.com', token });
}

// Versioning scheme of a tool's source: its own, else its datasource's default.
export async function versioningFor(source) {
  const [{ get }, { getDefaultVersioning }] = await Promise.all([
    import(`${base}/modules/versioning/index.js`),
    import(`${base}/modules/datasource/common.js`),
  ]);
  return get(source.versioning ?? getDefaultVersioning(source.datasource));
}
