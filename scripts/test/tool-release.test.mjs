import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseToolDefinition } from '../lib/tool-definition.mjs';
import { toolRelease } from '../lib/tool-release.mjs';

const java = parseToolDefinition('java', {
  source: { datasource: 'java-version' },
  publish: { lines: { 21: { from: '21.0.13' } } },
  install: { cacheFolder: 'Java_Temurin-Hotspot_jdk', archFolders: { amd64: 'x64', arm64: 'aarch64' } },
  setup: { action: 'actions/setup-java', versionInput: 'java-version', with: { distribution: 'temurin' } },
});
const maven = parseToolDefinition('maven', { source: { datasource: 'maven' }, publish: { lines: { 3.9: { from: '3.9.16' } } }, install: { addToPath: 'bin' } });
const node = parseToolDefinition('node', { source: { datasource: 'node-version' }, publish: { lines: { 26: { from: '26.13.1' } } } });

const layers = {
  'linux/arm64': { digest: 'sha256:bbb', size: 196083302, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' },
  'linux/amd64': { digest: 'sha256:aaa', size: 197132288, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' },
};
const release = (tool, published) => toolRelease({
  tool,
  published: { tool: tool.name, line: '*', revision: 1, upstream: null, ...published },
  layers,
  digest: 'sha256:index',
  image: 'ghcr.io/camunda/infra-tools',
  repository: 'camunda/infra-tools',
  commit: '0123456789abcdef0123456789abcdef01234567',
});

test('a tool release documents one tool image: usage, tool cache path, layers, image, line, revision and build commit', () => {
  const r = release(java, { version: '21.0.13+9.0.LTS', line: '21', revision: 2, tag: 'java-21.0.13-9.0.LTS-r2', upstream: 'https://adoptium.net' });
  assert.deepEqual({ ...r, body: undefined }, {
    tag_name: 'java-21.0.13-9.0.LTS-r2',
    target_commitish: '0123456789abcdef0123456789abcdef01234567',
    name: 'java 21.0.13+9.0.LTS (r2)',
    make_latest: 'false',
    body: undefined,
  });
  assert.equal(r.body, [
    'java 21.0.13+9.0.LTS in the runner tool cache, for its setup-* action. Upstream: https://adoptium.net',
    '',
    '## Usage',
    '',
    'In jobs pinning an infra-tools release that lists it. The setup-* step takes the version the infra-tools step installed, so it finds it in the tool cache instead of downloading it:',
    '',
    '```yaml',
    '- id: tools',
    '  uses: camunda/infra-tools@<sha> # X.Y.Z',
    '  with:',
    '    tool-cache: java@21.0.13+9.0.LTS',
    '- uses: actions/setup-java@<sha> # vX.Y.Z',
    '  with:',
    '    distribution: temurin',
    '    java-version: ${{ fromJSON(steps.tools.outputs.versions).java }}',
    '```',
    '',
    '## Tool image',
    '',
    '| Platform | Tool cache path | Layer digest | Size |',
    '| --- | --- | --- | --- |',
    '| linux/amd64 | `Java_Temurin-Hotspot_jdk/21.0.13-9.0.LTS/x64` | `sha256:aaa` | 188.0 MB |',
    '| linux/arm64 | `Java_Temurin-Hotspot_jdk/21.0.13-9.0.LTS/aarch64` | `sha256:bbb` | 187.0 MB |',
    '',
    'Image `ghcr.io/camunda/infra-tools:java-21.0.13-9.0.LTS-r2@sha256:index`, line `21`, revision 2, built from camunda/infra-tools@0123456.',
  ].join('\n'));
});

test('a plain tool is used through tools, ready to use; a tool-cache tool without setup block names the expression to pass', () => {
  const plain = release(maven, { version: '3.9.16', line: '3.9', tag: 'maven-3.9.16-r1' }).body;
  assert.match(plain, /^maven 3\.9\.16, ready to use\.\n/);
  assert.match(plain, /\n```yaml\n- uses: camunda\/infra-tools@<sha> # X\.Y\.Z\n {2}with:\n {4}tools: maven@3\.9\.16\n```\n/);
  assert.match(plain, /\| linux\/amd64 \| `maven\/3\.9\.16\/x64` \|/);

  const cached = release(node, { version: '26.13.1', line: '26', tag: 'node-26.13.1-r1' }).body;
  assert.match(cached, /\n {4}tool-cache: node@26\.13\.1\n# Then the setup-\* action of node, with its version input set to \$\{\{ fromJSON\(steps\.tools\.outputs\.versions\)\.node \}\}\n```\n/);
});
