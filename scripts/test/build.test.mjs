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
  publish: { lines: { 3.9: { versions: ['3.9.16'], ignoredVersions: ['3.9.15'] }, '*': { from: '3.10.0', retired: ['3.10.1'] } } },
  install: { addToPath: 'bin' },
});

test('a build target names the tool image tag and the build arguments of one tool version', () => {
  assert.deepEqual(buildTarget(maven, '3.9.16'), {
    tool: 'maven',
    version: '3.9.16',
    line: '3.9',
    revision: 1,
    tag: 'maven-3.9.16-r1',
    args: { TOOL: 'maven', VERSION: '3.9.16', FOLDER_VERSION: '3.9.16', CACHE_FOLDER: 'maven', ARCH_FOLDERS: 'amd64=x64 arm64=arm64' },
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
  });
});

test('only versions the tool definition publishes have a build target', () => {
  assert.throws(() => buildTarget(maven, '3.8.9'), { message: 'maven 3.8.9 is in no version line of tools/maven/tool.json' });
  assert.throws(() => buildTarget(maven, '3.9.15'), { message: 'maven 3.9.15 is ignored in line 3.9 of tools/maven/tool.json' });
  assert.throws(() => buildTarget(maven, '3.10.1'), { message: 'maven 3.10.1 is retired in line * of tools/maven/tool.json' });
});
