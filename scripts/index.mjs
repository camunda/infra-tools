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
// node index.mjs latest-index --image <registry>/<repository> --repository <owner>/<name>
//   Prints the index the action tests install from: the latest published release's (lib/release.mjs latestReleaseVersion).
//   Uses gh and its token.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mirrorReleases } from './lib/mirror.mjs';
import { publishRelease } from './lib/publish-release.mjs';
import { Registry } from './lib/registry.mjs';
import { latestReleaseVersion, unpublishedReleases } from './lib/release.mjs';
import { ghApi, ghJson, ROOT } from './lib/repository.mjs';

const USAGE = {
  release: 'node index.mjs release --image <registry>/<repository> --repository <owner>/<name> [--out <dir>]',
  mirror: 'node index.mjs mirror --image <registry>/<repository> --mirror <registry>/<repository> --user <name>',
  'latest-index': 'node index.mjs latest-index --image <registry>/<repository> --repository <owner>/<name>',
};
const COMMANDS = { release: publishReleases, mirror: copyToMirror, 'latest-index': printLatestIndex };

const [command, ...args] = process.argv.slice(2);
if (!COMMANDS[command]) throw new Error(`usage:\n${Object.values(USAGE).join('\n')}`);
await COMMANDS[command](args);

// Options of a command, all strings; throws its usage when a required one is missing.
function options(command, args, { required, defaults = {} }) {
  const names = [...required, ...Object.keys(defaults)];
  const parsed = parseArgs({ args, options: Object.fromEntries(names.map((name) => [name, { type: 'string', ...(name in defaults && { default: defaults[name] }) }])) });
  if (required.some((name) => !parsed.values[name])) throw new Error(`usage: ${USAGE[command]}`);
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
    uploadToolsJson: async ({ id }, content) => {
      await mkdir(out, { recursive: true });
      const asset = join(out, 'tools.json');
      await writeFile(asset, content);
      // By release id, not by tag name, which a draft can lose. Replaces the tools.json a failed upload left.
      for (const a of ghJson(`${repo}/releases/${id}/assets`)) {
        if (a.name === 'tools.json') ghJson(`${repo}/releases/assets/${a.id}`, { method: 'DELETE' });
      }
      ghApi('', '--method', 'POST', '-H', 'Content-Type: application/json', `https://uploads.github.com/${repo}/releases/${id}/assets?name=tools.json`, '--input', asset);
    },
  };
  const { entries, digest, previousVersion, notes } = await publishRelease(release, { registry: new Registry(image), repository, github });
  console.log(`pushed ${image}:${version}-tools@${digest}: ${entries.length} tool layers (previous release: ${previousVersion ?? 'none'})`);
  console.log(`release ${version} published: https://github.com/${repository}/releases/tag/${version}\n\n${notes}`);
}

async function printLatestIndex(args) {
  const { values } = options('latest-index', args, { required: ['image', 'repository'] });
  const index = `${values.image}:${latestReleaseVersion(ghJson(`repos/${values.repository}/releases/latest`))}-tools`;
  console.error(`Action tests install from ${index}`);
  console.log(index);
}
