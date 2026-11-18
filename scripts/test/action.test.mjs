// The action as consumers call it (seam 1), run against a fake registry: tool cache contents, PATH, outputs, logs and exit
// status. The CI workflow (ci.yml) runs the same action on real runners against ghcr.io.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeRegistry, REPOSITORY, TOKEN } from './fake-registry.mjs';

const SETUP = fileURLToPath(new URL('../action/setup.sh', import.meta.url));
const ARCH_FOLDERS = { 'linux/amd64': 'x64', 'linux/arm64': 'arm64' };

// A maven tool image layer: opt/hostedtoolcache/maven/<version>/<arch>, marked complete, as build/tool.Dockerfile makes it.
async function mavenLayer(dir, version, archFolder) {
  const root = join(dir, `maven-${version}-${archFolder}`);
  const home = join(root, 'opt/hostedtoolcache/maven', version, archFolder);
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, 'bin/mvn'), `#!/bin/sh\necho "Apache Maven ${version}"\n`);
  await chmod(join(home, 'bin/mvn'), 0o755);
  await writeFile(`${home}.complete`, '');
  return execFileSync('tar', ['czf', '-', '-C', root, 'opt']);
}

let work;
let registry;

// The test index: maven 3.9.16 and 3.10.1 on both platforms.
before(async () => {
  work = await mkdtemp(join(tmpdir(), 'infra-tools-action-'));
  registry = new FakeRegistry();
  await registry.start();
  const entries = [];
  for (const version of ['3.9.16', '3.10.1']) {
    for (const [platform, archFolder] of Object.entries(ARCH_FOLDERS)) {
      const bytes = await mavenLayer(work, version, archFolder);
      entries.push({
        platform,
        tool: 'maven',
        version,
        line: version.split('.').slice(0, 2).join('.'),
        folderVersion: version,
        revision: 1,
        tag: `maven-${version}-r1`,
        cacheFolder: 'maven',
        archFolder,
        addToPath: 'bin',
        digest: registry.addBlob(bytes),
        size: bytes.length,
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      });
    }
  }
  registry.addIndex('test-tools', entries);
});

after(async () => {
  await registry.stop();
  await rm(work, { recursive: true, force: true });
});

const digestOf = (version, platform) => registry.indexEntries('test-tools').find((e) => e.version === version && e.platform === platform).digest;

let runner;
beforeEach(async () => {
  runner = await mkdtemp(join(work, 'runner-'));
  await mkdir(join(runner, 'tool-cache'));
  await mkdir(join(runner, 'temp'));
  registry.requests = [];
});

// Runs the action like the composite step of action.yml does, with the runner's environment.
function action({ tools = '', env = {} } = {}) {
  const files = { output: join(runner, 'output'), path: join(runner, 'path') };
  const child = spawn('bash', [SETUP], {
    env: {
      PATH: process.env.PATH,
      HOME: runner,
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      RUNNER_TOOL_CACHE: join(runner, 'tool-cache'),
      RUNNER_TEMP: join(runner, 'temp'),
      GITHUB_OUTPUT: files.output,
      GITHUB_PATH: files.path,
      TOOLS: tools,
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
      resolve({ status, log, outputs, path: (await read(files.path)).split('\n').filter(Boolean) });
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

test('a non-Linux runner installs nothing and succeeds', async () => {
  const result = await action({ tools: 'maven@3', env: { RUNNER_OS: 'macOS' } });
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
