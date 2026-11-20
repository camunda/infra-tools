// The action as consumers call it (seam 1), run against a fake registry: tool cache contents, PATH, outputs, logs and exit
// status. The CI workflow (ci.yml) runs the same action on real runners against ghcr.io.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeRegistry, REPOSITORY, TOKEN } from './fake-registry.mjs';

const SETUP = fileURLToPath(new URL('../../action/setup.sh', import.meta.url));
const ARCH_FOLDERS = { 'linux/amd64': 'x64', 'linux/arm64': 'arm64' };

// A tool image layer: opt/hostedtoolcache/<cache folder>/<folder version>/<arch>, marked complete, as build/tool.Dockerfile
// makes it, holding bin/<command> printing `<banner> <version>`.
async function toolLayer(dir, { cacheFolder, folderVersion, archFolder, command, banner }) {
  const root = join(dir, `${cacheFolder}-${folderVersion}-${archFolder}`);
  const home = join(root, 'opt/hostedtoolcache', cacheFolder, folderVersion, archFolder);
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, 'bin', command), `#!/bin/sh\necho "${banner} ${folderVersion}"\n`);
  await chmod(join(home, 'bin', command), 0o755);
  await writeFile(`${home}.complete`, '');
  return execFileSync('tar', ['czf', '-', '-C', root, 'opt']);
}

// The tools of the test index, as their tool definitions in tools/ lay them out.
const TOOLS = {
  maven: { versions: ['3.9.16', '3.10.1'], cacheFolder: 'maven', archFolders: ARCH_FOLDERS, addToPath: 'bin', command: 'mvn', banner: 'Apache Maven' },
  java: {
    versions: ['21.0.12+8.0.LTS', '21.0.12+101.0.LTS', '25.0.3+9.0.LTS'],
    cacheFolder: 'Java_Temurin-Hotspot_jdk',
    archFolders: { 'linux/amd64': 'x64', 'linux/arm64': 'aarch64' },
    addToPath: null,
    command: 'java',
    banner: 'openjdk',
  },
  node: { versions: ['24.22.0', '26.13.1'], cacheFolder: 'node', archFolders: ARCH_FOLDERS, addToPath: null, command: 'node', banner: 'node' },
};

let work;
let registry;

// The test index: every version of TOOLS on both platforms.
before(async () => {
  work = await mkdtemp(join(tmpdir(), 'infra-tools-action-'));
  registry = new FakeRegistry();
  await registry.start();
  const entries = [];
  for (const [tool, { versions, cacheFolder, archFolders, addToPath, command, banner }] of Object.entries(TOOLS)) {
    for (const version of versions) {
      const folderVersion = version.replace('+', '-');
      for (const [platform, archFolder] of Object.entries(archFolders)) {
        const bytes = await toolLayer(work, { cacheFolder, folderVersion, archFolder, command, banner });
        entries.push({
          platform,
          tool,
          version,
          line: version.split('.')[0],
          folderVersion,
          revision: 1,
          tag: `${tool}-${folderVersion}-r1`,
          cacheFolder,
          archFolder,
          addToPath,
          digest: registry.addBlob(bytes),
          size: bytes.length,
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        });
      }
    }
  }
  registry.addIndex('test-tools', entries);
  // The index of release 1.2.3, the default of an action whose release-please manifest holds it.
  registry.addIndex('1.2.3-tools', entries);
  // An index whose maven 3.9.16 is on linux/amd64 only.
  registry.addIndex('amd64-only-tools', entries.filter((e) => !(e.version === '3.9.16' && e.platform === 'linux/arm64')));
  await startMirror();
});

after(async () => {
  await stopMirror();
  await registry.stop();
  await rm(work, { recursive: true, force: true });
});

const digestOf = (version, platform) => registry.indexEntries('test-tools').find((e) => e.tool === 'maven' && e.version === version && e.platform === platform).digest;

let runner;
beforeEach(async () => {
  runner = await mkdtemp(join(work, 'runner-'));
  await mkdir(join(runner, 'tool-cache'));
  await mkdir(join(runner, 'temp'));
  await mkdir(join(runner, 'workspace'));
  registry.requests = [];
});

