// Files of this repository read by the scripts.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolDefinition } from './tool-definition.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function readToolDefinition(name) {
  return parseToolDefinition(name, JSON.parse(await readFile(join(ROOT, 'tools', name, 'tool.json'), 'utf8')));
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
