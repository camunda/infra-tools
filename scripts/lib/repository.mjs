// Files of this repository read by the scripts, and the GitHub API.
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolDefinition } from './tool-definition.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Waits before each retry of a transient GitHub API error (ADR 0012): a step fails only when its error persists.
const GH_RETRY_DELAYS = [2000, 4000, 8000];
// gh api errors worth retrying, from its stderr: a rate limit (secondary ones answer 403), a server or gateway error, a network
// error.
const GH_TRANSIENT = /\(HTTP (429|5\d\d)\)|rate limit|connection reset|connection refused|timeout|deadline exceeded|\bEOF\b/i;

// Blocks for ms: gh api runs synchronously.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Runs a gh api call, retrying it after each of delays while it fails with a transient error; any other error, or the last
// one, throws. A retried write GitHub had applied (a 502 after the change) can be applied twice: failure issues tolerate a
// duplicate comment or issue, and the other writes check what exists first.
export function retryTransient(call, { delays = GH_RETRY_DELAYS, sleep = sleepSync } = {}) {
  for (let retry = 0; ; retry++) {
    try {
      return call();
    } catch (err) {
      if (retry >= delays.length || !GH_TRANSIENT.test(err.stderr ?? '')) throw err;
      console.log(`gh api: ${String(err.stderr).trim().split('\n').at(-1)}, retried in ${delays[retry] / 1000} s`);
      sleep(delays[retry]);
    }
  }
}

// gh api with its arguments and input (the request body, '' for none), with gh's token (GH_TOKEN or GITHUB_TOKEN), transient
// errors retried. Returns the response body; an error status throws, with gh's message (e.g. "(HTTP 404)") in its stderr.
export const ghApi = (input, ...args) => retryTransient(() => execFileSync('gh', ['api', ...args], { input, encoding: 'utf8' }));

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

// The JSON files of a folder, by file name, such as the failures of a run: [] when the folder is missing (nothing failed).
export async function readJsonFiles(dir) {
  if (!dir) return [];
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))));
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}
