// Files of this repository read by the scripts, and the GitHub API.
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolDefinition } from './tool-definition.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// gh api with its arguments and input (the request body, '' for none), with gh's token (GH_TOKEN or GITHUB_TOKEN). Returns the
// response body; an error status throws, with gh's message (e.g. "(HTTP 404)") in its stderr.
export const ghApi = (input, ...args) => execFileSync('gh', ['api', ...args], { input, encoding: 'utf8' });

// gh api on a path (e.g. repos/<owner>/<name>/releases), returning the parsed response (null when empty). method: GET by
// default; body: the request body, sent as JSON; accept: the Accept header (e.g. application/vnd.github.raw+json for the
// content of a file). A GET of a missing resource (404) returns null; any other error throws, as ghApi.
export function ghJson(path, { method = 'GET', body, accept } = {}) {
  const args = ['--method', method, ...(accept ? ['-H', `Accept: ${accept}`] : []), path, ...(body ? ['--input', '-'] : [])];
  try {
    return JSON.parse(ghApi(body ? JSON.stringify(body) : '', ...args) || 'null');
  } catch (err) {
    if (method === 'GET' && /\(HTTP 404\)/.test(err.stderr)) return null;
    throw err;
  }
}

// Every pull request of a repository (owner/name) with a label, open or not: { number, state ('OPEN', 'CLOSED' or 'MERGED'),
// body }, as lib/fix-pr.mjs takes the fix PRs. An API error throws: pull requests that cannot be read must not read as none.
export function readPullRequests(repository, label) {
  const issues = JSON.parse(ghApi('', '--paginate', '--slurp', `repos/${repository}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`)).flat();
  return issues
    .filter((issue) => issue.pull_request)
    .map((pr) => ({ number: pr.number, state: pr.state === 'open' ? 'OPEN' : pr.pull_request.merged_at ? 'MERGED' : 'CLOSED', body: pr.body }));
}

export async function readToolDefinition(name) {
  return parseToolDefinition(name, JSON.parse(await readFile(join(ROOT, 'tools', name, 'tool.json'), 'utf8')));
}

// The tool definition of a tool at a commit, such as the build commit of a tool image, fetched at depth 1 when the checkout
// lacks it (the record job checks out main's tip only). Throws when it cannot be read.
export async function readToolDefinitionAt(name, commit) {
  const git = (args, options) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options });
  try {
    git(['cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' });
  } catch {
    git(['fetch', '--no-tags', '--depth=1', 'origin', commit]);
  }
  return parseToolDefinition(name, JSON.parse(git(['show', `${commit}:tools/${name}/tool.json`])));
}

// Every tool of tools/, by folder name.
export async function readToolNames() {
  return (await readdir(join(ROOT, 'tools'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// Catalog entries of a tool (published/<tool>.json), [] before its first publication.
export async function readCatalog(name) {
  return JSON.parse((await readOptional(join(ROOT, 'published', `${name}.json`))) ?? '[]');
}

export async function writeCatalog(name, entries) {
  await mkdir(join(ROOT, 'published'), { recursive: true });
  await writeFile(join(ROOT, 'published', `${name}.json`), `${JSON.stringify(entries, null, 2)}\n`);
}

// The release-please manifest, which holds the version of the latest release ('.').
export const RELEASE_MANIFEST = '.github/config/.release-please-manifest.json';

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}