// Runs the action like the composite step of action.yml does, with the runner's environment.
function action({ tools = '', toolCacheTools = '', env = {}, bash = 'bash', setup = SETUP } = {}) {
  const files = { output: join(runner, 'output'), path: join(runner, 'path'), summary: join(runner, 'summary') };
  const child = spawn(bash, [setup], {
    env: {
      PATH: process.env.PATH,
      HOME: runner,
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      RUNNER_TOOL_CACHE: join(runner, 'tool-cache'),
      RUNNER_TEMP: join(runner, 'temp'),
      GITHUB_OUTPUT: files.output,
      GITHUB_PATH: files.path,
      GITHUB_STEP_SUMMARY: files.summary,
      GITHUB_WORKSPACE: join(runner, 'workspace'),
      TOOLS: tools,
      TOOL_CACHE_TOOLS: toolCacheTools,
      TOKEN,
      INDEX: `${registry.host}/${REPOSITORY}:test-tools`,
      INFRA_TOOLS_REGISTRY_SCHEME: 'http',
      ...env,
    },
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return new Promise((resolve) => {
    child.on('close', async (status) => {
      const read = async (file) => (existsSync(file) ? readFile(file, 'utf8') : '');
      const outputs = Object.fromEntries((await read(files.output)).split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
      resolve({ status, log, outputs, path: (await read(files.path)).split('\n').filter(Boolean), summary: await read(files.summary) });
    });
  });
}

const toolCache = (...parts) => join(runner, 'tool-cache', ...parts);

test('a plain tool is installed into the tool cache, marked complete and put on PATH', async () => {
  const result = await action({ tools: 'maven@3.9' });
  assert.equal(result.status, 0, result.log);
  assert.equal(execFileSync(toolCache('maven/3.9.16/x64/bin/mvn'), { encoding: 'utf8' }), 'Apache Maven 3.9.16\n');
  assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
  assert.deepEqual(result.path, [toolCache('maven/3.9.16/x64/bin')]);
  assert.equal(result.outputs.versions, '{"maven":"3.9.16"}');
});

test('a tool-cache tool is installed into the tool cache and marked complete, not put on PATH', async () => {
  const result = await action({ toolCacheTools: 'java@21' });
  assert.equal(result.status, 0, result.log);
  assert.equal(execFileSync(toolCache('Java_Temurin-Hotspot_jdk/21.0.12-101.0.LTS/x64/bin/java'), { encoding: 'utf8' }), 'openjdk 21.0.12-101.0.LTS\n');
  assert.ok(existsSync(toolCache('Java_Temurin-Hotspot_jdk/21.0.12-101.0.LTS/x64.complete')));
  assert.deepEqual(result.path, []);
  assert.equal(result.outputs.versions, '{"java":"21.0.12+101.0.LTS"}');
});

test('with several builds of one version, an exact build pin takes its build and a version selector the highest present', async () => {
  const pinned = await action({ toolCacheTools: 'java@21.0.12+8.0.LTS' });
  assert.equal(pinned.status, 0, pinned.log);
  assert.equal(pinned.outputs.versions, '{"java":"21.0.12+8.0.LTS"}');
  const other = await action({ toolCacheTools: 'java@21.0.12-101.0.LTS' });
  assert.equal(other.status, 0, other.log);
  assert.equal(other.outputs.versions, '{"java":"21.0.12+101.0.LTS"}');
  assert.ok(existsSync(toolCache('Java_Temurin-Hotspot_jdk/21.0.12-8.0.LTS/x64.complete')));
  assert.ok(existsSync(toolCache('Java_Temurin-Hotspot_jdk/21.0.12-101.0.LTS/x64.complete')));
  registry.requests = [];
  const present = await action({ toolCacheTools: 'java@21.0.12' });
  assert.equal(present.outputs.versions, '{"java":"21.0.12+101.0.LTS"}');
  assert.deepEqual(registry.requests, []);
});

test('plain and tool-cache tools are installed in one step, with their versions in one output', async () => {
  const result = await action({ tools: 'maven@3.9', toolCacheTools: 'java@25\nnode@26', env: { RUNNER_ARCH: 'ARM64' } });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(JSON.parse(result.outputs.versions), { maven: '3.9.16', java: '25.0.3+9.0.LTS', node: '26.13.1' });
  assert.ok(existsSync(toolCache('Java_Temurin-Hotspot_jdk/25.0.3-9.0.LTS/aarch64.complete')));
  assert.ok(existsSync(toolCache('node/26.13.1/arm64.complete')));
  assert.deepEqual(result.path, [toolCache('maven/3.9.16/arm64/bin')]);
});

// A repository using the Maven wrapper (only-script, as camunda/camunda): ./mvnw runs
// $MAVEN_USER_HOME/wrapper/dists/<distribution>/<Java String.hashCode of distributionUrl, hex>/bin/mvn when it exists.
async function wrapperWorkspace(version) {
  const workspace = join(runner, 'workspace');
  await mkdir(join(workspace, '.mvn/wrapper'), { recursive: true });
  const url = `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${version}/apache-maven-${version}-bin.zip`;
  await writeFile(join(workspace, '.mvn/wrapper/maven-wrapper.properties'), `wrapperVersion=3.3.4\r\ndistributionType=only-script\r\ndistributionUrl=${url}\r\n`);
  return workspace;
}

test('./mvnw uses the installed maven when the wrapper asks for the same version', async () => {
  const result = await action({ tools: 'maven@3.9', env: { GITHUB_WORKSPACE: await wrapperWorkspace('3.9.16') } });
  assert.equal(result.status, 0, result.log);
  assert.equal(execFileSync(join(runner, '.m2/wrapper/dists/apache-maven-3.9.16/56ba1f9f/bin/mvn'), { encoding: 'utf8' }), 'Apache Maven 3.9.16\n');
});

test('./mvnw finds the installed maven under MAVEN_USER_HOME, also when maven was already present', async () => {
  const workspace = await wrapperWorkspace('3.9.16');
  await action({ tools: 'maven@3.9' });
  const result = await action({ tools: 'maven@3.9', env: { GITHUB_WORKSPACE: workspace, MAVEN_USER_HOME: join(runner, 'm2') } });
  assert.equal(result.status, 0, result.log);
  assert.match(result.log, /^maven@3\.9: 3\.9\.16 cached/m);
  assert.equal(execFileSync(join(runner, 'm2/wrapper/dists/apache-maven-3.9.16/56ba1f9f/bin/mvn'), { encoding: 'utf8' }), 'Apache Maven 3.9.16\n');
});

test('a wrapper asking for another maven version is left to download it', async () => {
  const result = await action({ tools: 'maven@3.9', env: { GITHUB_WORKSPACE: await wrapperWorkspace('3.9.11') } });
  assert.equal(result.status, 0, result.log);
  assert.ok(!existsSync(join(runner, '.m2/wrapper')));
  assert.match(result.log, /::notice::infra-tools: \.mvn\/wrapper asks for maven 3\.9\.11, not the installed 3\.9\.16: \.\/mvnw downloads it/);
});

test('a tool-cache tool listed under tools fails and names the tool-cache input, without a network call', async () => {
  const result = await action({ tools: 'maven@3.9\njava@21' });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /::error::infra-tools: java is a tool-cache tool: list it under tool-cache, not tools, and keep its setup-\* step/);
  assert.deepEqual(registry.requests, []);
  assert.deepEqual(result.path, []);
});

test('a plain tool listed under tool-cache fails and names the tools input, without a network call', async () => {
  const result = await action({ toolCacheTools: 'maven@3.9' });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /::error::infra-tools: maven is a plain tool: list it under tools, not tool-cache/);
  assert.deepEqual(registry.requests, []);
});

test('each tool gets one log line with its version, size, duration, speed and source registry', async () => {
  const result = await action({ tools: 'maven@3.9' });
  assert.match(result.log, new RegExp(`^maven@3\\.9: 3\\.9\\.16 installed \\d+\\.\\d MB in \\d+\\.\\d s \\(\\d+\\.\\d MB/s\\) from ${registry.host} -> ${toolCache('maven/3.9.16/x64')}$`, 'm'));
});

test('a present tool makes no network call, even with an unreachable index', async () => {
  await mkdir(toolCache('maven/3.9.16/x64/bin'), { recursive: true });
  await writeFile(toolCache('maven/3.9.16/x64.complete'), '');
  const result = await action({ tools: 'maven@3', env: { INDEX: '127.0.0.1:1/camunda/infra-tools:none' } });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(registry.requests, []);
  assert.equal(result.outputs.versions, '{"maven":"3.9.16"}');
  assert.deepEqual(result.path, [toolCache('maven/3.9.16/x64/bin')]);
  assert.match(result.log, /^maven@3: 3\.9\.16 cached -> /m);
});

test('a present version with build metadata is output with its +', async () => {
  await mkdir(toolCache('maven/3.9.16-1/x64/bin'), { recursive: true });
  await writeFile(toolCache('maven/3.9.16-1/x64.complete'), '');
  const result = await action({ tools: 'maven@3.9.16+1' });
  assert.equal(result.status, 0, result.log);
  assert.equal(result.outputs.versions, '{"maven":"3.9.16+1"}');
  assert.deepEqual(registry.requests, []);
});

test('a version without its complete marker is not present and is installed again', async () => {
  await mkdir(toolCache('maven/3.9.16/x64/bin'), { recursive: true });
  const result = await action({ tools: 'maven@3.9.16' });
  assert.equal(result.status, 0, result.log);
  assert.equal(execFileSync(toolCache('maven/3.9.16/x64/bin/mvn'), { encoding: 'utf8' }), 'Apache Maven 3.9.16\n');
  assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
});

test('a selector resolves to the highest matching version by number, not text', async () => {
  const result = await action({ tools: 'maven@3' });
  assert.equal(result.outputs.versions, '{"maven":"3.10.1"}');
  assert.ok(existsSync(toolCache('maven/3.10.1/x64.complete')));
});

test('a selector without a version takes the highest version', async () => {
  const result = await action({ tools: 'maven' });
  assert.equal(result.outputs.versions, '{"maven":"3.10.1"}');
});

test('a selector matches whole version parts: maven@3.1 is not 3.10.1', async () => {
  const result = await action({ tools: 'maven@3.1' });
  assert.notEqual(result.status, 0);
  assert.match(result.log, new RegExp(`::error::infra-tools: maven@3\\.1 matches no version in ${registry.host}/${REPOSITORY}:test-tools`));
  assert.equal(result.outputs.versions, undefined);
});

test('an unknown tool fails and names the available tools', async () => {
  const result = await action({ tools: 'mavne@3' });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /::error::infra-tools: unknown tool 'mavne'; tools: .*\bmaven\b/);
  assert.deepEqual(registry.requests, []);
});

