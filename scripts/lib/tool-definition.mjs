// Tool definitions (tools/<tool>/tool.json, D38): three blocks, source (Renovate lookup, passed as-is), publish (version
// lines, D41) and install (tool cache layout), plus setup for tool-cache tools (their setup-* action, for the usage snippet of
// their tool releases, D53). Blocks with only defaults can be left out.
import { compareVersions, inLine } from './versions.mjs';

const OPTIONS = {
  source: ['datasource', 'packageName', 'versioning', 'extractVersion'],
  publish: ['minAge', 'lines'],
  install: ['cacheFolder', 'archFolders', 'addToPath'],
  setup: ['action', 'versionInput', 'with'],
};

const DEFAULTS = {
  publish: { minAge: '1 day' },
  install: { archFolders: { amd64: 'x64', arm64: 'arm64' }, addToPath: null },
};

// Parses and validates a tool definition; throws with the file and option at fault.
export function parseToolDefinition(name, json) {
  const where = `tools/${name}/tool.json`;
  const fail = (message) => {
    throw new Error(`${where}: ${message}`);
  };
  for (const [block, options] of Object.entries(json)) {
    if (!OPTIONS[block]) fail(`unknown block ${block}`);
    for (const option of Object.keys(options ?? {})) {
      if (!OPTIONS[block].includes(option)) fail(`unknown option ${block}.${option}`);
    }
  }
  const tool = {
    name,
    source: { packageName: name, ...json.source },
    publish: { ...DEFAULTS.publish, ...json.publish },
    install: { cacheFolder: name, ...DEFAULTS.install, ...json.install },
    ...(json.setup && { setup: { with: {}, ...json.setup } }),
  };
  if (!tool.source.datasource) fail('missing source.datasource');
  if (!tool.publish.lines || !Object.keys(tool.publish.lines).length) fail('missing publish.lines');
  const { archFolders, addToPath } = tool.install;
  if (typeof archFolders?.amd64 !== 'string' || typeof archFolders?.arm64 !== 'string') fail('install.archFolders needs a folder for amd64 and arm64');
  if (addToPath !== null && typeof addToPath !== 'string') fail('install.addToPath is a folder name');
  if (typeof tool.publish.minAge !== 'string') fail('publish.minAge is a duration string (e.g. "1 day")');
  checkDuration(fail, 'publish.minAge', tool.publish.minAge);
  if (tool.setup) {
    if (addToPath !== null) fail('setup is for tool-cache tools; a plain tool (install.addToPath) is ready to use');
    if (typeof tool.setup.action !== 'string' || typeof tool.setup.versionInput !== 'string') fail('setup needs action and versionInput');
    const inputs = tool.setup.with;
    if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs) || Object.values(inputs).some((v) => typeof v !== 'string')) fail('setup.with maps inputs to strings');
  }
  validateLines(tool, fail);
  return tool;
}

export const PLATFORMS = ['linux/amd64', 'linux/arm64'];

// Architecture of a platform: amd64 for linux/amd64.
export const archOf = (platform) => platform.split('/')[1];

// Tool cache arch folder of a platform, as the tool's setup-* action expects it (e.g. aarch64 for Java).
export const archFolder = (tool, platform) => tool.install.archFolders[archOf(platform)];

const ANY = '*';

const LINE_OPTIONS = ['from', 'versions', 'ignoredVersions', 'revisions', 'retired', 'minAge', 'reason'];

const explicitKeys = (tool) => Object.keys(tool.publish.lines).filter((key) => key !== ANY);

// Line of a version, with its key: the explicit line it belongs to, else "*" from its `from` on, else undefined.
export function lineFor(tool, version) {
  const key = explicitKeys(tool).find((k) => inLine(version, k));
  if (key) return { key, ...tool.publish.lines[key] };
  const any = tool.publish.lines[ANY];
  if (any?.from && compareVersions(version, any.from) >= 0) return { key: ANY, ...any };
  return undefined;
}

export const revisionOf = (tool, version) => lineFor(tool, version)?.revisions?.[version] ?? 1;

export function isRetired(tool, version) {
  const line = lineFor(tool, version);
  return Boolean(line && (line.retired === 'all' || line.retired?.includes(version)));
}

