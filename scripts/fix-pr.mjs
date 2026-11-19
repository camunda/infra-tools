// Usage: node fix-pr.mjs --image <registry>/<repository> --repository <owner>/<name> --failures <dir> --run-url <url>
//          [--base <branch>]
// Reconciler fix PRs (spec §5.3, step 5), once the run's builds are recorded: the failures build.mjs --failure wrote to
// --failures (one JSON file per failed tool version, none when every build passed) open a fix PR or join the open one of the
// same tool, major and error; a fix PR version that fails again gets a comment when its error changed; an open fix PR none of
// whose versions is left to publish is closed with a comment (lib/fix-pr.mjs). Fix PRs start from an empty commit on --base
// (default main). Uses gh and its token (GH_TOKEN or GITHUB_TOKEN): the Infra - Misc App's, so that the fix PR's checks run.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FIX_PR_LABEL, fixPrChanges, trackedVersions } from './lib/fix-pr.mjs';
import { planEveryTool } from './lib/reconcile-scripts.mjs';
import { Registry } from './lib/registry.mjs';
import { ghJson, readPullRequests } from './lib/repository.mjs';

const { values } = parseArgs({
  options: { image: { type: 'string' }, repository: { type: 'string' }, failures: { type: 'string' }, 'run-url': { type: 'string' }, base: { type: 'string', default: 'main' } },
});
if (!values.image || !values.repository || !values.failures || !values['run-url']) {
  throw new Error('usage: node fix-pr.mjs --image <registry>/<repository> --repository <owner>/<name> --failures <dir> --run-url <url> [--base <branch>]');
}
const repo = `repos/${values.repository}`;
const api = (method, path, body) => ghJson(`${repo}/${path}`, { method, body });

// The failures of this run; the folder is missing when no build failed.
async function readFailures(dir) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))));
}

// A branch on an empty commit on top of the base branch, so that a fix PR can be opened before any fix is pushed (D41). A
// branch left by an earlier fix PR of the same version, merged or closed, is moved there.
function emptyCommitBranch(branch, message) {
  const base = api('GET', `git/ref/heads/${values.base}`).object.sha;
  const { tree } = api('GET', `git/commits/${base}`);
  const { sha } = api('POST', 'git/commits', { message, tree: tree.sha, parents: [base] });
  try {
    api('POST', 'git/refs', { ref: `refs/heads/${branch}`, sha });
  } catch (err) {
    if (!/Reference already exists/.test(err.stderr)) throw err;
    api('PATCH', `git/refs/heads/${branch}`, { sha, force: true });
  }
}

const failures = await readFailures(values.failures);
const pullRequests = readPullRequests(values.repository, FIX_PR_LABEL);
const { plans } = await planEveryTool(new Registry(values.image), { fixPrs: trackedVersions(pullRequests) });
const changes = fixPrChanges({ failures, pullRequests, plans, runUrl: values['run-url'] });
for (const change of changes) {
  if (change.action === 'open') {
    emptyCommitBranch(change.branch, change.title);
    const { number, html_url: url } = api('POST', 'pulls', { title: change.title, head: change.branch, base: values.base, body: change.body });
    api('POST', `issues/${number}/labels`, { labels: [FIX_PR_LABEL] });
    console.log(`${change.title}: opened ${url}`);
  } else if (change.action === 'update') {
    api('PATCH', `pulls/${change.number}`, { title: change.title, body: change.body });
    console.log(`${change.title}: updated #${change.number}`);
  } else if (change.action === 'comment') {
    api('POST', `issues/${change.number}/comments`, { body: change.body });
    console.log(`#${change.number}: commented, its error changed`);
  } else if (change.action === 'close') {
    api('POST', `issues/${change.number}/comments`, { body: change.comment });
    api('PATCH', `pulls/${change.number}`, { state: 'closed', body: change.body });
    console.log(`#${change.number}: closed, no version left to publish`);
  }
}
if (!changes.length) console.log(failures.length ? 'fix PRs up to date' : 'no failure, no fix PR to close');
