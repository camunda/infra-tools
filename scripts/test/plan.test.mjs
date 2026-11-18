import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planTool } from '../lib/plan.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';

const now = Date.parse('2026-10-14T12:00:00Z');
const old = '2026-10-01T00:00:00Z';

// Renovate getPkgReleases stand-in: one release list for every lookup.
const upstream = (versions, releaseTimestamp = old) => async () => ({ releases: versions.map((version) => ({ version, releaseTimestamp })) });
const noTags = async () => false;

const java = (lines, publish = {}) => parseToolDefinition('java', { source: { datasource: 'java-version' }, publish: { ...publish, lines } });

const decisions = (plan) => plan.versions.map((v) => `${v.version}: ${v.decision} (${v.reason})`);

test('a line publishes from its from on, "*" publishes newer versions in no other line', async () => {
  const plan = await planTool(java({ 21: { from: '21.0.12' }, '*': { from: '27.0.0' } }), {
    lookup: upstream(['21.0.11+10', '21.0.12+8', '21.0.13+5', '22.0.0+36', '27.0.0+35', '28.0.0+1']),
    tagExists: noTags,
    now,
  });
  assert.deepEqual(decisions(plan), [
    '21.0.11+10: skip (before from 21.0.12)',
    '21.0.12+8: publish (new)',
    '21.0.13+5: publish (new)',
    '22.0.0+36: skip (in no line)',
    '27.0.0+35: publish (new)',
    '28.0.0+1: publish (new)',
  ]);
  assert.deepEqual(plan.versions[1], { version: '21.0.12+8', decision: 'publish', reason: 'new', line: '21', revision: 1, tag: 'java-21.0.12-8-r1' });
  assert.equal(plan.versions[4].line, '*');
});

test('every line state decides its versions (D41)', async () => {
  const tool = java({
    17: { retired: 'all' },
    21: { from: '21.0.12', versions: ['21.0.10+7'], ignoredVersions: ['21.0.13+5'], retired: ['21.0.12+8'], revisions: { '21.0.14+2': 2 } },
    25: { reason: 'stopped', revisions: { '25.0.1+8': 3 } },
    '*': { from: '27.0.0' },
  });
  const plan = await planTool(tool, {
    lookup: upstream(['17.0.18+8', '21.0.9+1', '21.0.10+7', '21.0.12+8', '21.0.13+5', '21.0.14+2', '25.0.1+8', '25.0.2+4', '27.0.0+35']),
    tagExists: noTags,
    now,
  });
  assert.deepEqual(decisions(plan), [
    '17.0.18+8: skip (line retired)',
    '21.0.9+1: skip (before from 21.0.12)',
    '21.0.10+7: publish (pinned in versions)',
    '21.0.12+8: skip (retired)',
    '21.0.13+5: skip (ignored)',
    '21.0.14+2: publish (revision 2)',
    '25.0.1+8: publish (revision 3)',
    '25.0.2+4: skip (line stopped)',
    '27.0.0+35: publish (new)',
  ]);
  assert.deepEqual(plan.versions.filter((v) => v.decision === 'publish').map((v) => v.tag), [
    'java-21.0.10-7-r1', 'java-21.0.14-2-r2', 'java-25.0.1-8-r3', 'java-27.0.0-35-r1',
  ]);
});

test('every build of the same X.Y.Z is kept and ordered; identity is the exact string (D23)', async () => {
  const plan = await planTool(java({ 21: { from: '21.0.12' } }), {
    lookup: upstream(['21.0.12+101.0.LTS', '21.0.11+10.0.LTS', '21.0.12+8.0.LTS', '21.0.12+8.0.LTS']),
    tagExists: noTags,
    now,
  });
  assert.deepEqual(decisions(plan), [
    '21.0.11+10.0.LTS: skip (before from 21.0.12)',
    '21.0.12+8.0.LTS: publish (new)',
    '21.0.12+101.0.LTS: publish (new)',
  ]);
});

test('versions newer than minAge wait; a line can override minAge; pinned versions never wait', async () => {
  const recent = '2026-10-14T06:00:00Z';
  const tool = java({ 21: { from: '21.0.12' }, 25: { from: '25.0.4', minAge: '1 hour' }, 26: { versions: ['26.0.1+8'] }, '*': { from: '27.0.0' } });
  const plan = await planTool(tool, { lookup: upstream(['21.0.13+5', '25.0.5+3', '26.0.1+8', '27.0.1+2'], recent), tagExists: noTags, now });
  assert.deepEqual(decisions(plan), [
    '21.0.13+5: wait (released less than 1 day ago)',
    '25.0.5+3: publish (new)',
    '26.0.1+8: publish (pinned in versions)',
    '27.0.1+2: wait (released less than 1 day ago)',
  ]);
});

