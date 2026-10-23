import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRetired, lineFor, loadTools, normalizeTool, revisionOf } from '../lib/config.mjs';
import { classify } from '../lib/upstream.mjs';

const scheme = {
  isVersion: (v) => /^\d+(\.\d+)*/.test(v),
  isStable: (v) => !/-(alpha|beta|rc)/.test(v),
};
const now = Date.parse('2026-10-14T12:00:00Z');
const old = '2026-10-01T00:00:00Z';
const recent = '2026-10-14T06:00:00Z';
const found = (versions, releaseTimestamp = old) => versions.map((version) => ({ version, releaseTimestamp }));
const tool = (lines, publish = {}) => normalizeTool('java', { source: { datasource: 'java-version' }, publish: { ...publish, lines } });

test('lines: a line publishes from its from on, "*" publishes newer versions in no line', () => {
  const java = tool({ 21: { from: '21.0.12' }, '*': { from: '27.0.0' } });
  const out = classify(java, found(['21.0.11+10', '21.0.12+8', '21.0.13+5', '22.0.0+36', '26.0.2+10', '27.0.0+35', '28.0.0+1']), { now, scheme });
  assert.deepEqual(out.eligible, ['21.0.12+8', '21.0.13+5', '27.0.0+35', '28.0.0+1']);
  assert.deepEqual(out.lines, { '21.0.12+8': '21', '21.0.13+5': '21' });
});

test('lines: every build is kept, from is inclusive', () => {
  const java = tool({ 21: { from: '21.0.12' } });
  const out = classify(java, found(['21.0.11+10.0.LTS', '21.0.12+8.0.LTS', '21.0.12+101.0.LTS']), { now, scheme });
  assert.deepEqual(out.eligible, ['21.0.12+8.0.LTS', '21.0.12+101.0.LTS']);
});

test('lines: versions pin older versions, ignored and retired versions are skipped, lines only without "*"', () => {
  const node = normalizeTool('node', { source: { datasource: 'node-version' }, publish: { lines: {
    24: { retired: ['24.0.0'] },
    26: { from: '26.11.1', versions: ['26.10.0'], ignoredVersions: ['26.11.2'] },
  } } });
  const out = classify(node, found(['24.0.0', '24.1.0', '26.9.0', '26.10.0', '26.11.1', '26.11.2', '26.12.0', '27.0.0']), { now, scheme });
  assert.deepEqual(out.eligible, ['26.10.0', '26.11.1', '26.12.0']);
});

test('lines: retired all publishes nothing, revisions re-plan published versions', () => {
  const java = tool({ 17: { retired: 'all' }, 21: { revisions: { '21.0.12+8': 2 } }, '*': { from: '27.0.0' } });
  const out = classify(java, found(['17.0.18+8', '21.0.12+8', '21.0.13+5', '27.0.0+35']), { now, scheme });
  assert.deepEqual(out.eligible, ['21.0.12+8', '27.0.0+35']);
  assert.equal(revisionOf(java, '21.0.12+8'), 2);
  assert.equal(revisionOf(java, '27.0.0+35'), 1);
  assert.ok(isRetired(java, '17.0.18+8'));
  assert.ok(!isRetired(java, '21.0.12+8'));
});

test('lines: minAge is inherited or overridden, pinned versions do not wait', () => {
  const java = tool({ 21: { from: '21.0.12' }, 25: { from: '25.0.4', minAge: '1 hour' }, 26: { versions: ['26.0.1+8'] }, '*': { from: '27.0.0' } }, { minAge: '1 day' });
  const out = classify(java, found(['21.0.13+5', '25.0.5+3', '26.0.1+8', '27.0.1+2'], recent), { now, scheme });
  assert.deepEqual(out.eligible, ['25.0.5+3', '26.0.1+8']);
  assert.deepEqual(out.waiting, ['21.0.13+5', '27.0.1+2']);
});

test('lines: versions missing a platform are incomplete, unstable versions skipped', () => {
  const java = tool({ '*': { from: '21.0.12' } });
  const out = classify(java, [
    { version: '21.0.12+8.0.LTS', releaseTimestamp: old, count: 2 },
    { version: '21.0.13+8.0.LTS', releaseTimestamp: old, count: 1 },
    { version: '22.0.0-rc.1', releaseTimestamp: old, count: 2 },
  ], { now, scheme, platformLists: 2 });
  assert.deepEqual(out, { eligible: ['21.0.12+8.0.LTS'], waiting: [], incomplete: ['21.0.13+8.0.LTS'], lines: {} });
});