const isVersionList = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');

function validateLines(tool, fail) {
  const { lines } = tool.publish;
  const owns = (key, version) => (key === ANY ? lineFor(tool, version)?.key === ANY : inLine(version, key));
  for (const [key, line] of Object.entries(lines)) {
    const lineFail = (message) => fail(`publish.lines.${key}: ${message}`);
    if (key !== ANY && !/^\d+(\.\d+)?$/.test(key)) lineFail('a line is a major ("21"), a minor ("1.25") or "*"');
    for (const option of Object.keys(line)) {
      if (!LINE_OPTIONS.includes(option)) lineFail(`unknown option ${option}`);
    }
    // A line without these keeps nothing: reason documents, ignoredVersions only matters next to from.
    if (key !== ANY && !['from', 'versions', 'revisions', 'retired'].some((o) => line[o] !== undefined)) lineFail('empty line; delete it, or set from, versions, revisions or retired');
    // JSON numbers would lose precision silently ("from": 1.10 is 1.1).
    if (line.from !== undefined && typeof line.from !== 'string') lineFail('from is a version string');
    if (line.reason !== undefined && typeof line.reason !== 'string') lineFail('reason is a string');
    if (line.minAge !== undefined && typeof line.minAge !== 'string') lineFail('minAge is a duration string (e.g. "1 day")');
    if (line.minAge !== undefined) checkDuration(lineFail, 'minAge', line.minAge);
    if (line.retired === 'all') {
      if (key === ANY) lineFail('"retired": "all" is not allowed on "*"; give its versions a line first');
      const others = Object.keys(line).filter((o) => !['retired', 'reason'].includes(o));
      if (others.length) lineFail(`"retired": "all" excludes ${others.join(', ')}`);
      continue;
    }
    if (line.retired !== undefined && !isVersionList(line.retired)) lineFail('retired is a list of versions or "all"');
    for (const option of ['versions', 'ignoredVersions']) {
      if (line[option] !== undefined && !isVersionList(line[option])) lineFail(`${option} is a list of versions`);
    }
    const revisions = Object.entries(line.revisions ?? {});
    if (revisions.some(([, r]) => !Number.isInteger(r) || r < 1)) lineFail('revisions maps a version to a revision number from 1');
    if (key === ANY) {
      if (!line.from) lineFail('"*" needs from');
      if (line.versions) lineFail('"*" cannot have versions; pin them in their own line');
    }
    if (line.from !== undefined && key !== ANY && !inLine(line.from, key)) lineFail(`from ${line.from} is not in line ${key}`);
    const named = [
      ...['versions', 'ignoredVersions', 'retired'].flatMap((option) => (line[option] ?? []).map((version) => [option, version])),
      ...revisions.map(([version]) => ['revisions', version]),
    ];
    for (const [option, version] of named) {
      if (!owns(key, version)) lineFail(`${option} ${version} is not in line ${key}`);
    }
    for (const version of line.versions ?? []) {
      if (line.from && compareVersions(version, line.from) >= 0) lineFail(`versions ${version} is at or above from ${line.from}; from already publishes it`);
    }
  }
  const keys = explicitKeys(tool);
  for (const a of keys) {
    for (const b of keys) {
      if (a !== b && inLine(b, a)) fail(`publish.lines.${a} and publish.lines.${b} overlap; keep the major or its minors`);
    }
  }
  const from = lines[ANY]?.from;
  for (const key of from ? keys : []) {
    if (inLine(from, key) || compareVersions(from, key) < 0) {
      fail(`publish.lines.${key} is at or above publish.lines.* (from ${from}); move "*".from past ${key}`);
    }
  }
}

const checkDuration = (fail, option, value) => {
  try {
    parseDuration(value);
  } catch (err) {
    fail(`${option}: ${err.message}`);
  }
};

const UNITS = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3 };

// Milliseconds of a duration such as "1 day" or "6 hours".
export function parseDuration(text) {
  const match = /^(\d+)\s*(minute|hour|day|week)s?$/.exec(String(text).trim());
  if (!match) throw new Error(`invalid duration ${text} (e.g. "1 day", "6 hours")`);
  return Number(match[1]) * UNITS[match[2]];
}