test('a failed download is retried', async () => {
  registry.failures[digestOf('3.9.16', 'linux/amd64')] = 2;
  const result = await action({ tools: 'maven@3.9' });
  assert.equal(result.status, 0, result.log);
  assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
});

test('a layer that does not match its digest is never marked complete', async () => {
  const digest = digestOf('3.9.16', 'linux/amd64');
  registry.corrupt.add(digest);
  try {
    const result = await action({ tools: 'maven@3.9' });
    assert.notEqual(result.status, 0);
    assert.equal(registry.requests.filter((r) => r.endsWith(`/blobs/${digest}`)).length, 3);
    assert.match(result.log, new RegExp(`::error::infra-tools: maven: could not download layer ${digest}`));
    assert.ok(!existsSync(toolCache('maven/3.9.16/x64.complete')));
  } finally {
    registry.corrupt.clear();
  }
});

test('an arm64 runner installs the arm64 layer into its arch folder', async () => {
  const result = await action({ tools: 'maven@3.9', env: { RUNNER_ARCH: 'ARM64' } });
  assert.equal(result.status, 0, result.log);
  assert.ok(existsSync(toolCache('maven/3.9.16/arm64.complete')));
  assert.deepEqual(result.path, [toolCache('maven/3.9.16/arm64/bin')]);
});

