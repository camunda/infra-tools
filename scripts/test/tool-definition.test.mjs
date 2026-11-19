import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseToolDefinition } from '../lib/tool-definition.mjs';

test('a tool definition keeps its three blocks and fills the defaults', () => {
  const maven = parseToolDefinition('maven', {
    source: { datasource: 'maven', packageName: 'org.apache.maven:apache-maven', versioning: 'semver' },
    publish: { lines: { 3.9: { from: '3.9.16' } } },
    install: { addToPath: 'bin' },
  });
  assert.deepEqual(maven, {
    name: 'maven',
    source: { datasource: 'maven', packageName: 'org.apache.maven:apache-maven', versioning: 'semver' },
    publish: { minAge: '1 day', lines: { 3.9: { from: '3.9.16' } } },
    install: { cacheFolder: 'maven', archFolders: { amd64: 'x64', arm64: 'arm64' }, addToPath: 'bin' },
    test: { packages: [] },
  });
});

test('a tool-cache tool has no addToPath and the package name defaults to the tool name', () => {
  const node = parseToolDefinition('node', { source: { datasource: 'node-version' }, publish: { lines: { '*': { from: '26.0.0' } } } });
  assert.equal(node.source.packageName, 'node');
  assert.equal(node.install.addToPath, null);
});

const rejects = (json, message) => assert.throws(() => parseToolDefinition('jq', json), { message });
const lines = { '*': { from: '1.8.2' } };

test('unknown blocks and options are rejected, required options are checked', () => {
  rejects({ source: { datasource: 'github-releases' }, publish: { lines }, build: {} }, 'tools/jq/tool.json: unknown block build');
  rejects({ source: { datasource: 'github-releases', from: '1.8.2' }, publish: { lines } }, 'tools/jq/tool.json: unknown option source.from');
  rejects({ source: { datasource: 'github-releases' }, publish: { lines, startVersion: '1.8.2' } }, 'tools/jq/tool.json: unknown option publish.startVersion');
  rejects({ publish: { lines } }, 'tools/jq/tool.json: missing source.datasource');
  rejects({ source: { datasource: 'github-releases' } }, 'tools/jq/tool.json: missing publish.lines');
  rejects({ source: { datasource: 'github-releases' }, publish: { lines: {} } }, 'tools/jq/tool.json: missing publish.lines');
});

test('install options are checked', () => {
  const source = { datasource: 'github-releases' };
  rejects({ source, publish: { lines }, install: { archFolders: { amd64: 'x64' } } }, 'tools/jq/tool.json: install.archFolders needs a folder for amd64 and arm64');
  rejects({ source, publish: { lines }, install: { addToPath: true } }, 'tools/jq/tool.json: install.addToPath is a folder name');
  rejects({ source, publish: { lines, minAge: 'soon' } }, 'tools/jq/tool.json: publish.minAge: invalid duration soon (e.g. "1 day", "6 hours")');
  rejects({ source, publish: { lines, minAge: 1 } }, 'tools/jq/tool.json: publish.minAge is a duration string (e.g. "1 day")');
});

test('a tool-cache tool names its setup-* action and version input for the usage snippet; a plain tool has none (D53)', () => {
  const setup = { action: 'actions/setup-java', versionInput: 'java-version', with: { distribution: 'temurin' } };
  const java = parseToolDefinition('java', { source: { datasource: 'java-version' }, publish: { lines: { 21: { from: '21.0.12' } } }, setup });
  assert.deepEqual(java.setup, setup);
  assert.deepEqual(parseToolDefinition('node', { source: { datasource: 'node-version' }, publish: { lines }, setup: { action: 'actions/setup-node', versionInput: 'node-version' } }).setup, {
    action: 'actions/setup-node',
    versionInput: 'node-version',
    with: {},
  });
  const source = { datasource: 'github-releases' };
  rejects({ source, publish: { lines }, setup: { action: 'actions/setup-jq' } }, 'tools/jq/tool.json: setup needs action and versionInput');
  rejects({ source, publish: { lines }, setup: { action: 'actions/setup-jq', versionInput: 'version', with: { cache: true } } }, 'tools/jq/tool.json: setup.with maps inputs to strings');
  rejects({ source, publish: { lines }, setup: { action: 'actions/setup-jq', versionInput: 'version', with: 'cache' } }, 'tools/jq/tool.json: setup.with maps inputs to strings');
  rejects({ source, publish: { lines }, setup: { action: 'actions/setup-jq', versionInput: 'version', with: null } }, 'tools/jq/tool.json: setup.with maps inputs to strings');
  rejects({ source, publish: { lines }, setup: { action: 'actions/setup-jq', versionInput: 'version', uses: 'x' } }, 'tools/jq/tool.json: unknown option setup.uses');
  rejects({ source, publish: { lines }, install: { addToPath: 'bin' }, setup: { action: 'actions/setup-jq', versionInput: 'version' } }, 'tools/jq/tool.json: setup is for tool-cache tools; a plain tool (install.addToPath) is ready to use');
});

