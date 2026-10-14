import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchFor, parseMarker, pullFor, renderBody, signature, trackedVersions } from '../lib/fixpr.mjs';

const marker = { tool: 'node', major: 27, signature: 'abc', branch: 'tool-build/node-27.0.0', versions: { '27.0.0': 'node-27.0.0-r1' } };
const failure = { tool: 'node', version: '27.0.0', error: { step: 'build and test', excerpt: 'ERROR: 404 Not Found for node-v27.0.0' } };

test('marker round trip through the PR body', () => {
  const body = renderBody(marker, [failure], 'https://example/run');
  assert.deepEqual(parseMarker(body), marker);
  assert.equal(parseMarker('no marker'), null);
});

test('same error across versions has the same signature', () => {
  assert.equal(signature('ERROR: download failed for 27.0.0 (sha256:aa)'), signature('ERROR: download failed for 27.1.3 (sha256:bb)'));
  assert.notEqual(signature('ERROR: download failed'), signature('ERROR: test failed'));
});

test('tracked versions: open PRs track, closed unmerged PRs ignore, merged PRs release', () => {
  const body = (versions) => renderBody({ ...marker, versions }, [failure]);
  const tracked = trackedVersions([
    { number: 1, state: 'open', body: body({ '27.0.0': 't' }), pull_request: {} },
    { number: 2, state: 'closed', body: body({ '27.0.1': 't' }), pull_request: { merged_at: null } },
    { number: 3, state: 'closed', body: body({ '27.0.2': 't' }), pull_request: { merged_at: '2026-10-14T00:00:00Z' } },
  ]);
  assert.deepEqual([...tracked.open.keys()], ['node|27.0.0']);
  assert.deepEqual([...tracked.ignored.keys()], ['node|27.0.1']);
});

test('failures join an open PR of the same tool, major and error', () => {
  const pull = { number: 1, body: renderBody(marker, [failure]) };
  assert.equal(pullFor({ tool: 'node', version: '27.1.0', signature: 'abc' }, [pull]), pull);
  assert.equal(pullFor({ tool: 'node', version: '28.0.0', signature: 'abc' }, [pull]), undefined);
  assert.equal(pullFor({ tool: 'node', version: '27.1.0', signature: 'other' }, [pull]), undefined);
  assert.equal(branchFor('java', '21.0.13-7.0.LTS'), 'tool-build/java-21.0.13-7.0.LTS');
});