test('lines: pinned versions and revisions must exist upstream', () => {
  const node = normalizeTool('node', { source: { datasource: 'node-version' }, publish: { lines: { 26: { versions: ['26.10.0'] } } } });
  assert.throws(() => classify(node, found(['26.11.0']), { now, scheme }), /26\.10\.0/);
});

test('lineFor: explicit line, then "*" from its from on', () => {
  const go = normalizeTool('go', { source: { datasource: 'golang-version' }, publish: { lines: { 1.25: { from: '1.25.11' }, '*': { from: '1.27.2' } } } });
  assert.equal(lineFor(go, '1.25.3').key, '1.25');
  assert.equal(lineFor(go, '1.27.2').key, '*');
  assert.equal(lineFor(go, '1.26.9'), undefined);
});

test('blocks: options are read from their block, unknown blocks and options are rejected', () => {
  const jq = normalizeTool('jq', { source: { datasource: 'github-releases', packageName: 'jqlang/jq' }, publish: { lines: { '*': { from: '1.8.2' } } }, install: { addToPath: 'bin' } });
  assert.equal(jq.packageName, 'jqlang/jq');
  assert.equal(jq.addToPath, 'bin');
  assert.equal(jq.cacheFolder, 'jq');
  assert.throws(() => normalizeTool('jq', { source: { datasource: 'x' }, publish: { lines: { '*': { from: '1' } } }, extra: {} }), /unknown block extra/);
  assert.throws(() => normalizeTool('jq', { source: { datasource: 'x', from: '1' }, publish: { lines: { '*': { from: '1' } } } }), /unknown option source\.from/);
  assert.throws(() => normalizeTool('jq', { source: { datasource: 'x' }, publish: { startVersion: '1' } }), /unknown option publish\.startVersion/);
  assert.throws(() => normalizeTool('jq', { source: { datasource: 'x' } }), /missing publish\.lines/);
});

test('lines validation', () => {
  const bad = (lines, pattern) => assert.throws(() => tool(lines), pattern);
  bad({ '21.x': { from: '21.0.1' } }, /a line is a major/);
  bad({ 21: {} }, /empty line/);
  bad({ 21: { from: '22.0.0' } }, /from 22\.0\.0 is not in line 21/);
  bad({ 21: { versions: ['22.0.1'] } }, /versions 22\.0\.1 is not in line 21/);
  bad({ 21: { from: '21.0.12', versions: ['21.0.13'] } }, /already published by from/);
  bad({ 21: { from: '21.0.12', unknown: 1 } }, /unknown option unknown/);
  bad({ 21: { retired: 'all', from: '21.0.12' } }, /excludes from/);
  bad({ 21: { retired: 'some' } }, /list of versions or "all"/);
  bad({ '*': { retired: 'all' } }, /not allowed on "\*"/);
  bad({ '*': { minAge: '1 day' } }, /"\*" needs from/);
  bad({ '*': { from: '27.0.0', versions: ['27.0.1'] } }, /"\*" cannot have versions/);
  bad({ 26: { from: '26.0.0' }, 26.11: { from: '26.11.1' } }, /overlap; keep the major or its minors/);
  bad({ 28: { from: '28.0.0' }, '*': { from: '27.0.0' } }, /overlaps publish\.lines\.\* \(from 27\.0\.0\)/);
  bad({ 21: { from: '21.0.12', minAge: 'soon' } }, /invalid duration/);
  bad({ '*': { from: '27.0.0', retired: ['26.0.1'] } }, /retired 26\.0\.1 is not in line \*/);
  assert.equal(tool({ 21: { retired: 'all', reason: 'end of life' } }).lines['21'].reason, 'end of life');
  assert.ok(tool({ 21: { reason: 'stopped' }, '*': { from: '27.0.0' } }));
});

test('every tool config is valid', async () => {
  const tools = await loadTools();
  assert.equal(tools.length, 16);
  for (const t of tools) assert.ok(t.archFolders.amd64 && t.archFolders.arm64, `${t.name}: arch folders`);
});
