// The action as consumers call it (seam 1), run against a fake registry: tool cache contents, PATH, outputs, logs and exit
// status. The CI workflow (ci.yml) runs the same action on real runners against ghcr.io.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeRegistry, REPOSITORY, TOKEN } from './fake-registry.mjs';

const SETUP = fileURLToPath(new URL('../action/setup.sh', import.meta.url));
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
  // An index whose maven 3.9.16 is on linux/amd64 only.
  registry.addIndex('amd64-only-tools', entries.filter((e) => !(e.version === '3.9.16' && e.platform === 'linux/arm64')));
  // An index whose maven 3.9.16 layer on linux/amd64 matches its digest but is not a tarball.
  const broken = Buffer.from('not a tarball');
  registry.addIndex(
    'broken-tools',
    entries.map((e) => (e.version === '3.9.16' && e.platform === 'linux/amd64' ? { ...e, digest: registry.addBlob(broken), size: broken.length } : e)),
  );
});

after(async () => {
  await registry.stop();
  await rm(work, { recursive: true, force: true });
});

// The test-tools index entry of a tool version on a platform.
const indexEntry = (tool, version, platform) => registry.indexEntries('test-tools').find((e) => e.tool === tool && e.version === version && e.platform === platform);
const digestOf = (version, platform) => indexEntry('maven', version, platform).digest;

