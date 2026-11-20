// Release indexes (spec §5.5), one command each:
//
// node index.mjs release --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]
//   Publishes every draft release (X.Y.Z) release-please created, oldest first (lib/publish-release.mjs): its index pushed to
//   --image, then the draft published. tools.json is written to --out (default build/out/release) before its upload. Uses gh
//   and its token (GH_TOKEN, else GITHUB_TOKEN) for GitHub, GITHUB_TOKEN for the registry.
//
// node index.mjs mirror --image <registry>/<repository> --mirror <registry>/<repository> --user <name>
//   Copies the release indexes the mirror lacks (lib/mirror.mjs), logged in as --user with MIRROR_TOKEN.
//
// node index.mjs latest-index --image <registry>/<repository> --repository <owner>/<name> --ref <commit>
//   Prints the index the action tests install from (lib/release.mjs latestIndexTag): the latest published release's, up to
//   the release-please manifest version at --ref, or the tracer index before the first one. Uses gh and its token, and
//   GITHUB_TOKEN for the registry.
//
// node index.mjs tracer --index <registry>/<repository>:<tag> <tool>@<version>...
//   Until the first release, for the manual Publish tool workflow: adds the tool images of the given tool versions to the
//   index at --index (lib/publish-index.mjs publishIndex) and pushes it.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mirrorReleases } from './lib/mirror.mjs';
import { publishIndex } from './lib/publish-index.mjs';
import { publishRelease } from './lib/publish-release.mjs';
import { Registry } from './lib/registry.mjs';
import { latestIndexTag, unpublishedReleases } from './lib/release.mjs';
import { ghApi, ghJson, readToolDefinition, RELEASE_MANIFEST, ROOT } from './lib/repository.mjs';

const USAGE = {
  release: 'node index.mjs release --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]',
  mirror: 'node index.mjs mirror --image <registry>/<repository> --mirror <registry>/<repository> --user <name>',
  'latest-index': 'node index.mjs latest-index --image <registry>/<repository> --repository <owner>/<name> --ref <commit>',
  tracer: 'node index.mjs tracer --index <registry>/<repository>:<tag> <tool>@<version>...',
};
const COMMANDS = { release: publishReleases, mirror: copyToMirror, 'latest-index': printLatestIndex, tracer: addToTracerIndex };

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
  // With the drafts and their assets' state: a failed upload can leave tools.json in the starter state.
  const releases = JSON.parse(ghApi('', '--paginate', '--slurp', `repos/${values.repository}/releases?per_page=100`)).flat();
  const unpublished = unpublishedReleases(releases);
  if (!unpublished.length) return console.log('every release is published');
  for (const release of unpublished) await publishOneRelease(release, values);
}

async function copyToMirror(args) {
  const { values } = options('mirror', args, { required: ['image', 'mirror', 'user'] });
  // Else the client would send GITHUB_TOKEN to the mirror.
  if (!process.env.MIRROR_TOKEN) throw new Error('mirror needs MIRROR_TOKEN, a token of the mirror');
  const mirror = new Registry(values.mirror, { token: process.env.MIRROR_TOKEN, user: values.user });
  const copied = await mirrorReleases(new Registry(values.image), mirror);
  console.log(copied.length ? `copied to ${values.mirror}: ${copied.join(', ')}` : `${values.mirror} holds every release index`);
}

// Publishes one release (a GitHub release: { id, tag_name, target_commitish, body, draft }).
async function publishOneRelease(release, { image, repository, out }) {
  const version = release.tag_name;
  const repo = `repos/${repository}`;
  const github = {
    toolNames: (ref) =>
      ghJson(`${repo}/contents/tools?ref=${ref}`)
        .filter((e) => e.type === 'dir')
        .map((e) => e.name),
    file: (path, ref) => ghJson(`${repo}/contents/${path}?ref=${ref}`, { accept: 'application/vnd.github.raw+json' }),
    updateRelease: (id, fields) => ghJson(`${repo}/releases/${id}`, { method: 'PATCH', body: fields }),
    uploadToolsJson: async ({ tag_name: tag }, content) => {
      await mkdir(out, { recursive: true });
      const asset = join(out, 'tools.json');
      await writeFile(asset, content);
      // --clobber: replaces the tools.json a failed upload left. gh finds a draft by its tag name.
      execFileSync('gh', ['release', 'upload', tag, asset, '--clobber', '--repo', repository], { stdio: 'inherit' });
    },
  };
  const { entries, digest, previousVersion, notes } = await publishRelease(release, { registry: new Registry(image), repository, github });
  console.log(`pushed ${image}:${version}-tools@${digest}: ${entries.length} tool layers (previous release: ${previousVersion ?? 'none'})`);
  console.log(`release ${version} published: https://github.com/${repository}/releases/tag/${version}\n\n${notes}`);
}

async function printLatestIndex(args) {
  const { values } = options('latest-index', args, { required: ['image', 'repository', 'ref'] });
  // null before the release-please manifest exists.
  const manifest = ghJson(`repos/${values.repository}/contents/${RELEASE_MANIFEST}?ref=${values.ref}`, { accept: 'application/vnd.github.raw+json' });
  const index = `${values.image}:${latestIndexTag(manifest, await new Registry(values.image).tags())}`;
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
