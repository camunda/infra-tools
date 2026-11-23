import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTarget } from '../lib/build.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';

const java = parseToolDefinition('java', {
  source: { datasource: 'java-version' },
  publish: { lines: { 21: { versions: ['21.0.12+8'], revisions: { '21.0.12+8': 2 } } } },
  install: { cacheFolder: 'Java_Temurin-Hotspot_jdk', archFolders: { amd64: 'x64', arm64: 'aarch64' } },
});
const maven = parseToolDefinition('maven', {
  source: { datasource: 'maven' },
  publish: { lines: { 3.9: { versions: ['3.9.16'], ignoredVersions: ['3.9.15'], reason: '3.9.15 fails' }, '*': { from: '3.10.0', retired: ['3.10.1'] } } },
  install: { addToPath: 'bin' },
  test: { packages: ['openjdk-21-jre-headless', 'libatomic1'] },
});

test('a build target names the tool image tag and the build arguments of one tool version', () => {
  assert.deepEqual(buildTarget(maven, '3.9.16'), {
    tool: 'maven',
    version: '3.9.16',
    line: '3.9',
    revision: 1,
    tag: 'maven-3.9.16-r1',
    args: {
      TOOL: 'maven',
      VERSION: '3.9.16',
      FOLDER_VERSION: '3.9.16',
      CACHE_FOLDER: 'maven',
      ARCH_FOLDERS: 'amd64=x64 arm64=arm64',
      TEST_PACKAGES: 'openjdk-21-jre-headless libatomic1',
    },
  });
});

test('a build target writes build metadata as - and carries the revision of its line', () => {
  const target = buildTarget(java, '21.0.12+8');
  assert.equal(target.tag, 'java-21.0.12-8-r2');
  assert.deepEqual(target.args, {
    TOOL: 'java',
    VERSION: '21.0.12+8',
    FOLDER_VERSION: '21.0.12-8',
    CACHE_FOLDER: 'Java_Temurin-Hotspot_jdk',
    ARCH_FOLDERS: 'amd64=x64 arm64=aarch64',
    TEST_PACKAGES: '',
  });
});

test('a build target takes the plan\'s revision, above its line\'s once a platform was added (D62)', () => {
  const target = buildTarget(java, '21.0.12+8', { revision: 3 });
  assert.deepEqual([target.revision, target.tag], [3, 'java-21.0.12-8-r3']);
});

test('only versions the tool definition publishes have a build target', () => {
  assert.throws(() => buildTarget(maven, '3.8.9'), { message: 'tools/maven/tool.json: maven 3.8.9 is in no version line' });
  assert.throws(() => buildTarget(maven, '3.9.15'), { message: 'tools/maven/tool.json: maven 3.9.15 is ignored in line 3.9' });
  assert.throws(() => buildTarget(maven, '3.10.1'), { message: 'tools/maven/tool.json: maven 3.10.1 is retired in line *' });
});

test('a line publishes its pinned versions and its versions from its from on, nothing else', () => {
  assert.throws(() => buildTarget(maven, '3.9.14'), { message: 'tools/maven/tool.json: maven 3.9.14 is not published by line 3.9' });
  assert.throws(() => buildTarget(maven, '3.9.17'), { message: 'tools/maven/tool.json: maven 3.9.17 is not published by line 3.9' });
  assert.equal(buildTarget(maven, '3.11.0').tag, 'maven-3.11.0-r1');
  assert.equal(buildTarget(java, '21.0.12+8').line, '21');
});

test('a dry run also builds a published version the tool definition no longer publishes, with its catalog line and revision', () => {
  const catalogEntry = { version: '3.8.9', line: '3.8', revision: 2, tag: 'maven-3.8.9-r2' };
  const target = buildTarget(maven, '3.8.9', { catalogEntry });
  assert.deepEqual([target.line, target.revision, target.tag], ['3.8', 2, 'maven-3.8.9-r2']);
  assert.equal(buildTarget(maven, '3.9.16', { catalogEntry: { version: '3.9.16', line: '3.9', revision: 1, tag: 'maven-3.9.16-r1' } }).tag, 'maven-3.9.16-r1');
  // Versions the tool definition retires are never built, retired in the catalog or not; one it no longer retires (restored)
  // is built even while the catalog still marks it retired.
  assert.throws(() => buildTarget(maven, '3.10.1', { catalogEntry: { version: '3.10.1', line: '*', revision: 1, tag: 'maven-3.10.1-r1' } }), { message: 'tools/maven/tool.json: maven 3.10.1 is retired in line *' });
  assert.equal(buildTarget(maven, '3.8.9', { catalogEntry: { ...catalogEntry, retired: true } }).tag, 'maven-3.8.9-r2');
});
