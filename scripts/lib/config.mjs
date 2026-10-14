import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions, lineOf, parseDuration } from './versions.mjs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PLATFORMS = ['linux/amd64', 'linux/arm64'];
export const DEFAULT_REGISTRY = 'ghcr.io/camunda/infra-tools';

// tool.json blocks: source (Renovate lookup, passed as-is), publish (version lines), install (tool cache layout).
export const BLOCKS = {
  source: ['datasource', 'packageName', 'versioning', 'extractVersion'],
  publish: ['minAge', 'lines'],
  install: ['cacheFolder', 'archFolders', 'addToPath'],
};

export const LINE_OPTIONS = ['from', 'versions', 'ignoredVersions', 'revisions', 'retired', 'minAge', 'reason'];
export const ANY = '*';

const DEFAULTS = {
  minAge: '1 day',
  archFolders: { amd64: 'x64', arm64: 'arm64' },
  addToPath: null,
};

// Flattens the blocks into one object used by the scripts; rejects unknown blocks and options.
export function normalizeTool(name, config) {
  const where = `tools/${name}/tool.json`;
  const flat = {};
  for (const [block, values] of Object.entries(config)) {
    if (!BLOCKS[block]) throw new Error(`${where}: unknown block ${block}`);
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!BLOCKS[block].includes(key)) throw new Error(`${where}: unknown option ${block}.${key}`);
      flat[key] = value;
    }
  }
  if (!flat.datasource) throw new Error(`${where}: missing source.datasource`);
  if (!flat.lines || !Object.keys(flat.lines).length) throw new Error(`${where}: missing publish.lines`);
  const tool = { ...DEFAULTS, cacheFolder: name, packageName: name, ...flat, name };
  validateLines(where, tool);
  return tool;
}

const explicitKeys = (tool) => Object.keys(tool.lines).filter((k) => k !== ANY);

// Line owning a version: the explicit line it belongs to, else "*" from its `from` on. Lines never overlap (validated).
export function lineFor(tool, version) {
  const key = lineOf(version, explicitKeys(tool));
  if (key) return { key, ...tool.lines[key] };
  const any = tool.lines[ANY];
  if (any && compareVersions(version, any.from) >= 0) return { key: ANY, ...any };
  return undefined;
}

export const revisionOf = (tool, version) => lineFor(tool, version)?.revisions?.[version] ?? 1;

export function isRetired(tool, version) {
  const line = lineFor(tool, version);
  return Boolean(line && (line.retired === 'all' || line.retired?.includes(version)));
}

function validateLines(where, tool) {
  parseDuration(tool.minAge);
  const keys = explicitKeys(tool);
  const owns = (key, version) => (key === ANY ? lineFor(tool, version)?.key === ANY : lineOf(version, [key]) === key);
  for (const [key, line] of Object.entries(tool.lines)) {
    const at = `${where}: publish.lines.${key}`;
    if (key !== ANY && !/^\d+(\.\d+)?$/.test(key)) throw new Error(`${at}: a line is a major ("21"), a minor ("1.25") or "*"`);
    for (const option of Object.keys(line)) {
      if (!LINE_OPTIONS.includes(option)) throw new Error(`${at}: unknown option ${option}`);
    }
    if (!Object.keys(line).length) throw new Error(`${at}: empty line; delete it, or set from, versions, revisions or retired`);
    if (line.minAge) parseDuration(line.minAge);
    if (line.retired === 'all') {
      const others = Object.keys(line).filter((o) => !['retired', 'reason'].includes(o));
      if (key === ANY) throw new Error(`${at}: "retired": "all" is not allowed on "*"; give its versions a line first`);
      if (others.length) throw new Error(`${at}: "retired": "all" excludes ${others.join(', ')}`);
      continue;
    }
    if (line.retired !== undefined && !Array.isArray(line.retired)) throw new Error(`${at}: retired is a list of versions or "all"`);
    if (key === ANY) {
      if (!line.from) throw new Error(`${at}: "*" needs from`);
      if (line.versions) throw new Error(`${at}: "*" cannot have versions; pin them in their own line`);
    }
    if (line.from && key !== ANY && !owns(key, line.from) && line.from !== key) throw new Error(`${at}: from ${line.from} is not in line ${key}`);
    for (const option of ['versions', 'ignoredVersions', 'retired']) {
      for (const version of line[option] ?? []) {
        if (!owns(key, version)) throw new Error(`${at}: ${option} ${version} is not in line ${key}`);
      }
    }
    for (const version of Object.keys(line.revisions ?? {})) {
      if (!owns(key, version)) throw new Error(`${at}: revisions ${version} is not in line ${key}`);
    }
    for (const version of line.versions ?? []) {
      if (line.from && compareVersions(version, line.from) >= 0) throw new Error(`${at}: versions ${version} is already published by from ${line.from}`);
    }
  }
  for (const a of keys) {
    for (const b of keys) {
      if (a !== b && lineOf(b, [a]) === a) throw new Error(`${where}: publish.lines.${a} and publish.lines.${b} overlap; keep the major or its minors`);
    }
  }
  const any = tool.lines[ANY];
  if (any?.from) {
    for (const key of keys) {
      if (lineOf(any.from, [key]) === key || compareVersions(any.from, key) < 0) {
        throw new Error(`${where}: publish.lines.${key} overlaps publish.lines.* (from ${any.from}); move "*".from past ${key}`);
      }
    }
  }
}

export async function toolNames() {
  const entries = await readdir(join(ROOT, 'tools'), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function loadTools(names) {
  const all = await toolNames();
  const selected = names?.length ? names : all;
  const unknown = selected.filter((n) => !all.includes(n));
  if (unknown.length) throw new Error(`unknown tools: ${unknown.join(', ')}`);
  return Promise.all(
    selected.map(async (name) => normalizeTool(name, JSON.parse(await readFile(join(ROOT, 'tools', name, 'tool.json'), 'utf8')))),
  );
}

export const archOf = (platform) => platform.split('/')[1];

export const archFolder = (tool, platform) => tool.archFolders[archOf(platform)];

export const archFoldersArg = (tool) => Object.entries(tool.archFolders).map(([k, v]) => `${k}=${v}`).join(' ');

export async function dockerfileFor(name) {
  const own = join(ROOT, 'tools', name, 'Dockerfile');
  try {
    await access(own);
    return own;
  } catch {
    return join(ROOT, 'build', 'tool.Dockerfile');
  }
}

export async function releaseVersion() {
  const manifest = JSON.parse(await readFile(join(ROOT, '.github', 'config', '.release-please-manifest.json'), 'utf8'));
  return manifest['.'];
}
