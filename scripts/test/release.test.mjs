import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseBody, releaseName } from '../lib/release.mjs';

const r = {
  tool: 'java', version: '21.0.12+101.0.LTS', revision: 1, line: '21', tag: 'java-21.0.12-101.0.LTS-r1', digest: 'sha256:abc',
  cacheFolder: 'Java_Temurin-Hotspot_jdk', folderVersion: '21.0.12-101.0.LTS', archFolders: 'amd64=x64 arm64=aarch64',
};
const layers = {
  'linux/arm64': { digest: 'sha256:arm', size: 200 * 1024 * 1024 },
  'linux/amd64': { digest: 'sha256:amd', size: 199 * 1024 * 1024 },
};

test('release name', () => assert.equal(releaseName(r), 'java 21.0.12+101.0.LTS (r1)'));

test('release body: cache action, layers per platform, provenance', () => {
  const body = releaseBody({
    r, tool: { addToPath: null }, layers, registry: 'ghcr.io/camunda/infra-tools', repository: 'camunda/infra-tools',
    commit: '0123456789abcdef', source: 'https://github.com/adoptium/temurin21-binaries',
  });
  assert.match(body, /^java 21\.0\.12\+101\.0\.LTS, built for the runner tool cache\. Upstream: https:\/\/github\.com\/adoptium/);
  assert.match(body, /- uses: camunda\/infra-tools\/cache@<sha> # X\.Y\.Z\n {2}with:\n {4}tools: java@21\.0\.12\+101\.0\.LTS/);
  assert.match(body, /\| linux\/amd64 \| `Java_Temurin-Hotspot_jdk\/21\.0\.12-101\.0\.LTS\/x64` \| `sha256:amd` \| 199 MB \|\n\| linux\/arm64 \| `[^`]+\/aarch64`/);
  assert.match(body, /line `21`, revision 1\.\nBuilt and tested on linux\/amd64 and linux\/arm64 from camunda\/infra-tools@0123456\.$/);
});

test('release body: root action for plain tools, no upstream or commit', () => {
  const body = releaseBody({
    r: { ...r, tool: 'jq', version: '1.8.2', line: null, archFolders: { amd64: 'x64', arm64: 'arm64' } },
    tool: { addToPath: 'bin' }, layers, registry: 'ghcr.io/camunda/infra-tools', repository: 'camunda/infra-tools',
  });
  assert.match(body, /^jq 1\.8\.2, built for the runner tool cache\.\n/);
  assert.match(body, /- uses: camunda\/infra-tools@<sha>/);
  assert.match(body, /line `\*`/);
  assert.match(body, /linux\/arm64\.$/);
});