test('a tool lists the apt packages its test needs on top of the Ubuntu image', () => {
  const maven = parseToolDefinition('maven', { source: { datasource: 'maven' }, publish: { lines }, install: { addToPath: 'bin' }, test: { packages: ['openjdk-21-jre-headless'] } });
  assert.deepEqual(maven.test, { packages: ['openjdk-21-jre-headless'] });
  const source = { datasource: 'github-releases' };
  rejects({ source, publish: { lines }, test: { packages: 'libatomic1' } }, 'tools/jq/tool.json: test.packages is a list of apt package names');
  rejects({ source, publish: { lines }, test: { packages: ['libatomic1 curl'] } }, 'tools/jq/tool.json: test.packages is a list of apt package names');
  rejects({ source, publish: { lines }, test: { packages: ['$(curl x)'] } }, 'tools/jq/tool.json: test.packages is a list of apt package names');
  rejects({ source, publish: { lines }, test: { script: 'test.sh' } }, 'tools/jq/tool.json: unknown option test.script');
});

test('version lines are validated (D41)', () => {
  const java = (lines) => parseToolDefinition('java', { source: { datasource: 'java-version' }, publish: { lines } });
  const bad = (lines, message) => assert.throws(() => java(lines), { message: `tools/java/tool.json: ${message}` });
  bad({ '21.x': { from: '21.0.1' } }, 'publish.lines.21.x: a line is a major ("21"), a minor ("1.25") or "*"');
  bad({ 21: {} }, 'publish.lines.21: empty line; delete it, or set from, versions, revisions or retired');
  bad({ 21: { reason: 'stopped' } }, 'publish.lines.21: empty line; delete it, or set from, versions, revisions or retired');
  bad({ 21: { ignoredVersions: ['21.0.1'], reason: 'stopped' } }, 'publish.lines.21: empty line; delete it, or set from, versions, revisions or retired');
  bad({ 21: { from: '21.0.12', start: '21.0.1' } }, 'publish.lines.21: unknown option start');
  bad({ 21: { from: '22.0.0' } }, 'publish.lines.21: from 22.0.0 is not in line 21');
  bad({ 21: { versions: ['22.0.1'] } }, 'publish.lines.21: versions 22.0.1 is not in line 21');
  bad({ 21: { from: '21.0.12', ignoredVersions: ['210.0.1'] } }, 'publish.lines.21: ignoredVersions 210.0.1 is not in line 21');
  bad({ 21: { revisions: { '25.0.1': 2 } } }, 'publish.lines.21: revisions 25.0.1 is not in line 21');
  bad({ 21: { retired: ['17.0.1'] } }, 'publish.lines.21: retired 17.0.1 is not in line 21');
  bad({ 21: { from: '21.0.12', versions: ['21.0.12+8'] } }, 'publish.lines.21: versions 21.0.12+8 is at or above from 21.0.12; from already publishes it');
  bad({ 21: { versions: '21.0.1' } }, 'publish.lines.21: versions is a list of versions');
  bad({ 1.1: { from: 1.10 } }, 'publish.lines.1.1: from is a version string');
  bad({ 21: { from: '21.0.12', minAge: 6 } }, 'publish.lines.21: minAge is a duration string (e.g. "1 day")');
  bad({ 21: { from: '21.0.12', reason: ['a', 'b'] } }, 'publish.lines.21: reason is a string');
  bad({ 21: { revisions: { '21.0.1': 0 } } }, 'publish.lines.21: revisions maps a version to a revision number from 1');
  bad({ 21: { retired: 'some' } }, 'publish.lines.21: retired is a list of versions or "all"');
  bad({ 21: { retired: 'all', from: '21.0.12' } }, 'publish.lines.21: "retired": "all" excludes from');
  bad({ 21: { from: '21.0.12', minAge: 'soon' } }, 'publish.lines.21: minAge: invalid duration soon (e.g. "1 day", "6 hours")');
  bad({ '*': { retired: 'all' } }, 'publish.lines.*: "retired": "all" is not allowed on "*"; give its versions a line first');
  bad({ '*': { minAge: '1 day' } }, 'publish.lines.*: "*" needs from');
  bad({ '*': { from: '27.0.0', versions: ['27.0.1'] } }, 'publish.lines.*: "*" cannot have versions; pin them in their own line');
  bad({ '*': { from: '27.0.0', retired: ['26.0.1'] } }, 'publish.lines.*: retired 26.0.1 is not in line *');
  bad({ 26: { from: '26.0.0' }, 26.11: { from: '26.11.1' } }, 'publish.lines.26 and publish.lines.26.11 overlap; keep the major or its minors');
  bad({ 28: { from: '28.0.0' }, '*': { from: '27.0.0' } }, 'publish.lines.28 is at or above publish.lines.* (from 27.0.0); move "*".from past 28');
  bad({ 27: { from: '27.0.1' }, '*': { from: '27.0.0' } }, 'publish.lines.27 is at or above publish.lines.* (from 27.0.0); move "*".from past 27');

  const ok = java({
    17: { retired: 'all', reason: 'end of life' },
    21: { from: '21.0.12', versions: ['21.0.11+9'], ignoredVersions: ['21.0.12+8.0.LTS'], revisions: { '21.0.12+101.0.LTS': 2 }, minAge: '6 hours' },
    25: { reason: 'stopped', retired: ['25.0.1+8'] },
    '*': { from: '27.0.0', ignoredVersions: ['27.0.1+3'] },
  });
  assert.equal(ok.publish.lines['17'].reason, 'end of life');
});
