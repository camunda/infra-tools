// Usage: node pull-request.mjs --image <registry>/<repository> --repository <owner>/<name> [--base <git ref>] [--out <dir>]
//          [--comment <PR number>]
// Checks of a pull request (lib/pull-request.mjs) against the PR's merge commit, whose first parent is the base (--base,
// default HEAD^1). Reads only: upstream versions, and published tags and indexes in --image; never builds or pushes. Writes to
// --out (default build/out/pull-request):
// - builds.json: the tool versions to build and test in dry run (scripts/build.mjs without --push);
// - comment.md: the PR comment, with the revision warnings and the release notes preview; not written when no tool changed.
// Prints each warning as a workflow warning annotation. With --comment, also brings the release notes preview comment of that
// PR up to date (lib/pull-request.mjs previewCommentUpdate), with gh and its token (GH_TOKEN or GITHUB_TOKEN).
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkPullRequest, previewComment, previewCommentUpdate } from './lib/pull-request.mjs';
import { readIndex } from './lib/publish-index.mjs';
import { Registry } from './lib/registry.mjs';
import { readCatalog, readReleaseVersion, readToolDefinition, readToolNames, ROOT } from './lib/repository.mjs';
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

const registry = new Registry(values.image);
const previousVersion = await readReleaseVersion();
const previousTag = `${previousVersion}-tools`;
if (previousVersion && !(await registry.exists(previousTag))) throw new Error(`${values.image}:${previousTag}: index of the latest release not found`);

const { builds, warnings, notes } = await checkPullRequest({
  tools,
  baseTools,
  changedFiles,
  plan: { tagExists: (tag) => registry.exists(tag), now: Date.now() },
  catalogs,
  previousRelease: { index: previousVersion ? await readIndex(registry, previousTag) : [], version: previousVersion },
  toolImageLayers: (tag) => registry.toolImageLayers(tag),
  repository: values.repository,
});

await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'builds.json'), `${JSON.stringify(builds, null, 2)}\n`);
for (const w of warnings) console.log(`::warning title=Revision not bumped::${w}`);
console.log(builds.length ? `dry run: ${builds.map((b) => `${b.tool} ${b.version} (${b.reason})`).join(', ')}` : 'dry run: nothing to build');
const preview = previewComment({ builds, warnings, notes });
if (preview !== null) await writeFile(join(values.out, 'comment.md'), preview);

if (values.comment) {
  const gh = (input, ...args) => execFileSync('gh', ['api', ...args], { input, encoding: 'utf8' });
  const comments = JSON.parse(gh('', '--paginate', '--slurp', `repos/${values.repository}/issues/${values.comment}/comments`)).flat();
  const update = previewCommentUpdate(comments, preview);
  if (update) {
    const path = update.id ? `issues/comments/${update.id}` : `issues/${values.comment}/comments`;
    gh(JSON.stringify({ body: update.body }), '--method', update.id ? 'PATCH' : 'POST', `repos/${values.repository}/${path}`, '--input', '-');
  }
  console.log(update ? `release notes preview comment ${update.id ? 'updated' : 'created'}` : 'release notes preview comment: none to post');
}
