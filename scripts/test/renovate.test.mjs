import assert from 'node:assert/strict';
import { test } from 'node:test';

// plan.mjs looks up upstream versions through Renovate's datasources; its dist layout is not a public API.
test('Renovate library exposes getPkgReleases', async () => {
  const { getPkgReleases } = await import('renovate/dist/modules/datasource/index.js');
  assert.equal(typeof getPkgReleases, 'function');
});