// macOS runners run the action with their bash 3.2 (/bin/bash on macOS; bash 5 elsewhere).
test('a non-Linux runner installs nothing and succeeds', async () => {
  const result = await action({ tools: 'maven@3', env: { RUNNER_OS: 'macOS' }, bash: '/bin/bash' });
  assert.equal(result.status, 0, result.log);
  assert.equal(result.outputs.versions, '{}');
  assert.match(result.log, /::notice::infra-tools: macOS runners are not supported, nothing installed/);
  assert.deepEqual(registry.requests, []);
});

test('no selected tool gives an empty versions output without a network call', async () => {
  const result = await action({ tools: '\n' });
  assert.equal(result.status, 0, result.log);
  assert.equal(result.outputs.versions, '{}');
  assert.deepEqual(registry.requests, []);
});

test('an unreachable registry fails with a clear message', async () => {
  const result = await action({ tools: 'maven@3', env: { INDEX: '127.0.0.1:1/camunda/infra-tools:none' } });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /::error::infra-tools: cannot reach 127\.0\.0\.1:1/);
});

// A copy of the action, with the tool definitions of tools/ and the given release-please manifest (none: no manifest).
async function actionWithManifest(manifest) {
  const action = join(runner, 'action');
  await mkdir(join(action, 'action'), { recursive: true });
  await writeFile(join(action, 'action/setup.sh'), await readFile(SETUP));
  await cp(fileURLToPath(new URL('../../tools', import.meta.url)), join(action, 'tools'), { recursive: true });
  if (manifest) {
    await mkdir(join(action, '.github/config'), { recursive: true });
    await writeFile(join(action, '.github/config/.release-please-manifest.json'), manifest);
  }
  return join(action, 'action/setup.sh');
}

