import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isRetired, ROOT } from './config.mjs';
import { compareVersions, folderVersion } from './versions.mjs';

const CATALOG = join(ROOT, 'published');
export const ANNOTATION = 'io.camunda.infra-tools';

export async function readCatalog(tool) {
  try {
    return JSON.parse(await readFile(join(CATALOG, `${tool}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function writeCatalog(tool, entries) {
  await mkdir(CATALOG, { recursive: true });
  const sorted = [...entries].sort((a, b) => compareVersions(a.version, b.version));
  await writeFile(join(CATALOG, `${tool}.json`), `${JSON.stringify(sorted, null, 2)}\n`);
}

// Applies published results and retirements to a tool's catalog; returns conventional changes for the record commit.
export function updateCatalog(tool, entries, published, now = new Date().toISOString()) {
  const next = entries.map((e) => ({ ...e }));
  const changes = [];
  for (const r of published) {
    const entry = {
      version: r.version,
      ...(r.line ? { line: r.line } : {}),
      folderVersion: folderVersion(r.version),
      revision: r.revision,
      tag: r.tag,
      cacheFolder: tool.cacheFolder,
      archFolders: tool.archFolders,
      addToPath: tool.addToPath,
      publishedAt: now,
      ...(r.release ? { release: r.release } : {}),
    };
    const i = next.findIndex((e) => e.version === r.version);
    if (i < 0) {
      next.push(entry);
      changes.push({ type: 'feat', tool: tool.name, text: `publish ${r.version}` });
    } else if (r.revision > next[i].revision) {
      next[i] = { ...next[i], ...entry };
      changes.push({ type: 'fix', tool: tool.name, text: `republish ${r.version} (r${r.revision})` });
    }
  }
  for (const e of next) {
    if (!e.retired && isRetired(tool, e.version)) {
      e.retired = true;
      changes.push({ type: 'feat', breaking: true, tool: tool.name, text: `retire ${e.version}` });
    }
  }
  return { entries: next, changes };
}

const line = (c) => `${c.type}(${c.tool})${c.breaking ? '!' : ''}: ${c.text}`;

// One commit, one conventional entry per change: release-please reads additional entries from the body.
export function commitMessage(changes) {
  if (!changes.length) return '';
  return [line(changes[0]), ...changes.slice(1).map(line)].join('\n\n') + '\n';
}

export const indexKey = (e) => `${e.platform}|${e.tool}|${e.version}`;

export function mergeIndex(previous, current, retired) {
  const merged = new Map(previous.map((e) => [indexKey(e), e]));
  const errors = [];
  for (const e of current) {
    const old = merged.get(indexKey(e));
    if (old && old.digest !== e.digest && e.revision <= old.revision) {
      errors.push(`${e.tool} ${e.version} (${e.platform}): digest changed without a higher revision (r${old.revision} → r${e.revision})`);
      continue;
    }
    merged.set(indexKey(e), e);
  }
  for (const key of [...merged.keys()]) {
    const e = merged.get(key);
    if (retired.has(`${e.tool}|${e.version}`)) merged.delete(key);
  }
  const entries = [...merged.values()].sort((a, b) => a.tool.localeCompare(b.tool) || compareVersions(a.version, b.version) || a.platform.localeCompare(b.platform));
  return { entries, errors };
}

export function diffIndex(previous, next) {
  const group = (entries) => {
    const map = new Map();
    for (const e of entries) {
      const key = `${e.tool}|${e.version}`;
      const item = map.get(key) ?? { tool: e.tool, version: e.version, line: e.line ?? null, revision: e.revision, tag: e.tag, platforms: [], digests: {} };
      item.platforms.push(e.platform);
      item.digests[e.platform] = e.digest;
      map.set(key, item);
    }
    return map;
  };
  const [before, after] = [group(previous), group(next)];
  const changes = { added: [], replaced: [], retired: [] };
  for (const [key, item] of after) {
    const old = before.get(key);
    if (!old) changes.added.push(item);
    else if (JSON.stringify(old.digests) !== JSON.stringify(item.digests)) changes.replaced.push({ ...item, previousRevision: old.revision });
  }
  for (const [key, item] of before) if (!after.has(key)) changes.retired.push(item);
  return changes;
}

export function changesMarkdown({ version, previous, repository, changes }) {
  const link = (i) => `[${i.tag}](https://github.com/${repository}/releases/tag/${i.tag})`;
  const arch = (i) => i.platforms.map((p) => p.split('/')[1]).sort().join(', ');
  const out = [`Index: \`${version}-tools\`${previous ? `, previous: \`${previous}\`` : ''}`, ''];
  const table = (title, header, rows) => {
    if (!rows.length) return;
    out.push(`### ${title}`, '', `| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
  };
  table('➕ Added', ['Tool', 'Version', 'Line', 'Platforms', 'Release'], changes.added.map((i) => [i.tool, i.version, i.line ?? '–', arch(i), link(i)]));
  table('🔁 Replaced', ['Tool', 'Version', 'Revision', 'Release'], changes.replaced.map((i) => [i.tool, i.version, `r${i.previousRevision} → r${i.revision}`, link(i)]));
  table('➖ Retired', ['Tool', 'Version'], changes.retired.map((i) => [i.tool, i.version]));
  if (!changes.added.length && !changes.replaced.length && !changes.retired.length) out.push('No tool changes.', '');
  return out.join('\n');
}
