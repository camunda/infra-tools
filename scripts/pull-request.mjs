// Usage: node pull-request.mjs --image <registry>/<repository> --repository <owner>/<name> [--base <git ref>] [--out <dir>]
//          [--comment <PR number>]
// Checks of a pull request (lib/pull-request.mjs) against the PR's merge commit, whose first parent is the base (--base,
// default HEAD^1). Reads only: upstream versions, the latest published release of --repository, and published tags and
// indexes in --image; never builds or pushes. Writes to --out (default build/out/pull-request):
// - builds.json: the tool versions to build and test in dry run (scripts/build.mjs without --push);
// - comment.md: the PR comment, with the revision errors and warnings and the release notes preview; not written when no tool
//   changed.
// Prints each error and warning as a workflow annotation, and fails once the comment is posted when there is an error. With --comment, also brings the release notes preview comment of that
// PR up to date (lib/pull-request.mjs previewCommentUpdate). Plans with the fix PRs of --repository, as the reconciler does.
// Uses gh and its token (GH_TOKEN or GITHUB_TOKEN).
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FIX_PR_LABEL, trackedVersions } from './lib/fix-pr.mjs';
import { checkPullRequest, previewComment, previewCommentUpdate } from './lib/pull-request.mjs';
import { readIndex } from './lib/publish-index.mjs';
import { Registry } from './lib/registry.mjs';
import { latestReleaseVersion } from './lib/release.mjs';
import { ghApi, ghJson, readCatalog, readPullRequests, readToolDefinition, readToolNames, ROOT } from './lib/repository.mjs';
import { parseToolDefinition } from './lib/tool-definition.mjs';

const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    repository: { type: 'string' },
    base: { type: 'string', default: 'HEAD^1' },
    out: { type: 'string', default: join(ROOT, 'build/out/pull-request') },
    comment: { type: 'string' },
  },
});
if (!values.image || !values.repository) throw new Error('usage: node pull-request.mjs --image <registry>/<repository> --repository <owner>/<name> [--base <git ref>] [--out <dir>] [--comment <PR number>]');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const changedFiles = git('diff', '--name-only', values.base, 'HEAD').split('\n').filter(Boolean);

const names = await readToolNames();
const tools = await Promise.all(names.map(readToolDefinition));
const baseTools = {};
const catalogs = {};
for (const name of names) {
  catalogs[name] = await readCatalog(name);
  let json;
  try {
    json = git('show', `${values.base}:tools/${name}/tool.json`);
  } catch {
    continue; // a tool new in this PR
  }
  baseTools[name] = parseToolDefinition(name, JSON.parse(json));
}

// The latest published release (ADR 0013). A rerun of an older run keeps its base, which can predate it: its catalog can then
// hold a lower revision than the release's index, so the checks run again on the current base instead.
const previousVersion = latestReleaseVersion(ghJson(`repos/${values.repository}/releases/latest`));
const base = git('rev-parse', values.base).trim();
const { status } = ghJson(`repos/${values.repository}/compare/${previousVersion}...${base}?per_page=1`);
if (!['ahead', 'identical'].includes(status)) throw new Error(`release ${previousVersion} is newer than the base ${base}: push again or update the branch to check the PR on the current base`);

const registry = new Registry(values.image);
const tags = await registry.tags();

const { builds, errors, warnings, notes } = await checkPullRequest({
  tools,
  baseTools,
  changedFiles,
  plan: { tags: new Set(tags), platformsOf: (tag) => registry.toolImagePlatforms(tag), now: Date.now() },
  catalogs,
  previousRelease: { index: await readIndex(registry, `${previousVersion}-tools`), version: previousVersion },
  toolImageLayers: (tag) => registry.toolImageLayers(tag),
  repository: values.repository,
  fixPrs: trackedVersions(readPullRequests(values.repository, FIX_PR_LABEL)),
});

await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'builds.json'), `${JSON.stringify(builds, null, 2)}\n`);
for (const e of errors) console.log(`::error title=Revision not above the published one::${e}`);
for (const w of warnings) console.log(`::warning title=Revision not bumped::${w}`);
console.log(builds.length ? `dry run: ${builds.map((b) => `${b.tool} ${b.version} (${b.reason})`).join(', ')}` : 'dry run: nothing to build');
const preview = previewComment({ builds, errors, warnings, notes });
if (preview !== null) await writeFile(join(values.out, 'comment.md'), preview);

if (values.comment) {
  const comments = JSON.parse(ghApi('', '--paginate', '--slurp', `repos/${values.repository}/issues/${values.comment}/comments`)).flat();
  const update = previewCommentUpdate(comments, preview);
  if (update) {
    const path = update.id ? `issues/comments/${update.id}` : `issues/${values.comment}/comments`;
    ghJson(`repos/${values.repository}/${path}`, { method: update.id ? 'PATCH' : 'POST', body: { body: update.body } });
  }
  console.log(update ? `release notes preview comment ${update.id ? 'updated' : 'created'}` : 'release notes preview comment: none to post');
}

if (errors.length) process.exit(1);
