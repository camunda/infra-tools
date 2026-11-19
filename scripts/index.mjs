// Usage: node index.mjs --release --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]
//        node index.mjs --index <registry>/<repository>:<tag> <tool>@<version>...
// With --release (spec §5.5), publishes the latest release, the version of the release-please manifest, once release-please
// created it: pushes its index to --image (lib/publish-index.mjs publishRelease) from the tool definitions and the catalog at
// its tag, appends the Added / Replaced / Retired tables to its notes and attaches tools.json, written to --out (default
// build/out/release) first. tools.json is attached last: a release that has it is published, and is left alone; a run that
// failed before is completed by the next one. Uses gh and its token (GH_TOKEN or GITHUB_TOKEN) for the release.
// With --index, adds the tool images of the given tool versions to the index at --index (lib/publish-index.mjs publishIndex)
// and pushes it: the manual Publish tool workflow, until the first release.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { publishIndex, publishRelease } from './lib/publish-index.mjs';
import { Registry } from './lib/registry.mjs';
import { releaseBody, releasedVersion, releaseNotes, toolsJson } from './lib/release.mjs';
import { ghApi, readToolDefinition, RELEASE_MANIFEST, ROOT } from './lib/repository.mjs';
import { parseToolDefinition } from './lib/tool-definition.mjs';

const { values, positionals } = parseArgs({
  options: {
    release: { type: 'boolean' },
    image: { type: 'string' },
    repository: { type: 'string' },
    out: { type: 'string', default: join(ROOT, 'build/out/release') },
    index: { type: 'string' },
  },
  allowPositionals: true,
});

if (values.release) {
  if (!values.image || !values.repository) throw new Error('usage: node index.mjs --release --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]');
  await release();
} else {
  const [repository, tag] = values.index?.split(/:(?=[^:/]+$)/) ?? [];
  if (!tag || !positionals.length) throw new Error('usage: node index.mjs --index <registry>/<repository>:<tag> <tool>@<version>...');
  const toolVersions = [];
  for (const selector of positionals) {
    const [name, version] = selector.split('@');
    toolVersions.push({ tool: await readToolDefinition(name), version });
  }
  const { entries, digest } = await publishIndex(new Registry(repository), tag, toolVersions);
  console.log(`pushed ${values.index}@${digest}: ${entries.length} tool layers`);
  for (const e of entries) console.log(`  ${e.platform} ${e.tool} ${e.version} ${e.tag} ${e.digest}`);
}

// gh api returning parsed JSON, or null on 404; any other error throws.
function ghJson(...args) {
  try {
    return JSON.parse(ghApi('', ...args));
  } catch (err) {
    if (/\(HTTP 404\)/.test(err.stderr)) return null;
    throw err;
  }
}

async function release() {
  const version = releasedVersion(await readFile(join(ROOT, RELEASE_MANIFEST), 'utf8'));
  if (!version) return console.log('no release yet: nothing to publish');
  const repo = `repos/${values.repository}`;
  const existing = ghJson(`${repo}/releases/tags/${version}`);
  if (!existing) return console.log(`release ${version} not created yet: nothing to publish`);
  if (existing.assets.some((a) => a.name === 'tools.json')) return console.log(`release ${version} already published: ${existing.html_url}`);

  // The tool definitions and the catalog at the release tag: main may have moved since.
  const file = (path) => ghJson('-H', 'Accept: application/vnd.github.raw+json', `${repo}/contents/${path}?ref=${version}`);
  const names = ghJson(`${repo}/contents/tools?ref=${version}`)
    .filter((e) => e.type === 'dir')
    .map((e) => e.name);
  const tools = names.map((name) => parseToolDefinition(name, file(`tools/${name}/tool.json`)));
  const catalogs = Object.fromEntries(names.map((name) => [name, file(`published/${name}.json`) ?? []]));

  const { entries, digest, previousVersion, before } = await publishRelease(new Registry(values.image), version, { tools, catalogs });
  console.log(`pushed ${values.image}:${version}-tools@${digest}: ${entries.length} tool layers (previous release: ${previousVersion ?? 'none'})`);
  const notes = releaseNotes({ version, previousVersion, repository: values.repository, before, after: entries });
  ghApi(JSON.stringify({ body: releaseBody(existing.body, notes) }), '--method', 'PATCH', `${repo}/releases/${existing.id}`, '--input', '-');
  await mkdir(values.out, { recursive: true });
  const asset = join(values.out, 'tools.json');
  await writeFile(asset, `${JSON.stringify(toolsJson({ version, image: values.image, entries }), null, 2)}\n`);
  execFileSync('gh', ['release', 'upload', version, asset, '--repo', values.repository], { stdio: 'inherit' });
  console.log(`release ${version} published: ${existing.html_url}\n\n${notes}`);
}
