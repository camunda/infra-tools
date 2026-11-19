// Release indexes (spec §5.5), one command each:
//
// node index.mjs release --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]
//   Publishes every release (X.Y.Z) without tools.json, oldest first, once release-please created it: pushes its index to
//   --image (lib/publish-index.mjs publishRelease) from the tool definitions and the catalog at its tag, appends the Added /
//   Replaced / Retired tables to its notes and attaches tools.json, written to --out (default build/out/release) first.
//   tools.json is attached last: a release that has it uploaded is published, and is left alone; a release whose publication
//   failed is completed by the next run, before any later release, replacing the tools.json a failed upload left. Uses gh and
//   its token (GH_TOKEN or GITHUB_TOKEN).
//
// node index.mjs latest-index --image <registry>/<repository> --repository <owner>/<name> --ref <commit>
//   Prints the index the action tests install from (lib/release.mjs latestIndexTag): the latest release's, from the
//   release-please manifest at --ref, or the tracer index before the first release. Uses gh and its token.
//
// node index.mjs tracer --index <registry>/<repository>:<tag> <tool>@<version>...
//   Until the first release, for the manual Publish tool workflow: adds the tool images of the given tool versions to the
//   index at --index (lib/publish-index.mjs publishIndex) and pushes it.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { publishIndex, publishRelease } from './lib/publish-index.mjs';
import { Registry } from './lib/registry.mjs';
import { latestIndexTag, releaseBody, releaseNotes, toolsJson, unpublishedReleases } from './lib/release.mjs';
import { ghApi, ghJson, readToolDefinition, RELEASE_MANIFEST, ROOT } from './lib/repository.mjs';
import { parseToolDefinition } from './lib/tool-definition.mjs';

const USAGE = {
  release: 'node index.mjs release --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]',
  'latest-index': 'node index.mjs latest-index --image <registry>/<repository> --repository <owner>/<name> --ref <commit>',
  tracer: 'node index.mjs tracer --index <registry>/<repository>:<tag> <tool>@<version>...',
};
const COMMANDS = { release: publishReleases, 'latest-index': printLatestIndex, tracer: addToTracerIndex };

const [command, ...args] = process.argv.slice(2);
if (!COMMANDS[command]) throw new Error(`usage:\n${Object.values(USAGE).join('\n')}`);
await COMMANDS[command](args);

// Options of a command, all strings; throws its usage when a required one is missing.
function options(command, args, { required, defaults = {}, positionals = false }) {
  const names = [...required, ...Object.keys(defaults)];
  const parsed = parseArgs({ args, options: Object.fromEntries(names.map((name) => [name, { type: 'string', ...(name in defaults && { default: defaults[name] }) }])), allowPositionals: positionals });
  if (required.some((name) => !parsed.values[name]) || (positionals && !parsed.positionals.length)) throw new Error(`usage: ${USAGE[command]}`);
  return parsed;
}

async function publishReleases(args) {
  const { values } = options('release', args, { required: ['image', 'repository'], defaults: { out: join(ROOT, 'build/out/release') } });
  // With their assets' state: a failed upload can leave tools.json in the starter state.
  const releases = JSON.parse(ghApi('', '--paginate', '--slurp', `repos/${values.repository}/releases?per_page=100`)).flat();
  const unpublished = unpublishedReleases(releases);
  if (!unpublished.length) return console.log('every release is published');
  for (const release of unpublished) await publishOneRelease(release, values);
}

// Publishes one release (a GitHub release: { id, tag_name, body, html_url }).
async function publishOneRelease(release, { image, repository, out }) {
  const version = release.tag_name;
  const repo = `repos/${repository}`;
  // The tool definitions and the catalog at the release tag: main may have moved since.
  const file = (path) => ghJson(`${repo}/contents/${path}?ref=${version}`, { accept: 'application/vnd.github.raw+json' });
  const names = ghJson(`${repo}/contents/tools?ref=${version}`)
    .filter((e) => e.type === 'dir')
    .map((e) => e.name);
  const tools = names.map((name) => parseToolDefinition(name, file(`tools/${name}/tool.json`)));
  const catalogs = Object.fromEntries(names.map((name) => [name, file(`published/${name}.json`) ?? []]));

  const { entries, digest, previousVersion, before } = await publishRelease(new Registry(image), version, { tools, catalogs });
  console.log(`pushed ${image}:${version}-tools@${digest}: ${entries.length} tool layers (previous release: ${previousVersion ?? 'none'})`);
  const notes = releaseNotes({ version, previousVersion, repository, before, after: entries });
  ghJson(`${repo}/releases/${release.id}`, { method: 'PATCH', body: { body: releaseBody(release.body, notes) } });
  await mkdir(out, { recursive: true });
  const asset = join(out, 'tools.json');
  await writeFile(asset, `${JSON.stringify(toolsJson({ version, image, entries }), null, 2)}\n`);
  // --clobber: replaces the tools.json a failed upload left.
  execFileSync('gh', ['release', 'upload', version, asset, '--clobber', '--repo', repository], { stdio: 'inherit' });
  console.log(`release ${version} published: ${release.html_url}\n\n${notes}`);
}

function printLatestIndex(args) {
  const { values } = options('latest-index', args, { required: ['image', 'repository', 'ref'] });
  // null before the release-please manifest exists.
  const manifest = ghJson(`repos/${values.repository}/contents/${RELEASE_MANIFEST}?ref=${values.ref}`, { accept: 'application/vnd.github.raw+json' });
  const index = `${values.image}:${latestIndexTag(manifest)}`;
  console.error(`Action tests install from ${index}`);
  console.log(index);
}

async function addToTracerIndex(args) {
  const { values, positionals } = options('tracer', args, { required: ['index'], positionals: true });
  const [repository, tag] = values.index.split(/:(?=[^:/]+$)/);
  if (!tag) throw new Error(`usage: ${USAGE.tracer}`);
  const toolVersions = [];
  for (const selector of positionals) {
    const [name, version] = selector.split('@');
    toolVersions.push({ tool: await readToolDefinition(name), version });
  }
  const { entries, digest } = await publishIndex(new Registry(repository), tag, toolVersions);
  console.log(`pushed ${values.index}@${digest}: ${entries.length} tool layers`);
  for (const e of entries) console.log(`  ${e.platform} ${e.tool} ${e.version} ${e.tag} ${e.digest}`);
}
