import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCatalog } from '../lib/catalog.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';

const node = parseToolDefinition('node', {
  source: { datasource: 'node-version' },
  publish: { lines: { 24: { retired: ['24.19.0'] }, 26: { from: '26.11.1', revisions: { '26.11.1': 2 } } } },
});
const now = '2026-10-14T00:00:00.000Z';
const layout = { cacheFolder: 'node', archFolders: { amd64: 'x64', arm64: 'arm64' }, addToPath: null };

test('the catalog records new versions, republished revisions and retirements, with one change each', () => {
  const current = [
    { version: '24.19.0', line: '24', folderVersion: '24.19.0', revision: 1, tag: 'node-24.19.0-r1', ...layout, publishedAt: '2026-10-01T00:00:00.000Z' },
    { version: '26.11.1', line: '26', folderVersion: '26.11.1', revision: 1, tag: 'node-26.11.1-r1', ...layout, publishedAt: '2026-10-01T00:00:00.000Z' },
  ];
  const published = [
    { version: '26.11.2', line: '26', revision: 1, tag: 'node-26.11.2-r1' },
    { version: '26.11.1', line: '26', revision: 2, tag: 'node-26.11.1-r2' },
  ];
  const { entries, changes } = mergeCatalog(node, current, published, { now });
  assert.deepEqual(entries, [
    { ...current[0], retired: true },
    { version: '26.11.1', line: '26', folderVersion: '26.11.1', revision: 2, tag: 'node-26.11.1-r2', ...layout, publishedAt: now },
    { version: '26.11.2', line: '26', folderVersion: '26.11.2', revision: 1, tag: 'node-26.11.2-r1', ...layout, publishedAt: now },
  ]);
  assert.deepEqual(changes, [
    { type: 'feat', tool: 'node', text: 'publish 26.11.2' },
    { type: 'fix', tool: 'node', text: 'republish 26.11.1 (r2)' },
    { type: 'feat', breaking: true, tool: 'node', text: 'retire 24.19.0' },
  ]);
  assert.deepEqual(mergeCatalog(node, entries, published, { now: '2026-10-15T00:00:00.000Z' }), { entries, changes: [] }, 'merging again changes nothing');
});

test('build metadata is written as - in the folder version, and entries stay ordered by version', () => {
  const java = parseToolDefinition('java', { source: { datasource: 'java-version' }, publish: { lines: { 21: { from: '21.0.12' } } } });
  const { entries } = mergeCatalog(java, [], [
    { version: '21.0.12+101.0.LTS', line: '21', revision: 1, tag: 'java-21.0.12-101.0.LTS-r1' },
    { version: '21.0.12+8.0.LTS', line: '21', revision: 1, tag: 'java-21.0.12-8.0.LTS-r1' },
  ], { now });
  assert.deepEqual(entries.map((e) => [e.version, e.folderVersion]), [['21.0.12+8.0.LTS', '21.0.12-8.0.LTS'], ['21.0.12+101.0.LTS', '21.0.12-101.0.LTS']]);
});
