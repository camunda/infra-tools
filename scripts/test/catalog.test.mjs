import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changesMarkdown, commitMessage, diffIndex, mergeIndex, updateCatalog } from '../lib/catalog.mjs';
import { normalizeTool } from '../lib/config.mjs';

const node = normalizeTool('node', { source: { datasource: 'node-version' }, publish: { lines: { 24: { retired: ['24.19.0'] }, 26: { from: '26.11.1' } } } });
const entry = (tool, version, revision, platform, digest) => ({ tool, version, revision, platform, digest, tag: `${tool}-${version}-r${revision}` });

test('catalog records new versions, republished revisions and retirements', () => {
  const current = [
    { version: '24.19.0', revision: 1, tag: 'node-24.19.0-r1' },
    { version: '26.11.1', revision: 1, tag: 'node-26.11.1-r1' },
  ];
  const published = [
    { version: '26.11.2', revision: 1, tag: 'node-26.11.2-r1', line: '26' },
    { version: '26.11.1', revision: 2, tag: 'node-26.11.1-r2' },
  ];
  const { entries, changes } = updateCatalog(node, current, published, '2026-10-14T00:00:00Z');
  assert.deepEqual(changes.map((c) => `${c.type}${c.breaking ? '!' : ''} ${c.text}`), ['feat publish 26.11.2', 'fix republish 26.11.1 (r2)', 'feat! retire 24.19.0']);
  assert.equal(entries.find((e) => e.version === '26.11.1').revision, 2);
  assert.equal(entries.find((e) => e.version === '26.11.2').line, '26');
  assert.equal(entries.find((e) => e.version === '24.19.0').retired, true);
  assert.equal(updateCatalog(node, entries, published).changes.length, 0, 'idempotent');
});

test('commit message carries one conventional entry per change', () => {
  const message = commitMessage([
    { type: 'feat', tool: 'node', text: 'publish 26.11.2' },
    { type: 'feat', breaking: true, tool: 'node', text: 'retire 24.19.0' },
  ]);
  assert.equal(message, 'feat(node): publish 26.11.2\n\nfeat(node)!: retire 24.19.0\n');
  assert.equal(commitMessage([]), '');
});

test('index merge keeps previous versions, replaces revisions, drops retired, rejects digest changes', () => {
  const previous = [entry('node', '24.19.0', 1, 'linux/amd64', 'a'), entry('node', '26.11.1', 1, 'linux/amd64', 'b')];
  const current = [entry('node', '26.11.1', 2, 'linux/amd64', 'c'), entry('node', '26.11.2', 1, 'linux/amd64', 'd')];
  const { entries, errors } = mergeIndex(previous, current, new Set(['node|24.19.0']));
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => `${e.version}:${e.digest}`), ['26.11.1:c', '26.11.2:d']);
  const bad = mergeIndex(previous, [entry('node', '26.11.1', 1, 'linux/amd64', 'x')], new Set());
  assert.equal(bad.errors.length, 1);
});

test('diff lists added, replaced and retired versions once per version', () => {
  const previous = [entry('node', '24.19.0', 1, 'linux/amd64', 'a'), entry('node', '26.11.1', 1, 'linux/amd64', 'b'), entry('node', '26.11.1', 1, 'linux/arm64', 'b2')];
  const next = [entry('node', '26.11.1', 2, 'linux/amd64', 'c'), entry('node', '26.11.1', 2, 'linux/arm64', 'c2'), entry('node', '26.11.2', 1, 'linux/amd64', 'd'), entry('node', '26.11.2', 1, 'linux/arm64', 'd2')];
  const changes = diffIndex(previous, next);
  assert.deepEqual(changes.added.map((i) => [i.version, i.platforms.length]), [['26.11.2', 2]]);
  assert.deepEqual(changes.replaced.map((i) => [i.version, i.previousRevision, i.revision]), [['26.11.1', 1, 2]]);
  assert.deepEqual(changes.retired.map((i) => i.version), ['24.19.0']);
  const md = changesMarkdown({ version: '0.2.0', previous: '0.1.0', repository: 'camunda/infra-tools', changes });
  assert.match(md, /### ➕ Added/);
  assert.match(md, /r1 → r2/);
  assert.match(md, /node-26\.11\.2-r1\]\(https:\/\/github\.com\/camunda\/infra-tools\/releases\/tag\/node-26\.11\.2-r1\)/);
});