// maven 3.9.16, present in the tool cache of an amd64 runner.
async function presentMaven() {
  await mkdir(toolCache('maven/3.9.16/x64/bin'), { recursive: true });
  await writeFile(toolCache('maven/3.9.16/x64.complete'), '');
}

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
  await presentMaven();
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
test('a non-Linux runner installs nothing, writes no install figures and succeeds', async () => {
  const result = await action({ tools: 'maven@3', env: { RUNNER_OS: 'macOS' }, bash: '/bin/bash' });
  assert.equal(result.status, 0, result.log);
  assert.equal(result.outputs.versions, '{}');
  assert.match(result.log, /::notice::infra-tools: macOS runners are not supported, nothing installed/);
  assert.deepEqual(registry.requests, []);
  assert.deepEqual(await readdir(join(runner, 'temp')), []);
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

test('a missing tool cache folder is created', async () => {
  await rm(toolCache(), { recursive: true });
  const result = await action({ tools: 'maven@3.9' });
  assert.equal(result.status, 0, result.log);
  assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
});

test('summary: true adds a table of the selected tools to the job summary', async () => {
  await presentMaven();
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

// The install figures the action appended for submit-build-status (spec §5.6, ADR 0010), one object per line.
const figuresFile = () => join(runner, 'temp/ci-analytics/tool-installs.jsonl');
async function figures() {
  if (!existsSync(figuresFile())) return [];
  return (await readFile(figuresFile(), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const layerSize = (tool, version, platform = 'linux/amd64') => indexEntry(tool, version, platform).size;
// The release and platform of every line written from the test-tools index on an amd64 runner.
const testTools = { release: 'test-tools', platform: 'linux/amd64' };

test('install figures: one line per selected tool, present or installed, with the release and platform', async () => {
  await presentMaven();
  const result = await action({ tools: 'maven@3.9\nmaven@3.10', toolCacheTools: 'java@21' });
  assert.equal(result.status, 0, result.log);
  const [present, maven, java, ...rest] = await figures();
  assert.deepEqual(rest, []);
  assert.deepEqual(present, { tool: 'maven', selector: 'maven@3.9', version: '3.9.16', outcome: 'present', ...testTools });
  assert.deepEqual(Object.keys(maven), ['tool', 'selector', 'version', 'outcome', 'size_bytes', 'duration_ms', 'registry', 'release', 'platform']);
  assert.ok(Number.isInteger(maven.duration_ms) && maven.duration_ms >= 0, `duration_ms: ${maven.duration_ms}`);
  assert.deepEqual(
    { ...maven, duration_ms: 0 },
    { tool: 'maven', selector: 'maven@3.10', version: '3.10.1', outcome: 'installed', size_bytes: layerSize('maven', '3.10.1'), duration_ms: 0, registry: registry.host, ...testTools },
  );
  assert.equal(java.selector, 'java@21');
  assert.equal(java.version, '21.0.12+101.0.LTS');
  assert.equal(java.outcome, 'installed');
});

test('install figures: a second run in the same job appends its lines', async () => {
  await action({ tools: 'maven@3.9' });
  const result = await action({ tools: 'maven@3.9' });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(
    (await figures()).map(({ selector, outcome }) => ({ selector, outcome })),
    [
      { selector: 'maven@3.9', outcome: 'installed' },
      { selector: 'maven@3.9', outcome: 'present' },
    ],
  );
});

test('install figures: a login failure writes a failed line, without version, for each tool to install', async () => {
  await presentMaven();
  const result = await action({ tools: 'maven@3.9\nmaven@3.10', toolCacheTools: 'java@21', env: { TOKEN: 'wrong' } });
  assert.notEqual(result.status, 0);
  const failed = { outcome: 'failed', error: 'login', ...testTools };
  assert.deepEqual(await figures(), [
    { tool: 'maven', selector: 'maven@3.9', version: '3.9.16', outcome: 'present', ...testTools },
    { tool: 'maven', selector: 'maven@3.10', ...failed },
    { tool: 'java', selector: 'java@21', ...failed },
  ]);
});

test('install figures: an index that cannot be read writes a failed line, without version, for each tool to install', async () => {
  const result = await action({ tools: 'maven@3.9', env: { INDEX: `${registry.host}/${REPOSITORY}:missing-tools` } });
  assert.notEqual(result.status, 0);
  assert.deepEqual(await figures(), [{ tool: 'maven', selector: 'maven@3.9', outcome: 'failed', error: 'index', ...testTools, release: 'missing-tools' }]);
});

test('install figures: a selector matching no version writes a failed index line, after the lines already written', async () => {
  const result = await action({ tools: 'maven@3.10\nmaven@3.1' });
  assert.notEqual(result.status, 0);
  const [installed, failed, ...rest] = await figures();
  assert.deepEqual(rest, []);
  assert.equal(installed.outcome, 'installed');
  assert.deepEqual(failed, { tool: 'maven', selector: 'maven@3.1', outcome: 'failed', error: 'index', ...testTools });
});

test('install figures: a layer that cannot be downloaded writes a failed pull line with its version', async () => {
  const digest = digestOf('3.9.16', 'linux/amd64');
  registry.corrupt.add(digest);
  try {
    const result = await action({ tools: 'maven@3.9' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(await figures(), [{ tool: 'maven', selector: 'maven@3.9', version: '3.9.16', outcome: 'failed', error: 'pull', ...testTools }]);
  } finally {
    registry.corrupt.clear();
  }
});

test('install figures: a layer that cannot be extracted writes a failed extract line with its version', async () => {
  const result = await action({ tools: 'maven@3.9', env: { INDEX: `${registry.host}/${REPOSITORY}:broken-tools` } });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /::error::infra-tools: maven: cannot extract layer sha256:/);
  assert.ok(!existsSync(toolCache('maven/3.9.16/x64.complete')));
  assert.deepEqual(await figures(), [{ tool: 'maven', selector: 'maven@3.9', version: '3.9.16', outcome: 'failed', error: 'extract', ...testTools, release: 'broken-tools' }]);
});

test('install figures: a file that cannot be written is a warning, and the tools are still installed', async () => {
  // A file where the figures folder should be.
  await writeFile(join(runner, 'temp/ci-analytics'), '');
  const result = await action({ tools: 'maven@3.9\nmaven@3.10' });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(JSON.parse(result.outputs.versions), { maven: '3.10.1' });
  const warnings = result.log.split('\n').filter((l) => l.startsWith('::warning::'));
  assert.deepEqual(warnings, [`::warning::infra-tools: cannot write the install figures to ${figuresFile()}`]);
});

test('install figures: a file that cannot be written does not hide the install failure', async () => {
  await writeFile(join(runner, 'temp/ci-analytics'), '');
  const result = await action({ tools: 'maven@3.1' });
  assert.equal(result.status, 1);
  assert.match(result.log, /::warning::infra-tools: cannot write the install figures/);
  assert.match(result.log, /^::error::infra-tools: maven@3\.1 matches no version in /m);
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
  await mkdir(join(action, 'scripts/action'), { recursive: true });
  await writeFile(join(action, 'scripts/action/setup.sh'), await readFile(SETUP));
  await mkdir(join(action, 'tools/java'), { recursive: true });
  await writeFile(join(action, 'tools/java/tool.json'), JSON.stringify({ install: { cacheFolder: 'Java_Temurin-Hotspot_jdk' } }));
  await repositoryFile('.github/workflows/ci.yml', step({ tools: ['java@21'] }));
  const result = await validate({}, { setup: join(action, 'scripts/action/setup.sh') });
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
