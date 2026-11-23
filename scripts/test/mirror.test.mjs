// Copying release indexes to a mirror (index.mjs mirror), against two fake registries.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mirrorReleases } from '../lib/mirror.mjs';
import { sha256 } from '../lib/oci.mjs';
import { Registry } from '../lib/registry.mjs';
import { FakeRegistry, TOKEN } from './fake-registry.mjs';

const entry = (platform, version, bytes) => ({
  platform,
  tool: 'maven',
  version,
  line: '3',
  folderVersion: version,
  revision: 1,
  tag: `maven-${version}-r1`,
  cacheFolder: 'maven',
  archFolder: platform === 'linux/amd64' ? 'x64' : 'arm64',
  addToPath: 'bin',
  digest: sha256(bytes),
  size: bytes.length,
  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
});

// A release index on the source registry, with its tool layers.
function addRelease(fake, tag, versions) {
  const entries = [];
  for (const version of versions) {
    for (const platform of ['linux/amd64', 'linux/arm64']) {
      const bytes = Buffer.from(`maven ${version} ${platform}`);
      fake.addBlob(bytes);
      entries.push(entry(platform, version, bytes));
    }
  }
  fake.addBlob(Buffer.from('{}'));
  fake.addIndex(tag, entries);
}

let source;
let mirror;
let fakes = [];
beforeEach(async () => {
  await Promise.all(fakes.map((f) => f.stop()));
  const ghcr = new FakeRegistry();
  const gar = new FakeRegistry({ name: 'ci-30-162810/infra-tools/camunda/infra-tools', user: 'oauth2accesstoken' });
  fakes = [ghcr, gar];
  await Promise.all(fakes.map((f) => f.start()));
  source = { fake: ghcr, registry: new Registry(ghcr.repository, { token: TOKEN, scheme: 'http' }) };
  // No wait between retries: a rejected push answers 500 every time.
  mirror = { fake: gar, registry: new Registry(gar.repository, { token: TOKEN, user: 'oauth2accesstoken', scheme: 'http', retryDelays: [0, 0] }) };
});
after(() => Promise.all(fakes.map((f) => f.stop())));

test('a release index missing from the mirror is copied with its manifests and layers, with the same digests', async () => {
  addRelease(source.fake, '1.0.0-tools', ['3.9.16']);
  const copied = await mirrorReleases(source.registry, mirror.registry);
  assert.deepEqual(copied, ['1.0.0-tools']);
  assert.equal(await mirror.registry.digest('1.0.0-tools'), await source.registry.digest('1.0.0-tools'));
  assert.deepEqual(mirror.fake.indexEntries('1.0.0-tools'), source.fake.indexEntries('1.0.0-tools'));
  for (const { digest } of source.fake.indexEntries('1.0.0-tools')) assert.ok(mirror.fake.blobs.has(digest), digest);
});

test('release indexes already on the mirror and other tags are left alone, and shared layers are uploaded once', async () => {
  addRelease(source.fake, '1.0.0-tools', ['3.9.16']);
  await mirrorReleases(source.registry, mirror.registry);
  addRelease(source.fake, '1.1.0-tools', ['3.9.16', '3.10.1']);
  addRelease(source.fake, 'test-tools', ['3.10.1']);
  mirror.fake.requests = [];
  const copied = await mirrorReleases(source.registry, mirror.registry);
  assert.deepEqual(copied, ['1.1.0-tools']);
  assert.ok(!mirror.fake.manifests.has('test-tools'));
  const uploads = mirror.fake.requests.filter((r) => r.startsWith('PUT') && r.includes('/blobs/uploads/'));
  assert.equal(uploads.length, 2, 'only the layers of 3.10.1');
});

test('an interrupted copy leaves no tag on the mirror, and the next run completes it', async () => {
  addRelease(source.fake, '1.0.0-tools', ['3.9.16']);
  // The layers are uploaded before the index push fails.
  mirror.fake.rejected.add('1.0.0-tools');
  await assert.rejects(mirrorReleases(source.registry, mirror.registry));
  assert.ok(!mirror.fake.manifests.has('1.0.0-tools'));
  for (const { digest } of source.fake.indexEntries('1.0.0-tools')) assert.ok(mirror.fake.blobs.has(digest), digest);
  mirror.fake.rejected.clear();
  assert.deepEqual(await mirrorReleases(source.registry, mirror.registry), ['1.0.0-tools']);
});

test('a layer that does not match its digest is not copied', async () => {
  addRelease(source.fake, '1.0.0-tools', ['3.9.16']);
  const [first] = source.fake.indexEntries('1.0.0-tools');
  source.fake.corrupt.add(first.digest);
  await assert.rejects(mirrorReleases(source.registry, mirror.registry), new RegExp(`${first.digest} does not match its digest`));
  assert.ok(!mirror.fake.manifests.has('1.0.0-tools'));
});

test('a mirror copy without a mirror token fails before sending any token', async () => {
  const { execFileSync } = await import('node:child_process');
  const run = () =>
    execFileSync('node', ['index.mjs', 'mirror', '--image', source.fake.repository, '--mirror', mirror.fake.repository, '--user', 'oauth2accesstoken'], {
      cwd: new URL('..', import.meta.url),
      env: { PATH: process.env.PATH, GITHUB_TOKEN: TOKEN },
      stdio: 'pipe',
    });
  assert.throws(run, /mirror needs MIRROR_TOKEN/);
  assert.deepEqual(mirror.fake.requests, []);
});
