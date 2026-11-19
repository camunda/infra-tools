// The superseded-run guard of the reconciler (scripts/superseded.sh) as reconcile.yml runs it: in a depth-1 checkout, against
// an origin whose main may have moved since the run's commit. Observes its output and job summary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SUPERSEDED = fileURLToPath(new URL('../superseded.sh', import.meta.url));

let work;
let origin;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Writes the files to main of the origin and commits them: returns the commit.
async function commit(files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(origin, path)), { recursive: true });
    await writeFile(join(origin, path), content);
  }
  git(origin, 'add', '--all');
  git(origin, 'commit', '--quiet', '--message', 'change');
  return git(origin, 'rev-parse', 'HEAD');
}

// A depth-1 checkout of the commit (main: the branch), as actions/checkout makes it.
function checkout(name, commit) {
  const dir = join(work, name);
  git(work, 'init', '--quiet', dir);
  git(dir, 'remote', 'add', 'origin', `file://${origin}`);
  git(dir, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', commit);
  git(dir, 'checkout', '--quiet', 'FETCH_HEAD');
  return dir;
}

// Runs the guard for the run's commit in the checkout: its superseded output and job summary.
async function guard(dir, runCommit) {
  const output = join(work, 'output');
  const summary = join(work, 'summary');
  await writeFile(output, '');
  await writeFile(summary, '');
  execFileSync(SUPERSEDED, { cwd: dir, env: { ...process.env, GITHUB_SHA: runCommit, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
  return { output: await readFile(output, 'utf8'), summary: await readFile(summary, 'utf8') };
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'infra-tools-superseded-'));
  origin = join(work, 'origin');
  git(work, 'init', '--quiet', '--initial-branch=main', origin);
  git(origin, 'config', 'user.name', 'test');
  git(origin, 'config', 'user.email', 'test@example.com');
  git(origin, 'config', 'commit.gpgsign', 'false');
  // A depth-1 fetch of a commit that is not a branch tip, as GitHub allows.
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  await commit({ 'tools/node/tool.json': '{"lines":{}}\n', 'published/node.json': '[]\n' });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

test('a run on the tip of main is not superseded', async () => {
  const run = git(origin, 'rev-parse', 'HEAD');
  const { output, summary } = await guard(checkout('plan', run), run);
  assert.equal(output, 'superseded=false\n');
  assert.equal(summary, '');
});

test('a run is superseded once main changes outside published/ since its commit', async () => {
  const run = git(origin, 'rev-parse', 'HEAD');
  await commit({ 'tools/node/tool.json': '{"lines":{"26":{}}}\n' });
  const { output, summary } = await guard(checkout('plan', run), run);
  assert.equal(output, 'superseded=true\n');
  assert.match(summary, /^Superseded: .*main.*publishes instead\.\n$/);
});

test('record commits on main supersede no run', async () => {
  const run = git(origin, 'rev-parse', 'HEAD');
  await commit({ 'published/node.json': '[{"version":"26.11.2"}]\n' });
  const { output, summary } = await guard(checkout('plan', run), run);
  assert.equal(output, 'superseded=false\n');
  assert.equal(summary, '');
});

test('the record job checks the run in a depth-1 checkout of the tip of main', async () => {
  const run = git(origin, 'rev-parse', 'HEAD');
  await commit({ 'published/node.json': '[{"version":"26.11.2"}]\n' });
  const record = checkout('record', git(origin, 'rev-parse', 'HEAD'));
  assert.equal((await guard(record, run)).output, 'superseded=false\n');
  await commit({ 'build/tool.Dockerfile': 'FROM scratch\n' });
  assert.equal((await guard(record, run)).output, 'superseded=true\n');
});