// ghcr.io is reached through the fake registry as an http proxy: no network.
test('without the index input, the action installs from the index of the release of its release-please manifest', async () => {
  const setup = await actionWithManifest('{\n  ".": "1.2.3"\n}\n');
  const result = await action({ tools: 'maven@3.9', setup, env: { INDEX: '', http_proxy: `http://${registry.host}` } });
  assert.equal(result.status, 0, result.log);
  assert.ok(registry.requests.includes('GET http://ghcr.io/v2/camunda/infra-tools/manifests/1.2.3-tools'), registry.requests.join('\n'));
  assert.match(result.log, /^infra-tools: ghcr\.io\/camunda\/infra-tools:1\.2\.3-tools \(linux\/amd64\)$/m);
  assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
});

test('before the first release, the action without the index input fails and asks for one', async () => {
  for (const manifest of ['{\n  ".": "0.0.0"\n}\n', undefined]) {
    const setup = await actionWithManifest(manifest);
    const result = await action({ tools: 'maven@3.9', setup, env: { INDEX: '' } });
    assert.notEqual(result.status, 0);
    assert.match(result.log, /::error::infra-tools: no release yet: set the index input/);
    await rm(join(runner, 'action'), { recursive: true });
  }
});

test('a missing tool cache folder is created', async () => {
  await rm(toolCache(), { recursive: true });
  const result = await action({ tools: 'maven@3.9' });
  assert.equal(result.status, 0, result.log);
  assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
});

// GKE runner set: the fake registry plays ghcr.io, the mirror fake Artifact Registry and the GKE metadata server, via a proxy.
const MIRROR = 'europe-west1-docker.pkg.dev/ci-30-162810/infra-tools';
const SOURCE_INDEX = `ghcr.io/${REPOSITORY}:test-tools`;
const METADATA_TOKEN = 'workload-identity-token';

