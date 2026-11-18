// The action as consumers call it (seam 1), run against a fake registry: tool cache contents, PATH, outputs, logs and exit
// status. The CI workflow (ci.yml) runs the same action on real runners against ghcr.io.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MEDIA_TYPES, ociIndex } from '../lib/oci-index.mjs';

const SETUP = fileURLToPath(new URL('../action/setup.sh', import.meta.url));
const REPOSITORY = 'camunda/infra-tools';
const TOKEN = 'job-token';
const ARCH_FOLDERS = { 'linux/amd64': 'x64', 'linux/arm64': 'arm64' };

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

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

// Fake OCI registry: bearer token exchange as on ghcr.io, the test index, its manifests and the layers. Records every request.
class FakeRegistry {
  requests = [];
  blobs = {};
  failures = {}; // digest → number of 500 responses before serving it
  corrupt = new Set(); // digests served with other bytes

  async start(layers) {
    const entries = [];
    for (const { version, platform, bytes } of layers) {
      const digest = sha256(bytes);
      this.blobs[digest] = bytes;
      entries.push({
        platform,
        tool: 'maven',
        version,
        line: version.split('.').slice(0, 2).join('.'),
        folderVersion: version,
        revision: 1,
        tag: `maven-${version}-r1`,
        cacheFolder: 'maven',
        archFolder: ARCH_FOLDERS[platform],
        addToPath: 'bin',
        digest,
        size: bytes.length,
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      });
    }
    const { index, manifests } = ociIndex(entries);
    this.manifests = { 'test-tools': [MEDIA_TYPES.index, index] };
    for (const [digest, manifest] of Object.entries(manifests)) this.manifests[digest] = [MEDIA_TYPES.manifest, manifest];
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.host = `127.0.0.1:${this.server.address().port}`;
  }

  handle(req, res) {
    this.requests.push(req.url);
    const url = new URL(req.url, `http://${this.host}`);
    if (url.pathname === '/token') {
      const basic = `Basic ${Buffer.from(`token:${TOKEN}`).toString('base64')}`;
      if (req.headers.authorization !== basic || url.searchParams.get('scope') !== `repository:${REPOSITORY}:pull`) return res.writeHead(401).end();
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token: 'bearer-token' }));
    }
    if (req.headers.authorization !== 'Bearer bearer-token') {
      const challenge = `Bearer realm="http://${this.host}/token",service="${this.host}",scope="repository:${REPOSITORY}:pull"`;
      return res.writeHead(401, { 'WWW-Authenticate': challenge }).end();
    }
    const match = url.pathname.match(/^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/);
    if (!match || match[1] !== REPOSITORY) return res.writeHead(404).end();
    const [, , kind, reference] = match;
    if (kind === 'manifests') {
      if (!this.manifests[reference]) return res.writeHead(404).end();
      const [mediaType, json] = this.manifests[reference];
      return res.writeHead(200, { 'Content-Type': mediaType }).end(JSON.stringify(json));
    }
    if (!this.blobs[reference]) return res.writeHead(404).end();
    if (this.failures[reference] > 0) {
      this.failures[reference]--;
      return res.writeHead(500).end();
    }
    const bytes = this.corrupt.has(reference) ? Buffer.concat([this.blobs[reference], Buffer.from('x')]) : this.blobs[reference];
    return res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(bytes);
  }

  digestOf(version, platform) {
    const [, index] = this.manifests['test-tools'];
    const manifest = this.manifests[index.manifests.find((m) => `${m.platform.os}/${m.platform.architecture}` === platform).digest][1];
    return manifest.layers.find((l) => l.annotations['io.camunda.infra-tools.version'] === version).digest;
  }

  stop() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

let work;
let registry;

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'infra-tools-action-'));
  const layers = [];
  for (const version of ['3.9.16', '3.10.1']) {
    for (const platform of Object.keys(ARCH_FOLDERS)) layers.push({ version, platform, bytes: await mavenLayer(work, version, ARCH_FOLDERS[platform]) });
  }
  registry = new FakeRegistry();
  await registry.start(layers);
});

after(async () => {
  await registry.stop();
  await rm(work, { recursive: true, force: true });
});

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
  registry.failures[registry.digestOf('3.9.16', 'linux/amd64')] = 2;
  const result = await action({ tools: 'maven@3.9' });
  assert.equal(result.status, 0, result.log);
  assert.ok(existsSync(toolCache('maven/3.9.16/x64.complete')));
});

test('a layer that does not match its digest is never marked complete', async () => {
  const digest = registry.digestOf('3.9.16', 'linux/amd64');
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
