import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeReleasePr } from '../lib/release-merge.mjs';

const now = Date.parse('2026-11-19T05:00:00Z');
const context = { now, repository: 'camunda/infra-tools', runUrl: 'https://github.com/camunda/infra-tools/actions/runs/1' };
const hoursAgo = (hours) => new Date(now - hours * 3600 * 1000).toISOString();

// The GitHub stand-in: open release PRs, the Check CI runs of each, and what a merge leaves (merged or queued for auto-merge).
function github({ prs = [], checkRuns = {}, afterMerge = 'merged' } = {}) {
  const merged = [];
  return {
    merged,
    releasePrs: async () => prs,
    checkRuns: async (pr) => checkRuns[pr.number] ?? [],
    merge: async (pr) => merged.push(pr.number),
    mergeState: async () => afterMerge,
  };
}
const releasePr = (number, { labels = ['autorelease: pending'], hours = 1 } = {}) => ({ number, labels, createdAt: hoursAgo(hours) });
const passed = [{ id: 1, status: 'completed', conclusion: 'success' }];

test('no open release PR: nothing to merge, no alert', async () => {
  const gh = github();
  assert.deepEqual(await mergeReleasePr(gh, context), { messages: ['No release PR to merge.'], alert: null });
  assert.deepEqual(gh.merged, []);
});

test('a green release PR is merged, and says so only once it is', async () => {
  const gh = github({ prs: [releasePr(12)], checkRuns: { 12: passed } });
  assert.deepEqual(await mergeReleasePr(gh, context), { messages: ['Release PR #12 merged.'], alert: null });
  assert.deepEqual(gh.merged, [12]);
});

test('a release PR left waiting for auto-merge after the merge is not reported merged, and alerts', async () => {
  const gh = github({ prs: [releasePr(12)], checkRuns: { 12: passed }, afterMerge: 'queued' });
  const { messages, alert } = await mergeReleasePr(gh, context);
  assert.deepEqual(messages, ['Release PR #12 not merged: auto-merge is enabled and waits on its requirements (e.g. a review).']);
  assert.match(alert.text, /Release PR <https:\/\/github\.com\/camunda\/infra-tools\/pull\/12\|#12> not merged: auto-merge waits on its requirements/);
  assert.match(alert.text, /<!subteam\^S01K6MZC3AQ\|infra-medic> — <https:\/\/github\.com\/camunda\/infra-tools\/actions\/runs\/1\|View workflow run>/);
});

test('a release PR whose Check CI did not pass is left open; it alerts only once open for 2 days or more', async () => {
  const pending = [{ id: 1, status: 'in_progress', conclusion: null }];
  const failed = [{ id: 1, status: 'completed', conclusion: 'success' }, { id: 2, status: 'completed', conclusion: 'failure' }];
  for (const [runs, result] of [[pending, 'pending'], [failed, 'failure'], [[], 'missing']]) {
    const gh = github({ prs: [releasePr(12)], checkRuns: { 12: runs } });
    assert.deepEqual(await mergeReleasePr(gh, context), { messages: [`Release PR #12 not merged: Check CI is ${result}.`], alert: null });
    assert.deepEqual(gh.merged, []);
  }
  const { messages, alert } = await mergeReleasePr(github({ prs: [releasePr(12, { hours: 48 })], checkRuns: { 12: failed } }), context);
  assert.deepEqual(messages, ['Release PR #12 not merged: Check CI is failure.', 'Release PR #12 is open for 2 days or more.']);
  assert.match(alert.text, /Release PR <https:\/\/github\.com\/camunda\/infra-tools\/pull\/12\|#12> open for 2 days or more: its CI fails, or it is not merged/);
});

test('a release PR labelled no-merge is left alone', async () => {
  const gh = github({ prs: [releasePr(12, { labels: ['autorelease: pending', 'no-merge'] })], checkRuns: { 12: passed } });
  assert.deepEqual(await mergeReleasePr(gh, context), { messages: ['No release PR to merge.'], alert: null });
  assert.deepEqual(gh.merged, []);
});