let mirror;
let proxy;
let routes; // host → fake registry host the proxy sends it to
// Called once the test index is filled: the mirror shares its content.
async function startMirror() {
  mirror = new FakeRegistry({ name: `ci-30-162810/infra-tools/${REPOSITORY}`, metadataToken: METADATA_TOKEN });
  await mirror.start();
  // Same content, same digests.
  mirror.blobs = registry.blobs;
  mirror.manifests = registry.manifests;
  routes = { 'ghcr.io': registry.host, 'europe-west1-docker.pkg.dev': mirror.host, 'metadata.google.internal': mirror.host };
  proxy = createServer((req, res) => {
    const url = new URL(req.url);
    const [hostname, port] = (routes[url.host] ?? url.host).split(':');
    const forward = request({ hostname, port, path: url.pathname + url.search, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    forward.on('error', () => res.writeHead(502).end());
    req.pipe(forward);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
}

async function stopMirror() {
  await mirror.stop();
  await new Promise((resolve) => proxy.close(resolve));
}

beforeEach(() => {
  mirror.requests = [];
  mirror.failures = {};
});

const onGke = (env = {}) => ({ INDEX: SOURCE_INDEX, INFRA_TOOLS_MIRROR: MIRROR, http_proxy: `http://127.0.0.1:${proxy.address().port}`, ...env });

test('with a mirror on Artifact Registry, tools come from the mirror with the Workload Identity token, not from ghcr.io', async () => {
  const result = await action({ tools: 'maven@3.9', env: onGke() });
  assert.equal(result.status, 0, result.log);
  assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
  assert.match(result.log, /^maven@3\.9: 3\.9\.16 installed .* from europe-west1-docker\.pkg\.dev -> /m);
  assert.ok(mirror.requests.includes(`GET /v2/ci-30-162810/infra-tools/${REPOSITORY}/manifests/test-tools`), mirror.requests.join('\n'));
  assert.ok(!mirror.requests.some((r) => r.startsWith('GET /token')), 'no token exchange on Artifact Registry');
  assert.deepEqual(registry.requests, []);
  assert.doesNotMatch(result.log, /::warning::/);
});

test('when the mirror fails, the action falls back to ghcr.io with a warning and succeeds', async () => {
  for (const [down, why] of [
    ['europe-west1-docker.pkg.dev', `cannot read the index ${MIRROR}/${REPOSITORY}:test-tools`],
    ['metadata.google.internal', 'no Workload Identity token for europe-west1-docker.pkg.dev'],
  ]) {
    const route = routes[down];
    routes[down] = '127.0.0.1:1';
    try {
      await rm(toolCache(), { recursive: true, force: true });
      registry.requests = [];
      const result = await action({ tools: 'maven@3.9', env: onGke() });
      assert.equal(result.status, 0, result.log);
      assert.ok(result.log.includes(`::warning::infra-tools: mirror ${MIRROR}/${REPOSITORY}:test-tools failed (${why}), using ${SOURCE_INDEX}`), result.log);
      assert.match(result.log, /^maven@3\.9: 3\.9\.16 installed .* from ghcr\.io -> /m);
      assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
    } finally {
      routes[down] = route;
    }
  }
});

test('a mirror without the release index, not copied yet, falls back to ghcr.io at once, without retries', async () => {
  const shared = mirror.manifests;
  mirror.manifests = new Map();
  try {
    const result = await action({ tools: 'maven@3.9', env: onGke() });
    assert.equal(result.status, 0, result.log);
    assert.ok(result.log.includes(`::warning::infra-tools: mirror ${MIRROR}/${REPOSITORY}:test-tools failed (no index ${MIRROR}/${REPOSITORY}:test-tools), using ${SOURCE_INDEX}`), result.log);
    assert.equal(mirror.requests.filter((r) => r.includes('/manifests/')).length, 1, mirror.requests.join('\n'));
  } finally {
    mirror.manifests = shared;
  }
});

test('a layer the mirror fails to serve comes from ghcr.io, with a warning', async () => {
  const digest = digestOf('3.9.16', 'linux/amd64');
  mirror.failures[digest] = Infinity;
  const result = await action({ tools: 'maven@3.9', env: onGke() });
  assert.equal(result.status, 0, result.log);
  assert.ok(result.log.includes(`::warning::infra-tools: mirror ${MIRROR}/${REPOSITORY}:test-tools failed (maven: could not download layer ${digest}), using ${SOURCE_INDEX}`), result.log);
  assert.ok(registry.requests.includes(`GET /v2/${REPOSITORY}/blobs/${digest}`), registry.requests.join('\n'));
  assert.match(result.log, /^maven@3\.9: 3\.9\.16 installed .* from ghcr\.io -> /m);
});

test('an index on another registry than ghcr.io ignores the mirror', async () => {
  const result = await action({ tools: 'maven@3.9', env: onGke({ INDEX: `${registry.host}/${REPOSITORY}:test-tools` }) });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(mirror.requests, []);
  assert.match(result.log, new RegExp(`^maven@3\\.9: 3\\.9\\.16 installed .* from ${registry.host} -> `, 'm'));
});

test('summary: true adds a table of the selected tools to the job summary', async () => {
  await mkdir(toolCache('maven/3.9.16/x64/bin'), { recursive: true });
  await writeFile(toolCache('maven/3.9.16/x64.complete'), '');
  const result = await action({ tools: 'maven@3.9\nmaven@3.10', env: { SUMMARY: 'true' } });
  assert.equal(result.status, 0, result.log);
  const rows = result.summary.split('\n').filter((l) => l.startsWith('|'));
  assert.deepEqual(rows.slice(0, 2), ['| Selector | Version | Result | Tool cache path |', '| --- | --- | --- | --- |']);
  assert.equal(rows[2], `| maven@3.9 | 3.9.16 | cached | ${toolCache('maven/3.9.16/x64')} |`);
  assert.match(rows[3], new RegExp(`^\\| maven@3\\.10 \\| 3\\.10\\.1 \\| installed \\d+\\.\\d MB .*from ${registry.host} \\| ${toolCache('maven/3.10.1/x64')} \\|$`));
  assert.equal(rows.length, 4);
});

test('the job summary is left alone by default', async () => {
  const result = await action({ tools: 'maven@3.9' });
  assert.equal(result.status, 0, result.log);
  assert.equal(result.summary, '');
});

// A file of the repository the action runs in (GITHUB_WORKSPACE).
async function repositoryFile(path, content) {
  const file = join(runner, 'workspace', path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

// An infra-tools step with the given inputs, as consumers pin it.
const step = (inputs) =>
  `jobs:
  build:
    steps:
    - uses: camunda/infra-tools@0123456789abcdef # 1.0.0
      with:
${Object.entries(inputs)
  .map(([input, selectors]) => `        ${input}: |\n${selectors.map((s) => `          ${s}\n`).join('')}`)
  .join('')}`;

// The real HOME, for a yq installed by a version manager (asdf shims read ~/.tool-versions).
const validate = (env = {}, options = {}) => action({ ...options, env: { MODE: 'validate', HOME: process.env.HOME, ...env } });

test('mode: validate passes the selectors of every workflow and local action, and installs nothing', async () => {
  await repositoryFile(
    '.github/workflows/ci.yml',
    `jobs:
  build:
    steps:
    - uses: actions/checkout@v6
      with:
        tools: nothing@1
    - uses: camunda/infra-tools@0123456789abcdef # 1.0.0
      with:
        tools: |
          maven@3.9
          maven@3.10.1
`,
  );
  await repositoryFile(
    '.github/actions/build/action.yaml',
    `runs:
  using: composite
  steps:
  - uses: camunda/infra-tools@0123456789abcdef # 1.0.0
    with:
      tools: maven
`,
  );
  const result = await validate();
  assert.equal(result.status, 0, result.log);
  assert.match(result.log, /^\.github\/workflows\/ci\.yml: maven@3\.9: 3\.9\.16 on linux\/amd64, 3\.9\.16 on linux\/arm64$/m);
  assert.match(result.log, /^\.github\/workflows\/ci\.yml: maven@3\.10\.1: /m);
  assert.match(result.log, /^\.github\/actions\/build\/action\.yaml: maven: 3\.10\.1 on linux\/amd64, 3\.10\.1 on linux\/arm64$/m);
  assert.doesNotMatch(result.log, /nothing@1/);
  assert.deepEqual(result.path, []);
  assert.deepEqual(await readdir(toolCache()), []);
  assert.equal(registry.requests.filter((r) => r.includes('/blobs/')).length, 0);
  assert.equal(result.outputs.versions, '{}');
});

test('mode: validate fails with an annotation on the file for each selector that matches no version on a platform', async () => {
  await repositoryFile('.github/workflows/ci.yml', step({ tools: ['maven@3.9', 'maven@3.10', 'maven@99'] }));
  await repositoryFile('.github/actions/build/action.yml', `runs:\n  using: composite\n  steps:\n  - uses: camunda/infra-tools@v1\n    with:\n      tools: maven@3.9.16\n`);
  const result = await validate({ INDEX: `${registry.host}/${REPOSITORY}:amd64-only-tools` });
  assert.notEqual(result.status, 0);
  const index = `${registry.host}/${REPOSITORY}:amd64-only-tools`.replaceAll('.', '\\.');
  const errors = result.log.split('\n').filter((l) => l.startsWith('::error'));
  assert.equal(errors.length, 3, result.log);
  assert.match(errors[0], new RegExp(`^::error file=\\.github/workflows/ci\\.yml::infra-tools: maven@3\\.9 matches no version in ${index} on linux/arm64$`));
  assert.match(errors[1], new RegExp(`^::error file=\\.github/workflows/ci\\.yml::infra-tools: maven@99 matches no version in ${index} on linux/amd64, linux/arm64$`));
  assert.match(errors[2], new RegExp(`^::error file=\\.github/actions/build/action\\.yml::infra-tools: maven@3\\.9\\.16 matches no version in ${index} on linux/arm64$`));
  assert.match(result.log, /^\.github\/workflows\/ci\.yml: maven@3\.10: 3\.10\.1 on linux\/amd64, 3\.10\.1 on linux\/arm64$/m);
  assert.deepEqual(await readdir(toolCache()), []);
});

test('mode: validate fails on a plain tool listed under tool-cache, naming the right input', async () => {
  await repositoryFile('.github/workflows/ci.yml', step({ 'tool-cache': ['maven@3'] }));
  const result = await validate();
  assert.notEqual(result.status, 0);
  assert.match(result.log, /^::error file=\.github\/workflows\/ci\.yml::infra-tools: maven is a plain tool: list it under tools, not tool-cache$/m);
});

test('mode: validate fails on a tool-cache tool listed under tools, naming the right input and its setup-* step', async () => {
  // A copy of the action with a tool-cache tool definition (no addToPath).
  const action = join(runner, 'action');
  await mkdir(join(action, 'action'), { recursive: true });
  await writeFile(join(action, 'action/setup.sh'), await readFile(SETUP));
  await mkdir(join(action, 'tools/java'), { recursive: true });
  await writeFile(join(action, 'tools/java/tool.json'), JSON.stringify({ install: { cacheFolder: 'Java_Temurin-Hotspot_jdk' } }));
  await repositoryFile('.github/workflows/ci.yml', step({ tools: ['java@21'] }));
  const result = await validate({}, { setup: join(action, 'action/setup.sh') });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /^::error file=\.github\/workflows\/ci\.yml::infra-tools: java is a tool-cache tool: list it under tool-cache, not tools, and keep its setup-\* step$/m);
});

test('mode: validate fails on an unknown tool', async () => {
  await repositoryFile('.github/workflows/ci.yml', step({ tools: ['mavne@3'] }));
  const result = await validate();
  assert.notEqual(result.status, 0);
  assert.match(result.log, /^::error file=\.github\/workflows\/ci\.yml::infra-tools: unknown tool 'mavne'; tools: .*\bmaven\b/m);
});

// The consumer workflows ci.yml validates on a real runner.
test('mode: validate passes the valid fixture of ci.yml and fails its invalid one', async () => {
  const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  await repositoryFile('.github/workflows/valid-selectors.yml', await fixture('valid-selectors.yml'));
  const valid = await validate();
  assert.equal(valid.status, 0, valid.log);
  await repositoryFile('.github/workflows/invalid-selectors.yml', await fixture('invalid-selectors.yml'));
  const invalid = await validate();
  assert.notEqual(invalid.status, 0);
  const errors = invalid.log.split('\n').filter((l) => l.startsWith('::error'));
  assert.equal(errors.length, 2, invalid.log);
  assert.match(errors[0], /maven@99 matches no version/);
  assert.match(errors[1], /maven is a plain tool: list it under tools, not tool-cache/);
});

test('an unknown mode fails rather than installing', async () => {
  const result = await action({ tools: 'maven@3.9', env: { MODE: 'valdiate' } });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /^::error::infra-tools: unknown mode 'valdiate': use extract or validate$/m);
  assert.deepEqual(registry.requests, []);
});

test('mode: validate fails on a workflow it cannot read', async () => {
  await repositoryFile('.github/workflows/ci.yml', 'jobs: [\n');
  const result = await validate();
  assert.notEqual(result.status, 0);
  assert.match(result.log, /^::error file=\.github\/workflows\/ci\.yml::infra-tools: cannot read \.github\/workflows\/ci\.yml/m);
});