test('unstable versions are skipped by the tool versioning, unless pinned', async () => {
  const node = parseToolDefinition('node', {
    source: { datasource: 'node-version', versioning: 'semver' },
    publish: { lines: { 26: { from: '26.11.0', versions: ['26.0.0-rc.1'] }, '*': { from: '27.0.0' } } },
  });
  const plan = await planTool(node, { lookup: upstream(['27.1.0', '26.0.0-rc.1', '26.11.1', '27.0.0', '27.1.0-rc.1']), tagExists: noTags, now });
  assert.deepEqual(decisions(plan), [
    '26.0.0-rc.1: publish (pinned in versions)',
    '26.11.1: publish (new)',
    '27.0.0: publish (new)',
    '27.1.0-rc.1: skip (unstable)',
    '27.1.0: publish (new)',
  ]);
});

test('with {arch} in the package name, a version missing on one platform waits (D28)', async () => {
  const tool = parseToolDefinition('java', {
    source: { datasource: 'java-version', packageName: 'java-jdk?os=linux&architecture={arch}' },
    publish: { lines: { 21: { from: '21.0.12', versions: ['21.0.11+9'] } } },
    install: { archFolders: { amd64: 'x64', arm64: 'aarch64' } },
  });
  const lookups = [];
  const perArch = {
    'java-jdk?os=linux&architecture=x64': ['21.0.11+9', '21.0.12+8', '21.0.13+5'],
    'java-jdk?os=linux&architecture=aarch64': ['21.0.12+8'],
  };
  const lookup = async (config) => {
    lookups.push(config);
    return { releases: perArch[config.packageName].map((version) => ({ version, releaseTimestamp: old })) };
  };
  const plan = await planTool(tool, { lookup, tagExists: noTags, now });
  assert.deepEqual(lookups, Object.keys(perArch).map((packageName) => ({ datasource: 'java-version', packageName })));
  assert.deepEqual(decisions(plan), [
    '21.0.11+9: wait (missing on linux/arm64)',
    '21.0.12+8: publish (new)',
    '21.0.13+5: wait (missing on linux/arm64)',
  ]);
});

test('a version whose tag exists is published already; a revision bump plans the new tag (D10)', async () => {
  const tags = new Set(['java-21.0.12-8-r1', 'java-21.0.13-5-r1']);
  const tagExists = async (tag) => tags.has(tag);
  const tool = java({ 21: { from: '21.0.12', revisions: { '21.0.13+5': 2 } }, '*': { from: '27.0.0' } });
  const plan = await planTool(tool, { lookup: upstream(['21.0.11+9', '21.0.12+8', '21.0.13+5', '27.0.0+35']), tagExists, now });
  assert.deepEqual(decisions(plan), [
    '21.0.11+9: skip (before from 21.0.12)',
    '21.0.12+8: skip (published)',
    '21.0.13+5: publish (revision 2)',
    '27.0.0+35: publish (new)',
  ]);
});

test('upstream and registry outages fail the plan, never read as "no versions"', async () => {
  const tool = java({ '*': { from: '27.0.0' } });
  const plan = (options) => planTool(tool, { lookup: upstream(['27.0.0+35']), tagExists: noTags, now, ...options });
  // Renovate's getPkgReleases returns null when a lookup fails.
  await assert.rejects(plan({ lookup: async () => null }), { message: 'java: no upstream versions from java-version java (lookup failed or empty)' });
  await assert.rejects(plan({ lookup: async () => ({ releases: [] }) }), { message: 'java: no upstream versions from java-version java (lookup failed or empty)' });
  await assert.rejects(plan({ lookup: async () => { throw new Error('ECONNRESET'); } }), { message: 'ECONNRESET' });
  await assert.rejects(plan({ tagExists: async () => { throw new Error('HEAD ghcr.io: HTTP 503'); } }), { message: 'HEAD ghcr.io: HTTP 503' });
});

test('pinned versions and revisions must exist upstream', async () => {
  const tool = java({ 21: { versions: ['21.0.10+7'], revisions: { '21.0.11+9': 2 } }, '*': { from: '27.0.0' } });
  await assert.rejects(planTool(tool, { lookup: upstream(['21.0.12+8', '27.0.0+35']), tagExists: noTags, now }), {
    message: 'java: not found upstream: 21.0.10+7, 21.0.11+9',
  });
});
