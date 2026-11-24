import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { useGithubToken, versioningFor } from '../lib/renovate.mjs';

// lib/renovate.mjs looks up upstream versions through Renovate's datasources; its dist layout is not a public API.
test('Renovate library exposes getPkgReleases', async () => {
  const { getPkgReleases } = await import('renovate/dist/modules/datasource/index.js');
  assert.equal(typeof getPkgReleases, 'function');
});

test('a tool versioning is its own, else its datasource default', async () => {
  const semver = await versioningFor({ datasource: 'node-version', versioning: 'semver' });
  assert.equal(semver.isStable('26.0.0-rc.1'), false);
  const nodeDefault = await versioningFor({ datasource: 'node-version' });
  // Renovate's node versioning marks non-LTS majors unstable (why node uses semver, D35).
  assert.equal(nodeDefault.isStable('25.0.0'), false);
});

// Renovate's host rules are global: each test starts and ends without any.
const hostRules = await import('renovate/dist/util/host-rules.js');
beforeEach(() => hostRules.clear());
afterEach(() => hostRules.clear());

test('a GitHub token authenticates GitHub lookups', async () => {
  await useGithubToken('ghs_test');
  assert.equal(hostRules.find({ hostType: 'github', url: 'https://api.github.com/graphql' }).token, 'ghs_test');
});

test('without a GitHub token, GitHub lookups stay anonymous', async () => {
  await useGithubToken(undefined);
  assert.deepEqual(hostRules.getAll(), []);
});
