// Release indexes (spec §5.5), one command each:
//
// node index.mjs latest-index --image <registry>/<repository> --repository <owner>/<name>
//   Prints the index the action tests install from: the latest published release's (lib/release.mjs latestReleaseVersion).
//   Uses gh and its token.
//
// The release itself, which pushes the indexes, is release.mjs.
import { parseArgs } from 'node:util';
import { latestReleaseVersion } from './lib/release.mjs';
import { ghJson } from './lib/repository.mjs';

const USAGE = {
  'latest-index': 'node index.mjs latest-index --image <registry>/<repository> --repository <owner>/<name>',
};
const COMMANDS = { 'latest-index': printLatestIndex };

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

async function printLatestIndex(args) {
  const { values } = options('latest-index', args, { required: ['image', 'repository'] });
  const index = `${values.image}:${latestReleaseVersion(ghJson(`repos/${values.repository}/releases/latest`))}-tools`;
  console.error(`Action tests install from ${index}`);
  console.log(index);
}
