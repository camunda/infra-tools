import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalogTags, commitMessage, recordRun } from '../lib/reconcile.mjs';
import { parseToolDefinition } from '../lib/tool-definition.mjs';
import { catalogEntry } from './catalog-entry.mjs';

const node = parseToolDefinition('node', {
  source: { datasource: 'node-version' },
  publish: { lines: { 24: { retired: ['24.19.0'] }, 26: { from: '26.11.1', revisions: { '26.11.1': 2 } } } },
});
const maven = parseToolDefinition('maven', { source: { datasource: 'maven' }, publish: { lines: { 3.9: { from: '3.9.16' } } }, install: { addToPath: 'bin' } });
const now = '2026-10-14T00:00:00.000Z';

test('a run records every version whose tool image exists and that the catalog lacks, and nothing else', () => {
  const catalogs = { node: [catalogEntry(node, '24.19.0', 1, '24'), catalogEntry(node, '26.11.1', 1, '26')], maven: [catalogEntry(maven, '3.9.16', 1, '3.9')] };
  // The plans after the builds: 26.11.1 r2 and 26.11.2 were pushed by this run (or pushed by an earlier run that failed to
  // record them), 26.11.3 failed to build.
  const plans = {
    node: {
      tool: 'node',
      upstream: 'https://github.com/nodejs/node',
      versions: [
        { version: '24.19.0', decision: 'skip', reason: 'retired' },
        { version: '26.11.1', decision: 'skip', reason: 'published' },
        { version: '26.11.2', decision: 'skip', reason: 'published' },
        { version: '26.11.3', decision: 'publish', reason: 'new', line: '26', revision: 1, tag: 'node-26.11.3-r1' },
      ],
    },
    maven: { tool: 'maven', upstream: null, versions: [{ version: '3.9.16', decision: 'skip', reason: 'published' }] },
  };
  const run = recordRun({ tools: [maven, node], catalogs, plans, now });
  assert.deepEqual(run.unreleased, [
    { tool: 'node', version: '26.11.1', line: '26', revision: 2, tag: 'node-26.11.1-r2', upstream: 'https://github.com/nodejs/node' },
    { tool: 'node', version: '26.11.2', line: '26', revision: 1, tag: 'node-26.11.2-r1', upstream: 'https://github.com/nodejs/node' },
  ]);
  assert.deepEqual(run.catalogs.node.map((e) => [e.version, e.revision, e.retired ?? false]), [['24.19.0', 1, true], ['26.11.1', 2, false], ['26.11.2', 1, false]]);
  assert.deepEqual(run.catalogs.maven, catalogs.maven);
  assert.deepEqual(run.changes, [
    { type: 'fix', tool: 'node', text: 'republish 26.11.1 (r2)' },
    { type: 'feat', tool: 'node', text: 'publish 26.11.2' },
    { type: 'feat', breaking: true, tool: 'node', text: 'retire 24.19.0' },
  ]);

  const again = recordRun({ tools: [maven, node], catalogs: run.catalogs, plans, now });
  assert.deepEqual([again.unreleased, again.changes], [[], []], 'a second run records nothing');
});

// release-please reads each nested commit block as one more commit (googleapis/release-please src/commit.ts, splitMessages):
// unlike blank-line-separated entries, a breaking entry (feat(node)!) is kept apart.
test('the record commit has one changelog entry per change: the first as subject, the others as nested commits', () => {
  const change = (type, text, breaking = false) => ({ type, tool: 'node', text, breaking });
  assert.equal(commitMessage([change('fix', 'republish 26.11.1 (r2)'), change('feat', 'publish 26.11.2'), change('feat', 'retire 24.19.0', true)]), [
    'fix(node): republish 26.11.1 (r2)',
    '',
    'BEGIN_NESTED_COMMIT',
    'feat(node): publish 26.11.2',
    'END_NESTED_COMMIT',
    'BEGIN_NESTED_COMMIT',
    'feat(node)!: retire 24.19.0',
    'END_NESTED_COMMIT',
    '',
  ].join('\n'));
  assert.equal(commitMessage([change('feat', 'publish 26.11.2')]), 'feat(node): publish 26.11.2\n');
  assert.equal(commitMessage([]), '', 'no change, no commit');
});

test('a catalog version whose tag is gone fails the run instead of being published again', async () => {
  const catalogs = { node: [{ ...catalogEntry(node, '24.19.0', 1, '24'), retired: true }, catalogEntry(node, '26.11.1', 1, '26')], maven: [catalogEntry(maven, '3.9.16', 1, '3.9')] };
  const tags = new Set(['node-26.11.1-r1', 'maven-3.9.16-r1']);
  await assert.rejects(checkCatalogTags({ catalogs, tagExists: async (tag) => tags.has(tag) }), {
    message: 'published versions lost their tag; published tool images never change:\nnode 24.19.0: tag node-24.19.0-r1 not found',
  });
  tags.add('node-24.19.0-r1');
  await checkCatalogTags({ catalogs, tagExists: async (tag) => tags.has(tag) });
  await assert.rejects(checkCatalogTags({ catalogs, tagExists: async () => { throw new Error('HEAD ghcr.io: HTTP 503'); } }), { message: 'HEAD ghcr.io: HTTP 503' });
});
